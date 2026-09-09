# Step 2 decision: hand-rolled compiler, not Style Dictionary v4

**Date:** 2026-07-16 (build Step 2)
**Decision:** `VERDICT: hand-rolled` — the compile pipeline (`src/build/compile.ts`) is the
plan-pre-approved hand-rolled compiler. Style Dictionary is NOT added as a dependency.

## What was verified, from Style Dictionary's own docs

Plan §9 table row / Appendix C flagged the claim "full 2025.10 support lands in v5" as
UNVERIFIED research to be checked at Step 2 against the tool's own documentation. Checked
2026-07-16:

1. **styledictionary.com/info/dtcg/** (the project's own DTCG page):
   > "As of version 4, Style Dictionary has first-class support for the DTCG format."

   but, on the stable spec revision on-brand is pinned to (plan §2: "DTCG JSON, stable spec
   2025.10"):
   > "the latest format 2025.10 does not have full support yet in Style Dictionary."
   > "This is a work in progress in v5."

2. **style-dictionary/style-dictionary#1590 — "Support for DTCG v2025.10"** (open issue,
   milestone 5.0, high priority at research time):
   > "Style Dictionary needs a few updates to align with the newly-published v2025.10 version"

   The gap list it enumerates includes the new **color module**, **border & shadow** (need
   color-module compatibility), **gradient**, **duration/motion tokens** (#1471), and
   **resolvers**. The issue was still in the planning phase (no assignee, no branch).

So the research claim held up: v4's first-class DTCG support targets the pre-stable draft;
2025.10 alignment is v5 work that had not shipped as a stable base for us to adopt.

## Why hand-rolled wins here (not just "SD is behind")

- **The named v4→2025.10 gaps overlap our schema.** on-brand's token types include `shadow`,
  `duration`, and `cubicBezier` (src/schema/types.ts `TOKEN_TYPES`) — three of the areas
  issue #1590 lists as needing work. Adopting v4 means adopting a compiler that is
  documented as incomplete for exactly the value types we emit.
- **SD's carried weight would go unused.** Style Dictionary's value is alias/reference
  resolution (`{color.brand.1}`), the transform pipeline, and its built-in formats. on-brand
  v1 uses none of these: the schema forbids `{`/`}` in names and validates values as
  literals (no aliases), values pass through as authored (plan §9.10 — "emit what the tokens
  hold"), and every output is a custom format either way (plan §2). What remains — flatten a
  validated tree and print lines — is the ~200-line compiler the plan pre-approved.
- **Our real complexity already lives in `src/schema/`.** Validation, `extends` resolution,
  and the `modes.dark.json` overlay merge (a local documented convention — DTCG 2025.10 has
  no standardized theming story, plan §4) shipped in Step 1. SD has no modes/extends story
  that matches; we would still run all of that code before handing SD a resolved tree.
- **No unjustified deps** (workspace rule). A large dependency whose engine features are all
  bypassed adds supply-chain and upgrade surface for zero capability.

**Revisit trigger:** if a later phase needs alias tokens or SD-ecosystem interop, re-evaluate
against Style Dictionary v5 once its 2025.10 base is released stable. The emitter interface
in `src/build/compile.ts` (flat token list in, files out) is the seam a swap would happen
behind — emitters would become SD custom formats with minimal change (plan §2: "the engine
is swappable").

## Manifest determinism contract (the timestamp tension, resolved)

Plan §3.1 lists a `timestamp` in `manifest.json`; plan §3.2 requires "two consecutive builds
must be byte-identical" and "dist/ is deterministic from (tokens.json + modes.dark.json +
resolved preset)". A wall-clock timestamp stamped on every build breaks §3.2 and puts diff
churn in every committed dist/. Resolution (implemented in `src/build/manifest.ts`):

- `timestamp` records **when the recorded source hash last changed**, not when the build
  ran: on each build, if the previous `dist/manifest.json` exists and its `sourceHash`
  equals the newly computed one, the previous timestamp is carried forward byte-for-byte;
  otherwise (first build, or sources changed) it is stamped with the current UTC time.
- Consequences, which the tests pin: two consecutive identical builds are byte-identical
  across all of dist/ including manifest.json; the manifest (and its hash) changes **iff**
  the sources change; `onbrand check`'s Step-5 drift guard compares recorded hashes, which
  are a pure function of source bytes (CRLF-normalized) and never of time.
- The precise byte-identity guarantee is therefore: **rebuilding over an existing dist/ with
  unchanged sources and the same `--emit` set is a byte-for-byte no-op.** A from-scratch
  rebuild (dist/ deleted) reproduces every emitted file byte-for-byte except the manifest
  `timestamp` field, which restarts at the rebuild time — the one deliberate, documented
  exception to pure source-determinism, chosen over dropping §3.1's timestamp field
  entirely.

### Source labels are identity keys (machine-independent)

`manifest.sources[].path` entries are **identity keys, not openable paths** — Step 5 (and
any other consumer) must treat them as opaque keys attached to content hashes:

- project-local files: brand/-relative forward-slash ("tokens.json", "../base-tokens.json");
- extends targets resolved inside the on-brand install (preset names): recorded as
  `onbrand:<package-relative path>` (e.g. `onbrand:templates/presets/default/tokens.json`)
  so the SAME project content produces the SAME sourceHash on every machine, wherever the
  on-brand repo lives — install paths never leak into the hash;
- case-normalized (lowercased) on win32 only, where the filesystem is case-insensitive;
  exact casing is preserved on case-sensitive filesystems (two case-differing files stay
  distinct labels there).

### Per-output provenance (`manifest.outputs`) — the subset-build guard

`--emit` subset builds rewrite the manifest but not every dist file, so a single top-level
sourceHash could false-green the Step-5 drift guard (full build, edit sources, `--emit tw`:
sourceHash freshens while tokens.css still embodies the old sources). Therefore the
manifest carries `outputs`: a map of dist/-relative output path -> the sourceHash that was
current **when that file was last regenerated**. Outputs emitted this run get the current
hash; entries for outputs not regenerated are carried forward from the previous manifest.
The Step-5 drift check must compare each output's recorded hash (not the top-level
sourceHash) against the current sources — a stale output stays detectable through any
number of subset builds. Keys are sorted for byte-determinism.

**Carry-forward hardening (issue #19, implemented at Step 5).** The merge in
`buildManifest` now (a) validates every carried-forward key with `isCleanOutputKey` —
absolute, `..`-traversal, drive-letter, backslash, and reserved-name keys are DROPPED with a
warning, so a hand-corrupted manifest can never inject a path that escapes `dist/`; and
(b) PRUNES a carried-forward entry whose file is gone from disk (via the injectable
`carriedOutputExists` predicate compile.ts wires to `existsSync` under `dist/`). Outputs
emitted *this* run are never pruned (they were just written). The Step-5 drift check
(`src/check/drift.ts`) runs every key through the same `isCleanOutputKey` guard BEFORE
joining it onto `distDir`, so iterating `manifest.outputs` can never stat outside `dist/`; a
recorded entry whose file is absent is reported as `dist incomplete`. An entry for an
emitter a future version stops running is carried forward only while its file survives on
disk.

**Why the prune cannot false-green `check` (iteration-2 fix).** Pruning alone would let a
deleted output vanish from the manifest entirely, so a later `onbrand check` would have
nothing to compare and pass an incomplete dist. Therefore `check` also runs a **completeness
sweep**: `compile.ts` owns a declared output-name registry (`EMITTER_OUTPUTS`, enforced at
build time — an emitter whose emitted file set differs from its registry row fails the build
loudly, so the registry can never drift into a stale duplicate), and `checkDrift` errors
`dist incomplete — no provenance recorded` for any implemented emitter's output that has no
manifest entry while a manifest exists. Consequences: a pruned-then-subset-rebuilt dist
fails the next `check`; a fresh project built with only `--emit <subset>` reads as
incomplete until a full build runs (intended — dist/ is committed as the complete set);
`manifest.outputs` entries with non-string hash values are per-entry errors (a corrupted
manifest never reads as clean); and there is deliberately NO top-level-sourceHash-only
fallback — a manifest without a usable `outputs` map is an error, since no real onbrand
build has ever produced one.

## Still open: OKLCH hex-fallback seam (plan §9.10)

Step 2 emits color values exactly as authored (the default preset holds hex). The plan's
"emitters write oklch() with hex fallbacks" applies once ramps.ts (Step 10) starts
generating OKLCH ramps — the seam is marked with a TODO at `tokenValueToCss`'s color case
in `src/build/emitters/css.ts`. Do not close this file's decision as fully realized until
that seam is filled or explicitly descoped at Step 10.

## Emitter flag policy (Step 2 scope)

`onbrand build --emit` accepts the full registry name set — `EMITTER_IDS` in
`src/build/compile.ts` is the one source of truth (at Step-2 time: the §6 set
`css,tw,ts,py,svg,components`; `designmd` joined post-v1).
Names outside that set are a usage error (exit 2, lists the valid names). Names in the set
whose emitter lands in a later step (tw/ts/py — Step 3; svg/components — Step 4) are
**skipped with a note** on stderr, so bare `onbrand build` (default: all) works today and
stays the safest zero-flag invocation; `manifest.json`'s `emitters` array records only what
was actually emitted.
