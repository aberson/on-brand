import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { compileBrand, implementedEmitterOutputs } from '../src/build/compile.ts';
import {
  DIST_PUBLICATION_LOCK_FILE,
  acquireDistPublicationLock,
} from '../src/build/publication-lock.ts';
import { runCheck } from '../src/check/run.ts';
import { buildObservatoryArtifact } from '../src/gallery/observatory-export.ts';
import { classifyBrand } from '../src/gallery/discover.ts';
import { identityOf, sameFileNode } from '../src/filesystem.ts';
import {
  FROZEN_ASSIGNMENT_TARGETS,
  INSPIRATION_SCHEMA,
  INSPIRATION_SCHEMA_VERSION,
  inspirationIdForAssetSha256,
  type InspirationTrace,
} from '../src/inspiration/contract.ts';
import {
  INSPIRATION_VIEW_OUTPUT,
  SPECIMEN_CONTENT_SOURCE_LABEL,
  SPECIMEN_VIEW_OUTPUT,
  classifyInspirationViewFreshness,
  recordSpecimenView,
} from '../src/inspiration/views.ts';
import { generatePreview } from '../src/preview/specimen.ts';
import {
  controllerLeaseBytes,
  prepareControllerLeasePath,
  controllerLeasePaths,
  controllerScopeBinding,
  controllerScopePaths,
} from './helpers/retirement-controller-fixture.ts';

const PRESET_DIR = fileURLToPath(new URL('../templates/presets/default/', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/onbrand.mjs', import.meta.url));
const WORKER = fileURLToPath(new URL('./helpers/dist-publication-worker.ts', import.meta.url));
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9W9QF0oAAAAASUVORK5CYII=',
  'base64',
);
const PNG_SHA256 = createHash('sha256').update(PNG).digest('hex');
const ALT_PNG = readFileSync(
  fileURLToPath(new URL('./fixtures/extraction/screenshots/example.png', import.meta.url)),
);
const ALT_PNG_SHA256 = createHash('sha256').update(ALT_PNG).digest('hex');
const roots: string[] = [];
const workers: WorkerHandle[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'onbrand-lifecycle-'));
  roots.push(root);
  return root;
}

function scaffoldProject(withTrace = false): string {
  const project = path.join(tempRoot(), 'project');
  cpSync(PRESET_DIR, path.join(project, 'brand'), { recursive: true });
  if (withTrace) writeTrace(project);
  return project;
}

function makeTrace(
  summary = 'A compact measured blue palette.',
  assetSha256 = PNG_SHA256,
  assetRelativePath = 'assets/inspiration.png',
): InspirationTrace {
  return {
    schema: INSPIRATION_SCHEMA,
    schemaVersion: INSPIRATION_SCHEMA_VERSION,
    id: inspirationIdForAssetSha256(assetSha256),
    reviewStatus: 'generated-draft',
    summary,
    asset: {
      path: assetRelativePath,
      sha256: assetSha256,
      mediaType: 'image/png',
      alt: 'One synthetic blue pixel.',
      creator: 'test fixture',
      title: 'Synthetic blue',
      date: 'unknown',
      sourceUrl: null,
      rights: 'test-only',
      licenseUrl: null,
      retrievedAt: null,
    },
    analysis: {
      sourceKind: 'image',
      algorithm: 'image-cluster-v1',
      basePreset: 'default',
      primary: { sampleId: 'sample-01', selectionSource: 'deterministic' },
      neutral: null,
      secondaries: [],
      unobservedDefaults: ['typography', 'spacing', 'radius', 'shadow', 'motion', 'status'],
      defaultDerivedColorTargets: FROZEN_ASSIGNMENT_TARGETS.slice(2).map((token) => ({
        token,
        role: token.startsWith('color.chart.') ? 'categorical' as const : 'diagram' as const,
        reason: 'no-qualifying-image-sample' as const,
      })),
    },
    mappings: [{
      id: 'sample-01',
      label: 'Measured blue',
      region: { x: 0, y: 0, width: 0.04, height: 0.04 },
      sample: {
        hex: '#3b63a8',
        method: 'image-cluster-v1',
        selectionSource: 'deterministic',
        pixelShare: 1,
      },
      targets: [
        'color.chart.categorical.1',
        'color.diagram.spine-accent',
        'color.primitive.brand.9',
        'color.semantic.accent',
      ].map((token) => ({
        token,
        presentation: 'swatch-only' as const,
        relationship: 'sampled' as const,
        usage: `Synthetic ${token} assignment.`,
      })),
      rationale: 'Measured sample mapped deterministically.',
      confidence: 'high',
    }],
  };
}

function writeTrace(
  project: string,
  summary?: string,
  assetBytes: Buffer = PNG,
  assetRelativePath = 'assets/inspiration.png',
): void {
  const brand = path.join(project, 'brand');
  const assetPath = path.join(brand, ...assetRelativePath.split('/'));
  mkdirSync(path.dirname(assetPath), { recursive: true });
  const assetSha256 = createHash('sha256').update(assetBytes).digest('hex');
  writeFileSync(assetPath, assetBytes);
  writeFileSync(
    path.join(brand, 'inspiration.json'),
    `${JSON.stringify(makeTrace(summary, assetSha256, assetRelativePath), null, 2)}\n`,
  );
}

function manifest(project: string): {
  sourceHash: string;
  outputs: Record<string, string>;
  outputSources?: Record<string, unknown>;
} {
  return JSON.parse(
    readFileSync(path.join(project, 'brand', 'dist', 'manifest.json'), 'utf8'),
  ) as ReturnType<typeof manifest>;
}

function mutateCore(project: string): void {
  const target = path.join(project, 'brand', 'tokens.json');
  const tokens = JSON.parse(readFileSync(target, 'utf8')) as {
    space: Record<string, { $value: string }>;
  };
  tokens.space['1']!.$value = '0.3125rem';
  writeFileSync(target, `${JSON.stringify(tokens, null, 2)}\n`);
}

function mutatePreviewRelevantCore(project: string): void {
  const target = path.join(project, 'brand', 'tokens.json');
  const tokens = JSON.parse(readFileSync(target, 'utf8')) as {
    font: { sans: { $value: string[] } };
  };
  tokens.font.sans.$value[0] = 'Arial';
  writeFileSync(target, `${JSON.stringify(tokens, null, 2)}\n`);
}

function distSnapshot(project: string): Record<string, string> {
  const dist = path.join(project, 'brand', 'dist');
  return Object.fromEntries(
    readdirSync(dist)
      .filter((name) => name !== DIST_PUBLICATION_LOCK_FILE && !name.includes('.onbrand-tmp-'))
      .sort()
      .map((name) => [name, readFileSync(path.join(dist, name)).toString('base64')]),
  );
}

