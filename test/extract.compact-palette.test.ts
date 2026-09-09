/**
 * Deterministic `image-cluster-v2` compact palette selection.
 *
 * Every fixture here is a synthetic raster generated in-test. No artwork,
 * museum image, or hue name reaches production code or CI.
 */

import { describe, expect, it } from 'vitest';
import Color from 'colorjs.io';
import {
  MAX_COMPACT_PALETTE_SAMPLES,
  compareCompactTieBreak,
  selectCompactPalette,
  type CompactPaletteCluster,
  type CompactPaletteRaster,
} from '../src/extract/compact-palette.ts';
import {
  PALETTE_FAMILY_DELTA_E,
  PALETTE_MIN_FAMILY_PIXEL_SHARE,
  hasQualifyingPaletteSupport,
  minimumFamilyComponentPixels,
} from '../src/extract/palette-evidence.ts';
import { MAX_IMAGE_CLUSTERS, analyzeImageRaster } from '../src/extract/image-palette.ts';
import { S_L_CEILING, lightnessGapCeiling } from '../src/extract/color-metric.ts';

interface Canvas {
  width: number;
  height: number;
  data: Buffer;
  channels: 3;
}

function canvas(width: number, height: number, background: [number, number, number]): Canvas {
  const data = Buffer.alloc(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    data[pixel * 3] = background[0];
    data[pixel * 3 + 1] = background[1];
    data[pixel * 3 + 2] = background[2];
  }
  return { width, height, data, channels: 3 };
}

function paint(
  target: Canvas,
  x0: number,
  y0: number,
  width: number,
  height: number,
  [red, green, blue]: [number, number, number],
): void {
  for (let y = y0; y < y0 + height; y += 1) {
    for (let x = x0; x < x0 + width; x += 1) {
      const offset = (y * target.width + x) * 3;
      target.data[offset] = red;
      target.data[offset + 1] = green;
      target.data[offset + 2] = blue;
    }
  }
}

function hex([red, green, blue]: [number, number, number]): string {
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function fromCanvas(target: Canvas): {
  raster: CompactPaletteRaster;
  clusters: CompactPaletteCluster[];
} {
  const analysis = analyzeImageRaster(target);
  return {
    raster: { width: target.width, height: target.height, pixelClusters: analysis.pixelClusters },
    clusters: analysis.clusters,
  };
}

/** Build a synthetic pool directly so exact family/component counts are provable. */
function synthetic(
  width: number,
  height: number,
  clusters: CompactPaletteCluster[],
  assign: (x: number, y: number) => number,
): { raster: CompactPaletteRaster; clusters: CompactPaletteCluster[] } {
  const pixelClusters = new Int32Array(width * height);
  const counts = new Array<number>(clusters.length).fill(0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = assign(x, y);
      pixelClusters[y * width + x] = index;
      counts[index] = counts[index]! + 1;
    }
  }
  return {
    raster: { width, height, pixelClusters },
    clusters: clusters.map((cluster, index) => ({ ...cluster, count: counts[index]! })),
  };
}

function rgbOf(value: string): [number, number, number] {
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ];
}

function deltaE(left: string, right: string): number {
  return new Color(left).deltaE(new Color(right), { method: '2000' });
}

// ---------------------------------------------------------------- crowded ---

const BACKGROUND_SHADES: Array<[number, number, number]> = Array.from(
  { length: 14 },
  (_, step) => [16 + 14 * step, 58 + 11 * step, 128 + 8 * step] as [number, number, number],
);
const CROWDED_NEUTRAL: [number, number, number] = [154, 154, 154];
const CROWDED_ACCENTS: Array<[number, number, number]> = [
  [46, 139, 58], // a coherent mid-value accent family
  [210, 105, 30], // a coherent warm accent family
  [122, 63, 176], // a coherent violet accent family
  [245, 230, 184], // a coherent light-value accent family
];

function crowdedCanvas(): Canvas {
  const target = canvas(128, 160, BACKGROUND_SHADES[0]!);
  for (let step = 1; step < BACKGROUND_SHADES.length; step += 1) {
    paint(target, (step - 1) * 6, 0, 6, 100, BACKGROUND_SHADES[step]!);
  }
  paint(target, 84, 0, 40, 40, CROWDED_NEUTRAL);
  CROWDED_ACCENTS.forEach((accent, index) => {
    paint(target, 4 + index * 20, 120, 12, 12, accent);
  });
  return target;
}

