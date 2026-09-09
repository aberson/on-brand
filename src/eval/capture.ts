/**
 * Headless Playwright screenshot capture (Brand-Fidelity plan §5/§6, Step 8, #37).
 *
 * Captures the TWO PNGs the vision-judge (Step 9, `src/eval/mood-judge.ts`) needs
 * per site: a SOURCE screenshot (the live site, or — for the hermetic replay
 * path — a local stand-in) and a SPECIMEN screenshot (`onbrand preview`'s
 * generated `brand/dist/specimen.html`, rendered via `src/preview`). Both shots
 * go through the exact same primitive so the judge compares like-for-like
 * captures (same viewport, same wait strategy) rather than two differently-
 * shot images.
 *
 * ------------------------------------------------------- reused Playwright pattern ---
 * The launch/goto/screenshot/close idiom mirrors the two existing real-browser
 * suites already in this repo (`test/preview.e2e.test.ts`,
 * `test/svg.e2e.test.ts`): `chromium.launch()` once, `page.goto(url, {
 * waitUntil: 'load' })`, `page.screenshot()`, always `page.close()` /
 * `browser.close()` in a `finally`. No new Playwright bootstrap is invented
 * here — this module is the first to lift that idiom into `src/` (previously
 * it only lived in test files) so both the eval harness and future tests can
 * call it directly instead of re-deriving it.
 *
 * -------------------------------------------------------- guarded require (review fix) ---
 * `playwright` is a DEVDEPENDENCY (package.json), and this is the first `src/`
 * (production) module to depend on its JS API — everywhere else Playwright is
 * used only from `test/`. Both existing drivers (`test/preview.e2e.test.ts`,
 * `test/svg.e2e.test.ts`) therefore never `import { chromium } from
 * 'playwright'` statically; they lazily `require()` it behind a
 * `createRequire` + try/catch probe so a missing-Playwright environment
 * degrades to a loud, catchable error rather than a hard crash at import
 * time. This module adopts the SAME pattern: `Browser`/`Page` are imported as
 * TYPES ONLY (`import type` — erased at compile time, zero runtime footprint,
 * so type-checking still needs `playwright`'s types present in
 * `node_modules` but nothing crashes at RUNTIME if the package is absent),
 * and the runtime `chromium` value is resolved lazily via `resolveChromium()`
 * the first time a capture function actually runs — so simply importing
 * `capture.ts` (e.g. a future `onbrand` CLI wiring that imports the eval
 * module graph for `--help` or unrelated commands) never crashes in a
 * playwright-less production install; only an actual capture attempt does,
 * with a clear, actionable error message.
 *
 * ------------------------------------------------------------------- viewport ---
 * `DEFAULT_VIEWPORT` (1280x720) matches Playwright's own implicit default — the
 * SAME viewport the two e2e suites above already render at (neither overrides
 * `newPage()`'s viewport) — and lines up with the 1280px-viewport specimen
 * capture already described in `docs/findings/extraction-eval.md` ("Vision
 * pre-screen" section). Pinned as an explicit named constant rather than left
 * implicit so a future Playwright default change can't silently redefine what
 * "the corpus was captured at" means (one source of truth, code-quality.md).
 *
 * ------------------------------------------------------------------- cleanup ---
 * Every capture path closes its page AND browser in a `finally`, even when
 * `goto`/`screenshot` throws — no leaked Chromium processes regardless of
 * whether the target resolves. `captureSitePair` launches ONE browser shared by
 * both shots (not two), closed once in an outer `finally`.
 *
 * ------------------------------------------------------------------- targets ---
 * `target` is any Playwright-navigable URL: `http(s)://` (a live site — the
 * `--refresh` path) or `file://` (a local fixture / generated specimen —
 * always used for the SPECIMEN shot, since a specimen is always produced
 * locally by `onbrand build` + `onbrand preview`). `fileUrlFromPath` is a small
 * convenience so callers don't need to import `node:url` themselves to build a
 * `file://` target from an absolute path (mirrors `pathToFileURL(...).href`,
 * the exact idiom `test/preview.e2e.test.ts` already uses).
 *
 * --------------------------------------------------------- beforeGoto hook (review fix) ---
 * `CaptureOptions.beforeGoto` runs on the freshly-opened page BEFORE
 * navigation — the reach-in point a caller needs to install `page.route(...)`
 * / `page.on('request', ...)` (e.g. to stub remote webfont/CDN requests for a
 * HERMETIC test, mirroring `test/preview.e2e.test.ts`'s own
 * `page.route('https://fonts.googleapis.com/**', ...)`). It defaults to
 * `undefined` (a no-op) — DELIBERATELY off by default: in PRODUCTION, Step 9's
 * vision-judge needs the specimen's REAL brand webfonts actually rendered (a
 * mood/type judge scoring a page with unstyled fallback text would be scoring
 * the wrong thing), so this module must never block external requests by
 * default. Blocking is something a caller opts INTO for hermeticity (tests),
 * never something this module imposes globally.
 */

import { closeSync, existsSync, mkdirSync, openSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser, Page } from 'playwright';

// --- guarded require (see file header) ---------------------------------------

const require = createRequire(import.meta.url);
let playwrightModule: typeof import('playwright') | undefined;
let playwrightLoadError: string | undefined;
try {
  playwrightModule = require('playwright') as typeof import('playwright');
} catch (e) {
  playwrightLoadError = e instanceof Error ? e.message : String(e);
}

