/**
 * Local-image proposal integration: exercise the real transactional producer,
 * then assert the canonical trace, both generated views, and their distinct
 * provenance are all in place before the INCOMPLETE marker disappears.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { hashContent } from '../src/build/manifest.ts';
import { acquireDistPublicationLock } from '../src/build/publication-lock.ts';
import { runCheck } from '../src/check/run.ts';
import { assertValidInspirationTrace } from '../src/inspiration/contract.ts';
import { InspirationCatalogError } from '../src/inspiration/export.ts';
import {
  INSPIRATION_VIEW_OUTPUT,
  SPECIMEN_CONTENT_SOURCE_LABEL,
  SPECIMEN_VIEW_OUTPUT,
} from '../src/inspiration/views.ts';
import { runFromImage } from '../src/extract/from-image.ts';
import { getLeaf } from '../src/extract/normalize.ts';
import {
  IMAGE_CLUSTER_ALGORITHM_V2,
  readPaletteSupportEvidence,
  type PaletteSample,
} from '../src/extract/palette-evidence.ts';
import { EXIT_OK, EXIT_USAGE } from '../src/cli.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO_ROOT, 'bin', 'onbrand.mjs');
const INPUT = path.join(REPO_ROOT, 'test', 'fixtures', 'extraction', 'screenshots', 'example.png');
const CLOCK = new Date('2026-08-12T12:00:00.000Z');
const EXPECTED_DIR = 'onbrand-proposal-example-20260812';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-fromimage-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function imageOptions(outDir: string, force = false) {
  return {
    title: 'Example image',
    alt: 'A synthetic example screenshot with colored areas.',
    creator: 'Test fixture',
    artworkDate: '2026',
    sourceUrl: 'https://example.test/artwork',
    rights: 'Test-only fixture',
    licenseUrl: 'https://example.test/license',
    retrievedAt: '2026-08-12',
    outDir,
    force,
    now: () => CLOCK,
  };
}

describe('runFromImage — complete local proposal', () => {
  it('creates exact source evidence, canonical trace, side-by-side/specimen, and current provenance', async () => {
    const out = tempDir();
    const result = await runFromImage(INPUT, imageOptions(out));

    expect(result.status).toBe('complete');
    expect(path.basename(result.proposalDir)).toBe(EXPECTED_DIR);
    expect(existsSync(path.join(result.proposalDir, 'INCOMPLETE.md'))).toBe(false);

    const brand = result.brandDir;
    for (const rel of [
      'tokens.json',
      'modes.dark.json',
      'guide.md',
      'inspiration.json',
      'assets/inspiration.png',
      'dist/manifest.json',
      `dist/${INSPIRATION_VIEW_OUTPUT}`,
      `dist/${SPECIMEN_VIEW_OUTPUT}`,
    ]) {
      expect(existsSync(path.join(brand, rel)), rel).toBe(true);
    }
    expect(existsSync(path.join(result.proposalDir, 'raw-image-analysis.json'))).toBe(true);
    expect(existsSync(path.join(result.proposalDir, 'image-report.md'))).toBe(true);

    const traceText = readFileSync(path.join(brand, 'inspiration.json'), 'utf8');
    const trace = assertValidInspirationTrace(JSON.parse(traceText));
    expect(trace.reviewStatus).toBe('generated-draft');
    expect(trace.asset.path).toBe('assets/inspiration.png');
    expect(readFileSync(path.join(brand, 'assets', 'inspiration.png'))).toEqual(readFileSync(INPUT));
    expect(trace.asset.sha256).toBe(createHash('sha256').update(readFileSync(INPUT)).digest('hex'));

    const evidence = JSON.parse(readFileSync(path.join(result.proposalDir, 'raw-image-analysis.json'), 'utf8')) as {
      samples: Array<{ id: string; hex: string; pixelShare: number }>;
    };
    const selectedIds = [
      trace.analysis.primary.sampleId,
      ...(trace.analysis.neutral === null ? [] : [trace.analysis.neutral.sampleId]),
      ...trace.analysis.secondaries.map((secondary) => secondary.sampleId),
    ];
    expect(trace.mappings.map((mapping) => mapping.id)).toEqual(selectedIds);
    const tokens = JSON.parse(readFileSync(path.join(brand, 'tokens.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const dark = JSON.parse(readFileSync(path.join(brand, 'modes.dark.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    for (const mapping of trace.mappings) {
      const measured = evidence.samples.find((sample) => sample.id === mapping.id);
      expect(measured, `mapping ${mapping.id} names a selected measured sample`).toBeDefined();
      if (measured === undefined) continue;
      expect(mapping.sample).toMatchObject({ hex: measured.hex, pixelShare: measured.pixelShare });
      expect(mapping.confidence).toBe(mapping.id === trace.analysis.neutral?.sampleId ? 'medium' : 'high');
      for (const target of mapping.targets) {
        expect(getLeaf(tokens, target.token), `light target ${target.token}`).toEqual(
          expect.any(String),
        );
        expect(getLeaf(dark, target.token), `dark target ${target.token}`).toEqual(
          expect.any(String),
        );
      }
    }

    const manifest = JSON.parse(readFileSync(path.join(brand, 'dist', 'manifest.json'), 'utf8')) as {
      sourceHash: string;
      outputs: Record<string, string>;
      llm: string;
      outputSources?: Record<string, Array<{ label: string; sourcePath: string | null; kind: string; sha256: string }>>;
    };
    expect(manifest.llm).toBe('none');
    expect(manifest.outputs[SPECIMEN_VIEW_OUTPUT]).toBe(manifest.sourceHash);
    expect(manifest.outputs[INSPIRATION_VIEW_OUTPUT]).not.toBe(manifest.sourceHash);
    expect(manifest.outputSources?.[INSPIRATION_VIEW_OUTPUT]).toEqual([
      { label: 'core', sourcePath: null, kind: 'digest', sha256: manifest.sourceHash },
      { label: 'trace', sourcePath: 'inspiration.json', kind: 'text-lf', sha256: hashContent(traceText) },
      { label: 'asset', sourcePath: 'assets/inspiration.png', kind: 'binary', sha256: trace.asset.sha256 },
    ]);
    expect(manifest.outputSources?.[SPECIMEN_VIEW_OUTPUT]).toEqual([{
      label: SPECIMEN_CONTENT_SOURCE_LABEL,
      sourcePath: null,
      kind: 'digest',
      sha256: createHash('sha256')
        .update(readFileSync(path.join(brand, 'dist', SPECIMEN_VIEW_OUTPUT)))
        .digest('hex'),
    }]);

    const explanation = readFileSync(path.join(brand, 'dist', INSPIRATION_VIEW_OUTPUT), 'utf8');
    expect(explanation).toContain('data:image/png;base64,');
    expect(explanation).toContain('Review status: generated-draft');
    expect(explanation).toContain('Open full component specimen');
    expect(runCheck(result.proposalDir).ok).toBe(true);
  }, 120_000);

  it('--force reuses the unsuffixed deterministic proposal directory and replaces prior contents', async () => {
    const out = tempDir();
    const first = await runFromImage(INPUT, imageOptions(out));
    expect(first.status).toBe('complete');
    writeFileSync(path.join(first.proposalDir, 'old-run-sentinel.txt'), 'old');

    const forced = await runFromImage(INPUT, imageOptions(out, true));
    expect(forced.status).toBe('complete');
    expect(forced.proposalDir).toBe(first.proposalDir);
    expect(existsSync(path.join(forced.proposalDir, 'old-run-sentinel.txt'))).toBe(false);
    expect(existsSync(path.join(forced.brandDir, 'dist', INSPIRATION_VIEW_OUTPUT))).toBe(true);
  }, 120_000);

  it('keeps the complete proposal reviewable when the optional catalog refresh fails', async () => {
    const out = tempDir();
    const retry = 'node onbrand.mjs inspiration-export --root workspace --out catalog.json';
    const releaseDiagnostic = 'Additionally, owned catalog lock could not be released.';
    const result = await runFromImage(INPUT, {
      ...imageOptions(out),
      refreshCatalog: () => {
        throw new InspirationCatalogError(
          'catalog writer is locked',
          { kind: 'command', label: 'retry with:', command: retry },
          { additionalDiagnostics: [releaseDiagnostic] },
        );
      },
    });

    expect(result.status).toBe('catalog-failed');
    expect(result.stageFailed).toBe('catalog');
    expect(result.error).toBe(`catalog writer is locked\n${releaseDiagnostic}\nretry with:\n${retry}`);
    expect(existsSync(path.join(result.proposalDir, 'INCOMPLETE.md'))).toBe(false);
    expect(existsSync(path.join(result.brandDir, 'dist', INSPIRATION_VIEW_OUTPUT))).toBe(true);
    expect(existsSync(path.join(result.brandDir, 'dist', SPECIMEN_VIEW_OUTPUT))).toBe(true);
    expect(runCheck(result.proposalDir).ok).toBe(true);
  }, 120_000);

  it('flattens foreign catalog prose instead of treating punctuation as a command protocol', async () => {
    const out = tempDir();
    const result = await runFromImage(INPUT, {
      ...imageOptions(out),
      refreshCatalog: () => {
        throw new Error('foreign catalog error\nretry with:\nnot-an-owned-command');
      },
    });

    expect(result).toMatchObject({
      status: 'catalog-failed',
      stageFailed: 'catalog',
      error: 'foreign catalog error retry with: not-an-owned-command',
    });
    expect(result.error).not.toContain('\n');
    expect(existsSync(path.join(result.proposalDir, 'INCOMPLETE.md'))).toBe(false);
  }, 120_000);

  it('returns an incomplete preview-stage outcome when required provenance recording is locked', async () => {
    const out = tempDir();
    let held: ReturnType<typeof acquireDistPublicationLock> | undefined;
    let result;
    try {
      result = await runFromImage(INPUT, {
        ...imageOptions(out),
        beforeSpecimenRecord: (proposalDir) => {
          held = acquireDistPublicationLock(proposalDir);
        },
      });
    } finally {
      expect(held?.release()).toBe(true);
    }

    expect(result).toMatchObject({
      status: 'incomplete',
      stageFailed: 'preview',
      error: expect.stringMatching(/publication lock|live local PID/),
    });
    expect(existsSync(path.join(result.proposalDir, 'INCOMPLETE.md'))).toBe(true);
    expect(readFileSync(path.join(result.proposalDir, 'INCOMPLETE.md'), 'utf8')).toContain('preview (FAILED)');
    expect(existsSync(path.join(result.proposalDir, 'image-report.md'))).toBe(false);
    expect(existsSync(path.join(result.brandDir, 'dist', SPECIMEN_VIEW_OUTPUT))).toBe(true);
    const failedManifest = JSON.parse(
      readFileSync(path.join(result.brandDir, 'dist', 'manifest.json'), 'utf8'),
    ) as { outputs: Record<string, string> };
    expect(failedManifest.outputs).not.toHaveProperty(SPECIMEN_VIEW_OUTPUT);
  }, 120_000);
});

/**
 * The Step-40 production smoke: one generated PNG, the REAL adapter, selection,
 * synthesis, compile, both generated views, specimen provenance, and check —
 * with no mock, no network, no catalog flag, and no artwork bytes.
 */
