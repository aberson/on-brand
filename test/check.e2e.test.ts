/**
 * Integration tests for `onbrand check` through the PRODUCTION entry point:
 * spawn `node bin/onbrand.mjs check ...` (exactly what package.json "bin"
 * points at). The three CALIBRATION ANCHORS the step demands
 * (measurement-validity: a gate that cannot fail garbage cannot gate):
 *
 *   (a) known-good  — the default preset build PASSES;
 *   (b) known-garbage — a grey-on-grey fixture FAILS with named WCAG
 *       violations listing token dot-paths + both colors + the ratio;
 *   (c) stale-dist  — a fixture whose dist/manifest.json hashes mismatch the
 *       current sources FAILS the drift check, naming the stale outputs.
 *
 * Plus: --strict promotes APCA advisories to errors; exit codes match §6
 * (0 ok, 1 gate failure, 2 usage); `build --check` runs the same gate; and the
 * #19 traversal-safety guard refuses an unsafe manifest.outputs key.
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../src/cli.ts';

const BIN = fileURLToPath(new URL('../bin/onbrand.mjs', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/check', import.meta.url));

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-check-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A fresh, fully-built default-preset project (dist present + fresh). */
function initAndBuild(): string {
  const dir = tempDir();
  expect(runCli(['init', dir]).status).toBe(EXIT_OK);
  expect(runCli(['build', dir]).status).toBe(EXIT_OK);
  return dir;
}

/** Copy a committed fixture into a temp dir (so we never mutate test/fixtures). */
function fixtureCopy(name: string): string {
  const dir = tempDir();
  cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

describe('onbrand check — calibration anchors (spawned through bin/onbrand.mjs)', () => {
  it('(a) known-good: the default preset build PASSES the gate (exit 0)', () => {
    const dir = initAndBuild();
    const run = runCli(['check', dir]);
    expect(run.status).toBe(EXIT_OK);
    expect(run.stderr).toContain('check PASS');
    expect(run.stderr).toContain('0 error');
    // APCA is reported alongside every pairing (advisory).
    expect(run.stderr).toContain('APCA');
  }, 30_000);

  it('(b) known-garbage: grey-on-grey FAILS with named WCAG violations (paths + colors + ratio)', () => {
    const dir = fixtureCopy('garbage');
    const run = runCli(['check', dir]);
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).toContain('check FAIL');
    // named token dot-paths + both colors + the computed ratio
    expect(run.stderr).toContain('WCAG 2 AA FAIL');
    expect(run.stderr).toContain('color.semantic.text');
    expect(run.stderr).toContain('color.semantic.bg');
    expect(run.stderr).toContain('#7c7c7c');
    expect(run.stderr).toContain('#8a8a8a');
    expect(run.stderr).toContain(':1'); // the ratio, e.g. "1.21:1"
    // every declared status pair is named too
    expect(run.stderr).toContain('color.status.success.fg');
  });

  it('(c) stale-dist: a fixture with mismatched manifest hashes FAILS the drift check', () => {
    const dir = fixtureCopy('stale');
    const run = runCli(['check', dir]);
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).toContain('stale dist output');
    expect(run.stderr).toContain('tokens.css'); // a named stale output
    expect(run.stderr).toContain('onbrand build'); // the remediation
  });
});

describe('onbrand check — APCA advisory vs --strict', () => {
  it('non-strict PASSES a WCAG-clean-but-APCA-weak palette (advisory only)', () => {
    const dir = fixtureCopy('apca-advisory');
    const run = runCli(['check', dir]);
    expect(run.status).toBe(EXIT_OK);
    expect(run.stderr).toContain('advisory'); // shown, not failing
    expect(run.stderr).toContain('check PASS');
  });

  it('--strict promotes the APCA advisories to errors (exit 1)', () => {
    const dir = fixtureCopy('apca-advisory');
    const run = runCli(['check', dir, '--strict']);
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).toContain('promoted by --strict');
    expect(run.stderr).toContain('color.semantic.text-muted');
  });

  it('the real default preset also fails --strict on its borderline dark muted text', () => {
    const dir = initAndBuild();
    const run = runCli(['check', dir, '--strict']);
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).toContain('APCA');
    expect(run.stderr).toContain('[dark]');
  });
});

