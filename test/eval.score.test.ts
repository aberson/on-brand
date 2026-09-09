/**
 * Brand-Fidelity Step 10 (#39) — unit tests for `src/eval/score.ts`'s suite
 * rollup: czg-control weighting, a11y-as-its-own-axis, slider-coverage +
 * weak-region math, and the #25/#26/#27 finding mechanisms, over small
 * hand-built `CorpusFidelityEntry` fixtures (fast, isolated — the REAL full
 * v1 corpus + anti-hardcode mutation proof lives in
 * `test/eval.corpus-runner.e2e.test.ts`, which is the acceptance-grade test;
 * this file exercises edge cases the real corpus doesn't happen to hit, e.g.
 * an exactly-empty slider bucket, the EXACT_MATCH_EPSILON boundary, and a
 * majority-just-under-threshold categorical-sameness case).
 */

import { describe, expect, it } from 'vitest';
import { loadCorpus, type CorpusEntry, type SliderCoords } from '../benchmark/corpus.ts';
import type { TruthTemplate } from '../benchmark/truth-scaffold.ts';
import type { ColorFidelityResult } from '../src/eval/color-fidelity.ts';
import type { FontFidelityResult } from '../src/eval/font-fidelity.ts';
import type { CvdAxisResult } from '../src/eval/color-fidelity.ts';
import type { FidelityResult } from '../src/eval/score.ts';
import {
  backgroundMismatchSeverity,
  buildPunchList,
  buildSuiteRollup,
  CATEGORICAL_SAMENESS_THRESHOLD,
  crossCheckIssue25,
  CZG_CONTROL_WEIGHT,
  findAccentRecoveryFailures,
  findCategoricalSameness,
  findMaterialBackgroundMismatches,
  findSliderWeakRegions,
  HIGH_SEVERITY_RATIO,
  REAL_SITE_WEIGHT,
  siteWeight,
  sliderBucketOf,
  summarizeA11y,
  summarizeBackgroundExactMatches,
  summarizeFidelity,
  summarizeSliderCoverage,
  WEAK_REGION_MIN_WEIGHT,
  WEAK_REGION_PASS_RATE,
  type CorpusFidelityEntry,
} from '../src/eval/score.ts';

// ---------------------------------------------------------------------------
// Fixture factories (minimal but type-valid; not schema-parsed — these are
// pure-function unit tests, not replaying the real pipeline).
// ---------------------------------------------------------------------------

const DEFAULT_SLIDER: SliderCoords = {
  warmth: 0.5,
  saturation: 0.5,
  lightness: 0.5,
  contrast: 0.5,
  hueDiversity: 0.5,
  accentDominance: 0.5,
  neutralRatio: 0.5,
  vibrancy: 0.5,
};

const SHARED_CATEGORICAL = ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777'];

function makeEntry(id: string, overrides: Partial<CorpusEntry> = {}): CorpusEntry {
  return {
    id,
    url: `https://${id}.example.com`,
    archetype: 'saas',
    sliderCoords: { ...DEFAULT_SLIDER, ...(overrides.sliderCoords ?? {}) },
    isControl: false,
    tier: 'v1',
    heldOut: false,
    ...overrides,
  };
}

type TruthOverrides = Partial<Omit<TruthTemplate, 'pinned'>> & { pinned?: Partial<TruthTemplate['pinned']> };

function makeTruth(id: string, overrides: TruthOverrides = {}): TruthTemplate {
  const base: TruthTemplate = {
    id,
    url: `https://${id}.example.com`,
    archetype: 'saas',
    sliderTags: DEFAULT_SLIDER,
    isControl: false,
    isMultiAccent: false,
    extractorGuess: {
      accent: { hex: '#123456', evidenceCount: 1, source: 'accent-role' },
      backgroundLight: { hex: '#ffffff', frequency: 1, lightness: 1 },
      backgroundDark: null,
      topClusters: [],
    },
    pinned: {
      accent: { hex: '#123456', source: 'official-brand-guide', confidence: 'high' },
      backgroundLight: { hex: '#ffffff', source: 'official-site-css', confidence: 'high' },
      backgroundDark: { hex: '#0d1117', source: 'official-site-css', confidence: 'high' },
      fonts: { heading: null, body: null, mono: null },
      secondaryAccents: [],
    },
    goldHex: '#123456',
    status: 'pinned',
    notes: '',
    _generated: {
      scaffolder: 'test',
      corpusId: id,
      fromFixture: `docs/findings/eval-raw-extractions/benchmark/${id}.raw-extraction.json`,
      note: '',
    },
  };
  return { ...base, ...overrides, pinned: { ...base.pinned, ...(overrides.pinned ?? {}) } };
}

