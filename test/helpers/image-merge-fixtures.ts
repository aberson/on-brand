/**
 * Seeded output-preservation fixtures for the image cluster merge (Step 41).
 *
 * The Phase I2I2B merge speedup is OUTPUT-PRESERVING by contract: for identical
 * input bytes every produced cluster, palette, and evidence document must stay
 * byte-identical to the pre-change implementation.  This module owns the seeded
 * raster synthesis and the exact encoder options, so the regeneration script
 * (`gen-image-merge-baseline.ts`) and the assertions
 * (`test/extract.image-palette.test.ts`) can never disagree about what a fixture
 * is.
 *
 * Nothing here is random or clock-dependent: a fixed 32-bit PRNG seed produces
 * the same palette and the same pixel assignment on every machine, and `sharp`
 * is pinned to an exact version in `package.json`, so the encoded bytes (and
 * therefore every decoder's working raster) are reproducible.  The pinned
 * `assetSha256` in `test/fixtures/image-merge/baseline.json` fails loudly if an
 * encoder ever drifts, rather than surfacing as a mystery cluster mismatch.
 *
 * The decode + downsample chain below is copied VERBATIM from the module-private
 * `decodeOrientedRaster()` / `workingRaster()` in `src/extract/image-palette.ts`
 * (the same copy `.claude/skills/brand-iterate/scripts/measure-colors.ts` keeps),
 * because `analyzeImageRaster()` must be pinned on the exact working raster the
 * production adapter feeds it.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  MAX_DECODED_PIXELS,
  MAX_IMAGE_CHANNELS,
  WORKING_LONG_EDGE,
} from '../../src/extract/image-palette.ts';

export type MergeFixtureFormat = 'png' | 'jpeg' | 'webp';
export type MergeFixtureCardinality = 'low' | 'medium' | 'high';

/** One synthesized source raster, shared by all three container formats. */
export interface MergeFixtureProfile {
  cardinality: MergeFixtureCardinality;
  width: number;
  height: number;
  /** Edge length of one flat colour cell, in source pixels. */
  cell: number;
  /** Number of distinct seeded source colours drawn into the raster. */
  paletteSize: number;
  seed: number;
}

export interface MergeFixtureSpec extends MergeFixtureProfile {
  /** `<cardinality>-<format>`; the key used in the pinned baseline document. */
  id: string;
  format: MergeFixtureFormat;
  filename: string;
}

/**
 * Three cardinality tiers.  `low` stays under the twelve-sample budget, `medium`
 * lands in the low hundreds of merged clusters, and `high` pushes the merge into
 * the several-hundred-cluster regime where the per-comparison allocation used to
 * dominate wall time.  `high` is deliberately NOT sized at the measured 4,186
 * pool ceiling: the pre-change implementation needs many minutes there, which no
 * per-test timeout can host.
 */
export const MERGE_FIXTURE_PROFILES: readonly MergeFixtureProfile[] = [
  { cardinality: 'low', width: 48, height: 48, cell: 16, paletteSize: 8, seed: 0x0be1_0001 },
  { cardinality: 'medium', width: 160, height: 160, cell: 8, paletteSize: 200, seed: 0x0be1_0002 },
  { cardinality: 'high', width: 240, height: 240, cell: 6, paletteSize: 620, seed: 0x0be1_0003 },
];

export const MERGE_FIXTURE_FORMATS: readonly MergeFixtureFormat[] = ['png', 'jpeg', 'webp'];

const EXTENSION: Record<MergeFixtureFormat, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
};

export const MERGE_FIXTURES: readonly MergeFixtureSpec[] = MERGE_FIXTURE_PROFILES.flatMap((profile) =>
  MERGE_FIXTURE_FORMATS.map((format) => ({
    ...profile,
    format,
    id: `${profile.cardinality}-${format}`,
    filename: `${profile.cardinality}-${format}.${EXTENSION[format]}`,
  })),
);

/**
 * The seeded raster used by the performance guard.  It is larger than the `high`
 * preservation fixture so the guard exercises the merge in the regime the phase
 * was written for, and it never leaves memory (no encode, no filesystem).
 */
export const MERGE_PERF_PROFILE: MergeFixtureProfile = {
  cardinality: 'high',
  width: 256,
  height: 256,
  cell: 4,
  paletteSize: 1_400,
  seed: 0x0be1_00ff,
};

/** Deterministic 32-bit PRNG. Identical sequence on every platform and runtime. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface SeededRaster {
  data: Buffer;
  width: number;
  height: number;
  channels: 3;
}

/**
 * Synthesize the profile's RGB raster: a seeded palette painted into a grid of
 * flat `cell`-pixel squares, row-major, cycling through the palette so exactly
 * `min(cells, paletteSize)` distinct colours appear.
 *
 * Spatial coherence is load-bearing, not cosmetic.  Per-pixel colour noise makes
 * a lossy encoder invent thousands of near-unique edge colours, which turns a
 * "medium" fixture into a multi-minute merge and makes the tier labels meaningless.
 * Flat cells keep every tier's cardinality where this file says it is.
 */
export function seededRaster(profile: MergeFixtureProfile): SeededRaster {
  const random = mulberry32(profile.seed);
  const palette = new Uint8Array(profile.paletteSize * 3);
  for (let index = 0; index < palette.length; index += 1) {
    palette[index] = Math.floor(random() * 256);
  }
  const data = Buffer.allocUnsafe(profile.width * profile.height * 3);
  const columns = Math.ceil(profile.width / profile.cell);
  for (let y = 0; y < profile.height; y += 1) {
    const cellRow = Math.floor(y / profile.cell) * columns;
    for (let x = 0; x < profile.width; x += 1) {
      const source = ((cellRow + Math.floor(x / profile.cell)) % profile.paletteSize) * 3;
      const offset = (y * profile.width + x) * 3;
      data[offset] = palette[source]!;
      data[offset + 1] = palette[source + 1]!;
      data[offset + 2] = palette[source + 2]!;
    }
  }
  return { data, width: profile.width, height: profile.height, channels: 3 };
}

