/**
 * Step 6 unit + contract tests for src/preview (dist-parse.ts + render.ts +
 * specimen.ts). What this file pins that the spawned e2e
 * (preview.e2e.test.ts) can't cheaply prove:
 *   1. ZERO-LITERAL GREP GATE (Step 6 Done-when) on the rendered HTML — via
 *      the shared scanner in test/helpers/color-literals.ts, with a
 *      calibration anchor (measurement-validity: a scanner that can't fail
 *      garbage can't gate). The ONE fenced diagram-palette island is
 *      excluded; everything authored is literal-free.
 *   2. DIST-ONLY ENFORCEMENT (plan §7 "uses only dist/ outputs — enforced by
 *      test"): an AST walk (TypeScript compiler API — covers import/export
 *      declarations, dynamic import(), and require(), so no regex blind spot)
 *      over EVERY src/preview file, asserting each specifier is a node
 *      builtin, a preview sibling, or on the justified whitelist (the shared
 *      naming.ts guards) — and that the whitelist doesn't rot.
 *   3. The dist-output PARSERS + untrusted-input guards, branch by branch
 *      (cssVarNames var-name guard incl. the var()-fallback smuggle,
 *      forbiddenCssValueSequence one case per forbidden class,
 *      parseDiagramPalette fail-loud paths).
 *   4. openInBrowser command COMPOSITION through the injectable spawn seam
 *      (all three platform branches; the win32 PowerShell -FilePath shape
 *      that neutralizes cmd.exe %VAR%-expansion) — no browser ever launches.
 *      Plus a win32-only regression check against the REAL Start-Process
 *      cmdlet (the composition seam can't catch a wrong-but-well-formed param
 *      name; -LiteralPath shipped once and threw at runtime — M1 UAT finding).
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import {
  PreviewError,
  badgeNames,
  cssVarNames,
  firstFontFamily,
  forbiddenCssValueSequence,
  loadableGoogleFonts,
  parseDiagramPalette,
  varsWithPrefix,
} from '../src/preview/dist-parse.ts';
import { googleFontsLink, renderSpecimen, type SpecimenModel } from '../src/preview/render.ts';
import { openInBrowser } from '../src/preview/specimen.ts';
import { findColorLiterals, stripDiagramFence } from './helpers/color-literals.ts';

/** A representative model with hex diagram values + chart vars + badges. */
function sampleModel(): SpecimenModel {
  return {
    chartCategorical: ['--color-chart-categorical-1', '--color-chart-categorical-2'],
    chartSequential: ['--color-chart-sequential-1', '--color-chart-sequential-2'],
    chartChrome: ['--color-chart-chrome-grid', '--color-chart-chrome-axis'],
    statusBadges: ['success', 'warning', 'danger'],
    diagram: [
      { key: 'canvas', className: 'dsw--canvas', light: '#f5f7fc', dark: '#161c26' },
      { key: 'node-fill', className: 'dsw--node-fill', light: '#ffffff', dark: '#1f2733' },
    ],
    hasPaletteSvg: true,
    fonts: ['Inter', 'JetBrains Mono'],
  };
}

describe('findColorLiterals calibration anchor (shared helper)', () => {
  it('flags hex + color functions, ignores var() references', () => {
    expect(findColorLiterals('color: #abcdef')).toContain('#abcdef');
    expect(findColorLiterals('a #fff b #1f242c29 c')).toEqual(['#fff', '#1f242c29']);
    expect(findColorLiterals('background: oklch(0.6 0.1 250)')).toContain('oklch(');
    expect(findColorLiterals('background: rgb(0 0 0)')).toContain('rgb(');
    expect(findColorLiterals('background: var(--color-chart-categorical-1)')).toEqual([]);
    expect(findColorLiterals('.dsw--canvas { }')).toEqual([]);
  });
});

