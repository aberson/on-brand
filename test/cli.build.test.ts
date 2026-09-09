/**
 * Integration tests for `onbrand build` through the PRODUCTION entry point:
 * spawn `node bin/onbrand.mjs ...` (exactly what package.json "bin" points
 * at) against a fresh `onbrand init` temp project — the full producer ->
 * consumer round trip the step's Done-when demands:
 *   - golden snapshot byte-match for the default preset,
 *   - emitted CSS parses cleanly (postcss),
 *   - dark values from modes.dark.json appear in BOTH dark blocks,
 *   - two consecutive builds are byte-identical (manifest included),
 *   - manifest hash changes iff sources change,
 *   - validation failure -> exit 1 with path-precise errors (plan.md §6).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss, { type AtRule, type Rule } from 'postcss';
import { afterAll, describe, expect, it } from 'vitest';
import { tokenPathToCssVar } from '../src/build/emitters/css.ts';
import { DIST_PUBLICATION_LOCK_FILE } from '../src/build/publication-lock.ts';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../src/cli.ts';

const BIN = fileURLToPath(new URL('../bin/onbrand.mjs', import.meta.url));
const GOLDEN_CSS = fileURLToPath(new URL('./golden/tokens.css', import.meta.url));

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-build-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** init + build a fresh default-preset project; returns the project dir. */
function initAndBuild(): string {
  const dir = tempDir();
  expect(runCli(['init', dir]).status).toBe(EXIT_OK);
  const build = runCli(['build', dir]);
  expect(build.status).toBe(EXIT_OK);
  return dir;
}

const distPath = (dir: string, file: string): string => path.join(dir, 'brand', 'dist', file);

/** Collect { prop: value } for every custom property directly inside a container. */
function declMap(container: AtRule | Rule): Map<string, string> {
  const map = new Map<string, string>();
  container.walkDecls((decl) => {
    map.set(decl.prop, decl.value);
  });
  return map;
}

