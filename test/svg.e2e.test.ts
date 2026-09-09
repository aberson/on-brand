/**
 * Step 4 acceptance for palette.svg: "valid XML and Playwright-renders
 * non-blank in both modes". This is the REAL-browser half — Chromium's
 * DOMParser is a genuine strict XML parser, and drawing the SVG to a canvas +
 * sampling pixels proves each mode column actually paints (not blank, not one
 * flat color).
 *
 * The SVG is a SINGLE file with two columns (light | dark). We split the canvas
 * at its horizontal midpoint and assert BOTH halves are non-blank and
 * multi-color — the "both modes" check for a two-column sheet.
 *
 * This file SKIPS with a loud warning when Chromium is unavailable, and runs
 * for real when it is present (as it is on the build machine). One browser
 * launch, reused across the tests (kept fast).
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_OK } from '../src/cli.ts';

const BIN = fileURLToPath(new URL('../bin/onbrand.mjs', import.meta.url));

// --- Chromium availability probe (module top-level, like emitters.e2e) -------

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
    `[svg.e2e] WARNING: SKIPPING the palette.svg render test — ${skipReason}. ` +
      'Install with `npm i -D playwright` + `npx playwright install chromium`. ' +
      'On the build machine Chromium IS expected present — this test must actually run there.',
  );
}

// --- shared temp project -----------------------------------------------------

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-render-'));
  tempDirs.push(dir);
  return dir;
}
function runCli(args: string[]): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stderr: result.stderr };
}
function buildSvg(mutate?: (doc: Record<string, unknown>) => void): string {
  const dir = tempDir();
  expect(runCli(['init', dir]).status).toBe(EXIT_OK);
  if (mutate !== undefined) {
    const tokensPath = path.join(dir, 'brand', 'tokens.json');
    const doc = JSON.parse(readFileSync(tokensPath, 'utf8')) as Record<string, unknown>;
    mutate(doc);
    writeFileSync(tokensPath, JSON.stringify(doc, null, 2), 'utf8');
  }
  expect(runCli(['build', dir, '--emit', 'svg']).status).toBe(EXIT_OK);
  return readFileSync(path.join(dir, 'brand', 'dist', 'palette.svg'), 'utf8');
}

/**
 * The in-page routine (runs in Chromium, serialized by Playwright): strict XML
 * parse + render to canvas + per-half pixel stats. Browser globals are reached
 * through `globalThis as any` so this Node-typed test file doesn't need the DOM
 * lib; the body is self-contained (no closure over outer scope) so Playwright's
 * function serialization is faithful.
 */
async function pageProbe(svgText: string): Promise<{
  parserError: string | null;
  rootTag: string | null;
  loaded?: boolean;
  noSvg?: boolean;
  left?: { colors: number; opaque: number };
  right?: { colors: number; opaque: number };
  tainted?: boolean;
}> {
  const g = globalThis as any;
  const parsed = new g.DOMParser().parseFromString(svgText, 'application/xml');
  const parserError = parsed.querySelector('parsererror');
  const rootTag = parsed.documentElement ? parsed.documentElement.tagName : null;
  const errText = parserError ? parserError.textContent : null;

  const container = g.document.createElement('div');
  container.innerHTML = svgText;
  g.document.body.appendChild(container);
  const svg = container.querySelector('svg');
  if (!svg) return { parserError: errText, rootTag, noSvg: true };
  const w = svg.viewBox.baseVal.width || parseInt(svg.getAttribute('width'), 10);
  const h = svg.viewBox.baseVal.height || parseInt(svg.getAttribute('height'), 10);
  const xml = new g.XMLSerializer().serializeToString(svg);
  const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  const img = new g.Image();
  const loaded: boolean = await new Promise((res) => {
    img.onload = () => res(true);
    img.onerror = () => res(false);
    img.src = dataUrl;
  });
  const canvas = g.document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const cx = canvas.getContext('2d');
  cx.drawImage(img, 0, 0, w, h);
  const mid = Math.floor(w / 2);
  let tainted = false;
  const inspect = (x0: number, x1: number): { colors: number; opaque: number } => {
    try {
      const d = cx.getImageData(x0, 0, x1 - x0, h).data;
      const colors = new Set<number>();
      let opaque = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 0) {
          opaque++;
          colors.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
        }
      }
      return { colors: colors.size, opaque };
    } catch {
      tainted = true;
      return { colors: 0, opaque: 0 };
    }
  };
  const left = inspect(0, mid);
  const right = inspect(mid, w);
  return { parserError: errText, rootTag, loaded, left, right, tainted };
}

let browser: import('playwright').Browser | undefined;
beforeAll(async () => {
  if (hasChromium && chromium !== undefined) browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  if (browser !== undefined) await browser.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function probe(svgText: string): Promise<Awaited<ReturnType<typeof pageProbe>>> {
  const page = await browser!.newPage();
  try {
    await page.setContent('<!doctype html><html><body></body></html>');
    return await page.evaluate(pageProbe, svgText);
  } finally {
    await page.close();
  }
}

describe('palette.svg renders in a real browser', () => {
  it.runIf(hasChromium)(
    'is valid XML (Chromium DOMParser) and paints non-blank, multi-color in BOTH halves',
    async () => {
      const svgText = buildSvg();
      const r = await probe(svgText);

      // real XML parse: no parser error, root element is <svg>
      expect(r.parserError, `parser error: ${r.parserError}`).toBeNull();
      expect(r.rootTag).toBe('svg');

      expect(r.loaded, 'SVG image failed to load into the canvas').toBe(true);
      expect(r.tainted, 'canvas tainted — getImageData blocked; cannot verify pixels').toBe(false);
      expect(r.left, 'no light-half stats').toBeDefined();
      expect(r.right, 'no dark-half stats').toBeDefined();

      // both halves are painted (many opaque px) and multi-color (not one flat fill)
      expect(r.left!.opaque).toBeGreaterThan(500);
      expect(r.right!.opaque).toBeGreaterThan(500);
      expect(r.left!.colors, 'light half is blank/one-color').toBeGreaterThan(4);
      expect(r.right!.colors, 'dark half is blank/one-color').toBeGreaterThan(4);
    },
    120_000,
  );

  it.runIf(hasChromium)(
    'stays valid XML even with a schema-valid but XML-hostile color value',
    async () => {
      // The from-url threat model: a fetched value carrying XML metacharacters
      // must not break the document's well-formedness (xmlEscape guarantees it).
      const svgText = buildSvg((doc) => {
        (doc as any).color.diagram.warning.$value = 'rgb(0 0 0 & < > " \')';
      });
      const r = await probe(svgText);
      expect(r.parserError, `parser error: ${r.parserError}`).toBeNull();
      expect(r.rootTag).toBe('svg');
    },
    120_000,
  );
});