/**
 * Encode one spec's raster with fixed, explicitly stated encoder options.
 *
 * JPEG runs at quality 100 / 4:4:4 and WebP runs lossless on purpose.  The point
 * of spanning three containers is to prove the merge is stable across three real
 * decoders and three distinct byte streams; turning the quality down instead
 * measures how badly a lossy encoder shreds synthetic blocks, which is a
 * different (and unbounded) experiment.
 */
export async function encodeFixture(spec: MergeFixtureSpec): Promise<Buffer> {
  const raster = seededRaster(spec);
  const image = sharp(raster.data, {
    raw: { width: raster.width, height: raster.height, channels: 3 },
  });
  if (spec.format === 'png') return image.png({ compressionLevel: 9 }).toBuffer();
  if (spec.format === 'jpeg') {
    return image.jpeg({ quality: 100, chromaSubsampling: '4:4:4', mozjpeg: false }).toBuffer();
  }
  return image.webp({ lossless: true, effort: 4 }).toBuffer();
}

/** Write every fixture into `directory` and return its absolute pathname by id. */
export async function writeMergeFixtures(directory: string): Promise<Map<string, string>> {
  const written = new Map<string, string>();
  for (const spec of MERGE_FIXTURES) {
    const target = path.join(directory, spec.filename);
    writeFileSync(target, await encodeFixture(spec));
    written.set(spec.id, target);
  }
  return written;
}

/**
 * Verbatim mirror of the module-private `decodeOrientedRaster()` +
 * `workingRaster()` in `src/extract/image-palette.ts`.  `kernel: 'nearest'` and
 * `flatten({ background: '#ffffff' })` are load-bearing for byte-identical
 * clusters; do not "simplify" them.
 */
export async function workingRasterOf(bytes: Buffer): Promise<SeededRaster> {
  const oriented = await sharp(bytes, {
    failOn: 'warning',
    limitInputPixels: MAX_DECODED_PIXELS,
    limitInputChannels: MAX_IMAGE_CHANNELS,
    pages: 1,
    sequentialRead: true,
  })
    .rotate()
    .toColourspace('srgb')
    .flatten({ background: '#ffffff' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const working = await sharp(oriented.data, {
    raw: {
      width: oriented.info.width,
      height: oriented.info.height,
      channels: oriented.info.channels,
    },
  })
    .resize({
      width: WORKING_LONG_EDGE,
      height: WORKING_LONG_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
      kernel: 'nearest',
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (working.info.channels !== 3) {
    throw new Error(`fixture downsample produced ${working.info.channels} channels, expected 3`);
  }
  return {
    data: working.data,
    width: working.info.width,
    height: working.info.height,
    channels: 3,
  };
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The repo-relative module whose merge behaviour the baseline pins. */
export const MERGE_SOURCE_MODULE = 'src/extract/image-palette.ts';

/**
 * SHA-256 of a source file with CRLF normalized to LF, so the digest equals the
 * file's git blob digest and is identical on a Windows (core.autocrlf) checkout
 * and a POSIX one. Used to prove WHICH implementation a baseline was generated
 * from.
 */
export function sourceDigest(absolutePath: string): string {
  return sha256Hex(readFileSync(absolutePath, 'utf8').replace(/\r\n/g, '\n'));
}

/** SHA-256 over the exact bytes backing the per-pixel merged-cluster identity map. */
export function pixelClustersDigest(pixelClusters: Int32Array): string {
  return sha256Hex(
    Buffer.from(pixelClusters.buffer, pixelClusters.byteOffset, pixelClusters.byteLength),
  );
}

/** The committed baseline document, keyed by fixture id. */
export interface MergeBaselineEntry {
  cardinality: MergeFixtureCardinality;
  format: MergeFixtureFormat;
  sourceWidth: number;
  sourceHeight: number;
  workingWidth: number;
  workingHeight: number;
  /** SHA-256 of the encoded fixture bytes; pins the encoder, not just the merge. */
  assetSha256: string;
  clusterCount: number;
  /** SHA-256 of `JSON.stringify(clusters)` over the FULL merged pool, in order. */
  clustersSha256: string;
  /** The first eight merged clusters verbatim, so a mismatch is diagnosable. */
  clustersHead: Array<{ count: number; red: number; green: number; blue: number; hex: string }>;
  pixelClusterCount: number;
  pixelClustersSha256: string;
  /** `measureImagePalette()` output with the temp `assetPath` replaced by the id. */
  evidence: unknown;
}

/**
 * Which implementation produced this baseline. The whole point of the document
 * is that it PREDATES the code under test, so that fact is recorded mechanically
 * rather than asserted in prose.
 */
export interface MergeBaselineSource {
  /** `git rev-parse HEAD` at generation time. */
  commit: string;
  module: string;
  /** `sourceDigest()` of `module` as it stood at generation time. */
  moduleSha256: string;
}

export interface MergeBaselineDocument {
  note: string;
  generator: string;
  source: MergeBaselineSource;
  fixtures: Record<string, MergeBaselineEntry>;
}

export const MERGE_BASELINE_PATH = 'test/fixtures/image-merge/baseline.json';
