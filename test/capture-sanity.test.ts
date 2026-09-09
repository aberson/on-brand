/**
 * Capture-sanity gate — Brand-Fidelity Step 2 hardening (data integrity).
 *
 * Calibrated with REAL fixtures as anchors (measurement-validity: "a bench that
 * can't fail garbage can't gate"):
 *   - louisvuitton (a WAF deny page) MUST flag `likely-not-a-page` — the garbage
 *     anchor. If this ever goes green, the gate is vacuous.
 *   - basecamp (a real site whose OKLCH palette the engine couldn't resolve) MUST
 *     read `thin-colors`, NOT `likely-not-a-page` — it is structurally real and is
 *     kept; only its colour read is flagged.
 *   - stripe (a rich real capture) MUST read `ok` — the known-good anchor.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ColorCluster, RawExtraction } from '../src/extract/engine/adapter.ts';
import {
  assessCapture,
  isRealPage,
  MIN_ROLED_COLORS,
  MIN_STRUCTURAL_AXES,
} from '../benchmark/capture-sanity.ts';

const BENCH_DIR = fileURLToPath(
  new URL('../docs/findings/eval-raw-extractions/benchmark/', import.meta.url),
);
function readFixture(id: string): RawExtraction {
  return JSON.parse(readFileSync(path.join(BENCH_DIR, `${id}.raw-extraction.json`), 'utf8')) as RawExtraction;
}

/**
 * The permanent deny-page GARBAGE ANCHOR — the real louisvuitton WAF "Access
 * denied" extraction (3 colours, 0 structural axes), preserved as a committed
 * TEST fixture rather than a corpus fixture. It was removed from the corpus (the
 * luxury slot was swapped to a capturable brand), but the anchor must outlive any
 * corpus swap: a gate calibrated on a real known-garbage input can actually gate.
 */
const DENY_ANCHOR = fileURLToPath(
  new URL('./fixtures/capture-sanity/deny-page.raw-extraction.json', import.meta.url),
);
function readDenyAnchor(): RawExtraction {
  return JSON.parse(readFileSync(DENY_ANCHOR, 'utf8')) as RawExtraction;
}

/** A structurally-rich synthetic base; tests override the axes they exercise. */
function makeRaw(over: Partial<RawExtraction> = {}): RawExtraction {
  const color = (hex: string, roled: boolean): ColorCluster => ({
    hex,
    frequency: 10,
    roles: roled ? [{ role: 'text', count: 5 }] : [],
  });
  return {
    url: 'https://example.test/',
    extractedAt: '2026-01-01T00:00:00.000Z',
    engine: { name: 'synthetic', version: '0' },
    colors: Array.from({ length: 8 }, (_, i) => color(`#${(i + 1).toString(16).repeat(6).slice(0, 6)}`, true)),
    fonts: [],
    typeSizes: Array.from({ length: 6 }, (_, i) => ({ px: 12 + i, frequency: 5 })),
    spacing: Array.from({ length: 6 }, (_, i) => ({ px: 4 * i, frequency: 5 })),
    radii: [{ px: 4, frequency: 5 }, { px: 8, frequency: 5 }],
    shadows: [{ css: '0 1px 2px #0002', frequency: 5 }],
    screenshots: [],
    ...over,
  };
}

describe('assessCapture — real-fixture anchors', () => {
  it('the real louisvuitton WAF deny page flags likely-not-a-page [garbage anchor]', () => {
    const a = assessCapture(readDenyAnchor());
    expect(a.verdict, `signals: ${a.signals.join(' | ')}`).toBe('likely-not-a-page');
    expect(a.structuralAxes).toBeLessThan(MIN_STRUCTURAL_AXES);
    expect(isRealPage(readDenyAnchor())).toBe(false);
  });

  it('basecamp (real site, OKLCH colour read collapsed) reads thin-colors, NOT not-a-page', () => {
    const a = assessCapture(readFixture('basecamp'));
    expect(a.verdict).toBe('thin-colors');
    expect(a.structuralAxes, 'basecamp is structurally a real page').toBe(4);
    expect(a.roledColors).toBeLessThan(MIN_ROLED_COLORS);
    expect(isRealPage(readFixture('basecamp')), 'a real site is kept, not rejected').toBe(true);
  });

  it('stripe (rich capture) reads ok [known-good anchor]', () => {
    const a = assessCapture(readFixture('stripe'));
    expect(a.verdict).toBe('ok');
    expect(a.signals).toEqual([]);
  });
});

describe('assessCapture — synthetic boundaries', () => {
  it('a near-empty extraction (deny/blank shape) is likely-not-a-page', () => {
    const raw = makeRaw({ typeSizes: [], spacing: [], radii: [], shadows: [], colors: [] });
    // one lone colour so RawExtraction is still well-formed
    raw.colors = [{ hex: '#000000', frequency: 1, roles: [] }];
    expect(assessCapture(raw).verdict).toBe('likely-not-a-page');
  });

  it('structurally real but few role-bearing colours is thin-colors', () => {
    const raw = makeRaw({
      colors: [
        { hex: '#111111', frequency: 9, roles: [{ role: 'text', count: 4 }] },
        { hex: '#222222', frequency: 8, roles: [] },
        { hex: '#333333', frequency: 7, roles: [] },
      ],
    });
    const a = assessCapture(raw);
    expect(a.verdict).toBe('thin-colors');
    expect(a.roledColors).toBe(1);
  });

  it('a rich synthetic page is ok', () => {
    expect(assessCapture(makeRaw()).verdict).toBe('ok');
  });

  it('likely-not-a-page takes precedence over thin-colors (a deny page is both)', () => {
    // near-empty AND colour-thin → the structural poverty is the load-bearing tell
    const raw = makeRaw({ typeSizes: [], spacing: [], radii: [], shadows: [], colors: [{ hex: '#000000', frequency: 1, roles: [] }] });
    expect(assessCapture(raw).verdict).toBe('likely-not-a-page');
  });
});
