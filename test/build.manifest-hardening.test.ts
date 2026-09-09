/**
 * Issue #19: manifest.outputs carry-forward hardening.
 *
 *   - isCleanOutputKey rejects absolute / traversal / non-dist-shaped keys;
 *   - buildManifest DROPS carried-forward keys that fail that check;
 *   - buildManifest PRUNES carried-forward entries whose file is gone from disk
 *     (via the injectable carriedOutputExists predicate);
 *   - outputs emitted THIS run are never pruned (they were just written).
 */

import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  computeSourceHash,
  isCleanOutputKey,
  renderManifest,
} from '../src/build/manifest.ts';

const T0 = '2026-07-16T00:00:00.000Z';
const h1 = computeSourceHash([{ relPath: 'tokens.json', content: '{"a":1}' }]);
const h2 = computeSourceHash([{ relPath: 'tokens.json', content: '{"a":2}' }]);

describe('isCleanOutputKey', () => {
  it('accepts clean dist/-relative emitter filenames', () => {
    for (const key of ['tokens.css', 'theme.tw.css', 'diagram-palette.json', 'sub/dir/file.svg']) {
      expect(isCleanOutputKey(key), key).toBe(true);
    }
  });

  it('rejects absolute, traversal, drive-letter, backslash, and reserved keys', () => {
    for (const key of [
      '',
      '/etc/passwd',
      '../outside.css',
      'a/../../b.css',
      'C:/windows/system32',
      'dir\\file.css',
      './rel.css',
      '__proto__/x.css',
      'a/constructor',
    ]) {
      expect(isCleanOutputKey(key), key).toBe(false);
    }
  });
});

describe('buildManifest #19 carry-forward hardening', () => {
  it('drops a carried-forward key that is not a clean dist/-relative path', () => {
    // Forge a previous manifest carrying a traversal key.
    const forged = JSON.stringify({
      sourceHash: h1.sourceHash,
      outputs: { 'tokens.css': h1.sourceHash, '../../evil.txt': h1.sourceHash },
    });
    const warnings: string[] = [];
    const manifest = buildManifest({
      hash: h2,
      emitters: [],
      outputs: [],
      previousManifestContent: forged,
      onWarning: (m) => warnings.push(m),
      now: () => T0,
    });
    expect(Object.keys(manifest.outputs)).toEqual(['tokens.css']); // evil key gone
    expect(warnings.join('\n')).toContain('../../evil.txt');
  });

  it('prunes a carried-forward entry whose file is gone from disk', () => {
    const full = buildManifest({
      hash: h1,
      emitters: ['css', 'tw'],
      outputs: ['tokens.css', 'theme.tw.css'],
      now: () => T0,
    });
    const warnings: string[] = [];
    // subset build regenerates only tw; css file has been deleted from disk.
    const subset = buildManifest({
      hash: h2,
      emitters: ['tw'],
      outputs: ['theme.tw.css'],
      previousManifestContent: renderManifest(full),
      carriedOutputExists: (rel) => rel !== 'tokens.css', // css missing on disk
      onWarning: (m) => warnings.push(m),
      now: () => T0,
    });
    expect(Object.keys(subset.outputs).sort()).toEqual(['theme.tw.css']);
    expect(subset.outputs['theme.tw.css']).toBe(h2.sourceHash); // fresh
    expect(warnings.join('\n')).toContain('tokens.css');
  });

  it('never prunes an output emitted this run even if the predicate says missing', () => {
    const manifest = buildManifest({
      hash: h1,
      emitters: ['css'],
      outputs: ['tokens.css'],
      carriedOutputExists: () => false, // would prune everything carried
      now: () => T0,
    });
    expect(manifest.outputs['tokens.css']).toBe(h1.sourceHash);
  });
});
