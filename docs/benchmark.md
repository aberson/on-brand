# Brand-fidelity evaluation

The benchmark measures how faithfully website proposals reproduce a fixed source
extraction. It separates deterministic color and font scores from optional
model-based judgments about mood and typography.

- `benchmark/corpus.json` is the source manifest; `benchmark/corpus.ts` validates
  its entries and coverage axes.
- Frozen extractions and source screenshots live under
  `docs/findings/eval-raw-extractions/benchmark/`. Ground-truth files live under
  `docs/findings/eval-truth/`.
- `src/eval/` contains the scorers, capture helpers, report renderer, and corpus runner.
- `.claude/skills/brand-fidelity/` contains the optional agent workflow.

Replay runs use fixed local fixtures instead of live websites. Tests exercise
calibration anchors, malformed inputs, and the production proposal pipeline so
output is checked against independent expectations. Live extraction and model
tests require explicit environment switches; offline tests do not require model
credentials or access to the private development archive.

Run the evaluation suites from the repository root:

```powershell
npm test -- test/eval.color-fidelity.test.ts test/eval.font-fidelity.test.ts test/eval.score.test.ts
npm test -- test/benchmark-fixtures.replay.test.ts
```

[Fixture provenance](../benchmark/FIXTURES.md) records source URLs and whether an
entry was harvested, live-extracted, or synthetic. The benchmark includes samples
of third-party websites; see [NOTICE.md](../NOTICE.md) for the licensing boundary.

The optional review sheet at `docs/findings/eval-truth/review-sheet.html` uses
relative screenshot paths and can be opened locally after cloning.
