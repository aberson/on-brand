/**
 * Unit tests for explicit-root brand discovery + classification (Step 17;
 * plan.md §5, §6). Fixtures are built through the PRODUCTION assembly
 * (compileBrand) so "fresh dist" means exactly what the tool means by it.
 *
 * The two load-bearing guarantees the step's Done-when demands:
 *   - a proposal fixture can NEVER be labeled final (status adopted / final:true),
 *     however fresh its dist is;
 *   - excluded trees (node_modules, .git, ...) and a brand's own dist/assets
 *     subtree are never crawled.
 */

import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { compileBrand } from '../src/build/compile.ts';
import { classifyBrand, discoverBrands } from '../src/gallery/discover.ts';

const PRESET_DIR = fileURLToPath(new URL('../templates/presets/default', import.meta.url));

const tempDirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-discover-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Copy the default preset sources into <root>/brand (a scaffolded, unbuilt brand). */
function scaffold(root: string, guide?: string): string {
  const brand = path.join(root, 'brand');
  mkdirSync(brand, { recursive: true });
  copyFileSync(path.join(PRESET_DIR, 'tokens.json'), path.join(brand, 'tokens.json'));
  copyFileSync(path.join(PRESET_DIR, 'modes.dark.json'), path.join(brand, 'modes.dark.json'));
  if (guide !== undefined) writeFileSync(path.join(brand, 'guide.md'), guide, 'utf8');
  return root;
}

/** Scaffold + full build (fresh dist for every implemented emitter). */
function scaffoldAndBuild(root: string, guide?: string): string {
  scaffold(root, guide);
  compileBrand(root);
  return root;
}

/** Mutate a token value so the recorded dist hashes go stale (no rebuild). */
function driftSources(root: string): void {
  const tokensPath = path.join(root, 'brand', 'tokens.json');
  const original = readFileSync(tokensPath, 'utf8');
  writeFileSync(tokensPath, original.replace('#3b63a8', '#0000aa'), 'utf8');
}

describe('classifyBrand — provenance x health matrix', () => {
  it('adopted: a valid non-proposal brand with a fresh dist is final', () => {
    const root = scaffoldAndBuild(path.join(workspace(), 'app'));
    const b = classifyBrand(root);
    expect(b.status).toBe('adopted');
    expect(b.final).toBe(true);
    expect(b.provenance).toBe('adopted');
    expect(b.hasDist).toBe(true);
    expect(b.hasTokens).toBe(true);
    expect(b.incompleteMarker).toBe(false);
    expect(b.error).toBeUndefined();
  });

  it('stale: an adopted brand whose dist drifted from sources is not final', () => {
    const root = scaffoldAndBuild(path.join(workspace(), 'app'));
    driftSources(root);
    const b = classifyBrand(root);
    expect(b.status).toBe('stale');
    expect(b.final).toBe(false);
    expect(b.hasDist).toBe(true);
    expect(b.reason).toContain('drifted');
  });

  it('stale: an adopted brand with no built dist at all is not final', () => {
    const root = scaffold(path.join(workspace(), 'app'));
    const b = classifyBrand(root);
    expect(b.status).toBe('stale');
    expect(b.final).toBe(false);
    expect(b.hasDist).toBe(false);
  });

  it('proposal: a complete from-url proposal is valid but NEVER final', () => {
    const ws = workspace();
    const root = scaffoldAndBuild(path.join(ws, 'onbrand-proposal-example-20260101'));
    const b = classifyBrand(root);
    expect(b.status).toBe('proposal');
    expect(b.provenance).toBe('proposal');
    // The load-bearing invariant: a fresh dist does NOT promote a proposal.
    expect(b.final).toBe(false);
    expect(b.status).not.toBe('adopted');
    expect(b.hasDist).toBe(true);
  });

  it('incomplete: a proposal with an INCOMPLETE.md marker beats even a fresh dist', () => {
    const ws = workspace();
    const root = scaffoldAndBuild(path.join(ws, 'onbrand-proposal-example-20260101'));
    writeFileSync(path.join(root, 'INCOMPLETE.md'), '# INCOMPLETE proposal\n', 'utf8');
    const b = classifyBrand(root);
    expect(b.status).toBe('incomplete');
    expect(b.final).toBe(false);
    expect(b.incompleteMarker).toBe(true);
    expect(b.provenance).toBe('proposal');
  });

  it('incomplete: a proposal with no built dist is incomplete, not adopted', () => {
    const ws = workspace();
    const root = scaffold(path.join(ws, 'onbrand-proposal-example-20260101'));
    const b = classifyBrand(root);
    expect(b.status).toBe('incomplete');
    expect(b.final).toBe(false);
    expect(b.provenance).toBe('proposal');
  });

  it('proposal provenance is detected from a DRAFT guide.md even with a plain dir name', () => {
    const root = scaffoldAndBuild(
      path.join(workspace(), 'plain-name'),
      '# Acme — Brand Guide (DRAFT)\n\nGENERATED as a DRAFT by `onbrand from-url`\n',
    );
    const b = classifyBrand(root);
    expect(b.provenance).toBe('proposal');
    expect(b.final).toBe(false);
    expect(b.status).not.toBe('adopted');
  });

  it('invalid: a brand whose tokens.json fails validation carries the loader error', () => {
    const root = scaffold(path.join(workspace(), 'app'));
    const tokensPath = path.join(root, 'brand', 'tokens.json');
    const doc = JSON.parse(readFileSync(tokensPath, 'utf8')) as {
      color: { semantic: { bg: { $value: unknown } } };
    };
    doc.color.semantic.bg.$value = 42;
    writeFileSync(tokensPath, JSON.stringify(doc, null, 2), 'utf8');

    const b = classifyBrand(root);
    expect(b.status).toBe('invalid');
    expect(b.final).toBe(false);
    expect(b.error).toBeDefined();
    expect(b.error).toContain('color.semantic.bg');
  });
});

