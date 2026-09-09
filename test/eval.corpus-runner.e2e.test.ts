/**
 * Brand-Fidelity Step 10 (#39) — the ACCEPTANCE-grade end-to-end test.
 *
 * Replays + scores the FULL v1 corpus (12 real sites + 8 csszengarden
 * controls) through the REAL production pipeline (`FixtureEngine` ->
 * `normalize()` -> `scoreSite()`, no boundary mock — the same wiring
 * `test/eval.smoke.e2e.test.ts` proved for one site, generalized here to all
 * 20), builds the suite rollup, and generates the report. Then proves the
 * three known findings (#25/#26/#27) are genuinely SCORE-DRIVEN, not
 * hard-coded strings: for each finding, a real site's frozen truth (or its
 * own shipped structural output) is mutated so the finding's condition no
 * longer holds, and the finding is asserted to disappear on a re-score while
 * every OTHER site's findings are unaffected — the anti-hardcode proof the
 * step's acceptance criterion demands.
 *
 * REVIEW FIX (Step 10 second pass): the #25 detector was made DISCRIMINATING
 * (reuses color-fidelity.ts's own `backgroundMatch` gate instead of a
 * near-zero epsilon that flagged ~22/24 real-site background sides as
 * "noise"). Under the new detector github's own dark-bg ΔE (~2.7) genuinely
 * PASSES the gate — it is not a top-half offender — so the tests below no
 * longer assert github appears in the MATERIAL mismatch list; instead they
 * assert the honest cross-check (`crossCheckIssue25`) and use a genuinely
 * failing real site (stripe/duolingo/kurzgesagt) for the material-mismatch
 * anti-hardcode proof.
 *
 * Also exercises the mood-axis graceful degrade AND the judged per-site loop
 * via INJECTED fake judges (never the real `claude` CLI — this suite must
 * stay hermetic and fast regardless of this machine's ambient auth state,
 * measurement-validity "never depend on ambient state for a correctness
 * test") and confirms every other section of the report still renders in
 * full when mood is unavailable.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TruthTemplate } from '../benchmark/truth-scaffold.ts';
import type { NormalizeResult } from '../src/extract/normalize.ts';
import { generateReport } from '../src/eval/report.ts';
import {
  buildSuiteRollup,
  CZG_CONTROL_WEIGHT,
  HIGH_SEVERITY_RATIO,
  type CorpusFidelityEntry,
} from '../src/eval/score.ts';
import {
  categoricalSecondaryOf,
  diffAgainstFixture,
  main,
  parseArgs,
  readTruth,
  replayAndScoreCorpus,
  runMoodSuite,
  scoreReplayedSite,
  type ReplayedSite,
} from '../src/eval/corpus-runner.ts';
import { MOOD_ATTRIBUTES, type VisionJudge, type VisionJudgeInput, type VisionJudgeSample, type Verdict } from '../src/eval/mood-judge.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// Replay + score the full v1 corpus ONCE for this whole file and CACHE it
// (memoized promise): it is a pure, deterministic, network-free replay (see
// file header), so sharing the SAME resolved objects across every test below
// is safe — every mutation test only ever spreads/clones
// (`{...site, ...}` / `array.map(...)`), never mutates a shared object or
// array in place (review finding #7: an earlier revision's comment claimed
// caching that didn't actually exist — this is now real).
let cachedCorpus: Promise<{ replayed: ReplayedSite[]; scored: CorpusFidelityEntry[] }> | undefined;
async function loadRealCorpus(): Promise<{ replayed: ReplayedSite[]; scored: CorpusFidelityEntry[] }> {
  cachedCorpus ??= replayAndScoreCorpus({ tier: 'v1' });
  return cachedCorpus;
}

// --- shared mood-test fakery (hermetic: no live claude, no real Playwright for calibration) ---

/** A well-formed `VisionJudgeSample` where every mood attribute gets the same verdict. */
function sampleAll(verdict: Verdict): VisionJudgeSample {
  const parsed = Object.fromEntries(
    MOOD_ATTRIBUTES.map((a) => [a, { verdict, rationale: 'test' }]),
  ) as VisionJudgeSample['parsed'];
  return { raw: JSON.stringify(parsed), parsed };
}

