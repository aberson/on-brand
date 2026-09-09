/**
 * The Step 6 zero-literal "grep gate", shared by preview.specimen.test.ts
 * (pure-render surface) and preview.e2e.test.ts (real spawned-CLI dist
 * output). ONE definition so a gate extension can never land in one surface
 * and silently miss the other (code-quality: one source of truth). Not a test
 * file itself (vitest collects test/**\/*.test.ts only); tsconfig still
 * typechecks it.
 *
 * The scanner is deliberately INDEPENDENT of production code — it re-detects
 * literals rather than importing any emitter helper, so it is a real external
 * check (measurement-validity). Its calibration anchor lives in
 * preview.specimen.test.ts.
 */

import { DIAGRAM_FENCE_BEGIN, DIAGRAM_FENCE_END } from '../../src/preview/render.ts';

/**
 * Find literal color values: hex (#rgb..#rrggbbaa) and the color functions
 * (oklch/rgb/rgba/hsl/hsla). var(--...) references never match.
 */
export function findColorLiterals(text: string): string[] {
  const hits: string[] = [];
  const hex = /#[0-9a-fA-F]{3,8}\b/g;
  let m: RegExpExecArray | null;
  while ((m = hex.exec(text)) !== null) hits.push(m[0]);
  const fn = /\b(?:oklch|rgba?|hsla?)\s*\(/gi;
  while ((m = fn.exec(text)) !== null) hits.push(m[0]);
  return hits;
}

/**
 * Strip the ONE fenced diagram-palette island (dist-sourced, not authored) so
 * the gate judges only the AUTHORED parts of the page.
 */
export function stripDiagramFence(html: string): string {
  const re = new RegExp(`${DIAGRAM_FENCE_BEGIN}[\\s\\S]*?${DIAGRAM_FENCE_END}`, 'g');
  return html.replace(re, '');
}
