/**
 * Per-site hybrid-score orchestrator (Brand-Fidelity plan §5, Step 7 skeleton, #36).
 *
 * Combines Step 5's colour-fidelity scorer (`color-fidelity.ts`) and Step 6's
 * font-fidelity scorer (`font-fidelity.ts`) into a single per-site
 * `FidelityResult`. PURE ORCHESTRATION over structured inputs (a production
 * `NormalizeResult` + `RawExtraction` + frozen `TruthTemplate`) — no I/O, no
 * `.md` parsing, no network, no wall-clock, no randomness. Determinism is
 * inherited entirely from its inputs: `normalize()` is itself a pure function
 * of its `RawExtraction` argument, so `scoreSite` is a pure function of
 * (extraction, truth) end to end.
 *
 * ----------------------------------------------------- SKELETON SCOPE (Step 7) ---
 * This is the SKELETON the plan's Step 7 calls for: it scores ONE site's
 * colour + font fidelity and returns a `FidelityResult`. It deliberately does
 * NOT build:
 *   - the full-suite rollup across the corpus (czg-control weighting <0.5x,
 *     Monet-preset exclusion from the fidelity rollup, slider-coverage /
 *     weak-region aggregation) — that is Step 10 (`#39`).
 *   - the mood/type judged axis (`mood-judge.ts`, Steps 8/9) — not built yet;
 *     `FidelityResult` has room to grow a `mood` field later without breaking
 *     this shape (additive, per plan §4 impact-table discipline).
 * `scoreSite` is written to be trivially extensible for both: Step 10 will
 * call it once per corpus site and fold the results, not replace it.
 *
 * --------------------------------------------------- no boundary mock, no re-derivation ---
 * `scoreSite` reads the SAME accessor seam `color-fidelity.ts` /
 * `font-fidelity.ts` already export — `scoreableProposalFromNormalize` /
 * `scoreableFontsProposalFromNormalize` — rather than re-deriving a proposal
 * shape from `norm` itself (one source of truth, code-quality.md). The caller
 * (the Step 7 smoke test) is responsible for producing `norm`/`extraction` via
 * the real extraction boundary (the `FixtureEngine` seam reading a committed
 * `raw-extraction.json`, then production `normalize()`) — `score.ts` itself
 * never reads a fixture file or constructs an engine; that would blur the
 * "pure orchestration over structured inputs" contract this module exists to
 * keep.
 *
 * ------------------------------------------------------- a11y/CVD stays its own axis ---
 * `cvd` (the CVD-sim sub-check) is carried on `FidelityResult` SEPARATELY from
 * `color`/`font` and is NEVER folded into `pass` — mirrors
 * `color-fidelity.ts`'s own "a11y/CVD is its own axis" discipline (plan §6).
 * A future corpus-level a11y rollup (Step 10) reads `.cvd` directly; it must
 * never derive from `.pass`.
 */

import type { RawExtraction } from '../extract/engine/adapter.ts';
import type { NormalizeResult } from '../extract/normalize.ts';
import type { TruthTemplate } from '../../benchmark/truth-scaffold.ts';
import type { CorpusEntry, SliderAxis } from '../../benchmark/corpus.ts';
import { SLIDER_AXES } from '../../benchmark/corpus.ts';
import {
  DEFAULT_THRESHOLDS,
  scoreColorFidelity,
  scoreCvdAxis,
  scoreableProposalFromNormalize,
  type ColorFidelityResult,
  type ColorFidelityThresholds,
  type CvdAxisResult,
} from './color-fidelity.ts';
import {
  scoreFontFidelity,
  scoreableFontsProposalFromNormalize,
  type FontFidelityResult,
} from './font-fidelity.ts';

/**
 * The per-site hybrid-fidelity result. `color` + `font` are the two
 * deterministic Step 5/6 scorers combined here; `cvd` is the a11y sub-axis,
 * reported alongside but never folded into `pass` (see file header).
 */
export interface FidelityResult {
  /** Corpus id this result was scored for (e.g. `"stripe"`). */
  siteId: string;
  color: ColorFidelityResult;
  font: FontFidelityResult;
  /** a11y/CVD sub-check — its own axis, never folded into `pass`. */
  cvd: CvdAxisResult;
  /**
   * `color.pass AND font.pass`. PROVISIONAL per-site gate for this skeleton
   * only — a full corpus rollup (czg weighting, Monet exclusion, a11y-as-
   * separate-axis aggregation) is Step 10, not here. Note `font.pass` is
   * `false` (not vacuously `true`) whenever `font.scoredRoles` is empty (an
   * unpinned/scaffolded truth, e.g. the czg controls) — `font-fidelity.ts`'s
   * own regression guard — so a site whose truth was never frozen correctly
   * reads as an overall `pass: false` here too, never a silent pass.
   */
  pass: boolean;
}