function makeColorResult(overrides: Partial<ColorFidelityResult> = {}): ColorFidelityResult {
  return {
    accent: { deltaE: 0, pass: true, weight: 1, similarity: 1 },
    topKCoverage: { k: 5, candidatesConsidered: 1, matched: true, bestDeltaE: 0, matchedRank: 1 },
    saturatedTopKCoverage: { k: 5, saturatedCandidatesConsidered: 1, matched: true, bestDeltaE: 0 },
    background: {
      light: { deltaE: 0, pass: true, weight: 1 },
      dark: { deltaE: 0, pass: true, weight: 1 },
    },
    accentRecovered: true,
    score: 1,
    pass: true,
    ...overrides,
  };
}

function makeFontResult(overrides: Partial<FontFidelityResult> = {}): FontFidelityResult {
  return {
    heading: null,
    body: null,
    mono: null,
    scoredRoles: [],
    silentlyWrongRoles: [],
    pass: true,
    ...overrides,
  };
}

function makeCvdResult(overrides: Partial<CvdAxisResult> = {}): CvdAxisResult {
  return { checks: [], allDistinguishable: true, ...overrides };
}

function makeFidelity(siteId: string, overrides: Partial<FidelityResult> = {}): FidelityResult {
  const color = overrides.color ?? makeColorResult();
  const font = overrides.font ?? makeFontResult();
  return {
    siteId,
    color,
    font,
    cvd: overrides.cvd ?? makeCvdResult(),
    pass: overrides.pass ?? (color.pass && font.pass),
  };
}

function makeSite(
  id: string,
  overrides: {
    entry?: Partial<CorpusEntry>;
    truth?: TruthOverrides;
    fidelity?: Partial<FidelityResult>;
    categoricalSecondary?: readonly string[];
    shippedSeed?: string;
    shippedBackground?: { light: string; dark: string };
  } = {},
): CorpusFidelityEntry {
  const entry = makeEntry(id, overrides.entry);
  const truth = makeTruth(id, { ...overrides.truth, isControl: entry.isControl });
  return {
    entry,
    truth,
    fidelity: makeFidelity(id, overrides.fidelity),
    shippedBackground: overrides.shippedBackground ?? { light: '#ffffff', dark: '#0d1117' },
    shippedSeed: overrides.shippedSeed ?? '#123456',
    categoricalSecondary: overrides.categoricalSecondary ?? SHARED_CATEGORICAL,
  };
}

// ---------------------------------------------------------------------------
// czg weighting
// ---------------------------------------------------------------------------

describe('siteWeight — czg controls weighted <0.5x (plan §6)', () => {
  it('CZG_CONTROL_WEIGHT is strictly less than 0.5', () => {
    expect(CZG_CONTROL_WEIGHT).toBeLessThan(0.5);
  });

  it('a real site gets REAL_SITE_WEIGHT (1); a control gets CZG_CONTROL_WEIGHT', () => {
    expect(siteWeight({ isControl: false })).toBe(REAL_SITE_WEIGHT);
    expect(siteWeight({ isControl: true })).toBe(CZG_CONTROL_WEIGHT);
  });
});

