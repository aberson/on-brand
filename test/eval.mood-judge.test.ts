/**
 * Deterministic tests for `src/eval/mood-judge.ts` (Brand-Fidelity plan Step 9,
 * #38). A vision-judge's LLM call is inherently NON-DETERMINISTIC and needs
 * the `claude` CLI + network, so it cannot be unit-tested deterministically —
 * every case in this file therefore injects a FAKE `VisionJudge` (a plain
 * async function returning controlled `VisionJudgeSample` values) so the
 * DETERMINISTIC mechanism mood-judge.ts builds on top of that seam — k>=3
 * sampling, per-attribute median/majority aggregation, parse-fail-abort,
 * UNCERTAIN-escalation, and the calibration gate — is exercised with zero
 * network and zero live LLM call. This mirrors this repo's existing pattern
 * for the same class of problem (`src/extract/llm.ts`'s injectable
 * `ClaudeSpawner`, exercised offline in `test/extract.llm.test.ts`).
 *
 * The PRODUCTION `VisionJudge` (`createClaudeVisionJudge`, real `claude` CLI
 * spawn/classify/parse code) is separately exercised through the Step 11
 * fake-bins pattern (`nodeScriptSpawner` + a fake bin) in the "production
 * VisionJudge" describe block below — so the REAL subprocess code runs, with
 * no network and no live claude (mirrors `test/extract.llm.test.ts`).
 *
 * The LIVE anchor test (real claude CLI + real Monet presets: the Monet
 * negative anchor genuinely FAILS, the water-lily positive anchor genuinely
 * PASSES) lives in `test/eval.mood-judge.e2e.test.ts`, gated on claude-CLI +
 * Chromium presence — it is SKIPPED (not failed) offline.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifySpawn,
  nodeScriptSpawner,
  EXEC_DENY_TOOLS,
  READ_DENY_TOOLS,
  MCP_DENY_TOOLS,
  type ClaudeSpawner,
} from '../src/extract/llm.ts';
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from '../src/extract/llm-prompts.ts';
import {
  MIN_SAMPLES,
  MOOD_ATTRIBUTES,
  MOOD_AUTH_DEAD_REASON,
  MOOD_CLI_ABSENT_REASON,
  MoodJudgeCalibrationError,
  MoodJudgeParseError,
  VisionJudgeUnavailableError,
  aggregateVotes,
  buildMoodJudgePrompt,
  calibrateAgainstKnownBad,
  createClaudeVisionJudge,
  judgeMood,
  resolveOverall,
  runCalibratedMoodJudgment,
  scoreMoodAxis,
  type MoodAttribute,
  type Verdict,
  type VisionJudge,
  type VisionJudgeInput,
  type VisionJudgeSample,
} from '../src/eval/mood-judge.ts';

const fakeBin = (name: string): string =>
  fileURLToPath(new URL(`./helpers/fake-bins/${name}.js`, import.meta.url));
const spawnerFor = (name: string): ClaudeSpawner => nodeScriptSpawner(fakeBin(name));

// --- test helpers --------------------------------------------------------

/** A fully-parsed sample where EVERY attribute got the same verdict. */
function sampleAll(v: Verdict, tag = ''): VisionJudgeSample {
  const parsed = Object.fromEntries(
    MOOD_ATTRIBUTES.map((a) => [a, { verdict: v, rationale: `fake ${a} ${v}${tag}` }]),
  ) as Record<MoodAttribute, { verdict: Verdict; rationale: string }>;
  return { raw: JSON.stringify(parsed), parsed };
}

/** A parsed sample with a PER-ATTRIBUTE verdict map (for mixed-vote tests). */
function sampleMixed(verdicts: Record<MoodAttribute, Verdict>): VisionJudgeSample {
  const parsed = Object.fromEntries(
    MOOD_ATTRIBUTES.map((a) => [a, { verdict: verdicts[a], rationale: `fake ${a} ${verdicts[a]}` }]),
  ) as Record<MoodAttribute, { verdict: Verdict; rationale: string }>;
  return { raw: JSON.stringify(parsed), parsed };
}

/** A sample that failed to parse (no `parsed`, no `hardStop`). */
function sampleParseFail(raw = 'not json at all'): VisionJudgeSample {
  return { raw };
}

/** A REAL, already-existing directory (a committed fixture PNG's dir) — the
 * production VisionJudge tests below spawn a REAL child process and pin its
 * `cwd` to the image's directory (mirrors `llm.ts`'s screenshot-pass cwd
 * pin), which on Windows requires the directory to actually exist (a
 * nonexistent cwd itself produces a spawn ENOENT — indistinguishable from a
 * genuinely-missing claude binary). Using a real fixture path avoids
 * conflating "bad test fixture" with "claude CLI absent".
 */
const REAL_FIXTURE_IMAGE = fileURLToPath(
  new URL('./fixtures/extraction/screenshots/example.png', import.meta.url),
);

function makeInput(overrides: Partial<VisionJudgeInput> = {}): VisionJudgeInput {
  return {
    subjectId: 'test-subject',
    images: [{ label: 'specimen', path: REAL_FIXTURE_IMAGE }],
    palette: ['#112233', '#445566'],
    referenceDescription: 'A cool, muted, contemplative reference mood.',
    ...overrides,
  };
}

