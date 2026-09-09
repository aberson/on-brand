# On Brand real-artwork UAT - M3a entry point (qualify and select).
#
# Run it: powershell -NoProfile -Command "& <path>\Invoke-UatM3a.ps1"  (-File cannot bind -InputFilename)
#
# -SkipInstall skips ONLY npm ci + playwright install. Every safety guard
# (gh preflight, repo identity, issue readability, clean checkout, LOCALAPPDATA)
# still runs on every invocation.
#
# -InputFilename overrides a candidate staging file name without editing this
# tracked file (an edit would dirty the checkout and the clean-checkout gate
# would then refuse to run). Example:
#   -InputFilename @{ parasol = 'parasol.png' }
#
# The body below is VERBATIM from the M3a fence of
# documentation/inspiration-real-artwork-uat.md as of 538fec3 (lines 605-854).
param(
  [switch]$SkipInstall,
  [hashtable]$InputFilename
)

function Resolve-UatInputFilenameOverride {
  param([hashtable]$Override)
  $allowedSlugs = @('water-lilies', 'parasol', 'parliament-sunset')
  $resolved = @{}
  if ($null -eq $Override) { return $resolved }
  foreach ($key in @($Override.Keys)) {
    $slug = [string]$key
    if ($allowedSlugs -cnotcontains $slug) {
      throw "-InputFilename key '$slug' is not one of: $($allowedSlugs -join ', ')"
    }
    $value = [string]$Override[$key]
    # \A and \z (not ^ and $): .NET's $ also matches just before a single
    # trailing newline, which would accept "parasol.png`n" as one file name.
    $pattern = '\A' + [regex]::Escape($slug) + '\.(jpg|jpeg|png|webp)\z'
    if ($value -cnotmatch $pattern) {
      throw "-InputFilename value '$value' must be '$slug' with a .jpg, .jpeg, .png, or .webp extension"
    }
    $resolved[$slug] = $value
  }
  return $resolved
}

$script:InputFilenameOverride = Resolve-UatInputFilenameOverride -Override $InputFilename
$script:SkipInstall = [bool]$SkipInstall
. (Join-Path $PSScriptRoot 'uat-common.ps1')
. (Join-Path $PSScriptRoot 'uat-session.ps1')