/**
 * Score one site's colour + font fidelity against its frozen truth and
 * combine into a single `FidelityResult`. Pure; no I/O. `siteId` is the
 * corpus id, carried through for a future suite rollup. `norm` is the
 * production `NormalizeResult` for this site (from `normalize(extraction)` —
 * the caller runs the real extraction/normalize stages; this function only
 * orchestrates scoring over the result). `extraction` is the same
 * `RawExtraction` that produced `norm`, needed directly by
 * `scoreColorFidelity`'s role-agnostic saturated-top-K check (it reads
 * `extraction.colors`, which is not derivable from `norm` alone). `truth` is
 * the frozen `TruthTemplate` ground truth for this site. `thresholds` covers
 * colour-fidelity + CVD (default `DEFAULT_THRESHOLDS`); font-fidelity has no
 * numeric thresholds of its own (see `font-fidelity.ts`'s file header), so it
 * is never passed one.
 */
export function scoreSite(
  siteId: string,
  norm: NormalizeResult,
  extraction: RawExtraction,
  truth: TruthTemplate,
  thresholds: ColorFidelityThresholds = DEFAULT_THRESHOLDS,
): FidelityResult {
  const colorProposal = scoreableProposalFromNormalize(norm);
  const fontProposal = scoreableFontsProposalFromNormalize(norm);

  const color = scoreColorFidelity(colorProposal, extraction, truth, thresholds);
  const font = scoreFontFidelity(fontProposal, truth);
  const cvd = scoreCvdAxis(colorProposal, thresholds);

  return {
    siteId,
    color,
    font,
    cvd,
    pass: color.pass && font.pass,
  };
}

/**
 * ============================================================================
 * SUITE ROLLUP (Step 10, #39) — aggregates per-site `FidelityResult`s (above)
 * across the whole corpus into a suite-level report input.
 * ============================================================================
 *
 * Still PURE ORCHESTRATION over structured inputs only (same discipline as
 * `scoreSite` above): no I/O, no fixture reads, no network, no wall-clock, no
 * randomness. The I/O-ful corpus replay (reading fixtures/truth files off
 * disk, driving `FixtureEngine`/live extraction, capturing screenshots for the
 * mood axis) lives in `src/eval/corpus-runner.ts`, which calls `scoreSite` +
 * everything below and hands the result to `src/eval/report.ts` for
 * rendering. This module never becomes I/O-ful just because the corpus grew a
 * suite level — that would blur the "pure orchestration" contract the file
 * header above already establishes for `scoreSite`.
 *
 * -------------------------------------------------- czg weighting + Monet exclusion ---
 * `CZG_CONTROL_WEIGHT` (< 0.5, plan §6 "czg controls weighted <0.5x") down-
 * weights every `isControl` corpus entry (the csszengarden skins) in the
 * fidelity rollup's weighted pass-rate/score — same-HTML-different-skin
 * controls are a useful smoke signal but not 2003-era ground truth (plan §6).
 * Monet mood-anchor presets are excluded from the fidelity rollup NOT by a
 * runtime filter here but STRUCTURALLY: `CorpusFidelityEntry.entry` is a
 * `CorpusEntry` (the schema-validated shape `benchmark/corpus.ts` parses from
 * `corpus.json`), and no Monet preset is or can be a corpus entry — they are
 * `templates/presets/monet-*` template dirs, never rows in the corpus
 * manifest (verified in `test/eval.score.test.ts` against the REAL loaded
 * corpus). The mood axis's use of the Monet mismatch anchor (calibration) is
 * carried entirely on a SEPARATE `MoodSuiteResult` (`report.ts`) that this
 * rollup never reads — there is no code path by which a Monet result could
 * enter `SuiteRollup.fidelity`/`.sliderCoverage`/etc.
 *
 * -------------------------------------------------------------- a11y is its own axis ---
 * `summarizeA11y` reads ONLY `fidelity.cvd` (never `fidelity.pass`) — mirrors
 * `scoreSite`'s own "cvd is never folded into pass" discipline one level up.
 *
 * ------------------------------------------------- slider-coverage + weak regions ---
 * Each of the corpus's 8 palette-slider axes (`benchmark/corpus.ts`'s
 * `SLIDER_AXES`) is split into low/mid/high terciles ([0,1/3), [1/3,2/3),
 * [2/3,1]); `summarizeSliderCoverage` computes a weighted pass rate + mean
 * colour-fidelity score per axis+bucket. `findSliderWeakRegions` flags any
 * bucket whose weighted pass rate falls below `WEAK_REGION_PASS_RATE` (0.5)
 * AND carries at least `WEAK_REGION_MIN_WEIGHT` of weighted evidence (so a
 * single low-confidence site can't look like a "systemic" weak region).
 *
 * ------------------------------------------------ #25 / #27 / #26 (known findings) ---
 * These functions are the mechanism the report's "known findings" section
 * reads — each is a GENERIC rule over the real computed scores, never an
 * `if (siteId === 'github')` special case (measurement-validity: the finding
 * must fall out of the metric, not be hard-coded):
 *
 *   - `findMaterialBackgroundMismatches` (#25, "GitHub's dark-background
 *     mismatch"): for every REAL (non-control) site with a pinned
 *     `backgroundLight`/`backgroundDark`, flags the side as MATERIAL when it
 *     FAILS `color-fidelity.ts`'s own already-calibrated `backgroundMatch`
 *     pass gate (`!side.pass`, i.e. `deltaE > thresholds.backgroundMatch`) —
 *     REUSING that gate rather than a near-zero epsilon. An earlier revision
 *     of this function flagged EVERY non-exact reproduction (`deltaE > ~0`),
 *     which is trivially true for ~22/24 real-site background slots
 *     (`color.semantic.bg` is ALWAYS ramp-synthesized, never a literal copy —
 *     see `normalize.ts`'s `applySemantic`) and therefore NON-DISCRIMINATING
 *     noise, not signal (review finding, Step 10 second pass). Reusing the
 *     calibrated gate instead yields a genuinely selective list (on the real
 *     v1 corpus: ~3/12 real sites' dark side, 0/12 light side) sorted worst-
 *     first with a magnitude-scaled severity (`severityRatio =
 *     deltaE / thresholds.backgroundMatch`). Because that gate is HONEST,
 *     github's own dark-bg ΔE (~2.7, well under the 10.0 gate — one of the
 *     SMALLER real-site mismatches, not a top-half offender) does NOT itself
 *     appear as "material" — `crossCheckIssue25` (below) surfaces this
 *     explicitly as a face-validity signal rather than silently dropping the
 *     historical claim once the detector was made discriminating.
 *   - `crossCheckIssue25` (#25 face-validity cross-check, NOT a generic
 *     detector): a NAMED, documented comparison against the ONE historical
 *     claim `findMaterialBackgroundMismatches` traces back to (gh issue #25:
 *     github's shipped dark bg `#151719` vs its true `#0d1117`, "the
 *     background color doesn't really match"). States, honestly, whether the
 *     CURRENT instrument agrees (github IS flagged material) or disagrees
 *     (github's ΔE clears the gate) — a genuine disagreement is itself
 *     useful Step-11 signal (either the ΔE gate is too lenient for near-black
 *     tones, or #25's real complaint — `applySemantic()` NEVER reusing a
 *     site's own extracted dark-background cluster even when one exists with
 *     real `background:` role evidence — isn't fully captured by a pinned-hex
 *     ΔE at all). This function is deliberately NOT reused for any other
 *     finding; it exists only to keep this one historical claim honest.
 *   - `findAccentRecoveryFailures` (#27, "the accent-vs-action-blue gap"):
 *     every REAL site whose colour-fidelity `accentRecovered` is false (the
 *     Step 5 accent-recovery gate) — includes github (true green `#0fbf3e`
 *     vs shipped light-blue seed), nytimes, and kurzgesagt, among others.
 *   - `findCategoricalSameness` (#26, "categorical-sameness"): a purely
 *     STRUCTURAL check over `CorpusFidelityEntry.categoricalSecondary`
 *     (`color.chart.categorical.2`..`.8` as actually shipped) — no truth file
 *     involved at all (`applyChart` in `normalize.ts` never overrides those
 *     leaves past the default preset, so every proposal ships the identical
 *     7-hex tail regardless of brand). Reports the fraction of corpus sites
 *     sharing the majority (mode) categorical-tail array; `detected` fires
 *     once that fraction clears `CATEGORICAL_SAMENESS_THRESHOLD`.
 */

