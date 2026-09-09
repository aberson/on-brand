/**
 * Step 8 acceptance for `src/eval/capture.ts` (Brand-Fidelity plan §5, #37):
 * "for a given site it writes both PNGs headlessly; a test asserts both files
 * exist and are non-empty." Extended per a code-review + anchor-skeptic pass
 * that found the original suite's "no live network" claim EMPIRICALLY
 * REFUTED (see "hermeticity" below) plus several under-tested paths.
 *
 * ------------------------------------------------------------- hermeticity ---
 * The real generated `brand/dist/specimen.html` (default preset) contains a
 * genuine `<link>` to `https://fonts.googleapis.com/...` — navigating to it
 * with NO guard fires real outbound HTTPS requests. The acceptance test below
 * does NOT merely avoid touching `http(s)://` targets (the earlier, refuted
 * claim); it installs an explicit hermetic `beforeGoto` guard via
 * `CaptureOptions.beforeGoto` (a catch-all `page.route('**\/*', ...)` that lets
 * `file://` navigation through and fulfils every OTHER request locally, never
 * dispatching it to a real server — Playwright guarantees a `route.fulfill()`
 * response never touches the network, regardless of what the `request` event
 * observed) and then ENFORCES hermeticity with an assertion: every observed
 * non-`file://` request must be one of the two known Google Fonts hosts (a
 * failure here would mean either an unexpected third-party host leaked
 * through, or — the "not vacuous" sanity leg — that the real specimen somehow
 * stopped referencing fonts at all, which would mean the assertion is no
 * longer exercising the bug it exists to catch). This is the exact wiring
 * `test/preview.e2e.test.ts` already relies on for the same reason (its own
 * `page.route('https://fonts.googleapis.com/**', ...)` stub, there scoped to
 * one host) — `capture.ts`'s `beforeGoto` hook is what makes that pattern
 * reusable outside a hand-rolled `beforeAll`.
 *
 * PRODUCTION note: `beforeGoto`/blocking is OFF by default (see
 * `capture.ts`'s file header) — Step 9's vision-judge needs the specimen's
 * REAL webfonts rendered to score mood/type honestly, so nothing in
 * `capture.ts` itself blocks external requests; only this TEST opts in.
 *
 * ------------------------------------------------------------- no REMOTE host ---
 * Separately, this file also exercises the `http(s)://` capture path for
 * real (Step 8's stated primary purpose — the live source-shot path Step 9
 * will use per corpus site) — but ONLY against a `node:http` server bound to
 * `127.0.0.1:0` from THIS process (mirrors `test/from-url.e2e.test.ts`'s own
 * `serveSite()` idiom), never a real remote URL. A short `timeoutMs` is also
 * proven to actually reject against a deliberately-hanging local handler.
 *
 * ------------------------------------------------------------- Chromium probe ---
 * Same top-level availability probe + `it.runIf(hasChromium)` skip pattern as
 * `test/preview.e2e.test.ts` / `test/svg.e2e.test.ts` (loud console.warn on
 * skip; expected present on the build machine).
 *
 * ---------------------------------------------------------- output location ---
 * All PNGs this suite writes go under `os.tmpdir()` (via `mkdtempSync`) —
 * entirely outside the repo tree, so nothing test-generated is ever committed
 * (no `.gitignore` entry needed; the location is not inside the repo at all).
 * Temp dirs are removed in `afterAll`.
 */

import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { EXIT_OK } from '../src/cli.ts';
import {
  DEFAULT_VIEWPORT,
  captureScreenshot,
  captureSitePair,
  fileUrlFromPath,
  isNonEmptyPng,
} from '../src/eval/capture.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO_ROOT, 'bin', 'onbrand.mjs');
const FIXTURE_SITE_INDEX = path.join(REPO_ROOT, 'test', 'fixtures', 'site', 'index.html');
/** A real, already-committed PNG (no Chromium/network needed) — proves `isNonEmptyPng`'s true path independently of this file's own capture calls. */
const COMMITTED_REAL_PNG = path.join(
  REPO_ROOT,
  'docs',
  'findings',
  'eval-raw-extractions',
  'benchmark',
  'basecamp.viewport.png',
);

// --- Chromium availability probe (same idiom as preview.e2e.test.ts) --------

