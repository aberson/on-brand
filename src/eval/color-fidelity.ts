/**
 * Deterministic colour-fidelity metrics (Brand-Fidelity plan §5/§6/§9, Step 5, #34).
 *
 * Scores how faithfully an `onbrand from-url` PROPOSAL reproduces a site's real
 * brand colours, against the FROZEN human-pinned ground truth
 * (`docs/findings/eval-truth/<id>.truth.json`, schema in `benchmark/truth-scaffold.ts`).
 * Pure functions over structured inputs only — no `.md` report parsing, no network,
 * no wall-clock, no randomness. ΔE2000 (colorjs.io, the same `.deltaE(other, {method:
 * '2000'})` idiom `src/check/contrast.ts` / `src/extract/contrast.ts` already use) is
 * the one distance metric throughout; no new dependency.
 *
 * ------------------------------------------------------- anti-circularity ---
 * Every metric here reads `truth.pinned.*` (human-sourced, frozen) or
 * `truth.goldHex` (the independently-published brand hex) — NEVER
 * `extraction.colors[].roles` as if it were ground truth. Role evidence is only
 * ever used the way the PRODUCTION pipeline already uses it (`selectSeedCandidates`
 * in `src/extract/normalize.ts`, which is what produces `NormalizeResult.seed` +
 * `.seedCandidates`) — i.e. as part of what we are MEASURING, never as the
 * measuring stick itself (plan §6 "Freeze human-pinned roles; don't trust
 * extractor `roles`").
 *
 * --------------------------------------------------------------- the metrics ---
 *   1. `scoreAccentFidelity`         — proposal's shipped seed vs pinned accent.
 *   2. `scoreTopKCoverage`           — is the true accent hue ANYWHERE in the
 *                                      extractor's own ranked candidate pool
 *                                      (`NormalizeResult.seedCandidates`), even if
 *                                      a different one than #1 got shipped? This
 *                                      is role-INFORMED (the candidates are
 *                                      themselves role-weighted by
 *                                      `selectSeedCandidates`) — it separates
 *                                      "extraction never found the hue at all"
 *                                      (this metric fails too) from "extraction
 *                                      found it but the picker chose wrong"
 *                                      (this metric passes, #1 fails).
 *   3. `scoreBackgroundFidelity`     — shipped light/dark background vs pinned
 *                                      `backgroundLight`/`backgroundDark`.
 *                                      SYMMETRICALLY NULLABLE: a `null` pinned
 *                                      side is SKIPPED (returns `null`), never
 *                                      scored against a synthesized value (plan
 *                                      §6 "Symmetric nullable backgrounds" — a
 *                                      dark-first brand pins `backgroundLight:
 *                                      null`; a light-only brand pins
 *                                      `backgroundDark: null`).
 *   4. `scoreSaturatedTopKCoverage`  — the ANTI-GAMING cross-check. Built
 *                                      independently from `RawExtraction.colors`
 *                                      directly (hex + frequency ONLY — `.roles`
 *                                      is never read, hence "role-agnostic"),
 *                                      filtered to non-near-neutral chroma before
 *                                      ranking. A background-heavy or
 *                                      near-white/near-black-dominated extraction
 *                                      therefore CANNOT spuriously "match" a real
 *                                      saturated accent — the white-chrome guard.
 *   5. `scoreCvdAxis`                — CVD-sim sub-check. Simulates the
 *                                      proposal's OWN accent against BOTH the
 *                                      light AND dark shipped backgrounds under
 *                                      3 dichromat types (6 checks total) and
 *                                      checks each stays ΔE-distinguishable —
 *                                      dark-first brands (spotify/linear/
 *                                      robinhood) need the dark surface checked
 *                                      too, not just light. Reported entirely
 *                                      SEPARATELY (its own a11y axis) — never
 *                                      folded into `scoreColorFidelity`'s score
 *                                      (plan §6 "a11y/CVD is its own axis").
 *
 * ------------------------------------------------------------- thresholds ---
 * All thresholds are PROVISIONAL (plan §8 open question: "exact ΔE2000 pass
 * thresholds ... calibrated against the anchor set, revisited at Step 11
 * face-validity"). `accentMatch: 15` is grounded in a real measurement across
 * every pinned v1 site (not just the required anchors): replaying every
 * committed fixture through the PRODUCTION `normalize()` and diffing
 * `seed` vs `pinned.accent` gives a clean bimodal split with a wide dead zone —
 * genuine hits at ΔE 0 / 0 / 0 / 0 / 0 / 8.4 (stripe) / 10.9 (duolingo), genuine
 * misses at ΔE 25.8 / 34.3 / 46.4 / 54.4 / 61.0 (kurzgesagt / nytimes / github /
 * linear / basecamp) — nothing falls in between, so 15 cleanly separates them
 * without being tuned to any single anchor.
 *
 * `confidence` down-weighting (plan §6 "down-weight a low-confidence pin"):
 * `CONFIDENCE_WEIGHT` scales each component's contribution to the composite
 * score so a low-confidence pin (e.g. an aggregator-only source) can't force a
 * false failure the same way a high-confidence official source would.
 *
 * ------------------------------------------------ accent-recovery GATE (Step 5 review fix) ---
 * A code review + completeness critic replaying all 20 real fixtures found: with
 * the ORIGINAL flat weighted-average composite, nytimes (accent ΔE 34.4, both
 * coverage checks failing) still composite-PASSED (score 0.56) purely on a
 * background match; kurzgesagt (ΔE 25.8) and github (ΔE 46.4) likewise
 * composite-PASSED with a wrong accent. Averaging accent into a pool with
 * background lets a right-background/wrong-accent proposal "pass" colour
 * fidelity — the accent is the brand's primary identifying colour (plan §6) and
 * letting background rescue it hands a future `/brand-tune` a Goodhart target
 * (measurement-scope < decision-scope, the measurement-validity rule's hazard).
 *
 * FIX: accent recovery is now a NECESSARY condition for `pass`, not just one
 * term in a weighted average. `accentRecovered = accent.pass OR
 * (saturatedTopKCoverage found the true accent within a TIGHT `recoveryMatch`
 * ΔE)`. When neither holds, `pass` is forced false and `score` is capped at
 * `recoveryCapScore` regardless of how well background/coverage happen to
 * match. Background + both coverage checks remain contributing sub-scores when
 * accent IS recovered (so a genuinely-good extraction that also nails
 * backgrounds still scores higher than a bare accent-only pass) — they just
 * cannot MANUFACTURE a pass on their own.
 *
 * `recoveryMatch` (4, deliberately far TIGHTER than `accentMatch`'s 15) exists
 * because `saturatedTopKCoverage`'s own reporting threshold (15) is not tight
 * enough to serve as "recovery evidence" once you look at WHY it matches for
 * some wrong-accent sites: for kurzgesagt, the "match" is `#0c46da` at raw
 * frequency 2 (ΔE 6.4 from the pinned accent) — one incidental pixel in an
 * illustration-heavy site; for github it's `#5fed83` at frequency 6 (ΔE 12.4) —
 * likewise incidental. Both are noise, not genuine colour reuse: across every
 * v1 site where `saturatedTopKCoverage` legitimately recovers the true accent
 * (duolingo/forliving/imprintgenius/medium/robinhood/spotify/stripe), the
 * matched cluster is an EXACT hex match (ΔE 0.0) even at very low frequency
 * (forliving's match is frequency 2, medium's is frequency 1) — i.e. the site's
 * own literal accent hex genuinely reappears somewhere in the DOM, however
 * rarely. There is a clean, wide gap between "exact reuse" (0.0) and
 * "coincidentally close" (6.4, the nearest noise case) — `recoveryMatch: 4`
 * sits in that gap. This is a SEPARATE, tighter bar than `accentMatch`
 * specifically for what counts as "real recovery" for the pass gate; the
 * looser `accentMatch` is still what `saturatedTopKCoverage.matched` reports
 * for its own (informational/diagnostic) purpose.
 */