// --- czg weighting -------------------------------------------------------

/** czg-control weight in every rollup aggregate below — plan §6 "weighted <0.5x real sites". Kept a plain named constant (not a magic literal) so a future re-derivation can't silently drift from "<0.5" (code-quality.md one-source-of-truth). */
export const CZG_CONTROL_WEIGHT = 0.4;
/** Weight for a real (non-control) corpus site. */
export const REAL_SITE_WEIGHT = 1;

/** The rollup weight for a corpus entry: `CZG_CONTROL_WEIGHT` for a csszengarden control, `REAL_SITE_WEIGHT` otherwise. */
export function siteWeight(entry: Pick<CorpusEntry, 'isControl'>): number {
  return entry.isControl ? CZG_CONTROL_WEIGHT : REAL_SITE_WEIGHT;
}

// --- the per-site rollup input ---------------------------------------------

/**
 * One corpus site's full scored record — everything the suite rollup +
 * report need, assembled by `corpus-runner.ts` (I/O) and handed here (pure).
 */
export interface CorpusFidelityEntry {
  /** The validated corpus manifest entry (id, url, archetype, sliderCoords, isControl, tier, heldOut). */
  entry: CorpusEntry;
  /** The frozen ground truth this site was scored against. */
  truth: TruthTemplate;
  /** This site's per-site hybrid fidelity result (`scoreSite` above). */
  fidelity: FidelityResult;
  /** The site's shipped semantic backgrounds (light + dark) — the same `ScoreableProposal` fields `scoreColorFidelity` compared against `truth.pinned`, carried here so a report can cite the literal shipped hex (e.g. #25's "true #0d1117 vs shipped #151719"). */
  shippedBackground: { light: string; dark: string };
  /** The site's shipped brand seed (`NormalizeResult.seed`) — evidence for #27's "shipped X vs true Y" framing. */
  shippedSeed: string;
  /** This site's shipped `color.chart.categorical.2`..`.8` (light tokens), in that order — the #26 structural-sameness evidence. */
  categoricalSecondary: readonly string[];
}

// --- fidelity summary (czg-weighted; Monet cannot appear, see file header) ---

