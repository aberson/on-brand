/**
 * Ground-truth scaffolder — Brand-Fidelity Step 3-prep (#31).
 *
 * Guards that the scaffolder emits one schema-valid template per v1 corpus site
 * with a populated accent guess, DERIVES the accent correctly (asserted against
 * an independent recomputation from the stripe fixture — not tautological), and
 * that the idempotency guard protects the operator's Step-3 edits (a pinned /
 * hand-edited template is never clobbered unless `force`).
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { ColorCluster, RawExtraction } from '../src/extract/engine/adapter.ts';
import { loadCorpus, type CorpusEntry } from '../benchmark/corpus.ts';
import {
  buildTruthTemplate,
  deriveBackgrounds,
  scaffoldAllTruth,
  truthTemplateSchema,
  type TruthTemplate,
} from '../benchmark/truth-scaffold.ts';

const FIXTURE_DIR = fileURLToPath(
  new URL('../docs/findings/eval-raw-extractions/benchmark/', import.meta.url),
);
const HEX_RE = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;

const V1_IDS = loadCorpus()
  .entries.filter((e) => e.tier === 'v1')
  .map((e) => e.id)
  .sort();

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'onbrand-truth-'));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function readTemplate(dir: string, id: string): unknown {
  return JSON.parse(readFileSync(join(dir, `${id}.truth.json`), 'utf8'));
}

function committedTruthIds(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.truth.json'))
    .map((f) => f.replace('.truth.json', ''))
    .sort();
}

/** Independent recomputation of the max-accent-count hex (does NOT use production code). */
function expectedAccentHex(raw: RawExtraction): string {
  const accentTotal = (c: ColorCluster): number =>
    c.roles.filter((r) => r.role === 'accent').reduce((s, r) => s + r.count, 0);
  let best: ColorCluster | undefined;
  for (const c of raw.colors) {
    if (accentTotal(c) <= 0) continue;
    if (!best || accentTotal(c) > accentTotal(best)) best = c;
  }
  if (!best) throw new Error('fixture has no accent evidence');
  return best.hex;
}

