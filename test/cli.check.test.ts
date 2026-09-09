/** Step 20: spawned CLI coverage for `onbrand check --json`. */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_OK } from '../src/cli.ts';

const BIN = fileURLToPath(new URL('../bin/onbrand.mjs', import.meta.url));
const GARBAGE = fileURLToPath(new URL('./fixtures/check/garbage', import.meta.url));
const tempDirs: string[] = [];

function emptyProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-cli-check-json-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('onbrand check --json (spawned production CLI)', () => {
  it('writes one parseable versioned JSON report to stdout while retaining the gate failure exit', () => {
    const run = runCli(['check', GARBAGE, '--json']);
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).toBe('');

    const report = JSON.parse(run.stdout) as {
      schema: string;
      schemaVersion: number;
      ok: boolean;
      findings: Array<{
        category: string;
        code: string;
        evidence: Record<string, string | number | boolean>;
        nextCommand: string;
      }>;
    };
    expect(report.schema).toBe('onbrand.check');
    expect(report.schemaVersion).toBe(1);
    expect(report.ok).toBe(false);
    const wcag = report.findings.find((finding) => finding.code === 'wcag-contrast-fail');
    expect(wcag).toMatchObject({
      category: 'wcag',
      nextCommand: 'onbrand check',
      evidence: {
        foregroundPath: 'color.semantic.text',
        backgroundPath: 'color.semantic.bg',
      },
    });
  });

  it('documents --json in command and top-level help', () => {
    const commandHelp = runCli(['check', '--help']);
    expect(commandHelp.status).toBe(EXIT_OK);
    expect(commandHelp.stdout).toContain('--json');

    const topLevelHelp = runCli(['--help']);
    expect(topLevelHelp.status).toBe(EXIT_OK);
    expect(topLevelHelp.stdout).toContain('check [dir] [--strict] [--json]');
  });

  it('keeps --json parseable when sources cannot load', () => {
    const run = runCli(['check', emptyProject(), '--json']);
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).toBe('');
    expect(JSON.parse(run.stdout)).toMatchObject({
      schema: 'onbrand.check',
      schemaVersion: 1,
      state: 'unavailable',
      error: { code: 'source-load-failed', nextCommand: 'onbrand check' },
    });
  });
});
