/**
 * Extraction-engine adapter — the STABLE seam between a URL-scraping engine
 * (dembrandt, or our own Playwright pipeline) and the rest of on-brand.
 *
 * This interface is OURS and engine-agnostic. Whatever the Step 8 spike decides
 * (wrap dembrandt vs. build engine/own.ts), the normalizer (Step 10) consumes
 * `RawExtraction` and nothing downstream knows which engine produced it. The
 * engine's job is to observe-and-report; all snapping/clustering/ramp-building
 * lives in normalize.ts. So `RawExtraction` deliberately holds RAW observations
 * with evidence (frequencies, roles, CSS strings), never schema-valid tokens.
 *
 * Design rules honored here:
 *   - One source of truth for the extraction shape (plan §7): every extract
 *     module imports these types and never re-declares them.
 *   - Numeric fields are px numbers (pre-snap); colors are sRGB hex strings;
 *     shadows keep the raw CSS string (parsing is the normalizer's job).
 *   - Coverage scoring is a PURE FUNCTION exported from here so the spike
 *     script and the offline tests compute the verdict via the identical code
 *     path (measurement-validity: score the production artifact, one path).
 */

// --- Color -------------------------------------------------------------------

/**
 * A CSS role a color was observed playing. The engine maps its own vocabulary
 * onto this closed set; `unknown` is the honest fallback (never silently drop).
 * The normalizer keys brand/neutral/semantic inference off these roles.
 */
export type ColorRole =
  | 'background'
  | 'text'
  | 'border'
  | 'fill'
  | 'shadow'
  | 'gradient'
  | 'accent'
  | 'unknown';

export const COLOR_ROLES: readonly ColorRole[] = [
  'background',
  'text',
  'border',
  'fill',
  'shadow',
  'gradient',
  'accent',
  'unknown',
];

/** One role a color played, with how many times it was seen in that role. */
export interface ColorRoleEvidence {
  role: ColorRole;
  count: number;
}

/**
 * A clustered color observation. `hex` is sRGB (`#rrggbb` or `#rrggbbaa`);
 * `frequency` is the engine's usage weight (element count or weighted score);
 * `roles` is the role evidence that lets the normalizer decide bg vs text vs
 * accent. A cluster with a non-empty `roles` array carries role evidence.
 */
export interface ColorCluster {
  hex: string;
  frequency: number;
  roles: ColorRoleEvidence[];
}

// --- Typography --------------------------------------------------------------

/** Structural role a font stack served; drives heading/body/mono mapping. */
export type FontRole = 'heading' | 'body' | 'mono' | 'unknown';

export const FONT_ROLES: readonly FontRole[] = ['heading', 'body', 'mono', 'unknown'];

/**
 * A font-family stack exactly as CSS declared it, in fallback order
 * (`["Inter", "system-ui", "sans-serif"]`). The normalizer fingerprints the
 * first concrete family and maps it to a Google Fonts lookalike (Step 10).
 */
export interface FontStack {
  families: string[];
  role: FontRole;
  frequency: number;
}

/** A used type size in px, with optional companion evidence for scale inference. */
export interface TypeSize {
  px: number;
  frequency: number;
  fontWeight?: number;
  lineHeightPx?: number;
}

// --- Layout scalars ----------------------------------------------------------

/** A spacing value in px (margin/padding/gap), pre-snap to the 4px grid. */
export interface SpacingValue {
  px: number;
  frequency: number;
  /** CSS box properties this value came from (`margin`, `padding`, `gap`), if known. */
  sources?: string[];
}

/** A border-radius value in px, pre-snap to sm/md/lg/pill slots. */
export interface RadiusValue {
  px: number;
  frequency: number;
}

/**
 * A box-shadow observation. Kept as the raw CSS string — parsing into layered
 * {color, offsetX, offsetY, blur, spread} is the normalizer's job (it owns the
 * schema `ShadowValue` shape). `frequency` is usage weight.
 */
export interface ShadowObservation {
  css: string;
  frequency: number;
}

// --- Screenshots -------------------------------------------------------------

/**
 * A captured screenshot. `path` points at a PNG file on disk (the spike commits
 * these under test/fixtures/; from-url writes them into the proposal dir). We
 * store a path, never inline base64, so RawExtraction JSON stays diff-legible.
 */
export interface Screenshot {
  /** Semantic label: `light`, `dark`, `full`, `viewport`, ... */
  label: string;
  /** Filesystem path to the PNG (repo-relative for committed fixtures). */
  path: string;
  width?: number;
  height?: number;
}

// --- The extraction result ---------------------------------------------------

/** Provenance: which engine + version produced this extraction. */
export interface EngineInfo {
  name: string;
  version: string;
}

