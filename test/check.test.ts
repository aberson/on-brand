/**
 * Step 20 contract tests for the structured check report. The pre-existing
 * contrast/lint/drift tests exercise individual branches; these assertions pin
 * the shared JSON-facing shape each branch contributes to `runCheck()`.
 */

import {
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { compileBrand } from '../src/build/compile.ts';
import {
  CHECK_REPORT_SCHEMA,
  CHECK_REPORT_SCHEMA_VERSION,
  formatCheckReport,
  runCheck,
} from '../src/check/run.ts';
import { recordSpecimenView } from '../src/inspiration/views.ts';
import {
  PREVIEW_TOKENS_CSS_INPUT,
  SPECIMEN_VIEW_MAX_BYTES,
  SPECIMEN_VIEW_OUTPUT,
} from '../src/preview/contract.ts';
import { generatePreview } from '../src/preview/specimen.ts';

const CHECK_IO_CALLS = vi.hoisted(() => ({
  reads: [] as string[],
  inspections: [] as string[],
  hashes: [] as Array<{ target: string; maxBytes: number | undefined }>,
}));

vi.mock('../src/filesystem.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/filesystem.ts')>();
  type Options = { maxBytes?: number; requireSingleLink?: boolean };
  return {
    ...actual,
    stableReadRegularFile(target: string, options: Options = {}) {
      CHECK_IO_CALLS.reads.push(target);
      return actual.stableReadRegularFile(target, options);
    },
    stableInspectRegularFile(target: string, options: Options = {}) {
      CHECK_IO_CALLS.inspections.push(target);
      return actual.stableInspectRegularFile(target, options);
    },
    stableHashRegularFile(target: string, options: Options = {}) {
      CHECK_IO_CALLS.hashes.push({ target, maxBytes: options.maxBytes });
      return actual.stableHashRegularFile(target, options);
    },
  };
});

const PRESET_DIR = fileURLToPath(new URL('../templates/presets/default', import.meta.url));
const GARBAGE = fileURLToPath(new URL('./fixtures/check/garbage', import.meta.url));
const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-structured-check-'));
  tempDirs.push(dir);
  const brand = path.join(dir, 'brand');
  mkdirSync(brand, { recursive: true });
  copyFileSync(path.join(PRESET_DIR, 'tokens.json'), path.join(brand, 'tokens.json'));
  copyFileSync(path.join(PRESET_DIR, 'modes.dark.json'), path.join(brand, 'modes.dark.json'));
  return dir;
}

