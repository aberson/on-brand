/**
 * Normalizer integration test through the PRODUCTION entry point (plan.md Step
 * 10 "Done when"): for EACH committed raw-extraction fixture, normalize -> write
 * a temp brand/ -> validate() green -> spawn `node bin/onbrand.mjs build` and
 * `... check`, both exit 0. This is the full producer->consumer round trip
 * (code-quality: an integration test through the production caller), not a unit
 * test of the normalizer alone.
 *
 * The blank/garbage fixture must produce a near-empty-BUT-VALID, check-passing
 * set (default-fill policy) — never a crash.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_OK } from '../src/cli.ts';
import { normalize } from '../src/extract/normalize.ts';
import { applyModeOverlay } from '../src/schema/modes.ts';
import { validate } from '../src/schema/validate.ts';
import type { RawExtraction } from '../src/extract/engine/adapter.ts';

const BIN = fileURLToPath(new URL('../bin/onbrand.mjs', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/extraction/raw-extraction/', import.meta.url));

const FIXTURE_NAMES = ['zengarden', 'stripe', 'example', 'blank'] as const;

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function loadFixture(name: string): RawExtraction {
  return JSON.parse(readFileSync(`${FIXTURES}${name}.json`, 'utf8')) as RawExtraction;
}

/** Normalize a fixture and write a temp project brand/ with both documents. */
function writeBrand(name: string): string {
  const result = normalize(loadFixture(name));
  const dir = mkdtempSync(path.join(os.tmpdir(), `onbrand-norm-${name}-`));
  tempDirs.push(dir);
  const brand = path.join(dir, 'brand');
  mkdirSync(brand, { recursive: true });
  writeFileSync(path.join(brand, 'tokens.json'), `${JSON.stringify(result.tokens, null, 2)}\n`, 'utf8');
  writeFileSync(
    path.join(brand, 'modes.dark.json'),
    `${JSON.stringify(result.dark, null, 2)}\n`,
    'utf8',
  );
  return dir;
}

function runCli(args: string[]): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stderr: result.stderr };
}

describe('normalize -> valid brand tokens (in-process validate)', () => {
  for (const name of FIXTURE_NAMES) {
    it(`${name}: tokens.json + modes.dark.json validate() green and overlay merges`, () => {
      const result = normalize(loadFixture(name));
      const tokens = validate(result.tokens, { kind: 'tokens' });
      expect(tokens.ok, JSON.stringify(tokens.issues)).toBe(true);
      const overlay = validate(result.dark, { kind: 'overlay' });
      expect(overlay.ok, JSON.stringify(overlay.issues)).toBe(true);
      const merged = applyModeOverlay(result.tokens, result.dark);
      expect(merged.ok, JSON.stringify(merged.issues)).toBe(true);
    });
  }
});

describe('normalize -> onbrand build + check exit 0 (production CLI)', () => {
  for (const name of FIXTURE_NAMES) {
    it(`${name}: spawned build succeeds and check passes the WCAG gate`, () => {
      const dir = writeBrand(name);
      const build = runCli(['build', dir]);
      expect(build.status, build.stderr).toBe(EXIT_OK);
      const check = runCli(['check', dir]);
      expect(check.status, check.stderr).toBe(EXIT_OK);
      expect(check.stderr).toContain('check PASS');
      expect(check.stderr).toContain('0 error');
    });
  }
});

describe('garbage fixture is near-empty-but-valid, never a crash', () => {
  it('blank normalizes without throwing and passes check', () => {
    expect(() => normalize(loadFixture('blank'))).not.toThrow();
    const dir = writeBrand('blank');
    const check = runCli(['check', dir]);
    expect(check.status).toBe(EXIT_OK);
  });
});

describe('hostile extraction (malformed values) still round-trips the production CLI', () => {
  it('malformed colors/shadows/fonts/sizes: normalize -> build + check exit 0 (review iteration 2)', () => {
    // Populated-but-malformed input — the class the blank fixture never
    // exercised: unparseable color hex, non-numeric rgba() shadow channels,
    // null font-family entries, sr-only 0px type sizes.
    const hostile: RawExtraction = {
      url: 'https://hostile.example',
      extractedAt: '2026-07-16T00:00:00.000Z',
      engine: { name: 'hostile', version: '0' },
      colors: [
        { hex: 'not-a-color', frequency: 99, roles: [{ role: 'accent', count: 50 }] },
        { hex: '#334488', frequency: 2, roles: [{ role: 'accent', count: 1 }] },
      ],
      fonts: [{ families: [null, 'Arial'] as unknown as string[], role: 'body', frequency: 3 }],
      typeSizes: [{ px: 0, frequency: 50 }],
      spacing: [],
      radii: [],
      shadows: [{ css: 'rgba(abc, def, ghi, xyz) 0px 30px 45px -30px', frequency: 9 }],
      screenshots: [],
    };
    const result = normalize(hostile); // must not throw
    expect(result.warnings.some((w) => w.includes('not-a-color'))).toBe(true);
    expect(validate(result.tokens, { kind: 'tokens' }).ok).toBe(true);

    const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-norm-hostile-'));
    tempDirs.push(dir);
    const brand = path.join(dir, 'brand');
    mkdirSync(brand, { recursive: true });
    writeFileSync(path.join(brand, 'tokens.json'), `${JSON.stringify(result.tokens, null, 2)}\n`, 'utf8');
    writeFileSync(path.join(brand, 'modes.dark.json'), `${JSON.stringify(result.dark, null, 2)}\n`, 'utf8');
    expect(runCli(['build', dir]).status).toBe(EXIT_OK);
    const check = runCli(['check', dir]);
    expect(check.status, check.stderr).toBe(EXIT_OK);
    expect(check.stderr).toContain('check PASS');
  });
});