import Color from 'colorjs.io';
import { NEAR_NEUTRAL_CHROMA_MAX, type TruthTemplate } from '../../benchmark/truth-scaffold.ts';
import type { ColorCluster, RawExtraction } from '../extract/engine/adapter.ts';
import { getLeaf, type NormalizeResult, type SeedCandidate } from '../extract/normalize.ts';

// --- ΔE2000 (the one distance metric) ----------------------------------------

/**
 * ΔE2000 between two well-formed colors. THROWS on an unparseable string — used
 * only on pinned-truth hexes (schema-validated `#rrggbb`/`#rrggbbaa`) and
 * tool-produced hexes (seed/background, always valid sRGB), mirroring
 * `check/contrast.ts`'s `evaluateContrast` idiom for those inputs.
 */
export function deltaE2000(a: string, b: string): number {
  return new Color(a).deltaE(new Color(b), { method: '2000' });
}

/** `deltaE2000` that returns `undefined` instead of throwing — for
 * extraction-derived hex strings, which (unlike pinned/tool-produced hex) are
 * not schema-validated and must never crash the scorer (mirrors
 * `extract/ramps.ts`'s `tryOklch` / `extract/normalize.ts`'s `oklchOf`). */
function tryDeltaE2000(a: string, b: string): number | undefined {
  try {
    return deltaE2000(a, b);
  } catch {
    return undefined;
  }
}

