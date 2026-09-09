/**
 * Deterministic compact palette selection (`image-cluster-v2`).
 *
 * This module is PURE: no decode, filesystem, network, clock, random, LLM,
 * token, or trace work happens here.  It receives the bounded working raster's
 * stable per-pixel merged-cluster identity plus the COMPLETE merged pool, and
 * returns at most twelve clusters in a fully specified order.
 *
 * Why it exists: the released v1 producer spent its whole twelve-sample budget
 * on the most frequent near-duplicate shades, so a painting with one large
 * colour field lost every coherent accent.  V2 keeps the v1 decode,
 * quantization, and Delta E 3 merge exactly as they are, and only changes the
 * decision made over the merged pool before the twelve-sample cap.
 *
 * Performance contract: perceptual coordinates and `Color` instances are
 * constructed ONCE per merged cluster.  No `Color` is constructed inside a
 * pixel loop or inside the candidate x candidate loop.
 */

import Color from 'colorjs.io';
import { deltaE2000, lightnessGapCeiling } from './color-metric.ts';
import {
  MAX_PALETTE_SAMPLES,
  PALETTE_CHROMA_FLOOR,
  PALETTE_FAMILY_DELTA_E,
  PALETTE_MIN_FAMILY_PIXEL_SHARE,
  PALETTE_NEUTRAL_CHROMA_MAX,
  PALETTE_NEUTRAL_MIN_SHARE,
  hasQualifyingPaletteSupport,
} from './palette-evidence.ts';

/** The frozen evidence budget; the SAME constant the released v1 maximum uses. */
export const MAX_COMPACT_PALETTE_SAMPLES = MAX_PALETTE_SAMPLES;

/**
 * A conservative Delta E 2000 rejection bound.  A lightness gap wider than this
 * CANNOT be inside the family radius, which lets the family scan skip the
 * expensive distance for most pairs without ever changing a membership decision.
 *
 * The derivation now lives in the shared `color-metric.ts` leaf, which reuses
 * the SAME `1.75` ceiling this module shipped inline, so the value is still
 * exactly `12 * 1.75 = 21.0` and no released selector decision moved.
 */
const MAX_FAMILY_LIGHTNESS_GAP = lightnessGapCeiling(PALETTE_FAMILY_DELTA_E);

/** One merged cluster from the frozen greedy Delta E 3 merge. */
export interface CompactPaletteCluster {
  count: number;
  red: number;
  green: number;
  blue: number;
  hex: string;
}

/**
 * The bounded working raster, expressed as the stable merged-cluster identity
 * every pixel inherited from its five-bit histogram bin.  Pixel membership is
 * never re-guessed after a merge moved a representative colour.
 */
export interface CompactPaletteRaster {
  width: number;
  height: number;
  /** Row-major merged-cluster index for every working-raster pixel. */
  pixelClusters: Int32Array;
}

/** One retained cluster plus its deterministic v2 support evidence. */
export interface CompactPaletteSample {
  /** Index into the complete merged pool, before compaction. */
  index: number;
  cluster: CompactPaletteCluster;
  familyPixelShare: number;
  largestFamilyRegionPixelShare: number;
}

export interface CompactPaletteResult {
  workingPixels: number;
  samples: CompactPaletteSample[];
}

export class CompactPaletteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompactPaletteError';
  }
}

interface ClusterMetrics {
  color: Color;
  lightness: number;
  chroma: number;
  share: number;
}

function metricsFor(clusters: readonly CompactPaletteCluster[], workingPixels: number): ClusterMetrics[] {
  return clusters.map((cluster) => {
    let color: Color;
    try {
      color = new Color(cluster.hex);
    } catch {
      throw new CompactPaletteError(`merged cluster ${JSON.stringify(cluster.hex)} is not a parseable colour`);
    }
    const [lightness] = color.to('lab').coords;
    const [, chroma] = color.to('oklch').coords;
    return {
      color,
      lightness: lightness ?? 0,
      chroma: Number.isFinite(chroma) ? chroma! : 0,
      share: cluster.count / workingPixels,
    };
  });
}

/**
 * Candidate-centered, non-transitive family membership: cluster `j` belongs to
 * candidate `i`'s family when `dE2000(rep_i, rep_j) <= 12`.  One row is written
 * into a caller-owned reusable buffer, so working memory stays O(pool) rather
 * than O(pool^2) for a merged pool that a busy raster can push into the hundreds.
 */
function writeFamilyRow(metrics: readonly ClusterMetrics[], candidate: number, row: Uint8Array): void {
  const n = metrics.length;
  const left = metrics[candidate]!;
  for (let j = 0; j < n; j += 1) {
    if (j === candidate) {
      row[j] = 1;
      continue;
    }
    const right = metrics[j]!;
    row[j] =
      Math.abs(left.lightness - right.lightness) <= MAX_FAMILY_LIGHTNESS_GAP &&
      deltaE2000(left.color, right.color) <= PALETTE_FAMILY_DELTA_E
        ? 1
        : 0;
  }
}