/** A lightweight fake calibration-input builder — no real specimen render, no Playwright, since the fake judges below never actually read the image path. */
async function fakeBuildKnownBadInput(): Promise<VisionJudgeInput> {
  return { subjectId: 'monet-mismatch-anchor', images: [{ label: 'specimen', path: 'unused.png' }], palette: [] };
}

describe('corpus-runner — the full v1 corpus runs end-to-end (Step 10 acceptance)', () => {
  it('replays + scores all 20 v1-tier sites (12 real + 8 czg controls) with no throw', async () => {
    const { scored } = await loadRealCorpus();
    expect(scored).toHaveLength(20);
    const realCount = scored.filter((s) => !s.entry.isControl).length;
    const controlCount = scored.filter((s) => s.entry.isControl).length;
    expect(realCount).toBe(12);
    expect(controlCount).toBe(8);
  });

  it('the generated report is well-formed, non-empty Markdown containing every corpus site id', async () => {
    const { scored } = await loadRealCorpus();
    const rollup = buildSuiteRollup(scored);
    const report = generateReport({ mode: 'replay', sites: scored, rollup, mood: { status: 'not-run' } });
    expect(report.length).toBeGreaterThan(500);
    for (const site of scored) {
      expect(report).toContain(site.entry.id);
    }
  });

  it('czg controls are weighted CZG_CONTROL_WEIGHT (<0.5x) in the real fidelity rollup', async () => {
    const { scored } = await loadRealCorpus();
    const rollup = buildSuiteRollup(scored);
    // 12 real sites at weight 1 + 8 controls at CZG_CONTROL_WEIGHT.
    expect(rollup.fidelity.weightedTotal).toBeCloseTo(12 + 8 * CZG_CONTROL_WEIGHT, 10);
  });

  it('Monet mood-anchor presets never appear anywhere in the real fidelity rollup (structurally excluded)', async () => {
    const { scored } = await loadRealCorpus();
    const rollup = buildSuiteRollup(scored);
    const rollupIds = scored.map((s) => s.entry.id);
    expect(rollupIds.every((id) => !id.toLowerCase().includes('monet'))).toBe(true);
    expect(rollup.fidelity.sitesScored).toBe(20); // no extra Monet row ever snuck in
  });

  it('a11y/CVD is reported as its own axis, independent of the composite pass rate', async () => {
    const { scored } = await loadRealCorpus();
    const rollup = buildSuiteRollup(scored);
    // Real-fixture fact (Step 5/6/7 calibration-locked elsewhere): every real
    // site's CVD sub-check is distinguishable even though several sites FAIL
    // overall fidelity (wrong accent/font) — proving a11y truly is a separate
    // axis, not derived from `.pass`.
    expect(rollup.a11y.distinguishableRate).toBe(1);
    expect(rollup.fidelity.weightedPassRate).toBeLessThan(1);
  });
});

