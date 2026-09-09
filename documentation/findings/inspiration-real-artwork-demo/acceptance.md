# Real-artwork demo — operator acceptance record

> Historical record: earlier issues and commits are retained in the private
> development archive. Their original repository binding is preserved as evidence;
> links now point to that archive. Public tests use the checked-in records offline.

**Phase I2I.2, Step 39 (issue #74).** This is the durable transcription of the two
Manual UAT M3 gates that decided On Brand's first real-artwork inspiration demo. It
records the operator's dispositions, the exact bytes they bind to, and the digests of
the released tree. It deliberately duplicates no raster and no screenshot: the demo
itself is at [`examples/inspiration/water-lilies/`](../../../examples/inspiration/water-lilies/),
and its acquisition and rights narrative is at
[`examples/inspiration/water-lilies/PROVENANCE.md`](../../../examples/inspiration/water-lilies/PROVENANCE.md).

Both underlying records are closed-schema JSON documents held outside this repository
and posted verbatim to their step issues. Neither is read by any test; this file, and
the provenance record beside the demo, are the in-repo transcription.

## Disposition

| Gate | Step | Issue | Decision |
|---|---|---|---|
| M3a — qualify and select one candidate | 34 | [#69](https://github.com/aberson/on-brand-private/issues/69) | ACCEPT |
| M3b — accept the integrated demo | 37 | [#72](https://github.com/aberson/on-brand-private/issues/72) | ACCEPT |

| Field | Value |
|---|---|
| Demo slug | `water-lilies` |
| M3a run ID (`selectionRunId`) | `f5c1fcd7-2990-4ab8-b85a-bf8b090384ae` |
| M3a evidence created at | `2026-08-25T03:37:55.846Z` |
| M3b run ID | `06696feb-b081-4777-a0cc-7743c1cfeb8b` |
| M3b evidence created at | `2026-08-25T19:57:40.289Z` |
| Reviewed commit | `9f23d0610f9e934a4c3ef587887ca96fb68741a7` |
| Released review status | `operator-reviewed` |
| Repository binding | `aberson/on-brand` |

## Source and rights, as the operator observed them

| Field | Value |
|---|---|
| Artwork | *Water Lilies* (1906), Claude Monet |
| Holding institution | Art Institute of Chicago |
| Object page | <https://www.artic.edu/artworks/16568/water-lilies> |
| Rights statement observed | CC0 Public Domain Designation |
| Policy URL | <https://creativecommons.org/publicdomain/zero/1.0/> |
| Observation date (UTC, machine-stamped) | 2026-08-25 |
| Reviewed asset SHA-256 | `06367197ac8d6745537dcfe6722ff4b8ef2cb33e044168d8c471782b55f7dd39` |
| Reviewed asset bytes | 278626 (`image/jpeg`) |

This is a transcription of what the institution published on the date above, read by
the operator during the M3a run. It is evidence of that observation — not legal
advice, not a timeless claim, and not an automated inference. On Brand fetched
nothing: the CLI never resolves `sourceUrl` or `licenseUrl`. A later reuse of these
bytes should re-check the live object page.

A public-domain **artwork** and a freely reusable **media file** are related but
distinct claims. The object-page statement and the exact media locator are both
recorded in the demo's `PROVENANCE.md` for that reason.

## Viewport and content checks (M3b)

The operator opened the checked-in explanation and specimen locally and recorded a
separate verdict per gate.

| Gate | Verdict | What it covers |
|---|---|---|
| `desktop` | PASS | The explanation and specimen at desktop width. |
| `narrow` | PASS | The same two pages at narrow width, including reading order. |
| `sourceRights` | PASS | Artwork identity, attribution, and rights wording as displayed. |
| `paletteCallouts` | PASS | The numbered source-to-token relationships and palette fidelity. |
| `explanationVsSpecimen` | PASS | That the two pages are meaningfully distinct, not redundant. |

**Accepted limitations:** none were recorded. The M3b record's `acceptedLimitations`
array is empty, which is an answer and not an omission — the operator accepted the
tree without attaching a caveat to the decision.

That said, one *reservation* was recorded against the M3a selection and is not
retracted by this acceptance: the palette is faithful to the pond but renders
blue-dominant on the specimen, because every measured secondary is routed to
`chart.categorical.*`, which no specimen surface renders. It is tracked as issues
[#88](https://github.com/aberson/on-brand-private/issues/88),
[#89](https://github.com/aberson/on-brand-private/issues/89), and
[#90](https://github.com/aberson/on-brand-private/issues/90); it is not a defect of this demo,
and each of those changes generated output — so they land after this step, never
inside it.

## What `operator-reviewed` means here

It means one operator reviewed **this exact tree** and accepted it, on the terms in
the table above. It is not an institutional approval, a rights clearance, or a claim
that these tokens suit another project. The producer never writes it: a fresh
`from-image` proposal is always a `generated-draft`, and the value moves only through
the gated Step 39 promotion described below.

## The promotion, and what it was allowed to touch

Before writing a tracked byte, Step 39's pre-write gate:

1. loaded the M3b record and retrieved the latest matching-schema comment on the
   Step 37 issue, then compared the two JSON values character by character. That
   comment was authored by `aberson` — the repository owner and this project's
   operator — at `2026-08-25T19:57:42Z`, on a private repository, and its body was
   byte-identical to the operator's local `m3b-acceptance.json`. The acceptance
   therefore carries the operator's own authority, not an arbitrary commenter's;
2. validated the closed schema — every field present, no extras — plus the ACCEPT
   decision, all five PASS verdicts, the repository/issue/step binding, both UUIDv4
   run IDs, and the freshness window (at most 24 hours old, no more than five
   minutes in the future);
3. cross-checked `selectionRunId`, `demoSlug`, and `assetSha256` against the M3a
   record;
4. proved `reviewedCommit` exists, is an ancestor of `HEAD`, and that the demo tree
   at work start was identical to it with nothing uncommitted or untracked; and
5. re-derived all eight digests the record names from the files on disk.

Every check passed (71 of 71). Only then did one value move.

Promotion changed four files: `brand/inspiration.json` (the `reviewStatus` value),
`brand/dist/manifest.json` and `brand/dist/inspiration-to-implementation.html` (both
regenerated by the production `onbrand build` writer under the per-brand publication
lock — the explanation restates the status, and the manifest binds the explanation to
the trace digest), and `PROVENANCE.md`. Nothing else in the tree moved, and the
manifest `timestamp` is unchanged because the token sources did not move.

## Released digests

Recomputed from the tree as released. The M3b record names eight of these files; the
three it does not — `image-report.md`, `brand/guide.md`, and this step's hand-authored
`PROVENANCE.md` — are listed anyway because they are the rest of the released tree, and
the first two must not move either. Four rows changed under promotion; the other seven
are byte-identical to the tree the operator reviewed. The `was` values below are the
operator's accepted digests, so three of the four changed rows state both what was
reviewed and what was released; the `PROVENANCE.md` row states only what was released,
because the M3b record never pinned a digest for it.

| File | SHA-256 | vs. reviewed |
|---|---|---|
| `brand/assets/inspiration.jpg` | `06367197ac8d6745537dcfe6722ff4b8ef2cb33e044168d8c471782b55f7dd39` | unchanged |
| `raw-image-analysis.json` | `989297f79bed1fa2cfef511fda869e22baf76ec48e1ec51205d21c01f1bfb644` | unchanged |
| `image-report.md` | `1c9e5721c6de62d4ef9212a1bfca5a63e9b87a97b9cbd95a22d90489c03f2860` | unchanged |
| `brand/tokens.json` | `ca613053e5b08bbe21d5c697249353c2edfba9f1c53c48d212d59c161c8db4f8` | unchanged |
| `brand/modes.dark.json` | `cd526171d994b52dae117e6377a4d058ee98956ee20b3e52d3d09cbf10824158` | unchanged |
| `brand/guide.md` | `161974e6217e6ccdbbffe622d21feb79fe732a6be1082f19c976cdc2fa6da5ea` | unchanged |
| `brand/dist/specimen.html` | `f0a221439aaf0eaf45e6555f17eb90dac16c2d6190a73ffb5c2e4f36122cc3f8` | unchanged |
| `brand/inspiration.json` | `f4c934d7130bd49cb569c27db20aab8588676ad42a2b4d1ca05d9943838e4ca0` | promoted (was `641732006d02adc27d1cddd93f49a9b4e3394eec41ff179f35f04fe09e8b8c09`) |
| `brand/dist/manifest.json` | `ecabd45ed9d279b9ce4536b129b61d6688dfabff106f047927a282308c5c684b` | regenerated (was `c9dda56f7dd69b1f7dd022f395555e167d78fb41c8e823fe98faad3701d8e1ed`) |
| `brand/dist/inspiration-to-implementation.html` | `f60cbb894d83d758107a2792f85797ed302d1d4405b9bfaea2c2e4abb60d66ee` | regenerated (was `88ad36c7e7a9c8e7840c094cf3a5d6ceeda432f1ed2aaaa5d5a3153e504bbe80`) |
| `PROVENANCE.md` | `5a278a9edee997fe89a65e1af07324eee161c97082aa846c64e3bde16fae5069` | rewritten by this step (hand-authored; not named by the M3b record) |

`test/inspiration.demo.test.ts` pins both sets of digests as literals and re-checks them
on every `npm test`: the five as-reviewed producer files must still hash to the values
the operator accepted, the four changed files must hash to their as-released values, the
three of those the M3b record pinned must NOT still hash to their reviewed ones, and this
table must publish all nine. Both
sets are pinned literals, so a tree and a table that drifted together still fail. Their
provenance differs: the five as-reviewed values are transcribed from the M3b record
rather than read from the tree they describe, which is what makes them an independent,
pre-recorded expectation; the four as-released values postdate that record and could not
have come from it — they are digests of the promoted tree, computed once at release and
pinned here and in the test as literals. It reads neither the operator's local records
nor GitHub.

## Boundary

This record closes On Brand's real-artwork demo acceptance and nothing else. The Dev
Observatory list/detail consumer remains a separately owned, excluded integration —
no registry entry, decoder, route, export, or rail promotion was created, and no
`.observatory/` artifact exists for this demo. Skill Mesh has no role. Neither
adjacent repository was read or written during this phase.
