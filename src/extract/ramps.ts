/**
 * Seed color -> 12-step perceptual ramp (plan.md §9.10, Step 10).
 *
 * Ramps are computed in OKLCH (perceptually uniform lightness) and clamped to
 * the sRGB gamut, so every emitted step is a real, renderable color. A ramp is
 * built from three fixed profiles, NOT free-form per seed:
 *
 *   - LIGHT_L / DARK_L    fixed lightness stops (0..1 OKLCH L), monotonic. The
 *                         light profile is Radix-style light-to-dark; the dark
 *                         profile is dark-base-to-light-foreground (matching the
 *                         default preset's dark overlay convention, §4 Modes).
 *   - a chroma profile    per palette (brand/neutral/status): brand rides the
 *                         seed's chroma, neutral is a near-gray tint of the seed
 *                         hue, status uses a conventional hue at brand-ish chroma.
 *   - the seed hue        held CONSTANT across all 12 steps.
 *
 * Because lightness is a fixed monotonic sequence and gamut clamping reduces
 * CHROMA only (colorjs `oklch.c` gamut mapping — reduce chroma, keep L and H),
 * two anchor invariants hold by construction and are pinned by tests:
 *
 *   1. Monotonic lightness across steps 1..12 (lightness is never touched).
 *   2. All 12 steps land inside sRGB after clamping.
 *
 * Hue-preservation tolerance (§10 risk "OKLCH gamut clipping on saturated
 * seeds"): the CSS gamut-map final-clip introduces at most a few degrees of hue
 * drift. We hold delta-h < HUE_TOLERANCE_DEG (8 deg) for every step vs. the
 * seed hue. ACHROMATIC CARVE-OUT: a near-gray seed (chroma <
 * ACHROMATIC_CHROMA, or an undefined OKLCH hue) has no meaningful hue, so it
 * produces a pure-gray ramp (hue held at 0, chroma 0) and the hue-tolerance
 * check does not apply — comparing hue against an achromatic seed is
 * meaningless (OKLCH reports hue = NaN for a true gray).
 */

import Color from 'colorjs.io';

export type RampVariant = 'light' | 'dark';
export type RampPalette = 'brand' | 'neutral' | 'status';

/** Seed chroma below which a color is treated as achromatic (no hue). */
export const ACHROMATIC_CHROMA = 0.02;

/** Max hue drift (deg) a clamped step may show vs. the seed hue (§10). */
export const HUE_TOLERANCE_DEG = 8;

/** Number of steps in every ramp (Radix-style 12-step scale, §4). */
export const RAMP_STEPS = 12;

/**
 * Fallback brand seed when an extraction yields no usable brand color (the
 * garbage/blank default-fill path): the default preset's brand-9 accent. Kept
 * here as a hex constant, matched to templates/presets/default/tokens.json.
 */
export const FALLBACK_BRAND_SEED = '#3b63a8';

// Fixed lightness stops (OKLCH L, 0..1). Both are strictly monotonic.
const LIGHT_L = [0.985, 0.965, 0.935, 0.895, 0.845, 0.79, 0.72, 0.64, 0.56, 0.51, 0.43, 0.27];
const DARK_L = [0.205, 0.24, 0.285, 0.335, 0.395, 0.46, 0.54, 0.625, 0.7, 0.76, 0.84, 0.945];

// Chroma profiles (multipliers on a per-palette base chroma).
const BRAND_C = [0.05, 0.09, 0.16, 0.26, 0.4, 0.58, 0.8, 1.0, 1.1, 1.05, 0.9, 0.55];
// Neutral chroma is an ABSOLUTE tiny tint of the seed hue (near-gray).
const NEUTRAL_C = [
  0.004, 0.005, 0.006, 0.007, 0.008, 0.009, 0.01, 0.011, 0.012, 0.012, 0.011, 0.008,
];

/** Minimum brand base chroma so a low-chroma seed still yields a colored ramp. */
const BRAND_BASE_MIN = 0.12;
/** Minimum status base chroma so conventional hues read as their color. */
const STATUS_BASE_MIN = 0.1;

export interface Ramp {
  /** 12 sRGB hex strings ("#rrggbb"), step 1..12 = index 0..11. */
  steps: string[];
  /** Seed hue in degrees, or undefined for an achromatic seed. */
  seedHue: number | undefined;
  /** True when the seed had no meaningful hue (pure-gray ramp). */
  achromatic: boolean;
  /** Human notes when gamut clamping reduced a step's chroma (§10 warning). */
  clampWarnings: string[];
}

/** OKLCH {l, c, h} of a hex/CSS color; h is NaN for a true gray. THROWS on an
 * unparseable string — pipeline-facing entry points (buildRamp, hueOf) wrap it
 * so extraction-derived garbage never propagates a throw (review iteration 2). */
function toOklch(cssColor: string): { l: number; c: number; h: number } {
  const [l, c, h] = new Color(cssColor).to('oklch').coords;
  return { l: l!, c: c!, h: h! };
}

/** toOklch that returns undefined instead of throwing on an unparseable color. */
function tryOklch(cssColor: string): { l: number; c: number; h: number } | undefined {
  try {
    return toOklch(cssColor);
  } catch {
    return undefined;
  }
}