function staleOutputPaths(project: string): string[] {
  return runCheck(project).findings
    .filter((finding) => finding.category === 'stale-dist' && finding.severity === 'error')
    .map((finding) => finding.path)
    .filter((value): value is string => value !== undefined)
    .sort();
}

function replaceWithSameBytesNewNode(target: string, content: string): void {
  const originalIdentity = identityOf(statSync(target, { bigint: true }));
  const replacement = `${target}.replacement-${randomUUID()}`;
  // Reserve the replacement while the original inode still exists, so even a
  // filesystem that eagerly recycles inode numbers cannot make this ambiguous.
  let staged = false;
  try {
    writeFileSync(replacement, content, { flag: 'wx' });
    staged = true;
    const replacementIdentity = identityOf(statSync(replacement, { bigint: true }));
    expect(sameFileNode(originalIdentity, replacementIdentity)).toBe(false);
    rmSync(target);
    renameSync(replacement, target);
    staged = false;
  } finally {
    if (staged) rmSync(replacement, { force: true });
  }
}

interface WorkerHandle {
  child: ChildProcessWithoutNullStreams;
  exited: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

function startWorker(
  mode:
    | 'compile'
    | 'record'
    | 'preview'
    | 'lock'
    | 'lock-release-after-lease'
    | 'lock-release-after-unlink',
  project: string,
  ready: string,
  release: string,
): WorkerHandle {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', WORKER, mode, project, ready, release],
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
    () => `worker did not reach barrier\nstdout: ${handle.stdout}\nstderr: ${handle.stderr}`,
  );
  if (!existsSync(ready)) {
    throw new Error(`worker exited before barrier (${handle.code})\n${handle.stderr}`);
  }
}

async function waitExit(handle: WorkerHandle): Promise<void> {
  await pollUntil(
    () => handle.exited,
    () => `worker did not exit\nstdout: ${handle.stdout}\nstderr: ${handle.stderr}`,
  );
}

