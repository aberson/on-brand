import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
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
  truncateSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileBrand, computeBrandSourceHash } from '../src/build/compile.ts';
import { COOPERATIVE_LOCK_MAX_BYTES } from '../src/cooperative-lock.ts';
import { identityOf, sameFileNode } from '../src/filesystem.ts';
import { generatePreview } from '../src/preview/specimen.ts';
import {
  FROZEN_ASSIGNMENT_TARGETS,
  INSPIRATION_LIMITS,
  INSPIRATION_SCHEMA,
  INSPIRATION_SCHEMA_VERSION,
  inspirationIdForAssetSha256,
  type InspirationTrace,
} from '../src/inspiration/contract.ts';
import {
  DEFAULT_INSPIRATION_ARTIFACT_FILENAME,
  INSPIRATION_ARTIFACT_SCHEMA,
  INSPIRATION_ARTIFACT_SCHEMA_VERSION,
  INSPIRATION_EXPORT_LIMITS,
  InspirationCatalogError,
  buildInspirationArtifact,
  exportInspirationArtifact,
  inspirationArtifactItemId,
  recoverStaleInspirationExportLock,
} from '../src/inspiration/export.ts';
import {
  renderPosixInspirationExportRetry,
  renderPowerShellInspirationExportRetry,
} from '../src/inspiration/retry-command.ts';
import { recordSpecimenView } from '../src/inspiration/views.ts';
import { SPECIMEN_VIEW_MAX_BYTES } from '../src/preview/contract.ts';
import {
  controllerLeaseBytes,
  prepareControllerLeasePath,
  controllerLeasePaths,
  controllerScopeBinding,
  controllerScopePath,
  controllerScopePaths,
} from './helpers/retirement-controller-fixture.ts';
import { rawInspirationRetryCommand } from './helpers/inspiration-retry.ts';

const FILE_IO_CALLS = vi.hoisted(() => ({
  reads: [] as Array<{ target: string; maxBytes: number | undefined }>,
  inspections: [] as Array<{ target: string; maxBytes: number | undefined }>,
  hashes: [] as Array<{ target: string; maxBytes: number | undefined }>,
  unsafeTargetInspections: new Set<string>(),
}));

vi.mock('../src/filesystem.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/filesystem.ts')>();
  type Options = { maxBytes?: number; requireSingleLink?: boolean };
  return {
    ...actual,
    stableReadRegularFile(target: string, options: Options = {}) {
      FILE_IO_CALLS.reads.push({ target, maxBytes: options.maxBytes });
      return actual.stableReadRegularFile(target, options);
    },
    stableInspectRegularFile(target: string, options: Options = {}) {
      FILE_IO_CALLS.inspections.push({ target, maxBytes: options.maxBytes });
      return actual.stableInspectRegularFile(target, options);
    },
    stableHashRegularFile(target: string, options: Options = {}) {
      FILE_IO_CALLS.hashes.push({ target, maxBytes: options.maxBytes });
      return actual.stableHashRegularFile(target, options);
    },
    inspectSafeRegularFileTarget(target: string, options: Options = {}) {
      return FILE_IO_CALLS.unsafeTargetInspections.has(target)
        ? { state: 'unsafe' as const }
        : actual.inspectSafeRegularFileTarget(target, options);
    },
  };
});

const PRESET_DIR = path.resolve('templates/presets/default');
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO_ROOT, 'bin', 'onbrand.mjs');
const WORKER = fileURLToPath(new URL('./helpers/inspiration-export-worker.ts', import.meta.url));
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9W9QF0oAAAAASUVORK5CYII=',
  'base64',
);
const PNG_SHA256 = createHash('sha256').update(PNG).digest('hex');
const roots: string[] = [];
const workers: WorkerHandle[] = [];

interface WorkerHandle {
  child: ChildProcessWithoutNullStreams;
  exited: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

afterEach(async () => {
  FILE_IO_CALLS.unsafeTargetInspections.clear();
  for (const worker of workers.splice(0)) {
    if (!worker.exited) {
      worker.child.kill();
      await waitForExit(worker).catch(() => undefined);
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function startLockHolder(root: string, out: string, ready: string, release: string): WorkerHandle {
  return startWorker('hold', root, out, ready, release);
}

function startRecoveryWorker(
  mode:
    | 'recover'
    | 'recover-before-controller'
    | 'recover-after-stage'
    | 'recover-after-lease'
    | 'recover-before-final-authorization'
    | 'recover-after-unlink'
    | 'recover-after-lease-and-unlink'
    | 'recover-alias-election',
  root: string,
  out: string,
  ready: string,
  release: string,
): WorkerHandle {
  return startWorker(mode, root, out, ready, release);
}

type WorkerMode =
  | 'hold'
  | 'recover'
  | 'recover-before-controller'
  | 'recover-after-stage'
  | 'recover-after-lease'
  | 'recover-before-final-authorization'
  | 'recover-after-unlink'
  | 'recover-after-lease-and-unlink'
  | 'recover-alias-election';

function startWorker(mode: WorkerMode, root: string, out: string, ready: string, release: string): WorkerHandle {
  const child = spawn(process.execPath, ['--import', 'tsx', WORKER, mode, root, out, ready, release], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const worker: WorkerHandle = { child, exited: false, code: null, stdout: '', stderr: '' };
  workers.push(worker);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { worker.stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { worker.stderr += chunk; });
  child.on('exit', (code) => { worker.exited = true; worker.code = code; });
  return worker;
}

async function waitFor(predicate: () => boolean, failure: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(failure());
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitForReady(worker: WorkerHandle, ready: string): Promise<void> {
  await waitFor(
    () => existsSync(ready) || worker.exited,
    () => `catalog lock worker did not reach barrier\nstdout: ${worker.stdout}\nstderr: ${worker.stderr}`,
  );
  if (!existsSync(ready)) throw new Error(`catalog lock worker exited (${worker.code})\n${worker.stderr}`);
}

async function waitForExit(worker: WorkerHandle): Promise<void> {
  await waitFor(() => worker.exited, () => `catalog lock worker did not exit\n${worker.stderr}`);
}

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'onbrand-inspiration-export-'));
  roots.push(root);
  return root;
}

function replaceWithDistinctFileNode(target: string, content: string | Uint8Array): void {
  const originalIdentity = identityOf(statSync(target, { bigint: true }));
  const sibling = `${target}.replacement-${randomUUID()}`;
  let staged = false;
  try {
    writeFileSync(sibling, content, { flag: 'wx' });
    staged = true;
    const replacementIdentity = identityOf(statSync(sibling, { bigint: true }));
    expect(sameFileNode(originalIdentity, replacementIdentity)).toBe(false);
    rmSync(target);
    renameSync(sibling, target);
    staged = false;
  } finally {
    if (staged) rmSync(sibling, { force: true });
  }
}

function resetFileIoCalls(): void {
  FILE_IO_CALLS.reads.length = 0;
  FILE_IO_CALLS.inspections.length = 0;
  FILE_IO_CALLS.hashes.length = 0;
  FILE_IO_CALLS.unsafeTargetInspections.clear();
}

function detectDirectoryLinkCapability(): boolean {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'onbrand-catalog-link-capability-'));
  const target = path.join(probe, 'target');
  const link = path.join(probe, 'link');
  try {
    mkdirSync(target);
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const DIRECTORY_LINKS_AVAILABLE = detectDirectoryLinkCapability();

function snapshotBrandTree(project: string): Map<string, Buffer> {
  const brand = path.join(project, 'brand');
  const snapshot = new Map<string, Buffer>();
  const walk = (directory: string, relative: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const next = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target, next);
      else snapshot.set(next, readFileSync(target));
    }
  };
  walk(brand, '');
  return snapshot;
}

function recursiveStringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(recursiveStringValues);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(recursiveStringValues);
  }
  return [];
}

function looksLikeEmbeddedImage(value: string): boolean {
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value.trim())) return true;
  const compact = value.trim();
  if (compact.length < 80 || compact.length % 4 !== 0 || !/^[a-z0-9+/]+={0,2}$/i.test(compact)) {
    return false;
  }
  const decoded = Buffer.from(compact, 'base64');
  return decoded.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    (decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff) ||
    decoded.subarray(0, 6).toString('ascii') === 'GIF87a' ||
    decoded.subarray(0, 6).toString('ascii') === 'GIF89a' ||
    (decoded.subarray(0, 4).toString('ascii') === 'RIFF' && decoded.subarray(8, 12).toString('ascii') === 'WEBP') ||
    decoded.subarray(0, 2).toString('ascii') === 'BM' ||
    /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(decoded.toString('utf8'));
}

