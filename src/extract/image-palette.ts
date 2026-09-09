/**
 * Bounded deterministic local-raster palette measurement.
 *
 * `sharp` is deliberately used only as a decoder/orienter/colour converter.
 * Histogram construction, cluster ordering, merging, and representative-region
 * choice all live here so On Brand owns the image-cluster result.  The v1
 * decode/quantization/merge rules are unchanged under `image-cluster-v2`; only
 * WHICH merged clusters survive the frozen twelve-sample budget changed, and
 * that decision lives in the pure `compact-palette.ts` selector.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import Color from 'colorjs.io';
import sharp from 'sharp';
import { deltaE2000, lightnessGapCeiling } from './color-metric.ts';
import { selectCompactPalette } from './compact-palette.ts';
import {
  IMAGE_CLUSTER_ALGORITHM,
  MAX_PALETTE_SAMPLES,
  type ImageClusterAlgorithm,
  type ImageMediaType,
  type PaletteEvidence,
  type PaletteRegion,
  type PaletteSample,
} from './palette-evidence.ts';

/** Fixed v1 safety and algorithm bounds. They are intentionally not caller configurable. */
export const MAX_IMAGE_BYTES = 5_000_000;
export const MAX_IMAGE_DIMENSION = 8_192;
export const MAX_DECODED_PIXELS = 20_000_000;
export const MAX_IMAGE_CHANNELS = 4;
export const WORKING_LONG_EDGE = 256;
export const MAX_IMAGE_CLUSTERS = MAX_PALETTE_SAMPLES;
export const REGION_SIZE = 0.04;
export const HISTOGRAM_BITS_PER_CHANNEL = 5;
export const CLUSTER_MERGE_DELTA_E = 3.0;

/**
 * Derived, not tuned: a bin whose Lab lightness differs from a cluster's by at
 * least this much provably has `ΔE00 >= CLUSTER_MERGE_DELTA_E` and therefore
 * CANNOT merge, so the merge may skip its exact distance.  See
 * `color-metric.ts` for the `S_L <= 1.75` derivation.
 */
const CLUSTER_MERGE_LIGHTNESS_GAP = lightnessGapCeiling(CLUSTER_MERGE_DELTA_E);

export type ImagePaletteErrorCode =
  | 'not-regular-file'
  | 'symlink'
  | 'file-changed'
  | 'asset-too-large'
  | 'bad-magic'
  | 'media-type-mismatch'
  | 'bad-metadata'
  | 'too-many-frames'
  | 'dimension-limit'
  | 'pixel-limit'
  | 'channel-limit'
  | 'decode-failed';

/** A stable, caller-actionable error for rejected untrusted image evidence. */
export class ImagePaletteError extends Error {
  readonly code: ImagePaletteErrorCode;

  constructor(code: ImagePaletteErrorCode, message: string) {
    super(message);
    this.name = 'ImagePaletteError';
    this.code = code;
  }
}

/**
 * Raw local bytes proven to have come from one bounded, non-linked regular
 * file. A later transactional caller can copy these exact bytes without
 * reopening the source and can replace `assetPath` with its final relative path
 * before asking the adapter to measure them.
 */
export interface LoadedImagePaletteInput {
  bytes: Uint8Array;
  assetPath: string;
  assetSha256: string;
  mediaType: ImageMediaType;
}

/** Input for the raw-byte adapter entry point. */
export interface ImagePaletteInput {
  bytes: Uint8Array;
  /** Caller-owned provenance only; this module never opens it. */
  assetPath: string;
  /** When supplied, it must equal the exact SHA-256 of `bytes`. */
  assetSha256?: string;
  /** When supplied, it must agree with the byte magic. */
  mediaType?: ImageMediaType;
}

