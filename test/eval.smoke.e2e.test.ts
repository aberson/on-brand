/**
 * Brand-Fidelity Step 7 (#36) — end-to-end smoke gate: fixture-replay ->
 * in-process pipeline -> deterministic score, for ONE real site, with NO
 * boundary mock.
 *
 * ------------------------------------------------------- the wiring under test ---
 * `FixtureEngine.extract()` (production, `src/extract/from-url.ts` — the SAME
 * class the CLI's `ONBRAND_FAKE_EXTRACTION` hermetic-replay seam and
 * `test/benchmark-fixtures.replay.test.ts`'s spawned-CLI tier use) reads the
 * committed `docs/findings/eval-raw-extractions/benchmark/<id>.raw-extraction.json`
 * fixture straight off disk — this IS the real, un-mocked extraction boundary;
 * nothing here stands in for it. Its output feeds the production
 * `normalize()` (`src/extract/normalize.ts`), and `normalize()`'s result feeds
 * `scoreSite` (`src/eval/score.ts`, Step 7's skeleton), which internally calls
 * the SAME production accessors `eval.color-fidelity.test.ts` /
 * `eval.font-fidelity.test.ts` already exercise
 * (`scoreableProposalFromNormalize` / `scoreableFontsProposalFromNormalize`)
 * and the Step 5/6 scorers (`scoreColorFidelity` / `scoreFontFidelity` /
 * `scoreCvdAxis`). `FixtureEngine.extract()` + `normalize()` IS the production
 * extraction+normalize path (measurement-validity.md "assemble through the
 * production code path") — `runFromUrl`'s remaining stages (llm-assist,
 * build, report) are correctly never invoked here: they render/ship a
 * proposal dir, which scoring has no use for, and (for llm-assist
 * specifically) would reintroduce non-determinism this smoke gate must not
 * have. No CLI subprocess is spawned, no network is touched. The whole chain
 * is a pure function of (committed fixture, frozen truth).
 *
 * ------------------------------------------------------------ range, not brittle ---
 * Exact-value calibration locks already live in `eval.color-fidelity.test.ts`
 * (`ACCENT_CALIBRATION`) and `eval.font-fidelity.test.ts` (`ROLE_CALIBRATION`)
 * — this smoke test only proves the WIRING completes one real end-to-end
 * cycle and lands in a sane range, so it asserts bounds a broken pipeline
 * could actually violate (e.g. `deltaE <= accentMatch`, `score > overallPass`)
 * and deliberately omits assertions that hold for ANY input regardless of
 * pipeline health (ΔE2000 is non-negative by definition; `score` is already
 * clamped to `<=1` inside `similarityFromDeltaE`; "some role was scored"
 * depends only on the truth file, not on the shipped proposal) — a tautology
 * proves nothing about wiring health, per review finding #3.
 *
 * -------------------------------------------------------- the garbage anchors ---
 * Two independent garbage anchors, one per scored axis, each replayed through
 * the SAME `scoreSite` entrypoint as the positive case (never a separately-
 * constructed shortcut) — this is the producer/consumer-drift guard
 * (measurement-validity.md "assemble through the production code path"): a
 * bench that hand-assembles a *separate* negative-case shortcut could pass
 * while the real wiring silently breaks.
 *   - COLOUR: the pinned accent is swapped to a deliberately-wrong reference
 *     (mirrors `eval.color-fidelity.test.ts`'s Hacker-News-orange anchor).
 *     Proves `color.pass` genuinely drives `result.pass` down.
 *   - FONT: the pinned body font is swapped to a family stripe's shipped body
 *     family cannot match (mirrors `eval.font-fidelity.test.ts`'s
 *     Papyrus anchor). Proves `font.pass` ALSO genuinely drives `result.pass`
 *     down — the missing symmetric complement to the colour anchor (review
 *     finding #1): without this, a mutant silently dropping the font term
 *     from `scoreSite`'s `pass = color.pass && font.pass` (e.g. `pass:
 *     color.pass`) would pass every other test in this file.
 *
 * Each garbage anchor calls `replayThroughProduction` a second, independent
 * time — byte-identical to the positive case's call by construction (the
 * fixture replay is a pure function of the committed file), but NOT shared
 * state; only the truth object differs between the positive and negative
 * assertions within a test.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { truthTemplateSchema, type TruthTemplate } from '../benchmark/truth-scaffold.ts';
import type { RawExtraction } from '../src/extract/engine/adapter.ts';
import { FixtureEngine } from '../src/extract/from-url.ts';
import { normalize, type NormalizeResult } from '../src/extract/normalize.ts';
import {
  DEFAULT_THRESHOLDS,
  scoreCvdAxis,
  scoreableProposalFromNormalize,
} from '../src/eval/color-fidelity.ts';
import { scoreSite, type FidelityResult } from '../src/eval/score.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BENCH_DIR = path.join(REPO_ROOT, 'docs', 'findings', 'eval-raw-extractions', 'benchmark');
const TRUTH_DIR = path.join(REPO_ROOT, 'docs', 'findings', 'eval-truth');

const SITE_ID = 'stripe';

/** Read + schema-validate a REAL pinned truth file — the same production
 * contract every other eval test validates against. */