function makeTrace(overrides: Partial<InspirationTrace> = {}): InspirationTrace {
  const source: InspirationTrace = {
    schema: INSPIRATION_SCHEMA,
    schemaVersion: INSPIRATION_SCHEMA_VERSION,
    id: inspirationIdForAssetSha256(PNG_SHA256),
    reviewStatus: 'generated-draft',
    summary: 'A compact measured blue palette.',
    asset: {
      path: 'assets/inspiration.png',
      sha256: PNG_SHA256,
      mediaType: 'image/png',
      alt: 'One blue pixel.',
      creator: 'unknown',
      title: 'Synthetic blue',
      date: 'unknown',
      sourceUrl: null,
      rights: 'unknown',
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
    mappings: [
      {
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
      },
    ],
  };
  return { ...source, ...overrides };
}

function scaffold(root: string, trace = makeTrace()): void {
  const brand = path.join(root, 'brand');
  mkdirSync(path.join(brand, 'assets'), { recursive: true });
  copyFileSync(path.join(PRESET_DIR, 'tokens.json'), path.join(brand, 'tokens.json'));
  copyFileSync(path.join(PRESET_DIR, 'modes.dark.json'), path.join(brand, 'modes.dark.json'));
  writeFileSync(path.join(brand, 'assets', 'inspiration.png'), PNG);
  writeFileSync(path.join(brand, 'inspiration.json'), `${JSON.stringify(trace, null, 2)}\n`);
}

describe('inspiration catalog export', () => {
  it('exports deterministic available, stale, and invalid trace states without leaking paths or image bytes', () => {
    const root = workspace();
    const available = path.join(root, 'app');
    const stale = path.join(root, 'onbrand-proposal-stale-20260812');
    const invalid = path.join(root, 'invalid');
    scaffold(available);
    scaffold(stale);
    const bad = makeTrace();
    bad.asset.sha256 = '0'.repeat(64);
    bad.id = inspirationIdForAssetSha256(bad.asset.sha256);
    scaffold(invalid, bad);

    compileBrand(available);
    const preview = generatePreview(available);
    recordSpecimenView(
      available,
      preview.generation,
      computeBrandSourceHash(available).sourceHash,
      { required: true },
    );

    const now = () => new Date('2026-08-12T20:00:00.000Z');
    const artifact = buildInspirationArtifact({ root, now });

    expect(artifact.schema).toBe(INSPIRATION_ARTIFACT_SCHEMA);
    expect(artifact.schemaVersion).toBe(INSPIRATION_ARTIFACT_SCHEMA_VERSION);
    expect(artifact.generatedAt).toBe('2026-08-12T20:00:00.000Z');
    expect(artifact.summary).toMatchObject({
      discoveredTraceCount: 3,
      emittedItemCount: 3,
      itemsTruncated: false,
      finalCount: 1,
      proposalCount: 1,
      brandStatusCounts: { adopted: 1, proposal: 0, incomplete: 1, stale: 1, invalid: 0 },
      traceStateCounts: { available: 1, stale: 1, invalid: 1, unavailable: 0 },
    });
    expect(artifact.items.map((item) => item.relPath)).toEqual([
      'app',
      'invalid',
      'onbrand-proposal-stale-20260812',
    ]);

    const app = artifact.items.find((item) => item.relPath === 'app')!;
    expect(app).toMatchObject({
      traceState: 'available',
      standalonePath: 'app/brand/dist/inspiration-to-implementation.html',
      specimenPath: 'app/brand/dist/specimen.html',
      inspiration: { assetPath: 'app/brand/assets/inspiration.png' },
    });
    if (app.traceState === 'available') {
      expect(app.id).toBe(inspirationArtifactItemId('app', app.implementation.sourceId));
      expect(app.implementation.mappings[0]?.targets[0]).toMatchObject({
        tokenPath: 'color.chart.categorical.1',
        lightHex: '#3b63a8',
      });
    }
    expect(artifact.items.find((item) => item.relPath === 'onbrand-proposal-stale-20260812')).toMatchObject({
      traceState: 'stale',
      brandProvenance: 'proposal',
      final: false,
    });
    expect(artifact.items.find((item) => item.relPath === 'invalid')).toMatchObject({
      traceState: 'invalid',
      traceReviewStatus: null,
    });
    const encoded = JSON.stringify(artifact);
    expect(encoded).not.toContain(root);
    expect(encoded).not.toContain(PNG.toString('base64'));
    expect(encoded).not.toMatch(/[a-z]:[\\/]/i);
  });

  it('withholds the optional specimen claim when live bytes no longer match recorded provenance', () => {
    const root = workspace();
    const project = path.join(root, 'app');
    scaffold(project);
    compileBrand(project);
    const preview = generatePreview(project);
    recordSpecimenView(
      project,
      preview.generation,
      computeBrandSourceHash(project).sourceHash,
      { required: true },
    );

    writeFileSync(preview.specimenPath, '<!doctype html><title>interposed bytes</title>\n');
    const artifact = buildInspirationArtifact({
      root,
      now: () => new Date('2026-08-12T20:00:00.000Z'),
    });
    const item = artifact.items[0]!;
    expect(item).toMatchObject({
      relPath: 'app',
      traceState: 'available',
      standalonePath: 'app/brand/dist/inspiration-to-implementation.html',
    });
    expect(item).not.toHaveProperty('specimenPath');
  });

  it('bounds the catalog manifest read before parsing content', () => {
    const root = workspace();
    const project = path.join(root, 'app');
    scaffold(project);
    const built = compileBrand(project);
    const preview = generatePreview(project);
    expect(recordSpecimenView(
      project,
      preview.generation,
      built.manifest.sourceHash,
      { required: true },
    )).toBe(true);
    const dist = path.join(project, 'brand', 'dist');
    const manifestPath = path.join(dist, 'manifest.json');
    const specimenPath = path.join(dist, 'specimen.html');

    truncateSync(manifestPath, INSPIRATION_EXPORT_LIMITS.maxBytes + 1);
    resetFileIoCalls();
    const item = buildInspirationArtifact({ root }).items[0]!;
    expect(item).toMatchObject({
      traceState: 'stale',
      reason: 'Trace is valid, but its generated-view manifest is absent or unusable.',
    });
    expect(FILE_IO_CALLS.reads).toContainEqual({
      target: manifestPath,
      maxBytes: INSPIRATION_EXPORT_LIMITS.maxBytes,
    });
    expect(FILE_IO_CALLS.hashes.filter((call) => call.target === specimenPath)).toEqual([]);
  });

  it('uses explanation metadata and returns before optional specimen hashing when it is over limit', () => {
    const root = workspace();
    const project = path.join(root, 'app');
    scaffold(project);
    const built = compileBrand(project);
    const preview = generatePreview(project);
    expect(recordSpecimenView(
      project,
      preview.generation,
      built.manifest.sourceHash,
      { required: true },
    )).toBe(true);
    const dist = path.join(project, 'brand', 'dist');
    const explanationPath = path.join(dist, 'inspiration-to-implementation.html');

    truncateSync(explanationPath, INSPIRATION_LIMITS.maxStandaloneHtmlBytes + 1);
    resetFileIoCalls();
    const item = buildInspirationArtifact({ root }).items[0]!;
    expect(item).toMatchObject({
      traceState: 'stale',
      reason: 'Trace, asset, and resolved token mappings are valid, but the generated explanation is absent, untracked, or stale.',
    });
    expect(item).not.toHaveProperty('specimenPath');
    expect(FILE_IO_CALLS.inspections).toContainEqual({
      target: explanationPath,
      maxBytes: INSPIRATION_LIMITS.maxStandaloneHtmlBytes,
    });
    expect(FILE_IO_CALLS.reads.some((call) => call.target === explanationPath)).toBe(false);
    expect(FILE_IO_CALLS.hashes.some((call) => call.target === preview.specimenPath)).toBe(false);
  });

  it('keeps the explanation current but withholds an over-limit optional specimen', () => {
    const root = workspace();
    const project = path.join(root, 'app');
    scaffold(project);
    const built = compileBrand(project);
    const preview = generatePreview(project);
    expect(recordSpecimenView(
      project,
      preview.generation,
      built.manifest.sourceHash,
      { required: true },
    )).toBe(true);

    truncateSync(preview.specimenPath, SPECIMEN_VIEW_MAX_BYTES + 1);
    resetFileIoCalls();
    const item = buildInspirationArtifact({ root }).items[0]!;
    expect(item).toMatchObject({
      traceState: 'available',
      standalonePath: 'app/brand/dist/inspiration-to-implementation.html',
    });
    expect(item).not.toHaveProperty('specimenPath');
    expect(FILE_IO_CALLS.hashes).toContainEqual({
      target: preview.specimenPath,
      maxBytes: SPECIMEN_VIEW_MAX_BYTES,
    });
    expect(FILE_IO_CALLS.reads.some((call) => call.target === preview.specimenPath)).toBe(false);
  });

  it('uses an exclusive lock, publishes atomically, and only recovers a dead stale holder', () => {
    const root = workspace();
    const project = path.join(root, 'app');
    scaffold(project);
    compileBrand(project);
    const out = path.join('.observatory', 'catalog.json');
    const outPath = path.join(root, ...out.split('/'));
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, 'prior complete catalog\n');

    const lockPath = `${outPath}.lock`;
    writeFileSync(lockPath, `${JSON.stringify({
      runToken: randomUUID(),
      pid: process.pid,
      startedAt: '2026-08-12T19:59:00.000Z',
    })}\n`);
    expect(() => exportInspirationArtifact({ root, out, now: () => new Date('2026-08-12T20:00:00.000Z') })).toThrow(
      /already being refreshed/,
    );
    expect(readFileSync(outPath, 'utf8')).toBe('prior complete catalog\n');

    for (const invalidCase of [
      { bytes: Buffer.from('not a cooperative lock\n'), unsafe: false },
      { bytes: Buffer.alloc(COOPERATIVE_LOCK_MAX_BYTES + 1, 0x61), unsafe: false },
      { bytes: Buffer.from('unreadable or linked lock sentinel\n'), unsafe: true },
    ]) {
      writeFileSync(lockPath, invalidCase.bytes);
      if (invalidCase.unsafe) FILE_IO_CALLS.unsafeTargetInspections.add(lockPath);
      let invalidFailure: unknown;
      try {
        exportInspirationArtifact({ root, out, now: () => new Date('2026-08-12T20:00:00.000Z') });
      } catch (cause) {
        invalidFailure = cause;
      } finally {
        FILE_IO_CALLS.unsafeTargetInspections.delete(lockPath);
      }
      expect(invalidFailure).toBeInstanceOf(InspirationCatalogError);
      const invalidCatalog = invalidFailure as InspirationCatalogError;
      expect(invalidCatalog.recoveryBlock).toMatchObject({ kind: 'manual' });
      expect(invalidCatalog.recoveryBlock.kind === 'manual'
        ? invalidCatalog.recoveryBlock.instruction
        : '').toContain(`manual inspection required for ${lockPath}`);
      expect(invalidCatalog.message).not.toContain('retry with:');
      expect(readFileSync(lockPath)).toEqual(invalidCase.bytes);
      expect(readFileSync(outPath, 'utf8')).toBe('prior complete catalog\n');
    }
    rmSync(lockPath, { force: true });

    const result = exportInspirationArtifact({ root, out, now: () => new Date('2026-08-12T20:00:00.000Z') });
    expect(result.outPath).toBe(path.resolve(outPath));
    expect(existsSync(outPath)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(JSON.parse(readFileSync(outPath, 'utf8'))).toMatchObject({
      schema: INSPIRATION_ARTIFACT_SCHEMA,
      generatedAt: '2026-08-12T20:00:00.000Z',
    });

    writeFileSync(lockPath, `${JSON.stringify({
      runToken: randomUUID(),
      pid: 999_999_999,
      startedAt: '2026-08-12T19:00:00.000Z',
    })}\n`);
    const recovered = recoverStaleInspirationExportLock({
      root,
      out,
      now: () => new Date('2026-08-12T20:00:00.000Z'),
    });
    expect(recovered.recovered).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it.skipIf(!DIRECTORY_LINKS_AVAILABLE)(
    'rejects a linked explicit catalog root before creating missing parents outside it',
    () => {
      const container = workspace();
      const outside = path.join(container, 'outside-target');
      const linkedRoot = path.join(container, 'linked-root');
      const realRoot = path.join(container, 'real-root');
      mkdirSync(outside);
      mkdirSync(realRoot);
      const sentinelPath = path.join(outside, 'sentinel.txt');
      const sentinelBytes = Buffer.from('outside sentinel\n');
      writeFileSync(sentinelPath, sentinelBytes);
      const sentinelIdentity = statSync(sentinelPath, { bigint: true });
      symlinkSync(outside, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');

      expect(() => exportInspirationArtifact({
        root: linkedRoot,
        out: 'missing/nested/catalog.json',
      })).toThrow(/workspace root.*non-linked directory/);
      const linkedAncestor = path.join(realRoot, 'linked-parent');
      symlinkSync(outside, linkedAncestor, process.platform === 'win32' ? 'junction' : 'dir');
      expect(() => exportInspirationArtifact({
        root: realRoot,
        out: 'linked-parent/missing/nested/catalog.json',
      })).toThrow(/traverse linked or non-directory ancestors/);

      expect(existsSync(path.join(outside, 'missing'))).toBe(false);
      expect(readFileSync(sentinelPath)).toEqual(sentinelBytes);
      const retained = statSync(sentinelPath, { bigint: true });
      expect({ dev: retained.dev, ino: retained.ino })
        .toEqual({ dev: sentinelIdentity.dev, ino: sentinelIdentity.ino });
    },
  );

  it('applies the 51-to-50 bound after deterministic discovery with summary counts over every trace', () => {
    const root = workspace();
    const controlRoot = workspace();
    for (let index = 0; index < 51; index++) {
      const name = `project-${String(index).padStart(3, '0')}`;
      scaffold(path.join(root, name));
      if (index < 50) scaffold(path.join(controlRoot, name));
    }
    const now = () => new Date('2026-08-12T20:00:00.000Z');
    const bounded = buildInspirationArtifact({ root, now });
    const independentControl = buildInspirationArtifact({ root: controlRoot, now });
    expect(bounded.summary).toEqual({
      discoveredTraceCount: 51,
      emittedItemCount: 50,
      itemsTruncated: true,
      finalCount: 0,
      proposalCount: 0,
      brandStatusCounts: { adopted: 0, proposal: 0, incomplete: 0, stale: 51, invalid: 0 },
      traceStateCounts: { available: 0, stale: 51, invalid: 0, unavailable: 0 },
    });
    expect(bounded.items.map((item) => item.relPath)).toEqual(
      Array.from({ length: 50 }, (_, index) => `project-${String(index).padStart(3, '0')}`),
    );
    expect(independentControl.summary).toMatchObject({
      discoveredTraceCount: 50,
      emittedItemCount: 50,
      itemsTruncated: false,
    });
    expect(Buffer.from(JSON.stringify(bounded.items), 'utf8'))
      .toEqual(Buffer.from(JSON.stringify(independentControl.items), 'utf8'));
  }, 30_000);

  it('exports without changing any discovered source or generated brand bytes', () => {
    const root = workspace();
    const adopted = path.join(root, 'app');
    const proposal = path.join(root, 'onbrand-proposal-export-20260812');
    scaffold(adopted);
    scaffold(proposal);
    for (const project of [adopted, proposal]) {
      const built = compileBrand(project);
      const preview = generatePreview(project);
      expect(recordSpecimenView(project, preview.generation, built.manifest.sourceHash, { required: true })).toBe(true);
    }
    const before = new Map([[adopted, snapshotBrandTree(adopted)], [proposal, snapshotBrandTree(proposal)]]);
    exportInspirationArtifact({
      root,
      out: '.observatory/catalog.json',
      now: () => new Date('2026-08-12T20:00:00.000Z'),
    });
    for (const [project, snapshot] of before) expect(snapshotBrandTree(project)).toEqual(snapshot);
  }, 30_000);

  it('blocks a second production CLI behind a real child lock without changing the prior catalog', async () => {
    const root = workspace();
    scaffold(path.join(root, 'app'));
    const out = path.join('.observatory', 'catalog.json');
    const outPath = path.join(root, ...out.split('/'));
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, 'prior complete catalog\n');
    const ready = path.join(root, 'catalog.ready');
    const release = path.join(root, 'catalog.release');
    const worker = startLockHolder(root, out, ready, release);
    await waitForReady(worker, ready);
    const blocked = spawnSync(process.execPath, [BIN, 'inspiration-export', '--root', root, '--out', out], {
      encoding: 'utf8', timeout: 30_000,
    });
    expect(blocked.status).toBe(1);
    expect(readFileSync(outPath, 'utf8')).toBe('prior complete catalog\n');
    expect(blocked.stderr).toMatch(/PID \d+, started \d{4}-\d{2}-\d{2}T/);
    const expectedRetry = process.platform === 'win32'
      ? renderPowerShellInspirationExportRetry(process.execPath, path.resolve(BIN), path.resolve(root), path.resolve(outPath))
      : renderPosixInspirationExportRetry(process.execPath, path.resolve(BIN), path.resolve(root), path.resolve(outPath));
    expect(rawInspirationRetryCommand(String(blocked.stderr))).toBe(expectedRetry);
    writeFileSync(release, 'release\n', { flag: 'wx' });
    await waitForExit(worker);
    expect(worker.code, worker.stderr).toBe(0);
  }, 30_000);

  it('refuses young, live, and malformed residue; then recovers only a verified dead old owner', () => {
    const root = workspace();
    scaffold(path.join(root, 'app'));
    const out = '.observatory/catalog.json';
    const lock = path.join(root, '.observatory', 'catalog.json.lock');
    mkdirSync(path.dirname(lock), { recursive: true });
    const now = () => new Date('2026-08-12T20:00:00.000Z');
    const record = (pid: number, startedAt: string) => `${JSON.stringify({ runToken: randomUUID(), pid, startedAt })}\n`;
    writeFileSync(lock, record(999_999_999, '2026-08-12T19:50:00.000Z'));
    expect(recoverStaleInspirationExportLock({ root, out, now })).toMatchObject({ recovered: false, reason: 'lock is not older than fifteen minutes' });
    expect(existsSync(lock)).toBe(true);
    const liveBytes = record(process.pid, '2026-08-12T19:00:00.000Z');
    writeFileSync(lock, liveBytes);
    expect(recoverStaleInspirationExportLock({ root, out, now })).toMatchObject({ recovered: false, reason: 'recorded local lock PID is still alive' });
    expect(readFileSync(lock, 'utf8')).toBe(liveBytes);
    const malformedBytes = 'not a lock\n';
    writeFileSync(lock, malformedBytes);
    expect(recoverStaleInspirationExportLock({ root, out, now })).toMatchObject({
      recovered: false,
      reason: 'lock contents are malformed, unreadable, or oversized',
    });
    expect(readFileSync(lock, 'utf8')).toBe(malformedBytes);
    FILE_IO_CALLS.unsafeTargetInspections.add(lock);
    expect(recoverStaleInspirationExportLock({ root, out, now })).toMatchObject({
      recovered: false,
      reason: 'lock path is linked, unreadable, or otherwise unsafe',
    });
    FILE_IO_CALLS.unsafeTargetInspections.delete(lock);
    expect(readFileSync(lock, 'utf8')).toBe(malformedBytes);
    writeFileSync(lock, record(999_999_999, '2026-08-12T19:00:00.000Z'));
    expect(recoverStaleInspirationExportLock({ root, out, now })).toMatchObject({ recovered: true });
    expect(existsSync(lock)).toBe(false);
    expect(recoverStaleInspirationExportLock({ root, out, now })).toMatchObject({
      recovered: false,
      alreadyClear: true,
      reason: 'lock is already absent',
    });
  });

  it('leaves killed-holder residue until its verified dead owner is older than fifteen minutes', async () => {
    const root = workspace();
    scaffold(path.join(root, 'app'));
    const out = '.observatory/catalog.json';
    const ready = path.join(root, 'holder.ready');
    const release = path.join(root, 'never.release');
    const worker = startLockHolder(root, out, ready, release);
    await waitForReady(worker, ready);
    const lockPath = path.join(root, '.observatory', 'catalog.json.lock');
    const held = JSON.parse(readFileSync(lockPath, 'utf8')) as { startedAt: string };
    worker.child.kill();
    await waitForExit(worker);
    expect(existsSync(lockPath)).toBe(true);
    const started = Date.parse(held.startedAt);
    expect(recoverStaleInspirationExportLock({ root, out, now: () => new Date(started + 5 * 60_000) })).toMatchObject({ recovered: false, reason: 'lock is not older than fifteen minutes' });
    expect(recoverStaleInspirationExportLock({ root, out, now: () => new Date(started + 16 * 60_000) })).toMatchObject({ recovered: true });
    expect(existsSync(lockPath)).toBe(false);
  }, 30_000);

  it('preserves the catalog lock when its stale source owner revives before detach', () => {
    const root = workspace();
    scaffold(path.join(root, 'app'));
    const out = '.observatory/catalog.json';
    const lockPath = path.join(root, '.observatory', 'catalog.json.lock');
    mkdirSync(path.dirname(lockPath), { recursive: true });
    const lockBytes = `${JSON.stringify({
      runToken: randomUUID(),
      pid: 999_999_999,
      startedAt: '2026-08-12T19:00:00.000Z',
    })}\n`;
    writeFileSync(lockPath, lockBytes);
    let sourceOwnerRevived = false;

    const recovered = recoverStaleInspirationExportLock({
      root,
      out,
      now: () => new Date('2026-08-12T20:00:00.000Z'),
      processState: () => sourceOwnerRevived ? 'alive' : 'dead',
      retirement: {
        hooks: { beforeFinalControllerAuthorization: () => { sourceOwnerRevived = true; } },
      },
    });

    expect(recovered).toMatchObject({
      recovered: false,
      reason: 'lock changed while recovery was attempted',
    });
    expect(readFileSync(lockPath, 'utf8')).toBe(lockBytes);
    expect(controllerLeasePaths(lockPath)).toEqual([]);
  });

  it('removes successful catalog controller scopes and fails a paused old-scope controller before publication', () => {
    const root = workspace();
    scaffold(path.join(root, 'app'));
    const out = '.observatory/catalog.json';
    const outPath = path.join(root, '.observatory', 'catalog.json');
    const lockPath = `${outPath}.lock`;

    for (let attempt = 0; attempt < 3; attempt++) {
      exportInspirationArtifact({ root, out });
      expect(existsSync(lockPath)).toBe(false);
      expect(controllerScopePaths(lockPath)).toEqual([]);
    }

    const source = {
      runToken: randomUUID(), pid: 999_999_999, startedAt: '2026-08-12T19:00:00.000Z',
    };
    const sourceBytes = `${JSON.stringify(source)}\n`;
    writeFileSync(lockPath, sourceBytes);
    let nested: ReturnType<typeof recoverStaleInspirationExportLock> | undefined;
    const outer = recoverStaleInspirationExportLock({
      root,
      out,
      now: () => new Date('2026-08-12T20:00:00.000Z'),
      processState: () => 'dead',
      retirement: {
        hooks: {
          beforeControllerLeaseCreate: () => {
            nested = recoverStaleInspirationExportLock({
              root,
              out,
              now: () => new Date('2026-08-12T20:00:00.000Z'),
              processState: () => 'dead',
            });
          },
        },
      },
    });
    expect(nested).toMatchObject({ recovered: true });
    expect(outer).toMatchObject({ recovered: false });
    expect(existsSync(lockPath)).toBe(false);
    expect(controllerScopePaths(lockPath)).toEqual([]);
    expect(readdirSync(path.dirname(lockPath)).filter((name) => name.startsWith('.onbrand-retire-pending-')))
      .toEqual([]);
  });

  it('ignores an incomplete pending controller stage and recovers without hard-link support', async () => {
    const root = workspace();
    scaffold(path.join(root, 'app'));
    const out = '.observatory/catalog.json';
    const outPath = path.join(root, '.observatory', 'catalog.json');
    const lockPath = `${outPath}.lock`;
    const record = {
      runToken: randomUUID(), pid: 999_999_999, startedAt: '2026-08-12T19:00:00.000Z',
    };
    const staleBytes = `${JSON.stringify(record)}\n`;
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(outPath, 'prior complete catalog\n');
    writeFileSync(lockPath, staleBytes);
    const ready = path.join(root, 'after-stage.ready');
    const release = path.join(root, 'never.release');
    const worker = startRecoveryWorker('recover-after-stage', root, out, ready, release);
    await waitForReady(worker, ready);
    expect(readFileSync(lockPath, 'utf8')).toBe(staleBytes);
    expect(controllerLeasePaths(lockPath)).toEqual([]);
    expect(readdirSync(path.dirname(lockPath)).filter((name) => name.startsWith('.onbrand-retire-pending-')))
      .toHaveLength(1);

    expect(worker.child.kill()).toBe(true);
    await waitForExit(worker);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(outPath, 'utf8')).toBe('prior complete catalog\n');

    expect(recoverStaleInspirationExportLock({
      root,
      out,
      now: () => new Date('2026-08-12T20:00:00.000Z'),
    })).toMatchObject({ recovered: true });
    expect(existsSync(lockPath)).toBe(false);
    expect(readFileSync(outPath, 'utf8')).toBe('prior complete catalog\n');
    // A killed partial stage is outside the authoritative final-lease
    // namespace and cannot block a later producer transaction.
    expect(() => exportInspirationArtifact({ root, out })).not.toThrow();
  }, 30_000);

  it('recovers a real child killed after final lease publication with two independent single-link inodes', async () => {
    const root = workspace();
    scaffold(path.join(root, 'app'));
    const out = '.observatory/catalog.json';
    const outPath = path.join(root, '.observatory', 'catalog.json');
    const lockPath = `${outPath}.lock`;
    const record = {
      runToken: randomUUID(), pid: 999_999_999, startedAt: '2026-08-12T19:00:00.000Z',
    };
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(outPath, 'prior complete catalog\n');
    writeFileSync(lockPath, `${JSON.stringify(record)}\n`);
    const ready = path.join(root, 'after-lease.ready');
    const worker = startRecoveryWorker('recover-after-lease', root, out, ready, path.join(root, 'never.release'));
    await waitForReady(worker, ready);
    const [leasePath] = controllerLeasePaths(lockPath);
    expect(leasePath).toBeDefined();
    const primaryStat = statSync(lockPath, { bigint: true });
    const leaseStat = statSync(leasePath!, { bigint: true });
    expect(primaryStat.nlink).toBe(1n);
    expect(leaseStat.nlink).toBe(1n);
    expect({ dev: leaseStat.dev, ino: leaseStat.ino }).not.toEqual({ dev: primaryStat.dev, ino: primaryStat.ino });
    if (process.platform !== 'win32') expect(Number(leaseStat.mode & 0o777n)).toBe(0o600);

    expect(worker.child.kill()).toBe(true);
    await waitForExit(worker);
    expect(recoverStaleInspirationExportLock({
      root,
      out,
      now: () => new Date('2026-08-12T20:00:00.000Z'),
    })).toMatchObject({ recovered: true });
    expect(existsSync(lockPath)).toBe(false);
    expect(controllerLeasePaths(lockPath)).toEqual([]);
    expect(readFileSync(outPath, 'utf8')).toBe('prior complete catalog\n');
  }, 30_000);

  it('fails closed on same-source live, unknown, malformed, and extra-linked controllers while ignoring a strict old source', () => {
    const root = workspace();
    scaffold(path.join(root, 'app'));
    const out = '.observatory/catalog.json';
    const lockPath = path.join(root, '.observatory', 'catalog.json.lock');
    mkdirSync(path.dirname(lockPath), { recursive: true });
    const source = {
      runToken: randomUUID(), pid: 999_999_999, startedAt: '2026-08-12T19:00:00.000Z',
    };
    const sourceBytes = `${JSON.stringify(source)}\n`;
    writeFileSync(lockPath, sourceBytes);
    const scopeBinding = controllerScopeBinding(lockPath);
    const liveController = randomUUID();
    const liveLease = prepareControllerLeasePath(lockPath, source.runToken, liveController, scopeBinding);
    writeFileSync(liveLease, controllerLeaseBytes(source.runToken, liveController, process.pid));
    expect(recoverStaleInspirationExportLock({
      root,
      out,
      now: () => new Date('2026-08-12T20:00:00.000Z'),
    })).toMatchObject({ recovered: false, reason: expect.stringMatching(/already in progress|unsafe controller/) });
    expect(readFileSync(lockPath, 'utf8')).toBe(sourceBytes);
    expect(readFileSync(liveLease, 'utf8')).toBe(controllerLeaseBytes(source.runToken, liveController, process.pid));
    rmSync(liveLease);

    const unknownController = randomUUID();
    const unknownLease = prepareControllerLeasePath(lockPath, source.runToken, unknownController, scopeBinding);
    const unknownBytes = controllerLeaseBytes(source.runToken, unknownController, 999_999_998);
    writeFileSync(unknownLease, unknownBytes);
    expect(recoverStaleInspirationExportLock({
      root,
      out,
      now: () => new Date('2026-08-12T20:00:00.000Z'),
      retirement: { processState: () => 'unknown' },
    })).toMatchObject({ recovered: false, reason: expect.stringMatching(/already in progress|unsafe controller/) });
    expect(readFileSync(unknownLease, 'utf8')).toBe(unknownBytes);
    rmSync(unknownLease);

    const malformedController = randomUUID();
    const malformedLease = prepareControllerLeasePath(lockPath, source.runToken, malformedController, scopeBinding);
    writeFileSync(malformedLease, 'malformed controller\n');
    expect(recoverStaleInspirationExportLock({
      root,
      out,
      now: () => new Date('2026-08-12T20:00:00.000Z'),
    })).toMatchObject({ recovered: false, reason: expect.stringMatching(/already in progress|unsafe controller/) });
    expect(readFileSync(malformedLease, 'utf8')).toBe('malformed controller\n');
    rmSync(malformedLease);

    const ambiguousLease = path.join(
      controllerScopePath(lockPath, source.runToken, scopeBinding),
      'not-a-controller.lease',
    );
    writeFileSync(ambiguousLease, 'malformed foreign-looking controller\n');
    expect(recoverStaleInspirationExportLock({
      root,
      out,
      now: () => new Date('2026-08-12T20:00:00.000Z'),
    })).toMatchObject({ recovered: false, reason: expect.stringMatching(/already in progress|unsafe controller/) });
    expect(readFileSync(ambiguousLease, 'utf8')).toBe('malformed foreign-looking controller\n');
    rmSync(ambiguousLease);

    const linkedController = randomUUID();
    const linkedLease = prepareControllerLeasePath(lockPath, source.runToken, linkedController, scopeBinding);
    const linkedExtra = `${linkedLease}.extra`;
    writeFileSync(linkedLease, controllerLeaseBytes(source.runToken, linkedController, 999_999_998));
    linkSync(linkedLease, linkedExtra);
    expect(recoverStaleInspirationExportLock({
      root,
      out,
      now: () => new Date('2026-08-12T20:00:00.000Z'),
      retirement: { processState: () => 'dead' },
    })).toMatchObject({ recovered: false, reason: expect.stringMatching(/already in progress|unsafe controller/) });
    expect(existsSync(linkedLease)).toBe(true);
    expect(existsSync(linkedExtra)).toBe(true);
    rmSync(linkedExtra);
    rmSync(linkedLease);

    const oldSource = randomUUID();
    const oldController = randomUUID();
    const oldLease = prepareControllerLeasePath(lockPath, oldSource, oldController, scopeBinding);
    const oldBytes = controllerLeaseBytes(oldSource, oldController, process.pid);
    writeFileSync(oldLease, oldBytes);
    expect(recoverStaleInspirationExportLock({
      root,
      out,
      now: () => new Date('2026-08-12T20:00:00.000Z'),
    })).toMatchObject({ recovered: true });
    expect(readFileSync(oldLease, 'utf8')).toBe(oldBytes);
    expect(() => exportInspirationArtifact({ root, out })).not.toThrow();
    expect(readFileSync(oldLease, 'utf8')).toBe(oldBytes);

    const mismatchedRecordSource = randomUUID();
    const mismatchedController = randomUUID();
    writeFileSync(lockPath, sourceBytes);
    const mismatchedBinding = controllerScopeBinding(lockPath);
    const mismatchedLease = prepareControllerLeasePath(
      lockPath,
      source.runToken,
      mismatchedController,
      mismatchedBinding,
    );
    writeFileSync(
      mismatchedLease,
      controllerLeaseBytes(mismatchedRecordSource, mismatchedController, process.pid),
    );
    expect(recoverStaleInspirationExportLock({
      root,
      out,
      now: () => new Date('2026-08-12T20:00:00.000Z'),
    })).toMatchObject({ recovered: false, reason: expect.stringMatching(/already in progress|unsafe controller/) });
    expect(readFileSync(lockPath, 'utf8')).toBe(sourceBytes);
    expect(readFileSync(mismatchedLease, 'utf8'))
      .toBe(controllerLeaseBytes(mismatchedRecordSource, mismatchedController, process.pid));
  });

  it('streams ordinary and pending siblings and validated old-token leases without stranding a successor', () => {
    const root = workspace();
    scaffold(path.join(root, 'app'));
    const out = '.observatory/catalog.json';
    const lockPath = path.join(root, '.observatory', 'catalog.json.lock');
    const parent = path.dirname(lockPath);
    mkdirSync(parent, { recursive: true });
    const current = {
      runToken: randomUUID(), pid: 999_999_999, startedAt: '2026-08-12T19:00:00.000Z',
    };
    writeFileSync(lockPath, `${JSON.stringify(current)}\n`);
    const scopeBinding = controllerScopeBinding(lockPath);

    for (let index = 0; index < 4_097; index++) {
      writeFileSync(path.join(parent, `ordinary-sibling-${index}`), 'ordinary\n');
    }
    const pendingPaths = Array.from({ length: 65 }, () => `${lockPath}.retire-pending-${randomUUID()}`);
    for (const pendingPath of pendingPaths) writeFileSync(pendingPath, 'incomplete staging residue\n');
    const oldLeases = Array.from({ length: 65 }, () => {
      const sourceToken = randomUUID();
      const controllerId = randomUUID();
      const leasePath = prepareControllerLeasePath(lockPath, sourceToken, controllerId, scopeBinding);
      writeFileSync(leasePath, controllerLeaseBytes(sourceToken, controllerId, process.pid));
      return { leasePath, bytes: readFileSync(leasePath) };
    });

    expect(recoverStaleInspirationExportLock({
      root,
      out,
      now: () => new Date('2026-08-12T20:00:00.000Z'),
    })).toMatchObject({ recovered: true });
    expect(existsSync(lockPath)).toBe(false);
    for (const pendingPath of pendingPaths) expect(existsSync(pendingPath)).toBe(true);
    for (const lease of oldLeases) expect(readFileSync(lease.leasePath)).toEqual(lease.bytes);

    const successor = exportInspirationArtifact({ root, out });
    expect(existsSync(successor.outPath)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    for (const lease of oldLeases) expect(readFileSync(lease.leasePath)).toEqual(lease.bytes);
  }, 60_000);

  it('fails closed when the current source exceeds its bounded controller set', () => {
    const root = workspace();
    scaffold(path.join(root, 'app'));
    const out = '.observatory/catalog.json';
    const lockPath = path.join(root, '.observatory', 'catalog.json.lock');
    mkdirSync(path.dirname(lockPath), { recursive: true });
    const current = {
      runToken: randomUUID(), pid: 999_999_999, startedAt: '2026-08-12T19:00:00.000Z',
    };
    const currentBytes = `${JSON.stringify(current)}\n`;
    writeFileSync(lockPath, currentBytes);
    const scopeBinding = controllerScopeBinding(lockPath);
    const leases = Array.from({ length: 65 }, () => {
      const controllerId = randomUUID();
      const leasePath = prepareControllerLeasePath(lockPath, current.runToken, controllerId, scopeBinding);
      const bytes = controllerLeaseBytes(current.runToken, controllerId, 999_999_998);
      writeFileSync(leasePath, bytes);
      return { leasePath, bytes };
    });

    expect(recoverStaleInspirationExportLock({
      root,
      out,
      now: () => new Date('2026-08-12T20:00:00.000Z'),
      retirement: { processState: () => 'dead' },
    })).toMatchObject({ recovered: false, reason: expect.stringMatching(/already in progress|unsafe controller/) });
    expect(readFileSync(lockPath, 'utf8')).toBe(currentBytes);
    for (const lease of leases) expect(readFileSync(lease.leasePath, 'utf8')).toBe(lease.bytes);
  });

  it('serializes two active controllers and preserves a successor across delayed post-detach cleanup', async () => {
    const root = workspace();
    scaffold(path.join(root, 'app'));
    const out = '.observatory/catalog.json';
    const lockPath = path.join(root, '.observatory', 'catalog.json.lock');
    mkdirSync(path.dirname(lockPath), { recursive: true });
    const staleBytes = `${JSON.stringify({
      runToken: randomUUID(), pid: 999_999_999, startedAt: '2026-08-12T19:00:00.000Z',
    })}\n`;
    writeFileSync(lockPath, staleBytes);
    const firstReady = path.join(root, 'first-before-final-authorization.ready');
    const firstRelease = path.join(root, 'first-before-final-authorization.release');
    const first = startRecoveryWorker(
      'recover-before-final-authorization',
      root,
      out,
      firstReady,
      firstRelease,
    );
    await waitForReady(first, firstReady);

    const secondReady = path.join(root, 'second.ready');
    const secondRelease = path.join(root, 'second.release');
    const second = startRecoveryWorker('recover-after-lease-and-unlink', root, out, secondReady, secondRelease);
    await waitForReady(second, `${secondReady}.lease`);
    expect(controllerLeasePaths(lockPath)).toHaveLength(2);

    // The first controller was authorized before the second published, but its
    // mandatory final inventory sees the live second controller and yields.
    writeFileSync(firstRelease, 'release\n', { flag: 'wx' });
    await waitForExit(first);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain('"recovered":false');
    expect(existsSync(lockPath)).toBe(true);

    writeFileSync(`${secondRelease}.lease`, 'release\n', { flag: 'wx' });
    await waitForReady(second, `${secondReady}.unlink`);
    expect(existsSync(lockPath)).toBe(false);

    const freshReady = path.join(root, 'fresh.ready');
    const freshRelease = path.join(root, 'fresh.release');
    const fresh = startLockHolder(root, out, freshReady, freshRelease);
    await waitForReady(fresh, freshReady);
    const freshBytes = readFileSync(lockPath, 'utf8');
    const freshStat = statSync(lockPath, { bigint: true });

    writeFileSync(`${secondRelease}.unlink`, 'release\n', { flag: 'wx' });
    await waitForExit(second);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toContain('"recovered":true');
    expect(readFileSync(lockPath, 'utf8')).toBe(freshBytes);
    const afterDelayedCleanup = statSync(lockPath, { bigint: true });
    expect({ dev: afterDelayedCleanup.dev, ino: afterDelayedCleanup.ino })
      .toEqual({ dev: freshStat.dev, ino: freshStat.ino });

    writeFileSync(freshRelease, 'release\n', { flag: 'wx' });
    await waitForExit(fresh);
    expect(fresh.code, fresh.stderr).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  }, 30_000);

  it.runIf(process.platform === 'win32')(
    'converges case-varied aliases on one controller scope and preserves a successor',
    async ({ skip }) => {
      const root = workspace();
      scaffold(path.join(root, 'app'));
      const out = '.observatory/catalog.json';
      const lockPath = path.join(root, '.observatory', 'catalog.json.lock');
      mkdirSync(path.dirname(lockPath), { recursive: true });
      const source = {
        runToken: randomUUID(),
        pid: 999_999_999,
        startedAt: '2026-08-12T19:00:00.000Z',
      };
      const staleBytes = `${JSON.stringify(source)}\n`;
      writeFileSync(lockPath, staleBytes);

      const rootName = path.basename(root);
      const caseIndex = [...rootName].findIndex((character) => /[a-z]/i.test(character));
      if (caseIndex < 0) skip('temporary root has no case-variable component');
      const originalCharacter = rootName[caseIndex]!;
      const variedCharacter = originalCharacter === originalCharacter.toUpperCase()
        ? originalCharacter.toLowerCase()
        : originalCharacter.toUpperCase();
      const aliasRoot = path.join(
        path.dirname(root),
        `${rootName.slice(0, caseIndex)}${variedCharacter}${rootName.slice(caseIndex + 1)}`,
      );
      if (path.resolve(aliasRoot) === path.resolve(root)) {
        skip('path resolver erased the case variation');
      }
      const aliasLockPath = path.join(aliasRoot, '.observatory', 'catalog.json.lock');
      const identities = (() => {
        try {
          return {
            parent: statSync(path.dirname(lockPath), { bigint: true }),
            aliasParent: statSync(path.dirname(aliasLockPath), { bigint: true }),
            source: statSync(lockPath, { bigint: true }),
            aliasSource: statSync(aliasLockPath, { bigint: true }),
          };
        } catch {
          return undefined;
        }
      })();
      if (identities === undefined) {
        return skip('filesystem does not expose a usable case alias');
      }
      if (
        identities.parent.dev === 0n || identities.aliasParent.dev === 0n ||
        identities.parent.ino === 0n || identities.aliasParent.ino === 0n ||
        identities.source.dev === 0n || identities.aliasSource.dev === 0n ||
        identities.source.ino === 0n || identities.aliasSource.ino === 0n
      ) {
        return skip('filesystem does not expose nonzero node identities');
      }
      expect({ dev: identities.aliasParent.dev, ino: identities.aliasParent.ino })
        .toEqual({ dev: identities.parent.dev, ino: identities.parent.ino });
      expect({ dev: identities.aliasSource.dev, ino: identities.aliasSource.ino })
        .toEqual({ dev: identities.source.dev, ino: identities.source.ino });
      const originalScope = controllerScopePath(lockPath, source.runToken, {
        parentIdentity: identities.parent,
        sourceIdentity: identities.source,
      });
      const aliasScope = controllerScopePath(aliasLockPath, source.runToken, {
        parentIdentity: identities.aliasParent,
        sourceIdentity: identities.aliasSource,
      });
      expect(path.basename(aliasScope)).toBe(path.basename(originalScope));

      const localWorkers: WorkerHandle[] = [];
      try {
        const aReady = path.join(root, 'alias-a.ready');
        const aRelease = path.join(root, 'alias-a.release');
        const bReady = path.join(root, 'alias-b.ready');
        const bRelease = path.join(root, 'alias-b.release');
        const a = startRecoveryWorker('recover-alias-election', root, out, aReady, aRelease);
        const b = startRecoveryWorker('recover-alias-election', aliasRoot, out, bReady, bRelease);
        localWorkers.push(a, b);
        await Promise.all([
          waitForReady(a, `${aReady}.lease`),
          waitForReady(b, `${bReady}.lease`),
        ]);
        expect(controllerScopePaths(lockPath)).toHaveLength(1);
        expect(controllerLeasePaths(lockPath)).toHaveLength(2);

        writeFileSync(`${aRelease}.lease`, 'release\n', { flag: 'wx' });
        await waitForExit(a);
        expect(a.code, a.stderr).toBe(0);
        expect(a.stdout).toContain('"recovered":false');
        expect(existsSync(`${aReady}.detach`)).toBe(false);
        expect(readFileSync(lockPath, 'utf8')).toBe(staleBytes);

        writeFileSync(`${bRelease}.lease`, 'release\n', { flag: 'wx' });
        await waitForReady(b, `${bReady}.detach`);
        expect(existsSync(`${aReady}.detach`)).toBe(false);
        expect(readFileSync(lockPath, 'utf8')).toBe(staleBytes);

        writeFileSync(`${bRelease}.detach`, 'release\n', { flag: 'wx' });
        await waitForReady(b, `${bReady}.unlink`);
        expect(existsSync(lockPath)).toBe(false);

        const successorReady = path.join(root, 'alias-successor.ready');
        const successorRelease = path.join(root, 'alias-successor.release');
        const successor = startLockHolder(root, out, successorReady, successorRelease);
        localWorkers.push(successor);
        await waitForReady(successor, successorReady);
        const successorBytes = readFileSync(lockPath);
        const successorIdentity = statSync(lockPath, { bigint: true });
        expect(successorIdentity.dev).not.toBe(0n);
        expect(successorIdentity.ino).not.toBe(0n);

        writeFileSync(`${bRelease}.unlink`, 'release\n', { flag: 'wx' });
        await waitForExit(b);
        expect(b.code, b.stderr).toBe(0);
        expect(b.stdout).toContain('"recovered":true');
        expect(readFileSync(lockPath)).toEqual(successorBytes);
        const afterCleanup = statSync(lockPath, { bigint: true });
        expect({ dev: afterCleanup.dev, ino: afterCleanup.ino })
          .toEqual({ dev: successorIdentity.dev, ino: successorIdentity.ino });

        writeFileSync(successorRelease, 'release\n', { flag: 'wx' });
        await waitForExit(successor);
        expect(successor.code, successor.stderr).toBe(0);
        expect(existsSync(lockPath)).toBe(false);
      } finally {
        await Promise.all(localWorkers.map(async (worker) => {
          if (worker.exited) return;
          worker.child.kill();
          await waitForExit(worker).catch(() => undefined);
        }));
      }
    },
    45_000,
  );

  it('lets simultaneous published controllers converge or fail closed before a bounded retry', async () => {
    const root = workspace();
    scaffold(path.join(root, 'app'));
    const out = '.observatory/catalog.json';
    const lockPath = path.join(root, '.observatory', 'catalog.json.lock');
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${JSON.stringify({
      runToken: randomUUID(), pid: 999_999_999, startedAt: '2026-08-12T19:00:00.000Z',
    })}\n`);
    const aReady = path.join(root, 'a.ready');
    const bReady = path.join(root, 'b.ready');
    const aRelease = path.join(root, 'a.release');
    const bRelease = path.join(root, 'b.release');
    const a = startRecoveryWorker('recover-after-lease', root, out, aReady, aRelease);
    const b = startRecoveryWorker('recover-after-lease', root, out, bReady, bRelease);
    await Promise.all([waitForReady(a, aReady), waitForReady(b, bReady)]);
    expect(controllerLeasePaths(lockPath)).toHaveLength(2);
    writeFileSync(aRelease, 'release\n', { flag: 'wx' });
    writeFileSync(bRelease, 'release\n', { flag: 'wx' });
    await Promise.all([waitForExit(a), waitForExit(b)]);
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);
    const recoveredCount = [a.stdout, b.stdout].filter((stdout) => stdout.includes('"recovered":true')).length;
    expect(recoveredCount).toBeLessThanOrEqual(1);
    if (existsSync(lockPath)) {
      expect(recoverStaleInspirationExportLock({
        root,
        out,
        now: () => new Date('2026-08-12T20:00:00.000Z'),
      })).toMatchObject({ recovered: true });
    }
    expect(existsSync(lockPath)).toBe(false);
    expect(controllerLeasePaths(lockPath)).toEqual([]);
  }, 30_000);

  it('keeps a post-detach crashed controller harmless to a fresh successor', async () => {
    const root = workspace();
    scaffold(path.join(root, 'app'));
    const out = '.observatory/catalog.json';
    const lockPath = path.join(root, '.observatory', 'catalog.json.lock');
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${JSON.stringify({
      runToken: randomUUID(), pid: 999_999_999, startedAt: '2026-08-12T19:00:00.000Z',
    })}\n`);
    const ready = path.join(root, 'detached.ready');
    const crashed = startRecoveryWorker('recover-after-unlink', root, out, ready, path.join(root, 'never.release'));
    await waitForReady(crashed, ready);
    expect(existsSync(lockPath)).toBe(false);
    const [oldLeasePath] = controllerLeasePaths(lockPath);
    expect(oldLeasePath).toBeDefined();
    const oldLeaseBytes = readFileSync(oldLeasePath!);
    const oldLeaseStat = statSync(oldLeasePath!, { bigint: true });
    expect(crashed.child.kill()).toBe(true);
    await waitForExit(crashed);

    const freshReady = path.join(root, 'fresh-after-crash.ready');
    const freshRelease = path.join(root, 'fresh-after-crash.release');
    const fresh = startLockHolder(root, out, freshReady, freshRelease);
    await waitForReady(fresh, freshReady);
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ runToken: expect.any(String) });
    expect(readFileSync(oldLeasePath!)).toEqual(oldLeaseBytes);
    writeFileSync(freshRelease, 'release\n', { flag: 'wx' });
    await waitForExit(fresh);
    expect(fresh.code, fresh.stderr).toBe(0);
    expect(existsSync(lockPath)).toBe(false);

    // The strict old-token lease remains recoverable evidence, but repeated
    // successor transactions neither block on it nor mutate through it.
    expect(controllerLeasePaths(lockPath)).toHaveLength(1);
    const successor = exportInspirationArtifact({ root, out });
    expect(existsSync(successor.outPath)).toBe(true);
    expect(controllerLeasePaths(lockPath)).toEqual([oldLeasePath]);
    expect(readFileSync(oldLeasePath!)).toEqual(oldLeaseBytes);
    const retained = statSync(oldLeasePath!, { bigint: true });
    expect({ dev: retained.dev, ino: retained.ino })
      .toEqual({ dev: oldLeaseStat.dev, ino: oldLeaseStat.ino });
  }, 30_000);

  it('reports checked catalog release failures without hiding the primary publication error', () => {
    const root = workspace();
    const project = path.join(root, 'app');
    scaffold(project);
    const out = '.observatory/catalog.json';
    const outPath = path.join(root, '.observatory', 'catalog.json');
    const lockPath = `${outPath}.lock`;
    const releaseFailure = (): never => { throw new Error('controlled controller release failure'); };
    const expectedRecoveryCommand = `${process.platform === 'win32'
      ? renderPowerShellInspirationExportRetry(process.execPath, path.resolve(BIN), path.resolve(root), path.resolve(outPath))
      : renderPosixInspirationExportRetry(process.execPath, path.resolve(BIN), path.resolve(root), path.resolve(outPath))} --recover-stale-lock`;
    let releaseError: unknown;
    try {
      exportInspirationArtifact({
        root,
        out,
        retirement: { hooks: { beforeFinalControllerAuthorization: releaseFailure } },
      });
    } catch (cause) {
      releaseError = cause;
    }
    expect(releaseError).toBeInstanceOf(InspirationCatalogError);
    const checkedRelease = releaseError as InspirationCatalogError;
    expect(checkedRelease.summary)
      .toMatch(/owned inspiration artifact lock could not be released.*controlled controller release failure/);
    expect(checkedRelease.recoveryBlock).toEqual({
      kind: 'command',
      label: 'after the lock is older than 15 minutes, recover and retry with:',
      command: expectedRecoveryCommand,
    });
    expect(checkedRelease.message.split(/\r?\n/)).toEqual([
      checkedRelease.summary,
      checkedRelease.recoveryBlock.kind === 'command' ? checkedRelease.recoveryBlock.label : '',
      expectedRecoveryCommand,
    ]);
    expect(checkedRelease.message).not.toContain('\nretry with:\n');
    expect(existsSync(outPath)).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    expect(controllerLeasePaths(lockPath)).toEqual([]);
    const exactRecoveryRetry = rawInspirationRetryCommand(checkedRelease.message);
    expect(exactRecoveryRetry).toBe(expectedRecoveryCommand);
    rmSync(lockPath);
    const alreadyClearRerun = process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', exactRecoveryRetry], {
        encoding: 'utf8', timeout: 30_000, cwd: root,
      })
      : spawnSync('sh', ['-c', exactRecoveryRetry], { encoding: 'utf8', timeout: 30_000, cwd: root });
    expect(alreadyClearRerun.status, alreadyClearRerun.stderr).toBe(0);
    expect(alreadyClearRerun.stdout).toContain('No stale lock remains at');
    expect(existsSync(lockPath)).toBe(false);

    writeFileSync(outPath, 'prior complete catalog\n');
    let combined: unknown;
    try {
      exportInspirationArtifact({
        root,
        out,
        beforeArtifactPublish: () => { throw new Error('controlled publication failure'); },
        retirement: { hooks: { beforeFinalControllerAuthorization: releaseFailure } },
      });
    } catch (cause) {
      combined = cause;
    }
    expect(combined).toBeInstanceOf(InspirationCatalogError);
    const combinedError = combined as InspirationCatalogError;
    expect(combinedError.summary)
      .toBe('failed while refreshing inspiration catalog (controlled publication failure)');
    expect(combinedError.additionalDiagnostics).toEqual([
      expect.stringMatching(/^Additionally, owned inspiration artifact lock could not be released/),
    ]);
    expect(combinedError.recoveryBlock).toEqual({
      kind: 'command',
      label: 'after the lock is older than 15 minutes, recover and retry with:',
      command: expectedRecoveryCommand,
    });
    expect(combinedError.message.split(/\r?\n/)).toEqual([
      combinedError.summary,
      combinedError.additionalDiagnostics[0],
      combinedError.recoveryBlock.kind === 'command' ? combinedError.recoveryBlock.label : '',
      expectedRecoveryCommand,
    ]);
    expect(combinedError.message.match(/--recover-stale-lock/g)).toHaveLength(1);
    expect(combinedError.message).not.toContain('\nretry with:\n');
    expect(readFileSync(outPath, 'utf8')).toBe('prior complete catalog\n');
    expect(existsSync(lockPath)).toBe(true);
    expect(controllerLeasePaths(lockPath)).toEqual([]);
    rmSync(lockPath);

    writeFileSync(outPath, 'prior complete catalog\n');
    const capacityInstruction =
      `catalog capacity requires operator action: reduce ${root} to at most ` +
      `${INSPIRATION_EXPORT_LIMITS.maxItems} discoverable inspiration traces, then rerun inspiration-export.`;
    let capacityAndRelease: unknown;
    try {
      exportInspirationArtifact({
        root,
        out,
        assertArtifact: () => {
          throw new InspirationCatalogError(
            'the completed proposal was omitted from the bounded inspiration catalog',
            { kind: 'manual', instruction: capacityInstruction },
          );
        },
        retirement: { hooks: { beforeFinalControllerAuthorization: releaseFailure } },
      });
    } catch (cause) {
      capacityAndRelease = cause;
    }
    expect(capacityAndRelease).toBeInstanceOf(InspirationCatalogError);
    const capacityReleaseError = capacityAndRelease as InspirationCatalogError;
    expect(capacityReleaseError.additionalDiagnostics).toEqual([
      capacityInstruction,
      expect.stringMatching(/^Additionally, owned inspiration artifact lock could not be released/),
    ]);
    expect(capacityReleaseError.recoveryBlock).toEqual({
      kind: 'command',
      label: 'after the lock is older than 15 minutes, recover and retry with:',
      command: expectedRecoveryCommand,
    });
    expect(capacityReleaseError.message.split(/\r?\n/)).toEqual([
      capacityReleaseError.summary,
      capacityInstruction,
      capacityReleaseError.additionalDiagnostics[1],
      capacityReleaseError.recoveryBlock.kind === 'command'
        ? capacityReleaseError.recoveryBlock.label
        : '',
      expectedRecoveryCommand,
    ]);
    expect(capacityReleaseError.message.match(/--recover-stale-lock/g)).toHaveLength(1);
    expect(readFileSync(outPath, 'utf8')).toBe('prior complete catalog\n');
    expect(existsSync(lockPath)).toBe(true);
    expect(controllerLeasePaths(lockPath)).toEqual([]);
    rmSync(lockPath);

  });

  it('rejects unknown worker modes before touching the filesystem', () => {
    for (const mode of ['recover-unknown', 'typo']) {
      const run = spawnSync(
        process.execPath,
        ['--import', 'tsx', WORKER, mode, 'unused-root', 'unused-out', 'unused-ready', 'unused-release'],
        { encoding: 'utf8', timeout: 30_000 },
      );
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`unknown worker mode ${JSON.stringify(mode)}`);
    }
  });

  it('pins truthful recovery blocks for detached, malformed, oversized, inspection-failed, replacement, and absent locks', () => {
    const root = workspace();
    scaffold(path.join(root, 'app'));
    const out = '.observatory/catalog.json';
    const outPath = path.join(root, '.observatory', 'catalog.json');
    const lockPath = `${outPath}.lock`;

    let postDetachFailure: unknown;
    try {
      exportInspirationArtifact({
        root,
        out,
        retirement: {
          hooks: { afterPrimaryUnlink: () => { throw new Error('controlled post-detach cleanup failure'); } },
        },
      });
    } catch (cause) {
      postDetachFailure = cause;
    }
    expect(postDetachFailure).toBeInstanceOf(InspirationCatalogError);
    const postDetachBlock = (postDetachFailure as InspirationCatalogError).recoveryBlock;
    expect(postDetachBlock).toMatchObject({ kind: 'command', label: 'retry with:' });
    expect(postDetachBlock.kind === 'command' ? postDetachBlock.command : '')
      .not.toContain('--recover-stale-lock');
    expect(existsSync(lockPath)).toBe(false);

    let oversizedFailure: unknown;
    const oversizedBytes = Buffer.alloc(COOPERATIVE_LOCK_MAX_BYTES + 1, 0x61);
    try {
      exportInspirationArtifact({
        root,
        out,
        assertArtifact: () => { writeFileSync(lockPath, oversizedBytes); },
      });
    } catch (cause) {
      oversizedFailure = cause;
    }
    expect(oversizedFailure).toBeInstanceOf(InspirationCatalogError);
    const oversizedBlock = (oversizedFailure as InspirationCatalogError).recoveryBlock;
    expect(oversizedBlock).toMatchObject({ kind: 'manual' });
    expect(oversizedBlock.kind === 'manual' ? oversizedBlock.instruction : '')
      .toContain(`manual inspection required for ${lockPath}`);
    expect(readFileSync(lockPath)).toEqual(oversizedBytes);
    rmSync(lockPath);

    let inspectionFailure: unknown;
    const malformedBytes = Buffer.from('not a cooperative lock\n');
    try {
      exportInspirationArtifact({
        root,
        out,
        assertArtifact: () => {
          writeFileSync(lockPath, malformedBytes);
          FILE_IO_CALLS.unsafeTargetInspections.add(lockPath);
        },
      });
    } catch (cause) {
      inspectionFailure = cause;
    } finally {
      FILE_IO_CALLS.unsafeTargetInspections.delete(lockPath);
    }
    expect(inspectionFailure).toBeInstanceOf(InspirationCatalogError);
    const inspectionBlock = (inspectionFailure as InspirationCatalogError).recoveryBlock;
    expect(inspectionBlock).toMatchObject({ kind: 'manual' });
    expect(inspectionBlock.kind === 'manual' ? inspectionBlock.instruction : '')
      .toContain('manual inspection required');
    expect(readFileSync(lockPath)).toEqual(malformedBytes);
    rmSync(lockPath);

    const replacement = `${JSON.stringify({
      runToken: randomUUID(), pid: process.pid, startedAt: '2026-08-12T20:00:00.000Z',
    })}\n`;
    expect(() => exportInspirationArtifact({
      root,
      out,
      assertArtifact: () => { replaceWithDistinctFileNode(lockPath, replacement); },
    })).not.toThrow();
    expect(readFileSync(lockPath, 'utf8')).toBe(replacement);
    rmSync(lockPath);

    expect(() => exportInspirationArtifact({
      root,
      out,
      assertArtifact: () => { rmSync(lockPath); },
    })).not.toThrow();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('preserves a replacement node and never releases same-inode token or exact-byte mutations', () => {
    const root = workspace();
    scaffold(path.join(root, 'app'));
    const out = '.observatory/catalog.json';
    const outPath = path.join(root, '.observatory', 'catalog.json');
    mkdirSync(path.dirname(outPath), { recursive: true });
    const lockPath = `${outPath}.lock`;
    const replacement = `${JSON.stringify({ runToken: randomUUID(), pid: process.pid, startedAt: '2026-08-12T20:00:00.000Z' })}\n`;
    exportInspirationArtifact({
      root,
      out,
      assertArtifact: () => {
        replaceWithDistinctFileNode(lockPath, replacement);
      },
    });
    expect(readFileSync(lockPath, 'utf8')).toBe(replacement);
    expect(existsSync(outPath)).toBe(true);

    rmSync(lockPath);
    let tokenMutationBytes = '';
    let tokenMutationFailure: unknown;
    try {
      exportInspirationArtifact({
        root,
        out,
        assertArtifact: () => {
          const held = JSON.parse(readFileSync(lockPath, 'utf8')) as {
            runToken: string;
            pid: number;
            startedAt: string;
          };
          tokenMutationBytes = `${JSON.stringify({ ...held, runToken: randomUUID() })}\n`;
          writeFileSync(lockPath, tokenMutationBytes);
        },
      });
    } catch (cause) {
      tokenMutationFailure = cause;
    }
    expect(tokenMutationFailure).toBeInstanceOf(InspirationCatalogError);
    expect((tokenMutationFailure as InspirationCatalogError).recoveryBlock.kind).toBe('manual');
    expect(readFileSync(lockPath, 'utf8')).toBe(tokenMutationBytes);

    rmSync(lockPath);
    let mutatedBytes = '';
    let mutationFailure: unknown;
    try {
      exportInspirationArtifact({
        root,
        out,
        assertArtifact: () => {
          const held = JSON.parse(readFileSync(lockPath, 'utf8')) as {
            runToken: string;
            pid: number;
            startedAt: string;
          };
          mutatedBytes = `${JSON.stringify({
            ...held,
            startedAt: '2026-08-12T20:00:00.000Z',
          })}\n`;
          writeFileSync(lockPath, mutatedBytes);
        },
      });
    } catch (cause) {
      mutationFailure = cause;
    }
    expect(mutationFailure).toBeInstanceOf(InspirationCatalogError);
    const mutationRecovery = (mutationFailure as InspirationCatalogError).recoveryBlock;
    expect(mutationRecovery.kind).toBe('manual');
    expect(mutationRecovery.kind === 'manual' ? mutationRecovery.instruction : '')
      .toContain('manual inspection required');
    expect(readFileSync(lockPath, 'utf8')).toBe(mutatedBytes);
  });

  it('cleans only its owned staging and lock after a controlled post-stage failure', () => {
    const root = workspace();
    scaffold(path.join(root, 'app'));
    const out = '.observatory/catalog.json';
    const outPath = path.join(root, '.observatory', 'catalog.json');
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, 'prior complete catalog\n');
    const foreignStage = path.join(path.dirname(outPath), '.onbrand-tmp-foreign-sentinel');
    const foreignBytes = Buffer.from('foreign staging sentinel\n');
    writeFileSync(foreignStage, foreignBytes);
    const foreignIdentity = statSync(foreignStage, { bigint: true });
    let ownedStagedPath: string | undefined;
    expect(() => exportInspirationArtifact({
      root,
      out,
      beforeArtifactPublish: (stagedPath) => {
        ownedStagedPath = stagedPath;
        throw new Error('controlled post-stage failure');
      },
    })).toThrow(/controlled post-stage failure/);
    expect(ownedStagedPath).toBeDefined();
    expect(existsSync(ownedStagedPath!)).toBe(false);
    expect(readFileSync(outPath, 'utf8')).toBe('prior complete catalog\n');
    expect(existsSync(`${outPath}.lock`)).toBe(false);
    expect(controllerLeasePaths(`${outPath}.lock`)).toEqual([]);
    expect(readFileSync(foreignStage)).toEqual(foreignBytes);
    const retainedIdentity = statSync(foreignStage, { bigint: true });
    expect({ dev: retainedIdentity.dev, ino: retainedIdentity.ino })
      .toEqual({ dev: foreignIdentity.dev, ino: foreignIdentity.ino });
    expect(readdirSync(path.dirname(outPath)).filter((name) => name.includes('.onbrand-tmp-')))
      .toEqual([path.basename(foreignStage)]);
  });

  it('renders exact PowerShell and POSIX retry argv quoting from a table-driven matrix', () => {
    const cases = [
      {
        name: 'ordinary atoms',
        node: '/opt/node', bin: '/repo/bin/onbrand.mjs', root: '/tmp/root', out: 'catalog.json',
        powerShell: "& '/opt/node' '/repo/bin/onbrand.mjs' inspiration-export --root '/tmp/root' --out 'catalog.json'",
        posix: "'/opt/node' '/repo/bin/onbrand.mjs' inspiration-export --root '/tmp/root' --out 'catalog.json'",
      },
      {
        name: 'whitespace apostrophe and required shell metacharacters',
        node: `C:\\node's\\node.exe`, bin: `C:\\repo path\\bin\\onbrand.mjs`, root: `C:\\root &; 'quote'`, out: `out &; 'quote'.json`,
        powerShell: `& 'C:\\node''s\\node.exe' 'C:\\repo path\\bin\\onbrand.mjs' inspiration-export --root 'C:\\root &; ''quote''' --out 'out &; ''quote''.json'`,
        posix: "'C:\\node'\"'\"'s\\node.exe' 'C:\\repo path\\bin\\onbrand.mjs' inspiration-export --root 'C:\\root &; '\"'\"'quote'\"'\"'' --out 'out &; '\"'\"'quote'\"'\"'.json'",
      },
      {
        name: 'POSIX dollar and semicolon',
        node: '/opt/node', bin: '/repo/bin/onbrand.mjs', root: "/tmp/root $; 'quote'", out: "out $; 'quote'.json",
        powerShell: "& '/opt/node' '/repo/bin/onbrand.mjs' inspiration-export --root '/tmp/root $; ''quote''' --out 'out $; ''quote''.json'",
        posix: "'/opt/node' '/repo/bin/onbrand.mjs' inspiration-export --root '/tmp/root $; '\"'\"'quote'\"'\"'' --out 'out $; '\"'\"'quote'\"'\"'.json'",
      },
    ];
    for (const row of cases) {
      expect(renderPowerShellInspirationExportRetry(row.node, row.bin, row.root, row.out), row.name).toBe(row.powerShell);
      expect(renderPosixInspirationExportRetry(row.node, row.bin, row.root, row.out), row.name).toBe(row.posix);
    }
  });

  it('runs the printed current-platform retry from outside the repository with exact special-character argv', () => {
    const parent = workspace();
    const root = path.join(parent, process.platform === 'win32' ? "root &; 'quote'" : "root $; 'quote'");
    const outside = path.join(parent, 'outside-cwd');
    mkdirSync(outside, { recursive: true });
    scaffold(path.join(root, 'app'));
    const out = path.join(root, process.platform === 'win32' ? "catalog &; 'quote'.json" : "catalog $; 'quote'.json");
    mkdirSync(path.dirname(out), { recursive: true });
    const lockPath = `${out}.lock`;
    writeFileSync(lockPath, `${JSON.stringify({ runToken: randomUUID(), pid: process.pid, startedAt: '2026-08-12T20:00:00.000Z' })}\n`);
    const blocked = spawnSync(process.execPath, [BIN, 'inspiration-export', '--root', root, '--out', out], {
      encoding: 'utf8', timeout: 30_000, cwd: outside,
    });
    expect(blocked.status).toBe(1);
    const retry = rawInspirationRetryCommand(String(blocked.stderr));
    const expectedRetry = process.platform === 'win32'
      ? renderPowerShellInspirationExportRetry(process.execPath, path.resolve(BIN), path.resolve(root), path.resolve(out))
      : renderPosixInspirationExportRetry(process.execPath, path.resolve(BIN), path.resolve(root), path.resolve(out));
    expect(retry).toBe(expectedRetry);
    rmSync(lockPath);
    const rerun = process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', retry], { encoding: 'utf8', timeout: 30_000, cwd: outside })
      : spawnSync('sh', ['-c', retry], { encoding: 'utf8', timeout: 30_000, cwd: outside });
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ schema: INSPIRATION_ARTIFACT_SCHEMA });
  }, 30_000);

  it('uses the documented default output below .observatory', () => {
    const root = workspace();
    scaffold(path.join(root, 'app'));
    const result = exportInspirationArtifact({ root, now: () => new Date('2026-08-12T20:00:00.000Z') });
    expect(result.outPath).toBe(path.join(root, ...DEFAULT_INSPIRATION_ARTIFACT_FILENAME.split('/')));
  });

  it('publishes a long legal catalog basename with fixed-length isolated controller and staging names', () => {
    const root = workspace();
    scaffold(path.join(root, 'app'));
    const basename = `${'catalog-'.repeat(29)}x.json`;
    expect(basename.length).toBeLessThanOrEqual(255);
    const out = path.join('.observatory', basename);
    const result = exportInspirationArtifact({ root, out });
    const lockPath = `${result.outPath}.lock`;
    const otherLockPath = `${result.outPath}.other.lock`;
    const tokenA = randomUUID();
    const tokenB = randomUUID();
    const lockBytes = `${JSON.stringify({
      runToken: tokenA,
      pid: 999_999_999,
      startedAt: '2026-08-12T19:00:00.000Z',
    })}\n`;
    writeFileSync(lockPath, lockBytes);
    writeFileSync(otherLockPath, lockBytes);
    const scopeBinding = controllerScopeBinding(lockPath);
    const otherScopeBinding = controllerScopeBinding(otherLockPath);
    const scopeA = controllerScopePath(lockPath, tokenA, scopeBinding);
    const scopeB = controllerScopePath(lockPath, tokenB, scopeBinding);
    expect(path.basename(scopeA).length).toBeLessThanOrEqual(255);
    expect(path.dirname(scopeA)).toBe(path.dirname(lockPath));
    expect(scopeA).not.toBe(scopeB);
    expect(controllerScopePath(otherLockPath, tokenA, otherScopeBinding)).not.toBe(scopeA);
    rmSync(lockPath);
    rmSync(otherLockPath);
    expect(existsSync(result.outPath)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(controllerScopePaths(lockPath)).toEqual([]);
    expect(readdirSync(path.dirname(result.outPath)).filter((name) => name.startsWith('.onbrand-tmp-')))
      .toEqual([]);
  });

  it('carries image-cluster-v2 into the catalog item without touching the committed v1 fixture', () => {
    const root = workspace();
    const project = path.join(root, 'app');
    const v1 = makeTrace();
    scaffold(project, {
      ...v1,
      analysis: { ...v1.analysis, algorithm: 'image-cluster-v2' },
      mappings: v1.mappings.map((mapping) => ({
        ...mapping,
        sample: { ...mapping.sample, method: 'image-cluster-v2' as const },
      })),
    });
    const built = compileBrand(project);
    const preview = generatePreview(project);
    recordSpecimenView(project, preview.generation, built.manifest.sourceHash, { required: true });

    const item = buildInspirationArtifact({ root }).items[0]!;
    expect(item.traceState).toBe('available');
    expect(item).toMatchObject({ inspiration: { analysisAlgorithm: 'image-cluster-v2' } });
    const methods = (item as { implementation: { mappings: Array<{ sampleMethod: string }> } })
      .implementation.mappings.map((mapping) => mapping.sampleMethod);
    expect(methods).toEqual(['image-cluster-v2']);

    const fixture = readFileSync(
      path.join(REPO_ROOT, 'test', 'fixtures', 'inspiration', 'catalog-v1.json'),
      'utf8',
    );
    expect(fixture).toContain('"analysisAlgorithm": "image-cluster-v1"');
    expect(fixture).toContain('"sampleMethod": "image-cluster-v1"');
  });

  it('keeps the committed synthetic catalog-v1 fixture byte-identical to production without path or image leakage', () => {
    const root = workspace();
    scaffold(path.join(root, 'fixture'));
    const fixture = readFileSync(path.join(REPO_ROOT, 'test', 'fixtures', 'inspiration', 'catalog-v1.json'), 'utf8');
    const emitted = exportInspirationArtifact({
      root,
      out: '.observatory/fixture-catalog.json',
      now: () => new Date('2026-08-12T20:00:00.000Z'),
    });
    const production = readFileSync(emitted.outPath, 'utf8');
    expect(fixture).toBe(production);
    for (const serialized of [fixture, production]) {
      for (const value of recursiveStringValues(JSON.parse(serialized) as unknown)) {
        expect(path.posix.isAbsolute(value), value).toBe(false);
        expect(path.win32.isAbsolute(value), value).toBe(false);
        expect(looksLikeEmbeddedImage(value), value).toBe(false);
      }
    }
  });
});