describe('renderSpecimen — zero authored color literals (grep gate)', () => {
  it('has ZERO color literals outside the fenced diagram-palette island', () => {
    const html = renderSpecimen(sampleModel());
    const authored = stripDiagramFence(html);
    expect(findColorLiterals(authored), `authored literals: ${findColorLiterals(authored).join(', ')}`).toEqual([]);
  });

  it("the fence DID carry the dist-sourced values (so we actually excluded something real)", () => {
    const html = renderSpecimen(sampleModel());
    // the whole doc contains the hex (proving it is embedded from the model)...
    expect(findColorLiterals(html)).toContain('#161c26');
    expect(html).toContain('onbrand:begin diagram-palette'); // guide-render marker scheme
    expect(html).toContain('onbrand:end diagram-palette');
    // ...and every one of those hits lives inside the fence, nowhere else.
    expect(findColorLiterals(stripDiagramFence(html))).toEqual([]);
  });

  it('CALIBRATION: a hex planted OUTSIDE the fence is caught by the gate', () => {
    const html = renderSpecimen(sampleModel());
    const tampered = html.replace('<body>', '<body style="background:#deadbe">');
    expect(findColorLiterals(stripDiagramFence(tampered))).toContain('#deadbe');
  });

  it('links tokens.css + components.css (not inlined) and wires the a11y toggle', () => {
    const html = renderSpecimen(sampleModel());
    expect(html).toContain('<link rel="stylesheet" href="tokens.css">');
    expect(html).toContain('<link rel="stylesheet" href="components.css">');
    expect(html).toContain('id="theme-toggle"');
    expect(html).toContain('aria-pressed');
    expect(html).toContain('<button'); // native button => keyboard-accessible
    expect(html).toContain('data-theme="light"'); // initial state
    // status badges are project-derived (from the model)
    expect(html).toContain('badge--success');
    expect(html).toContain('badge--danger');
    // chart swatches use var() references
    expect(html).toContain('var(--color-chart-categorical-1)');
    // palette.svg referenced, not inlined
    expect(html).toContain('src="palette.svg"');
  });

  it('renders with an empty-ish brand (no chart/diagram/badge tokens) without literals or crash', () => {
    const empty: SpecimenModel = {
      chartCategorical: [],
      chartSequential: [],
      chartChrome: [],
      statusBadges: [],
      diagram: [],
      hasPaletteSvg: false,
      fonts: [],
    };
    const html = renderSpecimen(empty);
    expect(findColorLiterals(stripDiagramFence(html))).toEqual([]);
    expect(html).toContain('id="theme-toggle"');
    expect(html).not.toContain('src="palette.svg"'); // omitted when absent
  });
});

// ---------------------------------------------------------------------------
// dist-only enforcement (plan §7) — AST import graph, not a regex
// ---------------------------------------------------------------------------

const PREVIEW_DIR = fileURLToPath(new URL('../src/preview/', import.meta.url));

/**
 * The ONLY non-builtin, non-sibling specifiers src/preview may import, each
 * with its justification. Anything else — src/build emitters, src/schema,
 * a bare npm package — fails the walk below.
 */
const IMPORT_WHITELIST = new Map<string, string>([
  [
    '../filesystem.ts',
    'shared stable-read, file-identity, link-safety, and ownership-safe publication primitives',
  ],
  [
    '../build/emitters/naming.ts',
    'shared identifier char-class guards (pure functions, read no token data; one-source-of-truth over a drifting local copy)',
  ],
  [
    '../extract/fonts.ts',
    'loadable Google Fonts family set derived from the from-url lookalike table (pure data, reads no token data; one-source-of-truth over a drifting local copy)',
  ],
]);

/**
 * Every module specifier a file declares: import/export declarations PLUS
 * dynamic import() and require() calls (the regex blind spot the review
 * named). A non-literal dynamic specifier is reported as such and fails the
 * whitelist check loudly.
 */