describe('known-finding reproduction — derived from real scores (Step 10 acceptance crux)', () => {
  it('#27 — accent-recovery failures include github, nytimes, and kurzgesagt (the plan\'s named examples)', async () => {
    const { scored } = await loadRealCorpus();
    const rollup = buildSuiteRollup(scored);
    const ids = rollup.accentRecoveryFailures.map((f) => f.siteId);
    expect(ids).toEqual(expect.arrayContaining(['github', 'nytimes', 'kurzgesagt']));
    const githubFailure = rollup.accentRecoveryFailures.find((f) => f.siteId === 'github')!;
    expect(githubFailure.pinnedAccentHex).toBe('#0fbf3e'); // github's real published green
    expect(githubFailure.shippedSeedHex).toBe('#8dd6ff'); // the "action blue" the tool actually picked
  });

  it('#25 — the material-mismatch list is DISCRIMINATING: genuinely failing sites appear, github does NOT (its ΔE clears the gate)', async () => {
    const { scored } = await loadRealCorpus();
    const rollup = buildSuiteRollup(scored);
    const ids = rollup.materialBackgroundMismatches.map((m) => `${m.siteId}:${m.side}`);
    // Real-fixture fact: stripe/duolingo/kurzgesagt genuinely fail the
    // backgroundMatch gate on their dark side (ΔE 13.7/16.7/14.6 vs a 10.0
    // gate) — these are the tool's actual worst dark-bg offenders.
    expect(ids).toEqual(expect.arrayContaining(['stripe:dark', 'duolingo:dark', 'kurzgesagt:dark']));
    // github's dark bg (ΔE ~2.7) is NOT one of them — it clears the gate.
    expect(ids).not.toContain('github:dark');
  });

  it('#25 — the material-mismatch fraction is WELL UNDER all real-site background sides (signal, not noise), sorted worst-first by ΔE', async () => {
    const { scored } = await loadRealCorpus();
    const rollup = buildSuiteRollup(scored);
    const realSites = scored.filter((s) => !s.entry.isControl);
    const totalSidesChecked = realSites.reduce(
      (sum, s) =>
        sum +
        (s.truth.pinned.backgroundLight !== null ? 1 : 0) +
        (s.truth.pinned.backgroundDark !== null ? 1 : 0),
      0,
    );
    const materialFraction = rollup.materialBackgroundMismatches.length / totalSidesChecked;
    expect(materialFraction).toBeGreaterThan(0); // a genuine, non-vacuous signal
    expect(materialFraction).toBeLessThan(0.5); // NOT "flag almost everything" noise
    const deltaEs = rollup.materialBackgroundMismatches.map((m) => m.deltaE);
    expect(deltaEs).toEqual([...deltaEs].sort((a, b) => b - a)); // worst-first, a real priority order
    // Severity actually scales with magnitude (not a flat label).
    const highs = rollup.materialBackgroundMismatches.filter((m) => m.severity === 'high');
    expect(highs.every((m) => m.severityRatio >= HIGH_SEVERITY_RATIO)).toBe(true);
  });

  it('#25 — the face-validity cross-check honestly reports github\'s real dark/light background scored data (ΔE ~2.7, NOT flagged as material)', async () => {
    const { scored } = await loadRealCorpus();
    const rollup = buildSuiteRollup(scored);
    const cross = rollup.issue25CrossCheck;
    expect(cross).not.toBeNull();
    expect(cross?.siteId).toBe('github');
    expect(cross?.side).toBe('dark');
    expect(cross?.pinnedHex).toBe('#0d1117');
    expect(cross?.shippedHex).toBe('#151719');
    expect(cross?.deltaE).toBeGreaterThan(0);
    expect(cross?.deltaE).toBeLessThan(cross?.materialityThreshold ?? Infinity); // clears the gate
    expect(cross?.flaggedAsMaterial).toBe(false); // an HONEST disagreement with the historical operator claim
  });

  it('#26 — categorical-sameness is detected: every corpus site ships a byte-identical chart.categorical.2-8 tail', async () => {
    const { scored } = await loadRealCorpus();
    const rollup = buildSuiteRollup(scored);
    expect(rollup.categoricalSameness.detected).toBe(true);
    expect(rollup.categoricalSameness.matchFraction).toBe(1);
    expect(rollup.categoricalSameness.matchingSiteIds).toHaveLength(20);
    expect(rollup.categoricalSameness.sharedPalette).toHaveLength(7);
  });
});

