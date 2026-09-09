/**
 * compileBrand unit-level tests: flattening order/typing, the extends chain
 * flowing into the manifest source hash, overlay-less builds, and the
 * skipped-emitter policy. The spawned-CLI integration tests live in
 * cli.build.test.ts.
 */

import {
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { compileBrand, flattenTokens } from '../src/build/compile.ts';
import { parseStrictManifest } from '../src/build/manifest.ts';
import { runCheck } from '../src/check/run.ts';
import { assertValid } from '../src/schema/validate.ts';

const PRESET_DIR = fileURLToPath(new URL('../templates/presets/default/', import.meta.url));

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-compile-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Scaffold a project dir whose brand/ is a copy of the default preset. */
function presetProject(): string {
  const dir = tempDir();
  cpSync(PRESET_DIR, path.join(dir, 'brand'), { recursive: true });
  return dir;
}

describe('flattenTokens', () => {
  const doc = assertValid(JSON.parse(readFileSync(path.join(PRESET_DIR, 'tokens.json'), 'utf8')));

  it('walks in document order and resolves inherited $type', () => {
    const tokens = flattenTokens(doc);
    expect(tokens[0]!.dotPath).toBe('color.primitive.brand.1');
    expect(tokens[0]!.type).toBe('color'); // inherited from the color group
    const weight = tokens.find((t) => t.dotPath === 'type.weight.bold');
    expect(weight?.type).toBe('fontWeight');
    expect(weight?.value).toBe(700);
  });

  it('flattens every leaf exactly once', () => {
    const tokens = flattenTokens(doc);
    const paths = tokens.map((t) => t.dotPath);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain('shadow.elevation-3');
    expect(paths).toContain('motion.easing.standard');
  });

  it('enumerates canonical numeric names ascending FIRST, regardless of authoring order', () => {
    // The documented ordering rule: JS own-property enumeration order, which
    // sorts array-index-like keys numerically ahead of everything else.
    const outOfOrder = assertValid({
      $extensions: { onbrand: { schemaVersion: 1 } },
      space: {
        $type: 'dimension',
        '10': { $value: '6rem' },
        named: { $value: '1rem' },
        '2': { $value: '0.5rem' },
      },
    });
    expect(flattenTokens(outOfOrder).map((t) => t.dotPath)).toEqual([
      'space.2',
      'space.10',
      'space.named',
    ]);
  });
});

describe('compileBrand', () => {
  it('repairs a parseable corrupt prior envelope and publishes a strict, check-clean manifest', () => {
    const dir = presetProject();
    compileBrand(dir, { now: () => '2026-07-16T00:00:00.000Z' });
    const manifestPath = path.join(dir, 'brand', 'dist', 'manifest.json');
    const corrupt = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown> & {
      outputs: Record<string, string>;
      outputSources?: Record<string, unknown>;
    };
    corrupt.sourceHash = 'F'.repeat(64);
    corrupt.timestamp = 'not-an-iso-timestamp';
    corrupt.outputs['specimen.html'] = 'not-a-lowercase-sha256';
    corrupt.outputSources = {
      'specimen.html': [{ label: 'specimen-html', sourcePath: null, kind: 'digest', sha256: 'bad' }],
      'tokens.css': [{ label: 'core', sourcePath: null, kind: 'digest', sha256: 'bad' }],
    };
    writeFileSync(manifestPath, `${JSON.stringify(corrupt, null, 2)}\n`);

    const repaired = compileBrand(dir, { now: () => '2026-07-16T01:00:00.000Z' });
    expect(repaired.manifest.timestamp).toBe('2026-07-16T01:00:00.000Z');
    expect(repaired.manifest.outputs).not.toHaveProperty('specimen.html');
    expect(repaired.manifest.outputSources).toBeUndefined();
    expect(parseStrictManifest(readFileSync(manifestPath, 'utf8'))).toEqual(repaired.manifest);
    expect(runCheck(dir).ok).toBe(true);
  });

  it('records tokens.json + modes.dark.json in the manifest sources', () => {
    const dir = presetProject();
    const result = compileBrand(dir, { now: () => '2026-07-16T00:00:00.000Z' });
    expect(result.manifest.sources.map((s) => s.path)).toEqual(['tokens.json', 'modes.dark.json']);
    expect(result.manifest.emitters).toEqual([
      'css',
      'tw',
      'ts',
      'py',
      'svg',
      'components',
      'designmd',
    ]);
  });

  it('skips nothing now that all seven contract emitters are implemented', () => {
    const dir = presetProject();
    // Default (all IDs) and an explicit full set both run cleanly with no skips.
    expect(compileBrand(dir).skipped).toEqual([]);
    expect(
      compileBrand(dir, { emit: ['css', 'tw', 'ts', 'py', 'svg', 'components', 'designmd'] }).skipped,
    ).toEqual([]);
  });

  it('builds without modes.dark.json: no dark blocks, single manifest source', () => {
    const dir = presetProject();
    rmSync(path.join(dir, 'brand', 'modes.dark.json'));
    const result = compileBrand(dir, { emit: ['css'] });
    const css = readFileSync(path.join(dir, 'brand', 'dist', 'tokens.css'), 'utf8');
    expect(css).not.toContain('@media');
    expect(css).not.toContain('data-theme');
    expect(result.manifest.sources.map((s) => s.path)).toEqual(['tokens.json']);
  });

  it('hashes the RESOLVED extends chain: the base file is a source and changing it changes the hash', () => {
    const dir = presetProject();
    // Move the full token set out to a base file; tokens.json extends it and
    // overrides one color.
    const brandDir = path.join(dir, 'brand');
    rmSync(path.join(brandDir, 'modes.dark.json'));
    cpSync(path.join(PRESET_DIR, 'tokens.json'), path.join(dir, 'base-tokens.json'));
    writeFileSync(
      path.join(brandDir, 'tokens.json'),
      JSON.stringify(
        {
          $extensions: { onbrand: { schemaVersion: 1, extends: '../base-tokens.json' } },
          color: { $type: 'color', semantic: { accent: { $value: '#123456' } } },
        },
        null,
        2,
      ),
      'utf8',
    );

    const first = compileBrand(dir, { emit: ['css'] });
    expect(first.manifest.sources.map((s) => s.path)).toEqual([
      'tokens.json',
      '../base-tokens.json',
    ]);
    // the extender's override reached the emitted css
    const css = readFileSync(path.join(brandDir, 'dist', 'tokens.css'), 'utf8');
    expect(css).toContain('--color-semantic-accent: #123456;');
    // the base ramp survived the merge
    expect(css).toContain('--color-primitive-brand-9: #3b63a8;');

    // editing ONLY the base file must change the source hash (stale-dist guard)
    const base = readFileSync(path.join(dir, 'base-tokens.json'), 'utf8');
    writeFileSync(
      path.join(dir, 'base-tokens.json'),
      base.replace('#fbfcfe', '#fbfcff'),
      'utf8',
    );
    const second = compileBrand(dir, { emit: ['css'] });
    expect(second.manifest.sourceHash).not.toBe(first.manifest.sourceHash);
  });

  it.runIf(process.platform === 'win32')(
    'records a case-normalized source label for a case-variant extends spec (Windows FS is case-insensitive)',
    () => {
      const dir = presetProject();
      const brandDir = path.join(dir, 'brand');
      rmSync(path.join(brandDir, 'modes.dark.json'));
      cpSync(path.join(PRESET_DIR, 'tokens.json'), path.join(dir, 'base-tokens.json'));
      writeFileSync(
        path.join(brandDir, 'tokens.json'),
        JSON.stringify({
          // spec casing differs from the on-disk name; the recorded label
          // (which feeds the source hash) must be canonical anyway
          $extensions: { onbrand: { schemaVersion: 1, extends: '../BASE-Tokens.json' } },
          color: { $type: 'color', semantic: { accent: { $value: '#123456' } } },
        }),
        'utf8',
      );
      const result = compileBrand(dir, { emit: ['css'] });
      expect(result.manifest.sources.map((s) => s.path)).toEqual([
        'tokens.json',
        '../base-tokens.json',
      ]);
    },
  );

  it('throws a path-precise error on an invalid overlay (non-color override)', () => {
    const dir = presetProject();
    writeFileSync(
      path.join(dir, 'brand', 'modes.dark.json'),
      JSON.stringify({ space: { '1': { $value: '#000000' } } }),
      'utf8',
    );
    expect(() => compileBrand(dir, { emit: ['css'] })).toThrowError(/space\.1/);
  });

  it('throws a hint pointing at init when brand/tokens.json is missing', () => {
    const dir = tempDir();
    expect(() => compileBrand(dir)).toThrowError(/onbrand init/);
  });

  it('labels preset-name extends targets machine-independently: same content, same hash, from any location', () => {
    // Two projects in DIFFERENT directories extending the same preset by name
    // must record identical sources and an identical sourceHash — the
    // on-brand install path must never leak into the label (plan §3.2:
    // content drives the hash).
    const fragment = JSON.stringify({
      $extensions: { onbrand: { schemaVersion: 1, extends: 'default' } },
    });
    const manifests = [tempDir(), tempDir()].map((dir) => {
      const brandDir = path.join(dir, 'brand');
      mkdirSync(brandDir, { recursive: true });
      writeFileSync(path.join(brandDir, 'tokens.json'), fragment, 'utf8');
      return compileBrand(dir, { emit: ['css'] }).manifest;
    });
    expect(manifests[0]!.sources).toEqual(manifests[1]!.sources);
    expect(manifests[0]!.sourceHash).toBe(manifests[1]!.sourceHash);
    expect(manifests[0]!.sources.map((s) => s.path)).toEqual([
      'tokens.json',
      'onbrand:templates/presets/default/tokens.json',
    ]);
  });

  it('runs the collision gate for EVERY emitter subset, not just css', () => {
    const dir = presetProject();
    const tokensPath = path.join(dir, 'brand', 'tokens.json');
    const doc = JSON.parse(readFileSync(tokensPath, 'utf8')) as {
      color: { semantic: Record<string, unknown> };
    };
    doc.color.semantic['code'] = { bg: { $value: '#ffffff' } }; // collides with code-bg
    writeFileSync(tokensPath, JSON.stringify(doc), 'utf8');
    // css is NOT in the emit set — the hoisted gate must still refuse
    expect(() => compileBrand(dir, { emit: ['tw'] })).toThrowError(/collides/);
  });

  // --- Step 3's NEW collision classes, driven through the REAL pipeline -----
  // (resolveTokensFile -> flattenTokens -> emitter gates; not hand-built
  // FlatToken fixtures — those live in the per-emitter unit tests).

  /** presetProject() + a mutation of the real brand/tokens.json. */
  function presetProjectWith(mutate: (doc: Record<string, any>) => void): string {
    const dir = presetProject();
    const tokensPath = path.join(dir, 'brand', 'tokens.json');
    const doc = JSON.parse(readFileSync(tokensPath, 'utf8')) as Record<string, any>;
    mutate(doc);
    writeFileSync(tokensPath, JSON.stringify(doc, null, 2), 'utf8');
    return dir;
  }

  it('py gate via compileBrand: a top-level "dark" group colliding with a DARK_ constant fails --emit py only', () => {
    const dir = presetProjectWith((doc) => {
      doc['foo'] = { $type: 'color', $value: '#222222' };
      doc['dark'] = { $type: 'color', foo: { $value: '#111111' } };
    });
    expect(() => compileBrand(dir, { emit: ['py'] })).toThrowError(/DARK_FOO/);
    expect(() => compileBrand(dir, { emit: ['py'] })).toThrowError(/dark-mode constant/);
    // the same source builds clean for css — the class is py-name-specific
    expect(() => compileBrand(dir, { emit: ['css'] })).not.toThrow();
  });

  it('py gate via compileBrand: a token flattening onto reserved CHART_CATEGORICAL fails --emit py only', () => {
    const dir = presetProjectWith((doc) => {
      doc['chart'] = { categorical: { $type: 'color', $value: '#123456' } };
    });
    expect(() => compileBrand(dir, { emit: ['py'] })).toThrowError(/reserved list constant/);
    expect(() => compileBrand(dir, { emit: ['py'] })).toThrowError(/chart\.categorical/);
    expect(() => compileBrand(dir, { emit: ['css'] })).not.toThrow();
  });

  it('tw gate via compileBrand: the namespace remap collision (font.weight-bold vs type.weight.bold) fails --emit tw only', () => {
    const dir = presetProjectWith((doc) => {
      doc.font['weight-bold'] = { $value: 'Inter' }; // font group $type: fontFamily
    });
    expect(() => compileBrand(dir, { emit: ['tw'] })).toThrowError(/--font-weight-bold/);
    expect(() => compileBrand(dir, { emit: ['tw'] })).toThrowError(/type\.weight\.bold/);
    // raw css vars differ (--font-weight-bold vs --type-weight-bold): css passes
    expect(() => compileBrand(dir, { emit: ['css'] })).not.toThrow();
  });

  it('staging: a failed rename cleans up temps, leaves each output fully old or fully new, manifest last', () => {
    const dir = presetProject();
    const distDir = path.join(dir, 'brand', 'dist');
    // Block the manifest TARGET with a directory: its rename must fail after
    // tokens.css has already renamed into place (manifest is renamed last).
    mkdirSync(path.join(distDir, 'manifest.json'), { recursive: true });

    expect(() => compileBrand(dir, { emit: ['css'] })).toThrowError(/failed while writing/);

    // no temp files left behind
    const leftovers = readdirSync(distDir).filter((name) => name.includes('.onbrand-tmp-'));
    expect(leftovers).toEqual([]);
    // tokens.css (renamed before the manifest) is fully new and well-formed
    const css = readFileSync(path.join(distDir, 'tokens.css'), 'utf8');
    expect(css).toContain('@layer tokens {');
    expect(css.endsWith('}\n')).toBe(true);
  });

  it('rejects a hard-linked carried specimen instead of preserving its provenance', () => {
    const dir = presetProject();
    const distDir = path.join(dir, 'brand', 'dist');
    compileBrand(dir, { emit: ['css'], now: () => '2026-07-16T00:00:00.000Z' });
    const manifestPath = path.join(distDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      sourceHash: string;
      outputs: Record<string, string>;
    };
    manifest.outputs['specimen.html'] = manifest.sourceHash;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const sentinel = path.join(dir, 'specimen-sentinel.html');
    writeFileSync(sentinel, '<p>outside sentinel</p>\n', 'utf8');
    linkSync(sentinel, path.join(distDir, 'specimen.html'));
    const manifestBefore = readFileSync(manifestPath);

    expect(() => compileBrand(dir, { emit: ['css'] })).toThrowError(/specimen target|carried output target/);
    expect(readFileSync(sentinel, 'utf8')).toBe('<p>outside sentinel</p>\n');
    expect(readFileSync(manifestPath).equals(manifestBefore)).toBe(true);
  });
});
