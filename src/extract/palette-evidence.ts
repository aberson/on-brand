/**
 * Source-neutral palette evidence contracts.
 *
 * Image decoding deliberately lives in `image-palette.ts`; this module contains
 * no filesystem, decoder, network, or LLM dependency.  Keeping the measured
 * evidence shape separate lets the URL and local-image acquisition adapters
 * feed the same later synthesis seam without pretending their observations are
 * interchangeable.
 */

import type { RawExtraction } from './engine/adapter.ts';
import type { TokensDocument } from '../schema/types.ts';

/** The only raster formats accepted by the v1 local-image adapter. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp';

/** The released first deterministic local-raster measurement. */
export const IMAGE_CLUSTER_ALGORITHM_V1 = 'image-cluster-v1' as const;

/**
 * The current deterministic local-raster measurement.  V2 keeps every v1
 * decode/quantization/merge rule and only changes which merged clusters survive
 * the frozen twelve-sample budget, so it is an algorithm-vocabulary expansion
 * rather than a trace/catalog envelope change.
 */
export const IMAGE_CLUSTER_ALGORITHM_V2 = 'image-cluster-v2' as const;

/** Every image algorithm a stored trace, export, or evidence file may carry. */
export const SUPPORTED_IMAGE_CLUSTER_ALGORITHMS = [
  IMAGE_CLUSTER_ALGORITHM_V1,
  IMAGE_CLUSTER_ALGORITHM_V2,
] as const;

export type ImageClusterAlgorithm = (typeof SUPPORTED_IMAGE_CLUSTER_ALGORITHMS)[number];

/**
 * The ONE constant naming the algorithm the CURRENT producer emits.  Stored
 * evidence measured before this correction legitimately still carries v1 and is
 * never rewritten.
 */
export const IMAGE_CLUSTER_ALGORITHM = IMAGE_CLUSTER_ALGORITHM_V2;

export function isSupportedImageClusterAlgorithm(value: unknown): value is ImageClusterAlgorithm {
  return (
    typeof value === 'string' &&
    (SUPPORTED_IMAGE_CLUSTER_ALGORITHMS as readonly string[]).includes(value)
  );
}

/**
 * The ONE owner of the unsupported-algorithm rejection.  Every entry point that
 * derives a deterministic role or a token document from measured evidence calls
 * this FIRST, so a typo, a future version, or corrupted stored evidence fails
 * closed instead of being silently treated as fully supported released v1.
 */
export function requireImageClusterAlgorithm(value: unknown): ImageClusterAlgorithm {
  if (!isSupportedImageClusterAlgorithm(value)) {
    throw new Error(
      `palette evidence algorithm ${JSON.stringify(value)} is not a supported image-cluster algorithm`,
    );
  }
  return value;
}

/**
 * The frozen maximum number of measured samples in one image palette.  ONE
 * owner: `image-palette.ts` and `compact-palette.ts` both re-export this exact
 * value so a future edit cannot silently split the evidence budget in two.
 */
export const MAX_PALETTE_SAMPLES = 12;

/**
 * Only v2 evidence is required to carry deterministic family-support metrics.
 * Callers must have already narrowed `algorithm` through
 * `requireImageClusterAlgorithm`; this predicate only splits v1 from v2.
 */
export function requiresPaletteSupportEvidence(algorithm: string): boolean {
  return algorithm === IMAGE_CLUSTER_ALGORITHM_V2;
}

// --- v2 support contract (ONE owner for these thresholds) --------------------

/** Palette candidates must clear this chroma floor to be colorful. */
export const PALETTE_CHROMA_FLOOR = 0.02;
/** A selected neutral tint is intentionally less chromatic than this. */
export const PALETTE_NEUTRAL_CHROMA_MAX = 0.05;
/** Image clusters with less than this share never tint the neutral ramp. */
export const PALETTE_NEUTRAL_MIN_SHARE = 0.02;

/**
 * Candidate-centered, NON-transitive perceptual family radius (Delta E 2000).
 * Non-transitive membership stops a gradient from chaining unrelated ends into
 * one giant family.
 */
export const PALETTE_FAMILY_DELTA_E = 12;
/** Aggregate family support: 0.25 percent of the bounded working raster. */
export const PALETTE_MIN_FAMILY_PIXEL_SHARE = 0.0025;
/** Local support: the working-pixel fraction used by the component floor. */
export const PALETTE_MIN_FAMILY_COMPONENT_SHARE = 0.00025;
/** Local support never falls below this absolute 8-connected pixel count. */
export const PALETTE_MIN_FAMILY_COMPONENT_PIXELS = 4;

/** Deterministic v2 support evidence for one measured sample. */
export interface PaletteSupportEvidence {
  familyPixelShare: number;
  largestFamilyRegionPixelShare: number;
}