const require = createRequire(import.meta.url);
let chromiumModule: typeof import('playwright') | undefined;
let hasChromium = false;
let skipReason = '';
try {
  chromiumModule = require('playwright') as typeof import('playwright');
  const exe = chromiumModule.chromium.executablePath();
  hasChromium = existsSync(exe);
  if (!hasChromium) skipReason = `chromium binary not found at ${exe}`;
} catch (e) {
  skipReason = `playwright unavailable: ${e instanceof Error ? e.message : String(e)}`;
}
if (!hasChromium) {
  console.warn(
    `[eval.capture.e2e] WARNING: SKIPPING the capture tests — ${skipReason}. ` +
      'Install with `npm i -D playwright` + `npx playwright install chromium`. ' +
      'On the build machine Chromium IS expected present — these tests must actually run there.',
  );
}

// --- shared temp dirs ---------------------------------------------------------

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-capture-'));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

let builtSpecimenPath: string | undefined;
/** init + build + preview once (spawned CLI, mirrors preview.e2e.test.ts's initAndBuild), shared across tests: produces a REAL brand/dist/specimen.html (default preset — genuinely references Google Fonts). */
function realSpecimenPath(): string {
  if (builtSpecimenPath !== undefined) return builtSpecimenPath;
  const dir = tempDir();
  expect(runCli(['init', dir]).status).toBe(EXIT_OK);
  expect(runCli(['build', dir]).status).toBe(EXIT_OK);
  expect(runCli(['preview', dir]).status).toBe(EXIT_OK);
  const specimenPath = path.join(dir, 'brand', 'dist', 'specimen.html');
  expect(existsSync(specimenPath)).toBe(true);
  builtSpecimenPath = specimenPath;
  return specimenPath;
}

/** Decode a PNG's IHDR chunk (BEHAVIORAL check — the real pixel dimensions Chromium wrote, not a re-assertion of a config literal). PNG layout: 8-byte signature, then a 4-byte chunk length + 4-byte "IHDR" type (bytes 8..16), then the IHDR payload whose first 8 bytes are width/height as big-endian uint32 (bytes 16..24). */
function pngDimensions(filePath: string): { width: number; height: number } {
  const buf = readFileSync(filePath);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** A `node:http` server on an ephemeral 127.0.0.1 port — mirrors `test/from-url.e2e.test.ts`'s own `serveSite()` idiom. NEVER a real remote host. */
function serveOnce(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

/**
 * Installs the hermetic guard used by the acceptance test below: `file://`
 * navigation passes through untouched; every OTHER (non-`file://`) request is
 * fulfilled locally (never reaches a real server) and its URL is recorded so
 * the test can assert on exactly what would have gone out over the wire.
 */
function installHermeticGuard(): {
  externalRequests: string[];
  beforeGoto: (page: import('playwright').Page) => Promise<void>;
} {
  const externalRequests: string[] = [];
  const beforeGoto = async (page: import('playwright').Page): Promise<void> => {
    page.on('request', (req) => {
      const url = req.url();
      if (!url.startsWith('file://')) externalRequests.push(url);
    });
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith('file://')) {
        await route.continue();
        return;
      }
      // Fulfilled IN-PROCESS — never dispatched to a real server, whatever
      // the host. Broader than a two-host allowlist on purpose (a future
      // template change referencing a different CDN is still caught, not
      // silently allowed through) — the test asserts the OBSERVED hosts are
      // exactly the expected Google Fonts pair, so an unexpected host still
      // fails loud even though it was also safely intercepted here.
      await route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    });
  };
  return { externalRequests, beforeGoto };
}

// ---------------------------------------------------------------------------

describe('isNonEmptyPng — garbage anchors (measurement-validity: a check that cannot fail garbage cannot gate)', () => {
  it('a real committed PNG passes (true path — no Chromium/network needed)', () => {
    expect(existsSync(COMMITTED_REAL_PNG), 'sanity: the fixture PNG itself exists').toBe(true);
    expect(isNonEmptyPng(COMMITTED_REAL_PNG)).toBe(true);
  });

  it('a 0-byte file is NOT a valid PNG', () => {
    const empty = path.join(tempDir(), 'empty.png');
    writeFileSync(empty, Buffer.alloc(0));
    expect(isNonEmptyPng(empty)).toBe(false);
  });

  it('a non-PNG file (plain text, no magic header) is NOT a valid PNG', () => {
    const notPng = path.join(tempDir(), 'not-a-png.png');
    writeFileSync(notPng, 'this is definitely not a png file\n', 'utf8');
    expect(isNonEmptyPng(notPng)).toBe(false);
  });

  it('a nonexistent path is NOT a valid PNG', () => {
    expect(isNonEmptyPng(path.join(tempDir(), 'does-not-exist.png'))).toBe(false);
  });
});

