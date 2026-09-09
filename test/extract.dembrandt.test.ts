/**
 * dembrandt wrapper tests (Step 8) — OFFLINE ONLY. The live runs happened once
 * during the spike (2026-07-16, dembrandt v0.23.1); their verbatim stdout is
 * committed under test/fixtures/extraction/dembrandt/ and these tests exercise
 * the pure mapper (mapDembrandtOutput) against those fixtures. No network, no
 * browser, no dembrandt process is ever spawned in `npm test`.
 *
 * The committed mapped fixtures under test/fixtures/extraction/raw-extraction/
 * are the Step 10 normalizer inputs; the round-trip test here pins them to the
 * mapper (regenerate via `npx tsx test/helpers/gen-extraction-fixtures.ts`).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  coverageOf,
  isNearEmpty,
  meetsMinimumCoverage,
  type RawExtraction,
} from '../src/extract/engine/adapter.ts';
import {
  DEFAULT_TIMEOUT_MS,
  DembrandtEngine,
  DembrandtError,
  cssColorToHex,
  mapDembrandtOutput,
  resolveDembrandtBin,
} from '../src/extract/engine/dembrandt.ts';
import { SPIKE_SITES, screenshotFixture, type SpikeSite } from './helpers/extraction-fixtures.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXTRACTION_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'extraction');

function loadRaw(site: SpikeSite): unknown {
  return JSON.parse(readFileSync(path.join(EXTRACTION_DIR, 'dembrandt', `${site}.json`), 'utf8'));
}

function loadMapped(site: SpikeSite): RawExtraction {
  return JSON.parse(
    readFileSync(path.join(EXTRACTION_DIR, 'raw-extraction', `${site}.json`), 'utf8'),
  ) as RawExtraction;
}

function mapSite(site: SpikeSite): RawExtraction {
  return mapDembrandtOutput(loadRaw(site), [screenshotFixture(site)]);
}

describe('mapDembrandtOutput — fixture round trip (pins the Step 10 inputs)', () => {
  for (const site of SPIKE_SITES) {
    it(`maps the ${site} raw fixture to exactly the committed RawExtraction fixture`, () => {
      expect(mapSite(site)).toEqual(loadMapped(site));
    });
  }

  it('is deterministic: mapping twice yields deep-equal results', () => {
    expect(mapSite('stripe')).toEqual(mapSite('stripe'));
  });

  it('every committed screenshot PNG exists on disk', () => {
    for (const site of SPIKE_SITES) {
      const mapped = loadMapped(site);
      expect(mapped.screenshots.length).toBeGreaterThan(0);
      for (const shot of mapped.screenshots) {
        expect(existsSync(path.join(REPO_ROOT, shot.path)), shot.path).toBe(true);
      }
    }
  });
});

describe('spike coverage — the pre-registered scoring, re-asserted offline', () => {
  it('token-rich site (csszengarden 221) meets the minimum coverage set', () => {
    expect(meetsMinimumCoverage(mapSite('zengarden'))).toBe(true);
  });

  it('heavy modern site (stripe) populates every RawExtraction field', () => {
    const cov = coverageOf(mapSite('stripe'));
    expect(Object.values(cov).every((v) => v === true)).toBe(true);
  });

  it('minimal real site (example.com) still meets the minimum coverage set', () => {
    expect(meetsMinimumCoverage(mapSite('example'))).toBe(true);
  });

  it('garbage anchor (blank page) yields a near-empty extraction', () => {
    const blank = mapSite('blank');
    expect(isNearEmpty(blank)).toBe(true);
    expect(meetsMinimumCoverage(blank)).toBe(false);
    expect(blank.fonts).toEqual([]);
    expect(blank.typeSizes).toEqual([]);
  });
});

describe('mapDembrandtOutput — mapping semantics on real fixture data', () => {
  it('carries frequency evidence from detected counts (zengarden dominant ink)', () => {
    const colors = mapSite('zengarden').colors;
    const dominant = colors.find((c) => c.hex === '#0d2c40');
    expect(dominant?.frequency).toBe(177);
    // semantic.text AND semantic.primary both point at this color.
    expect(dominant?.roles.some((r) => r.role === 'text' && r.count > 0)).toBe(true);
    expect(dominant?.roles.some((r) => r.role === 'accent' && r.count > 0)).toBe(true);
  });

  it('clusters are sorted by frequency descending (deterministic order)', () => {
    const freqs = mapSite('stripe').colors.map((c) => c.frequency);
    expect(freqs).toEqual([...freqs].sort((a, b) => b - a));
  });

  it('maps typography styles to role-tagged font stacks and aggregated sizes', () => {
    const mapped = mapSite('zengarden');
    const heading = mapped.fonts.find((f) => f.role === 'heading');
    expect(heading?.families[0]).toBe('ff-meta-web-pro');
    expect(heading?.frequency).toBe(4); // 4 heading-* styles in the fixture
    const size16 = mapped.typeSizes.find((s) => s.px === 16);
    expect(size16?.frequency).toBe(3); // heading-1 + body + link
    expect(mapped.typeSizes.map((s) => s.px)).toEqual([16, 24, 40, 48]);
  });

  it('maps border/gradient/button/link color usage into role evidence (stripe)', () => {
    const clusters = mapSite('stripe').colors;
    const rolesSeen = new Set(clusters.flatMap((c) => c.roles.map((r) => r.role)));
    expect(rolesSeen.has('border')).toBe(true);
    expect(rolesSeen.has('gradient')).toBe(true);
    expect(rolesSeen.has('accent')).toBe(true);
    expect(rolesSeen.has('background')).toBe(true);
    expect(rolesSeen.has('text')).toBe(true);
  });

  it('keeps shadows as raw CSS strings with frequency (parsing is Step 10)', () => {
    const shadows = mapSite('stripe').shadows;
    expect(shadows.length).toBeGreaterThan(0);
    expect(shadows[0]?.css).toMatch(/rgba?\(/);
    expect(shadows[0]?.frequency).toBeGreaterThan(0);
  });

  it('surfaces skipped CSS custom properties as a warning, not silence (stripe)', () => {
    const warnings = mapSite('stripe').warnings ?? [];
    expect(warnings.some((w) => w.includes('CSS custom properties'))).toBe(true);
  });

  it('records engine provenance from the dembrandt meta block', () => {
    const mapped = mapSite('zengarden');
    expect(mapped.engine).toEqual({ name: 'dembrandt', version: '0.23.1' });
    expect(mapped.url).toContain('csszengarden.com');
    expect(mapped.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('mapDembrandtOutput — failure modes', () => {
  it('throws DembrandtError on a non-object payload', () => {
    expect(() => mapDembrandtOutput('nonsense')).toThrow(DembrandtError);
    expect(() => mapDembrandtOutput([1, 2, 3])).toThrow(DembrandtError);
  });

  it('throws DembrandtError on the dembrandt error envelope (the about:blank shape)', () => {
    // Verbatim shape observed in the spike: dembrandt rewrites schemeless
    // input to https:// and about:blank hard-fails with this envelope.
    const envelope = {
      url: 'https://about:blank',
      error: {
        code: 'EXTRACTION_FAILED',
        message: 'page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL',
      },
    };
    expect(() => mapDembrandtOutput(envelope)).toThrow(/EXTRACTION_FAILED/);
  });

  it('degrades missing optional sections to empty arrays, never a crash', () => {
    const mapped = mapDembrandtOutput({ url: 'https://x.example', extractedAt: 'now' });
    expect(mapped.colors).toEqual([]);
    expect(mapped.fonts).toEqual([]);
    expect(mapped.shadows).toEqual([]);
    expect(isNearEmpty(mapped)).toBe(true);
  });
});

describe('DembrandtEngine — production default wiring (no spawn needed)', () => {
  it('REGRESSION: the no-arg constructor resolves the real installed bin', () => {
    // Iteration-2 critical: resolveDembrandtBin() used to resolve
    // 'dembrandt/package.json', which dembrandt's exports map blocks
    // (ERR_PACKAGE_PATH_NOT_EXPORTED) — every real `new DembrandtEngine()`
    // threw at construction. Both prior tests passed an explicit binPath and
    // masked it. This test goes through the exact production default path.
    const engine = new DembrandtEngine();
    expect(existsSync(engine.binPath), engine.binPath).toBe(true);
    expect(engine.binPath.replace(/\\/g, '/')).toMatch(/node_modules\/dembrandt\/dist\/index\.js$/);
    expect(resolveDembrandtBin()).toBe(engine.binPath);
  });

  it('rejects non-http(s) URLs up front with the spike-verified reason', async () => {
    const engine = new DembrandtEngine('unused-bin-path.js');
    await expect(engine.extract('about:blank')).rejects.toThrow(/about:|https?/);
    await expect(engine.extract('file:///c:/x.html')).rejects.toThrow(DembrandtError);
  });

  it('exposes the adapter engine name and the spike-budget default timeout', () => {
    expect(new DembrandtEngine('unused-bin-path.js').name).toBe('dembrandt');
    expect(DEFAULT_TIMEOUT_MS).toBe(120_000);
  });
});

describe('DembrandtEngine — real spawn paths via fake bins (offline, no network)', () => {
  // Each fake bin stands in for the dembrandt CLI so the REAL spawn/stream/
  // parse/timeout code in extract() executes; only the child's behavior is
  // simulated. binPath is the production injection seam — nothing is mocked.
  const fakeBin = (name: string): string =>
    fileURLToPath(new URL(`./helpers/fake-bins/${name}.js`, import.meta.url));

  it('nonzero exit -> DembrandtError carrying exit code and stderr tail', async () => {
    const engine = new DembrandtEngine(fakeBin('exit-nonzero'));
    const error = await engine.extract('https://x.example').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DembrandtError);
    expect((error as DembrandtError).message).toMatch(/exited 3 for https:\/\/x\.example/);
    expect((error as DembrandtError).stderrTail).toContain('deliberate failure from fake bin');
  });

  it('hung child -> wrapper-owned timeout kills the tree and says so', async () => {
    const engine = new DembrandtEngine(fakeBin('hang'));
    const error = await engine
      .extract('https://x.example', { timeoutMs: 400 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DembrandtError);
    expect((error as DembrandtError).message).toMatch(/timed out after 400ms/);
    expect((error as DembrandtError).message).toMatch(/process tree killed/);
  }, 15_000);

  it('exit 0 with non-JSON stdout -> DembrandtError from the parse branch', async () => {
    const engine = new DembrandtEngine(fakeBin('garbage-stdout'));
    const error = await engine.extract('https://x.example').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DembrandtError);
    expect((error as DembrandtError).message).toMatch(/not valid JSON/);
  });

  it('success path end-to-end: spawn -> parse -> screenshot injection -> mapping', async () => {
    const engine = new DembrandtEngine(fakeBin('success'));
    const shotDir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-dembrandt-test-'));
    try {
      const result = await engine.extract('https://fake.example', { screenshotDir: shotDir });
      expect(result.engine).toEqual({ name: 'dembrandt', version: '0.23.1-fake' });
      expect(result.colors.some((c) => c.hex === '#111111' && c.frequency === 9)).toBe(true);
      expect(result.fonts).toEqual([{ families: ['Fake Sans'], role: 'body', frequency: 1 }]);
      expect(result.typeSizes).toEqual([{ px: 16, frequency: 1, fontWeight: 400, lineHeightPx: 24 }]);
      // Screenshot was written by the child at the wrapper-chosen unique path.
      expect(result.screenshots).toHaveLength(1);
      const shot = result.screenshots[0]!;
      expect(shot.label).toBe('viewport');
      expect(existsSync(shot.path)).toBe(true);
      expect(path.basename(shot.path)).toMatch(/^fake\.example-[0-9a-f]{8}\.png$/);
      // Unique per invocation: a second run must not collide with the first.
      const second = await engine.extract('https://fake.example', { screenshotDir: shotDir });
      expect(second.screenshots[0]!.path).not.toBe(shot.path);
    } finally {
      rmSync(shotDir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('cssColorToHex — the color normalization the role evidence rides on', () => {
  it('converts rgb()/rgba() and passes hex through', () => {
    expect(cssColorToHex('rgb(13, 44, 64)')).toBe('#0d2c40');
    expect(cssColorToHex('rgb(255, 255, 255)')).toBe('#ffffff');
    expect(cssColorToHex('rgba(0, 0, 0, 0.4)')).toBe('#00000066');
    expect(cssColorToHex('rgba(1, 2, 3, 1)')).toBe('#010203');
    expect(cssColorToHex('#AbCdEf')).toBe('#abcdef');
  });

  it('returns undefined for shapes it does not understand', () => {
    expect(cssColorToHex('oklch(60% 0.2 30)')).toBeUndefined();
    expect(cssColorToHex('transparent')).toBeUndefined();
    expect(cssColorToHex('')).toBeUndefined();
  });
});