/** OKLCH chroma of a hex, or `undefined` instead of a throw on an unparseable
 * string (same never-throw-on-extraction-data guard as `ramps.ts`/`normalize.ts`). */
function chromaOf(hex: string): number | undefined {
  try {
    const coords = new Color(hex).to('oklch').coords;
    return coords[1]!;
  } catch {
    return undefined;
  }
}

// --- thresholds + confidence weighting ---------------------------------------

export interface ColorFidelityThresholds {
  /** ΔE2000 at/below which two colours count as "matched" (accent + both top-K coverage checks). */
  accentMatch: number;
  /** ΔE2000 at/below which a proposal background counts as matching its pinned counterpart. */
  backgroundMatch: number;
  /** OKLCH chroma below which a colour is near-neutral chrome, excluded from the saturated-top-K anti-gaming check. */
  nearNeutralChroma: number;
  /** ΔE2000 "still distinguishable" floor for the CVD-sim sub-check. */
  cvdDistinguishable: number;
  /** ΔE2000 span mapped to 0 similarity (`similarity = clamp(1 - deltaE/span, 0, 1)`); grounded in the garbage-anchor distance (~55) measured below. */
  similaritySpan: number;
  /** Composite `score` at/above which `scoreColorFidelity().pass` is true (subject to the accent-recovery gate — see file header). */
  overallPass: number;
  /** TIGHT ΔE2000 bar (far tighter than `accentMatch`) a `saturatedTopKCoverage` match must clear to count as genuine accent-recovery evidence for the pass GATE. See file header "accent-recovery GATE" for why this differs from `accentMatch`. */
  recoveryMatch: number;
  /** Ceiling `score` is capped to when accent recovery fails (neither `accent.pass` nor a tight `saturatedTopKCoverage` match) — keeps the reported number informative (background/coverage similarity still shows) while guaranteeing it never reaches `overallPass`. */
  recoveryCapScore: number;
}

export const DEFAULT_TOP_K = 5; // mirrors normalize.ts's documented "LLM may pick a DIFFERENT top-5 candidate"

/** See the file-header rationale for how each value was grounded. All provisional. */
export const DEFAULT_THRESHOLDS: ColorFidelityThresholds = {
  accentMatch: 15,
  backgroundMatch: 10,
  nearNeutralChroma: NEAR_NEUTRAL_CHROMA_MAX,
  cvdDistinguishable: 10,
  similaritySpan: 60,
  overallPass: 0.5,
  recoveryMatch: 4,
  recoveryCapScore: 0.35,
};

type PinnedConfidence = TruthTemplate['pinned']['accent']['confidence'];

/** Down-weight for a low-confidence pinned role (plan §6). */
export const CONFIDENCE_WEIGHT: Record<PinnedConfidence, number> = {
  high: 1,
  medium: 0.75,
  low: 0.5,
};

