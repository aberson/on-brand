/**
 * Shared filesystem primitives for local publication.
 *
 * These checks enforce the state visible when each pathname is inspected.
 * They deliberately do not claim descriptor-relative containment against a
 * malicious same-user process that can replace an ancestor between checks.
 * The supported boundary is an operator-controlled project tree.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import path from 'node:path';

export interface FileIdentity {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export interface StableRegularFileMetadata {
  identity: FileIdentity;
  /** POSIX-style owner/group/other permission bits observed on the open file. */
  mode: number;
}

export interface StableRegularFileDigest extends StableRegularFileMetadata {
  sha256: string;
}

export interface StableRegularFile extends StableRegularFileDigest {
  bytes: Buffer;
}

export type SafeTargetSnapshot =
  | { state: 'absent' }
  | { state: 'file'; identity: FileIdentity }
  | { state: 'unsafe' };

type DirectoryPathInspection =
  | { state: 'absent' }
  | { state: 'directory'; identity: FileIdentity }
  | { state: 'unsafe' };

export interface StagedFile {
  path: string;
  identity: FileIdentity;
  parentPath: string;
  parentIdentity: FileIdentity;
  targetSnapshot: SafeTargetSnapshot;
}

export function identityOf(stat: BigIntStats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

export function sameFileNode(left: FileIdentity, right: FileIdentity): boolean {
  return left.ino !== 0n && right.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
}

export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return sameFileNode(left, right) && left.nlink === right.nlink && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Leaf-only lstat for already-validated parents; deliberately not exported. */
function leafRegularFileStat(
  target: string,
  options: { requireSingleLink?: boolean } = {},
): BigIntStats | undefined {
  try {
    const stat = lstatSync(target, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    if (options.requireSingleLink === true && stat.nlink !== 1n) return undefined;
    return stat;
  } catch {
    return undefined;
  }
}

export function stableReadRegularFile(
  target: string,
  options: { maxBytes?: number; requireSingleLink?: boolean } = {},
): StableRegularFile | undefined {
  const inspected = withStableRegularFileDescriptor(target, options, (descriptor) => (
    options.maxBytes === undefined
      ? readFileSync(descriptor)
      : readDescriptorBounded(descriptor, options.maxBytes)
  ));
  if (inspected === undefined) return undefined;
  return {
    bytes: inspected.value,
    sha256: sha256Bytes(inspected.value),
    identity: inspected.identity,
    mode: inspected.mode,
  };
}

/**
 * Inspect one regular file's stable identity and metadata without reading its
 * contents. This is the appropriate primitive when existence, size, and link
 * safety are the whole contract.
 */
export function stableInspectRegularFile(
  target: string,
  options: { maxBytes?: number; requireSingleLink?: boolean } = {},
): StableRegularFileMetadata | undefined {
  const inspected = withStableRegularFileDescriptor(target, options, () => true);
  return inspected === undefined
    ? undefined
    : { identity: inspected.identity, mode: inspected.mode };
}

/**
 * SHA-256 one stable regular file through one fixed-size buffer. No complete
 * file Buffer is retained, and identity is revalidated after the final read.
 */
export function stableHashRegularFile(
  target: string,
  options: { maxBytes?: number; requireSingleLink?: boolean } = {},
): StableRegularFileDigest | undefined {
  const inspected = withStableRegularFileDescriptor(
    target,
    options,
    (descriptor) => hashDescriptorBounded(descriptor, options.maxBytes),
  );
  return inspected === undefined
    ? undefined
    : { sha256: inspected.value, identity: inspected.identity, mode: inspected.mode };
}

interface StableDescriptorResult<T> extends StableRegularFileMetadata {
  value: T;
}

/** Own the safety-critical open, identity revalidation, and close lifecycle. */
function withStableRegularFileDescriptor<T>(
  target: string,
  options: { maxBytes?: number; requireSingleLink?: boolean },
  inspectDescriptor: (descriptor: number) => T | undefined,
): StableDescriptorResult<T> | undefined {
  const before = inspectSafeRegularFileTarget(target, options);
  if (before.state !== 'file' || exceedsLimit(before.identity.size, options.maxBytes)) return undefined;
  let descriptor: number | undefined;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(target, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      (options.requireSingleLink === true && opened.nlink !== 1n) ||
      !sameFileIdentity(before.identity, identityOf(opened)) ||
      exceedsLimit(opened.size, options.maxBytes)
    ) {
      return undefined;
    }
    const value = inspectDescriptor(descriptor);
    if (value === undefined) return undefined;
    const afterInspection = fstatSync(descriptor, { bigint: true });
    const afterIdentity = identityOf(afterInspection);
    const afterPath = inspectSafeRegularFileTarget(target, options);
    if (
      afterPath.state !== 'file' ||
      !sameFileIdentity(identityOf(opened), afterIdentity) ||
      !sameFileIdentity(afterIdentity, afterPath.identity) ||
      exceedsLimit(afterInspection.size, options.maxBytes)
    ) {
      return undefined;
    }
    return {
      value,
      identity: afterIdentity,
      mode: Number(afterInspection.mode & 0o777n),
    };
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best-effort descriptor cleanup */ }
    }
  }
}

