/** Cooperative serializer for every brand/dist/manifest.json publisher. */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  assertSafeRegularFileTarget,
  assertSameUnlinkedDirectory,
  assertUnlinkedDirectoryPath,
  createPrivateExclusiveRegularFile,
  pathIsAbsent,
  sameFileIdentity,
  type FileIdentity,
} from '../filesystem.ts';
import {
  RetirementFinalizationError,
  encodeCooperativeLockRecord,
  isStrictCooperativeLockRecord,
  localProcessState,
  readStrictCooperativeLockRecord,
  retireVerifiedRegularFile,
  type CooperativeLockRecord,
  type LocalProcessState,
  type RetireVerifiedRegularFileOptions,
} from '../cooperative-lock.ts';

export const DIST_PUBLICATION_LOCK_FILE = '.onbrand-dist-publication.lock';

export interface DistPublicationLockRecord extends CooperativeLockRecord {}

export interface DistPublicationLock {
  path: string;
  record: DistPublicationLockRecord;
  release(): boolean;
}

export interface AcquireDistPublicationLockOptions {
  /** Test seam; production uses a UUID. */
  runToken?: string;
  /** Test seam; production uses the current local PID. */
  pid?: number;
  /** Test seam for a pinned well-formed UTC timestamp. */
  now?: () => string;
  /** Test seam for platforms where a specific PID state must be exercised. */
  processState?: (pid: number) => LocalProcessState;
  /** Test-only controller identity, liveness, and lifecycle seams. */
  retirement?: Omit<RetireVerifiedRegularFileOptions, 'sourceToken' | 'sourceOwnerStillRetirable'>;
}

/**
 * Acquire the per-brand writer lock. Existing records fail closed unless they
 * are strict, unchanged, and owned by a demonstrably dead local process.
 */
export function acquireDistPublicationLock(
  projectDir: string,
  options: AcquireDistPublicationLockOptions = {},
): DistPublicationLock {
  const resolvedProject = path.resolve(projectDir);
  const projectIdentity = assertUnlinkedDirectoryPath(resolvedProject, 'project tree');
  const brandDir = path.join(resolvedProject, 'brand');
  const brandIdentity = assertUnlinkedDirectoryPath(brandDir, 'brand tree');
  const lockPath = path.join(brandDir, DIST_PUBLICATION_LOCK_FILE);
  const record: DistPublicationLockRecord = {
    runToken: options.runToken ?? randomUUID(),
    pid: options.pid ?? process.pid,
    startedAt: (options.now ?? (() => new Date().toISOString()))(),
  };
  if (!isStrictCooperativeLockRecord(record)) {
    throw new Error('cannot acquire dist publication lock: generated owner record is invalid');
  }
  const content = encodeCooperativeLockRecord(record);
  const processState = options.processState ?? localProcessState;

  for (let attempt = 0; attempt < 3; attempt++) {
    assertSameUnlinkedDirectory(resolvedProject, projectIdentity, 'project tree');
    assertSameUnlinkedDirectory(brandDir, brandIdentity, 'brand tree');
    assertSafeRegularFileTarget(lockPath, 'dist publication lock');
    try {
      const identity = createLockFile(lockPath, content);
      return ownedLock(
        lockPath,
        record,
        identity,
        resolvedProject,
        projectIdentity,
        brandDir,
        brandIdentity,
        options.retirement,
      );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
    }

    const occupied = readStrictCooperativeLockRecord(lockPath);
    if (occupied === undefined) {
      if (pathIsAbsent(lockPath)) continue;
      throw new Error(`cannot acquire dist publication lock: ${lockPath} is unsafe or malformed`);
    }
    const state = processState(occupied.record.pid);
    if (state !== 'dead') {
      const detail = state === 'alive'
        ? `is owned by live local PID ${occupied.record.pid}, started ${occupied.record.startedAt}`
        : 'owner state cannot be proven dead';
      throw new Error(`cannot acquire dist publication lock: ${lockPath} ${detail}`);
    }

    // Recovery requires the same token, bytes, and full file identity at the
    // final inspection. If another writer replaced it, leave that path alone.
    const rechecked = readStrictCooperativeLockRecord(lockPath);
    if (
      rechecked === undefined ||
      rechecked.record.runToken !== occupied.record.runToken ||
      !rechecked.file.bytes.equals(occupied.file.bytes) ||
      !sameFileIdentity(rechecked.file.identity, occupied.file.identity)
    ) {
      throw new Error(`cannot acquire dist publication lock: ${lockPath} was replaced during recovery`);
    }
    assertSameUnlinkedDirectory(resolvedProject, projectIdentity, 'project tree');
    assertSameUnlinkedDirectory(brandDir, brandIdentity, 'brand tree');
    if (retireVerifiedRegularFile(
      lockPath,
      occupied.file,
      brandDir,
      brandIdentity,
      {
        ...options.retirement,
        sourceToken: occupied.record.runToken,
        sourceOwnerStillRetirable: () => processState(occupied.record.pid) === 'dead',
      },
    ) !== 'retired') {
      throw new Error(`cannot acquire dist publication lock: ${lockPath} changed before dead-owner recovery`);
    }
  }
  throw new Error(`cannot acquire dist publication lock: ${lockPath} remained contended`);
}

function createLockFile(lockPath: string, content: Uint8Array): FileIdentity {
  return createPrivateExclusiveRegularFile(
    lockPath,
    content,
    `cannot acquire dist publication lock: ${lockPath}`,
  );
}

function ownedLock(
  lockPath: string,
  record: DistPublicationLockRecord,
  identity: FileIdentity,
  projectDir: string,
  projectIdentity: FileIdentity,
  brandDir: string,
  brandIdentity: FileIdentity,
  retirement: AcquireDistPublicationLockOptions['retirement'],
): DistPublicationLock {
  let released = false;
  return {
    path: lockPath,
    record,
    release(): boolean {
      if (released) return true;
      try {
        assertSameUnlinkedDirectory(projectDir, projectIdentity, 'project tree');
        assertSameUnlinkedDirectory(brandDir, brandIdentity, 'brand tree');
        const current = readStrictCooperativeLockRecord(lockPath);
        if (
          current === undefined ||
          current.record.runToken !== record.runToken ||
          !sameFileIdentity(current.file.identity, identity) ||
          !current.file.bytes.equals(encodeCooperativeLockRecord(record))
        ) {
          return false;
        }
        if (retireVerifiedRegularFile(
          lockPath,
          current.file,
          brandDir,
          brandIdentity,
          { ...retirement, sourceToken: record.runToken },
        ) !== 'retired') return false;
        released = true;
        return true;
      } catch (cause) {
        if (cause instanceof RetirementFinalizationError && cause.primaryDetached) {
          released = true;
          return true;
        }
        return false;
      }
    },
  };
}
