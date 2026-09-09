/**
 * Step 4 svg emitter tests (palette.svg + diagram-palette.json), through the
 * PRODUCTION entry point (spawn bin/onbrand.mjs), covering the step Done-when:
 *   - golden byte-match for palette.svg and diagram-palette.json,
 *   - diagram-palette.json contains EVERY color.diagram key with light AND dark
 *     values matching the source tokens,
 *   - token values that land in SVG attributes/text are XML-escaped (hostile,
 *     schema-valid color value stays escaped — real XML-parse gate lives in
 *     svg.e2e.test.ts).
 * Plus focused units for xmlEscape and collectPaletteRows.
 *
 * palette.svg's "valid XML + renders non-blank in both modes" acceptance is
 * gated by the Playwright render test (svg.e2e.test.ts) — a real browser
 * XML parse + pixel check. This file is the fast, browserless half.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_OK } from '../src/cli.ts';
import { collectPaletteRows, xmlEscape } from '../src/build/emitters/svg.ts';
import { flattenTokens, type EmitterContext } from '../src/build/compile.ts';
import { assertValid } from '../src/schema/validate.ts';

const BIN = fileURLToPath(new URL('../bin/onbrand.mjs', import.meta.url));
const GOLDEN_DIR = fileURLToPath(new URL('./golden/', import.meta.url));
const PRESET_DIR = fileURLToPath(new URL('../templates/presets/default/', import.meta.url));

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-svg-'));
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

const distPath = (dir: string, file: string): string => path.join(dir, 'brand', 'dist', file);

let builtProject: string | undefined;
function initAndBuild(): string {
  if (builtProject !== undefined) return builtProject;
  const dir = tempDir();
  expect(runCli(['init', dir]).status).toBe(EXIT_OK);
  expect(runCli(['build', dir]).status).toBe(EXIT_OK);
  builtProject = dir;
  return dir;
}

describe('svg emitter goldens (spawned through bin/onbrand.mjs)', () => {
  it.each(['palette.svg', 'diagram-palette.json'] as const)(
    'matches the committed golden %s for the default preset, byte for byte',
    (file) => {
      const dir = initAndBuild();
      const emitted = readFileSync(distPath(dir, file), 'utf8');
      const golden = readFileSync(path.join(GOLDEN_DIR, file), 'utf8');
      expect(emitted).toBe(golden); // utf8 equality IS byte equality (CR/BOM survive decode)
    },
  );

  it('diagram-palette.json holds every color.diagram key with matching light AND dark values', () => {
    const dir = initAndBuild();
    const tokens = JSON.parse(readFileSync(path.join(PRESET_DIR, 'tokens.json'), 'utf8')) as {
      color: { diagram: Record<string, { $value: string } | unknown> };
    };
    const modes = JSON.parse(readFileSync(path.join(PRESET_DIR, 'modes.dark.json'), 'utf8')) as {
      color: { diagram: Record<string, { $value: string }> };
    };
    const diagramKeys = Object.keys(tokens.color.diagram);
    expect(diagramKeys).toContain('canvas');
    expect(diagramKeys.length).toBeGreaterThanOrEqual(8);

    const emitted = JSON.parse(readFileSync(distPath(dir, 'diagram-palette.json'), 'utf8')) as {
      light: Record<string, string>;
      dark: Record<string, string>;
    };
    // EVERY color.diagram key present under BOTH light and dark, order-preserved.
    expect(Object.keys(emitted.light)).toEqual(diagramKeys);
    expect(Object.keys(emitted.dark)).toEqual(diagramKeys);
    for (const key of diagramKeys) {
      expect(emitted.light[key]).toBe((tokens.color.diagram[key] as { $value: string }).$value);
      expect(emitted.dark[key]).toBe((modes.color.diagram[key] as { $value: string }).$value);
    }
  });

  it('XML-escapes a schema-valid but hostile color value in palette.svg (no raw breakout)', () => {
    const dir = tempDir();
    expect(runCli(['init', dir]).status).toBe(EXIT_OK);
    const tokensPath = path.join(dir, 'brand', 'tokens.json');
    const doc = JSON.parse(readFileSync(tokensPath, 'utf8')) as {
      color: { diagram: { warning: { $value: string } } };
    };
    // Passes colorSchema (rgb(...) ending in ")") yet carries all five XML
    // metacharacters — the from-url threat model (fetched values are data).
    doc.color.diagram.warning.$value = 'rgb(0 0 0 & < > " \')';
    writeFileSync(tokensPath, JSON.stringify(doc, null, 2), 'utf8');

    const run = runCli(['build', dir, '--emit', 'svg']);
    expect(run.status).toBe(EXIT_OK); // svg escapes, never rejects
    const svg = readFileSync(distPath(dir, 'palette.svg'), 'utf8');
    // the escaped form is present...
    expect(svg).toContain('rgb(0 0 0 &amp; &lt; &gt; &quot; &apos;)');
    // ...and the raw metacharacter run never appears
    expect(svg).not.toContain('0 0 0 & < >');
  });
});

describe('xmlEscape (unit)', () => {
  it('escapes the five XML entities and leaves clean text alone', () => {
    expect(xmlEscape('a & b < c > d " e \' f')).toBe(
      'a &amp; b &lt; c &gt; d &quot; e &apos; f',
    );
    expect(xmlEscape('#1f242c29')).toBe('#1f242c29');
    // ampersand escaped exactly once (not double-escaped)
    expect(xmlEscape('&amp;')).toBe('&amp;amp;');
  });

  it('drops XML-invalid control characters; tab/LF/CR become numeric character references', () => {
    // Built from char codes so no raw control byte is authored into this source
    // (repo.text-hygiene gate). Literal tab/LF/CR in an attribute value would be
    // collapsed to spaces by XML attribute-value normalization — the &#N; forms
    // survive it (review iteration 2, BUG-3).
    const hostile = `x${String.fromCharCode(0)}y${String.fromCharCode(7)}z`;
    expect(xmlEscape(hostile)).toBe('xyz');
    const whitespace = `a${String.fromCharCode(9)}b${String.fromCharCode(10)}c${String.fromCharCode(13)}d`;
    expect(xmlEscape(whitespace)).toBe('a&#9;b&#10;c&#13;d');
  });
});

describe('collectPaletteRows (unit)', () => {
  it('returns only color tokens, with dark value = override or light fallback', () => {
    const light = assertValid({
      $extensions: { onbrand: { schemaVersion: 1 } },
      color: {
        $type: 'color',
        semantic: { bg: { $value: '#ffffff' }, accent: { $value: '#3b63a8' } },
      },
      space: { $type: 'dimension', '1': { $value: '0.25rem' } },
    });
    const flat = flattenTokens(light);
    const darkOverrides = flattenTokens(
      assertValid({
        $extensions: { onbrand: { schemaVersion: 1 } },
        color: { $type: 'color', semantic: { bg: { $value: '#000000' } } },
      }),
    );
    const ctx: EmitterContext = { light: flat, darkOverrides, lightDocument: light };

    const rows = collectPaletteRows(ctx);
    // the dimension token is excluded; both color tokens present
    expect(rows.map((r) => r.dotPath)).toEqual(['color.semantic.bg', 'color.semantic.accent']);
    const bg = rows.find((r) => r.dotPath === 'color.semantic.bg')!;
    expect(bg).toMatchObject({ light: '#ffffff', dark: '#000000', group: 'color.semantic', leaf: 'bg' });
    // no dark override -> dark falls back to the light value
    expect(rows.find((r) => r.dotPath === 'color.semantic.accent')!.dark).toBe('#3b63a8');
  });
});
