/**
 * Unit tests for the tokens.css emitter: var naming, per-type value
 * conversion, and block structure (dark blocks only when overrides exist,
 * :root -> @media -> [data-theme="dark"] order inside @layer tokens).
 */

import { describe, expect, it } from 'vitest';
import {
  assertUniqueVarNames,
  cssDeclarationValue,
  emitTokensCss,
  tokenPathToCssVar,
  tokenValueToCss,
} from '../src/build/emitters/css.ts';
import type { EmitterContext, FlatToken } from '../src/build/compile.ts';
import type { TokensDocument } from '../src/schema/types.ts';

function flat(path: string[], type: FlatToken['type'], value: FlatToken['value']): FlatToken {
  return { path, dotPath: path.join('.'), type, value };
}

function ctx(light: FlatToken[], darkOverrides: FlatToken[] = []): EmitterContext {
  return { light, darkOverrides, lightDocument: {} as TokensDocument };
}

describe('tokenPathToCssVar', () => {
  it('joins dot-path segments with hyphens', () => {
    expect(tokenPathToCssVar(['color', 'semantic', 'bg'])).toBe('--color-semantic-bg');
  });

  it('keeps hyphens inside names (step--1 stays step--1)', () => {
    expect(tokenPathToCssVar(['type', 'scale', 'step--1'])).toBe('--type-scale-step--1');
    expect(tokenPathToCssVar(['color', 'semantic', 'text-muted'])).toBe(
      '--color-semantic-text-muted',
    );
  });

  it('normalizes CSS-ident-hostile characters (schema-legal spaces) to hyphens', () => {
    expect(tokenPathToCssVar(['color', 'my brand'])).toBe('--color-my-brand');
  });
});

describe('assertUniqueVarNames (the non-injective-mapping gate)', () => {
  it('throws a path-precise error naming BOTH tokens when dot paths collide on one var', () => {
    const colliding = [
      flat(['color', 'semantic', 'text-muted'], 'color', '#566070'),
      flat(['color', 'semantic', 'text', 'muted'], 'color', '#123456'),
    ];
    expect(() => assertUniqueVarNames(colliding)).toThrowError(
      /color\.semantic\.text\.muted.*collides with token "color\.semantic\.text-muted"/s,
    );
  });

  it('emitTokensCss refuses to emit colliding tokens (never silent last-wins)', () => {
    const colliding = [
      flat(['color', 'semantic', 'code-bg'], 'color', '#f0f1f4'),
      flat(['color', 'semantic', 'code', 'bg'], 'color', '#ffffff'),
    ];
    expect(() => emitTokensCss(ctx(colliding))).toThrowError(/--color-semantic-code-bg/);
  });

  it('accepts the same dot path twice (dark overrides re-visit their base token)', () => {
    const bg = flat(['color', 'semantic', 'bg'], 'color', '#fcfcfd');
    const bgDark = flat(['color', 'semantic', 'bg'], 'color', '#14181f');
    expect(() => assertUniqueVarNames([bg, bgDark])).not.toThrow();
  });

  it('catches sanitization-induced collisions too (space vs hyphen)', () => {
    const colliding = [
      flat(['color', 'my brand'], 'color', '#111111'),
      flat(['color', 'my-brand'], 'color', '#222222'),
    ];
    expect(() => assertUniqueVarNames(colliding)).toThrowError(/--color-my-brand/);
  });
});

