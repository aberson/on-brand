# Real-artwork inspiration UAT

This runbook qualifies one of three fixed museum candidates, preserves the exact selected bytes,
and later accepts the checked-in draft that was built from those bytes. Run M3a for issue #69.
After Step 36 has produced a checked-in draft, run M3b for issue #72. Every generated file stays
outside the checkout until a later automated step validates the evidence.

Human judgment is intentional here. The commands prove identity, byte integrity, metadata, and
handoff shape; only the operator can decide that the artwork is eligible and that the palette,
callouts, reading order, and explanation are faithful.

Both evidence files use one compressed JSON line plus one terminal newline. The issue comparison
removes at most that single transport newline from each side, then compares every remaining
character ordinally; leading whitespace, extra blank lines, or any changed JSON byte fails.

The mechanics live in checked-in scripts under `scripts/uat/`; this runbook owns the judgment.
Each phase below is one command plus the decisions only an operator can make.

## Fresh-checkout setup

Start in the root of a fresh, clean On Brand checkout. Use PowerShell. Stop on any error; do not
post an acceptance record after a failed command or an uncertain judgment.

There is no separate setup command to run. `scripts/uat/` holds four checked-in files:

| File | Role |
|---|---|
| `scripts/uat/uat-common.ps1` | Dot-source library: the two preference lines and the 16 shared guard functions. Dot-sourcing it only defines them, but two of them write evidence files or call `gh` when invoked, so never call one by hand to re-check something. Never run the file yourself either — invoking a library with `&` or `-File` defines its functions in a throwaway scope and then discards them (exit 0, nothing loaded, a false green). |
| `scripts/uat/uat-session.ps1` | Side-effecting session bootstrap: the optional install, the safety preflight, and the staging directories. The entry points dot-source it; never run it yourself. |
| `scripts/uat/Invoke-UatM3a.ps1` | M3a entry point. |
| `scripts/uat/Invoke-UatM3b.ps1` | M3b entry point. |

Run only the two entry points. Each one dot-sources the library and the bootstrap itself, so it
recomputes the entire session from scratch: nothing carries across invocations, and M3a and M3b do
not have to share a shell. Every invocation, in this order:

1. Installs dependencies — `npm ci`, then `npx playwright install chromium`. This is the only work
   `-SkipInstall` skips.
2. Confirms `gh auth status`, that this checkout's GitHub repository is exactly `aberson/on-brand-private`,
   that the authenticated account can write issues there, and that issues #69 and #72 are readable.
3. Requires a clean checkout — `git status --porcelain=v1 --untracked-files=all` must be empty.
4. Requires `%LOCALAPPDATA%` to match the Windows known-folder location, then creates the staging
   tree below.

`-SkipInstall` skips **only** item 1. It does **not** skip any safety guard: the `gh` preflight, the
repository-identity check, the issue-readability check, the clean-checkout gate, and the
`%LOCALAPPDATA%` known-folder check all run on every invocation, with or without the switch. Use it
only when dependencies and Chromium are already current for this exact checkout.

Both phases below launch a child `powershell.exe -NoProfile`. That is a guard, not a preference: the
preflight resolves bare `git`, `gh`, `npm`, and `npx` through the session's command table, and
PowerShell resolves profile functions and aliases before external commands, so a profile-defined
`function git` could silently turn the clean-checkout gate into a no-op. These are also `.ps1` files
on disk, which an execution policy gates where a pasted fence did not. If PowerShell refuses to run
one, widen the policy for that window only, with
`Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`: it needs no elevation and expires with
the shell. Do not change a machine- or user-scoped policy.

Everything a run produces stays outside the checkout, under
`%LOCALAPPDATA%\on-brand\inspiration-uat`:

| Path | Contents |
|---|---|
| `%LOCALAPPDATA%\on-brand\inspiration-uat\inputs\` | The media bytes downloaded by hand, one file per candidate. |
| `%LOCALAPPDATA%\on-brand\inspiration-uat\trials\` | One new directory per non-retry M3a run, holding that run's generated proposals. |
| `%LOCALAPPDATA%\on-brand\inspiration-uat\m3a-selection.json` | Durable M3a evidence. |
| `%LOCALAPPDATA%\on-brand\inspiration-uat\m3b-acceptance.json` | Durable M3b evidence. |
| `%LOCALAPPDATA%\on-brand\inspiration-uat\archive\` | Evidence a later run archived because it had gone stale. |

If a run throws it stops there and adds no record it had not already written. A throw at or after
the issue post leaves the local evidence file on disk, and the comment may already be on the issue —
that is exactly what the repost affordance below exists for. Read the message, fix the cause it
names, and run that phase again from the top; the entry point recomputes the whole session and
re-runs every guard, so the same window is safe to reuse. Re-running over still-fresh evidence
offers an idempotent repost of that exact record (`RETRY <runId>`); evidence older than 24 hours is
archived and the phase repeated in full (`REGENERATE <runId>`).

## M3a — qualify and select

Open each official object page, recheck the work, creator, date, rights statement, policy link, and
actual downloadable media. Download the original/public-domain media bytes directly to the staging
path the run prints for that candidate. Do not use a screenshot, thumbnail, transformed derivative,
or uncertain file.

- [Water Lilies (1906), Art Institute of Chicago](https://www.artic.edu/artworks/16568/water-lilies)
- [Woman with a Parasol — Madame Monet and Her Son (1875), National Gallery of Art](https://www.nga.gov/artworks/61379-woman-parasol-madame-monet-and-her-son)
- [The Houses of Parliament, Sunset (1903), National Gallery of Art](https://www.nga.gov/artworks/46523-houses-parliament-sunset)

The three downloads belong in `%LOCALAPPDATA%\on-brand\inspiration-uat\inputs\` as
`water-lilies.jpg`, `parasol.jpg`, and `parliament-sunset.jpg`. Nothing creates that directory ahead
of time — the run itself does, during its setup — so start the command below first and download when
it tells you where. For each candidate it prints `Download <title> directly to: <path>` and then
waits on that candidate's eligibility prompt, which is the moment to fetch the file. On a machine
that has already completed an M3a run the directory exists, so the three files may be staged
beforehand instead.

Each staged file must be an unmodified institution-provided rendition of **1 through 5,000,000
bytes** whose leading bytes are **PNG, JPEG, or WebP** — the run reads the magic bytes, not the file
extension, so renaming a file changes nothing. Museum "original" downloads of these works often
exceed the 5,000,000-byte cap. If no official rendition of a candidate fits, reject that candidate:
do not recompress, crop, resize, or convert it, because that destroys the byte provenance this whole
phase exists to establish. A file that fails these checks is skipped with a warning, not a halt, so
a run in which all three fail simply ends with no candidate qualified and no record.

If an official download offers PNG or WebP instead of JPEG, name that candidate's file with
`-InputFilename` — a hashtable keyed by candidate slug — rather than editing anything. Do not edit
the script: `Invoke-UatM3a.ps1` is a tracked file, so an edit dirties the checkout and the
clean-checkout gate then refuses to run. Only `water-lilies`, `parasol`, and `parliament-sunset` are
accepted keys, and each value must be that same slug with a `.jpg`, `.jpeg`, `.png`, or `.webp`
extension.

Drop `-InputFilename` entirely when all three downloads are the default `.jpg`, and add
`-SkipInstall` when dependencies are already current for this checkout. `-Command` is what makes the
override possible: PowerShell's `-File` form passes every argument on as a literal string, so
`-InputFilename` cannot carry a hashtable there.

```powershell
powershell.exe -NoProfile -Command "& .\scripts\uat\Invoke-UatM3a.ps1 -InputFilename @{ parasol = 'parasol.png' }"
```

The run creates a new trial directory on every non-retry run and never reuses an older proposal. For
each candidate it prints the exact staging path plus the planning-time rights and policy leads, then
asks the operator to:

1. Type `ELIGIBLE` after rechecking the object page, the actual download, and the rights. Anything
   else rejects that candidate, and nothing is generated for it.
2. Paste the exact non-empty rights wording observed during this review.
3. Paste the exact HTTPS license or policy URL verified during this review.
4. Paste the exact HTTPS media-download URL used for these bytes — the URL the staged bytes were
   obtained from.

Items 3 and 4 must be plain `https://` URLs with no `#` fragment, no embedded credentials, and no
signed or expiring query parameters; copy the direct object and media URLs rather than a signed
download link. Items 2, 3, and 4 are published verbatim in the issue comment, alongside the local
staging path, so paste nothing that should not appear on the issue.