export interface FidelitySummary {
  /** Total sites included (real + control). Never includes a Monet entry (structurally impossible — see file header). */
  sitesScored: number;
  weightedTotal: number;
  weightedPassed: number;
  /** `weightedPassed / weightedTotal` (0 when `weightedTotal` is 0 — an empty rollup is reported as 0, never NaN/divide-by-zero). */
  weightedPassRate: number;
  /** Weighted mean of `fidelity.color.score` across all sites (0..1). */
  weightedMeanColorScore: number;
  /** Unweighted real-site (non-control) breakdown — the report's "how many REAL sites passed" framing, independent of the control down-weight. */
  real: { total: number; passed: number };
  /** Unweighted control (czg) breakdown. */
  control: { total: number; passed: number };
}

/** Aggregate `fidelity.pass`/`fidelity.color.score` across sites with czg controls weighted `CZG_CONTROL_WEIGHT`. */
export function summarizeFidelity(sites: readonly CorpusFidelityEntry[]): FidelitySummary {
  let weightedTotal = 0;
  let weightedPassed = 0;
  let weightedColorScoreSum = 0;
  let realTotal = 0;
  let realPassed = 0;
  let controlTotal = 0;
  let controlPassed = 0;

  for (const site of sites) {
    const w = siteWeight(site.entry);
    weightedTotal += w;
    if (site.fidelity.pass) weightedPassed += w;
    weightedColorScoreSum += w * site.fidelity.color.score;
    if (site.entry.isControl) {
      controlTotal += 1;
      if (site.fidelity.pass) controlPassed += 1;
    } else {
      realTotal += 1;
      if (site.fidelity.pass) realPassed += 1;
    }
  }

  return {
    sitesScored: sites.length,
    weightedTotal,
    weightedPassed,
    weightedPassRate: weightedTotal > 0 ? weightedPassed / weightedTotal : 0,
    weightedMeanColorScore: weightedTotal > 0 ? weightedColorScoreSum / weightedTotal : 0,
    real: { total: realTotal, passed: realPassed },
    control: { total: controlTotal, passed: controlPassed },
  };
}

// --- a11y/CVD rollup (its OWN axis — never derived from `.pass`) ------------

export interface A11ySummary {
  sitesChecked: number;
  distinguishableCount: number;
  /** 0 when `sitesChecked` is 0 (never NaN). */
  distinguishableRate: number;
  /** Corpus ids whose CVD-sim sub-check found at least one non-distinguishable pairing. */
  failingSiteIds: string[];
}

/** Aggregate `fidelity.cvd.allDistinguishable` across sites. Reads ONLY `.cvd` — never `.pass` (a11y/CVD is its own axis, plan §6, mirroring `scoreSite`'s own discipline). */
export function summarizeA11y(sites: readonly CorpusFidelityEntry[]): A11ySummary {
  const failingSiteIds = sites.filter((s) => !s.fidelity.cvd.allDistinguishable).map((s) => s.entry.id);
  const sitesChecked = sites.length;
  const distinguishableCount = sitesChecked - failingSiteIds.length;
  return {
    sitesChecked,
    distinguishableCount,
    distinguishableRate: sitesChecked > 0 ? distinguishableCount / sitesChecked : 0,
    failingSiteIds,
  };
}

// --- slider-coverage rollup (8 axes x 3 buckets) ----------------------------

export type SliderBucket = 'low' | 'mid' | 'high';

/** Tercile bucket of a [0,1] slider coordinate: `[0, 1/3)` low, `[1/3, 2/3)` mid, `[2/3, 1]` high. */
export function sliderBucketOf(value: number): SliderBucket {
  if (value < 1 / 3) return 'low';
  if (value < 2 / 3) return 'mid';
  return 'high';
}

export interface SliderBucketStat {
  axis: SliderAxis;
  bucket: SliderBucket;
  siteIds: string[];
  weightedTotal: number;
  weightedPassed: number;
  /** 0 when `weightedTotal` is 0 (an empty bucket — never NaN). */
  weightedPassRate: number;
  /** Weighted mean `fidelity.color.score` across sites in this bucket (same `siteWeight` used for the pass rate — consistent weighting within one row; 0 when empty). */
  meanColorScore: number;
}

/**
 * One row per (axis, bucket) — 8 axes x 3 buckets = 24 rows, some possibly
 * empty (0 sites). Deliberately keyed on `fidelity.color.pass` (NOT the
 * composite `fidelity.pass`): the 8 slider axes (`benchmark/corpus.ts`) are
 * entirely PALETTE-descriptive (warmth/saturation/lightness/contrast/
 * hueDiversity/accentDominance/neutralRatio/vibrancy) — font fidelity has no
 * relationship to any of them. Using the composite pass would let the czg
 * controls' font axis (permanently unscored/`false` — they carry no pinned
 * font truth, `font-fidelity.ts`'s own vacuous-pass guard) drag down every
 * bucket a control happens to land in, an artifact of a DIFFERENT axis
 * masquerading as a palette-space weakness.
 */
