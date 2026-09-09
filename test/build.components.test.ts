/**
 * Step 4 components.css emitter tests, through the PRODUCTION entry point
 * (spawn bin/onbrand.mjs), covering the step Done-when:
 *   - golden byte-match for components.css,
 *   - the hard grep gate: ZERO literal color values (no hex, no rgb()/hsl(),
 *     no oklch()/lab()/color()) and no bare color keyword — every color is a
 *     var(--...) reference,
 *   - postcss parses it and every rule is inside @layer components,
 *   - badge status variants are DERIVED from color.status (adding a status
 *     token yields a matching .badge--<name>).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss, { type AtRule, type Declaration } from 'postcss';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_OK } from '../src/cli.ts';

const BIN = fileURLToPath(new URL('../bin/onbrand.mjs', import.meta.url));
const GOLDEN = fileURLToPath(new URL('./golden/components.css', import.meta.url));

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-components-'));
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

const componentsPath = (dir: string): string => path.join(dir, 'brand', 'dist', 'components.css');

function initAndBuild(): string {
  const dir = tempDir();
  expect(runCli(['init', dir]).status).toBe(EXIT_OK);
  expect(runCli(['build', dir]).status).toBe(EXIT_OK);
  return dir;
}

/**
 * The literal-color detector: hex (#rgb..#rrggbbaa), the CSS color functions,
 * and the bare keyword colors. Case-insensitive, char-safe (no regex control
 * classes). Comments are stripped across the WHOLE string first (multi-line
 * aware — the emitted header is a multi-line block comment), then each
 * remaining line is scanned; returns each offending line for a legible failure.
 */