/**
 * Render an OKLCH (L, C, H) to a gamut-clamped sRGB "#rrggbb". Clamping reduces
 * chroma (keeps L + H) via colorjs `oklch.c` mapping; `clamped` reports whether
 * any reduction happened. Byte values are rounded from the gamma sRGB coords so
 * the result is always a full 6-digit hex (never a collapsed "#rgb").
 */
function hexFromOklch(l: number, c: number, h: number): { hex: string; clamped: boolean } {
  let color = new Color('oklch', [l, c, Number.isFinite(h) ? h : 0]);
  let clamped = false;
  if (!color.inGamut('srgb')) {
    color = color.toGamut({ space: 'srgb', method: 'oklch.c' });
    clamped = true;
  }
  const srgb = color.to('srgb');
  const bytes = srgb.coords.map((v) => Math.max(0, Math.min(255, Math.round(v * 255))));
  const hex = `#${bytes.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  return { hex, clamped };
}

function lightnessStops(variant: RampVariant): number[] {
  return variant === 'light' ? LIGHT_L : DARK_L;
}

/**
 * Build a 12-step ramp from a seed color. `palette` selects the chroma
 * behavior; `variant` selects the lightness profile (light theme vs. dark
 * overlay). Deterministic: same inputs -> byte-identical steps.
 */
export function buildRamp(
  seedColor: string,
  opts: { variant: RampVariant; palette: RampPalette },
): Ramp {
  const { variant, palette } = opts;
  const clampWarnings: string[] = [];

  // Never throw on a malformed seed (default-fill policy, review iteration 2):
  // an unparseable seed string falls back to the preset brand seed + a warning,
  // keeping buildRamp total for callers feeding it extraction/LLM-derived input.
  let seed = tryOklch(seedColor);
  if (seed === undefined) {
    seed = toOklch(FALLBACK_BRAND_SEED);
    clampWarnings.push(
      `unparseable ${palette} seed color ${JSON.stringify(seedColor)}; ` +
        `fell back to the default preset brand seed ${FALLBACK_BRAND_SEED}`,
    );
  }
  const achromatic = !Number.isFinite(seed.h) || seed.c < ACHROMATIC_CHROMA;
  const hue = achromatic ? 0 : seed.h;
  const stops = lightnessStops(variant);
  const steps: string[] = [];
  for (let i = 0; i < RAMP_STEPS; i++) {
    const l = stops[i]!;
    let chroma: number;
    if (achromatic && palette !== 'status') {
      // Pure-gray ramp (brand or neutral) for a hueless seed.
      chroma = 0;
    } else if (palette === 'neutral') {
      chroma = NEUTRAL_C[i]!;
    } else if (palette === 'status') {
      chroma = Math.max(seed.c, STATUS_BASE_MIN) * BRAND_C[i]!;
    } else {
      chroma = Math.max(seed.c, BRAND_BASE_MIN) * BRAND_C[i]!;
    }
    const { hex, clamped } = hexFromOklch(l, chroma, hue);
    if (clamped) {
      clampWarnings.push(
        `${palette} ramp step ${i + 1} exceeded sRGB gamut at the seed chroma; ` +
          `clamped (chroma reduced, lightness + hue kept) to ${hex}`,
      );
    }
    steps.push(hex);
  }

  return {
    steps,
    seedHue: achromatic ? undefined : hue,
    achromatic,
    clampWarnings,
  };
}

/**
 * A desaturated derivative of the brand seed: same hue, near-gray chroma. The
 * neutral ramp (plan §4: "neutral ramp from a desaturated derivative").
 */
export function buildNeutralRamp(seedColor: string, variant: RampVariant): Ramp {
  return buildRamp(seedColor, { variant, palette: 'neutral' });
}

/** The brand ramp for a seed (plan §4: brand ramp 1-12 from the seed). */
export function buildBrandRamp(seedColor: string, variant: RampVariant): Ramp {
  return buildRamp(seedColor, { variant, palette: 'brand' });
}

/** Smallest signed hue distance (deg) between two hues, in [0, 180]. */
export function hueDeltaDeg(a: number, b: number): number {
  return Math.abs((((a - b + 540) % 360) - 180));
}

/** The OKLCH hue (deg) of a color, or undefined when achromatic OR unparseable. */
export function hueOf(cssColor: string): number | undefined {
  const parsed = tryOklch(cssColor);
  if (parsed === undefined) return undefined;
  const { c, h } = parsed;
  if (!Number.isFinite(h) || c < ACHROMATIC_CHROMA) return undefined;
  return h;
}

/**
 * OKLCH lightness (0..1) of a color — the monotonicity probe for tests. Probe
 * helper for ramp-PRODUCED hexes (always parseable); throws on garbage by
 * design — it is not on the extraction-data path.
 */
export function lightnessOf(cssColor: string): number {
  return toOklch(cssColor).l;
}

/** True when a color is inside the sRGB gamut; false for an unparseable string. */
export function inSrgbGamut(cssColor: string): boolean {
  try {
    return new Color(cssColor).inGamut('srgb');
  } catch {
    return false;
  }
}
