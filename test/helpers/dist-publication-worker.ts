/**
 * Real-process holder for the brand/dist publication lock.
 *
 * Tests coordinate through filesystem markers because the production barrier
 * hooks are synchronous. The worker publishes `ready`, then performs a bounded
 * poll for `release` while a named production callback is paused before
 * manifest publication or before specimen staging. Atomics.wait backs off the
 * filesystem poll; marker files, not timing, remain the deterministic
 * synchronization authority.
 */

import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { compileBrand, computeBrandSourceHash } from '../../src/build/compile.ts';
import { acquireDistPublicationLock } from '../../src/build/publication-lock.ts';
import { recordSpecimenView } from '../../src/inspiration/views.ts';
import { generatePreview } from '../../src/preview/specimen.ts';

type WorkerMode =
  | 'compile'
  | 'record'
  | 'preview'
  | 'lock'
  | 'lock-mode'
  | 'lock-release-after-lease'
  | 'lock-release-after-unlink';

const WAIT_LIMIT_MS = 30_000;
const POLL_BACKOFF = new Int32Array(new SharedArrayBuffer(4));

function requiredArg(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

function parseWorkerMode(value: string | undefined): WorkerMode {
  if (value === undefined || value === '') throw new Error('missing worker mode');
  switch (value) {
    case 'compile':
    case 'record':
    case 'preview':
    case 'lock':
    case 'lock-mode':
    case 'lock-release-after-lease':
    case 'lock-release-after-unlink':
      return value;
    default:
      throw new Error(`unknown worker mode ${JSON.stringify(value)}`);
  }
}

function unreachableWorkerMode(value: never): never {
  throw new Error(`unreachable worker mode ${JSON.stringify(value)}`);
}

function holdAtBarrier(readyPath: string, releasePath: string): void {
  writeFileSync(readyPath, `${process.pid}\n`, { flag: 'wx' });
  const deadline = Date.now() + WAIT_LIMIT_MS;
  while (!existsSync(releasePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for release marker ${releasePath}`);
    }
    Atomics.wait(POLL_BACKOFF, 0, 0, 10);
  }
}

function run(
  mode: WorkerMode,
  projectDir: string,
  readyPath: string,
  releasePath: string,
): void {
  const barrier = (): void => holdAtBarrier(readyPath, releasePath);
  switch (mode) {
    case 'compile': {
      const result = compileBrand(projectDir, { beforeManifestRename: barrier });
      process.stdout.write(`${JSON.stringify({ mode, sourceHash: result.manifest.sourceHash })}\n`);
      return;
    }
    case 'record': {
      const preview = generatePreview(projectDir);
      const recorded = recordSpecimenView(
        projectDir,
        preview.generation,
        computeBrandSourceHash(projectDir).sourceHash,
        { required: true, beforeManifestRename: barrier },
      );
      process.stdout.write(`${JSON.stringify({ mode, recorded })}\n`);
      return;
    }
    case 'preview': {
      const preview = generatePreview(projectDir, { beforeSpecimenStage: barrier });
      const recorded = recordSpecimenView(
        projectDir,
        preview.generation,
        computeBrandSourceHash(projectDir).sourceHash,
      );
      process.stdout.write(`${JSON.stringify({ mode, recorded })}\n`);
      return;
    }
    case 'lock': {
      const lock = acquireDistPublicationLock(projectDir);
      let released = false;
      try {
        barrier();
      } finally {
        released = lock.release();
      }
      process.stdout.write(`${JSON.stringify({ mode, released })}\n`);
      if (!released) throw new Error('publication-lock worker no longer owned the lock at release');
      return;
    }
    case 'lock-release-after-lease':
    case 'lock-release-after-unlink': {
      const lock = acquireDistPublicationLock(projectDir, {
        retirement: {
          hooks: mode === 'lock-release-after-lease'
            ? { afterControllerLeaseCreate: barrier }
            : { afterPrimaryUnlink: barrier },
        },
      });
      const released = lock.release();
      process.stdout.write(`${JSON.stringify({ mode, released })}\n`);
      if (!released) throw new Error('publication-lock crash worker could not release its lock');
      return;
    }
    case 'lock-mode': {
      // This process-local mutation cannot race Vitest workers. A maximally
      // restrictive umask proves the production lock and its retirement scope
      // apply final POSIX modes through owned descriptors.
      process.umask(0o777);
      let lockPath = '';
      let controllerScopeMode: number | undefined;
      const lock = acquireDistPublicationLock(projectDir, {
        retirement: {
          hooks: {
            afterControllerLeaseCreate: () => {
              const parent = path.dirname(requiredArg(lockPath, 'publication lock path'));
              const scopes = readdirSync(parent, { withFileTypes: true })
                .filter((entry) => entry.isDirectory() && /^\.onbrand-retire-[0-9a-f]{64}\.d$/.test(entry.name));
              if (scopes.length !== 1) throw new Error(`expected one retirement scope, found ${scopes.length}`);
              controllerScopeMode = statSync(path.join(parent, scopes[0]!.name)).mode & 0o777;
            },
          },
        },
      });
      lockPath = lock.path;
      const fileMode = statSync(lock.path).mode & 0o777;
      const released = lock.release();
      process.stdout.write(`${JSON.stringify({ mode, fileMode, controllerScopeMode, released })}\n`);
      if (!released) throw new Error('publication-lock mode worker could not release its lock');
      return;
    }
    default:
      return unreachableWorkerMode(mode);
  }
}

try {
  const [modeValue, projectValue, readyValue, releaseValue, ...unexpected] = process.argv.slice(2);
  const mode = parseWorkerMode(modeValue);
  if (unexpected.length !== 0) throw new Error('unexpected worker arguments');
  run(
    mode,
    requiredArg(projectValue, 'project directory'),
    requiredArg(readyValue, 'ready marker'),
    requiredArg(releaseValue, 'release marker'),
  );
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
  process.exitCode = 1;
}