describe('ANTI-HARDCODE proof — each finding disappears when its underlying condition no longer holds', () => {
  it('#27: setting github\'s pinned accent to equal its shipped seed removes it from accentRecoveryFailures, other sites unaffected', async () => {
    const { replayed, scored } = await loadRealCorpus();
    const githubReplayed = replayed.find((r) => r.entry.id === 'github')!;
    const githubScored = scored.find((s) => s.entry.id === 'github')!;

    // Sanity: with the REAL truth, github genuinely fails accent recovery.
    const realRollup = buildSuiteRollup(scored);
    expect(realRollup.accentRecoveryFailures.map((f) => f.siteId)).toContain('github');

    // Mutate: pin github's TRUE accent to equal what the tool actually
    // shipped (its own seed) — a proposal can only ever "recover" an accent
    // that matches the (now-mutated) truth trivially.
    const mutatedTruth: TruthTemplate = {
      ...githubReplayed.truth,
      pinned: {
        ...githubReplayed.truth.pinned,
        accent: { hex: githubScored.shippedSeed, source: 'operator-judgment', confidence: 'high' },
      },
    };
    const mutatedReplayed: ReplayedSite = { ...githubReplayed, truth: mutatedTruth };
    const mutatedScoredGithub = scoreReplayedSite(mutatedReplayed);
    expect(mutatedScoredGithub.fidelity.color.accentRecovered).toBe(true); // proves the mutation actually changed the score

    const mutatedSuite = scored.map((s) => (s.entry.id === 'github' ? mutatedScoredGithub : s));
    const mutatedRollup = buildSuiteRollup(mutatedSuite);

    const idsAfter = mutatedRollup.accentRecoveryFailures.map((f) => f.siteId);
    expect(idsAfter).not.toContain('github');
    // Other real accent-recovery failures (untouched by the mutation) remain.
    expect(idsAfter).toEqual(expect.arrayContaining(['nytimes', 'kurzgesagt']));
  });

  it('#25: setting stripe\'s pinned dark background to equal the shipped hex removes it from materialBackgroundMismatches, other mismatches unaffected', async () => {
    const { replayed, scored } = await loadRealCorpus();
    const stripeReplayed = replayed.find((r) => r.entry.id === 'stripe')!;
    const stripeScored = scored.find((s) => s.entry.id === 'stripe')!;

    const realRollup = buildSuiteRollup(scored);
    expect(realRollup.materialBackgroundMismatches.some((m) => m.siteId === 'stripe' && m.side === 'dark')).toBe(true);
    // A control group: duolingo's dark-bg mismatch is untouched by this mutation.
    expect(realRollup.materialBackgroundMismatches.some((m) => m.siteId === 'duolingo' && m.side === 'dark')).toBe(true);

    const mutatedTruth: TruthTemplate = {
      ...stripeReplayed.truth,
      pinned: {
        ...stripeReplayed.truth.pinned,
        backgroundDark: { hex: stripeScored.shippedBackground.dark, source: 'operator-judgment', confidence: 'high' },
      },
    };
    const mutatedReplayed: ReplayedSite = { ...stripeReplayed, truth: mutatedTruth };
    const mutatedScoredStripe = scoreReplayedSite(mutatedReplayed);
    expect(mutatedScoredStripe.fidelity.color.background.dark?.deltaE).toBeCloseTo(0, 5); // proves the mutation took effect
    expect(mutatedScoredStripe.fidelity.color.background.dark?.pass).toBe(true);

    const mutatedSuite = scored.map((s) => (s.entry.id === 'stripe' ? mutatedScoredStripe : s));
    const mutatedRollup = buildSuiteRollup(mutatedSuite);

    expect(mutatedRollup.materialBackgroundMismatches.some((m) => m.siteId === 'stripe' && m.side === 'dark')).toBe(false);
    // Duolingo's own (untouched) dark-bg mismatch still stands.
    expect(mutatedRollup.materialBackgroundMismatches.some((m) => m.siteId === 'duolingo' && m.side === 'dark')).toBe(true);
  });

  it('#26: perturbing one site\'s shipped categorical tail excludes it from the sameness finding and lowers the match fraction', async () => {
    const { scored } = await loadRealCorpus();
    const realRollup = buildSuiteRollup(scored);
    expect(realRollup.categoricalSameness.matchingSiteIds).toContain('stripe');
    expect(realRollup.categoricalSameness.matchFraction).toBe(1);

    const stripe = scored.find((s) => s.entry.id === 'stripe')!;
    const mutatedStripe: CorpusFidelityEntry = {
      ...stripe,
      categoricalSecondary: [...stripe.categoricalSecondary.slice(0, 6), '#deadbe'],
    };
    const mutatedSuite = scored.map((s) => (s.entry.id === 'stripe' ? mutatedStripe : s));
    const mutatedRollup = buildSuiteRollup(mutatedSuite);

    expect(mutatedRollup.categoricalSameness.matchingSiteIds).not.toContain('stripe');
    expect(mutatedRollup.categoricalSameness.differingSiteIds).toContain('stripe');
    expect(mutatedRollup.categoricalSameness.matchFraction).toBeLessThan(1);
    // Still detected overall (19/20 still share the tail) — only stripe's OWN
    // membership changed, proving the mechanism is per-site, not all-or-nothing.
    expect(mutatedRollup.categoricalSameness.detected).toBe(true);
  });
});

