# Step 8 decision: wrap dembrandt behind the adapter

**Date:** 2026-07-16 (build Step 8 spike; environment: dembrandt v0.23.1, Windows 11,
Node v24.14.0, worktree `build-step-onbrand-step8`. Fixture `extractedAt` stamps read
2026-07-17T03:0x because they are UTC — that is the evening of 2026-07-16 local.)
**Decision:** `VERDICT: wrap` — Step 9 (own engine) does not run; `engine/own.ts` stays a
pre-planned conditional fallback.

Pre-registered decision procedure (plan.md Step 8): run dembrandt via the adapter against 3 fixed
sites plus a garbage anchor; score schema coverage, wall time, and failure modes. `wrap` requires
the token-rich site to meet the minimum coverage set (colors w/ frequency + role evidence, font
stacks, type sizes, screenshots), the garbage anchor to yield a near-empty extraction, and no
disqualifying failure mode (crash, Windows-incompatible, >120s/site, non-permissive license).

All three real sites meet the minimum coverage set through `mapDembrandtOutput` (the heavy site
populates every RawExtraction field), the garbage anchor lands at 3 substantive observations
(threshold: <= 4), worst wall time is 90.8s (< 120s budget), and the license is MIT.

### Methodology note — what was fixed when (registration honesty)

plan.md pre-registered the procedure, the four inputs, the budget, and the shape of the bar
("a token-rich site must meet the minimum coverage set; garbage must yield near-empty
extraction") but did NOT enumerate which RawExtraction fields form the minimum set. The
field-level interpretation — `MINIMUM_COVERAGE_FIELDS = colors, colorRoleEvidence, fonts,
typeSizes, screenshots` (from the plan sentence's own list) and `NEAR_EMPTY_MAX = 4` (set from
the measured blank-page baseline) — was fixed in `adapter.ts` at scoring time, in the same
change as the outcome. Recorded plainly rather than rewritten. The outcome is robust to this
freedom: stripe.com satisfies ALL 8 coverage fields (so even the strictest reading passes for
"a token-rich site"), the excluded radii/shadows cells are verified honest-source gaps on the
other two sites (their pages declare no border-radius/box-shadow in the raw JSON), and the
real-vs-garbage gap (12–195 vs 3 substantive observations) is wide enough that no reasonable
near-empty threshold flips the anchor.

## License verification (Appendix C claim: MIT — CONFIRMED)

From `https://github.com/dembrandt/dembrandt` `LICENSE` (fetched 2026-07-16):

> MIT License
>
> Copyright (c) 2025 thevangelist

From the README:

> MIT. Do whatever you want with it.

`package.json` (v0.23.1): `"license": "MIT"`, `"engines": { "node": ">=18.0.0" }`,
`"bin": { "dembrandt": "dist/index.js", "dembrandt-mcp": "dist/mcp-server.js" }`.

## CLI flag verification (Appendix C claims — ALL CONFIRMED)

Verified twice: against the repo README and against `npx dembrandt --help` of the locally
installed v0.23.1. Verbatim from the installed CLI's help text:

- `--wcag` — "Analyze WCAG contrast ratios between palette colors"
- `--ai` — "Use ML model to predict brand primary color (experimental)"
- `--dark-mode` — "Extract colors from dark mode"
- Output formats claim also confirmed: `--json-only` (raw JSON to stdout), `--dtcg`
  (W3C Design Tokens), `--design-md`, `--brand-guide` (PDF), `--html`.

Flags the spike actually used: `--json-only` (pure JSON on stdout, progress spinner on stderr —
clean to parse) and `--screenshot <path>` (viewport PNG).

## Maintenance signals

- Latest release v0.23.1 on 2026-07-10 — six days before this spike.
- Open issues: 0. Actively developed; npm package `dembrandt`, install verified via
  `npm i -D dembrandt` (132 packages, 0 vulnerabilities).
- Runs on `playwright-core` (^1.60.0) + `commander`; ships an MCP server binary we do not use.
- Placed in `devDependencies` mirroring the repo's playwright precedent: on-brand is a private,
  never-published local CLI installed only via a full `npm install`, so the deps/devDeps split
  has no functional effect today. Revisit at Step 12 when `from-url` wires the engine into the
  production path (either move both to `dependencies` or keep this rationale current).
- Integration gotcha: dembrandt's `exports` map routes only `"."` (to `dist/index.js`, which is
  also the bin) and a few named subpaths — `require.resolve('dembrandt/package.json')` throws
  ERR_PACKAGE_PATH_NOT_EXPORTED. The wrapper resolves the bin as `require.resolve('dembrandt')`,
  pinned by a no-arg-constructor regression test.

## Per-site runs

Runs on 2026-07-16, default flags plus `--screenshot`. Raw stdout committed verbatim under
`test/fixtures/extraction/dembrandt/<site>.json`; mapped RawExtraction fixtures (the Step 10
normalizer inputs) under `test/fixtures/extraction/raw-extraction/<site>.json`; viewport PNGs
under `test/fixtures/extraction/screenshots/`.