describe('selectCompactPalette — crowded painting-like raster', () => {
  const { raster, clusters } = fromCanvas(crowdedCanvas());
  const result = selectCompactPalette(raster, clusters);
  const selectedHexes = result.samples.map((sample) => sample.cluster.hex);

  it('shares one twelve-sample budget constant with the released adapter maximum', () => {
    // `toBe` is identity for primitives: a future re-duplication fails here.
    expect(MAX_COMPACT_PALETTE_SAMPLES).toBe(MAX_IMAGE_CLUSTERS);
    expect(MAX_COMPACT_PALETTE_SAMPLES).toBe(12);
  });

  it('keeps the complete merged pool available above the twelve-sample budget', () => {
    // 14 related cool background shades + 1 neutral field + 4 small accents.
    expect(clusters).toHaveLength(19);
    expect(clusters.length).toBeGreaterThan(MAX_COMPACT_PALETTE_SAMPLES);
    expect(result.workingPixels).toBe(128 * 160);
    expect(result.samples).toHaveLength(MAX_COMPACT_PALETTE_SAMPLES);
  });

  it('reserves dominant coverage and the qualifying neutral before any diversity pick', () => {
    const dominant = clusters.reduce((best, cluster) => (cluster.count > best.count ? cluster : best));
    expect(selectedHexes[0]).toBe(dominant.hex);
    expect(selectedHexes[0]).toBe(hex(BACKGROUND_SHADES[0]!));
    expect(selectedHexes[1]).toBe(hex(CROWDED_NEUTRAL));
  });

  it('freezes the exact deterministic selection order', () => {
    expect(selectedHexes).toEqual([
      '#103a80',
      '#9a9a9a',
      '#d2691e',
      '#2e8b3a',
      '#f5e6b8',
      '#647cb0',
      '#7a3fb0',
      '#c6c9e8',
      '#8e9dc8',
      '#3a5b98',
      '#aab3d8',
      '#5671a8',
    ]);
  });

  it('retains every supported accent family and drops redundant background shades', () => {
    for (const accent of CROWDED_ACCENTS) {
      expect(selectedHexes, `accent ${hex(accent)}`).toContain(hex(accent));
    }
    const backgroundHexes = BACKGROUND_SHADES.map(hex);
    const droppedBackground = backgroundHexes.filter((shade) => !selectedHexes.includes(shade));
    expect(droppedBackground.length).toBe(7);
    expect(new Set(selectedHexes).size).toBe(selectedHexes.length);
  });

  it('records finite in-range support evidence for every retained sample', () => {
    for (const sample of result.samples) {
      expect(sample.familyPixelShare).toBeGreaterThan(0);
      expect(sample.familyPixelShare).toBeLessThanOrEqual(1);
      expect(sample.largestFamilyRegionPixelShare).toBeGreaterThan(0);
      expect(sample.largestFamilyRegionPixelShare).toBeLessThanOrEqual(sample.familyPixelShare);
    }
  });

  it('is byte-identical across repeated calls', () => {
    const again = selectCompactPalette(raster, clusters);
    expect(JSON.stringify(again)).toBe(JSON.stringify(result));
  });
});

// -------------------------------------------------- contiguous vs scattered ---

describe('selectCompactPalette — equal pixel counts, different spatial support', () => {
  const CONTIGUOUS: [number, number, number] = [200, 30, 40];
  const SCATTERED: [number, number, number] = [30, 60, 210];

  function scatteredCanvas(): Canvas {
    const target = canvas(128, 128, [250, 250, 250]);
    // 49 contiguous pixels.
    paint(target, 4, 4, 7, 7, CONTIGUOUS);
    // 49 pixels spaced 3 apart, so no two are even 8-connected.
    for (let row = 0; row < 7; row += 1) {
      for (let column = 0; column < 7; column += 1) {
        paint(target, 40 + column * 3, 40 + row * 3, 1, 1, SCATTERED);
      }
    }
    return target;
  }

  const { raster, clusters } = fromCanvas(scatteredCanvas());
  const result = selectCompactPalette(raster, clusters);

  it('keeps a small pool intact so both equal-count samples remain in raw evidence', () => {
    expect(clusters.length).toBeLessThanOrEqual(MAX_COMPACT_PALETTE_SAMPLES);
    expect(result.samples).toHaveLength(clusters.length);
    expect(result.samples.map((sample) => sample.cluster.hex)).toEqual(
      clusters.map((cluster) => cluster.hex),
    );
  });

  it('qualifies only the contiguous sample for a deterministic palette role', () => {
    const contiguous = result.samples.find((sample) => sample.cluster.hex === hex(CONTIGUOUS))!;
    const scattered = result.samples.find((sample) => sample.cluster.hex === hex(SCATTERED))!;
    expect(contiguous.cluster.count).toBe(49);
    expect(scattered.cluster.count).toBe(49);
    expect(contiguous.familyPixelShare).toBe(scattered.familyPixelShare);
    expect(contiguous.largestFamilyRegionPixelShare * result.workingPixels).toBe(49);
    expect(scattered.largestFamilyRegionPixelShare * result.workingPixels).toBe(1);
    expect(hasQualifyingPaletteSupport(contiguous, result.workingPixels)).toBe(true);
    expect(hasQualifyingPaletteSupport(scattered, result.workingPixels)).toBe(false);
  });
});

