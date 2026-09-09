import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../src/schema/types.ts';
import { TokenValidationError, assertValid, validate } from '../src/schema/validate.ts';

const INVALID_FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/invalid-tokens.json', import.meta.url),
);

function minimalDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $extensions: { onbrand: { schemaVersion: SCHEMA_VERSION } },
    color: {
      $type: 'color',
      semantic: {
        bg: { $value: '#ffffff' },
      },
    },
    ...overrides,
  };
}

describe('validate() — structure and root extensions', () => {
  it('accepts a minimal valid document', () => {
    const result = validate(minimalDoc());
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.document).toBeDefined();
  });

  it('rejects a non-object document', () => {
    const result = validate([1, 2, 3]);
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toMatch(/JSON object/);
  });

  it('requires $extensions.onbrand.schemaVersion for tokens documents', () => {
    const doc = minimalDoc();
    delete doc['$extensions'];
    const result = validate(doc);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path === '$extensions.onbrand')).toBe(true);
  });

  it('rejects an unsupported schemaVersion with a path-precise issue', () => {
    const result = validate(minimalDoc({ $extensions: { onbrand: { schemaVersion: 99 } } }));
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.path === '$extensions.onbrand.schemaVersion');
    expect(issue?.message).toMatch(/unsupported schemaVersion 99/);
  });

  it('rejects a non-integer schemaVersion', () => {
    const result = validate(minimalDoc({ $extensions: { onbrand: { schemaVersion: 1.5 } } }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path === '$extensions.onbrand.schemaVersion')).toBe(true);
  });

  it('accepts an extends spec on tokens documents', () => {
    const result = validate(
      minimalDoc({ $extensions: { onbrand: { schemaVersion: 1, extends: 'default' } } }),
    );
    expect(result.issues).toEqual([]);
  });

  it('rejects unsafe object-model names ("__proto__", "constructor", "prototype") path-precisely', () => {
    // JSON.parse to get OWN properties (an object literal with "__proto__"
    // would set the prototype instead).
    const doc: unknown = JSON.parse(
      `{
        "$extensions": {"onbrand": {"schemaVersion": 1}},
        "color": {"$type": "color", "__proto__": {"$value": "#123456"}},
        "constructor": {"$type": "color", "x": {"$value": "#123456"}},
        "type": {"$type": "number", "prototype": {"$value": 1}}
      }`,
    );
    const result = validate(doc);
    expect(result.ok).toBe(false);
    for (const p of ['color.__proto__', 'constructor', 'type.prototype']) {
      const issue = result.issues.find((i) => i.path === p);
      expect(issue?.message, p).toMatch(/unsafe token\/group name/);
    }
  });

  it('rejects token/group names containing dots or braces', () => {
    const result = validate(
      minimalDoc({
        color: { $type: 'color', 'bad.name': { $value: '#fff' } },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes('invalid token/group name'))).toBe(true);
  });

  it('rejects unknown $-properties on groups and tokens', () => {
    const result = validate(
      minimalDoc({
        color: {
          $type: 'color',
          $weird: true,
          semantic: { bg: { $value: '#ffffff', $unknown: 1 } },
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path === 'color.$weird')).toBe(true);
    expect(result.issues.some((i) => i.path === 'color.semantic.bg.$unknown')).toBe(true);
  });

  it('rejects nested children inside a token', () => {
    const result = validate(
      minimalDoc({
        color: {
          $type: 'color',
          semantic: { bg: { $value: '#ffffff', nested: { $value: '#000000' } } },
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path === 'color.semantic.bg.nested')).toBe(true);
  });
});

describe('validate() — $type resolution and values', () => {
  it('rejects the committed invalid fixture with a path-precise error at color.semantic.bg.$value', () => {
    const doc: unknown = JSON.parse(readFileSync(INVALID_FIXTURE_PATH, 'utf8'));
    const result = validate(doc);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.path === 'color.semantic.bg.$value');
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/color/);
    // the valid sibling token must NOT be flagged
    expect(result.issues.some((i) => i.path.startsWith('color.semantic.text'))).toBe(false);
  });

  it('assertValid throws a TokenValidationError whose message carries the dot path', () => {
    const doc: unknown = JSON.parse(readFileSync(INVALID_FIXTURE_PATH, 'utf8'));
    expect(() => assertValid(doc)).toThrowError(TokenValidationError);
    try {
      assertValid(doc);
    } catch (err) {
      expect((err as Error).message).toContain('color.semantic.bg.$value');
    }
  });

  it('inherits $type from the nearest ancestor group', () => {
    const result = validate(
      minimalDoc({
        color: { $type: 'color', deep: { nested: { thing: { $value: '#123456' } } } },
      }),
    );
    expect(result.issues).toEqual([]);
  });

  it('lets a token $type override the inherited group $type', () => {
    const result = validate(
      minimalDoc({
        color: {
          $type: 'color',
          special: { $type: 'number', opacity: { $value: 0.5 } },
        },
      }),
    );
    expect(result.issues).toEqual([]);
  });

  it('flags a token with no resolvable $type', () => {
    const result = validate(minimalDoc({ orphan: { $value: '#fff' } }));
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.path === 'orphan');
    expect(issue?.message).toMatch(/no \$type/);
  });

  it('allows a type-less leaf in fragment documents (sparse extends override)', () => {
    const result = validate(minimalDoc({ orphan: { $value: '#fff' } }), { kind: 'fragment' });
    expect(result.issues).toEqual([]);
  });

  it('rejects an unknown $type with a path-precise issue', () => {
    const result = validate(
      minimalDoc({ thing: { $type: 'gradient', x: { $value: 'nope' } } }),
    );
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.path === 'thing.$type');
    expect(issue?.message).toMatch(/unknown \$type "gradient"/);
  });

  it('accepts hex3/hex4/hex6/hex8 and CSS color functions; rejects garbage colors', () => {
    const mk = (v: unknown) =>
      validate(minimalDoc({ color: { $type: 'color', x: { $value: v } } }));
    expect(mk('#fff').issues).toEqual([]);
    expect(mk('#fffa').issues).toEqual([]);
    expect(mk('#1f242c').issues).toEqual([]);
    expect(mk('#1f242c29').issues).toEqual([]);
    expect(mk('oklch(0.7 0.1 250)').issues).toEqual([]);
    expect(mk('not-a-color').ok).toBe(false);
    expect(mk('#12345').ok).toBe(false);
  });

  it('validates dimensions: lengths and clamp()/calc() expressions', () => {
    const mk = (v: unknown) =>
      validate(minimalDoc({ space: { $type: 'dimension', x: { $value: v } } }));
    expect(mk('4px').issues).toEqual([]);
    expect(mk('0.25rem').issues).toEqual([]);
    expect(mk('-1px').issues).toEqual([]);
    expect(mk('clamp(1rem, 0.9489rem + 0.2273vw, 1.125rem)').issues).toEqual([]);
    expect(mk('4').ok).toBe(false);
    expect(mk(4).ok).toBe(false);
  });

  it('validates fontFamily as string or non-empty string array', () => {
    const mk = (v: unknown) =>
      validate(minimalDoc({ font: { $type: 'fontFamily', x: { $value: v } } }));
    expect(mk('Inter').issues).toEqual([]);
    expect(mk(['Inter', 'sans-serif']).issues).toEqual([]);
    expect(mk([]).ok).toBe(false);
    expect(mk(42).ok).toBe(false);
  });

  it('validates duration, cubicBezier and shadow values', () => {
    const dur = (v: unknown) =>
      validate(minimalDoc({ motion: { $type: 'duration', x: { $value: v } } }));
    expect(dur('150ms').issues).toEqual([]);
    expect(dur('0.3s').issues).toEqual([]);
    expect(dur('fast').ok).toBe(false);

    const cb = (v: unknown) =>
      validate(minimalDoc({ motion: { $type: 'cubicBezier', x: { $value: v } } }));
    expect(cb([0.4, 0, 0.2, 1]).issues).toEqual([]);
    expect(cb('ease-in-out').issues).toEqual([]);
    expect(cb([0.4, 0]).ok).toBe(false);

    const sh = (v: unknown) =>
      validate(minimalDoc({ shadow: { $type: 'shadow', x: { $value: v } } }));
    expect(
      sh({ color: '#00000029', offsetX: '0px', offsetY: '2px', blur: '8px', spread: '-1px' })
        .issues,
    ).toEqual([]);
    expect(sh({ color: '#000' }).ok).toBe(false);
  });

  it('reports shadow sub-field problems with the sub-path appended', () => {
    const result = validate(
      minimalDoc({
        shadow: {
          $type: 'shadow',
          'elevation-1': {
            $value: { color: 'nope', offsetX: '0px', offsetY: '1px', blur: '2px', spread: '0px' },
          },
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path === 'shadow.elevation-1.$value.color')).toBe(true);
  });
});

describe('validate() — overlay kind', () => {
  it('accepts a color-only overlay without $extensions', () => {
    const result = validate(
      { color: { semantic: { bg: { $value: '#14181f' } } } },
      { kind: 'overlay' },
    );
    expect(result.issues).toEqual([]);
  });

  it('rejects non-color values in an overlay', () => {
    const result = validate(
      { space: { x: { $value: '4px' } } },
      { kind: 'overlay' },
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path === 'space.x.$value')).toBe(true);
  });

  it('rejects a non-color $type declared in an overlay', () => {
    const result = validate(
      { space: { x: { $type: 'dimension', $value: '4px' } } },
      { kind: 'overlay' },
    );
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.path === 'space.x.$type');
    expect(issue?.message).toMatch(/only override color tokens/);
  });

  it('rejects extends inside an overlay', () => {
    const result = validate(
      {
        $extensions: { onbrand: { schemaVersion: 1, extends: 'default' } },
        color: { semantic: { bg: { $value: '#14181f' } } },
      },
      { kind: 'overlay' },
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path === '$extensions.onbrand.extends')).toBe(true);
  });
});
