/**
 * The DECLARED fg/bg color pairings the contrast gate checks (plan.md §9.8).
 *
 * "Declared pairings only — do not invent pairings" (measurement-validity):
 * every pair below is a place where the token schema (§4) genuinely renders one
 * color's text on another color's fill. Pairs are derived per MODE from the
 * resolved documents — light from tokens.json, dark from the overlay-merged
 * document — so both themes are gated (plan §9.8).
 *
 * A pair is emitted only when BOTH endpoints exist and resolve to a color-typed
 * string in that document; a minimal token set that omits (say) color.chart
 * simply yields fewer pairs, never an error.
 */

import { flattenTokens } from '../build/compile.ts';
import type { TokensDocument } from '../schema/types.ts';

export type Mode = 'light' | 'dark';
export type PairingKind = 'semantic' | 'status' | 'chart';

export interface Pairing {
  mode: Mode;
  kind: PairingKind;
  /** Human role, e.g. "body text on background". */
  role: string;
  fgPath: string;
  fgValue: string;
  bgPath: string;
  bgValue: string;
}

interface PairSpec {
  kind: PairingKind;
  role: string;
  fg: string;
  bg: string;
}

/**
 * Semantic text pairings — body + muted text over the two page fills.
 * (color.semantic text / text-muted vs bg / surface.)
 */
const SEMANTIC_SPECS: PairSpec[] = [
  { kind: 'semantic', role: 'body text on background', fg: 'color.semantic.text', bg: 'color.semantic.bg' },
  { kind: 'semantic', role: 'body text on surface', fg: 'color.semantic.text', bg: 'color.semantic.surface' },
  { kind: 'semantic', role: 'muted text on background', fg: 'color.semantic.text-muted', bg: 'color.semantic.bg' },
  { kind: 'semantic', role: 'muted text on surface', fg: 'color.semantic.text-muted', bg: 'color.semantic.surface' },
];

/** Each color.status.<name> renders its own fg on its own bg (the badge). */
const STATUS_NAMES = ['success', 'warning', 'danger', 'info'] as const;

/**
 * Chart chrome text pairings. Justification from the schema (§4): the chart
 * chrome `label` is rendered (a) inside a tooltip over `chrome.tooltip-bg`, and
 * (b) as an axis/legend label directly over the page background the chart sits
 * on — `color.semantic.bg` (a chart canvas has no fill of its own in the token
 * set, so the page background is the honest chart-background context).
 */
const CHART_SPECS: PairSpec[] = [
  { kind: 'chart', role: 'chart label on tooltip', fg: 'color.chart.chrome.label', bg: 'color.chart.chrome.tooltip-bg' },
  { kind: 'chart', role: 'chart label on chart background', fg: 'color.chart.chrome.label', bg: 'color.semantic.bg' },
];

/** Build a dot-path -> color-string map from a resolved document (color tokens only). */
function colorValues(doc: TokensDocument): Map<string, string> {
  const map = new Map<string, string>();
  for (const token of flattenTokens(doc)) {
    if (token.type === 'color' && typeof token.value === 'string') {
      map.set(token.dotPath, token.value);
    }
  }
  return map;
}

function pushIfBoth(
  out: Pairing[],
  mode: Mode,
  colors: Map<string, string>,
  spec: PairSpec,
): void {
  const fgValue = colors.get(spec.fg);
  const bgValue = colors.get(spec.bg);
  if (fgValue === undefined || bgValue === undefined) return;
  out.push({
    mode,
    kind: spec.kind,
    role: spec.role,
    fgPath: spec.fg,
    fgValue,
    bgPath: spec.bg,
    bgValue,
  });
}

/** All declared pairings present in one resolved document, for one mode. */
export function derivePairings(doc: TokensDocument, mode: Mode): Pairing[] {
  const colors = colorValues(doc);
  const out: Pairing[] = [];
  for (const spec of SEMANTIC_SPECS) pushIfBoth(out, mode, colors, spec);
  for (const name of STATUS_NAMES) {
    pushIfBoth(out, mode, colors, {
      kind: 'status',
      role: `${name} status text on its badge`,
      fg: `color.status.${name}.fg`,
      bg: `color.status.${name}.bg`,
    });
  }
  for (const spec of CHART_SPECS) pushIfBoth(out, mode, colors, spec);
  return out;
}