describe('onbrand check — drift severity + traversal safety', () => {
  it('a not-yet-built project WARNS (not errors) about missing dist — contrast still gates', () => {
    const dir = tempDir();
    expect(runCli(['init', dir]).status).toBe(EXIT_OK); // init only, no build
    const run = runCli(['check', dir]);
    expect(run.status).toBe(EXIT_OK); // default tokens pass WCAG; drift is a warning
    expect(run.stderr).toContain('no built dist');
    expect(run.stderr).toContain('1 warning');
  });

  it('#19: refuses an unsafe manifest.outputs key instead of traversing outside dist/', () => {
    const dir = initAndBuild();
    const manifestPath = path.join(dir, 'brand', 'dist', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      outputs: Record<string, string>;
      sourceHash: string;
    };
    manifest.outputs['../../escape.txt'] = manifest.sourceHash; // injected traversal key
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const run = runCli(['check', dir]);
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).toContain('unsafe key');
    expect(run.stderr).toContain('../../escape.txt');
  });
});

describe('onbrand check — dist-incomplete guard (prune false-green regression)', () => {
  it('REGRESSION: deleted output + subset rebuild (prune) must still FAIL check', () => {
    // Exact iteration-2 repro: the build-time prune removes the entry with
    // only a stderr note, and check used to PASS a dist missing an output.
    const dir = initAndBuild();
    rmSync(path.join(dir, 'brand', 'dist', 'components.css'));
    const rebuild = runCli(['build', dir, '--emit', 'tw']);
    expect(rebuild.status).toBe(EXIT_OK);
    expect(rebuild.stderr).toContain('pruned');

    const run = runCli(['check', dir]);
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).toContain('dist incomplete');
    expect(run.stderr).toContain('components.css');
    expect(run.stderr).toContain('"components" emitter');
  });

  it('a dist file deleted with NO rebuild in between also fails ("file is missing")', () => {
    const dir = initAndBuild();
    rmSync(path.join(dir, 'brand', 'dist', 'tokens.css'));
    const run = runCli(['check', dir]);
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).toContain('dist incomplete');
    expect(run.stderr).toContain('tokens.css');
  });
});

describe('onbrand check — dark-only WCAG hard failure (both modes gated)', () => {
  it('a pairing that passes light but fails dark FAILS the gate, tagged [dark]', () => {
    const dir = tempDir();
    expect(runCli(['init', dir]).status).toBe(EXIT_OK);
    // Make dark body text near-invisible on the dark bg; light is untouched.
    const modesPath = path.join(dir, 'brand', 'modes.dark.json');
    const overlay = JSON.parse(readFileSync(modesPath, 'utf8')) as {
      color: { semantic: { text: { $value: string } } };
    };
    overlay.color.semantic.text.$value = '#20242c'; // vs dark bg #14181f: ~1.2:1
    writeFileSync(modesPath, `${JSON.stringify(overlay, null, 2)}\n`, 'utf8');
    expect(runCli(['build', dir]).status).toBe(EXIT_OK);

    const run = runCli(['check', dir]);
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).toContain('[dark] WCAG 2 AA FAIL');
    expect(run.stderr).toContain('color.semantic.text');
    expect(run.stderr).not.toContain('[light] WCAG 2 AA FAIL'); // light still passes
  });
});

