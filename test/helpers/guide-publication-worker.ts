/** Real-process build holder paused after guide staging and before publication. */

import { existsSync, writeFileSync } from 'node:fs';
import { compileBrand } from '../../src/build/compile.ts';

const WAIT_LIMIT_MS = 30_000;
const POLL = new Int32Array(new SharedArrayBuffer(4));

function requiredArg(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

function holdBeforeGuide(readyPath: string, releasePath: string): void {
  writeFileSync(readyPath, `${process.pid}\n`, { flag: 'wx' });
  const deadline = Date.now() + WAIT_LIMIT_MS;
  while (!existsSync(releasePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for release marker ${releasePath}`);
    }
    Atomics.wait(POLL, 0, 0, 10);
  }
}

try {
  const [projectValue, readyValue, releaseValue] = process.argv.slice(2);
  const projectDir = requiredArg(projectValue, 'project directory');
  const readyPath = requiredArg(readyValue, 'ready marker');
  const releasePath = requiredArg(releaseValue, 'release marker');
  const result = compileBrand(projectDir, {
    beforeGuideRename: () => holdBeforeGuide(readyPath, releasePath),
  });
  process.stdout.write(`${JSON.stringify({ sourceHash: result.manifest.sourceHash })}\n`);
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
  process.exitCode = 1;
}