/** Map a ΔE2000 distance to a 0..1 similarity (1 = identical, 0 = at/past `similaritySpan`). */
function similarityFromDeltaE(deltaE: number, thresholds: ColorFidelityThresholds): number {
  return Math.max(0, Math.min(1, 1 - deltaE / thresholds.similaritySpan));
}

// --- the scoreable proposal (in-process, no .md parsing) ---------------------

/**
 * The structured slice of an `onbrand from-url` proposal the colour-fidelity
 * scorer needs. Built from a `NormalizeResult` (already exported by
 * `src/extract/normalize.ts`) — never from parsing `extraction-report.md` or
 * `guide.md` (plan §6 "PURE FUNCTIONS over structured inputs").
 */
export interface ScoreableProposal {
  /** The tool's shipped brand seed (the chosen accent). */
  seed: string;
  /** The extractor's full ranked brand-candidate pool (role-informed; from `selectSeedCandidates`). */
  seedCandidates: SeedCandidate[];
  /** Shipped light-mode background (`color.semantic.bg` in the light tokens). */
  backgroundLight: string;
  /** Shipped dark-mode background (`color.semantic.bg` in the dark overlay). */
  backgroundDark: string;
}

/**
 * Build a `ScoreableProposal` from a production `NormalizeResult`. Additive
 * accessor (plan §4 impact table) — reads `tokens`/`dark`'s `color.semantic.bg`
 * leaf via the now-exported `getLeaf` (previously module-private to
 * `normalize.ts`; 0 other external callers, grep-verified).
 *
 * FAILS LOUD (measurement-validity "fail loud on fallback config") if either
 * leaf is missing: `applySemantic` in normalize.ts always sets
 * `color.semantic.bg` on both documents, so a missing leaf means the scorer is
 * being handed a malformed/incompatible `NormalizeResult` (e.g. a stripped-down
 * test double, or a future schema change this scorer wasn't updated for) — that
 * must surface as a loud, specific error, never silently score a made-up
 * sentinel colour as if it were the proposal's real background.
 */
export function scoreableProposalFromNormalize(norm: NormalizeResult): ScoreableProposal {
  const bgLight = getLeaf(norm.tokens as unknown as Record<string, unknown>, 'color.semantic.bg');
  const bgDark = getLeaf(norm.dark as unknown as Record<string, unknown>, 'color.semantic.bg');
  if (typeof bgLight !== 'string') {
    throw new Error(
      'scoreableProposalFromNormalize: norm.tokens is missing a string color.semantic.bg leaf ' +
        '(applySemantic() should always set this — the NormalizeResult is malformed)',
    );
  }
  if (typeof bgDark !== 'string') {
    throw new Error(
      'scoreableProposalFromNormalize: norm.dark is missing a string color.semantic.bg leaf ' +
        '(applySemantic() should always set this — the NormalizeResult is malformed)',
    );
  }
  return {
    seed: norm.seed,
    seedCandidates: norm.seedCandidates,
    backgroundLight: bgLight,
    backgroundDark: bgDark,
  };
}

// --- 1. seed <-> pinned-accent ------------------------------------------------

export interface AccentFidelityResult {
  deltaE: number;
  pass: boolean;
  /** Confidence down-weight from the pinned accent's provenance (plan §6). */
  weight: number;
  /** `deltaE` mapped through the shared similarity curve (0..1). */
  similarity: number;
}

/** Metric 1: the proposal's synthesized seed hue vs the site's true pinned accent. */
export function scoreAccentFidelity(
  proposal: Pick<ScoreableProposal, 'seed'>,
  pinnedAccent: TruthTemplate['pinned']['accent'],
  thresholds: ColorFidelityThresholds = DEFAULT_THRESHOLDS,
): AccentFidelityResult {
  const deltaE = deltaE2000(proposal.seed, pinnedAccent.hex);
  return {
    deltaE,
    pass: deltaE <= thresholds.accentMatch,
    weight: CONFIDENCE_WEIGHT[pinnedAccent.confidence],
    similarity: similarityFromDeltaE(deltaE, thresholds),
  };
}

// --- 2. top-K coverage (role-informed; over the extractor's own candidates) --