describe('onbrand check — schema lint through the CLI', () => {
  it('warns on an unknown top-level category and a missing surface override (exit 0)', () => {
    const dir = tempDir();
    expect(runCli(['init', dir]).status).toBe(EXIT_OK);
    // typo'd category
    const tokensPath = path.join(dir, 'brand', 'tokens.json');
    const doc = JSON.parse(readFileSync(tokensPath, 'utf8')) as Record<string, unknown>;
    doc['colour'] = { $type: 'color', oops: { $value: '#123456' } };
    writeFileSync(tokensPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    // drop one surface override from the overlay
    const modesPath = path.join(dir, 'brand', 'modes.dark.json');
    const overlay = JSON.parse(readFileSync(modesPath, 'utf8')) as {
      color: { diagram: Record<string, unknown> };
    };
    delete overlay.color.diagram['warning'];
    writeFileSync(modesPath, `${JSON.stringify(overlay, null, 2)}\n`, 'utf8');
    expect(runCli(['build', dir]).status).toBe(EXIT_OK);

    const run = runCli(['check', dir]);
    expect(run.status).toBe(EXIT_OK); // lint findings are warnings, not gate failures
    expect(run.stderr).toContain('unknown top-level category "colour"');
    expect(run.stderr).toContain('color.diagram.warning');
    expect(run.stderr).toContain('no modes.dark.json override');
  });
});

describe('onbrand check — CLI contract (exit codes, help)', () => {
  it('exits 1 with an init hint when there is no brand/', () => {
    const run = runCli(['check', tempDir()]);
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).toContain('onbrand init');
  });

  it('rejects an unknown flag with exit 2 (usage error)', () => {
    const dir = initAndBuild();
    const run = runCli(['check', dir, '--nope']);
    expect(run.status).toBe(EXIT_USAGE);
    expect(run.stderr).toContain('--nope');
  });

  it('rejects an extra positional argument with exit 2', () => {
    const run = runCli(['check', tempDir(), 'extra-arg']);
    expect(run.status).toBe(EXIT_USAGE);
    expect(run.stderr).toContain('unexpected extra argument');
  });

  it('check --help exits 0 and documents --strict', () => {
    const run = runCli(['check', '--help']);
    expect(run.status).toBe(EXIT_OK);
    expect(run.stdout).toContain('--strict');
  });
});

describe('onbrand build --check (shared gate) + #19 prune', () => {
  it('build --check fails the build when a declared pairing fails WCAG', () => {
    const dir = tempDir();
    expect(runCli(['init', dir]).status).toBe(EXIT_OK);
    // Grey-out the core text pairing so light WCAG fails.
    const tokensPath = path.join(dir, 'brand', 'tokens.json');
    const doc = JSON.parse(readFileSync(tokensPath, 'utf8')) as {
      color: { semantic: { bg: { $value: string }; text: { $value: string } } };
    };
    doc.color.semantic.bg.$value = '#8a8a8a';
    doc.color.semantic.text.$value = '#7c7c7c';
    writeFileSync(tokensPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

    const run = runCli(['build', dir, '--check']);
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stdout).toContain('Built brand/dist/'); // the build still happened
    expect(run.stderr).toContain('WCAG 2 AA FAIL');
    expect(run.stderr).toContain('color.semantic.text');
  });

  it('#19: a subset rebuild prunes a manifest.outputs entry whose dist file was deleted', () => {
    const dir = initAndBuild();
    const distDir = path.join(dir, 'brand', 'dist');
    // delete one emitted output, then rebuild only a DIFFERENT emitter
    rmSync(path.join(distDir, 'components.css'));
    const run = runCli(['build', dir, '--emit', 'tw']);
    expect(run.status).toBe(EXIT_OK);
    expect(run.stderr).toContain('pruned'); // the merge warning
    const manifest = JSON.parse(readFileSync(path.join(distDir, 'manifest.json'), 'utf8')) as {
      outputs: Record<string, string>;
    };
    expect(manifest.outputs['components.css']).toBeUndefined(); // pruned (file gone)
    expect(manifest.outputs['theme.tw.css']).toBeDefined(); // the regenerated one stays
  });
});