function moduleSpecifiers(absPath: string): string[] {
  const sourceFile = ts.createSourceFile(absPath, readFileSync(absPath, 'utf8'), ts.ScriptTarget.ES2022, true);
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if (isDynamicImport || isRequire) {
        const arg = node.arguments[0];
        specs.push(
          arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : '<non-literal dynamic specifier>',
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specs;
}

describe('dist-only enforcement (plan §7)', () => {
  it('every src/preview file imports only node builtins, preview siblings, or the justified whitelist', () => {
    const files = readdirSync(PREVIEW_DIR).filter((f) => f.endsWith('.ts'));
    expect(files.length, 'expected the split preview modules').toBeGreaterThanOrEqual(3);
    const usedWhitelist = new Set<string>();
    let totalSpecs = 0;
    for (const file of files) {
      for (const spec of moduleSpecifiers(path.join(PREVIEW_DIR, file))) {
        totalSpecs++;
        if (spec.startsWith('node:')) continue;
        if (spec.startsWith('./')) {
          // sibling within src/preview only — no traversal back out
          expect(spec.includes('..'), `${file}: sibling specifier traverses out: ${spec}`).toBe(false);
          continue;
        }
        expect(
          IMPORT_WHITELIST.has(spec),
          `${file} imports non-whitelisted specifier ${JSON.stringify(spec)} — src/preview consumes dist/ outputs only (plan §7)`,
        ).toBe(true);
        usedWhitelist.add(spec);
      }
    }
    expect(totalSpecs, 'the walk found no imports at all — scanner broken').toBeGreaterThan(5);
    // rot guard: every whitelist entry must still be a real import somewhere
    for (const spec of IMPORT_WHITELIST.keys()) {
      expect(usedWhitelist.has(spec), `whitelist entry no longer imported (remove it): ${spec}`).toBe(true);
    }
  });

  it('CALIBRATION: the specifier walk sees dynamic import() and require()', () => {
    // measurement-validity: prove the scanner catches what the old regex missed.
    const source = [
      "import a from 'node:fs';",
      "const b = await import('../build/compile.ts');",
      "const c = require('../schema/validate.ts');",
      'const d = await import(someVariable);',
    ].join('\n');
    const sf = ts.createSourceFile('inline.ts', source, ts.ScriptTarget.ES2022, true);
    const specs: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        specs.push(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) {
          const arg = node.arguments[0];
          specs.push(arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : '<non-literal dynamic specifier>');
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(specs).toContain('../build/compile.ts');
    expect(specs).toContain('../schema/validate.ts');
    expect(specs).toContain('<non-literal dynamic specifier>');
  });
});

// ---------------------------------------------------------------------------
// dist-output parsers
// ---------------------------------------------------------------------------

describe('cssVarNames — surface discovery + var-name guard (BUG-1)', () => {
  it('extracts custom-property names, first-seen, de-duplicated', () => {
    const css = [
      '@layer tokens {',
      '  :root {',
      '    --color-semantic-bg: #fcfcfd;',
      '    --color-chart-categorical-1: #3b63a8;',
      '    --space-4: 1rem;',
      '  }',
      '  [data-theme="dark"] {',
      '    --color-semantic-bg: #14181f;', // re-declared -> collapses to first
      '  }',
      '}',
    ].join('\n');
    const names = cssVarNames(css, 'dist/tokens.css');
    expect(names).toContain('--color-semantic-bg');
    expect(names).toContain('--color-chart-categorical-1');
    expect(names).toContain('--space-4');
    expect(names.filter((n) => n === '--color-semantic-bg')).toHaveLength(1); // de-duped
  });

  it('THROWS PreviewError on the var()-fallback smuggle shape (hostile hand-edited tokens.css)', () => {
    // `var(<name>, <fallback>)` — a comma+parens name would carry a url()
    // fallback (a CSS network-request primitive) into a style attribute.
    const css = ':root {\n  --x, url(https://evil.example/beacon.png): red;\n}';
    expect(() => cssVarNames(css, 'dist/tokens.css')).toThrow(PreviewError);
    expect(() => cssVarNames(css, 'dist/tokens.css')).toThrow(/not a safe/);
  });

  it('THROWS PreviewError on non-identifier and empty var names', () => {
    // one declaration per line — the shape tokens.css is actually emitted in
    // (and the only shape the line scanner reads)
    expect(() => cssVarNames(':root {\n  --wéird: red;\n}', 'x')).toThrow(PreviewError);
    expect(() => cssVarNames(':root {\n  --: red;\n}', 'x')).toThrow(PreviewError);
    expect(() => cssVarNames(':root {\n  --a b: red;\n}', 'x')).toThrow(PreviewError);
  });
});

describe('varsWithPrefix / badgeNames', () => {
  it('varsWithPrefix filters by prefix and orders numeric ramps by trailing number', () => {
    const names = [
      '--color-chart-categorical-10',
      '--color-chart-categorical-2',
      '--color-chart-categorical-1',
      '--color-semantic-bg',
    ];
    expect(varsWithPrefix(names, '--color-chart-categorical-', true)).toEqual([
      '--color-chart-categorical-1',
      '--color-chart-categorical-2',
      '--color-chart-categorical-10',
    ]);
    // non-numeric groups keep first-seen order
    expect(
      varsWithPrefix(['--color-chart-chrome-grid', '--color-chart-chrome-axis'], '--color-chart-chrome-', false),
    ).toEqual(['--color-chart-chrome-grid', '--color-chart-chrome-axis']);
  });

  it('badgeNames pulls .badge--<name> suffixes from components.css, de-duplicated', () => {
    const components = [
      '@layer components {',
      '  .badge--success { color: var(--color-status-success-fg); }',
      '  .badge--warning { color: var(--color-status-warning-fg); }',
      '  .badge--success:hover { }', // duplicate suffix -> counted once
      '}',
    ].join('\n');
    expect(badgeNames(components)).toEqual(['success', 'warning']);
  });
});

describe('forbiddenCssValueSequence — one case per forbidden class (BUG-2)', () => {
  const cases: Array<[value: string, exactDescription: string]> = [
    ['red; color: blue', '";"'],
    ['red { display', '"{"'],
    ['red } body', '"}"'],
    ['red < x', '"<"'],
    ['red > x', '">"'],
    ['red " x', 'quote character (")'],
    ["red ' x", "quote character (')"],
    ['red /* comment', 'comment delimiter "/*"'],
    ['red *' + '/ tail', 'comment delimiter "*' + '/"'],
  ];
  for (const [value, exactDescription] of cases) {
    it(`detects ${JSON.stringify(value)} as ${exactDescription}`, () => {
      expect(forbiddenCssValueSequence(value)).toBe(exactDescription);
    });
  }

  it('detects control characters (built via charCode — never authored raw)', () => {
    expect(forbiddenCssValueSequence(`red${String.fromCharCode(1)}x`)).toContain('control character');
    expect(forbiddenCssValueSequence(`red${String.fromCharCode(0x7f)}x`)).toContain('control character');
  });

  it('passes legitimate color values (hex, oklch, clamp with commas/parens)', () => {
    for (const value of ['#3b63a8', '#1f242c29', 'oklch(0.6 0.1 250)', 'clamp(0.8rem, 1vw, 1rem)', 'red']) {
      expect(forbiddenCssValueSequence(value), value).toBeUndefined();
    }
  });
});

describe('parseDiagramPalette — dist consumption + fail-loud guards', () => {
  it('parses light/dark values into ordered entries', () => {
    const json = JSON.stringify({
      light: { canvas: '#f5f7fc', 'node-fill': '#ffffff' },
      dark: { canvas: '#161c26', 'node-fill': '#1f2733' },
    });
    const entries = parseDiagramPalette(json, 'dist/diagram-palette.json');
    expect(entries.map((e) => e.key)).toEqual(['canvas', 'node-fill']);
    expect(entries[0]).toMatchObject({ key: 'canvas', className: 'dsw--canvas', light: '#f5f7fc', dark: '#161c26' });
  });

  it('falls back to the light value when a dark override is absent', () => {
    const json = JSON.stringify({ light: { canvas: '#f5f7fc' }, dark: {} });
    expect(parseDiagramPalette(json, 'x')[0]!.dark).toBe('#f5f7fc');
  });

  it('THROWS PreviewError on a hostile class-suffix key (selector break-out)', () => {
    const json = JSON.stringify({ light: { 'canvas { } body': '#000000' }, dark: {} });
    expect(() => parseDiagramPalette(json, 'x')).toThrow(PreviewError);
  });

  it('THROWS PreviewError on a value that could escape the <style> declaration', () => {
    const json = JSON.stringify({ light: { canvas: 'red; } body { display:none' }, dark: {} });
    expect(() => parseDiagramPalette(json, 'x')).toThrow(PreviewError);
  });

  it('THROWS PreviewError on a quote-carrying value (bad-string line-swallow, BUG-2)', () => {
    const json = JSON.stringify({ light: { canvas: 'red" x' }, dark: {} });
    expect(() => parseDiagramPalette(json, 'x')).toThrow(/quote/);
  });

  it('THROWS PreviewError on malformed JSON / missing light object', () => {
    expect(() => parseDiagramPalette('not json', 'x')).toThrow(PreviewError);
    expect(() => parseDiagramPalette('{}', 'x')).toThrow(PreviewError);
  });
});

// ---------------------------------------------------------------------------
// font loading — parse + Google-Fonts filter + link composition (pure seams)
// ---------------------------------------------------------------------------

describe('specimen webfont loading', () => {
  const tokensWithFonts = [
    '@layer tokens {',
    '  :root {',
    '    --font-sans: Inter, "Segoe UI", system-ui, sans-serif;',
    '    --font-heading: Manrope, Inter, "Segoe UI", system-ui, sans-serif;',
    '    --font-mono: "JetBrains Mono", "Cascadia Code", Consolas, monospace;',
    '  }',
    '}',
  ].join('\n');

  it('firstFontFamily parses the first-choice family and strips surrounding quotes', () => {
    expect(firstFontFamily(tokensWithFonts, '--font-sans')).toBe('Inter');
    expect(firstFontFamily(tokensWithFonts, '--font-heading')).toBe('Manrope');
    expect(firstFontFamily(tokensWithFonts, '--font-mono')).toBe('JetBrains Mono'); // quotes stripped
    expect(firstFontFamily(tokensWithFonts, '--font-display')).toBeUndefined(); // absent property
    // the trailing ":" keeps --font-sans from matching a --font-sans-serif line
    expect(firstFontFamily(':root {\n  --font-sans-serif: Nope, x;\n}', '--font-sans')).toBeUndefined();
  });

  it('loadableGoogleFonts keeps mapped Google families, deduped + order-stable (sans, heading, mono)', () => {
    // Inter / Manrope / JetBrains Mono are all curated Google Fonts families.
    expect(loadableGoogleFonts(tokensWithFonts)).toEqual(['Inter', 'Manrope', 'JetBrains Mono']);
  });

  it('a Verdana-only (system) stack yields NO loadable font — and no link', () => {
    const css = ':root {\n  --font-sans: Verdana, Geneva, sans-serif;\n}';
    expect(loadableGoogleFonts(css)).toEqual([]);
    expect(googleFontsLink(loadableGoogleFonts(css))).toBe('');
  });

  it('a variable-font blob ("Mona Sans VF") is not loaded either', () => {
    const css = ':root {\n  --font-sans: "Mona Sans VF", system-ui, sans-serif;\n}';
    expect(loadableGoogleFonts(css)).toEqual([]);
  });

  it('CALIBRATION: a hostile family carrying a quote is excluded (safe-by-construction)', () => {
    // In"ter fingerprints to "inter" (the quote is dropped) so it passes the
    // Google-family check, but the unsafe display name must NOT reach the markup.
    expect(loadableGoogleFonts(':root {\n  --font-sans: In"ter, system-ui;\n}')).toEqual([]);
  });

  it('reuses the from-url lookalike target set (one source of truth: Figtree, Source Code Pro load)', () => {
    const css = ':root {\n  --font-sans: Figtree, system-ui, sans-serif;\n  --font-mono: "Source Code Pro", monospace;\n}';
    expect(loadableGoogleFonts(css)).toEqual(['Figtree', 'Source Code Pro']);
  });

  it('googleFontsLink composes a fonts.googleapis.com stylesheet link (spaces -> "+")', () => {
    const link = googleFontsLink(['Inter', 'JetBrains Mono']);
    expect(link).toContain('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?');
    expect(link).toContain('family=Inter');
    expect(link).toContain('family=JetBrains+Mono'); // space -> +
    expect(link).toContain('display=swap');
    expect(googleFontsLink([])).toBe(''); // no families -> no link
  });

  it('renderSpecimen emits the link when fonts are present (and none when empty), adding no color literal', () => {
    const withFonts = renderSpecimen({ ...sampleModel(), fonts: ['Inter'] });
    expect(withFonts).toContain('https://fonts.googleapis.com/css2?family=Inter');
    // the added <link> introduces no color literal — the grep gate stays intact
    expect(findColorLiterals(stripDiagramFence(withFonts))).toEqual([]);

    const noFonts = renderSpecimen({ ...sampleModel(), fonts: [] });
    expect(noFonts).not.toContain('fonts.googleapis.com');
  });
});

// ---------------------------------------------------------------------------
// openInBrowser — command composition through the injectable seam (BUG-3)
// ---------------------------------------------------------------------------

interface SpawnCall {
  cmd: string;
  args: readonly string[];
  opts: Record<string, unknown>;
}

function fakeSpawn(): { calls: SpawnCall[]; spawnFn: typeof spawn } {
  const calls: SpawnCall[] = [];
  const child = {
    on: () => child,
    unref: () => undefined,
  };
  const spawnFn = ((cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, opts });
    return child;
  }) as unknown as typeof spawn;
  return { calls, spawnFn };
}

describe('openInBrowser — composed command per platform (no real launch)', () => {
  it('win32: PowerShell Start-Process -FilePath with the path in a single-quoted literal', () => {
    const { calls, spawnFn } = fakeSpawn();
    openInBrowser('C:\\proj\\brand\\dist\\specimen.html', { spawnFn, platform: 'win32' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('powershell.exe');
    expect(calls[0]!.args).toContain('-NoProfile');
    expect(calls[0]!.args).toContain('-NonInteractive');
    const command = calls[0]!.args[calls[0]!.args.length - 1]!;
    expect(command).toBe(
      "$ErrorActionPreference='Stop'; Start-Process -FilePath 'C:\\proj\\brand\\dist\\specimen.html'",
    );
    expect(calls[0]!.opts['detached']).toBe(true);
    expect(calls[0]!.opts['stdio']).toBe('ignore');
  });

  it('win32: %VAR% sequences pass through VERBATIM inside the PS literal (cmd.exe would expand them)', () => {
    const { calls, spawnFn } = fakeSpawn();
    openInBrowser('C:\\odd %USERNAME% dir\\specimen.html', { spawnFn, platform: 'win32' });
    const command = calls[0]!.args[calls[0]!.args.length - 1]!;
    // Verbatim %USERNAME% inside single quotes: PS single-quoted literals do no
    // expansion of any kind, so the path reaches Start-Process untouched.
    expect(command).toContain("'C:\\odd %USERNAME% dir\\specimen.html'");
    expect(command).not.toBe('cmd'); // and no cmd.exe anywhere in the chain
    expect(calls[0]!.cmd).not.toContain('cmd');
  });

  it("win32: embedded single quotes are doubled (PS's only single-quote escape)", () => {
    const { calls, spawnFn } = fakeSpawn();
    openInBrowser("C:\\it's here\\specimen.html", { spawnFn, platform: 'win32' });
    const command = calls[0]!.args[calls[0]!.args.length - 1]!;
    expect(command).toBe(
      "$ErrorActionPreference='Stop'; Start-Process -FilePath 'C:\\it''s here\\specimen.html'",
    );
  });

  it('darwin: open <target>; linux: xdg-open <target>', () => {
    const mac = fakeSpawn();
    openInBrowser('/tmp/specimen.html', { spawnFn: mac.spawnFn, platform: 'darwin' });
    expect(mac.calls[0]!.cmd).toBe('open');
    expect(mac.calls[0]!.args).toEqual(['/tmp/specimen.html']);

    const linux = fakeSpawn();
    openInBrowser('/tmp/specimen.html', { spawnFn: linux.spawnFn, platform: 'linux' });
    expect(linux.calls[0]!.cmd).toBe('xdg-open');
    expect(linux.calls[0]!.args).toEqual(['/tmp/specimen.html']);
  });

  // Regression for the M1 UAT finding: the composition tests above pass for ANY
  // well-formed param name, so a wrong-but-plausible one (-LiteralPath, which
  // Start-Process does not define — that's Invoke-Item's) shipped and threw at
  // runtime, with the swallowed error making --open look like a Windows no-op.
  // This asserts the param the source ACTUALLY composes is real on this box —
  // parsed from the composed command, not hardcoded, so any wrong param is caught.
  it.runIf(process.platform === 'win32')(
    'win32: the -Param openInBrowser composes is a real Start-Process parameter',
    () => {
      const { calls, spawnFn } = fakeSpawn();
      openInBrowser('C:\\x\\specimen.html', { spawnFn, platform: 'win32' });
      const command = calls[0]!.args[calls[0]!.args.length - 1]!;
      const m = /Start-Process\s+-(\w+)\s/.exec(command);
      expect(m, `no -Param parsed from composed command: ${command}`).not.toBeNull();
      const param = m![1]!;
      const script = `if ((Get-Command Start-Process).Parameters.Keys -contains '${param}') { 'yes' } else { 'no' }`;
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8' },
      ).trim();
      expect(out, `-${param} is not a Start-Process parameter`).toBe('yes');
    },
  );
});

// ---------------------------------------------------------------------------
// openInBrowser — failure signaling through the onError seam (Step 19)
// ---------------------------------------------------------------------------
//
// The composition tests above prove WHAT command is launched; these prove a
// FAILED launch is surfaced rather than swallowed. The M1 UAT `-LiteralPath`
// bug shipped precisely because a launch failure was silent, so an opener that
// cannot report its own failure is the regression this guards. Two failure
// shapes: the common async 'error' event (opener binary not found -> ENOENT)
// and a synchronous spawn throw. Both must (1) reach onError with a single
// composed diagnostic naming the target + opener, and (2) never throw / never
// change the caller's control flow.

/** A fake child whose registered 'error' handler is captured for the test to fire. */
function fakeSpawnCapturingError(): {
  spawnFn: typeof spawn;
  fireError: (e: Error) => void;
  fireExit: (code: number | null, signal?: NodeJS.Signals | null) => void;
  unrefCalls: number;
} {
  let errorHandler: ((e: Error) => void) | undefined;
  let exitHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  const state = { unrefCalls: 0 };
  const child = {
    on: (event: string, handler: (e: Error) => void) => {
      if (event === 'error') errorHandler = handler;
      if (event === 'exit') {
        exitHandler = handler as unknown as (
          code: number | null,
          signal: NodeJS.Signals | null,
        ) => void;
      }
      return child;
    },
    unref: () => {
      state.unrefCalls += 1;
    },
  };
  const spawnFn = (() => child) as unknown as typeof spawn;
  return {
    spawnFn,
    fireError: (e: Error) => {
      if (errorHandler === undefined) throw new Error('no error handler was registered');
      errorHandler(e);
    },
    fireExit: (code, signal = null) => {
      if (exitHandler === undefined) throw new Error('no exit handler was registered');
      exitHandler(code, signal);
    },
    get unrefCalls() {
      return state.unrefCalls;
    },
  };
}

describe('openInBrowser — failure signaling (onError seam)', () => {
  it('routes the async spawn "error" event (ENOENT) to onError with a composed diagnostic', () => {
    const fake = fakeSpawnCapturingError();
    const diagnostics: string[] = [];
    openInBrowser('C:\\proj\\brand\\dist\\specimen.html', {
      spawnFn: fake.spawnFn,
      platform: 'win32',
      onError: (m) => diagnostics.push(m),
    });
    // Dispatch alone reports nothing. The short-lived opener remains referenced
    // until exit so a nonzero code cannot be lost during CLI teardown.
    expect(diagnostics).toEqual([]);
    expect(fake.unrefCalls).toBe(0);

    // the opener binary fails to launch, asynchronously — surfaced, not swallowed
    fake.fireError(new Error('spawn powershell.exe ENOENT'));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('could not open');
    expect(diagnostics[0]).toContain('specimen.html');
    expect(diagnostics[0]).toContain('powershell.exe Start-Process');
    expect(diagnostics[0]).toContain('ENOENT');
  });

  it('routes a SYNCHRONOUS spawn throw to onError and does NOT propagate', () => {
    const spawnFn = (() => {
      throw new Error('EACCES boom');
    }) as unknown as typeof spawn;
    const diagnostics: string[] = [];
    expect(() =>
      openInBrowser('/home/me/specimen.html', {
        spawnFn,
        platform: 'linux',
        onError: (m) => diagnostics.push(m),
      }),
    ).not.toThrow();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('could not open');
    expect(diagnostics[0]).toContain('xdg-open');
    expect(diagnostics[0]).toContain('EACCES boom');
  });

  it('reports a normal opener process that exits nonzero', () => {
    const fake = fakeSpawnCapturingError();
    const diagnostics: string[] = [];
    openInBrowser('C:\\proj\\brand\\dist\\specimen.html', {
      spawnFn: fake.spawnFn,
      platform: 'win32',
      onError: (m) => diagnostics.push(m),
    });
    fake.fireExit(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('powershell.exe Start-Process');
    expect(diagnostics[0]).toContain('exited with code 1');
  });

  it('reports a delayed real child exit before the process can tear down', async () => {
    const diagnostic = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for opener exit')), 5_000);
      const spawnFn = (() =>
        spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(7), 75)'], {
          detached: true,
          stdio: 'ignore',
        })) as unknown as typeof spawn;
      openInBrowser('/tmp/specimen.html', {
        spawnFn,
        platform: 'linux',
        onError: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
    await expect(diagnostic).resolves.toContain('exited with code 7');
  });

  it('names the darwin opener in the diagnostic', () => {
    const fake = fakeSpawnCapturingError();
    const diagnostics: string[] = [];
    openInBrowser('/Users/me/specimen.html', {
      spawnFn: fake.spawnFn,
      platform: 'darwin',
      onError: (m) => diagnostics.push(m),
    });
    fake.fireError(new Error('spawn open ENOENT'));
    expect(diagnostics[0]).toContain('via open:');
  });

  it('a launch failure with NO onError is silently swallowed (never crashes the caller)', () => {
    const fake = fakeSpawnCapturingError();
    // No onError provided: the CLI-agnostic default must remain best-effort.
    openInBrowser('/tmp/specimen.html', { spawnFn: fake.spawnFn, platform: 'linux' });
    expect(() => fake.fireError(new Error('spawn xdg-open ENOENT'))).not.toThrow();

    // and a synchronous throw with no onError is swallowed too
    const throwingSpawn = (() => {
      throw new Error('sync boom');
    }) as unknown as typeof spawn;
    expect(() =>
      openInBrowser('/tmp/specimen.html', { spawnFn: throwingSpawn, platform: 'linux' }),
    ).not.toThrow();
  });
});
