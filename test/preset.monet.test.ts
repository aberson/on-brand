/**
 * Calibration + production-gate tests for the 4 hand-authored "monet" presets
 * (templates/presets/monet-{parasol,san-giorgio,water-lily,mismatch-anchor}/) —
 * brand-fidelity benchmark Step 4 (issue #33).
 *
 * These presets are vision-judge MOOD ANCHORS for Step 9, not extracted from a
 * live site and not general-purpose UI presets. They are excluded from the
 * fidelity rollup. This file protects Step 4's done-when permanently:
 *
 *   1. schema validity + full §4 category coverage + every color token
 *      overridden in dark mode (mirrors preset.default.test.ts /
 *      preset.house-docs.test.ts's calibration family);
 *   2. `onbrand check` PASSES (0 errors -- WCAG 2 AA green) for all 4, in both
 *      modes, verified two ways: the spawned production CLI's exit code AND a
 *      direct call into the production `runCheck()` gate (measurement-validity:
 *      assemble through the production code path, don't just trust an exit code);
 *   3. `onbrand preview` renders a non-empty specimen for all 4 (no crash);
 *   4. monet-mismatch-anchor's palette is PROVABLY unrelated to the "Water
 *      Lilies" reference it names (a CIEDE2000 colorjs.io distance floor,
 *      the same color-science library the production contrast gate uses) --
 *      see templates/presets/monet-mismatch-anchor/PROVENANCE.md for the
 *      full write-up this test guards.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Color from 'colorjs.io';
import { afterAll, describe, expect, it } from 'vitest';
import { applyModeOverlay } from '../src/schema/modes.ts';
import { defaultPresetsRoot, readJsonFile } from '../src/schema/resolve.ts';
import { isToken, type TokensDocument } from '../src/schema/types.ts';
import { assertValid, validate } from '../src/schema/validate.ts';
import { runCheck } from '../src/check/run.ts';
import { EXIT_OK } from '../src/cli.ts';

const BIN = fileURLToPath(new URL('../bin/onbrand.mjs', import.meta.url));
const PRESETS_ROOT = defaultPresetsRoot();

const MONET_PRESETS = [
  'monet-parasol',
  'monet-san-giorgio',
  'monet-water-lily',
  'monet-mismatch-anchor',
] as const;

function tokenValue(doc: TokensDocument, dotPath: string): unknown {
  let node: unknown = doc;
  for (const seg of dotPath.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return isToken(node) ? node.$value : undefined;
}

// --- §4 category checklist (identical set to the default preset -- these
// mood anchors carry the SAME diagram key set as default, not house-docs'
// extended lifted-SVG set) ---------------------------------------------------

const RAMP_STEPS = Array.from({ length: 12 }, (_, i) => String(i + 1));

const REQUIRED_TOKEN_PATHS: string[] = [
  ...RAMP_STEPS.map((n) => `color.primitive.brand.${n}`),
  ...RAMP_STEPS.map((n) => `color.primitive.neutral.${n}`),
  ...['bg', 'surface', 'text', 'text-muted', 'border', 'accent', 'code-bg', 'shadow-color'].map(
    (k) => `color.semantic.${k}`,
  ),
  ...['success', 'warning', 'danger', 'info'].flatMap((s) => [
    `color.status.${s}.fg`,
    `color.status.${s}.bg`,
  ]),
  ...Array.from({ length: 8 }, (_, i) => `color.chart.categorical.${i + 1}`),
  ...Array.from({ length: 7 }, (_, i) => `color.chart.sequential.${i + 1}`),
  ...['grid', 'axis', 'label', 'tooltip-bg'].map((k) => `color.chart.chrome.${k}`),
  ...[
    'canvas',
    'node-fill',
    'node-stroke',
    'link',
    'spine-accent',
    'label',
    'chip-highlight',
    'warning',
  ].map((k) => `color.diagram.${k}`),
  'font.sans',
  'font.heading',
  'font.mono',
  'type.size.base',
  ...['step--1', 'step-0', 'step-1', 'step-2', 'step-3', 'step-4', 'step-5'].map(
    (s) => `type.scale.${s}`,
  ),
  ...['regular', 'medium', 'semibold', 'bold'].map((w) => `type.weight.${w}`),
  ...['tight', 'base', 'loose'].map((l) => `type.line-height.${l}`),
  ...Array.from({ length: 10 }, (_, i) => `space.${i + 1}`),
  ...['sm', 'md', 'lg', 'pill'].map((r) => `radius.${r}`),
  ...['elevation-1', 'elevation-2', 'elevation-3'].map((e) => `shadow.${e}`),
  ...['fast', 'base', 'slow'].map((d) => `motion.duration.${d}`),
  ...['standard', 'decelerate', 'accelerate'].map((e) => `motion.easing.${e}`),
];

// --- temp-dir + CLI plumbing (mirrors preset.house-docs.test.ts) -----------

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-monet-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// ---------------------------------------------------------------------------

describe.each(MONET_PRESETS)('%s preset — schema calibration', (name) => {
  const PRESET_DIR = path.join(PRESETS_ROOT, name);
  const tokensDoc = assertValid(readJsonFile(path.join(PRESET_DIR, 'tokens.json')));
  const modesDoc = readJsonFile(path.join(PRESET_DIR, 'modes.dark.json'));

  it('tokens.json passes validate()', () => {
    expect(validate(readJsonFile(path.join(PRESET_DIR, 'tokens.json'))).issues).toEqual([]);
  });

  it('$extensions.onbrand.schemaVersion is 1 and the preset is standalone (no extends)', () => {
    const ext = (tokensDoc as Record<string, unknown>)['$extensions'] as Record<string, unknown>;
    const onbrand = ext['onbrand'] as Record<string, unknown>;
    expect(onbrand['schemaVersion']).toBe(1);
    expect(onbrand['extends']).toBeUndefined();
  });

  it('modes.dark.json passes overlay validation and merges with zero issues', () => {
    const result = applyModeOverlay(tokensDoc, modesDoc);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(validate(result.document).ok).toBe(true);
  });

  it('covers the full §4 category set', () => {
    const missing = REQUIRED_TOKEN_PATHS.filter((p) => tokenValue(tokensDoc, p) === undefined);
    expect(missing).toEqual([]);
  });

  it('every color token is overridden in dark mode (dark != light)', () => {
    const dark = applyModeOverlay(tokensDoc, modesDoc).document;
    const colorPaths = REQUIRED_TOKEN_PATHS.filter((p) => p.startsWith('color.'));
    for (const p of colorPaths) {
      const light = tokenValue(tokensDoc, p);
      const darkValue = tokenValue(dark, p);
      expect(darkValue, p).toBeDefined();
      expect(darkValue, `expected a dark override for ${p}`).not.toBe(light);
    }
  });
});

describe.each(MONET_PRESETS)('%s preset — production build/check/preview round-trip', (name) => {
  it('init -> build -> check -> preview all exit 0 through the spawned production CLI', () => {
    const dir = tempDir();
    const initRes = runCli(['init', dir, '--preset', name]);
    expect(initRes.status, initRes.stderr).toBe(EXIT_OK);
    const buildRes = runCli(['build', dir]);
    expect(buildRes.status, buildRes.stderr).toBe(EXIT_OK);
    const checkRes = runCli(['check', dir]);
    expect(checkRes.status, checkRes.stderr).toBe(EXIT_OK);
    const previewRes = runCli(['preview', dir]);
    expect(previewRes.status, previewRes.stderr).toBe(EXIT_OK);

    const specimenPath = path.join(dir, 'brand', 'dist', 'specimen.html');
    expect(readFileSync(specimenPath, 'utf8').length).toBeGreaterThan(0);
  }, 30_000);

  it('the production runCheck() gate reports zero errors -- WCAG 2 AA green, both modes', () => {
    const dir = tempDir();
    expect(runCli(['init', dir, '--preset', name]).status).toBe(EXIT_OK);
    expect(runCli(['build', dir]).status).toBe(EXIT_OK);

    const report = runCheck(dir);
    expect(report.ok, JSON.stringify(report.findings, null, 2)).toBe(true);
    expect(report.errorCount).toBe(0);
    // Both light and dark pairings were actually evaluated (not silently empty).
    const lightPairings = report.pairings.filter((p) => p.mode === 'light');
    const darkPairings = report.pairings.filter((p) => p.mode === 'dark');
    expect(lightPairings.length).toBeGreaterThan(0);
    expect(darkPairings.length).toBeGreaterThan(0);
    for (const p of [...lightPairings, ...darkPairings]) {
      expect(p.wcagPass, `${p.mode} ${p.role}: ${p.fgPath} on ${p.bgPath}`).toBe(true);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The 3 REAL monet presets must be pairwise DISTINGUISHABLE from each other.
// Same "an instrument that can't fail garbage can't gate" principle as the
// mismatch-anchor check below, applied to the presets themselves: all 32
// tests above would stay green even if a copy-paste slip collapsed two of
// these presets toward the same palette (each still validates, still covers
// §4, still passes its OWN WCAG gate) -- destroying their entire purpose as
// 3 visually distinct Step-9 vision-judge mood anchors. Uses the production
// colorjs.io deltaE path already used by the mismatch-anchor check below
// (never re-implement color math).
// ---------------------------------------------------------------------------

const REAL_MONET_PRESETS = ['monet-parasol', 'monet-san-giorgio', 'monet-water-lily'] as const;

describe('the 3 real monet presets are pairwise distinguishable (not collapsed together)', () => {
  const docs = Object.fromEntries(
    REAL_MONET_PRESETS.map((name) => [
      name,
      assertValid(readJsonFile(path.join(PRESETS_ROOT, name, 'tokens.json'))),
    ]),
  ) as Record<(typeof REAL_MONET_PRESETS)[number], TokensDocument>;

  const pairs: Array<[(typeof REAL_MONET_PRESETS)[number], (typeof REAL_MONET_PRESETS)[number]]> = [
    ['monet-parasol', 'monet-san-giorgio'],
    ['monet-parasol', 'monet-water-lily'],
    ['monet-san-giorgio', 'monet-water-lily'],
  ];

  // Swatches that carry each preset's actual mood -- NOT bg/text/surface,
  // which are deliberately near-white/near-black across all 4 presets (every
  // preset is a light UI theme first) and would swamp a real distinctness
  // signal with noise from tokens that aren't supposed to differ.
  const MOOD_SWATCHES = [
    'color.semantic.accent',
    'color.chart.categorical.1',
    'color.chart.categorical.2',
    'color.chart.categorical.3',
  ];

  function deltaE(a: TokensDocument, b: TokensDocument, dotPath: string): number {
    const av = tokenValue(a, dotPath) as string;
    const bv = tokenValue(b, dotPath) as string;
    return new Color(av).deltaE(new Color(bv), { method: '2000' });
  }

  it.each(pairs)('%s vs %s: every mood swatch clears deltaE2000 >= 20 (clearly different hue)', (a, b) => {
    for (const p of MOOD_SWATCHES) {
      expect(deltaE(docs[a], docs[b], p), `${a} vs ${b} @ ${p}`).toBeGreaterThanOrEqual(20);
    }
  });

  it.each(pairs)('%s vs %s: average deltaE2000 across mood swatches is a STARK difference (>= 30)', (a, b) => {
    const values = MOOD_SWATCHES.map((p) => deltaE(docs[a], docs[b], p));
    const avg = values.reduce((x, y) => x + y, 0) / values.length;
    expect(avg).toBeGreaterThanOrEqual(30);
  });

  it('the 3 accents also occupy distinct hue families (>= 20deg apart on the hue wheel)', () => {
    const hues = REAL_MONET_PRESETS.map((name) => {
      const hex = tokenValue(docs[name], 'color.semantic.accent') as string;
      return new Color(hex).to('hsl').coords[0] as number;
    });
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        const raw = Math.abs(hues[i]! - hues[j]!);
        const circular = Math.min(raw, 360 - raw);
        expect(circular, `${REAL_MONET_PRESETS[i]} vs ${REAL_MONET_PRESETS[j]} hue gap`).toBeGreaterThanOrEqual(20);
      }
    }
  });

  it('deltaE calibration anchor: an identical palette would NOT clear the floor (measurement-validity)', () => {
    // A distinctness checker that can't fail two identical inputs can't gate
    // anything -- mirrors the mismatch-anchor's own calibration-anchor test.
    const sameDoc = docs['monet-parasol'];
    for (const p of MOOD_SWATCHES) {
      expect(deltaE(sameDoc, sameDoc, p)).toBeLessThan(1);
    }
  });
});

// ---------------------------------------------------------------------------
// monet-mismatch-anchor: the palette must be PROVABLY unrelated to the real
// monet-water-lily preset it names as its reference (PROVENANCE.md).
// ---------------------------------------------------------------------------

describe('monet-mismatch-anchor — provably unrelated to its stated reference', () => {
  const waterLilyDoc = assertValid(
    readJsonFile(path.join(PRESETS_ROOT, 'monet-water-lily', 'tokens.json')),
  );
  const mismatchDoc = assertValid(
    readJsonFile(path.join(PRESETS_ROOT, 'monet-mismatch-anchor', 'tokens.json')),
  );

  function deltaE(pathA: string): number {
    const a = tokenValue(waterLilyDoc, pathA) as string;
    const b = tokenValue(mismatchDoc, pathA) as string;
    return new Color(a).deltaE(new Color(b), { method: '2000' });
  }

  const KEY_SWATCHES = [
    'color.semantic.accent',
    'color.diagram.spine-accent',
    'color.primitive.brand.9',
    ...Array.from({ length: 8 }, (_, i) => `color.chart.categorical.${i + 1}`),
  ];

  it('every key swatch clears a "clearly perceptible" deltaE2000 floor (>= 15)', () => {
    for (const p of KEY_SWATCHES) {
      expect(deltaE(p), p).toBeGreaterThanOrEqual(15);
    }
  });

  it('the average deltaE2000 across key swatches is a STARK mismatch (>= 35)', () => {
    const values = KEY_SWATCHES.map(deltaE);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    expect(avg).toBeGreaterThanOrEqual(35);
  });

  it('deltaE calibration anchor: fails on an identical color (measurement-validity)', () => {
    // A checker that can't fail a trivially-identical input can't gate anything.
    expect(new Color('#3ea590').deltaE(new Color('#3ea590'), { method: '2000' })).toBeLessThan(1);
  });

  it('PROVENANCE.md documents the stated reference painting + the mismatch rationale', () => {
    const doc = readFileSync(
      path.join(PRESETS_ROOT, 'monet-mismatch-anchor', 'PROVENANCE.md'),
      'utf8',
    );
    expect(doc).toContain('Water Lilies');
    expect(doc.toLowerCase()).toContain('deltae');
    expect(doc.length).toBeGreaterThan(200);
  });
});
