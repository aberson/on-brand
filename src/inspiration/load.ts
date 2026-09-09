/**
 * Bounded, local-only loading for `brand/inspiration.json` and its one raster.
 *
 * The loader intentionally rejects links at every relevant path component.  A
 * trace is editable source data, but the page embeds exact artwork bytes, so a
 * permissive realpath/read sequence would otherwise let a brand escape its own
 * `brand/` directory between validation and rendering.
 */

import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { hashBytes, hashContent } from '../build/manifest.ts';
import type { ImageMediaType } from '../extract/palette-evidence.ts';
import {
  INSPIRATION_LIMITS,
  InspirationValidationError,
  assertValidInspirationTrace,
  type InspirationTrace,
} from './contract.ts';

export interface RasterDimensions {
  width: number;
  height: number;
}

export interface LoadedInspirationAsset extends RasterDimensions {
  /** Absolute local file path; never rendered or exported as user-facing data. */
  path: string;
  /** Clean brand-relative path from `asset.path`, e.g. `assets/inspiration.jpg`. */
  relativePath: string;
  bytes: Uint8Array;
  sha256: string;
  mediaType: ImageMediaType;
}

export interface LoadedInspirationTrace {
  projectDir: string;
  brandDir: string;
  tracePath: string;
  trace: InspirationTrace;
  /** SHA-256 over inspiration.json UTF-8 with CRLF normalized to LF. */
  traceSha256: string;
  asset: LoadedInspirationAsset;
}

export class InspirationLoadError extends Error {
  readonly originalCause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'InspirationLoadError';
    this.originalCause = cause;
  }
}

/**
 * Load the optional trace for a project.  A missing `brand/inspiration.json`
 * means the brand did not opt in and returns undefined.  Any present but bad
 * trace is an error; callers must not silently turn it into an empty view.
 */
export function loadInspirationTrace(projectDir: string): LoadedInspirationTrace | undefined {
  const absProjectDir = path.resolve(projectDir);
  const brandDir = path.join(absProjectDir, 'brand');
  assertRealDirectory(brandDir, 'brand directory');
  const tracePath = path.join(brandDir, 'inspiration.json');
  const traceStat = lstatOrUndefined(tracePath, 'brand/inspiration.json');
  if (traceStat === undefined) return undefined;
  if (traceStat.isSymbolicLink() || !traceStat.isFile()) {
    throw new InspirationLoadError('brand/inspiration.json must be a local non-linked regular file');
  }
  if (traceStat.size > INSPIRATION_LIMITS.maxJsonBytes) {
    throw new InspirationLoadError(
      `brand/inspiration.json exceeds ${INSPIRATION_LIMITS.maxJsonBytes} UTF-8 bytes`,
    );
  }

  let traceBytes: Uint8Array;
  try {
    traceBytes = readFileSync(tracePath);
  } catch (cause) {
    throw new InspirationLoadError(`cannot read brand/inspiration.json: ${messageOf(cause)}`, cause);
  }
  if (traceBytes.byteLength > INSPIRATION_LIMITS.maxJsonBytes) {
    throw new InspirationLoadError(
      `brand/inspiration.json exceeds ${INSPIRATION_LIMITS.maxJsonBytes} UTF-8 bytes`,
    );
  }
  // Detect a link/payload substitution after the bounded read, before parsing
  // or trusting anything from it.  This is not a substitute for production
  // proposal's open-handle preflight, but closes the normal source-loader race.
  assertUnchangedRegularFile(tracePath, traceStat, 'brand/inspiration.json');

  const traceText = decodeUtf8(traceBytes, 'brand/inspiration.json');
  let raw: unknown;
  try {
    raw = JSON.parse(traceText) as unknown;
  } catch (cause) {
    throw new InspirationLoadError(`invalid JSON in brand/inspiration.json: ${messageOf(cause)}`, cause);
  }

  let trace: InspirationTrace;
  try {
    trace = assertValidInspirationTrace(raw, 'brand/inspiration.json');
  } catch (cause) {
    if (cause instanceof InspirationValidationError) {
      throw new InspirationLoadError(cause.message, cause);
    }
    throw cause;
  }

  const assetPath = resolveContainedAssetPath(brandDir, trace.asset.path);
  const assetStat = lstatOrUndefined(assetPath, `brand/${trace.asset.path}`);
  if (assetStat === undefined) {
    throw new InspirationLoadError(`brand/${trace.asset.path}: asset does not exist`);
  }
  if (assetStat.isSymbolicLink() || !assetStat.isFile()) {
    throw new InspirationLoadError(`brand/${trace.asset.path}: asset must be a local non-linked regular file`);
  }
  if (assetStat.size > INSPIRATION_LIMITS.maxAssetBytes) {
    throw new InspirationLoadError(
      `brand/${trace.asset.path}: asset exceeds ${INSPIRATION_LIMITS.maxAssetBytes} bytes`,
    );
  }

  let assetBytes: Uint8Array;
  try {
    assetBytes = readFileSync(assetPath);
  } catch (cause) {
    throw new InspirationLoadError(`cannot read brand/${trace.asset.path}: ${messageOf(cause)}`, cause);
  }
  if (assetBytes.byteLength > INSPIRATION_LIMITS.maxAssetBytes) {
    throw new InspirationLoadError(
      `brand/${trace.asset.path}: asset exceeds ${INSPIRATION_LIMITS.maxAssetBytes} bytes`,
    );
  }
  assertUnchangedRegularFile(assetPath, assetStat, `brand/${trace.asset.path}`);

  const actualSha256 = hashBytes(assetBytes);
  if (actualSha256 !== trace.asset.sha256) {
    throw new InspirationLoadError(
      `brand/${trace.asset.path}: SHA-256 does not match inspiration.json asset.sha256`,
    );
  }
  const dimensions = inspectRaster(assetBytes, trace.asset.mediaType, `brand/${trace.asset.path}`);
  assertSafeDimensions(dimensions, `brand/${trace.asset.path}`);

  return {
    projectDir: absProjectDir,
    brandDir,
    tracePath,
    trace,
    traceSha256: hashContent(traceText),
    asset: {
      path: assetPath,
      relativePath: trace.asset.path,
      bytes: assetBytes,
      sha256: actualSha256,
      mediaType: trace.asset.mediaType,
      ...dimensions,
    },
  };
}

