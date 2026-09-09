/**
 * Font lookalike-table tests (plan.md §9.7, Step 10 deliverable "lookalike
 * table with license notes").
 *
 * Anchors: the plan's named mappings (Inter for Helvetica-likes,
 * Montserrat/Figtree for Gotham/Proxima-likes) resolve; the OFL license
 * invariant holds table-wide; unknown stacks are KEPT verbatim + flagged (no
 * invention); already-free families are kept as-is.
 */

import { describe, expect, it } from 'vitest';
import {
  LOOKALIKE_TABLE,
  OFL_LICENSE,
  fingerprint,
  mapFontStack,
  mapFonts,
} from '../src/extract/fonts.ts';
import type { FontStack } from '../src/extract/engine/adapter.ts';

function stack(families: string[], role: FontStack['role'] = 'body'): FontStack {
  return { families, role, frequency: 1 };
}

describe('lookalike table — license invariant + curated mappings', () => {
  it('every table entry carries the OFL license note (table-wide invariant)', () => {
    for (const entry of LOOKALIKE_TABLE) {
      expect(entry.license).toBe(OFL_LICENSE);
      expect(entry.license).toContain('OFL');
      expect(entry.match.length).toBeGreaterThan(0);
      expect(entry.note.length).toBeGreaterThan(0);
    }
  });

  it('Helvetica-likes map to Inter (plan §9.7)', () => {
    for (const family of ['Helvetica', 'Helvetica Neue', 'Arial', 'system-ui', 'SF Pro Display']) {
      const m = mapFontStack(stack([family]));
      expect(m.mapped).toBe(true);
      expect(m.mappedFamily).toBe('Inter');
      expect(m.license).toBe(OFL_LICENSE);
      expect(m.stack[0]).toBe('Inter');
    }
  });

  it('Gotham/Proxima-likes map to Montserrat or Figtree (plan §9.7)', () => {
    expect(mapFontStack(stack(['Gotham'])).mappedFamily).toBe('Montserrat');
    expect(mapFontStack(stack(['Proxima Nova'])).mappedFamily).toBe('Montserrat');
    expect(mapFontStack(stack(['Gilroy'])).mappedFamily).toBe('Figtree');
  });

  it('monospace stacks map to JetBrains Mono with a mono fallback tail', () => {
    const m = mapFontStack(stack(['SF Mono', 'Menlo'], 'mono'));
    expect(m.mappedFamily).toBe('JetBrains Mono');
    expect(m.stack).toContain('monospace');
  });

  it('already-free families are kept as-is (mapped to self, still OFL)', () => {
    const m = mapFontStack(stack(['Inter']));
    expect(m.mapped).toBe(true);
    expect(m.mappedFamily).toBe('Inter');
    expect(m.observedFamily).toBe('Inter');
    const manrope = mapFontStack(stack(['Manrope']));
    expect(manrope.mappedFamily).toBe('Manrope');
  });
});

describe('unknown stacks — kept verbatim, flagged unmapped (no invention)', () => {
  it('an unknown family keeps the observed name + adds fallbacks + flags unmapped', () => {
    const m = mapFontStack(stack(['ff-meta-web-pro']));
    expect(m.mapped).toBe(false);
    expect(m.mappedFamily).toBeUndefined();
    expect(m.observedFamily).toBe('ff-meta-web-pro');
    expect(m.stack[0]).toBe('ff-meta-web-pro'); // kept, not replaced
    expect(m.stack).toContain('sans-serif');
    expect(m.license).toBeUndefined();
    expect(m.note).toContain('unmapped');
  });
});

describe('hostile families entries — never a crash (review iteration 2)', () => {
  it('null/undefined entries in families are skipped, first real family wins', () => {
    const m = mapFontStack({
      families: [null, 'Arial'] as unknown as string[],
      role: 'body',
      frequency: 1,
    });
    expect(m.observedFamily).toBe('Arial');
    expect(m.mappedFamily).toBe('Inter');
  });

  it('an all-garbage families array degrades to the empty-stack mapping', () => {
    const m = mapFontStack({
      families: [null, undefined, 42] as unknown as string[],
      role: 'body',
      frequency: 1,
    });
    expect(m.mapped).toBe(false);
    expect(m.observedFamily).toBeUndefined();
    expect(m.stack).toContain('sans-serif');
  });

  it('mapFonts survives hostile entries end-to-end', () => {
    const mapped = mapFonts([
      { families: [undefined, 'Arial'] as unknown as string[], role: 'body', frequency: 1 },
      { families: [null] as unknown as string[], role: 'heading', frequency: 1 },
    ]);
    expect(mapped.sans.mappedFamily).toBe('Inter');
    expect(mapped.mono.mappedFamily).toBe('JetBrains Mono'); // default fill
  });
});

describe('fingerprint — normalization', () => {
  it('strips punctuation/space/case', () => {
    expect(fingerprint('SF Pro Display')).toBe('sfprodisplay');
    expect(fingerprint('"Helvetica Neue"')).toBe('helveticaneue');
    expect(fingerprint('ff-meta-web-pro')).toBe('ffmetawebpro');
  });
});

describe('mapFonts — role reduction', () => {
  it('picks highest-frequency stacks per role and always yields sans/heading/mono', () => {
    const fonts: FontStack[] = [
      { families: ['sohne-var', 'SF Pro Display'], role: 'heading', frequency: 10 },
      { families: ['sohne-var', 'SF Pro Display'], role: 'body', frequency: 13 },
      { families: ['SourceCodePro', 'SFMono-Regular'], role: 'unknown', frequency: 4 },
    ];
    const mapped = mapFonts(fonts);
    expect(mapped.sans.role).toBe('body');
    expect(mapped.heading.role).toBe('heading');
    expect(mapped.mono.role).toBe('mono');
    // SourceCodePro is a free mono kept as-is; mono tail present.
    expect(mapped.mono.stack).toContain('monospace');
  });

  it('falls back to default Inter/JetBrains Mono when a role is absent', () => {
    const mapped = mapFonts([]);
    expect(mapped.sans.mappedFamily).toBe('Inter');
    expect(mapped.mono.mappedFamily).toBe('JetBrains Mono');
    expect(mapped.sans.license).toBe(OFL_LICENSE);
  });
});