function previewCli(project: string) {
  return spawnSync(process.execPath, [BIN, 'preview', project], {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function createDirectoryLink(target: string, linkPath: string): void {
  try {
    symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
      throw new Error(`directory link/reparse fixture unavailable (${code}); acceptance cannot silently pass`);
    }
    throw cause;
  }
}

function detectFileSymlinkCapability(): boolean {
  const root = mkdtempSync(path.join(os.tmpdir(), 'onbrand-symlink-capability-'));
  const target = path.join(root, 'target.txt');
  const link = path.join(root, 'link.txt');
  try {
    writeFileSync(target, 'capability\n');
    symlinkSync(target, link, 'file');
    return true;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') return false;
    throw cause;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const FILE_SYMLINKS_AVAILABLE = detectFileSymlinkCapability();

afterEach(async () => {
  for (const worker of workers.splice(0)) {
    if (!worker.exited) {
      worker.child.kill();
      await waitExit(worker).catch(() => undefined);
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('generated-view lifecycle', () => {
  it('accepts and preserves a clean 240-character asset path, but rejects 241 before publication', () => {
    const acceptedPath = `assets/${'a'.repeat(229)}.png`;
    const rejectedPath = `assets/${'a'.repeat(230)}.png`;
    expect(acceptedPath).toHaveLength(240);
    expect(rejectedPath).toHaveLength(241);

    const accepted = scaffoldProject();
    writeTrace(accepted, undefined, PNG, acceptedPath);
    const acceptedBuild = compileBrand(accepted);
    expect(acceptedBuild.manifest.outputSources?.[INSPIRATION_VIEW_OUTPUT]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'asset', sourcePath: acceptedPath }),
      ]),
    );

    const rejected = scaffoldProject();
    writeTrace(rejected, undefined, PNG, rejectedPath);
    expect(() => compileBrand(rejected)).toThrow(/asset\.path.*at most 240|asset\.path.*clean brand-relative/);
    expect(existsSync(path.join(rejected, 'brand', 'dist', 'manifest.json'))).toBe(false);
    expect(existsSync(path.join(rejected, 'brand', 'dist', INSPIRATION_VIEW_OUTPUT))).toBe(false);
  });

  it('real build, preview, recorder, and runCheck wiring detects specimen-only byte drift', () => {
    const project = scaffoldProject();
    const built = compileBrand(project);
    const preview = generatePreview(project);
    expect(recordSpecimenView(
      project,
      preview.generation,
      built.manifest.sourceHash,
      { required: true },
    )).toBe(true);
    expect(runCheck(project).ok).toBe(true);

    const recordedDigest = preview.generation!.specimen.sha256;
    const changed = Buffer.concat([
      readFileSync(preview.specimenPath),
      Buffer.from('<!-- specimen-only mutation -->\n', 'utf8'),
    ]);
    writeFileSync(preview.specimenPath, changed);
    const currentDigest = createHash('sha256').update(changed).digest('hex');
    const report = runCheck(project);
    const specimenFindings = report.findings.filter((finding) => finding.path === SPECIMEN_VIEW_OUTPUT);
    expect(report.ok).toBe(false);
    expect(specimenFindings).toEqual([expect.objectContaining({
      code: 'stale-dist-output-outdated',
      evidence: expect.objectContaining({
        digestLabel: SPECIMEN_CONTENT_SOURCE_LABEL,
        recordedContentSha256: recordedDigest,
        currentContentSha256: currentDigest,
        hashesMatch: false,
      }),
    })]);
  });

  it('distinguishes absent, invalid, current, stale subset, and full-build removal states', () => {
    const project = scaffoldProject();
    const dist = path.join(project, 'brand', 'dist');
    expect(classifyInspirationViewFreshness(project, '0'.repeat(64))).toEqual({ state: 'absent' });
    compileBrand(project, { now: () => '2026-08-21T00:00:00.000Z' });
    const first = distSnapshot(project);
    compileBrand(project, { now: () => '2026-08-22T00:00:00.000Z' });
    expect(distSnapshot(project)).toEqual(first);
    expect(runCheck(project).ok).toBe(true);

    writeFileSync(path.join(project, 'brand', 'inspiration.json'), '{}\n');
    expect(classifyInspirationViewFreshness(project, manifest(project).sourceHash)).toEqual({ state: 'invalid' });
    expect(() => compileBrand(project)).toThrow();

    writeTrace(project);
    const current = compileBrand(project);
    expect(classifyInspirationViewFreshness(project, current.manifest.sourceHash).state).toBe('current');
    const explanation = path.join(dist, INSPIRATION_VIEW_OUTPUT);
    const originalHtml = readFileSync(explanation, 'utf8');
    const originalDigest = manifest(project).outputs[INSPIRATION_VIEW_OUTPUT];
    expect(originalDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(runCheck(project).ok).toBe(true);

    writeTrace(project, 'A changed but still valid explanation.');
    expect(staleOutputPaths(project)).toEqual([INSPIRATION_VIEW_OUTPUT]);
    compileBrand(project, { emit: ['css'] });
    expect(readFileSync(explanation, 'utf8')).toBe(originalHtml);
    expect(manifest(project).outputs[INSPIRATION_VIEW_OUTPUT]).toBe(originalDigest);
    expect(runCheck(project).ok).toBe(false);

    compileBrand(project);
    expect(readFileSync(explanation, 'utf8')).not.toBe(originalHtml);
    expect(runCheck(project).ok).toBe(true);

    // A valid binary asset mutation updates the trace's exact digest/id while
    // leaving core sources untouched, so only the explanation becomes stale.
    writeTrace(project, 'A changed but still valid explanation.', ALT_PNG);
    const mutatedTrace = JSON.parse(
      readFileSync(path.join(project, 'brand', 'inspiration.json'), 'utf8'),
    ) as InspirationTrace;
    expect(mutatedTrace.asset.sha256).toBe(ALT_PNG_SHA256);
    expect(mutatedTrace.id).toBe(inspirationIdForAssetSha256(ALT_PNG_SHA256));
    expect(staleOutputPaths(project)).toEqual([INSPIRATION_VIEW_OUTPUT]);
    compileBrand(project);
    expect(runCheck(project).ok).toBe(true);

    rmSync(path.join(project, 'brand', 'inspiration.json'));
    compileBrand(project, { emit: ['css'] });
    expect(existsSync(explanation)).toBe(true);
    expect(staleOutputPaths(project)).toEqual([INSPIRATION_VIEW_OUTPUT]);

    // Gallery deliberately ignores optional-view drift for brand health, while
    // its exported check consumer keeps the existing v1 error code/shape.
    expect(classifyBrand(project)).toMatchObject({ status: 'adopted', final: true });
    const galleryArtifact = buildObservatoryArtifact({
      root: project,
      now: () => new Date('2026-08-22T00:00:00.000Z'),
    });
    expect(galleryArtifact.schema).toBe('onbrand.observatory');
    expect(galleryArtifact.schemaVersion).toBe(1);
    expect(galleryArtifact.brands).toHaveLength(1);
    const galleryBrand = galleryArtifact.brands[0]!;
    expect(galleryBrand).toMatchObject({ status: 'adopted', final: true });
    expect(galleryBrand.check).toMatchObject({ state: 'available', ok: false });
    expect(galleryBrand.check.state).toBe('available');
    if (galleryBrand.check.state !== 'available') throw new Error('expected available gallery check');
    expect(galleryBrand.check.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'stale-dist-output-outdated',
        path: INSPIRATION_VIEW_OUTPUT,
      }),
    ]));
    const checkJsonRun = spawnSync(process.execPath, [BIN, 'check', project, '--json'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(checkJsonRun.status, checkJsonRun.stderr).toBe(1);
    const checkJson = JSON.parse(checkJsonRun.stdout) as {
      schema: string;
      schemaVersion: number;
      state: string;
      ok: boolean;
      findings: Array<{ code: string; path?: string }>;
    };
    expect(checkJson).toMatchObject({
      schema: 'onbrand.check', schemaVersion: 1, state: 'available', ok: false,
    });
    expect(checkJson.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'stale-dist-output-outdated',
        path: INSPIRATION_VIEW_OUTPUT,
      }),
    ]));

    compileBrand(project);
    const removed = manifest(project);
    expect(existsSync(explanation)).toBe(false);
    expect(removed.outputs).not.toHaveProperty(INSPIRATION_VIEW_OUTPUT);
    expect(removed.outputSources?.[INSPIRATION_VIEW_OUTPUT]).toBeUndefined();
    expect(runCheck(project).ok).toBe(true);
  });

  it('core mutation stales core plus both current optional views, and subsets preserve without freshening', () => {
    const coreProject = scaffoldProject(true);
    const coreBuild = compileBrand(coreProject);
    const corePreview = generatePreview(coreProject);
    expect(recordSpecimenView(
      coreProject,
      corePreview.generation,
      coreBuild.manifest.sourceHash,
      { required: true },
    )).toBe(true);
    const current = manifest(coreProject);
    expect(current.outputSources?.[SPECIMEN_VIEW_OUTPUT]).toEqual([{
      label: SPECIMEN_CONTENT_SOURCE_LABEL,
      sourcePath: null,
      kind: 'digest',
      sha256: corePreview.generation?.specimen.sha256,
    }]);
    expect(runCheck(coreProject).ok).toBe(true);

    mutateCore(coreProject);
    expect(staleOutputPaths(coreProject)).toEqual([
      ...implementedEmitterOutputs().map((output) => output.relPath),
      INSPIRATION_VIEW_OUTPUT,
      SPECIMEN_VIEW_OUTPUT,
    ].sort());

    const subsetProject = scaffoldProject(true);
    const beforeSubsetBuild = compileBrand(subsetProject);
    const subsetPreview = generatePreview(subsetProject);
    expect(recordSpecimenView(
      subsetProject,
      subsetPreview.generation,
      beforeSubsetBuild.manifest.sourceHash,
      { required: true },
    )).toBe(true);
    const beforeSubset = manifest(subsetProject);
    const dist = path.join(subsetProject, 'brand', 'dist');
    const specimenBytes = readFileSync(path.join(dist, SPECIMEN_VIEW_OUTPUT));
    const explanationBytes = readFileSync(path.join(dist, INSPIRATION_VIEW_OUTPUT));

    mutateCore(subsetProject);
    const subsetBuild = compileBrand(subsetProject, {
      emit: ['css'],
      now: () => '2026-08-22T02:00:00.000Z',
    });
    const afterSubset = manifest(subsetProject);
    expect(readFileSync(path.join(dist, SPECIMEN_VIEW_OUTPUT))).toEqual(specimenBytes);
    expect(readFileSync(path.join(dist, INSPIRATION_VIEW_OUTPUT))).toEqual(explanationBytes);
    expect(afterSubset.outputs[SPECIMEN_VIEW_OUTPUT]).toBe(beforeSubset.outputs[SPECIMEN_VIEW_OUTPUT]);
    expect(afterSubset.outputs[INSPIRATION_VIEW_OUTPUT]).toBe(beforeSubset.outputs[INSPIRATION_VIEW_OUTPUT]);
    expect(afterSubset.outputSources?.[SPECIMEN_VIEW_OUTPUT]).toEqual(
      beforeSubset.outputSources?.[SPECIMEN_VIEW_OUTPUT],
    );
    expect(afterSubset.outputSources?.[INSPIRATION_VIEW_OUTPUT]).toEqual(
      beforeSubset.outputSources?.[INSPIRATION_VIEW_OUTPUT],
    );
    expect(afterSubset.outputs[SPECIMEN_VIEW_OUTPUT]).not.toBe(subsetBuild.manifest.sourceHash);
    expect(staleOutputPaths(subsetProject)).toEqual([
      ...implementedEmitterOutputs()
        .map((output) => output.relPath)
        .filter((relPath) => relPath !== 'tokens.css'),
      INSPIRATION_VIEW_OUTPUT,
      SPECIMEN_VIEW_OUTPUT,
    ].sort());
  });

  it('keeps missing, corrupt, busy, and stale-input previews usable when provenance refresh fails', () => {
    for (const state of ['missing', 'corrupt'] as const) {
      const project = scaffoldProject();
      compileBrand(project);
      const manifestPath = path.join(project, 'brand', 'dist', 'manifest.json');
      if (state === 'missing') rmSync(manifestPath);
      else writeFileSync(manifestPath, '{ corrupt\n');
      const preview = generatePreview(project);
      expect(existsSync(preview.specimenPath)).toBe(true);
      expect(recordSpecimenView(project, preview.generation, '0'.repeat(64))).toBe(false);
      expect(existsSync(manifestPath)).toBe(state === 'corrupt');
      if (state === 'corrupt') expect(readFileSync(manifestPath, 'utf8')).toBe('{ corrupt\n');
    }

    const busy = scaffoldProject();
    const busyBuild = compileBrand(busy);
    const priorBusyPreview = generatePreview(busy);
    expect(recordSpecimenView(
      busy,
      priorBusyPreview.generation,
      busyBuild.manifest.sourceHash,
      { required: true },
    )).toBe(true);
    const beforeBusy = readFileSync(path.join(busy, 'brand', 'dist', 'manifest.json'), 'utf8');
    const lock = acquireDistPublicationLock(busy);
    try {
      const run = previewCli(busy);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr).toContain(
        'onbrand preview: warning: specimen.html is usable, but its provenance refresh failed.',
      );
      expect(run.stderr).toContain('onbrand preview: remediation:');
      const argvLines = run.stderr.split('\n').filter((line) => line.includes('remediation argv ('));
      expect(argvLines).toHaveLength(2);
      expect(argvLines.map((line) => (JSON.parse(line.slice(line.indexOf('['))) as string[]).slice(2))).toEqual([
        ['build', busy],
        ['preview', busy],
      ]);
      expect(existsSync(path.join(busy, 'brand', 'dist', SPECIMEN_VIEW_OUTPUT))).toBe(true);
      expect(readFileSync(path.join(busy, 'brand', 'dist', 'manifest.json'), 'utf8')).toBe(beforeBusy);
      expect(manifest(busy).outputs[SPECIMEN_VIEW_OUTPUT]).toBe(busyBuild.manifest.sourceHash);
      // The deterministic rewrite has the same exact bytes, so the older
      // digest can remain current even though this refresh attempt failed.
      expect(runCheck(busy).ok).toBe(true);
      const requiredPreview = generatePreview(busy);
      expect(() => recordSpecimenView(
        busy,
        requiredPreview.generation,
        manifest(busy).sourceHash,
        { required: true },
      )).toThrow(/publication lock|live local PID/);
    } finally {
      expect(lock.release()).toBe(true);
    }

    const stale = scaffoldProject();
    compileBrand(stale);
    mutateCore(stale);
    const run = previewCli(stale);
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(path.join(stale, 'brand', 'dist', SPECIMEN_VIEW_OUTPUT))).toBe(true);
    expect(manifest(stale).outputs).not.toHaveProperty(SPECIMEN_VIEW_OUTPUT);
  });
});

