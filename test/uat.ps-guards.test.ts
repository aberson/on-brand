/**
 * Guard suite for the checked-in real-artwork UAT PowerShell
 * (`scripts/uat/*.ps1`), which was partitioned VERBATIM out of the three
 * fences in `documentation/inspiration-real-artwork-uat.md`.
 *
 * Why real PowerShell: the guards being tested are PowerShell semantics
 * (StrictMode fail-closed behaviour, `-cne`/`-cnotmatch` case-sensitive
 * comparison, `[Uri]` parsing, `Get-FileHash`). A TypeScript re-implementation
 * would score a proxy, not the artifact the operator runs
 * (measurement-validity: score the production artifact end-to-end).
 *
 * Cost control: PowerShell cold start is ~300-900 ms, so the table-driven
 * cases are batched into a handful of spawns; each spawn writes one JSON
 * payload to a temp file that TypeScript then asserts on. Per-test timeouts
 * are carried here rather than raising vitest's global `testTimeout`.
 *
 * Safety: `uat-common.ps1` holds only the two preference lines plus 16 pure
 * guard functions, so dot-sourcing it is side-effect free. `uat-session.ps1`
 * (installs, `gh`, `Set-Location`) and the two `Invoke-Uat*.ps1` entry points
 * are NEVER dot-sourced here - they are inspected via PSParser/AST only.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const UAT_DIR = path.join(REPO_ROOT, 'scripts', 'uat');
const COMMON_PS1 = path.join(UAT_DIR, 'uat-common.ps1');
const SESSION_PS1 = path.join(UAT_DIR, 'uat-session.ps1');
const M3A_PS1 = path.join(UAT_DIR, 'Invoke-UatM3a.ps1');
const M3B_PS1 = path.join(UAT_DIR, 'Invoke-UatM3b.ps1');
const BLANK_PNG = path.join(REPO_ROOT, 'test', 'fixtures', 'extraction', 'screenshots', 'blank.png');

/** Generous per-spawn budget; a healthy cold start is far under a second. */
const SPAWN_TIMEOUT_MS = 60_000;

/** The 16 pure guard functions, in `uat-common.ps1` declaration order. */
const COMMON_FUNCTIONS = [
  'Assert-SafeLocalDirectory',
  'Assert-SafeEvidencePath',
  'Get-InvariantUtcTimestamp',
  'Get-InvariantUtcDate',
  'Write-AtomicEvidenceJson',
  'Get-LowerSha256',
  'Get-BoundedMediaInfo',
  'Assert-HttpsUrl',
  'Assert-ExactFields',
  'Test-JsonIntegerType',
  'Get-ExactUtcTimestamp',
  'Assert-ExactDate',
  'Assert-FreshEvidenceTimestamp',
  'Assert-M3aEnvelope',
  'Assert-M3aStaging',
  'Assert-LatestJsonComment',
] as const;

/**
 * Green anchors read out of the runbook (source lines 643/654/665 object
 * pages, 645/656 licence/policy) rather than invented, so the gate is scored
 * against the URLs the operator actually pastes.
 */
const GREEN_URLS = [
  'https://www.artic.edu/artworks/16568/water-lilies',
  'https://www.nga.gov/artworks/61379-woman-parasol-madame-monet-and-her-son',
  'https://www.nga.gov/artworks/46523-houses-parliament-sunset',
  'https://creativecommons.org/publicdomain/zero/1.0/',
  'https://www.nga.gov/open-access-images.html',
] as const;

interface SpawnResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

interface TokenReport {
  parseErrors: number;
  topLevel: string[];
  functions: string[];
}

interface CaseResult {
  name: string;
  threw: boolean;
  message: string;
  output: string;
}

let workDir = '';
let spawnCounter = 0;

/** Single-quote a value for embedding in a PowerShell script literal. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Run a PowerShell script through a real `powershell.exe -NoProfile`.
 * The script is written with a UTF-8 BOM: PS 5.1 decodes a BOM-less `.ps1`
 * as ANSI/cp1252, which can silently corrupt parsing with no parse error.
 */