/**
 * Largest 8-connected component of one candidate's family on the working
 * raster, measured with an iterative flood fill.  The visit buffer is stamped
 * rather than reallocated so repeated candidates stay linear in pixel count.
 */
function largestFamilyComponentPixels(
  raster: CompactPaletteRaster,
  row: Uint8Array,
  visited: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { width, height, pixelClusters } = raster;
  let largest = 0;
  for (let start = 0; start < pixelClusters.length; start += 1) {
    if (visited[start] === stamp) continue;
    if (row[pixelClusters[start]!] !== 1) {
      visited[start] = stamp;
      continue;
    }
    let top = 0;
    stack[top++] = start;
    visited[start] = stamp;
    let size = 0;
    while (top > 0) {
      const pixel = stack[--top]!;
      size += 1;
      const x = pixel % width;
      const y = (pixel - x) / width;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const neighbour = ny * width + nx;
          if (visited[neighbour] === stamp) continue;
          if (row[pixelClusters[neighbour]!] !== 1) {
            visited[neighbour] = stamp;
            continue;
          }
          visited[neighbour] = stamp;
          stack[top++] = neighbour;
        }
      }
    }
    if (size > largest) largest = size;
  }
  return largest;
}

function compareHexThenIndex(
  leftHex: string,
  leftIndex: number,
  rightHex: string,
  rightIndex: number,
): number {
  if (leftHex < rightHex) return -1;
  if (leftHex > rightHex) return 1;
  return leftIndex - rightIndex;
}

/** The four values the frozen exact-score tie-break reads, in key order. */
export interface CompactTieBreakKey {
  familyPixelShare: number;
  frequency: number;
  hex: string;
  /** Original merged-cluster index, the final total order. */
  index: number;
}

/**
 * The ONE frozen tie-break for two candidates whose max-min diversity scores are
 * exactly equal: familyPixelShare descending, individual frequency descending,
 * hex ascending, then original merged-cluster index ascending.  Negative when
 * `left` is retained first.
 */
export function compareCompactTieBreak(left: CompactTieBreakKey, right: CompactTieBreakKey): number {
  if (left.familyPixelShare !== right.familyPixelShare) {
    return right.familyPixelShare - left.familyPixelShare;
  }
  if (left.frequency !== right.frequency) return right.frequency - left.frequency;
  return compareHexThenIndex(left.hex, left.index, right.hex, right.index);
}

/**
 * Retain at most twelve merged clusters in the frozen v2 order:
 *
 *   1. the most frequent cluster (dominant coverage);
 *   2. the existing independently qualifying neutral, when distinct;
 *   3. supported colourful candidates, chosen iteratively by the greatest
 *      minimum Delta E 2000 distance from everything already retained.
 *
 * Exact score ties break by familyPixelShare descending, individual frequency
 * descending, hex ascending, then original merged-cluster index ascending.
 *
 * A pool of twelve or fewer clusters keeps its existing order untouched so
 * small fixtures and straightforward images never churn positional sample IDs;
 * support evidence is still measured and recorded for every one of them.
 */