function literalColorHits(css: string): string[] {
  const hits: string[] = [];
  // [\s\S]*? spans newlines, so multi-line /* ... */ blocks are removed whole.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const patterns: RegExp[] = [
    /#[0-9a-fA-F]{3,8}\b/,
    /\brgba?\(/i,
    /\bhsla?\(/i,
    /\b(?:oklch|oklab|lab|lch|hwb)\(/i,
    /(?:^|[^-])\bcolor\(/i,
    /\b(?:transparent|white|black|currentColor)\b/i,
  ];
  stripped.split('\n').forEach((line, i) => {
    for (const re of patterns) {
      if (re.test(line)) {
        hits.push(`L${i + 1}: ${line.trim()}`);
        break;
      }
    }
  });
  return hits;
}

describe('components.css emitter (spawned through bin/onbrand.mjs)', () => {
  it('matches the committed golden components.css, byte for byte', () => {
    const dir = initAndBuild();
    expect(readFileSync(componentsPath(dir), 'utf8')).toBe(readFileSync(GOLDEN, 'utf8'));
  });

  it('calibration: the literal-color detector flags a hex and passes a var() ref', () => {
    // measurement-validity: an instrument that cannot fail garbage cannot gate.
    expect(literalColorHits('a { color: #fff; }')).toHaveLength(1);
    expect(literalColorHits('a { color: rgb(0,0,0); }')).toHaveLength(1);
    expect(literalColorHits('a { color: transparent; }')).toHaveLength(1);
    expect(literalColorHits('a { color: var(--color-semantic-text); }')).toEqual([]);
    // multi-line comment awareness: a color word INSIDE a spanning /* */ block
    // is prose (no false positive), while real declarations still flag
    expect(literalColorHits('/* line one\n * mentions white here\n */\na { gap: 0; }')).toEqual([]);
    expect(
      literalColorHits('/* header\n * prose\n */\na { color: #fff; }'),
    ).toHaveLength(1);
  });

  it('contains ZERO literal color values — every color is a var(--...) reference', () => {
    const dir = initAndBuild();
    const css = readFileSync(componentsPath(dir), 'utf8');
    expect(literalColorHits(css)).toEqual([]);
    // and it genuinely references the token vars (not a vacuously-empty file)
    expect(css).toContain('var(--color-semantic-accent)');
    expect(css).toContain('var(--color-status-success-fg)');
  });

  it('postcss parses it and every rule lives inside @layer components', () => {
    const dir = initAndBuild();
    const root = postcss.parse(readFileSync(componentsPath(dir), 'utf8'));
    const layers = root.nodes.filter((n): n is AtRule => n.type === 'atrule' && n.name === 'layer');
    expect(layers).toHaveLength(1);
    expect(layers[0]!.params).toBe('components');
    // nothing but the header comment sits outside the layer
    expect(root.nodes.filter((n) => n.type !== 'comment' && n !== layers[0])).toHaveLength(0);
    // recipes exist for each surface
    const css = root.toString();
    for (const sel of ['.btn', '.card', '.badge', '.table', '.input']) {
      expect(css).toContain(sel);
    }
    // every declared color property value uses var()
    layers[0]!.walkDecls((decl: Declaration) => {
      if (/(^|-)(color|background|fill|stroke)$/i.test(decl.prop) || decl.prop === 'background') {
        if (decl.value !== 'none') {
          expect(decl.value, `${decl.prop}: ${decl.value}`).toContain('var(--');
        }
      }
    });
  });

  it('derives a badge variant for each color.status group (adding one yields a new .badge--*)', () => {
    const dir = tempDir();
    expect(runCli(['init', dir]).status).toBe(EXIT_OK);
    const tokensPath = path.join(dir, 'brand', 'tokens.json');
    const doc = JSON.parse(readFileSync(tokensPath, 'utf8')) as {
      color: { status: Record<string, { fg: { $value: string }; bg: { $value: string } }> };
    };
    // add a fifth status with both fg and bg
    doc.color.status['neutral'] = { fg: { $value: '#334155' }, bg: { $value: '#e2e8f0' } };
    writeFileSync(tokensPath, JSON.stringify(doc, null, 2), 'utf8');
    expect(runCli(['build', dir, '--emit', 'components']).status).toBe(EXIT_OK);

    const css = readFileSync(componentsPath(dir), 'utf8');
    for (const name of ['success', 'warning', 'danger', 'info', 'neutral']) {
      expect(css).toContain(`.badge--${name}`);
      expect(css).toContain(`var(--color-status-${name}-fg)`);
      expect(css).toContain(`var(--color-status-${name}-bg)`);
    }
    // still no literal colors after the token-derived expansion
    expect(literalColorHits(css)).toEqual([]);
  });

  // --- iteration-2: fail-loud naming gate + derivation edge cases ------------

  /** init a fresh project and mutate its brand/tokens.json. */
  function initProjectWith(mutate: (doc: Record<string, any>) => void): string {
    const dir = tempDir();
    expect(runCli(['init', dir]).status).toBe(EXIT_OK);
    const tokensPath = path.join(dir, 'brand', 'tokens.json');
    const doc = JSON.parse(readFileSync(tokensPath, 'utf8')) as Record<string, any>;
    mutate(doc);
    writeFileSync(tokensPath, JSON.stringify(doc, null, 2), 'utf8');
    return dir;
  }

  it('unsafe status name: `build --emit components` exits 1 path-precise (never a silent drop); css builds clean', () => {
    // A space is schema-legal in a name (only "."/"{"/"}" are forbidden) but
    // cannot become a class suffix — the fail-loud contract (naming.ts rule).
    const dir = initProjectWith((doc) => {
      doc.color.status['odd name'] = { fg: { $value: '#111111' }, bg: { $value: '#eeeeee' } };
    });
    const run = runCli(['build', dir, '--emit', 'components']);
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).toContain('color.status.odd name'); // path-precise
    expect(run.stderr).toContain('badge class suffix');
    expect(existsSync(componentsPath(dir))).toBe(false); // refused build wrote nothing
    expect(runCli(['build', dir, '--emit', 'css']).status).toBe(EXIT_OK); // class is components-specific
  });

  it('empty status name (schema-legal) also fails loud instead of emitting a malformed ".badge--"', () => {
    const dir = initProjectWith((doc) => {
      doc.color.status[''] = { fg: { $value: '#111111' }, bg: { $value: '#eeeeee' } };
    });
    const run = runCli(['build', dir, '--emit', 'components']);
    expect(run.status).toBe(EXIT_FAILURE);
    expect(run.stderr).toContain('badge class suffix');
  });

  it('partial status group (fg without bg) is excluded from badges, not an error', () => {
    // Half a pair cannot make a badge recipe; the tokens themselves stay legal
    // (tokens.css still emits them), so this is exclusion, not failure.
    const dir = initProjectWith((doc) => {
      doc.color.status['partial'] = { fg: { $value: '#111111' } };
    });
    expect(runCli(['build', dir, '--emit', 'components']).status).toBe(EXIT_OK);
    const css = readFileSync(componentsPath(dir), 'utf8');
    expect(css).not.toContain('.badge--partial');
    expect(css).not.toContain('var(--color-status-partial-fg)'); // no dangling var ref
    expect(css).toContain('.badge--success'); // complete pairs unaffected
  });
});
