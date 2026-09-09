import { mkdirSync, readdirSync, statSync, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { retirementControllerScopePath } from '../../src/cooperative-lock.ts';

const RETIREMENT_SCOPE_NAME = /^\.onbrand-retire-[0-9a-f]{64}\.d$/;

export interface ControllerScopeBinding {
  parentIdentity: Pick<BigIntStats, 'dev' | 'ino'>;
  sourceIdentity: Pick<BigIntStats, 'dev' | 'ino'>;
}

/** Capture the physical identities used by the production scope-v2 contract. */
export function controllerScopeBinding(lockPath: string): ControllerScopeBinding {
  return {
    parentIdentity: statSync(path.dirname(lockPath), { bigint: true }),
    sourceIdentity: statSync(lockPath, { bigint: true }),
  };
}

export function controllerScopePath(
  lockPath: string,
  sourceToken: string,
  binding: ControllerScopeBinding,
): string {
  return retirementControllerScopePath(
    path.dirname(lockPath),
    binding.parentIdentity,
    binding.sourceIdentity,
    sourceToken,
  );
}

/** Create the identity-bound controller scope, then return its lease path. */
export function prepareControllerLeasePath(
  lockPath: string,
  sourceToken: string,
  controllerId: string,
  binding: ControllerScopeBinding,
): string {
  const scope = controllerScopePath(lockPath, sourceToken, binding);
  mkdirSync(scope, { recursive: true });
  return path.join(scope, `${controllerId}.lease`);
}

export function controllerLeaseBytes(
  sourceToken: string,
  controllerId: string,
  pid: number,
): string {
  return `${JSON.stringify({
    sourceToken,
    controllerId,
    pid,
    startedAt: '2026-08-12T19:30:00.000Z',
  })}\n`;
}

export function controllerScopePaths(lockPath: string): string[] {
  const parent = path.dirname(lockPath);
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RETIREMENT_SCOPE_NAME.test(entry.name))
    .map((entry) => path.join(parent, entry.name))
    .sort();
}

export function controllerLeasePaths(lockPath: string): string[] {
  return controllerScopePaths(lockPath)
    .flatMap((scope) =>
      readdirSync(scope, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.lease'))
        .map((entry) => path.join(scope, entry.name))
    )
    .sort();
}
