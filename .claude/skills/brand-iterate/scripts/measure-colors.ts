/**
 * measure-colors.ts — deterministic candidate-colour measurement for /brand-iterate image mode.
 *
 * Usage (from the repository root):
 *   npx tsx .claude/skills/brand-iterate/scripts/measure-colors.ts <image> [--around <hex>] [--top <n>]
 *
 * Prints ONE JSON document to stdout (schema "brand-iterate.measure-colors/1").
 *
 * Fidelity contract: clustering and gate math are IMPORTED from the pipeline
 * (analyzeImageRaster, hasQualifyingPaletteSupport, minimumFamilyComponentPixels) — never
 * re-implemented. The decode + downsample-to-working-raster steps are module-private in
 * src/extract/image-palette.ts (decodeOrientedRaster / workingRaster), so the two sharp
 * chains below are copied from them VERBATIM; `kernel: 'nearest'` and
 * `flatten({ background: '#ffffff' })` are load-bearing for byte-identical clusters.
 * The 8-connected largest-component fill mirrors the private
 * largestFamilyComponentPixels in src/extract/compact-palette.ts.
 *
 * This script only ever READS the image. It changes nothing about what from-image
 * measured or recorded.
 */
import sharp from 'sharp';
import Color from 'colorjs.io';
import {
  readBoundedImageFile,
  analyzeImageRaster,
  WORKING_LONG_EDGE,
  MAX_DECODED_PIXELS,
  MAX_IMAGE_CHANNELS,
  MAX_IMAGE_DIMENSION,
} from '../../../../src/extract/image-palette.ts';
import {
  PALETTE_FAMILY_DELTA_E,
  PALETTE_MIN_FAMILY_PIXEL_SHARE,
  PALETTE_CHROMA_FLOOR,
  hasQualifyingPaletteSupport,
  minimumFamilyComponentPixels,
} from '../../../../src/extract/palette-evidence.ts';

function fail(message: string): never {
  process.stderr.write(`measure-colors: ${message}\n`);
  process.exit(1);
}

const HEX_RE = /^#[0-9a-f]{6}$/;

// --- argument parsing ------------------------------------------------------
const argv = process.argv.slice(2);
let imagePath: string | undefined;
let around: string | undefined;
let top = 24;
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--around') {
    const value = argv[++i];
    if (value === undefined) fail('--around requires a hex value');
    around = value.toLowerCase();
    if (!HEX_RE.test(around)) fail(`--around must be a 6-digit hex like #974c42, got ${value}`);
  } else if (arg === '--top') {
    const value = argv[++i];
    top = Number(value);
    if (!Number.isInteger(top) || top < 1 || top > 256) fail(`--top must be an integer 1..256, got ${value}`);
  } else if (arg.startsWith('--')) {
    fail(`unknown flag ${arg}`);
  } else if (imagePath === undefined) {
    imagePath = arg;
  } else {
    fail(`unexpected extra argument ${arg}`);
  }
}
if (imagePath === undefined) fail('usage: measure-colors.ts <image> [--around <hex>] [--top <n>]');

// --- helpers ---------------------------------------------------------------
interface OklchView {
  l: number;
  c: number;
  h: number | null;
}

function oklchOf(color: Color): OklchView {
  const [l, c, h] = color.to('oklch').coords;
  return {
    l: Number(l.toFixed(3)),
    c: Number(c.toFixed(3)),
    h: Number.isNaN(h) ? null : Number(h.toFixed(1)),
  };
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

/** Largest 8-connected component of pixels whose merged cluster is in `familyRow`.
 *  Mirrors the private largestFamilyComponentPixels in src/extract/compact-palette.ts. */
function largestComponent(
  familyRow: Uint8Array,
  pixelClusters: Int32Array,
  width: number,
  height: number,
): number {
  const total = width * height;
  const visited = new Uint8Array(total);
  const stack = new Int32Array(total);
  let best = 0;
  for (let start = 0; start < total; start += 1) {
    if (visited[start] === 1 || familyRow[pixelClusters[start]] !== 1) continue;
    visited[start] = 1;
    let topIdx = 0;
    stack[topIdx] = start;
    topIdx += 1;
    let size = 0;
    while (topIdx > 0) {
      topIdx -= 1;
      const idx = stack[topIdx];
      size += 1;
      const x = idx % width;
      const y = (idx - x) / width;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const n = ny * width + nx;
          if (visited[n] === 0 && familyRow[pixelClusters[n]] === 1) {
            visited[n] = 1;
            stack[topIdx] = n;
            topIdx += 1;
          }
        }
      }
    }
    if (size > best) best = size;
  }
  return best;
}

// --- measure ---------------------------------------------------------------
const loaded = readBoundedImageFile(imagePath);