describe('summarizeFidelity — weighted rollup', () => {
  it('weights a failing control at CZG_CONTROL_WEIGHT, not REAL_SITE_WEIGHT, in the weighted pass rate', () => {
    const passingReal = makeSite('real-pass', { fidelity: { pass: true } });
    const failingControl = makeSite('control-fail', {
      entry: { isControl: true },
      fidelity: { pass: false },
    });
    const summary = summarizeFidelity([passingReal, failingControl]);
    // weightedTotal = 1 (real) + 0.4 (control) = 1.4; weightedPassed = 1 (only the real site passed).
    expect(summary.weightedTotal).toBeCloseTo(1 + CZG_CONTROL_WEIGHT, 10);
    expect(summary.weightedPassed).toBeCloseTo(1, 10);
    expect(summary.weightedPassRate).toBeCloseTo(1 / (1 + CZG_CONTROL_WEIGHT), 10);
    expect(summary.real).toEqual({ total: 1, passed: 1 });
    expect(summary.control).toEqual({ total: 1, passed: 0 });
  });

  it('an empty site list reports 0, never NaN', () => {
    const summary = summarizeFidelity([]);
    expect(summary.weightedPassRate).toBe(0);
    expect(summary.weightedMeanColorScore).toBe(0);
    expect(Number.isNaN(summary.weightedPassRate)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// a11y — its own axis
// ---------------------------------------------------------------------------

describe('summarizeA11y — never derived from fidelity.pass', () => {
  it('counts a site as a11y-failing purely from cvd.allDistinguishable, even when fidelity.pass is true', () => {
    const site = makeSite('site-a', {
      fidelity: { pass: true, cvd: makeCvdResult({ allDistinguishable: false }) },
    });
    const summary = summarizeA11y([site]);
    expect(summary.failingSiteIds).toEqual(['site-a']);
    expect(summary.distinguishableCount).toBe(0);
  });

  it('counts a site as a11y-passing even when fidelity.pass is false (colour/font failed, CVD did not)', () => {
    const site = makeSite('site-b', {
      fidelity: { pass: false, cvd: makeCvdResult({ allDistinguishable: true }) },
    });
    const summary = summarizeA11y([site]);
    expect(summary.failingSiteIds).toEqual([]);
    expect(summary.distinguishableRate).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// slider-coverage + weak regions
// ---------------------------------------------------------------------------

describe('sliderBucketOf — tercile boundaries', () => {
  it.each([
    [0, 'low'],
    [0.32, 'low'],
    [1 / 3, 'mid'],
    [0.5, 'mid'],
    [2 / 3 - 1e-9, 'mid'],
    [2 / 3, 'high'],
    [1, 'high'],
  ] as const)('%f -> %s', (value, expected) => {
    expect(sliderBucketOf(value)).toBe(expected);
  });
});

describe('summarizeSliderCoverage + findSliderWeakRegions', () => {
  it('keys the bucket pass rate on color.pass, not the composite pass (font never enters palette-space coverage)', () => {
    // A site with color.pass true but composite pass false (font failed) should
    // still count as a PASS for slider-coverage purposes.
    const site = makeSite('warm-site', {
      entry: { sliderCoords: { ...DEFAULT_SLIDER, warmth: 0.9 } },
      fidelity: { pass: false, color: makeColorResult({ pass: true }), font: makeFontResult({ pass: false }) },
    });
    const stats = summarizeSliderCoverage([site]);
    const warmHigh = stats.find((s) => s.axis === 'warmth' && s.bucket === 'high');
    expect(warmHigh?.weightedPassRate).toBe(1);
  });

  it('flags a bucket as a weak region when its weighted pass rate is below the bar with enough weighted evidence', () => {
    const failing1 = makeSite('cool-1', {
      entry: { sliderCoords: { ...DEFAULT_SLIDER, warmth: 0.1 } },
      fidelity: { color: makeColorResult({ pass: false }) },
    });
    const failing2 = makeSite('cool-2', {
      entry: { sliderCoords: { ...DEFAULT_SLIDER, warmth: 0.05 } },
      fidelity: { color: makeColorResult({ pass: false }) },
    });
    const stats = summarizeSliderCoverage([failing1, failing2]);
    const weak = findSliderWeakRegions(stats);
    const warmthLow = weak.find((w) => w.id === 'warmth:low');
    expect(warmthLow).toBeDefined();
    expect(warmthLow?.weightedPassRate).toBeLessThan(WEAK_REGION_PASS_RATE);
    expect(warmthLow?.siteIds.sort()).toEqual(['cool-1', 'cool-2']);
  });

  it('an empty bucket (0 sites) is never reported as a weak region', () => {
    const site = makeSite('only-site', { entry: { sliderCoords: { ...DEFAULT_SLIDER, warmth: 0.9 } } });
    const stats = summarizeSliderCoverage([site]);
    const weak = findSliderWeakRegions(stats);
    expect(weak.some((w) => w.id === 'warmth:low')).toBe(false);
  });

  describe('WEAK_REGION_MIN_WEIGHT boundary (review finding #8)', () => {
    it('a LONE REAL site (weight 1, at the WEAK_REGION_MIN_WEIGHT=1 boundary) failing 0% IS flagged', () => {
      expect(REAL_SITE_WEIGHT).toBe(WEAK_REGION_MIN_WEIGHT); // pin the boundary assumption this test relies on
      const site = makeSite('lone-real-fail', {
        entry: { isControl: false, sliderCoords: { ...DEFAULT_SLIDER, warmth: 0.1 } },
        fidelity: { color: makeColorResult({ pass: false }) },
      });
      const weak = findSliderWeakRegions(summarizeSliderCoverage([site]));
      const warmthLow = weak.find((w) => w.id === 'warmth:low');
      expect(warmthLow).toBeDefined();
      expect(warmthLow?.weightedPassRate).toBe(0);
    });

    it('a LONE CONTROL site (weight 0.4, BELOW the boundary) failing 0% is NOT flagged (insufficient weighted evidence)', () => {
      expect(CZG_CONTROL_WEIGHT).toBeLessThan(WEAK_REGION_MIN_WEIGHT);
      const control = makeSite('lone-control-fail', {
        entry: { isControl: true, sliderCoords: { ...DEFAULT_SLIDER, warmth: 0.1 } },
        fidelity: { color: makeColorResult({ pass: false }) },
        truth: { isControl: true },
      });
      const weak = findSliderWeakRegions(summarizeSliderCoverage([control]));
      expect(weak.some((w) => w.id === 'warmth:low')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// #25 — background non-exact matches
// ---------------------------------------------------------------------------

describe('findMaterialBackgroundMismatches (#25 mechanism, DISCRIMINATING — review fix)', () => {
  it('flags a real site whose shipped dark background FAILS the calibrated backgroundMatch gate (a MATERIAL mismatch)', () => {
    const site = makeSite('mismatch-site', {
      fidelity: {
        color: makeColorResult({
          background: { light: { deltaE: 0, pass: true, weight: 1 }, dark: { deltaE: 16.7, pass: false, weight: 1 } },
        }),
      },
      shippedBackground: { light: '#ffffff', dark: '#161816' },
      truth: { pinned: { backgroundDark: { hex: '#4b4b4b', source: 'official-site-css', confidence: 'high' } } },
    });
    const mismatches = findMaterialBackgroundMismatches([site]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ siteId: 'mismatch-site', side: 'dark', pinnedHex: '#4b4b4b', shippedHex: '#161816' });
    expect(mismatches[0]?.severity).toBe('high'); // 16.7/10 = 1.67x >= HIGH_SEVERITY_RATIO
  });

  it('does NOT flag a side that PASSES the gate, even with a nonzero ΔE (the whole point of the discriminating fix)', () => {
    const site = makeSite('close-but-passing-site', {
      fidelity: {
        color: makeColorResult({
          background: { light: { deltaE: 1.8, pass: true, weight: 1 }, dark: { deltaE: 2.7, pass: true, weight: 1 } },
        }),
      },
    });
    expect(findMaterialBackgroundMismatches([site])).toEqual([]);
  });

  it('does NOT flag a site whose shipped background is an EXACT (ΔE 0) reproduction', () => {
    const site = makeSite('exact-site', {
      fidelity: {
        color: makeColorResult({
          background: { light: { deltaE: 0, pass: true, weight: 1 }, dark: { deltaE: 0, pass: true, weight: 1 } },
        }),
      },
    });
    expect(findMaterialBackgroundMismatches([site])).toEqual([]);
  });

  it('sorts worst-first by ΔE (a genuine priority order, not manifest/insertion order)', () => {
    const mild = makeSite('mild', {
      fidelity: { color: makeColorResult({ background: { light: null, dark: { deltaE: 11, pass: false, weight: 1 } } }) },
      truth: { pinned: { backgroundLight: null, backgroundDark: { hex: '#000000', source: 'official-site-css', confidence: 'high' } } },
    });
    const severe = makeSite('severe', {
      fidelity: { color: makeColorResult({ background: { light: null, dark: { deltaE: 40, pass: false, weight: 1 } } }) },
      truth: { pinned: { backgroundLight: null, backgroundDark: { hex: '#000000', source: 'official-site-css', confidence: 'high' } } },
    });
    const mismatches = findMaterialBackgroundMismatches([mild, severe]);
    expect(mismatches.map((m) => m.siteId)).toEqual(['severe', 'mild']);
    expect(mismatches[0]?.severity).toBe('high');
    expect(mismatches[1]?.severity).toBe('medium'); // 11/10 = 1.1x < HIGH_SEVERITY_RATIO (1.5)
  });

  it('excludes czg controls even when their background fails the gate (real-site framing only)', () => {
    const control = makeSite('czg-control', {
      entry: { isControl: true },
      fidelity: {
        color: makeColorResult({
          background: { light: { deltaE: 90, pass: false, weight: 1 }, dark: null },
        }),
      },
      truth: { isControl: true, pinned: { backgroundLight: { hex: '#ffffff', source: 'scaffold-guess', confidence: 'low' } } },
    });
    expect(findMaterialBackgroundMismatches([control])).toEqual([]);
  });

  it('skips a side whose pinned truth is null (symmetric-nullable, mirrors color-fidelity.ts)', () => {
    const site = makeSite('null-dark-truth', {
      fidelity: {
        color: makeColorResult({
          background: { light: { deltaE: 30, pass: false, weight: 1 }, dark: null },
        }),
      },
      truth: { pinned: { backgroundDark: null } },
    });
    const mismatches = findMaterialBackgroundMismatches([site]);
    expect(mismatches.every((m) => m.side !== 'dark')).toBe(true);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.side).toBe('light');
  });

  it('is genuinely selective on a realistic mixed corpus: only the failing sides appear (proving signal, not noise)', () => {
    const passing = makeSite('passing-site', {
      fidelity: { color: makeColorResult({ background: { light: { deltaE: 2, pass: true, weight: 1 }, dark: { deltaE: 4, pass: true, weight: 1 } } }) },
    });
    const failing = makeSite('failing-site', {
      fidelity: { color: makeColorResult({ background: { light: { deltaE: 2, pass: true, weight: 1 }, dark: { deltaE: 14, pass: false, weight: 1 } } }) },
    });
    const mismatches = findMaterialBackgroundMismatches([passing, failing]);
    // 4 real-site background SIDES total (2 sites x 2 sides); only 1 is material.
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.siteId).toBe('failing-site');
  });
});

describe('backgroundMismatchSeverity', () => {
  it('HIGH_SEVERITY_RATIO is > 1 (every entry in the list already failed the gate, so ratio is always > 1)', () => {
    expect(HIGH_SEVERITY_RATIO).toBeGreaterThan(1);
  });

  it('a ratio at/above HIGH_SEVERITY_RATIO is "high"; below it is "medium"', () => {
    expect(backgroundMismatchSeverity(HIGH_SEVERITY_RATIO)).toBe('high');
    expect(backgroundMismatchSeverity(HIGH_SEVERITY_RATIO + 0.01)).toBe('high');
    expect(backgroundMismatchSeverity(1.01)).toBe('medium');
  });
});

describe('crossCheckIssue25 + crossCheckBackgroundFinding — the #25 face-validity cross-check', () => {
  it('reports flaggedAsMaterial: false when the current instrument finds the named site/side within the pass gate (a genuine, honest disagreement with the historical claim)', () => {
    const github = makeSite('github', {
      fidelity: { color: makeColorResult({ background: { light: null, dark: { deltaE: 2.7, pass: true, weight: 1 } } }) },
      shippedBackground: { light: '#ffffff', dark: '#151719' },
      truth: { pinned: { backgroundLight: null, backgroundDark: { hex: '#0d1117', source: 'official-site-css', confidence: 'high' } } },
    });
    const cross = crossCheckIssue25([github]);
    expect(cross).toMatchObject({ siteId: 'github', side: 'dark', deltaE: 2.7, flaggedAsMaterial: false, pinnedHex: '#0d1117', shippedHex: '#151719' });
  });

  it('reports flaggedAsMaterial: true when the named site genuinely fails the gate', () => {
    const github = makeSite('github', {
      fidelity: { color: makeColorResult({ background: { light: null, dark: { deltaE: 25, pass: false, weight: 1 } } }) },
      truth: { pinned: { backgroundLight: null, backgroundDark: { hex: '#0d1117', source: 'official-site-css', confidence: 'high' } } },
    });
    const cross = crossCheckIssue25([github]);
    expect(cross?.flaggedAsMaterial).toBe(true);
  });

  it('returns null when the named site is absent from the scored set', () => {
    expect(crossCheckIssue25([])).toBeNull();
  });

  it('returns null when the named site/side has no pinned truth (nothing to cross-check)', () => {
    const github = makeSite('github', { truth: { pinned: { backgroundDark: null } } });
    expect(crossCheckIssue25([github])).toBeNull();
  });
});

describe('summarizeBackgroundExactMatches — informational only, never itself a finding', () => {
  it('counts exact (ΔE ~0) sides separately from material mismatches', () => {
    const exact = makeSite('exact-site', {
      fidelity: { color: makeColorResult({ background: { light: { deltaE: 0, pass: true, weight: 1 }, dark: { deltaE: 0, pass: true, weight: 1 } } }) },
    });
    const approx = makeSite('approx-site', {
      fidelity: { color: makeColorResult({ background: { light: { deltaE: 2, pass: true, weight: 1 }, dark: { deltaE: 2, pass: true, weight: 1 } } }) },
    });
    const stats = summarizeBackgroundExactMatches([exact, approx]);
    expect(stats.sidesChecked).toBe(4);
    expect(stats.exactCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// #27 — accent-recovery failures
// ---------------------------------------------------------------------------

describe('findAccentRecoveryFailures (#27 mechanism)', () => {
  it('flags a real site whose colour-fidelity accentRecovered is false', () => {
    const site = makeSite('wrong-accent', {
      fidelity: { color: makeColorResult({ accentRecovered: false, accent: { deltaE: 40, pass: false, weight: 1, similarity: 0.2 } }) },
      shippedSeed: '#8dd6ff',
      truth: { pinned: { accent: { hex: '#0fbf3e', source: 'official-brand-guide', confidence: 'high' } } },
    });
    const failures = findAccentRecoveryFailures([site]);
    expect(failures).toEqual([
      { siteId: 'wrong-accent', deltaE: 40, pinnedAccentHex: '#0fbf3e', shippedSeedHex: '#8dd6ff' },
    ]);
  });

  it('does not flag a site whose accent WAS recovered', () => {
    const site = makeSite('right-accent', { fidelity: { color: makeColorResult({ accentRecovered: true }) } });
    expect(findAccentRecoveryFailures([site])).toEqual([]);
  });

  it('excludes czg controls even when their (scaffolded) accent trivially fails recovery', () => {
    const control = makeSite('czg-control-2', {
      entry: { isControl: true },
      fidelity: { color: makeColorResult({ accentRecovered: false }) },
      truth: { isControl: true },
    });
    expect(findAccentRecoveryFailures([control])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #26 — categorical sameness (purely structural)
// ---------------------------------------------------------------------------

describe('findCategoricalSameness (#26 mechanism)', () => {
  it('detects sameness when every site shares the identical categorical tail', () => {
    const sites = ['a', 'b', 'c'].map((id) => makeSite(id, { categoricalSecondary: SHARED_CATEGORICAL }));
    const result = findCategoricalSameness(sites);
    expect(result.detected).toBe(true);
    expect(result.matchFraction).toBe(1);
    expect(result.matchingSiteIds.sort()).toEqual(['a', 'b', 'c']);
    expect(result.differingSiteIds).toEqual([]);
    expect(result.sharedPalette).toEqual(SHARED_CATEGORICAL);
  });

  it('excludes a site whose categorical tail genuinely differs from the majority', () => {
    const differing = ['#a', '#b', '#c', '#d', '#e', '#f', '#g'];
    const sites = [
      makeSite('a', { categoricalSecondary: SHARED_CATEGORICAL }),
      makeSite('b', { categoricalSecondary: SHARED_CATEGORICAL }),
      makeSite('c', { categoricalSecondary: SHARED_CATEGORICAL }),
      makeSite('d', { categoricalSecondary: differing }),
    ];
    const result = findCategoricalSameness(sites);
    expect(result.matchingSiteIds.sort()).toEqual(['a', 'b', 'c']);
    expect(result.differingSiteIds).toEqual(['d']);
    expect(result.matchFraction).toBeCloseTo(0.75, 10);
  });

  it('does not `detect` when the majority fraction falls below CATEGORICAL_SAMENESS_THRESHOLD', () => {
    expect(CATEGORICAL_SAMENESS_THRESHOLD).toBeGreaterThan(0.5);
    const sites = [
      makeSite('a', { categoricalSecondary: SHARED_CATEGORICAL }),
      makeSite('b', { categoricalSecondary: ['x1'] }),
      makeSite('c', { categoricalSecondary: ['x2'] }),
    ];
    const result = findCategoricalSameness(sites);
    expect(result.matchFraction).toBeLessThan(CATEGORICAL_SAMENESS_THRESHOLD);
    expect(result.detected).toBe(false);
    expect(result.sharedPalette).toBeNull();
  });

  it('an empty site list is not detected (never throws)', () => {
    const result = findCategoricalSameness([]);
    expect(result.detected).toBe(false);
    expect(result.matchFraction).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// punch list + top-level buildSuiteRollup wiring
// ---------------------------------------------------------------------------

describe('buildPunchList', () => {
  it('includes an accent-recovery item only when there are failures, with evidence citing the real hexes', () => {
    const empty = buildPunchList({
      fidelity: summarizeFidelity([]),
      a11y: summarizeA11y([]),
      sliderWeakRegions: [],
      materialBackgroundMismatches: [],
      accentRecoveryFailures: [],
      categoricalSameness: findCategoricalSameness([]),
    });
    expect(empty.find((i) => i.id === 'accent-recovery')).toBeUndefined();

    const withFailure = buildPunchList({
      fidelity: summarizeFidelity([]),
      a11y: summarizeA11y([]),
      sliderWeakRegions: [],
      materialBackgroundMismatches: [],
      accentRecoveryFailures: [{ siteId: 'x', deltaE: 40, pinnedAccentHex: '#000000', shippedSeedHex: '#ffffff' }],
      categoricalSameness: findCategoricalSameness([]),
    });
    const item = withFailure.find((i) => i.id === 'accent-recovery');
    expect(item?.severity).toBe('high');
    expect(item?.evidence).toContain('#000000');
    expect(item?.evidence).toContain('#ffffff');
  });

  it('sorts the returned list high -> medium -> low (review finding #6: an a11y "medium" item was rendering AFTER "low" weak-region items in insertion order)', () => {
    const items = buildPunchList({
      fidelity: summarizeFidelity([]),
      a11y: { sitesChecked: 1, distinguishableCount: 0, distinguishableRate: 0, failingSiteIds: ['a11y-site'] }, // medium
      sliderWeakRegions: [
        { id: 'warmth:low', kind: 'slider', axis: 'warmth', bucket: 'low', siteIds: ['x'], weightedPassRate: 0, description: 'warmth low' },
      ], // low
      materialBackgroundMismatches: [],
      accentRecoveryFailures: [{ siteId: 'y', deltaE: 40, pinnedAccentHex: '#000', shippedSeedHex: '#fff' }], // high
      categoricalSameness: findCategoricalSameness([]),
    });
    expect(items.map((i) => i.severity)).toEqual(['high', 'medium', 'low']);
  });
});

describe('buildSuiteRollup — end-to-end wiring over hand-built sites', () => {
  it('assembles every sub-rollup consistently', () => {
    const sites = [
      makeSite('real-1', { categoricalSecondary: SHARED_CATEGORICAL }),
      makeSite('control-1', { entry: { isControl: true }, categoricalSecondary: SHARED_CATEGORICAL, truth: { isControl: true } }),
    ];
    const rollup = buildSuiteRollup(sites);
    expect(rollup.fidelity.sitesScored).toBe(2);
    expect(rollup.a11y.sitesChecked).toBe(2);
    expect(rollup.sliderCoverage).toHaveLength(24); // 8 axes x 3 buckets
    expect(rollup.categoricalSameness.detected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Monet structural-exclusion sanity (against the REAL corpus manifest)
// ---------------------------------------------------------------------------

describe('Monet mood-anchor presets cannot enter the fidelity rollup (structural exclusion)', () => {
  it('the real corpus manifest contains zero entries referencing any monet-* preset', () => {
    const entries = loadCorpus().entries;
    for (const entry of entries) {
      expect(entry.id.toLowerCase()).not.toContain('monet');
      expect(entry.url.toLowerCase()).not.toContain('monet');
    }
  });
});
