import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { compileBrand } from '../src/build/compile.ts';
import { DIST_PUBLICATION_LOCK_FILE } from '../src/build/publication-lock.ts';

const PRESET_DIR = fileURLToPath(new URL('../templates/presets/default/', import.meta.url));
const WORKER = fileURLToPath(new URL('./helpers/guide-publication-worker.ts', import.meta.url));
const BEGIN = '<!-- onbrand:begin palette -->';
const END = '<!-- onbrand:end palette -->';
const roots: string[] = [];
const workers: WorkerHandle[] = [];

interface WorkerHandle {
  child: ChildProcessWithoutNullStreams;
  exited: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

function scaffoldProject(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'onbrand-guide-race-'));
  roots.push(root);
  const project = path.join(root, 'project');
  const brand = path.join(project, 'brand');
  cpSync(PRESET_DIR, brand, { recursive: true });
  writeFileSync(
    path.join(brand, 'guide.md'),
    ['# Guide', '', BEGIN, '_pending_', END, '', 'operator prose', ''].join('\n'),
    'utf8',
  );
  return project;
}

function setAccent(project: string, value: string): void {
  const tokensPath = path.join(project, 'brand', 'tokens.json');
  const tokens = JSON.parse(readFileSync(tokensPath, 'utf8')) as {
    color: { semantic: { accent: { $value: string } } };
  };
  tokens.color.semantic.accent.$value = value;
  writeFileSync(tokensPath, `${JSON.stringify(tokens, null, 2)}\n`, 'utf8');
}

function startWorker(project: string, ready: string, release: string): WorkerHandle {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', WORKER, project, ready, release],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  const handle: WorkerHandle = { child, exited: false, code: null, stdout: '', stderr: '' };
  workers.push(handle);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { handle.stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { handle.stderr += chunk; });
  child.on('exit', (code) => {
    handle.exited = true;
    handle.code = code;
  });
  return handle;
}

async function pollUntil(predicate: () => boolean, failure: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(failure());
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitReady(handle: WorkerHandle, ready: string): Promise<void> {
  await pollUntil(
    () => existsSync(ready) || handle.exited,
    () => `worker did not reach guide barrier\nstdout: ${handle.stdout}\nstderr: ${handle.stderr}`,
  );
  if (!existsSync(ready)) {
    throw new Error(`worker exited before guide barrier (${handle.code})\n${handle.stderr}`);
  }
}

async function waitExit(handle: WorkerHandle): Promise<void> {
  await pollUntil(
    () => handle.exited,
    () => `worker did not exit\nstdout: ${handle.stdout}\nstderr: ${handle.stderr}`,
  );
}

afterEach(async () => {
  for (const worker of workers.splice(0)) {
    if (!worker.exited) {
      worker.child.kill();
      await waitExit(worker).catch(() => undefined);
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('guide publication transaction', () => {
  it('holds the brand writer lock through guide publication and an ordered retry is coherent', async () => {
    const project = scaffoldProject();
    const root = path.dirname(project);
    const brand = path.join(project, 'brand');
    const dist = path.join(brand, 'dist');
    const guidePath = path.join(brand, 'guide.md');
    const ready = path.join(root, 'older.ready');
    const release = path.join(root, 'older.release');
    const olderAccent = '#102030';
    const newerAccent = '#405060';
    setAccent(project, olderAccent);

    const older = startWorker(project, ready, release);
    await waitReady(older, ready);
    const heldManifest = readFileSync(path.join(dist, 'manifest.json'));
    const heldPalette = readFileSync(path.join(dist, 'palette.svg'));
    const heldGuide = readFileSync(guidePath);

    setAccent(project, newerAccent);
    expect(() => compileBrand(project)).toThrowError(/live local PID|publication lock/);
    expect(readFileSync(path.join(dist, 'manifest.json'))).toEqual(heldManifest);
    expect(readFileSync(path.join(dist, 'palette.svg'))).toEqual(heldPalette);
    expect(readFileSync(guidePath)).toEqual(heldGuide);

    writeFileSync(release, 'release\n', { flag: 'wx' });
    await waitExit(older);
    expect(older.code, older.stderr).toBe(0);
    expect(readFileSync(guidePath, 'utf8')).toContain(olderAccent);

    const retry = compileBrand(project);
    const guide = readFileSync(guidePath, 'utf8');
    const palette = readFileSync(path.join(dist, 'palette.svg'), 'utf8');
    const css = readFileSync(path.join(dist, 'tokens.css'), 'utf8');
    expect(retry.guide?.status).toBe('updated');
    expect(guide).toContain(newerAccent);
    expect(guide).not.toContain(olderAccent);
    expect(palette).toContain(newerAccent);
    expect(palette).not.toContain(olderAccent);
    expect(css).toContain(`--color-semantic-accent: ${newerAccent};`);
    expect(retry.manifest.outputs['palette.svg']).toBe(retry.manifest.sourceHash);
  }, 30_000);

  it.runIf(process.platform !== 'win32')(
    'keeps a crash-residue stage private and recovers without deleting another run inode',
    async () => {
      const project = scaffoldProject();
      const root = path.dirname(project);
      const brand = path.join(project, 'brand');
      const guidePath = path.join(brand, 'guide.md');
      const ready = path.join(root, 'crash.ready');
      const release = path.join(root, 'never.release');
      chmodSync(guidePath, 0o600);
      const before = readFileSync(guidePath);

      const worker = startWorker(project, ready, release);
      await waitReady(worker, ready);
      const stagedNames = readdirSync(brand).filter((name) => /^\.onbrand-tmp-[0-9a-f]{64}$/.test(name));
      expect(stagedNames).toHaveLength(1);
      const crashStage = path.join(brand, stagedNames[0]!);
      expect(statSync(crashStage).mode & 0o777).toBe(0o600);

      worker.child.kill('SIGKILL');
      await waitExit(worker);
      expect(readFileSync(guidePath)).toEqual(before);
      expect(statSync(guidePath).mode & 0o777).toBe(0o600);
      expect(existsSync(crashStage)).toBe(true);
      expect(statSync(crashStage).mode & 0o777).toBe(0o600);

      expect(compileBrand(project).guide?.status).toBe('updated');
      expect(statSync(guidePath).mode & 0o777).toBe(0o600);
      expect(existsSync(crashStage)).toBe(true);
      expect(existsSync(path.join(brand, DIST_PUBLICATION_LOCK_FILE))).toBe(false);
      rmSync(crashStage);
    },
    30_000,
  );
});
