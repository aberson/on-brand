/**
 * Step 3 integration tests through the PRODUCTION entry point (spawn
 * `node bin/onbrand.mjs init/build` like cli.build.test.ts), covering the
 * step's Done-when:
 *   - golden byte-match for theme.ts / tokens.py / theme.tw.css,
 *   - emitted theme.ts passes `tsc --noEmit` in a minimal harness project
 *     (including a consumer file that pins the as-const literal typing),
 *   - emitted tokens.py imports cleanly via a real `python` subprocess
 *     (skipped with a loud warning only when python is genuinely absent),
 *   - theme.tw.css parses (postcss) and contains a valid @theme block with
 *     the dark companion blocks after it,
 *   - determinism of all three is covered by cli.build.test.ts's
 *     whole-dist byte-identity test.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss, { type AtRule, type Declaration, type Rule } from 'postcss';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_OK } from '../src/cli.ts';

const BIN = fileURLToPath(new URL('../bin/onbrand.mjs', import.meta.url));
const GOLDEN_DIR = fileURLToPath(new URL('./golden/', import.meta.url));

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-emitters-'));
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

/** init + build a fresh default-preset project once; share across tests. */
let builtProject: string | undefined;
function initAndBuild(): string {
  if (builtProject !== undefined) return builtProject;
  const dir = tempDir();
  expect(runCli(['init', dir]).status).toBe(EXIT_OK);
  expect(runCli(['build', dir]).status).toBe(EXIT_OK);
  builtProject = dir;
  return dir;
}

const distPath = (dir: string, file: string): string => path.join(dir, 'brand', 'dist', file);

// --- python availability probe (the guard the step demands) -----------------

const pythonProbe = spawnSync('python', ['--version'], { encoding: 'utf8', timeout: 30_000 });
const hasPython = pythonProbe.status === 0;
if (!hasPython) {
  // Loud, unmissable skip note — on this machine python IS expected on PATH.
  console.warn(
    '[emitters.e2e] WARNING: `python` not found on PATH — the tokens.py import test is SKIPPED. ' +
      'Install Python or fix PATH to restore the execution harness.',
  );
}

// --- tsc resolution (devDependency; run through the node executable) --------

const require = createRequire(import.meta.url);
function tscBinPath(): string {
  // require.resolve('typescript') -> <pkg>/lib/typescript.js; the CLI lives at <pkg>/bin/tsc
  const lib = require.resolve('typescript');
  const bin = path.join(path.dirname(lib), '..', 'bin', 'tsc');
  expect(existsSync(bin), `tsc bin not found at ${bin}`).toBe(true);
  return bin;
}