/** Image evidence adds measured oriented dimensions to the source-neutral contract. */
export interface ImagePaletteEvidence extends PaletteEvidence {
  source: Extract<PaletteEvidence['source'], { kind: 'image' }>;
  /** Narrowed from the source-neutral `string`: images carry a known algorithm. */
  algorithm: ImageClusterAlgorithm;
  /** Dimensions after EXIF orientation and before the 256px working resize. */
  width: number;
  height: number;
}

interface RawRaster {
  data: Buffer;
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
}

interface HistogramBin {
  key: number;
  count: number;
  redTotal: number;
  greenTotal: number;
  blueTotal: number;
  red: number;
  green: number;
  blue: number;
  hex: string;
}

interface MutableCluster {
  count: number;
  redTotal: number;
  greenTotal: number;
  blueTotal: number;
  red: number;
  green: number;
  blue: number;
  hex: string;
  /**
   * Cached perceptual view of `hex`, so the merge builds one `Color` per cluster
   * instead of one per comparison.  INTERNAL to the mutable record — it is
   * deliberately absent from the frozen `ColorCluster` projection callers see.
   *
   * `refreshCluster()` is the ONLY code that mutates `hex`, so it is the only
   * place these can go stale and the only place they are written.  Keep it that
   * way: a second writer, or a lazy derive-on-read, reintroduces exactly the
   * staleness this pair is written to make impossible.
   */
  color: Color;
  /** Lab lightness of `color`, cached for the derived early-out. */
  lightness: number;
}

interface ColorCluster {
  count: number;
  red: number;
  green: number;
  blue: number;
  hex: string;
}