function readTruth(id: string): TruthTemplate {
  const raw = JSON.parse(readFileSync(path.join(TRUTH_DIR, `${id}.truth.json`), 'utf8'));
  return truthTemplateSchema.parse(raw);
}

/**
 * Replay a committed fixture through the REAL extraction boundary
 * (`FixtureEngine`, production `from-url.ts`) then the REAL production
 * `normalize()` — no boundary mock, no CLI subprocess, no network. Mirrors
 * `test/from-url.e2e.test.ts`'s own `FixtureEngine` usage
 * (`new FixtureEngine(fixturePath, REPO_ROOT)`).
 */
async function replayThroughProduction(id: string): Promise<{ extraction: RawExtraction; norm: NormalizeResult }> {
  const fixturePath = path.join(BENCH_DIR, `${id}.raw-extraction.json`);
  const engine = new FixtureEngine(fixturePath, REPO_ROOT);
  const extraction = await engine.extract();
  const norm = normalize(extraction);
  return { extraction, norm };
}

describe('score.ts smoke gate — one real site, fully wired, no boundary mock (Step 7, #36)', () => {
  it('stripe scores end-to-end (colour + font) through the fully wired pipeline and lands in a sane range', async () => {
    const { extraction, norm } = await replayThroughProduction(SITE_ID);
    const truth = readTruth(SITE_ID);

    const result: FidelityResult = scoreSite(SITE_ID, norm, extraction, truth);

    expect(result.siteId).toBe(SITE_ID);

    // Colour: a real hit (calibration-locked at ~8.4 elsewhere) — asserted
    // here only as a RANGE a broken pipeline could actually violate: at/under
    // the SAME gate scoreAccentFidelity itself uses (`<=`, not `<`), and
    // comfortably above the pass threshold. Never the brittle exact figure.
    expect(result.color.accent.deltaE).toBeLessThanOrEqual(DEFAULT_THRESHOLDS.accentMatch);
    expect(result.color.accentRecovered).toBe(true);
    expect(result.color.score).toBeGreaterThan(DEFAULT_THRESHOLDS.overallPass);
    expect(result.color.pass).toBe(true);

    // Font: stripe scores heading/body "lookalike" + mono "kept" (calibration-
    // locked elsewhere) — here only assert none of it came back
    // silently-wrong. `font.pass === true` already implies scoredRoles is
    // non-empty (font-fidelity.ts's own vacuous-pass guard), so a separate
    // `scoredRoles.length > 0` assertion would be redundant.
    expect(result.font.silentlyWrongRoles).toEqual([]);
    expect(result.font.pass).toBe(true);

    // The a11y/CVD axis rode along but is reported SEPARATELY (never folded
    // into `pass`). Don't just shape-check the count (3 types x 2 surfaces is
    // a hardcoded structural constant scoreCvdAxis always emits, even on
    // garbage input, so it can't catch e.g. the historical "only
    // backgroundLight checked" bug) — independently recompute the SAME call
    // score.ts makes and deep-equal it against what scoreSite returned
    // (mirrors eval.color-fidelity.test.ts's "independently recomputed, not
    // read back" pattern for backgroundDark), then assert the real
    // distinguishability verdict.
    const independentCvd = scoreCvdAxis(scoreableProposalFromNormalize(norm), DEFAULT_THRESHOLDS);
    expect(result.cvd).toEqual(independentCvd);
    expect(result.cvd.allDistinguishable).toBe(true);

    // The composite is the AND of the two deterministic axes.
    expect(result.pass).toBe(true);
  });

  it('the COLOUR garbage anchor fails within the SAME wired path (score.ts), not a separately-constructed shortcut', async () => {
    const { extraction, norm } = await replayThroughProduction(SITE_ID);
    const realTruth = readTruth(SITE_ID);

    // Deliberately-wrong reference (Hacker News' signature orange, mirroring
    // eval.color-fidelity.test.ts's garbage anchor) — every other pinned
    // field is left as the real, schema-validated stripe truth; only accent
    // is swapped.
    const colorGarbageTruth: TruthTemplate = {
      ...realTruth,
      pinned: {
        ...realTruth.pinned,
        accent: { hex: '#ff6600', source: 'operator-judgment', confidence: 'high' },
      },
    };

    const result = scoreSite(SITE_ID, norm, extraction, colorGarbageTruth);

    // Same wiring (same extraction/norm shape as the positive case above,
    // reconstructed via the same replay call) — only the truth's accent
    // differs.
    expect(result.color.accent.pass).toBe(false);
    expect(result.color.accent.deltaE).toBeGreaterThan(50);
    expect(result.color.pass).toBe(false);

    // The composite must not be rescued by font fidelity (untouched by the
    // colour swap, still passes on its own) — colour failing is sufficient to
    // fail the whole per-site result, proving `color.pass` genuinely drives
    // `result.pass`.
    expect(result.font.pass).toBe(true);
    expect(result.pass).toBe(false);
  });

  it('the FONT garbage anchor fails within the SAME wired path — the symmetric complement proving font.pass ALSO drives result.pass (review finding #1)', async () => {
    const { extraction, norm } = await replayThroughProduction(SITE_ID);
    const realTruth = readTruth(SITE_ID);
    const realBody = realTruth.pinned.fonts.body;
    expect(realBody, 'sanity: stripe pins a real (non-null) body font').not.toBeNull();

    // Deliberately-wrong reference (mirrors eval.font-fidelity.test.ts's own
    // Papyrus garbage anchor) — stripe's shipped body family ("Inter", a
    // genuine Söhne->Inter substitution) shares no lookalike relationship
    // with "Papyrus". Every other pinned field, including accent, stays the
    // real schema-validated stripe truth.
    const fontGarbageTruth: TruthTemplate = {
      ...realTruth,
      pinned: {
        ...realTruth.pinned,
        fonts: {
          ...realTruth.pinned.fonts,
          body: { ...realBody!, family: 'Papyrus', lookalikes: [] },
        },
      },
    };

    const result = scoreSite(SITE_ID, norm, extraction, fontGarbageTruth);

    // Same wiring as the positive case — only the truth's pinned body font
    // differs.
    expect(result.font.body?.classification).toBe('silently-wrong');
    expect(result.font.silentlyWrongRoles).toContain('body');
    expect(result.font.pass).toBe(false);

    // Colour is UNTOUCHED by the font swap and still passes on its own — a
    // mutant that silently dropped the font term from `scoreSite`'s
    // `pass = color.pass && font.pass` (e.g. `pass: color.pass`) would read
    // `result.pass === true` here and pass every OTHER test in this file;
    // this is the assertion that catches exactly that mutant.
    expect(result.color.pass).toBe(true);
    expect(result.pass).toBe(false);
  });

  it('a scaffolded (unpinned) truth does NOT vacuously pass through scoreSite — the Step-6 vacuous-pass guard propagates through the orchestrator (czg-031)', async () => {
    const { extraction, norm } = await replayThroughProduction('czg-031');
    const truth = readTruth('czg-031');
    expect(truth.status, 'sanity: czg-031 is still scaffolded, never pinned').not.toBe('pinned');
    expect(truth.pinned.fonts, 'sanity: an unpinned template carries no font truth').toEqual({
      heading: null,
      body: null,
      mono: null,
    });

    const result = scoreSite('czg-031', norm, extraction, truth);

    expect(result.font.scoredRoles).toEqual([]);
    expect(result.font.pass).toBe(false);
    // Colour independently happens to pass for this scaffolded control (its
    // pinned accent is still the scaffolder's own extractor guess, which
    // trivially matches the extraction it was derived from) — asserted here
    // SPECIFICALLY to isolate that it is the FONT vacuous-pass guard, not a
    // colour failure, forcing the composite false: the orchestrator must not
    // vacuously pass even when the other axis would have.
    expect(result.color.pass).toBe(true);
    expect(result.pass).toBe(false);
  });
});
