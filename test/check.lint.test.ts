/**
 * Unit tests for the schema lint (src/check/lint.ts) — a brand-new production
 * module that shipped untested in iteration 1 (review finding T2). Covers both
 * checks: unknown top-level categories and missing dark-mode coverage for
 * SURFACE colors (semantic/status/chart/diagram — primitives deliberately
 * excluded as the palette source).
 */

import { describe, expect, it } from 'vitest';
import { KNOWN_TOP_CATEGORIES, lintSchema } from '../src/check/lint.ts';
import type { TokensDocument } from '../src/schema/types.ts';

/** Minimal valid-shaped document with one surface color, one primitive, and a typo'd category. */
function docWithTypo(): TokensDocument {
  return {
    $extensions: { onbrand: { schemaVersion: 1 } },
    color: {
      $type: 'color',
      semantic: {
        bg: { $value: '#ffffff' },
        text: { $value: '#111111' },
      },
      primitive: {
        brand: { '1': { $value: '#eeeeee' } },
      },
    },
    colour: {
      $type: 'color',
      oops: { $value: '#123456' },
    },
  } as unknown as TokensDocument;
}

describe('lintSchema — unknown top-level categories', () => {
  it('flags a typo\'d top-level category as a warning naming it', () => {
    const findings = lintSchema({
      lightDocument: docWithTypo(),
      hasModes: false,
      overriddenPaths: [],
    });
    const unknown = findings.filter((f) => f.message.includes('unknown top-level category'));
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.severity).toBe('warning');
    expect(unknown[0]!.path).toBe('colour');
    expect(unknown[0]!.message).toContain('"colour"');
  });

  it('does not flag any §4 category (and skips $-metadata keys)', () => {
    const doc = {
      $description: 'meta only',
      $extensions: { onbrand: { schemaVersion: 1 } },
      color: { $type: 'color', semantic: { bg: { $value: '#ffffff' } } },
      space: { $type: 'dimension', '1': { $value: '4px' } },
    } as unknown as TokensDocument;
    const findings = lintSchema({ lightDocument: doc, hasModes: false, overriddenPaths: [] });
    expect(findings).toEqual([]);
    // sanity: the categories used above really are in the known set
    expect(KNOWN_TOP_CATEGORIES).toContain('color');
    expect(KNOWN_TOP_CATEGORIES).toContain('space');
  });
});

describe('lintSchema — missing dark-mode coverage (surface colors)', () => {
  const doc = docWithTypo();

  it('reports nothing about coverage when no modes.dark.json exists', () => {
    const findings = lintSchema({ lightDocument: doc, hasModes: false, overriddenPaths: [] });
    expect(findings.filter((f) => f.message.includes('override'))).toEqual([]);
  });

  it('warns for a SURFACE color the overlay does not override, naming the dot path', () => {
    const findings = lintSchema({
      lightDocument: doc,
      hasModes: true,
      overriddenPaths: ['color.semantic.bg'], // text is NOT overridden
    });
    const coverage = findings.filter((f) => f.message.includes('no modes.dark.json override'));
    expect(coverage).toHaveLength(1);
    expect(coverage[0]!.severity).toBe('warning');
    expect(coverage[0]!.path).toBe('color.semantic.text');
  });

  it('never flags primitives (the palette source) or fully-covered surfaces', () => {
    const findings = lintSchema({
      lightDocument: doc,
      hasModes: true,
      overriddenPaths: ['color.semantic.bg', 'color.semantic.text'],
    });
    // primitive.brand.1 has no override but is not a surface color: no finding
    expect(findings.filter((f) => f.message.includes('override'))).toEqual([]);
  });
});
