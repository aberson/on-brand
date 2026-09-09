/**
 * Normalizer: RawExtraction -> a schema-valid brand token set (plan.md Step 10).
 *
 * Produces BOTH documents the build pipeline needs (plan §4 Modes):
 *   - tokens.json      the light-theme source of truth;
 *   - modes.dark.json  the dark overlay (color values only).
 *
 * ------------------------------------------------------------------ policy ---
 * DEFAULT-FILL POLICY. A near-empty extraction (the blank/garbage anchor) must
 * still yield a check-PASSING token set, so every category is GROUNDED IN THE
 * DEFAULT PRESET (templates/presets/default): we deep-clone the preset's
 * tokens.json + modes.dark.json as the skeleton, then override only what the
 * extraction confidently provides. Where extraction gives nothing (no seed
 * color, no fonts, no radii/shadows), the preset's known-good, WCAG-safe value
 * survives. Worst case (garbage in) => the output is essentially the preset:
 * valid, `onbrand check`-clean, never a crash.
 *
 * WCAG SAFETY BY CONSTRUCTION. The `onbrand check` gate hard-fails on any
 * declared fg/bg pairing below WCAG 2 AA (both modes). Rather than
 * generate-then-repair, the GATED surface (semantic text/muted, status fg/bg,
 * chart label) is assembled ONLY from seed-INDEPENDENT ramps:
 *   - the neutral ramp has FIXED lightness stops (a tiny brand-hue tint at
 *     near-zero chroma), so its dark/light steps are effectively fixed greys —
 *     text/muted/label contrast does not depend on the extracted seed;
 *   - status colors come from FIXED conventional hue anchors (success green /
 *     warning amber / danger red / info blue), fg=dark-step on bg=light-step
 *     (dark-on-tint), which is high-contrast by construction.
 * The seed drives only UN-gated brand expression (primitive ramps, accent,
 * chart series color, diagram palette). Result: the gate passes for ANY seed
 * (verified across seeds: min ratio ~6.8:1). A defensive self-check is asserted
 * in the tests.
 *
 * HUE TOLERANCE (§10 gamut-clip risk): ramps hold seed hue within
 * HUE_TOLERANCE_DEG (8 deg); near-achromatic seeds carve out to a grey ramp.
 * See ramps.ts.
 *
 * DETERMINISM: no Date.now / randomness anywhere; the same extraction in yields
 * byte-identical tokens out.
 */

import path from 'node:path';
import { defaultPresetsRoot, readJsonFile } from '../schema/resolve.ts';
import { isPlainObject, type TokensDocument } from '../schema/types.ts';
import Color from 'colorjs.io';
import type {
  ColorCluster,
  FontStack,
  RadiusValue,
  RawExtraction,
  ShadowObservation,
  SpacingValue,
  TypeSize,
} from './engine/adapter.ts';
import {
  ACHROMATIC_CHROMA,
  FALLBACK_BRAND_SEED,
  buildBrandRamp,
  buildNeutralRamp,
  buildRamp,
  type Ramp,
} from './ramps.ts';
import { mapFonts, type MappedFonts } from './fonts.ts';
import { suggestContrastFixes, type ContrastSuggestion, type NamedRamp } from './contrast.ts';
import {
  PALETTE_CHROMA_FLOOR,
  PALETTE_NEUTRAL_CHROMA_MAX,
  PALETTE_NEUTRAL_MIN_SHARE,
  hasQualifyingPaletteSupport,
  readPaletteSupportEvidence,
  requireImageClusterAlgorithm,
  requiresPaletteSupportEvidence,
  workingPixelCountFromSamples,
  type ImageClusterAlgorithm,
  type MappingPresentation,
  type MappingRelationship,
  type PaletteDecision,
  type PaletteEvidence,
  type PaletteSample,
  type PaletteSynthesisResult,
  type TraceMappingDraft,
} from './palette-evidence.ts';

// --- Seed selection ----------------------------------------------------------

export interface SeedCandidate {
  hex: string;
  /** Brand-likelihood score (role-weighted, chroma-favoring). */
  score: number;
  frequency: number;
  /** OKLCH chroma (0 = grey). */
  chroma: number;
  /** OKLCH hue in deg, or undefined when achromatic. */
  hue: number | undefined;
}

/** Role weights for the brand-likelihood score (accent evidence dominates). */
const ROLE_WEIGHT: Record<string, number> = {
  accent: 3,
  fill: 2,
  gradient: 1.5,
  border: 0.4,
  text: 0.2,
  background: -2,
  shadow: 0,
  unknown: 0,
};

/** OKLCH of a color, or undefined instead of a throw on an unparseable string
 * (never-a-crash contract: colorjs.io's constructor THROWS on garbage input —
 * mirror evaluateContrast's guard pattern; review iteration 2, critical). */
function oklchOf(hex: string): { l: number; c: number; h: number } | undefined {
  try {
    const [l, c, h] = new Color(hex).to('oklch').coords;
    return { l: l!, c: c!, h: h! };
  } catch {
    return undefined;
  }
}

/**
 * Rank color clusters by brand-likelihood: role-weighted evidence (accent
 * dominates) scaled by chroma (a vivid accent beats a grey), with a small
 * frequency*chroma term so a chromatic-but-roleless color can still appear as a
 * lower-ranked candidate. Achromatic clusters (greys, pure black/white) are
 * excluded from being the brand seed. A cluster whose hex does not parse is
 * SKIPPED (reported via `onWarning`), never a throw. Deterministic (stable
 * input order).
 */
export function selectSeedCandidates(
  extraction: RawExtraction,
  onWarning?: (message: string) => void,
): SeedCandidate[] {
  const scored: SeedCandidate[] = [];
  for (const cluster of extraction.colors) {
    const parsed = oklchOf(cluster.hex);
    if (parsed === undefined) {
      onWarning?.(
        `skipped unparseable color cluster ${JSON.stringify(cluster.hex)} during seed selection`,
      );
      continue;
    }
    const { c, h } = parsed;
    if (c < ACHROMATIC_CHROMA) continue; // greys/black/white are never the brand seed
    let roleScore = 0;
    for (const r of cluster.roles) {
      roleScore += (ROLE_WEIGHT[r.role] ?? 0) * r.count;
    }
    const score = roleScore * (0.3 + c * 2) + cluster.frequency * c * 0.01;
    if (score <= 0) continue;
    scored.push({
      hex: cluster.hex,
      score,
      frequency: cluster.frequency,
      chroma: c,
      hue: Number.isFinite(h) ? h : undefined,
    });
  }
  // Descending by score; ties broken by frequency, then hex (fully deterministic).
  scored.sort((a, b) => b.score - a.score || b.frequency - a.frequency || (a.hex < b.hex ? -1 : 1));
  return scored;
}

// --- Grid / scale snapping ---------------------------------------------------

/** The 4px design grid (plan §4 space scale). */
export const GRID_PX = 4;

/** Snap a px value to the nearest 4px grid multiple (the property-tested core). */
export function snapToGrid(px: number): number {
  return Math.round(px / GRID_PX) * GRID_PX;
}

