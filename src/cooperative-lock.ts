/** Cooperative lock records and bounded controller-lease retirement policy. */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import {
  assertSameUnlinkedDirectory,
  assertUnlinkedDirectoryPath,
  createPrivateExclusiveRegularFile,
  identityOf,
  pathIsAbsent,
  removeOwnedEmptyDirectory,
  removeOwnedFile,
  sameFileIdentity,
  sameFileNode,
  stableReadRegularFile,
  type FileIdentity,
  type StableRegularFile,
} from './filesystem.ts';

export type LocalProcessState = 'alive' | 'dead' | 'unknown';
export type RetirementControllerProcessState = LocalProcessState;

/** Maximum accepted wire size for cooperative lock and controller records. */
export const COOPERATIVE_LOCK_MAX_BYTES = 4_096;

/** Exact owner record shared by the catalog and dist cooperative locks. */
export interface CooperativeLockRecord {
  runToken: string;
  pid: number;
  startedAt: string;
}

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function isCanonicalUtcIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function isPositiveSafePid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isStrictCooperativeLockRecord(value: unknown): value is CooperativeLockRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  return keys.length === 3 && keys[0] === 'pid' && keys[1] === 'runToken' && keys[2] === 'startedAt' &&
    isCanonicalUuid(row['runToken']) && isPositiveSafePid(row['pid']) &&
    isCanonicalUtcIsoTimestamp(row['startedAt']);
}

/** Encode the exact newline-terminated wire form shared by cooperative locks. */
export function encodeCooperativeLockRecord(record: CooperativeLockRecord): Buffer {
  if (!isStrictCooperativeLockRecord(record)) {
    throw new Error('cannot encode an invalid cooperative lock record');
  }
  return Buffer.from(`${JSON.stringify({
    runToken: record.runToken,
    pid: record.pid,
    startedAt: record.startedAt,
  })}\n`, 'utf8');
}

