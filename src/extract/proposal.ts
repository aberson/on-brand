/** Shared local proposal filesystem primitives. */

import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** The v1 per-asset compressed-byte ceiling. */
export const MAX_IMAGE_ASSET_BYTES = 5_000_000;

/** Stage a UTF-8 file beside its destination and atomically replace it. */
export function writeAtomicFile(absPath: string, content: string): void {
  const tmp = `${absPath}.onbrand-tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, absPath);
  } catch (cause) {
    rmSync(tmp, { force: true });
    throw cause;
  }
}

/** Binary counterpart used for the exact source-asset copy. */
export function writeAtomicBytes(absPath: string, bytes: Uint8Array): void {
  const tmp = `${absPath}.onbrand-tmp-${process.pid}`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, absPath);
  } catch (cause) {
    rmSync(tmp, { force: true });
    throw cause;
  }
}

/** Input basename -> deterministic ASCII slug (plan §6 proposal naming). */
export function imageSlug(sourcePath: string): string {
  const base = path.parse(sourcePath).name.normalize('NFKD').toLowerCase();
  let out = '';
  let dashed = false;
  for (const char of base) {
    const code = char.charCodeAt(0);
    const allowed = (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
    if (allowed) {
      out += char;
      dashed = false;
    } else if (!dashed && out.length > 0) {
      out += '-';
      dashed = true;
    }
  }
  out = out.replace(/-+$/g, '').slice(0, 48).replace(/-+$/g, '');
  return out === '' ? 'image' : out;
}

function sameIdentity(
  before: NonNullable<ReturnType<typeof lstatSync>>,
  after: ReturnType<typeof fstatSync>,
): boolean {
  // On Windows dev/ino can be zero/unreliable. The non-link regular-file
  // checks still protect ordinary use; when both sides report identities we
  // require a match so a replace-between-check-and-open race cannot redirect
  // the bytes that are copied and measured.
  const beforeDev = Number(before.dev);
  const beforeIno = Number(before.ino);
  const afterDev = Number(after.dev);
  const afterIno = Number(after.ino);
  if (beforeDev !== 0 && beforeIno !== 0 && afterDev !== 0 && afterIno !== 0) {
    return beforeDev === afterDev && beforeIno === afterIno;
  }
  return after.isFile();
}

export interface LocalImageBytes {
  sourcePath: string;
  bytes: Uint8Array;
}

/**
 * Read one bounded local, non-linked regular file from the exact opened handle.
 * The caller uses this one byte sequence for hashing, decoding, and atomic
 * copying; it deliberately has no URL or network branch.
 */
export function readBoundedLocalImage(source: string, maxBytes = MAX_IMAGE_ASSET_BYTES): LocalImageBytes {
  const sourcePath = path.resolve(source);
  let before: NonNullable<ReturnType<typeof lstatSync>>;
  try {
    before = lstatSync(sourcePath);
  } catch (cause) {
    throw new Error(`image source ${JSON.stringify(source)} is not a readable local file (${cause instanceof Error ? cause.message : String(cause)})`);
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('image source must be a local non-linked regular file');
  }
  if (before.size < 1 || before.size > maxBytes) {
    throw new Error(`image source must be between 1 and ${maxBytes} bytes`);
  }
  let fd: number | undefined;
  try {
    // `openSync` is intentionally used after lstat so a file replacement can
    // be detected with fstat below. Node does not expose O_NOFOLLOW portably on
    // all supported Windows builds; the identity check is the portable guard.
    fd = openSync(sourcePath, 'r');
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new Error('image source changed after preflight; refusing to read it');
    }
    if (opened.size < 1 || opened.size > maxBytes) {
      throw new Error(`image source must be between 1 and ${maxBytes} bytes`);
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error('image source ended before its declared length');
      offset += count;
    }
    const after = fstatSync(fd);
    if (!sameIdentity(before, after) || after.size !== opened.size) {
      throw new Error('image source changed while reading; refusing partial bytes');
    }
    return { sourcePath, bytes };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** True only when candidate lives inside parent (including the parent itself). */
export function isInsideDirectory(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Best-effort regular source check used after write setup too. */
export function isRegularLocalFile(absPath: string): boolean {
  try {
    const entry = lstatSync(absPath);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Assert no path component known to exist is a link/non-directory. */
export function assertSafeDirectoryPath(root: string, candidate: string): void {
  const rootAbs = path.resolve(root);
  const candidateAbs = path.resolve(candidate);
  if (!isInsideDirectory(rootAbs, candidateAbs)) throw new Error('path escapes its explicit root');
  const rel = path.relative(rootAbs, candidateAbs);
  let current = rootAbs;
  for (const part of rel === '' ? [] : rel.split(path.sep)) {
    current = path.join(current, part);
    try {
      const entry = lstatSync(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`unsafe linked or non-directory path component ${current}`);
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw cause;
    }
  }
}
