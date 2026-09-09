import { describe, expect, it } from 'vitest';
import {
  PALETTE_ASSIGNMENT_TARGETS,
  buildTokensFromPalette,
  getLeaf,
  selectPaletteDecision,
} from '../src/extract/normalize.ts';
import {
  IMAGE_CLUSTER_ALGORITHM,
  IMAGE_CLUSTER_ALGORITHM_V1,
  IMAGE_CLUSTER_ALGORITHM_V2,
  PALETTE_MIN_FAMILY_PIXEL_SHARE,
  hasQualifyingPaletteSupport,
  minimumFamilyComponentPixels,
  readPaletteSupportEvidence,
  workingPixelCountFromSamples,
  type PaletteEvidence,
  type PaletteSample,
} from '../src/extract/palette-evidence.ts';
import { validate } from '../src/schema/validate.ts';

function sample(
  id: string,
  hex: string,
  pixelShare: number,
  x = 0.1,
): PaletteSample {
  return {
    id,
    hex,
    frequency: Math.round(pixelShare * 10_000),
    pixelShare,
    region: { x, y: 0.1, width: 0.04, height: 0.04 },
  };
}

function evidence(
  samples: PaletteSample[],
  algorithm: string = IMAGE_CLUSTER_ALGORITHM_V1,
): PaletteEvidence {
  return {
    source: {
      kind: 'image',
      assetPath: 'assets/inspiration.png',
      assetSha256: '0'.repeat(64),
      mediaType: 'image/png',
    },
    algorithm,
    samples,
    nonColor: { fonts: [], typeSizes: [], spacing: [], radii: [], shadows: [] },
  };
}

/**
 * `sample()` derives `frequency` from a 10,000-pixel working raster. Both
 * floors come from their ONE owner in `palette-evidence.ts` rather than a
 * copied formula, so a threshold edit moves these fixtures with it.
 */
const V2_WORKING_PIXELS = 10_000;
/** `max(4, ceil(workingPixels * 0.00025))` 8-connected pixels for this raster. */
const V2_MIN_COMPONENT_PIXELS = minimumFamilyComponentPixels(V2_WORKING_PIXELS);
/** Aggregate support is ample and the largest component clears the local floor. */
const SUPPORTED = {
  familyPixelShare: PALETTE_MIN_FAMILY_PIXEL_SHARE * 20,
  largestFamilyRegionPixelShare: (V2_MIN_COMPONENT_PIXELS * 50) / V2_WORKING_PIXELS,
};
/** Aggregate support is ample, but the largest component is half the local floor. */
const SCATTERED = {
  familyPixelShare: SUPPORTED.familyPixelShare,
  largestFamilyRegionPixelShare: V2_MIN_COMPONENT_PIXELS / 2 / V2_WORKING_PIXELS,
};

function v2Sample(
  id: string,
  hex: string,
  pixelShare: number,
  x: number,
  support: { familyPixelShare: number; largestFamilyRegionPixelShare: number } = SUPPORTED,
): PaletteSample {
  return { ...sample(id, hex, pixelShare, x), ...support };
}

function v2Evidence(samples: PaletteSample[]): PaletteEvidence {
  return evidence(samples, IMAGE_CLUSTER_ALGORITHM_V2);
}

const VIVID_EVIDENCE = evidence([
  sample('sample-01', '#1d4ed8', 0.22, 0.1), // deterministic primary
  sample('sample-02', '#e7e5e4', 0.3, 0.2), // qualifying neutral
  sample('sample-03', '#ef4444', 0.18, 0.3),
  sample('sample-04', '#16a34a', 0.12, 0.4),
  sample('sample-05', '#d97706', 0.08, 0.5),
]);

/**
 * A supported v2 pool with one dominant cool field, a qualifying neutral, and
 * distinct cool / green / warm / violet / light-value accents. The production
 * code never names a hue; this fixture only proves diverse roles survive.
 */