/**
 * Inspect a bounded raster header without decoding pixels.  The image adapter
 * owns sharp-based full decode/orientation; this independent check ensures a
 * later standalone renderer never embeds an unexpected/mislabeled payload.
 */
export function inspectRaster(
  bytes: Uint8Array,
  mediaType: ImageMediaType,
  context = 'raster asset',
): RasterDimensions {
  if (mediaType === 'image/png') return inspectPng(bytes, context);
  if (mediaType === 'image/jpeg') return inspectJpeg(bytes, context);
  return inspectWebp(bytes, context);
}

function resolveContainedAssetPath(brandDir: string, relPath: string): string {
  // contract.ts has already checked the syntactic form.  Walk every component
  // with lstat as well: path.resolve alone follows an intermediate junction.
  const assetPath = path.resolve(brandDir, ...relPath.split('/'));
  const relative = path.relative(brandDir, assetPath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new InspirationLoadError(`brand/${relPath}: asset path escapes brand/`);
  }

  let cursor = brandDir;
  for (const segment of relPath.split('/')) {
    cursor = path.join(cursor, segment);
    const entry = lstatOrUndefined(cursor, `brand/${relPath}`);
    // The final component is handled by the caller so it can distinguish a
    // missing asset.  An absent intermediate component cannot be contained.
    if (entry === undefined) break;
    if (entry.isSymbolicLink()) {
      throw new InspirationLoadError(`brand/${relPath}: linked path components are not allowed`);
    }
    if (cursor !== assetPath && !entry.isDirectory()) {
      throw new InspirationLoadError(`brand/${relPath}: an intermediate component is not a directory`);
    }
  }
  return assetPath;
}

function assertRealDirectory(target: string, label: string): void {
  const entry = lstatOrUndefined(target, label);
  if (entry === undefined || entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new InspirationLoadError(`${label} must be an existing local non-linked directory`);
  }
}

function lstatOrUndefined(target: string, label: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(target);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new InspirationLoadError(`cannot inspect ${label}: ${messageOf(cause)}`, cause);
  }
}

function assertUnchangedRegularFile(
  target: string,
  before: NonNullable<ReturnType<typeof lstatSync>>,
  label: string,
): void {
  const after = lstatOrUndefined(target, label);
  if (
    after === undefined || after.isSymbolicLink() || !after.isFile() ||
    after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
  ) {
    throw new InspirationLoadError(`${label} changed or became unsafe while loading`);
  }
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (cause) {
    throw new InspirationLoadError(`${label} is not valid UTF-8`, cause);
  }
}

function assertSafeDimensions(dimensions: RasterDimensions, context: string): void {
  if (
    !Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height) ||
    dimensions.width <= 0 || dimensions.height <= 0
  ) {
    throw new InspirationLoadError(`${context}: image dimensions must be positive integers`);
  }
  if (
    dimensions.width > INSPIRATION_LIMITS.maxAssetDimension ||
    dimensions.height > INSPIRATION_LIMITS.maxAssetDimension
  ) {
    throw new InspirationLoadError(
      `${context}: image dimensions exceed ${INSPIRATION_LIMITS.maxAssetDimension} pixels per side`,
    );
  }
  if (dimensions.width * dimensions.height > INSPIRATION_LIMITS.maxDecodedPixels) {
    throw new InspirationLoadError(
      `${context}: image exceeds ${INSPIRATION_LIMITS.maxDecodedPixels} decoded pixels`,
    );
  }
}

