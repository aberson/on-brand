/**
 * Adversarial vision-judge for the mood/temperature/type axis (Brand-Fidelity
 * plan §5/§6/§9, Step 9, #38) — reuses the `/judge-ui` doctrine (independent
 * vision-judge sub-verdict, k>=3, parse-fail aborts, UNCERTAIN escalates,
 * calibrate-against-known-bad-before-comparing; see
 * `dev/.claude/skills/judge-ui/SKILL.md` + the shared
 * `dev/.claude/skills/_shared/judge-core.md` doctrine, archetype
 * "Adversarial / refuter" x dimension "aesthetic mood fidelity", §2/§3) for
 * on-brand's own vision axis: does a generated brand SPECIMEN genuinely match
 * its REFERENCE mood (a real site's screenshot, or — for the Monet calibration
 * set, Step 4 — a named reference painting's documented palette/mood)?
 *
 * ------------------------------------------------------- the judge-ui adapter ---
 * This module IS the plan's Step 9 "judge-ui adapter for on-brand": it brings
 * `/judge-ui`'s engine-level doctrine into on-brand's own code pipeline, the
 * way toybox's `/uat-ui` is `/judge-ui`'s PROJECT adapter for a browser-driven
 * flow (bring-up + auth + a flow spec). on-brand has no browser-driven UAT
 * flow to hand `/judge-ui` — it has a static specimen render to vision-judge
 * in-process — so its adapter shape is a CODE MODULE (this file) rather than
 * a `/judge-ui --adapter onbrand` skill-level project adapter. Whether Step
 * 10's `/brand-fidelity` skill calls this module directly (the current
 * expectation — `scoreMoodAxis` is the intended entry point) or additionally
 * shells out to the `/judge-ui` SKILL for a project-adapter-shaped invocation
 * is a STEP 10 DECISION, not resolved here; nothing in this module blocks
 * either path.
 *
 * ---------------------------------------------------- provisional gap (documented) ---
 * `/judge-ui`'s honesty invariant #1 ("the judge may not PASS on pixels alone
 * — every PASS must be corroborated by an out-of-band read-back") has no
 * analogue here YET: `VisionJudgeInput.palette` is prose-only context handed
 * to the judge alongside the pixels, not a structured read-back the judge is
 * required to cross-check its own PASS against (e.g. echo the dominant hue it
 * observed and diff it against `palette` programmatically). A lightweight
 * read-back would harden this; it is a deferrable Step 10+ enhancement, not
 * blocking Step 9's acceptance (which is about the mood AXIS existing with
 * k>=3/parse-fail-abort/UNCERTAIN-escalate/calibration, not a read-back).
 *
 * ------------------------------------------------------- the injectable seam ---
 * A vision verdict is inherently NON-DETERMINISTIC and needs the `claude` CLI
 * (subscription OAuth) + network — so it cannot be unit-tested deterministically
 * in CI (measurement-validity: an LLM judge call is not a good unit-test
 * subject). Per judge-core doctrine + this repo's existing pattern
 * (`src/extract/llm.ts`'s `ClaudeSpawner` seam, exercised offline via
 * `nodeScriptSpawner` + the Step 8 fake-bins), the LLM call itself is an
 * INJECTABLE `VisionJudge` function (below). Everything in THIS module —
 * k>=3 sampling, per-attribute median/majority aggregation, parse-fail ABORT,
 * UNCERTAIN escalation, and the calibration gate — is a DETERMINISTIC
 * mechanism built on top of that seam, and is exhaustively unit-tested
 * (`test/eval.mood-judge.test.ts`) by injecting a FAKE `VisionJudge` that
 * returns controlled verdicts. The PRODUCTION `VisionJudge`
 * (`createClaudeVisionJudge`, bottom of this file) calls the real `claude` CLI
 * through the exact SAME spawn/classify/deny-list machinery
 * `src/extract/llm.ts` already uses and has already proven works for
 * screenshot-reading passes (`makeDefaultSpawner`, `classifySpawn`,
 * `EXEC_DENY_TOOLS`/`READ_DENY_TOOLS`/`MCP_DENY_TOOLS`/`SAFE_PERMISSION_MODE`,
 * all now exported from `llm.ts` for this reuse — see that file's header for
 * why: one source of truth for a security-critical firewall, per
 * `dev/.claude/rules/code-quality.md`). This is the "assemble through the
 * production code path" measurement-validity rule: the live anchor test
 * (`test/eval.mood-judge.e2e.test.ts`) exercises this SAME production judge,
 * not a hand-rolled sibling.
 *
 * The `claude` CLI has NO `--image` flag (verified in `llm.ts`'s header,
 * v2.1.170): the model reads a screenshot PNG itself via the Read tool, scoped
 * with `--allowedTools Read` + `--add-dir <dir>` + a pinned child `cwd`. This
 * module reuses that EXACT mechanism (`buildVisionPassArgs` below generalizes
 * it from one image to up to two — a source/reference shot and a specimen
 * shot, each possibly in a different directory) rather than inventing new
 * image-passing; the `claude` CLI's ability to read an image via Read was
 * already exercised in production by `llm.ts`'s color-pick/aesthetic passes,
 * so no new capability needed proving here beyond generalizing to N images.
 *
 * ------------------------------------------------------------ verdict shape ---
 * Per attribute (`temperature` / `value` / `saturation` / `mood` — plan §5
 * "structured palette -> per-attribute verdict"), a single vision-judge call
 * emits one of `PASS` / `FAIL` / `UNCERTAIN`. `judgeMood()` samples the SAME
 * judge k>=3 times (never single-sample — measurement-validity: "a
 * single-sample judge scored the same build 10 and 5") and aggregates each
 * attribute's k raw verdicts via a MEDIAN over an ordinal mapping
 * (FAIL=-1, UNCERTAIN=0, PASS=1) — for odd k this is exactly a majority vote
 * (judge-core §5.6 "categorical -> majority vote, ties escalate"), and it
 * generalizes the "median" language measurement-validity also uses. A median
 * of exactly 0 (a tie, or UNCERTAIN dominating) aggregates to `ESCALATE` —
 * NEVER silently bucketed as pass or fail. The overall verdict for a subject
 * follows `/judge-ui`'s own resolution order: any attribute FAIL -> overall
 * FAIL; else any attribute ESCALATE -> overall ESCALATE; else PASS.
 *
 * ------------------------------------------------------------ parse-fail-abort ---
 * If ANY of the k samples fails to parse into a well-formed per-attribute
 * verdict object, `judgeMood()` THROWS `MoodJudgeParseError` immediately — it
 * NEVER defaults an unparseable sample to a score of 0 or drops it silently
 * (measurement-validity: "a parse-fail->0 silently drags means toward zero").
 * There is deliberately no retry-and-fall-back-to-heuristic here (unlike
 * `llm.ts`'s from-url passes): there is no sane heuristic standing in for a
 * vision judgment, and a flaky/unparseable sample on a live vision call is
 * itself the signal that the instrument needs operator attention, not a
 * quiet degrade. A CLI-ABSENT/AUTH-DEAD condition is a SEPARATE, non-throwing
 * failure class from a parse failure — see "graceful degradation" below.
 *
 * -------------------------------------------------------------- calibration ---
 * `runCalibratedMoodJudgment()` is the GATE: it FIRST judges a known-bad
 * anchor (the Monet mismatch preset, Step 4) and REFUSES (throws
 * `MoodJudgeCalibrationError`, never silently proceeding) to run the
 * comparative judgment unless the known-bad anchor genuinely scored `FAIL`
 * overall — "a scorer that can't fail garbage can't gate" (measurement-validity
 * + judge-core §7 discrimination guard). This must run before ANY comparative
 * use of the judge, per the plan's Step 9 done-when.
 *
 * ------------------------------------------------------- graceful degradation ---
 * `scoreMoodAxis()` is the top-level entry point a caller (the future
 * `/brand-fidelity` skill, Step 10) should use: it mirrors `runLlmAssist`'s
 * "never crash, degrade with an explicit reason" contract for CLI absence —
 * if the `claude` CLI is not installed/authenticated, the mood axis is
 * reported `status: 'unavailable'` with a reason, NEVER a fabricated PASS/FAIL
 * score. Crucially this degrade path is narrow: it catches ONLY
 * `VisionJudgeUnavailableError` (cli-absent/auth-dead, detected the same way
 * `llm.ts`'s `classifySpawn` detects it); a parse failure or a failed
 * calibration gate still propagates LOUD (thrown), because "the CLI wasn't
 * there" and "the CLI answered but we can't trust the answer" are different
 * failure classes that must not collapse into the same quiet skip.
 */