const DIVERSE_V2_EVIDENCE = v2Evidence([
  v2Sample('sample-01', '#0f766e', 0.3, 0.1),
  v2Sample('sample-02', '#e7e5e4', 0.2, 0.2),
  v2Sample('sample-03', '#1d4ed8', 0.14, 0.3),
  v2Sample('sample-04', '#16a34a', 0.12, 0.4),
  v2Sample('sample-05', '#e11d48', 0.1, 0.5),
  v2Sample('sample-06', '#7c3aed', 0.08, 0.6),
  v2Sample('sample-07', '#fde68a', 0.06, 0.7),
]);

describe('selectPaletteDecision — frozen measured-palette selection', () => {
  it('chooses primary, neutral, and Delta-E separated secondaries deterministically', () => {
    const first = selectPaletteDecision(VIVID_EVIDENCE);
    const second = selectPaletteDecision({ ...VIVID_EVIDENCE, samples: [...VIVID_EVIDENCE.samples].reverse() });

    expect(first).toEqual({
      primary: { sampleId: 'sample-01', selectionSource: 'deterministic' },
      neutral: { sampleId: 'sample-02', selectionSource: 'deterministic' },
      secondaries: [
        { sampleId: 'sample-03', selectionSource: 'deterministic' },
        { sampleId: 'sample-04', selectionSource: 'deterministic' },
        { sampleId: 'sample-05', selectionSource: 'deterministic' },
      ],
    });
    expect(second).toEqual(first);
  });

  it('permits an LLM primary only when it names a measured colorful candidate', () => {
    expect(
      selectPaletteDecision(VIVID_EVIDENCE, {
        primarySampleId: 'sample-03',
        primarySelectionSource: 'llm',
      }),
    ).toMatchObject({ primary: { sampleId: 'sample-03', selectionSource: 'llm' } });
    expect(() =>
      selectPaletteDecision(VIVID_EVIDENCE, {
        primarySampleId: 'sample-02',
        primarySelectionSource: 'llm',
      }),
    ).toThrow(/colorful candidate/);
    expect(() => selectPaletteDecision(VIVID_EVIDENCE, { primarySampleId: 'sample-03' })).toThrow(
      /only an LLM/,
    );
  });

  it('uses the measured achromatic fallback rather than a fabricated brand seed', () => {
    const gray = evidence([
      sample('sample-01', '#555555', 0.25),
      sample('sample-02', '#aaaaaa', 0.5),
      sample('sample-03', '#222222', 0.25),
    ]);
    const decision = selectPaletteDecision(gray);
    expect(decision).toEqual({
      primary: { sampleId: 'sample-02', selectionSource: 'deterministic' },
      neutral: { sampleId: 'sample-03', selectionSource: 'deterministic' },
      secondaries: [],
    });
  });

  it('keeps a one-color image honest: one measured primary and no invented neutral or secondary', () => {
    const oneColor = evidence([sample('sample-01', '#777777', 1)]);
    const decision = selectPaletteDecision(oneColor);
    const result = buildTokensFromPalette(oneColor, decision);

    expect(decision).toEqual({
      primary: { sampleId: 'sample-01', selectionSource: 'deterministic' },
      neutral: null,
      secondaries: [],
    });
    expect(result.mappings.map((mapping) => mapping.id)).toEqual(['sample-01']);
    expect(result.defaultDerivedColorTargets).toHaveLength(10);
    expect(getLeaf(result.tokens, 'color.primitive.brand.9')).not.toBe('#3b63a8');
  });
});