/**
 * Distinct 4px-grid values present in the spacing observations (>= 4px), sorted
 * ascending — the clustering evidence behind the emitted space scale.
 */
export function snappedSpacingEvidence(extraction: RawExtraction): number[] {
  const set = new Set<number>();
  for (const s of extraction.spacing) {
    const snapped = snapToGrid(s.px);
    if (snapped >= GRID_PX) set.add(snapped);
  }
  return [...set].sort((a, b) => a - b);
}

/** Small-radius ladder the sm/md/lg slots snap onto (px). */
const RADIUS_LADDER = [4, 6, 8, 10, 12, 16];
/** Radii below this are hairline/border noise, not intentional corners. */
const RADIUS_FLOOR = 3;
/** A radius at or above this reads as a pill (fully rounded). */
const PILL_THRESHOLD = 100;

function snapRadius(px: number): number {
  let best = RADIUS_LADDER[0]!;
  let bestDist = Math.abs(px - best);
  for (const slot of RADIUS_LADDER) {
    const dist = Math.abs(px - slot);
    if (dist < bestDist) {
      best = slot;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Derive sm/md/lg/pill radius slots from observed radii. The three size slots
 * are the most-frequent distinct small radii (snapped to the ladder), sorted
 * ascending; pill is always 999px (conventional). Falls back to preset
 * defaults (4/8/12) when fewer than three distinct small radii were observed.
 */
export function deriveRadii(
  extraction: Pick<RawExtraction, 'radii'>,
  defaults: { sm: string; md: string; lg: string; pill: string },
): { sm: string; md: string; lg: string; pill: string } {
  const freq = new Map<number, number>();
  for (const r of extraction.radii) {
    // Number.isFinite guards: NaN slips both range comparisons (NaN < 3 and
    // NaN >= 100 are both false) and would credit its full frequency to the
    // 4px ladder slot, skewing the top-3 vote (review iteration 3, low).
    if (!Number.isFinite(r.px) || !Number.isFinite(r.frequency)) continue;
    if (r.px < RADIUS_FLOOR || r.px >= PILL_THRESHOLD) continue;
    const snapped = snapRadius(r.px);
    freq.set(snapped, (freq.get(snapped) ?? 0) + r.frequency);
  }
  const distinct = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  if (distinct.length < 3) {
    return { ...defaults, pill: '999px' };
  }
  const sizes = distinct
    .slice(0, 3)
    .map(([px]) => px)
    .sort((a, b) => a - b);
  return {
    sm: `${sizes[0]}px`,
    md: `${sizes[1]}px`,
    lg: `${sizes[2]}px`,
    pill: '999px',
  };
}

// --- Shadow parsing ----------------------------------------------------------

export interface ParsedShadow {
  color: string;
  offsetX: string;
  offsetY: string;
  blur: string;
  spread: string;
}

/** Split a box-shadow value into top-level layers (commas at paren depth 0). */
function splitLayers(css: string): string[] {
  const layers: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]!;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      layers.push(css.slice(start, i));
      start = i + 1;
    }
  }
  layers.push(css.slice(start));
  return layers.map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * Convert an `rgb()/rgba()` string to `#rrggbb`/`#rrggbbaa`; undefined if not
 * one. Non-numeric channels (parseFloat -> NaN) make the WHOLE color undefined
 * — NaN would otherwise survive Math.round/min/max and render a literal
 * "#NaNNaNNaN" that fails validate() (review iteration 2, high).
 */
function rgbToHex(token: string): string | undefined {
  const open = token.indexOf('(');
  const close = token.indexOf(')');
  if (open < 0 || close < 0 || close < open) return undefined;
  const parts = token
    .slice(open + 1, close)
    .split(',')
    .map((p) => p.trim());
  if (parts.length < 3) return undefined;
  const to255 = (v: string): number | undefined => {
    const parsed = parseFloat(v);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(255, Math.round(parsed))) : undefined;
  };
  const r = to255(parts[0]!);
  const g = to255(parts[1]!);
  const b = to255(parts[2]!);
  if (r === undefined || g === undefined || b === undefined) return undefined;
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  let out = `#${hex(r)}${hex(g)}${hex(b)}`;
  if (parts.length >= 4) {
    const alphaFloat = parseFloat(parts[3]!);
    if (!Number.isFinite(alphaFloat)) return undefined;
    const a = Math.max(0, Math.min(255, Math.round(alphaFloat * 255)));
    if (a < 255) out += hex(a);
  }
  return out;
}

/** A token that looks like a `<number>px` length (char-code scan, no regex classes). */
function parsePx(token: string): number | undefined {
  if (!token.endsWith('px')) return undefined;
  const num = token.slice(0, -2);
  const value = Number(num);
  return Number.isFinite(value) ? value : undefined;
}

/** Format a px number (rounded) as a dimension string; keeps sign. */
function pxString(value: number): string {
  return `${Math.round(value)}px`;
}

/**
 * Parse the first layer of a box-shadow observation into a single-layer DTCG
 * shadow value. Returns undefined when the layer has no recognizable color or
 * fewer than two offsets (the caller falls back to a preset default).
 */
export function parseShadow(css: string): ParsedShadow | undefined {
  const layers = splitLayers(css);
  if (layers.length === 0) return undefined;
  const first = layers[0]!;

  // Pull the color (rgb/rgba function or a hex literal), then the lengths.
  let color: string | undefined;
  const rgbStart = first.search(/rgba?\(/i);
  if (rgbStart >= 0) {
    const close = first.indexOf(')', rgbStart);
    if (close >= 0) color = rgbToHex(first.slice(rgbStart, close + 1));
  } else {
    const hashIdx = first.indexOf('#');
    if (hashIdx >= 0) {
      const rest = first.slice(hashIdx + 1);
      const end = rest.search(/[^0-9a-fA-F]/);
      const digits = end < 0 ? rest : rest.slice(0, end);
      // Only well-formed CSS hex lengths are colors. A bare '#', '#ff',
      // '#abcde', or an 11-digit run is degenerate shadow CSS that must not be
      // written verbatim into tokens — validate() would reject the document
      // (review iteration 3, medium; symmetric with the rgbToHex NaN guard).
      if (
        digits.length === 3 ||
        digits.length === 4 ||
        digits.length === 6 ||
        digits.length === 8
      ) {
        color = `#${digits}`;
      }
    }
  }
  if (color === undefined) return undefined;

  const lengths: number[] = [];
  for (const token of first.split(/\s+/)) {
    const px = parsePx(token);
    if (px !== undefined) lengths.push(px);
  }
  if (lengths.length < 2) return undefined; // need at least offsetX + offsetY

  return {
    color,
    offsetX: pxString(lengths[0]!),
    offsetY: pxString(lengths[1]!),
    blur: pxString(lengths[2] ?? 0),
    spread: pxString(lengths[3] ?? 0),
  };
}

/**
 * Derive elevation-1/2/3 from observed shadows: take the three highest-frequency
 * parseable shadows, order by blur ascending (elevation-1 = tightest). An
 * unparseable observation is SKIPPED with a collected warning (never written
 * verbatim); missing slots keep the preset default. Deterministic (frequency
 * then input order).
 */
export function deriveShadows(
  extraction: Pick<RawExtraction, 'shadows'>,
  defaults: [ParsedShadow, ParsedShadow, ParsedShadow],
  onWarning?: (message: string) => void,
): [ParsedShadow, ParsedShadow, ParsedShadow] {
  const ordered: Array<{ s: ShadowObservation; i: number }> = [...extraction.shadows]
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.frequency - a.s.frequency || a.i - b.i);

  const parsed: ParsedShadow[] = [];
  for (const { s } of ordered) {
    const p = parseShadow(s.css);
    if (p === undefined) {
      onWarning?.(
        `skipped unparseable shadow observation ${JSON.stringify(s.css)}; ` +
          'preset default elevation kept where no parseable shadow fills the slot',
      );
      continue;
    }
    parsed.push(p);
  }
  const ranked = parsed.sort(
    (a, b) => Number(a.blur.slice(0, -2)) - Number(b.blur.slice(0, -2)),
  );

  return [ranked[0] ?? defaults[0], ranked[1] ?? defaults[1], ranked[2] ?? defaults[2]];
}

