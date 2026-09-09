# Benchmark replay fixtures — provenance

The hermetic replay input for the Brand-Fidelity benchmark (feature plan §6). Each
`docs/findings/eval-raw-extractions/benchmark/<id>.raw-extraction.json` is a frozen
`RawExtraction` for a v1 corpus entry. Scoring runs (later steps) never live-extract:
they replay these files through the production `normalize → build → report` pipeline
via the `FixtureEngine` / `ONBRAND_FAKE_EXTRACTION` seam, so the benchmark measures
normalize+pick+render fidelity against a fixed input rather than flaky live scrapes.

Replay determinism + full-set consumability are guarded by
[`test/benchmark-fixtures.replay.test.ts`](../test/benchmark-fixtures.replay.test.ts):
every fixture is parsed, shape-checked, and run through production `normalize()`; then
**every** fixture is replayed once through the spawned production CLI and asserted exit-0
+ offline (replayed colours deep-equal the committed fixture — a live fetch can't
reproduce a frozen palette). A representative subset (`stripe`, `louisvuitton`,
`czg-113`, `czg-rainbow`, and `basecamp` — the fragile chroma-fallback tie-break) is
replayed a second time and asserted byte-identical across the **whole** proposal tree
(guide.md, extraction-report.md, raw-extraction.json, every `brand/dist/*` incl.
manifest.json). Two negative anchors prove the green is falsifiable: a mutated replay
output must be caught, and a corrupt fixture must make the CLI exit non-zero.

## How each was produced

- **harvested** — copied from a fresh (2026-07-18) `onbrand from-url` run staged under
  `m1-proposals/` (untracked; not part of this commit). Source screenshot copied to
  `<id>.viewport.png` and the fixture's screenshot path rewritten repo-root-relative so
  offline replay resolves it (FixtureEngine resolves against `packageRoot()`).
- **live** — extracted here on 2026-07-18 via `onbrand from-url <url> --no-llm`
  (deterministic, no LLM; pinned clock `ONBRAND_NOW=2026-07-18T12:00:00Z`), then the
  proposal's `raw-extraction.json` + viewport PNG harvested the same way.
- **synthetic** — hand-authored `RawExtraction` (no live site; corpus url is
  `fixture://<id>`). A small controlled palette matching the skin name + the corpus
  slider coords (e.g. `czg-dark` = low lightness, `czg-warm` = warm hues). The non-colour
  signal (fonts/type/spacing) is a fixed shared csszengarden-DOM scaffold, so the skins
  isolate palette. No screenshot.

## Real sites (12) + czg controls (3 live) + synthetic skins (5)

| id | archetype | source | url used | colours | notes |
|---|---|---|---|---|---|
| stripe | fintech | harvested | https://stripe.com/ | 125 | rich palette; brand violet `#533afd` |
| github | developer-tool | harvested | https://github.com/ | 59 | |
| imprintgenius | ecommerce | harvested | https://www.imprintgenius.com/ | 11 | |
| basecamp | saas | live | https://basecamp.com | 4 | minimal landing; correct brand blue `#2377d2` captured but **no role evidence** — seed falls back on chroma. Real extraction, low signal. |
| nytimes | media | live | https://www.nytimes.com | 35 | |
| duolingo | education | live | https://www.duolingo.com | 18 | |
| kurzgesagt | media | live | https://kurzgesagt.org | 11 | |
| louisvuitton | luxury | live | https://www.louisvuitton.com | 3 | **not** bot-blocked — genuine monochrome LV palette (black text/accent, white bg) + real `Louis Vuitton Web` brand fonts. Low chroma is the true brand, not a failure. |
| spotify | media | live | https://www.spotify.com | 65 | |
| linear | developer-tool | live | https://linear.app | 55 | |
| robinhood | fintech | live | https://robinhood.com | 15 | |
| medium | media | live | https://medium.com | 11 | |
| czg-031 | control-czg | live | https://www.csszengarden.com/031/ | 7 | |
| czg-113 | control-czg | live | https://www.csszengarden.com/113/ | 5 | |
| czg-157 | control-czg | live | https://www.csszengarden.com/157/ | 7 | |
| czg-cool | control-czg | synthetic | fixture://czg-cool | 6 | cool blue/cyan accent, light neutral |
| czg-dark | control-czg | synthetic | fixture://czg-dark | 5 | near-black bg, light text, periwinkle accent |
| czg-warm | control-czg | synthetic | fixture://czg-warm | 6 | warm cream bg, orange accent + amber |
| czg-rainbow | control-czg | synthetic | fixture://czg-rainbow | 10 | 8 saturated hues, very low neutral |
| czg-luxe | control-czg | synthetic | fixture://czg-luxe | 6 | dark warm-charcoal, muted gold accent |

## Bot-blocks / swaps

None. All 9 remaining real sites and all 3 live csszengarden controls extracted cleanly
on the first attempt (2026-07-18) — no site was swapped or deferred. louisvuitton (the
plan's flagged bot-block risk, §8) extracted successfully as a genuine minimal
monochrome palette (see note above), so no same-archetype swap was needed.

## Coverage

12/12 real sites + 3/3 live czg controls + 5/5 synthetic skins = all 20 v1 corpus ids
have a committed, replay-verified fixture. (The 2 `tier: later` corpus entries — notion,
airbnb — are intentionally out of scope for v1.)
