/**
 * Step 31 production acceptance: one synthetic raster travels through the
 * spawned from-image CLI, both generated views, the paired catalog, a
 * byte-identical standalone refresh, and real Chromium at the pinned wide,
 * narrow, reduced-motion, and no-JavaScript configurations.
 *
 * Screenshots are always captured below this test's OS temp root. Reviewed
 * evidence is promoted only by ONBRAND_UPDATE_INSPIRATION_EVIDENCE=1, after
 * every production and browser assertion has passed.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/check/run.ts';
import {
  INSPIRATION_ARTIFACT_SCHEMA,
  INSPIRATION_ARTIFACT_SCHEMA_VERSION,
  type InspirationArtifact,
} from '../src/inspiration/export.ts';
import { INSPIRATION_VIEW_OUTPUT, SPECIMEN_VIEW_OUTPUT } from '../src/inspiration/views.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO_ROOT, 'bin', 'onbrand.mjs');
const CLOCK = '2026-08-22T12:34:56.000Z';
const TITLE = 'Step 31 synthetic palette';
const ALT = 'Four equal rectangles in red, blue, green, and warm gray.';
const SYNTHETIC_WIDTH = 320;
const SYNTHETIC_HEIGHT = 180;
const WIDE = { name: 'wide', width: 1280, height: 900 } as const;
const NARROW = { name: 'narrow', width: 390, height: 844 } as const;
const NO_JS = { name: 'no-js', width: 390, height: 844 } as const;
const CATALOG_RELATIVE_PATH = '.observatory/inspiration-to-implementation.json';
const EXPECTED_PROPOSAL_NAME = 'onbrand-proposal-step-31-synthetic-20260822';
const RETAINED_RELATIVE_DIR = 'documentation/findings/inspiration-producer-acceptance';
const RETAINED_DIR = path.join(REPO_ROOT, ...RETAINED_RELATIVE_DIR.split('/'));
const RETAINED_FILES = [
  'wide-1280x900.png',
  'narrow-390x844.png',
  'no-js-390x844.png',
  'evidence.json',
] as const;
const ACCEPTANCE_ASSERTION_IDS = [
  'production-transaction-complete',
  'synthetic-distributed-mappings',
  'paired-catalog-current-once',
  'production-output-locator-semantics',
  'standalone-catalog-byte-parity',
  'chromium-launched',
  'wide-source-complete-above-fold',
  'wide-palette-summary-above-fold',
  'wide-screenshot-exact',
  'light-dark-computed-grouping',
  'keyboard-focus-order-and-outlines',
  'keyboard-disclosure',
  'keyboard-zoom-dialog-and-focus-return',
  'reduced-motion-computed',
  'full-specimen-handoff',
  'narrow-source-and-palette-above-fold',
  'narrow-collapsed-without-overflow',
  'numbered-source-fallback-summary-and-cards',
  'narrow-screenshot-exact',
  'no-js-readable-core',
  'no-js-native-disclosure-both-mode-values',
  'no-js-screenshot-exact',
  'browser-error-collections-empty',
  'retained-screenshot-content-hashes',
] as const;

interface BrowserFailures {
  console: string[];
  pageErrors: string[];
  requestFailed: string[];
}

interface EvidenceAssertion {
  id: string;
  pass: true;
  observed: unknown;
}

interface ProductionOutputLocator {
  locator: string;
  relativeTo: 'ephemeral-production-root';
  retained: false;
}

interface ProductionOutputLocators {
  proposalRoot: ProductionOutputLocator;
  rawEvidence: ProductionOutputLocator;
  imageReport: ProductionOutputLocator;
  tokens: ProductionOutputLocator;
  trace: ProductionOutputLocator;
  copiedAsset: ProductionOutputLocator;
  manifest: ProductionOutputLocator;
  explanation: ProductionOutputLocator;
  specimen: ProductionOutputLocator;
  catalog: ProductionOutputLocator;
}

interface AcceptanceEvidence {
  schema: 'onbrand.inspiration-producer-acceptance-evidence';
  schemaVersion: 1;
  generatedAt: string;
  input: {
    kind: 'synthetic-raster';
    generator: 'test/inspiration.e2e.test.ts';
    sha256: string;
    mediaType: 'image/png';
    width: number;
    height: number;
  };
  viewports: Array<{ name: string; width: number; height: number }>;
  assertions: EvidenceAssertion[];
  outputs: ProductionOutputLocators;
  screenshots: Record<string, string>;
}

interface ProductionLocatorValues {
  proposalRoot: string;
  rawEvidence: string;
  imageReport: string;
  tokens: string;
  trace: string;
  copiedAsset: string;
  manifest: string;
  explanation: string;
  specimen: string;
  catalog: string;
}

interface RetainedSnapshot {
  inventory: string[];
  files: Map<string, Buffer>;
}

interface RetainedEvidenceTarget {
  root: string;
  directory: string;
}

const REPOSITORY_RETAINED_EVIDENCE_TARGET: RetainedEvidenceTarget = {
  root: REPO_ROOT,
  directory: RETAINED_DIR,
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function retainedSnapshot(directory = RETAINED_DIR): RetainedSnapshot {
  if (!existsSync(directory)) return { inventory: [], files: new Map() };
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry.isFile()) files.set(entry.name, readFileSync(path.join(directory, entry.name)));
  }
  return {
    inventory: entries.map((entry) => `${entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other'}:${entry.name}`),
    files,
  };
}

function expectRetainedUnchanged(before: RetainedSnapshot, directory = RETAINED_DIR): void {
  const after = retainedSnapshot(directory);
  expect(after.inventory, 'normal mode changed the retained evidence inventory').toEqual(before.inventory);
  for (const [name, beforeBytes] of before.files) {
    const afterBytes = after.files.get(name);
    expect(afterBytes, `normal mode removed retained evidence ${name}`).toBeDefined();
    expect(
      Buffer.compare(afterBytes!, beforeBytes),
      `normal mode changed retained evidence bytes for ${name}`,
    ).toBe(0);
  }
}

function assertSafeDirectoryChain(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`retained evidence target escapes repository root: ${target}`);
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!existsSync(current)) continue;
    const stats = lstatSync(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`retained evidence directory component is linked or not a directory: ${current}`);
    }
  }
}

function validateScreenshotHashBinding(payload: ReadonlyMap<(typeof RETAINED_FILES)[number], Buffer>): void {
  for (const name of RETAINED_FILES) {
    if (!payload.has(name)) throw new Error(`screenshot hash payload is missing ${name}`);
  }
  const evidence = JSON.parse(payload.get('evidence.json')!.toString('utf8')) as AcceptanceEvidence;
  const binding = evidence.assertions.find((assertion) => assertion.id === 'retained-screenshot-content-hashes');
  const expected = {
    wide: sha256(payload.get('wide-1280x900.png')!),
    narrow: sha256(payload.get('narrow-390x844.png')!),
    noJavaScript: sha256(payload.get('no-js-390x844.png')!),
  };
  if (binding === undefined || binding.pass !== true || JSON.stringify(binding.observed) !== JSON.stringify(expected)) {
    throw new Error('evidence.json does not bind the three promoted screenshot hashes');
  }
}

function promoteRetainedEvidence(
  payload: ReadonlyMap<(typeof RETAINED_FILES)[number], Buffer>,
  before: RetainedSnapshot,
  target: RetainedEvidenceTarget,
): void {
  const retainedExisted = existsSync(target.directory);
  assertSafeDirectoryChain(target.root, target.directory);
  validateScreenshotHashBinding(payload);
  for (const name of RETAINED_FILES) {
    if (!payload.has(name)) throw new Error(`promotion payload is missing ${name}`);
  }

  let stageDir: string | undefined;
  let backupDir: string | undefined;
  let primaryFailure: unknown;
  const secondaryFailures: unknown[] = [];
  const staged = new Map<(typeof RETAINED_FILES)[number], string>();
  const installed = new Set<(typeof RETAINED_FILES)[number]>();
  try {
    mkdirSync(target.directory, { recursive: true });
    assertSafeDirectoryChain(target.root, target.directory);
    for (const name of RETAINED_FILES) {
      const fileTarget = path.join(target.directory, name);
      if (!existsSync(fileTarget)) continue;
      const stats = lstatSync(fileTarget);
      if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
        throw new Error(`retained evidence target is linked, multi-linked, or not a regular file: ${fileTarget}`);
      }
    }

    // Creation of both the staging root and backup directory is inside this
    // transaction so even a setup failure reaches guarded rollback/cleanup.
    stageDir = mkdtempSync(path.join(target.directory, '.step31-stage-'));
    backupDir = path.join(stageDir, 'backups');
    mkdirSync(backupDir);
    for (const name of RETAINED_FILES) {
      const stagePath = path.join(stageDir, `new-${name}`);
      const expected = payload.get(name)!;
      writeFileSync(stagePath, expected);
      if (Buffer.compare(readFileSync(stagePath), expected) !== 0) {
        throw new Error(`staged retained evidence changed while validating ${name}`);
      }
      staged.set(name, stagePath);
    }

    // Remove the old completion marker first. A process crash during the
    // remaining renames therefore leaves no evidence.json claiming a mixed set.
    const backupOrder = ['evidence.json', ...RETAINED_FILES.slice(0, -1)] as Array<(typeof RETAINED_FILES)[number]>;
    for (const name of backupOrder) {
      const fileTarget = path.join(target.directory, name);
      if (existsSync(fileTarget)) renameSync(fileTarget, path.join(backupDir, name));
    }
    for (const name of RETAINED_FILES.slice(0, -1)) {
      renameSync(staged.get(name)!, path.join(target.directory, name));
      installed.add(name);
    }
    // evidence.json is the hash-bound completion marker and is committed last.
    renameSync(staged.get('evidence.json')!, path.join(target.directory, 'evidence.json'));
    installed.add('evidence.json');

    for (const name of RETAINED_FILES) {
      if (Buffer.compare(readFileSync(path.join(target.directory, name)), payload.get(name)!) !== 0) {
        throw new Error(`committed retained evidence does not match staged bytes for ${name}`);
      }
    }
  } catch (cause) {
    primaryFailure = cause;
    for (const name of installed) {
      try {
        rmSync(path.join(target.directory, name), { force: true });
      } catch (rollbackCause) {
        secondaryFailures.push(rollbackCause);
      }
    }
    if (backupDir !== undefined && existsSync(backupDir)) {
      for (const name of RETAINED_FILES) {
        const backup = path.join(backupDir, name);
        if (!existsSync(backup)) continue;
        try {
          renameSync(backup, path.join(target.directory, name));
        } catch (rollbackCause) {
          secondaryFailures.push(rollbackCause);
        }
      }
    }
  } finally {
    if (stageDir !== undefined && existsSync(stageDir)) {
      try {
        rmSync(stageDir, { recursive: true, force: true });
      } catch (cleanupCause) {
        secondaryFailures.push(cleanupCause);
      }
    }
    if (!retainedExisted && existsSync(target.directory)) {
      try {
        if (readdirSync(target.directory).length === 0) rmSync(target.directory, { recursive: true, force: true });
      } catch (cleanupCause) {
        secondaryFailures.push(cleanupCause);
      }
    }
  }

  if (primaryFailure !== undefined) {
    const restored = retainedSnapshot(target.directory);
    if (
      JSON.stringify(restored.inventory) !== JSON.stringify(before.inventory) ||
      [...before.files].some(([name, bytes]) => {
        const restoredBytes = restored.files.get(name);
        return restoredBytes === undefined || Buffer.compare(restoredBytes, bytes) !== 0;
      })
    ) {
      secondaryFailures.push(new Error('retained evidence rollback did not restore the complete prior snapshot'));
    }
    if (secondaryFailures.length > 0) {
      throw new AggregateError(
        [primaryFailure, ...secondaryFailures],
        'retained evidence promotion failed and rollback/cleanup was incomplete',
        { cause: primaryFailure },
      );
    }
    throw primaryFailure;
  }
  if (secondaryFailures.length > 0) {
    throw new AggregateError(secondaryFailures, 'retained evidence promotion cleanup failed');
  }
}

function finalizeRetainedEvidence({
  updateEvidence,
  target,
  retainedBefore,
  promotionPayload,
  currentEvidence,
}: {
  updateEvidence: boolean;
  target: RetainedEvidenceTarget;
  retainedBefore: RetainedSnapshot;
  promotionPayload: ReadonlyMap<(typeof RETAINED_FILES)[number], Buffer>;
  currentEvidence?: AcceptanceEvidence;
}): void {
  if (updateEvidence) {
    promoteRetainedEvidence(promotionPayload, retainedBefore, target);
    return;
  }
  if (currentEvidence === undefined) {
    throw new Error('normal-mode evidence finalization requires current acceptance evidence');
  }
  validateRetainedEvidenceSet(retainedBefore, currentEvidence);
  expectRetainedUnchanged(retainedBefore, target.directory);
}

async function writeSyntheticRaster(target: string): Promise<Buffer> {
  const pixels = Buffer.alloc(SYNTHETIC_WIDTH * SYNTHETIC_HEIGHT * 3);
  const colors = {
    topLeft: [222, 65, 74],
    topRight: [38, 112, 181],
    bottomLeft: [45, 151, 91],
    bottomRight: [211, 207, 197],
  } as const;
  for (let y = 0; y < SYNTHETIC_HEIGHT; y += 1) {
    for (let x = 0; x < SYNTHETIC_WIDTH; x += 1) {
      const color = y < SYNTHETIC_HEIGHT / 2
        ? x < SYNTHETIC_WIDTH / 2 ? colors.topLeft : colors.topRight
        : x < SYNTHETIC_WIDTH / 2 ? colors.bottomLeft : colors.bottomRight;
      const offset = (y * SYNTHETIC_WIDTH + x) * 3;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
    }
  }
  await sharp(pixels, {
    raw: { width: SYNTHETIC_WIDTH, height: SYNTHETIC_HEIGHT, channels: 3 },
  })
    .png({ adaptiveFiltering: false, compressionLevel: 9, palette: false })
    .toFile(target);
  return readFileSync(target);
}

function runCli(args: readonly string[], timeout = 180_000) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ONBRAND_NOW: CLOCK };
  delete childEnv.ONBRAND_UPDATE_INSPIRATION_EVIDENCE;
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout,
    env: childEnv,
  });
}

function attachFailureCollectors(page: Page): BrowserFailures {
  const failures: BrowserFailures = { console: [], pageErrors: [], requestFailed: [] };
  page.on('console', (message) => failures.console.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => failures.pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    failures.requestFailed.push(`${request.method()} ${request.failure()?.errorText ?? 'request failed'}`);
  });
  return failures;
}

function expectNoBrowserFailures(label: string, failures: BrowserFailures): void {
  expect(failures.console, `${label} console errors`).toEqual([]);
  expect(failures.pageErrors, `${label} page errors`).toEqual([]);
  expect(failures.requestFailed, `${label} failed requests`).toEqual([]);
}

function pngDimensionsFromBytes(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function pngDimensions(target: string): { width: number; height: number } {
  return pngDimensionsFromBytes(readFileSync(target));
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

async function numberedText(page: Page, selector: string): Promise<number[]> {
  return page.locator(selector).evaluateAll((nodes: any[]) => nodes.map((node) => {
    const match = String(node.textContent ?? '').trim().match(/^\s*(\d+)/);
    return match === null ? Number.NaN : Number(match[1]);
  }));
}

async function numberedData(page: Page, selector: string): Promise<number[]> {
  return page.locator(selector).evaluateAll((nodes: any[]) =>
    nodes.map((node) => Number(node.getAttribute('data-mapping-number'))));
}

async function themeGrouping(page: Page): Promise<{
  theme: string | null;
  modeLabel: string;
  targetCount: number;
  allMatchActiveMode: boolean;
  ariaLabelsComplete: boolean;
  colors: string[];
}> {
  return page.evaluate(() => {
    const g = globalThis as any;
    const document = g.document;
    const theme = document.documentElement.getAttribute('data-theme');
    const variable = theme === 'dark' ? '--dark' : '--light';
    const normalize = (value: string): string => {
      const probe = document.createElement('span');
      probe.style.backgroundColor = value;
      document.body.appendChild(probe);
      const normalized = g.getComputedStyle(probe).backgroundColor as string;
      probe.remove();
      return normalized;
    };
    const targets = [...document.querySelectorAll('.palette-target')] as any[];
    const rows = targets.map((target) => {
      const light = target.style.getPropertyValue('--light').trim();
      const dark = target.style.getPropertyValue('--dark').trim();
      return {
        current: g.getComputedStyle(target).backgroundColor as string,
        expected: normalize(target.style.getPropertyValue(variable).trim()),
        label: String(target.getAttribute('aria-label') ?? ''),
        light,
        dark,
      };
    });
    const modeLabel = document.querySelector('.mode-label');
    const rawLabel = g.getComputedStyle(modeLabel, '::before').content as string;
    const authoredLabel = String(modeLabel.textContent ?? '').trim();
    return {
      theme,
      modeLabel: authoredLabel || rawLabel.replace(/^['\"]|['\"]$/g, ''),
      targetCount: rows.length,
      allMatchActiveMode: rows.every((row) => row.current === row.expected),
      ariaLabelsComplete: rows.every((row) => row.label.includes(`light ${row.light}`) && row.label.includes(`dark ${row.dark}`)),
      colors: rows.map((row) => row.current),
    };
  });
}

async function activeElementKey(page: Page): Promise<string> {
  return page.evaluate(() => {
    const g = globalThis as any;
    const active = g.document.activeElement;
    if (active?.id) return `#${active.id}`;
    if (active?.matches?.('.mapping-details > summary')) return '.mapping-details > summary';
    if (active?.matches?.('.defaults > summary')) return '.defaults > summary';
    if (active?.matches?.('.action')) return '.action';
    return String(active?.tagName ?? '').toLowerCase();
  });
}

async function countRenderedColorPixels(bytes: Buffer, cssColor: string): Promise<number> {
  const match = cssColor.match(/rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/i);
  expect(match, `focus indicator color is not an RGB color: ${cssColor}`).not.toBeNull();
  const expected = match!.slice(1, 4).map(Number);
  const raw = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let offset = 0; offset < raw.data.length; offset += raw.info.channels) {
    if (
      Math.abs(raw.data[offset]! - expected[0]!) <= 2 &&
      Math.abs(raw.data[offset + 1]! - expected[1]!) <= 2 &&
      Math.abs(raw.data[offset + 2]! - expected[2]!) <= 2
    ) count += 1;
  }
  return count;
}

async function assertKeyboardFocusOrder(page: Page): Promise<{
  order: string[];
  imageOverlay: { inset: boolean; renderedPixels: number; outlineOffset: number; outlineWidth: number };
}> {
  await page.evaluate(() => {
    const active = (globalThis as any).document.activeElement;
    if (typeof active?.blur === 'function') active.blur();
  });
  const expected = [
    '#theme-toggle',
    '#image-zoom-open',
    '.mapping-details > summary',
    '.defaults > summary',
    '.action',
  ];
  const observed: string[] = [];
  let imageOverlay: { inset: boolean; renderedPixels: number; outlineOffset: number; outlineWidth: number } | undefined;
  for (const key of expected) {
    await page.keyboard.press('Tab');
    const active = await activeElementKey(page);
    observed.push(active);
    expect(active).toBe(key);
    const outline = await page.evaluate(() => {
      const g = globalThis as any;
      const style = g.getComputedStyle(g.document.activeElement);
      return { style: style.outlineStyle as string, width: Number.parseFloat(style.outlineWidth as string) };
    });
    expect(outline.style).not.toBe('none');
    expect(outline.width).toBeGreaterThanOrEqual(2);
    if (key === '#image-zoom-open') {
      const indicator = await page.evaluate(() => {
        const g = globalThis as any;
        const document = g.document;
        const button = document.getElementById('image-zoom-open');
        const wrap = button.closest('.image-wrap');
        const buttonBox = button.getBoundingClientRect();
        const wrapBox = wrap.getBoundingClientRect();
        const style = g.getComputedStyle(button);
        const width = Number.parseFloat(style.outlineWidth as string);
        const offset = Number.parseFloat(style.outlineOffset as string);
        const painted = {
          left: buttonBox.left - offset - width,
          right: buttonBox.right + offset + width,
          top: buttonBox.top - offset - width,
          bottom: buttonBox.bottom + offset + width,
        };
        return {
          color: style.outlineColor as string,
          offset,
          width,
          inset: painted.left >= wrapBox.left && painted.right <= wrapBox.right &&
            painted.top >= wrapBox.top && painted.bottom <= wrapBox.bottom,
          insetShadow: String(style.boxShadow).includes('inset'),
        };
      });
      expect(indicator.offset).toBeLessThanOrEqual(-indicator.width);
      expect(indicator.inset).toBe(true);
      expect(indicator.insetShadow).toBe(true);
      const pixels = await countRenderedColorPixels(
        await page.locator('.image-wrap').screenshot(),
        indicator.color,
      );
      expect(pixels, 'focused image overlay must paint visible inset indicator pixels').toBeGreaterThan(100);
      imageOverlay = {
        inset: indicator.inset,
        renderedPixels: pixels,
        outlineOffset: indicator.offset,
        outlineWidth: indicator.width,
      };
    }
  }
  expect(imageOverlay).toBeDefined();
  return { order: observed, imageOverlay: imageOverlay! };
}

function productionLocator(locator: string): ProductionOutputLocator {
  return { locator, relativeTo: 'ephemeral-production-root', retained: false };
}

function productionLocatorValues(proposalRoot: string): ProductionLocatorValues {
  return {
    proposalRoot,
    rawEvidence: `${proposalRoot}/raw-image-analysis.json`,
    imageReport: `${proposalRoot}/image-report.md`,
    tokens: `${proposalRoot}/brand/tokens.json`,
    trace: `${proposalRoot}/brand/inspiration.json`,
    copiedAsset: `${proposalRoot}/brand/assets/inspiration.png`,
    manifest: `${proposalRoot}/brand/dist/manifest.json`,
    explanation: `${proposalRoot}/brand/dist/${INSPIRATION_VIEW_OUTPUT}`,
    specimen: `${proposalRoot}/brand/dist/${SPECIMEN_VIEW_OUTPUT}`,
    catalog: CATALOG_RELATIVE_PATH,
  };
}

function productionOutputLocators(values: ProductionLocatorValues): ProductionOutputLocators {
  return {
    proposalRoot: productionLocator(values.proposalRoot),
    rawEvidence: productionLocator(values.rawEvidence),
    imageReport: productionLocator(values.imageReport),
    tokens: productionLocator(values.tokens),
    trace: productionLocator(values.trace),
    copiedAsset: productionLocator(values.copiedAsset),
    manifest: productionLocator(values.manifest),
    explanation: productionLocator(values.explanation),
    specimen: productionLocator(values.specimen),
    catalog: productionLocator(values.catalog),
  };
}

function assertPortableEvidence(evidence: AcceptanceEvidence, forbiddenRoots: readonly string[] = []): string {
  const inspect = (value: unknown, field: string): void => {
    if (typeof value === 'string') {
      expect(value.length, `${field} must remain bounded`).toBeLessThanOrEqual(240);
      expect(value, `${field} contains a backslash`).not.toContain('\\');
      expect(value, `${field} contains an absolute drive path`).not.toMatch(/^[a-z]:\//i);
      expect(value, `${field} contains an absolute POSIX path`).not.toMatch(/^\//);
      expect(value, `${field} contains a file URL`).not.toMatch(/^file:/i);
      expect(value, `${field} contains a data URI`).not.toMatch(/^data:/i);
      expect(value, `${field} contains base64 payload text`).not.toMatch(/;base64,/i);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => inspect(item, `${field}[${index}]`));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) inspect(item, `${field}.${key}`);
    }
  };
  inspect(evidence, 'evidence');
  const rendered = `${JSON.stringify(evidence, null, 2)}\n`;
  for (const forbiddenRoot of forbiddenRoots) {
    expect(rendered, 'evidence contains an ephemeral absolute root').not.toContain(forbiddenRoot);
  }
  expect(rendered).not.toMatch(/file:\/\//i);
  expect(rendered).not.toMatch(/data:[^\s\"]+;base64,/i);
  return rendered;
}

function assertRepositoryRelativeLocator(locator: string, requireExists: boolean): string {
  const target = path.resolve(REPO_ROOT, ...locator.split('/'));
  const relative = path.relative(REPO_ROOT, target);
  expect(path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)).toBe(false);
  if (requireExists) expect(existsSync(target), `repository locator is not resolvable: ${locator}`).toBe(true);
  return target;
}

function assertProductionOutputLocatorSemantics(
  evidence: AcceptanceEvidence,
  expectedProposalRoot?: string,
  liveProductionRoot?: string,
): ProductionLocatorValues {
  const outputKeys = Object.keys(evidence.outputs).sort();
  expect(outputKeys).toEqual([
    'catalog',
    'copiedAsset',
    'explanation',
    'imageReport',
    'manifest',
    'proposalRoot',
    'rawEvidence',
    'specimen',
    'tokens',
    'trace',
  ]);
  for (const [name, output] of Object.entries(evidence.outputs)) {
    expect(Object.keys(output).sort(), `${name} locator shape`).toEqual(['locator', 'relativeTo', 'retained']);
    expect(output.relativeTo, `${name} locator base`).toBe('ephemeral-production-root');
    expect(output.retained, `${name} must not claim durable production output`).toBe(false);
    expect(output.locator, `${name} must be a relative portable locator`).not.toMatch(/^(?:[a-z]:[\\/]|[\\/])/i);
    expect(output.locator, `${name} must not traverse its declared root`).not.toMatch(/(?:^|\/)\.\.(?:\/|$)/);
    expect(output.locator).not.toContain('\\');
  }

  const proposalRoot = evidence.outputs.proposalRoot.locator;
  expect(proposalRoot).toBe(EXPECTED_PROPOSAL_NAME);
  expect(proposalRoot).not.toContain('/');
  if (expectedProposalRoot !== undefined) expect(proposalRoot).toBe(expectedProposalRoot);
  const expectedValues = productionLocatorValues(proposalRoot);
  expect(evidence.outputs).toEqual(productionOutputLocators(expectedValues));
  expect(evidence.outputs.explanation.locator).toBe(expectedValues.explanation);
  expect(evidence.outputs.specimen.locator).toBe(expectedValues.specimen);

  if (liveProductionRoot !== undefined) {
    for (const [name, locator] of Object.entries(expectedValues)) {
      const target = path.resolve(liveProductionRoot, ...locator.split('/'));
      const relative = path.relative(liveProductionRoot, target);
      expect(
        path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`),
        `${name} escapes the ephemeral production root`,
      ).toBe(false);
      expect(existsSync(target), `live production output is not resolvable: ${locator}`).toBe(true);
    }
  }
  return expectedValues;
}

function assertEvidenceAssertionSemantics(evidence: AcceptanceEvidence): void {
  const byId = new Map(evidence.assertions.map((assertion) => [assertion.id, assertion]));
  expect([...byId.keys()].sort(), 'evidence must contain every current acceptance assertion').toEqual(
    [...ACCEPTANCE_ASSERTION_IDS].sort(),
  );
  const observed = (id: (typeof ACCEPTANCE_ASSERTION_IDS)[number]): Record<string, unknown> => {
    const value = byId.get(id)?.observed;
    expect(value, `${id} must have an observed object`).not.toBeNull();
    expect(typeof value, `${id} must have an observed object`).toBe('object');
    expect(Array.isArray(value), `${id} observed value must not be an array`).toBe(false);
    return value as Record<string, unknown>;
  };
  const numeric = (value: Record<string, unknown>, key: string): number => {
    expect(typeof value[key], `${key} must be numeric`).toBe('number');
    expect(Number.isFinite(value[key]), `${key} must be finite`).toBe(true);
    return value[key] as number;
  };

  const transaction = observed('production-transaction-complete');
  expect(transaction.entryPoint).toBe('bin/onbrand.mjs');
  expect(numeric(transaction, 'artifactCount')).toBe(10);
  expect(numeric(transaction, 'checkErrors')).toBe(0);
  expect(transaction.incompleteMarker).toBe(false);
  expect(numeric(transaction, 'provenanceRows')).toBeGreaterThanOrEqual(4);

  const mappings = observed('synthetic-distributed-mappings');
  const mappingCount = numeric(mappings, 'count');
  expect(mappingCount).toBeGreaterThanOrEqual(4);

  const paired = observed('paired-catalog-current-once');
  expect(numeric(paired, 'matchingItems')).toBe(1);
  expect(paired.traceState).toBe('available');
  expect(paired.standalonePath).toBe(evidence.outputs.explanation.locator);
  expect(paired.specimenPath).toBe(evidence.outputs.specimen.locator);

  const locatorSemantics = observed('production-output-locator-semantics');
  expect(locatorSemantics).toEqual({
    relativeTo: 'ephemeral-production-root',
    retained: false,
    proposalRoot: evidence.outputs.proposalRoot.locator,
    catalog: evidence.outputs.catalog.locator,
    explanation: evidence.outputs.explanation.locator,
    specimen: evidence.outputs.specimen.locator,
  });
  expect(observed('standalone-catalog-byte-parity').sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(observed('chromium-launched').launched).toBe(true);

  for (const id of ['wide-source-complete-above-fold', 'wide-palette-summary-above-fold'] as const) {
    const bounds = observed(id);
    const bottom = numeric(bounds, 'bottom');
    const fold = numeric(bounds, 'fold');
    expect(fold).toBe(WIDE.height);
    expect(bottom).toBeGreaterThan(0);
    expect(bottom).toBeLessThanOrEqual(fold);
  }
  expect(observed('wide-screenshot-exact')).toEqual({ width: WIDE.width, height: WIDE.height });

  const grouping = observed('light-dark-computed-grouping');
  expect(numeric(grouping, 'targetCount')).toBeGreaterThanOrEqual(mappingCount);
  expect(grouping.changed).toBe(true);

  const focus = observed('keyboard-focus-order-and-outlines');
  expect(focus.order).toEqual([
    '#theme-toggle', '#image-zoom-open', '.mapping-details > summary', '.defaults > summary', '.action',
  ]);
  expect(numeric(focus, 'positiveTabindex')).toBe(0);
  expect(focus.imageOverlayFocusInset).toBe(true);
  expect(focus.imageOverlayFocusPixelsVisible).toBe(true);
  const outlineWidth = numeric(focus, 'imageOverlayOutlineWidth');
  expect(outlineWidth).toBeGreaterThanOrEqual(2);
  expect(numeric(focus, 'imageOverlayOutlineOffset')).toBeLessThanOrEqual(-outlineWidth);

  const disclosure = observed('keyboard-disclosure');
  expect(numeric(disclosure, 'mappingCards')).toBe(mappingCount);
  expect(disclosure.returnedCollapsed).toBe(true);
  const zoom = observed('keyboard-zoom-dialog-and-focus-return');
  expect(zoom.copiedAlt).toBe(true);
  expect(numeric(zoom, 'zoomFactorAtLeast')).toBeGreaterThanOrEqual(1.8);
  expect(zoom.focusReturned).toBe(true);
  expect(observed('reduced-motion-computed')).toEqual({
    mediaMatches: true,
    animationName: 'none',
    transitionDuration: '0s',
    scrollBehavior: 'auto',
  });
  expect(observed('full-specimen-handoff')).toEqual({ navigated: true, headingFound: true });

  const narrowBounds = observed('narrow-source-and-palette-above-fold');
  const narrowFold = numeric(narrowBounds, 'fold');
  expect(narrowFold).toBe(NARROW.height);
  expect(numeric(narrowBounds, 'sourceBottom')).toBeGreaterThan(0);
  expect(numeric(narrowBounds, 'sourceBottom')).toBeLessThanOrEqual(narrowFold);
  expect(numeric(narrowBounds, 'paletteBottom')).toBeGreaterThan(0);
  expect(numeric(narrowBounds, 'paletteBottom')).toBeLessThanOrEqual(narrowFold);
  const narrowLayout = observed('narrow-collapsed-without-overflow');
  expect(narrowLayout.detailsCollapsed).toBe(true);
  expect(numeric(narrowLayout, 'horizontalOverflow')).toBeLessThanOrEqual(0);
  const numbered = observed('numbered-source-fallback-summary-and-cards');
  expect(numeric(numbered, 'count')).toBe(mappingCount);
  expect(numeric(numbered, 'distinctPinCenters')).toBe(mappingCount);
  expect(numeric(numbered, 'linkedAssociations')).toBe(mappingCount);
  expect(numeric(numbered, 'visiblePins')).toBe(mappingCount);
  expect(numeric(numbered, 'visibleSwatches')).toBeGreaterThan(mappingCount);
  expect(observed('narrow-screenshot-exact')).toEqual({ width: NARROW.width, height: NARROW.height });

  const noJs = observed('no-js-readable-core');
  expect(numeric(noJs, 'mappingCount')).toBe(mappingCount);
  expect(noJs.authoredAltVisible).toBe(true);
  expect(noJs.staticNoteVisible).toBe(true);
  expect(noJs.inertControlsHidden).toBe(true);
  expect(numeric(noJs, 'horizontalOverflow')).toBeLessThanOrEqual(0);
  expect(numeric(noJs, 'fold')).toBe(NO_JS.height);
  expect(numeric(noJs, 'paletteBottom')).toBeGreaterThan(0);
  expect(numeric(noJs, 'paletteBottom')).toBeLessThanOrEqual(NO_JS.height);
  const noJsModes = observed('no-js-native-disclosure-both-mode-values');
  const noJsTargetCount = numeric(noJsModes, 'targetCount');
  expect(noJsTargetCount).toBeGreaterThanOrEqual(mappingCount);
  expect(numeric(noJsModes, 'lightValuesReadable')).toBe(noJsTargetCount);
  expect(numeric(noJsModes, 'darkValuesReadable')).toBe(noJsTargetCount);
  expect(observed('no-js-screenshot-exact')).toEqual({ width: NO_JS.width, height: NO_JS.height });
  expect(observed('browser-error-collections-empty')).toEqual({
    consoleMessages: 0,
    pageErrors: 0,
    requestFailures: 0,
  });
  const screenshotHashes = observed('retained-screenshot-content-hashes');
  expect(Object.keys(screenshotHashes).sort()).toEqual(['narrow', 'noJavaScript', 'wide']);
  for (const hash of Object.values(screenshotHashes)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
}

function assertEvidenceShapeAndLocators(evidence: AcceptanceEvidence, requireRetainedFiles = true): void {
  expect(Object.keys(evidence).sort()).toEqual([
    'assertions', 'generatedAt', 'input', 'outputs', 'schema', 'schemaVersion', 'screenshots', 'viewports',
  ]);
  expect(evidence.schema).toBe('onbrand.inspiration-producer-acceptance-evidence');
  expect(evidence.schemaVersion).toBe(1);
  expect(evidence.generatedAt).toBe(CLOCK);
  expect(Object.keys(evidence.input).sort()).toEqual(['generator', 'height', 'kind', 'mediaType', 'sha256', 'width']);
  expect(evidence.input).toMatchObject({
    kind: 'synthetic-raster',
    generator: 'test/inspiration.e2e.test.ts',
    mediaType: 'image/png',
    width: SYNTHETIC_WIDTH,
    height: SYNTHETIC_HEIGHT,
  });
  expect(evidence.input.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(evidence.viewports).toEqual([WIDE, NARROW, NO_JS]);
  expect(Array.isArray(evidence.assertions)).toBe(true);
  expect(evidence.assertions.length).toBeGreaterThan(0);
  const assertionIds = evidence.assertions.map((assertion) => assertion.id);
  expect(new Set(assertionIds).size, 'retained assertion IDs must be unique').toBe(assertionIds.length);
  for (const assertion of evidence.assertions) {
    expect(Object.keys(assertion).sort()).toEqual(['id', 'observed', 'pass']);
    expect(assertion.id).toMatch(/^[a-z0-9-]+$/);
    expect(assertion.pass).toBe(true);
  }
  assertEvidenceAssertionSemantics(evidence);
  expect(evidence.screenshots).toEqual({
    wide: `${RETAINED_RELATIVE_DIR}/wide-1280x900.png`,
    narrow: `${RETAINED_RELATIVE_DIR}/narrow-390x844.png`,
    noJavaScript: `${RETAINED_RELATIVE_DIR}/no-js-390x844.png`,
    evidence: `${RETAINED_RELATIVE_DIR}/evidence.json`,
  });
  assertRepositoryRelativeLocator(evidence.input.generator, true);
  for (const locator of Object.values(evidence.screenshots)) {
    assertRepositoryRelativeLocator(locator, requireRetainedFiles);
  }
  assertProductionOutputLocatorSemantics(evidence);
  assertPortableEvidence(evidence);
}

function parseAcceptanceEvidence(bytes: Buffer, label: string): AcceptanceEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (cause) {
    throw new Error(`${label} is not valid JSON`, { cause });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must contain an evidence object`);
  }
  const evidence = parsed as AcceptanceEvidence;
  if (
    evidence.input === null || typeof evidence.input !== 'object' ||
    !Array.isArray(evidence.viewports) || !Array.isArray(evidence.assertions) ||
    evidence.outputs === null || typeof evidence.outputs !== 'object' ||
    evidence.screenshots === null || typeof evidence.screenshots !== 'object'
  ) {
    throw new Error(`${label} does not contain the required evidence collections`);
  }
  assertEvidenceShapeAndLocators(evidence);
  return evidence;
}

function retainedPayload(snapshot: RetainedSnapshot): Map<(typeof RETAINED_FILES)[number], Buffer> {
  const payload = new Map<(typeof RETAINED_FILES)[number], Buffer>();
  for (const name of RETAINED_FILES) {
    const bytes = snapshot.files.get(name);
    expect(bytes, `retained evidence is missing ${name}`).toBeDefined();
    payload.set(name, bytes!);
  }
  return payload;
}

function validateRetainedEvidenceSet(snapshot: RetainedSnapshot, current?: AcceptanceEvidence): AcceptanceEvidence {
  const expectedInventory = RETAINED_FILES.map((name) => `file:${name}`).sort();
  expect(snapshot.inventory, 'retained evidence inventory is incomplete or contains unreviewed files').toEqual(expectedInventory);
  const payload = retainedPayload(snapshot);
  const evidence = parseAcceptanceEvidence(payload.get('evidence.json')!, 'retained evidence.json');
  validateScreenshotHashBinding(payload);
  expect(pngDimensionsFromBytes(payload.get('wide-1280x900.png')!)).toEqual({ width: WIDE.width, height: WIDE.height });
  expect(pngDimensionsFromBytes(payload.get('narrow-390x844.png')!)).toEqual({ width: NARROW.width, height: NARROW.height });
  expect(pngDimensionsFromBytes(payload.get('no-js-390x844.png')!)).toEqual({ width: NO_JS.width, height: NO_JS.height });
  if (current !== undefined) {
    expect(evidence.input, 'retained synthetic input is stale').toEqual(current.input);
    expect(evidence.outputs, 'retained production output semantics are stale').toEqual(current.outputs);
    expect(evidence.viewports, 'retained viewport contract is stale').toEqual(current.viewports);
    expect(evidence.screenshots, 'retained screenshot locators are stale').toEqual(current.screenshots);
    expect(
      evidence.assertions.map(({ id, pass }) => ({ id, pass })),
      'retained assertion contract is stale',
    ).toEqual(current.assertions.map(({ id, pass }) => ({ id, pass })));
  }
  return evidence;
}

async function cleanupAcceptanceResources(resources: {
  contexts: Array<BrowserContext | undefined>;
  browser: Browser | undefined;
  tempRoot: string | undefined;
}): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const context of resources.contexts) {
    if (context === undefined) continue;
    try {
      await context.close();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (resources.browser !== undefined) {
    try {
      await resources.browser.close();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (resources.tempRoot !== undefined && existsSync(resources.tempRoot)) {
    try {
      rmSync(resources.tempRoot, { recursive: true, force: true });
    } catch (cause) {
      failures.push(cause);
    }
  }
  return failures;
}

function rethrowPrimaryFailure(primaryFailure: unknown, cleanupFailures: readonly unknown[]): never {
  if (primaryFailure instanceof Error && cleanupFailures.length > 0) {
    Object.defineProperty(primaryFailure, 'cleanupFailures', {
      configurable: true,
      enumerable: false,
      value: [...cleanupFailures],
    });
  }
  throw primaryFailure;
}

function assertCurrentRepositoryLocators(evidence: AcceptanceEvidence, updateEvidence: boolean): void {
  assertRepositoryRelativeLocator(evidence.input.generator, true);
  for (const locator of Object.values(evidence.screenshots)) {
    assertRepositoryRelativeLocator(locator, !updateEvidence);
  }
}

describe('inspiration producer acceptance', () => {
  it('runs isolated evidence promotion followed by normal-mode validation without touching retained evidence', () => {
    // A first invocation-scoped update may seed the repository evidence set,
    // so this normal-gate regression anchor only borrows an existing reviewed
    // payload. It still exercises both finalization modes in its temp target.
    if (process.env.ONBRAND_UPDATE_INSPIRATION_EVIDENCE === '1') return;
    const repositoryBefore = retainedSnapshot();
    validateRetainedEvidenceSet(repositoryBefore);
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'onbrand-inspiration-evidence-cycle-'));
    const temporaryTarget: RetainedEvidenceTarget = {
      root: tempRoot,
      directory: path.join(tempRoot, 'retained-evidence'),
    };

    try {
      const promotionPayload = retainedPayload(repositoryBefore);
      const beforePromotion = retainedSnapshot(temporaryTarget.directory);
      expect(beforePromotion.inventory).toEqual([]);

      finalizeRetainedEvidence({
        updateEvidence: true,
        target: temporaryTarget,
        retainedBefore: beforePromotion,
        promotionPayload,
      });

      const promoted = retainedSnapshot(temporaryTarget.directory);
      for (const [name, expected] of promotionPayload) {
        expect(promoted.files.get(name), `temporary promotion did not commit ${name}`).toEqual(expected);
      }
      const currentEvidence = validateRetainedEvidenceSet(promoted);

      finalizeRetainedEvidence({
        updateEvidence: false,
        target: temporaryTarget,
        retainedBefore: promoted,
        promotionPayload,
        currentEvidence,
      });
      expectRetainedUnchanged(repositoryBefore, REPOSITORY_RETAINED_EVIDENCE_TARGET.directory);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('proves one real catalog-enabled proposal in Chromium and promotes only reviewed evidence', async () => {
    const updateEvidence = process.env.ONBRAND_UPDATE_INSPIRATION_EVIDENCE === '1';
    const retainedBefore = retainedSnapshot();
    const expectedRetainedInventory = RETAINED_FILES.map((name) => `file:${name}`).sort();
    if (updateEvidence) {
      expect(retainedBefore.inventory.filter((entry) => !expectedRetainedInventory.includes(entry))).toEqual([]);
    } else {
      expect(retainedBefore.inventory).toEqual(expectedRetainedInventory);
      validateRetainedEvidenceSet(retainedBefore);
    }

    let tempRoot: string | undefined;
    let smokeRoot = '';
    let screenshotDir = '';
    let inputPath = '';
    let browser: Browser | undefined;
    let wideContext: BrowserContext | undefined;
    let narrowContext: BrowserContext | undefined;
    let noJsContext: BrowserContext | undefined;
    let promotionPayload: Map<(typeof RETAINED_FILES)[number], Buffer> | undefined;
    let currentEvidence: AcceptanceEvidence | undefined;
    let bodyFailure: unknown;
    let bodySucceeded = false;
    const assertions: EvidenceAssertion[] = [];
    const accepted = (id: string, observed: unknown): void => {
      assertions.push({ id, pass: true, observed });
    };

    try {
      tempRoot = mkdtempSync(path.join(os.tmpdir(), 'onbrand-inspiration-acceptance-'));
      smokeRoot = path.join(tempRoot, 'workspace');
      screenshotDir = path.join(tempRoot, 'browser-evidence');
      inputPath = path.join(tempRoot, 'step-31-synthetic.png');
      mkdirSync(smokeRoot, { recursive: true });
      mkdirSync(screenshotDir, { recursive: true });

      const syntheticBytes = await writeSyntheticRaster(inputPath);
      const syntheticSha256 = sha256(syntheticBytes);
      expect(syntheticBytes.length).toBeLessThan(100_000);

      const produced = runCli([
        'from-image',
        inputPath,
        '--title', TITLE,
        '--alt', ALT,
        '--creator', 'On Brand deterministic test generator',
        '--artwork-date', '2026',
        '--rights', 'Synthetic test fixture; no external artwork.',
        '--out', smokeRoot,
        '--catalog-root', smokeRoot,
        '--catalog-out', CATALOG_RELATIVE_PATH,
        '--no-llm',
      ]);
      expect(
        produced.status,
        `from-image failed\nstdout: ${produced.stdout}\nstderr: ${produced.stderr}`,
      ).toBe(0);
      expect(produced.signal).toBeNull();

      const proposalNames = readdirSync(smokeRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('onbrand-proposal-'))
        .map((entry) => entry.name);
      expect(proposalNames).toHaveLength(1);
      const proposalName = proposalNames[0]!;
      expect(proposalName).toBe(EXPECTED_PROPOSAL_NAME);
      const proposalDir = path.join(smokeRoot, proposalName);
      const brandDir = path.join(proposalDir, 'brand');
      const distDir = path.join(brandDir, 'dist');
      const explanationPath = path.join(distDir, INSPIRATION_VIEW_OUTPUT);
      const specimenPath = path.join(distDir, SPECIMEN_VIEW_OUTPUT);
      const requiredArtifacts = [
        'raw-image-analysis.json',
        'image-report.md',
        'brand/tokens.json',
        'brand/modes.dark.json',
        'brand/inspiration.json',
        'brand/guide.md',
        'brand/assets/inspiration.png',
        'brand/dist/manifest.json',
        `brand/dist/${INSPIRATION_VIEW_OUTPUT}`,
        `brand/dist/${SPECIMEN_VIEW_OUTPUT}`,
      ];
      for (const relative of requiredArtifacts) {
        expect(existsSync(path.join(proposalDir, ...relative.split('/'))), relative).toBe(true);
      }
      expect(existsSync(path.join(proposalDir, 'INCOMPLETE.md'))).toBe(false);
      expect(readFileSync(path.join(brandDir, 'assets', 'inspiration.png'))).toEqual(syntheticBytes);
      const rawEvidence = JSON.parse(readFileSync(path.join(proposalDir, 'raw-image-analysis.json'), 'utf8')) as {
        width: number;
        height: number;
        samples: Array<{ id: string }>;
      };
      expect(rawEvidence).toMatchObject({ width: SYNTHETIC_WIDTH, height: SYNTHETIC_HEIGHT });
      const manifest = JSON.parse(readFileSync(path.join(distDir, 'manifest.json'), 'utf8')) as {
        llm: string;
        outputs: Record<string, string>;
        outputSources?: Record<string, Array<{ label: string }>>;
      };
      expect(manifest.llm).toBe('none');
      expect(manifest.outputs).toHaveProperty(INSPIRATION_VIEW_OUTPUT);
      expect(manifest.outputs).toHaveProperty(SPECIMEN_VIEW_OUTPUT);
      expect(manifest.outputSources?.[INSPIRATION_VIEW_OUTPUT]?.length).toBeGreaterThanOrEqual(3);
      expect(manifest.outputSources?.[SPECIMEN_VIEW_OUTPUT]?.length).toBeGreaterThanOrEqual(1);
      const check = runCheck(proposalDir);
      expect(check.ok, check.findings.map((finding) => `${finding.code}: ${finding.message}`).join('\n')).toBe(true);
      expect(check.errorCount).toBe(0);
      accepted('production-transaction-complete', {
        entryPoint: 'bin/onbrand.mjs',
        artifactCount: requiredArtifacts.length,
        checkErrors: check.errorCount,
        incompleteMarker: false,
        provenanceRows:
          (manifest.outputSources?.[INSPIRATION_VIEW_OUTPUT]?.length ?? 0) +
          (manifest.outputSources?.[SPECIMEN_VIEW_OUTPUT]?.length ?? 0),
      });

      const trace = JSON.parse(readFileSync(path.join(brandDir, 'inspiration.json'), 'utf8')) as {
        summary: string;
        mappings: Array<{ id: string; label: string; sample: { hex: string } }>;
      };
      expect(trace.mappings.length).toBeGreaterThanOrEqual(4);
      const expectedNumbers = Array.from({ length: trace.mappings.length }, (_, index) => index + 1);
      accepted('synthetic-distributed-mappings', { count: trace.mappings.length });

      const catalogPath = path.join(smokeRoot, ...CATALOG_RELATIVE_PATH.split('/'));
      const pairedCatalogBytes = readFileSync(catalogPath);
      const catalog = JSON.parse(pairedCatalogBytes.toString('utf8')) as InspirationArtifact;
      expect(catalog.schema).toBe(INSPIRATION_ARTIFACT_SCHEMA);
      expect(catalog.schemaVersion).toBe(INSPIRATION_ARTIFACT_SCHEMA_VERSION);
      expect(catalog.generatedAt).toBe(CLOCK);
      const matchingItems = catalog.items.filter((item) => item.relPath === proposalName);
      expect(matchingItems).toHaveLength(1);
      const matchingItem = matchingItems[0]!;
      const locatorValues = productionLocatorValues(proposalName);
      expect(matchingItem).toMatchObject({
        traceState: 'available',
        standalonePath: locatorValues.explanation,
        specimenPath: locatorValues.specimen,
      });
      expect(path.resolve(smokeRoot, ...matchingItem.standalonePath!.split('/'))).toBe(explanationPath);
      expect(path.resolve(smokeRoot, ...matchingItem.specimenPath!.split('/'))).toBe(specimenPath);
      accepted('paired-catalog-current-once', {
        matchingItems: matchingItems.length,
        traceState: 'available',
        standalonePath: matchingItem.standalonePath,
        specimenPath: matchingItem.specimenPath,
      });
      accepted('production-output-locator-semantics', {
        relativeTo: 'ephemeral-production-root',
        retained: false,
        proposalRoot: locatorValues.proposalRoot,
        catalog: locatorValues.catalog,
        explanation: locatorValues.explanation,
        specimen: locatorValues.specimen,
      });

      const refreshed = runCli(['inspiration-export', '--root', smokeRoot, '--out', CATALOG_RELATIVE_PATH]);
      expect(
        refreshed.status,
        `inspiration-export failed\nstdout: ${refreshed.stdout}\nstderr: ${refreshed.stderr}`,
      ).toBe(0);
      expect(Buffer.compare(readFileSync(catalogPath), pairedCatalogBytes)).toBe(0);
      accepted('standalone-catalog-byte-parity', { sha256: sha256(pairedCatalogBytes) });

      try {
        browser = await chromium.launch();
      } catch (cause) {
        throw new Error(
          'Step 31 requires a launchable Playwright Chromium browser and may not skip. ' +
            'Install it with `npx playwright install chromium`, then rerun test/inspiration.e2e.test.ts. ' +
            `Launch error: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      accepted('chromium-launched', { launched: true });

      const explanationUrl = pathToFileURL(explanationPath).href;
      const wideScreenshot = path.join(screenshotDir, 'wide-1280x900.png');
      wideContext = await browser.newContext({ viewport: { width: WIDE.width, height: WIDE.height }, reducedMotion: 'reduce' });
      const widePage = await wideContext.newPage();
      const wideFailures = attachFailureCollectors(widePage);
      await widePage.goto(explanationUrl, { waitUntil: 'load' });
      expect(await widePage.evaluate(() => ({
        width: (globalThis as any).innerWidth as number,
        height: (globalThis as any).innerHeight as number,
      }))).toEqual({ width: WIDE.width, height: WIDE.height });
      const wideBounds = await widePage.evaluate(() => {
        const g = globalThis as any;
        const document = g.document;
        const rect = (selector: string) => {
          const box = document.querySelector(selector).getBoundingClientRect();
          return {
            top: box.top as number,
            bottom: box.bottom as number,
            left: box.left as number,
            right: box.right as number,
            width: box.width as number,
            height: box.height as number,
          };
        };
        const sourcePrimary = rect('.source-primary');
        const sourceSecondary = rect('.source-secondary');
        const implementationPrimary = rect('.implementation-primary');
        const implementationSecondary = rect('.implementation-secondary');
        const sourceParts = [sourcePrimary, sourceSecondary];
        const sourcePanel = {
          top: Math.min(...sourceParts.map((box) => box.top)),
          bottom: Math.max(...sourceParts.map((box) => box.bottom)),
          left: Math.min(...sourceParts.map((box) => box.left)),
          right: Math.max(...sourceParts.map((box) => box.right)),
        };
        const palette = rect('.palette-overview');
        return {
          sourceTop: sourcePanel.top,
          sourceBottom: sourcePanel.bottom,
          sourceLeft: sourcePanel.left,
          sourceRight: sourcePanel.right,
          sourceWidth: sourcePanel.right - sourcePanel.left,
          sourceHeight: sourcePanel.bottom - sourcePanel.top,
          paletteBottom: palette.bottom,
          sections: {
            sourcePrimary,
            sourceSecondary,
            implementationPrimary,
            implementationSecondary,
          },
        };
      });
      expect(wideBounds.sourceWidth).toBeGreaterThan(0);
      expect(wideBounds.sourceHeight).toBeGreaterThan(0);
      expect(wideBounds.sourceLeft).toBeGreaterThanOrEqual(0);
      expect(wideBounds.sourceRight).toBeLessThanOrEqual(WIDE.width);
      expect(wideBounds.sourceBottom).toBeLessThanOrEqual(WIDE.height);
      expect(wideBounds.paletteBottom).toBeLessThanOrEqual(WIDE.height);
      const wideSections = wideBounds.sections;
      expect(Math.min(wideSections.sourcePrimary.right, wideSections.sourceSecondary.right))
        .toBeGreaterThan(Math.max(wideSections.sourcePrimary.left, wideSections.sourceSecondary.left));
      expect(Math.min(wideSections.implementationPrimary.right, wideSections.implementationSecondary.right))
        .toBeGreaterThan(Math.max(wideSections.implementationPrimary.left, wideSections.implementationSecondary.left));
      expect(wideSections.sourcePrimary.right).toBeLessThanOrEqual(wideSections.implementationPrimary.left);
      expect(wideSections.sourceSecondary.right).toBeLessThanOrEqual(wideSections.implementationSecondary.left);
      expect(wideSections.sourceSecondary.top).toBeGreaterThanOrEqual(wideSections.sourcePrimary.bottom - 0.5);
      expect(wideSections.implementationSecondary.top).toBeGreaterThanOrEqual(wideSections.implementationPrimary.bottom - 0.5);
      await widePage.screenshot({ path: wideScreenshot });
      expect(pngDimensions(wideScreenshot)).toEqual({ width: WIDE.width, height: WIDE.height });
      accepted('wide-source-complete-above-fold', { bottom: rounded(wideBounds.sourceBottom), fold: WIDE.height });
      accepted('wide-palette-summary-above-fold', { bottom: rounded(wideBounds.paletteBottom), fold: WIDE.height });
      accepted('wide-screenshot-exact', pngDimensions(wideScreenshot));

      const lightGrouping = await themeGrouping(widePage);
      expect(lightGrouping.theme).toBe('light');
      expect(lightGrouping.modeLabel).toContain('Light');
      expect(lightGrouping.targetCount).toBeGreaterThanOrEqual(trace.mappings.length);
      expect(lightGrouping.allMatchActiveMode).toBe(true);
      expect(lightGrouping.ariaLabelsComplete).toBe(true);
      await widePage.focus('#theme-toggle');
      await widePage.keyboard.press('Enter');
      const darkGrouping = await themeGrouping(widePage);
      expect(darkGrouping.theme).toBe('dark');
      expect(darkGrouping.modeLabel).toContain('Dark');
      expect(darkGrouping.allMatchActiveMode).toBe(true);
      expect(darkGrouping.ariaLabelsComplete).toBe(true);
      expect(darkGrouping.colors.some((color, index) => color !== lightGrouping.colors[index])).toBe(true);
      expect(await widePage.locator('#theme-toggle').getAttribute('aria-pressed')).toBe('true');
      expect(await widePage.locator('#theme-toggle').textContent()).toContain('Switch to light');
      await widePage.keyboard.press('Enter');
      accepted('light-dark-computed-grouping', { targetCount: lightGrouping.targetCount, changed: true });

      expect(await widePage.locator('[tabindex]').evaluateAll((nodes: any[]) =>
        nodes.filter((node) => Number(node.getAttribute('tabindex')) > 0).length)).toBe(0);
      await widePage.reload({ waitUntil: 'load' });
      const focusEvidence = await assertKeyboardFocusOrder(widePage);
      accepted('keyboard-focus-order-and-outlines', {
        order: focusEvidence.order,
        positiveTabindex: 0,
        imageOverlayFocusInset: focusEvidence.imageOverlay.inset,
        imageOverlayFocusPixelsVisible: focusEvidence.imageOverlay.renderedPixels > 100,
        imageOverlayOutlineOffset: focusEvidence.imageOverlay.outlineOffset,
        imageOverlayOutlineWidth: focusEvidence.imageOverlay.outlineWidth,
      });

      const mappingSummary = widePage.locator('.mapping-details > summary');
      await mappingSummary.focus();
      await widePage.keyboard.press('Enter');
      expect(await widePage.locator('.mapping-details').evaluate((node: any) => node.open as boolean)).toBe(true);
      expect(await numberedData(widePage, '.mapping')).toEqual(expectedNumbers);
      await widePage.keyboard.press('Enter');
      expect(await widePage.locator('.mapping-details').evaluate((node: any) => node.open as boolean)).toBe(false);
      accepted('keyboard-disclosure', { mappingCards: expectedNumbers.length, returnedCollapsed: true });

      await widePage.focus('#image-zoom-open');
      await widePage.keyboard.press('Enter');
      expect(await widePage.locator('#image-zoom-dialog').evaluate((node: any) => node.open as boolean)).toBe(true);
      expect(await activeElementKey(widePage)).toBe('#image-zoom-close');
      expect(await widePage.locator('#image-zoom-image').getAttribute('alt')).toBe(ALT);
      expect(await widePage.locator('#image-zoom-image').getAttribute('src')).toBe(
        await widePage.locator('#inspiration-image').getAttribute('src'),
      );
      await widePage.waitForFunction(() => (globalThis as any).document.getElementById('image-zoom-image').naturalWidth > 0);
      const fittedWidth = (await widePage.locator('#image-zoom-image').boundingBox())?.width;
      expect(fittedWidth).toBeDefined();
      await widePage.focus('#image-zoom-toggle');
      await widePage.keyboard.press('Enter');
      const zoomedWidth = (await widePage.locator('#image-zoom-image').boundingBox())?.width;
      expect(zoomedWidth).toBeDefined();
      expect(zoomedWidth!).toBeGreaterThan(fittedWidth! * 1.8);
      expect(await widePage.locator('#image-zoom-toggle').getAttribute('aria-pressed')).toBe('true');
      await widePage.focus('#image-zoom-close');
      await widePage.keyboard.press('Enter');
      expect(await widePage.locator('#image-zoom-dialog').evaluate((node: any) => node.open as boolean)).toBe(false);
      expect(await activeElementKey(widePage)).toBe('#image-zoom-open');
      accepted('keyboard-zoom-dialog-and-focus-return', { copiedAlt: true, zoomFactorAtLeast: 1.8, focusReturned: true });

      const reducedMotion = await widePage.evaluate(() => {
        const g = globalThis as any;
        const style = g.getComputedStyle(g.document.getElementById('theme-toggle'));
        return {
          mediaMatches: g.matchMedia('(prefers-reduced-motion: reduce)').matches as boolean,
          animationName: style.animationName as string,
          transitionDuration: style.transitionDuration as string,
          scrollBehavior: g.getComputedStyle(g.document.documentElement).scrollBehavior as string,
        };
      });
      expect(reducedMotion).toEqual({
        mediaMatches: true,
        animationName: 'none',
        transitionDuration: '0s',
        scrollBehavior: 'auto',
      });
      accepted('reduced-motion-computed', reducedMotion);

      await widePage.route('https://fonts.googleapis.com/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/css', body: '/* hermetic Step 31 font response */' }));
      await widePage.locator('.action').click();
      expect(new URL(widePage.url()).pathname.endsWith('/specimen.html')).toBe(true);
      expect(await widePage.locator('header h1').textContent()).toContain('on-brand specimen');
      expectNoBrowserFailures('wide interactions and specimen handoff', wideFailures);
      accepted('full-specimen-handoff', { navigated: true, headingFound: true });

      const narrowScreenshot = path.join(screenshotDir, 'narrow-390x844.png');
      narrowContext = await browser.newContext({ viewport: { width: NARROW.width, height: NARROW.height }, reducedMotion: 'reduce' });
      const narrowPage = await narrowContext.newPage();
      const narrowFailures = attachFailureCollectors(narrowPage);
      await narrowPage.goto(explanationUrl, { waitUntil: 'load' });
      const narrowLayout = await narrowPage.evaluate(() => {
        const g = globalThis as any;
        const document = g.document;
        const image = document.querySelector('.image-wrap').getBoundingClientRect();
        const palette = document.querySelector('.palette-overview').getBoundingClientRect();
        const sectionClasses = [
          'source-primary',
          'implementation-primary',
          'source-secondary',
          'implementation-secondary',
        ];
        const sectionBoxes = sectionClasses.map((className) => {
          const box = document.querySelector(`.${className}`).getBoundingClientRect();
          return { className, top: box.top as number, bottom: box.bottom as number };
        });
        const layout = document.querySelector('.layout');
        return {
          viewport: { width: g.innerWidth as number, height: g.innerHeight as number },
          imageBottom: image.bottom as number,
          paletteTop: palette.top as number,
          paletteBottom: palette.bottom as number,
          documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
          detailsCollapsed: [...document.querySelectorAll('details')].every((node: any) => !node.open),
          domSectionOrder: [...layout.children]
            .filter((node: any) => sectionClasses.some((className) => node.classList.contains(className)))
            .map((node: any) => sectionClasses.find((className) => node.classList.contains(className))),
          visualSectionOrder: [...sectionBoxes]
            .sort((left, right) => left.top - right.top)
            .map((box) => box.className),
          sectionsDoNotOverlap: sectionBoxes.slice(1).every((box, index) =>
            box.top >= sectionBoxes[index]!.bottom - 0.5),
        };
      });
      expect(narrowLayout.viewport).toEqual({ width: NARROW.width, height: NARROW.height });
      expect(narrowLayout.imageBottom).toBeLessThanOrEqual(NARROW.height);
      expect(narrowLayout.paletteTop).toBeGreaterThanOrEqual(narrowLayout.imageBottom);
      expect(narrowLayout.paletteBottom).toBeLessThanOrEqual(NARROW.height);
      expect(narrowLayout.documentOverflow).toBeLessThanOrEqual(0);
      expect(narrowLayout.bodyOverflow).toBeLessThanOrEqual(0);
      expect(narrowLayout.detailsCollapsed).toBe(true);
      expect(narrowLayout.domSectionOrder).toEqual([
        'source-primary',
        'implementation-primary',
        'source-secondary',
        'implementation-secondary',
      ]);
      expect(narrowLayout.visualSectionOrder).toEqual(narrowLayout.domSectionOrder);
      expect(narrowLayout.sectionsDoNotOverlap).toBe(true);

      const pinNumbers = await numberedData(narrowPage, '.pin');
      const paletteNumbers = await numberedData(narrowPage, '.palette-item');
      const fallbackNumbers = await numberedText(narrowPage, 'ol.sr-only > li');
      expect(pinNumbers).toEqual(expectedNumbers);
      expect(paletteNumbers).toEqual(expectedNumbers);
      expect(fallbackNumbers).toEqual(expectedNumbers);
      expect(await narrowPage.locator('.source-pin-fallback > li').allTextContents()).toEqual(
        trace.mappings.map((mapping, index) => `${index + 1}. ${mapping.label}: ${mapping.sample.hex}`),
      );
      const numberAssociations = await narrowPage.evaluate(() => {
        const document = (globalThis as any).document;
        const pins = [...document.querySelectorAll('.pin')] as any[];
        return pins.map((pin) => {
          const number = Number(pin.getAttribute('data-mapping-number'));
          const palette = document.getElementById(`palette-item-${number}`);
          const fallback = document.getElementById(`source-pin-fallback-${number}`);
          const card = document.getElementById(`mapping-detail-${number}`);
          return Boolean(
            palette && fallback && card &&
            pin.getAttribute('aria-details') === card.id &&
            String(pin.getAttribute('aria-describedby') ?? '').split(/\s+/).includes(fallback.id) &&
            palette.getAttribute('aria-details') === card.id,
          );
        });
      });
      expect(numberAssociations).toEqual(expectedNumbers.map(() => true));
      const pinGeometry = await narrowPage.evaluate(() => {
        const document = (globalThis as any).document;
        const image = document.getElementById('inspiration-image').getBoundingClientRect();
        const pins = [...document.querySelectorAll('.pin')] as any[];
        const centers = pins.map((pin: any) => {
          const box = pin.getBoundingClientRect();
          return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        });
        const visiblePins = pins.filter((pin) => {
          const box = pin.getBoundingClientRect();
          const style = (globalThis as any).getComputedStyle(pin);
          return box.width > 0 && box.height > 0 && box.left >= image.left && box.right <= image.right &&
            box.top >= image.top && box.bottom <= image.bottom &&
            style.visibility !== 'hidden' && Number(style.opacity) > 0;
        });
        const swatches = [...document.querySelectorAll('.palette-item .swatch, .palette-target')] as any[];
        const visibleSwatches = swatches.filter((swatch) => {
          const box = swatch.getBoundingClientRect();
          const style = (globalThis as any).getComputedStyle(swatch);
          return box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= (globalThis as any).innerWidth &&
            box.top >= 0 && box.bottom <= (globalThis as any).innerHeight &&
            style.visibility !== 'hidden' && Number(style.opacity) > 0;
        });
        return {
          allCentersInImage: centers.every((center) =>
            center.x >= image.left && center.x <= image.right && center.y >= image.top && center.y <= image.bottom),
          distinctCenterCount: new Set(centers.map((center) => `${center.x.toFixed(2)},${center.y.toFixed(2)}`)).size,
          pinCount: pins.length,
          visiblePinCount: visiblePins.length,
          swatchCount: swatches.length,
          visibleSwatchCount: visibleSwatches.length,
        };
      });
      expect(pinGeometry.allCentersInImage).toBe(true);
      expect(pinGeometry.distinctCenterCount).toBe(expectedNumbers.length);
      expect(pinGeometry.visiblePinCount).toBe(pinGeometry.pinCount);
      expect(pinGeometry.pinCount).toBe(expectedNumbers.length);
      expect(pinGeometry.visibleSwatchCount).toBe(pinGeometry.swatchCount);
      expect(pinGeometry.swatchCount).toBeGreaterThan(expectedNumbers.length);
      await narrowPage.screenshot({ path: narrowScreenshot });
      expect(pngDimensions(narrowScreenshot)).toEqual({ width: NARROW.width, height: NARROW.height });
      expectNoBrowserFailures('narrow explanation', narrowFailures);
      accepted('narrow-source-and-palette-above-fold', {
        sourceBottom: rounded(narrowLayout.imageBottom),
        paletteBottom: rounded(narrowLayout.paletteBottom),
        fold: NARROW.height,
      });
      accepted('narrow-collapsed-without-overflow', {
        detailsCollapsed: narrowLayout.detailsCollapsed,
        horizontalOverflow: Math.max(narrowLayout.documentOverflow, narrowLayout.bodyOverflow),
      });
      accepted('numbered-source-fallback-summary-and-cards', {
        count: expectedNumbers.length,
        distinctPinCenters: pinGeometry.distinctCenterCount,
        linkedAssociations: numberAssociations.filter(Boolean).length,
        visiblePins: pinGeometry.visiblePinCount,
        visibleSwatches: pinGeometry.visibleSwatchCount,
      });
      accepted('narrow-screenshot-exact', pngDimensions(narrowScreenshot));

      const noJsScreenshot = path.join(screenshotDir, 'no-js-390x844.png');
      noJsContext = await browser.newContext({
        viewport: { width: NO_JS.width, height: NO_JS.height },
        javaScriptEnabled: false,
        reducedMotion: 'reduce',
      });
      const noJsPage = await noJsContext.newPage();
      const noJsFailures = attachFailureCollectors(noJsPage);
      await noJsPage.goto(explanationUrl, { waitUntil: 'load' });
      const noJsProposalTitle = noJsPage.locator('header .header-copy > h1');
      const noJsProposalSummary = noJsPage.locator('header .header-copy > p:not(.eyebrow)');
      expect(await noJsProposalTitle.isVisible()).toBe(true);
      expect(await noJsProposalTitle.textContent()).toBe(TITLE);
      expect(await noJsProposalSummary.isVisible()).toBe(true);
      expect(await noJsProposalSummary.textContent()).toBe(trace.summary);
      for (const [label, locator] of [
        ['proposal title', noJsProposalTitle],
        ['proposal summary', noJsProposalSummary],
      ] as const) {
        const box = await locator.boundingBox();
        expect(box, `${label} must have a layout box`).not.toBeNull();
        expect(box!.x, `${label} left bound`).toBeGreaterThanOrEqual(0);
        expect(box!.y, `${label} top bound`).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width, `${label} right bound`).toBeLessThanOrEqual(NO_JS.width);
        expect(box!.y + box!.height, `${label} bottom bound`).toBeLessThanOrEqual(NO_JS.height);
      }
      expect(await noJsPage.locator('#inspiration-image').getAttribute('alt')).toBe(ALT);
      expect(await noJsPage.locator('#inspiration-image').isVisible()).toBe(true);
      expect(await noJsPage.locator('.palette-overview').isVisible()).toBe(true);
      expect(await noJsPage.locator('.palette-item').count()).toBe(expectedNumbers.length);
      expect(await noJsPage.locator('.screen-purpose').textContent()).toContain('measured image colors');
      expect(await noJsPage.locator('.metadata').textContent()).toContain('Synthetic test fixture');
      expect(await noJsPage.locator('.asset-alt').isVisible()).toBe(true);
      expect(await noJsPage.locator('.asset-alt').textContent()).toBe(ALT);
      expect(await noJsPage.locator('.action').isVisible()).toBe(true);
      expect(await noJsPage.locator('.no-js-note').isVisible()).toBe(true);
      expect(await noJsPage.locator('.no-js-note').textContent()).toMatch(/JavaScript|interactive/i);
      expect(await noJsPage.locator('#theme-toggle').isVisible()).toBe(false);
      expect(await noJsPage.locator('#image-zoom-open').isVisible()).toBe(false);
      const noJsLayout = await noJsPage.evaluate(() => {
        const document = (globalThis as any).document;
        return {
          horizontalOverflow: Math.max(
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
            document.body.scrollWidth - document.body.clientWidth,
          ) as number,
          paletteBottom: document.querySelector('.palette-overview').getBoundingClientRect().bottom as number,
        };
      });
      expect(noJsLayout.horizontalOverflow).toBeLessThanOrEqual(0);
      expect(noJsLayout.paletteBottom).toBeLessThanOrEqual(NO_JS.height);
      await noJsPage.screenshot({ path: noJsScreenshot });
      expect(pngDimensions(noJsScreenshot)).toEqual({ width: NO_JS.width, height: NO_JS.height });
      await noJsPage.locator('.mapping-details > summary').click();
      expect(await noJsPage.locator('.mapping').first().isVisible()).toBe(true);
      const noJsModeValues = await noJsPage.evaluate(() => {
        const g = globalThis as any;
        const rows = [...g.document.querySelectorAll('.mapping-details .target')] as any[];
        const readable = (node: any): boolean => {
          const style = g.getComputedStyle(node);
          const box = node.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 &&
            box.width > 0 && box.height > 0;
        };
        return rows.map((row) => {
          const light = row.querySelector('.light-value');
          const dark = row.querySelector('.dark-value');
          return {
            lightText: String(light?.textContent ?? '').trim(),
            darkText: String(dark?.textContent ?? '').trim(),
            lightReadable: light !== null && readable(light),
            darkReadable: dark !== null && readable(dark),
          };
        });
      });
      expect(noJsModeValues.length).toBeGreaterThanOrEqual(expectedNumbers.length);
      expect(noJsModeValues.every((row) => row.lightReadable && row.darkReadable)).toBe(true);
      expect(noJsModeValues.every((row) => /^Light:\s*#[0-9a-f]{6}$/i.test(row.lightText))).toBe(true);
      expect(noJsModeValues.every((row) => /^Dark:\s*#[0-9a-f]{6}$/i.test(row.darkText))).toBe(true);
      await noJsPage.locator('.mapping-details > summary').click();
      expectNoBrowserFailures('no-JavaScript explanation', noJsFailures);
      accepted('no-js-readable-core', {
        mappingCount: expectedNumbers.length,
        authoredAltVisible: true,
        staticNoteVisible: true,
        inertControlsHidden: true,
        horizontalOverflow: noJsLayout.horizontalOverflow,
        paletteBottom: rounded(noJsLayout.paletteBottom),
        fold: NO_JS.height,
      });
      accepted('no-js-native-disclosure-both-mode-values', {
        targetCount: noJsModeValues.length,
        lightValuesReadable: noJsModeValues.filter((row) => row.lightReadable).length,
        darkValuesReadable: noJsModeValues.filter((row) => row.darkReadable).length,
      });
      accepted('no-js-screenshot-exact', pngDimensions(noJsScreenshot));
      accepted('browser-error-collections-empty', {
        consoleMessages: 0,
        pageErrors: 0,
        requestFailures: 0,
      });
      const wideScreenshotBytes = readFileSync(wideScreenshot);
      const narrowScreenshotBytes = readFileSync(narrowScreenshot);
      const noJsScreenshotBytes = readFileSync(noJsScreenshot);
      accepted('retained-screenshot-content-hashes', {
        wide: sha256(wideScreenshotBytes),
        narrow: sha256(narrowScreenshotBytes),
        noJavaScript: sha256(noJsScreenshotBytes),
      });

      const evidence: AcceptanceEvidence = {
        schema: 'onbrand.inspiration-producer-acceptance-evidence',
        schemaVersion: 1,
        generatedAt: CLOCK,
        input: {
          kind: 'synthetic-raster',
          generator: 'test/inspiration.e2e.test.ts',
          sha256: syntheticSha256,
          mediaType: 'image/png',
          width: SYNTHETIC_WIDTH,
          height: SYNTHETIC_HEIGHT,
        },
        viewports: [WIDE, NARROW, NO_JS],
        assertions,
        outputs: productionOutputLocators(locatorValues),
        screenshots: {
          wide: `${RETAINED_RELATIVE_DIR}/wide-1280x900.png`,
          narrow: `${RETAINED_RELATIVE_DIR}/narrow-390x844.png`,
          noJavaScript: `${RETAINED_RELATIVE_DIR}/no-js-390x844.png`,
          evidence: `${RETAINED_RELATIVE_DIR}/evidence.json`,
        },
      };
      assertEvidenceShapeAndLocators(evidence, !updateEvidence);
      assertProductionOutputLocatorSemantics(evidence, proposalName, smokeRoot);
      assertCurrentRepositoryLocators(evidence, updateEvidence);
      const evidenceText = assertPortableEvidence(evidence, [tempRoot]);
      const temporaryEvidencePath = path.join(screenshotDir, 'evidence.json');
      writeFileSync(temporaryEvidencePath, evidenceText);
      const temporaryTargets = [wideScreenshot, narrowScreenshot, noJsScreenshot, temporaryEvidencePath];
      for (const target of temporaryTargets) {
        const relative = path.relative(tempRoot, target);
        expect(path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)).toBe(false);
      }
      promotionPayload = new Map<(typeof RETAINED_FILES)[number], Buffer>([
        ['wide-1280x900.png', wideScreenshotBytes],
        ['narrow-390x844.png', narrowScreenshotBytes],
        ['no-js-390x844.png', noJsScreenshotBytes],
        ['evidence.json', readFileSync(temporaryEvidencePath)],
      ]);
      currentEvidence = evidence;
      bodySucceeded = true;
    } catch (cause) {
      bodyFailure = cause;
    }

    // Every teardown is attempted independently. Promotion remains impossible
    // until all browser contexts, the browser, and the OS-temp root are gone.
    const cleanupFailures = await cleanupAcceptanceResources({
      contexts: [noJsContext, narrowContext, wideContext],
      browser,
      tempRoot,
    });
    if (!bodySucceeded) rethrowPrimaryFailure(bodyFailure, cleanupFailures);
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, 'Step 31 acceptance teardown failed');
    }
    expect(currentEvidence).toBeDefined();
    expect(promotionPayload).toBeDefined();

    finalizeRetainedEvidence({
      updateEvidence,
      target: REPOSITORY_RETAINED_EVIDENCE_TARGET,
      retainedBefore,
      promotionPayload: promotionPayload!,
      currentEvidence,
    });
  }, 240_000);
});