// Verbatim mirror of private decodeOrientedRaster() in src/extract/image-palette.ts.
const oriented = await sharp(loaded.bytes, {
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
if (oriented.info.channels !== 3) fail(`decode produced ${oriented.info.channels} channels, expected 3`);
if (oriented.info.width > MAX_IMAGE_DIMENSION || oriented.info.height > MAX_IMAGE_DIMENSION) {
  fail(`decoded dimensions ${oriented.info.width}x${oriented.info.height} exceed ${MAX_IMAGE_DIMENSION}`);
}

// Verbatim mirror of private workingRaster() in src/extract/image-palette.ts.
const working = await sharp(oriented.data, {
  raw: { width: oriented.info.width, height: oriented.info.height, channels: oriented.info.channels },
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
if (working.info.channels !== 3) fail(`downsample produced ${working.info.channels} channels, expected 3`);

const raster = {
  data: working.data,
  width: working.info.width,
  height: working.info.height,
  channels: 3 as const,
};
const { clusters, pixelClusters } = analyzeImageRaster(raster);
const workingPixels = raster.width * raster.height;

// One Color per cluster, hoisted (compact-palette's metricsFor pattern).
const clusterColors = clusters.map((cluster) => new Color(cluster.hex));

const candidates = clusters
  .map((cluster, index) => ({ cluster, index }))
  .sort((a, b) => b.cluster.count - a.cluster.count || a.cluster.hex.localeCompare(b.cluster.hex))
  .slice(0, top)
  .map(({ cluster, index }) => {
    const view = oklchOf(clusterColors[index]);
    return {
      hex: cluster.hex,
      pixels: cluster.count,
      share: round6(cluster.count / workingPixels),
      oklch: view,
      colourful: view.c >= PALETTE_CHROMA_FLOOR,
    };
  });

// --- family support around a target hex ------------------------------------
let aroundBlock: unknown = null;
if (around !== undefined) {
  const target = new Color(around);
  const familyRow = new Uint8Array(clusters.length);
  let familyPixels = 0;
  const distances: Array<{ index: number; deltaE: number }> = [];
  clusters.forEach((cluster, index) => {
    const deltaE = target.deltaE(clusterColors[index], { method: '2000' });
    distances.push({ index, deltaE });
    if (deltaE <= PALETTE_FAMILY_DELTA_E) {
      familyRow[index] = 1;
      familyPixels += cluster.count;
    }
  });
  const componentPixels = largestComponent(familyRow, pixelClusters, raster.width, raster.height);
  const support = {
    familyPixelShare: familyPixels / workingPixels,
    largestFamilyRegionPixelShare: componentPixels / workingPixels,
  };
  const spatialThreshold = minimumFamilyComponentPixels(workingPixels);
  const nearest = distances
    .sort((a, b) => a.deltaE - b.deltaE || clusters[a.index].hex.localeCompare(clusters[b.index].hex))
    .slice(0, 8)
    .map(({ index, deltaE }) => {
      const view = oklchOf(clusterColors[index]);
      return {
        hex: clusters[index].hex,
        deltaE2000: Number(deltaE.toFixed(2)),
        pixels: clusters[index].count,
        share: round6(clusters[index].count / workingPixels),
        oklch: view,
        colourful: view.c >= PALETTE_CHROMA_FLOOR,
      };
    });
  aroundBlock = {
    target: around,
    familyDeltaE: PALETTE_FAMILY_DELTA_E,
    family: {
      pixels: familyPixels,
      share: round6(support.familyPixelShare),
      largestComponentPixels: componentPixels,
      largestComponentShare: round6(support.largestFamilyRegionPixelShare),
    },
    gates: {
      aggregate: {
        thresholdShare: PALETTE_MIN_FAMILY_PIXEL_SHARE,
        thresholdPixels: Math.ceil(PALETTE_MIN_FAMILY_PIXEL_SHARE * workingPixels),
        pass: support.familyPixelShare >= PALETTE_MIN_FAMILY_PIXEL_SHARE,
      },
      spatial: {
        thresholdPixels: spatialThreshold,
        pass: componentPixels >= spatialThreshold,
      },
      wouldQualifyAsAccent: hasQualifyingPaletteSupport(support, workingPixels),
    },
    nearest,
  };
}

process.stdout.write(
  `${JSON.stringify(
    {
      schema: 'brand-iterate.measure-colors/1',
      image: {
        path: imagePath,
        sha256: loaded.assetSha256,
        mediaType: loaded.mediaType,
        width: oriented.info.width,
        height: oriented.info.height,
      },
      working: { width: raster.width, height: raster.height, pixels: workingPixels },
      clusterCount: clusters.length,
      candidates,
      around: aroundBlock,
    },
    null,
    2,
  )}\n`,
);
