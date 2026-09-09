import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  TokenResolveError,
  defaultPresetsRoot,
  mergeTokenTrees,
  resolveExtendsTarget,
  resolveTokensFile,
} from '../src/schema/resolve.ts';
import { TokenValidationError } from '../src/schema/validate.ts';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-resolve-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeJson(filePath: string, doc: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

const BASE_DOC = {
  $extensions: { onbrand: { schemaVersion: 1 } },
  color: {
    $type: 'color',
    semantic: {
      bg: { $value: '#ffffff' },
      accent: { $value: '#3b63a8' },
    },
  },
  radius: { $type: 'dimension', sm: { $value: '4px' } },
};

describe('resolveTokensFile — extends resolution', () => {
  it('returns a standalone file unchanged (no extends)', () => {
    const dir = tempDir();
    const file = path.join(dir, 'tokens.json');
    writeJson(file, BASE_DOC);
    const { document, chain } = resolveTokensFile(file);
    expect(chain).toEqual([file]);
    expect(document).toMatchObject({ color: { semantic: { bg: { $value: '#ffffff' } } } });
  });

  it('merges a relative-path extends: override wins, base fills, extends consumed', () => {
    const dir = tempDir();
    writeJson(path.join(dir, 'base.json'), BASE_DOC);
    writeJson(path.join(dir, 'child', 'tokens.json'), {
      $extensions: { onbrand: { schemaVersion: 1, extends: '../base.json' } },
      color: { semantic: { accent: { $value: '#ff0000' } } },
    });

    const { document, chain } = resolveTokensFile(path.join(dir, 'child', 'tokens.json'));
    expect(chain).toHaveLength(2);
    // override wins
    expect(document).toMatchObject({ color: { semantic: { accent: { $value: '#ff0000' } } } });
    // base-only tokens survive
    expect(document).toMatchObject({
      color: { semantic: { bg: { $value: '#ffffff' } } },
      radius: { sm: { $value: '4px' } },
    });
    // extends is consumed by resolution
    const ext = document['$extensions'] as { onbrand?: { extends?: string } };
    expect(ext.onbrand?.extends).toBeUndefined();
  });

  it('resolves a preset name against templates/presets/', () => {
    const dir = tempDir();
    const file = path.join(dir, 'tokens.json');
    writeJson(file, {
      $extensions: { onbrand: { schemaVersion: 1, extends: 'default' } },
      color: { semantic: { accent: { $value: '#ff0000' } } },
    });

    const { document, chain } = resolveTokensFile(file);
    expect(chain[1]).toBe(path.join(defaultPresetsRoot(), 'default', 'tokens.json'));
    // override applied on top of the real default preset
    expect(document).toMatchObject({
      color: {
        semantic: { accent: { $value: '#ff0000' }, bg: { $value: '#fcfcfd' } },
        primitive: { brand: { '9': { $value: '#3b63a8' } } },
      },
    });
  });

  it('resolves a directory extends target to its tokens.json', () => {
    const dir = tempDir();
    writeJson(path.join(dir, 'shared', 'tokens.json'), BASE_DOC);
    const target = resolveExtendsTarget('./shared', dir, defaultPresetsRoot());
    expect(target).toBe(path.join(dir, 'shared', 'tokens.json'));
  });

  it('follows a chain (a extends b extends c)', () => {
    const dir = tempDir();
    writeJson(path.join(dir, 'c.json'), BASE_DOC);
    writeJson(path.join(dir, 'b.json'), {
      $extensions: { onbrand: { schemaVersion: 1, extends: './c.json' } },
      color: { semantic: { bg: { $value: '#eeeeee' } } },
      space: { $type: 'dimension', '1': { $value: '0.25rem' } },
    });
    writeJson(path.join(dir, 'a.json'), {
      $extensions: { onbrand: { schemaVersion: 1, extends: './b.json' } },
      color: { semantic: { accent: { $value: '#00ff00' } } },
    });

    const { document, chain } = resolveTokensFile(path.join(dir, 'a.json'));
    expect(chain).toHaveLength(3);
    expect(document).toMatchObject({
      color: {
        semantic: {
          accent: { $value: '#00ff00' }, // from a
          bg: { $value: '#eeeeee' }, // from b
        },
      },
      space: { '1': { $value: '0.25rem' } }, // from b
      radius: { sm: { $value: '4px' } }, // from c
    });
  });

  it('throws on a circular extends chain', () => {
    const dir = tempDir();
    writeJson(path.join(dir, 'a.json'), {
      $extensions: { onbrand: { schemaVersion: 1, extends: './b.json' } },
    });
    writeJson(path.join(dir, 'b.json'), {
      $extensions: { onbrand: { schemaVersion: 1, extends: './a.json' } },
    });
    expect(() => resolveTokensFile(path.join(dir, 'a.json'))).toThrowError(/circular extends/);
  });

  it('throws a TokenResolveError naming the spec when the target is missing', () => {
    const dir = tempDir();
    writeJson(path.join(dir, 'tokens.json'), {
      $extensions: { onbrand: { schemaVersion: 1, extends: './nope.json' } },
    });
    try {
      resolveTokensFile(path.join(dir, 'tokens.json'));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TokenResolveError);
      expect((err as Error).message).toContain('./nope.json');
    }
  });

  it('throws a path-precise TokenValidationError when a file in the chain is invalid', () => {
    const dir = tempDir();
    writeJson(path.join(dir, 'tokens.json'), {
      $extensions: { onbrand: { schemaVersion: 1 } },
      color: { $type: 'color', semantic: { bg: { $value: 123 } } },
    });
    try {
      resolveTokensFile(path.join(dir, 'tokens.json'));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TokenValidationError);
      expect((err as Error).message).toContain('color.semantic.bg.$value');
    }
  });

  it('validates the MERGED result as a full tokens document (fragment leaf gains type from base group)', () => {
    const dir = tempDir();
    writeJson(path.join(dir, 'base.json'), BASE_DOC);
    // fragment: bare leaf with no $type anywhere in THIS file — inherited from
    // base's color group after merge.
    writeJson(path.join(dir, 'tokens.json'), {
      $extensions: { onbrand: { schemaVersion: 1, extends: './base.json' } },
      color: { semantic: { bg: { $value: '#000000' } } },
    });
    const { document } = resolveTokensFile(path.join(dir, 'tokens.json'));
    expect(document).toMatchObject({ color: { semantic: { bg: { $value: '#000000' } } } });
  });
});

