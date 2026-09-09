/**
 * Calibration tests for the reusable `house-docs` preset
 * (templates/presets/house-docs/), whose palette was grounded in the historical
 * 2026-07-17 skill-mesh and aberson-profile pilot inventory. These local tests
 * prove the preset/extends contract, not either downstream project's current
 * adoption or repository state.
 *
 * The point of this preset is its color.diagram palette, which is LIFTED from
 * the recorded hand-baked diagram SVG inventory. LIFTED_LIGHT / LIFTED_DARK below
 * are the frozen palette; every assertion is anchored to them so a future edit
 * to the preset that drifts the diagram palette away from the source art is
 * caught here (measurement-validity: the number gates a real thing — the
 * diagram regeneration Pass 2 builds). The non-diagram categories mirror the
 * default preset, so they inherit its WCAG-AA calibration.
 *
 * Two families:
 *   - schema/data calibration (mirrors preset.default.test.ts): the preset
 *     validates, the overlay merges, the §4 category set is covered, and the
 *     diagram values equal the lifted palette;
 *   - production round-trip (mirrors cli.build.test.ts): spawn the real bin
 *     over a temp project, and assert the emitted diagram-palette.json carries
 *     the lifted palette — both when a temp project uses house-docs directly and
 *     when a temp brand extends it.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { applyModeOverlay } from '../src/schema/modes.ts';
import { defaultPresetsRoot, readJsonFile, resolveTokensFile } from '../src/schema/resolve.ts';
import { isToken, type TokensDocument } from '../src/schema/types.ts';
import { assertValid, validate } from '../src/schema/validate.ts';
import { EXIT_OK } from '../src/cli.ts';

const PRESET_DIR = path.join(defaultPresetsRoot(), 'house-docs');
const BIN = fileURLToPath(new URL('../bin/onbrand.mjs', import.meta.url));

// --- The lifted palette (the drift-guard anchor) ---------------------------
// EXHAUSTIVE of every distinct color the 8 source SVGs use for a diagram role
// (verified by the historical Step-15 source-art hex census). Roles mapped to the SVG CSS
// classes:
//   canvas         = .bg fill
//   canvas-border  = .bg stroke (softer frame + dashed section-divider line)
//   node-fill      = .node/.rail/.innode rect fill
//   node-stroke    = .node rect stroke
//   link           = .lnk/.fan stroke + arrow marker
//   spine-accent   = .spine/.fork/.pn/.rail-name/.gw-cmd + chip stroke + spine arrow
//   label          = .lbl/.ps/.cap/.rail-dest/.title/.chip-lbl muted text
//   title-strong   = .hub-t (near-black hub title)
//   text-muted     = .in-t (mid-gray node text)
//   chip-highlight = .chip rect fill
//   warning        = .rail-sub (routing-web annotation-emphasis subtext)
// Values are the source hex normalized to on-brand's lowercase convention.
const LIFTED_LIGHT: Record<string, string> = {
  canvas: '#ffffff',
  'canvas-border': '#d4dbe8',
  'node-fill': '#ffffff',
  'node-stroke': '#c0c9da',
  link: '#c0c9da',
  'spine-accent': '#3355e0',
  label: '#6e778c',
  'title-strong': '#171b24',
  'text-muted': '#454e62',
  'chip-highlight': '#e4e9fb',
  warning: '#b6771f',
};
const LIFTED_DARK: Record<string, string> = {
  canvas: '#161c26',
  'canvas-border': '#29313f',
  'node-fill': '#161c26',
  'node-stroke': '#384153',
  link: '#384153',
  'spine-accent': '#6e9bff',
  label: '#7c8598',
  'title-strong': '#e8ecf4',
  'text-muted': '#a7b0c2',
  'chip-highlight': '#1b2540',
  warning: '#e3a542',
};
const DIAGRAM_KEYS = Object.keys(LIFTED_LIGHT);

const tokensDoc = assertValid(readJsonFile(path.join(PRESET_DIR, 'tokens.json')));
const modesDoc = readJsonFile(path.join(PRESET_DIR, 'modes.dark.json'));

function tokenValue(doc: TokensDocument, dotPath: string): unknown {
  let node: unknown = doc;
  for (const seg of dotPath.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return isToken(node) ? node.$value : undefined;
}

// --- §4 category checklist (same required set as the default preset) --------

const RAMP_STEPS = Array.from({ length: 12 }, (_, i) => String(i + 1));

const REQUIRED_TOKEN_PATHS: string[] = [
  ...RAMP_STEPS.map((n) => `color.primitive.brand.${n}`),
  ...RAMP_STEPS.map((n) => `color.primitive.neutral.${n}`),
  ...['bg', 'surface', 'text', 'text-muted', 'border', 'accent', 'code-bg', 'shadow-color'].map(
    (k) => `color.semantic.${k}`,
  ),
  ...['success', 'warning', 'danger', 'info'].flatMap((s) => [
    `color.status.${s}.fg`,
    `color.status.${s}.bg`,
  ]),
  ...Array.from({ length: 8 }, (_, i) => `color.chart.categorical.${i + 1}`),
  ...Array.from({ length: 7 }, (_, i) => `color.chart.sequential.${i + 1}`),
  ...['grid', 'axis', 'label', 'tooltip-bg'].map((k) => `color.chart.chrome.${k}`),
  ...DIAGRAM_KEYS.map((k) => `color.diagram.${k}`),
  'font.sans',
  'font.heading',
  'font.mono',
  'type.size.base',
  ...['step--1', 'step-0', 'step-1', 'step-2', 'step-3', 'step-4', 'step-5'].map(
    (s) => `type.scale.${s}`,
  ),
  ...['regular', 'medium', 'semibold', 'bold'].map((w) => `type.weight.${w}`),
  ...['tight', 'base', 'loose'].map((l) => `type.line-height.${l}`),
  ...Array.from({ length: 10 }, (_, i) => `space.${i + 1}`),
  ...['sm', 'md', 'lg', 'pill'].map((r) => `radius.${r}`),
  ...['elevation-1', 'elevation-2', 'elevation-3'].map((e) => `shadow.${e}`),
  ...['fast', 'base', 'slow'].map((d) => `motion.duration.${d}`),
  ...['standard', 'decelerate', 'accelerate'].map((e) => `motion.easing.${e}`),
];

// --- temp-dir plumbing (mirrors cli.build.test.ts) --------------------------

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-housedocs-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

interface DiagramPalette {
  light: Record<string, string>;
  dark: Record<string, string>;
}

function readDiagramPalette(projectDir: string): DiagramPalette {
  const raw = readFileSync(
    path.join(projectDir, 'brand', 'dist', 'diagram-palette.json'),
    'utf8',
  );
  return JSON.parse(raw) as DiagramPalette;
}

// ---------------------------------------------------------------------------

describe('house-docs preset — schema + lifted diagram palette', () => {
  it('tokens.json passes validate()', () => {
    expect(validate(readJsonFile(path.join(PRESET_DIR, 'tokens.json'))).issues).toEqual([]);
  });

  it('$extensions.onbrand.schemaVersion is 1 and the preset is standalone (no extends)', () => {
    const ext = (tokensDoc as Record<string, unknown>)['$extensions'] as Record<string, unknown>;
    const onbrand = ext['onbrand'] as Record<string, unknown>;
    expect(onbrand['schemaVersion']).toBe(1);
    expect(onbrand['extends']).toBeUndefined();
  });

  it('modes.dark.json passes overlay validation and merges with zero issues', () => {
    const result = applyModeOverlay(tokensDoc, modesDoc);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.overriddenPaths.length).toBeGreaterThan(40);
    expect(validate(result.document).ok).toBe(true);
  });

  it('covers the full §4 category set', () => {
    const missing = REQUIRED_TOKEN_PATHS.filter((p) => tokenValue(tokensDoc, p) === undefined);
    expect(missing).toEqual([]);
  });

  it('color.diagram LIGHT values equal the lifted SVG palette (drift guard)', () => {
    for (const key of DIAGRAM_KEYS) {
      expect(tokenValue(tokensDoc, `color.diagram.${key}`), key).toBe(LIFTED_LIGHT[key]);
    }
  });

  it('color.diagram DARK overlay values equal the lifted SVG palette (drift guard)', () => {
    const dark = applyModeOverlay(tokensDoc, modesDoc).document;
    for (const key of DIAGRAM_KEYS) {
      expect(tokenValue(dark, `color.diagram.${key}`), key).toBe(LIFTED_DARK[key]);
    }
  });

  it('every diagram role is mode-differentiated in the REAL preset (dark overlay differs from light)', () => {
    // Read the actual documents (not the test's own constants) so a preset that
    // forgets a dark override, or sets it equal to light, is caught here.
    const dark = applyModeOverlay(tokensDoc, modesDoc).document;
    for (const key of DIAGRAM_KEYS) {
      const p = `color.diagram.${key}`;
      const light = tokenValue(tokensDoc, p);
      const darkValue = tokenValue(dark, p);
      expect(darkValue, `expected a dark override for ${p}`).toBeDefined();
      expect(darkValue, p).not.toBe(light);
    }
  });
});

describe('house-docs preset — production build round-trip (spawned bin)', () => {
  it('init --preset house-docs then build emits a diagram-palette carrying the lifted palette', () => {
    const dir = tempDir();
    expect(runCli(['init', dir, '--preset', 'house-docs']).status).toBe(EXIT_OK);
    expect(runCli(['build', dir]).status).toBe(EXIT_OK);

    const palette = readDiagramPalette(dir);
    // every color.diagram key is present in BOTH modes...
    expect(Object.keys(palette.light).sort()).toEqual([...DIAGRAM_KEYS].sort());
    expect(Object.keys(palette.dark).sort()).toEqual([...DIAGRAM_KEYS].sort());
    // ...and equals the lifted SVG hex, exactly (drift guard through the real CLI)
    expect(palette.light).toEqual(LIFTED_LIGHT);
    expect(palette.dark).toEqual(LIFTED_DARK);
  });
});

describe('house-docs preset — local extends resolution', () => {
  /** A minimal brand that extends house-docs by preset NAME + one local override. */
  function writeExtendingTokens(brandDir: string): void {
    writeFileSync(
      path.join(brandDir, 'tokens.json'),
      `${JSON.stringify(
        {
          $extensions: { onbrand: { schemaVersion: 1, extends: 'house-docs' } },
          color: { $type: 'color', semantic: { accent: { $value: '#123456' } } },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  it('resolveTokensFile inherits the diagram palette by preset name and consumes extends', () => {
    const dir = tempDir();
    const brandDir = path.join(dir, 'brand');
    cpSync(PRESET_DIR, brandDir, { recursive: true }); // gives us a modes.dark.json too
    writeExtendingTokens(brandDir); // overwrite tokens.json with the extending fragment

    const resolved = resolveTokensFile(path.join(brandDir, 'tokens.json'));

    // preset-name extends resolved to templates/presets/house-docs/tokens.json
    expect(resolved.chain.some((p) => p.replace(/\\/g, '/').endsWith('house-docs/tokens.json'))).toBe(
      true,
    );
    // diagram palette inherited from house-docs (not present in the fragment)
    for (const key of DIAGRAM_KEYS) {
      expect(tokenValue(resolved.document, `color.diagram.${key}`), key).toBe(LIFTED_LIGHT[key]);
    }
    // the local override won
    expect(tokenValue(resolved.document, 'color.semantic.accent')).toBe('#123456');
    // extends key is consumed, never surfaced into the merged document
    const ext = (resolved.document as Record<string, unknown>)['$extensions'] as Record<
      string,
      unknown
    >;
    expect((ext['onbrand'] as Record<string, unknown>)['extends']).toBeUndefined();
  });

  it('a spawned build of a brand extending house-docs emits the inherited diagram palette', () => {
    const dir = tempDir();
    const brandDir = path.join(dir, 'brand');
    // A temp brand extends house-docs plus its own dark overlay.
    // Mode overlays are not inherited through extends, so the fixture copies
    // house-docs' modes.dark.json — compile.ts loads it from the project dir).
    cpSync(PRESET_DIR, brandDir, { recursive: true });
    writeExtendingTokens(brandDir);

    expect(runCli(['build', dir]).status).toBe(EXIT_OK);

    const palette = readDiagramPalette(dir);
    expect(palette.light).toEqual(LIFTED_LIGHT); // inherited via extends
    expect(palette.dark).toEqual(LIFTED_DARK); // from the copied overlay

    // the local override propagated through the production build path
    const css = readFileSync(path.join(brandDir, 'dist', 'tokens.css'), 'utf8');
    expect(css).toContain('#123456');
  });
});