export interface TopKCoverageResult {
  k: number;
  candidatesConsidered: number;
  /** True when some candidate within the top-K matches the pinned accent within threshold. */
  matched: boolean;
  /** Smallest ΔE2000 among the considered candidates vs the pinned accent, or undefined if there were none. */
  bestDeltaE: number | undefined;
  /** 1-based rank of the best-ranked candidate that matched, or undefined if none did. */
  matchedRank: number | undefined;
}

/**
 * Metric 2: how many of the site's pinned colours are matched by the proposal's
 * palette within a ΔE2000 threshold — scoped (v1) to the single pinned `accent`
 * (secondary accents are captured but not v1-scored, plan §6). Searches the
 * extractor's OWN ranked candidate pool (`seedCandidates`, already role-weighted
 * by `selectSeedCandidates`), not just the one shipped as `seed` — this is what
 * makes it a distinct signal from `scoreAccentFidelity`: a site can fail #1
 * (wrong candidate picked) while passing #2 (the right hue was in the pool).
 */
export function scoreTopKCoverage(
  proposal: Pick<ScoreableProposal, 'seedCandidates'>,
  pinnedAccent: TruthTemplate['pinned']['accent'],
  opts: { k?: number; thresholds?: ColorFidelityThresholds } = {},
): TopKCoverageResult {
  // Guarded so a future negative/zero-or-garbage k never silently mis-sizes
  // the slice (`.slice(0, -1)` would drop the last element instead of yielding
  // an empty pool).
  const k = Math.max(0, opts.k ?? DEFAULT_TOP_K);
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const pool = proposal.seedCandidates.slice(0, k);

  let bestDeltaE: number | undefined;
  let matchedRank: number | undefined;
  pool.forEach((candidate, i) => {
    const d = deltaE2000(candidate.hex, pinnedAccent.hex);
    if (bestDeltaE === undefined || d < bestDeltaE) bestDeltaE = d;
    if (matchedRank === undefined && d <= thresholds.accentMatch) matchedRank = i + 1;
  });

  return {
    k,
    candidatesConsidered: pool.length,
    matched: matchedRank !== undefined,
    bestDeltaE,
    matchedRank,
  };
}

// --- 3. light + dark background fidelity (symmetrically nullable) -----------

export interface BackgroundSideResult {
  deltaE: number;
  pass: boolean;
  weight: number;
}

export interface BackgroundFidelityResult {
  /** `null` when `pinned.backgroundLight` is null (dark-first brand) — SKIPPED, never scored against a synthesized value. */
  light: BackgroundSideResult | null;
  /** `null` when `pinned.backgroundDark` is null (light-only brand) — SKIPPED. */
  dark: BackgroundSideResult | null;
}

function scoreBackgroundSide(
  proposalHex: string,
  pinned: TruthTemplate['pinned']['backgroundLight'],
  thresholds: ColorFidelityThresholds,
): BackgroundSideResult | null {
  if (pinned === null) return null;
  const deltaE = deltaE2000(proposalHex, pinned.hex);
  return {
    deltaE,
    pass: deltaE <= thresholds.backgroundMatch,
    weight: CONFIDENCE_WEIGHT[pinned.confidence],
  };
}

/**
 * Metric 3: proposal background vs pinned `backgroundLight`/`backgroundDark`.
 * SYMMETRICALLY NULLABLE (plan §6): a null pinned side is skipped, not scored.
 */
export function scoreBackgroundFidelity(
  proposal: Pick<ScoreableProposal, 'backgroundLight' | 'backgroundDark'>,
  pinned: Pick<TruthTemplate['pinned'], 'backgroundLight' | 'backgroundDark'>,
  thresholds: ColorFidelityThresholds = DEFAULT_THRESHOLDS,
): BackgroundFidelityResult {
  return {
    light: scoreBackgroundSide(proposal.backgroundLight, pinned.backgroundLight, thresholds),
    dark: scoreBackgroundSide(proposal.backgroundDark, pinned.backgroundDark, thresholds),
  };
}

// --- 4. role-agnostic saturated-top-K (the anti-gaming cross-check) ---------

export interface SaturatedTopKCoverageResult {
  k: number;
  /** Non-near-neutral clusters retained after the chroma filter, ranked by frequency. */
  saturatedCandidatesConsidered: number;
  matched: boolean;
  bestDeltaE: number | undefined;
}

