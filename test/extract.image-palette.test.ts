/** Deterministic bounded local-raster palette evidence (I2I Step 23). */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Color from 'colorjs.io';
import sharp from 'sharp';
import {
  CLUSTER_MERGE_DELTA_E,
  ImagePaletteAdapter,
  ImagePaletteError,
  MAX_IMAGE_BYTES,
  REGION_SIZE,
  WORKING_LONG_EDGE,
  analyzeImageRaster,
  clusterImageRaster,
  detectImageMediaType,
  measureImagePalette,
  readBoundedImageFile,
} from '../src/extract/image-palette.ts';
import { S_L_CEILING, deltaE2000, lightnessGapCeiling } from '../src/extract/color-metric.ts';
import {
  IMAGE_CLUSTER_ALGORITHM,
  IMAGE_CLUSTER_ALGORITHM_V2,
  PALETTE_FAMILY_DELTA_E,
  hasQualifyingPaletteSupport,
  readPaletteSupportEvidence,
} from '../src/extract/palette-evidence.ts';
import { selectPaletteDecision } from '../src/extract/normalize.ts';
import {
  MERGE_FIXTURES,
  MERGE_PERF_PROFILE,
  MERGE_SOURCE_MODULE,
  type MergeBaselineDocument,
  mulberry32,
  pixelClustersDigest,
  seededRaster,
  sha256Hex,
  workingRasterOf,
  writeMergeFixtures,
} from './helpers/image-merge-fixtures.ts';

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'onbrand-image-palette-'));
afterAll(() => rmSync(temporaryRoot, { recursive: true, force: true }));

function fixturePath(name: string): string {
  return path.join(temporaryRoot, name);
}

async function writeRgbaPng(name: string, width: number, height: number, pixels: number[]): Promise<string> {
  const output = fixturePath(name);
  await sharp(Buffer.from(pixels), { raw: { width, height, channels: 4 } }).png().toFile(output);
  return output;
}

