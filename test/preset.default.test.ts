/**
 * Calibration tests for the default preset (templates/presets/default/).
 * Step 5 will contrast-gate this preset as a known-good anchor, so the values
 * committed here must already be plausible: full §4 category coverage and
 * WCAG 2 AA (>= 4.5:1) on every declared text/bg pairing, in both modes.
 *
 * The contrast helper below is test-side arithmetic only — the production
 * contrast gate (colorjs.io, WCAG + APCA) lands in Step 5; this test guards
 * the DATA, not the future gate implementation.
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { applyModeOverlay } from '../src/schema/modes.ts';
import { defaultPresetsRoot, readJsonFile } from '../src/schema/resolve.ts';
import { isToken, type TokensDocument } from '../src/schema/types.ts';
import { assertValid, validate } from '../src/schema/validate.ts';

const PRESET_DIR = path.join(defaultPresetsRoot(), 'default');

const tokensDoc = assertValid(readJsonFile(path.join(PRESET_DIR, 'tokens.json')));
const modesDoc = readJsonFile(path.join(PRESET_DIR, 'modes.dark.json'));

function tokenValue(doc: TokensDocument, dotPath: string): unknown {
  let node: unknown = doc;
  for (const seg of dotPath.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return isToken(node) ? node.$value : undefined;
}

// --- WCAG 2 relative-luminance contrast (test-side helper; see header) -----

function srgbChannel(byte: number): number {
  const s = byte / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const m = /^#([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$/.exec(hex);
  if (!m) throw new Error(`contrast helper needs a #rrggbb(aa) hex, got ${hex}`);
  const v = m[1]!;
  const r = Number.parseInt(v.slice(0, 2), 16);
  const g = Number.parseInt(v.slice(2, 4), 16);
  const b = Number.parseInt(v.slice(4, 6), 16);
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
}

function contrast(fgHex: string, bgHex: string): number {
  const a = luminance(fgHex);
  const b = luminance(bgHex);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// --- §4 category checklist --------------------------------------------------

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

describe('default preset — schema', () => {
  it('tokens.json passes validate()', () => {
    // assertValid at module load already threw if not; keep an explicit assertion
    expect(validate(readJsonFile(path.join(PRESET_DIR, 'tokens.json'))).issues).toEqual([]);
  });

  it('modes.dark.json passes overlay validation and merges with zero issues', () => {
    const result = applyModeOverlay(tokensDoc, modesDoc);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.overriddenPaths.length).toBeGreaterThan(40);
    expect(validate(result.document).ok).toBe(true);
  });

  it('covers the full §4 category set', () => {
    const missing = REQUIRED_TOKEN_PATHS.filter((p) => tokenValue(tokensDoc, p) === undefined);
    expect(missing).toEqual([]);
  });

  it('dark overlay covers the color surface the emitters need (semantic, status, chart, diagram)', () => {
    const dark = applyModeOverlay(tokensDoc, modesDoc).document;
    const colorPaths = REQUIRED_TOKEN_PATHS.filter((p) => p.startsWith('color.'));
    for (const p of colorPaths) {
      const light = tokenValue(tokensDoc, p);
      const darkValue = tokenValue(dark, p);
      expect(darkValue, p).toBeDefined();
      // every §4 color token is overridden in dark mode (dark !== light) except
      // none — the default preset overlays the whole color tree
      expect(darkValue, `expected a dark override for ${p}`).not.toBe(light);
    }
  });
});

describe('default preset — WCAG 2 AA plausibility (Step 5 calibration anchor)', () => {
  const dark = applyModeOverlay(tokensDoc, modesDoc).document;

  const AA_PAIRS: Array<[fg: string, bg: string]> = [
    ['color.semantic.text', 'color.semantic.bg'],
    ['color.semantic.text', 'color.semantic.surface'],
    ['color.semantic.text-muted', 'color.semantic.bg'],
    ['color.semantic.accent', 'color.semantic.bg'],
    ['color.semantic.text', 'color.semantic.code-bg'],
    ['color.status.success.fg', 'color.status.success.bg'],
    ['color.status.warning.fg', 'color.status.warning.bg'],
    ['color.status.danger.fg', 'color.status.danger.bg'],
    ['color.status.info.fg', 'color.status.info.bg'],
    ['color.chart.chrome.label', 'color.semantic.bg'],
    ['color.diagram.label', 'color.diagram.canvas'],
  ];

  it.each(AA_PAIRS)('light: %s on %s >= 4.5:1', (fgPath, bgPath) => {
    const fg = tokenValue(tokensDoc, fgPath) as string;
    const bg = tokenValue(tokensDoc, bgPath) as string;
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(AA_PAIRS)('dark: %s on %s >= 4.5:1', (fgPath, bgPath) => {
    const fg = tokenValue(dark, fgPath) as string;
    const bg = tokenValue(dark, bgPath) as string;
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('contrast helper anchor: fails garbage (grey-on-grey), passes known-good', () => {
    // measurement-validity: a checker that cannot fail garbage cannot gate
    expect(contrast('#777777', '#888888')).toBeLessThan(4.5);
    expect(contrast('#000000', '#ffffff')).toBeGreaterThan(20);
  });
});