describe('prototype-pollution guards', () => {
  it('mergeTokenTrees skips a literal "__proto__" override key and leaves [[Prototype]] unchanged', () => {
    // JSON.parse produces an OWN "__proto__" property (an object literal would
    // set the prototype at creation instead) — the exact shape a hostile or
    // corrupted tokens.json delivers.
    const override = JSON.parse('{"__proto__":{"polluted":true},"a":{"$type":"color","x":{"$value":"#222222"}}}') as Record<string, unknown>;
    const base = { a: { $type: 'color', x: { $value: '#111111' } } };

    const merged = mergeTokenTrees(base, override);

    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect((merged as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.hasOwn(merged, '__proto__')).toBe(false);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined(); // global prototype untouched
    // the legitimate sibling still merged
    expect(merged).toMatchObject({ a: { x: { $value: '#222222' } } });
  });

  it('resolveTokensFile rejects a chain file containing an unsafe "__proto__" name, path-precisely', () => {
    const dir = tempDir();
    writeJson(path.join(dir, 'base.json'), BASE_DOC);
    writeFileSync(
      path.join(dir, 'tokens.json'),
      '{"$extensions":{"onbrand":{"schemaVersion":1,"extends":"./base.json"}},"color":{"__proto__":{"$value":"#123456"}}}',
      'utf8',
    );
    try {
      resolveTokensFile(path.join(dir, 'tokens.json'));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TokenValidationError);
      expect((err as Error).message).toContain('color.__proto__');
      expect((err as Error).message).toMatch(/unsafe/);
    }
    expect(({} as { $value?: unknown }).$value).toBeUndefined(); // global prototype untouched
  });
});

describe('mergeTokenTrees', () => {
  it('does not mutate its inputs', () => {
    const base = { a: { $type: 'color', x: { $value: '#111111' } } };
    const override = { a: { x: { $value: '#222222' } } };
    const baseSnapshot = JSON.stringify(base);
    const overrideSnapshot = JSON.stringify(override);
    mergeTokenTrees(base, override);
    expect(JSON.stringify(base)).toBe(baseSnapshot);
    expect(JSON.stringify(override)).toBe(overrideSnapshot);
  });

  it('replaces a token wholesale when the override side is a leaf', () => {
    const base = {
      a: { $type: 'color', x: { $value: '#111111', $description: 'base desc' } },
    };
    const override = { a: { x: { $value: '#222222' } } };
    const merged = mergeTokenTrees(base, override) as {
      a: { x: { $value: string; $description?: string } };
    };
    expect(merged.a.x.$value).toBe('#222222');
    // leaf collisions replace, not field-merge
    expect(merged.a.x.$description).toBeUndefined();
  });
});