describe('real publisher interleavings', () => {
  it('an interposed older preview cannot certify over the newest preview generation', async () => {
    const project = scaffoldProject();
    compileBrand(project, { now: () => '2026-08-22T00:00:00.000Z' });
    const root = path.dirname(project);
    const oldReady = path.join(root, 'old-preview.ready');
    const oldRelease = path.join(root, 'old-preview.release');
    const oldPreview = startWorker('preview', project, oldReady, oldRelease);
    await waitReady(oldPreview, oldReady);

    // The older preview has consumed/rendered generation A but has not staged
    // specimen.html. Publish B, then let its recorder stop before final check.
    mutatePreviewRelevantCore(project);
    const newerBuild = compileBrand(project, { now: () => '2026-08-22T01:00:00.000Z' });
    const recordReady = path.join(root, 'new-record.ready');
    const recordRelease = path.join(root, 'new-record.release');
    const newerRecorder = startWorker('record', project, recordReady, recordRelease);
    await waitReady(newerRecorder, recordReady);
    const specimenPath = path.join(project, 'brand', 'dist', SPECIMEN_VIEW_OUTPUT);
    const newestBytes = readFileSync(specimenPath);
    const newestIdentity = statSync(specimenPath, { bigint: true });

    // A now stages and publishes against B's visible specimen pathname. Its
    // own provenance attempt loses the held manifest lock and cannot refresh.
    writeFileSync(oldRelease, 'release\n', { flag: 'wx' });
    await waitExit(oldPreview);
    expect(oldPreview.code, oldPreview.stderr).toBe(0);
    expect(oldPreview.stdout).toContain('"recorded":false');
    const interposedIdentity = statSync(specimenPath, { bigint: true });
    expect(sameFileNode(identityOf(interposedIdentity), identityOf(newestIdentity))).toBe(false);
    expect(readFileSync(specimenPath)).not.toEqual(newestBytes);

    // B's recorder revalidates after the barrier and refuses to publish. The
    // next newest preview can then record exact HTML bytes and becomes current.
    writeFileSync(recordRelease, 'release\n', { flag: 'wx' });
    await waitExit(newerRecorder);
    expect(newerRecorder.code).toBe(1);
    expect(newerRecorder.stderr).toContain('dist changed before manifest publication');
    expect(manifest(project).outputs).not.toHaveProperty(SPECIMEN_VIEW_OUTPUT);

    const retry = previewCli(project);
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stderr).not.toContain('provenance refresh failed');
    const retriedManifest = manifest(project);
    expect(retriedManifest.outputs[SPECIMEN_VIEW_OUTPUT]).toBe(newerBuild.manifest.sourceHash);
    expect(retriedManifest.outputSources?.[SPECIMEN_VIEW_OUTPUT]).toEqual([{
      label: SPECIMEN_CONTENT_SOURCE_LABEL,
      sourcePath: null,
      kind: 'digest',
      sha256: createHash('sha256').update(readFileSync(specimenPath)).digest('hex'),
    }]);
    expect(runCheck(project).ok).toBe(true);
  });

  it('a recorder held at its final validation barrier blocks every build output until retry', async () => {
    const project = scaffoldProject();
    const initial = compileBrand(project).manifest.sourceHash;
    const root = path.dirname(project);
    const ready = path.join(root, 'record.ready');
    const release = path.join(root, 'record.release');
    const worker = startWorker('record', project, ready, release);
    await waitReady(worker, ready);

    mutateCore(project);
    const heldDist = distSnapshot(project);
    expect(() => compileBrand(project)).toThrow(/live local PID|publication lock/);
    expect(distSnapshot(project)).toEqual(heldDist);

    writeFileSync(release, 'release\n', { flag: 'wx' });
    await waitExit(worker);
    expect(worker.code, worker.stderr).toBe(0);
    expect(manifest(project).outputs[SPECIMEN_VIEW_OUTPUT]).toBe(initial);

    const expectedProject = path.join(root, 'independent-expected-project');
    cpSync(project, expectedProject, { recursive: true });
    const retryTime = () => '2026-08-22T03:00:00.000Z';
    const expected = compileBrand(expectedProject, { now: retryTime });
    const newer = compileBrand(project, { now: retryTime }).manifest;
    expect(newer.sourceHash).not.toBe(initial);
    expect(newer).toEqual(expected.manifest);
    expect(distSnapshot(project)).toEqual(distSnapshot(expectedProject));
    expect(newer.outputs[SPECIMEN_VIEW_OUTPUT]).toBe(initial);
    expect(runCheck(project).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'stale-dist-output-outdated', path: SPECIMEN_VIEW_OUTPUT }),
    ]));
  });

  it('a compile held before manifest rename leaves a raced CLI preview usable without refreshed provenance', async () => {
    const project = scaffoldProject();
    const initial = compileBrand(project).manifest.sourceHash;
    mutateCore(project);
    const root = path.dirname(project);
    const ready = path.join(root, 'compile.ready');
    const release = path.join(root, 'compile.release');
    const worker = startWorker('compile', project, ready, release);
    await waitReady(worker, ready);

    const run = previewCli(project);
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(path.join(project, 'brand', 'dist', SPECIMEN_VIEW_OUTPUT))).toBe(true);
    expect(manifest(project).sourceHash).toBe(initial);
    expect(manifest(project).outputs).not.toHaveProperty(SPECIMEN_VIEW_OUTPUT);

    writeFileSync(release, 'release\n', { flag: 'wx' });
    await waitExit(worker);
    expect(worker.code, worker.stderr).toBe(0);
    expect(manifest(project).sourceHash).not.toBe(initial);
    expect(manifest(project).outputs).not.toHaveProperty(SPECIMEN_VIEW_OUTPUT);
    expect(runCheck(project).ok).toBe(true);
  });
});

