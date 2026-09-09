/** Production-main worker with a deterministic paired catalog refresh barrier. */

import { existsSync, writeFileSync } from 'node:fs';
import { main } from '../../src/cli.ts';

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

try {
  const [readyArg, releaseArg, ...cliArgv] = process.argv.slice(2);
  const ready = required(readyArg, 'ready marker');
  const release = required(releaseArg, 'release marker');
  if (cliArgv.length === 0) throw new Error('missing CLI argv');
  process.exitCode = await main(cliArgv, {
    beforeFromImageCatalogRefresh: () => waitForRelease(ready, release),
  });
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
  process.exitCode = 1;
}
