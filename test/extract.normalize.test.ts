/**
 * Normalizer unit + property tests (plan.md Step 10).
 *
 * Includes the Step 10 deliverable "property tests (grid snapping)": snapToGrid
 * lands every px on the 4px grid within 2px. Plus seed selection, radius/shadow/
 * type inference, the default-fill policy, and determinism.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GRID_PX,
  deriveRadii,
  deriveShadows,
  inferType,
  normalize,
  parseShadow,
  selectSeedCandidates,
  snapToGrid,
  snappedSpacingEvidence,
  type ParsedShadow,
  type TypeInference,
} from '../src/extract/normalize.ts';
import { FALLBACK_BRAND_SEED } from '../src/extract/ramps.ts';
import { validate } from '../src/schema/validate.ts';
import type { RawExtraction } from '../src/extract/engine/adapter.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/extraction/raw-extraction/', import.meta.url));

function loadFixture(name: string): RawExtraction {
  return JSON.parse(readFileSync(`${FIXTURES}${name}.json`, 'utf8')) as RawExtraction;
}

// --- Grid snapping (the Step 10 property-test deliverable) -------------------

describe('snapToGrid — property: lands on the 4px grid within 2px', () => {
  it('every value snaps to a multiple of 4, no further than 2px away', () => {
    for (let px = 0; px <= 400; px += 0.25) {
      const snapped = snapToGrid(px);
      expect(snapped % GRID_PX).toBe(0);
      expect(Math.abs(snapped - px)).toBeLessThanOrEqual(GRID_PX / 2);
    }
  });

  it('half-way values round up deterministically (banker-free)', () => {
    expect(snapToGrid(2)).toBe(4); // Math.round(0.5)=1 -> 4
    expect(snapToGrid(6)).toBe(8);
    expect(snapToGrid(16)).toBe(16);
    expect(snapToGrid(15.9)).toBe(16);
    expect(snapToGrid(162)).toBe(164); // 162 is equidistant (160/164); rounds up
    expect(snapToGrid(160)).toBe(160);
  });

  it('snappedSpacingEvidence clusters observations onto distinct grid values', () => {
    const ex = loadFixture('zengarden');
    const evidence = snappedSpacingEvidence(ex);
    expect(evidence.every((v) => v % GRID_PX === 0)).toBe(true);
    // sorted ascending, de-duplicated
    expect([...evidence].sort((a, b) => a - b)).toEqual(evidence);
    expect(new Set(evidence).size).toBe(evidence.length);
    expect(evidence).toContain(16); // 16px is zengarden's dominant gap
  });
});

// --- Seed selection ----------------------------------------------------------

describe('selectSeedCandidates — brand color ranking', () => {
  it('picks the accent-evidenced brand color (Stripe purple) over text/bg greys', () => {
    const candidates = selectSeedCandidates(loadFixture('stripe'));
    expect(candidates[0]!.hex).toBe('#533afd');
    // pure black/white (achromatic) never appear as candidates
    expect(candidates.some((c) => c.hex === '#000000' || c.hex === '#ffffff')).toBe(false);
  });

  it('picks the blue accent on example.com', () => {
    const candidates = selectSeedCandidates(loadFixture('example'));
    expect(candidates[0]!.hex).toBe('#334488');
  });

  it('a blank page (only black/white) yields NO candidate -> fallback seed', () => {
    const candidates = selectSeedCandidates(loadFixture('blank'));
    expect(candidates).toEqual([]);
    const result = normalize(loadFixture('blank'));
    expect(result.seedFromFallback).toBe(true);
    expect(result.seed).toBe(FALLBACK_BRAND_SEED);
    expect(result.warnings.some((w) => w.includes('fell back'))).toBe(true);
  });
});

// --- Radius / shadow / type inference ---------------------------------------

describe('deriveRadii — snap observed corners to sm/md/lg + pill', () => {
  it('derives ascending sm<md<=lg from Stripe radii; pill is always 999px', () => {
    const radii = deriveRadii(loadFixture('stripe'), {
      sm: '4px',
      md: '8px',
      lg: '12px',
      pill: '999px',
    });
    const n = (s: string): number => Number(s.slice(0, -2));
    expect(n(radii.sm)).toBeLessThan(n(radii.md));
    expect(n(radii.md)).toBeLessThanOrEqual(n(radii.lg));
    expect(radii.pill).toBe('999px');
    for (const v of [radii.sm, radii.md, radii.lg]) expect(v).toMatch(/^\d+px$/);
  });

  it('falls back to preset defaults when fewer than three distinct radii observed', () => {
    const radii = deriveRadii(loadFixture('zengarden'), {
      sm: '4px',
      md: '8px',
      lg: '12px',
      pill: '999px',
    });
    expect(radii).toEqual({ sm: '4px', md: '8px', lg: '12px', pill: '999px' });
  });
});

describe('parseShadow / deriveShadows — box-shadow -> DTCG single-layer', () => {
  it('parses a multi-layer rgba shadow to color + 4 offsets (first layer)', () => {
    const parsed = parseShadow('rgba(50, 50, 93, 0.25) 0px 30px 45px -30px, rgba(0, 0, 0, 0.1) 0px 18px 36px -18px');
    expect(parsed).toBeDefined();
    expect(parsed!.color).toMatch(/^#[0-9a-f]{6,8}$/);
    expect(parsed!.offsetY).toBe('30px');
    expect(parsed!.blur).toBe('45px');
    expect(parsed!.spread).toBe('-30px');
  });

  it('returns undefined for an unparseable shadow (no color / no offsets)', () => {
    expect(parseShadow('none')).toBeUndefined();
    expect(parseShadow('')).toBeUndefined();
  });

  it('deriveShadows yields three valid elevation layers from Stripe, blur ascending', () => {
    const defaults: [ParsedShadow, ParsedShadow, ParsedShadow] = [
      { color: '#00000014', offsetX: '0px', offsetY: '1px', blur: '2px', spread: '0px' },
      { color: '#0000001f', offsetX: '0px', offsetY: '2px', blur: '8px', spread: '-1px' },
      { color: '#00000029', offsetX: '0px', offsetY: '8px', blur: '24px', spread: '-4px' },
    ];
    const shadows = deriveShadows(loadFixture('stripe'), defaults);
    expect(shadows).toHaveLength(3);
    const blurs = shadows.map((s) => Number(s.blur.slice(0, -2)));
    expect([...blurs].sort((a, b) => a - b)).toEqual(blurs); // ascending
    for (const s of shadows) expect(s.color).toMatch(/^#[0-9a-f]{6,8}$/);
  });

  it('deriveShadows falls back to preset defaults when no shadows observed', () => {
    const defaults: [ParsedShadow, ParsedShadow, ParsedShadow] = [
      { color: '#00000014', offsetX: '0px', offsetY: '1px', blur: '2px', spread: '0px' },
      { color: '#0000001f', offsetX: '0px', offsetY: '2px', blur: '8px', spread: '-1px' },
      { color: '#00000029', offsetX: '0px', offsetY: '8px', blur: '24px', spread: '-4px' },
    ];
    expect(deriveShadows(loadFixture('zengarden'), defaults)).toEqual(defaults);
  });
});

describe('inferType — base size / weights / line-heights', () => {
  const defaults: TypeInference = {
    baseSize: '1rem',
    weights: { regular: 400, medium: 500, semibold: 600, bold: 700 },
    lineHeights: { tight: 1.2, base: 1.55, loose: 1.7 },
  };

  it('infers base size from the dominant body-range size (example.com -> 1rem)', () => {
    const type = inferType(loadFixture('example'), defaults);
    expect(type.baseSize).toBe('1rem'); // 16px
    expect(type.weights.regular).toBe(400);
    expect(type.weights.bold).toBe(700); // heaviest observed
  });

  it('derives line-heights from observed lineHeightPx ratios (zengarden)', () => {
    const type = inferType(loadFixture('zengarden'), defaults);
    expect(type.lineHeights.tight).toBeGreaterThanOrEqual(1);
    expect(type.lineHeights.loose).toBeLessThanOrEqual(2);
    expect(type.lineHeights.tight).toBeLessThanOrEqual(type.lineHeights.loose);
  });

  it('returns defaults when the extraction has no type sizes', () => {
    expect(inferType(loadFixture('blank'), defaults)).toEqual(defaults);
  });
});

// --- Default-fill policy + determinism --------------------------------------

describe('normalize — default-fill policy (near-empty stays valid)', () => {
  it('a blank extraction produces a valid, complete token set grounded in the preset', () => {
    const result = normalize(loadFixture('blank'));
    expect(validate(result.tokens, { kind: 'tokens' }).ok).toBe(true);
    expect(validate(result.dark, { kind: 'overlay' }).ok).toBe(true);
    // full category set survives from the preset skeleton
    const cats = Object.keys(result.tokens).filter((k) => !k.startsWith('$'));
    expect(cats).toEqual(
      expect.arrayContaining(['color', 'font', 'type', 'space', 'radius', 'shadow', 'motion']),
    );
  });
});

// --- Hostile / malformed input (review iteration 2: never a crash) -----------

/** A populated-but-malformed extraction: every field carries a hostile shape. */
function hostileExtraction(): RawExtraction {
  return {
    url: 'https://hostile.example',
    extractedAt: '2026-07-16T00:00:00.000Z',
    engine: { name: 'hostile', version: '0' },
    colors: [
      { hex: 'not-a-color', frequency: 99, roles: [{ role: 'accent', count: 50 }] },
      { hex: '#zzzzzz', frequency: 50, roles: [{ role: 'fill', count: 10 }] },
      { hex: '#334488', frequency: 2, roles: [{ role: 'accent', count: 1 }] },
      { hex: '#eeeeee', frequency: 1, roles: [{ role: 'background', count: 1 }] },
    ],
    // A null families entry is legal JSON; the string[] type is not enforced
    // at runtime on a directly-constructed RawExtraction.
    fonts: [
      { families: [null, 'Arial'] as unknown as string[], role: 'body', frequency: 3 },
      { families: [undefined] as unknown as string[], role: 'heading', frequency: 1 },
    ],
    typeSizes: [
      { px: 0, frequency: 50 }, // sr-only utility noise
      { px: 900, frequency: 1 },
    ],
    spacing: [{ px: Number.NaN, frequency: 1 }, { px: 16, frequency: 2 }],
    radii: [],
    shadows: [{ css: 'rgba(abc, def, ghi, xyz) 0px 30px 45px -30px', frequency: 9 }],
    screenshots: [],
  };
}

