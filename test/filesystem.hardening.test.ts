import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  assertUnlinkedDirectoryPath,
  createPrivateExclusiveRegularFile,
  publishStagedFile,
  stableHashRegularFile,
  stableInspectRegularFile,
  stableReadRegularFile,
  stageFileExclusive,
} from '../src/filesystem.ts';

const DESCRIPTOR_READ_CALLS = vi.hoisted(() => ({ wholeFile: 0, chunked: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync(...args: unknown[]) {
      if (typeof args[0] === 'number') DESCRIPTOR_READ_CALLS.wholeFile++;
      return Reflect.apply(actual.readFileSync, actual, args);
    },
    readSync(...args: unknown[]) {
      if (typeof args[0] === 'number') DESCRIPTOR_READ_CALLS.chunked++;
      return Reflect.apply(actual.readSync, actual, args);
    },
  };
});

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-filesystem-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('shared publication filesystem boundary', () => {
  it('creates and verifies private files larger than a cooperative lock record', () => {
    const root = tempDir();
    const target = path.join(root, 'large-private.bin');
    const bytes = Buffer.alloc(8 * 1_024 + 17, 0x5a);

    createPrivateExclusiveRegularFile(target, bytes, 'large private fixture');

    expect(readFileSync(target)).toEqual(bytes);
  });

  it('rejects a static linked ancestor even when the requested leaf is a normal directory', () => {
    const root = tempDir();
    const outside = path.join(root, 'outside');
    const leaf = path.join(outside, 'project');
    mkdirSync(leaf, { recursive: true });
    const linkedParent = path.join(root, 'linked-parent');
    symlinkSync(outside, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');

    expect(() => assertUnlinkedDirectoryPath(path.join(linkedParent, 'project')))
      .toThrowError(/local non-linked directory/);
  });

  it.runIf(process.platform !== 'win32')(
    'stages ordinary generated files as 0666 before the process umask',
    () => {
      const root = tempDir();
      const target = path.join(root, 'generated.txt');
      const staged = stageFileExclusive(target, 'generated\n');
      publishStagedFile(staged, target);

      const expectedMode = 0o666 & ~process.umask();
      expect(statSync(target).mode & 0o777).toBe(expectedMode);
    },
  );

  it('bounds content while metadata inspection and multi-chunk streaming digest remain usable', () => {
    const root = tempDir();
    const target = path.join(root, 'large-output.bin');
    const bytes = Buffer.alloc(256 * 1_024, 0x5a);
    writeFileSync(target, bytes);

    expect(stableReadRegularFile(target, { maxBytes: bytes.byteLength - 1 })).toBeUndefined();
    DESCRIPTOR_READ_CALLS.wholeFile = 0;
    DESCRIPTOR_READ_CALLS.chunked = 0;
    expect(stableReadRegularFile(target, { maxBytes: bytes.byteLength })?.bytes).toEqual(bytes);
    expect(DESCRIPTOR_READ_CALLS.wholeFile).toBe(0);
    expect(DESCRIPTOR_READ_CALLS.chunked).toBeGreaterThan(1);

    DESCRIPTOR_READ_CALLS.wholeFile = 0;
    DESCRIPTOR_READ_CALLS.chunked = 0;
    const metadata = stableInspectRegularFile(target, { maxBytes: bytes.byteLength });
    expect(metadata?.identity.size).toBe(BigInt(bytes.byteLength));
    expect(metadata).not.toHaveProperty('bytes');
    expect(metadata).not.toHaveProperty('sha256');
    expect(DESCRIPTOR_READ_CALLS).toEqual({ wholeFile: 0, chunked: 0 });

    DESCRIPTOR_READ_CALLS.wholeFile = 0;
    DESCRIPTOR_READ_CALLS.chunked = 0;
    const digest = stableHashRegularFile(target);
    expect(digest?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(digest).not.toHaveProperty('bytes');
    expect(DESCRIPTOR_READ_CALLS.wholeFile).toBe(0);
    expect(DESCRIPTOR_READ_CALLS.chunked).toBeGreaterThan(1);

    DESCRIPTOR_READ_CALLS.wholeFile = 0;
    DESCRIPTOR_READ_CALLS.chunked = 0;
    expect(stableHashRegularFile(target, { maxBytes: bytes.byteLength - 1 })).toBeUndefined();
    expect(DESCRIPTOR_READ_CALLS).toEqual({ wholeFile: 0, chunked: 0 });
  });
});
