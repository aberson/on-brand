/**
 * Step 6 acceptance for `onbrand preview` (plan §6 Done-when): "Playwright loads
 * it from a file:// path, toggles data-theme, screenshots both modes with no
 * console errors." Everything here runs through the PRODUCTION entry point
 * (spawn `node bin/onbrand.mjs ...`), exactly what package.json "bin" points at.
 *
 * Two describes:
 *   1. CLI contract (always runs, no browser): exit codes §6 — preview before
 *      build (and on a PARTIAL dist) errors exit 1 naming the missing files
 *      with the "onbrand build" hint; a successful run writes specimen.html;
 *      help/usage exits; and a REAL-output zero-literal grep gate via the
 *      SHARED scanner in test/helpers/color-literals.ts (the fenced
 *      diagram-palette island excluded).
 *   2. Real-browser render (runIf Chromium present): load file://, assert zero
 *      console/page errors, the toggle FLIPS the body's computed background-color
 *      (click AND keyboard, proving a11y), and both modes screenshot non-blank +
 *      visibly different. One browser launch, reused.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../src/cli.ts';
import { findColorLiterals, stripDiagramFence } from './helpers/color-literals.ts';

const BIN = fileURLToPath(new URL('../bin/onbrand.mjs', import.meta.url));

// --- Chromium availability probe (module top-level, like svg.e2e) ------------

const require = createRequire(import.meta.url);
let chromium: typeof import('playwright').chromium | undefined;
let hasChromium = false;
let skipReason = '';
try {
  ({ chromium } = require('playwright') as typeof import('playwright'));
  const exe = chromium.executablePath();
  hasChromium = existsSync(exe);
  if (!hasChromium) skipReason = `chromium binary not found at ${exe}`;
} catch (e) {
  skipReason = `playwright unavailable: ${e instanceof Error ? e.message : String(e)}`;
}
if (!hasChromium) {
  console.warn(
    `[preview.e2e] WARNING: SKIPPING the specimen render test — ${skipReason}. ` +
      'Install with `npm i -D playwright` + `npx playwright install chromium`. ' +
      'On the build machine Chromium IS expected present — this test must actually run there.',
  );
}

// --- shared temp projects ----------------------------------------------------

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-preview-'));
  tempDirs.push(dir);
  return dir;
}
function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

let builtProject: string | undefined;
/** init + build (all emitters) once; shared across tests. */
function initAndBuild(): string {
  if (builtProject !== undefined) return builtProject;
  const dir = tempDir();
  expect(runCli(['init', dir]).status).toBe(EXIT_OK);
  expect(runCli(['build', dir]).status).toBe(EXIT_OK);
  builtProject = dir;
  return dir;
}

let browser: import('playwright').Browser | undefined;
beforeAll(async () => {
  if (hasChromium && chromium !== undefined) browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  if (browser !== undefined) await browser.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('onbrand preview — CLI contract (spawned through bin/onbrand.mjs)', () => {
  it('before build: exits 1 with the "run onbrand build first" hint', () => {
    const dir = tempDir();
    expect(runCli(['init', dir]).status).toBe(EXIT_OK); // init only, no build
    const run = runCli(['preview', dir]);
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).toContain('onbrand build');
    expect(existsSync(path.join(dir, 'brand', 'dist', 'specimen.html'))).toBe(false);
  }, 30_000);

  it('partial dist (--emit css only): exits 1 NAMING the missing dist files', () => {
    // Regression pin for REQUIRED_DIST_FILES: a dist that has tokens.css but
    // not the other required outputs must be rejected exactly like no dist.
    const dir = tempDir();
    expect(runCli(['init', dir]).status).toBe(EXIT_OK);
    expect(runCli(['build', dir, '--emit', 'css']).status).toBe(EXIT_OK);
    const run = runCli(['preview', dir]);
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).toContain('components.css');
    expect(run.stderr).toContain('diagram-palette.json');
    expect(run.stderr).not.toContain('missing tokens.css'); // the present file is not named missing
    expect(run.stderr).toContain('onbrand build');
    expect(existsSync(path.join(dir, 'brand', 'dist', 'specimen.html'))).toBe(false);
  });

  it('after build: exits 0 and writes brand/dist/specimen.html', () => {
    const dir = initAndBuild();
    const run = runCli(['preview', dir]);
    expect(run.status).toBe(EXIT_OK);
    expect(run.stdout).toContain('Wrote');
    expect(existsSync(path.join(dir, 'brand', 'dist', 'specimen.html'))).toBe(true);
  });

  it('the REAL generated specimen.html has zero authored color literals (grep gate)', () => {
    const dir = initAndBuild();
    expect(runCli(['preview', dir]).status).toBe(EXIT_OK);
    const html = readFileSync(path.join(dir, 'brand', 'dist', 'specimen.html'), 'utf8');
    const authored = findColorLiterals(stripDiagramFence(html));
    expect(authored, `authored literals: ${authored.join(', ')}`).toEqual([]);
    // the fence really did carry dist-sourced values (default preset diagram canvas)
    expect(findColorLiterals(html).length).toBeGreaterThan(0);
    // it links the sibling dist stylesheets rather than inlining them
    expect(html).toContain('<link rel="stylesheet" href="tokens.css">');
    expect(html).toContain('<link rel="stylesheet" href="components.css">');
  });

  it('preview does not break a subsequent `onbrand check` (extra dist file ok)', () => {
    const dir = initAndBuild();
    expect(runCli(['preview', dir]).status).toBe(EXIT_OK);
    const run = runCli(['check', dir]);
    expect(run.status).toBe(EXIT_OK);
    expect(run.stderr).toContain('check PASS');
  });

  it('--help exits 0 and documents --open', () => {
    const run = runCli(['preview', '--help']);
    expect(run.status).toBe(EXIT_OK);
    expect(run.stdout).toContain('--open');
  });

  it('rejects an unknown flag with exit 2', () => {
    const run = runCli(['preview', initAndBuild(), '--nope']);
    expect(run.status).toBe(EXIT_USAGE);
    expect(run.stderr).toContain('--nope');
  });

  it('rejects an extra positional argument with exit 2', () => {
    const run = runCli(['preview', tempDir(), 'extra-arg']);
    expect(run.status).toBe(EXIT_USAGE);
    expect(run.stderr).toContain('unexpected extra argument');
  });
});