import path from 'node:path';
import { z } from 'zod';
import {
  classifySpawn,
  extractJson,
  makeDefaultSpawner,
  stderrTail,
  LLM_DEFAULT_TIMEOUT_MS,
  EXEC_DENY_TOOLS,
  READ_DENY_TOOLS,
  MCP_DENY_TOOLS,
  SAFE_PERMISSION_MODE,
  type ClaudeSpawner,
  type SpawnResult,
} from '../extract/llm.ts';
import { INJECTION_PREAMBLE, untrustedBlock, untrustedLine } from '../extract/llm-prompts.ts';

// --- attributes + verdict vocabulary -----------------------------------------

/** The 4 mood axes judged per plan §5 ("structured palette -> per-attribute
 * verdict (temperature/value/saturation/mood)"). ONE source of truth for the
 * attribute set — both the prompt builder and the zod reply schema below
 * derive from this list, so a future attribute addition can't drift between
 * what is asked for and what is parsed. */
export const MOOD_ATTRIBUTES = ['temperature', 'value', 'saturation', 'mood'] as const;
export type MoodAttribute = (typeof MOOD_ATTRIBUTES)[number];

/** One-line, human-readable definition per attribute — reused by the prompt
 * builder so the judged vocabulary is defined in exactly one place. */
const ATTRIBUTE_DEFINITIONS: Record<MoodAttribute, string> = {
  temperature: 'overall warm vs cool color temperature',
  value: 'overall light vs dark tonal register',
  saturation: 'overall vivid/saturated vs muted/desaturated chroma register',
  mood: 'the overall aesthetic/atmosphere/feeling (e.g. contemplative, energetic, harsh, playful)',
};