function runPowerShell(script: string): SpawnResult {
  const file = path.join(workDir, `spawn-${spawnCounter++}.ps1`);
  writeFileSync(file, `\uFEFF${script}`, 'utf8');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
    { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, windowsHide: true },
  );
  return {
    ok: result.error === undefined && result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Run a script that writes one compact JSON payload to `$OutPath` and return
 * the parsed payload. Fails loud if the spawn failed or wrote nothing - an
 * empty payload silently passing would be a fake green.
 */
function runPowerShellJson<T>(body: (outPath: string) => string): T {
  const outPath = path.join(workDir, `payload-${spawnCounter}.json`);
  const result = runPowerShell(body(outPath));
  if (!result.ok) {
    throw new Error(
      `PowerShell spawn failed (status ${result.status})\nSTDOUT: ${result.stdout}\nSTDERR: ${result.stderr}`,
    );
  }
  return JSON.parse(readFileSync(outPath, 'utf8')) as T;
}

/** Shared PowerShell prologue: production preferences, then the pure library. */
const PRODUCTION_PREAMBLE = [
  "$ErrorActionPreference = 'Stop'",
  'Set-StrictMode -Version Latest',
].join('\n');

/** Emit `$payload` as compact JSON to a file (no console-width wrapping). */
function emitJson(outPath: string): string {
  return [
    `$outPath = ${psQuote(outPath)}`,
    '[IO.File]::WriteAllText($outPath, ($payload | ConvertTo-Json -Depth 10 -Compress), [Text.UTF8Encoding]::new($false))',
  ].join('\n');
}

/** PSParser tokenizer used by the parse / purity / declaration spawn. */
const TOKEN_REPORT_FUNCTION = `
function Get-TokenReport {
  param([Parameter(Mandatory)][string]$Path)
  $parseErrors = $null
  $text = [IO.File]::ReadAllText($Path)
  $tokens = [System.Management.Automation.PSParser]::Tokenize($text, [ref]$parseErrors)
  $depth = 0
  $expectName = $false
  $top = New-Object System.Collections.Generic.List[string]
  $functions = New-Object System.Collections.Generic.List[string]
  foreach ($token in $tokens) {
    $content = [string]$token.Content
    $type = [string]$token.Type
    if ($expectName -and $type -eq 'CommandArgument') {
      $functions.Add($content)
      $expectName = $false
    }
    if ($type -eq 'Keyword' -and $content -eq 'function') { $expectName = $true }
    if ($type -eq 'GroupStart' -and $content.EndsWith('{')) { $depth++; continue }
    if ($type -eq 'GroupEnd' -and $content -eq '}') { $depth--; continue }
    if ($depth -eq 0 -and @('NewLine', 'Comment', 'LineContinuation', 'StatementSeparator') -notcontains $type) {
      $top.Add($type + '|' + $content)
    }
  }
  return [pscustomobject]@{
    parseErrors = @($parseErrors).Count
    topLevel = [string[]]@($top)
    functions = [string[]]@($functions)
  }
}
`.trim();

describe.skipIf(process.platform !== 'win32')('UAT PowerShell guards (scripts/uat/*.ps1)', () => {
  beforeAll(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'onbrand-uat-guards-'));
    mkdirSync(workDir, { recursive: true });
  });

  afterAll(() => {
    if (workDir !== '') rmSync(workDir, { recursive: true, force: true });
  });

  // -- 1. harness red anchor -------------------------------------------------

  it(
    'red anchor: the spawn helper reports a throwing script as a failure',
    () => {
      // measurement-validity: an instrument that cannot fail garbage cannot gate.
      const garbage = runPowerShell(
        `${PRODUCTION_PREAMBLE}\nthrow 'deliberate red anchor: this spawn MUST be reported as a failure'`,
      );
      expect(garbage.ok).toBe(false);
      expect(garbage.status).not.toBe(0);
      expect(garbage.stderr).toContain('deliberate red anchor');

      const green = runPowerShell(`${PRODUCTION_PREAMBLE}\nWrite-Output 'harness-green'`);
      expect(green.ok).toBe(true);
      expect(green.stdout).toContain('harness-green');
    },
    SPAWN_TIMEOUT_MS,
  );

  // -- 2/3/4. parse, purity, declared functions (one spawn) ------------------

  describe('static structure (PSParser)', () => {
    interface StructurePayload {
      reports: Record<string, TokenReport>;
      garbage: TokenReport;
      stray: TokenReport;
    }

    let payload: StructurePayload;

    beforeAll(() => {
      const brokenPath = path.join(workDir, 'broken.ps1');
      writeFileSync(brokenPath, '\uFEFFfunction Broken {\n  if ($true) {\n', 'utf8');
      const strayPath = path.join(workDir, 'stray-top-level.ps1');
      writeFileSync(
        strayPath,
        `\uFEFF$ErrorActionPreference = 'Stop'\nSet-StrictMode -Version Latest\nfunction Get-Thing { return 1 }\nRemove-Item -LiteralPath 'C:\\nope'\n`,
        'utf8',
      );

      payload = runPowerShellJson<StructurePayload>((outPath) =>
        [
          PRODUCTION_PREAMBLE,
          TOKEN_REPORT_FUNCTION,
          '$reports = [ordered]@{}',
          `foreach ($entry in @(
            @{ Name = 'uat-common.ps1'; Path = ${psQuote(COMMON_PS1)} },
            @{ Name = 'uat-session.ps1'; Path = ${psQuote(SESSION_PS1)} },
            @{ Name = 'Invoke-UatM3a.ps1'; Path = ${psQuote(M3A_PS1)} },
            @{ Name = 'Invoke-UatM3b.ps1'; Path = ${psQuote(M3B_PS1)} }
          )) {
            $reports[[string]$entry.Name] = Get-TokenReport -Path ([string]$entry.Path)
          }`,
          `$payload = [ordered]@{
            reports = $reports
            garbage = Get-TokenReport -Path ${psQuote(brokenPath)}
            stray = Get-TokenReport -Path ${psQuote(strayPath)}
          }`,
          emitJson(outPath),
        ].join('\n'),
      );
    }, SPAWN_TIMEOUT_MS);

    it('every checked-in .ps1 tokenizes with zero parse errors', () => {
      for (const name of ['uat-common.ps1', 'uat-session.ps1', 'Invoke-UatM3a.ps1', 'Invoke-UatM3b.ps1']) {
        expect(payload.reports[name], `report for ${name}`).toBeDefined();
        expect(payload.reports[name]!.parseErrors, `${name} parse errors`).toBe(0);
      }
    });

    it('red anchor: the tokenizer reports errors for a deliberately broken script', () => {
      expect(payload.garbage.parseErrors).toBeGreaterThan(0);
    });

    it('uat-common.ps1 has no top-level statement but the 2 preferences and 16 functions', () => {
      const expected = [
        'Variable|ErrorActionPreference',
        'Operator|=',
        'String|Stop',
        'Command|Set-StrictMode',
        'CommandParameter|-Version',
        'CommandArgument|Latest',
        ...COMMON_FUNCTIONS.flatMap((name) => ['Keyword|function', `CommandArgument|${name}`]),
      ];
      expect(payload.reports['uat-common.ps1']!.topLevel).toEqual(expected);
      // No side-effecting command survives at depth 0.
      const topLevelCommands = payload.reports['uat-common.ps1']!.topLevel.filter((entry) =>
        entry.startsWith('Command|'),
      );
      expect(topLevelCommands).toEqual(['Command|Set-StrictMode']);
    });

    it('red anchor: the purity check flags a stray top-level statement', () => {
      expect(payload.stray.parseErrors).toBe(0);
      expect(payload.stray.topLevel).toContain('Command|Remove-Item');
      expect(payload.stray.topLevel).not.toEqual(payload.reports['uat-common.ps1']!.topLevel);
    });

    it('uat-common.ps1 declares exactly the 16 guard functions, in source order', () => {
      expect(payload.reports['uat-common.ps1']!.functions).toEqual([...COMMON_FUNCTIONS]);
    });

    it('Read-Pass is declared in Invoke-UatM3b.ps1 (proved by tokenize, never by execution)', () => {
      // Dot-sourcing Invoke-UatM3b.ps1 would run the whole interactive flow, so
      // the declaration is proved statically.
      expect(payload.reports['Invoke-UatM3b.ps1']!.functions).toEqual(['Read-Pass']);
      expect(payload.reports['Invoke-UatM3a.ps1']!.functions).toEqual([
        'Resolve-UatInputFilenameOverride',
      ]);
      expect(payload.reports['uat-session.ps1']!.functions).toEqual([]);
    });
  });

  // -- 3. dot-source definitions --------------------------------------------

  it(
    'dot-sourcing uat-common.ps1 under Stop + StrictMode defines all 16 guard functions',
    () => {
      interface DefinitionPayload {
        defined: string[];
        bogusPresent: boolean;
        knownPresent: boolean;
      }
      const payload = runPowerShellJson<DefinitionPayload>((outPath) =>
        [
          PRODUCTION_PREAMBLE,
          `$commonPath = (Resolve-Path -LiteralPath ${psQuote(COMMON_PS1)}).Path`,
          '. $commonPath',
          `$defined = [string[]]@(
            Get-Command -CommandType Function |
              Where-Object { $null -ne $_.ScriptBlock -and [string]$_.ScriptBlock.File -eq $commonPath } |
              ForEach-Object { [string]$_.Name } |
              Sort-Object
          )`,
          `$payload = [ordered]@{
            defined = $defined
            bogusPresent = [bool](Test-Path -Path 'function:Assert-NotARealUatGuard')
            knownPresent = [bool](Test-Path -Path 'function:Assert-HttpsUrl')
          }`,
          emitJson(outPath),
        ].join('\n'),
      );
      expect(payload.defined).toEqual([...COMMON_FUNCTIONS].sort());
      expect(payload.defined).toHaveLength(16);
      expect(payload.knownPresent).toBe(true);
      // red anchor: the same probe reports a name that was never defined.
      expect(payload.bogusPresent).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  // -- 5. Assert-HttpsUrl ----------------------------------------------------

  it(
    'Assert-HttpsUrl throws on every red anchor and passes silently on every green anchor',
    () => {
      const redNames = [
        'red:x-amz-signature',
        'red:x-amz-credential',
        'red:x-goog-signature',
        'red:token',
        'red:sig',
        'red:userinfo',
        'red:http-scheme',
        'red:fragment',
        'red:control-char',
        'red:over-2048-chars',
        'red:stray-question-amz',
        'red:stray-question-token',
      ];
      const payload = runPowerShellJson<{ cases: CaseResult[] }>((outPath) =>
        [
          PRODUCTION_PREAMBLE,
          `. (Resolve-Path -LiteralPath ${psQuote(COMMON_PS1)}).Path`,
          `$base = ${psQuote(GREEN_URLS[0])}`,
          `$cases = @(
            @{ name = 'green:artic-object'; value = ${psQuote(GREEN_URLS[0])} },
            @{ name = 'green:nga-parasol'; value = ${psQuote(GREEN_URLS[1])} },
            @{ name = 'green:nga-parliament'; value = ${psQuote(GREEN_URLS[2])} },
            @{ name = 'green:cc0-license'; value = ${psQuote(GREEN_URLS[3])} },
            @{ name = 'green:nga-open-access'; value = ${psQuote(GREEN_URLS[4])} },
            @{ name = 'red:x-amz-signature'; value = ($base + '?X-Amz-Signature=deadbeef') },
            @{ name = 'red:x-amz-credential'; value = ($base + '?X-Amz-Credential=AKIAEXAMPLE') },
            @{ name = 'red:x-goog-signature'; value = ($base + '?X-Goog-Signature=deadbeef') },
            @{ name = 'red:token'; value = ($base + '?token=abc123') },
            @{ name = 'red:sig'; value = ($base + '?sig=abc123') },
            @{ name = 'red:userinfo'; value = 'https://user:pw@www.artic.edu/artworks/16568/water-lilies' },
            @{ name = 'red:http-scheme'; value = 'http://www.artic.edu/artworks/16568/water-lilies' },
            @{ name = 'red:fragment'; value = ($base + '#rights') },
            @{ name = 'red:control-char'; value = ('https://www.artic.edu/artworks/16568/water' + [char]0x01 + 'lilies') },
            @{ name = 'red:over-2048-chars'; value = ('https://www.artic.edu/artworks/' + ('a' * 2100)) },
            @{ name = 'red:stray-question-amz'; value = ($base + '?a=1?X-Amz-Signature=deadbeef') },
            @{ name = 'red:stray-question-token'; value = ($base + '?a=1?token=abc123') }
          )`,
          `$results = New-Object System.Collections.ArrayList
          foreach ($case in $cases) {
            $threw = $false
            $message = ''
            $output = ''
            try {
              $captured = @(Assert-HttpsUrl -Value ([string]$case.value) -Field 'testField')
              $output = [string]($captured -join '|')
            } catch {
              $threw = $true
              $message = [string]$_.Exception.Message
            }
            [void]$results.Add([pscustomobject]@{
              name = [string]$case.name
              threw = $threw
              message = $message
              output = $output
            })
          }`,
          '$payload = [ordered]@{ cases = @($results) }',
          emitJson(outPath),
        ].join('\n'),
      );

      const byName = new Map(payload.cases.map((entry) => [entry.name, entry] as const));
      expect(payload.cases).toHaveLength(5 + redNames.length);

      for (const greenName of [
        'green:artic-object',
        'green:nga-parasol',
        'green:nga-parliament',
        'green:cc0-license',
        'green:nga-open-access',
      ]) {
        const entry = byName.get(greenName)!;
        expect(entry, greenName).toBeDefined();
        expect(entry.threw, `${greenName} must not throw`).toBe(false);
        expect(entry.output, `${greenName} must pass silently`).toBe('');
      }
      for (const redName of redNames) {
        const entry = byName.get(redName)!;
        expect(entry, redName).toBeDefined();
        expect(entry.threw, `${redName} must throw`).toBe(true);
        expect(entry.message.length, `${redName} must explain itself`).toBeGreaterThan(0);
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  // -- 6. envelope validators ------------------------------------------------

  it(
    'Assert-M3aEnvelope / Assert-ExactFields accept the known-good record and reject mutations',
    () => {
      const payload = runPowerShellJson<{ cases: CaseResult[] }>((outPath) =>
        [
          PRODUCTION_PREAMBLE,
          `. (Resolve-Path -LiteralPath ${psQuote(COMMON_PS1)}).Path`,
          `function New-KnownGoodM3a {
            return [ordered]@{
              schema = 'onbrand.inspiration-real-artwork-uat-selection'
              schemaVersion = 1
              repository = 'aberson/on-brand'
              issueNumber = 69
              planStep = 34
              runId = '3f8a1c2d-4b5e-4a6f-9c0d-1e2f3a4b5c6d'
              evidenceCreatedAt = '2026-08-24T12:00:00.000Z'
              decision = 'ACCEPT'
              demoSlug = 'parasol'
              stagingPath = 'C:\\Users\\example\\AppData\\Local\\on-brand\\inspiration-uat\\trials\\run\\parasol\\proposal'
              inputFilename = 'parasol.jpg'
              assetSha256 = 'e474a175f992442a69e502e42d7748076f7b37bd4715cf7c03ed2b7ff55231c3'
              assetBytes = 8512
              mediaType = 'image/png'
              title = 'Woman with a Parasol'
              alt = 'A woman holding a parasol on a grassy hill beneath a blue sky.'
              creator = 'Claude Monet'
              artworkDate = '1875'
              sourceUrl = ${psQuote(GREEN_URLS[1])}
              mediaDownloadUrl = ${psQuote(GREEN_URLS[1])}
              rights = 'Public-domain media under the National Gallery of Art Open Access policy'
              licenseUrl = ${psQuote(GREEN_URLS[4])}
              retrievedAt = '2026-08-24'
            }
          }`,
          `$expectedFields = [string[]]@((New-KnownGoodM3a).Keys)`,
          `$missing = New-KnownGoodM3a
          $missing.Remove('alt')
          $extra = New-KnownGoodM3a
          $extra['strayField'] = 'not in the closed v1 schema'
          $wrongType = New-KnownGoodM3a
          $wrongType['assetBytes'] = '8512'`,
          `$cases = @(
            @{ name = 'envelope:known-good'; action = { Assert-M3aEnvelope -Record ([pscustomobject](New-KnownGoodM3a)) -ExpectedRepository 'aberson/on-brand' } },
            @{ name = 'envelope:mutated-field'; action = { Assert-M3aEnvelope -Record ([pscustomobject]$missing) -ExpectedRepository 'aberson/on-brand' } },
            @{ name = 'envelope:extra-field'; action = { Assert-M3aEnvelope -Record ([pscustomobject]$extra) -ExpectedRepository 'aberson/on-brand' } },
            @{ name = 'envelope:wrong-type'; action = { Assert-M3aEnvelope -Record ([pscustomobject]$wrongType) -ExpectedRepository 'aberson/on-brand' } },
            @{ name = 'fields:known-good'; action = { Assert-ExactFields -Record ([pscustomobject](New-KnownGoodM3a)) -Expected $expectedFields -Label 'M3a' } },
            @{ name = 'fields:mutated-field'; action = { Assert-ExactFields -Record ([pscustomobject]$missing) -Expected $expectedFields -Label 'M3a' } },
            @{ name = 'fields:extra-field'; action = { Assert-ExactFields -Record ([pscustomobject]$extra) -Expected $expectedFields -Label 'M3a' } },
            @{ name = 'envelope:field-count'; action = { if ($expectedFields.Count -ne 23) { throw 'not 23 fields' } } }
          )`,
          `$results = New-Object System.Collections.ArrayList
          foreach ($case in $cases) {
            $threw = $false
            $message = ''
            $output = ''
            try {
              $captured = @(& $case.action)
              $output = [string]($captured -join '|')
            } catch {
              $threw = $true
              $message = [string]$_.Exception.Message
            }
            [void]$results.Add([pscustomobject]@{
              name = [string]$case.name
              threw = $threw
              message = $message
              output = $output
            })
          }`,
          '$payload = [ordered]@{ cases = @($results) }',
          emitJson(outPath),
        ].join('\n'),
      );

      const byName = new Map(payload.cases.map((entry) => [entry.name, entry] as const));
      // The closed schema really is 23 fields (source lines 387-449).
      expect(byName.get('envelope:field-count')!.threw).toBe(false);

      expect(byName.get('envelope:known-good')!.threw).toBe(false);
      expect(byName.get('envelope:known-good')!.output).toBe('');
      expect(byName.get('fields:known-good')!.threw).toBe(false);

      for (const redName of [
        'envelope:mutated-field',
        'envelope:extra-field',
        'envelope:wrong-type',
        'fields:mutated-field',
        'fields:extra-field',
      ]) {
        expect(byName.get(redName)!.threw, `${redName} must throw`).toBe(true);
      }
      expect(byName.get('envelope:wrong-type')!.message).toContain('assetBytes');
      expect(byName.get('fields:mutated-field')!.message).toContain('closed v1 schema');
      expect(byName.get('fields:extra-field')!.message).toContain('closed v1 schema');
    },
    SPAWN_TIMEOUT_MS,
  );

  // -- 7. media guards -------------------------------------------------------

  it(
    'Get-BoundedMediaInfo + Get-LowerSha256 agree with Node and reject bad media',
    () => {
      const wrongMagic = path.join(workDir, 'wrong-magic.png');
      writeFileSync(wrongMagic, Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 7 + 0xde) & 0xff)));
      const zeroByte = path.join(workDir, 'zero-byte.png');
      writeFileSync(zeroByte, Buffer.alloc(0));
      const missing = path.join(workDir, 'does-not-exist.png');

      interface MediaPayload {
        bytes: number;
        mediaType: string;
        boundedSha256: string;
        lowerSha256: string;
        cases: CaseResult[];
      }
      const payload = runPowerShellJson<MediaPayload>((outPath) =>
        [
          PRODUCTION_PREAMBLE,
          `. (Resolve-Path -LiteralPath ${psQuote(COMMON_PS1)}).Path`,
          `$blank = ${psQuote(BLANK_PNG)}`,
          '$info = Get-BoundedMediaInfo -Path $blank',
          `$cases = @(
            @{ name = 'bounded:wrong-magic'; action = { [void](Get-BoundedMediaInfo -Path ${psQuote(wrongMagic)}) } },
            @{ name = 'bounded:zero-byte'; action = { [void](Get-BoundedMediaInfo -Path ${psQuote(zeroByte)}) } },
            @{ name = 'lower:missing'; action = { [void](Get-LowerSha256 -Path ${psQuote(missing)}) } },
            @{ name = 'pair:wrong-magic'; action = { [void](Get-BoundedMediaInfo -Path ${psQuote(wrongMagic)}); [void](Get-LowerSha256 -Path ${psQuote(wrongMagic)}) } },
            @{ name = 'pair:zero-byte'; action = { [void](Get-BoundedMediaInfo -Path ${psQuote(zeroByte)}); [void](Get-LowerSha256 -Path ${psQuote(zeroByte)}) } },
            @{ name = 'pair:blank-png'; action = { [void](Get-BoundedMediaInfo -Path $blank); [void](Get-LowerSha256 -Path $blank) } }
          )`,
          `$results = New-Object System.Collections.ArrayList
          foreach ($case in $cases) {
            $threw = $false
            $message = ''
            try {
              & $case.action
            } catch {
              $threw = $true
              $message = [string]$_.Exception.Message
            }
            [void]$results.Add([pscustomobject]@{
              name = [string]$case.name
              threw = $threw
              message = $message
              output = ''
            })
          }`,
          `$payload = [ordered]@{
            bytes = [int64]$info.Bytes
            mediaType = [string]$info.MediaType
            boundedSha256 = [string]$info.Sha256
            lowerSha256 = Get-LowerSha256 -Path $blank
            cases = @($results)
          }`,
          emitJson(outPath),
        ].join('\n'),
      );

      const nodeSha = createHash('sha256').update(readFileSync(BLANK_PNG)).digest('hex');
      expect(payload.bytes).toBe(8512);
      expect(payload.mediaType).toBe('image/png');
      // Byte-equal to Node's digest of the same fixture, not merely "a hash".
      expect(payload.boundedSha256).toBe(nodeSha);
      expect(payload.lowerSha256).toBe(nodeSha);

      const byName = new Map(payload.cases.map((entry) => [entry.name, entry] as const));
      // Red anchors. Get-BoundedMediaInfo owns the magic-byte and size contract;
      // Get-LowerSha256 is a pure digest helper, so the PAIR (production order:
      // bound first, then digest) is what rejects bad media.
      expect(byName.get('bounded:wrong-magic')!.threw).toBe(true);
      expect(byName.get('bounded:wrong-magic')!.message).toContain('Unsupported or mismatched image bytes');
      expect(byName.get('bounded:zero-byte')!.threw).toBe(true);
      expect(byName.get('bounded:zero-byte')!.message).toContain('1 through 5,000,000 bytes');
      expect(byName.get('lower:missing')!.threw).toBe(true);
      expect(byName.get('pair:wrong-magic')!.threw).toBe(true);
      expect(byName.get('pair:zero-byte')!.threw).toBe(true);
      // Green control: the same pair does NOT throw on the real fixture.
      expect(byName.get('pair:blank-png')!.threw).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  // -- 8. -InputFilename override -------------------------------------------

  it(
    "Invoke-UatM3a.ps1's -InputFilename override accepts a valid pair and rejects bad ones",
    () => {
      interface OverridePayload {
        parseErrors: number;
        found: number;
        cases: CaseResult[];
      }
      // The validator is loaded from the SHIPPED file's own AST extent, so the
      // artifact is what is scored - not a copy pasted into the test.
      const payload = runPowerShellJson<OverridePayload>((outPath) =>
        [
          PRODUCTION_PREAMBLE,
          `$m3aPath = (Resolve-Path -LiteralPath ${psQuote(M3A_PS1)}).Path`,
          `$parseErrors = $null
          $tokens = $null
          $ast = [System.Management.Automation.Language.Parser]::ParseFile($m3aPath, [ref]$tokens, [ref]$parseErrors)
          $found = @($ast.FindAll({
            param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
              $node.Name -eq 'Resolve-UatInputFilenameOverride'
          }, $true))
          if ($found.Count -ne 1) { throw 'Resolve-UatInputFilenameOverride is not declared exactly once' }
          Invoke-Expression $found[0].Extent.Text`,
          `$cases = @(
            @{ name = 'override:valid-png'; action = { $resolved = Resolve-UatInputFilenameOverride -Override @{ parasol = 'parasol.png' }; [string]$resolved['parasol'] } },
            @{ name = 'override:valid-webp'; action = { $resolved = Resolve-UatInputFilenameOverride -Override @{ 'water-lilies' = 'water-lilies.webp' }; [string]$resolved['water-lilies'] } },
            @{ name = 'override:none'; action = { $resolved = Resolve-UatInputFilenameOverride -Override $null; [string]$resolved.Count } },
            @{ name = 'override:unknown-slug'; action = { [void](Resolve-UatInputFilenameOverride -Override @{ monet = 'monet.png' }) } },
            @{ name = 'override:mismatched-slug'; action = { [void](Resolve-UatInputFilenameOverride -Override @{ parasol = 'water-lilies.png' }) } },
            @{ name = 'override:mismatched-extension'; action = { [void](Resolve-UatInputFilenameOverride -Override @{ parasol = 'parasol.gif' }) } },
            @{ name = 'override:trailing-lf'; action = { $resolved = Resolve-UatInputFilenameOverride -Override @{ parasol = ('parasol.png' + [char]10) }; [string]$resolved['parasol'] } },
            @{ name = 'override:trailing-crlf'; action = { $resolved = Resolve-UatInputFilenameOverride -Override @{ parasol = ('parasol.png' + [char]13 + [char]10) }; [string]$resolved['parasol'] } }
          )`,
          `$results = New-Object System.Collections.ArrayList
          foreach ($case in $cases) {
            $threw = $false
            $message = ''
            $output = ''
            try {
              $captured = @(& $case.action)
              $output = [string]($captured -join '|')
            } catch {
              $threw = $true
              $message = [string]$_.Exception.Message
            }
            [void]$results.Add([pscustomobject]@{
              name = [string]$case.name
              threw = $threw
              message = $message
              output = $output
            })
          }`,
          `$payload = [ordered]@{
            parseErrors = @($parseErrors).Count
            found = $found.Count
            cases = @($results)
          }`,
          emitJson(outPath),
        ].join('\n'),
      );

      expect(payload.parseErrors).toBe(0);
      expect(payload.found).toBe(1);

      const byName = new Map(payload.cases.map((entry) => [entry.name, entry] as const));
      expect(byName.get('override:valid-png')!.threw).toBe(false);
      expect(byName.get('override:valid-png')!.output).toBe('parasol.png');
      expect(byName.get('override:valid-webp')!.threw).toBe(false);
      expect(byName.get('override:valid-webp')!.output).toBe('water-lilies.webp');
      expect(byName.get('override:none')!.threw).toBe(false);
      expect(byName.get('override:none')!.output).toBe('0');

      // Red anchors.
      expect(byName.get('override:unknown-slug')!.threw).toBe(true);
      expect(byName.get('override:unknown-slug')!.message).toContain('is not one of');
      expect(byName.get('override:mismatched-slug')!.threw).toBe(true);
      expect(byName.get('override:mismatched-extension')!.threw).toBe(true);
      expect(byName.get('override:mismatched-extension')!.message).toContain('parasol');
      // Anchor red-ness: with the old '$' anchor this case was ACCEPTED and
      // returned 'parasol.png\n' (12 chars), because .NET's '$' also matches
      // just before a single trailing newline. '\z' is the true end-of-string.
      expect(byName.get('override:trailing-lf')!.threw).toBe(true);
      expect(byName.get('override:trailing-lf')!.message).toContain('must be');
      expect(byName.get('override:trailing-lf')!.output).toBe('');
      expect(byName.get('override:trailing-crlf')!.threw).toBe(true);
      expect(byName.get('override:trailing-crlf')!.message).toContain('must be');
    },
    SPAWN_TIMEOUT_MS,
  );

  // -- 9. the -SkipInstall guard is install-only -----------------------------

  it('uat-session.ps1 guards ONLY the two install commands with -SkipInstall', () => {
    // Static, no spawn: the guard must not enclose the gh preflight, repo
    // identity, issue readability, clean-checkout, or LOCALAPPDATA checks.
    const session = readFileSync(SESSION_PS1, 'utf8').replace(/^\uFEFF/, '').split('\n');
    const open = session.findIndex((line) => line === 'if (-not $script:SkipInstall) {');
    const close = session.findIndex((line) => line === '} # end -SkipInstall guard');
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    const guarded = session.slice(open + 1, close);
    expect(guarded).toEqual([
      'npm ci',
      'if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit $LASTEXITCODE" }',
      '',
      'npx playwright install chromium',
      'if ($LASTEXITCODE -ne 0) { throw "Chromium installation failed with exit $LASTEXITCODE" }',
    ]);
    const alwaysRuns = session.slice(close + 1).join('\n');
    for (const guard of [
      'gh auth status',
      'gh repo view --json nameWithOwner',
      'Issue #$issueNumber is not readable in $repoName',
      'The checkout must be clean before UAT begins',
      'LOCALAPPDATA does not match the Windows known-folder location',
    ]) {
      expect(alwaysRuns, `${guard} must stay outside the -SkipInstall guard`).toContain(guard);
    }
  });

  // -- 10. the preserved wart -----------------------------------------------

  it('Assert-LatestJsonComment keeps its $matches shadowing verbatim (out of scope to fix)', () => {
    const common = readFileSync(COMMON_PS1, 'utf8').replace(/^\uFEFF/, '');
    expect(common).toContain('$matches = [System.Collections.Generic.List[string]]::new()');
  });

  // -- 11. the filesystem walk (issue #87) -----------------------------------

  /**
   * Regression for issue #87.
   *
   * Every other M3a test drives `Assert-M3aEnvelope` over an in-memory record,
   * so none of them touches the second half of `Assert-M3aStaging` - the walk
   * from the proposal's raster up to the proposal brand. That walk starts at a
   * FILE, and `FileInfo` exposes `.Directory` while `DirectoryInfo` exposes
   * `.Parent`. Under `Set-StrictMode -Version Latest` the bare `.Parent` threw
   * `PropertyNotFoundStrict` on the first iteration, so M3a died after ACCEPT
   * and before any evidence was written. Fourteen green guard tests missed it
   * because none of them ever built a staging tree on disk.
   *
   * This test builds a real one and drives the real function. The red anchor
   * proves the pre-fix idiom is genuinely fatal, so a revert cannot pass here.
   */
  it('Assert-M3aStaging walks a real proposal raster from a FileInfo (issue #87)', () => {
    const stagingRoot = path.join(workDir, 'm3a-staging');
    const trialsRoot = path.join(stagingRoot, 'trials');
    const inputsRoot = path.join(stagingRoot, 'inputs');
    const proposal = path.join(trialsRoot, 'run-1', 'water-lilies', 'proposal');
    const brandDir = path.join(proposal, 'brand');
    const assetsDir = path.join(brandDir, 'assets');
    mkdirSync(assetsDir, { recursive: true });
    mkdirSync(inputsRoot, { recursive: true });

    // The staged input and the proposal's embedded raster must be the same
    // bytes - Assert-M3aStaging digests both and compares them to the record.
    const bytes = readFileSync(BLANK_PNG);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const assetPath = path.join(assetsDir, 'inspiration.png');
    writeFileSync(assetPath, bytes);
    writeFileSync(path.join(inputsRoot, 'water-lilies.png'), bytes);

    const asset = {
      path: 'assets/inspiration.png',
      sha256,
      mediaType: 'image/png',
      title: 'Water Lilies',
      alt: 'Water lilies floating on a pond.',
      creator: 'Claude Monet',
      date: '1906',
      sourceUrl: GREEN_URLS[1],
      rights: 'CC0 Public Domain Designation',
      licenseUrl: GREEN_URLS[4],
      retrievedAt: '2026-08-24',
    };
    writeFileSync(
      path.join(brandDir, 'inspiration.json'),
      JSON.stringify({ reviewStatus: 'generated-draft', asset }),
      'utf8',
    );

    const record = `[ordered]@{
      schema = 'onbrand.inspiration-real-artwork-uat-selection'
      schemaVersion = 1
      repository = 'aberson/on-brand'
      issueNumber = 69
      planStep = 34
      runId = '3f8a1c2d-4b5e-4a6f-9c0d-1e2f3a4b5c6d'
      evidenceCreatedAt = '2026-08-24T12:00:00.000Z'
      decision = 'ACCEPT'
      demoSlug = 'water-lilies'
      stagingPath = ${psQuote(proposal)}
      inputFilename = 'water-lilies.png'
      assetSha256 = ${psQuote(sha256)}
      assetBytes = ${bytes.length}
      mediaType = 'image/png'
      title = ${psQuote(asset.title)}
      alt = ${psQuote(asset.alt)}
      creator = ${psQuote(asset.creator)}
      artworkDate = '1906'
      sourceUrl = ${psQuote(asset.sourceUrl)}
      mediaDownloadUrl = ${psQuote(GREEN_URLS[1])}
      rights = ${psQuote(asset.rights)}
      licenseUrl = ${psQuote(asset.licenseUrl)}
      retrievedAt = '2026-08-24'
    }`;

    const payload = runPowerShellJson<{
      accepted: boolean;
      acceptError: string;
      bareParentThrows: boolean;
      digestMutationRejected: boolean;
    }>((outPath) =>
      [
        PRODUCTION_PREAMBLE,
        `. (Resolve-Path -LiteralPath ${psQuote(COMMON_PS1)}).Path`,
        `$trials = ${psQuote(trialsRoot)}`,
        `$inputs = ${psQuote(inputsRoot)}`,
        `$record = [pscustomobject]${record}`,
        // GREEN: the real function over a real staging tree must not throw.
        `$accepted = $true; $acceptError = ''`,
        `try {
           Assert-M3aStaging -Record $record -ExpectedRepository 'aberson/on-brand' \`
             -InputDirectory $inputs -TrialDirectory $trials
         } catch { $accepted = $false; $acceptError = $_.Exception.Message }`,
        // RED ANCHOR: the pre-fix idiom must still be fatal on a FileInfo, so
        // reverting the fix cannot leave this test green.
        `$raster = Get-Item -LiteralPath ${psQuote(assetPath)}`,
        `$bareParentThrows = $false`,
        `try { $null = $raster.Parent } catch { $bareParentThrows = $true }`,
        // The function must still REJECT a mismatched digest - proving the
        // green above is a real pass and not a walk that silently gave up.
        `$mutated = [pscustomobject]${record}`,
        `$mutated.assetSha256 = '0000000000000000000000000000000000000000000000000000000000000000'`,
        `$digestMutationRejected = $false`,
        `try {
           Assert-M3aStaging -Record $mutated -ExpectedRepository 'aberson/on-brand' \`
             -InputDirectory $inputs -TrialDirectory $trials
         } catch { $digestMutationRejected = $true }`,
        `$payload = [ordered]@{
           accepted = $accepted
           acceptError = $acceptError
           bareParentThrows = $bareParentThrows
           digestMutationRejected = $digestMutationRejected
         }`,
        emitJson(outPath),
      ].join('\n'),
    );

    expect(payload.acceptError).toBe('');
    expect(payload.accepted).toBe(true);
    expect(payload.bareParentThrows).toBe(true);
    expect(payload.digestMutationRejected).toBe(true);
  });
});