function rejected(code: ImagePaletteErrorCode, message: string): never {
  throw new ImagePaletteError(code, message);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameFileIdentity(before: Stats, after: Stats): boolean {
  // `dev` + `ino` are provided by Node on the supported Windows and CI
  // filesystems. Do not silently downgrade the race check to a pathname check.
  return before.dev === after.dev && before.ino === after.ino;
}

function assertUnchanged(before: Stats, after: Stats): void {
  if (
    !sameFileIdentity(before, after) ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    rejected('file-changed', 'image source changed while it was being read');
  }
}

function assertRegularNonLinked(stats: Stats): void {
  if (stats.isSymbolicLink()) rejected('symlink', 'image source must not be a symbolic link');
  if (!stats.isFile()) rejected('not-regular-file', 'image source must be a regular file');
}

function assertByteLength(length: number): void {
  if (!Number.isSafeInteger(length) || length < 1) {
    rejected('bad-magic', 'image source is empty or has an invalid byte length');
  }
  if (length > MAX_IMAGE_BYTES) {
    rejected('asset-too-large', `image source exceeds the ${MAX_IMAGE_BYTES}-byte limit`);
  }
}

/** Detect only the exact v1 raster allow-list from raw bytes; never trust a suffix. */
export function detectImageMediaType(bytes: Uint8Array): ImageMediaType {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return rejected('bad-magic', 'image source is not a PNG, JPEG, or WebP raster');
}

/**
 * Read a local source once, without following a link, into a bounded byte
 * buffer.  The descriptor identity is checked both before and after the read,
 * which lets proposal code hash/decode/copy this exact returned buffer rather
 * than reopening a raceable pathname.
 */
export function readBoundedImageFile(inputPath: string): LoadedImagePaletteInput {
  const resolvedPath = path.resolve(inputPath);
  let before: Stats;
  try {
    before = lstatSync(resolvedPath);
  } catch {
    rejected('not-regular-file', `cannot inspect image source: ${resolvedPath}`);
  }
  assertRegularNonLinked(before);
  assertByteLength(before.size);

  const noFollow = (fsConstants as Record<string, number>).O_NOFOLLOW ?? 0;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(resolvedPath, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) rejected('not-regular-file', 'opened image source is not a regular file');
    assertUnchanged(before, opened);
    assertByteLength(opened.size);

    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (read === 0) rejected('file-changed', 'image source changed while it was being read');
      offset += read;
    }

    const after = fstatSync(descriptor);
    assertUnchanged(opened, after);
    const mediaType = detectImageMediaType(bytes);
    return {
      bytes,
      assetPath: resolvedPath,
      assetSha256: sha256(bytes),
      mediaType,
    };
  } catch (error) {
    if (error instanceof ImagePaletteError) throw error;
    throw new ImagePaletteError('not-regular-file', `cannot open image source safely: ${resolvedPath}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function meanChannel(total: number, count: number): number {
  // Explicit half-up rounding is part of the frozen histogram contract.
  return Math.floor(total / count + 0.5);
}

function hexFromRgb(red: number, green: number, blue: number): string {
  return `#${red.toString(16).padStart(2, '0')}${green
    .toString(16)
    .padStart(2, '0')}${blue.toString(16).padStart(2, '0')}`;
}

function binKey(red: number, green: number, blue: number): number {
  return ((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3);
}

function binRepresentative(bin: Pick<HistogramBin, 'count' | 'redTotal' | 'greenTotal' | 'blueTotal'>): {
  red: number;
  green: number;
  blue: number;
  hex: string;
} {
  const red = meanChannel(bin.redTotal, bin.count);
  const green = meanChannel(bin.greenTotal, bin.count);
  const blue = meanChannel(bin.blueTotal, bin.count);
  return { red, green, blue, hex: hexFromRgb(red, green, blue) };
}

function makeHistogram(raster: RawRaster): HistogramBin[] {
  const bins = new Map<
    number,
    Pick<HistogramBin, 'key' | 'count' | 'redTotal' | 'greenTotal' | 'blueTotal'>
  >();
  for (let offset = 0; offset < raster.data.length; offset += raster.channels) {
    const red = raster.data[offset]!;
    const green = raster.data[offset + 1]!;
    const blue = raster.data[offset + 2]!;
    const key = binKey(red, green, blue);
    const current = bins.get(key);
    if (current === undefined) {
      bins.set(key, { key, count: 1, redTotal: red, greenTotal: green, blueTotal: blue });
    } else {
      current.count += 1;
      current.redTotal += red;
      current.greenTotal += green;
      current.blueTotal += blue;
    }
  }
  return [...bins.values()]
    .map((bin) => ({ ...bin, ...binRepresentative(bin) }))
    .sort((left, right) => right.count - left.count || left.hex.localeCompare(right.hex));
}

/** Lab lightness of a colour; the same coordinate CIEDE2000's `ΔL'` uses. */
function lightnessOf(color: Color): number {
  return color.to('lab').coords[0] ?? 0;
}

/**
 * Recompute a cluster's representative from its running channel totals.
 *
 * This is the SOLE mutation point for `cluster.hex`, and therefore the sole
 * point at which the cached `color`/`lightness` could go stale — so it rewrites
 * them here, unconditionally, beside the hex they are derived from.
 */
function refreshCluster(cluster: MutableCluster): void {
  const representative = binRepresentative(cluster);
  cluster.red = representative.red;
  cluster.green = representative.green;
  cluster.blue = representative.blue;
  cluster.hex = representative.hex;
  cluster.color = new Color(representative.hex);
  cluster.lightness = lightnessOf(cluster.color);
}

/** The complete merged pool plus the stable per-pixel identity map it produced. */
export interface ImageRasterAnalysis {
  /** Every merged cluster in frozen creation order; NOT truncated to twelve. */
  clusters: ColorCluster[];
  /**
   * Row-major merged-cluster index for every working-raster pixel.  Each 5-bit
   * histogram bin records the exact cluster identity that absorbed it, and every
   * pixel inherits its bin's identity, so membership is never re-guessed after a
   * later merge moved a cluster's representative colour.
   */
  pixelClusters: Int32Array;
}

/**
 * Build the frozen 5-bit histogram and deterministic ΔE2000 merged clusters, and
 * retain the FULL merged pool plus its pixel identity map so compact v2
 * selection can measure family/spatial support before the twelve-sample cap.
 */
export function analyzeImageRaster(raster: RawRaster): ImageRasterAnalysis {
  if (raster.channels < 3 || raster.data.length !== raster.width * raster.height * raster.channels) {
    rejected('decode-failed', 'decoder did not return a valid RGB raster');
  }
  const clusters: MutableCluster[] = [];
  const binCluster = new Map<number, number>();
  for (const bin of makeHistogram(raster)) {
    // One Color per BIN, not one per comparison. Bin order, cluster append
    // order, and the first-match break below are all unchanged and load-bearing.
    const binColor = new Color(bin.hex);
    const binLightness = lightnessOf(binColor);
    let matched = -1;
    for (let index = 0; index < clusters.length; index += 1) {
      const cluster = clusters[index]!;
      // Derived early-out: at this lightness gap the exact distance is provably
      // >= CLUSTER_MERGE_DELTA_E, so skipping it cannot change the verdict.
      if (Math.abs(binLightness - cluster.lightness) >= CLUSTER_MERGE_LIGHTNESS_GAP) continue;
      if (deltaE2000(binColor, cluster.color) < CLUSTER_MERGE_DELTA_E) {
        matched = index;
        break;
      }
    }
    if (matched === -1) {
      binCluster.set(bin.key, clusters.length);
      clusters.push({
        count: bin.count,
        redTotal: bin.redTotal,
        greenTotal: bin.greenTotal,
        blueTotal: bin.blueTotal,
        red: bin.red,
        green: bin.green,
        blue: bin.blue,
        hex: bin.hex,
        // Safe to adopt the bin's colour: a bin that opened a cluster is never
        // compared again, and refreshCluster() replaces this on every mutation.
        color: binColor,
        lightness: binLightness,
      });
    } else {
      const match = clusters[matched]!;
      match.count += bin.count;
      match.redTotal += bin.redTotal;
      match.greenTotal += bin.greenTotal;
      match.blueTotal += bin.blueTotal;
      refreshCluster(match);
      binCluster.set(bin.key, matched);
    }
  }

  const pixelClusters = new Int32Array(raster.width * raster.height);
  let offset = 0;
  for (let pixel = 0; pixel < pixelClusters.length; pixel += 1) {
    const key = binKey(raster.data[offset]!, raster.data[offset + 1]!, raster.data[offset + 2]!);
    const cluster = binCluster.get(key);
    if (cluster === undefined) {
      rejected('decode-failed', 'working raster pixel has no merged cluster identity');
    }
    pixelClusters[pixel] = cluster;
    offset += raster.channels;
  }

  return {
    clusters: clusters.map(({ count, red, green, blue, hex }) => ({ count, red, green, blue, hex })),
    pixelClusters,
  };
}

/**
 * The released frequency-ordered first-twelve view of the merged pool.
 * Exported for focused tests and unchanged by v2; the production adapter uses
 * `analyzeImageRaster()` plus `selectCompactPalette()` instead.
 */
export function clusterImageRaster(raster: RawRaster): ColorCluster[] {
  return analyzeImageRaster(raster).clusters.slice(0, MAX_IMAGE_CLUSTERS);
}

function stableCoordinate(value: number): number {
  // Prevent harmless binary-float tails from becoming JSON/fixture drift.
  return Number(value.toFixed(8));
}

function representativeRegions(raster: RawRaster, clusters: readonly ColorCluster[]): PaletteRegion[] {
  const bestDistance = new Array<number>(clusters.length).fill(Number.POSITIVE_INFINITY);
  const bestX = new Array<number>(clusters.length).fill(0);
  const bestY = new Array<number>(clusters.length).fill(0);

  // Row-major traversal plus strict `<` preserves the top/left winner on ties.
  let offset = 0;
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const red = raster.data[offset]!;
      const green = raster.data[offset + 1]!;
      const blue = raster.data[offset + 2]!;
      for (let index = 0; index < clusters.length; index += 1) {
        const cluster = clusters[index]!;
        const distance =
          (red - cluster.red) ** 2 + (green - cluster.green) ** 2 + (blue - cluster.blue) ** 2;
        if (distance < bestDistance[index]!) {
          bestDistance[index] = distance;
          bestX[index] = x;
          bestY[index] = y;
        }
      }
      offset += raster.channels;
    }
  }

  const maxOrigin = 1 - REGION_SIZE;
  return clusters.map((_, index) => {
    const centeredX = (bestX[index]! + 0.5) / raster.width;
    const centeredY = (bestY[index]! + 0.5) / raster.height;
    return {
      x: stableCoordinate(Math.max(0, Math.min(maxOrigin, centeredX - REGION_SIZE / 2))),
      y: stableCoordinate(Math.max(0, Math.min(maxOrigin, centeredY - REGION_SIZE / 2))),
      width: REGION_SIZE,
      height: REGION_SIZE,
    };
  });
}