/** A single raw per-attribute verdict. `UNCERTAIN` is a first-class, HONEST
 * answer (judge-core §5.5 "abstain option") — never a fallback the judge is
 * discouraged from using. */
export const VERDICTS = ['PASS', 'FAIL', 'UNCERTAIN'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** The DETERMINISTIC aggregate of >=1 raw verdicts for one attribute (or the
 * overall subject). `ESCALATE` is the aggregation's own abstain state — it is
 * NEVER silently mapped to PASS or FAIL by any caller in this module. */
export type AggregatedVerdict = 'PASS' | 'FAIL' | 'ESCALATE';

// --- the injectable VisionJudge seam ------------------------------------------

export interface VisionJudgeImage {
  /** `'source'` — the real site / reference-painting screenshot (absent for a
   * subject scored purely against a textual `referenceDescription`, e.g. the
   * Monet calibration set, which has no bundled painting image).
   * `'specimen'` — the generated brand tokens rendered via `onbrand preview`
   * (`src/eval/capture.ts` produces both). Always exactly one `'specimen'`
   * entry; at most one `'source'` entry. */
  label: 'source' | 'specimen';
  /** Filesystem path to the PNG (absolute or resolvable from `process.cwd()`). */
  path: string;
}

export interface VisionJudgeInput {
  /** A short id for logging/evidence (e.g. a corpus site id or preset name). */
  subjectId: string;
  /** 1-2 images — see `VisionJudgeImage`. Must include exactly one `'specimen'` entry. */
  images: VisionJudgeImage[];
  /** The specimen's trusted, tool-generated palette hexes — structured
   * grounding given to the judge ALONGSIDE the pixels (never itself a
   * substitute for looking at the image). Fenced as untrusted content in the
   * production prompt regardless (defense-in-depth: it is several
   * transformation steps removed from a scraped page, but still ultimately
   * page-derived for a real corpus site). */
  palette: readonly string[];
  /** A textual description of the reference mood/aesthetic to judge the
   * specimen against. REQUIRED when `images` has no `'source'` entry (the
   * Monet calibration set: there is no bundled reference-painting image, so
   * the judge is grounded in a written description of the reference painting
   * instead — see `templates/presets/monet-mismatch-anchor/PROVENANCE.md`).
   * Optional (additive context) when a `'source'` image is also present. */
  referenceDescription?: string;
}

/** One raw sample from a single vision-judge call. Exactly one of `parsed` /
 * `hardStop` is meaningful:
 *   - `parsed` set: the reply parsed into a well-formed per-attribute verdict
 *     object — the happy path.
 *   - `hardStop` set: the `claude` CLI itself is unavailable (absent binary or
 *     dead auth) — a SEPARATE failure class from a parse failure (see file
 *     header "graceful degradation"); `judgeMood` throws
 *     `VisionJudgeUnavailableError` immediately on this, without burning the
 *     remaining k-1 samples.
 *   - neither set: the CLI ran but the reply could not be parsed/trusted
 *     (nonzero exit, timeout, no JSON, schema mismatch) — a PARSE FAILURE;
 *     `judgeMood` throws `MoodJudgeParseError`.
 * `raw` is always populated (even on a hard stop, best-effort) so an abort
 * error can show a human what actually came back. */
export interface VisionJudgeSample {
  parsed?: Record<MoodAttribute, { verdict: Verdict; rationale: string }>;
  raw: string;
  hardStop?: 'cli-absent' | 'auth-dead';
}

/** The injectable seam. Production: `createClaudeVisionJudge()`. Tests inject
 * a fake returning controlled `VisionJudgeSample`s — see
 * `test/eval.mood-judge.test.ts`. */
export type VisionJudge = (input: VisionJudgeInput) => Promise<VisionJudgeSample>;

// --- error classes (the 3 distinct failure classes this module distinguishes) ---

/** Thrown by `judgeMood` when >=1 of the k samples did not parse. The whole
 * judgment aborts — never a partial/garbage score. */
export class MoodJudgeParseError extends Error {
  constructor(
    readonly subjectId: string,
    readonly sampleIndex: number,
    readonly k: number,
    rawExcerpt: string,
  ) {
    super(
      `judgeMood(${subjectId}): sample ${sampleIndex + 1}/${k} did not parse into a verdict — ` +
        `ABORTING the whole judgment (a parse failure is never silently scored). ` +
        `Raw reply excerpt: ${rawExcerpt.slice(0, 500)}`,
    );
    this.name = 'MoodJudgeParseError';
  }
}

/** Thrown by `judgeMood` when a sample reports the `claude` CLI itself is
 * unavailable (absent binary / dead auth). `scoreMoodAxis` catches ONLY this
 * error class to degrade gracefully — see file header. `rawExcerpt` carries
 * the sample's `raw` text (Step 9 review finding 6: the "raw always populated
 * for diagnosis" contract must hold on the hard-stop path too, not just the
 * parse-fail path). */
export class VisionJudgeUnavailableError extends Error {
  constructor(
    readonly subjectId: string,
    readonly hardStop: 'cli-absent' | 'auth-dead',
    readonly rawExcerpt: string,
  ) {
    super(
      `judgeMood(${subjectId}): claude CLI unavailable (${hardStop}) — the mood axis cannot be judged` +
        (rawExcerpt.trim() !== '' ? ` (raw: ${rawExcerpt.slice(0, 300)})` : ''),
    );
    this.name = 'VisionJudgeUnavailableError';
  }
}

/** Thrown by `runCalibratedMoodJudgment` when the known-bad anchor did not
 * score `FAIL` overall — the judge is miscalibrated and MUST NOT be trusted
 * for a comparative run until fixed. */
export class MoodJudgeCalibrationError extends Error {
  constructor(readonly calibration: CalibrationResult) {
    super(
      calibration.reason ??
        'mood-judge calibration failed: the known-bad anchor did not score FAIL',
    );
    this.name = 'MoodJudgeCalibrationError';
  }
}

// --- deterministic aggregation (pure; exhaustively unit-tested) --------------

/** Minimum samples per judgment. NEVER single-sample (measurement-validity). */
export const MIN_SAMPLES = 3;

const ORDINAL: Record<Verdict, number> = { FAIL: -1, UNCERTAIN: 0, PASS: 1 };

/**
 * Aggregate k raw verdicts for ONE attribute via the median of their ordinal
 * mapping (FAIL=-1, UNCERTAIN=0, PASS=1). For odd k this is exactly a majority
 * vote (e.g. [FAIL,FAIL,PASS] -> median -1 -> FAIL); a median of exactly 0
 * (a tie, or UNCERTAIN dominating) aggregates to ESCALATE, never silently
 * bucketed. For an even k the two middle ordinal values are averaged, so a
 * genuine 2-2 split (e.g. [PASS,PASS,FAIL,FAIL]) also lands on 0 -> ESCALATE.
 */
export function aggregateVotes(votes: readonly Verdict[]): AggregatedVerdict {
  if (votes.length === 0) {
    throw new Error('aggregateVotes: at least one vote is required');
  }
  const values = votes.map((v) => ORDINAL[v]).sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const median =
    values.length % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
  if (median > 0) return 'PASS';
  if (median < 0) return 'FAIL';
  return 'ESCALATE';
}

/** Resolve an overall verdict from a set of per-attribute aggregates, using
 * `/judge-ui`'s own resolution order: any FAIL wins outright; else any
 * ESCALATE wins; else PASS. Mirrors judge-ui's "Any stage FAIL -> FAIL; any
 * stage UNCERTAIN -> escalate; else PASS" (SKILL.md "Resolve the verdict"). */
export function resolveOverall(verdicts: readonly AggregatedVerdict[]): AggregatedVerdict {
  if (verdicts.length === 0) {
    throw new Error('resolveOverall: at least one verdict is required');
  }
  if (verdicts.some((v) => v === 'FAIL')) return 'FAIL';
  if (verdicts.some((v) => v === 'ESCALATE')) return 'ESCALATE';
  return 'PASS';
}

// --- the core mechanism: k>=3 sample + aggregate + parse-fail-abort ----------

export interface AttributeAggregate {
  attribute: MoodAttribute;
  verdict: AggregatedVerdict;
  /** The k raw per-sample verdicts for this attribute (evidence, judge-core §5.2). */
  votes: Verdict[];
  /** The k raw per-sample rationale strings for this attribute (evidence). */
  rationale: string[];
}

export interface MoodJudgeResult {
  subjectId: string;
  k: number;
  attributes: Record<MoodAttribute, AttributeAggregate>;
  overall: AggregatedVerdict;
  /** The raw k samples, for full auditability. */
  samples: VisionJudgeSample[];
}

/**
 * Sample `judge` k>=3 times against `input` and deterministically aggregate a
 * per-attribute + overall verdict. THROWS (never silently scores):
 *   - `VisionJudgeUnavailableError` the moment any sample reports the claude
 *     CLI is unavailable (short-circuits — does not burn the remaining
 *     samples on a CLI that has already proven absent/dead);
 *   - `MoodJudgeParseError` the moment any sample fails to parse.
 * Both checks run PER SAMPLE as they arrive (not after collecting all k), so
 * a hard-stop or parse failure on sample 1 of 3 aborts immediately.
 */
export async function judgeMood(
  judge: VisionJudge,
  input: VisionJudgeInput,
  options: { k?: number } = {},
): Promise<MoodJudgeResult> {
  const k = options.k ?? MIN_SAMPLES;
  if (!Number.isInteger(k) || k < MIN_SAMPLES) {
    throw new Error(
      `judgeMood(${input.subjectId}): k must be an integer >= ${MIN_SAMPLES} (measurement-validity: never single-sample); got ${String(k)}`,
    );
  }

  const samples: VisionJudgeSample[] = [];
  for (let i = 0; i < k; i++) {
    const sample = await judge(input);
    if (sample.hardStop !== undefined) {
      throw new VisionJudgeUnavailableError(input.subjectId, sample.hardStop, sample.raw);
    }
    if (sample.parsed === undefined) {
      throw new MoodJudgeParseError(input.subjectId, i, k, sample.raw);
    }
    samples.push(sample);
  }

  const attributes = {} as Record<MoodAttribute, AttributeAggregate>;
  for (const attribute of MOOD_ATTRIBUTES) {
    const votes = samples.map((s) => s.parsed![attribute].verdict);
    const rationale = samples.map((s) => s.parsed![attribute].rationale);
    attributes[attribute] = { attribute, verdict: aggregateVotes(votes), votes, rationale };
  }

  const overall = resolveOverall(MOOD_ATTRIBUTES.map((a) => attributes[a].verdict));

  return { subjectId: input.subjectId, k, attributes, overall, samples };
}

// --- calibration gate ---------------------------------------------------------

export interface CalibrationResult {
  /** True iff the known-bad anchor genuinely scored FAIL overall. */
  ok: boolean;
  /** The full judgment against the known-bad anchor (evidence). */
  result: MoodJudgeResult;
  /** Populated iff `!ok` — why calibration failed. */
  reason?: string;
}

/**
 * Judge the known-bad anchor and report whether the judge correctly failed
 * it. Does NOT throw on a miscalibrated judge (a caller that only wants the
 * calibration READING, not the gate, can call this directly) — the REFUSAL
 * behavior lives in `runCalibratedMoodJudgment` below.
 */
export async function calibrateAgainstKnownBad(
  judge: VisionJudge,
  knownBadInput: VisionJudgeInput,
  options: { k?: number } = {},
): Promise<CalibrationResult> {
  const result = await judgeMood(judge, knownBadInput, options);
  if (result.overall === 'FAIL') return { ok: true, result };
  return {
    ok: false,
    result,
    reason:
      `mood-judge calibration FAILED: known-bad anchor '${knownBadInput.subjectId}' scored ` +
      `'${result.overall}' overall (expected FAIL) — the judge cannot separate known-good from ` +
      `known-bad (judge-core §7 discrimination guard: "a rubric/grader must separate known-good ` +
      `from known-bad ... or the rubric is non-discriminating and is parked, not trusted"). ` +
      `Refusing to run any comparative judgment until this is fixed.`,
  };
}

/**
 * THE GATE. Calibrate against `knownBadInput` FIRST; if it does not score
 * FAIL, THROW `MoodJudgeCalibrationError` and never invoke `judge` against
 * `subjectInput` at all — "a scorer that can't fail garbage can't gate"
 * (measurement-validity). Only on a passing calibration does the comparative
 * judgment against `subjectInput` run. This must be called before ANY
 * comparative use of the judge (plan Step 9 done-when).
 */
export async function runCalibratedMoodJudgment(
  judge: VisionJudge,
  knownBadInput: VisionJudgeInput,
  subjectInput: VisionJudgeInput,
  options: { k?: number } = {},
): Promise<{ calibration: CalibrationResult; result: MoodJudgeResult }> {
  const calibration = await calibrateAgainstKnownBad(judge, knownBadInput, options);
  if (!calibration.ok) {
    throw new MoodJudgeCalibrationError(calibration);
  }
  const result = await judgeMood(judge, subjectInput, options);
  return { calibration, result };
}

// --- graceful degradation (the top-level entry point) -------------------------

export type MoodAxisStatus = 'judged' | 'unavailable';

/** Distinct per-`hardStop` reasons (Step 9 review finding 4: the earlier
 * single generic reason collapsed cli-absent and auth-dead together — a
 * regression against `llm.ts`'s own sibling handling, which keeps
 * `CLI_ABSENT_REASON` and `AUTH_DEAD_REASON` separate). */
export const MOOD_CLI_ABSENT_REASON =
  'the claude CLI was not found (spawn error / ENOENT) — mood axis unavailable, no score fabricated';
export const MOOD_AUTH_DEAD_REASON =
  'the claude CLI is present but authentication failed (nonzero exit with auth-shaped output) — mood axis unavailable, no score fabricated';

export interface MoodAxisResult {
  status: MoodAxisStatus;
  /** Present when `status === 'unavailable'`. */
  reason?: string;
  /** Present when `status === 'judged'`. */
  calibration?: CalibrationResult;
  /** Present when `status === 'judged'`. */
  result?: MoodJudgeResult;
}

/**
 * The top-level, never-crash entry point a caller (the future
 * `/brand-fidelity` skill) should use. Mirrors `runLlmAssist`'s "explicit
 * degrade, never a fabricated score" contract: if `judge` reports the CLI is
 * unavailable (`VisionJudgeUnavailableError`), returns `{status:
 * 'unavailable', reason}` — the mood axis is UNAVAILABLE/skipped, exactly as
 * the from-url pipeline degrades when the CLI is absent. A parse failure or a
 * failed calibration gate is NOT caught here — both propagate loudly (thrown),
 * because those are genuine instrument defects that must surface, not a
 * routine environmental absence.
 */
export async function scoreMoodAxis(
  judge: VisionJudge,
  knownBadInput: VisionJudgeInput,
  subjectInput: VisionJudgeInput,
  options: { k?: number } = {},
): Promise<MoodAxisResult> {
  try {
    const { calibration, result } = await runCalibratedMoodJudgment(
      judge,
      knownBadInput,
      subjectInput,
      options,
    );
    return { status: 'judged', calibration, result };
  } catch (err) {
    if (err instanceof VisionJudgeUnavailableError) {
      const reason = err.hardStop === 'cli-absent' ? MOOD_CLI_ABSENT_REASON : MOOD_AUTH_DEAD_REASON;
      return { status: 'unavailable', reason };
    }
    throw err;
  }
}

// --- the vision-judge prompt (injection-firewalled, mirrors llm-prompts.ts) ---

/**
 * Validate `images` before use: EXACTLY ONE `'specimen'` entry, AT MOST ONE
 * `'source'` entry. Step 9 review finding 5: a malformed image set (e.g. a
 * duplicate `'source'` label) must not silently proceed — a naive `.find()`
 * takes only the first match, but `--add-dir` (built from ALL image paths in
 * `createClaudeVisionJudge`) would still expose every directory to the
 * model's Read tool, including one the prompt never mentions. Throwing here
 * (called first, from `buildMoodJudgePrompt`) means `buildVisionPassArgs`
 * never runs on an unvalidated image set.
 */
function validateVisionJudgeImages(
  images: readonly VisionJudgeImage[],
  subjectId: string,
): { specimen: VisionJudgeImage; source?: VisionJudgeImage } {
  const specimens = images.filter((i) => i.label === 'specimen');
  const sources = images.filter((i) => i.label === 'source');
  if (specimens.length !== 1) {
    throw new Error(
      `VisionJudgeInput(${subjectId}): images must include EXACTLY ONE 'specimen' entry (found ${specimens.length})`,
    );
  }
  if (sources.length > 1) {
    throw new Error(
      `VisionJudgeInput(${subjectId}): images must include AT MOST ONE 'source' entry (found ${sources.length})`,
    );
  }
  return { specimen: specimens[0]!, source: sources[0] };
}

/**
 * Build the mood-judgment prompt. Reuses `INJECTION_PREAMBLE` +
 * `untrustedBlock`/`untrustedLine` from `llm-prompts.ts` (one source of truth
 * for the injection-firewall shape — see that file's header for the rule this
 * mirrors: page-derived data is DATA to judge, never instructions to follow).
 */
export function buildMoodJudgePrompt(input: VisionJudgeInput): string {
  const { specimen: specimenImage, source: sourceImage } = validateVisionJudgeImages(
    input.images,
    input.subjectId,
  );
  const hasDescription =
    input.referenceDescription !== undefined && input.referenceDescription.trim() !== '';
  if (sourceImage === undefined && !hasDescription) {
    throw new Error(
      `buildMoodJudgePrompt(${input.subjectId}): a 'source' image or a referenceDescription is required to judge the specimen against`,
    );
  }

  const referenceImageSection =
    sourceImage !== undefined
      ? [
          '',
          'A SOURCE reference screenshot is also provided (the real site or a reference image).',
          'Use the Read tool to view it (the claude CLI has no image flag -- read the file',
          'yourself):',
          `  source image: ${path.resolve(sourceImage.path)}`,
        ].join('\n')
      : '';

  const attributeLines = MOOD_ATTRIBUTES.map((a) => `  - ${a}: ${ATTRIBUTE_DEFINITIONS[a]}.`);

  const untrustedLines = [
    untrustedLine('subject id', input.subjectId),
    untrustedLine('specimen palette hexes', input.palette.join(', ')),
  ];
  if (hasDescription) {
    untrustedLines.push(untrustedLine('reference description', input.referenceDescription));
  }

  return [
    INJECTION_PREAMBLE,
    '',
    'TASK: judge whether a generated brand SPECIMEN genuinely matches a REFERENCE',
    'mood, across four INDEPENDENT attributes. Use the Read tool to view the specimen',
    'image (the claude CLI has no image flag -- read the file yourself):',
    `  specimen image: ${path.resolve(specimenImage.path)}`,
    referenceImageSection,
    '',
    'Judge EACH attribute SEPARATELY, comparing the specimen against the reference',
    '(the source image and/or the reference description below). For each attribute',
    'decide:',
    '  PASS       - the specimen genuinely matches the reference on this attribute.',
    '  FAIL       - the specimen clearly does NOT match the reference on this attribute.',
    '  UNCERTAIN  - genuinely ambiguous. Use this HONESTLY when you are not confident;',
    '               it is not a fallback to avoid answering, and a low-confidence call',
    '               belongs here, never forced into PASS or FAIL.',
    '',
    'The four attributes:',
    ...attributeLines,
    '',
    untrustedBlock(untrustedLines),
    '',
    'Output schema (JSON only, one entry per attribute, exactly these 4 keys):',
    '{"temperature": {"verdict": "PASS|FAIL|UNCERTAIN", "rationale": "one sentence"},',
    ' "value": {"verdict": "...", "rationale": "..."},',
    ' "saturation": {"verdict": "...", "rationale": "..."},',
    ' "mood": {"verdict": "...", "rationale": "..."}}',
  ].join('\n');
}

// --- production VisionJudge (real `claude` CLI) -------------------------------

const attributeVerdictSchema = z.object({
  verdict: z.enum(VERDICTS),
  rationale: z.string().min(1),
});

/** Reply schema DERIVED from `MOOD_ATTRIBUTES` (one source of truth: the
 * attribute set the prompt asks for is exactly the set this schema parses). */
const moodReplySchema = z.object(
  Object.fromEntries(MOOD_ATTRIBUTES.map((a) => [a, attributeVerdictSchema])) as Record<
    MoodAttribute,
    typeof attributeVerdictSchema
  >,
);

/** Extract + schema-validate a mood reply from raw stdout. Returns a
 * `parsed`-less sample (never throws) on any unusable shape — no JSON object,
 * or a JSON object that doesn't match the 4-attribute schema. Shared by BOTH
 * the happy path and the auth-dead-tightening path below (one source of
 * truth for "what counts as a usable reply"). */
function parseMoodReply(stdout: string): VisionJudgeSample {
  const json = extractJson(stdout);
  if (json === undefined) return { raw: stdout };
  const parsed = moodReplySchema.safeParse(json);
  if (!parsed.success) return { raw: stdout };
  return { raw: stdout, parsed: parsed.data };
}

/** A best-effort raw excerpt for a hard-stop sample: prefers the actual
 * stdout+stderr text (e.g. the auth-shaped message, on whichever stream it
 * landed on); falls back to the spawn error's own message when neither
 * stream produced anything (a genuine ENOENT never writes to either stream).
 * Step 9 review finding 6: the auth message on this CLI version prints to
 * STDOUT, so `raw` must not be built from stderr alone (it would be empty). */
function hardStopRaw(res: SpawnResult): string {
  const streams = `${res.stdout}\n${res.stderr}`.trim();
  if (streams !== '') return streams;
  return res.spawnError?.message ?? '';
}

/**
 * Args + cwd for a vision pass: `--allowedTools Read` scoped to the union of
 * every image's directory (deduplicated; each added via `--add-dir`, which
 * `claude --help` documents as variadic: `--add-dir <directories...>` — a
 * single flag occurrence followed by N directory tokens, verified against
 * this machine's `claude --help` v2.1.170), `cwd` pinned to the FIRST image
 * directory (bounds the child's ambient Read root exactly as `llm.ts`'s
 * single-image `buildPassArgs` does — the other dir(s) remain reachable only
 * via the explicit `--add-dir`, never the wider inherited tree), and the same
 * unconditional exec/mutation/MCP deny-list + forced safe permission mode
 * `llm.ts` applies to every pass (reused via its now-exported constants — see
 * that file's header for why duplicating this list would be a defect).
 */
function buildVisionPassArgs(
  prompt: string,
  imagePaths: readonly string[],
  extraArgs?: readonly string[],
): { args: string[]; cwd?: string } {
  const dirs = Array.from(new Set(imagePaths.map((p) => path.dirname(path.resolve(p)))));
  const args = ['-p', prompt];
  let cwd: string | undefined;
  if (dirs.length > 0) {
    args.push('--allowedTools', 'Read');
    args.push(
      '--disallowedTools',
      ...EXEC_DENY_TOOLS,
      ...READ_DENY_TOOLS.filter((t) => t !== 'Read'),
      ...MCP_DENY_TOOLS,
    );
    args.push('--add-dir', ...dirs);
    cwd = dirs[0];
  } else {
    args.push('--disallowedTools', ...EXEC_DENY_TOOLS, ...READ_DENY_TOOLS, ...MCP_DENY_TOOLS);
  }
  args.push('--permission-mode', SAFE_PERMISSION_MODE);
  if (extraArgs !== undefined) args.push(...extraArgs);
  return { args, cwd };
}

export interface ClaudeVisionJudgeOptions {
  /** Command to spawn (default: env `ONBRAND_CLAUDE_BIN`, else `'claude'`). */
  claudeCommand?: string;
  /** Per-call wall-clock budget in ms (default `LLM_DEFAULT_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Override the whole subprocess seam (offline tests: `nodeScriptSpawner`
   * from `llm.ts`, exercising the REAL spawn/parse/classify code with a fake
   * bin — mirrors `test/extract.llm.test.ts`'s pattern). */
  spawn?: ClaudeSpawner;
  /** Extra args appended to every invocation (e.g. `--model`). */
  extraArgs?: string[];
}

/**
 * The PRODUCTION `VisionJudge`: spawns the real `claude` CLI per call (one
 * call = one sample; `judgeMood` calls this k>=3 times). Never throws itself
 * — classifies the spawn outcome exactly as `llm.ts` does and returns the
 * appropriate `VisionJudgeSample` shape (`hardStop` for cli-absent/auth-dead,
 * `parsed` on a schema-valid JSON reply, neither on any other unusable
 * reply — nonzero exit, timeout, unparseable JSON, schema mismatch — which
 * `judgeMood` then treats as a parse failure and aborts on). Deliberately NO
 * retry-per-sample (see file header "parse-fail-abort").
 *
 * ------------------------------------------------- vision-path auth-dead tightening ---
 * Step 9 review finding 2: `classifySpawn`'s `auth-dead` classification is a
 * MARKER MATCH over stdout+stderr (`'401'`, `'403'`, `'authentication'`, …) —
 * shared with `llm.ts`'s text-only passes, where the reply is never a JSON
 * blob a false-positive marker could plausibly appear inside. On the VISION
 * path a genuine verdict's `rationale` can legitimately mention a hex like
 * `"#4019a3"` (contains the substring `"401"`), so a nonzero exit whose
 * stdout carries a REAL, parseable JSON reply must NOT be routed to the quiet
 * `hardStop`/`scoreMoodAxis`-absorbed degrade path merely because a marker
 * happened to match — that would silently swallow a real (if oddly-exit-coded)
 * verdict as "claude unavailable". So: `auth-dead` only short-circuits to
 * `hardStop` when `extractJson(res.stdout)` finds NOTHING; if a JSON object
 * IS present, it is parsed/validated exactly like the happy path — a
 * genuinely invalid shape still falls through as a loud parse-fail (no
 * `parsed`), never a quiet skip. This narrows ONLY this module's own
 * classification of `'auth-dead'` results; it does NOT touch `classifySpawn`/
 * `isAuthShaped` themselves (shared with `llm.ts`'s `runLlmAssist`, whose
 * text-only replies have no such false-positive risk and whose retry/degrade
 * semantics are unrelated to this module).
 */
export function createClaudeVisionJudge(options: ClaudeVisionJudgeOptions = {}): VisionJudge {
  const command = options.claudeCommand ?? process.env.ONBRAND_CLAUDE_BIN ?? 'claude';
  const spawner = options.spawn ?? makeDefaultSpawner(command);
  const timeoutMs = options.timeoutMs ?? LLM_DEFAULT_TIMEOUT_MS;

  return async (input: VisionJudgeInput): Promise<VisionJudgeSample> => {
    const prompt = buildMoodJudgePrompt(input);
    const imagePaths = input.images.map((i) => i.path);
    const { args, cwd } = buildVisionPassArgs(prompt, imagePaths, options.extraArgs);
    const res = await spawner(args, timeoutMs, cwd);
    const cls = classifySpawn(res);

    if (cls === 'cli-absent') return { raw: hardStopRaw(res), hardStop: 'cli-absent' };
    if (cls === 'auth-dead') {
      if (extractJson(res.stdout) === undefined) {
        return { raw: hardStopRaw(res), hardStop: 'auth-dead' };
      }
      // A parseable payload IS present despite the marker match — see the
      // "vision-path auth-dead tightening" doc above. A real reply wins.
      return parseMoodReply(res.stdout);
    }
    if (cls === 'timeout') {
      return { raw: `TIMEOUT after ${timeoutMs}ms waiting for claude CLI` };
    }
    if (cls === 'nonzero') {
      return {
        raw: `claude CLI exited ${String(res.code)}: ${stderrTail(`${res.stdout}\n${res.stderr}`)}`,
      };
    }

    return parseMoodReply(res.stdout);
  };
}