async function writeCrowdedPainting(file: string): Promise<void> {
  const width = 192;
  const height = 240;
  const pixels = Buffer.alloc(width * height * 3);
  const put = (x0: number, y0: number, w: number, h: number, rgb: [number, number, number]): void => {
    for (let y = y0; y < y0 + h; y += 1) {
      for (let x = x0; x < x0 + w; x += 1) {
        const offset = (y * width + x) * 3;
        pixels[offset] = rgb[0];
        pixels[offset + 1] = rgb[1];
        pixels[offset + 2] = rgb[2];
      }
    }
  };
  const shades: Array<[number, number, number]> = Array.from(
    { length: 14 },
    (_, step) => [16 + 14 * step, 58 + 11 * step, 128 + 8 * step] as [number, number, number],
  );
  put(0, 0, width, height, shades[0]!);
  for (let step = 1; step < shades.length; step += 1) put((step - 1) * 9, 0, 9, 150, shades[step]!);
  put(126, 0, 60, 60, [154, 154, 154]);
  const accents: Array<[number, number, number]> = [
    [46, 139, 58],
    [210, 105, 30],
    [122, 63, 176],
    [245, 230, 184],
  ];
  accents.forEach((accent, index) => put(6 + index * 30, 180, 18, 18, accent));
  await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toFile(file);
}

