# on-brand contributor instructions

This repository contains the public Node/TypeScript CLI. Read `README.md` for
commands, `docs/architecture.md` for the module boundaries, and the contracts
under `docs/` before changing generated formats.

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