/** Read one strict, private cooperative-lock record without following links. */
export function readStrictCooperativeLockRecord(
  lockPath: string,
): { record: CooperativeLockRecord; file: StableRegularFile } | undefined {
  const file = stableReadRegularFile(lockPath, {
    maxBytes: COOPERATIVE_LOCK_MAX_BYTES,
    requireSingleLink: true,
  });
  if (file === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(file.bytes.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
  return isStrictCooperativeLockRecord(value) ? { record: value, file } : undefined;
}

export function localProcessState(pid: number): LocalProcessState {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

export interface RetirementControllerHooks {
  /** Test-only seam before this controller creates its never-reused lease. */
  beforeControllerLeaseCreate?: () => void;
  /** Test-only seam after private staging and before final lease publication. */
  afterControllerLeaseStage?: () => void;
  /** Test-only seam after lease creation and before controller election. */
  afterControllerLeaseCreate?: () => void;
  /** Test-only seam immediately before final controller authorization and revalidation. */
  beforeFinalControllerAuthorization?: () => void;
  /** Test-only seam after the final source check and immediately before detach. */
  beforePrimaryDetach?: () => void;
  /** Test-only seam after primary detach and before controller cleanup. */
  afterPrimaryUnlink?: () => void;
}

export interface RetireVerifiedRegularFileOptions {
  /** Immutable owner token stored in the cooperative lock being retired. */
  sourceToken: string;
  /** Test seam; production controllers always use a fresh UUID. */
  controllerId?: string;
  /** Test seam; production controllers use the current process. */
  controllerPid?: number;
  /** Test seam; production controllers use the current UTC time. */
  controllerStartedAt?: string;
  /** Test seam for live/dead/unknown controller states. */
  processState?: (pid: number) => RetirementControllerProcessState;
  /** Re-check a stale source owner's eligibility immediately before detach. */
  sourceOwnerStillRetirable?: () => boolean;
  /** Named lifecycle seams; production callers omit this object. */
  hooks?: RetirementControllerHooks;
}

export type RetireVerifiedRegularFileResult = 'retired' | 'contended' | 'changed';

/** Distinguishes a post-detach finalization error from a residual primary. */
export class RetirementFinalizationError extends Error {
  readonly primaryDetached: boolean;

  constructor(message: string, primaryDetached: boolean, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RetirementFinalizationError';
    this.primaryDetached = primaryDetached;
  }
}

interface RetirementControllerRecord {
  sourceToken: string;
  controllerId: string;
  pid: number;
  startedAt: string;
}

interface RetirementControllerLease {
  path: string;
  record: RetirementControllerRecord;
  file: StableRegularFile;
}

interface RetirementControllerScope {
  path: string;
  identity: FileIdentity;
  sourceToken: string;
}

interface RetirementAttemptContext {
  readonly target: string;
  readonly expected: StableRegularFile;
  readonly parent: Readonly<{ path: string; identity: FileIdentity }>;
  readonly controller: Readonly<RetirementControllerRecord>;
  readonly scope: Readonly<RetirementControllerScope>;
  readonly leaseBytes: Buffer;
  readonly processState: (pid: number) => RetirementControllerProcessState;
  readonly sourceOwnerStillRetirable: (() => boolean) | undefined;
  readonly hooks: RetirementControllerHooks | undefined;
}

interface OwnedRetirementLeaseContext extends RetirementAttemptContext {
  readonly ownedLease: Readonly<{
    path: string;
    identity: FileIdentity;
    bytes: Buffer;
  }>;
}

type RetirementControllerInventory =
  | { state: 'stable'; leases: RetirementControllerLease[] }
  | { state: 'changed' }
  | { state: 'unsafe' };

const RETIREMENT_SCOPE_PREFIX = '.onbrand-retire-';
const RETIREMENT_SCOPE_SUFFIX = '.d';
const RETIREMENT_PENDING_PREFIX = '.onbrand-retire-pending-';
const RETIREMENT_CONTROLLER_LEASE_SUFFIX = '.lease';
const MAX_RETIREMENT_CONTROLLER_LEASES = 64;

/**
 * Retire one exact cooperative lock through a never-reused controller lease.
 * The publish/elect/re-elect/revalidate/snapshot/detach order is load-bearing.
 */
export function retireVerifiedRegularFile(
  target: string,
  expected: StableRegularFile,
  parentPath: string,
  parentIdentity: FileIdentity,
  options: RetireVerifiedRegularFileOptions,
): RetireVerifiedRegularFileResult {
  const controller = Object.freeze<RetirementControllerRecord>({
    sourceToken: options.sourceToken,
    controllerId: options.controllerId ?? randomUUID(),
    pid: options.controllerPid ?? process.pid,
    startedAt: options.controllerStartedAt ?? new Date().toISOString(),
  });
  if (!isStrictRetirementControllerRecord(controller)) {
    throw new Error(`cannot retire ${target}: generated controller lease is invalid`);
  }
  if (path.resolve(parentPath) !== path.dirname(path.resolve(target))) {
    throw new Error(`cannot retire ${target}: controller parent does not match target`);
  }
  if (options.sourceOwnerStillRetirable?.() === false || !matchesRetirementTarget(target, expected)) {
    return 'changed';
  }

  const scope = openRetirementControllerScope(
    controller.sourceToken,
    parentPath,
    parentIdentity,
    expected.identity,
  );
  const attempt = Object.freeze<RetirementAttemptContext>({
    target,
    expected,
    parent: Object.freeze({ path: parentPath, identity: parentIdentity }),
    controller,
    scope,
    leaseBytes: encodeRetirementControllerRecord(controller),
    processState: options.processState ?? localProcessState,
    sourceOwnerStillRetirable: options.sourceOwnerStillRetirable,
    hooks: options.hooks,
  });
  let owned: OwnedRetirementLeaseContext | undefined;
  let result: RetireVerifiedRegularFileResult = 'changed';
  let operationError: unknown;
  let leaseCleanupFailed = false;
  let scopeCleanupFailed = false;
  try {
    attempt.hooks?.beforeControllerLeaseCreate?.();
    assertSameUnlinkedDirectory(attempt.parent.path, attempt.parent.identity, 'publication parent');
    try {
      const leaseIdentity = publishRetirementControllerLease(attempt);
      owned = Object.freeze<OwnedRetirementLeaseContext>({
        ...attempt,
        ownedLease: Object.freeze({
          path: retirementControllerPath(attempt.scope, attempt.controller.controllerId),
          identity: leaseIdentity,
          bytes: attempt.leaseBytes,
        }),
      });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') result = 'contended';
      else throw cause;
    }
    if (owned !== undefined) {
      owned.hooks?.afterControllerLeaseCreate?.();
      result = detachWithRetirementController(owned);
    }
  } catch (cause) {
    operationError = cause;
  } finally {
    if (owned !== undefined) {
      const removed = removeOwnedFile(owned.ownedLease.path, owned.ownedLease.identity);
      leaseCleanupFailed = !removed && !pathIsAbsent(owned.ownedLease.path);
    }
    if (!leaseCleanupFailed) {
      const scopeCleanup = removeOwnedEmptyDirectory(attempt.scope.path, attempt.scope.identity);
      scopeCleanupFailed = scopeCleanup === 'changed' || scopeCleanup === 'failed';
    }
  }

  const detached = result === 'retired' ||
    (operationError instanceof RetirementFinalizationError && operationError.primaryDetached);
  if (operationError !== undefined) {
    if (operationError instanceof RetirementFinalizationError) throw operationError;
    throw new RetirementFinalizationError(messageOf(operationError), detached, operationError);
  }
  if (leaseCleanupFailed || scopeCleanupFailed) {
    const detail = leaseCleanupFailed
      ? 'owned controller lease could not be removed'
      : 'owned empty controller scope could not be removed';
    throw new RetirementFinalizationError(`cannot retire ${target}: ${detail}`, detached);
  }
  return result;
}

function detachWithRetirementController(context: OwnedRetirementLeaseContext): RetireVerifiedRegularFileResult {
  const initial = authorizeRetirementController(context);
  if (initial !== 'authorized') return initial;

  context.hooks?.beforeFinalControllerAuthorization?.();
  const final = authorizeRetirementController(context);
  if (final !== 'authorized') return final;
  if (!revalidateRetirementCandidate(context)) return 'changed';

  const snapshot = verifySoleRetirementController(context);
  if (snapshot !== 'authorized') return snapshot;
  if (!revalidateRetirementCandidate(context)) return 'changed';

  context.hooks?.beforePrimaryDetach?.();
  unlinkSync(context.target);
  try {
    context.hooks?.afterPrimaryUnlink?.();
  } catch (cause) {
    throw new RetirementFinalizationError(messageOf(cause), true, cause);
  }
  return 'retired';
}

function revalidateRetirementCandidate(context: RetirementAttemptContext): boolean {
  assertSameUnlinkedDirectory(context.parent.path, context.parent.identity, 'publication parent');
  return context.sourceOwnerStillRetirable?.() !== false &&
    matchesRetirementTarget(context.target, context.expected);
}

function verifySoleRetirementController(
  context: OwnedRetirementLeaseContext,
): 'authorized' | 'contended' | 'changed' {
  const inventory = inventoryRetirementControllers(context.scope);
  if (inventory.state === 'changed') return 'changed';
  if (inventory.state === 'unsafe' || inventory.leases.length !== 1) return 'contended';
  return matchesOwnedRetirementControllerLease(inventory.leases[0], context)
    ? 'authorized'
    : 'changed';
}

/** Stage complete private bytes in the parent, then atomically publish. */
function publishRetirementControllerLease(context: RetirementAttemptContext): FileIdentity {
  const leasePath = retirementControllerPath(context.scope, context.controller.controllerId);
  const pendingPath = retirementPendingPath(context);
  let pendingIdentity: FileIdentity | undefined;
  let renamed = false;
  try {
    pendingIdentity = createPrivateExclusiveRegularFile(
      pendingPath,
      context.leaseBytes,
      `retirement controller staging ${pendingPath}`,
    );
    context.hooks?.afterControllerLeaseStage?.();
    assertSameUnlinkedDirectory(context.parent.path, context.parent.identity, 'publication parent');
    assertSameUnlinkedDirectory(context.scope.path, context.scope.identity, 'retirement controller scope');
    if (!pathIsAbsent(leasePath)) {
      const collision = new Error(`retirement controller lease ${leasePath} already exists`) as NodeJS.ErrnoException;
      collision.code = 'EEXIST';
      throw collision;
    }
    renameSync(pendingPath, leasePath);
    renamed = true;
    const confirmed = stableReadRegularFile(leasePath, {
      maxBytes: COOPERATIVE_LOCK_MAX_BYTES,
      requireSingleLink: true,
    });
    if (
      confirmed === undefined || !sameFileNode(confirmed.identity, pendingIdentity) ||
      !confirmed.bytes.equals(context.leaseBytes)
    ) {
      throw new Error(`retirement controller lease ${leasePath} changed while being published`);
    }
    assertSameUnlinkedDirectory(context.scope.path, context.scope.identity, 'retirement controller scope');
    return confirmed.identity;
  } finally {
    if (!renamed && pendingIdentity !== undefined) {
      removeOwnedFile(pendingPath, pendingIdentity, { nodeOnly: true });
    }
  }
}

function authorizeRetirementController(
  context: OwnedRetirementLeaseContext,
): 'authorized' | 'contended' | 'changed' {
  for (let attempt = 0; attempt < 4; attempt++) {
    const inventory = inventoryRetirementControllers(context.scope);
    if (inventory.state === 'changed') continue;
    if (inventory.state === 'unsafe') return 'contended';
    const own = inventory.leases.find((lease) => lease.path === context.ownedLease.path);
    if (!matchesOwnedRetirementControllerLease(own, context)) return 'changed';
    let removedDeadPeer = false;
    for (const lease of inventory.leases) {
      if (lease.path === context.ownedLease.path) continue;
      if (context.processState(lease.record.pid) !== 'dead') return 'contended';
      if (!removeOwnedFile(lease.path, lease.file.identity) && !pathIsAbsent(lease.path)) {
        return 'contended';
      }
      removedDeadPeer = true;
    }
    if (removedDeadPeer) continue;
    return inventory.leases.length === 1 ? 'authorized' : 'contended';
  }
  return 'contended';
}

/** Inspect at most 64 finals in the directly addressed current-token scope. */
function inventoryRetirementControllers(scope: RetirementControllerScope): RetirementControllerInventory {
  let directory: ReturnType<typeof opendirSync> | undefined;
  const names: string[] = [];
  try {
    directory = opendirSync(scope.path);
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      if (names.length >= MAX_RETIREMENT_CONTROLLER_LEASES) return { state: 'unsafe' };
      if (controllerIdFromLeaseName(entry.name) === undefined) return { state: 'unsafe' };
      names.push(entry.name);
    }
  } catch {
    return pathIsAbsent(scope.path) ? { state: 'changed' } : { state: 'unsafe' };
  } finally {
    if (directory !== undefined) {
      try { directory.closeSync(); } catch { /* inventory remains fail-closed */ }
    }
  }
  if (!matchesRetirementControllerScope(scope)) return { state: 'changed' };
  names.sort();
  const leases: RetirementControllerLease[] = [];
  for (const name of names) {
    const controllerId = controllerIdFromLeaseName(name);
    if (controllerId === undefined) return { state: 'unsafe' };
    const leasePath = retirementControllerPath(scope, controllerId);
    const file = stableReadRegularFile(leasePath, {
      maxBytes: COOPERATIVE_LOCK_MAX_BYTES,
      requireSingleLink: true,
    });
    if (file === undefined) {
      return pathIsAbsent(leasePath) ? { state: 'changed' } : { state: 'unsafe' };
    }
    let value: unknown;
    try {
      value = JSON.parse(file.bytes.toString('utf8')) as unknown;
    } catch {
      return { state: 'unsafe' };
    }
    if (
      !isStrictRetirementControllerRecord(value) ||
      value.sourceToken !== scope.sourceToken ||
      value.controllerId !== controllerId ||
      !file.bytes.equals(encodeRetirementControllerRecord(value))
    ) {
      return { state: 'unsafe' };
    }
    leases.push({ path: leasePath, record: value, file });
  }
  return matchesRetirementControllerScope(scope) ? { state: 'stable', leases } : { state: 'changed' };
}

function matchesOwnedRetirementControllerLease(
  lease: RetirementControllerLease | undefined,
  context: OwnedRetirementLeaseContext,
): boolean {
  return lease !== undefined && lease.path === context.ownedLease.path &&
    sameFileIdentity(lease.file.identity, context.ownedLease.identity) &&
    lease.file.bytes.equals(context.ownedLease.bytes);
}

function matchesRetirementTarget(target: string, expected: StableRegularFile): boolean {
  if (expected.identity.nlink !== 1n) return false;
  const current = stableReadRegularFile(target, {
    maxBytes: COOPERATIVE_LOCK_MAX_BYTES,
    requireSingleLink: true,
  });
  return current !== undefined && sameFileIdentity(current.identity, expected.identity) &&
    current.bytes.equals(expected.bytes);
}

function openRetirementControllerScope(
  sourceToken: string,
  parentPath: string,
  parentIdentity: FileIdentity,
  sourceIdentity: FileIdentity,
): RetirementControllerScope {
  const scopePath = retirementControllerScopePath(
    parentPath,
    parentIdentity,
    sourceIdentity,
    sourceToken,
  );
  assertSameUnlinkedDirectory(parentPath, parentIdentity, 'publication parent');
  try {
    createPrivateRetirementControllerScope(scopePath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
  }
  const identity = assertUnlinkedDirectoryPath(scopePath, 'retirement controller scope');
  enforcePrivateRetirementControllerScope(scopePath, identity, parentPath, parentIdentity);
  assertSameUnlinkedDirectory(parentPath, parentIdentity, 'publication parent');
  return Object.freeze({ path: scopePath, identity, sourceToken });
}

/** Create a POSIX scope with usable owner bits even under a restrictive umask. */
function createPrivateRetirementControllerScope(scopePath: string): void {
  if (process.platform === 'win32') {
    mkdirSync(scopePath, { mode: 0o700 });
    return;
  }
  // The exact mode is still descriptor-enforced below. Temporarily clearing
  // the umask only ensures the newly created directory can be opened for that
  // identity-safe enforcement; every operation in this section is synchronous.
  const previousUmask = process.umask(0);
  try {
    mkdirSync(scopePath, { mode: 0o700 });
  } finally {
    process.umask(previousUmask);
  }
}

/** Enforce POSIX 0700 through a no-follow descriptor bound to this inode. */
function enforcePrivateRetirementControllerScope(
  scopePath: string,
  expected: FileIdentity,
  parentPath: string,
  parentIdentity: FileIdentity,
): void {
  if (process.platform === 'win32') return;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      scopePath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory() || !sameFileNode(identityOf(opened), expected)) {
      throw new Error(`retirement controller scope ${scopePath} changed before permission enforcement`);
    }
    assertSameUnlinkedDirectory(parentPath, parentIdentity, 'publication parent');
    assertSameUnlinkedDirectory(scopePath, expected, 'retirement controller scope');
    fchmodSync(descriptor, 0o700);
    const secured = fstatSync(descriptor, { bigint: true });
    if (
      !secured.isDirectory() ||
      !sameFileNode(identityOf(secured), expected) ||
      Number(secured.mode & 0o777n) !== 0o700
    ) {
      throw new Error(`retirement controller scope ${scopePath} did not retain owner-only permissions`);
    }
    assertSameUnlinkedDirectory(scopePath, expected, 'retirement controller scope');
    assertSameUnlinkedDirectory(parentPath, parentIdentity, 'publication parent');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Fixed-length, physical-parent-and-source-bound scope below the lock parent. */
export function retirementControllerScopePath(
  parentPath: string,
  parentIdentity: Pick<FileIdentity, 'dev' | 'ino'>,
  sourceIdentity: Pick<FileIdentity, 'dev' | 'ino'>,
  sourceToken: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      'scope-v2',
      parentIdentity.dev.toString(10),
      parentIdentity.ino.toString(10),
      sourceIdentity.dev.toString(10),
      sourceIdentity.ino.toString(10),
      sourceToken,
    ]), 'utf8')
    .digest('hex');
  return path.join(
    path.resolve(parentPath),
    `${RETIREMENT_SCOPE_PREFIX}${digest}${RETIREMENT_SCOPE_SUFFIX}`,
  );
}