/**
 * Metric 4: the ANTI-GAMING cross-check (plan §6, §9 "white-chrome guard").
 * Ranks `RawExtraction.colors` by hex + frequency ONLY — `.roles` is never read,
 * so this signal cannot be inflated by miscategorized role evidence the way
 * `scoreTopKCoverage` (built from role-weighted `seedCandidates`) theoretically
 * could be. Near-neutral chrome (`chroma < thresholds.nearNeutralChroma`,
 * e.g. `#fff`/`#000`/greys — the SAME definition `truth-scaffold.ts`'s accent
 * fallback uses, `NEAR_NEUTRAL_CHROMA_MAX`) is excluded BEFORE ranking, so a
 * background- or chrome-dominated extraction has NO candidates left to
 * spuriously "match" a genuinely saturated pinned accent — it can only ever
 * report `matched: false` in that case, never a false high score.
 */
export function scoreSaturatedTopKCoverage(
  colors: readonly ColorCluster[],
  pinnedAccent: TruthTemplate['pinned']['accent'],
  opts: { k?: number; thresholds?: ColorFidelityThresholds } = {},
): SaturatedTopKCoverageResult {
  const k = Math.max(0, opts.k ?? DEFAULT_TOP_K); // guard: see scoreTopKCoverage
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;

  const saturated = colors
    .map((c) => ({ hex: c.hex, frequency: c.frequency, chroma: chromaOf(c.hex) }))
    .filter(
      (c): c is { hex: string; frequency: number; chroma: number } =>
        c.chroma !== undefined && c.chroma >= thresholds.nearNeutralChroma,
    )
    .sort((a, b) => (b.frequency !== a.frequency ? b.frequency - a.frequency : a.hex < b.hex ? -1 : 1))
    .slice(0, k);

  let bestDeltaE: number | undefined;
  for (const candidate of saturated) {
    const d = tryDeltaE2000(candidate.hex, pinnedAccent.hex);
    if (d !== undefined && (bestDeltaE === undefined || d < bestDeltaE)) bestDeltaE = d;
  }

  return {
    k,
    saturatedCandidatesConsidered: saturated.length,
    matched: bestDeltaE !== undefined && bestDeltaE <= thresholds.accentMatch,
    bestDeltaE,
  };
}

// --- composite colour-fidelity score (a11y/CVD is NEVER folded in here) -----

export interface ColorFidelityResult {
  accent: AccentFidelityResult;
  topKCoverage: TopKCoverageResult;
  saturatedTopKCoverage: SaturatedTopKCoverageResult;
  background: BackgroundFidelityResult;
  /**
   * True when the primary accent was recovered by EITHER a direct pass
   * (`accent.pass`) OR a tight-tolerance `saturatedTopKCoverage` match
   * (`bestDeltaE <= thresholds.recoveryMatch`). This is the NECESSARY condition
   * for `pass` — see file header "accent-recovery GATE". Exposed so a report
   * can distinguish "genuinely wrong accent, hard-gated" from "accent fine, just
   * under the score threshold."
   */
  accentRecovered: boolean;
  /**
   * Weighted 0..1 rollup of the 4 colour metrics above (does NOT include the
   * CVD/a11y axis, plan §6). Capped at `thresholds.recoveryCapScore` when
   * `accentRecovered` is false, regardless of how well background/coverage
   * happen to match — background/coverage remain informative contributing
   * sub-scores but can never manufacture a pass on their own.
   */
  score: number;
  /** `accentRecovered AND score >= thresholds.overallPass` (provisional). */
  pass: boolean;
}

/**
 * Score all 4 colour-fidelity metrics for one site + roll them into a single
 * provisional 0..1 `score`/`pass`. The CVD/a11y sub-check is DELIBERATELY not a
 * parameter here — call `scoreCvdAxis` separately and report it on its own axis
 * (plan §6 "a11y/CVD is its own axis").
 */