All four answers are validated together with the staged file as soon as the fourth is entered. An
empty rights string, a rejected URL, or an unusable file prints a warning and drops that candidate
for the rest of the run — there is no re-prompt. Recovering a dropped candidate means re-running the
phase from the top.

Each eligible candidate then goes through production `from-image`, `check`, and `preview --open`,
and its generated explanation page opens as well. Inspect both pages. Confirm palette fidelity;
numbered source-to-token callouts; sampled, adjusted, derived, and default-derived wording; source
credit and rights; reading order; and a useful explanation/specimen distinction. Type `QUALIFIED`
only if every human check passes; anything else rejects that candidate.

The run then lists the qualified slugs, asks for exactly one, and asks for `ACCEPT`. On `ACCEPT` it
re-checks the selected proposal, re-confirms the checkout is still clean, writes
`%LOCALAPPDATA%\on-brand\inspiration-uat\m3a-selection.json`, posts that file verbatim to issue #69,
and verifies the posted comment is character-identical to the local file. If no candidate qualifies,
the run stops without a record: leave Steps 34 and 35 PLANNED and create no ACCEPT record.

Do not start tracked demo work in this operator session. Once the local file and issue #69 comment
are identical, mark Steps 34 and 35 exactly `Status: DONE`, checkpoint that status-only change, and
resume automated work with:

Run in: fresh window @ on-brand · Model: Opus (default) — build-bearing automated steps

```text
/build-phase --plan documentation/inspiration-real-artwork-demo-plan.md --resume 36
```

Keep the selected input and proposal at their recorded paths until Step 36 validates them.

## M3b — accept the integrated demo

Run this only after Step 36 has committed the selected candidate as a `generated-draft`. Open a new
PowerShell shell in a fresh checkout of that exact commit. For both the explanation and specimen,
complete this fixed browser checklist before entering PASS:

1. At 1440 x 900 CSS pixels and 100% zoom, inspect the full reading order and every source-to-token
   relationship; use Tab through every interactive control, Shift+Tab back through them, and
   Enter/Space on controls that expose or change content.
2. At 390 x 844 CSS pixels and 100% zoom, repeat the reading-order and keyboard pass and confirm no
   content or focus indicator is clipped or hidden.
3. At the same narrow viewport and 200% zoom, repeat the essential reading and keyboard path and
   confirm the explanation and specimen remain meaningfully distinct. Restore 100% zoom afterward.

Use browser responsive-design mode to set the CSS viewport exactly; do not substitute a visually
similar freehand window size.

```powershell
powershell.exe -NoProfile -File .\scripts\uat\Invoke-UatM3b.ps1
```

`-SkipInstall` is the only parameter this phase takes, and it skips only the dependency and Chromium
installs; every safety guard still runs. This phase passes no hashtable, so it uses the `-File` form
its own script header documents.

Before it asks anything, the run re-reads the M3a evidence and its issue #69 comment, requires issue
#71 to be closed and exactly one Step 36 checkpoint on first-parent history, and requires HEAD to be
that exact commit with a clean tree. It then opens the explanation and the specimen, re-checks the
checked-in demo, and confirms the committed raster is byte-for-byte the M3a selection. Those last
two checks run after the pages open, so a run that throws there leaves two browser windows standing
on a draft that did not verify — close them and treat nothing you saw as reviewed.

Work the checklist above, then answer the prompts: `PASS` for the desktop review, the narrow-width
review, the artwork/attribution/rights review, the palette-fidelity and numbered-callouts review,
and the explanation-versus-specimen review. Any other answer stops the run and creates no ACCEPT
record. The run then takes accepted limitations as a semicolon-separated list (press Enter for
none), and finally `ACCEPT`. It re-verifies that nothing in the reviewed tree moved during the
review, writes `%LOCALAPPDATA%\on-brand\inspiration-uat\m3b-acceptance.json`, posts that file
verbatim to issue #72, and verifies the posted comment is character-identical to the local file.

Once the local file and issue #72 comment are identical, mark Steps 37 and 38 exactly
`Status: DONE`, checkpoint that status-only change, and resume automated work with:

Run in: fresh window @ on-brand · Model: Opus (default) — build-bearing automated steps

```text
/build-phase --plan documentation/inspiration-real-artwork-demo-plan.md --resume 39
```

Do not relabel or regenerate the accepted draft during M3b. The later automated step owns any
review-status promotion after it authenticates this evidence.
