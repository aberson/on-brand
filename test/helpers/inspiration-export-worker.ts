/** Real-process barrier holder for the production inspiration catalog lock. */

import { existsSync, writeFileSync } from 'node:fs';
import { exportInspirationArtifact, recoverStaleInspirationExportLock } from '../../src/inspiration/export.ts';
import type { RetirementControllerHooks } from '../../src/cooperative-lock.ts';

type WorkerMode = 'hold' | RecoveryMode;
type RecoveryMode =
  | 'recover'
  | 'recover-before-controller'
  | 'recover-after-stage'
  | 'recover-after-lease'
  | 'recover-before-final-authorization'
  | 'recover-after-unlink'
  | 'recover-after-lease-and-unlink'
  | 'recover-alias-election';

const WAIT_LIMIT_MS = 30_000;
const POLL_BACKOFF = new Int32Array(new SharedArrayBuffer(4));

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === '') throw new Error(`missing ${name}`);
  return value;
}

function waitForRelease(readyPath: string, releasePath: string): void {
  writeFileSync(readyPath, `${process.pid}\n`, { flag: 'wx' });
  const deadline = Date.now() + WAIT_LIMIT_MS;
  while (!existsSync(releasePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${releasePath}`);
    Atomics.wait(POLL_BACKOFF, 0, 0, 10);
  }
}

function isRecoveryMode(value: string): value is RecoveryMode {
  switch (value) {
    case 'recover':
    case 'recover-before-controller':
    case 'recover-after-stage':
    case 'recover-after-lease':
    case 'recover-before-final-authorization':
    case 'recover-after-unlink':
    case 'recover-after-lease-and-unlink':
    case 'recover-alias-election':
      return true;
    default:
      return false;
  }
}

function parseMode(candidate: string | undefined): WorkerMode {
  if (candidate === undefined || candidate === '') throw new Error('missing worker mode');
  if (candidate === 'hold' || isRecoveryMode(candidate)) return candidate;
  throw new Error(`unknown worker mode ${JSON.stringify(candidate)}`);
}

function recoveryHooks(
  mode: RecoveryMode,
  barrier: (phase?: 'lease' | 'detach' | 'unlink') => void,
): RetirementControllerHooks {
  switch (mode) {
    case 'recover':
      return {};
    case 'recover-before-controller':
      return { beforeControllerLeaseCreate: () => barrier() };
    case 'recover-after-stage':
      return { afterControllerLeaseStage: () => barrier() };
    case 'recover-after-lease':
      return { afterControllerLeaseCreate: () => barrier() };
    case 'recover-before-final-authorization':
      return { beforeFinalControllerAuthorization: () => barrier() };
    case 'recover-after-unlink':
      return { afterPrimaryUnlink: () => barrier() };
    case 'recover-after-lease-and-unlink':
      return {
        afterControllerLeaseCreate: () => barrier('lease'),
        afterPrimaryUnlink: () => barrier('unlink'),
      };
    case 'recover-alias-election':
      return {
        afterControllerLeaseCreate: () => barrier('lease'),
        beforePrimaryDetach: () => barrier('detach'),
        afterPrimaryUnlink: () => barrier('unlink'),
      };
  }
}

function run(mode: WorkerMode, root: string, out: string, ready: string, release: string): void {
  if (mode === 'hold') {
    exportInspirationArtifact({
      root,
      out,
      assertArtifact: () => waitForRelease(ready, release),
    });
    return;
  }

  const barrier = (phase?: 'lease' | 'detach' | 'unlink'): void => {
    const suffix = phase === undefined ? '' : `.${phase}`;
    waitForRelease(`${ready}${suffix}`, `${release}${suffix}`);
  };
  const result = recoverStaleInspirationExportLock({
    root,
    out,
    now: () => new Date('2026-08-12T20:00:00.000Z'),
    retirement: { hooks: recoveryHooks(mode, barrier) },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  const [modeArg, root, out, ready, release, ...unexpected] = process.argv.slice(2);
  const mode = parseMode(modeArg);
  if (unexpected.length !== 0) throw new Error('unexpected worker arguments');
  run(
    mode,
    required(root, 'root'),
    required(out, 'out'),
    required(ready, 'ready marker'),
    required(release, 'release marker'),
  );
  process.stdout.write('released\n');
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
  process.exitCode = 1;
}
