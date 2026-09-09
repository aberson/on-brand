# Architecture

on-brand is a local Node/TypeScript CLI. It creates a portable `brand/` file set
and has no hosted service or required integration with another project.

## Token compilation

`brand/tokens.json` holds a defined DTCG subset. `src/schema/` validates the
document, resolves preset inheritance, and applies the optional color-only
`modes.dark.json` overlay. `src/build/` compiles resolved tokens into CSS,
Tailwind v4 themes, TypeScript and Python constants, component recipes, SVG and
JSON palettes, and `DESIGN.md`.

Publication stages generated files under a per-brand writer lock. The manifest
records source and output hashes, allowing `check` to detect stale or modified
outputs. The human guide preserves operator prose outside its generated tables.

## Proposal generators

- `src/extract/from-url.ts` uses a dembrandt adapter backed by Chromium. It
  normalizes measured colors, typography, spacing, radius, and shadows, then
  optionally uses the `claude` CLI for bounded brand selection and prose assistance.
  The report retains extraction evidence and confidence information.
- `src/extract/from-image.ts` measures a local PNG, JPEG, or WebP deterministically.
  Color-family coverage, spatial support, and perceptual diversity guide palette
  selection. Unobserved design choices retain preset defaults. Image proposals
  include the exact source raster and a trace connecting samples to generated tokens.

Both paths create reviewable proposals. Adoption is an explicit operator action.
The image producer writes `generated-draft`; it never certifies its own output
as operator-reviewed.

## Views and validation

`src/preview/` renders a component specimen from the generated files.
`src/inspiration/` renders the source-to-token explanation and validates its trace.
`src/gallery/` discovers brand sets under an explicit root and distinguishes
adopted, proposed, stale, incomplete, and invalid sets.

`src/check/` validates declared foreground/background pairings in both modes,
reports WCAG and APCA contrast, checks schema coverage, and detects output drift.
These token checks do not replace testing the accessibility of a consuming app.

The [observatory contract](observatory-contract.md) and
[inspiration contract](inspiration-contract.md) define the versioned file exports
for separate consumers. Exporting a file does not invoke or configure a consumer.

## Current limitations

The current image algorithm is `image-cluster-v2`. In the Water Lilies example,
secondary colors appear in categorical and diagram palettes while ordinary
semantic components remain blue-dominant. Improving that balance requires a new
reviewed candidate; the released example preserves its accepted bytes.

External inventory consumers are separate integrations. Website extraction
approximates visual identity and does not copy page layouts or source webfont files.

The image-cluster merge caches color calculations and uses a derived lightness
bound to skip impossible merges. Pinned baseline fixtures verify that this
optimization preserves palette output. A maximum-distinct raster can still be slow.

Historical `plan.md` and issue references in source comments refer to the private
development archive. This document and the public contracts describe the interfaces
needed to use and develop the tool independently.
