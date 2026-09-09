/**
 * Issue #20: fontFamilyName must CSS-string-escape backslash and double-quote.
 *
 * The gap it closes: a fontFamily $value ending in a backslash used to render
 * `"Foo\"` — an UNTERMINATED CSS string that makes the WHOLE emitted file
 * unparseable (postcss reports it) while `onbrand build` still exits 0. This is
 * load-bearing now that from-url (Steps 11-12) feeds site-derived font stacks
 * into tokens.
 *
 * Both directions (measurement-validity: an instrument that can't fail garbage
 * can't gate):
 *   - HOSTILE value round-trips SAFELY — the escaped output is a terminated CSS
 *     string and the whole tokens.css parses cleanly through postcss.
 *   - LEGIT quoted stacks are byte-IDENTICAL to before (escaping is a no-op when
 *     the name has neither a backslash nor a quote), so golden output is stable.
 */

import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { cssDeclarationValue, emitTokensCss, tokenValueToCss } from '../src/build/emitters/css.ts';
import type { EmitterContext, FlatToken } from '../src/build/compile.ts';
import type { TokensDocument } from '../src/schema/types.ts';

function flat(path: string[], type: FlatToken['type'], value: FlatToken['value']): FlatToken {
  return { path, dotPath: path.join('.'), type, value };
}

function ctx(light: FlatToken[]): EmitterContext {
  return { light, darkOverrides: [], lightDocument: {} as TokensDocument };
}

describe('#20 fontFamily CSS-string escaping', () => {
  it('escapes a name ending in a backslash into a terminated string', () => {
    // 'Foo\\' in JS is the 4-char name Foo + one backslash.
    expect(tokenValueToCss('fontFamily', 'Foo\\')).toBe('"Foo\\\\"');
    // The same inside a stack, alongside a legit quoted member.
    expect(tokenValueToCss('fontFamily', ['Foo\\', 'Segoe UI', 'sans-serif'])).toBe(
      '"Foo\\\\", "Segoe UI", sans-serif',
    );
  });

  it('escapes an embedded double-quote', () => {
    expect(tokenValueToCss('fontFamily', 'Fo"o')).toBe('"Fo\\"o"');
  });

  it('cssDeclarationValue accepts the escaped hostile value (no forbidden sequence)', () => {
    const token = flat(['font', 'sans'], 'fontFamily', ['Evil\\', 'sans-serif']);
    expect(() => cssDeclarationValue(token)).not.toThrow();
    expect(cssDeclarationValue(token)).toBe('"Evil\\\\", sans-serif');
  });

  it('the WHOLE emitted tokens.css parses through postcss with a hostile font value', () => {
    const light = [
      flat(['color', 'semantic', 'bg'], 'color', '#ffffff'),
      // A site-derived stack whose first family ends in a backslash — the exact
      // #20 corruption vector. Post-fix it emits a terminated string.
      flat(['font', 'sans'], 'fontFamily', ['Corrupt\\', 'Inter', 'sans-serif']),
    ];
    const [file] = emitTokensCss(ctx(light));
    expect(file!.content).toContain('--font-sans: "Corrupt\\\\", Inter, sans-serif;');
    // The load-bearing assertion: postcss parses the file without throwing.
    expect(() => postcss.parse(file!.content)).not.toThrow();
  });

  it('legit quoted stacks stay byte-identical (escaping is a no-op)', () => {
    expect(tokenValueToCss('fontFamily', ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'])).toBe(
      'Inter, "Segoe UI", system-ui, sans-serif',
    );
    expect(
      tokenValueToCss('fontFamily', ['JetBrains Mono', 'Cascadia Code', 'Consolas', 'monospace']),
    ).toBe('"JetBrains Mono", "Cascadia Code", Consolas, monospace');
    expect(tokenValueToCss('fontFamily', 'monospace')).toBe('monospace');
  });
});