export function selectCompactPalette(
  raster: CompactPaletteRaster,
  clusters: readonly CompactPaletteCluster[],
): CompactPaletteResult {
  const workingPixels = raster.width * raster.height;
  if (
    !Number.isSafeInteger(raster.width) ||
    !Number.isSafeInteger(raster.height) ||
    raster.width < 1 ||
    raster.height < 1
  ) {
    throw new CompactPaletteError('compact palette selection requires a positive bounded raster');
  }
  if (raster.pixelClusters.length !== workingPixels) {
    throw new CompactPaletteError('per-pixel cluster identity must cover exactly the working raster');
  }
  if (clusters.length === 0) {
    throw new CompactPaletteError('compact palette selection requires at least one merged cluster');
  }
  for (let pixel = 0; pixel < raster.pixelClusters.length; pixel += 1) {
    const index = raster.pixelClusters[pixel]!;
    if (index < 0 || index >= clusters.length) {
      throw new CompactPaletteError('per-pixel cluster identity refers to a missing merged cluster');
    }
  }

  const n = clusters.length;
  const metrics = metricsFor(clusters, workingPixels);
  const familyRow = new Uint8Array(n);
  // Aggregate support is accumulated symmetrically, so the pairwise distance is
  // computed once per unordered pair and no n x n matrix is ever materialized.
  const familyCounts = new Float64Array(n);
  for (let i = 0; i < n; i += 1) familyCounts[i] = clusters[i]!.count;
  for (let i = 0; i < n; i += 1) {
    const left = metrics[i]!;
    for (let j = i + 1; j < n; j += 1) {
      const right = metrics[j]!;
      if (Math.abs(left.lightness - right.lightness) > MAX_FAMILY_LIGHTNESS_GAP) continue;
      if (deltaE2000(left.color, right.color) > PALETTE_FAMILY_DELTA_E) continue;
      familyCounts[i] = familyCounts[i]! + clusters[j]!.count;
      familyCounts[j] = familyCounts[j]! + clusters[i]!.count;
    }
  }

  const visited = new Int32Array(workingPixels);
  const stack = new Int32Array(workingPixels);
  let stamp = 0;
  const componentPixels = new Float64Array(n).fill(-1);
  const measureComponent = (candidate: number): number => {
    const cached = componentPixels[candidate]!;
    if (cached >= 0) return cached;
    writeFamilyRow(metrics, candidate, familyRow);
    stamp += 1;
    const measured = largestFamilyComponentPixels(raster, familyRow, visited, stamp, stack);
    componentPixels[candidate] = measured;
    return measured;
  };

  const sampleFor = (index: number): CompactPaletteSample => ({
    index,
    cluster: clusters[index]!,
    familyPixelShare: familyCounts[index]! / workingPixels,
    largestFamilyRegionPixelShare: measureComponent(index) / workingPixels,
  });

  // D4: a small pool keeps its released order, still fully measured.
  if (n <= MAX_COMPACT_PALETTE_SAMPLES) {
    const samples: CompactPaletteSample[] = [];
    for (let index = 0; index < n; index += 1) samples.push(sampleFor(index));
    return { workingPixels, samples };
  }

  // 1. Dominant coverage.
  let dominant = 0;
  for (let index = 1; index < n; index += 1) {
    const best = clusters[dominant]!;
    const candidate = clusters[index]!;
    if (
      candidate.count > best.count ||
      (candidate.count === best.count &&
        compareHexThenIndex(candidate.hex, index, best.hex, dominant) < 0)
    ) {
      dominant = index;
    }
  }

  // 2. The existing independently qualifying neutral, unchanged in rule.
  let neutral: number | undefined;
  for (let index = 0; index < n; index += 1) {
    if (index === dominant) continue;
    const metric = metrics[index]!;
    if (metric.chroma >= PALETTE_NEUTRAL_CHROMA_MAX) continue;
    if (metric.share < PALETTE_NEUTRAL_MIN_SHARE) continue;
    if (neutral === undefined) {
      neutral = index;
      continue;
    }
    const best = metrics[neutral]!;
    const better =
      metric.chroma < best.chroma ||
      (metric.chroma === best.chroma &&
        (metric.share > best.share ||
          (metric.share === best.share &&
            compareHexThenIndex(clusters[index]!.hex, index, clusters[neutral]!.hex, neutral) < 0)));
    if (better) neutral = index;
  }

  const retained: number[] = [dominant];
  if (neutral !== undefined) retained.push(neutral);

  // 3. Supported colourful candidates only.
  const candidates: number[] = [];
  for (let index = 0; index < n; index += 1) {
    if (retained.includes(index)) continue;
    if (metrics[index]!.chroma < PALETTE_CHROMA_FLOOR) continue;
    const familyPixelShare = familyCounts[index]! / workingPixels;
    // The aggregate gate is checked first so the expensive connected-component
    // pass never runs for a candidate that already cannot qualify.
    if (familyPixelShare < PALETTE_MIN_FAMILY_PIXEL_SHARE) continue;
    const support = {
      familyPixelShare,
      largestFamilyRegionPixelShare: measureComponent(index) / workingPixels,
    };
    if (!hasQualifyingPaletteSupport(support, workingPixels)) continue;
    candidates.push(index);
  }

  // 4. Iterative greatest-minimum-distance selection.
  const minDistance = new Map<number, number>();
  const refresh = (added: number): void => {
    for (const candidate of candidates) {
      const distance = deltaE2000(metrics[candidate]!.color, metrics[added]!.color);
      const current = minDistance.get(candidate);
      if (current === undefined || distance < current) minDistance.set(candidate, distance);
    }
  };
  for (const index of retained) refresh(index);

  const tieKey = (index: number): CompactTieBreakKey => ({
    familyPixelShare: familyCounts[index]! / workingPixels,
    frequency: clusters[index]!.count,
    hex: clusters[index]!.hex,
    index,
  });

  while (retained.length < MAX_COMPACT_PALETTE_SAMPLES && candidates.length > 0) {
    let bestPosition = 0;
    for (let position = 1; position < candidates.length; position += 1) {
      const candidate = candidates[position]!;
      const best = candidates[bestPosition]!;
      const candidateScore = minDistance.get(candidate)!;
      const bestScore = minDistance.get(best)!;
      if (candidateScore > bestScore) {
        bestPosition = position;
        continue;
      }
      if (candidateScore < bestScore) continue;
      // 5. Exact-score tie: the ONE frozen tie-break order.
      if (compareCompactTieBreak(tieKey(candidate), tieKey(best)) < 0) bestPosition = position;
    }
    const chosen = candidates.splice(bestPosition, 1)[0]!;
    minDistance.delete(chosen);
    retained.push(chosen);
    refresh(chosen);
  }

  return { workingPixels, samples: retained.map((index) => sampleFor(index)) };
}