describe('runFromImage — image-cluster-v2 production smoke', () => {
  it('completes one crowded generated PNG through measurement, synthesis, build, views, and check', async () => {
    const out = tempDir();
    const source = path.join(tempDir(), 'crowded-painting.png');
    await writeCrowdedPainting(source);

    const startedAt = Date.now();
    const result = await runFromImage(source, {
      ...imageOptions(out),
      title: 'Synthetic crowded painting',
      alt: 'A generated raster with one dominant field, a neutral block, and four small accents.',
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).toBe('complete');
    expect(elapsedMs).toBeLessThan(60_000);
    expect(existsSync(path.join(result.proposalDir, 'INCOMPLETE.md'))).toBe(false);

    const evidence = JSON.parse(
      readFileSync(path.join(result.proposalDir, 'raw-image-analysis.json'), 'utf8'),
    ) as { algorithm: string; samples: PaletteSample[] };
    expect(evidence.algorithm).toBe(IMAGE_CLUSTER_ALGORITHM_V2);
    expect(evidence.samples).toHaveLength(12);
    for (const measured of evidence.samples) {
      expect(readPaletteSupportEvidence(measured), measured.id).toBeDefined();
    }

    const traceText = readFileSync(path.join(result.brandDir, 'inspiration.json'), 'utf8');
    const trace = assertValidInspirationTrace(JSON.parse(traceText));
    expect(trace.analysis.algorithm).toBe(IMAGE_CLUSTER_ALGORITHM_V2);
    expect(trace.mappings.every((mapping) => mapping.sample.method === IMAGE_CLUSTER_ALGORITHM_V2)).toBe(
      true,
    );

    const selectedIds = [
      trace.analysis.primary.sampleId,
      ...(trace.analysis.neutral === null ? [] : [trace.analysis.neutral.sampleId]),
      ...trace.analysis.secondaries.map((secondary) => secondary.sampleId),
    ];
    expect(new Set(selectedIds).size).toBe(selectedIds.length);
    expect(trace.mappings.map((mapping) => mapping.id)).toEqual(selectedIds);
    expect(trace.analysis.neutral).not.toBeNull();
    // A crowded pool must reach several distinct accent roles, not one hue.
    expect(trace.analysis.secondaries.length).toBeGreaterThanOrEqual(4);
    for (const id of selectedIds) {
      expect(evidence.samples.some((measured) => measured.id === id), id).toBe(true);
    }

    const tokens = JSON.parse(readFileSync(path.join(result.brandDir, 'tokens.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const dark = JSON.parse(
      readFileSync(path.join(result.brandDir, 'modes.dark.json'), 'utf8'),
    ) as Record<string, unknown>;
    for (const mapping of trace.mappings) {
      for (const target of mapping.targets) {
        expect(getLeaf(tokens, target.token), `light ${target.token}`).toEqual(expect.any(String));
        expect(getLeaf(dark, target.token), `dark ${target.token}`).toEqual(expect.any(String));
      }
    }

    const report = readFileSync(path.join(result.proposalDir, 'image-report.md'), 'utf8');
    expect(report).toContain(IMAGE_CLUSTER_ALGORITHM_V2);

    const manifest = JSON.parse(
      readFileSync(path.join(result.brandDir, 'dist', 'manifest.json'), 'utf8'),
    ) as { sourceHash: string; outputs: Record<string, string>; llm: string };
    expect(manifest.llm).toBe('none');
    expect(manifest.outputs[SPECIMEN_VIEW_OUTPUT]).toBe(manifest.sourceHash);
    expect(existsSync(path.join(result.brandDir, 'dist', INSPIRATION_VIEW_OUTPUT))).toBe(true);
    expect(existsSync(path.join(result.brandDir, 'dist', SPECIMEN_VIEW_OUTPUT))).toBe(true);
    expect(runCheck(result.proposalDir).ok).toBe(true);
  }, 60_000);
});

describe('onbrand from-image CLI usage', () => {
  it('rejects a missing required --alt flag with the documented usage exit code', () => {
    const result = spawnSync(process.execPath, [BIN, 'from-image', INPUT, '--title', 'Missing alt'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('--title, and --alt are required');
  });

  it('runs the complete deterministic command through the production bin', () => {
    const out = tempDir();
    const result = spawnSync(
      process.execPath,
      [BIN, 'from-image', INPUT, '--title', 'CLI image', '--alt', 'A CLI fixture image.', '--out', out, '--no-llm'],
      {
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, ONBRAND_NOW: CLOCK.toISOString() },
      },
    );
    expect(result.status, result.stderr).toBe(EXIT_OK);
    const proposal = path.join(out, EXPECTED_DIR);
    expect(existsSync(path.join(proposal, 'brand', 'dist', INSPIRATION_VIEW_OUTPUT))).toBe(true);
    expect(existsSync(path.join(proposal, 'brand', 'dist', SPECIMEN_VIEW_OUTPUT))).toBe(true);
  }, 120_000);
});