// -------------------------------------------------------------- boundaries ---

describe('selectCompactPalette — frozen support boundaries', () => {
  const BACKGROUND = '#ffffff';
  const ACCENT = '#c0392b';
  const WORKING = 100 * 100;

  function accentPool(place: (x: number, y: number) => boolean): {
    raster: CompactPaletteRaster;
    clusters: CompactPaletteCluster[];
  } {
    const base: CompactPaletteCluster[] = [
      { count: 0, ...zip(BACKGROUND) },
      { count: 0, ...zip(ACCENT) },
    ];
    return synthetic(100, 100, base, (x, y) => (place(x, y) ? 1 : 0));
  }

  function zip(value: string): { red: number; green: number; blue: number; hex: string } {
    const [red, green, blue] = rgbOf(value);
    return { red, green, blue, hex: value };
  }

  function accentSupport(place: (x: number, y: number) => boolean) {
    const pool = accentPool(place);
    const selected = selectCompactPalette(pool.raster, pool.clusters);
    return selected.samples.find((sample) => sample.cluster.hex === ACCENT)!;
  }

  /** A run of `length` contiguous pixels on row `row`, starting at column 0. */
  function contiguousRun(length: number): (x: number, y: number) => boolean {
    return (x, y) => y === 0 && x < length;
  }

  it('freezes the 0.25 percent aggregate family gate at just-below and at-threshold', () => {
    expect(PALETTE_MIN_FAMILY_PIXEL_SHARE * WORKING).toBe(25);
    const below = accentSupport(contiguousRun(24));
    const at = accentSupport(contiguousRun(25));
    expect(below.familyPixelShare).toBe(24 / WORKING);
    expect(at.familyPixelShare).toBe(25 / WORKING);
    expect(hasQualifyingPaletteSupport(below, WORKING)).toBe(false);
    expect(hasQualifyingPaletteSupport(at, WORKING)).toBe(true);
  });

  it('freezes the max(4, ceil(pixels * 0.00025)) 8-connected component gate', () => {
    expect(minimumFamilyComponentPixels(WORKING)).toBe(4);
    expect(minimumFamilyComponentPixels(40_000)).toBe(10);

    // Nine 3-pixel groups: aggregate support passes, local support does not.
    const threePixelGroups = accentSupport((x, y) => y % 2 === 0 && y < 18 && x % 5 < 3 && x < 5);
    expect(Math.round(threePixelGroups.familyPixelShare * WORKING)).toBe(27);
    expect(Math.round(threePixelGroups.largestFamilyRegionPixelShare * WORKING)).toBe(3);
    expect(hasQualifyingPaletteSupport(threePixelGroups, WORKING)).toBe(false);

    // Seven 4-pixel groups: exactly at the local threshold.
    const fourPixelGroups = accentSupport((x, y) => y % 2 === 0 && y < 14 && x % 6 < 4 && x < 6);
    expect(Math.round(fourPixelGroups.familyPixelShare * WORKING)).toBe(28);
    expect(Math.round(fourPixelGroups.largestFamilyRegionPixelShare * WORKING)).toBe(4);
    expect(hasQualifyingPaletteSupport(fourPixelGroups, WORKING)).toBe(true);
  });

  it('freezes candidate-centered, non-transitive Delta E 12 family membership', () => {
    const anchor = '#606060';
    const greys: string[] = [];
    for (let level = 0x60; level <= 0xa0; level += 1) {
      greys.push(`#${level.toString(16).padStart(2, '0').repeat(3)}`);
    }
    const inside = [...greys].reverse().find((grey) => deltaE(anchor, grey) <= PALETTE_FAMILY_DELTA_E)!;
    const outside = greys.find((grey) => deltaE(anchor, grey) > PALETTE_FAMILY_DELTA_E)!;
    expect(deltaE(anchor, inside)).toBeLessThanOrEqual(PALETTE_FAMILY_DELTA_E);
    expect(deltaE(anchor, outside)).toBeGreaterThan(PALETTE_FAMILY_DELTA_E);

    const clusters: CompactPaletteCluster[] = [anchor, inside, outside, '#ffffff'].map((value) => ({
      count: 0,
      ...zip(value),
    }));
    // 10 anchor, 20 inside-family, 40 outside-family, remainder white.
    const pool = synthetic(100, 100, clusters, (x, y) => {
      if (y !== 0) return 3;
      if (x < 10) return 0;
      if (x < 30) return 1;
      if (x < 70) return 2;
      return 3;
    });
    const selected = selectCompactPalette(pool.raster, pool.clusters);
    const anchorSample = selected.samples.find((sample) => sample.cluster.hex === anchor)!;
    // The anchor's family is exactly itself plus the inside neighbour: a nearer
    // neighbour of the neighbour never chains into a candidate-centered family.
    expect(Math.round(anchorSample.familyPixelShare * selected.workingPixels)).toBe(30);
  });
});

