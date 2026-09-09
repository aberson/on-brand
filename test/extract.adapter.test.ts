/**
 * Adapter interface shape tests (Step 8): the coverage-scoring functions in
 * src/extract/engine/adapter.ts are the instrument that decided the dembrandt
 * spike and will gate any future engine (engine/own.ts must pass the same
 * harness). Calibration anchors first (measurement-validity: an instrument
 * that cannot fail garbage cannot pick winners), then edge semantics.
 */

import { describe, expect, it } from 'vitest';
import {
  MINIMUM_COVERAGE_FIELDS,
  NEAR_EMPTY_MAX,
  coverageOf,
  isNearEmpty,
  meetsMinimumCoverage,
  substantiveObservationCount,
  type RawExtraction,
} from '../src/extract/engine/adapter.ts';

/** A hand-built token-rich extraction (known-good anchor). */
function richExtraction(): RawExtraction {
  return {
    url: 'https://rich.example',
    extractedAt: '2026-07-16T00:00:00.000Z',
    engine: { name: 'anchor', version: '0' },
    colors: [
      { hex: '#0d2c40', frequency: 177, roles: [{ role: 'text', count: 177 }] },
      { hex: '#f6efe5', frequency: 90, roles: [{ role: 'background', count: 90 }] },
      { hex: '#f15a30', frequency: 4, roles: [{ role: 'accent', count: 2 }] },
    ],
    fonts: [{ families: ['ff-meta-web-pro', 'sans-serif'], role: 'heading', frequency: 4 }],
    typeSizes: [
      { px: 16, frequency: 3, fontWeight: 400 },
      { px: 48, frequency: 1, fontWeight: 700, lineHeightPx: 96 },
    ],
    spacing: [{ px: 16, frequency: 36 }],
    radii: [{ px: 6, frequency: 9 }],
    shadows: [{ css: 'rgba(0, 0, 0, 0.1) 0px 2px 4px', frequency: 3 }],
    screenshots: [{ label: 'viewport', path: 'somewhere/rich.png' }],
  };
}

/** A hand-built garbage extraction (known-garbage anchor: blank-page level). */
function garbageExtraction(): RawExtraction {
  return {
    url: 'https://blank.example',
    extractedAt: '2026-07-16T00:00:00.000Z',
    engine: { name: 'anchor', version: '0' },
    colors: [
      { hex: '#000000', frequency: 2, roles: [{ role: 'text', count: 2 }] },
      { hex: '#ffffff', frequency: 1, roles: [{ role: 'background', count: 1 }] },
    ],
    fonts: [],
    typeSizes: [],
    spacing: [{ px: 8, frequency: 2 }],
    radii: [],
    shadows: [],
    screenshots: [{ label: 'viewport', path: 'somewhere/blank.png' }],
  };
}

describe('coverage scoring — calibration anchors', () => {
  it('scores the known-good above the known-garbage on every axis that matters', () => {
    expect(meetsMinimumCoverage(richExtraction())).toBe(true);
    expect(meetsMinimumCoverage(garbageExtraction())).toBe(false);
    expect(isNearEmpty(richExtraction())).toBe(false);
    expect(isNearEmpty(garbageExtraction())).toBe(true);
  });

  it('minimum coverage set is the pre-registered five fields', () => {
    expect(MINIMUM_COVERAGE_FIELDS).toEqual([
      'colors',
      'colorRoleEvidence',
      'fonts',
      'typeSizes',
      'screenshots',
    ]);
  });
});

describe('coverageOf — field semantics', () => {
  it('colors requires positive frequency, not mere presence', () => {
    const x = richExtraction();
    x.colors = [{ hex: '#123456', frequency: 0, roles: [] }];
    expect(coverageOf(x).colors).toBe(false);
  });

  it('colorRoleEvidence is separate from colors: clusters without roles do not count', () => {
    const x = richExtraction();
    x.colors = [{ hex: '#123456', frequency: 10, roles: [] }];
    const cov = coverageOf(x);
    expect(cov.colors).toBe(true);
    expect(cov.colorRoleEvidence).toBe(false);
    expect(meetsMinimumCoverage(x)).toBe(false);
  });

  it('a zero-count role is not evidence', () => {
    const x = richExtraction();
    x.colors = [{ hex: '#123456', frequency: 10, roles: [{ role: 'text', count: 0 }] }];
    expect(coverageOf(x).colorRoleEvidence).toBe(false);
  });

  it('empty extraction scores false everywhere', () => {
    const empty: RawExtraction = {
      url: '',
      extractedAt: '',
      engine: { name: 'x', version: '0' },
      colors: [],
      fonts: [],
      typeSizes: [],
      spacing: [],
      radii: [],
      shadows: [],
      screenshots: [],
    };
    expect(Object.values(coverageOf(empty)).every((v) => v === false)).toBe(true);
    expect(substantiveObservationCount(empty)).toBe(0);
    expect(isNearEmpty(empty)).toBe(true);
  });
});

describe('near-empty semantics', () => {
  it('screenshots never count toward substance (a blank page still screenshots)', () => {
    const x = garbageExtraction();
    x.screenshots = [
      { label: 'light', path: 'a.png' },
      { label: 'dark', path: 'b.png' },
      { label: 'full', path: 'c.png' },
    ];
    expect(substantiveObservationCount(x)).toBe(3); // 2 colors + 1 spacing
    expect(isNearEmpty(x)).toBe(true);
  });

  it('threshold boundary: exactly NEAR_EMPTY_MAX is near-empty, one more is not', () => {
    const base = garbageExtraction();
    base.colors = [];
    base.spacing = [];
    base.typeSizes = Array.from({ length: NEAR_EMPTY_MAX }, (_, i) => ({
      px: 10 + i,
      frequency: 1,
    }));
    expect(isNearEmpty(base)).toBe(true);
    base.typeSizes.push({ px: 99, frequency: 1 });
    expect(isNearEmpty(base)).toBe(false);
  });
});