/**
 * The single value every extraction engine returns and the normalizer (Step 10)
 * consumes. All raw, all evidence-bearing, engine-agnostic.
 */
export interface RawExtraction {
  /** The URL that was scraped (echoed for provenance). */
  url: string;
  /** UTC ISO-8601 timestamp of extraction. */
  extractedAt: string;
  engine: EngineInfo;
  colors: ColorCluster[];
  fonts: FontStack[];
  typeSizes: TypeSize[];
  spacing: SpacingValue[];
  radii: RadiusValue[];
  shadows: ShadowObservation[];
  screenshots: Screenshot[];
  /** Non-fatal notes about what could not be extracted (coverage gaps). */
  warnings?: string[];
}

// --- The engine contract -----------------------------------------------------

/** Per-run options an engine SHOULD honor; all optional with safe defaults. */
export interface ExtractOptions {
  /** Also capture a dark-mode variant if the engine supports it. */
  dark?: boolean;
  /** Pages to crawl and merge (default 1). */
  pages?: number;
  /** Directory to write screenshot PNGs into. */
  screenshotDir?: string;
  /** Per-run wall-clock budget in ms; the engine aborts past it. */
  timeoutMs?: number;
}

/**
 * The adapter contract. `engine/dembrandt.ts` and (conditionally) `engine/own.ts`
 * implement this; `from-url` depends only on this interface, never on a concrete
 * engine — swapping engines changes exactly one wiring line.
 */
export interface ExtractionEngine {
  readonly name: string;
  extract(url: string, options?: ExtractOptions): Promise<RawExtraction>;
}

// --- Coverage scoring (pure; used by both the spike and the offline tests) ----

/**
 * Which RawExtraction fields carry usable signal. Booleans, not counts, because
 * the verdict is a coverage predicate, not a magnitude. `colorRoleEvidence` is
 * split out from `colors` because the plan's minimum set requires *role-bearing*
 * color, not merely any color (a blank page still yields a default bg color).
 */
export interface Coverage {
  colors: boolean;
  colorRoleEvidence: boolean;
  fonts: boolean;
  typeSizes: boolean;
  spacing: boolean;
  radii: boolean;
  shadows: boolean;
  screenshots: boolean;
}

/** True when a color cluster carries at least one role with a positive count. */
function hasRoleEvidence(cluster: ColorCluster): boolean {
  return cluster.roles.some((r) => r.count > 0);
}

/** Score which fields a RawExtraction populated. Pure — no I/O, no engine calls. */
export function coverageOf(x: RawExtraction): Coverage {
  return {
    colors: x.colors.some((c) => c.frequency > 0),
    colorRoleEvidence: x.colors.some(hasRoleEvidence),
    fonts: x.fonts.length > 0,
    typeSizes: x.typeSizes.length > 0,
    spacing: x.spacing.length > 0,
    radii: x.radii.length > 0,
    shadows: x.shadows.length > 0,
    screenshots: x.screenshots.length > 0,
  };
}

/**
 * The fields that MUST be populated on a token-rich site for a `wrap` verdict
 * (plan Step 8 procedure §5): colors with frequency + role evidence, font
 * stacks, type sizes, and screenshots.
 */
export const MINIMUM_COVERAGE_FIELDS = [
  'colors',
  'colorRoleEvidence',
  'fonts',
  'typeSizes',
  'screenshots',
] as const satisfies readonly (keyof Coverage)[];

/** True when every field in the minimum coverage set is populated. */
export function meetsMinimumCoverage(x: RawExtraction): boolean {
  const c = coverageOf(x);
  return MINIMUM_COVERAGE_FIELDS.every((field) => c[field]);
}

/**
 * Count of substantive design observations (everything except screenshots — a
 * blank page still screenshots). The garbage anchor is judged near-empty by
 * this count falling at or below NEAR_EMPTY_MAX.
 */
export function substantiveObservationCount(x: RawExtraction): number {
  return (
    x.colors.length +
    x.fonts.length +
    x.typeSizes.length +
    x.spacing.length +
    x.radii.length +
    x.shadows.length
  );
}

/**
 * Threshold for "near-empty" (garbage anchor). A real UA renders about:blank
 * with a small number of default styles (a body background, a default text
 * color/size); anything at or below this count is default-only, not a real
 * design system. Set from the measured about:blank baseline in the Step 8 spike.
 */
export const NEAR_EMPTY_MAX = 4;

/** True when an extraction carries no more than default-UA-level signal. */
export function isNearEmpty(x: RawExtraction): boolean {
  return substantiveObservationCount(x) <= NEAR_EMPTY_MAX;
}