$m3aPath = Join-Path $uatRoot 'm3a-selection.json'
$m3aWasExisting = Test-Path -LiteralPath $m3aPath
if ($m3aWasExisting) {
  Assert-SafeEvidencePath -Path $m3aPath -TrustedRoot $trustedLocalAppData -CheckoutRoot $repoRoot
  $m3a = Get-Content -LiteralPath $m3aPath -Raw | ConvertFrom-Json
  Assert-M3aStaging -Record $m3a -ExpectedRepository $repoName `
    -InputDirectory $inputsRoot -TrialDirectory $trialsRoot
  $timestamp = Get-ExactUtcTimestamp -Value $m3a.evidenceCreatedAt -Field 'M3a evidenceCreatedAt'
  $now = [DateTimeOffset]::UtcNow
  if ($timestamp -lt $now.AddHours(-24) -or $timestamp -gt $now.AddMinutes(5)) {
    $regenerate = Read-Host "M3a evidence is stale. Type REGENERATE $($m3a.runId) to archive it and repeat every M3a check"
    if ($regenerate -cne "REGENERATE $($m3a.runId)") { throw 'Stale M3a evidence was not regenerated' }
    $archiveRoot = Join-Path $uatRoot 'archive'
    [void](Assert-SafeLocalDirectory -Path $archiveRoot -TrustedRoot $trustedLocalAppData -CheckoutRoot $repoRoot)
    New-Item -ItemType Directory -Force -Path $archiveRoot | Out-Null
    [void](Assert-SafeLocalDirectory -Path $archiveRoot -TrustedRoot $trustedLocalAppData -CheckoutRoot $repoRoot)
    $archivePath = Join-Path $archiveRoot ("m3a-selection-$($m3a.runId).json")
    Assert-SafeEvidencePath -Path $archivePath -TrustedRoot $trustedLocalAppData -CheckoutRoot $repoRoot
    if (Test-Path -LiteralPath $archivePath) { throw "Archive already exists: $archivePath" }
    Move-Item -LiteralPath $m3aPath -Destination $archivePath
    $m3aWasExisting = $false
  } else {
    $retry = Read-Host "Type RETRY $($m3a.runId) to repost this exact still-fresh M3a decision"
    if ($retry -cne "RETRY $($m3a.runId)") { throw 'Existing M3a evidence was not selected for post retry' }
  }
}
if ($m3aWasExisting) {
  Write-Host 'Reusing the validated, still-fresh local M3a record for an idempotent post retry.'
} else {
$retrievedAt = Get-InvariantUtcDate
$candidates = @(
  [pscustomobject]@{
    Slug = 'water-lilies'
    InputFilename = 'water-lilies.jpg'
    Title = 'Water Lilies'
    Alt = 'Water lilies floating on a pond.'
    Creator = 'Claude Monet'
    ArtworkDate = '1906'
    SourceUrl = 'https://www.artic.edu/artworks/16568/water-lilies'
    RightsLead = 'CC0 Public Domain Designation'
    LicenseUrlLead = 'https://creativecommons.org/publicdomain/zero/1.0/'
  },
  [pscustomobject]@{
    Slug = 'parasol'
    InputFilename = 'parasol.jpg'
    Title = 'Woman with a Parasol — Madame Monet and Her Son'
    Alt = 'A woman holding a parasol on a grassy hill beneath a blue sky.'
    Creator = 'Claude Monet'
    ArtworkDate = '1875'
    SourceUrl = 'https://www.nga.gov/artworks/61379-woman-parasol-madame-monet-and-her-son'
    RightsLead = 'Public-domain media under the National Gallery of Art Open Access policy'
    LicenseUrlLead = 'https://www.nga.gov/open-access-images.html'
  },
  [pscustomobject]@{
    Slug = 'parliament-sunset'
    InputFilename = 'parliament-sunset.jpg'
    Title = 'The Houses of Parliament, Sunset'
    Alt = 'The Houses of Parliament silhouetted against a pastel sunset over the Thames.'
    Creator = 'Claude Monet'
    ArtworkDate = '1903'
    SourceUrl = 'https://www.nga.gov/artworks/46523-houses-parliament-sunset'
    RightsLead = 'Public-domain media under the National Gallery of Art Open Access policy'
    LicenseUrlLead = 'https://www.nga.gov/open-access-images.html'
  }
)
foreach ($overrideCandidate in $candidates) {
  if ($script:InputFilenameOverride.ContainsKey($overrideCandidate.Slug)) {
    $overrideCandidate.InputFilename = [string]$script:InputFilenameOverride[$overrideCandidate.Slug]
  }
} # end -InputFilename override

$trialRunId = [guid]::NewGuid().ToString()
$trialRoot = Join-Path $trialsRoot $trialRunId
[void](Assert-SafeLocalDirectory -Path $trialRoot -TrustedRoot $trustedLocalAppData -CheckoutRoot $repoRoot)
if (Test-Path -LiteralPath $trialRoot) { throw "Trial directory already exists: $trialRoot" }
New-Item -ItemType Directory -Path $trialRoot | Out-Null
[void](Assert-SafeLocalDirectory -Path $trialRoot -TrustedRoot $trustedLocalAppData -CheckoutRoot $repoRoot)
$qualified = [System.Collections.Generic.List[object]]::new()

foreach ($candidate in $candidates) {
  [void](Assert-SafeLocalDirectory -Path $inputsRoot -TrustedRoot $trustedLocalAppData -CheckoutRoot $repoRoot)
  $inputPath = Join-Path $inputsRoot $candidate.InputFilename
  Write-Host "Download $($candidate.Title) directly to: $inputPath"
  Write-Host "Planning-time rights lead: $($candidate.RightsLead)"
  Write-Host "Planning-time policy lead: $($candidate.LicenseUrlLead)"
  $eligibility = Read-Host 'After rechecking the object page, actual download, and rights, type ELIGIBLE or anything else to reject'
  if ($eligibility -cne 'ELIGIBLE') {
    Write-Warning "$($candidate.Slug) rejected before generation; no proposal was created"
    continue
  }
  $rights = Read-Host 'Paste the exact non-empty rights wording observed during this review'
  $licenseUrl = Read-Host 'Paste the exact HTTPS license or policy URL verified during this review'
  $mediaDownloadUrl = Read-Host 'Paste the exact HTTPS media-download URL used for these bytes'
  try {
    if ([string]::IsNullOrWhiteSpace($rights)) { throw 'rights wording is empty' }
    Assert-HttpsUrl -Value $licenseUrl -Field 'licenseUrl'
    Assert-HttpsUrl -Value $mediaDownloadUrl -Field 'mediaDownloadUrl'
    $inputItem = Get-Item -LiteralPath $inputPath
    if ($inputItem.PSIsContainer -or
        ($inputItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'staged input is not a direct regular file'
    }
    $media = Get-BoundedMediaInfo -Path $inputPath
  } catch {
    Write-Warning "$($candidate.Slug) rejected before generation: $($_.Exception.Message)"
    continue
  }

  $candidateOut = Join-Path $trialRoot $candidate.Slug
  [void](Assert-SafeLocalDirectory -Path $candidateOut -TrustedRoot $trustedLocalAppData -CheckoutRoot $repoRoot)
  if (Test-Path -LiteralPath $candidateOut) { throw "Candidate output already exists: $candidateOut" }
  New-Item -ItemType Directory -Path $candidateOut | Out-Null
  [void](Assert-SafeLocalDirectory -Path $candidateOut -TrustedRoot $trustedLocalAppData -CheckoutRoot $repoRoot)
  node bin/onbrand.mjs from-image $inputPath `
    --title $candidate.Title `
    --alt $candidate.Alt `
    --creator $candidate.Creator `
    --artwork-date $candidate.ArtworkDate `
    --source-url $candidate.SourceUrl `
    --rights $rights `
    --license-url $licenseUrl `
    --retrieved-at $retrievedAt `
    --out $candidateOut `
    --no-llm
  if ($LASTEXITCODE -ne 0) { throw "from-image failed for $($candidate.Slug) with exit $LASTEXITCODE" }

  $proposals = @(Get-ChildItem -LiteralPath $candidateOut -Directory)
  if ($proposals.Count -ne 1) {
    throw "Expected exactly one new proposal for $($candidate.Slug); found $($proposals.Count)"
  }
  $proposal = $proposals[0]
  if (Test-Path -LiteralPath (Join-Path $proposal.FullName 'INCOMPLETE.md')) {
    throw "Proposal is incomplete: $($proposal.FullName)"
  }

  node bin/onbrand.mjs check $proposal.FullName
  if ($LASTEXITCODE -ne 0) { throw "check failed for $($candidate.Slug) with exit $LASTEXITCODE" }
  node bin/onbrand.mjs preview $proposal.FullName --open
  if ($LASTEXITCODE -ne 0) { throw "preview failed for $($candidate.Slug) with exit $LASTEXITCODE" }
  $explanationPath = Join-Path $proposal.FullName 'brand\dist\inspiration-to-implementation.html'
  if (-not (Test-Path -LiteralPath $explanationPath -PathType Leaf)) {
    throw "Missing explanation for $($candidate.Slug)"
  }
  Start-Process -FilePath $explanationPath

  $tracePath = Join-Path $proposal.FullName 'brand\inspiration.json'
  $trace = Get-Content -LiteralPath $tracePath -Raw | ConvertFrom-Json
  if ($trace.reviewStatus -cne 'generated-draft' -or
      $trace.asset.sha256 -cne $media.Sha256 -or
      $trace.asset.mediaType -cne $media.MediaType -or
      $trace.asset.title -cne $candidate.Title -or
      $trace.asset.alt -cne $candidate.Alt -or
      $trace.asset.creator -cne $candidate.Creator -or
      $trace.asset.date -cne $candidate.ArtworkDate -or
      $trace.asset.sourceUrl -cne $candidate.SourceUrl -or
      $trace.asset.rights -cne $rights -or
      $trace.asset.licenseUrl -cne $licenseUrl -or
      $trace.asset.retrievedAt -cne $retrievedAt) {
    throw "Generated trace does not match the qualified input for $($candidate.Slug)"
  }

  Write-Host 'Inspect both pages. Confirm palette fidelity; numbered source-to-token callouts; sampled, adjusted, derived, and default-derived wording; source credit and rights; reading order; and a useful explanation/specimen distinction.'
  $visualDecision = Read-Host 'Type QUALIFIED only if every human check passes; anything else rejects this candidate'
  if ($visualDecision -cne 'QUALIFIED') {
    Write-Warning "$($candidate.Slug) rejected after visual review"
    continue
  }

  $qualified.Add([pscustomobject]@{
    demoSlug = $candidate.Slug
    stagingPath = $proposal.FullName
    inputFilename = $candidate.InputFilename
    assetSha256 = $media.Sha256
    assetBytes = $media.Bytes
    mediaType = $media.MediaType
    title = $candidate.Title
    alt = $candidate.Alt
    creator = $candidate.Creator
    artworkDate = $candidate.ArtworkDate
    sourceUrl = $candidate.SourceUrl
    mediaDownloadUrl = $mediaDownloadUrl
    rights = $rights
    licenseUrl = $licenseUrl
    retrievedAt = $retrievedAt
  })
}

if ($qualified.Count -eq 0) {
  throw 'No candidate qualified. Leave Steps 34 and 35 PLANNED and do not create an ACCEPT record.'
}
Write-Host "Qualified candidates: $((@($qualified.demoSlug)) -join ', ')"
$selectedSlug = Read-Host 'Type exactly one qualified slug to select it'
$selectedRows = @($qualified | Where-Object { $_.demoSlug -ceq $selectedSlug })
if ($selectedRows.Count -ne 1) { throw 'Selection must name exactly one qualified candidate' }
$selected = $selectedRows[0]
$decision = Read-Host 'Type ACCEPT to create the durable M3a evidence, or anything else to stop'
if ($decision -cne 'ACCEPT') {
  throw 'Selection was not accepted. Leave Steps 34 and 35 PLANNED and create no record.'
}
node bin/onbrand.mjs check $selected.stagingPath
if ($LASTEXITCODE -ne 0) { throw "Final selected-proposal check failed with exit $LASTEXITCODE" }
$preEvidenceDirty = @(git status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0 -or $preEvidenceDirty.Count -ne 0) {
  throw 'The checkout changed during M3a; create no ACCEPT record'
}

$m3a = [ordered]@{
  schema = 'onbrand.inspiration-real-artwork-uat-selection'
  schemaVersion = 1
  repository = $repoName
  issueNumber = 69
  planStep = 34
  runId = [guid]::NewGuid().ToString()
  evidenceCreatedAt = Get-InvariantUtcTimestamp
  decision = 'ACCEPT'
  demoSlug = $selected.demoSlug
  stagingPath = $selected.stagingPath
  inputFilename = $selected.inputFilename
  assetSha256 = $selected.assetSha256
  assetBytes = $selected.assetBytes
  mediaType = $selected.mediaType
  title = $selected.title
  alt = $selected.alt
  creator = $selected.creator
  artworkDate = $selected.artworkDate
  sourceUrl = $selected.sourceUrl
  mediaDownloadUrl = $selected.mediaDownloadUrl
  rights = $selected.rights
  licenseUrl = $selected.licenseUrl
  retrievedAt = $selected.retrievedAt
}
Assert-M3aStaging -Record ([pscustomobject]$m3a) -ExpectedRepository $repoName `
  -InputDirectory $inputsRoot -TrialDirectory $trialsRoot

$m3aJson = ([pscustomobject]$m3a | ConvertTo-Json -Depth 4 -Compress)
Write-AtomicEvidenceJson -Path $m3aPath -Json $m3aJson -UatDirectory $uatRoot `
  -TrustedRoot $trustedLocalAppData -CheckoutRoot $repoRoot
}

Assert-SafeEvidencePath -Path $m3aPath -TrustedRoot $trustedLocalAppData -CheckoutRoot $repoRoot
Assert-M3aStaging -Record ([pscustomobject]$m3a) -ExpectedRepository $repoName `
  -InputDirectory $inputsRoot -TrialDirectory $trialsRoot
Assert-FreshEvidenceTimestamp -Value $m3a.evidenceCreatedAt -Field 'M3a evidenceCreatedAt'
node bin/onbrand.mjs check $m3a.stagingPath
if ($LASTEXITCODE -ne 0) { throw "Pre-post selected-proposal check failed with exit $LASTEXITCODE" }
$prePostDirty = @(git status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0 -or $prePostDirty.Count -ne 0) {
  throw 'The checkout changed before the M3a post; keep the evidence local and post nothing'
}
gh issue comment 69 --repo $repoName --body-file $m3aPath
if ($LASTEXITCODE -ne 0) { throw 'Posting M3a evidence to issue #69 failed' }
Assert-LatestJsonComment -IssueNumber 69 -Repository $repoName `
  -Schema 'onbrand.inspiration-real-artwork-uat-selection' -LocalPath $m3aPath `
  -ExpectedAuthor $operatorLogin
Write-Host "M3a evidence is durable: $m3aPath"
