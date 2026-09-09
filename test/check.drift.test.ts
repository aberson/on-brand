/**
 * Unit tests for checkDrift (src/check/drift.ts) branch coverage (review
 * finding T4) + the two iteration-2 fixes:
 *   - non-string manifest.outputs values are per-entry ERRORS, never a silent
 *     skip that lets a hand-corrupted manifest read as clean;
 *   - the completeness sweep: an implemented emitter's output with no
 *     manifest entry is an ERROR ("dist incomplete") — the check-side guard
 *     that makes the #19 build-time prune safe.
 */

import { linkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkDrift, type ExpectedOutput } from '../src/check/drift.ts';
import { sha256Bytes } from '../src/filesystem.ts';

const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const EXPECTED: ExpectedOutput[] = [{ emitter: 'css', relPath: 'tokens.css' }];

const tempDirs: string[] = [];
function tempDist(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-drift-'));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function manifest(outputs: unknown): string {
  return JSON.stringify({ sourceHash: HASH, outputs });
}

describe('checkDrift — manifest-shape branches', () => {
  it('absent manifest is a WARNING and skips the completeness sweep', () => {
    const findings = checkDrift(tempDist(), HASH, undefined, EXPECTED);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('warning');
    expect(findings[0]!.message).toContain('no built dist');
  });

  it('invalid JSON is an ERROR', () => {
    const findings = checkDrift(tempDist(), HASH, 'not json {', EXPECTED);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.message).toContain('not valid JSON');
  });

  it('valid JSON that is not an object is an ERROR', () => {
    const findings = checkDrift(tempDist(), HASH, '"just a string"', EXPECTED);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.message).toContain('not a JSON object');
  });

  it('a manifest without an outputs map is an ERROR (no sourceHash-only fallback)', () => {
    // Even with a matching top-level sourceHash: no real onbrand build ever
    // produced an outputs-less manifest, so it cannot be verified — fail loud.
    const findings = checkDrift(tempDist(), HASH, JSON.stringify({ sourceHash: HASH }), EXPECTED);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.message).toContain('no outputs map');
  });
});

describe('checkDrift — per-entry branches', () => {
  it('passes a fresh entry whose file exists', () => {
    const dist = tempDist();
    writeFileSync(path.join(dist, 'tokens.css'), '/* x */\n', 'utf8');
    const findings = checkDrift(dist, HASH, manifest({ 'tokens.css': HASH }), EXPECTED);
    expect(findings).toEqual([]);
  });

  it('a stale recorded hash is an ERROR naming the output', () => {
    const dist = tempDist();
    writeFileSync(path.join(dist, 'tokens.css'), '/* x */\n', 'utf8');
    const findings = checkDrift(dist, HASH, manifest({ 'tokens.css': OTHER_HASH }), EXPECTED);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toBe('tokens.css');
    expect(findings[0]!.message).toContain('stale dist output');
  });

  it('a current entry whose file is missing on disk is a "dist incomplete" ERROR', () => {
    // The CHECK-time-only case: file deleted after the recording build, no
    // rebuild in between (distinct from the build-time prune).
    const findings = checkDrift(tempDist(), HASH, manifest({ 'tokens.css': HASH }), EXPECTED);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('dist incomplete');
    expect(findings[0]!.message).toContain('the file is missing');
  });

  it('a hard-linked output is unsafe and fails closed', () => {
    const dist = tempDist();
    const sentinel = path.join(dist, 'sentinel.css');
    writeFileSync(sentinel, '/* sentinel */\n', 'utf8');
    linkSync(sentinel, path.join(dist, 'tokens.css'));

    const findings = checkDrift(dist, HASH, manifest({ 'tokens.css': HASH }), EXPECTED);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'error',
      path: 'tokens.css',
      evidence: { safeTarget: false },
    });
  });

  it('validates configured output content provenance against stable live bytes', () => {
    const dist = tempDist();
    const output = path.join(dist, 'tokens.css');
    const original = Buffer.from('/* original */\n', 'utf8');
    writeFileSync(output, original);
    const expected: ExpectedOutput[] = [{
      emitter: 'generated',
      relPath: 'tokens.css',
      contentDigestLabel: 'generated-content',
    }];
    const content = JSON.stringify({
      sourceHash: HASH,
      outputs: { 'tokens.css': HASH },
      outputSources: {
        'tokens.css': [{
          label: 'generated-content',
          sourcePath: null,
          kind: 'digest',
          sha256: sha256Bytes(original),
        }],
      },
    });

    expect(checkDrift(dist, HASH, content, expected)).toEqual([]);
    writeFileSync(output, '/* replaced */\n', 'utf8');
    const findings = checkDrift(dist, HASH, content, expected);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'stale-dist-output-outdated',
      path: 'tokens.css',
      evidence: { digestLabel: 'generated-content', hashesMatch: false },
    });
  });

  it('a non-string hash value is a per-entry ERROR, not a silent skip', () => {
    const dist = tempDist();
    writeFileSync(path.join(dist, 'tokens.css'), '/* x */\n', 'utf8');
    const findings = checkDrift(dist, HASH, manifest({ 'tokens.css': 12345 }), EXPECTED);
    expect(findings).toHaveLength(1); // errored once — NOT also swept as missing
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.message).toContain('not a hash string');
  });

  it('an unsafe key is refused, never joined onto distDir', () => {
    const findings = checkDrift(
      tempDist(),
      HASH,
      manifest({ '../../escape.txt': HASH, 'tokens.css': HASH }),
      EXPECTED,
    );
    const unsafe = findings.filter((f) => f.message.includes('unsafe key'));
    expect(unsafe).toHaveLength(1);
    expect(unsafe[0]!.message).toContain('../../escape.txt');
  });
});

describe('checkDrift — completeness sweep (the prune-false-green guard)', () => {
  it('an expected output with no manifest entry is a "dist incomplete" ERROR naming the emitter', () => {
    const findings = checkDrift(tempDist(), HASH, manifest({}), EXPECTED);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.path).toBe('tokens.css');
    expect(findings[0]!.message).toContain('no provenance recorded');
    expect(findings[0]!.message).toContain('"css" emitter');
  });

  it('does not double-report an expected output that already errored per-entry', () => {
    const findings = checkDrift(tempDist(), HASH, manifest({ 'tokens.css': OTHER_HASH }), EXPECTED);
    // stale error only — the sweep sees the key as recorded
    expect(findings.filter((f) => f.path === 'tokens.css')).toHaveLength(1);
  });
});
