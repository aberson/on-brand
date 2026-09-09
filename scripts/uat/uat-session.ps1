# On Brand real-artwork UAT (M3a + M3b) - side-effecting session bootstrap.
#
# Dot-source it: . <path>   -- and only AFTER uat-common.ps1, whose functions
# the staging block below calls. Entry points: Invoke-UatM3a.ps1 / Invoke-UatM3b.ps1.
# Never dot-source this file from a test: it installs, calls gh, and moves the
# working directory.
#
# Historical setup, with the repository guard updated for the private archive.
# Originally partitioned from the setup fence of
# documentation/inspiration-real-artwork-uat.md as of 538fec3 (lines 24-85 then 218-229). The
# only wiring added is the -SkipInstall guard around the two install commands;
# the gh preflight, repo-identity, issue-readability, clean-checkout, and
# LOCALAPPDATA known-folder checks are safety guards and always run.
if ($null -eq (Get-Variable -Name 'SkipInstall' -Scope 'Script' -ErrorAction 'SilentlyContinue')) { $script:SkipInstall = $false }

if (-not $script:SkipInstall) {
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit $LASTEXITCODE" }

npx playwright install chromium
if ($LASTEXITCODE -ne 0) { throw "Chromium installation failed with exit $LASTEXITCODE" }
} # end -SkipInstall guard

gh auth status
if ($LASTEXITCODE -ne 0) { throw "GitHub authentication is unavailable" }

$repoRoot = (git rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($repoRoot)) {
  throw 'Run this procedure inside an On Brand Git checkout'
}
Set-Location -LiteralPath $repoRoot

$repoView = gh repo view --json nameWithOwner | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Could not identify the current GitHub repository' }
$repoName = [string]$repoView.nameWithOwner
$expectedRepo = 'aberson/on-brand-private'
if ($repoName -cne $expectedRepo) {
  throw "Wrong repository: expected $expectedRepo, got $repoName"
}

$repoAccess = gh api "repos/$repoName" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Could not read repository access for $repoName" }
$canWriteIssues =
  $repoAccess.permissions.admin -eq $true -or
  $repoAccess.permissions.maintain -eq $true -or
  $repoAccess.permissions.push -eq $true -or
  $repoAccess.permissions.triage -eq $true
if (-not $canWriteIssues) { throw "Authenticated account lacks issue write access to $repoName" }
$operatorLogin = (gh api user --jq '.login').Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($operatorLogin)) {
  throw 'Could not resolve the authenticated GitHub login'
}

foreach ($issueNumber in 69, 72) {
  $issue = gh issue view $issueNumber --repo $repoName --json number,state | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or [int]$issue.number -ne $issueNumber) {
    throw "Issue #$issueNumber is not readable in $repoName"
  }
}

$dirty = @(git status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) {
  throw 'The checkout must be clean before UAT begins'
}

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw 'LOCALAPPDATA is not defined'
}
$trustedLocalAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if ([string]::IsNullOrWhiteSpace($trustedLocalAppData)) {
  throw 'Windows did not return a trusted local application-data directory'
}
$environmentLocalAppData = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\', '/')
$trustedLocalAppData = [IO.Path]::GetFullPath($trustedLocalAppData).TrimEnd('\', '/')
if (-not $environmentLocalAppData.Equals($trustedLocalAppData, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'LOCALAPPDATA does not match the Windows known-folder location'
}

$uatRoot = Join-Path $env:LOCALAPPDATA 'on-brand\inspiration-uat'
$inputsRoot = Join-Path $uatRoot 'inputs'
$trialsRoot = Join-Path $uatRoot 'trials'
[void](Assert-SafeLocalDirectory -Path $uatRoot -TrustedRoot $trustedLocalAppData -CheckoutRoot $repoRoot)
New-Item -ItemType Directory -Force -Path $uatRoot | Out-Null
[void](Assert-SafeLocalDirectory -Path $uatRoot -TrustedRoot $trustedLocalAppData -CheckoutRoot $repoRoot)
foreach ($directory in $inputsRoot, $trialsRoot) {
  [void](Assert-SafeLocalDirectory -Path $directory -TrustedRoot $trustedLocalAppData -CheckoutRoot $repoRoot)
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  [void](Assert-SafeLocalDirectory -Path $directory -TrustedRoot $trustedLocalAppData -CheckoutRoot $repoRoot)
}

# End of the verbatim setup-fence partition (runbook 24-85, 218-229, as of 538fec3).