/** Hash through one fixed buffer and stop if a concurrently growing file crosses its cap. */
function hashDescriptorBounded(descriptor: number, maxBytes: number | undefined): string | undefined {
  const digest = createHash('sha256');
  const chunk = Buffer.allocUnsafe(64 * 1_024);
  let total = 0;
  while (true) {
    const count = readSync(descriptor, chunk, 0, chunk.byteLength, null);
    if (count === 0) break;
    total += count;
    if (maxBytes !== undefined && total > maxBytes) return undefined;
    digest.update(chunk.subarray(0, count));
  }
  return digest.digest('hex');
}

/** Read at most maxBytes + 1 through bounded chunks so growth cannot allocate unbounded memory. */
function readDescriptorBounded(descriptor: number, maxBytes: number): Buffer | undefined {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const remaining = maxBytes - total + 1;
    if (remaining <= 0) return undefined;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1_024, remaining));
    const count = readSync(descriptor, chunk, 0, chunk.byteLength, null);
    if (count === 0) break;
    chunks.push(chunk.subarray(0, count));
    total += count;
    if (total > maxBytes) return undefined;
  }
  return Buffer.concat(chunks, total);
}

export function pathIsAbsent(target: string): boolean {
  try {
    lstatSync(target);
    return false;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/** Inspect every visible static component without following a link/junction. */
export function assertUnlinkedDirectoryPath(target: string, description = 'directory'): FileIdentity {
  const resolved = path.resolve(target);
  const inspected = inspectDirectoryPath(resolved);
  if (inspected.state === 'absent') {
    throw new Error(`${description} ${resolved} cannot be inspected (path does not exist)`);
  }
  if (inspected.state === 'unsafe') {
    throw new Error(`${description} ${resolved} must be a local non-linked directory`);
  }
  return inspected.identity;
}

export function assertSameUnlinkedDirectory(
  target: string,
  expected: FileIdentity,
  description = 'directory',
): void {
  const current = assertUnlinkedDirectoryPath(target, description);
  if (!sameFileNode(current, expected)) {
    throw new Error(`${description} ${path.resolve(target)} changed during publication`);
  }
}

/** Reject a present symbolic/junction/hard link or non-regular final target. */
export function assertSafeRegularFileTarget(
  target: string,
  description = 'output target',
): SafeTargetSnapshot {
  const inspected = inspectSafeRegularFileTarget(target, { requireSingleLink: true });
  if (inspected.state === 'unsafe') {
    throw new Error(`${description} ${target} must be absent or a local unlinked regular file`);
  }
  return inspected;
}

/**
 * Classify a regular-file pathname without following any visible static
 * directory link. Absence at the leaf or an earlier component is distinct
 * from an unsafe/non-regular/linked target so callers can prune only absence.
 */
export function inspectSafeRegularFileTarget(
  target: string,
  options: { requireSingleLink?: boolean } = {},
): SafeTargetSnapshot {
  const resolved = path.resolve(target);
  const parent = inspectDirectoryPath(path.dirname(resolved));
  if (parent.state === 'absent') return { state: 'absent' };
  if (parent.state === 'unsafe') return { state: 'unsafe' };
  try {
    const current = lstatSync(resolved, { bigint: true });
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      (options.requireSingleLink === true && current.nlink !== 1n)
    ) {
      return { state: 'unsafe' };
    }
    return { state: 'file', identity: identityOf(current) };
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'absent' }
      : { state: 'unsafe' };
  }
}