function retirementControllerPath(scope: RetirementControllerScope, controllerId: string): string {
  return path.join(scope.path, `${controllerId}${RETIREMENT_CONTROLLER_LEASE_SUFFIX}`);
}

function retirementPendingPath(context: RetirementAttemptContext): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      path.resolve(context.target),
      context.controller.sourceToken,
      context.controller.controllerId,
      randomUUID(),
    ]), 'utf8')
    .digest('hex');
  return path.join(context.parent.path, `${RETIREMENT_PENDING_PREFIX}${digest}`);
}

function controllerIdFromLeaseName(name: string): string | undefined {
  if (!name.endsWith(RETIREMENT_CONTROLLER_LEASE_SUFFIX)) return undefined;
  const controllerId = name.slice(0, -RETIREMENT_CONTROLLER_LEASE_SUFFIX.length);
  return isCanonicalUuid(controllerId) ? controllerId : undefined;
}

function matchesRetirementControllerScope(scope: RetirementControllerScope): boolean {
  try {
    assertSameUnlinkedDirectory(scope.path, scope.identity, 'retirement controller scope');
    return true;
  } catch {
    return false;
  }
}

function encodeRetirementControllerRecord(record: RetirementControllerRecord): Buffer {
  return Buffer.from(`${JSON.stringify({
    sourceToken: record.sourceToken,
    controllerId: record.controllerId,
    pid: record.pid,
    startedAt: record.startedAt,
  })}\n`, 'utf8');
}

function isStrictRetirementControllerRecord(value: unknown): value is RetirementControllerRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (
    keys.length !== 4 || keys[0] !== 'controllerId' || keys[1] !== 'pid' ||
    keys[2] !== 'sourceToken' || keys[3] !== 'startedAt'
  ) return false;
  return isCanonicalUuid(row['sourceToken']) && isCanonicalUuid(row['controllerId']) &&
    isPositiveSafePid(row['pid']) && isCanonicalUtcIsoTimestamp(row['startedAt']);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
