/**
 * Contrast math for the `onbrand check` gate (plan.md §9.8).
 *
 * Two instruments, both from colorjs.io (plan §2 stack) so we never re-derive
 * color science:
 *   - WCAG 2.1 relative-contrast ratio — the HARD gate. AA requires 4.5:1 for
 *     normal text (WCAG 2.1 SC 1.4.3). Symmetric in fg/bg.
 *   - APCA Lc (0.0.98G, as shipped in colorjs.io) — REPORTED alongside every
 *     pairing (advisory); `--strict` promotes a sub-threshold |Lc| to an error.
 *
 * colorjs.io orientation (verified against its own APCA.js source + a live
 * probe, 2026-07-16): the standalone `contrastAPCA(background, foreground)` is
 * bound as a prototype method with `this` = the FIRST argument, so the
 * background is the receiver: `new Color(bg).contrastAPCA(new Color(fg))`.
 * Signed result — POSITIVE for dark text on a light bg, NEGATIVE for light
 * text on a dark bg; the magnitude |Lc| is what the threshold compares.
 *
 * WCAG is symmetric, so `new Color(fg).contrastWCAG21(new Color(bg))` is
 * orientation-independent.
 */

import Color from 'colorjs.io';

/** WCAG 2.1 AA minimum contrast ratio for normal (body) text (SC 1.4.3). */
export const WCAG_AA_NORMAL = 4.5;

/**
 * APCA Lc threshold used by `--strict` (advisory otherwise).
 *
 * Chosen: Lc 60. Published APCA Readability Criterion "Bronze Simple Mode"
 * guidance (https://readtech.org/ARC/tests/bronze-simple-mode/; algorithm
 * APCA 0.0.98G, the version colorjs.io ships) sets Lc 60 as the minimum for
 * larger/columnar content text (24px normal / ~18.7px bold); body text
 * prefers Lc 75+. Our declared pairings mix body text (semantic text/bg) with
 * UI text (status labels, chart chrome), so Lc 60 is the defensible
 * one-threshold floor: high enough to flag genuinely-weak pairings, not so
 * high it fails legible UI text. Compared against the ABSOLUTE Lc.
 */
export const APCA_STRICT_LC = 60;

export interface ContrastResult {
  /** WCAG 2.1 ratio (1..21), rounded to 2dp FOR DISPLAY ONLY. undefined on a parse error. */
  wcag?: number;
  /** Signed APCA Lc, rounded to 1dp FOR DISPLAY ONLY. undefined on a parse error. */
  apca?: number;
  /** WCAG 2 AA pass (RAW ratio >= 4.5:1 — never the rounded display value). */
  wcagPass: boolean;
  /** APCA pass (RAW |Lc| >= APCA_STRICT_LC — never the rounded display value). */
  apcaPass: boolean;
  /** Set when a color failed to parse or produced a non-numeric contrast; wcag/apca are then absent. */
  parseError?: string;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Evaluate one fg-on-bg color pairing. Never throws: an unparseable color
 * string yields a `parseError` result (both metrics fail) so the gate reports
 * "could not read this color" rather than crashing mid-run.
 */
export function evaluateContrast(fgValue: string, bgValue: string): ContrastResult {
  let fg: Color;
  let bg: Color;
  try {
    fg = new Color(fgValue);
  } catch (cause) {
    return {
      wcagPass: false,
      apcaPass: false,
      parseError: `unparseable foreground color ${JSON.stringify(fgValue)} (${errText(cause)})`,
    };
  }
  try {
    bg = new Color(bgValue);
  } catch (cause) {
    return {
      wcagPass: false,
      apcaPass: false,
      parseError: `unparseable background color ${JSON.stringify(bgValue)} (${errText(cause)})`,
    };
  }

  // Gate on the RAW values; round only the display fields. Rounding first
  // opened a false-pass band (raw 4.4975:1 displays as 4.50 — a genuine AA
  // violation that must NOT pass the hard gate; review finding, iteration 2).
  const rawWcag = fg.contrastWCAG21(bg);
  const rawApca = bg.contrastAPCA(fg); // receiver = background (see file header)

  // colorjs.io accepts CSS Color 4 `none` components (e.g. "rgb(none none
  // none)") without throwing, but APCA then yields NaN — route that to the
  // parse-error branch instead of shipping NaN through the report.
  if (Number.isNaN(rawWcag) || Number.isNaN(rawApca)) {
    return {
      wcagPass: false,
      apcaPass: false,
      parseError:
        `non-numeric contrast result for ${JSON.stringify(fgValue)} on ${JSON.stringify(bgValue)}` +
        ' (a CSS Color 4 "none" component?)',
    };
  }

  return {
    wcag: round(rawWcag, 2),
    apca: round(rawApca, 1),
    wcagPass: rawWcag >= WCAG_AA_NORMAL,
    apcaPass: Math.abs(rawApca) >= APCA_STRICT_LC,
  };
}

function errText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