describe('ImagePaletteAdapter — fixed image-cluster-v1 evidence', () => {
  it('preserves weighted channel totals when repeated near-color bins merge', () => {
    const data = Buffer.from([
      100, 100, 100,
      100, 100, 100,
      100, 100, 100,
      104, 104, 104,
    ]);

    expect(clusterImageRaster({ data, width: 4, height: 1, channels: 3 })).toEqual([
      { count: 4, red: 101, green: 101, blue: 101, hex: '#656565' },
    ]);
  });

  it('produces byte-stable histogram ordering, shares, and 0.04 source regions for an opaque PNG', async () => {
    // Equal counts deliberately exercise the frozen lowercase-hex tie break:
    // green sorts before red, independently of source-pixel order.
    const png = await writeRgbaPng('opaque.png', 4, 2, [
      255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255,
      255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255,
    ]);

    const adapter = new ImagePaletteAdapter();
    const first = await adapter.measureFile(png);
    const second = await adapter.measureFile(png);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.algorithm).toBe(IMAGE_CLUSTER_ALGORITHM);
    expect(first.width).toBe(4);
    expect(first.height).toBe(2);
    expect(first.source).toMatchObject({ kind: 'image', mediaType: 'image/png' });
    expect(first.samples.map(({ id, hex, frequency, pixelShare }) => ({ id, hex, frequency, pixelShare }))).toEqual([
      { id: 'sample-01', hex: '#00ff00', frequency: 4, pixelShare: 0.5 },
      { id: 'sample-02', hex: '#ff0000', frequency: 4, pixelShare: 0.5 },
    ]);
    for (const sample of first.samples) {
      expect(sample.region).toMatchObject({ width: REGION_SIZE, height: REGION_SIZE });
      expect(sample.region!.x).toBeGreaterThanOrEqual(0);
      expect(sample.region!.x).toBeLessThanOrEqual(1 - REGION_SIZE);
      expect(sample.region!.y).toBeGreaterThanOrEqual(0);
      expect(sample.region!.y).toBeLessThanOrEqual(1 - REGION_SIZE);
    }
  });

  it('honors alpha compositing over white and returns no alpha-bearing sampled hexes', async () => {
    const png = await writeRgbaPng('alpha.png', 2, 1, [
      0, 0, 255, 0, // fully transparent blue must become white, never sampled blue
      255, 0, 0, 255,
    ]);
    const evidence = await measureImagePalette(png);
    expect(evidence.samples.some((sample) => sample.hex === '#0000ff')).toBe(false);
    expect(evidence.samples.some((sample) => sample.hex === '#ffffff')).toBe(true);
    expect(evidence.samples.every((sample) => /^#[0-9a-f]{6}$/.test(sample.hex))).toBe(true);
  });

  it('accepts all three v1 raster types and records exact raw-byte digests', async () => {
    const raw = Buffer.from([
      24, 90, 188, 255, 24, 90, 188, 255,
      224, 170, 62, 255, 224, 170, 62, 255,
    ]);
    const png = fixturePath('format.png');
    const jpeg = fixturePath('format.jpg');
    const webp = fixturePath('format.webp');
    await sharp(raw, { raw: { width: 2, height: 2, channels: 4 } }).png().toFile(png);
    await sharp(raw, { raw: { width: 2, height: 2, channels: 4 } }).jpeg({ quality: 100 }).toFile(jpeg);
    await sharp(raw, { raw: { width: 2, height: 2, channels: 4 } }).webp({ quality: 100 }).toFile(webp);

    const adapter = new ImagePaletteAdapter();
    for (const [file, mediaType] of [
      [png, 'image/png'],
      [jpeg, 'image/jpeg'],
      [webp, 'image/webp'],
    ] as const) {
      const evidence = await adapter.measureFile(file);
      const rawBytes = readFileSync(file);
      expect(evidence.source.mediaType).toBe(mediaType);
      expect(evidence.source.assetSha256).toBe(createHash('sha256').update(rawBytes).digest('hex'));
      expect(evidence.samples.length).toBeGreaterThan(0);
      expect(evidence.samples.length).toBeLessThanOrEqual(12);
      expect(evidence.algorithm).toBe(IMAGE_CLUSTER_ALGORITHM_V2);
      for (const measured of evidence.samples) {
        expect(readPaletteSupportEvidence(measured), `${mediaType} ${measured.id}`).toBeDefined();
      }
    }
  });

  it('honors EXIF orientation before reporting source regions', async () => {
    const jpeg = fixturePath('oriented.jpg');
    await sharp(Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]), {
      raw: { width: 2, height: 1, channels: 4 },
    })
      .jpeg({ quality: 100 })
      .withMetadata({ orientation: 6 })
      .toFile(jpeg);

    const evidence = await measureImagePalette(jpeg);
    expect(evidence.width).toBe(1);
    expect(evidence.height).toBe(2);
    expect(evidence.samples.every((sample) => sample.region !== null)).toBe(true);
  });

  it('retains dominant, neutral, and supported accent families from a crowded raster', async () => {
    // 14 related cool background shades, one neutral field, and four small but
    // spatially coherent accents: 19 merged clusters for a 12-sample budget.
    const width = 128;
    const height = 160;
    const pixels = Buffer.alloc(width * height * 4);
    const put = (x0: number, y0: number, w: number, h: number, rgb: [number, number, number]): void => {
      for (let y = y0; y < y0 + h; y += 1) {
        for (let x = x0; x < x0 + w; x += 1) {
          const offset = (y * width + x) * 4;
          pixels[offset] = rgb[0];
          pixels[offset + 1] = rgb[1];
          pixels[offset + 2] = rgb[2];
          pixels[offset + 3] = 255;
        }
      }
    };
    const shades: Array<[number, number, number]> = Array.from(
      { length: 14 },
      (_, step) => [16 + 14 * step, 58 + 11 * step, 128 + 8 * step] as [number, number, number],
    );
    const neutral: [number, number, number] = [154, 154, 154];
    const accents: Array<[number, number, number]> = [
      [46, 139, 58],
      [210, 105, 30],
      [122, 63, 176],
      [245, 230, 184],
    ];
    put(0, 0, width, height, shades[0]!);
    for (let step = 1; step < shades.length; step += 1) put((step - 1) * 6, 0, 6, 100, shades[step]!);
    put(84, 0, 40, 40, neutral);
    accents.forEach((accent, index) => put(4 + index * 20, 120, 12, 12, accent));
    const toHex = ([r, g, b]: [number, number, number]): string =>
      `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;

    const png = await writeRgbaPng('crowded.png', width, height, [...pixels]);
    const evidence = await measureImagePalette(png);

    expect(evidence.algorithm).toBe(IMAGE_CLUSTER_ALGORITHM_V2);
    expect(evidence.samples).toHaveLength(12);
    expect(evidence.samples.map((measured) => measured.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `sample-${String(index + 1).padStart(2, '0')}`),
    );
    const hexes = evidence.samples.map((measured) => measured.hex);
    expect(hexes[0]).toBe(toHex(shades[0]!));
    expect(hexes[1]).toBe(toHex(neutral));
    for (const accent of accents) expect(hexes).toContain(toHex(accent));
    expect(shades.map(toHex).filter((shade) => !hexes.includes(shade)).length).toBeGreaterThan(0);
    for (const measured of evidence.samples) {
      const support = readPaletteSupportEvidence(measured);
      expect(support, measured.id).toBeDefined();
      expect(measured.region).not.toBeNull();
      expect(hasQualifyingPaletteSupport(support!, width * height)).toBe(true);
    }

    // The production decision seam reaches distinct diverse roles from this pool.
    const decision = selectPaletteDecision(evidence);
    const roleIds = [
      decision.primary.sampleId,
      ...(decision.neutral === null ? [] : [decision.neutral.sampleId]),
      ...decision.secondaries.map((secondary) => secondary.sampleId),
    ];
    expect(new Set(roleIds).size).toBe(roleIds.length);
    expect(decision.neutral).not.toBeNull();
    expect(decision.secondaries.length).toBeGreaterThanOrEqual(4);
  });

  it('allows a proposal to reuse one safely-read byte buffer with final asset provenance', async () => {
    const png = await writeRgbaPng('reuse.png', 1, 1, [12, 34, 56, 255]);
    const loaded = readBoundedImageFile(png);
    const evidence = await new ImagePaletteAdapter().measure({
      ...loaded,
      assetPath: 'brand/assets/inspiration.png',
    });
    expect(evidence.source).toMatchObject({
      assetPath: 'brand/assets/inspiration.png',
      assetSha256: loaded.assetSha256,
      mediaType: 'image/png',
    });
  });
});

describe('ImagePaletteAdapter — bounded rejection and raw-byte identity', () => {
  it('rejects bad magic, truncation, declared-media disagreement, and oversized buffers before decode', async () => {
    const adapter = new ImagePaletteAdapter();
    await expect(adapter.measureBytes(Buffer.from('not a raster'), { assetPath: 'bad' })).rejects.toMatchObject({
      code: 'bad-magic',
    } satisfies Partial<ImagePaletteError>);

    const valid = await writeRgbaPng('truncated.png', 1, 1, [1, 2, 3, 255]);
    const truncated = readFileSync(valid).subarray(0, 20);
    await expect(adapter.measureBytes(truncated, { assetPath: 'truncated.png' })).rejects.toMatchObject({
      code: 'decode-failed',
    } satisfies Partial<ImagePaletteError>);

    const bytes = readFileSync(valid);
    await expect(
      adapter.measureBytes(bytes, { assetPath: 'wrong.jpg', mediaType: 'image/jpeg' }),
    ).rejects.toMatchObject({ code: 'media-type-mismatch' } satisfies Partial<ImagePaletteError>);
    await expect(
      adapter.measureBytes(Buffer.alloc(MAX_IMAGE_BYTES + 1), { assetPath: 'huge.png' }),
    ).rejects.toMatchObject({ code: 'asset-too-large' } satisfies Partial<ImagePaletteError>);
  });

  it('rejects an over-wide but compactly encoded raster from metadata before raw allocation', async () => {
    const oversized = fixturePath('too-wide.png');
    await sharp({
      create: { width: 8_193, height: 1, channels: 3, background: '#ffffff' },
    })
      .png()
      .toFile(oversized);
    await expect(measureImagePalette(oversized)).rejects.toMatchObject({
      code: 'dimension-limit',
    } satisfies Partial<ImagePaletteError>);
  });

  it('rejects animated WebP instead of silently measuring its first frame', async () => {
    const first = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#ff0000' },
    })
      .png()
      .toBuffer();
    const second = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#00ff00' },
    })
      .png()
      .toBuffer();
    const animated = await sharp([first, second], { join: { animated: true } }).webp().toBuffer();
    await expect(
      new ImagePaletteAdapter().measureBytes(animated, { assetPath: 'animated.webp' }),
    ).rejects.toMatchObject({ code: 'too-many-frames' } satisfies Partial<ImagePaletteError>);
  });

  it('changes the raw digest for a one-byte source mutation, including a trailing byte', async () => {
    const png = await writeRgbaPng('digest.png', 1, 1, [100, 110, 120, 255]);
    const before = readBoundedImageFile(png);
    const bytes = readFileSync(png);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0x0a;
    writeFileSync(png, bytes);
    const after = readBoundedImageFile(png);
    expect(after.assetSha256).not.toBe(before.assetSha256);
  });

  it('rejects a symlink rather than following it', async () => {
    const target = await writeRgbaPng('symlink-target.png', 1, 1, [1, 2, 3, 255]);
    const link = fixturePath('symlink.png');
    try {
      symlinkSync(target, link, 'file');
    } catch {
      // Some locked-down Windows runners cannot create file symlinks. The
      // production lstat gate is still covered wherever the OS permits it.
      return;
    }
    expect(() => readBoundedImageFile(link)).toThrow(/symbolic link/);
  });

  it('pins the implementation constants used by the decoder and histogram', () => {
    expect(WORKING_LONG_EDGE).toBe(256);
    expect(REGION_SIZE).toBe(0.04);
    expect(CLUSTER_MERGE_DELTA_E).toBe(3);
    expect(detectImageMediaType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png',
    );
  });
});

// --- Step 41 shared helpers -------------------------------------------------

function hexOf(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Run the production merge over a raster made of the given grey levels, each
 * repeated `count` times. One pixel per repetition, one row, so each grey lands
 * in its own five-bit bin with exactly the count given and the histogram
 * presents them in the frozen frequency-descending / hex-ascending order.
 */
function mergeGreys(levels: ReadonlyArray<readonly [level: number, count: number]>) {
  const pixels = levels.reduce((total, [, count]) => total + count, 0);
  const data = Buffer.alloc(pixels * 3);
  let offset = 0;
  for (const [level, count] of levels) {
    for (let repeat = 0; repeat < count; repeat += 1) {
      data[offset] = level;
      data[offset + 1] = level;
      data[offset + 2] = level;
      offset += 3;
    }
  }
  return analyzeImageRaster({ data, width: pixels, height: 1, channels: 3 }).clusters;
}

/**
 * Step 41 — the merge speedup is OUTPUT-PRESERVING, and this is the hard gate.
 *
 * `test/fixtures/image-merge/baseline.json` was generated from the PRE-change
 * implementation (commit 88bc3d2) by `test/helpers/gen-image-merge-baseline.ts`.
 * Regenerating it to make a failure go away would pin the new behaviour and
 * destroy the gate: a mismatch here means a palette moved, not that the fixture
 * went stale.
 */
/**
 * Per-test budget for every Step 41 test that does real colour math or touches
 * the filesystem.
 *
 * These tests are correctness assertions with a wall-clock side effect, not
 * measurements: none of them asserts anything about elapsed time, so the only
 * thing the default 30s global can do to them is turn machine load into a red
 * build. That is not hypothetical here — it is the same bug-shape twice. Review
 * round 1 caught the perf guard's fixed 4,000ms ceiling failing at 10,829ms
 * during an antivirus scan; round 2 caught these fixture tests reaching
 * 14,970ms (`high-jpeg`) under 40 busy-loop processes on 22 logical cores,
 * against a 1,015ms idle figure — a 14.7x load factor with only 2x left before
 * the global timeout.
 *
 * 120_000 is that worst OBSERVED loaded figure with ~8x headroom, ~100x over
 * idle, and it matches the number the perf guard already carries for the same
 * reason. Nothing here is slow enough for a real hang to hide behind it: the
 * heaviest is ~1s idle, so a genuine infinite loop still fails, it is just not
 * raced by unrelated load.
 */
const LOAD_TOLERANT_TIMEOUT_MS = 120_000;

describe('image cluster merge — pre-change output preservation (Step 41)', () => {
  const baseline = JSON.parse(
    readFileSync(fileURLToPath(new URL('./fixtures/image-merge/baseline.json', import.meta.url)), 'utf8'),
  ) as MergeBaselineDocument;
  const fixtureDir = path.join(temporaryRoot, 'merge-fixtures');
  let files: Map<string, string>;

  // ~25ms idle, so the budget is pure insurance — but this hook is the one that
  // WRITES the nine fixture files, and a real-time antivirus scan on file writes
  // is not proportional to CPU load, it just adds seconds. That is the exact
  // mechanism behind the round-1 flake. A hook timeout is also the worst failure
  // shape available: it fails the whole FILE with zero failed tests (the same
  // pathology vitest.config.ts already documents for the browser suites).
  beforeAll(async () => {
    mkdirSync(fixtureDir, { recursive: true });
    files = await writeMergeFixtures(fixtureDir);
  }, LOAD_TOLERANT_TIMEOUT_MS);

  /**
   * The mechanical half of "this baseline predates the code under test".
   *
   * Prose in the generator header is not a control: the failure mode to close is
   * a future contributor hitting a red output-preservation test, re-running
   * `npx tsx test/helpers/gen-image-merge-baseline.ts`, and silently re-blessing
   * the new output with nothing in the diff to notice. The generator now refuses
   * to overwrite without `--rebaseline`; this test closes the other half.
   *
   * THE PINNED LITERALS BELOW ARE THE CONTROL. `PRE_CHANGE_COMMIT` and
   * `PRE_CHANGE_MODULE_SHA256` are hardcoded here, in the test file, so ANY
   * regeneration — for any reason — moves `baseline.source` away from them and
   * turns this red. Making it green again requires editing these literals, which
   * is a visible, deliberate, reviewable line in the diff. That is precisely the
   * "nobody notices" failure mode, closed. The `git show` cross-check below adds
   * that the recorded digest is genuine rather than hand-typed.
   *
   * What this deliberately does NOT do is compare the recorded digest against
   * the CURRENT source. An earlier revision asserted they must differ, on the
   * theory that a baseline recording today's implementation is self-blessing.
   * That assertion was wrong: the generator docstring sanctions regenerating
   * when a FIXTURE DEFINITION changes, and doing that while
   * `src/extract/image-palette.ts` is untouched legitimately records the current
   * digest — leaving a contributor to choose between a cosmetic no-op edit to a
   * production file and deleting the assertion. It also added nothing, because
   * the literals above already catch every regeneration. A control a normal
   * workflow cannot satisfy is a footgun, not a control.
   */
  it('was generated from an implementation that predates the one under test', () => {
    const PRE_CHANGE_COMMIT = '88bc3d2deee652ef672500b8dcff9e06b2f80180';
    const PRE_CHANGE_MODULE_SHA256 = '2e1bb2d8e7b1645e35d64ae98dd2012dc2d4eb7f9c1906d7a5ddebf1760939b6';
    const repoRoot = fileURLToPath(new URL('..', import.meta.url));

    expect(baseline.source.module).toBe(MERGE_SOURCE_MODULE);
    expect(baseline.source.commit).toBe(PRE_CHANGE_COMMIT);
    expect(baseline.source.moduleSha256).toBe(PRE_CHANGE_MODULE_SHA256);

    // The recorded digest is genuine, not a hand-typed number: it really is the
    // digest of that module at that commit. Skipped where the object is
    // unreachable (a shallow clone or a source export); the pinned literals
    // above still hold there, and they need no git at all.
    const shown = spawnSync('git', ['show', `${PRE_CHANGE_COMMIT}:${MERGE_SOURCE_MODULE}`], {
      cwd: repoRoot,
      encoding: 'buffer',
      maxBuffer: 8_000_000,
    });
    if (shown.status === 0) {
      expect(createHash('sha256').update(shown.stdout).digest('hex')).toBe(PRE_CHANGE_MODULE_SHA256);
    }
  });

  it('pins every declared fixture, so a silently dropped tier cannot pass vacuously', () => {
    expect(Object.keys(baseline.fixtures).sort()).toEqual(MERGE_FIXTURES.map((spec) => spec.id).sort());
    const cardinalities = new Set(Object.values(baseline.fixtures).map((entry) => entry.cardinality));
    const formats = new Set(Object.values(baseline.fixtures).map((entry) => entry.format));
    expect([...cardinalities].sort()).toEqual(['high', 'low', 'medium']);
    expect([...formats].sort()).toEqual(['jpeg', 'png', 'webp']);
    // The tier labels have to mean something: low fits inside the sample budget,
    // high has to actually stress the merge.
    expect(baseline.fixtures['low-png']!.clusterCount).toBeLessThan(12);
    expect(baseline.fixtures['medium-png']!.clusterCount).toBeGreaterThan(100);
    expect(baseline.fixtures['high-png']!.clusterCount).toBeGreaterThan(400);
  });

  // Each of these merges the fixture TWICE by design: once directly, to pin the
  // full merged pool and the per-pixel identity map, and once inside the real
  // measureImagePalette() production path, to pin the serialised evidence. The
  // second pass is not redundant work that could be cached away — routing the
  // evidence assertion around the production entry point is exactly the coverage
  // this file exists to provide, so the budget absorbs the cost instead.
  for (const spec of MERGE_FIXTURES) {
    it(
      `reproduces the pinned ${spec.id} merged pool, identity map, and evidence exactly`,
      async () => {
      const expected = baseline.fixtures[spec.id]!;
      const bytes = readFileSync(files.get(spec.id)!);
      // Pin the encoder too: a drifted fixture must fail here, loudly, rather
      // than surface downstream as an unexplained cluster mismatch.
      expect(sha256Hex(bytes)).toBe(expected.assetSha256);

      const working = await workingRasterOf(bytes);
      expect({ width: working.width, height: working.height }).toEqual({
        width: expected.workingWidth,
        height: expected.workingHeight,
      });

      const analysis = analyzeImageRaster(working);
      expect(analysis.clusters).toHaveLength(expected.clusterCount);
      expect(analysis.clusters.slice(0, 8)).toEqual(expected.clustersHead);
      expect(sha256Hex(JSON.stringify(analysis.clusters))).toBe(expected.clustersSha256);
      expect(analysis.pixelClusters).toHaveLength(expected.pixelClusterCount);
      expect(pixelClustersDigest(analysis.pixelClusters)).toBe(expected.pixelClustersSha256);

      const evidence = await measureImagePalette(files.get(spec.id)!);
      const normalized = { ...evidence, source: { ...evidence.source, assetPath: spec.id } };
      expect(JSON.stringify(normalized)).toBe(JSON.stringify(expected.evidence));
      },
      LOAD_TOLERANT_TIMEOUT_MS,
    );
  }
});

describe('shared colour metric — derived lightness bound (Step 41)', () => {
  const EXACT_S_L_MAXIMUM = 1 + (0.015 * 2500) / Math.sqrt(20 + 2500);
  const lightnessOf = (color: Color): number => color.to('lab').coords[0] ?? 0;

  it('rounds the S_L ceiling UP, never below the true CIEDE2000 maximum', () => {
    expect(S_L_CEILING).toBe(1.75);
    expect(EXACT_S_L_MAXIMUM).toBeCloseTo(1.74702, 5);
    // Rounding UP is the safe direction: a larger ceiling admits MORE pairs to
    // the exact test. A future edit that "tightens" this below the true maximum
    // could skip a pair that genuinely merges, so freeze the inequality too.
    expect(S_L_CEILING).toBeGreaterThanOrEqual(EXACT_S_L_MAXIMUM);
  });

  it('derives the merge gap and the family gap from that one ceiling', () => {
    expect(lightnessGapCeiling(CLUSTER_MERGE_DELTA_E)).toBe(5.25);
    // The exact value compact-palette.ts shipped inline before the import swap.
    expect(lightnessGapCeiling(PALETTE_FAMILY_DELTA_E)).toBe(21);
    expect(lightnessGapCeiling(PALETTE_FAMILY_DELTA_E)).toBe(PALETTE_FAMILY_DELTA_E * 1.75);
  });

  // ~246ms idle for ~40k deltaE evaluations: the only other Step 41 test doing
  // bulk colour math, and the only other one whose runtime scales with machine
  // contention rather than with anything it asserts.
  it('never skips a pair that would have merged, across greyscale and seeded RGB', () => {
    const ceiling = lightnessGapCeiling(CLUSTER_MERGE_DELTA_E);

    // Exhaustive over every greyscale pair: greys maximise |dL| per unit of
    // dE2000, so this is the adversarial direction for the bound.
    const greys = Array.from({ length: 256 }, (_, value) => new Color(hexOf(value, value, value)));
    const greyLightness = greys.map(lightnessOf);
    let widestMergingGap = -1;
    for (let left = 0; left < greys.length; left += 1) {
      for (let right = left + 1; right < greys.length; right += 1) {
        if (deltaE2000(greys[left]!, greys[right]!) >= CLUSTER_MERGE_DELTA_E) continue;
        const gap = Math.abs(greyLightness[left]! - greyLightness[right]!);
        expect(gap, `grey ${left}/${right} merged at |dL|=${gap}`).toBeLessThan(ceiling);
        if (gap > widestMergingGap) widestMergingGap = gap;
      }
    }
    // Sound AND tight enough to be worth having: real merges reach 96% of it.
    expect(widestMergingGap).toBeGreaterThan(ceiling * 0.9);

    // Plus a seeded chromatic sample, so the claim is not greyscale-only.
    const random = mulberry32(0x0be1_5eed);
    const channel = (): number => Math.floor(random() * 256);
    for (let sample = 0; sample < 4_000; sample += 1) {
      const left = new Color(hexOf(channel(), channel(), channel()));
      const right = new Color(hexOf(channel(), channel(), channel()));
      if (deltaE2000(left, right) >= CLUSTER_MERGE_DELTA_E) continue;
      expect(Math.abs(lightnessOf(left) - lightnessOf(right))).toBeLessThan(ceiling);
    }
  }, LOAD_TOLERANT_TIMEOUT_MS);

  it('still merges the widest just-below-ceiling pair and splits one at the ceiling', () => {
    // #000000/#111111 is the greyscale pair with the widest lightness gap that
    // genuinely merges: |dL| = 5.063, 96% of the 5.25 ceiling, dE2000 = 2.963.
    // If the early-out were even slightly too aggressive, this pair would split.
    const near = new Color('#000000');
    const far = new Color('#111111');
    expect(Math.abs(lightnessOf(near) - lightnessOf(far))).toBeCloseTo(5.0633, 3);
    expect(deltaE2000(near, far)).toBeLessThan(CLUSTER_MERGE_DELTA_E);
    expect(mergeGreys([[0x00, 1], [0x11, 1]])).toHaveLength(1);

    // A pair whose lightness gap reaches the ceiling provably cannot merge.
    const dark = new Color('#000000');
    const light = new Color('#242424');
    expect(Math.abs(lightnessOf(dark) - lightnessOf(light))).toBeGreaterThanOrEqual(
      lightnessGapCeiling(CLUSTER_MERGE_DELTA_E),
    );
    expect(deltaE2000(dark, light)).toBeGreaterThanOrEqual(CLUSTER_MERGE_DELTA_E);
    expect(mergeGreys([[0x00, 1], [0x24, 1]])).toHaveLength(2);
  });
});

describe('image cluster merge — cached representative invalidation (Step 41)', () => {
  /**
   * The exact sequence that exposes a stale cached cluster colour.
   *
   *   #141414 x2 opens a cluster; #191919 x2 is within dE 3 of it and is
   *   absorbed, which moves the representative to #171717.
   *   Then #202020 arrives:
   *     dE(#202020, #141414) = 3.691  -> a STALE representative REJECTS it
   *     dE(#202020, #171717) = 2.825  -> the REFRESHED representative ABSORBS it
   *
   * So one cluster proves the later comparison saw the refreshed representative,
   * and two clusters proves it saw the stale one. Removing the cache write in
   * refreshCluster() must fail this test; if it does not, the test is not an
   * instrument.
   */
  const ABSORBER = 0x14;
  const ABSORBED = 0x19;
  const LATER = 0x20;

  it('states the arithmetic the sequence depends on', () => {
    const absorber = new Color(hexOf(ABSORBER, ABSORBER, ABSORBER));
    const absorbed = new Color(hexOf(ABSORBED, ABSORBED, ABSORBED));
    const refreshed = new Color('#171717');
    const later = new Color(hexOf(LATER, LATER, LATER));

    expect(deltaE2000(absorber, absorbed)).toBeLessThan(CLUSTER_MERGE_DELTA_E);
    expect(deltaE2000(later, absorber)).toBeGreaterThanOrEqual(CLUSTER_MERGE_DELTA_E);
    expect(deltaE2000(later, refreshed)).toBeLessThan(CLUSTER_MERGE_DELTA_E);
    // Three distinct five-bit bins, so the histogram really does present three
    // separate merge decisions, in this order.
    expect(new Set([ABSORBER >> 3, ABSORBED >> 3, LATER >> 3]).size).toBe(3);
  });

  it('compares a later bin against the REFRESHED representative, not the stale one', () => {
    const clusters = mergeGreys([[ABSORBER, 2], [ABSORBED, 2], [LATER, 1]]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toEqual({ count: 5, red: 0x18, green: 0x18, blue: 0x18, hex: '#181818' });
  });
});

describe('image cluster merge — performance guard (Step 41)', () => {
  /**
   * This guard exists for exactly one purpose: to fail loudly if the old
   * two-Color-allocations-per-comparison pattern ever comes back. It is NOT a
   * measurement — exact figures live in the step evidence.
   *
   * It deliberately does NOT assert a fixed wall-clock ceiling. The first
   * version did (4,000 ms against a measured 318 ms), and review reproduced a
   * spurious red at 10,829 ms on a machine that was mid-antivirus-scan — 2.7x
   * over the ceiling, with three later runs at 300-360 ms. A merge guard that
   * halts an autonomous `/build-phase` because Defender woke up is worse than no
   * guard. Note the bind a fixed number is in here: the after figure is ~300 ms
   * and the before figure ~11,800 ms, so any ceiling raised far enough to
   * survive real load stops discriminating against the very pattern it exists
   * to catch.
   *
   * So the threshold is derived from a calibration measured in THIS process,
   * moments before, on the same core: the cost of one old-style comparison
   * (two `new Color(...)` plus one `deltaE`). Whatever slows the merge down —
   * antivirus, scheduler preemption, a parallel test file, a slower machine —
   * slows the calibration by the same factor, so the ratio holds and the
   * absolute numbers cancel out. Cold-start is not a factor either: a genuinely
   * cold first merge measures 338 ms against a warm 269 ms, and the calibration
   * runs first, which warms colorjs.io before the merge is ever timed.
   *
   * Recorded on the build machine: merge min-of-3 ~= 270-320 ms; calibration
   * projects the old implementation at ~10,400 ms (directly measured: 11,842 ms).
   * The assertion is min-of-3 < projected/3, which passes with ~13x headroom and
   * which the old implementation fails by ~3.4x.
   */

  /**
   * Inner-loop bin-vs-cluster iterations for this exact seeded raster. A
   * property of the FIXTURE — frozen bin ordering, cluster append order, and the
   * first-match break — not of the implementation: the early-out changes what
   * happens inside an iteration, never how many there are. Counted by a
   * counter-instrumented replica of the production loop (see the step evidence).
   */
  const OLD_STYLE_COMPARISONS = 506_967;
  const CALIBRATION_SAMPLES = 12_000;
  /** Slowest the merge may be relative to the projected old cost. */
  const REQUIRED_SPEEDUP = 3;
  const MERGE_RUNS = 3;

  /** Old-style: construct both colours, then measure. What the merge used to do. */
  function calibrateOldStyleComparison(samples: number): number {
    const hexes = Array.from(
      { length: 512 },
      (_, index) => `#${((index * 7919) % 0xff_ffff).toString(16).padStart(6, '0')}`,
    );
    let sink = 0;
    const started = performance.now();
    for (let sample = 0; sample < samples; sample += 1) {
      const left = hexes[sample % hexes.length]!;
      const right = hexes[(sample * 31 + 17) % hexes.length]!;
      sink += new Color(left).deltaE(new Color(right), { method: '2000' });
    }
    const elapsed = performance.now() - started;
    // Keep the optimizer honest: an unused result could be eliminated wholesale.
    expect(sink).toBeGreaterThan(0);
    return elapsed;
  }

  it(
    'merges a seeded high-cardinality raster far faster than the allocation-per-comparison pattern could',
    () => {
      // Build the raster OUTSIDE the timed region: synthesis, file writes, and
      // decode must never land in the sample.
      const raster = seededRaster(MERGE_PERF_PROFILE);

      // Warm colorjs.io before anything is timed.
      calibrateOldStyleComparison(500);
      const calibrationMs = calibrateOldStyleComparison(CALIBRATION_SAMPLES);
      const projectedOldMs = calibrationMs * (OLD_STYLE_COMPARISONS / CALIBRATION_SAMPLES);

      // Minimum of N, not a single sample: transient load can only make a run
      // SLOWER, never faster, so the minimum is a stable floor.
      let fastestMs = Number.POSITIVE_INFINITY;
      let clusters = 0;
      let pixels = 0;
      for (let run = 0; run < MERGE_RUNS; run += 1) {
        const started = performance.now();
        const analysis = analyzeImageRaster(raster);
        fastestMs = Math.min(fastestMs, performance.now() - started);
        clusters = analysis.clusters.length;
        pixels = analysis.pixelClusters.length;
      }

      // Assert the work actually happened, so the guard cannot pass by measuring
      // an empty merge, and so fixture drift is loud rather than silent.
      expect(clusters).toBe(821);
      expect(pixels).toBe(MERGE_PERF_PROFILE.width * MERGE_PERF_PROFILE.height);

      expect(
        fastestMs,
        `merge min-of-${MERGE_RUNS} was ${fastestMs.toFixed(0)}ms; ` +
          `calibration projects the allocation-per-comparison pattern at ${projectedOldMs.toFixed(0)}ms ` +
          `(${CALIBRATION_SAMPLES} samples in ${calibrationMs.toFixed(0)}ms)`,
      ).toBeLessThan(projectedOldMs / REQUIRED_SPEEDUP);
    },
    // Generous: under heavy load every timed region stretches together, and the
    // ratio still holds — the test just takes longer to reach it.
    120_000,
  );
});