// ------------------------------------------------------------ order + ties ---

describe('selectCompactPalette — order preservation and frozen tie-breaks', () => {
  it('preserves prior cluster order for one-, two-, and twelve-cluster pools', () => {
    for (const size of [1, 2, MAX_COMPACT_PALETTE_SAMPLES]) {
      const clusters: CompactPaletteCluster[] = Array.from({ length: size }, (_, index) => {
        const value = `#${(0x102030 + index * 0x111111).toString(16).padStart(6, '0')}`;
        const [red, green, blue] = rgbOf(value);
        return { count: 0, red, green, blue, hex: value };
      });
      const pool = synthetic(40, 40, clusters, (x, y) => (x + y * 40) % size);
      const selected = selectCompactPalette(pool.raster, pool.clusters);
      expect(selected.samples.map((sample) => sample.index)).toEqual(
        clusters.map((_, index) => index),
      );
      expect(selected.samples.map((sample) => sample.cluster.hex)).toEqual(
        pool.clusters.map((cluster) => cluster.hex),
      );
    }
  });

  it('freezes the exact-score tie-break key order', () => {
    const base = { familyPixelShare: 0.01, frequency: 100, hex: '#112233', index: 5 };
    // 1. familyPixelShare descending.
    expect(compareCompactTieBreak({ ...base, familyPixelShare: 0.02 }, base)).toBeLessThan(0);
    expect(compareCompactTieBreak(base, { ...base, familyPixelShare: 0.02 })).toBeGreaterThan(0);
    // 2. individual frequency descending.
    expect(compareCompactTieBreak({ ...base, frequency: 101 }, base)).toBeLessThan(0);
    // 3. hex ascending (frequency equal).
    expect(compareCompactTieBreak({ ...base, hex: '#112232', index: 9 }, base)).toBeLessThan(0);
    expect(compareCompactTieBreak({ ...base, hex: '#112234', index: 0 }, base)).toBeGreaterThan(0);
    // 4. original merged-cluster index ascending.
    expect(compareCompactTieBreak({ ...base, index: 4 }, base)).toBeLessThan(0);
    expect(compareCompactTieBreak({ ...base, index: 6 }, base)).toBeGreaterThan(0);
    expect(compareCompactTieBreak(base, { ...base })).toBe(0);
  });

  /**
   * Two clusters sharing one representative colour is the only construction
   * whose diversity scores are EXACTLY equal at every step, so it is the only
   * way to freeze which key actually decided a real selection.
   */
  function twinPool(firstRun: number): ReturnType<typeof synthetic> {
    const dominant: CompactPaletteCluster = {
      count: 0,
      red: 255,
      green: 255,
      blue: 255,
      hex: '#ffffff',
    };
    const twin = { count: 0, red: 12, green: 160, blue: 90, hex: '#0ca05a' };
    const filler: CompactPaletteCluster[] = Array.from({ length: 11 }, (_, index) => {
      const value = `#${(0x203040 + index * 0x0d1117).toString(16).padStart(6, '0')}`;
      const [red, green, blue] = rgbOf(value);
      return { count: 0, red, green, blue, hex: value };
    });
    return synthetic(100, 100, [dominant, { ...twin }, { ...twin }, ...filler], (x, y) => {
      if (y < 2) return x < firstRun ? 1 : 2;
      if (y < 4) return x < 40 ? 1 : 3 + (x % 11);
      if (y < 12) return 3 + (x % 11);
      return 0;
    });
  }

  it('breaks an exact score tie by individual frequency before merged index', () => {
    const pool = twinPool(60);
    const selected = selectCompactPalette(pool.raster, pool.clusters);
    expect(pool.clusters[1]!.count).toBeGreaterThan(pool.clusters[2]!.count);
    const twins = selected.samples.filter((sample) => sample.cluster.hex === '#0ca05a');
    expect(twins.map((sample) => sample.index)).toEqual([1]);
  });

  it('falls through to merged-cluster index when frequency also ties', () => {
    const equal = synthetic(
      100,
      100,
      [
        { count: 0, red: 255, green: 255, blue: 255, hex: '#ffffff' },
        { count: 0, red: 12, green: 160, blue: 90, hex: '#0ca05a' },
        { count: 0, red: 12, green: 160, blue: 90, hex: '#0ca05a' },
        ...Array.from({ length: 11 }, (_, index) => {
          const value = `#${(0x203040 + index * 0x0d1117).toString(16).padStart(6, '0')}`;
          const [red, green, blue] = rgbOf(value);
          return { count: 0, red, green, blue, hex: value };
        }),
      ],
      (x, y) => {
        if (y < 2) return x < 50 ? 1 : 2;
        if (y < 4) return x < 40 ? 1 : 3 + (x % 11);
        if (y < 12) return 3 + (x % 11);
        return 0;
      },
    );
    const selected = selectCompactPalette(equal.raster, equal.clusters);
    const twins = selected.samples.filter((sample) => sample.cluster.hex === '#0ca05a');
    expect(twins.map((sample) => sample.index)).toEqual([1]);
  });
});