describe('onbrand build (spawned through bin/onbrand.mjs)', () => {
  it('matches the committed golden tokens.css for the default preset, byte for byte', () => {
    const dir = initAndBuild();
    const emitted = readFileSync(distPath(dir, 'tokens.css'), 'utf8');
    const golden = readFileSync(GOLDEN_CSS, 'utf8');
    // utf8 string equality IS byte equality here (CR/BOM would survive decode)
    expect(emitted).toBe(golden);
  });

  it('emits CSS that postcss parses cleanly, with the contract block structure', () => {
    const dir = initAndBuild();
    const root = postcss.parse(readFileSync(distPath(dir, 'tokens.css'), 'utf8'));

    const layers = root.nodes.filter((n): n is AtRule => n.type === 'atrule' && n.name === 'layer');
    expect(layers).toHaveLength(1);
    const layer = layers[0]!;
    expect(layer.params).toBe('tokens');

    // Exactly four children, in contract order (plan.md §3.1): the light :root
    // base, the two dark opt-ins, then the [data-theme="light"] reassert that
    // lets an explicit light choice win over an OS-dark @media match (M1 fix).
    const children = layer.nodes ?? [];
    expect(children).toHaveLength(4);
    expect(children[0]!.type).toBe('rule');
    expect((children[0] as Rule).selector).toBe(':root');
    expect(children[1]!.type).toBe('atrule');
    expect((children[1] as AtRule).name).toBe('media');
    expect((children[1] as AtRule).params).toBe('(prefers-color-scheme: dark)');
    expect(children[2]!.type).toBe('rule');
    expect((children[2] as Rule).selector).toBe('[data-theme="dark"]');
    expect(children[3]!.type).toBe('rule');
    expect((children[3] as Rule).selector).toBe('[data-theme="light"]');

    // Nothing outside @layer tokens except the header comment.
    expect(root.nodes.filter((n) => n.type !== 'comment' && n !== layer)).toHaveLength(0);
  });

  it('surfaces every modes.dark.json color value in BOTH dark blocks (overlay -> css round trip)', () => {
    const dir = initAndBuild();
    const root = postcss.parse(readFileSync(distPath(dir, 'tokens.css'), 'utf8'));
    const layer = root.nodes.find((n): n is AtRule => n.type === 'atrule' && n.name === 'layer')!;
    const [lightRule, mediaAt, themeRule] = layer.nodes as [Rule, AtRule, Rule];
    const light = declMap(lightRule);
    const mediaDark = declMap(mediaAt);
    const themeDark = declMap(themeRule);

    // Flatten the overlay the project actually holds (the producer side).
    const overlay = JSON.parse(
      readFileSync(path.join(dir, 'brand', 'modes.dark.json'), 'utf8'),
    ) as Record<string, unknown>;
    const overrides: Array<{ varName: string; value: string }> = [];
    const collect = (node: Record<string, unknown>, segs: string[]): void => {
      for (const [name, child] of Object.entries(node)) {
        if (name.startsWith('$') || typeof child !== 'object' || child === null) continue;
        const childRecord = child as Record<string, unknown>;
        if (typeof childRecord['$value'] === 'string') {
          overrides.push({
            varName: tokenPathToCssVar([...segs, name]),
            value: childRecord['$value'],
          });
        } else {
          collect(childRecord, [...segs, name]);
        }
      }
    };
    collect(overlay, []);

    expect(overrides.length).toBeGreaterThan(50); // the default overlay is rich
    for (const { varName, value } of overrides) {
      expect(mediaDark.get(varName)).toBe(value);
      expect(themeDark.get(varName)).toBe(value);
      expect(light.has(varName)).toBe(true); // every dark override has a light base
      expect(light.get(varName)).not.toBe(undefined);
    }
    // spot-check the semantic pair is actually mode-differentiated
    expect(light.get('--color-semantic-bg')).toBe('#fcfcfd');
    expect(mediaDark.get('--color-semantic-bg')).toBe('#14181f');
  });

  it('two consecutive builds are byte-identical across all of dist/ (manifest included)', () => {
    const dir = initAndBuild();
    const distDir = path.join(dir, 'brand', 'dist');
    const files = readdirSync(distDir).sort();
    // every Step-2/Step-3/Step-4 output is present and covered by the comparison
    expect(files).toEqual([
      'DESIGN.md',
      'components.css',
      'diagram-palette.json',
      'manifest.json',
      'palette.svg',
      'theme.ts',
      'theme.tw.css',
      'tokens.css',
      'tokens.py',
    ]);
    const first = new Map(files.map((f) => [f, readFileSync(path.join(distDir, f))]));
    expect(runCli(['build', dir]).status).toBe(EXIT_OK);
    for (const f of files) {
      expect(readFileSync(path.join(distDir, f)).equals(first.get(f)!), f).toBe(true);
    }
  });

  it('manifest hash changes iff sources change (CRLF-only churn does NOT count)', () => {
    const dir = initAndBuild();
    const tokensPath = path.join(dir, 'brand', 'tokens.json');
    const manifest1 = readFileSync(distPath(dir, 'manifest.json'), 'utf8');

    // 1. line-ending churn only: hash and manifest unchanged
    const original = readFileSync(tokensPath, 'utf8');
    const lfOnly = original.replaceAll('\r\n', '\n');
    writeFileSync(tokensPath, lfOnly.replaceAll('\n', '\r\n'), 'utf8');
    expect(runCli(['build', dir]).status).toBe(EXIT_OK);
    expect(readFileSync(distPath(dir, 'manifest.json'), 'utf8')).toBe(manifest1);

    // 2. real content change: hash changes
    writeFileSync(tokensPath, original.replace('#3b63a8', '#3b63a9'), 'utf8');
    expect(runCli(['build', dir]).status).toBe(EXIT_OK);
    const manifest2 = JSON.parse(readFileSync(distPath(dir, 'manifest.json'), 'utf8')) as {
      sourceHash: string;
    };
    expect(manifest2.sourceHash).not.toBe(
      (JSON.parse(manifest1) as { sourceHash: string }).sourceHash,
    );
  });

  it('exits 1 with a path-precise error on invalid tokens', () => {
    const dir = tempDir();
    expect(runCli(['init', dir]).status).toBe(EXIT_OK);
    const tokensPath = path.join(dir, 'brand', 'tokens.json');
    const doc = JSON.parse(readFileSync(tokensPath, 'utf8')) as {
      color: { semantic: { bg: { $value: unknown } } };
    };
    doc.color.semantic.bg.$value = 42;
    writeFileSync(tokensPath, JSON.stringify(doc, null, 2), 'utf8');

    const run = runCli(['build', dir]);
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).toContain('color.semantic.bg');
    // failed build must not have produced dist output
    expect(existsSync(distPath(dir, 'tokens.css'))).toBe(false);
  });

  it('subset builds keep per-output provenance: a stale tokens.css stays guard-detectable', () => {
    const dir = initAndBuild();
    type ManifestShape = { sourceHash: string; outputs: Record<string, string>; emitters: string[] };
    const readManifest = (): ManifestShape =>
      JSON.parse(readFileSync(distPath(dir, 'manifest.json'), 'utf8')) as ManifestShape;

    const m1 = readManifest();
    expect(m1.outputs['tokens.css']).toBe(m1.sourceHash); // fresh full build

    // Edit sources, then a subset build that does NOT regenerate tokens.css.
    const tokensPath = path.join(dir, 'brand', 'tokens.json');
    const original = readFileSync(tokensPath, 'utf8');
    writeFileSync(tokensPath, original.replace('#3b63a8', '#0000aa'), 'utf8');
    const cssBefore = readFileSync(distPath(dir, 'tokens.css'), 'utf8');
    expect(runCli(['build', dir, '--emit', 'tw']).status).toBe(EXIT_OK);

    const m2 = readManifest();
    expect(readFileSync(distPath(dir, 'tokens.css'), 'utf8')).toBe(cssBefore); // css untouched
    expect(m2.sourceHash).not.toBe(m1.sourceHash); // top-level hash freshened...
    expect(m2.outputs['tokens.css']).toBe(m1.sourceHash); // ...but the entry carried forward
    expect(m2.outputs['tokens.css']).not.toBe(m2.sourceHash); // guard-detectable stale
    expect(m2.emitters).toEqual(['tw']); // only the requested emitter ran
    expect(m2.outputs['theme.tw.css']).toBe(m2.sourceHash); // the regenerated output is fresh

    // Regenerating css re-stamps its provenance to the current sources.
    expect(runCli(['build', dir, '--emit', 'css']).status).toBe(EXIT_OK);
    const m3 = readManifest();
    expect(m3.outputs['tokens.css']).toBe(m3.sourceHash);
    expect(m3.sourceHash).toBe(m2.sourceHash);
  });

  it.each([
    { mode: 'full', extra: [] as string[] },
    { mode: 'subset', extra: ['--emit', 'css'] },
  ])(
    '$mode production builds fail closed behind a live publication owner',
    ({ extra }) => {
      const dir = initAndBuild();
      const manifestPath = distPath(dir, 'manifest.json');
      const before = readFileSync(manifestPath);
      const lockPath = path.join(dir, 'brand', DIST_PUBLICATION_LOCK_FILE);
      const lock = `${JSON.stringify({
        runToken: '11111111-1111-1111-8111-111111111111',
        pid: process.pid,
        startedAt: '2026-08-21T00:00:00.000Z',
      })}\n`;
      writeFileSync(lockPath, lock, { encoding: 'utf8', flag: 'wx' });

      const run = runCli(['build', dir, ...extra]);
      expect(run.status).toBe(EXIT_FAILURE);
      expect(run.stderr).toContain('dist publication lock');
      expect(run.stderr).toContain(`PID ${process.pid}`);
      expect(readFileSync(manifestPath)).toEqual(before);
      expect(readFileSync(lockPath, 'utf8')).toBe(lock);
      rmSync(lockPath);
    },
  );

  it('exits 1 naming both tokens when distinct dot paths collide on one CSS var', () => {
    const dir = tempDir();
    expect(runCli(['init', dir]).status).toBe(EXIT_OK);
    const tokensPath = path.join(dir, 'brand', 'tokens.json');
    const doc = JSON.parse(readFileSync(tokensPath, 'utf8')) as {
      color: { semantic: Record<string, unknown> };
    };
    // color.semantic.code.bg collides with the preset's color.semantic.code-bg
    doc.color.semantic['code'] = { bg: { $value: '#ffffff' } };
    writeFileSync(tokensPath, JSON.stringify(doc, null, 2), 'utf8');

    const run = runCli(['build', dir]);
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).toContain('--color-semantic-code-bg');
    expect(run.stderr).toContain('color.semantic.code-bg');
    expect(run.stderr).toContain('color.semantic.code.bg');
    // the refused build wrote nothing
    expect(existsSync(distPath(dir, 'tokens.css'))).toBe(false);
    expect(existsSync(distPath(dir, 'manifest.json'))).toBe(false);
  });

  it('exits 1 with an init hint when there is no brand/', () => {
    const run = runCli(['build', tempDir()]);
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).toContain('onbrand init');
  });

  it('default build runs all seven emitters with no skip note; --emit css is clean too', () => {
    const dir = tempDir();
    expect(runCli(['init', dir]).status).toBe(EXIT_OK);
    const all = runCli(['build', dir]);
    expect(all.status).toBe(EXIT_OK);
    // Step 4 made svg + components live, designmd landed post-v1: no skips.
    expect(all.stdout).toContain('css, tw, ts, py, svg, components, designmd');
    expect(all.stderr).not.toContain('skipped');
    // svg ran, so the guide palette fence was refreshed (reported on stdout)
    expect(all.stdout).toContain('palette fence refreshed');

    const cssOnly = runCli(['build', dir, '--emit', 'css']);
    expect(cssOnly.status).toBe(EXIT_OK);
    expect(cssOnly.stderr).toBe('');
    // css-only did NOT run svg, so guide.md is left untouched (no fence note)
    expect(cssOnly.stdout).not.toContain('palette fence');
  });

  it('rejects unknown emitter names with exit 2, listing the valid set', () => {
    const dir = tempDir();
    expect(runCli(['init', dir]).status).toBe(EXIT_OK);
    const run = runCli(['build', dir, '--emit', 'css,less']);
    expect(run.status).toBe(EXIT_USAGE);
    expect(run.stderr).toContain('"less"');
    expect(run.stderr).toContain('css, tw, ts, py, svg, components, designmd');
    expect(existsSync(distPath(dir, 'manifest.json'))).toBe(false); // usage errors write nothing
  });

  it('build --check builds then runs the gate (default preset passes, exit 0)', () => {
    const dir = tempDir();
    expect(runCli(['init', dir]).status).toBe(EXIT_OK);
    const run = runCli(['build', dir, '--check']);
    expect(run.status).toBe(EXIT_OK);
    // the build happened...
    expect(run.stdout).toContain('Built brand/dist/');
    expect(existsSync(distPath(dir, 'manifest.json'))).toBe(true);
    // ...and the SAME gate ran post-build (report goes to stderr).
    expect(run.stderr).toContain('check PASS');
    expect(run.stderr).toContain('WCAG 2 AA');
  });

  it('build --help exits 0 and documents --emit', () => {
    const run = runCli(['build', '--help']);
    expect(run.status).toBe(EXIT_OK);
    expect(run.stdout).toContain('--emit');
  });
});
