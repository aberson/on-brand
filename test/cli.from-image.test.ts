/** Production CLI coverage for the paired Step-27 catalog refresh. */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_OK } from '../src/cli.ts';
import { runFromImage } from '../src/extract/from-image.ts';
import { INSPIRATION_ARTIFACT_SCHEMA } from '../src/inspiration/export.ts';
import {
  renderPosixInspirationExportRetry,
  renderPowerShellInspirationExportRetry,
} from '../src/inspiration/retry-command.ts';
import { rawInspirationRetryCommand } from './helpers/inspiration-retry.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO_ROOT, 'bin', 'onbrand.mjs');
const EXPORT_WORKER = fileURLToPath(new URL('./helpers/inspiration-export-worker.ts', import.meta.url));
const FROM_IMAGE_CLI_WORKER = fileURLToPath(new URL('./helpers/from-image-cli-worker.ts', import.meta.url));
const PRESET_DIR = path.join(REPO_ROOT, 'templates', 'presets', 'default');
const INPUT = path.join(REPO_ROOT, 'test', 'fixtures', 'extraction', 'screenshots', 'example.png');
const CLOCK = '2026-08-12T12:00:00.000Z';
const PROPOSAL = 'onbrand-proposal-example-20260812';
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'onbrand-cli-fromimage-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function invoke(args: string[], env: Record<string, string> = {}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ...env, ONBRAND_NOW: CLOCK },
  });
}

interface ExportWorker {
  child: ChildProcessWithoutNullStreams;
  exited: boolean;
  code: number | null;
  stderr: string;
}

interface CliWorker extends ExportWorker {
  stdout: string;
}

function startExportWorker(root: string, out: string, ready: string, release: string): ExportWorker {
  const child = spawn(process.execPath, ['--import', 'tsx', EXPORT_WORKER, 'hold', root, out, ready, release], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const worker: ExportWorker = { child, exited: false, code: null, stderr: '' };
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { worker.stderr += chunk; });
  child.on('exit', (code) => { worker.exited = true; worker.code = code; });
  return worker;
}

function startCliWorker(ready: string, release: string, args: string[]): CliWorker {
  const child = spawn(process.execPath, ['--import', 'tsx', FROM_IMAGE_CLI_WORKER, ready, release, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ONBRAND_NOW: CLOCK },
  });
  const worker: CliWorker = { child, exited: false, code: null, stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { worker.stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { worker.stderr += chunk; });
  child.on('exit', (code) => { worker.exited = true; worker.code = code; });
  return worker;
}

async function waitForWorker(predicate: () => boolean, message: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message());
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function listTree(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, relativeDir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else files.push(relative);
    }
  };
  walk(root, '');
  return files.sort();
}

function treeDiff(left: string, right: string): string[] {
  const leftFiles = listTree(left);
  const rightFiles = listTree(right);
  const allFiles = [...new Set([...leftFiles, ...rightFiles])].sort();
  return allFiles.filter((relative) => {
    if (!leftFiles.includes(relative) || !rightFiles.includes(relative)) return true;
    return !readFileSync(path.join(left, ...relative.split('/'))).equals(
      readFileSync(path.join(right, ...relative.split('/'))),
    );
  });
}

function seedInvalidCatalogTrace(root: string, name: string): void {
  const brand = path.join(root, name, 'brand');
  mkdirSync(brand, { recursive: true });
  copyFileSync(path.join(PRESET_DIR, 'tokens.json'), path.join(brand, 'tokens.json'));
  copyFileSync(path.join(PRESET_DIR, 'modes.dark.json'), path.join(brand, 'modes.dark.json'));
  writeFileSync(path.join(brand, 'inspiration.json'), '{}\n');
}