describe('Step 3 emitters (spawned through bin/onbrand.mjs)', () => {
  it.each(['theme.ts', 'tokens.py', 'theme.tw.css'] as const)(
    'matches the committed golden %s for the default preset, byte for byte',
    (file) => {
      const dir = initAndBuild();
      const emitted = readFileSync(distPath(dir, file), 'utf8');
      const golden = readFileSync(path.join(GOLDEN_DIR, file), 'utf8');
      // utf8 string equality IS byte equality here (CR/BOM would survive decode)
      expect(emitted).toBe(golden);
    },
  );

  it('emitted theme.ts passes tsc --noEmit (strict) with a literal-typing consumer', () => {
    const dir = initAndBuild();
    const harness = tempDir();
    copyFileSync(distPath(dir, 'theme.ts'), path.join(harness, 'theme.ts'));

    // The consumer pins the contract the emitter promises: exact-path access,
    // as-const literal types, deep readonly-ness.
    writeFileSync(
      path.join(harness, 'consumer.ts'),
      [
        "import { theme, darkTheme, type Theme } from './theme';",
        '',
        '// as-const literal types (not just string/number)',
        "const litBg: '#fcfcfd' = theme.color.semantic.bg;",
        "const darkBg: '#14181f' = darkTheme.color.semantic.bg;",
        'const bold: 700 = theme.type.weight.bold;',
        '// hyphenated token names are quoted keys, reachable by bracket access',
        "const muted: string = theme.color.semantic['text-muted'];",
        '// arrays and shadow objects survive as data',
        'const sans: readonly string[] = theme.font.sans;',
        "const blur: string = theme.shadow['elevation-2'].blur;",
        'const whole: Theme = theme;',
        '// @ts-expect-error the tree is deeply readonly (as const)',
        "theme.color.semantic.bg = '#000000';",
        'export { litBg, darkBg, bold, muted, sans, blur, whole };',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      path.join(harness, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            lib: ['ES2022'],
            skipLibCheck: true,
          },
          files: ['theme.ts', 'consumer.ts'],
        },
        null,
        2,
      ),
      'utf8',
    );

    const result = spawnSync(process.execPath, [tscBinPath(), '-p', harness], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(result.status, `tsc output:\n${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it.runIf(hasPython)('emitted tokens.py imports cleanly and holds the contract values', () => {
    const dir = initAndBuild();
    const script = [
      'import sys',
      'sys.path.insert(0, sys.argv[1])',
      'import tokens',
      'assert tokens.COLOR_SEMANTIC_BG == "#fcfcfd"',
      'assert tokens.DARK_COLOR_SEMANTIC_BG == "#14181f"',
      'assert tokens.COLOR_SEMANTIC_TEXT_MUTED == "#566070"',
      'assert len(tokens.CHART_CATEGORICAL) == 8',
      'assert tokens.CHART_CATEGORICAL[0] == tokens.COLOR_CHART_CATEGORICAL_1',
      'assert len(tokens.DARK_CHART_CATEGORICAL) == 8',
      'assert tokens.DARK_CHART_CATEGORICAL[0] == tokens.DARK_COLOR_CHART_CATEGORICAL_1',
      'assert tokens.TYPE_WEIGHT_BOLD == 700',
      'assert tokens.DARK_TYPE_WEIGHT_BOLD == 700',
      'assert tokens.SHADOW_ELEVATION_1["blur"] == "2px"',
      'assert tokens.MOTION_EASING_STANDARD == [0.4, 0, 0.2, 1]',
      'assert tokens.DARK_RADIUS_MD == tokens.RADIUS_MD',
      'print("TOKENS_PY_OK")',
    ].join('\n');
    const result = spawnSync('python', ['-c', script, path.join(dir, 'brand', 'dist')], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status, `python output:\n${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('TOKENS_PY_OK');
  });

  it('theme.tw.css parses cleanly and contains a valid @theme block + dark companions', () => {
    const dir = initAndBuild();
    const content = readFileSync(distPath(dir, 'theme.tw.css'), 'utf8');
    const root = postcss.parse(content);

    const themes = root.nodes.filter((n): n is AtRule => n.type === 'atrule' && n.name === 'theme');
    expect(themes).toHaveLength(1);
    const theme = themes[0]!;
    expect(theme.params).toBe(''); // plain @theme — NOT inline/static (dark flip contract)

    // every node inside @theme is a --var declaration; the default preset maps a lot of them
    const decls = (theme.nodes ?? []).filter((n): n is Declaration => n.type === 'decl');
    expect(decls).toHaveLength(theme.nodes?.length ?? -1);
    expect(decls.length).toBeGreaterThan(100);
    for (const decl of decls) {
      expect(decl.prop.startsWith('--')).toBe(true);
    }
    // one declaration per verified namespace we map
    for (const ns of [
      '--color-',
      '--font-',
      '--text-',
      '--font-weight-',
      '--leading-',
      '--spacing-',
      '--radius-',
      '--shadow-',
      '--ease-',
    ]) {
      expect(decls.some((d) => d.prop.startsWith(ns)), ns).toBe(true);
    }
    // no invented namespace for durations; they are listed as unmapped instead
    expect(decls.some((d) => d.prop.startsWith('--duration'))).toBe(false);
    expect(content).toContain('motion.duration.fast');

    // dark companions: @media then [data-theme="dark"], both AFTER @theme
    const media = root.nodes.find((n): n is AtRule => n.type === 'atrule' && n.name === 'media');
    const dataTheme = root.nodes.find(
      (n): n is Rule => n.type === 'rule' && n.selector === '[data-theme="dark"]',
    );
    expect(media?.params).toBe('(prefers-color-scheme: dark)');
    expect(dataTheme).toBeDefined();
    expect(root.index(media!)).toBeGreaterThan(root.index(theme));
    expect(root.index(dataTheme!)).toBeGreaterThan(root.index(media!));

    // every dark-overridden property re-declares a property that exists in @theme
    const themeProps = new Set(decls.map((d) => d.prop));
    dataTheme!.walkDecls((decl) => {
      expect(themeProps.has(decl.prop), decl.prop).toBe(true);
    });
    // spot-check the mode flip on the semantic pair
    expect(content).toContain('--color-semantic-bg: #fcfcfd;');
    expect(content).toContain('--color-semantic-bg: #14181f;');
  });

  it.each(['ts', 'py', 'tw'] as const)(
    '--emit %s alone works through the CLI (file written, manifest records only it)',
    (id) => {
      const dir = tempDir();
      expect(runCli(['init', dir]).status).toBe(EXIT_OK);
      expect(runCli(['build', dir, '--emit', id]).status).toBe(EXIT_OK);
      const outputFile = { ts: 'theme.ts', py: 'tokens.py', tw: 'theme.tw.css' }[id];
      expect(existsSync(distPath(dir, outputFile))).toBe(true);
      expect(existsSync(distPath(dir, 'tokens.css'))).toBe(false); // subset means subset
      const manifest = JSON.parse(readFileSync(distPath(dir, 'manifest.json'), 'utf8')) as {
        emitters: string[];
      };
      expect(manifest.emitters).toEqual([id]);
    },
  );
});

// ---------------------------------------------------------------------------
// Step 3's NEW gates driven through the spawned CLI against real tokens.json
// content (the compileBrand-level versions live in build.compile.test.ts).
// ---------------------------------------------------------------------------

describe('Step 3 gates through the spawned CLI (real failing builds)', () => {
  /** init a fresh project and mutate its real brand/tokens.json. */
  function initProjectWith(mutate: (doc: Record<string, any>) => void): string {
    const dir = tempDir();
    expect(runCli(['init', dir]).status).toBe(EXIT_OK);
    const tokensPath = path.join(dir, 'brand', 'tokens.json');
    const doc = JSON.parse(readFileSync(tokensPath, 'utf8')) as Record<string, any>;
    mutate(doc);
    writeFileSync(tokensPath, JSON.stringify(doc, null, 2), 'utf8');
    return dir;
  }

  function expectNoDist(dir: string): void {
    expect(existsSync(distPath(dir, 'manifest.json'))).toBe(false);
    expect(existsSync(distPath(dir, 'tokens.py'))).toBe(false);
    expect(existsSync(distPath(dir, 'theme.tw.css'))).toBe(false);
  }

  it('py DARK_ collision: `build --emit py` exits 1 naming both parties; css builds clean', () => {
    const dir = initProjectWith((doc) => {
      doc['foo'] = { $type: 'color', $value: '#222222' };
      doc['dark'] = { $type: 'color', foo: { $value: '#111111' } };
    });
    const run = runCli(['build', dir, '--emit', 'py']);
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).toContain('DARK_FOO');
    expect(run.stderr).toContain('dark.foo');
    expect(run.stderr).toContain('dark-mode constant');
    expectNoDist(dir);
    expect(runCli(['build', dir, '--emit', 'css']).status).toBe(EXIT_OK);
  });

  it('py reserved-name collision: `build --emit py` exits 1 naming CHART_CATEGORICAL; css builds clean', () => {
    const dir = initProjectWith((doc) => {
      doc['chart'] = { categorical: { $type: 'color', $value: '#123456' } };
    });
    const run = runCli(['build', dir, '--emit', 'py']);
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).toContain('CHART_CATEGORICAL');
    expect(run.stderr).toContain('chart.categorical');
    expect(run.stderr).toContain('reserved list constant');
    expectNoDist(dir);
    expect(runCli(['build', dir, '--emit', 'css']).status).toBe(EXIT_OK);
  });

  it('tw remap collision (font.weight-bold vs type.weight.bold): fails --emit tw, passes --emit css', () => {
    // Codifies the reviewer's live repro: both tokens land on --font-weight-bold
    // under the tw namespace remap, while their RAW css vars differ.
    const dir = initProjectWith((doc) => {
      doc.font['weight-bold'] = { $value: 'Inter' };
    });
    const run = runCli(['build', dir, '--emit', 'tw']);
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).toContain('--font-weight-bold');
    expect(run.stderr).toContain('font.weight-bold');
    expect(run.stderr).toContain('type.weight.bold');
    expectNoDist(dir);
    expect(runCli(['build', dir, '--emit', 'css']).status).toBe(EXIT_OK);
  });

  it('declaration-breakout value: schema-valid hostile color fails BOTH --emit css and --emit tw', () => {
    // Passes colorSchema (a "fn(...)" string ending in ")") but would escape
    // its declaration; from-url (Steps 11-12) makes this a real input path.
    const dir = initProjectWith((doc) => {
      doc.color.semantic.bg.$value = 'rgb(0,0,0); } html { --pwn: url(x)';
    });
    for (const emit of ['css', 'tw'] as const) {
      const run = runCli(['build', dir, '--emit', emit]);
      expect(run.status, emit).toBe(EXIT_FAILURE);
      expect(run.stderr, emit).toContain('color.semantic.bg');
      expect(run.stderr, emit).toContain('forbidden');
    }
    expectNoDist(dir);
  });
});