function resetCheckIoCalls(): void {
  CHECK_IO_CALLS.reads.length = 0;
  CHECK_IO_CALLS.inspections.length = 0;
  CHECK_IO_CALLS.hashes.length = 0;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('structured onbrand check report', () => {
  it('reports WCAG evidence and a safe next command instead of asking consumers to parse prose', () => {
    const report = runCheck(GARBAGE);
    expect(report.schema).toBe(CHECK_REPORT_SCHEMA);
    expect(report.schemaVersion).toBe(CHECK_REPORT_SCHEMA_VERSION);

    const finding = report.findings.find((item) => item.code === 'wcag-contrast-fail');
    expect(finding).toBeDefined();
    expect(finding).toMatchObject({
      severity: 'error',
      category: 'wcag',
      path: 'color.semantic.text',
      nextCommand: 'onbrand check',
    });
    expect(finding!.evidence).toMatchObject({
      mode: 'light',
      foregroundPath: 'color.semantic.text',
      backgroundPath: 'color.semantic.bg',
      foreground: '#7c7c7c',
      background: '#8a8a8a',
      requiredRatio: 4.5,
    });
    expect(finding!.nextCommand).not.toMatch(/\b(rm|del|remove)\b/i);
  });

  it('reports schema evidence and a verification command for an unknown token category', () => {
    const project = tempProject();
    const tokensPath = path.join(project, 'brand', 'tokens.json');
    const tokens = JSON.parse(readFileSync(tokensPath, 'utf8')) as Record<string, unknown>;
    tokens.colour = { $type: 'color', oops: { $value: '#123456' } };
    writeFileSync(tokensPath, `${JSON.stringify(tokens, null, 2)}\n`, 'utf8');

    const finding = runCheck(project).findings.find(
      (item) => item.code === 'schema-unknown-top-level-category',
    );
    expect(finding).toMatchObject({
      severity: 'warning',
      category: 'schema',
      path: 'colour',
      nextCommand: 'onbrand check',
      evidence: { category: 'colour' },
    });
  });

  it('makes the observed dist-incomplete case explicit, with output proof and rebuild command', () => {
    const project = tempProject();
    compileBrand(project);
    rmSync(path.join(project, 'brand', 'dist', 'components.css'));

    const finding = runCheck(project).findings.find(
      (item) => item.code === 'stale-dist-output-missing',
    );
    expect(finding).toMatchObject({
      severity: 'error',
      category: 'stale-dist',
      path: 'components.css',
      nextCommand: 'onbrand build',
      evidence: { output: 'components.css', fileExists: false },
    });

    const text = formatCheckReport(runCheck(project));
    expect(text).toContain('Stale dist');
    expect(text).toContain('Evidence:');
    expect(text).toContain('Next: onbrand build');
  });

  it('fails closed when manifest.json is a hard-linked target', () => {
    const project = tempProject();
    compileBrand(project);
    const manifestPath = path.join(project, 'brand', 'dist', 'manifest.json');
    const sentinel = path.join(project, 'manifest-sentinel.json');
    const bytes = readFileSync(manifestPath);
    writeFileSync(sentinel, bytes);
    rmSync(manifestPath);
    linkSync(sentinel, manifestPath);

    const report = runCheck(project);
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        path: 'dist/manifest.json',
        evidence: expect.objectContaining({ safeTarget: false }),
      }),
    ]));
  });

  it('fails closed on an unrecorded hard-linked optional specimen', () => {
    const project = tempProject();
    compileBrand(project);
    const sentinel = path.join(project, 'specimen-sentinel.html');
    writeFileSync(sentinel, '<p>sentinel</p>\n', 'utf8');
    linkSync(sentinel, path.join(project, 'brand', 'dist', 'specimen.html'));

    const report = runCheck(project);
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        path: 'specimen.html',
        evidence: expect.objectContaining({ safeTarget: false }),
      }),
    ]));
  });

  it('uses metadata-only inspection for ordinary outputs and stream hashing for the specimen', () => {
    const project = tempProject();
    const built = compileBrand(project);
    const preview = generatePreview(project);
    expect(recordSpecimenView(
      project,
      preview.generation,
      built.manifest.sourceHash,
      { required: true },
    )).toBe(true);

    resetCheckIoCalls();
    const report = runCheck(project);
    expect(report.ok).toBe(true);
    const dist = path.join(project, 'brand', 'dist');
    const ordinary = path.join(dist, PREVIEW_TOKENS_CSS_INPUT);
    const specimen = path.join(dist, SPECIMEN_VIEW_OUTPUT);
    expect(CHECK_IO_CALLS.inspections).toEqual(expect.arrayContaining([ordinary, specimen]));
    expect(CHECK_IO_CALLS.reads).not.toContain(ordinary);
    expect(CHECK_IO_CALLS.hashes.some((call) => call.target === ordinary)).toBe(false);
    expect(CHECK_IO_CALLS.reads).not.toContain(specimen);
    expect(CHECK_IO_CALLS.hashes).toEqual([{ target: specimen, maxBytes: SPECIMEN_VIEW_MAX_BYTES }]);

    truncateSync(specimen, SPECIMEN_VIEW_MAX_BYTES + 1);
    resetCheckIoCalls();
    const overLimit = runCheck(project);
    expect(overLimit.ok).toBe(false);
    expect(overLimit.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'stale-dist-output-missing',
        path: SPECIMEN_VIEW_OUTPUT,
        evidence: expect.objectContaining({ safeTarget: false }),
      }),
    ]));
    expect(CHECK_IO_CALLS.reads).not.toContain(specimen);
    expect(CHECK_IO_CALLS.hashes).toEqual([{ target: specimen, maxBytes: SPECIMEN_VIEW_MAX_BYTES }]);
  });
});