describe('scaffoldAllTruth — generation', () => {
  it('writes exactly one template per v1 corpus id (no missing, no orphans)', () => {
    const out = tempDir();
    const result = scaffoldAllTruth({ outDir: out });

    expect([...result.written].sort()).toEqual(V1_IDS);
    expect(result.skipped).toEqual([]);
    expect(committedTruthIds(out)).toEqual(V1_IDS);
    expect(V1_IDS).toHaveLength(20); // 12 real v1 sites + 8 czg controls
  });

  it('every template validates against truthTemplateSchema', () => {
    const out = tempDir();
    scaffoldAllTruth({ outDir: out });
    for (const id of V1_IDS) {
      const parsed = truthTemplateSchema.safeParse(readTemplate(out, id));
      expect(parsed.success, `${id} validates: ${parsed.success ? '' : JSON.stringify(parsed.error?.issues)}`).toBe(
        true,
      );
    }
  });

  it('every template has a populated accent-guess hex + status scaffolded', () => {
    const out = tempDir();
    scaffoldAllTruth({ outDir: out });
    for (const id of V1_IDS) {
      const t = readTemplate(out, id) as {
        extractorGuess: { accent: { hex: string } };
        status: string;
        pinned: { accent: { hex: string; source: string }; fonts: { body: unknown } };
      };
      expect(t.extractorGuess.accent.hex, `${id} accent hex`).toMatch(HEX_RE);
      expect(t.status, `${id} status`).toBe('scaffolded');
      // pinned colour hexes seed from the guess (a starting point) tagged with
      // the `scaffold-guess` sentinel source; fonts start null. Step 3 replaces
      // each with an independently-sourced pin.
      expect(t.pinned.accent.hex, `${id} pinned seeded from guess`).toBe(t.extractorGuess.accent.hex);
      expect(t.pinned.accent.source, `${id} pinned source is the scaffold sentinel`).toBe('scaffold-guess');
      expect(t.pinned.fonts.body, `${id} pinned body font starts null`).toBeNull();
    }
  });

  it('controls carry goldHex null + a note; real sites carry an empty-string goldHex', () => {
    const out = tempDir();
    scaffoldAllTruth({ outDir: out });
    for (const entry of loadCorpus().entries.filter((e) => e.tier === 'v1')) {
      const t = readTemplate(out, entry.id) as { goldHex: unknown; goldHexNote?: unknown };
      if (entry.isControl) {
        expect(t.goldHex, `${entry.id} control goldHex`).toBeNull();
        expect(typeof t.goldHexNote, `${entry.id} control goldHexNote`).toBe('string');
      } else {
        expect(t.goldHex, `${entry.id} real-site goldHex`).toBe('');
        expect(t.goldHexNote, `${entry.id} real-site has no note`).toBeUndefined();
      }
    }
  });

  it('derives stripe accent from the highest accent-role count (not tautological)', () => {
    const out = tempDir();
    scaffoldAllTruth({ outDir: out });

    const stripeRaw = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'stripe.raw-extraction.json'), 'utf8'),
    ) as RawExtraction;
    // Independent recomputation from the fixture, then a hard-coded cross-check.
    const expected = expectedAccentHex(stripeRaw);
    expect(expected).toBe('#533afd'); // the fixture's accent (count 734), not a role-less #fff/#000

    const t = readTemplate(out, 'stripe') as {
      extractorGuess: { accent: { hex: string; evidenceCount: number; source: string } };
    };
    expect(t.extractorGuess.accent.hex).toBe(expected);
    expect(t.extractorGuess.accent.source).toBe('accent-role');
    expect(t.extractorGuess.accent.evidenceCount).toBe(734);
  });

  it('basecamp (the only role-less fixture) resolves accent via saturated-fallback', () => {
    // basecamp's fixture carries no accent-role evidence, so the primary rule
    // cannot fire — it must fall through to the most-saturated cluster. This
    // pins the saturated-fallback branch to a real corpus site (previously only
    // exercised incidentally by the whole-corpus loops, so a regression in the
    // chroma filter / tie-break would have gone unnoticed).
    const out = tempDir();
    scaffoldAllTruth({ outDir: out });
    const t = readTemplate(out, 'basecamp') as {
      extractorGuess: { accent: { source: string; evidenceCount: number } };
    };
    expect(t.extractorGuess.accent.source).toBe('saturated-fallback');
    expect(t.extractorGuess.accent.evidenceCount).toBe(0);
  });
});

describe('scaffoldAllTruth — idempotency guard', () => {
  it('a second run leaves an un-edited scaffold untouched (idempotent no-op)', () => {
    const out = tempDir();
    expect(scaffoldAllTruth({ outDir: out }).written).toHaveLength(20);

    const second = scaffoldAllTruth({ outDir: out });
    expect(second.written, 'a pristine re-run rewrites nothing').toEqual([]);
    expect([...second.skipped].sort()).toEqual(V1_IDS);
  });

  it('does not overwrite a pinned/edited template; force does', () => {
    const out = tempDir();
    scaffoldAllTruth({ outDir: out });

    // Simulate the operator's Step-3 edit: pin stripe with a corrected accent.
    const stripePath = join(out, 'stripe.truth.json');
    const edited = JSON.parse(readFileSync(stripePath, 'utf8')) as {
      status: string;
      pinned: { accent: { hex: string } };
    };
    edited.status = 'pinned';
    edited.pinned.accent.hex = '#abcabc'; // operator sentinel
    writeFileSync(stripePath, `${JSON.stringify(edited, null, 2)}\n`, 'utf8');

    // Default re-run must SKIP the pinned file and leave the operator edit intact.
    const guarded = scaffoldAllTruth({ outDir: out });
    expect(guarded.skipped, 'pinned stripe is protected').toContain('stripe');
    expect(guarded.written, 'pinned stripe is not rewritten').not.toContain('stripe');
    const afterGuard = readTemplate(out, 'stripe') as {
      status: string;
      pinned: { accent: { hex: string } };
    };
    expect(afterGuard.status).toBe('pinned');
    expect(afterGuard.pinned.accent.hex, 'operator edit preserved').toBe('#abcabc');

    // force overwrites: stripe is rewritten back to a fresh scaffold.
    const forced = scaffoldAllTruth({ outDir: out, force: true });
    expect(forced.written, 'force rewrites stripe').toContain('stripe');
    const afterForce = readTemplate(out, 'stripe') as {
      status: string;
      pinned: { accent: { hex: string } };
    };
    expect(afterForce.status).toBe('scaffolded');
    expect(afterForce.pinned.accent.hex, 'force restored the derived guess').toBe('#533afd');
  });
});