async function runFromImageCapacityRace(root: string, concurrentName: string): Promise<CliWorker> {
  for (let index = 0; index < 49; index++) {
    seedInvalidCatalogTrace(root, `a-seed-${String(index).padStart(3, '0')}`);
  }
  const catalog = path.join('.observatory', 'inspiration-to-implementation.json');
  const catalogPath = path.join(root, ...catalog.split('/'));
  const priorCatalogBytes = existsSync(catalogPath) ? readFileSync(catalogPath) : undefined;
  const proposal = path.join(root, PROPOSAL);
  const ready = path.join(root, `${concurrentName}.catalog-refresh.ready`);
  const release = path.join(root, `${concurrentName}.catalog-refresh.release`);
  const worker = startCliWorker(ready, release, [
    'from-image', INPUT,
    '--title', 'Concurrent capacity fixture',
    '--alt', 'A local fixture whose paired catalog reaches its bound concurrently.',
    '--out', root,
    '--catalog-root', root,
    '--catalog-out', catalog,
    '--no-llm',
  ]);
  try {
    await waitForWorker(
      () => existsSync(ready) || worker.exited,
      () => `from-image worker did not reach catalog refresh barrier (${worker.code})\n${worker.stderr}`,
    );
    expect(existsSync(ready), worker.stderr).toBe(true);
    expect(worker.exited, worker.stderr).toBe(false);
    expect(existsSync(path.join(proposal, 'INCOMPLETE.md'))).toBe(false);
    expect(existsSync(path.join(proposal, 'image-report.md'))).toBe(true);
    expect(existsSync(path.join(proposal, 'brand', 'dist', 'inspiration-to-implementation.html'))).toBe(true);
    expect(existsSync(path.join(proposal, 'brand', 'dist', 'specimen.html'))).toBe(true);
    if (priorCatalogBytes === undefined) expect(existsSync(catalogPath)).toBe(false);
    else expect(readFileSync(catalogPath)).toEqual(priorCatalogBytes);
    seedInvalidCatalogTrace(root, concurrentName);
    writeFileSync(release, 'release\n', { flag: 'wx' });
    await waitForWorker(
      () => worker.exited,
      () => `from-image capacity worker did not exit\nstdout: ${worker.stdout}\nstderr: ${worker.stderr}`,
    );
    return worker;
  } finally {
    if (!worker.exited) {
      worker.child.kill();
      await waitForWorker(() => worker.exited, () => 'from-image capacity worker could not be stopped')
        .catch(() => undefined);
    }
  }
}

function manifestLlm(proposalDir: string): unknown {
  const manifest = JSON.parse(readFileSync(path.join(proposalDir, 'brand', 'dist', 'manifest.json'), 'utf8')) as {
    llm?: unknown;
  };
  return manifest.llm;
}

function installModelSpawnProbe(root: string): {
  sentinel: string;
  env: Record<string, string>;
} {
  const sentinel = path.join(root, 'model-process-invoked.txt');
  const hook = path.join(root, 'model-spawn-probe.cjs');
  writeFileSync(
    hook,
    [
      "'use strict';",
      "const { writeFileSync } = require('node:fs');",
      "if (process.execArgv.includes('-p') && process.env.ONBRAND_MODEL_SENTINEL) {",
      "  writeFileSync(process.env.ONBRAND_MODEL_SENTINEL, 'model process invoked\\n');",
      '}',
      '',
    ].join('\n'),
  );
  const requireHook = `--require=${JSON.stringify(hook.split(path.sep).join('/'))}`;
  return {
    sentinel,
    env: {
      ONBRAND_CLAUDE_BIN: process.execPath,
      ONBRAND_MODEL_SENTINEL: sentinel,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, requireHook].filter(Boolean).join(' '),
    },
  };
}