export function summarizeSliderCoverage(sites: readonly CorpusFidelityEntry[]): SliderBucketStat[] {
  const stats: SliderBucketStat[] = [];
  for (const axis of SLIDER_AXES) {
    for (const bucket of ['low', 'mid', 'high'] as const) {
      const inBucket = sites.filter((s) => sliderBucketOf(s.entry.sliderCoords[axis]) === bucket);
      let weightedTotal = 0;
      let weightedPassed = 0;
      let weightedColorScoreSum = 0;
      for (const s of inBucket) {
        const w = siteWeight(s.entry);
        weightedTotal += w;
        if (s.fidelity.color.pass) weightedPassed += w;
        weightedColorScoreSum += w * s.fidelity.color.score;
      }
      stats.push({
        axis,
        bucket,
        siteIds: inBucket.map((s) => s.entry.id),
        weightedTotal,
        weightedPassed,
        weightedPassRate: weightedTotal > 0 ? weightedPassed / weightedTotal : 0,
        meanColorScore: weightedTotal > 0 ? weightedColorScoreSum / weightedTotal : 0,
      });
    }
  }
  return stats;
}

// --- weak-region rollup ------------------------------------------------------

/** A slider bucket's weighted pass rate must fall below this to be reported as a weak region. */
export const WEAK_REGION_PASS_RATE = 0.5;
/** Minimum weighted evidence a bucket needs before it's eligible to be called a weak region (a single low-weight site can't look "systemic"). */
export const WEAK_REGION_MIN_WEIGHT = 1;

export interface WeakRegion {
  /** `"<axis>:<bucket>"`, e.g. `"warmth:low"`. */
  id: string;
  kind: 'slider';
  axis: SliderAxis;
  bucket: SliderBucket;
  siteIds: string[];
  weightedPassRate: number;
  description: string;
}

/** Slider-space buckets the tool is systematically weak in (weighted pass rate below `WEAK_REGION_PASS_RATE`, with enough weighted evidence to matter). */
export function findSliderWeakRegions(stats: readonly SliderBucketStat[]): WeakRegion[] {
  return stats
    .filter((s) => s.weightedTotal >= WEAK_REGION_MIN_WEIGHT && s.weightedPassRate < WEAK_REGION_PASS_RATE)
    .map((s) => ({
      id: `${s.axis}:${s.bucket}`,
      kind: 'slider' as const,
      axis: s.axis,
      bucket: s.bucket,
      siteIds: s.siteIds,
      weightedPassRate: s.weightedPassRate,
      description:
        `${s.axis} (${s.bucket}): weighted pass rate ${(s.weightedPassRate * 100).toFixed(0)}% ` +
        `across ${s.siteIds.length} site(s) [${s.siteIds.join(', ')}]`,
    }));
}

// --- #25: MATERIAL background mismatches ("GitHub's dark-background mismatch") ---

/** A background mismatch's severity, scaled by how far past the materiality
 * gate it sits (`severityRatio = deltaE / thresholds.backgroundMatch`; only
 * ever computed for entries that already failed the gate, so this is always
 * `> 1`). `>= HIGH_SEVERITY_RATIO` reads "high", otherwise "medium" — there is
 * deliberately no "low" bucket here (an entry that didn't clear the
 * materiality gate at all is not in this list in the first place; see
 * `findMaterialBackgroundMismatches`). */
export const HIGH_SEVERITY_RATIO = 1.5;

export type BackgroundMismatchSeverity = 'high' | 'medium';

/** Map a severity ratio (always `> 1` for an entry in this list) to a `high`/`medium` bucket. */
export function backgroundMismatchSeverity(ratio: number): BackgroundMismatchSeverity {
  return ratio >= HIGH_SEVERITY_RATIO ? 'high' : 'medium';
}

export interface BackgroundMismatchEntry {
  siteId: string;
  side: 'light' | 'dark';
  deltaE: number;
  pinnedHex: string;
  shippedHex: string;
  confidence: TruthTemplate['pinned']['accent']['confidence'];
  /** `deltaE / thresholds.backgroundMatch` — always `> 1` (this list only holds gate-failing entries). */
  severityRatio: number;
  severity: BackgroundMismatchSeverity;
}

/**
 * #25 mechanism (DISCRIMINATING — see file header for the review history):
 * every REAL (non-control) site whose shipped background FAILS
 * `color-fidelity.ts`'s own already-calibrated `backgroundMatch` pass gate
 * (`!side.pass`) — i.e. a MATERIAL mismatch, not merely a non-exact one
 * (`color.semantic.bg` is ALWAYS ramp-synthesized, so "non-exact" alone is
 * true for nearly every site and carries no signal). Sorted worst-first by
 * `deltaE` so the report reads as a genuine priority order, not manifest
 * order; each entry carries a magnitude-scaled `severity` rather than a flat
 * label.
 */
export function findMaterialBackgroundMismatches(
  sites: readonly CorpusFidelityEntry[],
  thresholds: ColorFidelityThresholds = DEFAULT_THRESHOLDS,
): BackgroundMismatchEntry[] {
  const out: BackgroundMismatchEntry[] = [];
  for (const site of sites) {
    if (site.entry.isControl) continue; // real-site framing only, mirrors #25's own scope
    const darkPinned = site.truth.pinned.backgroundDark;
    const dark = site.fidelity.color.background.dark;
    if (darkPinned !== null && dark !== null && !dark.pass) {
      const severityRatio = dark.deltaE / thresholds.backgroundMatch;
      out.push({
        siteId: site.entry.id,
        side: 'dark',
        deltaE: dark.deltaE,
        pinnedHex: darkPinned.hex,
        shippedHex: site.shippedBackground.dark,
        confidence: darkPinned.confidence,
        severityRatio,
        severity: backgroundMismatchSeverity(severityRatio),
      });
    }
    const lightPinned = site.truth.pinned.backgroundLight;
    const light = site.fidelity.color.background.light;
    if (lightPinned !== null && light !== null && !light.pass) {
      const severityRatio = light.deltaE / thresholds.backgroundMatch;
      out.push({
        siteId: site.entry.id,
        side: 'light',
        deltaE: light.deltaE,
        pinnedHex: lightPinned.hex,
        shippedHex: site.shippedBackground.light,
        confidence: lightPinned.confidence,
        severityRatio,
        severity: backgroundMismatchSeverity(severityRatio),
      });
    }
  }
  return out.sort((a, b) => b.deltaE - a.deltaE); // worst-first
}