function assertMetadata(metadata: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>, mediaType: ImageMediaType): void {
  const expectedFormat = mediaType === 'image/jpeg' ? 'jpeg' : mediaType.slice('image/'.length);
  if (metadata.format !== expectedFormat) {
    rejected('media-type-mismatch', 'image decoder format does not match the byte magic');
  }
  const width = metadata.width;
  const height = metadata.height;
  const channels = metadata.channels;
  if (
    width === undefined ||
    height === undefined ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    rejected('bad-metadata', 'image decoder did not report valid dimensions');
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    rejected('dimension-limit', `image dimensions exceed the ${MAX_IMAGE_DIMENSION}px limit`);
  }
  if (width * height > MAX_DECODED_PIXELS) {
    rejected('pixel-limit', `image exceeds the ${MAX_DECODED_PIXELS}-pixel limit`);
  }
  if (channels === undefined || channels < 1 || channels > MAX_IMAGE_CHANNELS) {
    rejected('channel-limit', `image channels exceed the ${MAX_IMAGE_CHANNELS}-channel limit`);
  }
  if (metadata.pages !== undefined && metadata.pages !== 1) {
    rejected('too-many-frames', 'animated or multi-page images are not supported');
  }
}

function decoder(bytes: Buffer) {
  return sharp(bytes, {
    failOn: 'warning',
    limitInputPixels: MAX_DECODED_PIXELS,
    limitInputChannels: MAX_IMAGE_CHANNELS,
    pages: 1,
    sequentialRead: true,
  });
}