describe('normalize — hostile input never crashes (review iteration 2 regression)', () => {
  it('malformed hex among valid clusters: valid output, valid seed, collected warning', () => {
    const result = normalize(hostileExtraction());
    // never a throw; the valid chromatic cluster wins the seed
    expect(result.seed).toBe('#334488');
    expect(result.seedFromFallback).toBe(false);
    expect(result.warnings.some((w) => w.includes('not-a-color'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('#zzzzzz'))).toBe(true);
    // both documents still validate
    expect(validate(result.tokens, { kind: 'tokens' }).ok).toBe(true);
    expect(validate(result.dark, { kind: 'overlay' }).ok).toBe(true);
  });

  it('non-numeric rgba() shadow channels fall back to the preset default (no "#NaNNaNNaN")', () => {
    const result = normalize(hostileExtraction());
    expect(JSON.stringify(result.tokens)).not.toContain('NaN');
    const validated = validate(result.tokens, { kind: 'tokens' });
    expect(validated.ok, JSON.stringify(validated.issues)).toBe(true);
  });

  it('a 0px-dominant type extraction keeps the preset base size, never "0rem"', () => {
    const result = normalize(hostileExtraction());
    const tokens = result.tokens as { type: { size: { base: { $value: string } } } };
    expect(tokens.type.size.base.$value).toBe('1rem');
  });
});

describe('parseShadow — malformed channels (review iteration 2 regression)', () => {
  it('returns undefined for non-numeric rgba() channels instead of "#NaNNaNNaN"', () => {
    expect(parseShadow('rgba(abc, def, ghi, xyz) 0px 30px 45px -30px')).toBeUndefined();
    expect(parseShadow('rgba(10, 20, 30, xyz) 0px 2px 4px')).toBeUndefined(); // NaN alpha
  });
});

describe('parseShadow — degenerate hex literals (review iteration 3 regression)', () => {
  it('rejects invalid-length hex runs instead of writing them verbatim', () => {
    // The sibling of the "#NaNNaNNaN" bug, one branch over: any of these
    // written into tokens.json would fail validate().
    expect(parseShadow('# 0px 1px 2px')).toBeUndefined(); // bare hash
    expect(parseShadow('#ff 0px 1px 2px')).toBeUndefined(); // 2 digits
    expect(parseShadow('#abcde 0px 1px 2px')).toBeUndefined(); // 5 digits
    expect(parseShadow('#abcdef12345 0px 1px 2px')).toBeUndefined(); // 11 digits
  });

  it('still accepts every well-formed CSS hex length (3/4/6/8)', () => {
    expect(parseShadow('#000 0px 1px 2px')!.color).toBe('#000');
    expect(parseShadow('#0002 0px 1px 2px')!.color).toBe('#0002');
    expect(parseShadow('#aabbcc 0px 1px 2px')!.color).toBe('#aabbcc');
    expect(parseShadow('#aabbccdd 0px 1px 2px')!.color).toBe('#aabbccdd');
  });

  it('normalize with a degenerate hex shadow keeps the preset default + collects a warning', () => {
    const ex = loadFixture('blank');
    ex.shadows = [{ css: '#ff 0px 1px 2px', frequency: 100 }];
    const result = normalize(ex);
    expect(JSON.stringify(result.tokens)).not.toContain('"#ff"');
    const validated = validate(result.tokens, { kind: 'tokens' });
    expect(validated.ok, JSON.stringify(validated.issues)).toBe(true);
    expect(result.warnings.some((w) => w.includes('shadow') && w.includes('#ff'))).toBe(true);
  });
});

describe('deriveRadii — NaN observations must not vote (review iteration 3 regression)', () => {
  it('a NaN px entry no longer credits its frequency to the 4px slot', () => {
    const ex = loadFixture('blank');
    // Reviewer repro: without the guard, NaN's 99 votes land on the 4px slot
    // and displace a genuinely-observed radius from the top three.
    ex.radii = [
      { px: Number.NaN, frequency: 99 },
      { px: 6, frequency: 5 },
      { px: 10, frequency: 4 },
      { px: 14, frequency: 3 },
    ];
    const radii = deriveRadii(ex, { sm: '4px', md: '8px', lg: '12px', pill: '999px' });
    expect(radii).toEqual({ sm: '6px', md: '10px', lg: '12px', pill: '999px' });
  });

  it('a NaN frequency entry is skipped too', () => {
    const ex = loadFixture('blank');
    ex.radii = [
      { px: 8, frequency: Number.NaN },
      { px: 6, frequency: 5 },
    ];
    // Only one clean distinct radius -> falls back to preset defaults.
    const radii = deriveRadii(ex, { sm: '4px', md: '8px', lg: '12px', pill: '999px' });
    expect(radii).toEqual({ sm: '4px', md: '8px', lg: '12px', pill: '999px' });
  });
});

describe('inferType — degenerate size floor (review iteration 2 regression)', () => {
  it('a 0px-dominant pool with no sane sizes falls back to the preset default', () => {
    const defaults: TypeInference = {
      baseSize: '1rem',
      weights: { regular: 400, medium: 500, semibold: 600, bold: 700 },
      lineHeights: { tight: 1.2, base: 1.55, loose: 1.7 },
    };
    const ex = hostileExtraction();
    const type = inferType(ex, defaults);
    expect(type.baseSize).toBe('1rem'); // never '0rem' or '56.25rem'
  });
});

describe('normalize — determinism', () => {
  it('the same fixture yields byte-identical documents across runs', () => {
    for (const name of ['blank', 'example', 'zengarden', 'stripe']) {
      const a = JSON.stringify(normalize(loadFixture(name)).tokens);
      const b = JSON.stringify(normalize(loadFixture(name)).tokens);
      expect(a).toBe(b);
      const da = JSON.stringify(normalize(loadFixture(name)).dark);
      const db = JSON.stringify(normalize(loadFixture(name)).dark);
      expect(da).toBe(db);
    }
  });
});
