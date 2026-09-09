/**
 * Deterministic colour-fidelity metrics — Brand-Fidelity Step 5 (#34).
 *
 * Calibration-anchor-first (measurement-validity.md): every anchor here scores
 * the PRODUCTION pipeline's real output (`normalize()` replayed over a committed
 * `docs/findings/eval-raw-extractions/benchmark/*.raw-extraction.json` fixture)
 * against the REAL frozen ground truth (`docs/findings/eval-truth/*.truth.json`,
 * validated through the production `truthTemplateSchema`) — no mock at the data
 * boundary, and no hand-built "proposal" standing in for what the tool actually
 * ships. Only the WHITE-CHROME GUARD test constructs a synthetic extraction (by
 * design — it needs a controlled all-chrome palette that no real fixture is
 * guaranteed to have), and only the GARBAGE-ANCHOR test constructs a synthetic
 * ground-truth (the deliberately-wrong Hacker-News-orange reference is data the
 * benchmark must never actually pin as a real site's truth).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { truthTemplateSchema, type TruthTemplate } from '../benchmark/truth-scaffold.ts';
import type { RawExtraction } from '../src/extract/engine/adapter.ts';
import { normalize } from '../src/extract/normalize.ts';
import {
  CONFIDENCE_WEIGHT,
  DEFAULT_THRESHOLDS,
  deltaE2000,
  scoreAccentFidelity,
  scoreBackgroundFidelity,
  scoreColorFidelity,
  scoreCvdAxis,
  scoreSaturatedTopKCoverage,
  scoreTopKCoverage,
  scoreableProposalFromNormalize,
  type ScoreableProposal,
} from '../src/eval/color-fidelity.ts';

const BENCH_DIR = fileURLToPath(
  new URL('../docs/findings/eval-raw-extractions/benchmark/', import.meta.url),
);
const TRUTH_DIR = fileURLToPath(new URL('../docs/findings/eval-truth/', import.meta.url));
const HEX_RE = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;

function readFixture(id: string): RawExtraction {
  return JSON.parse(readFileSync(`${BENCH_DIR}${id}.raw-extraction.json`, 'utf8')) as RawExtraction;
}

/** Read + schema-validate a REAL pinned truth file — the production contract
 * (truthTemplateSchema) is the same one that rejects a not-yet-pinned template. */
function readTruth(id: string): TruthTemplate {
  const raw = JSON.parse(readFileSync(`${TRUTH_DIR}${id}.truth.json`, 'utf8'));
  return truthTemplateSchema.parse(raw);
}

/** Build a real `ScoreableProposal` by replaying a committed fixture through the
 * PRODUCTION `normalize()` — the exact producer the scorer's consumer contract
 * (`scoreableProposalFromNormalize`) is written against. */
function realProposal(id: string): { proposal: ScoreableProposal; extraction: RawExtraction } {
  const extraction = readFixture(id);
  const norm = normalize(extraction);
  return { proposal: scoreableProposalFromNormalize(norm), extraction };
}

// ---------------------------------------------------------------------------
// deltaE2000 — basic sanity
// ---------------------------------------------------------------------------

describe('deltaE2000', () => {
  it('is 0 for an identical colour', () => {
    expect(deltaE2000('#635bff', '#635bff')).toBe(0);
  });

  it('is symmetric', () => {
    expect(deltaE2000('#635bff', '#ff6600')).toBeCloseTo(deltaE2000('#ff6600', '#635bff'), 6);
  });

  it('is much larger for a clearly different hue-family than a near-identical variant', () => {
    const farApart = deltaE2000('#635bff', '#ff6600');
    const nearIdentical = deltaE2000('#635bff', '#6459fc');
    expect(farApart).toBeGreaterThan(nearIdentical * 10);
  });
});

// ---------------------------------------------------------------------------
// scoreableProposalFromNormalize — the producer/consumer seam
// ---------------------------------------------------------------------------

describe('scoreableProposalFromNormalize', () => {
  it('builds a well-formed proposal from the real stripe fixture via production normalize()', () => {
    const { proposal } = realProposal('stripe');
    expect(HEX_RE.test(proposal.seed), `seed "${proposal.seed}"`).toBe(true);
    expect(HEX_RE.test(proposal.backgroundLight), `backgroundLight "${proposal.backgroundLight}"`).toBe(true);
    expect(HEX_RE.test(proposal.backgroundDark), `backgroundDark "${proposal.backgroundDark}"`).toBe(true);
    expect(proposal.seedCandidates.length).toBeGreaterThan(0);
    // The chosen seed is always the top-ranked candidate (normalize()'s heuristic pick).
    expect(proposal.seed).toBe(proposal.seedCandidates[0]!.hex);
  });
});

