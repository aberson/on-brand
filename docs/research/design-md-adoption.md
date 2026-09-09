# DESIGN.md adoption investigation (2026-07-21)

**Question:** Should on-brand adopt Google Stitch's DESIGN.md (https://stitch.withgoogle.com/docs/design-md/overview) as a standard?

**Verdict: Do not adopt DESIGN.md as *the* standard — DTCG `tokens.json` stays the source of truth. Optionally adopt it as one more *derived* `dist/` output (a small emitter), which is a cheap, reversible hedge on future agent-tooling interop. Reject replacing `guide.md` or the DTCG source format outright.**

Method: 17-agent research workflow — 5 research arms (spec repo deep-read, Stitch docs, ecosystem/adoption
sweep, DTCG-standards relationship, on-brand repo grounding), a 25-row field mapping, a 6-option adoption
memo, and adversarial verification of 10 load-bearing claims against primary sources (2 CONFIRMED,
7 PARTLY-TRUE with corrections folded in below, 1 CONFIRMED-with-nuance).

---

## 1. What DESIGN.md actually is (primary-source verified)

- A format spec from **Google Labs**, open-sourced ~2026-04-10 at
  [google-labs-code/design.md](https://github.com/google-labs-code/design.md). **Apache-2.0 confirmed**
  via the LICENSE file. ~26.2k stars; CLI `@google/design.md` at 0.3.0 (four releases Apr–Jun 2026);
  last push 2026-07-14.
- One markdown file: **optional** YAML front matter (only `name` is required; `version`/`description`/
  `colors`/`typography`/`rounded`/`spacing`/`components` optional) + a markdown prose body whose sections
  *should* (spec's word — not *must*) follow a fixed order: Overview, Colors, Typography, Layout,
  Elevation & Depth, Shapes, Components, Do's and Don'ts.
- **Token shape is flat CSS strings (`colors: {surface: "#f9f9ff"}`), NOT DTCG `$value`/`$type`**
  (confirmed against `docs/spec.md` + the `paws-and-paths` example). DTCG appears only as a **one-way
  export target**: `npx @google/design.md export --format dtcg` (also Tailwind v3/v4). There is **no
  tokens.json → DESIGN.md import path** anywhere in the official tooling.
- No standards-form JSON Schema exists; conformance is enforced by the CLI's TypeScript linter (9 rules
  incl. WCAG AA contrast, broken-ref, section-order). Nuance: `packages/cli/src/linter/spec-config.yaml`
  is a machine-readable "single source of truth" that generates both `docs/spec.md` and the linter rules.
- Status is explicitly **alpha**: "The spec, token schema, and CLI are under active development. Expect
  changes to the format as it matures." Semver is still 0.x. Single-vendor governance (Google Labs), no
  standards body — unlike AGENTS.md, which was multi-vendor from inception and was donated to the Linux
  Foundation. Issue-tracker responsiveness is unproven (oldest open issue, #65, unanswered since May 2).

## 2. Adoption reality check (the load-bearing finding)

**No tool documented by its own maker natively auto-discovers DESIGN.md.**

- Claude Code's own docs auto-load **only CLAUDE.md**; DESIGN.md is never mentioned
  ([code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory)). Claims that Claude Code /
  Cursor / Gemini CLI / Antigravity "natively read" it trace exclusively to SEO/marketing blogs, not
  vendor docs. Real usage today = convention: put it at repo root and reference it from an
  already-auto-loaded file (CLAUDE.md, `.cursor/rules`) or prompt it explicitly.
- [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) (~103k stars) is easy to
  misread as an ecosystem list — it is a **gallery of reverse-engineered brand lookalike files**
  (Stripe, Apple, Tesla…), not tools that consume the format.
- [anthropics/skills#1008](https://github.com/anthropics/skills/issues/1008) proposes DESIGN.md support
  in Claude Code's frontend-design skill — **undecided** as of this check.
- Google's own first-party skill ([stitch-skills/design-md](https://github.com/google-labs-code/stitch-skills/tree/main/skills/design-md))
  *generates* a DESIGN.md from a Stitch project via MCP; it does not consume arbitrary ones.
- Stitch itself supports export **and** import of DESIGN.md (official announcement); the exact in-app
  menu path is only secondary-sourced.
- No production case study or measured install base found; adoption signal is GitHub-star mindshare +
  announcement-cycle content, ~3.5 months old.

## 3. Format mapping vs the brand/ contract (25 rows, highlights)

- **Lossless (3):** `rounded` scale ↔ dimension tokens; Typography prose section; Do's-and-Don'ts prose
  section.
- **Lossy (12):** colors (bare CSS string vs DTCG object; DESIGN.md admits named colors we don't),
  typography (composite object vs our decomposed fontFamily/dimension/fontWeight/number leaves), spacing
  (untyped Dimension-or-number vs explicit `$type`), components (property bag vs flat tokens feeding
  `components.css`), prose sections with naming/scope mismatches.
- **DESIGN.md-only (5):** required machine-readable `name`; `fontFeature`/`fontVariation` (no DTCG
  `$type` in our closed list covers OpenType/variable-font axes); component property-bags with state
  variants (`button-primary-hover` as sibling keys); `{path.to.token}` in-prose reference syntax;
  prose physically adjacent to its token category.
- **on-brand-only (5):** `modes.dark.json` dark overlay (DESIGN.md has **no mode/theme concept at
  all** — confirmed against the closed front-matter field list); motion tokens (`duration`,
  `cubicBezier`); structured `shadow` `$type` (DESIGN.md's Elevation & Depth is prose-only);
  `$extensions` vendor passthrough + `extends` preset inheritance; the self-verifying 6-emitter dist/
  registry + provenance manifest + stale-dist drift gate.

Net: DESIGN.md is **DTCG-adjacent, not DTCG-isomorphic**; its own community framing is "tokens inform
DESIGN.md, not vice versa" — a downstream agent-facing layer, not a token-pipeline replacement.

## 4. Options considered

| # | Option | Effort | Verdict |
|---|---|---|---|
| 1 | New emitter → `brand/dist/DESIGN.md` (tokens-only v1, derived from tokens.json) | ~150–290 LOC + golden test (registry at `src/build/compile.ts:160,176-183,194-201`) | **recommend (optional)** |
| 2 | from-url proposals get DESIGN.md | Free once (1) ships — `from-url.ts:435-439` runs every registered emitter | **recommend (rides 1)** |
| 3 | Importer: `init` ingests an existing DESIGN.md | Large — new YAML dep + normalize.ts-scale mapper; official CLI already does DESIGN.md→DTCG one-way (shell out instead) | **defer** |
| 4 | Replace `guide.md` with DESIGN.md | Large, 5+ read/write sites | **reject** — breaks the operator-owned-prose contract + guide-render's fence architecture |
| 5 | Replace DTCG tokens.json as source format | Very large | **reject** — trades stable W3C spec + strict zod validation for an alpha single-vendor format missing shadow/motion/dark-mode |
| 6 | Do nothing / wait | Zero | acceptable — the cost of waiting is only forfeiting a near-free hedge |

Notes on option 1: emitters receive only `EmitterContext` (tokens — `compile.ts:147-158`), so v1 would be
tokens-only; folding `guide.md` prose in (the "most vital part" per DESIGN.md's own philosophy) is a v2
decision. Also relevant: **dembrandt already ships a native `--design-md` flag** that our wrapper doesn't
use (`docs/findings/dembrandt-spike.md:57-58`; we invoke `--json-only`) — an alternative near-free path
to a DESIGN.md in from-url proposals, though an emitter keeps tokens.json as the single source.

## 5. Risks if we build against it

- Alpha/0.x spec with an explicit "expect changes" disclaimer — emitter rework risk.
- Near-term payoff unproven: our actual consumers (Claude Code sessions) read CLAUDE.md, not DESIGN.md;
  the interop value is a bet on future native support (watch anthropics/skills#1008).
- Single-vendor stewardship; if Google deprioritizes Stitch, the format could stall.
- Naming collision: the unaffiliated "designtoken.md" (Designless) product is a different thing.

## 6. Re-check triggers

Revisit this verdict if any of: (a) anthropics/skills#1008 resolves in favor; (b) any major agent ships
filename-convention auto-discovery of DESIGN.md; (c) the spec reaches 1.0 / leaves alpha; (d) a
tokens.json → DESIGN.md official import path appears.

---

*Sources: primary — github.com/google-labs-code/design.md (README, docs/spec.md, PHILOSOPHY.md, LICENSE,
examples/, releases, issues via gh api), blog.google Stitch DESIGN.md announcement, code.claude.com docs,
anthropics/skills#1008, VoltAgent/awesome-design-md, google-labs-code/stitch-skills; secondary (flagged
as such in-line) — designmd.app, mindwiredai.com, designwhine.com, dsebastien.net, betterstack.com,
wavespeed.ai, designsystemscollective.com. The Stitch docs pages themselves are JS-rendered SPA routes
that could not be fetched headlessly; the GitHub repo's docs/spec.md is the generated source of the same
spec text. Full structured findings: workflow run wf_33e2c1b5-488 (17 agents, 0 errors).*