function isUnitShare(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Read v2 support evidence, or `undefined` when it is missing or malformed.
 * Callers deciding a deterministic palette role must FAIL CLOSED on undefined.
 */
export function readPaletteSupportEvidence(sample: PaletteSample): PaletteSupportEvidence | undefined {
  if (!isUnitShare(sample.familyPixelShare) || !isUnitShare(sample.largestFamilyRegionPixelShare)) {
    return undefined;
  }
  return {
    familyPixelShare: sample.familyPixelShare,
    largestFamilyRegionPixelShare: sample.largestFamilyRegionPixelShare,
  };
}

/** `max(4, ceil(workingPixels * 0.00025))` 8-connected family pixels. */
export function minimumFamilyComponentPixels(workingPixels: number): number {
  return Math.max(
    PALETTE_MIN_FAMILY_COMPONENT_PIXELS,
    Math.ceil(workingPixels * PALETTE_MIN_FAMILY_COMPONENT_SHARE),
  );
}

/**
 * The shared aggregate-AND-local support gate.  Aggregate support lets related
 * brushstroke shades count together; local support stops an equal number of
 * isolated salt-and-pepper pixels from masquerading as an accent.
 */
export function hasQualifyingPaletteSupport(
  support: PaletteSupportEvidence,
  workingPixels: number,
): boolean {
  if (!Number.isFinite(workingPixels) || workingPixels < 1) return false;
  if (support.familyPixelShare < PALETTE_MIN_FAMILY_PIXEL_SHARE) return false;
  const componentPixels = Math.round(support.largestFamilyRegionPixelShare * workingPixels);
  return componentPixels >= minimumFamilyComponentPixels(workingPixels);
}

/**
 * Recover the bounded working-raster pixel count from measured evidence.
 * `pixelShare === frequency / workingPixels` for every image sample, so the
 * most frequent sample recovers it with the least rounding error.  Returns
 * `undefined` when no sample can support the recovery.
 */
export function workingPixelCountFromSamples(samples: readonly PaletteSample[]): number | undefined {
  let best: number | undefined;
  let bestFrequency = 0;
  for (const sample of samples) {
    if (
      typeof sample.frequency !== 'number' ||
      !Number.isFinite(sample.frequency) ||
      sample.frequency < 1 ||
      typeof sample.pixelShare !== 'number' ||
      !Number.isFinite(sample.pixelShare) ||
      sample.pixelShare <= 0 ||
      sample.pixelShare > 1
    ) {
      continue;
    }
    if (sample.frequency <= bestFrequency) continue;
    const working = Math.round(sample.frequency / sample.pixelShare);
    if (!Number.isSafeInteger(working) || working < 1 || working < sample.frequency) continue;
    bestFrequency = sample.frequency;
    best = working;
  }
  return best;
}

/** A normalized source rectangle.  Image samples use a fixed 0.04 square. */
export interface PaletteRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Acquisition provenance.  `assetPath` is caller-owned provenance, not a URL. */
export type PaletteSource =
  | { kind: 'url'; url: string; screenshotPath: string | null }
  | {
      kind: 'image';
      assetPath: string;
      assetSha256: string;
      mediaType: ImageMediaType;
    };

/** One measured palette cluster, in deterministic cluster order. */
export interface PaletteSample {
  /** `sample-01` through `sample-12`, assigned after compact ordering. */
  id: string;
  /** Lowercase opaque sRGB `#rrggbb`. */
  hex: string;
  /** Number of working-raster pixels represented by this cluster. */
  frequency: number;
  /** `frequency / working-raster pixel count`, always in (0, 1] for images. */
  pixelShare: number;
  /** Null is allowed for adapters that cannot localize a source sample. */
  region: PaletteRegion | null;
  /**
   * image-cluster-v2 only: the fraction of working-raster pixels inside this
   * sample's candidate-centered, non-transitive perceptual family.  Stored v1
   * evidence legitimately omits it.
   */
  familyPixelShare?: number;
  /**
   * image-cluster-v2 only: the fraction of working-raster pixels in that
   * family's largest 8-connected component.  Stored v1 evidence omits it.
   */
  largestFamilyRegionPixelShare?: number;
}

/** Measured color evidence plus the non-color observations available to it. */
export interface PaletteEvidence {
  source: PaletteSource;
  algorithm: string;
  samples: PaletteSample[];
  nonColor: Pick<RawExtraction, 'fonts' | 'typeSizes' | 'spacing' | 'radii' | 'shadows'>;
}

/** One source-neutral structural palette choice. */
export interface PaletteDecision {
  primary: { sampleId: string; selectionSource: 'deterministic' | 'llm' };
  neutral: { sampleId: string; selectionSource: 'deterministic' } | null;
  secondaries: Array<{ sampleId: string; selectionSource: 'deterministic' }>;
}

export type MappingPresentation =
  | 'surface'
  | 'text'
  | 'button-bg'
  | 'badge-bg'
  | 'chart-series'
  | 'swatch-only';

export type MappingRelationship = 'sampled' | 'adjusted-for-contrast' | 'derived';

/** A source sample and all concrete token targets emitted from it. */
export interface TraceMappingDraft {
  id: string;
  label: string;
  region: PaletteRegion;
  sample: {
    hex: string;
    method: ImageClusterAlgorithm;
    selectionSource: 'deterministic' | 'llm';
    pixelShare: number;
  };
  targets: Array<{
    token: string;
    presentation: MappingPresentation;
    relationship: MappingRelationship;
    usage: string;
  }>;
  rationale: string;
  confidence: 'low' | 'medium' | 'high';
}

export interface PaletteSynthesisResult {
  tokens: TokensDocument;
  dark: TokensDocument;
  basePreset: 'default';
  mappings: TraceMappingDraft[];
  unobservedDefaults: Array<'typography' | 'spacing' | 'radius' | 'shadow' | 'motion' | 'status'>;
  defaultDerivedColorTargets: Array<{
    token: string;
    role: 'categorical' | 'diagram';
    reason: 'no-qualifying-image-sample';
  }>;
}