function inspectPng(bytes: Uint8Array, context: string): RasterDimensions {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!hasBytes(bytes, 0, signature)) throw new InspirationLoadError(`${context}: PNG magic bytes are invalid`);
  if (bytes.length < 33 || readU32BE(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== 'IHDR') {
    throw new InspirationLoadError(`${context}: PNG is missing a valid IHDR header`);
  }
  const width = readU32BE(bytes, 16);
  const height = readU32BE(bytes, 20);
  // Walk real chunks rather than scanning compressed byte payload for a text
  // sequence that happens to spell "acTL". That avoids false animation
  // rejections while still refusing actual APNG metadata deterministically.
  let offset = 8;
  let sawIend = false;
  while (offset + 12 <= bytes.length) {
    const length = readU32BE(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    const next = offset + 12 + length;
    if (next > bytes.length) throw new InspirationLoadError(`${context}: PNG has a truncated ${type} chunk`);
    if (type === 'acTL') throw new InspirationLoadError(`${context}: animated PNG is not supported`);
    if (type === 'IEND') {
      if (length !== 0 || next !== bytes.length) throw new InspirationLoadError(`${context}: PNG has an invalid IEND chunk`);
      sawIend = true;
      break;
    }
    offset = next;
  }
  if (!sawIend) throw new InspirationLoadError(`${context}: PNG is missing a terminal IEND chunk`);
  return { width, height };
}

function inspectJpeg(bytes: Uint8Array, context: string): RasterDimensions {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new InspirationLoadError(`${context}: JPEG magic bytes are invalid`);
  }
  let offset = 2;
  while (offset < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset]!;
    offset += 1;
    // Stand-alone markers: TEM, restart, EOI.  A start of scan ends the
    // marker section; dimensions must already have appeared in a SOF marker.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (offset + 2 > bytes.length) break;
    const length = readU16BE(bytes, offset);
    if (length < 2 || offset + length > bytes.length) {
      throw new InspirationLoadError(`${context}: JPEG has a truncated marker segment`);
    }
    if (isStartOfFrame(marker)) {
      if (length < 8) throw new InspirationLoadError(`${context}: JPEG frame header is too short`);
      const height = readU16BE(bytes, offset + 3);
      const width = readU16BE(bytes, offset + 5);
      return { width, height };
    }
    if (marker === 0xda) break;
    offset += length;
  }
  throw new InspirationLoadError(`${context}: JPEG contains no supported frame dimensions`);
}

function inspectWebp(bytes: Uint8Array, context: string): RasterDimensions {
  if (bytes.length < 16 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') {
    throw new InspirationLoadError(`${context}: WebP magic bytes are invalid`);
  }
  const declaredSize = readU32LE(bytes, 4);
  if (declaredSize + 8 !== bytes.length) {
    throw new InspirationLoadError(`${context}: WebP RIFF length does not match the asset bytes`);
  }
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunk = ascii(bytes, offset, 4);
    const length = readU32LE(bytes, offset + 4);
    const data = offset + 8;
    const padded = length + (length % 2);
    if (data + padded > bytes.length) throw new InspirationLoadError(`${context}: WebP has a truncated ${chunk} chunk`);
    if (chunk === 'VP8X') {
      if (length < 10) throw new InspirationLoadError(`${context}: WebP VP8X header is too short`);
      if ((bytes[data]! & 0x02) !== 0) throw new InspirationLoadError(`${context}: animated WebP is not supported`);
      return {
        width: 1 + readU24LE(bytes, data + 4),
        height: 1 + readU24LE(bytes, data + 7),
      };
    }
    if (chunk === 'VP8 ') {
      if (length < 10 || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) {
        throw new InspirationLoadError(`${context}: WebP VP8 frame header is invalid`);
      }
      return {
        width: readU16LE(bytes, data + 6) & 0x3fff,
        height: readU16LE(bytes, data + 8) & 0x3fff,
      };
    }
    if (chunk === 'VP8L') {
      if (length < 5 || bytes[data] !== 0x2f) throw new InspirationLoadError(`${context}: WebP VP8L header is invalid`);
      const b0 = bytes[data + 1]!;
      const b1 = bytes[data + 2]!;
      const b2 = bytes[data + 3]!;
      const b3 = bytes[data + 4]!;
      return {
        width: 1 + b0 + ((b1 & 0x3f) << 8),
        height: 1 + (b1 >> 6) + (b2 << 2) + ((b3 & 0x0f) << 10),
      };
    }
    offset = data + padded;
  }
  throw new InspirationLoadError(`${context}: WebP contains no supported image chunk`);
}

function isStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function hasBytes(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || length < 0 || offset + length > bytes.length) return '';
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]!);
  return out;
}

function readU16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! * 0x1000000) + ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!)) >>> 0;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