// --- #25 face-validity cross-check (NAMED historical claim, not a generic detector) ---

/** The one historical claim `crossCheckIssue25` compares the current instrument against — gh issue #25's own evidence: github's shipped dark bg `#151719` vs its true `#0d1117`. */
export const ISSUE_25_SITE_ID = 'github';
export const ISSUE_25_SIDE: 'dark' = 'dark';

export interface BackgroundFaceValidityCrossCheck {
  siteId: string;
  side: 'light' | 'dark';
  deltaE: number;
  materialityThreshold: number;
  /** Whether the CURRENT instrument (the `backgroundMatch` gate) flags this side as material. */
  flaggedAsMaterial: boolean;
  pinnedHex: string;
  shippedHex: string;
}

/**
 * Look up one site+side's scored background data and report whether the
 * current instrument flags it as material — the mechanism
 * `crossCheckIssue25` calls for the ONE named historical claim (see file
 * header). Returns `null` when the site isn't present or its pinned truth
 * for that side is null (nothing to cross-check).
 */
export function crossCheckBackgroundFinding(
  sites: readonly CorpusFidelityEntry[],
  siteId: string,
  side: 'light' | 'dark',
  thresholds: ColorFidelityThresholds = DEFAULT_THRESHOLDS,
): BackgroundFaceValidityCrossCheck | null {
  const site = sites.find((s) => s.entry.id === siteId);
  if (site === undefined) return null;
  const pinned = side === 'dark' ? site.truth.pinned.backgroundDark : site.truth.pinned.backgroundLight;
  const scored = side === 'dark' ? site.fidelity.color.background.dark : site.fidelity.color.background.light;
  if (pinned === null || scored === null) return null;
  return {
    siteId,
    side,
    deltaE: scored.deltaE,
    materialityThreshold: thresholds.backgroundMatch,
    flaggedAsMaterial: !scored.pass,
    pinnedHex: pinned.hex,
    shippedHex: side === 'dark' ? site.shippedBackground.dark : site.shippedBackground.light,
  };
}

/**
 * THE #25 face-validity cross-check (see `ISSUE_25_SITE_ID`/`ISSUE_25_SIDE`
 * + the file header for why this is a named, one-off comparison, not a
 * generic mechanism reused elsewhere). Honestly states whether the CURRENT
 * deterministic instrument agrees or disagrees with the original operator
 * eyeball (gh issue #25) — this is itself a legitimate, non-fabricated
 * finding: a disagreement means either the ΔE gate is too lenient for
 * near-black tones, or #25's real complaint (never reusing the site's own
 * extracted dark-background cluster) isn't fully captured by a pinned-hex
 * ΔE at all. NEVER used to force github into `findMaterialBackgroundMismatches`.
 */
export function crossCheckIssue25(
  sites: readonly CorpusFidelityEntry[],
  thresholds: ColorFidelityThresholds = DEFAULT_THRESHOLDS,
): BackgroundFaceValidityCrossCheck | null {
  return crossCheckBackgroundFinding(sites, ISSUE_25_SITE_ID, ISSUE_25_SIDE, thresholds);
}

// --- structural note: exact-reproduction rate (informational only, not a "finding") ---

export interface BackgroundExactMatchStats {
  /** Real-site background sides checked (both light+dark, non-null pinned truth only). */
  sidesChecked: number;
  /** Sides where the shipped value is an EXACT (ΔE ~0) reproduction of the pinned truth. */
  exactCount: number;
}

/** How often the tool's shipped background is a BYTE-exact reproduction of the pinned truth — informational context for the report (NOT itself a "mismatch" finding; `color.semantic.bg` is always ramp-synthesized by construction, so a low count here is expected and is not, on its own, evidence of a fidelity problem — see `findMaterialBackgroundMismatches` for the finding that actually gates). */
export function summarizeBackgroundExactMatches(sites: readonly CorpusFidelityEntry[]): BackgroundExactMatchStats {
  let sidesChecked = 0;
  let exactCount = 0;
  const EXACT_EPSILON = 1e-6;
  for (const site of sites) {
    if (site.entry.isControl) continue;
    const dark = site.fidelity.color.background.dark;
    if (site.truth.pinned.backgroundDark !== null && dark !== null) {
      sidesChecked += 1;
      if (dark.deltaE <= EXACT_EPSILON) exactCount += 1;
    }
    const light = site.fidelity.color.background.light;
    if (site.truth.pinned.backgroundLight !== null && light !== null) {
      sidesChecked += 1;
      if (light.deltaE <= EXACT_EPSILON) exactCount += 1;
    }
  }
  return { sidesChecked, exactCount };
}

