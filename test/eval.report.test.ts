/**
 * Brand-Fidelity Step 10 (#39) — unit tests for `src/eval/report.ts`'s
 * `generateReport`: a PURE function of a hand-built `ReportInput`, no I/O, no
 * network, no wall-clock. These tests exercise the rendering contract
 * directly (every section present, mood degrade rendering, refresh-mode
 * drift section) over small synthetic rollups; the real-corpus / real-score
 * acceptance proof lives in `test/eval.corpus-runner.e2e.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import type { CorpusEntry, SliderCoords } from '../benchmark/corpus.ts';
import type { TruthTemplate } from '../benchmark/truth-scaffold.ts';
import type { FidelityResult } from '../src/eval/score.ts';
import {
  buildSuiteRollup,
  type CorpusFidelityEntry,
} from '../src/eval/score.ts';
import { generateReport, type MoodSuiteResult, type ReportInput } from '../src/eval/report.ts';

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

function makeEntry(id: string, overrides: Partial<CorpusEntry> = {}): CorpusEntry {
  return {
    id,
    url: `https://${id}.example.com`,
    archetype: 'saas',
    sliderCoords: DEFAULT_SLIDER,
    isControl: false,
    tier: 'v1',
    heldOut: false,
    ...overrides,
  };
}

function makeTruth(id: string): TruthTemplate {
  return {
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
      backgroundDark: null,
      fonts: { heading: null, body: null, mono: null },
      secondaryAccents: [],
    },
    goldHex: '#123456',
    status: 'pinned',
    notes: '',
    _generated: { scaffolder: 'test', corpusId: id, fromFixture: '', note: '' },
  };
}

function makeFidelity(siteId: string, pass = true): FidelityResult {
  return {
    siteId,
    color: {
      accent: { deltaE: 0, pass: true, weight: 1, similarity: 1 },
      topKCoverage: { k: 5, candidatesConsidered: 1, matched: true, bestDeltaE: 0, matchedRank: 1 },
      saturatedTopKCoverage: { k: 5, saturatedCandidatesConsidered: 1, matched: true, bestDeltaE: 0 },
      background: { light: { deltaE: 0, pass: true, weight: 1 }, dark: null },
      accentRecovered: true,
      score: 1,
      pass: true,
    },
    font: { heading: null, body: null, mono: null, scoredRoles: [], silentlyWrongRoles: [], pass: true },
    cvd: { checks: [], allDistinguishable: true },
    pass,
  };
}

function makeSite(id: string, pass = true): CorpusFidelityEntry {
  return {
    entry: makeEntry(id),
    truth: makeTruth(id),
    fidelity: makeFidelity(id, pass),
    shippedBackground: { light: '#ffffff', dark: '#0d1117' },
    shippedSeed: '#123456',
    categoricalSecondary: ['#1', '#2', '#3', '#4', '#5', '#6', '#7'],
  };
}

function baseInput(overrides: Partial<ReportInput> = {}): ReportInput {
  const sites = overrides.sites ?? [makeSite('site-a')];
  const rollup = overrides.rollup ?? buildSuiteRollup(sites);
  const mood: MoodSuiteResult = overrides.mood ?? { status: 'not-run' };
  return { mode: 'replay', sites, rollup, mood, ...overrides };
}

describe('generateReport — purity + required sections', () => {
  it('is a pure function: calling it twice with the same input yields byte-identical output', () => {
    const input = baseInput();
    expect(generateReport(input)).toBe(generateReport(input));
  });

  it('includes every required section: per-site table, fidelity rollup, a11y, slider coverage, weak regions, known findings, mood, punch list', () => {
    const report = generateReport(baseInput());
    expect(report).toContain('## Per-site fidelity');
    expect(report).toContain('## Fidelity rollup');
    expect(report).toContain('## Accessibility / CVD axis');
    expect(report).toContain('## Slider-coverage rollup');
    expect(report).toContain('## Weak-region rollup');
    expect(report).toContain('## Known-finding reproduction');
    expect(report).toContain('### #25');
    expect(report).toContain('### #26');
    expect(report).toContain('### #27');
    expect(report).toContain('## Mood axis');
    expect(report).toContain('## Punch list');
  });

  it('renders the site id in the per-site table', () => {
    const report = generateReport(baseInput({ sites: [makeSite('unique-site-id')], rollup: buildSuiteRollup([makeSite('unique-site-id')]) }));
    expect(report).toContain('unique-site-id');
  });
});

describe('generateReport — mode scope note', () => {
  it('a replay report states it measures normalize/pick/render fidelity, not live extraction', () => {
    const report = generateReport(baseInput({ mode: 'replay' }));
    expect(report).toMatch(/replay mode/i);
    expect(report).toMatch(/not live extraction|NOT live extraction/);
    expect(report).not.toContain('## Live-drift');
  });

  it('a refresh report includes the Live-Drift section and states refresh mode', () => {
    const report = generateReport(
      baseInput({ mode: 'refresh', drift: [{ siteId: 'site-a', changed: true, note: 'top clusters differ' }] }),
    );
    expect(report).toMatch(/refresh mode/i);
    expect(report).toContain('## Live-drift');
    expect(report).toContain('site-a');
    expect(report).toContain('CHANGED');
  });
});

describe('generateReport — mood-axis degrade rendering', () => {
  it('renders UNAVAILABLE with the real reason, never a fabricated verdict, and still renders every other section', () => {
    const report = generateReport(
      baseInput({ mood: { status: 'unavailable', reason: 'the claude CLI is present but authentication failed (401)' } }),
    );
    expect(report).toContain('UNAVAILABLE');
    expect(report).toContain('authentication failed (401)');
    expect(report).not.toMatch(/mood.*PASS|mood.*FAIL/i);
    // Every other section still renders in full.
    expect(report).toContain('## Fidelity rollup');
    expect(report).toContain('## Known-finding reproduction');
  });

  it('renders per-site mood verdicts when judged', () => {
    const report = generateReport(
      baseInput({
        sites: [makeSite('judged-site')],
        rollup: buildSuiteRollup([makeSite('judged-site')]),
        mood: { status: 'judged', perSite: [{ siteId: 'judged-site', overall: 'PASS' }] },
      }),
    );
    expect(report).toContain('judged-site: PASS');
  });

  it('renders "not run" when mood scoring was skipped entirely', () => {
    const report = generateReport(baseInput({ mood: { status: 'not-run' } }));
    expect(report).toMatch(/not run/i);
  });

  it('renders "not judged" in the per-site table cell for a site absent from a judged run\'s perSite list (review finding #9)', () => {
    const judgedSite = makeSite('judged-site');
    const skippedSite = makeSite('skipped-site'); // e.g. a control, or a site with no committed screenshot
    const report = generateReport(
      baseInput({
        sites: [judgedSite, skippedSite],
        rollup: buildSuiteRollup([judgedSite, skippedSite]),
        mood: { status: 'judged', perSite: [{ siteId: 'judged-site', overall: 'PASS' }] },
      }),
    );
    // The per-site table row for skipped-site's mood column reads "not judged", never a fabricated verdict.
    const skippedRow = report.split('\n').find((line) => line.includes('skipped-site'));
    expect(skippedRow).toContain('not judged');
  });
});

describe('generateReport — known-finding sections read straight off the rollup (no re-derivation)', () => {
  it('an accent-recovery failure in the rollup appears verbatim in the #27 section', () => {
    const failingSite = makeSite('accent-fail-site', false);
    failingSite.fidelity.color.accentRecovered = false;
    failingSite.fidelity.color.accent = { deltaE: 42, pass: false, weight: 1, similarity: 0.1 };
    const rollup = buildSuiteRollup([failingSite]);
    const report = generateReport(baseInput({ sites: [failingSite], rollup }));
    expect(report).toContain('accent-fail-site');
    expect(report).toContain('42.0');
  });

  it('a MATERIAL background mismatch (fails the backgroundMatch gate) in the rollup appears verbatim in the #25 section', () => {
    const bgSite = makeSite('bg-mismatch-site');
    bgSite.fidelity.color.background = { light: { deltaE: 0, pass: true, weight: 1 }, dark: { deltaE: 16.7, pass: false, weight: 1 } };
    bgSite.truth.pinned.backgroundDark = { hex: '#4b4b4b', source: 'official-site-css', confidence: 'high' };
    bgSite.shippedBackground = { light: '#ffffff', dark: '#161816' };
    const rollup = buildSuiteRollup([bgSite]);
    const report = generateReport(baseInput({ sites: [bgSite], rollup }));
    expect(report).toContain('bg-mismatch-site');
    expect(report).toContain('#4b4b4b');
    expect(report).toContain('#161816');
  });

  it('a background side that PASSES the gate does NOT appear in the #25 material list, even with a nonzero ΔE', () => {
    const bgSite = makeSite('close-but-passing-site');
    bgSite.fidelity.color.background = { light: { deltaE: 0, pass: true, weight: 1 }, dark: { deltaE: 2.7, pass: true, weight: 1 } };
    bgSite.truth.pinned.backgroundDark = { hex: '#0d1117', source: 'official-site-css', confidence: 'high' };
    bgSite.shippedBackground = { light: '#ffffff', dark: '#151719' };
    const rollup = buildSuiteRollup([bgSite]);
    expect(rollup.materialBackgroundMismatches).toEqual([]);
    const report = generateReport(baseInput({ sites: [bgSite], rollup }));
    expect(report).toContain('No real site\'s background MATERIALLY missed');
  });

  it('a detected categorical-sameness result appears in the #26 section with the shared palette', () => {
    const a = makeSite('cat-a');
    const b = makeSite('cat-b');
    const rollup = buildSuiteRollup([a, b]);
    const report = generateReport(baseInput({ sites: [a, b], rollup }));
    expect(report).toContain('Detected');
    expect(report).toContain('#1, #2, #3, #4, #5, #6, #7');
  });
});
