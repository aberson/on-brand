# Public source and private brands

The public repository contains the tool, generic presets, test fixtures, benchmark
code and evidence, and the attributed Water Lilies example. It starts with a clean
source snapshot. Earlier development history, original conversation records,
workspace inventories, and internal issue discussions remain in a separate private
archive.

Store your own brand kits in their consuming projects or a separate private
repository. Local `brand/`, `brands/`, `proposals/`, `onbrand-proposal-*/`,
`.observatory/`, and environment files are ignored here. An ignore rule prevents
accidental additions; it does not encrypt files or remove anything already committed.

The README screenshots use the public demo and temporary preset-based projects.
The screenshot script never captures an operator's real workspace inventory.

Some public evidence records refer to historical commits and issue numbers. The
acceptance record and current guidance link to the private archive and require
maintainer access. The demo's digest-pinned `PROVENANCE.md` retains its original
bytes, including links that predate this split; the
[historical reference](../documentation/inspiration-real-artwork-demo-plan.md)
provides their current archive locations. The original repository binding and
accepted digests remain historical evidence. Public tests read the checked-in
transcriptions and do not fetch that archive.

`scripts/uat/` is the historical maintainer acceptance harness. Its repository
guard targets the private archive, preventing it from acting on unrelated issue
numbers in the new public repository. Ordinary CLI users do not need these scripts.

The code uses the [MIT license](../LICENSE). Third-party materials retain their
own terms and attribution; see [NOTICE.md](../NOTICE.md). The package retains
`private: true` to prevent accidental npm publication; this does not restrict
cloning or using the MIT-licensed source.