// --- #27: accent-recovery failures ("the accent-vs-action-blue gap") -------

export interface AccentRecoveryFailureEntry {
  siteId: string;
  deltaE: number;
  pinnedAccentHex: string;
  shippedSeedHex: string;
}

/**
 * #27 mechanism: every REAL (non-control) site whose colour-fidelity
 * `accentRecovered` is false (Step 5's accent-recovery gate — neither a
 * direct accent match nor a tight-tolerance saturated-top-K recovery).
 * Real-fixture data currently includes github/nytimes/kurzgesagt/linear/
 * basecamp (the "e.g." in the plan's done-when is non-exhaustive by design).
 */
export function findAccentRecoveryFailures(sites: readonly CorpusFidelityEntry[]): AccentRecoveryFailureEntry[] {
  return sites
    .filter((s) => !s.entry.isControl && !s.fidelity.color.accentRecovered)
    .map((s) => ({
      siteId: s.entry.id,
      deltaE: s.fidelity.color.accent.deltaE,
      pinnedAccentHex: s.truth.pinned.accent.hex,
      shippedSeedHex: s.shippedSeed,
    }));
}

// --- #26: categorical-sameness (structural; no truth file involved) --------

/** Fraction of corpus sites that must ship the identical `chart.categorical.2..8` tail for the structural sameness finding to fire. */
export const CATEGORICAL_SAMENESS_THRESHOLD = 0.9;

export interface CategoricalSamenessResult {
  detected: boolean;
  /** Corpus ids sharing the majority (mode) categorical-tail array. */
  matchingSiteIds: string[];
  /** Corpus ids whose categorical-tail array differs from the majority. */
  differingSiteIds: string[];
  /** The shared 7-hex tail, or `null` when no majority cleared the threshold. */
  sharedPalette: readonly string[] | null;
  /** `matchingSiteIds.length / sites.length`. */
  matchFraction: number;
}

/**
 * #26 mechanism: groups sites by their EXACT shipped `categoricalSecondary`
 * array (JSON-keyed) and reports whether the majority group clears
 * `CATEGORICAL_SAMENESS_THRESHOLD`. Purely structural — reads only each
 * site's own shipped build output, never a truth file (there is nothing to
 * pin: `applyChart` in `normalize.ts` never overrides `categorical.2..8` past
 * the default preset, so this is a build-output fact, not a fidelity-to-truth
 * comparison).
 */
export function findCategoricalSameness(sites: readonly CorpusFidelityEntry[]): CategoricalSamenessResult {
  if (sites.length === 0) {
    return { detected: false, matchingSiteIds: [], differingSiteIds: [], sharedPalette: null, matchFraction: 0 };
  }
  const groups = new Map<string, { siteIds: string[]; palette: readonly string[] }>();
  for (const site of sites) {
    const key = JSON.stringify(site.categoricalSecondary);
    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.siteIds.push(site.entry.id);
    } else {
      groups.set(key, { siteIds: [site.entry.id], palette: site.categoricalSecondary });
    }
  }
  let best: { siteIds: string[]; palette: readonly string[] } | undefined;
  for (const group of groups.values()) {
    if (best === undefined || group.siteIds.length > best.siteIds.length) best = group;
  }
  const matchingSiteIds = best?.siteIds ?? [];
  const matchFraction = matchingSiteIds.length / sites.length;
  const detected = matchFraction >= CATEGORICAL_SAMENESS_THRESHOLD;
  const allIds = sites.map((s) => s.entry.id);
  const matchingSet = new Set(matchingSiteIds);
  return {
    detected,
    matchingSiteIds,
    differingSiteIds: allIds.filter((id) => !matchingSet.has(id)),
    sharedPalette: detected ? (best?.palette ?? null) : null,
    matchFraction,
  };
}

// --- punch list ---------------------------------------------------------

export interface PunchListItem {
  id: string;
  severity: 'high' | 'medium' | 'low';
  summary: string;
  evidence: string;
}

/** Sort rank for a punch-list severity (ascending = higher priority first). */
const SEVERITY_RANK: Record<PunchListItem['severity'], number> = { high: 0, medium: 1, low: 2 };