/** Reject a linked final component while allowing an unusable non-file input. */
export function assertFileTargetIsNotLinked(target: string, description = 'file target'): void {
  const parent = inspectDirectoryPath(path.dirname(path.resolve(target)));
  if (parent.state === 'unsafe') {
    throw new Error(`${description} ${target} must not have a linked directory component`);
  }
  if (parent.state === 'absent') return;
  try {
    const current = lstatSync(target, { bigint: true });
    if (current.isSymbolicLink() || (current.isFile() && current.nlink !== 1n)) {
      throw new Error(`${description} ${target} must be a local unlinked regular file when present`);
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
}

/**
 * Create one private, unlinked regular file and return its stable identity.
 * Cooperative lock owners share this descriptor-first primitive so creation
 * mode, link checks, and failed-create cleanup cannot drift between locks.
 */
export function createPrivateExclusiveRegularFile(
  target: string,
  content: string | Uint8Array,
  description: string,
): FileIdentity {
  const expectedBytes = Buffer.from(content);
  let descriptor: number | undefined;
  let initialIdentity: FileIdentity | undefined;
  try {
    descriptor = openSync(target, 'wx', 0o600);
    initialIdentity = identityOf(fstatSync(descriptor, { bigint: true }));
    writeFileSync(descriptor, expectedBytes);
    // Creation mode is filtered by umask; cooperative locks stay private.
    if (process.platform !== 'win32') fchmodSync(descriptor, 0o600);
    const writtenIdentity = identityOf(fstatSync(descriptor, { bigint: true }));
    if (writtenIdentity.nlink !== 1n) throw new Error(`${description} became linked while being created`);
    closeSync(descriptor);
    descriptor = undefined;
    const confirmed = stableReadRegularFile(target, {
      maxBytes: expectedBytes.byteLength,
      requireSingleLink: true,
    });
    if (
      confirmed === undefined || !sameFileIdentity(confirmed.identity, writtenIdentity) ||
      !confirmed.bytes.equals(expectedBytes)
    ) throw new Error(`${description} changed while being created`);
    return confirmed.identity;
  } catch (cause) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best-effort descriptor cleanup */ }
    }
    if (initialIdentity !== undefined) removeOwnedFile(target, initialIdentity, { nodeOnly: true });
    throw cause;
  }
}

export function stageFileExclusive(
  target: string,
  content: string | Uint8Array,
  options: {
    randomBytesFn?: (size: number) => Buffer;
    /** Creation mode before the process umask (ordinary generated files). */
    mode?: number;
    /** Exact final permission bits, applied identity-safely through the open fd. */
    exactMode?: number;
  } = {},
): StagedFile {
  if (
    options.exactMode !== undefined &&
    (!Number.isInteger(options.exactMode) || options.exactMode < 0 || options.exactMode > 0o777)
  ) {
    throw new Error(`invalid exact staging mode for ${target}`);
  }
  const parentPath = path.dirname(target);
  const parentIdentity = assertUnlinkedDirectoryPath(parentPath, 'publication parent');
  let targetSnapshot: SafeTargetSnapshot;
  try {
    targetSnapshot = assertSafeRegularFileTarget(target);
  } catch {
    // Reserving a fresh sibling is still safe. Publication will reject the
    // unsafe destination after earlier outputs have retained manifest-last
    // semantics, then cleanup removes only this owned staging inode.
    targetSnapshot = { state: 'unsafe' };
  }
  const randomBytesFn = options.randomBytesFn ?? randomBytes;
  let descriptor: number | undefined;
  let temporary: string | undefined;
  let initialIdentity: FileIdentity | undefined;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const digest = createHash('sha256')
        .update(JSON.stringify([path.resolve(target), randomBytesFn(16).toString('hex')]), 'utf8')
        .digest('hex');
      const candidate = path.join(parentPath, `.onbrand-tmp-${digest}`);
      try {
        // Ordinary generated files retain Node's write-file convention:
        // 0666 before the process umask. Sensitive cooperative locks use
        // their own explicit 0600 creation path.
        descriptor = openSync(candidate, 'wx', options.exactMode ?? options.mode ?? 0o666);
        temporary = candidate;
        initialIdentity = identityOf(fstatSync(descriptor, { bigint: true }));
        break;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      }
    }
    if (descriptor === undefined || temporary === undefined || initialIdentity === undefined) {
      throw new Error(`could not reserve a unique staging file for ${target}`);
    }
    if (typeof content === 'string') writeFileSync(descriptor, content, { encoding: 'utf8' });
    else writeFileSync(descriptor, content);
    if (options.exactMode !== undefined) fchmodSync(descriptor, options.exactMode);
    const writtenIdentity = identityOf(fstatSync(descriptor, { bigint: true }));
    if (writtenIdentity.nlink !== 1n) throw new Error(`staging file for ${target} is linked`);
    closeSync(descriptor);
    descriptor = undefined;
    assertSameUnlinkedDirectory(parentPath, parentIdentity, 'publication parent');
    const current = leafRegularFileStat(temporary, { requireSingleLink: true });
    if (current === undefined || !sameFileIdentity(identityOf(current), writtenIdentity)) {
      throw new Error(`staging file for ${target} changed before publication`);
    }
    return { path: temporary, identity: writtenIdentity, parentPath, parentIdentity, targetSnapshot };
  } catch (cause) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best-effort descriptor cleanup */ }
    }
    if (temporary !== undefined && initialIdentity !== undefined) {
      removeOwnedFile(temporary, initialIdentity, { nodeOnly: true });
    }
    throw cause;
  }
}

