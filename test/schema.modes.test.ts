import { describe, expect, it } from 'vitest';
import { applyModeOverlay } from '../src/schema/modes.ts';
import { assertValid, validate } from '../src/schema/validate.ts';
import type { TokensDocument } from '../src/schema/types.ts';

function baseDoc(): TokensDocument {
  return assertValid({
    $extensions: { onbrand: { schemaVersion: 1 } },
    color: {
      $type: 'color',
      semantic: {
        bg: { $value: '#ffffff' },
        text: { $value: '#1f242c' },
      },
    },
    radius: { $type: 'dimension', sm: { $value: '4px' } },
  });
}

describe('applyModeOverlay', () => {
  it('applies color overrides and reports the overridden paths', () => {
    const result = applyModeOverlay(baseDoc(), {
      color: { semantic: { bg: { $value: '#14181f' } } },
    });
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.overriddenPaths).toEqual(['color.semantic.bg']);
    expect(result.document).toMatchObject({
      color: {
        semantic: {
          bg: { $value: '#14181f' }, // overridden
          text: { $value: '#1f242c' }, // untouched
        },
      },
    });
  });

  it('does not mutate the base document', () => {
    const base = baseDoc();
    const snapshot = JSON.stringify(base);
    applyModeOverlay(base, { color: { semantic: { bg: { $value: '#14181f' } } } });
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it('flags an overlay token that does not exist in base, path-precisely', () => {
    const result = applyModeOverlay(baseDoc(), {
      color: { semantic: { ghost: { $value: '#123456' } } },
    });
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.path === 'color.semantic.ghost');
    expect(issue?.message).toMatch(/does not exist in the base/);
  });

  it('flags an overlay override of a non-color token', () => {
    const result = applyModeOverlay(baseDoc(), {
      radius: { sm: { $value: '#123456' } },
    });
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.path === 'radius.sm');
    expect(issue?.message).toMatch(/only override color tokens/);
    // and the base value must NOT have been changed
    expect(result.document).toMatchObject({ radius: { sm: { $value: '4px' } } });
  });

  it('flags an overlay path that is a group in base', () => {
    const result = applyModeOverlay(baseDoc(), {
      color: { semantic: { $value: '#123456' } },
    });
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.path === 'color.semantic');
    expect(issue?.message).toMatch(/group in the base/);
  });

  it('surfaces structural overlay issues (invalid color value) AND does not apply the bad leaf', () => {
    const result = applyModeOverlay(baseDoc(), {
      color: {
        semantic: {
          bg: { $value: 'not-a-color' },
          text: { $value: '#edeff3' },
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path === 'color.semantic.bg.$value')).toBe(true);
    // the structurally-invalid leaf is skipped: not in the document, not reported as overridden
    expect(result.overriddenPaths).toEqual(['color.semantic.text']);
    expect(result.document).toMatchObject({
      color: {
        semantic: {
          bg: { $value: '#ffffff' }, // base value kept
          text: { $value: '#edeff3' }, // valid sibling still applied
        },
      },
    });
  });

  it('rejects and never applies an unsafe "__proto__" overlay key (prototype unchanged)', () => {
    // Must go through JSON.parse: a TS object literal with "__proto__" sets the
    // prototype at creation instead of making an own property.
    const overlay: unknown = JSON.parse(
      '{"color":{"semantic":{"__proto__":{"$value":"#123456"},"bg":{"$value":"#14181f"}}}}',
    );
    const result = applyModeOverlay(baseDoc(), overlay);
    expect(result.ok).toBe(false);
    expect(
      result.issues.some(
        (i) => i.path === 'color.semantic.__proto__' && /unsafe/.test(i.message),
      ),
    ).toBe(true);
    // valid sibling applied; unsafe key neither applied nor polluting
    expect(result.overriddenPaths).toEqual(['color.semantic.bg']);
    expect(Object.getPrototypeOf(result.document)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['$value']).toBeUndefined();
  });

  it('applies valid overrides even when other overlay entries fail', () => {
    const result = applyModeOverlay(baseDoc(), {
      color: {
        semantic: {
          bg: { $value: '#14181f' },
          ghost: { $value: '#123456' },
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.overriddenPaths).toEqual(['color.semantic.bg']);
    expect(result.document).toMatchObject({
      color: { semantic: { bg: { $value: '#14181f' } } },
    });
  });

  it('merged output still passes validate()', () => {
    const result = applyModeOverlay(baseDoc(), {
      color: { semantic: { bg: { $value: '#14181f' }, text: { $value: '#edeff3' } } },
    });
    expect(result.ok).toBe(true);
    expect(validate(result.document).ok).toBe(true);
  });
});
