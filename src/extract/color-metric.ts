/**
 * Shared perceptual colour metric for the extraction pipeline.
 *
 * A pure leaf: no I/O, no state, no clock, and no dependency beyond
 * `colorjs.io`.  Both `image-palette.ts` (the greedy Delta E 3 cluster merge)
 * and `compact-palette.ts` (the `image-cluster-v2` selector) import from here,
 * so the metric and its derived lightness bound have exactly ONE owner instead
 * of a hand-copy per module.
 *
 * `src/eval/color-fidelity.ts` keeps its own string-based `deltaE2000`: it has a
 * different API and a different lifecycle (brand-fidelity scoring, not the
 * producer path), and folding it in here is deliberately out of scope.
 */

import Color from 'colorjs.io';

/**
 * The largest value CIEDE2000's lightness weighting term `S_L` can take,
 * rounded UP.
 *
 * CIEDE2000 combines its terms Euclidean-style, with lightness entering as
 * `ΔL' / (k_L · S_L)`.  With `k_L = 1` and `ΔL' = ΔL` (CIEDE2000 does not
 * rescale `L`), and with every other term non-negative:
 *
 *     ΔE00  ≥  |ΔL| / S_L
 *
 * `S_L = 1 + (0.015 · (L̄ − 50)²) / sqrt(20 + (L̄ − 50)²)` peaks at `L̄ ∈ {0, 100}`,
 * i.e. `(L̄ − 50)² = 2500`:
 *
 *     S_L(max) = 1 + (0.015 · 2500) / sqrt(20 + 2500)
 *              = 1 + 37.5 / 50.1996…
 *              = 1.74702…
 *
 * so `ΔE00 ≥ |ΔL| / 1.75` holds for every pair of colours.
 *
 * The ceiling is deliberately rounded UP to `1.75` rather than tightened to the
 * exact `1.74702`.  Rounding up is the SAFE direction — a larger ceiling admits
 * more pairs to the expensive exact test, so it can never skip a pair that would
 * have matched — and `1.75` is the value `compact-palette.ts` already shipped as
 * `PALETTE_FAMILY_DELTA_E * 1.75`.  Reusing it makes
 * `lightnessGapCeiling(PALETTE_FAMILY_DELTA_E)` reproduce that module's frozen
 * `21.0` exactly, so adopting this shared owner cannot move the released
 * selector by even one ULP.  Do not "tighten" it.
 */
export const S_L_CEILING = 1.75;

/**
 * CIEDE2000 distance between two ALREADY-CONSTRUCTED colours.
 *
 * The signature takes `Color` objects rather than hex strings on purpose: it
 * puts allocation under the caller's control, which is what lets a hot loop
 * build each colour once instead of once per comparison.  The library call
 * itself is unchanged, so the numbers are bit-identical to constructing the same
 * colours inline.  Never reimplement CIEDE2000 in local arithmetic here —
 * numerical identity across this boundary is what keeps every produced palette
 * stable.
 */
export function deltaE2000(left: Color, right: Color): number {
  return left.deltaE(right, { method: '2000' });
}

/**
 * The largest `|ΔL|` at which two colours can still be within `deltaE` of each
 * other.  A pair whose lightness gap reaches this value provably has
 * `ΔE00 ≥ deltaE`, so a caller may skip the exact distance for it without
 * changing any decision.  Derived from `S_L_CEILING`, never tuned.
 */
export function lightnessGapCeiling(deltaE: number): number {
  return deltaE * S_L_CEILING;
}
