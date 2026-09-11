# Inspiration to implementation contract

`onbrand from-image` accepts one local PNG, JPEG, or WebP raster and writes a
reviewable proposal. It never fetches `sourceUrl`; source/rights metadata is
operator-supplied and defaults to `unknown` or `null`.

The image path is deterministic-only. It never starts a model process, always
records `llm: "none"` in `brand/dist/manifest.json`, and emits deterministic
selection provenance. `--no-llm` remains accepted for script compatibility but is
a no-op; omitting it and supplying it have the same behavior. The trace validator
retains the closed `llm` primary-selection value for compatible stored records,
but the shipped image producer does not emit or exercise that path. `from-url`
keeps its separate optional LLM-assist contract.

## Explicit user accents and format compatibility

`onbrand studio` wraps the same deterministic image producer with drag-and-drop
input and a measured accent selector. `RunFromImageOptions.accentSampleId` names
an existing colorful sample that must pass the same support gates as an automatic
accent. It changes the primary choice; neutral and secondary selection still use
the existing policy, with the chosen primary excluded from secondary slots.
The source raster and raw measurement evidence do not change, and no model runs.

An explicit choice emits `brand/inspiration.json` **schemaVersion 2**, with
`selectionSource: "user"` on the primary selection and its mapping. Version 1
continues to accept only `deterministic` and legacy `llm` values. The shape,
measurement algorithm, output limits, and `generated-draft` review status remain
the same. A user's accent choice does not constitute review of the generated kit.
Automatic `from-image` and automatic studio runs retain version 1 and their
existing output behavior. Readers in this release accept both trace versions.

An inspiration catalog containing a user-selected mapping likewise emits
**schemaVersion 2** for `onbrand.inspiration-to-implementation`. A catalog whose
emitted items contain only the prior selection vocabulary stays version 1.
Older strict readers must reject version 2 until updated; a user selection is
never mislabeled as an LLM choice to pass an old decoder. Studio generation does
not refresh an external inventory automatically. Regular token/CSS/TS/Python
formats, standalone previews, and the separate brand-inventory format do not
change. The checked-in version 1 demo and fixtures are not rewritten.

## Image algorithm versions

The current producer emits `image-cluster-v2` (2026-08-23). The supported
vocabulary is `image-cluster-v1` and `image-cluster-v2`; stored v1 traces,
exports, and the committed catalog fixture stay valid and are never rewritten.
The trace and catalog envelope `schemaVersion` values are unchanged — only the
already-versioned algorithm name expanded — so a strict downstream decoder that
knows only the v1 literal must be updated before it consumes a v2 record.

V2 keeps every released decode rule: EXIF orientation, sRGB conversion, partial
alpha flattened over white, a 256-pixel working long edge, the five-bit
histogram, the ΔE2000 < 3 greedy merge, and at most twelve evidence samples.
What changed is which merged clusters survive that twelve-sample budget. V2
reserves the most frequent cluster, then the independently qualifying neutral,
then admits only colour candidates whose candidate-centered, non-transitive
ΔE2000 ≤ 12 perceptual family clears both an aggregate gate (≥ 0.25 percent of
working pixels) and a local gate (a largest 8-connected component of at least
`max(4, ceil(workingPixels * 0.00025))` pixels). Remaining slots go to the
candidate with the greatest minimum ΔE2000 from everything already retained,
with exact ties broken by family support, then individual frequency, then hex,
then original merged-cluster index. A pool of twelve or fewer clusters keeps its
prior order untouched.

The greedy merge was made substantially cheaper on 2026-08-26 without changing
what it produces: each histogram bin now builds one colour instead of one per
comparison, each cluster caches the colour of its current representative
(rewritten at the single point that mutates it), and a pair whose Lab lightness
differs by at least `3 * 1.75 = 5.25` skips the exact distance because CIEDE2000
provably cannot bring it under 3. Same clusters, same order, same palettes; a
committed pre-change fixture set across PNG, JPEG, and WebP at three cardinality
tiers is the gate. That work was deliberately output-preserving, so it did NOT
bound the merge: a pathological maximum-distinct raster still costs
`bins x clusters` comparisons and remains slow by design. Making adversarial
inputs fast would change which clusters survive, and therefore needs its own
palette-fidelity acceptance.