describe('onbrand preview — real-browser render + light/dark toggle', () => {
  it.runIf(hasChromium)(
    'loads file://, no console errors, toggle (click + keyboard) flips body bg, both modes non-blank',
    async () => {
      const dir = initAndBuild();
      expect(runCli(['preview', dir]).status).toBe(EXIT_OK);
      const specimenPath = path.join(dir, 'brand', 'dist', 'specimen.html');
      const url = pathToFileURL(specimenPath).href;

      const page = await browser!.newPage();
      // The specimen now links a Google Fonts stylesheet for the mapped families
      // (default preset: Inter/Manrope/JetBrains Mono). Fulfil it locally so this
      // hermetic render test never depends on the network — an offline fetch
      // would surface as a console error and flake the zero-error assertion.
      await page.route('https://fonts.googleapis.com/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/css', body: '/* stubbed webfont css */' }),
      );
      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      page.on('pageerror', (e) => consoleErrors.push(e.message));

      try {
        await page.goto(url, { waitUntil: 'load' });

        // no console / page errors on load
        expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);

        // sanity: linked stylesheets actually applied (a token-driven bg, not default white)
        // Browser globals reached via `globalThis as any` so this Node-typed file
        // needs no DOM lib (same pattern as svg.e2e.test.ts).
        const bodyBg = () =>
          page.evaluate(() => {
            const g = globalThis as any;
            return g.getComputedStyle(g.document.body).backgroundColor as string;
          });
        const currentTheme = () =>
          page.evaluate(() => (globalThis as any).document.documentElement.getAttribute('data-theme') as string | null);

        const bgLight = await bodyBg();
        expect(bgLight).not.toBe('');
        expect(await currentTheme()).toBe('light');

        const shotLight = await page.screenshot();

        // --- toggle via CLICK ---
        await page.click('#theme-toggle');
        expect(await currentTheme()).toBe('dark');
        const bgDark = await bodyBg();
        expect(bgDark, 'body background did not change between light and dark').not.toBe(bgLight);

        const shotDark = await page.screenshot();

        // both modes painted something and differ (non-blank + theme actually applied)
        expect(shotLight.length).toBeGreaterThan(1000);
        expect(shotDark.length).toBeGreaterThan(1000);
        expect(Buffer.compare(shotLight, shotDark), 'light and dark screenshots are identical').not.toBe(0);

        // --- toggle back via KEYBOARD (a11y: native button responds to Enter) ---
        await page.focus('#theme-toggle');
        await page.keyboard.press('Enter');
        expect(await currentTheme()).toBe('light');
        expect(await bodyBg()).toBe(bgLight);

        // still no console errors after interaction
        expect(consoleErrors, `console errors after toggle: ${consoleErrors.join(' | ')}`).toEqual([]);
      } finally {
        await page.close();
      }
    },
    120_000,
  );
});