/** A queue-driven fake VisionJudge: returns samples[i] on the i-th call
 * (repeats the last entry past the end), and records every input it was
 * called with. */
function queueJudge(samples: VisionJudgeSample[]): { judge: VisionJudge; calls: VisionJudgeInput[] } {
  const calls: VisionJudgeInput[] = [];
  let i = 0;
  const judge: VisionJudge = async (input) => {
    calls.push(input);
    const sample = samples[Math.min(i, samples.length - 1)]!;
    i += 1;
    return sample;
  };
  return { judge, calls };
}

// ---------------------------------------------------------------------------

describe('aggregateVotes — deterministic median/majority over an ordinal mapping', () => {
  // NOTE: a standalone `[FAIL,FAIL,PASS] -> FAIL` case is deliberately NOT
  // repeated here — it's one of the 3 permutations the very next test already
  // covers (Step 9 review finding 7: trim the redundant subset).
  it('a 2/3 majority wins: [PASS, PASS, FAIL] -> PASS', () => {
    expect(aggregateVotes(['PASS', 'PASS', 'FAIL'])).toBe('PASS');
  });

  it('order-independent: every permutation of the same multiset aggregates the same', () => {
    const perms = [
      ['FAIL', 'PASS', 'FAIL'],
      ['PASS', 'FAIL', 'FAIL'],
      ['FAIL', 'FAIL', 'PASS'],
    ] as const;
    for (const p of perms) expect(aggregateVotes(p)).toBe('FAIL');
  });

  it('a genuine 3-way split (no majority) escalates: [FAIL, UNCERTAIN, PASS] -> ESCALATE', () => {
    expect(aggregateVotes(['FAIL', 'UNCERTAIN', 'PASS'])).toBe('ESCALATE');
  });

  it('unanimous UNCERTAIN escalates, never silently bucketed', () => {
    expect(aggregateVotes(['UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN'])).toBe('ESCALATE');
  });

  it('unanimous PASS/FAIL aggregate to themselves', () => {
    expect(aggregateVotes(['PASS', 'PASS', 'PASS'])).toBe('PASS');
    expect(aggregateVotes(['FAIL', 'FAIL', 'FAIL'])).toBe('FAIL');
  });

  it('an even k=4 genuine 2-2 split escalates (measurement-validity: never silently pick a side)', () => {
    expect(aggregateVotes(['PASS', 'PASS', 'FAIL', 'FAIL'])).toBe('ESCALATE');
  });

  it('an even k=4 non-tied split resolves by median: [PASS,PASS,PASS,FAIL] -> PASS', () => {
    expect(aggregateVotes(['PASS', 'PASS', 'PASS', 'FAIL'])).toBe('PASS');
  });

  it('rejects an empty vote list (a judge over zero samples is meaningless)', () => {
    expect(() => aggregateVotes([])).toThrow();
  });
});

describe('resolveOverall — /judge-ui precedence: FAIL beats ESCALATE beats PASS', () => {
  it('all PASS -> PASS', () => {
    expect(resolveOverall(['PASS', 'PASS', 'PASS', 'PASS'])).toBe('PASS');
  });

  it('any FAIL wins outright, even alongside an ESCALATE', () => {
    expect(resolveOverall(['PASS', 'ESCALATE', 'FAIL', 'PASS'])).toBe('FAIL');
  });

  it('any ESCALATE wins when nothing FAILed', () => {
    expect(resolveOverall(['PASS', 'ESCALATE', 'PASS', 'PASS'])).toBe('ESCALATE');
  });

  it('rejects an empty verdict list', () => {
    expect(() => resolveOverall([])).toThrow();
  });
});