`raw-image-analysis.json` records the two measured support metrics per sample,
`familyPixelShare` and `largestFamilyRegionPixelShare`. They are evidence only:
the trace and catalog shapes are unchanged. Every v2 sample must carry finite
values in `[0, 1]`, and deterministic role selection fails closed when a v2
sample's support evidence is missing or malformed. Stored v1 evidence omits both
fields and keeps its exact released selection behavior. An unsupported isolated
or scattered colour can therefore remain visible in raw evidence without ever
becoming a secondary mapping, and without becoming the primary whenever any
candidate in the pool carries qualifying support. Because the trace requires a
primary, the one last-resort exception is a pool in which no candidate qualifies
at all: deterministic selection then still names the highest-share sample rather
than failing. Every mapping's `sample.method` is
stamped from the measured evidence and must equal `analysis.algorithm`; a
mismatch fails validation. Primary scoring, the 2 percent neutral rule, the
ΔE 10 secondary separation, the seven-secondary cap, token assignment, ramps,
and contrast policy are all unchanged.

Automated coverage for the palette policy is synthetic: generated rasters and
hand-authored evidence only. Subjective palette fidelity for a real, rights-
verified artwork is not decidable by that coverage; it was judged once, by an
operator, at Manual UAT M3 — see
[Review status and the verified demo](#review-status-and-the-verified-demo).

```powershell
node bin/onbrand.mjs from-image .\painting.jpg `
  --title "Artwork title" --alt "Objective image description" `
  --creator "Artist" --rights "Public domain" --out .\proposals --no-llm
```

The proposal contains exact copied bytes under `brand/assets/`, raw measured
evidence in `raw-image-analysis.json`, a canonical editable trace in
`brand/inspiration.json`, regular generated outputs, `specimen.html`, and the
self-contained `inspiration-to-implementation.html` explanation.

Usage/preflight rejection happens before proposal mutation. After proposal
creation begins, `INCOMPLETE.md` remains until deterministic measurement,
synthesis, full compile, check, explanation, specimen generation, exact specimen
provenance recording, a second check, and `image-report.md` all succeed. A
failure in those stages leaves the marker and bounded evidence for diagnosis.
When paired catalog flags are present, the producer removes the marker only
after those local stages complete and starts catalog refresh afterward. A
catalog failure therefore exits nonzero but keeps a complete reviewable proposal
without `INCOMPLETE.md`; the previous complete catalog bytes remain intact.

The trace uses schema `onbrand.inspiration` v1. It records only measured sample
hexes/regions and source-to-token mappings; rendered light/dark implementation
values are resolved from the current tokens rather than duplicated in the trace.
Image-derived mappings explicitly account for every categorical/diagram role.
Any unfilled role is marked `no-qualifying-image-sample`, and typography,
spacing, radius, shadow, motion, and status are declared defaults.

Freshness is output-specific: normal emitters and the full specimen use the
core token source hash, while the specimen's v1 `outputSources` row also binds
that claim to the exact HTML bytes recorded. A later lock-free preview write
with different bytes is therefore stale, never falsely current. The
inspiration catalog likewise exposes `specimenPath` only after the live
single-link specimen bytes match that recorded digest; catalog v1's shape and
the meaning of its other fields are unchanged. The
side-by-side view hashes the core hash, LF-normalized trace text, and the exact
binary asset bytes. A full build renders
or removes the optional explanation; an explicit `--emit` subset never silently
freshens it. A retained explanation whose trace was removed remains recorded as
stale until the next full build removes both the file and its manifest rows.
Missing or corrupt manifest data never makes a successfully rendered preview
look current: an ordinary preview remains usable but untracked, while the
required `from-image` transaction fails rather than reporting completion. If a
provenance refresh fails after a prior valid manifest existed, the CLI reports
the refresh failure without guessing `current`, `stale`, or `untracked`, because
an older exact digest may still match. Ordinary preview preserves exit 0 and
`--open` behavior for the usable page and prints shell-neutral JSON argv arrays
for the exact local `build` then `preview` remediation invocations.

Every full or subset build and every specimen-provenance update serializes its
`brand/dist/manifest.json` transaction through
`brand/.onbrand-dist-publication.lock`. The lock is created exclusively with
exactly `{ runToken, pid, startedAt }`; only an unchanged lock owned by a local
PID that is demonstrably dead may be recovered. Live, malformed, or replaced
locks fail closed, and a process never removes a lock whose token and file
identity no longer match its own. A build keeps that same lock while refreshing
the palette-derived `guide.md` fence, so an older build cannot publish its guide
after a newer build. A failed guide refresh can leave already-published dist
bytes, but the command fails and an ordered retry restores one coherent guide
and dist generation.

This publication protocol assumes an operator-controlled project tree for the
whole command. At inspection time On Brand walks every visible pathname
component from the filesystem root to the requested project/`brand`/`dist`
directory and rejects a linked, reparse, or non-directory component. Linked or
multi-linked manifest/specimen targets fail closed in build and check paths;
preview and specimen recording also reject linked or multi-linked required
dist inputs and `palette.svg`.
Generated dist files and `guide.md` use unpredictable exclusive sibling
staging plus identity-checked publication and cleanup; ordinary outputs retain
Node's 0666-before-umask mode convention, existing operator-owned `guide.md`
permission bits are preserved exactly, and the ownership lock is 0600.
These are pathname-at-inspection checks, not retained directory capabilities:
they do not protect against a malicious same-user process that ignores the lock
and swaps or relinks an ancestor between inspection and rename. Do not run On
Brand elevated or against a tree writable by untrusted principals.

Use the dedicated bounded producer artifact when an external consumer needs the
catalog:

```powershell
node bin/onbrand.mjs inspiration-export --root ..\workspace `
  --out ..\workspace\.observatory\inspiration-to-implementation.json
```

The export is read-only with respect to brands: it never rebuilds a proposal or
invokes Dev Observatory. `from-image` can refresh it only with both explicit
`--catalog-root` and `--catalog-out` flags after the specimen and explanation
have completed.

Catalog v1 freezes its schema/version, limits, IDs, ordering, counts, truncation,
portable paths, and no-embedded-image boundary. Publication uses an exclusive
`<catalog-out>.lock` and atomic replacement. A contending writer preserves the
prior catalog and emits one platform-safe retry command that invokes the running
Node executable plus the resolved `bin/onbrand.mjs inspiration-export` entry
point. `--recover-stale-lock` succeeds only for an unchanged, demonstrably dead
local owner older than 15 minutes; young, live-PID, malformed, replaced, or
non-owner locks fail closed. Capacity omission is manual remediation, not an
automatic retry.

The committed `test/fixtures/inspiration/catalog-v1.json` is deliberately
synthetic, stale, and `generated-draft`. It freezes the public producer contract;
it is not an accepted or current catalog assertion. Reproduction is
production-backed: the focused Vitest test scaffolds a bounded synthetic brand,
calls `exportInspirationArtifact()` with the pinned clock
`2026-08-12T20:00:00.000Z`, and compares the emitted UTF-8 file to the committed
fixture byte-for-byte while rejecting absolute paths and embedded image data.
There is no standalone fixture-regeneration CLI.

## Review status and the verified demo

`reviewStatus` is a closed two-value enum, unchanged at v1:
`generated-draft | operator-reviewed`. Its lifecycle is deliberately asymmetric.

The producer writes **only** `generated-draft`, and always will. A proposal it has
just generated has by definition not been reviewed by anyone, so a producer that
could emit the reviewed value would be certifying its own output. There is no CLI
command, flag, or environment variable that promotes a trace, and adding one is not
a v1 gap to be filled — the absence is the control.

`operator-reviewed` therefore appears only where a human decision was recorded
outside the tool and then validated against the exact bytes it describes. It means:
one operator opened that exact tree's explanation and specimen, checked artwork
identity, attribution and rights wording, the numbered source-to-token callouts, and
whether the explanation and the full specimen are meaningfully distinct — and
accepted it. It does **not** mean an institution approved anything, that rights were
cleared, that the palette is objectively correct, or that the tokens suit any other
project. It is a dated record of one review of one tree, and a reader who needs more
than that should re-check the live object page rather than trust the flag.

Consumers must treat the two values as a display and filtering distinction only.
Nothing in the producer, the check gate, or the catalog exporter behaves differently
for a reviewed trace; `src/inspiration/export.ts` copies the value into catalog rows
verbatim so a downstream reader can separate drafts from reviewed records without
inferring anything.

`examples/inspiration/water-lilies/` is the one released `operator-reviewed`
example — Claude Monet, *Water Lilies* (1906), Art Institute of Chicago, CC0. It is
a complete `from-image` producer tree over the exact institution-delivered bytes,
carrying its own `PROVENANCE.md`; the acquisition, rights observation, both operator
gates, and the released digests are recorded there and in
[`documentation/findings/inspiration-real-artwork-demo/acceptance.md`](../documentation/findings/inspiration-real-artwork-demo/acceptance.md).
Promotion changed exactly one trace value, the two generated outputs derived from it
(the manifest and the explanation, both rewritten by `onbrand build`), and the
hand-authored `PROVENANCE.md`. The raster, measured evidence, image report, tokens,
dark overlay, guide, and specimen are byte-identical to the tree the operator
reviewed.

By contrast, `test/fixtures/inspiration/catalog-v1.json` and the retained Step-31
evidence under `documentation/findings/inspiration-producer-acceptance/` are
synthetic contract fixtures, and `templates/presets/monet-*` are hand-authored mood
anchors for the fidelity benchmark. None of them is real-artwork evidence, none is
`operator-reviewed`, and none may be relabelled as either.

## Acceptance evidence and ownership boundary

The accepted Step-31 browser proof uses a synthetic 320×180 PNG, not Monet or
another rights-verified artwork. Its production proposal/catalog outputs were
under an ephemeral test root and their locators are recorded as `retained:
false`; only the reviewed evidence JSON and three screenshots are retained under
`documentation/findings/inspiration-producer-acceptance/`.

Ordinary acceptance reruns write browser screenshots and generated evidence only
under OS temp, compare the retained evidence semantically, validate its
screenshot-hash binding, and assert that retained files remain byte-unchanged.
They must not set `ONBRAND_UPDATE_INSPIRATION_EVIDENCE=1`; that invocation-scoped
setting is reserved for an explicit reviewed evidence-promotion transaction.
The local `.observatory/` producer snapshot remains ignored.

On Brand producer work is implemented and accepted through Steps 28–31, with
palette measurement superseded by the `image-cluster-v2` correction shipped as
Step 40 of
[`documentation/image-palette-fidelity-plan.md`](https://github.com/aberson/on-brand-private/blob/master/documentation/image-palette-fidelity-plan.md).
Manual UAT M3 is now closed: real-artwork attribution/rights, subjective palette
fidelity, and qualitative explanation-versus-specimen distinctness were judged by
the operator across the two gates recorded in
[`documentation/findings/inspiration-real-artwork-demo/acceptance.md`](../documentation/findings/inspiration-real-artwork-demo/acceptance.md),
and that judgment covers exactly one artwork — the released demo above, not the
producer in general.

The full cross-repository feature is still not complete. Dev Observatory owns the
list/detail consumer; that integration remains separately owned and excluded, and
On Brand has produced no registry entry, decoder, route, or `.observatory/` artifact
for the released demo. “Step 43” is a historical handoff label only. See the
[accepted-producer traceability record](https://github.com/aberson/on-brand-private/blob/master/documentation/inspiration-producer-acceptance-traceability.md).
