# On Brand real-artwork UAT - M3b entry point (accept the checked-in draft).
#
# Run it: powershell -NoProfile -File <path>\Invoke-UatM3b.ps1
#
# -SkipInstall skips ONLY npm ci + playwright install. Every safety guard
# (gh preflight, repo identity, issue readability, clean checkout, LOCALAPPDATA)
# still runs on every invocation.
#
# The body below is VERBATIM from the M3b fence of
# documentation/inspiration-real-artwork-uat.md as of 538fec3 (lines 886-1185),
# with ONE DELIBERATE DEVIATION (issue #87): the checked-in-raster reparse walk
# advanced with a bare $cursor.Parent, which throws under StrictMode because the
# walk starts at a FileInfo. It is the same defect that blocked every M3a run,
# and would have blocked M3b identically.
param(
  [switch]$SkipInstall
)

$script:SkipInstall = [bool]$SkipInstall
. (Join-Path $PSScriptRoot 'uat-common.ps1')
. (Join-Path $PSScriptRoot 'uat-session.ps1')

$m3aPath = Join-Path $uatRoot 'm3a-selection.json'
$selection = Get-Content -LiteralPath $m3aPath -Raw | ConvertFrom-Json
Assert-M3aEnvelope -Record $selection -ExpectedRepository $repoName
Assert-LatestJsonComment -IssueNumber 69 -Repository $repoName `
  -Schema 'onbrand.inspiration-real-artwork-uat-selection' -LocalPath $m3aPath `
  -ExpectedAuthor $operatorLogin

$step36Issue = gh issue view 71 --repo $repoName --json number,state | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or [int]$step36Issue.number -ne 71 -or $step36Issue.state -cne 'CLOSED') {
  throw 'M3b requires closed Step 36 issue #71'
}
$step36Subject = 'checkpoint: step 36 complete — Promote the selected real-artwork draft demo'
$step36Rows = @(
  git log --first-parent --format='%H%x09%s' | ForEach-Object {
    $parts = $_.Split("`t", 2)
    if ($parts.Count -eq 2 -and $parts[1] -ceq $step36Subject) {
      [pscustomobject]@{ Commit = $parts[0]; Subject = $parts[1] }
    }
  }
)
if ($LASTEXITCODE -ne 0 -or $step36Rows.Count -ne 1) {
  throw 'Could not identify exactly one Step 36 checkpoint on first-parent history'
}
$step36Commit = [string]$step36Rows[0].Commit

$repoDirty = @(git status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0 -or $repoDirty.Count -ne 0) {
  throw 'M3b requires a clean checkout of the exact Step 36 draft'
}
$reviewedCommit = (git rev-parse HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $reviewedCommit -cnotmatch '^[0-9a-f]{40}$') {
  throw 'Could not resolve the reviewed commit'
}
if ($reviewedCommit -cne $step36Commit) {
  throw "Check out the exact Step 36 checkpoint before M3b: $step36Commit"
}
$demoRoot = Join-Path $repoRoot ("examples\inspiration\$($selection.demoSlug)")
if (-not (Test-Path -LiteralPath $demoRoot -PathType Container)) {
  throw "Missing checked-in demo: $demoRoot"
}
$demoStatus = @(git status --porcelain=v1 --untracked-files=all -- "examples/inspiration/$($selection.demoSlug)")
if ($LASTEXITCODE -ne 0 -or $demoStatus.Count -ne 0) { throw 'The demo tree differs from HEAD' }

node bin/onbrand.mjs check $demoRoot
if ($LASTEXITCODE -ne 0) { throw "check failed with exit $LASTEXITCODE" }
$explanationPath = Join-Path $demoRoot 'brand\dist\inspiration-to-implementation.html'
$specimenPath = Join-Path $demoRoot 'brand\dist\specimen.html'
if (-not (Test-Path -LiteralPath $explanationPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $specimenPath -PathType Leaf)) {
  throw 'The checked-in explanation or specimen is missing'
}
Start-Process -FilePath $explanationPath
Start-Process -FilePath $specimenPath

