/**
 * Capture-sanity gate — Brand-Fidelity Step 2 hardening (data integrity).
 *
 * WHY. The benchmark replays committed `raw-extraction.json` fixtures as frozen
 * ground truth. A capture that is NOT the real site — a bot-block "Access denied"
 * wall, a CAPTCHA/interstitial, an error page, a near-blank render — silently
 * becomes ground truth, and (per the measurement-validity rule) the number then
 * lies with no unit-test able to see it. This exact failure shipped: the
 * louisvuitton fixture is a WAF deny page (3 colours), and the Step-2 replay test
 * rationalised it as "minimal-real (louisvuitton, 3 colours)". This module is the
 * loud check that a thin capture fails instead of freezing.
 *
 * WHAT it distinguishes (grounded in the committed fixtures' richness profile):
 *   - `likely-not-a-page` — the DOM is near-empty across STRUCTURAL axes
 *     (typeSizes / spacing / radii / shadows), the signature of a deny/CAPTCHA/
 *     error/blank capture. louisvuitton: 0/4 structural axes → flagged.
 *   - `thin-colors` — the page is structurally real but few colours carry a role,
 *     so the colour read is unreliable (e.g. a site whose palette is declared in
 *     OKLCH / CSS custom properties the engine could not resolve). basecamp is a
 *     REAL page (4/4 structural axes) whose colour extraction collapsed to 4
 *     hexes (0 role-bearing) — a genuine extractor weakness, not a bad capture, so
 *     it is KEPT and merely flagged.
 *   - `ok` — structurally real with a usable colour read.
 *
 * NOT caught here (by design): a cookie-consent OVERLAY that still lets the real
 * DOM extract richly (github/kurzgesagt/spotify) — the palette is intact, only the
 * screenshot is obscured; that is a visual (screenshot) check, not an extraction
 * one. Overlay detection belongs to the capture step, not this gate.
 *
 * Types come from the extraction adapter (the one source of truth); this module
 * never re-declares the shape and never scores fidelity — it only judges whether a
 * capture is a real page worth pinning ground truth against.
 */

import type { RawExtraction } from '../src/extract/engine/adapter.ts';

/** Below this many role-bearing colours, the colour read is treated as unreliable. */
export const MIN_ROLED_COLORS = 5;

/**
 * A capture must show at least this many of the 4 STRUCTURAL axes to read as a
 * real rendered page. Each axis present = the DOM carried non-trivial layout
 * evidence on that dimension. A deny/error/blank page scores 0–1; every real
 * corpus site scores 4.
 */
export const MIN_STRUCTURAL_AXES = 2;

/** Per-axis presence thresholds — an axis "counts" only above trivial noise. */
const STRUCTURAL_THRESHOLDS = {
  typeSizes: 5,
  spacing: 6,
  radii: 2,
  shadows: 1,
} as const;

export type CaptureVerdict = 'ok' | 'thin-colors' | 'likely-not-a-page';

export interface CaptureAssessment {
  verdict: CaptureVerdict;
  /** Distinct colour clusters extracted. */
  distinctColors: number;
  /** Colour clusters carrying at least one role (the usable-signal count). */
  roledColors: number;
  /** How many of the 4 structural axes are present (0..4). */
  structuralAxes: number;
  /** Human-readable reasons behind a non-`ok` verdict (empty when ok). */
  signals: string[];
}

/**
 * Assess whether a RawExtraction looks like a real, pinnable capture. Pure; reads
 * only counts. `likely-not-a-page` takes precedence over `thin-colors` (a deny
 * page is also colour-thin, but the structural poverty is the load-bearing tell).
 */
export function assessCapture(raw: RawExtraction): CaptureAssessment {
  const distinctColors = raw.colors.length;
  const roledColors = raw.colors.filter((c) => c.roles.length > 0).length;
  const structuralAxes =
    (raw.typeSizes.length >= STRUCTURAL_THRESHOLDS.typeSizes ? 1 : 0) +
    (raw.spacing.length >= STRUCTURAL_THRESHOLDS.spacing ? 1 : 0) +
    (raw.radii.length >= STRUCTURAL_THRESHOLDS.radii ? 1 : 0) +
    (raw.shadows.length >= STRUCTURAL_THRESHOLDS.shadows ? 1 : 0);

  const signals: string[] = [];
  let verdict: CaptureVerdict = 'ok';

  if (structuralAxes < MIN_STRUCTURAL_AXES) {
    verdict = 'likely-not-a-page';
    signals.push(
      `only ${structuralAxes}/4 structural axes present (typeSizes/spacing/radii/shadows) — the DOM is near-empty, the signature of a bot-block / CAPTCHA / error / blank capture, not a rendered site`,
    );
  } else if (roledColors < MIN_ROLED_COLORS) {
    verdict = 'thin-colors';
    signals.push(
      `only ${roledColors} role-bearing colour(s) (< ${MIN_ROLED_COLORS}) though the page is structurally real — the colour read likely missed the brand palette (e.g. unresolved OKLCH / CSS custom properties); usable but flagged`,
    );
  }

  return { verdict, distinctColors, roledColors, structuralAxes, signals };
}

/** True when a capture is a real, pinnable page (not a deny/error/blank wall). */
export function isRealPage(raw: RawExtraction): boolean {
  return assessCapture(raw).verdict !== 'likely-not-a-page';
}
