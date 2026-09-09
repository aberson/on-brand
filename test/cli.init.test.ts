/**
 * Integration tests for `onbrand init` through the PRODUCTION entry point:
 * they spawn `node bin/onbrand.mjs ...` (the exact file package.json "bin"
 * points at) and assert the scaffolded brand/ passes the schema module
 * end-to-end — the producer -> consumer round trip.
 *
 * Windows note: we invoke process.execPath directly on the .mjs shim, so no
 * npm .cmd wrapper (and no shell:true) is needed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { applyModeOverlay } from '../src/schema/modes.ts';
import { assertValid, validate } from '../src/schema/validate.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, main } from '../src/cli.ts';

const BIN = fileURLToPath(new URL('../bin/onbrand.mjs', import.meta.url));

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-init-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runCli(
  args: string[],
  cwd?: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    cwd,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('onbrand init (spawned through bin/onbrand.mjs)', () => {
  it('scaffolds a brand/ that passes validate() and the overlay merge', () => {
    const dir = tempDir();
    const run = runCli(['init', dir]);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(EXIT_OK);

    const brandDir = path.join(dir, 'brand');
    const tokensRaw = readFileSync(path.join(brandDir, 'tokens.json'), 'utf8');
    const modesRaw = readFileSync(path.join(brandDir, 'modes.dark.json'), 'utf8');
    const guide = readFileSync(path.join(brandDir, 'guide.md'), 'utf8');

    // acceptance: produced brand/ passes validate()
    const tokens = assertValid(JSON.parse(tokensRaw));
    expect(validate(JSON.parse(modesRaw), { kind: 'overlay' }).ok).toBe(true);
    const merged = applyModeOverlay(tokens, JSON.parse(modesRaw));
    expect(merged.issues).toEqual([]);

    // guide: project name substituted, TODO prompts + palette fences present
    expect(guide).toContain(`# ${path.basename(dir)} — Brand Guide`);
    expect(guide).not.toContain('{{PROJECT_NAME}}');
    expect(guide).toContain('<!-- onbrand:begin palette -->');
    expect(guide).toContain('<!-- onbrand:end palette -->');
    expect(guide).toContain('TODO');

    // assets dir scaffolded
    expect(existsSync(path.join(brandDir, 'assets', '.gitkeep'))).toBe(true);
  });

  it('re-running without --force exits nonzero and writes nothing', () => {
    const dir = tempDir();
    expect(runCli(['init', dir]).status).toBe(EXIT_OK);

    // plant sentinels in ALL protected files so any rewrite is detectable
    const tokensPath = path.join(dir, 'brand', 'tokens.json');
    const modesPath = path.join(dir, 'brand', 'modes.dark.json');
    const guidePath = path.join(dir, 'brand', 'guide.md');
    writeFileSync(tokensPath, '{"sentinel": true}', 'utf8');
    writeFileSync(modesPath, '{"sentinel": "dark"}', 'utf8');
    writeFileSync(guidePath, 'OPERATOR PROSE', 'utf8');

    const rerun = runCli(['init', dir]);
    expect(rerun.status).toBe(EXIT_FAILURE);
    expect(rerun.stderr).toContain('--force');
    // nothing was written
    expect(readFileSync(tokensPath, 'utf8')).toBe('{"sentinel": true}');
    expect(readFileSync(modesPath, 'utf8')).toBe('{"sentinel": "dark"}');
    expect(readFileSync(guidePath, 'utf8')).toBe('OPERATOR PROSE');
  });

  it('a failing init exits 1 with a clear error and leaves no partial brand/ (brand path blocked by a file)', () => {
    const dir = tempDir();
    // occupy the brand path with a FILE so mkdir/scaffold cannot proceed
    writeFileSync(path.join(dir, 'brand'), 'not a directory', 'utf8');

    const run = runCli(['init', dir]);
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).toContain('onbrand init:');
    // the blocking file is untouched and no protected files appeared anywhere
    expect(readFileSync(path.join(dir, 'brand'), 'utf8')).toBe('not a directory');
    expect(existsSync(path.join(dir, 'brand', 'tokens.json'))).toBe(false);
  });

  it('--force overwrites and exits 0', () => {
    const dir = tempDir();
    expect(runCli(['init', dir]).status).toBe(EXIT_OK);
    const tokensPath = path.join(dir, 'brand', 'tokens.json');
    writeFileSync(tokensPath, '{"sentinel": true}', 'utf8');

    const rerun = runCli(['init', dir, '--force']);
    expect(rerun.status).toBe(EXIT_OK);
    const tokens: unknown = JSON.parse(readFileSync(tokensPath, 'utf8'));
    expect(validate(tokens).ok).toBe(true);
  });

  it('unknown preset exits 2 (usage) and creates nothing', () => {
    const dir = tempDir();
    const run = runCli(['init', dir, '--preset', 'no-such-preset']);
    expect(run.status).toBe(EXIT_USAGE);
    expect(run.stderr).toContain('no-such-preset');
    expect(run.stderr).toContain('default'); // lists what IS available
    expect(existsSync(path.join(dir, 'brand'))).toBe(false);
  });

  it('--preset default is the same as the default', () => {
    const dir = tempDir();
    const run = runCli(['init', dir, '--preset', 'default']);
    expect(run.status).toBe(EXIT_OK);
    expect(existsSync(path.join(dir, 'brand', 'tokens.json'))).toBe(true);
  });

  it('unknown command exits 2 with usage on stderr', () => {
    const run = runCli(['frobnicate']);
    expect(run.status).toBe(EXIT_USAGE);
    expect(run.stderr).toContain('unknown command');
    expect(run.stderr).toContain('Usage:');
  });

  it('bare invocation exits 2; --help exits 0', () => {
    expect(runCli([]).status).toBe(EXIT_USAGE);
    const help = runCli(['--help']);
    expect(help.status).toBe(EXIT_OK);
    expect(help.stdout).toContain('onbrand init');
  });

  it('every §6 subcommand is live; an unknown command exits 2 with the usage banner', () => {
    // from-url landed in Step 12 — no §6 command is stubbed anymore. The
    // declared-but-unbuilt exit-2 mechanism now only fires for a truly unknown
    // command.
    const run = runCli(['not-a-real-command']);
    expect(run.status).toBe(EXIT_USAGE);
    expect(run.stderr).toContain('unknown command');
    // from-url IS dispatched now: bare (no url) is a usage error, not "unimplemented".
    const fromUrl = runCli(['from-url']);
    expect(fromUrl.status).toBe(EXIT_USAGE);
    expect(fromUrl.stderr).toContain('missing <url>');
  });
});

describe('onbrand init (direct main() calls — arg parsing edges)', () => {
  it('--preset without a value is a usage error', async () => {
    expect(await main(['init', tempDir(), '--preset'])).toBe(EXIT_USAGE);
  });

  it('unknown flag is a usage error', async () => {
    expect(await main(['init', tempDir(), '--frobnicate'])).toBe(EXIT_USAGE);
  });

  it('extra positional argument is a usage error', async () => {
    expect(await main(['init', tempDir(), 'extra-arg'])).toBe(EXIT_USAGE);
  });

  it('init --help exits 0', async () => {
    expect(await main(['init', '--help'])).toBe(EXIT_OK);
  });

  it('dir argument omitted defaults to "." (spawned with cwd = temp dir)', () => {
    const dir = tempDir();
    const run = runCli(['init'], dir);
    expect(run.status).toBe(EXIT_OK);
    expect(existsSync(path.join(dir, 'brand', 'tokens.json'))).toBe(true);
  });
});