describe('onbrand from-image deterministic compatibility', () => {
  it('keeps API/CLI omitted and --no-llm trees byte-identical without starting a model process', async () => {
    const probe = installModelSpawnProbe(temporaryRoot());
    const previous = {
      claudeBin: process.env.ONBRAND_CLAUDE_BIN,
      sentinel: process.env.ONBRAND_MODEL_SENTINEL,
      nodeOptions: process.env.NODE_OPTIONS,
    };
    Object.assign(process.env, probe.env);

    try {
      const probeAnchor = spawnSync(process.execPath, ['-p', '0'], {
        encoding: 'utf8',
        env: { ...process.env, ...probe.env },
      });
      expect(probeAnchor.status, String(probeAnchor.stderr)).toBe(EXIT_OK);
      expect(existsSync(probe.sentinel), 'model-process probe negative control').toBe(true);
      rmSync(probe.sentinel, { force: true });

      const title = 'Determinism fixture';
      const alt = 'A local fixture raster used to verify deterministic compatibility.';
      const apiOmitted = await runFromImage(INPUT, {
        title,
        alt,
        outDir: temporaryRoot(),
        now: () => new Date(CLOCK),
      });
      const apiNoLlm = await runFromImage(INPUT, {
        title,
        alt,
        outDir: temporaryRoot(),
        noLlm: true,
        now: () => new Date(CLOCK),
      });
      expect(apiOmitted.status).toBe('complete');
      expect(apiNoLlm.status).toBe('complete');

      const cliOmittedRoot = temporaryRoot();
      const cliOmitted = invoke(
        ['from-image', INPUT, '--title', title, '--alt', alt, '--out', cliOmittedRoot],
        probe.env,
      );
      expect(cliOmitted.status, String(cliOmitted.stderr)).toBe(EXIT_OK);

      const cliNoLlmRoot = temporaryRoot();
      const cliNoLlm = invoke(
        ['from-image', INPUT, '--title', title, '--alt', alt, '--out', cliNoLlmRoot, '--no-llm'],
        probe.env,
      );
      expect(cliNoLlm.status, String(cliNoLlm.stderr)).toBe(EXIT_OK);

      const proposals = [
        apiOmitted.proposalDir,
        apiNoLlm.proposalDir,
        path.join(cliOmittedRoot, PROPOSAL),
        path.join(cliNoLlmRoot, PROPOSAL),
      ];
      expect(proposals.map(manifestLlm)).toEqual(['none', 'none', 'none', 'none']);
      for (const proposal of proposals.slice(1)) {
        expect(treeDiff(proposals[0]!, proposal), `tree drift in ${proposal}`).toEqual([]);
      }
      expect(existsSync(probe.sentinel)).toBe(false);
    } finally {
      if (previous.claudeBin === undefined) delete process.env.ONBRAND_CLAUDE_BIN;
      else process.env.ONBRAND_CLAUDE_BIN = previous.claudeBin;
      if (previous.sentinel === undefined) delete process.env.ONBRAND_MODEL_SENTINEL;
      else process.env.ONBRAND_MODEL_SENTINEL = previous.sentinel;
      if (previous.nodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous.nodeOptions;
    }
  }, 120_000);

  it('documents --no-llm as an accepted compatibility no-op', () => {
    const result = invoke(['from-image', '--help']);
    expect(result.status, String(result.stderr)).toBe(EXIT_OK);
    expect(result.stdout).toContain('accepted compatibility no-op');
  });
});

describe('onbrand from-image catalog integration', () => {
  it('publishes one current proposal only after its specimen and explanation complete', () => {
    const root = temporaryRoot();
    const catalog = path.join('.observatory', 'inspiration-to-implementation.json');
    const result = invoke([
      'from-image', INPUT,
      '--title', 'Catalog fixture',
      '--alt', 'A local fixture raster for the catalog path.',
      '--out', root,
      '--catalog-root', root,
      '--catalog-out', catalog,
      '--no-llm',
    ]);
    expect(result.status, String(result.stderr)).toBe(EXIT_OK);

    const catalogPath = path.join(root, ...catalog.split('/'));
    expect(existsSync(catalogPath)).toBe(true);
    const firstBytes = readFileSync(catalogPath, 'utf8');
    const artifact = JSON.parse(firstBytes) as {
      schema: string;
      items: Array<{
        relPath: string;
        traceState: string;
        standalonePath?: string;
        specimenPath?: string;
      }>;
    };
    expect(artifact.schema).toBe(INSPIRATION_ARTIFACT_SCHEMA);
    expect(artifact.items.filter((item) => item.relPath === PROPOSAL)).toEqual([
      expect.objectContaining({
        traceState: 'available',
        standalonePath: `${PROPOSAL}/brand/dist/inspiration-to-implementation.html`,
        specimenPath: `${PROPOSAL}/brand/dist/specimen.html`,
      }),
    ]);

    const refresh = invoke(['inspiration-export', '--root', root, '--out', catalog]);
    expect(refresh.status, String(refresh.stderr)).toBe(EXIT_OK);
    expect(readFileSync(catalogPath, 'utf8')).toBe(firstBytes);
  }, 120_000);

  it('keeps a completed proposal when the paired catalog refresh is lock-blocked, then runs the sole printed retry', async () => {
    const root = temporaryRoot();
    const catalog = path.join('.observatory', 'inspiration-to-implementation.json');
    const catalogPath = path.join(root, ...catalog.split('/'));
    mkdirSync(path.dirname(catalogPath), { recursive: true });
    writeFileSync(catalogPath, 'prior complete catalog\n');
    const ready = path.join(root, 'catalog.ready');
    const release = path.join(root, 'catalog.release');
    const worker = startExportWorker(root, catalog, ready, release);
    try {
      await waitForWorker(
        () => existsSync(ready) || worker.exited,
        () => `catalog worker did not reach barrier (${worker.code})\n${worker.stderr}`,
      );
      expect(existsSync(ready), worker.stderr).toBe(true);
      const blocked = invoke([
        'from-image', INPUT,
        '--title', 'Blocked paired catalog fixture',
        '--alt', 'A local fixture whose catalog lock is intentionally held.',
        '--out', root,
        '--catalog-root', root,
        '--catalog-out', catalog,
        '--no-llm',
      ]);
      expect(blocked.status).toBe(1);
      expect(readFileSync(catalogPath, 'utf8')).toBe('prior complete catalog\n');
      const proposal = path.join(root, PROPOSAL);
      expect(existsSync(path.join(proposal, 'INCOMPLETE.md'))).toBe(false);
      expect(existsSync(path.join(proposal, 'brand', 'dist', 'inspiration-to-implementation.html'))).toBe(true);
      expect(existsSync(path.join(proposal, 'brand', 'dist', 'specimen.html'))).toBe(true);
      const blockedError = String(blocked.stderr);
      const retry = rawInspirationRetryCommand(blockedError);
      const expectedRetry = process.platform === 'win32'
        ? renderPowerShellInspirationExportRetry(process.execPath, path.resolve(BIN), path.resolve(root), path.resolve(catalogPath))
        : renderPosixInspirationExportRetry(process.execPath, path.resolve(BIN), path.resolve(root), path.resolve(catalogPath));
      expect(retry).toBe(expectedRetry);
      writeFileSync(release, 'release\n', { flag: 'wx' });
      await waitForWorker(() => worker.exited, () => `catalog worker did not exit\n${worker.stderr}`);
      expect(worker.code, worker.stderr).toBe(0);
      const rerun = process.platform === 'win32'
        ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', retry], {
          encoding: 'utf8', timeout: 30_000, cwd: root,
        })
        : spawnSync('sh', ['-c', retry], { encoding: 'utf8', timeout: 30_000, cwd: root });
      expect(rerun.status, rerun.stderr).toBe(0);
      expect(JSON.parse(readFileSync(catalogPath, 'utf8')).items).toContainEqual(expect.objectContaining({
        relPath: PROPOSAL, traceState: 'available',
      }));
    } finally {
      if (!worker.exited) {
        worker.child.kill();
        await waitForWorker(() => worker.exited, () => `catalog worker could not be stopped\n${worker.stderr}`).catch(() => undefined);
      }
    }
  }, 120_000);

  it('accepts a truncated paired catalog when the completed proposal is emitted exactly once', async () => {
    const root = temporaryRoot();
    const worker = await runFromImageCapacityRace(root, 'z-concurrent-trace');
    expect(worker.code, worker.stderr).toBe(EXIT_OK);
    const catalogPath = path.join(root, '.observatory', 'inspiration-to-implementation.json');
    const artifact = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
      summary: { discoveredTraceCount: number; emittedItemCount: number; itemsTruncated: boolean };
      items: Array<{ relPath: string; traceState: string }>;
    };
    expect(artifact.summary).toMatchObject({
      discoveredTraceCount: 51,
      emittedItemCount: 50,
      itemsTruncated: true,
    });
    expect(artifact.items.filter((item) => item.relPath === PROPOSAL)).toEqual([
      expect.objectContaining({ relPath: PROPOSAL, traceState: 'available' }),
    ]);
  }, 120_000);

  it('keeps prior catalog bytes and gives manual capacity remediation when truncation omits the proposal', async () => {
    const root = temporaryRoot();
    const catalogPath = path.join(root, '.observatory', 'inspiration-to-implementation.json');
    mkdirSync(path.dirname(catalogPath), { recursive: true });
    writeFileSync(catalogPath, 'prior complete catalog\n');
    const worker = await runFromImageCapacityRace(root, 'b-concurrent-trace');
    expect(worker.code).toBe(1);
    expect(worker.stderr).toContain('catalog capacity requires operator action');
    expect(worker.stderr).not.toContain('retry with:');
    expect(readFileSync(catalogPath, 'utf8')).toBe('prior complete catalog\n');
    expect(existsSync(path.join(root, PROPOSAL, 'INCOMPLETE.md'))).toBe(false);
    expect(existsSync(path.join(root, PROPOSAL, 'brand', 'dist', 'inspiration-to-implementation.html')))
      .toBe(true);
  }, 120_000);
});