/** Validate staged inode, parent, and the original destination before rename. */
export function publishStagedFile(staged: StagedFile, target: string): void {
  if (path.dirname(target) !== staged.parentPath) {
    throw new Error(`staged file parent does not match publication target ${target}`);
  }
  assertSameUnlinkedDirectory(staged.parentPath, staged.parentIdentity, 'publication parent');
  if (!sameTargetSnapshot(assertSafeRegularFileTarget(target), staged.targetSnapshot)) {
    throw new Error(`publication target ${target} changed after staging`);
  }
  const current = leafRegularFileStat(staged.path, { requireSingleLink: true });
  if (current === undefined || !sameFileIdentity(identityOf(current), staged.identity)) {
    throw new Error(`staging file for ${target} changed before publication`);
  }
  renameSync(staged.path, target);
}

/** Remove a path only while it still names the inode created by this caller. */
export function removeOwnedFile(
  target: string,
  expected: FileIdentity,
  options: { nodeOnly?: boolean } = {},
): boolean {
  try {
    const current = leafRegularFileStat(target);
    if (current === undefined) return false;
    const actual = identityOf(current);
    const matches = options.nodeOnly
      ? sameFileNode(actual, expected)
      : sameFileIdentity(actual, expected);
    if (!matches) return false;
    rmSync(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

export type RemoveOwnedEmptyDirectoryResult =
  | 'removed'
  | 'absent'
  | 'not-empty'
  | 'changed'
  | 'failed';

/** Identity-check, then remove only an empty directory without recursion. */
export function removeOwnedEmptyDirectory(
  target: string,
  expected: FileIdentity,
): RemoveOwnedEmptyDirectoryResult {
  const inspected = inspectDirectoryPath(path.resolve(target));
  if (inspected.state === 'absent') return 'absent';
  if (inspected.state !== 'directory' || !sameFileNode(inspected.identity, expected)) return 'changed';
  try {
    rmdirSync(target);
    return 'removed';
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'absent';
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return 'not-empty';
    return 'failed';
  }
}

function sameTargetSnapshot(left: SafeTargetSnapshot, right: SafeTargetSnapshot): boolean {
  if (left.state !== right.state) return false;
  if (left.state === 'absent') return true;
  return left.state === 'file' && right.state === 'file' && sameFileIdentity(left.identity, right.identity);
}

function exceedsLimit(size: bigint, maxBytes: number | undefined): boolean {
  return maxBytes !== undefined && size > BigInt(maxBytes);
}

/** Lexically enumerate root -> leaf, without realpath-following any prefix. */
function pathPrefixes(target: string): string[] {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const relative = resolved.slice(root.length);
  const prefixes = [root];
  let current = root;
  for (const component of relative.split(path.sep).filter((part) => part.length > 0)) {
    current = path.join(current, component);
    prefixes.push(current);
  }
  return prefixes;
}

function inspectDirectoryPath(target: string): DirectoryPathInspection {
  let leafIdentity: FileIdentity | undefined;
  for (const component of pathPrefixes(target)) {
    let stat: BigIntStats;
    try {
      stat = lstatSync(component, { bigint: true });
    } catch (cause) {
      return (cause as NodeJS.ErrnoException).code === 'ENOENT'
        ? { state: 'absent' }
        : { state: 'unsafe' };
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { state: 'unsafe' };
    leafIdentity = identityOf(stat);
  }
  return leafIdentity === undefined
    ? { state: 'unsafe' }
    : { state: 'directory', identity: leafIdentity };
}
