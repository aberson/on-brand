/**
 * Step 19 CLI-level tests for `onbrand preview --open` (and the shared gallery
 * opener) driven through the in-process `main()` with `openInBrowser` MOCKED —
 * no real browser is launched (Step 22 owns the real adopted-brand open).
 *
 * These complement two neighbours rather than duplicating them:
 *   - test/preview.e2e.test.ts spawns the REAL bin and covers exit codes,
 *     usage errors, and the zero-literal grep gate on generated output.
 *   - test/preview.specimen.test.ts unit-tests openInBrowser's command
 *     COMPOSITION + the onError seam against the injectable spawn.
 * Here we assert the CLI WIRING: `--open` invokes the opener with the absolute
 * specimen/gallery path and an onError callback; a launch failure is surfaced
 * as an `onbrand preview:` / `onbrand gallery:` diagnostic on stderr WITHOUT
 * changing the exit code (a page that wrote successfully must still exit 0);
 * and omitting `--open` never touches the opener. `openInBrowser` is mocked
 * while `generatePreview`/`generateGallery` stay real, so the produced HTML is
 * genuine but nothing spawns a browser.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { acquireDistPublicationLock } from '../src/build/publication-lock.ts';

// Mocked opener shared by both preview and gallery; hoisted so vi.mock can see it.
const { openSpy } = vi.hoisted(() => ({ openSpy: vi.fn() }));

vi.mock('../src/preview/specimen.ts', async (importActual) => {
  const actual = await importActual<typeof import('../src/preview/specimen.ts')>();
  return { ...actual, openInBrowser: openSpy };
});

const { EXIT_OK, EXIT_USAGE, main } = await import('../src/cli.ts');

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Run `main` with stdout/stderr captured (main writes through process streams). */
async function runMain(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const outSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown) => (outChunks.push(String(chunk)), true));
  const errSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown) => (errChunks.push(String(chunk)), true));
  try {
    const status = await main(args);
    return { status, stdout: outChunks.join(''), stderr: errChunks.join('') };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

let builtProject: string;
let galleryRoot: string;

beforeAll(async () => {
  // A real built project so generatePreview() produces a genuine specimen.html.
  builtProject = tempDir('onbrand-cli-preview-');
  expect((await runMain(['init', builtProject])).status).toBe(EXIT_OK);
  expect((await runMain(['build', builtProject])).status).toBe(EXIT_OK);

  // A workspace with one adopted brand for the gallery opener test.
  galleryRoot = tempDir('onbrand-cli-preview-ws-');
  const app = path.join(galleryRoot, 'app');
  expect((await runMain(['init', app])).status).toBe(EXIT_OK);
  expect((await runMain(['build', app])).status).toBe(EXIT_OK);
}, 120_000);

afterEach(() => {
  openSpy.mockReset();
});

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('onbrand preview --open (in-process main, opener mocked)', () => {
  it('invokes the opener once with the ABSOLUTE specimen path and an onError callback', async () => {
    const run = await runMain(['preview', builtProject, '--open']);
    expect(run.status).toBe(EXIT_OK);
    expect(openSpy).toHaveBeenCalledTimes(1);

    const [target, options] = openSpy.mock.calls[0] as [string, { onError?: unknown }];
    expect(path.isAbsolute(target)).toBe(true);
    expect(target.endsWith(path.join('brand', 'dist', 'specimen.html'))).toBe(true);
    expect(typeof options.onError).toBe('function');
    expect(run.stdout).toContain('Opening in your default browser');
  });

  it('WITHOUT --open never touches the opener', async () => {
    const run = await runMain(['preview', builtProject]);
    expect(run.status).toBe(EXIT_OK);
    expect(openSpy).not.toHaveBeenCalled();
    expect(run.stdout).toContain('Wrote');
    expect(run.stdout).not.toContain('Opening in your default browser');
  });

  it('a launch failure is surfaced as an `onbrand preview:` diagnostic WITHOUT changing exit 0', async () => {
    // Simulate the opener reporting a failure synchronously through its onError
    // seam (the real opener would fire this on the async spawn 'error' event).
    openSpy.mockImplementation((_target: string, options?: { onError?: (m: string) => void }) => {
      options?.onError?.('could not open <path> via powershell.exe Start-Process: spawn powershell.exe ENOENT');
    });
    const run = await runMain(['preview', builtProject, '--open']);
    expect(run.status).toBe(EXIT_OK); // opener failure must NOT fail a successful write
    expect(run.stderr).toContain('onbrand preview:');
    expect(run.stderr).toContain('could not open');
    expect(run.stderr).toContain('ENOENT');
    // and the success line still printed
    expect(run.stdout).toContain('Wrote');
  });

  it('publication contention warns with remediation but still writes, opens, and exits 0', async () => {
    const project = tempDir('onbrand-cli-preview-busy-');
    expect((await runMain(['init', project])).status).toBe(EXIT_OK);
    expect((await runMain(['build', project])).status).toBe(EXIT_OK);
    const lock = acquireDistPublicationLock(project);
    try {
      const run = await runMain(['preview', project, '--open']);
      expect(run.status).toBe(EXIT_OK);
      expect(run.stdout).toContain('Wrote');
      expect(run.stdout).toContain('Opening in your default browser');
      expect(run.stderr).toContain(
        'onbrand preview: warning: specimen.html is usable, but its provenance refresh failed.',
      );
      expect(run.stderr).toContain('onbrand preview: remediation:');
      const argvLines = run.stderr.split('\n').filter((line) => line.includes('remediation argv ('));
      expect(argvLines).toHaveLength(2);
      const displayed = argvLines.map((line) => JSON.parse(line.slice(line.indexOf('['))) as string[]);
      expect(displayed.map((argv) => argv.slice(2))).toEqual([
        ['build', project],
        ['preview', project],
      ]);
      expect(displayed.every((argv) => argv[1]!.endsWith(path.join('bin', 'onbrand.mjs')))).toBe(true);
      expect(openSpy).toHaveBeenCalledTimes(1);
    } finally {
      expect(lock.release()).toBe(true);
    }
  });

  it('rejects an unknown flag with exit 2 and never opens (existing compatibility)', async () => {
    const run = await runMain(['preview', builtProject, '--nope']);
    expect(run.status).toBe(EXIT_USAGE);
    expect(run.stderr).toContain('--nope');
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe('onbrand gallery --open reuses the same opener seam', () => {
  it('invokes the opener with the ABSOLUTE gallery path and an onError callback', async () => {
    const run = await runMain(['gallery', '--root', galleryRoot, '--open']);
    expect(run.status).toBe(EXIT_OK);
    expect(openSpy).toHaveBeenCalledTimes(1);

    const [target, options] = openSpy.mock.calls[0] as [string, { onError?: unknown }];
    expect(path.isAbsolute(target)).toBe(true);
    expect(target.endsWith('.html')).toBe(true);
    expect(typeof options.onError).toBe('function');
    expect(run.stdout).toContain('Opening in your default browser');
  });

  it('surfaces a launch failure as an `onbrand gallery:` diagnostic WITHOUT changing exit 0', async () => {
    openSpy.mockImplementation((_target: string, options?: { onError?: (m: string) => void }) => {
      options?.onError?.('could not open <path> via xdg-open: spawn xdg-open ENOENT');
    });
    const run = await runMain(['gallery', '--root', galleryRoot, '--open']);
    expect(run.status).toBe(EXIT_OK);
    expect(run.stderr).toContain('onbrand gallery:');
    expect(run.stderr).toContain('could not open');
  });
});
