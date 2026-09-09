# On Brand real-artwork UAT (M3a + M3b) - shared guard library.
#
# Dot-source it: . <path>   -- for example: . "$PSScriptRoot\uat-common.ps1"
# Invoking this file with & or -File defines its functions inside a throwaway
# scope and then discards them: exit 0, nothing usable, a false green.
# See .claude/rules/windows-shell.md (Script invocation shape).
#
# Everything below this header is VERBATIM from the setup fence of
# documentation/inspiration-real-artwork-uat.md as of 538fec3 (lines 22-23, 86-217, 230-585):
# the two preference lines plus the 16 pure guard functions. The functions do
# no network I/O and never prompt, so a test may safely dot-source this file.
#
# TWO DELIBERATE DEVIATIONS from 538fec3:
#
#  1. Assert-M3aStaging (issue #87): the proposal-raster reparse walk advanced
#     with a bare $cursor.Parent, which throws under StrictMode because the walk
#     starts at a FileInfo. It blocked every M3a run before any evidence was
#     written. Fixed in place rather than re-filed, because the verbatim copy is
#     unrunnable without it.
#  2. Assert-HttpsUrl (issue #84): the query-parameter scan split only on '&'
#     and ';', so a stray second '?' hid a secret-bearing parameter from the
#     detector. That guard protects URLs an operator pastes, which are written
#     into evidence and posted publicly, so it is fixed before the M3b run that
#     depends on it.
#
# No test pins byte-equality with 538fec3; test/repo.text-hygiene.test.ts pins
# the UTF-8 BOM and the non-ASCII allowlist, both of which still hold.
# Side-effecting bootstrap lives in uat-session.ps1 - never dot-sourced by a test.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Assert-SafeLocalDirectory {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$TrustedRoot,
    [Parameter(Mandatory)][string]$CheckoutRoot
  )
  $target = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  $trusted = [IO.Path]::GetFullPath($TrustedRoot).TrimEnd('\', '/')
  $checkout = [IO.Path]::GetFullPath($CheckoutRoot).TrimEnd('\', '/')
  $trustedPrefix = $trusted + [IO.Path]::DirectorySeparatorChar
  $targetPrefix = $target + [IO.Path]::DirectorySeparatorChar
  $checkoutPrefix = $checkout + [IO.Path]::DirectorySeparatorChar
  if (-not $target.StartsWith($trustedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Path is not a strict descendant of the trusted local application-data directory"
  }
  if ($target.Equals($checkout, [StringComparison]::OrdinalIgnoreCase) -or
      $target.StartsWith($checkoutPrefix, [StringComparison]::OrdinalIgnoreCase) -or
      $checkout.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Path overlaps the Git checkout"
  }
  $trustedItem = Get-Item -LiteralPath $trusted
  if (-not $trustedItem.PSIsContainer -or
      ($trustedItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The trusted local application-data directory is not a direct directory'
  }
  $relative = $target.Substring($trustedPrefix.Length)
  $cursor = $trusted
  foreach ($segment in @($relative -split '[\\/]')) {
    if ([string]::IsNullOrWhiteSpace($segment) -or $segment -in @('.', '..')) {
      throw "$Path contains an invalid directory segment"
    }
    $cursor = Join-Path $cursor $segment
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor
      if (-not $item.PSIsContainer -or
          ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Unsafe local directory component: $cursor"
      }
    }
  }
  return $target
}

function Assert-SafeEvidencePath {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$TrustedRoot,
    [Parameter(Mandatory)][string]$CheckoutRoot
  )
  [void](Assert-SafeLocalDirectory -Path (Split-Path -Parent $Path) `
    -TrustedRoot $TrustedRoot -CheckoutRoot $CheckoutRoot)
  if (Test-Path -LiteralPath $Path) {
    $item = Get-Item -LiteralPath $Path
    if ($item.PSIsContainer -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Unsafe evidence file: $Path"
    }
  }
}

function Get-InvariantUtcTimestamp {
  return [DateTimeOffset]::UtcNow.ToString(
    "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
    [Globalization.CultureInfo]::InvariantCulture
  )
}

function Get-InvariantUtcDate {
  return [DateTimeOffset]::UtcNow.ToString(
    'yyyy-MM-dd',
    [Globalization.CultureInfo]::InvariantCulture
  )
}

function Write-AtomicEvidenceJson {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Json,
    [Parameter(Mandatory)][string]$UatDirectory,
    [Parameter(Mandatory)][string]$TrustedRoot,
    [Parameter(Mandatory)][string]$CheckoutRoot
  )
  if ($Json -match '[\r\n]') { throw 'Evidence JSON must be exactly one line before writing' }

  $safeUat = Assert-SafeLocalDirectory -Path $UatDirectory `
    -TrustedRoot $TrustedRoot -CheckoutRoot $CheckoutRoot
  $uatItem = Get-Item -LiteralPath (Resolve-Path -LiteralPath $safeUat)
  if (-not $uatItem.PSIsContainer -or
      ($uatItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The UAT evidence directory is not a direct local directory'
  }

  $destination = [IO.Path]::GetFullPath($Path)
  $destinationParent = [IO.Path]::GetFullPath((Split-Path -Parent $destination)).TrimEnd('\', '/')
  if (-not $destinationParent.Equals(
      $uatItem.FullName.TrimEnd('\', '/'),
      [StringComparison]::OrdinalIgnoreCase
    )) {
    throw 'Evidence files must be direct children of the validated UAT directory'
  }
  Assert-SafeEvidencePath -Path $destination -TrustedRoot $TrustedRoot `
    -CheckoutRoot $CheckoutRoot
  if (Test-Path -LiteralPath $destination) {
    throw "Evidence destination already exists: $destination"
  }

  $temporary = Join-Path $uatItem.FullName (".onbrand-evidence-$([guid]::NewGuid()).tmp")
  Assert-SafeEvidencePath -Path $temporary -TrustedRoot $TrustedRoot `
    -CheckoutRoot $CheckoutRoot
  try {
    [IO.File]::WriteAllText(
      $temporary,
      $Json + [Environment]::NewLine,
      [Text.UTF8Encoding]::new($false)
    )
    Assert-SafeEvidencePath -Path $temporary -TrustedRoot $TrustedRoot `
      -CheckoutRoot $CheckoutRoot
    Assert-SafeEvidencePath -Path $destination -TrustedRoot $TrustedRoot `
      -CheckoutRoot $CheckoutRoot
    if (Test-Path -LiteralPath $destination) {
      throw "Evidence destination appeared during write: $destination"
    }
    [IO.File]::Move($temporary, $destination)
  } finally {
    if (Test-Path -LiteralPath $temporary) {
      Remove-Item -LiteralPath $temporary -Force -ErrorAction Stop
    }
  }
  Assert-SafeEvidencePath -Path $destination -TrustedRoot $TrustedRoot `
    -CheckoutRoot $CheckoutRoot
}

function Get-LowerSha256 {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing file: $Path" }
  $item = Get-Item -LiteralPath $Path
  if ($item.PSIsContainer -or
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Hash target is not a direct regular file: $Path"
  }
  return (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-BoundedMediaInfo {
  param([Parameter(Mandatory)][string]$Path)
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $item = Get-Item -LiteralPath $resolved
  if ($item.PSIsContainer -or
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Image is not a direct regular file: $Path"
  }
  $stream = [IO.File]::Open(
    $resolved,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::None
  )
  try {
    $length = $stream.Length
    if ($length -lt 1 -or $length -gt 5000000) {
      throw "Image must contain 1 through 5,000,000 bytes: $Path"
    }
    $bytes = [byte[]]::new([int]$length)
    $offset = 0
    while ($offset -lt $bytes.Length) {
      $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
      if ($read -eq 0) { throw "Image ended before its validated byte length: $Path" }
      $offset += $read
    }
    if ($stream.Length -ne $length -or $stream.ReadByte() -ne -1) {
      throw "Image changed while its bytes were read: $Path"
    }
  } finally {
    $stream.Dispose()
  }
  $mediaType = $null
  if ($bytes.Length -ge 8 -and
      $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4e -and
      $bytes[3] -eq 0x47 -and $bytes[4] -eq 0x0d -and $bytes[5] -eq 0x0a -and
      $bytes[6] -eq 0x1a -and $bytes[7] -eq 0x0a) {
    $mediaType = 'image/png'
  } elseif ($bytes.Length -ge 3 -and
            $bytes[0] -eq 0xff -and $bytes[1] -eq 0xd8 -and $bytes[2] -eq 0xff) {
    $mediaType = 'image/jpeg'
  } elseif ($bytes.Length -ge 12 -and
            [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ceq 'RIFF' -and
            [Text.Encoding]::ASCII.GetString($bytes, 8, 4) -ceq 'WEBP') {
    $mediaType = 'image/webp'
  }
  if ($null -eq $mediaType) { throw "Unsupported or mismatched image bytes: $Path" }
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    $sha256 = ([BitConverter]::ToString($hasher.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant()
  } finally {
    $hasher.Dispose()
  }
  [pscustomobject]@{
    Bytes = [int64]$bytes.LongLength
    MediaType = $mediaType
    Sha256 = $sha256
  }
}

function Assert-HttpsUrl {
  param([Parameter(Mandatory)][string]$Value, [Parameter(Mandatory)][string]$Field)
  $parsed = $null
  if ($Value.Length -gt 2048 -or $Value -match '[\x00-\x1f\x7f]' -or
      -not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$parsed) -or
      $parsed.Scheme -cne 'https' -or
      -not [string]::IsNullOrEmpty($parsed.UserInfo) -or
      -not [string]::IsNullOrEmpty($parsed.Fragment)) {
    throw "$Field must be a bounded public HTTPS URL without credentials or a fragment"
  }
  # Issue #84: split on '?' as well as '&' and ';'. [Uri] puts everything after
  # the FIRST '?' into Query, so a stray second one ("...?a=1?X-Amz-Signature=x")
  # left the whole tail inside a single component and only 'a' was ever tested
  # as a parameter name - the signature sailed through. A stray '?' is not valid
  # in a query string anyway, so treating it as a separator can only widen what
  # the guard inspects. Deviates from 538fec3; see the file header.
  foreach ($component in @($parsed.Query.TrimStart('?') -split '[&;?]')) {
    if ([string]::IsNullOrEmpty($component)) { continue }
    $encodedKey = @($component -split '=', 2)[0].Replace('+', ' ')
    try {
      $queryKey = [Uri]::UnescapeDataString($encodedKey)
    } catch {
      throw "$Field contains an invalid query-parameter name"
    }
    if ($queryKey -match '(?i)^(?:x-amz-.+|x-goog-.+|x-ms-.+|policy|expires|key-pair-id|awsaccesskeyid|googleaccessid|key)$' -or
        $queryKey -match '(?i)(?:^|[-_.])(?:token|secret|signature|sig|credential|credentials|access[-_]?key|api[-_]?key|client[-_]?secret|password|passwd|authorization|auth|session|jwt)(?:$|[-_.])') {
      throw "$Field appears to contain a secret-bearing query parameter"
    }
  }
}

function Assert-ExactFields {
  param(
    [Parameter(Mandatory)]$Record,
    [Parameter(Mandatory)][string[]]$Expected,
    [Parameter(Mandatory)][string]$Label
  )
  $actual = @($Record.PSObject.Properties.Name | Sort-Object)
  $wanted = @($Expected | Sort-Object)
  if (($actual -join "`n") -cne ($wanted -join "`n")) {
    throw "$Label fields are not the closed v1 schema"
  }
}

function Test-JsonIntegerType {
  param($Value)
  return $Value -is [byte] -or $Value -is [sbyte] -or
    $Value -is [int16] -or $Value -is [uint16] -or
    $Value -is [int32] -or $Value -is [uint32] -or
    $Value -is [int64] -or $Value -is [uint64]
}

function Get-ExactUtcTimestamp {
  param([Parameter(Mandatory)][string]$Value, [Parameter(Mandatory)][string]$Field)
  $parsed = [DateTimeOffset]::MinValue
  $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor
    [Globalization.DateTimeStyles]::AdjustToUniversal
  if (-not [DateTimeOffset]::TryParseExact(
      $Value,
      "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
      [Globalization.CultureInfo]::InvariantCulture,
      $styles,
      [ref]$parsed
    )) {
    throw "$Field must be a real RFC 3339 UTC millisecond timestamp"
  }
  return $parsed
}

function Assert-ExactDate {
  param([Parameter(Mandatory)][string]$Value, [Parameter(Mandatory)][string]$Field)
  $parsed = [DateTime]::MinValue
  if (-not [DateTime]::TryParseExact(
      $Value,
      'yyyy-MM-dd',
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::None,
      [ref]$parsed
    )) {
    throw "$Field must be a real YYYY-MM-DD date"
  }
}

function Assert-FreshEvidenceTimestamp {
  param([Parameter(Mandatory)][string]$Value, [Parameter(Mandatory)][string]$Field)
  $timestamp = Get-ExactUtcTimestamp -Value $Value -Field $Field
  $now = [DateTimeOffset]::UtcNow
  if ($timestamp -lt $now.AddHours(-24) -or $timestamp -gt $now.AddMinutes(5)) {
    throw "$Field is outside the 24-hour/five-minute evidence window"
  }
}

function Assert-M3aEnvelope {
  param(
    [Parameter(Mandatory)]$Record,
    [Parameter(Mandatory)][string]$ExpectedRepository
  )
  $fields = @(
    'schema', 'schemaVersion', 'repository', 'issueNumber', 'planStep', 'runId',
    'evidenceCreatedAt', 'decision', 'demoSlug', 'stagingPath', 'inputFilename',
    'assetSha256', 'assetBytes', 'mediaType', 'title', 'alt', 'creator', 'artworkDate',
    'sourceUrl', 'mediaDownloadUrl', 'rights', 'licenseUrl', 'retrievedAt'
  )
  Assert-ExactFields -Record $Record -Expected $fields -Label 'M3a'
  foreach ($field in @(
    'schema', 'repository', 'runId', 'evidenceCreatedAt', 'decision', 'demoSlug',
    'stagingPath', 'inputFilename', 'assetSha256', 'mediaType', 'title', 'alt',
    'creator', 'artworkDate', 'sourceUrl', 'mediaDownloadUrl', 'rights', 'licenseUrl',
    'retrievedAt'
  )) {
    if ($Record.$field -isnot [string]) { throw "M3a $field must be a JSON string" }
  }
  foreach ($field in 'schemaVersion', 'issueNumber', 'planStep', 'assetBytes') {
    if (-not (Test-JsonIntegerType -Value $Record.$field)) {
      throw "M3a $field must be a JSON integer"
    }
  }
  if ($Record.schema -cne 'onbrand.inspiration-real-artwork-uat-selection' -or
      $Record.schemaVersion -ne 1 -or
      $Record.repository -cne $ExpectedRepository -or
      $Record.issueNumber -ne 69 -or
      $Record.planStep -ne 34 -or
      $Record.decision -cne 'ACCEPT') {
    throw 'M3a identity or decision fields are invalid'
  }
  if ([string]$Record.runId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
    throw 'M3a runId must be a lowercase UUIDv4'
  }
  [void](Get-ExactUtcTimestamp -Value $Record.evidenceCreatedAt -Field 'M3a evidenceCreatedAt')
  if (@('water-lilies', 'parasol', 'parliament-sunset') -cnotcontains [string]$Record.demoSlug) {
    throw 'M3a demoSlug is not one of the fixed candidates'
  }
  if (-not [IO.Path]::IsPathRooted([string]$Record.stagingPath)) {
    throw 'M3a stagingPath must be an absolute proposal path'
  }
  if ([string]::IsNullOrWhiteSpace([string]$Record.inputFilename) -or
      [IO.Path]::GetFileName([string]$Record.inputFilename) -cne [string]$Record.inputFilename) {
    throw 'M3a inputFilename must be one file name'
  }
  if ([string]$Record.assetSha256 -cnotmatch '^[0-9a-f]{64}$' -or
      $Record.assetBytes -lt 1 -or
      $Record.assetBytes -gt 5000000 -or
      @('image/png', 'image/jpeg', 'image/webp') -cnotcontains [string]$Record.mediaType) {
    throw 'M3a asset digest, byte count, or media type is invalid'
  }
  foreach ($field in 'title', 'alt', 'creator', 'artworkDate', 'rights') {
    if ([string]::IsNullOrWhiteSpace([string]$Record.$field)) { throw "M3a $field is empty" }
  }
  Assert-HttpsUrl -Value $Record.sourceUrl -Field 'sourceUrl'
  Assert-HttpsUrl -Value $Record.mediaDownloadUrl -Field 'mediaDownloadUrl'
  Assert-HttpsUrl -Value $Record.licenseUrl -Field 'licenseUrl'
  Assert-ExactDate -Value $Record.retrievedAt -Field 'M3a retrievedAt'
}

function Assert-M3aStaging {
  param(
    [Parameter(Mandatory)]$Record,
    [Parameter(Mandatory)][string]$ExpectedRepository,
    [Parameter(Mandatory)][string]$InputDirectory,
    [Parameter(Mandatory)][string]$TrialDirectory
  )
  Assert-M3aEnvelope -Record $Record -ExpectedRepository $ExpectedRepository

  $trialItem = Get-Item -LiteralPath (Resolve-Path -LiteralPath $TrialDirectory)
  $stageItem = Get-Item -LiteralPath (Resolve-Path -LiteralPath $Record.stagingPath)
  $trialPrefix = $trialItem.FullName.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  if (-not $stageItem.FullName.StartsWith($trialPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'M3a stagingPath must be a strict descendant of the UAT trials directory'
  }
  $cursor = $stageItem
  while ($null -ne $cursor -and
         -not $cursor.FullName.Equals($trialItem.FullName, [StringComparison]::OrdinalIgnoreCase)) {
    if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "M3a stagingPath crosses a reparse point: $($cursor.FullName)"
    }
    $cursor = $cursor.Parent
  }
  if ($null -eq $cursor -or
      ($trialItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'M3a trials directory is not a direct local path'
  }

  $inputDirectoryItem = Get-Item -LiteralPath (Resolve-Path -LiteralPath $InputDirectory)
  if (($inputDirectoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'M3a inputs directory may not be a reparse point'
  }
  $inputPath = Join-Path $inputDirectoryItem.FullName ([string]$Record.inputFilename)
  $inputItem = Get-Item -LiteralPath $inputPath
  if ($inputItem.PSIsContainer -or
      ($inputItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'M3a input is not a direct regular file'
  }
  $media = Get-BoundedMediaInfo -Path $inputPath
  if ($Record.assetSha256 -cne $media.Sha256 -or
      [int64]$Record.assetBytes -ne $media.Bytes -or
      $Record.mediaType -cne $media.MediaType) {
    throw 'M3a asset digest, byte count, or media type does not match the staged input'
  }

  $tracePath = Join-Path $Record.stagingPath 'brand\inspiration.json'
  $trace = Get-Content -LiteralPath $tracePath -Raw | ConvertFrom-Json
  if ($trace.reviewStatus -cne 'generated-draft' -or
      $trace.asset.sha256 -cne $Record.assetSha256 -or
      $trace.asset.mediaType -cne $Record.mediaType -or
      $trace.asset.title -cne $Record.title -or
      $trace.asset.alt -cne $Record.alt -or
      $trace.asset.creator -cne $Record.creator -or
      $trace.asset.date -cne $Record.artworkDate -or
      $trace.asset.sourceUrl -cne $Record.sourceUrl -or
      $trace.asset.rights -cne $Record.rights -or
      $trace.asset.licenseUrl -cne $Record.licenseUrl -or
      $trace.asset.retrievedAt -cne $Record.retrievedAt) {
    throw 'M3a metadata does not match the generated proposal trace'
  }
  $assetRelative = [string]$trace.asset.path
  $assetParts = @($assetRelative -split '/')
  if ([IO.Path]::IsPathRooted($assetRelative) -or
      $assetRelative.Contains('\') -or
      -not $assetRelative.StartsWith('assets/', [StringComparison]::Ordinal) -or
      $assetParts.Count -lt 2 -or
      @($assetParts | Where-Object { $_ -in @('', '.', '..') }).Count -ne 0) {
    throw 'The proposal trace asset path is not a bounded brand-relative path'
  }
  $brandItem = Get-Item -LiteralPath (Resolve-Path -LiteralPath (Join-Path $Record.stagingPath 'brand'))
  $proposalAsset = Join-Path $brandItem.FullName ($assetRelative.Replace('/', '\'))
  $assetItem = Get-Item -LiteralPath (Resolve-Path -LiteralPath $proposalAsset)
  $brandPrefix = $brandItem.FullName.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  if (-not $assetItem.FullName.StartsWith($brandPrefix, [StringComparison]::OrdinalIgnoreCase) -or
      $assetItem.PSIsContainer) {
    throw 'The proposal raster resolves outside the proposal brand or is not a file'
  }
  $cursor = $assetItem
  while ($null -ne $cursor -and
         -not $cursor.FullName.Equals($brandItem.FullName, [StringComparison]::OrdinalIgnoreCase)) {
    if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "The proposal raster path crosses a reparse point: $($cursor.FullName)"
    }
    # Issue #87. This walk starts at a FILE, and FileInfo exposes .Directory
    # while DirectoryInfo exposes .Parent. Under the Set-StrictMode -Version
    # Latest set at the top of this file, reading the absent one THROWS rather
    # than yielding $null, so the bare .Parent killed every M3a run on the
    # first iteration. Deviates from 538fec3; see the file header.
    $cursor = if ($cursor -is [IO.FileInfo]) { $cursor.Directory } else { $cursor.Parent }
  }
  if ($null -eq $cursor -or
      ($brandItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The proposal raster is not a direct descendant of the proposal brand'
  }
  $proposalMedia = Get-BoundedMediaInfo -Path $assetItem.FullName
  if ($proposalMedia.Sha256 -cne $Record.assetSha256 -or
      $proposalMedia.Bytes -ne $Record.assetBytes -or
      $proposalMedia.MediaType -cne $Record.mediaType) {
    throw 'The proposal does not contain the selected bytes'
  }
}

function Assert-LatestJsonComment {
  param(
    [Parameter(Mandatory)][int]$IssueNumber,
    [Parameter(Mandatory)][string]$Repository,
    [Parameter(Mandatory)][string]$Schema,
    [Parameter(Mandatory)][string]$LocalPath,
    [Parameter(Mandatory)][string]$ExpectedAuthor
  )
  $payload = gh issue view $IssueNumber --repo $Repository --json comments | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw "Could not read comments for issue #$IssueNumber" }
  $matches = [System.Collections.Generic.List[string]]::new()
  foreach ($comment in @($payload.comments)) {
    try {
      $parsed = ([string]$comment.body) | ConvertFrom-Json
      if ($parsed.schema -ceq $Schema -and $comment.author.login -ceq $ExpectedAuthor) {
        $matches.Add([string]$comment.body)
      }
    } catch {
      # Non-JSON discussion is not handoff evidence.
    }
  }
  if ($matches.Count -eq 0) {
    throw "Issue #$IssueNumber has no matching JSON evidence comment by $ExpectedAuthor"
  }
  $local = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $LocalPath))
  $remote = $matches[$matches.Count - 1]
  foreach ($name in 'local', 'remote') {
    $value = Get-Variable -Name $name -ValueOnly
    if ($value.EndsWith("`r`n", [StringComparison]::Ordinal)) {
      $value = $value.Substring(0, $value.Length - 2)
    } elseif ($value.EndsWith("`n", [StringComparison]::Ordinal) -or
              $value.EndsWith("`r", [StringComparison]::Ordinal)) {
      $value = $value.Substring(0, $value.Length - 1)
    }
    Set-Variable -Name $name -Value $value
  }
  if ($local -cne $remote) {
    throw "Latest matching issue #$IssueNumber comment is not identical to $LocalPath"
  }
}