// ---------------------------------------------------------------------------
// Fallback branches — synthetic inputs no committed v1 fixture reaches.
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<CorpusEntry> = {}): CorpusEntry {
  return {
    id: 'synthetic',
    url: 'https://example.test/',
    archetype: 'saas',
    sliderCoords: {
      warmth: 0.5,
      saturation: 0.5,
      lightness: 0.5,
      contrast: 0.5,
      hueDiversity: 0.5,
      accentDominance: 0.5,
      neutralRatio: 0.5,
      vibrancy: 0.5,
    },
    isControl: false,
    tier: 'v1',
    heldOut: false,
    ...overrides,
  };
}

function makeRaw(colors: ColorCluster[]): RawExtraction {
  return {
    url: 'https://example.test/',
    extractedAt: '2026-01-01T00:00:00.000Z',
    engine: { name: 'synthetic', version: '0' },
    colors,
    fonts: [],
    typeSizes: [],
    spacing: [],
    radii: [],
    shadows: [],
    screenshots: [],
  };
}

describe('deriveAccent / deriveBackgrounds — fallback branches (synthetic inputs)', () => {
  it('frequency-fallback: an all-neutral, role-less extraction picks the highest-frequency cluster', () => {
    // Every cluster is a near-neutral grey (OKLCH chroma < 0.04) with no accent
    // role, so neither the primary accent-role rule nor the saturated-fallback
    // can fire — deriveAccent must fall through to frequency-fallback. No real
    // v1 fixture reaches this branch, so only a synthetic input covers it.
    const raw = makeRaw([
      { hex: '#808080', frequency: 100, roles: [] },
      { hex: '#c0c0c0', frequency: 50, roles: [] },
      { hex: '#404040', frequency: 10, roles: [] },
    ]);
    const t = buildTruthTemplate(makeEntry(), raw);
    expect(t.extractorGuess.accent.source).toBe('frequency-fallback');
    expect(t.extractorGuess.accent.evidenceCount).toBe(0);
    expect(t.extractorGuess.accent.hex).toBe('#808080'); // highest-frequency cluster
  });

  it('empty-pool guard: deriveBackgrounds does not throw when every cluster hex is unparseable', () => {
    // Regression guard for the fixed `Reduce of empty array` crash: when NO
    // cluster hex parses as OKLCH, `withLightness` (and every OKLCH-derived
    // pool) is empty. deriveBackgrounds must fall back to the highest-frequency
    // RAW cluster instead of reducing an empty array. Tested directly because
    // buildTruthTemplate would (correctly) reject the resulting non-hex accent
    // at schema validation — the guard itself lives in deriveBackgrounds.
    const clusters: ColorCluster[] = [
      { hex: 'var(--brand)', frequency: 100, roles: [] },
      { hex: 'not-a-color', frequency: 50, roles: [] },
    ];
    expect(() => deriveBackgrounds(clusters)).not.toThrow();
    const { backgroundLight, backgroundDark } = deriveBackgrounds(clusters);
    expect(backgroundLight.hex, 'highest-frequency raw cluster').toBe('var(--brand)');
    expect(backgroundLight.lightness, 'documented neutral default (no OKLCH available)').toBe(0);
    expect(backgroundDark).toBeNull();
  });

  it('fails loud (throws) when a fixture is missing under a custom fixtureDir', () => {
    // Also exercises path.join per-entry path building against a non-default
    // (still absolute) fixtureDir: an empty fixtureDir means the first v1 read
    // throws ENOENT rather than silently scaffolding from nothing.
    const out = tempDir();
    const emptyFixtures = tempDir();
    expect(() => scaffoldAllTruth({ outDir: out, fixtureDir: emptyFixtures, force: true })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Pinned-status enforcement — the §6 anti-circularity rule, structurally.
// A benchmark whose ground truth can be a rubber-stamped extractor guess is
// gameable; these assert the schema goes RED on that (and on a missing gold /
// font anchor) and GREEN only on an independently-sourced pin.
// ---------------------------------------------------------------------------
describe('truthTemplateSchema — pinned-status enforcement (§6 anti-circularity)', () => {
  function scaffoldedStripe(): TruthTemplate {
    const out = tempDir();
    scaffoldAllTruth({ outDir: out });
    return truthTemplateSchema.parse(readTemplate(out, 'stripe'));
  }
  const sohne: TruthTemplate['pinned']['fonts']['body'] = {
    family: 'Söhne',
    lookalikes: ['Inter'],
    source: 'official-site-css',
    confidence: 'high',
  };
  /** Turn a scaffolded stripe into a fully independently-sourced pinned template. */
  function independentlyPinned(): TruthTemplate {
    const t = scaffoldedStripe();
    t.status = 'pinned';
    t.goldHex = '#635bff';
    t.pinned.accent = { hex: '#635bff', source: 'official-site-css', confidence: 'high' };
    t.pinned.backgroundLight = { hex: '#ffffff', source: 'official-site-css', confidence: 'high' };
    t.pinned.backgroundDark = { hex: '#0a2540', source: 'official-site-css', confidence: 'medium' };
    t.pinned.fonts = { heading: sohne, body: sohne, mono: null };
    return t;
  }
  const paths = (t: TruthTemplate): string[] => {
    const r = truthTemplateSchema.safeParse(t);
    return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
  };

  it('a scaffolded template validates while its roles are still scaffold-guess', () => {
    expect(truthTemplateSchema.safeParse(scaffoldedStripe()).success).toBe(true);
  });

  it('REJECTS a rubber-stamped pin — status flipped to pinned with roles still scaffold-guess', () => {
    const t = scaffoldedStripe();
    t.status = 'pinned'; // flip status only; leave pinned.* as the guess, fonts null
    const p = paths(t);
    expect(p, 'a rubber-stamped pin must not validate').not.toEqual([]);
    expect(p).toContain('pinned.accent.source'); // the scaffold-guess anchor is caught
    expect(p).toContain('pinned.fonts.body'); // and the missing font truth
  });

  it('ACCEPTS a fully independently-sourced pinned template', () => {
    expect(truthTemplateSchema.safeParse(independentlyPinned()).success).toBe(true);
  });

  it('REJECTS a pinned real site with an empty goldHex', () => {
    const t = independentlyPinned();
    t.goldHex = '';
    expect(paths(t)).toContain('goldHex');
  });

  it('REJECTS a pinned template with no body font even when colours are sourced', () => {
    const t = independentlyPinned();
    t.pinned.fonts.body = null;
    expect(paths(t)).toContain('pinned.fonts.body');
  });

  it('accepts a dark-first brand pinning backgroundLight: null', () => {
    const t = independentlyPinned();
    t.pinned.backgroundLight = null; // spotify/linear/robinhood shape
    expect(truthTemplateSchema.safeParse(t).success).toBe(true);
  });

  it('REJECTS a pinned template whose secondary accent is still scaffold-guess', () => {
    const t = independentlyPinned();
    t.isMultiAccent = true;
    t.pinned.secondaryAccents = [{ hex: '#ff6118', label: 'gradient orange', source: 'scaffold-guess', confidence: 'medium' }];
    expect(paths(t)).toContain('pinned.secondaryAccents.0.source');
  });

  it('ACCEPTS a pinned multi-accent template with independently-sourced secondaries', () => {
    const t = independentlyPinned();
    t.isMultiAccent = true;
    t.pinned.secondaryAccents = [
      { hex: '#ff6118', label: 'gradient orange', source: 'official-site-css', confidence: 'medium' },
      { hex: '#f44bcc', label: 'gradient magenta', source: 'official-site-css', confidence: 'medium' },
    ];
    expect(truthTemplateSchema.safeParse(t).success).toBe(true);
  });

  it('allows isMultiAccent=true with no secondaries captured yet (flagged, deferred)', () => {
    const t = independentlyPinned();
    t.isMultiAccent = true;
    expect(t.pinned.secondaryAccents).toEqual([]);
    expect(truthTemplateSchema.safeParse(t).success).toBe(true);
  });
});