$trace = Get-Content -LiteralPath (Join-Path $demoRoot 'brand\inspiration.json') -Raw | ConvertFrom-Json
if ($trace.reviewStatus -cne 'generated-draft' -or
    $trace.asset.sha256 -cne $selection.assetSha256 -or
    $trace.asset.mediaType -cne $selection.mediaType -or
    $trace.asset.title -cne $selection.title -or
    $trace.asset.alt -cne $selection.alt -or
    $trace.asset.creator -cne $selection.creator -or
    $trace.asset.date -cne $selection.artworkDate -or
    $trace.asset.sourceUrl -cne $selection.sourceUrl -or
    $trace.asset.rights -cne $selection.rights -or
    $trace.asset.licenseUrl -cne $selection.licenseUrl -or
    $trace.asset.retrievedAt -cne $selection.retrievedAt) {
  throw 'The checked-in draft trace is not the M3a-selected record'
}
$assetRelative = [string]$trace.asset.path
$assetParts = @($assetRelative -split '/')
if ([IO.Path]::IsPathRooted($assetRelative) -or
    $assetRelative.Contains('\') -or
    -not $assetRelative.StartsWith('assets/', [StringComparison]::Ordinal) -or
    $assetParts.Count -lt 2 -or
    @($assetParts | Where-Object { $_ -in @('', '.', '..') }).Count -ne 0) {
  throw 'The checked-in trace asset path is not a bounded brand-relative path'
}
$brandItem = Get-Item -LiteralPath (Resolve-Path -LiteralPath (Join-Path $demoRoot 'brand'))
$assetPath = Join-Path $brandItem.FullName ($assetRelative.Replace('/', '\'))
$assetItem = Get-Item -LiteralPath (Resolve-Path -LiteralPath $assetPath)
$brandPrefix = $brandItem.FullName.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
if (-not $assetItem.FullName.StartsWith($brandPrefix, [StringComparison]::OrdinalIgnoreCase) -or
    $assetItem.PSIsContainer) {
  throw 'The checked-in raster resolves outside the demo brand or is not a file'
}
$cursor = $assetItem
while ($null -ne $cursor -and
       -not $cursor.FullName.Equals($brandItem.FullName, [StringComparison]::OrdinalIgnoreCase)) {
  if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "The checked-in raster path crosses a reparse point: $($cursor.FullName)"
  }
  # Issue #87, same defect as Assert-M3aStaging in uat-common.ps1: this walk
  # starts at a FILE, and FileInfo exposes .Directory, not .Parent. Under
  # StrictMode the bare .Parent throws instead of yielding $null, which would
  # block every M3b run exactly as it blocked M3a. Deviates from 538fec3.
  $cursor = if ($cursor -is [IO.FileInfo]) { $cursor.Directory } else { $cursor.Parent }
}
if ($null -eq $cursor -or
    ($brandItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'The checked-in raster is not a direct descendant of the demo brand'
}
$committedMedia = Get-BoundedMediaInfo -Path $assetItem.FullName
if ($committedMedia.Sha256 -cne $selection.assetSha256 -or
    $committedMedia.Bytes -ne [int64]$selection.assetBytes -or
    $committedMedia.MediaType -cne $selection.mediaType) {
  throw 'The checked-in raster bytes do not match the M3a selection'
}

$digestPaths = [ordered]@{
  assetSha256 = "brand\$($assetRelative.Replace('/', '\'))"
  rawImageAnalysisSha256 = 'raw-image-analysis.json'
  tokensSha256 = 'brand\tokens.json'
  darkModeSha256 = 'brand\modes.dark.json'
  inspirationSha256 = 'brand\inspiration.json'
  manifestSha256 = 'brand\dist\manifest.json'
  explanationSha256 = 'brand\dist\inspiration-to-implementation.html'
  specimenSha256 = 'brand\dist\specimen.html'
}
$digests = [ordered]@{}
foreach ($entry in $digestPaths.GetEnumerator()) {
  $relativeGitPath = "examples/inspiration/$($selection.demoSlug)/$($entry.Value.Replace('\', '/'))"
  git diff --quiet $reviewedCommit -- $relativeGitPath
  if ($LASTEXITCODE -ne 0) { throw "$relativeGitPath differs from reviewedCommit" }
  $digests[$entry.Key] = Get-LowerSha256 -Path (Join-Path $demoRoot $entry.Value)
}

$m3bPath = Join-Path $uatRoot 'm3b-acceptance.json'
$m3bWasExisting = Test-Path -LiteralPath $m3bPath
if ($m3bWasExisting) {
  Assert-SafeEvidencePath -Path $m3bPath -TrustedRoot $trustedLocalAppData -CheckoutRoot $repoRoot
  $m3b = Get-Content -LiteralPath $m3bPath -Raw | ConvertFrom-Json
  if ($m3b.runId -isnot [string] -or
      $m3b.runId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
    throw 'Existing M3b evidence has no valid UUIDv4 runId'
  }
  $timestamp = Get-ExactUtcTimestamp -Value $m3b.evidenceCreatedAt -Field 'M3b evidenceCreatedAt'
  $now = [DateTimeOffset]::UtcNow
  if ($timestamp -lt $now.AddHours(-24) -or $timestamp -gt $now.AddMinutes(5)) {
    $regenerate = Read-Host "M3b evidence is stale. Type REGENERATE $($m3b.runId) to archive it and repeat every M3b check"
    if ($regenerate -cne "REGENERATE $($m3b.runId)") { throw 'Stale M3b evidence was not regenerated' }
    $archiveRoot = Join-Path $uatRoot 'archive'
    [void](Assert-SafeLocalDirectory -Path $archiveRoot -TrustedRoot $trustedLocalAppData -CheckoutRoot $repoRoot)
    New-Item -ItemType Directory -Force -Path $archiveRoot | Out-Null
    [void](Assert-SafeLocalDirectory -Path $archiveRoot -TrustedRoot $trustedLocalAppData -CheckoutRoot $repoRoot)
    $archivePath = Join-Path $archiveRoot ("m3b-acceptance-$($m3b.runId).json")
    Assert-SafeEvidencePath -Path $archivePath -TrustedRoot $trustedLocalAppData -CheckoutRoot $repoRoot
    if (Test-Path -LiteralPath $archivePath) { throw "Archive already exists: $archivePath" }
    Move-Item -LiteralPath $m3bPath -Destination $archivePath
    $m3bWasExisting = $false
  } else {
    $retry = Read-Host "Type RETRY $($m3b.runId) to repost this exact still-fresh M3b decision"
    if ($retry -cne "RETRY $($m3b.runId)") { throw 'Existing M3b evidence was not selected for post retry' }
  }
}
if ($m3bWasExisting) {
  Write-Host 'Reusing the validated, still-fresh local M3b record for an idempotent post retry.'
} else {
Write-Host 'Inspect the explanation and specimen at desktop and narrow widths. Check the artwork, attribution, rights wording, palette fidelity, numbered source-to-token relationships, reading order, zoom and keyboard behavior, and whether the explanation adds meaning beyond the specimen.'
function Read-Pass {
  param([Parameter(Mandatory)][string]$Label)
  $value = Read-Host "Type PASS only if $Label passes"
  if ($value -cne 'PASS') { throw "$Label did not pass; create no M3b ACCEPT record" }
  return 'PASS'
}
$desktop = Read-Pass -Label 'desktop review'
$narrow = Read-Pass -Label 'narrow-width review'
$sourceRights = Read-Pass -Label 'artwork, attribution, and rights review'
$paletteCallouts = Read-Pass -Label 'palette fidelity and numbered callouts review'
$explanationVsSpecimen = Read-Pass -Label 'explanation versus specimen review'
$limitationsText = Read-Host 'Enter accepted limitations separated by semicolons, or press Enter for none'
[string[]]$acceptedLimitations = @()
if (-not [string]::IsNullOrWhiteSpace($limitationsText)) {
  $acceptedLimitations = [string[]]@(
    $limitationsText.Split(';') | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 }
  )
}
$m3bDecision = Read-Host 'Type ACCEPT to accept this exact checked-in draft, or anything else to stop'
if ($m3bDecision -cne 'ACCEPT') { throw 'M3b was not accepted; create no ACCEPT record' }

$m3b = [pscustomobject][ordered]@{
  schema = 'onbrand.inspiration-real-artwork-uat-acceptance'
  schemaVersion = 1
  repository = $repoName
  issueNumber = 72
  planStep = 37
  runId = [guid]::NewGuid().ToString()
  selectionRunId = [string]$selection.runId
  evidenceCreatedAt = Get-InvariantUtcTimestamp
  decision = 'ACCEPT'
  demoSlug = [string]$selection.demoSlug
  reviewedCommit = $reviewedCommit
  assetSha256 = $digests.assetSha256
  rawImageAnalysisSha256 = $digests.rawImageAnalysisSha256
  tokensSha256 = $digests.tokensSha256
  darkModeSha256 = $digests.darkModeSha256
  inspirationSha256 = $digests.inspirationSha256
  manifestSha256 = $digests.manifestSha256
  explanationSha256 = $digests.explanationSha256
  specimenSha256 = $digests.specimenSha256
  desktop = $desktop
  narrow = $narrow
  sourceRights = $sourceRights
  paletteCallouts = $paletteCallouts
  explanationVsSpecimen = $explanationVsSpecimen
  acceptedLimitations = $acceptedLimitations
}
}

$m3bFields = @(
  'schema', 'schemaVersion', 'repository', 'issueNumber', 'planStep', 'runId',
  'selectionRunId', 'evidenceCreatedAt', 'decision', 'demoSlug', 'reviewedCommit',
  'assetSha256', 'rawImageAnalysisSha256', 'tokensSha256', 'darkModeSha256',
  'inspirationSha256', 'manifestSha256', 'explanationSha256', 'specimenSha256',
  'desktop', 'narrow', 'sourceRights', 'paletteCallouts', 'explanationVsSpecimen',
  'acceptedLimitations'
)
Assert-ExactFields -Record $m3b -Expected $m3bFields -Label 'M3b'
foreach ($field in @(
  'schema', 'repository', 'runId', 'selectionRunId', 'evidenceCreatedAt', 'decision',
  'demoSlug', 'reviewedCommit', 'assetSha256', 'rawImageAnalysisSha256', 'tokensSha256',
  'darkModeSha256', 'inspirationSha256', 'manifestSha256', 'explanationSha256',
  'specimenSha256', 'desktop', 'narrow', 'sourceRights', 'paletteCallouts',
  'explanationVsSpecimen'
)) {
  if ($m3b.$field -isnot [string]) { throw "M3b $field must be a JSON string" }
}
foreach ($field in 'schemaVersion', 'issueNumber', 'planStep') {
  if (-not (Test-JsonIntegerType -Value $m3b.$field)) {
    throw "M3b $field must be a JSON integer"
  }
}
if ($m3b.acceptedLimitations -isnot [System.Array]) {
  throw 'M3b acceptedLimitations must be a JSON array'
}
if ($m3b.schema -cne 'onbrand.inspiration-real-artwork-uat-acceptance' -or
    $m3b.schemaVersion -ne 1 -or
    $m3b.repository -cne $repoName -or
    $m3b.issueNumber -ne 72 -or
    $m3b.planStep -ne 37 -or
    $m3b.decision -cne 'ACCEPT' -or
    $m3b.selectionRunId -cne $selection.runId -or
    $m3b.demoSlug -cne $selection.demoSlug -or
    $m3b.reviewedCommit -cnotmatch '^[0-9a-f]{40}$' -or
    $m3b.reviewedCommit -cne $reviewedCommit -or
    $m3b.assetSha256 -cne $selection.assetSha256) {
  throw 'M3b identity, commit, selection, or decision fields are invalid'
}
if ($m3b.runId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or
    $m3b.selectionRunId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
  throw 'M3b UUID fields are invalid'
}
[void](Get-ExactUtcTimestamp -Value $m3b.evidenceCreatedAt -Field 'M3b evidenceCreatedAt')
Assert-FreshEvidenceTimestamp -Value $m3b.evidenceCreatedAt -Field 'M3b evidenceCreatedAt'
foreach ($field in 'assetSha256', 'rawImageAnalysisSha256', 'tokensSha256', 'darkModeSha256', 'inspirationSha256', 'manifestSha256', 'explanationSha256', 'specimenSha256') {
  if ([string]$m3b.$field -cnotmatch '^[0-9a-f]{64}$') { throw "M3b $field is invalid" }
  if ($m3b.$field -cne $digests[$field]) {
    throw "M3b $field does not match the reviewed tree"
  }
}
foreach ($field in 'desktop', 'narrow', 'sourceRights', 'paletteCallouts', 'explanationVsSpecimen') {
  if ($m3b.$field -cne 'PASS') { throw "M3b $field must be PASS" }
}
foreach ($limitation in @($m3b.acceptedLimitations)) {
  if ($limitation -isnot [string] -or [string]::IsNullOrWhiteSpace($limitation)) {
    throw 'M3b limitations must be non-empty strings'
  }
}

$m3bJson = ($m3b | ConvertTo-Json -Depth 4 -Compress)
if ($m3bJson -cnotmatch '"acceptedLimitations":\[') {
  throw 'M3b acceptedLimitations must serialize as a JSON array'
}
node bin/onbrand.mjs check $demoRoot
if ($LASTEXITCODE -ne 0) { throw "final check failed with exit $LASTEXITCODE" }
$postReviewDirty = @(git status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0 -or $postReviewDirty.Count -ne 0) {
  throw 'The checkout changed during M3b; create no ACCEPT record'
}
$endCommit = (git rev-parse HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $endCommit -cne $reviewedCommit) {
  throw 'HEAD changed during M3b; create no ACCEPT record'
}
foreach ($entry in $digestPaths.GetEnumerator()) {
  $relativeGitPath = "examples/inspiration/$($selection.demoSlug)/$($entry.Value.Replace('\', '/'))"
  git diff --quiet $reviewedCommit -- $relativeGitPath
  if ($LASTEXITCODE -ne 0) { throw "$relativeGitPath changed during M3b" }
  $recordedDigest = [string]$m3b.PSObject.Properties[$entry.Key].Value
  if ((Get-LowerSha256 -Path (Join-Path $demoRoot $entry.Value)) -cne $recordedDigest) {
    throw "$relativeGitPath digest changed during M3b"
  }
}

if (-not $m3bWasExisting) {
  Write-AtomicEvidenceJson -Path $m3bPath -Json $m3bJson -UatDirectory $uatRoot `
    -TrustedRoot $trustedLocalAppData -CheckoutRoot $repoRoot
}

Assert-SafeEvidencePath -Path $m3bPath -TrustedRoot $trustedLocalAppData -CheckoutRoot $repoRoot
gh issue comment 72 --repo $repoName --body-file $m3bPath
if ($LASTEXITCODE -ne 0) { throw 'Posting M3b evidence to issue #72 failed' }
Assert-LatestJsonComment -IssueNumber 72 -Repository $repoName `
  -Schema 'onbrand.inspiration-real-artwork-uat-acceptance' -LocalPath $m3bPath `
  -ExpectedAuthor $operatorLogin
Write-Host "M3b evidence is durable: $m3bPath"