describe('tokenValueToCss', () => {
  it('passes color strings through as authored (hex and oklch)', () => {
    expect(tokenValueToCss('color', '#3b63a8')).toBe('#3b63a8');
    expect(tokenValueToCss('color', 'oklch(0.55 0.11 260)')).toBe('oklch(0.55 0.11 260)');
  });

  it('passes dimension and duration strings through', () => {
    expect(tokenValueToCss('dimension', 'clamp(1rem, 0.9rem + 0.2vw, 1.125rem)')).toBe(
      'clamp(1rem, 0.9rem + 0.2vw, 1.125rem)',
    );
    expect(tokenValueToCss('duration', '150ms')).toBe('150ms');
  });

  it('prints numbers bare (fontWeight, number)', () => {
    expect(tokenValueToCss('fontWeight', 600)).toBe('600');
    expect(tokenValueToCss('number', 1.55)).toBe('1.55');
  });

  it('joins fontFamily arrays, quoting only names that need it', () => {
    expect(tokenValueToCss('fontFamily', ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'])).toBe(
      'Inter, "Segoe UI", system-ui, sans-serif',
    );
  });

  it('quotes a single fontFamily string containing a space', () => {
    expect(tokenValueToCss('fontFamily', 'JetBrains Mono')).toBe('"JetBrains Mono"');
    expect(tokenValueToCss('fontFamily', 'monospace')).toBe('monospace');
  });

  it('renders cubicBezier arrays as cubic-bezier() and keywords bare', () => {
    expect(tokenValueToCss('cubicBezier', [0.4, 0, 0.2, 1])).toBe('cubic-bezier(0.4, 0, 0.2, 1)');
    expect(tokenValueToCss('cubicBezier', 'ease-in-out')).toBe('ease-in-out');
  });

  it('renders shadows in box-shadow order, arrays comma-joined', () => {
    const single = { color: '#0000001f', offsetX: '0px', offsetY: '2px', blur: '8px', spread: '-1px' };
    expect(tokenValueToCss('shadow', single)).toBe('0px 2px 8px -1px #0000001f');
    expect(
      tokenValueToCss('shadow', [
        single,
        { color: '#00000014', offsetX: '0px', offsetY: '1px', blur: '2px', spread: '0px' },
      ]),
    ).toBe('0px 2px 8px -1px #0000001f, 0px 1px 2px 0px #00000014');
  });
});

describe('cssDeclarationValue (the shared declaration-breakout guard)', () => {
  // Both css and tw emission paths render through this ONE site. Schema
  // validation does not close the hole (any "fn(...)" string ending in ")"
  // passes colorSchema/dimensionSchema; fontFamily takes any string).

  it.each([
    ['";" declaration terminator', 'rgb(0,0,0); } html { --pwn: url(x)'],
    ['"}" block escape', 'rgb(} body)'],
    ['comment open', 'rgb(/* comment)'],
    ['comment close', 'rgb(*/ escape)'],
  ] as const)('rejects a schema-shaped color value carrying %s, path-precisely', (_label, value) => {
    const token = flat(['color', 'semantic', 'bg'], 'color', value);
    expect(() => cssDeclarationValue(token)).toThrowError(/color\.semantic\.bg/);
    expect(() => cssDeclarationValue(token)).toThrowError(/forbidden/);
  });

  it('rejects control characters anywhere in the rendered value (newline shown by code)', () => {
    const token = flat(['font', 'sans'], 'fontFamily', 'Inter\nBold');
    expect(() => cssDeclarationValue(token)).toThrowError(/control character \(code 10\)/);
  });

  it('rejects hostile text hidden inside a composite value (shadow color field)', () => {
    const token = flat(['shadow', 'elevation-1'], 'shadow', {
      color: 'rgb(0,0,0); } *{}',
      offsetX: '0px',
      offsetY: '1px',
      blur: '2px',
      spread: '0px',
    });
    expect(() => cssDeclarationValue(token)).toThrowError(/shadow\.elevation-1/);
  });

  it('passes every legitimate token value class untouched (the other direction)', () => {
    expect(cssDeclarationValue(flat(['c'], 'color', '#3b63a8'))).toBe('#3b63a8');
    expect(cssDeclarationValue(flat(['c'], 'color', 'oklch(0.55 0.11 260)'))).toBe(
      'oklch(0.55 0.11 260)',
    );
    expect(
      cssDeclarationValue(flat(['d'], 'dimension', 'clamp(1rem, 0.9rem + 0.2vw, 1.125rem)')),
    ).toBe('clamp(1rem, 0.9rem + 0.2vw, 1.125rem)');
    expect(
      cssDeclarationValue(flat(['f'], 'fontFamily', ['Inter', 'Segoe UI', 'sans-serif'])),
    ).toBe('Inter, "Segoe UI", sans-serif'); // commas + quotes stay legal
    expect(cssDeclarationValue(flat(['e'], 'cubicBezier', [0.4, 0, 0.2, 1]))).toBe(
      'cubic-bezier(0.4, 0, 0.2, 1)',
    );
    expect(
      cssDeclarationValue(
        flat(['s'], 'shadow', {
          color: '#0000001f',
          offsetX: '0px',
          offsetY: '2px',
          blur: '8px',
          spread: '-1px',
        }),
      ),
    ).toBe('0px 2px 8px -1px #0000001f');
  });
});

describe('emitTokensCss', () => {
  const light = [
    flat(['color', 'semantic', 'bg'], 'color', '#fcfcfd'),
    flat(['space', '1'], 'dimension', '0.25rem'),
  ];
  const dark = [flat(['color', 'semantic', 'bg'], 'color', '#14181f')];

  it('wraps everything in @layer tokens and starts with the DO-NOT-EDIT header', () => {
    const [file] = emitTokensCss(ctx(light, dark));
    expect(file!.relPath).toBe('tokens.css');
    expect(file!.content.startsWith('/* GENERATED by on-brand - DO NOT EDIT.')).toBe(true);
    expect(file!.content).toContain('@layer tokens {');
    expect(file!.content.endsWith('}\n')).toBe(true);
    expect(file!.content).not.toContain('\r');
  });

  it('orders blocks :root, then @media dark, then [data-theme="dark"]', () => {
    const [file] = emitTokensCss(ctx(light, dark));
    const rootAt = file!.content.indexOf(':root {');
    const mediaAt = file!.content.indexOf('@media (prefers-color-scheme: dark)');
    const themeAt = file!.content.indexOf('[data-theme="dark"]');
    expect(rootAt).toBeGreaterThan(-1);
    expect(mediaAt).toBeGreaterThan(rootAt);
    expect(themeAt).toBeGreaterThan(mediaAt);
  });

  it('omits both dark blocks when there are no overrides', () => {
    const [file] = emitTokensCss(ctx(light, []));
    expect(file!.content).toContain(':root {');
    expect(file!.content).not.toContain('@media');
    expect(file!.content).not.toContain('data-theme');
  });

  it('emits dark values in BOTH dark blocks; light value in :root AND the [data-theme="light"] reassert', () => {
    const [file] = emitTokensCss(ctx(light, dark));
    // dark value: @media :root + [data-theme="dark"]
    expect(file!.content.match(/--color-semantic-bg: #14181f;/g)).toHaveLength(2);
    // light value: :root base + [data-theme="light"] reassert (M1 toggle fix)
    expect(file!.content.match(/--color-semantic-bg: #fcfcfd;/g)).toHaveLength(2);
  });

  it('emits a [data-theme="light"] block reasserting the light value for exactly the dark-overridden tokens', () => {
    const [file] = emitTokensCss(ctx(light, dark));
    const darkAt = file!.content.indexOf('[data-theme="dark"]');
    const lightAt = file!.content.indexOf('[data-theme="light"]');
    // the light reassert block exists and sits AFTER the dark blocks, so an
    // explicit data-theme="light" wins over an OS-dark @media match (source order)
    expect(darkAt).toBeGreaterThan(-1);
    expect(lightAt).toBeGreaterThan(darkAt);
    const lightBlock = file!.content.slice(lightAt);
    // it reasserts the LIGHT value for the dark-overridden token...
    expect(lightBlock).toContain('--color-semantic-bg: #fcfcfd;');
    // ...and ONLY the dark-overridden tokens (space.1 is never dark-overridden)
    expect(lightBlock).not.toContain('--space-1');
  });
});