describe('selectPaletteDecision — image-cluster-v2 support filtering', () => {
  it('pins the current producer algorithm and the released v1 vocabulary', () => {
    expect(IMAGE_CLUSTER_ALGORITHM_V1).toBe('image-cluster-v1');
    expect(IMAGE_CLUSTER_ALGORITHM_V2).toBe('image-cluster-v2');
    expect(IMAGE_CLUSTER_ALGORITHM).toBe(IMAGE_CLUSTER_ALGORITHM_V2);
    // Released v1 evidence carries no support fields and keeps its behavior.
    expect(VIVID_EVIDENCE.algorithm).toBe(IMAGE_CLUSTER_ALGORITHM_V1);
    for (const measured of VIVID_EVIDENCE.samples) {
      expect(measured.familyPixelShare).toBeUndefined();
      expect(measured.largestFamilyRegionPixelShare).toBeUndefined();
    }
    expect(sample('sample-01', '#1d4ed8', 0.22).frequency / 0.22).toBe(V2_WORKING_PIXELS);
  });

  it('derives both v2 fixtures from the shared support gate rather than copied numbers', () => {
    expect(V2_MIN_COMPONENT_PIXELS).toBe(4);
    expect(PALETTE_MIN_FAMILY_PIXEL_SHARE * V2_WORKING_PIXELS).toBe(25);
    expect(SUPPORTED).toEqual({ familyPixelShare: 0.05, largestFamilyRegionPixelShare: 0.02 });
    expect(SCATTERED).toEqual({ familyPixelShare: 0.05, largestFamilyRegionPixelShare: 0.0002 });
    // Aggregate support is identical; only local 8-connected support differs.
    expect(hasQualifyingPaletteSupport(SUPPORTED, V2_WORKING_PIXELS)).toBe(true);
    expect(hasQualifyingPaletteSupport(SCATTERED, V2_WORKING_PIXELS)).toBe(false);
    expect(Math.round(SCATTERED.largestFamilyRegionPixelShare * V2_WORKING_PIXELS)).toBe(2);
  });

  it('assigns every distinct diverse role from one supported v2 pool', () => {
    const decision = selectPaletteDecision(DIVERSE_V2_EVIDENCE);
    expect(decision).toEqual({
      primary: { sampleId: 'sample-01', selectionSource: 'deterministic' },
      neutral: { sampleId: 'sample-02', selectionSource: 'deterministic' },
      secondaries: [
        { sampleId: 'sample-03', selectionSource: 'deterministic' },
        { sampleId: 'sample-04', selectionSource: 'deterministic' },
        { sampleId: 'sample-05', selectionSource: 'deterministic' },
        { sampleId: 'sample-06', selectionSource: 'deterministic' },
        { sampleId: 'sample-07', selectionSource: 'deterministic' },
      ],
    });
    const ids = [
      decision.primary.sampleId,
      decision.neutral!.sampleId,
      ...decision.secondaries.map((secondary) => secondary.sampleId),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(decision.secondaries.length).toBeLessThanOrEqual(7);

    const result = buildTokensFromPalette(DIVERSE_V2_EVIDENCE, decision);
    expect(result.mappings.map((mapping) => mapping.id)).toEqual(ids);
    expect(result.mappings.every((mapping) => mapping.sample.method === IMAGE_CLUSTER_ALGORITHM_V2)).toBe(
      true,
    );
    expect(validate(result.tokens, { kind: 'tokens' }).ok).toBe(true);
    expect(validate(result.dark, { kind: 'overlay' }).ok).toBe(true);
    const mappedFrozen = result.mappings
      .flatMap((mapping) => mapping.targets.map((target) => target.token))
      .filter((target) => (PALETTE_ASSIGNMENT_TARGETS as readonly string[]).includes(target));
    const defaulted = result.defaultDerivedColorTargets.map((target) => target.token);
    expect([...mappedFrozen, ...defaulted]).toEqual([...PALETTE_ASSIGNMENT_TARGETS]);
  });

  // Narrow title on purpose: this pool keeps a SUPPORTED colourful alternative
  // (`sample-01`), so `colorful` is never empty and the last-resort fallback is
  // never reached. The empty-`colorful` fallback has its own test below.
  it('keeps a scattered high-chroma outlier out of every role while a supported accent exists', () => {
    const outlier = v2Evidence([
      v2Sample('sample-01', '#0f766e', 0.3, 0.1),
      v2Sample('sample-02', '#e7e5e4', 0.25, 0.2),
      v2Sample('sample-03', '#ff00ff', 0.3, 0.3, SCATTERED),
    ]);
    const decision = selectPaletteDecision(outlier);
    expect(decision.primary.sampleId).toBe('sample-01');
    expect(decision.secondaries.map((secondary) => secondary.sampleId)).not.toContain('sample-03');
    // The same pool without the local-support failure DOES map the outlier.
    const supported = v2Evidence([
      v2Sample('sample-01', '#0f766e', 0.3, 0.1),
      v2Sample('sample-02', '#e7e5e4', 0.25, 0.2),
      v2Sample('sample-03', '#ff00ff', 0.3, 0.3),
    ]);
    expect(selectPaletteDecision(supported).primary.sampleId).toBe('sample-03');
  });

  it('fails closed when v2 support evidence is missing or malformed', () => {
    const missing = v2Evidence([sample('sample-01', '#1d4ed8', 0.6, 0.1)]);
    expect(() => selectPaletteDecision(missing)).toThrow(/no valid samples/);

    const malformed = v2Evidence([
      v2Sample('sample-01', '#1d4ed8', 0.6, 0.1, {
        familyPixelShare: Number.NaN,
        largestFamilyRegionPixelShare: 0.02,
      }),
    ]);
    expect(() => selectPaletteDecision(malformed)).toThrow(/no valid samples/);

    const outOfRange = v2Evidence([
      v2Sample('sample-01', '#1d4ed8', 0.6, 0.1, {
        familyPixelShare: 0.05,
        largestFamilyRegionPixelShare: 1.5,
      }),
    ]);
    expect(() => selectPaletteDecision(outOfRange)).toThrow(/no valid samples/);
  });

  it('rejects evidence whose algorithm is not a supported image-cluster version', () => {
    const unsupported = evidence([sample('sample-01', '#1d4ed8', 0.6, 0.1)], 'image-cluster-v3');
    expect(() => buildTokensFromPalette(unsupported)).toThrow(/not a supported image-cluster algorithm/);
  });

  it('fails closed in selectPaletteDecision itself for any unrecognized algorithm', () => {
    // Without a boundary check an unrecognized algorithm reads as released v1:
    // support is never required, so every sample defaults to supported and the
    // decision comes back fully UNGATED instead of throwing.
    for (const unknown of ['image-cluster-v3', 'IMAGE-CLUSTER-V2', 'image-cluster-v', '', 'url-css']) {
      const bogus = evidence([sample('sample-01', '#1d4ed8', 0.6, 0.1)], unknown);
      expect(() => selectPaletteDecision(bogus)).toThrow(/not a supported image-cluster algorithm/);
      // The scattered v2 sample below would silently qualify on the lenient path.
      const bogusV2 = evidence(
        [v2Sample('sample-01', '#1d4ed8', 0.6, 0.1, SCATTERED)],
        unknown,
      );
      expect(() => selectPaletteDecision(bogusV2)).toThrow(/not a supported image-cluster algorithm/);
    }

    // Both released vocabulary entries still decide exactly as before.
    expect(selectPaletteDecision(VIVID_EVIDENCE).primary.sampleId).toBe('sample-01');
    expect(VIVID_EVIDENCE.algorithm).toBe(IMAGE_CLUSTER_ALGORITHM_V1);
    expect(selectPaletteDecision(DIVERSE_V2_EVIDENCE).primary.sampleId).toBe('sample-01');
    expect(DIVERSE_V2_EVIDENCE.algorithm).toBe(IMAGE_CLUSTER_ALGORITHM_V2);
  });

  /**
   * The v2 support conjunct on the colourful filter created a NEW way for
   * `colorful` to empty: every colourful candidate fails the local-support
   * gate. The last-resort primary used to sort EVERY candidate by pixel share
   * without reading `supported`, so the argmax unsupported colour took the
   * primary role (and `color.semantic.accent`) anyway. Real reproduction: a
   * vivid magenta on a sparse 2-px lattice at 25% pixel share.
   */
  const FALLBACK_ARGMAX_UNSUPPORTED = v2Evidence([
    // Argmax pixel share, vivid, locally unsupported: the demonstrated case.
    v2Sample('sample-01', '#e0157a', 0.5, 0.1, SCATTERED),
    v2Sample('sample-02', '#16a34a', 0.3, 0.3, SCATTERED),
    // Lower share, below the chroma floor, and the only SUPPORTED candidate.
    v2Sample('sample-03', '#a3a3a3', 0.2, 0.5),
  ]);

  it('prefers a supported sample when the v2 gate empties the colourful pool', () => {
    const decision = selectPaletteDecision(FALLBACK_ARGMAX_UNSUPPORTED);
    expect(decision).toEqual({
      primary: { sampleId: 'sample-03', selectionSource: 'deterministic' },
      neutral: null,
      secondaries: [],
    });

    const result = buildTokensFromPalette(FALLBACK_ARGMAX_UNSUPPORTED, decision);
    expect(result.mappings.map((mapping) => mapping.id)).toEqual(['sample-03']);
    for (const mapping of result.mappings) {
      expect(mapping.sample.hex, `mapping ${mapping.id}`).not.toBe('#e0157a');
      expect(mapping.sample.hex, `mapping ${mapping.id}`).not.toBe('#16a34a');
    }
    // No frozen assignment target carries the unsupported outlier's value.
    for (const target of PALETTE_ASSIGNMENT_TARGETS) {
      expect(getLeaf(result.tokens, target), target).not.toBe('#e0157a');
    }
  });

  it('names a primary without throwing when NO v2 sample is supported', () => {
    // Legitimate 1-sample v2 evidence the real producer genuinely emits: the
    // support metrics are valid and simply fail, so plan section 2's
    // always-present primary still has to hold.
    const soleScattered = v2Evidence([v2Sample('sample-01', '#e0157a', 1, 0.1, SCATTERED)]);
    expect(readPaletteSupportEvidence(soleScattered.samples[0]!)).toEqual(SCATTERED);
    expect(() => selectPaletteDecision(soleScattered)).not.toThrow();
    expect(selectPaletteDecision(soleScattered)).toEqual({
      primary: { sampleId: 'sample-01', selectionSource: 'deterministic' },
      neutral: null,
      secondaries: [],
    });
  });

  it('leaves released v1 decisions byte-identical: v1 never reads support fields', () => {
    const grayV1 = evidence([
      sample('sample-01', '#555555', 0.25, 0.1),
      sample('sample-02', '#aaaaaa', 0.5, 0.2),
      sample('sample-03', '#222222', 0.25, 0.3),
    ]);
    // The same achromatic pool -- which reaches the last-resort fallback -- with
    // v2-shaped support fields attached under the v1 algorithm. Read as v2 only
    // `sample-01` would be supported and the fallback primary would move, so an
    // identical decision AND identical token bytes prove v1 ignores them.
    const grayV1WithIgnoredSupport = evidence([
      v2Sample('sample-01', '#555555', 0.25, 0.1),
      v2Sample('sample-02', '#aaaaaa', 0.5, 0.2, SCATTERED),
      v2Sample('sample-03', '#222222', 0.25, 0.3, SCATTERED),
    ]);
    const released = {
      primary: { sampleId: 'sample-02', selectionSource: 'deterministic' },
      neutral: { sampleId: 'sample-03', selectionSource: 'deterministic' },
      secondaries: [],
    };
    expect(selectPaletteDecision(grayV1)).toEqual(released);
    expect(selectPaletteDecision(grayV1WithIgnoredSupport)).toEqual(released);
    expect(JSON.stringify(buildTokensFromPalette(grayV1).tokens)).toBe(
      JSON.stringify(buildTokensFromPalette(grayV1WithIgnoredSupport).tokens),
    );
    // The released colourful v1 fixture keeps every frozen role too.
    expect(selectPaletteDecision(VIVID_EVIDENCE)).toEqual({
      primary: { sampleId: 'sample-01', selectionSource: 'deterministic' },
      neutral: { sampleId: 'sample-02', selectionSource: 'deterministic' },
      secondaries: [
        { sampleId: 'sample-03', selectionSource: 'deterministic' },
        { sampleId: 'sample-04', selectionSource: 'deterministic' },
        { sampleId: 'sample-05', selectionSource: 'deterministic' },
      ],
    });
  });

  /**
   * Stop-and-audit regression. Two instances of one bug shape -- a deterministic
   * role assignment failing OPEN around the v2 support gate -- have now been
   * fixed, so assert the general INVARIANT instead of the one demonstrated
   * line: whenever v2 evidence holds at least one supported sample, no
   * unsupported sample may occupy the primary or any secondary role. The
   * neutral role is deliberately excluded (see the neutral selector's comment
   * in `normalize.ts`: plan section 3 scopes the gate to colourful pixels).
   */
  it('never lets an unsupported v2 sample take a primary or secondary role', () => {
    const shapes: { name: string; pool: PaletteEvidence }[] = [
      {
        name: 'unsupported argmax, only a low-chroma supported sample',
        pool: FALLBACK_ARGMAX_UNSUPPORTED,
      },
      { name: 'fully supported diverse pool', pool: DIVERSE_V2_EVIDENCE },
      {
        name: 'unsupported argmax with a supported colourful runner-up',
        pool: v2Evidence([
          v2Sample('sample-01', '#e0157a', 0.5, 0.1, SCATTERED),
          v2Sample('sample-02', '#1d4ed8', 0.2, 0.3),
          v2Sample('sample-03', '#e7e5e4', 0.3, 0.5),
        ]),
      },
      {
        name: 'every colourful sample scattered, supported neutral is the argmax',
        pool: v2Evidence([
          v2Sample('sample-01', '#e7e5e4', 0.4, 0.1),
          v2Sample('sample-02', '#ff00ff', 0.35, 0.3, SCATTERED),
          v2Sample('sample-03', '#16a34a', 0.25, 0.5, SCATTERED),
        ]),
      },
    ];

    for (const shape of shapes) {
      expect(workingPixelCountFromSamples(shape.pool.samples), `${shape.name}: working pixels`).toBe(
        V2_WORKING_PIXELS,
      );
      const supported = new Set(
        shape.pool.samples
          .filter((measured) => {
            const support = readPaletteSupportEvidence(measured);
            return support !== undefined && hasQualifyingPaletteSupport(support, V2_WORKING_PIXELS);
          })
          .map((measured) => measured.id),
      );
      expect(supported.size, `${shape.name}: has a supported sample`).toBeGreaterThan(0);

      const decision = selectPaletteDecision(shape.pool);
      expect(supported.has(decision.primary.sampleId), `${shape.name}: primary`).toBe(true);
      for (const secondary of decision.secondaries) {
        expect(supported.has(secondary.sampleId), `${shape.name}: secondary`).toBe(true);
      }
      // The same invariant must survive the production token builder.
      const roleIds = new Set([
        decision.primary.sampleId,
        ...decision.secondaries.map((secondary) => secondary.sampleId),
      ]);
      const result = buildTokensFromPalette(shape.pool, decision);
      for (const mapping of result.mappings) {
        if (!roleIds.has(mapping.id)) continue;
        expect(supported.has(mapping.id), `${shape.name}: mapping ${mapping.id}`).toBe(true);
      }
    }
  });
});

describe('buildTokensFromPalette — one token result and one canonical trace', () => {
  it('changes concrete secondary targets and accounts for every frozen assignment row', () => {
    const decision = selectPaletteDecision(VIVID_EVIDENCE);
    const result = buildTokensFromPalette(VIVID_EVIDENCE, decision);

    expect(result.basePreset).toBe('default');
    expect(validate(result.tokens, { kind: 'tokens' }).ok).toBe(true);
    expect(validate(result.dark, { kind: 'overlay' }).ok).toBe(true);
    expect(result.mappings.map((mapping) => mapping.id)).toEqual([
      'sample-01',
      'sample-02',
      'sample-03',
      'sample-04',
      'sample-05',
    ]);
    const selectedIds = [
      decision.primary.sampleId,
      ...(decision.neutral === null ? [] : [decision.neutral.sampleId]),
      ...decision.secondaries.map((secondary) => secondary.sampleId),
    ];
    expect(result.mappings.map((mapping) => mapping.id)).toEqual(selectedIds);
    for (const mapping of result.mappings) {
      const measured = VIVID_EVIDENCE.samples.find((candidate) => candidate.id === mapping.id);
      expect(measured, `mapping ${mapping.id} names measured evidence`).toBeDefined();
      if (measured === undefined) continue;
      expect(mapping.sample.hex).toBe(measured.hex);
      expect(mapping.sample.pixelShare).toBe(measured.pixelShare);
      for (const target of mapping.targets) {
        expect(getLeaf(result.tokens, target.token), `light target ${target.token}`).toEqual(
          expect.any(String),
        );
        expect(getLeaf(result.dark, target.token), `dark target ${target.token}`).toEqual(
          expect.any(String),
        );
      }
    }
    expect(result.mappings.map((mapping) => [mapping.id, mapping.confidence])).toEqual([
      ['sample-01', 'high'],
      ['sample-02', 'medium'],
      ['sample-03', 'high'],
      ['sample-04', 'high'],
      ['sample-05', 'high'],
    ]);
    expect(getLeaf(result.tokens, 'color.chart.categorical.2')).not.toBe('#c8571f');
    expect(getLeaf(result.tokens, 'color.diagram.node-stroke')).not.toBe('#86a5d9');

    const mappedFrozen = result.mappings
      .flatMap((mapping) => mapping.targets.map((target) => target.token))
      .filter((target) => (PALETTE_ASSIGNMENT_TARGETS as readonly string[]).includes(target));
    const defaulted = result.defaultDerivedColorTargets.map((target) => target.token);
    expect([...mappedFrozen, ...defaulted]).toEqual([...PALETTE_ASSIGNMENT_TARGETS]);
    expect(new Set([...mappedFrozen, ...defaulted]).size).toBe(PALETTE_ASSIGNMENT_TARGETS.length);
    expect(result.defaultDerivedColorTargets).toEqual([
      { token: 'color.chart.categorical.5', role: 'categorical', reason: 'no-qualifying-image-sample' },
      { token: 'color.chart.categorical.6', role: 'categorical', reason: 'no-qualifying-image-sample' },
      { token: 'color.chart.categorical.7', role: 'categorical', reason: 'no-qualifying-image-sample' },
      { token: 'color.chart.categorical.8', role: 'categorical', reason: 'no-qualifying-image-sample' },
    ]);
    expect(result.unobservedDefaults).toEqual([
      'typography',
      'spacing',
      'radius',
      'shadow',
      'motion',
      'status',
    ]);
  });

  it('stamps every mapping with the measured algorithm rather than a producer literal', () => {
    const v1 = buildTokensFromPalette(VIVID_EVIDENCE);
    expect(v1.mappings.every((mapping) => mapping.sample.method === IMAGE_CLUSTER_ALGORITHM_V1)).toBe(
      true,
    );
    expect(v1.mappings[0]!.rationale).toContain(IMAGE_CLUSTER_ALGORITHM_V1);

    const v2 = buildTokensFromPalette(DIVERSE_V2_EVIDENCE);
    expect(v2.mappings.every((mapping) => mapping.sample.method === IMAGE_CLUSTER_ALGORITHM_V2)).toBe(
      true,
    );
    expect(v2.mappings[0]!.rationale).toContain(IMAGE_CLUSTER_ALGORITHM_V2);
  });

  it('rejects a caller-forged neutral or secondary decision', () => {
    const decision = selectPaletteDecision(VIVID_EVIDENCE);
    expect(() =>
      buildTokensFromPalette(VIVID_EVIDENCE, {
        ...decision,
        secondaries: [],
      }),
    ).toThrow(/frozen deterministic policy/);
  });
});