describe('judgeMood — k>=3 sampling, deterministic aggregation, evidence', () => {
  it('happy path: k defaults to MIN_SAMPLES (3); the judge is called exactly 3 times', async () => {
    const { judge, calls } = queueJudge([sampleAll('PASS'), sampleAll('PASS'), sampleAll('PASS')]);
    const input = makeInput();
    const result = await judgeMood(judge, input);

    expect(calls).toHaveLength(MIN_SAMPLES);
    expect(result.k).toBe(MIN_SAMPLES);
    expect(result.overall).toBe('PASS');
    for (const attr of MOOD_ATTRIBUTES) {
      expect(result.attributes[attr].verdict).toBe('PASS');
      expect(result.attributes[attr].votes).toEqual(['PASS', 'PASS', 'PASS']);
      expect(result.attributes[attr].rationale).toHaveLength(3);
    }
    expect(result.samples).toHaveLength(3);
  });

  it('rejects k below MIN_SAMPLES WITHOUT calling the judge at all (never single-sample)', async () => {
    const { judge, calls } = queueJudge([sampleAll('PASS')]);
    await expect(judgeMood(judge, makeInput(), { k: 1 })).rejects.toThrow(/>= 3/);
    expect(calls).toHaveLength(0);
  });

  it('mixed per-attribute votes aggregate independently, and overall resolves by FAIL > ESCALATE > PASS', async () => {
    const { judge } = queueJudge([
      sampleMixed({ temperature: 'PASS', value: 'UNCERTAIN', saturation: 'PASS', mood: 'FAIL' }),
      sampleMixed({ temperature: 'PASS', value: 'PASS', saturation: 'UNCERTAIN', mood: 'FAIL' }),
      sampleMixed({ temperature: 'PASS', value: 'FAIL', saturation: 'FAIL', mood: 'PASS' }),
    ]);
    const result = await judgeMood(judge, makeInput(), { k: 3 });

    expect(result.attributes.temperature.verdict).toBe('PASS'); // unanimous
    expect(result.attributes.value.verdict).toBe('ESCALATE'); // UNCERTAIN,PASS,FAIL -> median 0
    expect(result.attributes.saturation.verdict).toBe('ESCALATE'); // PASS,UNCERTAIN,FAIL -> median 0
    expect(result.attributes.mood.verdict).toBe('FAIL'); // FAIL,FAIL,PASS -> majority FAIL
    // mood FAILed outright -> overall FAIL, regardless of the two ESCALATEs.
    expect(result.overall).toBe('FAIL');
  });

  it('the SAME build scored differently across k samples still aggregates deterministically (order-independent)', async () => {
    const votesA = [sampleAll('FAIL'), sampleAll('FAIL'), sampleAll('PASS')];
    const votesB = [sampleAll('PASS'), sampleAll('FAIL'), sampleAll('FAIL')]; // same multiset, different order
    const { judge: judgeA } = queueJudge(votesA);
    const { judge: judgeB } = queueJudge(votesB);
    const resultA = await judgeMood(judgeA, makeInput(), { k: 3 });
    const resultB = await judgeMood(judgeB, makeInput(), { k: 3 });
    expect(resultA.overall).toBe('FAIL');
    expect(resultB.overall).toBe('FAIL');
    expect(resultA.overall).toBe(resultB.overall);
  });

  describe('parse-fail ABORTS the whole judgment (never silently scores)', () => {
    it('a garbage/unparseable sample throws MoodJudgeParseError immediately (short-circuits — does not burn the remaining samples)', async () => {
      const { judge, calls } = queueJudge([sampleParseFail('{{{not json')]);
      await expect(judgeMood(judge, makeInput(), { k: 3 })).rejects.toThrow(MoodJudgeParseError);
      expect(calls).toHaveLength(1); // aborted on sample 1/3, samples 2-3 never requested
    });

    it('a parse failure on a LATER sample (not the first) still aborts the whole judgment', async () => {
      const { judge, calls } = queueJudge([sampleAll('PASS'), sampleParseFail(), sampleAll('PASS')]);
      await expect(judgeMood(judge, makeInput(), { k: 3 })).rejects.toThrow(MoodJudgeParseError);
      expect(calls).toHaveLength(2); // sample 3 never requested
    });

    it('the thrown error names the subject and includes the raw reply for diagnosis', async () => {
      const { judge } = queueJudge([sampleParseFail('unparseable garbage output')]);
      await expect(judgeMood(judge, makeInput({ subjectId: 'my-subject' }), { k: 3 })).rejects.toThrow(
        /my-subject/,
      );
    });
  });

  describe('claude-CLI-unavailable is a SEPARATE failure class from parse-fail', () => {
    it('a cli-absent sample throws VisionJudgeUnavailableError and short-circuits', async () => {
      const { judge, calls } = queueJudge([{ raw: '', hardStop: 'cli-absent' as const }]);
      await expect(judgeMood(judge, makeInput(), { k: 3 })).rejects.toThrow(VisionJudgeUnavailableError);
      expect(calls).toHaveLength(1);
    });

    it('an auth-dead sample also throws VisionJudgeUnavailableError, carrying the raw text (Step 9 review finding 6)', async () => {
      const { judge } = queueJudge([{ raw: 'auth dead diagnostic text', hardStop: 'auth-dead' as const }]);
      const err = await judgeMood(judge, makeInput(), { k: 3 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VisionJudgeUnavailableError);
      expect((err as VisionJudgeUnavailableError).hardStop).toBe('auth-dead');
      expect((err as VisionJudgeUnavailableError).rawExcerpt).toBe('auth dead diagnostic text');
      expect((err as Error).message).toContain('auth dead diagnostic text');
    });

    it('a hard-stop on a LATER sample (not the first) also aborts, having called the judge exactly that many times (Step 9 review finding 7a)', async () => {
      const { judge, calls } = queueJudge([sampleAll('PASS'), { raw: 'dead later', hardStop: 'auth-dead' as const }]);
      await expect(judgeMood(judge, makeInput(), { k: 3 })).rejects.toThrow(VisionJudgeUnavailableError);
      expect(calls).toHaveLength(2); // sample 3 never requested
    });
  });
});

describe('calibrateAgainstKnownBad — the discrimination guard', () => {
  it('a genuinely-failing known-bad anchor calibrates ok', async () => {
    const { judge } = queueJudge([sampleAll('FAIL'), sampleAll('FAIL'), sampleAll('FAIL')]);
    const calibration = await calibrateAgainstKnownBad(judge, makeInput({ subjectId: 'monet-mismatch-anchor' }));
    expect(calibration.ok).toBe(true);
    expect(calibration.result.overall).toBe('FAIL');
    expect(calibration.reason).toBeUndefined();
  });

  it('a known-bad anchor that scores PASS/ESCALATE calibrates NOT ok, with a diagnostic reason', async () => {
    const { judge } = queueJudge([sampleAll('PASS'), sampleAll('PASS'), sampleAll('PASS')]);
    const calibration = await calibrateAgainstKnownBad(judge, makeInput({ subjectId: 'monet-mismatch-anchor' }));
    expect(calibration.ok).toBe(false);
    expect(calibration.result.overall).toBe('PASS');
    expect(calibration.reason).toMatch(/calibration FAILED/);
    expect(calibration.reason).toMatch(/monet-mismatch-anchor/);
  });

  it('a known-bad anchor whose votes aggregate to overall ESCALATE (not FAIL, not PASS) ALSO calibrates NOT ok (Step 9 review finding 7b)', async () => {
    // Every attribute independently escalates (a genuine 3-way split across
    // samples), so overall is ESCALATE per resolveOverall -- distinct from
    // the PASS case above. The gate must refuse on EITHER non-FAIL outcome.
    const votes = [
      sampleMixed({ temperature: 'FAIL', value: 'FAIL', saturation: 'FAIL', mood: 'UNCERTAIN' }),
      sampleMixed({ temperature: 'UNCERTAIN', value: 'UNCERTAIN', saturation: 'UNCERTAIN', mood: 'UNCERTAIN' }),
      sampleMixed({ temperature: 'PASS', value: 'PASS', saturation: 'PASS', mood: 'PASS' }),
    ];
    const { judge } = queueJudge(votes);
    const calibration = await calibrateAgainstKnownBad(judge, makeInput({ subjectId: 'monet-mismatch-anchor' }));
    expect(calibration.result.overall).toBe('ESCALATE'); // sanity: genuinely escalate, not FAIL/PASS
    expect(calibration.ok).toBe(false);
    expect(calibration.reason).toMatch(/calibration FAILED/);
  });
});

describe('runCalibratedMoodJudgment — the GATE refuses to proceed on a miscalibrated judge', () => {
  it('calibration passes: the comparative judgment runs and both results are returned', async () => {
    const callLog: string[] = [];
    const judge: VisionJudge = async (input) => {
      callLog.push(input.subjectId);
      return input.subjectId === 'known-bad' ? sampleAll('FAIL') : sampleAll('PASS');
    };
    const { calibration, result } = await runCalibratedMoodJudgment(
      judge,
      makeInput({ subjectId: 'known-bad' }),
      makeInput({ subjectId: 'monet-water-lily' }),
    );
    expect(calibration.ok).toBe(true);
    expect(result.overall).toBe('PASS');
    expect(result.subjectId).toBe('monet-water-lily');
    // Both the known-bad calibration (3x) and the comparative subject (3x) ran.
    expect(callLog.filter((s) => s === 'known-bad')).toHaveLength(3);
    expect(callLog.filter((s) => s === 'monet-water-lily')).toHaveLength(3);
  });

  it('a fake judge that PASSES the known-bad makes the gate REFUSE — the comparative subject is NEVER judged', async () => {
    const callLog: string[] = [];
    const judge: VisionJudge = async (input) => {
      callLog.push(input.subjectId);
      return sampleAll('PASS'); // miscalibrated: even the known-bad "passes"
    };
    const knownBad = makeInput({ subjectId: 'known-bad' });
    const subject = makeInput({ subjectId: 'monet-water-lily' });

    await expect(runCalibratedMoodJudgment(judge, knownBad, subject)).rejects.toThrow(
      MoodJudgeCalibrationError,
    );
    // The comparative subject must NEVER have been dispatched to the judge.
    expect(callLog.every((s) => s === 'known-bad')).toBe(true);
    expect(callLog).not.toContain('monet-water-lily');
  });

  it('the thrown MoodJudgeCalibrationError carries the calibration evidence', async () => {
    const judge: VisionJudge = async () => sampleAll('PASS');
    const err = await runCalibratedMoodJudgment(
      judge,
      makeInput({ subjectId: 'known-bad' }),
      makeInput({ subjectId: 'subject' }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoodJudgeCalibrationError);
    const calibrationError = err as MoodJudgeCalibrationError;
    expect(calibrationError.calibration.ok).toBe(false);
    expect(calibrationError.calibration.result.overall).toBe('PASS');
  });

  it('a known-bad anchor that aggregates to overall ESCALATE (not FAIL) ALSO makes the REAL gate refuse (Step 9 review finding 7b)', async () => {
    const escalatingVotes: VisionJudgeSample[] = [
      sampleMixed({ temperature: 'FAIL', value: 'FAIL', saturation: 'FAIL', mood: 'UNCERTAIN' }),
      sampleMixed({ temperature: 'UNCERTAIN', value: 'UNCERTAIN', saturation: 'UNCERTAIN', mood: 'UNCERTAIN' }),
      sampleMixed({ temperature: 'PASS', value: 'PASS', saturation: 'PASS', mood: 'PASS' }),
    ];
    const callLog: string[] = [];
    let knownBadCall = 0;
    const judge: VisionJudge = async (input) => {
      callLog.push(input.subjectId);
      if (input.subjectId !== 'known-bad') return sampleAll('PASS');
      const sample = escalatingVotes[knownBadCall]!;
      knownBadCall += 1;
      return sample;
    };
    const knownBad = makeInput({ subjectId: 'known-bad' });
    const subject = makeInput({ subjectId: 'subject' });

    const err = await runCalibratedMoodJudgment(judge, knownBad, subject).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoodJudgeCalibrationError);
    expect((err as MoodJudgeCalibrationError).calibration.result.overall).toBe('ESCALATE');
    // The comparative subject must NEVER have been dispatched either.
    expect(callLog).not.toContain('subject');
  });
});

describe('scoreMoodAxis — graceful degradation is narrow (CLI-absent only; parse/calibration failures stay loud)', () => {
  it('claude CLI absent: status "unavailable" with the cli-absent-specific reason, NEVER a fabricated score, and NEVER throws', async () => {
    const judge: VisionJudge = async () => ({ raw: '', hardStop: 'cli-absent' as const });
    const result = await scoreMoodAxis(judge, makeInput({ subjectId: 'known-bad' }), makeInput({ subjectId: 'subject' }));
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe(MOOD_CLI_ABSENT_REASON);
    expect(result.calibration).toBeUndefined();
    expect(result.result).toBeUndefined();
  });

  it('claude CLI present but unauthenticated: status "unavailable" with the auth-dead-specific reason (Step 9 review finding 4)', async () => {
    const judge: VisionJudge = async () => ({ raw: 'auth dead', hardStop: 'auth-dead' as const });
    const result = await scoreMoodAxis(judge, makeInput({ subjectId: 'known-bad' }), makeInput({ subjectId: 'subject' }));
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe(MOOD_AUTH_DEAD_REASON);
  });

  it('cli-absent and auth-dead produce DIFFERENT reasons — granularity is preserved, not collapsed to one generic string', async () => {
    expect(MOOD_CLI_ABSENT_REASON).not.toBe(MOOD_AUTH_DEAD_REASON);
  });

  it('a parse failure still propagates LOUD through scoreMoodAxis (not swallowed into "unavailable")', async () => {
    const judge: VisionJudge = async () => sampleParseFail();
    await expect(
      scoreMoodAxis(judge, makeInput({ subjectId: 'known-bad' }), makeInput({ subjectId: 'subject' })),
    ).rejects.toThrow(MoodJudgeParseError);
  });

  it('a failed calibration gate still propagates LOUD through scoreMoodAxis (not swallowed)', async () => {
    const judge: VisionJudge = async () => sampleAll('PASS'); // known-bad "passes" -> miscalibrated
    await expect(
      scoreMoodAxis(judge, makeInput({ subjectId: 'known-bad' }), makeInput({ subjectId: 'subject' })),
    ).rejects.toThrow(MoodJudgeCalibrationError);
  });

  it('happy path: status "judged" with both calibration and result populated', async () => {
    const judge: VisionJudge = async (input) =>
      input.subjectId === 'known-bad' ? sampleAll('FAIL') : sampleAll('PASS');
    const result = await scoreMoodAxis(judge, makeInput({ subjectId: 'known-bad' }), makeInput({ subjectId: 'subject' }));
    expect(result.status).toBe('judged');
    expect(result.calibration?.ok).toBe(true);
    expect(result.result?.overall).toBe('PASS');
  });
});

describe('buildMoodJudgePrompt — injection-firewalled, mirrors llm-prompts.ts', () => {
  it('throws when images has no specimen entry', () => {
    expect(() =>
      buildMoodJudgePrompt(makeInput({ images: [{ label: 'source', path: '/tmp/source.png' }] })),
    ).toThrow(/specimen/);
  });

  it('throws when there is no source image AND no referenceDescription', () => {
    expect(() =>
      buildMoodJudgePrompt(
        makeInput({
          images: [{ label: 'specimen', path: '/tmp/specimen.png' }],
          referenceDescription: undefined,
        }),
      ),
    ).toThrow(/referenceDescription|source/);
  });

  describe('malformed image sets are rejected, never silently proceeding (Step 9 review finding 5)', () => {
    it('throws on TWO specimen entries (ambiguous which one --add-dir/cwd would actually pin to)', () => {
      expect(() =>
        buildMoodJudgePrompt(
          makeInput({
            images: [
              { label: 'specimen', path: '/tmp/a/specimen.png' },
              { label: 'specimen', path: '/tmp/b/specimen.png' },
            ],
          }),
        ),
      ).toThrow(/EXACTLY ONE 'specimen'/);
    });

    it("throws on TWO source entries (a naive .find() would silently take only the first, while --add-dir exposes BOTH directories)", () => {
      expect(() =>
        buildMoodJudgePrompt(
          makeInput({
            images: [
              { label: 'specimen', path: '/tmp/a/specimen.png' },
              { label: 'source', path: '/tmp/b/source.png' },
              { label: 'source', path: '/tmp/c/source-dup.png' },
            ],
          }),
        ),
      ).toThrow(/AT MOST ONE 'source'/);
    });
  });

  it('specimen-only + referenceDescription: embeds the resolved specimen path, omits a source-image line, includes the injection preamble', () => {
    const prompt = buildMoodJudgePrompt(makeInput());
    expect(prompt).toContain('You are a component of an automated brand-extraction tool');
    expect(prompt).toContain('specimen image:');
    expect(prompt).not.toContain('source image:');
    expect(prompt).toContain(UNTRUSTED_OPEN);
    expect(prompt).toContain(UNTRUSTED_CLOSE);
  });

  it('fences subjectId, palette, and referenceDescription BETWEEN the untrusted markers', () => {
    const prompt = buildMoodJudgePrompt(
      makeInput({ subjectId: 'my-subject-xyz', palette: ['#abcdef'], referenceDescription: 'a distinctive phrase' }),
    );
    // NOTE: INJECTION_PREAMBLE's own prose MENTIONS the marker text ("Everything
    // between the <<<UNTRUSTED_PAGE_DATA and UNTRUSTED_PAGE_DATA>>> markers...")
    // before the actual fenced block appears — so the first indexOf of each
    // marker lands inside that descriptive sentence, not the real block. Use
    // the LAST open marker (the actual block, which comes after the preamble)
    // and the first close marker at/after it.
    const openIdx = prompt.lastIndexOf(UNTRUSTED_OPEN);
    const closeIdx = prompt.indexOf(UNTRUSTED_CLOSE, openIdx);
    expect(openIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThan(openIdx);
    const fenced = prompt.slice(openIdx, closeIdx);
    expect(fenced).toContain('my-subject-xyz');
    expect(fenced).toContain('#abcdef');
    expect(fenced).toContain('a distinctive phrase');
  });

  it('specimen + source: embeds BOTH resolved image paths', () => {
    const prompt = buildMoodJudgePrompt(
      makeInput({
        images: [
          { label: 'specimen', path: '/tmp/onbrand-mood-test/specimen.png' },
          { label: 'source', path: '/tmp/onbrand-mood-test/source.png' },
        ],
        referenceDescription: undefined,
      }),
    );
    expect(prompt).toContain('specimen image:');
    expect(prompt).toContain('source image:');
  });

  it('names all 4 attributes in the output schema section', () => {
    const prompt = buildMoodJudgePrompt(makeInput());
    for (const attr of MOOD_ATTRIBUTES) expect(prompt).toContain(`"${attr}"`);
  });
});

// ---------------------------------------------------------------------------
// Production VisionJudge (createClaudeVisionJudge): real spawn/classify/parse
// code, exercised via the Step 11 fake-bins pattern — no network, no live
// claude, but the REAL subprocess machinery runs.
// ---------------------------------------------------------------------------

describe('createClaudeVisionJudge — production VisionJudge over a fake claude bin', () => {
  it('happy path: a schema-valid reply parses into all 4 attributes', async () => {
    const judge = createClaudeVisionJudge({ spawn: spawnerFor('claude-mood-ok'), timeoutMs: 10_000 });
    const sample = await judge(makeInput());
    expect(sample.hardStop).toBeUndefined();
    expect(sample.parsed).toBeDefined();
    for (const attr of MOOD_ATTRIBUTES) {
      expect(sample.parsed![attr].verdict).toBe('PASS');
      expect(sample.parsed![attr].rationale.length).toBeGreaterThan(0);
    }
  }, 20_000);

  it('feeds a full k>=3 judgeMood run end-to-end through the real fake-bin subprocess', async () => {
    const judge = createClaudeVisionJudge({ spawn: spawnerFor('claude-mood-ok'), timeoutMs: 10_000 });
    const result = await judgeMood(judge, makeInput(), { k: 3 });
    expect(result.overall).toBe('PASS');
  }, 30_000);

  it('CLI absent (ENOENT via a bogus command, the REAL default spawner): hardStop "cli-absent"', async () => {
    const judge = createClaudeVisionJudge({ claudeCommand: 'onbrand-no-such-claude-bin-xyz', timeoutMs: 10_000 });
    const sample = await judge(makeInput());
    expect(sample.hardStop).toBe('cli-absent');
    expect(sample.parsed).toBeUndefined();
  }, 20_000);

  it('auth-dead (nonzero + auth-shaped stderr): hardStop "auth-dead"', async () => {
    const judge = createClaudeVisionJudge({ spawn: spawnerFor('claude-auth-dead'), timeoutMs: 10_000 });
    const sample = await judge(makeInput());
    expect(sample.hardStop).toBe('auth-dead');
  }, 20_000);

  it('auth-dead with the marker on STDOUT ONLY (clean stderr) — the real observed shape on this claude CLI version — also classifies "auth-dead" (Step 9 review finding 1)', async () => {
    // Regression pin: this fake bin writes the "Failed to authenticate ...
    // 401 ..." text to STDOUT only, with a CLEAN stderr and a nonzero exit —
    // exactly the shape empirically observed running the real claude CLI
    // while building the live anchor test. The OLD stderr-only isAuthShaped
    // check would have misclassified this as generic 'nonzero'.
    const spawner = spawnerFor('claude-auth-dead-stdout');
    const raw = await spawner(['-p', 'irrelevant'], 10_000);
    expect(raw.stderr.trim()).toBe(''); // pins the empirical premise: stderr is clean
    expect(raw.stdout).toMatch(/401|authenticate/i);
    expect(raw.code).not.toBe(0);
    expect(classifySpawn(raw)).toBe('auth-dead');

    const judge = createClaudeVisionJudge({ spawn: spawner, timeoutMs: 10_000 });
    const sample = await judge(makeInput());
    expect(sample.hardStop).toBe('auth-dead');
    expect(sample.parsed).toBeUndefined();
  }, 20_000);

  it('end-to-end: a stdout-only auth failure reaches scoreMoodAxis as status "unavailable" (Step 9 review finding 1)', async () => {
    const judge = createClaudeVisionJudge({ spawn: spawnerFor('claude-auth-dead-stdout'), timeoutMs: 10_000 });
    const axisResult = await scoreMoodAxis(
      judge,
      makeInput({ subjectId: 'known-bad' }),
      makeInput({ subjectId: 'subject' }),
    );
    expect(axisResult.status).toBe('unavailable');
    expect(axisResult.reason).toBe(MOOD_AUTH_DEAD_REASON);
  }, 20_000);

  it('a quota-exhausted CLI response on stdout is unavailable rather than a live-test parse failure', async () => {
    const judge = createClaudeVisionJudge({
      spawn: async () => ({
        stdout: "You've hit your monthly spend limit",
        stderr: '',
        code: 1,
        timedOut: false,
      }),
      timeoutMs: 10_000,
    });
    const sample = await judge(makeInput());
    expect(sample.hardStop).toBe('auth-dead');
    expect(sample.raw).toContain('spend limit');
  });

  it('a nonzero exit whose stdout carries a REAL verdict merely mentioning a hex like "#4019a3" is NOT misclassified auth-dead — it is judged normally (Step 9 review finding 2)', async () => {
    // "4019a3" contains the literal substring "401", which classifySpawn's
    // shared marker match would otherwise flag as auth-shaped. The
    // vision-path tightening in createClaudeVisionJudge must let a genuinely
    // parseable reply win over that false-positive.
    const judge = createClaudeVisionJudge({ spawn: spawnerFor('claude-mood-hexcollision'), timeoutMs: 10_000 });
    const sample = await judge(makeInput());
    expect(sample.hardStop).toBeUndefined();
    expect(sample.parsed).toBeDefined();
    expect(sample.parsed!.mood.rationale).toContain('#4019a3');
    for (const attr of MOOD_ATTRIBUTES) expect(sample.parsed![attr].verdict).toBe('PASS');
  }, 20_000);

  it('plain nonzero exit (no auth stderr): neither parsed nor hardStop — a PARSE-FAILURE-shaped sample', async () => {
    const judge = createClaudeVisionJudge({ spawn: spawnerFor('exit-nonzero'), timeoutMs: 10_000 });
    const sample = await judge(makeInput());
    expect(sample.parsed).toBeUndefined();
    expect(sample.hardStop).toBeUndefined();
    expect(sample.raw).toMatch(/exited 3/);
  }, 20_000);

  it('plain nonzero diagnostics include stdout as well as stderr', async () => {
    const judge = createClaudeVisionJudge({
      spawn: async () => ({
        stdout: 'quota-independent stdout diagnostic',
        stderr: 'stderr warning',
        code: 3,
        timedOut: false,
      }),
      timeoutMs: 10_000,
    });
    const sample = await judge(makeInput());
    expect(sample.hardStop).toBeUndefined();
    expect(sample.raw).toContain('quota-independent stdout diagnostic');
    expect(sample.raw).toContain('stderr warning');
  });

  it('unparseable stdout: neither parsed nor hardStop', async () => {
    const judge = createClaudeVisionJudge({ spawn: spawnerFor('garbage-stdout'), timeoutMs: 10_000 });
    const sample = await judge(makeInput());
    expect(sample.parsed).toBeUndefined();
    expect(sample.hardStop).toBeUndefined();
  }, 20_000);

  it('a hanging CLI: the wrapper timer fires, the tree is killed, and the call resolves within a bounded time (no hang) as a parse-failure-shaped sample', async () => {
    const judge = createClaudeVisionJudge({ spawn: spawnerFor('hang'), timeoutMs: 300 });
    const start = Date.now();
    const sample = await judge(makeInput());
    const elapsed = Date.now() - start;
    expect(sample.parsed).toBeUndefined();
    expect(sample.hardStop).toBeUndefined();
    expect(sample.raw).toMatch(/TIMEOUT/);
    expect(elapsed).toBeLessThan(15_000); // hang.js sleeps 120s; must not wait for it
  }, 20_000);

  describe('spawned args shape (in-process recording spawner — no real subprocess needed for this assertion)', () => {
    function recordingSpawner(record: { args: string[]; cwd?: string }[]): ClaudeSpawner {
      return async (args, _timeoutMs, cwd) => {
        record.push({ args: [...args], cwd });
        const payload = Object.fromEntries(
          MOOD_ATTRIBUTES.map((a) => [a, { verdict: 'PASS', rationale: 'ok' }]),
        );
        return { stdout: JSON.stringify(payload), stderr: '', code: 0, timedOut: false };
      };
    }

    it('applies the unconditional deny-list + forced safe permission mode + Read-only allow', async () => {
      const record: { args: string[]; cwd?: string }[] = [];
      const judge = createClaudeVisionJudge({ spawn: recordingSpawner(record) });
      await judge(makeInput());

      expect(record).toHaveLength(1);
      const { args } = record[0]!;
      expect(args).toContain('--allowedTools');
      const allowIdx = args.indexOf('--allowedTools');
      expect(args[allowIdx + 1]).toBe('Read');
      expect(args).toContain('--disallowedTools');
      // Security-pinned firewall (NOT a spot-check). EXPECTED_VISION_DENY is the EXACT set
      // of tools that MUST be denied on a vision pass — Read is allowed for the screenshot,
      // so it is the one read-family tool excluded. Hard-coded as literals so changing the
      // firewall requires a deliberate, reviewed edit here. Two independent checks:
      //  (1) the deny-list CONSTANTS still equal the security pin — catches a drop from
      //      EXEC_DENY_TOOLS/READ_DENY_TOOLS/MCP_DENY_TOOLS itself; and
      //  (2) the actually-spawned args deny every pinned tool — catches a drop in the
      //      buildVisionPassArgs spread even if the constants are intact.
      const EXPECTED_VISION_DENY = [
        'Bash', 'BashOutput', 'KillShell', 'NotebookEdit', 'Write', 'Edit',
        'WebFetch', 'WebSearch', 'Task', 'Agent', 'Glob', 'Grep', 'mcp__*',
      ];
      const denyFromConstants = [
        ...EXEC_DENY_TOOLS,
        ...READ_DENY_TOOLS.filter((t) => t !== 'Read'),
        ...MCP_DENY_TOOLS,
      ];
      expect([...denyFromConstants].sort()).toEqual([...EXPECTED_VISION_DENY].sort());
      for (const tool of EXPECTED_VISION_DENY) {
        expect(args).toContain(tool);
      }
      const modeIdx = args.indexOf('--permission-mode');
      expect(modeIdx).toBeGreaterThan(-1);
      expect(args[modeIdx + 1]).toBe('default');
    });

    it('a single specimen image: --add-dir is exactly its directory, and cwd is pinned to it', async () => {
      const record: { args: string[]; cwd?: string }[] = [];
      const judge = createClaudeVisionJudge({ spawn: recordingSpawner(record) });
      await judge(makeInput({ images: [{ label: 'specimen', path: '/tmp/onbrand-mood-solo/specimen.png' }] }));

      const { args, cwd } = record[0]!;
      const addDirIdx = args.indexOf('--add-dir');
      expect(addDirIdx).toBeGreaterThan(-1);
      const expectedDir = path.resolve('/tmp/onbrand-mood-solo');
      expect(args[addDirIdx + 1]).toBe(expectedDir);
      expect(cwd).toBe(expectedDir);
    });

    it('two images in DIFFERENT directories: --add-dir covers BOTH, cwd is pinned to the first', async () => {
      const record: { args: string[]; cwd?: string }[] = [];
      const judge = createClaudeVisionJudge({ spawn: recordingSpawner(record) });
      await judge(
        makeInput({
          images: [
            { label: 'specimen', path: '/tmp/onbrand-mood-a/specimen.png' },
            { label: 'source', path: '/tmp/onbrand-mood-b/source.png' },
          ],
          referenceDescription: undefined,
        }),
      );

      const { args, cwd } = record[0]!;
      const dirA = path.resolve('/tmp/onbrand-mood-a');
      const dirB = path.resolve('/tmp/onbrand-mood-b');
      const addDirIdx = args.indexOf('--add-dir');
      expect(args[addDirIdx + 1]).toBe(dirA);
      expect(args[addDirIdx + 2]).toBe(dirB);
      expect(cwd).toBe(dirA); // pinned to the FIRST image's directory
    });

    it('the prompt embeds the resolved absolute specimen path', async () => {
      const record: { args: string[]; cwd?: string }[] = [];
      const judge = createClaudeVisionJudge({ spawn: recordingSpawner(record) });
      await judge(makeInput({ images: [{ label: 'specimen', path: 'relative/specimen.png' }] }));

      const { args } = record[0]!;
      const pIdx = args.indexOf('-p');
      const prompt = args[pIdx + 1]!;
      expect(prompt).toContain(path.resolve('relative/specimen.png'));
    });
  });

  it('a REAL subprocess with 2 images in DIFFERENT real directories (source + specimen, both --add-dir-worthy) completes successfully (Step 9 review finding 7c)', async () => {
    // Both paths are REAL, already-existing, and in DIFFERENT directories
    // (unlike REAL_FIXTURE_IMAGE's single-dir default) -- proves the actual
    // node-spawned child process handles a cwd pinned to the specimen's dir
    // plus a --add-dir'd second directory without erroring.
    const specimenPath = REAL_FIXTURE_IMAGE; // test/fixtures/extraction/screenshots/example.png
    const sourcePath = fileURLToPath(
      new URL('../docs/findings/eval-raw-extractions/benchmark/basecamp.viewport.png', import.meta.url),
    );
    const judge = createClaudeVisionJudge({ spawn: spawnerFor('claude-mood-ok'), timeoutMs: 10_000 });
    const sample = await judge(
      makeInput({
        images: [
          { label: 'specimen', path: specimenPath },
          { label: 'source', path: sourcePath },
        ],
        referenceDescription: undefined,
      }),
    );
    expect(sample.hardStop).toBeUndefined();
    expect(sample.parsed).toBeDefined();
  }, 20_000);
});
