# on-brand contributor instructions

This repository contains the public Node/TypeScript CLI. Read `README.md` for
commands, `docs/architecture.md` for the module boundaries, and the contracts
under `docs/` before changing generated formats.

## Stack

| Layer | Tools |
|---|---|
| Runtime and CLI | Node.js, TypeScript, tsx |
| Tokens and image extraction | Zod, Color.js, sharp |
| Browser views and website extraction | HTML/CSS/JavaScript, Playwright, dembrandt |
| Validation | Vitest, TypeScript |

## Commands

```powershell
npm ci
npx playwright install chromium
node bin/onbrand.mjs studio --out ../brand-proposals --open
npm test
npm run typecheck
```

There is no separate lint script. Drop images onto the Studio browser page;
the command window hosts the local server. Use the page's Quit button to stop.

## Directory layout

```text
src/schema/        # token parsing, inheritance, and validation
src/build/         # generated exports and manifests
src/extract/       # website and image proposal pipelines
src/studio/        # browser drop zone, loopback server, generation worker
src/inspiration/   # image trace contracts and explanation views
src/preview/       # component specimen
src/gallery/       # brand discovery and gallery
src/check/         # contrast, consistency, and freshness checks
test/              # automated tests
docs/              # public contracts and architecture
examples/          # attributed, pinned demonstration outputs
```

## Architecture

The CLI creates brand sources or delegates to proposal generators. The compiler
turns those sources into portable exports; views consume the exports. Studio
wraps the image generator with a loopback HTTP server and a worker thread, keeping
progress requests responsive. See `docs/architecture.md` for the module boundaries.

## Current state

Image Studio is complete: local uploads, measured accent selection, progress,
previews, and fresh proposal directories for every version. Explicit user accents
use inspiration trace version 2; automatic generation remains version 1. Consult
`docs/inspiration-contract.md` before changing or consuming these formats.

## Environment requirements

Node `^20.19.0 || >=22.12.0` and npm are required. Install Playwright Chromium for
website extraction, screenshots, and the browser integration tests. The image
workflow needs no model credentials. Optional website assistance uses an
authenticated `claude` CLI; `--no-llm` disables it. No hosted service is required.

## Contributor rules

- Use the Node version range in `package.json` and install with `npm ci`.
- Run `npm run typecheck` and tests relevant to a change; run `npm test` before release.
- Consumers read committed `brand/dist/` files. Regeneration is explicit.
- `brand/tokens.json` is the source of truth; generated files are never hand-edited.
- Image extraction is deterministic and never invokes a model. New image proposals
  always have `reviewStatus: "generated-draft"`.
- The released Water Lilies example and golden fixtures are digest-pinned. Copy
  them to temporary directories for experiments; never rebuild them in place.
- Keep private brands, proposals, local inventories, credentials, and operator
  notes out of this repository. See `.gitignore` and `docs/publication.md`.
- Preserve the UTF-8 BOM and LF bytes of `scripts/uat/*.ps1`; Windows PowerShell
  5.1 depends on that encoding. Those scripts target the private historical archive.
- Keep changes small and do not add dependencies without a concrete need.
