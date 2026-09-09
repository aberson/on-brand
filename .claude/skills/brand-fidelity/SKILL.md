---
name: brand-fidelity
description: Run the on-brand brand-fidelity benchmark corpus (replay by default, --refresh for a live-extraction drift check), score every site with the colour/font/mood hybrid scorer, and emit a Markdown report — per-site fidelity, a slider-coverage rollup, a weak-region rollup, and a punch list, with czg controls weighted <0.5x, Monet mood-anchor presets excluded from the fidelity rollup, and a11y/CVD reported as its own axis. Use when asked to run the brand-fidelity benchmark, check for extraction regressions, or get a fidelity report for on-brand's from-url pipeline.
user-invocable: true
---

# Brand Fidelity

Scores how faithfully `onbrand from-url` reproduces a site's real brand — palette, accent,
light/dark backgrounds, type, and mood — against the frozen ground truth in
`docs/findings/eval-truth/`. Turns the manual operator eyeball that originally surfaced findings
#25/#26/#27 into a graded, rerunnable instrument (see `docs/benchmark.md`). Those
issue numbers refer to the private development archive; the findings are described
below and all scored evidence is included in this public repository.

## Commands

```
npx tsx src/eval/corpus-runner.ts                                # replay (default), writes docs/findings/brand-fidelity-report.md
npx tsx src/eval/corpus-runner.ts --out <path>                    # write the report elsewhere
npx tsx src/eval/corpus-runner.ts --no-mood                       # skip the mood axis entirely (fast, colour/font/structural only)
npx tsx src/eval/corpus-runner.ts --refresh                       # ALSO live-re-extract every http(s) corpus site and diff vs the committed fixture (separate drift gate; never feeds the scored fidelity numbers)
npx tsc --noEmit                                                  # typecheck
npm test                                                          # full suite incl. the corpus-runner + rollup + report tests
```

## What it does

1. **Loads the corpus** (`benchmark/corpus.ts` / `corpus.json`) — the v1 tier: 12 real sites +
   8 csszengarden controls, each tagged with an 8-axis palette-slider coordinate.
2. **Replays each site** through the REAL production pipeline with no boundary mock:
   `FixtureEngine` (`src/extract/from-url.ts`) reads the committed
   `docs/findings/eval-raw-extractions/benchmark/<id>.raw-extraction.json` fixture, then the
   production `normalize()` (`src/extract/normalize.ts`) builds the tokens/dark documents exactly
   as a real `onbrand from-url --no-llm` run would. This is deterministic and network-free — the
   default "replay" mode measures **normalize + pick + render fidelity**, not live extraction.
3. **Scores every site** with `scoreSite` (`src/eval/score.ts`): deterministic colour-fidelity
   (`color-fidelity.ts`, ΔE2000 via colorjs.io) + font-fidelity (`font-fidelity.ts`) + a CVD/a11y
   sub-check, against each site's frozen `docs/findings/eval-truth/<id>.truth.json`.
4. **Attempts the mood axis** (`mood-judge.ts`'s vision-judge machinery): calibrates ONCE against
   the Monet mismatch anchor before scoring any real site ("a scorer that can't fail garbage can't
   gate"). If `claude` is unavailable or unauthenticated, the WHOLE mood axis degrades to
   `UNAVAILABLE` with the real reason — never a fabricated score — and every other section of the
   report (colour, font, structural, a11y) still renders in full.
5. **Rolls up the suite** (`buildSuiteRollup` in `score.ts`): a weighted fidelity summary (czg
   controls weighted 0.4x, real sites 1x), an a11y/CVD summary (its own axis, never folded into
   fidelity), a slider-coverage rollup (8 palette axes x low/mid/high tercile), a weak-region
   rollup (which palette-space regions the tool is systematically weak in), and the three
   known-finding reproductions (#25/#26/#27 — see below).
6. **Renders the report** (`generateReport` in `report.ts`, a pure function of the scored results)
   and writes it to `docs/findings/brand-fidelity-report.md` (or `--out <path>`).

## Known findings this report reproduces (derived from real scores, never hard-coded)

- **#25 — GitHub's dark-background mismatch.** `color.semantic.bg` is always synthesized from the
  neutral ramp (`normalize.ts`'s `applySemantic`), never a literal copy of the extracted colour, but
  that alone is true for nearly every site (a non-discriminating signal caught by review). The real
  finding, `findMaterialBackgroundMismatches` (`score.ts`), REUSES `color-fidelity.ts`'s own
  calibrated `backgroundMatch` pass gate — only sites that genuinely FAIL it are flagged, sorted
  worst-first with a magnitude-scaled severity (on the real corpus: stripe/duolingo/kurzgesagt's dark
  sides, ~14/22 real-site sides otherwise clear the gate). github's own dark-bg ΔE (~2.7) actually
  CLEARS the gate — it is not a top-half offender — so `crossCheckIssue25` (`score.ts`) honestly
  reports this as a disagreement with the original operator eyeball rather than forcing github into
  the material list; the report's #25 section always shows this cross-check explicitly.
- **#26 — categorical-sameness.** `applyChart` in `normalize.ts` never overrides
  `chart.categorical.2`..`.8` past the default preset — `findCategoricalSameness` (`score.ts`)
  detects that the corpus ships a byte-identical 7-hex tail regardless of brand (only
  `categorical-1` tracks the seed) by grouping every site's ACTUAL shipped tail and checking
  whether the majority clears a 90% threshold.
- **#27 — the accent-vs-action-blue gap.** `findAccentRecoveryFailures` (`score.ts`) flags every
  real site whose colour-fidelity `accentRecovered` is false (the Step 5 accent-recovery gate) —
  includes github/nytimes/kurzgesagt among others.

## Design constraints (do not violate)

- **Replay is the default, scored path.** `--refresh` is a SEPARATE live-drift gate
  (`refreshCorpusSite`/`diffAgainstFixture` in `corpus-runner.ts`) that diffs a live re-extraction
  against the committed fixture — it never feeds the scored fidelity numbers, and a future
  auto-tune loop must never touch it (plan §6).
- **czg controls are weighted `CZG_CONTROL_WEIGHT` (0.4, < 0.5x) in the fidelity rollup** — a useful
  smoke signal, not real ground truth.
- **Monet mood-anchor presets (`templates/presets/monet-*`) are excluded from the fidelity rollup
  entirely** — they are not corpus entries at all (only used to calibrate the mood judge); there is
  no code path by which one could enter `SuiteRollup.fidelity`.
- **a11y/CVD is its own axis** — `summarizeA11y` reads only `fidelity.cvd`, never `.pass`.
- **The report generator (`report.ts`) is a pure function** — no network/LLM call happens inside it;
  all I/O (fixture reads, mood-judge calibration, screenshots) lives in `corpus-runner.ts`.

## evals/

`evals/evals.json` + `evals/test_scenarios.json` follow the skill-eval-setup convention
(`/skill-eval-setup brand-fidelity` regenerates them from this file).

## Relationship to other on-brand pieces

- Reuses `/judge-ui`'s vision-judge doctrine (`mood-judge.ts`, Step 9) rather than re-inventing it.
- `src/eval/capture.ts` (Step 8) provides the screenshot primitives the mood axis's per-site
  specimen capture uses.
- Feeds the plan's Step 11 (operator face-validity review) — the operator reads the generated
  report and confirms the weak-region rollup matches their own manual eyeball, or files specific
  miscalibration follow-ups.
