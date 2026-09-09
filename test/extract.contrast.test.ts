/**
 * Extraction-side contrast auto-fix suggestion tests (plan.md §9.8, Step 10).
 *
 * The suggester reuses the check gate's evaluateContrast (one source of truth
 * for WCAG); these tests verify it (a) emits a suggestion for a FAILING
 * extracted pair whose replacement actually passes 4.5:1, (b) emits NO row for
 * a passing pair (nothing to fix), and (c) reports a note when no supplied ramp
 * step can pass.
 */

import { describe, expect, it } from 'vitest';
import { evaluateContrast } from '../src/check/contrast.ts';
import {
  nearestPassingStep,
  suggestContrastFixes,
  type NamedRamp,
} from '../src/extract/contrast.ts';
import { buildBrandRamp, buildNeutralRamp } from '../src/extract/ramps.ts';
import type { RawExtraction } from '../src/extract/engine/adapter.ts';

function extraction(colors: RawExtraction['colors']): RawExtraction {
  return {
    url: 'https://x.example',
    extractedAt: '2026-07-16T00:00:00.000Z',
    engine: { name: 'anchor', version: '0' },
    colors,
    fonts: [],
    typeSizes: [],
    spacing: [],
    radii: [],
    shadows: [],
    screenshots: [],
  };
}

const RAMPS: NamedRamp[] = [
  { label: 'brand', steps: buildBrandRamp('#3b63a8', 'light').steps },
  { label: 'neutral', steps: buildNeutralRamp('#3b63a8', 'light').steps },
];

describe('suggestContrastFixes — failing pairs get a passing suggestion', () => {
  it('a low-contrast grey text pair fails and gets a nearest passing ramp step', () => {
    const ex = extraction([
      { hex: '#999999', frequency: 10, roles: [{ role: 'text', count: 10 }] },
      { hex: '#dddddd', frequency: 5, roles: [{ role: 'background', count: 5 }] },
    ]);
    const suggestions = suggestContrastFixes(ex, RAMPS);
    expect(suggestions).toHaveLength(1);
    const s = suggestions[0]!;
    expect(s.passes).toBe(false);
    expect(s.suggestion).toBeDefined();
    // the suggested replacement genuinely passes WCAG AA on the same bg
    const recheck = evaluateContrast(s.suggestion!.hex, s.bgHex);
    expect(recheck.wcagPass).toBe(true);
    expect(['brand', 'neutral']).toContain(s.suggestion!.ramp);
    expect(s.suggestion!.step).toBeGreaterThanOrEqual(1);
    expect(s.suggestion!.step).toBeLessThanOrEqual(12);
  });
});

describe('suggestContrastFixes — passing pairs are omitted', () => {
  it('black text on white background yields no suggestion row (nothing to fix)', () => {
    const ex = extraction([
      { hex: '#000000', frequency: 10, roles: [{ role: 'text', count: 10 }] },
      { hex: '#ffffff', frequency: 5, roles: [{ role: 'background', count: 5 }] },
    ]);
    expect(suggestContrastFixes(ex, RAMPS)).toEqual([]);
  });
});

describe('suggestContrastFixes — no passing step available', () => {
  it('reports a note when no supplied ramp step can reach 4.5:1', () => {
    const ex = extraction([
      { hex: '#7c7c7c', frequency: 10, roles: [{ role: 'text', count: 10 }] },
      { hex: '#8a8a8a', frequency: 5, roles: [{ role: 'background', count: 5 }] },
    ]);
    // A ramp of only mid-greys can never pass against a mid-grey background.
    const midOnly: NamedRamp[] = [{ label: 'mid', steps: Array(12).fill('#909090') }];
    const suggestions = suggestContrastFixes(ex, midOnly);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.suggestion).toBeUndefined();
    expect(suggestions[0]!.note).toContain('4.5:1');
  });
});

describe('nearestPassingStep — picks a step that passes and is nearest by lightness', () => {
  it('returns a step whose contrast passes on the bg', () => {
    const fix = nearestPassingStep('#999999', '#dddddd', RAMPS);
    expect(fix).toBeDefined();
    expect(evaluateContrast(fix!.hex, '#dddddd').wcagPass).toBe(true);
  });

  it('returns undefined when no ramp step passes', () => {
    const midOnly: NamedRamp[] = [{ label: 'mid', steps: Array(12).fill('#909090') }];
    expect(nearestPassingStep('#7c7c7c', '#8a8a8a', midOnly)).toBeUndefined();
  });
});

describe('malformed colors never throw (review iteration 2)', () => {
  it('nearestPassingStep returns undefined for an unparseable foreground', () => {
    expect(nearestPassingStep('not-a-color', '#ffffff', RAMPS)).toBeUndefined();
  });

  it('nearestPassingStep skips unparseable ramp steps instead of throwing', () => {
    const dirty: NamedRamp[] = [{ label: 'dirty', steps: ['garbage', '#1a2b4d'] }];
    const fix = nearestPassingStep('#999999', '#ffffff', dirty);
    expect(fix).toBeDefined();
    expect(fix!.hex).toBe('#1a2b4d');
  });

  it('suggestContrastFixes reports a parseError row for an unparseable extracted pair', () => {
    const ex = extraction([
      { hex: 'not-a-color', frequency: 10, roles: [{ role: 'text', count: 10 }] },
      { hex: '#ffffff', frequency: 5, roles: [{ role: 'background', count: 5 }] },
    ]);
    const suggestions = suggestContrastFixes(ex, RAMPS);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.parseError).toBeDefined();
    expect(suggestions[0]!.suggestion).toBeUndefined();
  });
});
