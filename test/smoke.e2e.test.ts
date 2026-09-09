/**
 * Step 7 pipeline smoke gate: ONE real, mock-free, sequential producer ->
 * consumer cycle through the PRODUCTION entry point (spawn `node
 * bin/onbrand.mjs ...`, exactly what package.json "bin" points at), all inside
 * a SINGLE fresh temp project:
 *
 *   init (default preset) -> build (all emitters) -> check -> preview
 *
 * Unlike check.e2e / preview.e2e (which test each command's edge cases in
 * depth), this gate's only job is the full uninterrupted CYCLE: each stage
 * consumes the previous stage's real on-disk output. It asserts each stage's
 * exit code plus ONE load-bearing artifact per stage, and pins the whole
 * cycle's wall-clock under 60s (Windows tsx spawn overhead is ~1-2s/spawn; the
 * real cycle is well under budget -- if it ever exceeds, investigate rather
 * than raise the limit). This must stay green before any extraction work.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { implementedEmitterOutputs } from '../src/build/compile.ts';
import { validate } from '../src/schema/validate.ts';
import { EXIT_OK } from '../src/cli.ts';

const BIN = fileURLToPath(new URL('../bin/onbrand.mjs', import.meta.url));

const CYCLE_BUDGET_MS = 60_000;

interface StageResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-smoke-'));
  tempDirs.push(dir);
  return dir;
}

function runCli(args: string[]): StageResult {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// --- run the whole cycle ONCE, sequentially, in one fresh temp project -------

let project = '';
let initRes: StageResult;
let buildRes: StageResult;
let checkRes: StageResult;
let previewRes: StageResult;
let cycleMs = 0;

beforeAll(() => {
  project = tempDir();
  const startedAt = Date.now();
  initRes = runCli(['init', project]); //          producer: scaffold brand/
  buildRes = runCli(['build', project]); //         producer: compile all emitters -> dist/
  checkRes = runCli(['check', project]); //         consumer: gate the freshly built dist
  previewRes = runCli(['preview', project]); //     consumer: render specimen from dist/ (no --open)
  cycleMs = Date.now() - startedAt;
}, 90_000);

afterAll(() => {
  // best-effort on Windows file locks
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('onbrand smoke gate -- one real init/build/check/preview cycle', () => {
  it('init scaffolds a schema-valid brand/tokens.json (exit 0)', () => {
    expect(initRes.status, initRes.stderr).toBe(EXIT_OK);
    const tokensPath = path.join(project, 'brand', 'tokens.json');
    expect(existsSync(tokensPath)).toBe(true);
    const tokens: unknown = JSON.parse(readFileSync(tokensPath, 'utf8'));
    expect(validate(tokens).ok).toBe(true);
  });

  it('build emits a COMPLETE dist -- every EMITTER_OUTPUTS file present (exit 0)', () => {
    expect(buildRes.status, buildRes.stderr).toBe(EXIT_OK);
    const distDir = path.join(project, 'brand', 'dist');
    const missing = implementedEmitterOutputs()
      .map(({ relPath }) => relPath)
      .filter((relPath) => !existsSync(path.join(distDir, relPath)));
    expect(missing, `missing dist outputs: ${missing.join(', ')}`).toEqual([]);
  });

  it('check PASSES on the freshly built default preset (exit 0 -- the calibration anchor)', () => {
    expect(checkRes.status, checkRes.stderr).toBe(EXIT_OK);
  });

  it('preview writes a non-empty specimen.html from dist/ (exit 0, no --open)', () => {
    expect(previewRes.status, previewRes.stderr).toBe(EXIT_OK);
    const specimenPath = path.join(project, 'brand', 'dist', 'specimen.html');
    expect(existsSync(specimenPath)).toBe(true);
    expect(readFileSync(specimenPath, 'utf8').length).toBeGreaterThan(0);
  });

  it('the whole producer -> consumer cycle completes under 60s', () => {
    expect(cycleMs, `cycle took ${cycleMs}ms`).toBeLessThan(CYCLE_BUDGET_MS);
  });
});