describe('publication lock ownership', () => {
  it('rejects an ordinary unknown dist-worker mode before filesystem work', () => {
    const root = tempRoot();
    const project = path.join(root, 'must-remain-absent');
    const ready = path.join(root, 'must-remain-absent.ready');
    const release = path.join(root, 'must-remain-absent.release');
    const run = spawnSync(
      process.execPath,
      ['--import', 'tsx', WORKER, 'ordinary-typo', project, ready, release],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true },
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('unknown worker mode "ordinary-typo"');
    expect(existsSync(project)).toBe(false);
    expect(existsSync(ready)).toBe(false);
    expect(existsSync(release)).toBe(false);
  });

  it.runIf(process.platform !== 'win32')(
    'descriptor-enforces private lock and controller modes under a restrictive child-process umask',
    () => {
      const project = scaffoldProject();
      const run = spawnSync(
        process.execPath,
        ['--import', 'tsx', WORKER, 'lock-mode', project, 'unused-ready', 'unused-release'],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true },
      );
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({
        mode: 'lock-mode',
        fileMode: 0o600,
        controllerScopeMode: 0o700,
        released: true,
      });
      expect(existsSync(path.join(project, 'brand', DIST_PUBLICATION_LOCK_FILE))).toBe(false);
    },
  );

  it('fails closed for live/malformed/replaced locks, recovers a real dead owner, and preserves replacements', async () => {
    const project = scaffoldProject();
    const lockPath = path.join(project, 'brand', DIST_PUBLICATION_LOCK_FILE);

    const live = acquireDistPublicationLock(project);
    const liveBytes = readFileSync(lockPath, 'utf8');
    const liveRecord = JSON.parse(liveBytes) as Record<string, unknown>;
    expect(Object.keys(liveRecord)).toEqual(['runToken', 'pid', 'startedAt']);
    expect(liveBytes).toBe(`${JSON.stringify(liveRecord)}\n`);
    expect(liveRecord).toEqual({
      runToken: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      pid: process.pid,
      startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });
    if (process.platform !== 'win32') {
      expect(Number(statSync(lockPath, { bigint: true }).mode & 0o777n)).toBe(0o600);
    }
    expect(() => acquireDistPublicationLock(project)).toThrow(/live local PID/);
    expect(live.release()).toBe(true);

    writeFileSync(lockPath, '{ malformed\n');
    expect(() => acquireDistPublicationLock(project)).toThrow(/unsafe or malformed/);
    expect(readFileSync(lockPath, 'utf8')).toBe('{ malformed\n');
    rmSync(lockPath);

    const deadRecord = `${JSON.stringify({
      runToken: randomUUID(),
      pid: 999_999_999,
      startedAt: '2026-08-21T00:00:00.000Z',
    })}\n`;
    writeFileSync(lockPath, deadRecord);
    expect(() => acquireDistPublicationLock(project, {
      processState: () => {
        replaceWithSameBytesNewNode(lockPath, deadRecord);
        return 'dead';
      },
    })).toThrow(/replaced during recovery/);
    expect(readFileSync(lockPath, 'utf8')).toBe(deadRecord);
    rmSync(lockPath);

    const owned = acquireDistPublicationLock(project);
    const ownedBytes = readFileSync(lockPath, 'utf8');
    replaceWithSameBytesNewNode(lockPath, ownedBytes);
    expect(owned.release()).toBe(false);
    expect(readFileSync(lockPath, 'utf8')).toBe(ownedBytes);
    rmSync(lockPath);

    const root = path.dirname(project);
    const ready = path.join(root, 'dead.ready');
    const release = path.join(root, 'dead.release');
    const holder = startWorker('lock', project, ready, release);
    await waitReady(holder, ready);
    expect(() => acquireDistPublicationLock(project)).toThrow(/live local PID/);
    expect(holder.child.kill()).toBe(true);
    await waitExit(holder);
    expect(existsSync(lockPath)).toBe(true);
    const recovered = acquireDistPublicationLock(project);
    expect(recovered.release()).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('repeats normal dist acquisition and release without leaving controller scopes', () => {
    const project = scaffoldProject();
    const lockPath = path.join(project, 'brand', DIST_PUBLICATION_LOCK_FILE);

    for (let attempt = 0; attempt < 5; attempt++) {
      const lock = acquireDistPublicationLock(project);
      expect(controllerScopePaths(lockPath)).toEqual([]);
      expect(lock.release()).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
      expect(controllerLeasePaths(lockPath)).toEqual([]);
      expect(controllerScopePaths(lockPath)).toEqual([]);
    }
  });

  it('resumes a strict dead dist controller but preserves live and malformed controller state', () => {
    const project = scaffoldProject();
    const lockPath = path.join(project, 'brand', DIST_PUBLICATION_LOCK_FILE);
    const record = {
      runToken: randomUUID(),
      pid: 999_999_999,
      startedAt: '2026-08-12T19:00:00.000Z',
    };
    const staleBytes = `${JSON.stringify(record)}\n`;
    const deadController = randomUUID();
    writeFileSync(lockPath, staleBytes);
    const deadBinding = controllerScopeBinding(lockPath);
    const leasePath = prepareControllerLeasePath(lockPath, record.runToken, deadController, deadBinding);
    writeFileSync(
      leasePath,
      controllerLeaseBytes(record.runToken, deadController, 999_999_998),
    );

    const acquired = acquireDistPublicationLock(project, {
      processState: () => 'dead',
      retirement: { processState: () => 'dead' },
    });
    expect(existsSync(leasePath)).toBe(false);
    expect(readFileSync(lockPath, 'utf8')).not.toBe(staleBytes);
    expect(acquired.release()).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(controllerScopePaths(lockPath)).toEqual([]);

    writeFileSync(lockPath, staleBytes);
    const liveBinding = controllerScopeBinding(lockPath);
    const liveController = randomUUID();
    const liveLease = prepareControllerLeasePath(lockPath, record.runToken, liveController, liveBinding);
    const liveBytes = controllerLeaseBytes(record.runToken, liveController, process.pid);
    writeFileSync(liveLease, liveBytes);
    expect(() => acquireDistPublicationLock(project, { processState: () => 'dead' }))
      .toThrow(/changed before dead-owner recovery/);
    expect(readFileSync(lockPath, 'utf8')).toBe(staleBytes);
    expect(readFileSync(liveLease, 'utf8')).toBe(liveBytes);
    rmSync(liveLease);

    let sourceOwnerRevived = false;
    expect(() => acquireDistPublicationLock(project, {
      processState: () => sourceOwnerRevived ? 'alive' : 'dead',
      retirement: {
        hooks: { beforeFinalControllerAuthorization: () => { sourceOwnerRevived = true; } },
      },
    })).toThrow(/changed before dead-owner recovery/);
    expect(readFileSync(lockPath, 'utf8')).toBe(staleBytes);
    expect(controllerLeasePaths(lockPath)).toEqual([]);
    expect(controllerScopePaths(lockPath)).toEqual([]);

    const malformedController = randomUUID();
    const malformedLease = prepareControllerLeasePath(lockPath, record.runToken, malformedController, liveBinding);
    writeFileSync(malformedLease, 'malformed controller\n');
    expect(() => acquireDistPublicationLock(project, { processState: () => 'dead' }))
      .toThrow(/changed before dead-owner recovery/);
    expect(readFileSync(lockPath, 'utf8')).toBe(staleBytes);
    expect(readFileSync(malformedLease, 'utf8')).toBe('malformed controller\n');
  });

  it('accepts exactly 63 peer controllers plus its own and fails closed at 64 peers plus its own', () => {
    const seed = (project: string, peerCount: number): {
      lockPath: string;
      staleBytes: string;
      peers: Map<string, string>;
    } => {
      const lockPath = path.join(project, 'brand', DIST_PUBLICATION_LOCK_FILE);
      const source = {
        runToken: randomUUID(),
        pid: 999_999_999,
        startedAt: '2026-08-12T19:00:00.000Z',
      };
      const staleBytes = `${JSON.stringify(source)}\n`;
      writeFileSync(lockPath, staleBytes);
      const scopeBinding = controllerScopeBinding(lockPath);
      const peers = new Map<string, string>();
      for (let index = 0; index < peerCount; index++) {
        const controllerId = randomUUID();
        const leasePath = prepareControllerLeasePath(lockPath, source.runToken, controllerId, scopeBinding);
        const leaseBytes = controllerLeaseBytes(
          source.runToken,
          controllerId,
          900_000_000 + index,
        );
        writeFileSync(leasePath, leaseBytes);
        peers.set(leasePath, leaseBytes);
      }
      return { lockPath, staleBytes, peers };
    };

    const acceptedProject = scaffoldProject();
    const accepted = seed(acceptedProject, 63);
    expect(controllerLeasePaths(accepted.lockPath)).toHaveLength(63);
    const acquired = acquireDistPublicationLock(acceptedProject, {
      processState: () => 'dead',
      retirement: { processState: () => 'dead' },
    });
    for (const peerPath of accepted.peers.keys()) expect(existsSync(peerPath)).toBe(false);
    expect(controllerScopePaths(accepted.lockPath)).toEqual([]);
    expect(acquired.release()).toBe(true);
    expect(existsSync(accepted.lockPath)).toBe(false);
    expect(controllerScopePaths(accepted.lockPath)).toEqual([]);

    const rejectedProject = scaffoldProject();
    const rejected = seed(rejectedProject, 64);
    expect(controllerLeasePaths(rejected.lockPath)).toHaveLength(64);
    expect(() => acquireDistPublicationLock(rejectedProject, {
      processState: () => 'dead',
      retirement: { processState: () => 'dead' },
    })).toThrow(/changed before dead-owner recovery/);
    expect(readFileSync(rejected.lockPath, 'utf8')).toBe(rejected.staleBytes);
    expect(controllerLeasePaths(rejected.lockPath)).toEqual([...rejected.peers.keys()].sort());
    for (const [peerPath, peerBytes] of rejected.peers) {
      expect(readFileSync(peerPath, 'utf8')).toBe(peerBytes);
    }
    expect(controllerScopePaths(rejected.lockPath)).toHaveLength(1);
  });

  it('fails closed and cleans its controller scope when dist release aborts before detach', () => {
    const project = scaffoldProject();
    const lock = acquireDistPublicationLock(project, {
      retirement: {
        hooks: {
          beforeFinalControllerAuthorization: () => {
            throw new Error('controlled controller release failure');
          },
        },
      },
    });
    const lockBytes = readFileSync(lock.path);
    const lockIdentity = statSync(lock.path, { bigint: true });

    expect(lock.release()).toBe(false);
    expect(readFileSync(lock.path)).toEqual(lockBytes);
    expect(sameFileNode(identityOf(statSync(lock.path, { bigint: true })), identityOf(lockIdentity)))
      .toBe(true);
    expect(controllerLeasePaths(lock.path)).toEqual([]);
    expect(controllerScopePaths(lock.path)).toEqual([]);
  });

  it('reports release success when only controller finalization fails after primary detach', () => {
    const project = scaffoldProject();
    const lock = acquireDistPublicationLock(project, {
      retirement: {
        hooks: {
          afterPrimaryUnlink: () => { throw new Error('controlled post-detach finalization failure'); },
        },
      },
    });

    expect(lock.release()).toBe(true);
    expect(lock.release()).toBe(true);
    expect(existsSync(lock.path)).toBe(false);
    expect(controllerLeasePaths(lock.path)).toEqual([]);
    expect(controllerScopePaths(lock.path)).toEqual([]);
  });

  it('recovers a dist releaser killed after controller publication without hard-linking the primary', async () => {
    const project = scaffoldProject();
    const lockPath = path.join(project, 'brand', DIST_PUBLICATION_LOCK_FILE);
    const root = path.dirname(project);
    const ready = path.join(root, 'dist-controller.ready');
    const worker = startWorker(
      'lock-release-after-lease',
      project,
      ready,
      path.join(root, 'never.release'),
    );
    await waitReady(worker, ready);
    const [leasePath] = controllerLeasePaths(lockPath);
    expect(leasePath).toBeDefined();
    const primary = statSync(lockPath, { bigint: true });
    const lease = statSync(leasePath!, { bigint: true });
    expect(primary.nlink).toBe(1n);
    expect(lease.nlink).toBe(1n);
    expect({ dev: lease.dev, ino: lease.ino }).not.toEqual({ dev: primary.dev, ino: primary.ino });

    expect(worker.child.kill()).toBe(true);
    await waitExit(worker);
    const recovered = acquireDistPublicationLock(project);
    expect(controllerLeasePaths(lockPath)).toEqual([]);
    expect(recovered.release()).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('keeps a dist controller killed after detach harmless to successor acquisition and release', async () => {
    const project = scaffoldProject();
    const lockPath = path.join(project, 'brand', DIST_PUBLICATION_LOCK_FILE);
    const root = path.dirname(project);
    const ready = path.join(root, 'dist-detached.ready');
    const worker = startWorker(
      'lock-release-after-unlink',
      project,
      ready,
      path.join(root, 'never.release'),
    );
    await waitReady(worker, ready);
    expect(existsSync(lockPath)).toBe(false);
    expect(controllerLeasePaths(lockPath)).toHaveLength(1);
    expect(worker.child.kill()).toBe(true);
    await waitExit(worker);

    const successor = acquireDistPublicationLock(project);
    const successorBytes = readFileSync(lockPath, 'utf8');
    const successorStat = statSync(lockPath, { bigint: true });
    expect(successor.release()).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(controllerLeasePaths(lockPath)).toHaveLength(1);
    expect(successorBytes).toContain(successor.record.runToken);
    expect(successorStat.nlink).toBe(1n);
  });
});

describe('filesystem publication boundary', () => {
  it('rejects linked project/brand/dist trees without changing an outside sentinel', () => {
    const root = tempRoot();
    const actualProject = path.join(root, 'actual-project');
    cpSync(PRESET_DIR, path.join(actualProject, 'brand'), { recursive: true });
    const sentinelDir = path.join(root, 'outside');
    mkdirSync(sentinelDir);
    const sentinel = path.join(sentinelDir, 'sentinel.txt');
    writeFileSync(sentinel, 'outside bytes\n');

    const projectLink = path.join(root, 'project-link');
    createDirectoryLink(actualProject, projectLink);
    expect(() => compileBrand(projectLink)).toThrow(/non-linked directory/);
    expect(existsSync(path.join(actualProject, 'brand', 'dist'))).toBe(false);
    expect(readFileSync(sentinel, 'utf8')).toBe('outside bytes\n');

    const outsideParent = path.join(root, 'outside-parent');
    const ancestorProject = path.join(outsideParent, 'project');
    cpSync(PRESET_DIR, path.join(ancestorProject, 'brand'), { recursive: true });
    const linkedParent = path.join(root, 'linked-parent');
    createDirectoryLink(outsideParent, linkedParent);
    expect(() => compileBrand(path.join(linkedParent, 'project'))).toThrow(/non-linked directory/);
    expect(existsSync(path.join(ancestorProject, 'brand', 'dist'))).toBe(false);

    const brandLinkedProject = path.join(root, 'brand-linked-project');
    mkdirSync(brandLinkedProject);
    const brandLink = path.join(brandLinkedProject, 'brand');
    createDirectoryLink(path.join(actualProject, 'brand'), brandLink);
    expect(() => compileBrand(brandLinkedProject)).toThrow(/non-linked directory/);
    expect(readFileSync(sentinel, 'utf8')).toBe('outside bytes\n');

    const distLinkedProject = path.join(root, 'dist-linked-project');
    cpSync(PRESET_DIR, path.join(distLinkedProject, 'brand'), { recursive: true });
    const outsideDist = path.join(root, 'outside-dist');
    mkdirSync(outsideDist);
    writeFileSync(path.join(outsideDist, 'sentinel.txt'), 'dist outside bytes\n');
    createDirectoryLink(outsideDist, path.join(distLinkedProject, 'brand', 'dist'));
    expect(() => compileBrand(distLinkedProject)).toThrow(/non-linked directory/);
    expect(readFileSync(path.join(outsideDist, 'sentinel.txt'), 'utf8')).toBe('dist outside bytes\n');
  });

  it('rejects hard-linked manifest/specimen targets without changing outside bytes', () => {
    const manifestProject = scaffoldProject();
    compileBrand(manifestProject);
    const outsideManifest = path.join(path.dirname(manifestProject), 'outside-manifest.txt');
    writeFileSync(outsideManifest, 'outside manifest bytes\n');
    const manifestPath = path.join(manifestProject, 'brand', 'dist', 'manifest.json');
    rmSync(manifestPath);
    linkSync(outsideManifest, manifestPath);
    expect(() => compileBrand(manifestProject)).toThrow(/unlinked regular file/);
    expect(readFileSync(outsideManifest, 'utf8')).toBe('outside manifest bytes\n');

    const specimenProject = scaffoldProject();
    compileBrand(specimenProject);
    const outsideSpecimen = path.join(path.dirname(specimenProject), 'outside-specimen.txt');
    writeFileSync(outsideSpecimen, 'outside specimen bytes\n');
    linkSync(outsideSpecimen, path.join(specimenProject, 'brand', 'dist', SPECIMEN_VIEW_OUTPUT));
    expect(() => compileBrand(specimenProject, { emit: ['css'] })).toThrow(/specimen target|unlinked/);
    expect(() => generatePreview(specimenProject)).toThrow(/unlinked regular file/);
    expect(readFileSync(outsideSpecimen, 'utf8')).toBe('outside specimen bytes\n');
  });

  it('rejects every hard-linked dist input consumed by preview and its recorder', () => {
    const inputs = ['tokens.css', 'components.css', 'diagram-palette.json', 'palette.svg'] as const;
    for (const relPath of inputs) {
      const project = scaffoldProject();
      compileBrand(project);
      const distPath = path.join(project, 'brand', 'dist', relPath);
      const outside = path.join(path.dirname(project), `outside-${relPath.replace('.', '-')}`);
      const original = readFileSync(distPath);
      writeFileSync(outside, original);
      rmSync(distPath);
      linkSync(outside, distPath);
      expect(() => generatePreview(project), relPath).toThrow(/single-link|stable local|unlinked/);
      expect(readFileSync(outside), relPath).toEqual(original);
    }

    const recorderProject = scaffoldProject();
    const built = compileBrand(recorderProject);
    const preview = generatePreview(recorderProject);
    const tokensPath = path.join(recorderProject, 'brand', 'dist', 'tokens.css');
    const outsideTokens = path.join(path.dirname(recorderProject), 'outside-recorder-tokens.css');
    const tokenBytes = readFileSync(tokensPath);
    writeFileSync(outsideTokens, tokenBytes);
    rmSync(tokensPath);
    linkSync(outsideTokens, tokensPath);
    expect(() => recordSpecimenView(
      recorderProject,
      preview.generation,
      built.manifest.sourceHash,
      { required: true },
    )).toThrow(/changed or is unsafe/);
    expect(readFileSync(outsideTokens)).toEqual(tokenBytes);
  });

  it.skipIf(!FILE_SYMLINKS_AVAILABLE)(
    'rejects symbolic manifest/specimen/guide targets across real production paths',
    () => {
      const manifestProject = scaffoldProject();
      compileBrand(manifestProject);
      const manifestPath = path.join(manifestProject, 'brand', 'dist', 'manifest.json');
      const outsideManifest = path.join(path.dirname(manifestProject), 'outside-symbolic-manifest.txt');
      writeFileSync(outsideManifest, 'symbolic manifest sentinel\n');
      rmSync(manifestPath);
      symlinkSync(outsideManifest, manifestPath, 'file');
      expect(() => compileBrand(manifestProject)).toThrow(/linked|unlinked|unsafe/);
      expect(runCheck(manifestProject)).toMatchObject({
        ok: false,
        findings: expect.arrayContaining([
          expect.objectContaining({ path: 'dist/manifest.json', severity: 'error' }),
        ]),
      });
      expect(readFileSync(outsideManifest, 'utf8')).toBe('symbolic manifest sentinel\n');

      const specimenProject = scaffoldProject();
      const built = compileBrand(specimenProject);
      const preview = generatePreview(specimenProject);
      expect(recordSpecimenView(
        specimenProject,
        preview.generation,
        built.manifest.sourceHash,
        { required: true },
      )).toBe(true);
      const specimenPath = path.join(specimenProject, 'brand', 'dist', SPECIMEN_VIEW_OUTPUT);
      const outsideSpecimen = path.join(path.dirname(specimenProject), 'outside-symbolic-specimen.txt');
      writeFileSync(outsideSpecimen, 'symbolic specimen sentinel\n');
      rmSync(specimenPath);
      symlinkSync(outsideSpecimen, specimenPath, 'file');
      expect(() => compileBrand(specimenProject, { emit: ['css'] })).toThrow(/linked|unlinked|unsafe/);
      expect(() => generatePreview(specimenProject)).toThrow(/linked|unlinked/);
      expect(runCheck(specimenProject)).toMatchObject({
        ok: false,
        findings: expect.arrayContaining([
          expect.objectContaining({ path: SPECIMEN_VIEW_OUTPUT, severity: 'error' }),
        ]),
      });
      expect(readFileSync(outsideSpecimen, 'utf8')).toBe('symbolic specimen sentinel\n');

      for (const relPath of ['tokens.css', 'components.css', 'diagram-palette.json', 'palette.svg']) {
        const inputProject = scaffoldProject();
        compileBrand(inputProject);
        const inputPath = path.join(inputProject, 'brand', 'dist', relPath);
        const outsideInput = path.join(path.dirname(inputProject), `outside-symbolic-${relPath.replace('.', '-')}`);
        const bytes = readFileSync(inputPath);
        writeFileSync(outsideInput, bytes);
        rmSync(inputPath);
        symlinkSync(outsideInput, inputPath, 'file');
        expect(() => generatePreview(inputProject), relPath).toThrow(/single-link|stable local|linked/);
        expect(readFileSync(outsideInput), relPath).toEqual(bytes);
      }

      const guideProject = scaffoldProject();
      const guidePath = path.join(guideProject, 'brand', 'guide.md');
      const outsideGuide = path.join(path.dirname(guideProject), 'outside-symbolic-guide.md');
      const outsideGuideBytes = Buffer.from('outside guide sentinel bytes\n', 'utf8');
      writeFileSync(outsideGuide, outsideGuideBytes);
      rmSync(guidePath);
      symlinkSync(outsideGuide, guidePath, 'file');
      expect(() => compileBrand(guideProject, { emit: ['svg'] })).toThrow(/guide\.md.*unlinked|linked|unsafe/);
      expect(readFileSync(outsideGuide)).toEqual(outsideGuideBytes);
    },
  );
});