describe('capture.ts — headless screenshot capture (Step 8, #37)', () => {
  it('fileUrlFromPath builds a file:// URL from an absolute path', () => {
    const url = fileUrlFromPath(FIXTURE_SITE_INDEX);
    expect(url.startsWith('file://')).toBe(true);
    expect(url).toContain('index.html');
  });

  it.runIf(hasChromium)(
    'captureSitePair writes BOTH a source PNG and a specimen PNG headlessly, with hermeticity ENFORCED by assertion (not just claimed)',
    async () => {
      const specimenPath = realSpecimenPath();
      const outDir = tempDir();
      const sourcePath = path.join(outDir, 'source.png');
      const specimenOut = path.join(outDir, 'specimen.png');
      const guard = installHermeticGuard();

      const result = await captureSitePair(
        fileUrlFromPath(FIXTURE_SITE_INDEX), // "source" stand-in: local static fixture site
        fileUrlFromPath(specimenPath), // "specimen": the REAL generated specimen.html
        { sourcePath, specimenPath: specimenOut },
        { beforeGoto: guard.beforeGoto },
      );

      // both PNGs exist and are non-empty (the acceptance criterion)
      expect(existsSync(sourcePath)).toBe(true);
      expect(existsSync(specimenOut)).toBe(true);
      expect(statSync(sourcePath).size).toBeGreaterThan(0);
      expect(statSync(specimenOut).size).toBeGreaterThan(0);

      // and each is a genuinely valid PNG (magic-header check), not just an
      // arbitrary non-empty file
      expect(isNonEmptyPng(sourcePath)).toBe(true);
      expect(isNonEmptyPng(specimenOut)).toBe(true);

      expect(result.source.outputPath).toBe(path.resolve(sourcePath));
      expect(result.specimen.outputPath).toBe(path.resolve(specimenOut));

      // HERMETICITY, ENFORCED (review fix): the real specimen genuinely DOES
      // reference an external font host (this leg would fail if it stopped
      // doing so, proving the assertion below isn't vacuous)...
      expect(
        guard.externalRequests.length,
        'sanity: the real specimen should reference an external font host — if this is 0, the hermeticity assertion below is vacuous',
      ).toBeGreaterThan(0);
      // ...and EVERY one of those requests was intercepted by our guard and
      // fulfilled in-process (never dispatched to a real server) — asserted
      // by checking the observed set is EXACTLY the expected Google Fonts
      // pair. Any other host appearing here would mean either an unexpected
      // leak or a specimen template change this guard doesn't yet cover.
      const unexpected = guard.externalRequests.filter(
        (u) => !u.startsWith('https://fonts.googleapis.com/') && !u.startsWith('https://fonts.gstatic.com/'),
      );
      expect(unexpected, `unexpected external host(s) observed: ${unexpected.join(', ')}`).toEqual([]);
    },
    60_000,
  );

  it.runIf(hasChromium)(
    'captureScreenshot writes a single non-empty, valid PNG for a file:// target',
    async () => {
      const outputPath = path.join(tempDir(), 'single.png');
      const result = await captureScreenshot(fileUrlFromPath(FIXTURE_SITE_INDEX), outputPath);

      expect(existsSync(outputPath)).toBe(true);
      expect(statSync(outputPath).size).toBeGreaterThan(0);
      expect(isNonEmptyPng(outputPath)).toBe(true);
      expect(result.outputPath).toBe(path.resolve(outputPath));
    },
    30_000,
  );

  it.runIf(hasChromium)(
    'auto-creates a genuinely nonexistent NESTED output directory',
    async () => {
      const outDir = tempDir();
      const nestedOut = path.join(outDir, 'a', 'b', 'c', 'nested.png');
      expect(existsSync(path.dirname(nestedOut)), 'sanity: the nested dir must not already exist').toBe(false);

      await captureScreenshot(fileUrlFromPath(FIXTURE_SITE_INDEX), nestedOut);

      expect(existsSync(nestedOut)).toBe(true);
      expect(isNonEmptyPng(nestedOut)).toBe(true);
    },
    30_000,
  );

  it.runIf(hasChromium)(
    'the captured PNG pixel dimensions ACTUALLY match the configured viewport (behavioral — decodes the real IHDR chunk, not a re-assertion of the literal)',
    async () => {
      const outDir = tempDir();

      const defaultOut = path.join(outDir, 'default-viewport.png');
      await captureScreenshot(fileUrlFromPath(FIXTURE_SITE_INDEX), defaultOut);
      expect(pngDimensions(defaultOut)).toEqual(DEFAULT_VIEWPORT);

      const customViewport = { width: 800, height: 600 };
      const customOut = path.join(outDir, 'custom-viewport.png');
      await captureScreenshot(fileUrlFromPath(FIXTURE_SITE_INDEX), customOut, { viewport: customViewport });
      expect(pngDimensions(customOut)).toEqual(customViewport);

      // sanity: the override genuinely changed the rendered size (not a
      // fixed/ignored screenshot dimension)
      expect(pngDimensions(customOut)).not.toEqual(pngDimensions(defaultOut));
    },
    30_000,
  );

  it.runIf(hasChromium)(
    'captures a real http:// target — a node:http server on 127.0.0.1 (LOCAL only, never a remote host); this is the live-URL path Step 9 uses for source shots',
    async () => {
      const { server, port } = await serveOnce((_req, res) => {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><html><body style="background:#123456"><h1>hermetic localhost fixture</h1></body></html>');
      });
      try {
        const outputPath = path.join(tempDir(), 'localhost.png');
        const target = `http://127.0.0.1:${port}/`;
        const result = await captureScreenshot(target, outputPath);

        expect(existsSync(outputPath)).toBe(true);
        expect(isNonEmptyPng(outputPath)).toBe(true);
        expect(result.target).toBe(target);
      } finally {
        server.close();
      }
    },
    30_000,
  );

  it.runIf(hasChromium)(
    'a short timeoutMs actually REJECTS against a deliberately-hanging local handler (never a real remote host)',
    async () => {
      const { server, port } = await serveOnce(() => {
        // Deliberately never responds — forces page.goto to hit its own
        // navigation timeout rather than resolving.
      });
      try {
        const outputPath = path.join(tempDir(), 'never-written-timeout.png');
        await expect(
          captureScreenshot(`http://127.0.0.1:${port}/`, outputPath, { timeoutMs: 500 }),
        ).rejects.toThrow();
        expect(existsSync(outputPath)).toBe(false);
      } finally {
        server.close();
      }
    },
    15_000,
  );

  it.runIf(hasChromium)(
    'always closes the browser, even when the capture throws (no leaked Chromium)',
    async () => {
      const outDir = tempDir();
      const closeSpy = vi.fn();
      const realLaunch = chromiumModule!.chromium.launch.bind(chromiumModule!.chromium);
      vi.spyOn(chromiumModule!.chromium, 'launch').mockImplementation(async (opts) => {
        const browser = await realLaunch(opts);
        const realClose = browser.close.bind(browser);
        browser.close = (async (...closeArgs: Parameters<typeof browser.close>) => {
          closeSpy();
          return realClose(...closeArgs);
        }) as typeof browser.close;
        return browser;
      });

      try {
        // An unsupported-protocol target makes page.goto throw deterministically
        // (verified directly: `net::ERR_ABORTED at not-a-real-protocol://nope`) —
        // no network round-trip, no timeout wait needed.
        await expect(
          captureScreenshot('not-a-real-protocol://nope', path.join(outDir, 'never-written.png')),
        ).rejects.toThrow();

        expect(closeSpy, 'browser.close() was not called after a failed capture').toHaveBeenCalledTimes(1);
        expect(existsSync(path.join(outDir, 'never-written.png'))).toBe(false);
      } finally {
        vi.restoreAllMocks();
      }
    },
    30_000,
  );

  it.runIf(hasChromium)(
    'captureSitePair closes its single shared browser even when the SECOND shot fails',
    async () => {
      const outDir = tempDir();
      const closeSpy = vi.fn();
      const realLaunch = chromiumModule!.chromium.launch.bind(chromiumModule!.chromium);
      vi.spyOn(chromiumModule!.chromium, 'launch').mockImplementation(async (opts) => {
        const browser = await realLaunch(opts);
        const realClose = browser.close.bind(browser);
        browser.close = (async (...closeArgs: Parameters<typeof browser.close>) => {
          closeSpy();
          return realClose(...closeArgs);
        }) as typeof browser.close;
        return browser;
      });

      try {
        await expect(
          captureSitePair(
            fileUrlFromPath(FIXTURE_SITE_INDEX), // first shot: succeeds
            'not-a-real-protocol://nope', // second shot: throws
            { sourcePath: path.join(outDir, 'src.png'), specimenPath: path.join(outDir, 'spec.png') },
          ),
        ).rejects.toThrow();

        expect(closeSpy, 'browser.close() was not called after the second shot failed').toHaveBeenCalledTimes(1);
        // the first shot's file WAS written (it succeeded before the failure)
        expect(existsSync(path.join(outDir, 'src.png'))).toBe(true);
        expect(existsSync(path.join(outDir, 'spec.png'))).toBe(false);
      } finally {
        vi.restoreAllMocks();
      }
    },
    30_000,
  );
});