describe('compact palette — shared lightness bound after the color-metric import swap', () => {
  /**
   * Step 41 replaced this module's inline `PALETTE_FAMILY_DELTA_E * 1.75` family
   * pre-filter with the shared `lightnessGapCeiling()` leaf. The swap is only
   * safe because the shared ceiling reuses the SAME 1.75, so the bound is still
   * exactly 21.0 and not one selection above can have moved. Freeze that: a
   * future "tightening" of S_L_CEILING to the true 1.74702 maximum would silently
   * narrow this module's pre-filter to 20.9642 and is what this test exists to
   * catch. Every other anchor in this file is the evidence that nothing moved.
   */
  it('reproduces the previously inlined MAX_FAMILY_LIGHTNESS_GAP exactly', () => {
    expect(S_L_CEILING).toBe(1.75);
    expect(lightnessGapCeiling(PALETTE_FAMILY_DELTA_E)).toBe(21);
    expect(lightnessGapCeiling(PALETTE_FAMILY_DELTA_E)).toBe(PALETTE_FAMILY_DELTA_E * 1.75);
  });

  it('never rejects a family member it should have kept', () => {
    // The pre-filter is a shortcut around the exact distance, so it must be a
    // strict over-approximation: any pair inside the family radius must also be
    // inside the lightness gap.
    const gap = lightnessGapCeiling(PALETTE_FAMILY_DELTA_E);
    const lightnessOf = (hex: string): number => new Color(hex).to('lab').coords[0] ?? 0;
    const anchors = ['#000000', '#404040', '#808080', '#c0c0c0', '#ffffff', '#0ca05a', '#b4472a', '#2b4c8c'];
    for (const left of anchors) {
      for (const right of anchors) {
        const distance = new Color(left).deltaE(new Color(right), { method: '2000' });
        if (distance > PALETTE_FAMILY_DELTA_E) continue;
        expect(
          Math.abs(lightnessOf(left) - lightnessOf(right)),
          `${left}/${right} is inside dE ${PALETTE_FAMILY_DELTA_E} but outside the gap`,
        ).toBeLessThanOrEqual(gap);
      }
    }
  });
});
