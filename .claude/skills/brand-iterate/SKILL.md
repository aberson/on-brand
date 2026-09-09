---
name: brand-iterate
description: Iterate on a brand's palette safely — copy a brand/ tree to a scratch dir, patch one or more DTCG tokens, then run the full build → preview → check loop and report what moved. Also takes an image or pasted crop as the colour source — measures candidates deterministically with the extraction pipeline's own cluster math, snaps a vision estimate to a pixel-supported colour, proposes a destination slot, then runs the same safe loop. Never edits a tracked brand tree in place, so the operator-reviewed water-lilies demo and its pinned digests stay intact. Use when asked to try a colour, adjust a token, tweak the palette, add a colour from the inspiration image, or see what a different accent would look like.
user-invocable: true
---

# Brand Iterate

Change a token, see the result, keep the committed tree safe.

`brand/tokens.json` is the single source of truth — everything under `brand/dist/` regenerates
from it. This skill wraps that loop and handles the two things that bite:

1. **`build` does not regenerate `specimen.html`.** That is `preview`. Skip it and `check` fails
   with a stale-dist error that reads like a real defect.
2. **Tracked brand trees are digest-pinned.** `examples/inspiration/water-lilies/` is byte-locked
   to the tree accepted at M3b — 15 pinned digests across 18 tests, plus the published table in
   `documentation/findings/inspiration-real-artwork-demo/acceptance.md`. Editing it in place
   invalidates the `operator-reviewed` claim.

## Invocation

```
/brand-iterate <token.path>=<hex> [<token.path>=<hex> ...] [--dark <hex>] [--from <dir>] [--out <dir>] [--open]
/brand-iterate --image <file> [--want "<which colour>"] [--slot <token.path>] [--dark <hex>] [--from <dir>] [--out <dir>] [--open]
```

- `<token.path>` is dotted, relative to the tokens document root — e.g.
  `color.chart.categorical.5`, `color.semantic.accent`, `color.primitive.brand.9`.
- `--from` is the brand root to copy (the directory *containing* `brand/`).
  Default: `examples/inspiration/water-lilies`.
- `--out` is the scratch directory. Default: a fresh timestamped dir under the OS temp path.
- `--open` opens the regenerated specimen.
- `--image` is a raster on disk (png/jpeg/webp, ≤ 5 MB — `readBoundedImageFile` bounds).
  An image pasted into the invocation works too — see Image mode below.
- `--want` names which colour to pull, in words: `--want "the bright red of the blooms"`.
  Without it, propose the strongest under-represented colourful candidates.
- `--slot` is the destination token path; supplying it skips the destination question.

Examples:

```
/brand-iterate color.chart.categorical.5=#974c42
/brand-iterate --image crop.png --want "the bright red" --slot color.chart.categorical.5
```

## Image mode — measure, snap, propose

Image mode turns "add a colour from this crop" into a `<slot>=<hex>` pair, then runs the
same Steps 1–6 below. Four sub-steps, in order:

### 0.a Resolve the colour source

Priority order:

1. `--image <path>` — measure that file.
2. A pasted image, when the `--from` brand carries `brand/assets/inspiration.*` on disk —
   the paste indicates *which* colour the operator means; the **measurement runs against the
   on-disk raster**. Eyeball a target hex from the paste, then snap it (0.c).
3. A pasted image alone (no on-disk raster) — a vision estimate is the only option. Use it,
   but label it `estimate, not measured` in the report. Never present an eyeballed hex as a
   measured one.

### 0.b Measure

From the repository root:

```
npx tsx .claude/skills/brand-iterate/scripts/measure-colors.ts <image> [--around <hex>] [--top <n>]
```