describe('categoricalSecondaryOf — fails loud on a missing/non-string leaf (review finding #3)', () => {
  it('throws naming the missing dot-path rather than silently coercing to the string "undefined"', () => {
    const malformedNorm = { tokens: { color: { chart: { categorical: {} } } } } as unknown as NormalizeResult;
    expect(() => categoricalSecondaryOf(malformedNorm)).toThrow(/color\.chart\.categorical\.2/);
  });

  it('a real replayed site\'s tokens always satisfy the contract (no throw)', async () => {
    const { replayed } = await loadRealCorpus();
    const stripe = replayed.find((r) => r.entry.id === 'stripe')!;
    expect(() => categoricalSecondaryOf(stripe.norm)).not.toThrow();
  });
});

describe('mood axis — graceful degradation via an injected fake judge (hermetic; never the real claude CLI)', () => {
  it('reports UNAVAILABLE with a real reason when the judge hard-stops at calibration, and never attempts a per-site score', async () => {
    const { replayed } = await loadRealCorpus();

    let calibrationCallCount = 0;
    const judge: VisionJudge = async () => {
      calibrationCallCount += 1;
      return { raw: '', hardStop: 'cli-absent' as const };
    };

    const result = await runMoodSuite(replayed, { judge, buildKnownBadInput: fakeBuildKnownBadInput });

    expect(result.status).toBe('unavailable');
    expect(result.reason).toBeTruthy();
    expect(result.perSite).toBeUndefined();
    // Only the ONE calibration call happened — no per-site judging was attempted.
    expect(calibrationCallCount).toBe(1);
  });

  it('when mood is unavailable, the report still renders colour/font/structural findings in full', async () => {
    const { replayed, scored } = await loadRealCorpus();
    const rollup = buildSuiteRollup(scored);

    const mood = await runMoodSuite(replayed, {
      judge: async () => ({ raw: '', hardStop: 'cli-absent' as const }),
      buildKnownBadInput: fakeBuildKnownBadInput,
    });

    const report = generateReport({ mode: 'replay', sites: scored, rollup, mood });
    expect(report).toContain('UNAVAILABLE');
    expect(report).toContain('github'); // #25/#27 findings still present
    expect(report).toContain('Detected'); // #26 still present
    expect(report).toContain('## Fidelity rollup');
  });

  it('enabled: false skips mood entirely and returns "not-run" with zero judge calls', async () => {
    const { replayed } = await loadRealCorpus();
    let calls = 0;
    const result = await runMoodSuite(replayed, {
      enabled: false,
      judge: async () => {
        calls += 1;
        return { raw: '', hardStop: 'cli-absent' as const };
      },
    });
    expect(result).toEqual({ status: 'not-run' });
    expect(calls).toBe(0);
  });
});

describe('mood axis — the JUDGED per-site loop actually executes (review finding #2 — previously zero coverage)', () => {
  it('drives buildSpecimenScreenshot -> judgeMood for an eligible real site, skipping a control AND a site with no committed screenshot', async () => {
    const { replayed } = await loadRealCorpus();
    const stripeSite = replayed.find((r) => r.entry.id === 'stripe')!;
    const controlSite = replayed.find((r) => r.entry.isControl)!;
    // A synthetic non-control entry whose id has no committed <id>.viewport.png.
    const noScreenshotSite: ReplayedSite = {
      ...stripeSite,
      entry: { ...stripeSite.entry, id: 'fake-no-screenshot-site', isControl: false },
    };

    const judgeCalls: string[] = [];
    const judge: VisionJudge = async (input) => {
      judgeCalls.push(input.subjectId);
      return input.subjectId === 'monet-mismatch-anchor' ? sampleAll('FAIL') : sampleAll('PASS');
    };

    const result = await runMoodSuite([stripeSite, controlSite, noScreenshotSite], {
      judge,
      buildKnownBadInput: fakeBuildKnownBadInput,
    });

    expect(result.status).toBe('judged');
    expect(result.perSite).toEqual([{ siteId: 'stripe', overall: 'PASS' }]);
    // The control and the screenshot-less entry were genuinely SKIPPED, not
    // silently mis-scored: only 'monet-mismatch-anchor' (calibration) and
    // 'stripe' (the one eligible site) were ever handed to the judge.
    expect(judgeCalls.filter((id) => id === 'monet-mismatch-anchor').length).toBeGreaterThan(0);
    expect(judgeCalls).not.toContain('fake-no-screenshot-site');
    expect(judgeCalls.filter((id) => id === controlSite.entry.id)).toEqual([]);
  // 60s, not 30s (issue #85): this drives real compileBrand + generatePreview +
  // a Playwright screenshot while four other suites are launching Chromium.
  }, 60_000);

  it('a parse-failure during a judged per-site run propagates LOUD, never silently absorbed (review finding #5)', async () => {
    const { replayed } = await loadRealCorpus();
    const stripeSite = replayed.find((r) => r.entry.id === 'stripe')!;

    const judge: VisionJudge = async (input) =>
      input.subjectId === 'monet-mismatch-anchor' ? sampleAll('FAIL') : { raw: 'not json, unparseable' };

    await expect(
      runMoodSuite([stripeSite], { judge, buildKnownBadInput: fakeBuildKnownBadInput }),
    ).rejects.toThrow(/did not parse/i);
  }, 30_000);
});

