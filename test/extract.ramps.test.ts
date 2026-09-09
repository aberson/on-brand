/**
 * Ramp anchor tests (plan.md Step 10 "Done when": monotonic lightness, all 12
 * steps in sRGB gamut after clamping, seed hue preserved within tolerance).
 *
 * These are the measurement-validity anchors for the ramp engine: a saturated
 * seed (#ff0080) is the gamut-stress probe (§10 "OKLCH gamut clipping on
 * saturated seeds"), and the achromatic carve-out is verified explicitly.
 */

import { describe, expect, it } from 'vitest';
import {
  ACHROMATIC_CHROMA,
  FALLBACK_BRAND_SEED,
  HUE_TOLERANCE_DEG,
  RAMP_STEPS,
  buildBrandRamp,
  buildNeutralRamp,
  buildRamp,
  hueDeltaDeg,
  hueOf,
  inSrgbGamut,
  lightnessOf,
} from '../src/extract/ramps.ts';

const SEEDS = ['#ff0080', '#533afd', '#0d2c40', '#2e8b57', '#3b63a8', '#00bcd9'];

describe('ramp anchors — monotonic lightness + sRGB output (both variants)', () => {
  // NOTE (review iteration 2): a per-step `inSrgbGamut(hex)` assertion was
  // removed as tautological — ANY "#rrggbb" string is an sRGB byte triplet and
  // is in-gamut by construction, so it could not fail even against an
  // UNCLAMPED implementation. The discriminating in-gamut anchor is the
  // clampWarnings block below: the production `clamped` flag is set only when
  // the PRE-conversion OKLCH coords fall outside sRGB, so an implementation
  // that skips toGamut() fails those assertions.
  for (const seed of SEEDS) {
    for (const variant of ['light', 'dark'] as const) {
      it(`${seed} (${variant}): 12 steps, strictly monotonic L, 6-digit hex out`, () => {
        const ramp = buildBrandRamp(seed, variant);
        expect(ramp.steps).toHaveLength(RAMP_STEPS);

        const lightnesses = ramp.steps.map(lightnessOf);
        for (let i = 1; i < lightnesses.length; i++) {
          if (variant === 'light') {
            // light profile is light -> dark (decreasing L)
            expect(lightnesses[i]!).toBeLessThan(lightnesses[i - 1]!);
          } else {
            // dark profile is dark-base -> light-foreground (increasing L)
            expect(lightnesses[i]!).toBeGreaterThan(lightnesses[i - 1]!);
          }
        }

        for (const step of ramp.steps) {
          expect(step).toMatch(/^#[0-9a-f]{6}$/);
        }
      });
    }
  }
});

describe('ramp anchors — seed hue preserved within tolerance', () => {
  it('the saturated gamut-stress probe #ff0080 holds delta-h < 8 deg on every chromatic step', () => {
    const ramp = buildBrandRamp('#ff0080', 'light');
    const seedHue = hueOf('#ff0080');
    expect(seedHue).toBeDefined();

    let chromaticSteps = 0;
    for (const step of ramp.steps) {
      const h = hueOf(step);
      if (h === undefined) continue; // near-achromatic light tints are exempt
      chromaticSteps++;
      expect(hueDeltaDeg(h, seedHue!)).toBeLessThan(HUE_TOLERANCE_DEG);
    }
    // Most of a saturated seed's ramp must actually carry hue (else the check is vacuous).
    expect(chromaticSteps).toBeGreaterThanOrEqual(8);
  });

  it('a saturated seed clamps (reduces chroma) and records a warning per clamped step', () => {
    // THE discriminating in-gamut anchor (review iteration 2): `clamped` is set
    // in production only when the pre-hex OKLCH coords are OUTSIDE sRGB, so an
    // unclamped implementation produces ZERO warnings and fails here. At
    // #ff0080's chroma the majority of the light profile's 12 intended steps
    // overshoot sRGB (measured: 12/12 light, 5 dark — the dark profile's
    // low-L stops carry smaller chroma multipliers, so fewer overshoot).
    const light = buildBrandRamp('#ff0080', 'light');
    expect(light.clampWarnings.length).toBeGreaterThanOrEqual(8);
    for (const warning of light.clampWarnings) {
      expect(warning).toContain('sRGB gamut');
    }
    const dark = buildBrandRamp('#ff0080', 'dark');
    expect(dark.clampWarnings.length).toBeGreaterThan(0);
  });

  it('an in-gamut low-chroma seed clamps nothing (the anchor can pass as well as fail)', () => {
    // Calibration counterpart: #3b63a8's intended chroma stays inside sRGB at
    // every stop, so a correct implementation emits zero warnings here.
    expect(buildBrandRamp('#3b63a8', 'light').clampWarnings).toEqual([]);
  });
});

describe('ramp anchors — achromatic carve-out', () => {
  it('a grey seed yields a pure-grey ramp: no hue, no clamping, still monotonic', () => {
    const ramp = buildBrandRamp('#808080', 'light');
    expect(ramp.achromatic).toBe(true);
    expect(ramp.seedHue).toBeUndefined();
    expect(ramp.clampWarnings).toEqual([]);
    for (const step of ramp.steps) {
      expect(hueOf(step)).toBeUndefined(); // every step is a true grey
    }
    const ls = ramp.steps.map(lightnessOf);
    for (let i = 1; i < ls.length; i++) expect(ls[i]!).toBeLessThan(ls[i - 1]!);
  });

  it('a very-low-chroma seed (below ACHROMATIC_CHROMA) is treated as achromatic', () => {
    // Build a near-grey by nudging just under the threshold.
    const ramp = buildRamp('#7f8081', { variant: 'light', palette: 'brand' });
    // #7f8081 chroma is well under ACHROMATIC_CHROMA
    expect(ACHROMATIC_CHROMA).toBeGreaterThan(0);
    expect(ramp.achromatic).toBe(true);
  });
});

describe('ramp — determinism', () => {
  it('same seed + variant yields byte-identical steps', () => {
    const a = buildBrandRamp('#533afd', 'light');
    const b = buildBrandRamp('#533afd', 'light');
    expect(a.steps).toEqual(b.steps);
  });

  it('neutral ramp is a near-grey desaturated derivative of the seed hue', () => {
    const neutral = buildNeutralRamp('#533afd', 'light');
    expect(neutral.steps).toHaveLength(RAMP_STEPS);
    // Derived threshold (review iteration 2): every NEUTRAL_C chroma stop
    // (max 0.012) sits BELOW ACHROMATIC_CHROMA (0.02) — hueOf's achromatic
    // cutoff — so ALL 12 steps must read as hueless, not an eyeballed subset.
    const hueless = neutral.steps.filter((s) => hueOf(s) === undefined).length;
    expect(hueless).toBe(RAMP_STEPS);
    // ...and a near-grey ramp never exceeds the sRGB gamut.
    expect(neutral.clampWarnings).toEqual([]);
  });
});

describe('ramp — malformed seed never throws (default-fill policy)', () => {
  it('an unparseable seed falls back to the preset brand seed with a warning', () => {
    const ramp = buildBrandRamp('not-a-color', 'light');
    expect(ramp.steps).toHaveLength(RAMP_STEPS);
    expect(ramp.clampWarnings.some((w) => w.includes('unparseable'))).toBe(true);
    // Fallback content check: identical to a ramp built from the fallback seed.
    expect(ramp.steps).toEqual(buildBrandRamp(FALLBACK_BRAND_SEED, 'light').steps);
  });

  it('hueOf/inSrgbGamut are total on garbage strings', () => {
    expect(hueOf('not-a-color')).toBeUndefined();
    expect(inSrgbGamut('not-a-color')).toBe(false);
  });
});