// --- Type scale inference ----------------------------------------------------

function formatRem(px: number): string {
  const rem = px / 16;
  const rounded = Math.round(rem * 10000) / 10000;
  return `${rounded}rem`;
}

export interface TypeInference {
  baseSize: string;
  weights: { regular: number; medium: number; semibold: number; bold: number };
  lineHeights: { tight: number; base: number; loose: number };
}

function clampInt(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(value)));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Infer base size, weights, and line-heights from observed type sizes. The
 * fluid clamp() scale steps stay preset defaults (generating correct Utopia
 * clamps from an extraction is out of Step 10 scope — "infer what the extraction
 * supports, sane defaults for the rest", plan §4).
 */
/**
 * Sizes outside this px band are never base-size candidates: real sites emit
 * `font-size: 0`/1px on visually-hidden utilities (sr-only, icon containers)
 * and huge display sizes — a 0px-dominant extraction must not collapse
 * type.size.base to "0rem" (review iteration 2; same idea as RADIUS_FLOOR).
 */
const BASE_SIZE_MIN_PX = 8;
const BASE_SIZE_MAX_PX = 32;

export function inferType(
  extraction: Pick<RawExtraction, 'typeSizes'>,
  defaults: TypeInference,
): TypeInference {
  const sizes = extraction.typeSizes;
  if (sizes.length === 0) return defaults;

  // Base size: the most frequent body-ish size (13..20px); else the most
  // frequent size in the sane base band; else preset default.
  const bodyish = sizes.filter((s) => s.px >= 13 && s.px <= 20);
  const bodyPool =
    bodyish.length > 0
      ? bodyish
      : sizes.filter((s) => s.px >= BASE_SIZE_MIN_PX && s.px <= BASE_SIZE_MAX_PX);
  const base = mostFrequent(bodyPool, (s) => s.px);
  const baseSize = base !== undefined ? formatRem(base.px) : defaults.baseSize;

  // Weights: regular from the base size's weight, bold from the heaviest seen.
  const weights = sizes.map((s) => s.fontWeight).filter((w): w is number => w !== undefined);
  const regular = base?.fontWeight ?? (weights.length > 0 ? Math.min(...weights) : undefined);
  const bold = weights.length > 0 ? Math.max(...weights) : undefined;

  // Line-heights from observed lineHeightPx/px ratios.
  const ratios = sizes
    .filter((s): s is TypeSize & { lineHeightPx: number } => s.lineHeightPx !== undefined && s.px > 0)
    .map((s) => s.lineHeightPx / s.px)
    .filter((r) => r >= 1 && r <= 2.2);

  const lineHeights =
    ratios.length > 0
      ? {
          tight: round2(Math.max(1, Math.min(...ratios))),
          base: round2(median(ratios)),
          loose: round2(Math.min(2, Math.max(...ratios))),
        }
      : defaults.lineHeights;

  return {
    baseSize,
    weights: {
      regular: regular !== undefined ? clampInt(regular, 1, 1000) : defaults.weights.regular,
      medium: defaults.weights.medium,
      semibold: defaults.weights.semibold,
      bold: bold !== undefined ? clampInt(bold, 1, 1000) : defaults.weights.bold,
    },
    lineHeights,
  };
}

function mostFrequent<T>(items: readonly T[], key: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestCount = -1;
  const counts = new Map<number, number>();
  for (const item of items) {
    const k = key(item);
    const c = (counts.get(k) ?? 0) + 1;
    counts.set(k, c);
  }
  for (const item of items) {
    const c = counts.get(key(item)) ?? 0;
    if (c > bestCount) {
      bestCount = c;
      best = item;
    }
  }
  return best;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

// --- Conventional status hue anchors (plan §4: success/warning/danger/info) ---

const STATUS_SEEDS: Record<string, string> = {
  success: '#16a34a', // green
  warning: '#d97706', // amber
  danger: '#dc2626', // red
  info: '#2563eb', // blue
};

// --- Document assembly -------------------------------------------------------

/** Navigate a token document to a leaf and set its `$value` (leaf must exist). */
function setLeaf(root: Record<string, unknown>, dotPath: string, value: unknown): void {
  const segs = dotPath.split('.');
  let node: Record<string, unknown> = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const next = node[segs[i]!];
    if (!isPlainObject(next)) return;
    node = next;
  }
  const leaf = node[segs[segs.length - 1]!];
  if (isPlainObject(leaf) && Object.hasOwn(leaf, '$value')) {
    (leaf as { $value: unknown }).$value = value;
  }
}

/**
 * Read a leaf's current `$value` (used to seed type/shadow defaults). Exported
 * (additive; the only other reader is internal to this module) so
 * `src/eval/color-fidelity.ts` can read a built proposal's shipped background
 * colors in-process (Brand-Fidelity plan §4 impact table — a scoreable-proposal
 * accessor, not a new call site that changes behavior here).
 */
export function getLeaf(root: Record<string, unknown>, dotPath: string): unknown {
  const segs = dotPath.split('.');
  let node: unknown = root;
  for (const seg of segs) {
    if (!isPlainObject(node)) return undefined;
    node = node[seg];
  }
  return isPlainObject(node) && Object.hasOwn(node, '$value')
    ? (node as { $value: unknown }).$value
    : undefined;
}

export interface NormalizeOptions {
  /** Override where the default preset skeleton is read from (tests). */
  presetsRoot?: string;
}

export interface NormalizeResult {
  /** The light-theme tokens.json document (schema-valid). */
  tokens: TokensDocument;
  /** The modes.dark.json overlay document (color values only). */
  dark: TokensDocument;
  /** Ranked brand-seed candidates (top-N for the extraction report). */
  seedCandidates: SeedCandidate[];
  /** The seed actually used (a candidate hex, or the fallback). */
  seed: string;
  /** True when no usable seed was found and the preset fallback was used. */
  seedFromFallback: boolean;
  /** Font stack -> lookalike mappings (with license notes + unmapped flags). */
  fonts: MappedFonts;
  /** Contrast auto-fix suggestions for failing extracted pairs (report data). */
  contrastSuggestions: ContrastSuggestion[];
  /** Non-fatal notes (gamut clamps, unmapped fonts, fallbacks). */
  warnings: string[];
}

/** What buildTokensForSeed returns: the two documents plus the seed-INDEPENDENT
 * evidence (fonts, contrast suggestions, warnings). Which color IS the brand is
 * the caller's concern — pass any chosen seed hex. */
export interface SeedBuildResult {
  tokens: TokensDocument;
  dark: TokensDocument;
  fonts: MappedFonts;
  contrastSuggestions: ContrastSuggestion[];
  warnings: string[];
}

/**
 * The chroma floor, neutral chroma ceiling, and neutral share floor have ONE
 * owner in `palette-evidence.ts` so the compact v2 selector and this decision
 * policy can never drift apart.
 */
/** Selected secondary samples must be visibly distinct from all earlier choices. */
const PALETTE_SECONDARY_MIN_DELTA_E = 10;
const MAX_PALETTE_SECONDARIES = 7;

interface ParsedPaletteSample {
  sample: PaletteSample;
  chroma: number;
  primaryScore: number;
  /**
   * v1 evidence carries no support metrics, so every parseable v1 sample stays
   * eligible exactly as released.  A v2 sample is supported only when its
   * measured family clears BOTH the aggregate and the local gate.
   */
  supported: boolean;
}

/**
 * Parse evidence defensively. A malformed sample is not a usable decision
 * candidate. For image-cluster-v2 evidence this FAILS CLOSED: a sample whose
 * required support metrics are missing or malformed is dropped from every
 * deterministic role rather than silently treated as fully supported.
 */
function parsedPaletteSample(
  sample: PaletteSample,
  support: { required: boolean; workingPixels: number | undefined },
): ParsedPaletteSample | undefined {
  if (
    typeof sample.id !== 'string' ||
    typeof sample.hex !== 'string' ||
    !Number.isFinite(sample.pixelShare) ||
    sample.pixelShare <= 0 ||
    sample.pixelShare > 1
  ) {
    return undefined;
  }
  const parsed = oklchOf(sample.hex);
  if (parsed === undefined || !Number.isFinite(parsed.c) || parsed.c < 0) return undefined;
  let supported = true;
  if (support.required) {
    const measured = readPaletteSupportEvidence(sample);
    if (measured === undefined || support.workingPixels === undefined) return undefined;
    supported = hasQualifyingPaletteSupport(measured, support.workingPixels);
  }
  return {
    sample,
    chroma: parsed.c,
    primaryScore: sample.pixelShare * (1 + Math.min(parsed.c / 0.2, 1)),
    supported,
  };
}

function comparePrimaryCandidates(a: ParsedPaletteSample, b: ParsedPaletteSample): number {
  return (
    b.primaryScore - a.primaryScore ||
    b.sample.pixelShare - a.sample.pixelShare ||
    (a.sample.hex < b.sample.hex ? -1 : a.sample.hex > b.sample.hex ? 1 : 0) ||
    (a.sample.id < b.sample.id ? -1 : a.sample.id > b.sample.id ? 1 : 0)
  );
}

function compareFallbackCandidates(a: ParsedPaletteSample, b: ParsedPaletteSample): number {
  return (
    b.sample.pixelShare - a.sample.pixelShare ||
    (a.sample.hex < b.sample.hex ? -1 : a.sample.hex > b.sample.hex ? 1 : 0) ||
    (a.sample.id < b.sample.id ? -1 : a.sample.id > b.sample.id ? 1 : 0)
  );
}

/** Undefined rather than throwing when an evidence hex is bad. */
function paletteDeltaE(a: string, b: string): number | undefined {
  try {
    return new Color(a).deltaE(new Color(b), { method: '2000' });
  } catch {
    return undefined;
  }
}

/**
 * Freeze the selection policy for measured palette evidence. The optional LLM
 * may replace only the primary with a caller-validated candidate ID; neutral
 * and secondary assignments always remain deterministic.
 */
export function selectPaletteDecision(
  evidence: PaletteEvidence,
  options: { primarySampleId?: string; primarySelectionSource?: 'deterministic' | 'llm' } = {},
): PaletteDecision {
  // Fail closed at the boundary. This is an exported, source-neutral function,
  // so an unrecognized algorithm must be rejected HERE rather than downstream:
  // otherwise it would fall through to the lenient released-v1 path and produce
  // a fully UNGATED deterministic decision.
  const algorithm = requireImageClusterAlgorithm(evidence.algorithm);
  const required = requiresPaletteSupportEvidence(algorithm);
  const support = {
    required,
    workingPixels: required ? workingPixelCountFromSamples(evidence.samples) : undefined,
  };
  const candidates = evidence.samples
    .map((sample) => parsedPaletteSample(sample, support))
    .filter((candidate): candidate is ParsedPaletteSample => candidate !== undefined);
  if (candidates.length === 0) {
    throw new Error('palette evidence has no valid samples for a primary decision');
  }

  // A v2 colourful candidate must clear the shared family-support gate before it
  // can become a primary or secondary mapping. The dominant-coverage exemption
  // (plan §6 D2 step 1) is RETENTION-only — it decides which samples survive the
  // merged pool before the twelve-sample cap, never which ROLE a sample takes —
  // and the 2% neutral rule stays separate from the colourful-accent gate too
  // (D3). Because this gate can empty `colorful`, the last-resort primary below
  // prefers a supported sample rather than falling open to an unsupported one.
  const colorful = candidates.filter(
    (candidate) => candidate.chroma >= PALETTE_CHROMA_FLOOR && candidate.supported,
  );
  const orderedColorful = [...colorful].sort(comparePrimaryCandidates);
  if (options.primarySelectionSource === 'llm' && options.primarySampleId === undefined) {
    throw new Error('an LLM palette decision must name one measured colorful candidate ID');
  }
  if (options.primarySampleId !== undefined && options.primarySelectionSource !== 'llm') {
    throw new Error('only an LLM decision may override the deterministic primary candidate');
  }
  const primaryOverride =
    options.primarySampleId === undefined
      ? undefined
      : colorful.find((candidate) => candidate.sample.id === options.primarySampleId);
  if (options.primarySampleId !== undefined && primaryOverride === undefined) {
    throw new Error(
      `LLM palette decision ${JSON.stringify(options.primarySampleId)} is not a measured colorful candidate`,
    );
  }
  // The last-resort fallback fires when NO candidate cleared the colourful gate,
  // which v2 support filtering can now cause on its own. Preferring supported
  // samples keeps plan §6 D4 / §9 true (an isolated outlier never becomes a
  // primary or secondary mapping) while staying byte-identical for v1, where
  // every parsed candidate is `supported` and the sort input is unchanged. If
  // nothing is supported the pool falls back to every candidate so §2's
  // always-present primary still holds.
  const supportedCandidates = candidates.filter((candidate) => candidate.supported);
  const fallbackPool = supportedCandidates.length > 0 ? supportedCandidates : candidates;
  const primary =
    primaryOverride ?? orderedColorful[0] ?? [...fallbackPool].sort(compareFallbackCandidates)[0]!;
  const primarySelectionSource =
    primaryOverride !== undefined && options.primarySelectionSource === 'llm' ? 'llm' : 'deterministic';

  // The neutral selector deliberately does NOT consult `supported`, and that is
  // not a fail-open sibling of the primary/secondary gate: plan §3 scopes the
  // in-scope bullet to unsupported isolated or scattered COLOURFUL pixels, a
  // neutral is by definition below PALETTE_NEUTRAL_CHROMA_MAX (i.e. not
  // colourful), and D3 holds the existing 2% neutral rule separate from the
  // colourful-accent gate — which §3 freezes as out of scope. Do not "fix" this.
  const neutral = candidates
    .filter(
      (candidate) =>
        candidate.sample.id !== primary.sample.id &&
        candidate.chroma < PALETTE_NEUTRAL_CHROMA_MAX &&
        candidate.sample.pixelShare >= PALETTE_NEUTRAL_MIN_SHARE,
    )
    .sort(
      (a, b) =>
        a.chroma - b.chroma ||
        b.sample.pixelShare - a.sample.pixelShare ||
        (a.sample.hex < b.sample.hex ? -1 : a.sample.hex > b.sample.hex ? 1 : 0) ||
        (a.sample.id < b.sample.id ? -1 : a.sample.id > b.sample.id ? 1 : 0),
    )[0];

  const alreadySelected = [primary, ...(neutral === undefined ? [] : [neutral])];
  const secondaries: ParsedPaletteSample[] = [];
  for (const candidate of orderedColorful) {
    if (candidate.sample.id === primary.sample.id) continue;
    const distinct = [...alreadySelected, ...secondaries].every((selected) => {
      const distance = paletteDeltaE(candidate.sample.hex, selected.sample.hex);
      return distance !== undefined && distance >= PALETTE_SECONDARY_MIN_DELTA_E;
    });
    if (!distinct) continue;
    secondaries.push(candidate);
    if (secondaries.length === MAX_PALETTE_SECONDARIES) break;
  }

  return {
    primary: { sampleId: primary.sample.id, selectionSource: primarySelectionSource },
    neutral:
      neutral === undefined ? null : { sampleId: neutral.sample.id, selectionSource: 'deterministic' },
    secondaries: secondaries.map((candidate) => ({
      sampleId: candidate.sample.id,
      selectionSource: 'deterministic',
    })),
  };
}

/**
 * Build a schema-valid tokens.json + modes.dark.json for an EXPLICIT brand seed.
 *
 * Split out of normalize() (Step 12, plan §9 Decision 4) so from-url can honor
 * the LLM's brand-color pick: the deterministic normalizer proposes a heuristic
 * seed, the LLM may pick a DIFFERENT top-5 candidate, and the shipped tokens must
 * be built from whichever color is chosen — not always the heuristic top. Grounded
 * in the default preset (default-fill policy above); overrides only extraction-
 * informed values. Pure w.r.t. the clock (no Date.now / randomness).
 */
interface TokenBuildEvidence {
  /** Raw color-role observations are only used for report-only contrast suggestions. */
  colors: ColorCluster[];
  fonts: FontStack[];
  typeSizes: TypeSize[];
  spacing: SpacingValue[];
  radii: RadiusValue[];
  shadows: ShadowObservation[];
  lightDescription: string;
  darkDescription: string;
}

/**
 * Shared document assembly for URL observations and source-neutral palette
 * evidence. It deliberately consumes only the non-color observation fields it
 * needs; image callers do not have to invent a RawExtraction URL.
 */
function buildTokenDocuments(
  evidence: TokenBuildEvidence,
  seed: string,
  neutralSeed: string,
  options: NormalizeOptions = {},
  paletteOverrides?: PaletteTokenOverrides,
): SeedBuildResult {
  const presetsRoot = options.presetsRoot ?? defaultPresetsRoot();
  const presetDir = path.join(presetsRoot, 'default');
  const tokens = readJsonFile(path.join(presetDir, 'tokens.json')) as Record<string, unknown>;
  const dark = readJsonFile(path.join(presetDir, 'modes.dark.json')) as Record<string, unknown>;

  const warnings: string[] = [];

  // 1. Ramps (brand + neutral, both modes).
  const brandL = buildBrandRamp(seed, 'light');
  const brandD = buildBrandRamp(seed, 'dark');
  const neutralL = buildNeutralRamp(neutralSeed, 'light');
  const neutralD = buildNeutralRamp(neutralSeed, 'dark');
  for (const ramp of [brandL, brandD, neutralL, neutralD]) {
    warnings.push(...ramp.clampWarnings);
  }

  // 2. Color assembly (light tokens + dark overlay).
  applyPrimitives(tokens, dark, brandL, brandD, neutralL, neutralD);
  applySemantic(tokens, dark, brandL, brandD, neutralL, neutralD);
  applyStatus(tokens, dark);
  applyChart(tokens, dark, brandL, brandD, neutralL, neutralD);
  applyDiagram(tokens, dark, brandL, brandD, neutralL, neutralD);
  if (paletteOverrides !== undefined) {
    applyPaletteOverrides(tokens, dark, paletteOverrides);
  }

  // 3. Fonts.
  const fonts = mapFonts(evidence.fonts);
  setLeaf(tokens, 'font.sans', fonts.sans.stack);
  setLeaf(tokens, 'font.heading', fonts.heading.stack);
  setLeaf(tokens, 'font.mono', fonts.mono.stack);
  for (const mapping of [fonts.sans, fonts.heading, fonts.mono]) {
    if (!mapping.mapped) warnings.push(`font ${mapping.role}: ${mapping.note}`);
  }

  // 4. Type scale.
  const typeDefaults: TypeInference = {
    baseSize: String(getLeaf(tokens, 'type.size.base') ?? '1rem'),
    weights: {
      regular: Number(getLeaf(tokens, 'type.weight.regular') ?? 400),
      medium: Number(getLeaf(tokens, 'type.weight.medium') ?? 500),
      semibold: Number(getLeaf(tokens, 'type.weight.semibold') ?? 600),
      bold: Number(getLeaf(tokens, 'type.weight.bold') ?? 700),
    },
    lineHeights: {
      tight: Number(getLeaf(tokens, 'type.line-height.tight') ?? 1.2),
      base: Number(getLeaf(tokens, 'type.line-height.base') ?? 1.55),
      loose: Number(getLeaf(tokens, 'type.line-height.loose') ?? 1.7),
    },
  };
  const type = inferType({ typeSizes: evidence.typeSizes }, typeDefaults);
  setLeaf(tokens, 'type.size.base', type.baseSize);
  setLeaf(tokens, 'type.weight.regular', type.weights.regular);
  setLeaf(tokens, 'type.weight.medium', type.weights.medium);
  setLeaf(tokens, 'type.weight.semibold', type.weights.semibold);
  setLeaf(tokens, 'type.weight.bold', type.weights.bold);
  setLeaf(tokens, 'type.line-height.tight', type.lineHeights.tight);
  setLeaf(tokens, 'type.line-height.base', type.lineHeights.base);
  setLeaf(tokens, 'type.line-height.loose', type.lineHeights.loose);

  // 5. Radii.
  const radii = deriveRadii({ radii: evidence.radii }, {
    sm: String(getLeaf(tokens, 'radius.sm') ?? '4px'),
    md: String(getLeaf(tokens, 'radius.md') ?? '8px'),
    lg: String(getLeaf(tokens, 'radius.lg') ?? '12px'),
    pill: String(getLeaf(tokens, 'radius.pill') ?? '999px'),
  });
  setLeaf(tokens, 'radius.sm', radii.sm);
  setLeaf(tokens, 'radius.md', radii.md);
  setLeaf(tokens, 'radius.lg', radii.lg);
  setLeaf(tokens, 'radius.pill', radii.pill);

  // 6. Shadows.
  const shadowDefaults: [ParsedShadow, ParsedShadow, ParsedShadow] = [
    readPresetShadow(tokens, 'shadow.elevation-1'),
    readPresetShadow(tokens, 'shadow.elevation-2'),
    readPresetShadow(tokens, 'shadow.elevation-3'),
  ];
  const shadows = deriveShadows({ shadows: evidence.shadows }, shadowDefaults, (message) =>
    warnings.push(message),
  );
  setLeaf(tokens, 'shadow.elevation-1', shadows[0]);
  setLeaf(tokens, 'shadow.elevation-2', shadows[1]);
  setLeaf(tokens, 'shadow.elevation-3', shadows[2]);

  // 7. Contrast auto-fix suggestions (report data; never mutates tokens).
  const suggestionRamps: NamedRamp[] = [
    { label: 'brand', steps: brandL.steps },
    { label: 'neutral', steps: neutralL.steps },
  ];
  const contrastSuggestions = suggestContrastFixes({ colors: evidence.colors }, suggestionRamps);

  // Refresh the document descriptions to mark provenance.
  (tokens as Record<string, unknown>)['$description'] = evidence.lightDescription;
  (dark as Record<string, unknown>)['$description'] = evidence.darkDescription;

  return {
    tokens: tokens as TokensDocument,
    dark: dark as TokensDocument,
    fonts,
    contrastSuggestions,
    warnings,
  };
}

export function buildTokensForSeed(
  extraction: RawExtraction,
  seed: string,
  options: NormalizeOptions = {},
): SeedBuildResult {
  return buildTokenDocuments(
    {
      colors: extraction.colors,
      fonts: extraction.fonts,
      typeSizes: extraction.typeSizes,
      spacing: extraction.spacing,
      radii: extraction.radii,
      shadows: extraction.shadows,
      lightDescription:
        `on-brand tokens normalized from ${extraction.url} (engine ${extraction.engine.name} ${extraction.engine.version}). Ramps: OKLCH, gamut-clamped. Gated surface (text/status/chart) is WCAG 2 AA-safe by construction.`,
      darkDescription: `Dark-mode overlay normalized from ${extraction.url} (color values only).`,
    },
    seed,
    seed,
    options,
  );
}

const UNOBSERVED_IMAGE_DEFAULTS = [
  'typography',
  'spacing',
  'radius',
  'shadow',
  'motion',
  'status',
] as const;

const PRIMARY_TARGETS = [
  'color.chart.categorical.1',
  'color.diagram.spine-accent',
  'color.primitive.brand.9',
  'color.semantic.accent',
] as const;

const SECONDARY_ASSIGNMENTS = [
  ['color.chart.categorical.2', 'color.diagram.node-stroke'],
  ['color.chart.categorical.3', 'color.diagram.chip-highlight'],
  ['color.chart.categorical.4', 'color.diagram.link'],
  ['color.chart.categorical.5'],
  ['color.chart.categorical.6'],
  ['color.chart.categorical.7'],
  ['color.chart.categorical.8'],
] as const;

/** Every frozen categorical/diagram target, ordered by the assignment table. */
export const PALETTE_ASSIGNMENT_TARGETS = [
  'color.chart.categorical.1',
  'color.diagram.spine-accent',
  ...SECONDARY_ASSIGNMENTS.flat(),
] as const;

interface PaletteTokenOverrides {
  /** Secondary sample hexes in frozen role order. */
  secondaries: string[];
}

function applyPaletteOverrides(
  tokens: Record<string, unknown>,
  dark: Record<string, unknown>,
  overrides: PaletteTokenOverrides,
): void {
  for (let index = 0; index < overrides.secondaries.length; index++) {
    const sampleHex = overrides.secondaries[index]!;
    const lightRamp = buildBrandRamp(sampleHex, 'light');
    const darkRamp = buildBrandRamp(sampleHex, 'dark');
    const targets = SECONDARY_ASSIGNMENTS[index]!;
    for (const target of targets) {
      // Chart series use the contrast-safe expression stop, while diagram
      // silhouettes use a light tint/stroke from the same exact sample ramp.
      const isChart = target.startsWith('color.chart.categorical.');
      setLeaf(tokens, target, lightRamp.steps[isChart ? 8 : 6]);
      setLeaf(dark, target, darkRamp.steps[isChart ? 9 : 8]);
    }
  }
}

function paletteSampleById(evidence: PaletteEvidence, sampleId: string): PaletteSample {
  const sample = evidence.samples.find((candidate) => candidate.id === sampleId);
  if (sample === undefined) {
    throw new Error(`palette decision refers to missing sample ${JSON.stringify(sampleId)}`);
  }
  if (oklchOf(sample.hex) === undefined) {
    throw new Error(`palette decision refers to unparseable sample ${JSON.stringify(sampleId)}`);
  }
  return sample;
}

function mappingRegion(sample: PaletteSample): TraceMappingDraft['region'] {
  if (sample.region === null) {
    throw new Error(`palette sample ${JSON.stringify(sample.id)} has no region for an inspiration trace`);
  }
  return sample.region;
}

function targetPresentation(token: string): MappingPresentation {
  return token.startsWith('color.chart.categorical.') ? 'chart-series' : 'swatch-only';
}

function targetRelationship(
  sample: PaletteSample,
  token: string,
  tokens: TokensDocument,
): MappingRelationship {
  return getLeaf(tokens, token) === sample.hex ? 'sampled' : 'adjusted-for-contrast';
}

function makePaletteMapping(
  sample: PaletteSample,
  selectionSource: 'deterministic' | 'llm',
  role: 'primary' | 'neutral' | 'secondary',
  targets: readonly string[],
  tokens: TokensDocument,
  algorithm: ImageClusterAlgorithm,
): TraceMappingDraft {
  return {
    id: sample.id,
    label: `Sample ${sample.id.replace(/^sample-/, '')}`,
    region: mappingRegion(sample),
    sample: {
      // Stamped from the MEASURED evidence, never a global producer literal, so
      // a stored v1 trace and a new v2 trace each stay internally consistent.
      hex: sample.hex,
      method: algorithm,
      selectionSource,
      pixelShare: sample.pixelShare,
    },
    targets: targets.map((token) => ({
      token,
      presentation: targetPresentation(token),
      relationship: targetRelationship(sample, token, tokens),
      usage: `Palette assignment for ${token}.`,
    })),
    rationale: `Measured sample mapped to ${targets[0]!} by ${algorithm}.`,
    confidence: role === 'neutral' ? 'medium' : 'high',
  };
}

function defaultDerivedTarget(token: string): PaletteSynthesisResult['defaultDerivedColorTargets'][number] {
  return {
    token,
    role: token.startsWith('color.chart.categorical.') ? 'categorical' : 'diagram',
    reason: 'no-qualifying-image-sample',
  };
}

function sameSecondaryIds(a: PaletteDecision, b: PaletteDecision): boolean {
  return (
    a.secondaries.length === b.secondaries.length &&
    a.secondaries.every(
      (secondary, index) =>
        secondary.sampleId === b.secondaries[index]?.sampleId &&
        secondary.selectionSource === b.secondaries[index]?.selectionSource,
    )
  );
}

/** Enforce that only an explicit LLM primary may vary; all other roles are frozen. */
function assertPaletteDecision(evidence: PaletteEvidence, decision: PaletteDecision): void {
  const deterministic = selectPaletteDecision(evidence);
  if (
    decision.primary.selectionSource === 'deterministic' &&
    decision.primary.sampleId !== deterministic.primary.sampleId
  ) {
    throw new Error('a deterministic palette decision must use the frozen primary candidate');
  }
  const expected =
    decision.primary.selectionSource === 'llm'
      ? selectPaletteDecision(evidence, {
          primarySampleId: decision.primary.sampleId,
          primarySelectionSource: 'llm',
        })
      : deterministic;
  if (
    decision.neutral?.sampleId !== expected.neutral?.sampleId ||
    decision.neutral?.selectionSource !== expected.neutral?.selectionSource ||
    !sameSecondaryIds(decision, expected)
  ) {
    throw new Error('palette neutral and secondary assignments must match the frozen deterministic policy');
  }
}

/**
 * Synthesize an image-grounded token pair and the exact mapping trace from one
 * measured palette decision. This is intentionally separate from the legacy
 * URL wrapper: it adds secondary assignments without changing from-url bytes.
 */
export function buildTokensFromPalette(
  evidence: PaletteEvidence,
  decision: PaletteDecision = selectPaletteDecision(evidence),
  options: NormalizeOptions = {},
): PaletteSynthesisResult {
  // Reject before any decision work, including a caller-supplied decision that
  // never went through `selectPaletteDecision`'s own boundary check.
  const algorithm = requireImageClusterAlgorithm(evidence.algorithm);
  assertPaletteDecision(evidence, decision);
  const primary = paletteSampleById(evidence, decision.primary.sampleId);
  const neutral =
    decision.neutral === null ? undefined : paletteSampleById(evidence, decision.neutral.sampleId);
  const secondaries = decision.secondaries.map((entry) => paletteSampleById(evidence, entry.sampleId));

  const selectedIds = [primary.id, ...(neutral === undefined ? [] : [neutral.id]), ...secondaries.map((x) => x.id)];
  if (new Set(selectedIds).size !== selectedIds.length) {
    throw new Error('palette decision sample IDs must be pairwise distinct');
  }
  if (secondaries.length > MAX_PALETTE_SECONDARIES) {
    throw new Error(`palette decision supports at most ${MAX_PALETTE_SECONDARIES} secondaries`);
  }

  const built = buildTokenDocuments(
    {
      // Image evidence truthfully has no DOM role observations: contrast
      // suggestions are report data, so this remains empty rather than forged.
      colors: [],
      fonts: evidence.nonColor.fonts,
      typeSizes: evidence.nonColor.typeSizes,
      spacing: evidence.nonColor.spacing,
      radii: evidence.nonColor.radii,
      shadows: evidence.nonColor.shadows,
      lightDescription:
        `on-brand tokens synthesized from ${evidence.algorithm} palette evidence. Ramps: OKLCH, gamut-clamped. Gated surface (text/status/chart) is WCAG 2 AA-safe by construction.`,
      darkDescription: `Dark-mode overlay synthesized from ${evidence.algorithm} palette evidence (color values only).`,
    },
    primary.hex,
    neutral?.hex ?? primary.hex,
    options,
    { secondaries: secondaries.map((sample) => sample.hex) },
  );

  const mappings: TraceMappingDraft[] = [
    makePaletteMapping(
      primary,
      decision.primary.selectionSource,
      'primary',
      PRIMARY_TARGETS,
      built.tokens,
      algorithm,
    ),
  ];
  if (neutral !== undefined && decision.neutral !== null) {
    mappings.push(
      makePaletteMapping(
        neutral,
        decision.neutral.selectionSource,
        'neutral',
        ['color.primitive.neutral.9'],
        built.tokens,
        algorithm,
      ),
    );
  }
  for (let index = 0; index < secondaries.length; index++) {
    mappings.push(
      makePaletteMapping(
        secondaries[index]!,
        decision.secondaries[index]!.selectionSource,
        'secondary',
        SECONDARY_ASSIGNMENTS[index]!,
        built.tokens,
        algorithm,
      ),
    );
  }

  const assignedFrozenTargets = new Set<string>([
    ...PRIMARY_TARGETS.slice(0, 2),
    ...SECONDARY_ASSIGNMENTS.slice(0, secondaries.length).flat(),
  ]);
  const defaultDerivedColorTargets = PALETTE_ASSIGNMENT_TARGETS.filter(
    (target) => !assignedFrozenTargets.has(target),
  ).map(defaultDerivedTarget);

  return {
    tokens: built.tokens,
    dark: built.dark,
    basePreset: 'default',
    mappings,
    unobservedDefaults: [...UNOBSERVED_IMAGE_DEFAULTS],
    defaultDerivedColorTargets,
  };
}

/**
 * Normalize a RawExtraction into a schema-valid tokens.json + modes.dark.json,
 * using the HEURISTIC top-scored brand seed. Thin wrapper over selectSeedCandidates
 * + buildTokensForSeed; from-url uses those two directly so it can substitute the
 * LLM's brand-color pick for the seed (Decision 4). Grounded in the default preset.
 */
export function normalize(
  extraction: RawExtraction,
  options: NormalizeOptions = {},
): NormalizeResult {
  const warnings: string[] = [];

  // Seed selection (brand color). Unparseable clusters are skipped with a
  // collected warning (never a throw — default-fill policy).
  const seedCandidates = selectSeedCandidates(extraction, (message) => warnings.push(message));
  const seedFromFallback = seedCandidates.length === 0;
  const seed = seedFromFallback ? FALLBACK_BRAND_SEED : seedCandidates[0]!.hex;
  if (seedFromFallback) {
    warnings.push(
      `no brand-colored seed found in the extraction (only greys/near-neutrals); ` +
        `fell back to the default preset brand seed ${FALLBACK_BRAND_SEED}`,
    );
  }

  const built = buildTokensForSeed(extraction, seed, options);
  warnings.push(...built.warnings);

  return {
    tokens: built.tokens,
    dark: built.dark,
    seedCandidates,
    seed,
    seedFromFallback,
    fonts: built.fonts,
    contrastSuggestions: built.contrastSuggestions,
    warnings,
  };
}

function readPresetShadow(tokens: Record<string, unknown>, dotPath: string): ParsedShadow {
  const value = getLeaf(tokens, dotPath);
  if (isPlainObject(value)) {
    const v = value as Record<string, unknown>;
    return {
      color: String(v['color'] ?? '#00000029'),
      offsetX: String(v['offsetX'] ?? '0px'),
      offsetY: String(v['offsetY'] ?? '1px'),
      blur: String(v['blur'] ?? '2px'),
      spread: String(v['spread'] ?? '0px'),
    };
  }
  return { color: '#00000029', offsetX: '0px', offsetY: '1px', blur: '2px', spread: '0px' };
}

// --- Color group appliers ----------------------------------------------------

function applyPrimitives(
  tokens: Record<string, unknown>,
  dark: Record<string, unknown>,
  brandL: Ramp,
  brandD: Ramp,
  neutralL: Ramp,
  neutralD: Ramp,
): void {
  for (let i = 0; i < 12; i++) {
    const step = String(i + 1);
    setLeaf(tokens, `color.primitive.brand.${step}`, brandL.steps[i]);
    setLeaf(tokens, `color.primitive.neutral.${step}`, neutralL.steps[i]);
    setLeaf(dark, `color.primitive.brand.${step}`, brandD.steps[i]);
    setLeaf(dark, `color.primitive.neutral.${step}`, neutralD.steps[i]);
  }
}

function withAlpha(hex: string, alpha: string): string {
  // hex is "#rrggbb"; append a 2-digit alpha.
  return `${hex}${alpha}`;
}

function applySemantic(
  tokens: Record<string, unknown>,
  dark: Record<string, unknown>,
  brandL: Ramp,
  brandD: Ramp,
  neutralL: Ramp,
  neutralD: Ramp,
): void {
  const nL = neutralL.steps;
  const nD = neutralD.steps;
  // Light: dark neutral text on near-white neutral bg (seed-independent, safe).
  setLeaf(tokens, 'color.semantic.bg', nL[0]);
  setLeaf(tokens, 'color.semantic.surface', '#ffffff');
  setLeaf(tokens, 'color.semantic.text', nL[11]);
  setLeaf(tokens, 'color.semantic.text-muted', nL[10]);
  setLeaf(tokens, 'color.semantic.border', nL[4]);
  setLeaf(tokens, 'color.semantic.accent', brandL.steps[8]);
  setLeaf(tokens, 'color.semantic.code-bg', nL[2]);
  setLeaf(tokens, 'color.semantic.shadow-color', withAlpha(nL[11]!, '29'));

  // Dark: light neutral text on near-black neutral bg.
  setLeaf(dark, 'color.semantic.bg', nD[0]);
  setLeaf(dark, 'color.semantic.surface', nD[2]);
  setLeaf(dark, 'color.semantic.text', nD[11]);
  setLeaf(dark, 'color.semantic.text-muted', nD[10]);
  setLeaf(dark, 'color.semantic.border', nD[4]);
  setLeaf(dark, 'color.semantic.accent', brandD.steps[9]);
  setLeaf(dark, 'color.semantic.code-bg', nD[3]);
  setLeaf(dark, 'color.semantic.shadow-color', '#00000080');
}

function applyStatus(tokens: Record<string, unknown>, dark: Record<string, unknown>): void {
  for (const [name, hex] of Object.entries(STATUS_SEEDS)) {
    const light = buildRamp(hex, { variant: 'light', palette: 'status' });
    const darkRamp = buildRamp(hex, { variant: 'dark', palette: 'status' });
    // Light: dark fg on light-tint bg. Dark: light fg on dark-tint bg.
    setLeaf(tokens, `color.status.${name}.fg`, light.steps[10]);
    setLeaf(tokens, `color.status.${name}.bg`, light.steps[1]);
    setLeaf(dark, `color.status.${name}.fg`, darkRamp.steps[10]);
    setLeaf(dark, `color.status.${name}.bg`, darkRamp.steps[1]);
  }
}

function applyChart(
  tokens: Record<string, unknown>,
  dark: Record<string, unknown>,
  brandL: Ramp,
  brandD: Ramp,
  neutralL: Ramp,
  neutralD: Ramp,
): void {
  // Series color 1 = the brand accent; 2..8 keep the preset's distinguishable set.
  setLeaf(tokens, 'color.chart.categorical.1', brandL.steps[8]);
  setLeaf(dark, 'color.chart.categorical.1', brandD.steps[9]);

  // Sequential ramp sampled from the brand ramp (light->dark light; dark->light dark).
  const seqLight = [2, 3, 5, 6, 8, 9, 11];
  const seqDark = [2, 3, 4, 6, 8, 9, 11];
  for (let i = 0; i < 7; i++) {
    setLeaf(tokens, `color.chart.sequential.${i + 1}`, brandL.steps[seqLight[i]!]);
    setLeaf(dark, `color.chart.sequential.${i + 1}`, brandD.steps[seqDark[i]!]);
  }

  // Chrome: neutral grid/axis, gated label (safe by construction), surface tooltip.
  setLeaf(tokens, 'color.chart.chrome.grid', neutralL.steps[3]);
  setLeaf(tokens, 'color.chart.chrome.axis', neutralL.steps[7]);
  setLeaf(tokens, 'color.chart.chrome.label', neutralL.steps[10]);
  setLeaf(tokens, 'color.chart.chrome.tooltip-bg', '#ffffff');
  setLeaf(dark, 'color.chart.chrome.grid', neutralD.steps[4]);
  setLeaf(dark, 'color.chart.chrome.axis', neutralD.steps[7]);
  setLeaf(dark, 'color.chart.chrome.label', neutralD.steps[10]);
  setLeaf(dark, 'color.chart.chrome.tooltip-bg', neutralD.steps[2]);
}

function applyDiagram(
  tokens: Record<string, unknown>,
  dark: Record<string, unknown>,
  brandL: Ramp,
  brandD: Ramp,
  neutralL: Ramp,
  neutralD: Ramp,
): void {
  // Diagram colors are not WCAG-gated; drive them from brand + neutral steps.
  setLeaf(tokens, 'color.diagram.canvas', brandL.steps[1]);
  setLeaf(tokens, 'color.diagram.node-stroke', brandL.steps[6]);
  setLeaf(tokens, 'color.diagram.link', neutralL.steps[8]);
  setLeaf(tokens, 'color.diagram.spine-accent', brandL.steps[8]);
  setLeaf(tokens, 'color.diagram.label', neutralL.steps[11]);
  setLeaf(tokens, 'color.diagram.chip-highlight', brandL.steps[2]);

  setLeaf(dark, 'color.diagram.canvas', neutralD.steps[1]);
  setLeaf(dark, 'color.diagram.node-stroke', brandD.steps[9]);
  setLeaf(dark, 'color.diagram.link', neutralD.steps[7]);
  setLeaf(dark, 'color.diagram.spine-accent', brandD.steps[9]);
  setLeaf(dark, 'color.diagram.label', neutralD.steps[11]);
  setLeaf(dark, 'color.diagram.chip-highlight', brandD.steps[3]);
}