async function decodeOrientedRaster(bytes: Buffer): Promise<RawRaster> {
  try {
    const decoded = await decoder(bytes)
      .rotate()
      .toColourspace('srgb')
      .flatten({ background: '#ffffff' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { data, info } = decoded;
    if (
      info.width < 1 ||
      info.height < 1 ||
      info.width > MAX_IMAGE_DIMENSION ||
      info.height > MAX_IMAGE_DIMENSION ||
      info.width * info.height > MAX_DECODED_PIXELS ||
      info.channels !== 3
    ) {
      rejected('decode-failed', 'decoder produced an invalid normalized RGB raster');
    }
    return { data, width: info.width, height: info.height, channels: info.channels };
  } catch (error) {
    if (error instanceof ImagePaletteError) throw error;
    rejected('decode-failed', 'image could not be decoded safely');
  }
}

async function workingRaster(original: RawRaster): Promise<RawRaster> {
  try {
    const resized = await sharp(original.data, {
      raw: { width: original.width, height: original.height, channels: original.channels },
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
    if (resized.info.channels !== 3 || resized.info.width < 1 || resized.info.height < 1) {
      rejected('decode-failed', 'working raster is not normalized RGB');
    }
    return {
      data: resized.data,
      width: resized.info.width,
      height: resized.info.height,
      channels: resized.info.channels,
    };
  } catch (error) {
    if (error instanceof ImagePaletteError) throw error;
    rejected('decode-failed', 'image could not be resized safely');
  }
}

function normalizeInput(input: ImagePaletteInput): {
  bytes: Buffer;
  assetPath: string;
  assetSha256: string;
  mediaType: ImageMediaType;
} {
  assertByteLength(input.bytes.byteLength);
  if (input.assetPath.trim() === '') rejected('bad-metadata', 'image assetPath must not be empty');
  // Make one bounded private copy: caller mutation cannot race raw digest/decode.
  const bytes = Buffer.from(input.bytes);
  const mediaType = detectImageMediaType(bytes);
  if (input.mediaType !== undefined && input.mediaType !== mediaType) {
    rejected('media-type-mismatch', 'declared image media type does not match byte magic');
  }
  const assetSha256 = sha256(bytes);
  if (input.assetSha256 !== undefined && input.assetSha256.toLowerCase() !== assetSha256) {
    rejected('media-type-mismatch', 'declared image SHA-256 does not match raw bytes');
  }
  return { bytes, assetPath: input.assetPath, assetSha256, mediaType };
}

/**
 * The bounded local-image adapter. It accepts either a pathname (read once with
 * `readBoundedImageFile`) or caller-held bytes, making proposal code able to
 * preflight/open once and reuse the exact same bytes for digest, decode, and
 * atomic copy.
 */
export class ImagePaletteAdapter {
  async measure(input: string | ImagePaletteInput): Promise<ImagePaletteEvidence> {
    return typeof input === 'string' ? this.measureFile(input) : this.measureInput(input);
  }

  async measureFile(inputPath: string): Promise<ImagePaletteEvidence> {
    return this.measureInput(readBoundedImageFile(inputPath));
  }

  async measureBytes(
    bytes: Uint8Array,
    provenance: Omit<ImagePaletteInput, 'bytes'>,
  ): Promise<ImagePaletteEvidence> {
    return this.measureInput({ bytes, ...provenance });
  }

  async measureInput(input: ImagePaletteInput): Promise<ImagePaletteEvidence> {
    const normalized = normalizeInput(input);
    try {
      const metadata = await decoder(normalized.bytes).metadata();
      assertMetadata(metadata, normalized.mediaType);
    } catch (error) {
      if (error instanceof ImagePaletteError) throw error;
      rejected('decode-failed', 'image metadata could not be decoded safely');
    }

    const original = await decodeOrientedRaster(normalized.bytes);
    const working = await workingRaster(original);
    const analysis = analyzeImageRaster(working);
    const compact = selectCompactPalette(
      { width: working.width, height: working.height, pixelClusters: analysis.pixelClusters },
      analysis.clusters,
    );
    const regions = representativeRegions(
      original,
      compact.samples.map((entry) => entry.cluster),
    );
    const workingPixels = compact.workingPixels;
    const samples: PaletteSample[] = compact.samples.map((entry, index) => ({
      id: `sample-${String(index + 1).padStart(2, '0')}`,
      hex: entry.cluster.hex,
      frequency: entry.cluster.count,
      pixelShare: entry.cluster.count / workingPixels,
      region: regions[index]!,
      familyPixelShare: entry.familyPixelShare,
      largestFamilyRegionPixelShare: entry.largestFamilyRegionPixelShare,
    }));

    return {
      source: {
        kind: 'image',
        assetPath: normalized.assetPath,
        assetSha256: normalized.assetSha256,
        mediaType: normalized.mediaType,
      },
      algorithm: IMAGE_CLUSTER_ALGORITHM,
      samples,
      nonColor: { fonts: [], typeSizes: [], spacing: [], radii: [], shadows: [] },
      width: original.width,
      height: original.height,
    };
  }
}

/** Convenience entry point for the common pathname use case. */
export async function measureImagePalette(input: string | ImagePaletteInput): Promise<ImagePaletteEvidence> {
  return new ImagePaletteAdapter().measure(input);
}
