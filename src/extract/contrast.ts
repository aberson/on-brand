/**
 * Extraction-side contrast auto-fix SUGGESTIONS (plan.md §9.8, Step 10).
 *
 * The `onbrand check` gate (src/check/contrast.ts) is the HARD WCAG gate over a
 * project's *token* pairings. This module is different: it looks at the RAW
 * extracted fg/bg color pairs (a site's actual text-on-background usage) and,
 * where a pair fails WCAG 2 AA, proposes the nearest generated ramp step that
 * WOULD pass — data for the Step 12 extraction report, never a silent mutation
 * of the tokens.
 *
 * The contrast math is imported from the check gate (`evaluateContrast`) — one
 * source of truth for WCAG/APCA, never re-derived here (measurement-validity:
 * assemble through the production code path).
 *
 * Suggestion shape (per failing pair):
 *   { fgHex, bgHex, ratio, passes:false, suggestion?: {hex, ramp, step, ratio} }
 * A `suggestion` is present when some ramp step reaches WCAG_AA_NORMAL against
 * the same background; absent (with a note) when no step in the supplied ramps
 * can pass (e.g. a mid-grey background no dark OR light text can satisfy).
 */

import Color from 'colorjs.io';
import { WCAG_AA_NORMAL, evaluateContrast } from '../check/contrast.ts';
import type { ColorCluster, RawExtraction } from './engine/adapter.ts';

/** A named ramp the suggester may draw a replacement step from. */
export interface NamedRamp {
  label: string;
  /** 12 hex steps, index 0..11 = step 1..12. */
  steps: string[];
}

export interface ContrastSuggestion {
  fgHex: string;
  bgHex: string;
  /** WCAG ratio of the observed pair (display-rounded), undefined on parse error. */
  ratio: number | undefined;
  /** Always false here — only failing pairs are returned. */
  passes: false;
  /** Set when a color could not be parsed (the pair is reported, not gated). */
  parseError?: string;
  /** The nearest ramp step that passes 4.5:1 on this bg, when one exists. */
  suggestion?: {
    hex: string;
    ramp: string;
    /** 1..12 step index. */
    step: number;
    ratio: number;
  };
  /** Present when no supplied ramp step could reach 4.5:1 on this background. */
  note?: string;
}

/**
 * OKLCH lightness (0..1) of a color, for "nearest by lightness" selection —
 * undefined instead of a throw on an unparseable string (colorjs.io's
 * constructor throws on garbage; extraction-derived input must never crash
 * the pipeline — review iteration 2 sibling audit).
 */
function lightness(hex: string): number | undefined {
  try {
    return new Color(hex).to('oklch').coords[0]!;
  } catch {
    return undefined;
  }
}

/** Colors whose role evidence names them a foreground (text). */
function foregroundColors(colors: readonly ColorCluster[]): ColorCluster[] {
  return colors.filter((c) => c.roles.some((r) => r.role === 'text' && r.count > 0));
}

/** Colors whose role evidence names them a background. */
function backgroundColors(colors: readonly ColorCluster[]): ColorCluster[] {
  return colors.filter((c) => c.roles.some((r) => r.role === 'background' && r.count > 0));
}

/**
 * Find the nearest ramp step (across the supplied ramps) that passes WCAG AA on
 * `bgHex`. "Nearest" is by OKLCH-lightness distance to the original foreground,
 * so a dark text that fails gets nudged to the nearest passing dark step rather
 * than flipped to white. Deterministic (fixed ramp + step iteration order).
 */
export function nearestPassingStep(
  fgHex: string,
  bgHex: string,
  ramps: readonly NamedRamp[],
): { hex: string; ramp: string; step: number; ratio: number } | undefined {
  const targetL = lightness(fgHex);
  if (targetL === undefined) return undefined; // unparseable fg: no distance metric, no suggestion
  let best: { hex: string; ramp: string; step: number; ratio: number; dist: number } | undefined;
  for (const ramp of ramps) {
    for (let i = 0; i < ramp.steps.length; i++) {
      const hex = ramp.steps[i]!;
      const result = evaluateContrast(hex, bgHex);
      if (!result.wcagPass || result.wcag === undefined) continue;
      const stepL = lightness(hex);
      if (stepL === undefined) continue; // unparseable ramp step: skip, never throw
      const dist = Math.abs(stepL - targetL);
      if (best === undefined || dist < best.dist) {
        best = { hex, ramp: ramp.label, step: i + 1, ratio: result.wcag, dist };
      }
    }
  }
  if (best === undefined) return undefined;
  return { hex: best.hex, ramp: best.ramp, step: best.step, ratio: best.ratio };
}

/**
 * Build auto-fix suggestions for every FAILING extracted fg/bg pair. Pairs are
 * the cross-product of role-tagged text colors and role-tagged background
 * colors; a pair that already passes WCAG AA is omitted (no fix needed). The
 * result is ordered deterministically (text order, then background order).
 */
export function suggestContrastFixes(
  extraction: Pick<RawExtraction, 'colors'>,
  ramps: readonly NamedRamp[],
): ContrastSuggestion[] {
  const fgs = foregroundColors(extraction.colors);
  const bgs = backgroundColors(extraction.colors);
  const out: ContrastSuggestion[] = [];

  for (const fg of fgs) {
    for (const bg of bgs) {
      const result = evaluateContrast(fg.hex, bg.hex);
      if (result.parseError !== undefined) {
        out.push({
          fgHex: fg.hex,
          bgHex: bg.hex,
          ratio: undefined,
          passes: false,
          parseError: result.parseError,
        });
        continue;
      }
      if (result.wcagPass) continue; // already accessible; nothing to suggest

      const fix = nearestPassingStep(fg.hex, bg.hex, ramps);
      const base: ContrastSuggestion = {
        fgHex: fg.hex,
        bgHex: bg.hex,
        ...(result.wcag !== undefined ? { ratio: result.wcag } : { ratio: undefined }),
        passes: false,
      };
      if (fix !== undefined) {
        out.push({ ...base, suggestion: fix });
      } else {
        out.push({
          ...base,
          note: `no supplied ramp step reaches ${WCAG_AA_NORMAL}:1 on ${bg.hex}`,
        });
      }
    }
  }
  return out;
}