/** Stable-sort a punch list high -> medium -> low so it genuinely reads as a priority order (review finding: an a11y "medium" item was rendering AFTER "low" weak-region items in manifest-insertion order). */
export function sortPunchListBySeverity(items: readonly PunchListItem[]): PunchListItem[] {
  return [...items].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/** Assemble a prioritized punch list from the individual rollups. Pure — a deterministic re-arrangement of data already computed above. Returned already sorted high -> medium -> low. */
export function buildPunchList(input: {
  fidelity: FidelitySummary;
  a11y: A11ySummary;
  sliderWeakRegions: readonly WeakRegion[];
  materialBackgroundMismatches: readonly BackgroundMismatchEntry[];
  accentRecoveryFailures: readonly AccentRecoveryFailureEntry[];
  categoricalSameness: CategoricalSamenessResult;
}): PunchListItem[] {
  const items: PunchListItem[] = [];

  if (input.accentRecoveryFailures.length > 0) {
    items.push({
      id: 'accent-recovery',
      severity: 'high',
      summary: `${input.accentRecoveryFailures.length} real site(s) failed accent recovery — the tool picked the wrong primary brand colour (#27, "accent-vs-action-blue gap").`,
      evidence: input.accentRecoveryFailures
        .map((f) => `${f.siteId}: shipped ${f.shippedSeedHex} vs true ${f.pinnedAccentHex} (ΔE ${f.deltaE.toFixed(1)})`)
        .join('; '),
    });
  }

  if (input.categoricalSameness.detected) {
    items.push({
      id: 'categorical-sameness',
      severity: 'medium',
      summary: `chart.categorical.2-8 is byte-identical across ${input.categoricalSameness.matchingSiteIds.length}/${
        input.categoricalSameness.matchingSiteIds.length + input.categoricalSameness.differingSiteIds.length
      } corpus sites — only categorical-1 tracks the brand seed (#26, "categorical-sameness").`,
      evidence: `shared tail: ${(input.categoricalSameness.sharedPalette ?? []).join(', ')}`,
    });
  }

  if (input.materialBackgroundMismatches.length > 0) {
    const anyHigh = input.materialBackgroundMismatches.some((m) => m.severity === 'high');
    items.push({
      id: 'background-material-mismatch',
      severity: anyHigh ? 'high' : 'medium',
      summary: `${input.materialBackgroundMismatches.length} real-site background(s) MATERIALLY miss the pinned truth (fail color-fidelity.ts's own backgroundMatch gate) — worst first (#25, "GitHub's dark-background mismatch").`,
      evidence: input.materialBackgroundMismatches
        .map((m) => `${m.siteId} (${m.side}, ${m.severity}): shipped ${m.shippedHex} vs true ${m.pinnedHex} (ΔE ${m.deltaE.toFixed(1)})`)
        .join('; '),
    });
  }

  for (const region of input.sliderWeakRegions) {
    items.push({
      id: `weak-region:${region.id}`,
      severity: 'low',
      summary: `Palette-space weak region: ${region.description}`,
      evidence: `sites: ${region.siteIds.join(', ')}`,
    });
  }

  if (input.a11y.failingSiteIds.length > 0) {
    items.push({
      id: 'a11y-cvd',
      severity: 'medium',
      summary: `${input.a11y.failingSiteIds.length} site(s) failed the CVD/a11y distinguishability sub-check (reported on its own axis, never folded into fidelity).`,
      evidence: `sites: ${input.a11y.failingSiteIds.join(', ')}`,
    });
  }

  return sortPunchListBySeverity(items);
}

// --- the suite rollup (Step 10 top-level entry point) -----------------------

export interface SuiteRollup {
  fidelity: FidelitySummary;
  a11y: A11ySummary;
  sliderCoverage: SliderBucketStat[];
  sliderWeakRegions: WeakRegion[];
  /** The DISCRIMINATING #25 finding — only sites whose background FAILS the calibrated `backgroundMatch` gate, worst-first, magnitude-scaled severity. See file header. */
  materialBackgroundMismatches: BackgroundMismatchEntry[];
  /** Informational only (never itself a "finding") — how often the shipped background is a byte-exact reproduction of the pinned truth. Expected to be near-zero by construction (`applySemantic` always ramp-synthesizes); NOT evidence of a fidelity problem on its own. */
  backgroundExactMatchStats: BackgroundExactMatchStats;
  /** The #25 face-validity cross-check against the ONE named historical claim (github/dark) — `null` only if github or its pinned dark truth is absent from `sites`. */
  issue25CrossCheck: BackgroundFaceValidityCrossCheck | null;
  accentRecoveryFailures: AccentRecoveryFailureEntry[];
  categoricalSameness: CategoricalSamenessResult;
  punchList: PunchListItem[];
}

/**
 * Build the full suite-level rollup from every corpus site's scored record.
 * Pure; no I/O (see file header). `corpus-runner.ts` is the caller: it
 * replays each corpus site (fixture or live), calls `scoreSite` per site to
 * build a `CorpusFidelityEntry[]`, and passes that array here.
 */
export function buildSuiteRollup(sites: readonly CorpusFidelityEntry[]): SuiteRollup {
  const fidelity = summarizeFidelity(sites);
  const a11y = summarizeA11y(sites);
  const sliderCoverage = summarizeSliderCoverage(sites);
  const sliderWeakRegions = findSliderWeakRegions(sliderCoverage);
  const materialBackgroundMismatches = findMaterialBackgroundMismatches(sites);
  const backgroundExactMatchStats = summarizeBackgroundExactMatches(sites);
  const issue25CrossCheck = crossCheckIssue25(sites);
  const accentRecoveryFailures = findAccentRecoveryFailures(sites);
  const categoricalSameness = findCategoricalSameness(sites);
  const punchList = buildPunchList({
    fidelity,
    a11y,
    sliderWeakRegions,
    materialBackgroundMismatches,
    accentRecoveryFailures,
    categoricalSameness,
  });

  return {
    fidelity,
    a11y,
    sliderCoverage,
    sliderWeakRegions,
    materialBackgroundMismatches,
    backgroundExactMatchStats,
    issue25CrossCheck,
    accentRecoveryFailures,
    categoricalSameness,
    punchList,
  };
}