describe('--refresh live-drift diff (pure function, no network in this test)', () => {
  it('diffAgainstFixture reports unchanged when the top-3 clusters and colour count match', () => {
    const raw = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs', 'findings', 'eval-raw-extractions', 'benchmark', 'stripe.raw-extraction.json'), 'utf8'),
    );
    const result = diffAgainstFixture('stripe', raw, raw); // identical "live" data
    expect(result.changed).toBe(false);
    expect(result.note).toMatch(/unchanged/);
  });

  it('diffAgainstFixture reports changed when the live top-3 clusters differ', () => {
    const raw = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs', 'findings', 'eval-raw-extractions', 'benchmark', 'stripe.raw-extraction.json'), 'utf8'),
    );
    const mutatedLive = { ...raw, colors: [{ hex: '#abcdef', frequency: 999999, roles: [] }, ...raw.colors] };
    const result = diffAgainstFixture('stripe', raw, mutatedLive);
    expect(result.changed).toBe(true);
    expect(result.note).toMatch(/CHANGED|delta/);
  });
});

describe('corpus-runner CLI entry — parseArgs + main() (review finding #4)', () => {
  it('parseArgs: defaults are refresh:false, mood:true, out:undefined', () => {
    expect(parseArgs([])).toEqual({ refresh: false, mood: true, out: undefined });
  });

  it('parseArgs: parses --refresh, --no-mood, and --out <path>', () => {
    expect(parseArgs(['--refresh'])).toMatchObject({ refresh: true, mood: true });
    expect(parseArgs(['--no-mood'])).toMatchObject({ refresh: false, mood: false });
    expect(parseArgs(['--out', '/tmp/report.md'])).toMatchObject({ out: '/tmp/report.md' });
  });

  it('parseArgs: an unrecognized flag is ignored (not an error) and does not disturb adjacent flag parsing', () => {
    const parsed = parseArgs(['--bogus-flag', '--refresh', '--out', 'x.md']);
    expect(parsed.refresh).toBe(true);
    expect(parsed.out).toBe('x.md');
  });

  it('main() runs end-to-end through the hermetic replay + --no-mood path and writes a well-formed report to --out', async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), 'onbrand-corpus-runner-main-test-'));
    const outPath = path.join(outDir, 'report.md');
    const originalArgv = process.argv;
    process.argv = [originalArgv[0] ?? 'node', originalArgv[1] ?? 'corpus-runner.ts', '--no-mood', '--out', outPath];
    try {
      await main();
    } finally {
      process.argv = originalArgv;
    }
    try {
      const content = readFileSync(outPath, 'utf8');
      expect(content).toContain('# Brand-Fidelity Report');
      expect(content).toContain('github');
      expect(content).toContain('not run'); // mood section, --no-mood
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('readTruth — reads + schema-validates the real committed truth files', () => {
  it('reads github.truth.json and it is schema-valid + pinned', () => {
    const truth = readTruth('github');
    expect(truth.status).toBe('pinned');
    expect(truth.pinned.accent.hex).toBe('#0fbf3e');
  });
});