The helper prints one JSON document (`brand-iterate.measure-colors/1`): ranked candidates
from the **full** merged cluster pool (so colours far too small for from-image's gates still
appear), and with `--around` the dE2000 ≤ 12 family support plus the accent-gate verdicts and
the 8 nearest pixel-supported colours. It replicates the pipeline's private decode/downsample
verbatim and *imports* its cluster and gate math (`analyzeImageRaster`,
`hasQualifyingPaletteSupport`; two private steps — the decode chains and the component fill —
are verbatim mirrors, disclosed in the helper's header) — the numbers are what the pipeline
itself would see, not a re-implementation. `wouldQualifyAsAccent` reflects the two support
gates only; full v2 selection additionally requires the chroma floor and coverage
reservations, so read it alongside the adjacent `colourful` flag. It only reads the image;
nothing recorded by `from-image` changes.

The gate verdicts are **context, not gates on iteration** — they tell the operator whether
`from-image` would have picked the colour on its own (issue #88's territory). Worked example,
water-lilies + the bloom red `#974c42`: 62,976-px working raster; family 58 px (0.092%)
against the 158-px aggregate threshold, largest region 10 px against 16 — the extractor would
never select it, which is exactly why this mode exists.

### 0.c Snap

- Target came from vision — a pasted crop, or a prose `--want` (eyeball a target hex from the
  image first): snap to the **nearest pixel-supported cluster** and report the distance — e.g.
  an estimate of `#974c42` snaps to `#a05045` (dE2000 2.27).
- Nearest cluster is > 12 dE2000 away: the image does not actually contain the colour. Stop
  and say so — do not silently snap across a family boundary.
- Operator typed an exact hex: use it as-is; still report its family support and nearest
  neighbours for context.

### 0.d Propose a destination

The skill never creates a token — a pulled colour lands in an existing slot. Rank by
visibility × fit:

| Destination | Visible on | Fits |
|---|---|---|
| `color.semantic.accent` | specimen components + i2i primary swatch | the one brand-pop slot; best default for a single strong pull (ungated) |
| `color.diagram.node-stroke` / `.link` / `.chip-highlight` | both pages | mid-chroma secondary hues (ungated) |
| `color.chart.categorical.2`–`8` | both — specimen's small chart strip + i2i secondary rows | series colours; the #88–#90 landing zone (ungated) |
| `color.chart.sequential.1`–`7` | specimen ramp strip | one hue light→dark — patch the ramp as a set, never one step |
| `color.semantic.bg/surface/text/text-muted`, `color.status.*.fg/bg`, `color.chart.chrome.label/tooltip-bg` | specimen | contrast-GATED (WCAG 4.5:1 hard fail in `check`); status slots are hue-semantic — an image pull rarely fits |

Every slot above has a dark-overlay counterpart — Step 3's overlay rule applies unchanged.

If `--slot` or the operator's prose names the destination, proceed. Otherwise ask ONE
question offering the top 2–3 ranked destinations, then continue into Steps 1–6 with
`<slot>=<hex>`. When the chosen slot is in the gated row, say so before building — a
contrast failure at Step 5 is then an expected possibility, reported verbatim, not patched
around.

## Steps

### 1. Resolve and guard

Resolve `--from` to an absolute path and confirm `<from>/brand/tokens.json` exists.

**Refuse to write into a tracked tree.** Compute the scratch destination first; if it resolves
inside the repository working tree, or if `git -C <repo> ls-files --error-unmatch <out>/brand/tokens.json`
succeeds, halt with:

```
brand-iterate: refusing to write into a tracked brand tree (<path>).
Iteration happens on a copy. Re-run without --out, or pass a path outside the repo.
```

This guard is the point of the skill. Do not weaken it, and do not offer a `--force`.

### 2. Copy

Copy `<from>/brand` to `<out>/brand` in full. The copy must include `dist/` so the stale-dist
comparison in step 5 has a prior manifest to diff against.

### 3. Patch

For each `path=hex` pair, set that token's `$value`. Validate before writing:

- the dotted path resolves to an existing leaf carrying a `$value` — never create a new token
- the value is a 6-digit hex (`#rrggbb`), lowercased on write
- record the before value for the report

A path that does not resolve is an error naming the closest existing sibling. Do not guess.

**Check the dark overlay.** `brand/modes.dark.json` carries its own value for many tokens. After
patching `tokens.json`, resolve the same dotted path in the overlay. If it exists there:

- with `--dark <hex>` supplied, patch it to that value;
- otherwise derive a counterpart that keeps the new hue and adopts the overlay's existing
  lightness and chroma (in OKLCH — the space the measure helper reports in), then report the
  derived value so the operator can override it.

Never leave the two modes disagreeing silently. `check` will **not** catch it — it gates contrast,
lint, and drift, not semantic coherence between modes — so a half-patched token ships a light
surface showing the new colour and a dark surface still showing the old one's counterpart.
Worked example: patching `color.chart.categorical.5` to `#974c42` left dark at `#f78f8d`, the
counterpart of the *previous* `#b55050`, and `check` still passed.

### 4. Build, then preview

Run **both**, in this order, from the repository root:

```
npx onbrand build   <out>
npx onbrand preview <out>
```

`build` emits tokens.css, components.css, theme.ts, theme.tw.css, tokens.py, palette.svg,
diagram-palette.json, DESIGN.md, the manifest, and (when an inspiration trace is present)
`inspiration-to-implementation.html`. `preview` emits `specimen.html`. Both are required before
`check` will pass.

### 5. Check

```
npx onbrand check <out>
```

Exit 0 is a pass. A contrast failure here is a real finding, not a nuisance — report the failing
pairing verbatim rather than adjusting the value to make it green.

### 6. Report

Return a terse block:

```
brand-iterate: <n> token(s) patched
  <token.path>  <before> → <after>   (dark: <before> → <after>)

  build   OK (<k> outputs)
  preview OK
  check   PASS | FAIL — <failing pairing verbatim>

  tokens.css: --color-<flattened-name>: <after>;
  scratch: <out>
  source tree untouched: <from>
```

Image mode adds, above the `build` line:

```
  image: <path> (sha256 <first 12 chars>)
  measured: <hex> — family <px> px (<share>%), largest region <px> px; accent gate: pass|fail (context)
  snap: <vision estimate> → <hex> (dE2000 <x>)      [omit when the operator gave the exact hex]
  destination: <token.path> — <one-line why>
```

In the vision-only case (0.a case 3, no raster on disk) replace the `measured:` line with
`estimate: <hex> — vision estimate, not measured` and omit `snap:`.

Confirm the change actually reached `tokens.css` by reading it — that is what the specimen
consumes. **Do not verify by grepping `specimen.html`**: it links `tokens.css` and inlines no
hex values, so grepping it reports a false negative.

## What this skill does not do

- It does not change what `from-image` measured. Image mode *reads* a raster to propose token
  edits — through the pipeline's own cluster math — but the recorded trace, its palette
  evidence, and every digest stay untouched. `from-image` is one-shot and deterministic; changing
  which colours the extractor itself records is issue #88, not a token edit.
- It does not promote anything. A scratch tree is never `operator-reviewed`; that status is only
  reachable through the M3b → Step 39 gate against a validated acceptance record.
- It does not commit. If an iteration is worth keeping, that is a plan step with its own review.

## Related

- `scripts/measure-colors.ts` — the image-mode measurement helper (this skill's only code).
  Lives outside tsconfig `include`, so `npx tsc --noEmit` ignores it by design.
- `/brand-fidelity` — scores `from-url` output against frozen ground truth.
- Issue #88 — accent gates reject impressionist brushwork (changes what gets measured).
- Issue #89 — measured secondaries never reach a *component* surface on the specimen (the
  chart strip does render categorical swatches; the page still reads single-hue).