| Site | Wall time | Raw JSON | Engine found |
|---|---|---|---|
| https://csszengarden.com/221/ (token-rich) | 16.9s | 14.8 KB | 7 detected + 6 palette colors, 3 semantic slots, 6 type styles, 17 spacing values, 2 links |
| https://stripe.com (heavy modern) | 34.7s | 101.9 KB | 73 detected colors, 5 semantic slots, 30 CSS custom props, 49 type styles, 20 spacing, 17 radii, 14 shadows, 13 gradients, 8 buttons |
| https://example.com (minimal real) | 15.4s | 4.2 KB | 3 detected colors, 2 semantic slots, 3 type styles, 3 spacing values |
| blank page (garbage anchor) | 90.8s | 2.0 KB | 1 detected color, 2 semantic slots (UA defaults), 1 spacing value, 0 typography |

## Schema coverage (scored by `coverageOf` in `src/extract/engine/adapter.ts`)

Computed by `npx tsx test/helpers/gen-extraction-fixtures.ts` and re-asserted offline in
`test/extract.dembrandt.test.ts` — the same exported scoring functions in both places, no
hand-scored numbers. Minimum set for the token-rich site: colors, colorRoleEvidence, fonts,
typeSizes, screenshots.

| Site | colors | roleEvidence | fonts | typeSizes | spacing | radii | shadows | screenshots | Min set | Substantive obs | Near-empty (<=4) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| csszengarden 221 | Y | Y | Y | Y | Y | n | n | Y | MET | 32 | no |
| stripe.com | Y | Y | Y | Y | Y | Y | Y | Y | MET | 195 | no |
| example.com | Y | Y | Y | Y | Y | n | n | Y | MET | 12 | no |
| blank (garbage) | Y | Y | n | n | Y | n | n | Y | not met | 3 | YES |

Notes on the two `n` cells for real sites: zengarden 221 and example.com genuinely declare no
border-radius or box-shadow (stripe, which has them, extracts both) — an honest-source gap, not
an engine gap. The garbage anchor's residual signal is UA defaults (black text on white, one
8px spacing) — exactly the near-empty shape the anchor was pre-registered to require.

## Failure modes observed

1. **Non-http(s) URLs hard-fail.** dembrandt rewrites schemeless input to `https://`, so literal
   `about:blank` dies with `EXTRACTION_FAILED` / exit 2 ("Cannot navigate to invalid URL", 4.6s).
   The garbage anchor was therefore realized as a locally served empty-body page — functionally
   about:blank with a navigable URL. The wrapper (`DembrandtEngine.extract`) now rejects
   non-http(s) URLs up front with a clear error, and the error envelope shape is pinned in an
   offline test.
2. **Blank/thin pages are slow, not broken.** The empty page took 90.8s (content-wait heuristics
   plus a navigation retry); real sites took 15–35s. Under the 120s/site budget, but from-url
   should keep the 120s timeout (wrapper default `DEFAULT_TIMEOUT_MS`). On timeout the wrapper
   owns the kill and reaps the WHOLE process tree (`taskkill /T /F` on Windows): dembrandt
   registers no signal handlers and drives a separate Chromium subprocess, so a naive
   single-process kill would orphan the browser. Accumulated child output is also capped
   (`MAX_OUTPUT_BYTES`, 64 MiB) — a pathological page degrades to a clean error, not RSS growth.
   Both paths are exercised offline via fake bins in `test/extract.dembrandt.test.ts`.
3. **"Main content selector timeout" warning** on example.com — non-fatal, extraction continues;
   printed to stderr only, absent from the JSON.
4. **Screenshots are opt-in and viewport-only.** No PNG without `--screenshot <path>`; not
   full-page. Fine for evidence + LLM brand-pick input; noted for Step 12's report layout.
5. **CSS custom properties carry no usage counts** (30 color-valued vars on stripe). The mapper
   skips them and says so in `RawExtraction.warnings` rather than silently dropping — flagged as
   a future enrichment (they are high-quality token-name signal).
6. **Windows/Node compatibility: clean.** Node >=18 required, ran on Node 24 + Windows 11 with
   the workspace's existing Playwright Chromium; no sandbox flags needed.

## What the wrapper maps (mapping doctrine)

`src/extract/engine/dembrandt.ts` — pure `mapDembrandtOutput` (offline-tested) + spawning
`DembrandtEngine`. Frequency backbone from `colors.detected[].count`; role evidence layered from
`colors.semantic` (background/text -> those roles; primary/secondary/accent -> accent),
`borders.combinations[]` (border), `gradients[].stopColors` (gradient), button backgrounds and
link colors (accent — interactive accents, not page background). Typography styles aggregate to
per-role font stacks and per-px type sizes ("16px (1.00rem)" and unitless line-height strings
parsed defensively). Spacing/radii keep dembrandt's `numericValue` + `count`; shadows stay raw
CSS strings (parsing belongs to the Step 10 normalizer).

## Reproduction

```powershell
# live re-spike (network + Chromium; NOT part of npm test)
npx dembrandt https://csszengarden.com/221/ --json-only --screenshot out.png
# regenerate mapped fixtures + coverage table from committed raw outputs (offline)
npx tsx test/helpers/gen-extraction-fixtures.ts
```
