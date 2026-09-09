# water-lilies — real-artwork demo provenance

**Phase I2I.2, Steps 36 (issue #71) and 39 (issue #74).** This directory is one
complete `onbrand from-image` proposal, promoted verbatim from the candidate the
operator selected at Manual UAT M3a (issue #69) and released after the operator
accepted it at Manual UAT M3b (issue #72). Nothing here was hand-authored except this
file: the raster, the measured evidence, the trace, the tokens, the guide, the
manifest, the explanation, and the specimen are exactly the bytes the production
producer wrote.

`brand/inspiration.json` carries `reviewStatus: "operator-reviewed"`. Step 36 checked
this tree in as a draft; Step 39 of
[`documentation/inspiration-real-artwork-demo-plan.md`](../../../documentation/inspiration-real-artwork-demo-plan.md)
validated the M3b acceptance record against the exact reviewed commit and promoted
that one value. **That status is a record of one operator's local review of this
tree** — its artwork identity, the rights wording transcribed below, its palette
callouts, and the explanation-versus-specimen distinction. It is not an
institutional approval, a rights clearance, or a claim that these tokens suit any
other project.

The producer itself still writes `generated-draft` and always will: a proposal it
has just generated has by definition not been reviewed by anyone. `operator-reviewed`
is reachable only through the gated promotion described under
[M3b acceptance evidence](#m3b-acceptance-evidence) below.

## Artwork

| Field | Value |
|---|---|
| Title | Water Lilies |
| Creator | Claude Monet |
| Artwork date | 1906 |
| Holding institution | Art Institute of Chicago |
| Object page | <https://www.artic.edu/artworks/16568/water-lilies> |
| Alt text (operator-supplied) | Water lilies floating on a pond. |

## Acquisition

The operator opened the object page in a browser and downloaded the
institution-offered rendition directly, and separately read the work, creator, date,
and rights statement there. On Brand fetched nothing: the CLI never resolves
`sourceUrl`, `licenseUrl`, or the media locator, and the committed bytes are the
downloaded file copied unchanged by the producer.

What was downloaded is the institution's **width-843 IIIF derivative**: the media
locator below ends in `full/843,/0/default.jpg`, and the committed file decodes to
843x809 (`raw-image-analysis.json`). It is **not** the full-resolution master, and
nothing here claims master-level fidelity. The non-transformation claim is about On
Brand's handling only: the delivered file was **not** recompressed, cropped, resized,
or converted on its way into this directory, so the checked-in bytes and the
institution-delivered bytes are the same byte sequence.

| Field | Value |
|---|---|
| Media download URL | <https://www.artic.edu/iiif/2/3c27b499-af56-f0d5-93b5-a7f2f1ad5813/full/843,/0/default.jpg> |
| Media type | image/jpeg |
| Asset bytes | 278626 |
| Asset SHA-256 | `06367197ac8d6745537dcfe6722ff4b8ef2cb33e044168d8c471782b55f7dd39` |
| Committed at | `brand/assets/inspiration.jpg` |
| Bytes acquired at (browser download, operator-local clock) | 2026-08-23 08:38:33 |
| Rights/metadata observation date, machine-stamped UTC (`retrievedAt`) | 2026-08-25 |

Those two dates are different measurements and are recorded separately because they
do not agree.

`retrievedAt` is not an acquisition date. `scripts/uat/Invoke-UatM3a.ps1` sets it
from `Get-InvariantUtcDate` when the M3a run executes, so it is the UTC calendar date
on which the rights and metadata above were observed and transcribed. That run
stamped its own `evidenceCreatedAt` at `2026-08-25T03:37:55.846Z`, which on the
operator's local clock (UTC-7) was the evening of 2026-08-24. `2026-08-25` is that
instant's UTC date, and it is the string the producer recorded verbatim into
`brand/inspiration.json`.

The bytes were acquired earlier. The staged input the M3a run consumed is
byte-identical to the committed asset — same SHA-256, same 278626 bytes — and its
creation time equals its last-write time at 2026-08-23 08:38:33 on the operator's
local clock, the signature of an unmodified browser download. That is when the file
arrived.
[`documentation/inspiration-real-artwork-uat.md`](../../../documentation/inspiration-real-artwork-uat.md)
explicitly permits staging downloads in an earlier session while the script still
stamps the current UTC date, so the two dates differing is expected behaviour of the
instrument rather than a defect in this record.

That digest is asserted three ways by `test/inspiration.demo.test.ts`: against the
committed file on disk, against `brand/inspiration.json`'s `asset.sha256`, and
against the `asset` row of `brand/dist/manifest.json`'s `outputSources` for the
explanation.

## Rights

| Field | Value |
|---|---|
| Rights statement observed | CC0 Public Domain Designation |
| Policy / license URL | <https://creativecommons.org/publicdomain/zero/1.0/> |
| Observed on (UTC, same machine stamp as `retrievedAt`) | 2026-08-25 |

This is the operator's transcription of what the institution published, read during
the M3a run stamped above — not on the day the bytes were downloaded, which was two
days earlier. It is evidence of that observation, not legal advice and not a
timeless claim; museum labels and policy URLs change. On Brand performs no
automated rights inference — every field above is a bounded operator-supplied
string that the CLI records and never verifies. A later reuse of these bytes should
re-check the live object page rather than trusting this table.

Note also that a public-domain **artwork** and a freely reusable **media file** are
related but distinct claims. Both are recorded here deliberately: the object-page
statement above, and the exact media locator the bytes came from.

## M3a selection evidence

The candidate was chosen by the operator from the fixed three-artwork trial in
[`documentation/inspiration-real-artwork-uat.md`](../../../documentation/inspiration-real-artwork-uat.md).
The durable record is a closed-schema JSON document
(`onbrand.inspiration-real-artwork-uat-selection`, `schemaVersion` 1) held outside
this repository and posted verbatim as a comment on the issue below.

| Field | Value |
|---|---|
| Demo slug | `water-lilies` |
| M3a run ID | `f5c1fcd7-2990-4ab8-b85a-bf8b090384ae` |
| M3a evidence created at | `2026-08-25T03:37:55.846Z` |
| M3a issue | [#69](https://github.com/aberson/on-brand/issues/69) |
| M3a plan step | 34 |
| M3a decision | ACCEPT |
| Repository binding | `aberson/on-brand` |

`evidenceCreatedAt` is the record's own UTC timestamp, and the one M3a field here
that is neither machine-local nor a bare calendar date. It is what Step 36's
freshness check compared against, and it is the anchor a later reader needs to
resolve every bare date this file publishes to a single instant.

Before this tree was written, Step 36 loaded that record, retrieved the latest
matching-schema comment on issue #69, compared the two JSON values character by
character, validated every closed-schema field, confirmed the record was under 24
hours old and not future-dated, and re-derived the asset digest, byte count, and
media magic bytes from the actual file. Every metadata value in the table above was
matched against `brand/inspiration.json` before a single tracked byte was written.

The selection record also carries the machine-local staging path the operator's
proposal was generated at. **That path is deliberately not transcribed here.** It
names one workstation's private staging layout, proves nothing about the artwork
or its rights, and would be stale the moment the trial directory is cleaned up. The
run ID above is the durable handle that binds this tree to that record.

## M3b acceptance evidence

The integrated draft was reviewed by the operator at Manual UAT M3b and accepted.
The durable record is a second closed-schema JSON document
(`onbrand.inspiration-real-artwork-uat-acceptance`, `schemaVersion` 1) held outside
this repository and posted verbatim as a comment on the issue below.

| Field | Value |
|---|---|
| M3b run ID | `06696feb-b081-4777-a0cc-7743c1cfeb8b` |
| M3a run ID it accepts (`selectionRunId`) | `f5c1fcd7-2990-4ab8-b85a-bf8b090384ae` |
| M3b evidence created at | `2026-08-25T19:57:40.289Z` |
| M3b issue | [#72](https://github.com/aberson/on-brand/issues/72) |
| M3b plan step | 37 |
| M3b decision | ACCEPT |
| Reviewed commit | `9f23d0610f9e934a4c3ef587887ca96fb68741a7` |
| Accepted limitations | none recorded |

The operator opened this tree's explanation and specimen locally and recorded a
separate verdict for each of five gates — `desktop`, `narrow`, `sourceRights`,
`paletteCallouts`, and `explanationVsSpecimen`. All five are PASS.

`reviewedCommit` names the Step 36 **draft** commit, not this one, and that is
deliberate: the acceptance is evidence about the exact bytes the operator looked at.
Before Step 39 wrote anything, its pre-write gate loaded the record, retrieved the
latest matching-schema comment on issue #72, compared the two JSON values character
by character, validated every closed-schema field and all five PASS verdicts,
confirmed the record was under 24 hours old and not future-dated, checked the
`selectionRunId` against the M3a record, proved `reviewedCommit` exists and is an
ancestor of `HEAD` with a demo tree identical to the working tree, and re-derived all
eight digests the record names from the files on disk. Then, and only then, one
value moved.

Promotion changed exactly four files in this directory: `brand/inspiration.json`
(the `reviewStatus` value), `brand/dist/manifest.json` and
`brand/dist/inspiration-to-implementation.html` (both regenerated by
`onbrand build`, because the explanation restates the status and the manifest binds
the explanation to the trace digest), and this file. The raster, the measured
evidence, the image report, the tokens, the dark-mode overlay, the guide, and the
specimen are byte-identical to the bytes the operator reviewed — their M3b digests
still reproduce. The manifest's `timestamp` is unchanged too: the token sources did
not move, so the manifest contract preserves the recorded source-hash instant rather
than stamping the promotion.

The wider real-artwork acceptance record, including the released digests, lives at
[`documentation/findings/inspiration-real-artwork-demo/acceptance.md`](../../../documentation/findings/inspiration-real-artwork-demo/acceptance.md).

## Reproducing this tree

The producer is deterministic given the same input bytes, the same operator
metadata, a pinned clock, and the pinned raster decoder — `"sharp": "0.35.3"` in
`package.json`, the repo's only exact-pinned dependency. The pin belongs in that
list: the measured palette is read out of sharp's decode of the committed JPEG, so a
future `sharp` bump would surface as an opaque red across the byte-compared files
while the bytes, the metadata, and the clock all still verify correct. Given all
four, the producer reproduces this directory byte-for-byte **except for the review
promotion**: a fresh proposal is a `generated-draft`, so its `brand/inspiration.json`,
`brand/dist/manifest.json`, and `brand/dist/inspiration-to-implementation.html`
differ from the released copies here by exactly that one value and the two digests
that follow from it. Every other file comes back identical.

```powershell
node bin/onbrand.mjs from-image <the-selected-jpg> `
  --title "Water Lilies" `
  --alt "Water lilies floating on a pond." `
  --creator "Claude Monet" `
  --artwork-date "1906" `
  --source-url "https://www.artic.edu/artworks/16568/water-lilies" `
  --rights "CC0 Public Domain Designation" `
  --license-url "https://creativecommons.org/publicdomain/zero/1.0/" `
  --retrieved-at "2026-08-25" `
  --out <a-temp-dir> --no-llm
```

`--retrieved-at` carries the machine-stamped observation date exactly as the M3a run
recorded it (see Acquisition above); it is an input to reproduce, not a claim about
when the bytes arrived.

`test/inspiration.demo.test.ts` runs exactly that command against a temporary copy
of the committed raster on every `npm test`, with `ONBRAND_NOW` pinned to this
tree's manifest timestamp, and byte-compares the result — comparing the three
promotion-affected files structurally instead, for the reason above. It never
rebuilds this directory in place, never reaches the network, never passes a catalog
flag, and never reads the M3a or M3b records or GitHub.

## What is deliberately absent

- No `.observatory/` catalog artifact, and no `--catalog-root` / `--catalog-out`
  pairing. Dev Observatory consumption is a separate owner's integration.
- No second candidate. `water-lilies` was the only artwork carried through the local
  qualification cycle: the surviving trial directories contain `water-lilies` and
  nothing else, and a qualified candidate necessarily leaves a proposal directory
  behind. `parasol` was staged as an input file but not carried through, and
  `parliament-sunset` was never staged at all. Only the selected candidate is
  committed, carrying the rights statement the operator observed and transcribed
  above — an observation on one date, not a verification.
- No screenshot evidence. The Step 31 synthetic browser evidence under
  `documentation/findings/inspiration-producer-acceptance/` and the hand-authored
  `templates/presets/monet-*` benchmark anchors are separate artifacts and are
  byte-unchanged by both Step 36 and Step 39.
- No Dev Observatory decoder, registry entry, route, or rail promotion. The
  `operator-reviewed` status is On Brand's own record; nothing downstream consumes
  it yet, and this phase wrote nothing outside this repository.