export function scoreColorFidelity(
  proposal: ScoreableProposal,
  extraction: RawExtraction,
  truth: TruthTemplate,
  thresholds: ColorFidelityThresholds = DEFAULT_THRESHOLDS,
): ColorFidelityResult {
  const accent = scoreAccentFidelity(proposal, truth.pinned.accent, thresholds);
  const topKCoverage = scoreTopKCoverage(proposal, truth.pinned.accent, { thresholds });
  const saturatedTopKCoverage = scoreSaturatedTopKCoverage(extraction.colors, truth.pinned.accent, { thresholds });
  const background = scoreBackgroundFidelity(proposal, truth.pinned, thresholds);

  // Weighted rollup — PROVISIONAL (plan §8), revisited at Step 11 face-validity.
  // Accent (the single shipped pick) carries the most weight since it's what a
  // consuming project actually gets. `saturatedTopKCoverage` is weighted MORE
  // than `topKCoverage` on purpose: `topKCoverage` searches the role-WEIGHTED
  // `seedCandidates` pool, so it can be fooled by a real-but-secondary saturated
  // colour that happens to sit near a wrong reference (empirically verified
  // against the real stripe fixture: its genuine secondary "gradient orange"
  // cluster `#ff6118` — present with real `accent`-role evidence — sits ΔE2000
  // 2.8 from the Hacker-News garbage anchor `#ff6600`, so `topKCoverage` alone
  // spuriously "matches" garbage). `saturatedTopKCoverage` correctly resists
  // this (that cluster's frequency is far too low to crack its role-agnostic
  // top-5-by-frequency cut) — it is the trusted anti-gaming signal, so it
  // outweighs the gameable one rather than being averaged equally with it. Each
  // present background side contributes its own confidence-weighted
  // similarity. A `null` (skipped) background side contributes nothing (neither
  // numerator nor denominator) rather than being scored as a failure.
  const parts: Array<{ weight: number; similarity: number }> = [
    { weight: 2 * accent.weight, similarity: accent.similarity },
    {
      weight: 0.5 * accent.weight,
      similarity: similarityFromDeltaE(topKCoverage.bestDeltaE ?? thresholds.similaritySpan, thresholds),
    },
    {
      weight: 1.5 * accent.weight,
      similarity: similarityFromDeltaE(saturatedTopKCoverage.bestDeltaE ?? thresholds.similaritySpan, thresholds),
    },
  ];
  if (background.light) {
    parts.push({ weight: background.light.weight, similarity: similarityFromDeltaE(background.light.deltaE, thresholds) });
  }
  if (background.dark) {
    parts.push({ weight: background.dark.weight, similarity: similarityFromDeltaE(background.dark.deltaE, thresholds) });
  }

  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  const rawScore = totalWeight > 0 ? parts.reduce((sum, p) => sum + p.weight * p.similarity, 0) / totalWeight : 0;

  // ACCENT-RECOVERY GATE (review fix, see file header). A weighted average lets
  // background+coverage rescue a proposal that never recovered the true accent
  // at all — accent recovery must be a NECESSARY condition for a colour-fidelity
  // PASS, not just one term diluted into an average. `recoveryMatch` is
  // deliberately far tighter than `accentMatch` (see header) so this can't be
  // satisfied by the same low-frequency-coincidence noise that inflates
  // `saturatedTopKCoverage.matched` at its own (looser) reporting threshold.
  const accentRecovered =
    accent.pass ||
    (saturatedTopKCoverage.bestDeltaE !== undefined && saturatedTopKCoverage.bestDeltaE <= thresholds.recoveryMatch);
  const score = accentRecovered ? rawScore : Math.min(rawScore, thresholds.recoveryCapScore);
  const pass = accentRecovered && score >= thresholds.overallPass;

  return {
    accent,
    topKCoverage,
    saturatedTopKCoverage,
    background,
    accentRecovered,
    score,
    pass,
  };
}

// --- 5. CVD-sim sub-check (its own a11y axis; never folded into fidelity) ---

export type CvdType = 'protanopia' | 'deuteranopia' | 'tritanopia';

/**
 * Linear-sRGB dichromat simulation matrices (a widely-used simplified
 * Brettel/Viénot-style approximation, e.g. the Coblis/Fluid colour-blindness
 * simulators). PROVISIONAL — good enough for a relative "does this pairing stay
 * distinguishable" sub-check, not a clinical-grade simulation.
 */