/** Resolve the `chromium` BrowserType lazily — throws a clear, actionable error (never a raw module-resolution crash) if `playwright` isn't installed. Called only when a capture actually runs, so importing this module never crashes a playwright-less environment. */
function resolveChromium(): typeof import('playwright').chromium {
  if (playwrightModule === undefined) {
    throw new Error(
      `src/eval/capture.ts: "playwright" is not installed/resolvable (${playwrightLoadError}) — ` +
        'run "npm install" and "npx playwright install chromium" in the on-brand repo before capturing screenshots.',
    );
  }
  return playwrightModule.chromium;
}

// --- types ---------------------------------------------------------------

/** Playwright viewport dimensions. See file header "viewport" for provenance. */
export interface CaptureViewport {
  width: number;
  height: number;
}

/** 1280x720 — see file header "viewport". */
export const DEFAULT_VIEWPORT: CaptureViewport = { width: 1280, height: 720 };

export interface CaptureOptions {
  /** Default `DEFAULT_VIEWPORT` (1280x720). */
  viewport?: CaptureViewport;
  /** `page.goto` navigation timeout (ms). Default 30_000. */
  timeoutMs?: number;
  /** Capture the full scrollable page rather than just the viewport. Default false (viewport-only, mirroring dembrandt's own `--screenshot`, which is documented viewport-only). */
  fullPage?: boolean;
  /** Optional hook run on the page BEFORE navigation. See file header "beforeGoto hook". OFF (`undefined`) by default. */
  beforeGoto?: (page: Page) => Promise<void> | void;
}

export interface CaptureResult {
  /** The URL that was navigated to. */
  target: string;
  /** Absolute path the PNG was written to. */
  outputPath: string;
}

/** Build a `file://` target from an absolute (or cwd-relative) filesystem path — the same `pathToFileURL(...).href` idiom `test/preview.e2e.test.ts` uses. */
export function fileUrlFromPath(absPath: string): string {
  return pathToFileURL(path.resolve(absPath)).href;
}

/**
 * Navigate `browser` to `target` and write a PNG to `outputPath`. Caller owns
 * the browser's lifecycle (launch + close) — this function only opens/closes
 * its OWN page, in a `finally`, so a `goto`/`screenshot` failure never leaks a
 * page on an otherwise-live browser. Exported (not just an internal helper) so
 * a multi-site caller (the eval harness, Step 9's mood-judge) can share one
 * browser launch across many shots instead of paying a fresh launch per site.
 */
export async function captureScreenshotWithBrowser(
  browser: Browser,
  target: string,
  outputPath: string,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const resolvedOutputPath = path.resolve(outputPath);
  mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });

  const page = await browser.newPage({ viewport });
  try {
    if (options.beforeGoto !== undefined) await options.beforeGoto(page);
    await page.goto(target, { waitUntil: 'load', timeout: timeoutMs });
    await page.screenshot({ path: resolvedOutputPath, fullPage: options.fullPage ?? false });
  } finally {
    await page.close();
  }
  return { target, outputPath: resolvedOutputPath };
}

/**
 * Single-shot convenience: launch a browser, capture one screenshot, close the
 * browser — all in a `finally` so the browser is closed even when `goto`/
 * `screenshot` throws (an unreachable/invalid target never leaks a Chromium
 * process).
 */
export async function captureScreenshot(
  target: string,
  outputPath: string,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  const browser = await resolveChromium().launch();
  try {
    return await captureScreenshotWithBrowser(browser, target, outputPath, options);
  } finally {
    await browser.close();
  }
}

export interface SiteCaptureOutputs {
  /** Where to write the source-site PNG. */
  sourcePath: string;
  /** Where to write the rendered-specimen PNG. */
  specimenPath: string;
}

export interface SiteCaptureResult {
  source: CaptureResult;
  specimen: CaptureResult;
}

/**
 * Capture the SOURCE + SPECIMEN pair for one site, sharing a single browser
 * launch (per-site capability the vision-judge, Step 9, consumes directly).
 * `sourceTarget` is the site's URL (live `http(s)://` on the `--refresh` path,
 * or a local `file://` stand-in for hermetic replay/tests); `specimenTarget`
 * is always local — a `file://` URL to a generated `brand/dist/specimen.html`
 * (build one with `onbrand build` + `onbrand preview`, or `fileUrlFromPath` an
 * already-built one). The browser is closed exactly once, in an outer
 * `finally`, so a failure capturing EITHER shot still leaves no leaked
 * Chromium process — the second shot is simply never attempted if the first
 * throws (propagated to the caller, not swallowed). `options` (including
 * `beforeGoto`) applies to BOTH shots.
 */
export async function captureSitePair(
  sourceTarget: string,
  specimenTarget: string,
  outputs: SiteCaptureOutputs,
  options: CaptureOptions = {},
): Promise<SiteCaptureResult> {
  const browser = await resolveChromium().launch();
  try {
    const source = await captureScreenshotWithBrowser(browser, sourceTarget, outputs.sourcePath, options);
    const specimen = await captureScreenshotWithBrowser(browser, specimenTarget, outputs.specimenPath, options);
    return { source, specimen };
  } finally {
    await browser.close();
  }
}

/** The 8-byte PNG file signature (every valid PNG starts with these bytes). */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * True when `filePath` exists, is non-empty, and starts with the PNG
 * signature. Used by tests/callers that want a cheap "is this really a PNG"
 * check beyond a bare `existsSync` — this is the acceptance-gating check for
 * Step 8/9, so it must reliably return `false` on garbage (a 0-byte file, a
 * non-PNG file) and not just on the true path (measurement-validity "a check
 * that can't fail garbage can't gate" — see the paired unit test).
 */
export function isNonEmptyPng(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const fd = openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(PNG_SIGNATURE.length);
    const bytesRead = readSync(fd, header, 0, header.length, 0);
    return bytesRead === PNG_SIGNATURE.length && header.equals(PNG_SIGNATURE);
  } finally {
    closeSync(fd);
  }
}