describe('discoverBrands — walk, excludes, ordering', () => {
  it('finds a workspace-root brand AND a nested proposal (sibling walk), sorted', () => {
    const ws = workspace();
    scaffoldAndBuild(ws); // brand at the workspace root itself
    scaffoldAndBuild(path.join(ws, 'onbrand-proposal-acme-20260101'));

    const { brands } = discoverBrands(ws);
    expect(brands).toHaveLength(2);
    // sorted by relPath: '.' sorts before 'onbrand-...'
    expect(brands.map((b) => b.relPath)).toEqual(['.', 'onbrand-proposal-acme-20260101']);

    const rootBrand = brands.find((b) => b.relPath === '.')!;
    expect(rootBrand.name).toBe('<workspace>');
    expect(rootBrand.status).toBe('adopted');
    expect(rootBrand.final).toBe(true);

    const proposal = brands.find((b) => b.relPath === 'onbrand-proposal-acme-20260101')!;
    expect(proposal.status).toBe('proposal');
    expect(proposal.final).toBe(false);
  });

  it('never crawls excluded trees (node_modules) or a brand\'s own dist subtree', () => {
    const ws = workspace();
    scaffoldAndBuild(path.join(ws, 'app'));
    // A valid brand buried in an excluded tree must be invisible.
    scaffoldAndBuild(path.join(ws, 'node_modules', 'some-pkg'));
    // A directory literally named dist is excluded too.
    scaffoldAndBuild(path.join(ws, 'dist', 'nested'));

    const { brands } = discoverBrands(ws);
    expect(brands.map((b) => b.relPath)).toEqual(['app']);
    // exactly one entry per brand root — the app's own brand/dist did not
    // register a second brand.
    expect(brands).toHaveLength(1);
  });

  it('respects maxDepth (a brand deeper than the bound is not discovered)', () => {
    const ws = workspace();
    scaffoldAndBuild(path.join(ws, 'a', 'b', 'c', 'deep'));

    expect(discoverBrands(ws, { maxDepth: 2 }).brands).toHaveLength(0);
    expect(discoverBrands(ws, { maxDepth: 6 }).brands.map((b) => b.relPath)).toEqual([
      'a/b/c/deep',
    ]);
  });

  it('honors extra excludes passed by the caller', () => {
    const ws = workspace();
    scaffoldAndBuild(path.join(ws, 'keep'));
    scaffoldAndBuild(path.join(ws, 'vendored'));

    const { brands } = discoverBrands(ws, { exclude: ['vendored'] });
    expect(brands.map((b) => b.relPath)).toEqual(['keep']);
  });

  it('returns an empty list for a workspace with no brands, and throws on a missing root', () => {
    const ws = workspace();
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    expect(discoverBrands(ws).brands).toEqual([]);

    expect(() => discoverBrands(path.join(ws, 'does-not-exist'))).toThrow(/not an existing directory/);
  });

  it('uses forward-slash relPaths regardless of platform separators', () => {
    const ws = workspace();
    scaffoldAndBuild(path.join(ws, 'group', 'app'));
    const { brands } = discoverBrands(ws);
    expect(brands.map((b) => b.relPath)).toEqual(['group/app']);
  });

  it('does not follow directory or brand-payload junctions outside the explicit workspace root', () => {
    const container = workspace();
    const ws = path.join(container, 'workspace');
    const outside = scaffoldAndBuild(path.join(container, 'outside-brand'));
    mkdirSync(ws, { recursive: true });

    // A whole linked project and a real child carrying a linked brand/ payload
    // must both remain outside the discovery boundary.
    symlinkSync(outside, path.join(ws, 'linked-project'), 'junction');
    const linkedPayload = path.join(ws, 'linked-payload');
    mkdirSync(linkedPayload, { recursive: true });
    symlinkSync(path.join(outside, 'brand'), path.join(linkedPayload, 'brand'), 'junction');

    expect(discoverBrands(ws).brands).toEqual([]);
  });
});