const CVD_MATRICES: Record<CvdType, readonly [number, number, number, number, number, number, number, number, number]> = {
  protanopia: [0.567, 0.433, 0.0, 0.558, 0.442, 0.0, 0.0, 0.242, 0.758],
  deuteranopia: [0.625, 0.375, 0.0, 0.7, 0.3, 0.0, 0.0, 0.3, 0.7],
  tritanopia: [0.95, 0.05, 0.0, 0.0, 0.433, 0.567, 0.0, 0.475, 0.525],
};

/**
 * Simulate a hex colour under a dichromat type: convert to linear sRGB, apply
 * the deficiency matrix, gamut-clamp back to sRGB (same clamp-then-round-to-hex
 * idiom as `extract/ramps.ts`'s `hexFromOklch`), and re-encode as hex.
 */
function simulateCvdHex(hex: string, type: CvdType): string {
  const linear = new Color(hex).to('srgb-linear').coords;
  const [lr, lg, lb] = [linear[0]!, linear[1]!, linear[2]!];
  const m = CVD_MATRICES[type];
  const rgb: [number, number, number] = [
    m[0] * lr + m[1] * lg + m[2] * lb,
    m[3] * lr + m[4] * lg + m[5] * lb,
    m[6] * lr + m[7] * lg + m[8] * lb,
  ];
  let color = new Color('srgb-linear', rgb);
  if (!color.inGamut('srgb')) color = color.toGamut({ space: 'srgb' });
  const srgb = color.to('srgb');
  const bytes = srgb.coords.map((v) => Math.max(0, Math.min(255, Math.round(v * 255))));
  return `#${bytes.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** Which shipped background surface a CVD check paired the accent against. */
export type CvdSurface = 'light' | 'dark';

export interface CvdCheckResult {
  type: CvdType;
  /** Which background surface (`backgroundLight`/`backgroundDark`) this check paired the accent against. */
  surface: CvdSurface;
  /** ΔE2000 between the simulated accent and the simulated background. */
  deltaE: number;
  distinguishable: boolean;
}

export interface CvdAxisResult {
  /** 3 dichromat types x 2 surfaces (light + dark) = 6 checks. */
  checks: CvdCheckResult[];
  /** True only when EVERY check (both surfaces, every simulated type) stays distinguishable. */
  allDistinguishable: boolean;
}

/**
 * Metric 5: CVD-sim sub-check feeding the a11y axis. A WITHIN-PROPOSAL check —
 * does the tool's OWN shipped accent/background pairing stay distinguishable
 * under each dichromat type — NOT a fidelity-to-truth comparison, and reported
 * entirely separately from `scoreColorFidelity` (plan §6). Checks BOTH the
 * light AND dark shipped backgrounds (review fix): several corpus brands are
 * dark-first (spotify/linear/robinhood ship a dark-mode surface as a primary
 * experience, not an afterthought), so checking only `backgroundLight` would
 * silently skip the a11y axis's most relevant surface for exactly those sites.
 */
export function scoreCvdAxis(
  proposal: Pick<ScoreableProposal, 'seed' | 'backgroundLight' | 'backgroundDark'>,
  thresholds: ColorFidelityThresholds = DEFAULT_THRESHOLDS,
): CvdAxisResult {
  const types: CvdType[] = ['protanopia', 'deuteranopia', 'tritanopia'];
  const surfaces: Array<{ surface: CvdSurface; bg: string }> = [
    { surface: 'light', bg: proposal.backgroundLight },
    { surface: 'dark', bg: proposal.backgroundDark },
  ];
  const checks: CvdCheckResult[] = [];
  for (const type of types) {
    const simAccent = simulateCvdHex(proposal.seed, type);
    for (const { surface, bg } of surfaces) {
      const simBg = simulateCvdHex(bg, type);
      const deltaE = deltaE2000(simAccent, simBg);
      checks.push({ type, surface, deltaE, distinguishable: deltaE >= thresholds.cvdDistinguishable });
    }
  }
  return { checks, allDistinguishable: checks.every((c) => c.distinguishable) };
}