// ---------------------------------------------------------------------------
// Metric 1 — accent fidelity, against REAL truth (a hit and a known real miss)
// ---------------------------------------------------------------------------

describe('scoreAccentFidelity — real fixtures vs real pinned truth', () => {
  it('stripe: the real extractor top pick (#533afd) is genuinely close to the pinned accent (#635bff) — PASSES', () => {
    const { proposal } = realProposal('stripe');
    const truth = readTruth('stripe');
    const result = scoreAccentFidelity(proposal, truth.pinned.accent);
    expect(result.deltaE).toBeCloseTo(8.38, 1);
    expect(result.pass).toBe(true);
    expect(result.weight).toBe(1); // pinned confidence "high"
  });

  it('github: the real extractor picked UI action-blue (#8dd6ff), not the true brand green (#0fbf3e) — FAILS (a genuine miss, not a synthetic anchor)', () => {
    const { proposal } = realProposal('github');
    const truth = readTruth('github');
    const result = scoreAccentFidelity(proposal, truth.pinned.accent);
    expect(result.deltaE).toBeGreaterThan(DEFAULT_THRESHOLDS.accentMatch * 2);
    expect(result.pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Metric 2 — top-K coverage (role-informed, over the extractor's own candidates)
// ---------------------------------------------------------------------------

describe('scoreTopKCoverage', () => {
  it('stripe: the pinned accent is found at candidate rank 1 (the picker got it right)', () => {
    const { proposal } = realProposal('stripe');
    const truth = readTruth('stripe');
    const result = scoreTopKCoverage(proposal, truth.pinned.accent);
    expect(result.matched).toBe(true);
    expect(result.matchedRank).toBe(1);
  });

  it('github: the true accent is not recoverable within the DEFAULT top-5 cutoff', () => {
    const { proposal } = realProposal('github');
    const truth = readTruth('github');
    const result = scoreTopKCoverage(proposal, truth.pinned.accent);
    expect(result.matched).toBe(false);
  });

  it('github: WIDENING k finds a real (not synthetic) found-but-wrong-pick case — proves metric 2 genuinely separates "never found" from "found but ranked past the cutoff"', () => {
    // seedCandidates[13] is `#5fed8380`, ΔE2000 12.4 from the pinned accent —
    // inside accentMatch (15), but rank 14 (1-based), well past DEFAULT_TOP_K
    // (5). This is real production candidate-ranking output (selectSeedCandidates
    // on the real github fixture), not a hand-built anchor.
    const { proposal } = realProposal('github');
    const truth = readTruth('github');
    expect(proposal.seedCandidates[13]?.hex).toBe('#5fed8380');

    const widened = scoreTopKCoverage(proposal, truth.pinned.accent, { k: 20 });
    expect(widened.matched).toBe(true);
    expect(widened.matchedRank).toBe(14);
    expect(widened.bestDeltaE).toBeCloseTo(12.39, 1);
  });
});

// ---------------------------------------------------------------------------
// Metric 3 — background fidelity (incl. the symmetric-nullable skip contract)
// ---------------------------------------------------------------------------

describe('scoreBackgroundFidelity', () => {
  it('stripe: the shipped light background (a near-white neutral tint) is close to the pinned pure white', () => {
    const { proposal } = realProposal('stripe');
    const truth = readTruth('stripe');
    const result = scoreBackgroundFidelity(proposal, truth.pinned);
    expect(result.light).not.toBeNull();
    expect(result.light!.pass).toBe(true);
  });

  it('a null pinned side is SKIPPED (returns null), never scored against a synthesized value (imprintgenius pins backgroundDark: null)', () => {
    const { proposal } = realProposal('imprintgenius');
    const truth = readTruth('imprintgenius');
    expect(truth.pinned.backgroundDark).toBeNull(); // sanity on the fixture itself
    const result = scoreBackgroundFidelity(proposal, truth.pinned);
    expect(result.dark).toBeNull();
    expect(result.light).not.toBeNull(); // the non-null side is still scored
  });

  it('github: a REAL non-null backgroundDark is scored — proves the dark side is wired to pinned.backgroundDark, not swapped with light', () => {
    const { proposal } = realProposal('github');
    const truth = readTruth('github');
    expect(truth.pinned.backgroundDark).not.toBeNull(); // sanity: github pins a real dark bg (#0d1117)
    const result = scoreBackgroundFidelity(proposal, truth.pinned);
    expect(result.dark).not.toBeNull();

    // Independently recomputed (not read back from the module under test): a
    // swapped light<->dark argument would NOT reproduce this exact figure.
    const expectedDarkDeltaE = deltaE2000(proposal.backgroundDark, truth.pinned.backgroundDark!.hex);
    expect(result.dark!.deltaE).toBe(expectedDarkDeltaE);
    expect(result.dark!.pass).toBe(true); // github's real dark bg (#0d1117) is a genuine close match

    // And it is NOT the (very different) light<->dark cross-pairing — proposal
    // light is near-white, pinned dark is near-black, so a swap would read huge.
    const crossPairingDeltaE = deltaE2000(proposal.backgroundDark, truth.pinned.backgroundLight!.hex);
    expect(crossPairingDeltaE).toBeGreaterThan(result.dark!.deltaE * 5);
  });
});

// ---------------------------------------------------------------------------
// REQUIRED ANCHOR — white-chrome guard (saturated-top-K anti-gaming check)
// ---------------------------------------------------------------------------

describe('scoreSaturatedTopKCoverage — white-chrome guard (REQUIRED calibration anchor)', () => {
  it('a site whose dominant colours are near-white/near-black chrome does NOT score high on background-as-accent', () => {
    // Synthetic near-neutral-only extraction (by design — a controlled palette
    // no real fixture guarantees). Scored against the REAL stripe pinned accent
    // (a genuinely saturated brand purple), so a real, non-synthetic reference.
    const chromeOnlyColors: RawExtraction['colors'] = [
      { hex: '#ffffff', frequency: 500, roles: [{ role: 'background', count: 500 }] },
      { hex: '#fefefe', frequency: 300, roles: [] },
      { hex: '#f8f8f8', frequency: 200, roles: [] },
      { hex: '#000000', frequency: 150, roles: [{ role: 'text', count: 150 }] },
      { hex: '#1a1a1a', frequency: 80, roles: [] },
    ];
    const truth = readTruth('stripe');
    const result = scoreSaturatedTopKCoverage(chromeOnlyColors, truth.pinned.accent);
    expect(result.saturatedCandidatesConsidered).toBe(0); // every candidate filtered as near-neutral chrome
    expect(result.matched).toBe(false);
    expect(result.bestDeltaE).toBeUndefined();
  });

  it('control: the SAME near-white palette, unfiltered, would trivially be "close" to a near-white pinned bg — proving the guard is about the ACCENT axis specifically, not that ΔE2000 itself is broken', () => {
    // Near-identical whites are indeed close by plain ΔE2000 (this is what a
    // background-fidelity check SHOULD reward) — the guard is specifically that
    // this closeness must never leak into the ACCENT-matching axis.
    expect(deltaE2000('#ffffff', '#fefefe')).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// REQUIRED ANCHOR — garbage anchor (stripe proposal vs Hacker-News orange)
// ---------------------------------------------------------------------------

describe('scoreColorFidelity — garbage anchor (REQUIRED calibration anchor)', () => {
  it('the real stripe proposal scored against a deliberately-wrong Hacker-News-orange reference scores BELOW threshold', () => {
    const { proposal, extraction } = realProposal('stripe');
    const realTruth = readTruth('stripe');
    // Deliberately-wrong reference: Hacker News' signature orange chrome, NOT
    // stripe's real accent. Every other pinned field is left as the real,
    // schema-validated stripe truth (only accent is swapped).
    const garbageTruth: TruthTemplate = {
      ...realTruth,
      pinned: {
        ...realTruth.pinned,
        accent: { hex: '#ff6600', source: 'operator-judgment', confidence: 'high' },
      },
    };

    const result = scoreColorFidelity(proposal, extraction, garbageTruth);

    // The direct signal: the accent metric hard-fails against the garbage anchor.
    expect(result.accent.pass).toBe(false);
    expect(result.accent.deltaE).toBeGreaterThan(50);

    // The instrument is genuinely falsifiable here, not just "some sub-metric
    // failed": stripe's REAL extraction happens to carry a genuine secondary
    // "gradient orange" cluster (#ff6118, real accent-role evidence) that sits
    // ΔE2000 ~2.8 from the Hacker-News anchor — so the role-informed topKCoverage
    // metric ALONE would be fooled into "matching" garbage:
    expect(result.topKCoverage.matched).toBe(true);
    // ...which is exactly why the role-agnostic saturated-top-K anti-gaming
    // cross-check exists and is weighted to dominate it: that cluster's raw
    // frequency (37) is far too low to crack the top-5-by-frequency saturated
    // cut, so the cross-check correctly resists the same "match":
    expect(result.saturatedTopKCoverage.matched).toBe(false);

    // And the composite — accent dominant, anti-gaming cross-check outweighing
    // the gameable one — lands BELOW the pass threshold despite that one
    // spurious sub-match.
    expect(result.score).toBeLessThan(DEFAULT_THRESHOLDS.overallPass);
    expect(result.pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Accent-recovery GATE — review-fix regression (Step 5 code review, HIGH #1)
// ---------------------------------------------------------------------------
//
// A code review + completeness critic replayed all 20 real fixtures and found:
// with the ORIGINAL flat weighted-average composite, nytimes (accent ΔE 34.4,
// both coverage checks failing) still composite-PASSED (score 0.56) purely on
// a background match; kurzgesagt (ΔE 25.8) and github (ΔE 46.4) likewise
// composite-PASSED despite a wrong accent — only linear (54.4) and basecamp
// (61.0) correctly failed. This locks the fix: accent recovery (`accent.pass`
// OR a TIGHT `saturatedTopKCoverage` match, see `recoveryMatch` in the file
// header) is now a NECESSARY condition, so ALL FIVE of these real wrong-accent
// sites must now correctly fail colour fidelity — never rescued by background.

const WRONG_ACCENT_SITES = ['nytimes', 'kurzgesagt', 'github', 'linear', 'basecamp'] as const;

describe.each(WRONG_ACCENT_SITES)(
  'scoreColorFidelity — accent-recovery gate regression: %s',
  (id) => {
    it(`${id}: a wrong real accent is NEVER rescued by background/coverage into a composite PASS`, () => {
      const { proposal, extraction } = realProposal(id);
      const truth = readTruth(id);
      const result = scoreColorFidelity(proposal, extraction, truth);

      expect(result.accent.pass, `${id} accent.pass`).toBe(false);
      expect(result.accentRecovered, `${id} accentRecovered`).toBe(false);
      expect(result.pass, `${id} composite pass`).toBe(false);
      expect(result.score, `${id} score capped`).toBeLessThanOrEqual(DEFAULT_THRESHOLDS.recoveryCapScore);
    });
  },
);

// ---------------------------------------------------------------------------
// Calibration lock — all 12 real v1 sites (review, HIGH #2)
// ---------------------------------------------------------------------------
//
// Locks the documented hit/miss classification + measured ΔE bands so a future
// normalize() regression that nudges a boundary case across `accentMatch` (15)
// shows up as a test failure instead of silently invalidating the calibration.
// Explicitly includes both boundary cases the threshold hinges on: duolingo
// (hit, ΔE ~10.9 — nearest to 15 from below) and kurzgesagt (miss, ΔE ~25.8 —
// nearest from above).

const ACCENT_CALIBRATION: ReadonlyArray<{ id: string; classification: 'hit' | 'miss'; approxDeltaE: number }> = [
  { id: 'forliving', classification: 'hit', approxDeltaE: 0 },
  { id: 'imprintgenius', classification: 'hit', approxDeltaE: 0 },
  { id: 'medium', classification: 'hit', approxDeltaE: 0 },
  { id: 'robinhood', classification: 'hit', approxDeltaE: 0 },
  { id: 'spotify', classification: 'hit', approxDeltaE: 0 },
  { id: 'stripe', classification: 'hit', approxDeltaE: 8.4 },
  { id: 'duolingo', classification: 'hit', approxDeltaE: 10.9 }, // boundary: nearest hit to accentMatch from below
  { id: 'kurzgesagt', classification: 'miss', approxDeltaE: 25.8 }, // boundary: nearest miss to accentMatch from above
  { id: 'nytimes', classification: 'miss', approxDeltaE: 34.3 },
  { id: 'github', classification: 'miss', approxDeltaE: 46.4 },
  { id: 'linear', classification: 'miss', approxDeltaE: 54.4 },
  { id: 'basecamp', classification: 'miss', approxDeltaE: 61.0 },
];

describe('scoreAccentFidelity — calibration lock over all 12 real v1 sites', () => {
  it('covers exactly the 12 real v1 corpus sites (no missing, no orphans)', () => {
    expect(ACCENT_CALIBRATION.map((c) => c.id).sort()).toEqual(
      [
        'basecamp', 'duolingo', 'forliving', 'github', 'imprintgenius', 'kurzgesagt',
        'linear', 'medium', 'nytimes', 'robinhood', 'spotify', 'stripe',
      ].sort(),
    );
  });

  it.each(ACCENT_CALIBRATION)(
    '$id: ΔE ≈ $approxDeltaE, classified as a $classification',
    ({ id, classification, approxDeltaE }) => {
      const { proposal } = realProposal(id);
      const truth = readTruth(id);
      const result = scoreAccentFidelity(proposal, truth.pinned.accent);
      expect(result.deltaE, `${id} deltaE`).toBeCloseTo(approxDeltaE, 0);
      expect(result.pass, `${id} pass`).toBe(classification === 'hit');
    },
  );
});

// ---------------------------------------------------------------------------
// REQUIRED ANCHOR — gold-matched known-good (non-circular)
// ---------------------------------------------------------------------------

describe('scoreColorFidelity — gold-matched known-good (REQUIRED calibration anchor, non-circular)', () => {
  it('a proposal whose seed equals the site\'s independently-sourced PUBLISHED gold-hex scores HIGH', () => {
    const { proposal, extraction } = realProposal('stripe');
    const truth = readTruth('stripe');
    expect(typeof truth.goldHex).toBe('string');

    // NON-CIRCULAR: this hypothetical proposal's seed is set to the truth file's
    // independently-sourced `goldHex` (a human-pinned, published brand-guide
    // value) — NOT the real extraction's own heuristic guess (#533afd, a
    // DIFFERENT value from goldHex/pinned.accent). Scoring "proposal vs its own
    // extraction" would be a guaranteed, meaningless pass; this deliberately
    // does not do that.
    const goldProposal: ScoreableProposal = { ...proposal, seed: truth.goldHex! };
    expect(goldProposal.seed).not.toBe(proposal.seed); // proves it's NOT the extraction's own guess

    const result = scoreColorFidelity(goldProposal, extraction, truth);
    expect(result.accent.deltaE).toBe(0);
    expect(result.accent.pass).toBe(true);
    expect(result.score).toBeGreaterThan(0.85);
    expect(result.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A real "everything passes" sanity check (both directions must be provable)
// ---------------------------------------------------------------------------

describe('scoreColorFidelity — real match scores high (the positive complement to the garbage anchor)', () => {
  it('the real stripe proposal scored against its OWN real pinned truth scores well above the pass threshold', () => {
    const { proposal, extraction } = realProposal('stripe');
    const truth = readTruth('stripe');
    const result = scoreColorFidelity(proposal, extraction, truth);
    expect(result.score).toBeGreaterThan(DEFAULT_THRESHOLDS.overallPass);
    expect(result.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Confidence down-weighting (plan §6)
// ---------------------------------------------------------------------------

describe('CONFIDENCE_WEIGHT', () => {
  it('down-weights low/medium confidence relative to high', () => {
    expect(CONFIDENCE_WEIGHT.high).toBe(1);
    expect(CONFIDENCE_WEIGHT.medium).toBeLessThan(CONFIDENCE_WEIGHT.high);
    expect(CONFIDENCE_WEIGHT.low).toBeLessThan(CONFIDENCE_WEIGHT.medium);
  });

  it('a medium-confidence pinned accent carries a lower weight than a high-confidence one (kurzgesagt is pinned medium)', () => {
    const truth = readTruth('kurzgesagt');
    expect(truth.pinned.accent.confidence).toBe('medium');
    const { proposal } = realProposal('kurzgesagt');
    const result = scoreAccentFidelity(proposal, truth.pinned.accent);
    expect(result.weight).toBe(CONFIDENCE_WEIGHT.medium);
    expect(result.weight).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// Metric 5 — CVD-sim sub-check (its own a11y axis; never folded into fidelity)
// ---------------------------------------------------------------------------

describe('scoreCvdAxis', () => {
  it('is a SEPARATE result shape from scoreColorFidelity (a11y is never folded into the fidelity score); covers BOTH light and dark surfaces (3 types x 2 surfaces = 6 checks)', () => {
    const { proposal } = realProposal('stripe');
    const cvd = scoreCvdAxis(proposal);
    expect(cvd.checks).toHaveLength(6);
    expect(new Set(cvd.checks.map((c) => c.type))).toEqual(new Set(['deuteranopia', 'protanopia', 'tritanopia']));
    expect(new Set(cvd.checks.map((c) => c.surface))).toEqual(new Set(['light', 'dark']));
    // Every type appears against both surfaces exactly once.
    for (const type of ['protanopia', 'deuteranopia', 'tritanopia'] as const) {
      expect(cvd.checks.filter((c) => c.type === type)).toHaveLength(2);
    }
  });

  it("stripe's saturated purple accent stays distinguishable from its near-white background under every simulated deficiency", () => {
    const { proposal } = realProposal('stripe');
    const cvd = scoreCvdAxis(proposal);
    expect(cvd.allDistinguishable).toBe(true);
    for (const check of cvd.checks) {
      expect(check.deltaE, `${check.type}/${check.surface}`).toBeGreaterThan(DEFAULT_THRESHOLDS.cvdDistinguishable);
    }
  });

  it('a dark-first brand (spotify) gets its DARK surface genuinely checked too, not just light', () => {
    const { proposal } = realProposal('spotify');
    const cvd = scoreCvdAxis(proposal);
    const darkChecks = cvd.checks.filter((c) => c.surface === 'dark');
    const lightChecks = cvd.checks.filter((c) => c.surface === 'light');
    expect(darkChecks).toHaveLength(3);
    expect(lightChecks).toHaveLength(3);
    // The two surfaces are genuinely different backgrounds, so (for a real
    // proposal, not a degenerate one) their simulated ΔE readings differ —
    // proving the dark surface isn't just a duplicate of the light one.
    expect(proposal.backgroundLight).not.toBe(proposal.backgroundDark);
    const anyDiffer = darkChecks.some((d, i) => d.deltaE !== lightChecks[i]!.deltaE);
    expect(anyDiffer).toBe(true);
  });

  it('CVD simulation collapses a red/green pairing far more than a blue/yellow pairing (protanopia/deuteranopia are red-green deficiencies) — proves the sim is not a no-op', () => {
    const rawRedGreen = deltaE2000('#ff0000', '#00ff00');
    const rawBlueYellow = deltaE2000('#0000ff', '#ffff00');

    // Reuse the module's proposal shape as a vehicle for two synthetic swatches
    // (this checks the SIMULATION mechanism itself, not a real site's palette).
    const redGreenProposal: ScoreableProposal = {
      seed: '#ff0000',
      seedCandidates: [],
      backgroundLight: '#00ff00',
      backgroundDark: '#00ff00',
    };
    const blueYellowProposal: ScoreableProposal = {
      seed: '#0000ff',
      seedCandidates: [],
      backgroundLight: '#ffff00',
      backgroundDark: '#ffff00',
    };

    const redGreen = scoreCvdAxis(redGreenProposal);
    const blueYellow = scoreCvdAxis(blueYellowProposal);

    const redGreenProtan = redGreen.checks.find((c) => c.type === 'protanopia')!;
    const blueYellowProtan = blueYellow.checks.find((c) => c.type === 'protanopia')!;

    // Simulation must actually change something (not an identity transform).
    expect(redGreenProtan.deltaE).toBeLessThan(rawRedGreen);
    // And the red-green pairing must lose far more separation than blue-yellow
    // under a red-green deficiency — the whole point of simulating per-type.
    const redGreenLossFraction = 1 - redGreenProtan.deltaE / rawRedGreen;
    const blueYellowLossFraction = 1 - blueYellowProtan.deltaE / rawBlueYellow;
    expect(redGreenLossFraction).toBeGreaterThan(blueYellowLossFraction);
  });
});
