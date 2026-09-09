/**
 * Step 4 guide.md fenced-block renderer tests. The load-bearing acceptance:
 * `onbrand build` refreshes ONLY the auto-generated palette fence and preserves
 * every byte of prose OUTSIDE the fences — including a BOM, CRLF line endings,
 * trailing whitespace and non-ASCII text. So the assertions are byte-exact
 * (Buffer compares), and the fixture is deliberately hostile to any encoding /
 * line-ending normalization.
 *
 * Covered: round-trip prose preservation, the fence actually filled, idempotency
 * (second build byte-identical), graceful skips (no markers -> untouched; no
 * guide.md -> absent), that an --emit subset without svg leaves guide.md
 * alone, and the iteration-2 marker-contract hardening: markers documented in
 * a ``` code block are prose (never spliced), a token NAME carrying marker
 * text cannot corrupt the next build (line-anchored scan + codeCell
 * neutralization), and codeCell's table/inline-code escaping.
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { compileBrand, type EmitterContext } from '../src/build/compile.ts';
import { DIST_PUBLICATION_LOCK_FILE } from '../src/build/publication-lock.ts';
import { codeCell, renderGuide } from '../src/build/guide-render.ts';
import { assertValid } from '../src/schema/validate.ts';

const PRESET_DIR = fileURLToPath(new URL('../templates/presets/default/', import.meta.url));

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-guide-'));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A project whose brand/ is the default preset, with a custom guide.md. */
function projectWithGuide(guide: Buffer): { dir: string; brandDir: string; guidePath: string } {
  const dir = tempDir();
  const brandDir = path.join(dir, 'brand');
  cpSync(PRESET_DIR, brandDir, { recursive: true });
  const guidePath = path.join(brandDir, 'guide.md');
  writeFileSync(guidePath, guide);
  return { dir, brandDir, guidePath };
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const BEGIN = '<!-- onbrand:begin palette -->';
const END = '<!-- onbrand:end palette -->';

/** Head bytes (through the begin marker) + placeholder + tail bytes. */
function hostileGuide(): { buf: Buffer; head: Buffer; tail: Buffer } {
  // CRLF throughout, a BOM, trailing spaces, non-ASCII — none may change.
  const head = Buffer.from(
    `# My Brand Guide\r\n\r\nProse with trailing space   \r\nUnicode line: cafe ☕ — keep me\r\n\r\n${BEGIN}`,
    'utf8',
  );
  const placeholder = Buffer.from('\r\n_old auto content to be replaced_\r\n', 'utf8');
  const tail = Buffer.from(
    `${END}\r\n\r\n## Voice & tone\r\n\r\n- concise, no emojis   \r\n- prose stays exactly as written\r\n`,
    'utf8',
  );
  return { buf: Buffer.concat([BOM, head, placeholder, tail]), head: Buffer.concat([BOM, head]), tail };
}

describe('guide-render byte-for-byte prose preservation (via compileBrand)', () => {
  it('refreshes the palette fence and preserves every prose byte outside it', () => {
    const { buf, head, tail } = hostileGuide();
    const { dir, guidePath } = projectWithGuide(buf);

    const result = compileBrand(dir, { emit: ['svg'] });
    expect(result.guide?.status).toBe('updated');
    expect(result.guide?.refreshed).toEqual(['palette']);

    const after = readFileSync(guidePath);
    // head (BOM + prose + begin marker) preserved byte-for-byte
    expect(after.subarray(0, head.length).equals(head)).toBe(true);
    // tail (end marker + prose) preserved byte-for-byte
    expect(after.subarray(after.length - tail.length).equals(tail)).toBe(true);
    // the fence was actually filled with the rendered table + svg embed
    const text = after.toString('utf8');
    expect(text).toContain('![Brand palette (light and dark)](./dist/palette.svg)');
    expect(text).toContain('`color.semantic.bg`');
    // the old auto content is gone
    expect(text).not.toContain('_old auto content to be replaced_');
    // CRLF style inside the auto block was matched (no lone-LF introduced)
    const block = text.slice(text.indexOf(BEGIN) + BEGIN.length, text.indexOf(END));
    expect(block.includes('\r\n')).toBe(true);
    expect(/[^\r]\n/.test(block)).toBe(false);
  });

  it('is idempotent: a second build leaves guide.md byte-identical', () => {
    const { buf } = hostileGuide();
    const { dir, guidePath } = projectWithGuide(buf);
    compileBrand(dir, { emit: ['svg'] });
    const first = readFileSync(guidePath);
    const result2 = compileBrand(dir, { emit: ['svg'] });
    expect(result2.guide?.status).toBe('unchanged');
    expect(readFileSync(guidePath).equals(first)).toBe(true);
  });

  it('leaves guide.md untouched when the svg emitter does not run (--emit css)', () => {
    const { buf } = hostileGuide();
    const { dir, guidePath } = projectWithGuide(buf);
    const before = readFileSync(guidePath);
    const result = compileBrand(dir, { emit: ['css'] });
    expect(result.guide).toBeUndefined(); // guide phase rides svg only
    expect(readFileSync(guidePath).equals(before)).toBe(true);
  });

  it.runIf(process.platform !== 'win32')(
    'preserves restrictive guide permission bits across staged replacement',
    () => {
      const { buf } = hostileGuide();
      const { dir, guidePath } = projectWithGuide(buf);
      chmodSync(guidePath, 0o640);

      expect(compileBrand(dir, { emit: ['svg'] }).guide?.status).toBe('updated');
      expect(statSync(guidePath).mode & 0o777).toBe(0o640);
    },
  );

  it('cleans its staged guide and releases the writer lock when the publication barrier fails', () => {
    const { buf } = hostileGuide();
    const { dir, brandDir, guidePath } = projectWithGuide(buf);
    const before = readFileSync(guidePath);

    expect(() => compileBrand(dir, {
      emit: ['svg'],
      beforeGuideRename: () => { throw new Error('guide barrier failure'); },
    })).toThrowError(/guide barrier failure/);

    expect(readFileSync(guidePath).equals(before)).toBe(true);
    expect(readdirSync(brandDir).filter((name) => name.includes('.onbrand-tmp-'))).toEqual([]);
    expect(existsSync(path.join(brandDir, DIST_PUBLICATION_LOCK_FILE))).toBe(false);

    expect(compileBrand(dir, { emit: ['svg'] }).guide?.status).toBe('updated');
  });
});

describe('guide-render graceful skips (unit)', () => {
  const emptyCtx: EmitterContext = {
    light: [],
    darkOverrides: [],
    lightDocument: assertValid({ $extensions: { onbrand: { schemaVersion: 1 } } }),
  };

  it('skips (no-fences) without adding or erroring when the markers are absent', () => {
    const brandDir = tempDir();
    const guidePath = path.join(brandDir, 'guide.md');
    const original = Buffer.from('# Guide\r\n\r\nNo fences here at all.\r\n', 'utf8');
    writeFileSync(guidePath, original);

    const result = renderGuide(brandDir, emptyCtx);
    expect(result.status).toBe('no-fences');
    expect(result.refreshed).toEqual([]);
    // file unchanged byte-for-byte; no fence was injected
    expect(readFileSync(guidePath).equals(original)).toBe(true);
  });

  it('reports absent when there is no guide.md, without creating one', () => {
    const brandDir = tempDir();
    const result = renderGuide(brandDir, emptyCtx);
    expect(result.status).toBe('absent');
    expect(result.refreshed).toEqual([]);
  });

  it('rejects a hard-linked guide without changing the other link', () => {
    const { dir, guidePath } = projectWithGuide(hostileGuide().buf);
    const sentinel = path.join(dir, 'guide-sentinel.md');
    const sentinelBytes = readFileSync(guidePath);
    writeFileSync(sentinel, sentinelBytes);
    rmSync(guidePath);
    linkSync(sentinel, guidePath);

    expect(() => compileBrand(dir, { emit: ['svg'] })).toThrowError(/local unlinked regular file/);
    expect(readFileSync(sentinel).equals(sentinelBytes)).toBe(true);
  });

  it('never opens the legacy predictable guide staging name', () => {
    const { dir, guidePath } = projectWithGuide(hostileGuide().buf);
    const sentinel = path.join(dir, 'outside-guide-staging-sentinel.md');
    const sentinelBytes = Buffer.from('outside sentinel must stay exact\n', 'utf8');
    writeFileSync(sentinel, sentinelBytes);
    const predictableStage = `${guidePath}.onbrand-tmp-${process.pid}`;
    linkSync(sentinel, predictableStage);

    expect(compileBrand(dir, { emit: ['svg'] }).guide?.status).toBe('updated');
    expect(readFileSync(sentinel).equals(sentinelBytes)).toBe(true);
    expect(readFileSync(predictableStage).equals(sentinelBytes)).toBe(true);
  });

  it('skips a begin marker with no matching end marker (malformed fence)', () => {
    const brandDir = tempDir();
    const guidePath = path.join(brandDir, 'guide.md');
    const original = Buffer.from(`before\r\n${BEGIN}\r\nunterminated\r\n`, 'utf8');
    writeFileSync(guidePath, original);
    const result = renderGuide(brandDir, emptyCtx);
    expect(result.status).toBe('no-fences');
    expect(readFileSync(guidePath).equals(original)).toBe(true);
  });

  it('ignores marker text that is not the whole trimmed line (mid-line = data, not a fence)', () => {
    const brandDir = tempDir();
    const guidePath = path.join(brandDir, 'guide.md');
    // markers exist only mid-line — prose mentioning the syntax inline
    const original = Buffer.from(
      `The ${BEGIN} marker and the ${END} marker are documented inline here.\n`,
      'utf8',
    );
    writeFileSync(guidePath, original);
    const result = renderGuide(brandDir, emptyCtx);
    expect(result.status).toBe('no-fences');
    expect(readFileSync(guidePath).equals(original)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Iteration-2 marker-contract hardening (the two independently-reproduced
// review corruptions, now structural guarantees).
// ---------------------------------------------------------------------------

describe('marker contract: documentation and hostile names cannot corrupt guide.md', () => {
  it('a guide documenting the marker syntax in a ``` code block keeps its docs byte-for-byte; the REAL fence refreshes', () => {
    // Review repro (a): the naive first-match scan overwrote the documentation
    // example and never refreshed the real fence. Code-fence awareness fixes it.
    const dir = tempDir();
    const brandDir = path.join(dir, 'brand');
    cpSync(PRESET_DIR, brandDir, { recursive: true });
    const guidePath = path.join(brandDir, 'guide.md');
    const docsRegion = [
      '## Notes for teammates',
      '```',
      BEGIN,
      'documented example - must survive byte-for-byte',
      END,
      '```',
      '',
    ].join('\n');
    const guide = ['# Guide', '', docsRegion, '## Palette', BEGIN, '_real placeholder_', END, ''].join(
      '\n',
    );
    writeFileSync(guidePath, guide, 'utf8');

    const result = compileBrand(dir, { emit: ['svg'] });
    expect(result.guide?.status).toBe('updated');
    const after = readFileSync(guidePath, 'utf8');
    // documentation region preserved byte-for-byte (code block untouched)
    expect(after).toContain(docsRegion);
    expect(after).toContain('documented example - must survive byte-for-byte');
    // the REAL fence (after the code block) was the one refreshed
    expect(after).toContain('| Token | Light | Dark |');
    expect(after).not.toContain('_real placeholder_');
    // idempotent from here
    const first = readFileSync(guidePath);
    compileBrand(dir, { emit: ['svg'] });
    expect(readFileSync(guidePath).equals(first)).toBe(true);
  });

  it('markers hidden inside an UNCLOSED code fence are never spliced (safe skip)', () => {
    const dir = tempDir();
    const brandDir = path.join(dir, 'brand');
    cpSync(PRESET_DIR, brandDir, { recursive: true });
    const guidePath = path.join(brandDir, 'guide.md');
    const original = Buffer.from(['# G', '```', BEGIN, '_x_', END, ''].join('\n'), 'utf8');
    writeFileSync(guidePath, original);
    const result = compileBrand(dir, { emit: ['svg'] });
    expect(result.guide?.status).toBe('no-fences');
    expect(readFileSync(guidePath).equals(original)).toBe(true);
  });

  it('a token NAME carrying marker text cannot plant a fake fence: build2 == build1, exactly one end marker', () => {
    // Review repro (b): the self-injected fake end-marker corrupted every
    // subsequent build. codeCell flattens the newlines (row stays one
    // "|"-prefixed line) and the line-anchored scan ignores mid-line text.
    const dir = tempDir();
    const brandDir = path.join(dir, 'brand');
    cpSync(PRESET_DIR, brandDir, { recursive: true });
    const guidePath = path.join(brandDir, 'guide.md');
    writeFileSync(
      guidePath,
      ['# G', '', BEGIN, '_ph_', END, '', 'tail prose', ''].join('\n'),
      'utf8',
    );
    const tokensPath = path.join(brandDir, 'tokens.json');
    const doc = JSON.parse(readFileSync(tokensPath, 'utf8')) as {
      color: { semantic: Record<string, unknown> };
    };
    const hostileName = `x -->\n${END}\ninjected`;
    doc.color.semantic[hostileName] = { $value: '#123456' };
    writeFileSync(tokensPath, JSON.stringify(doc, null, 2), 'utf8');

    compileBrand(dir, { emit: ['svg'] });
    const build1 = readFileSync(guidePath);
    compileBrand(dir, { emit: ['svg'] });
    const build2 = readFileSync(guidePath);

    // idempotent — the corruption compounded on build 2 before the fix
    expect(build2.equals(build1)).toBe(true);
    const text = build1.toString('utf8');
    // prose after the fence survived
    expect(text.endsWith('tail prose\n')).toBe(true);
    // exactly ONE line-anchored end marker exists (the real one)
    const anchoredEnds = text.split('\n').filter((line) => line.trim() === END);
    expect(anchoredEnds).toHaveLength(1);
    // the hostile name rendered as ONE neutralized "|"-prefixed table row
    const row = text.split('\n').find((line) => line.includes('injected'));
    expect(row).toBeDefined();
    expect(row!.startsWith('|')).toBe(true);
    expect(row!).toContain('x --> <!-- onbrand:end palette --> injected');
  });
});

describe('marker contract: pipes and backticks in token names stay inside their table cell', () => {
  it('a name with | and ` renders escaped, keeping the table column count intact', () => {
    const dir = tempDir();
    const brandDir = path.join(dir, 'brand');
    cpSync(PRESET_DIR, brandDir, { recursive: true });
    const guidePath = path.join(brandDir, 'guide.md');
    writeFileSync(guidePath, ['# G', BEGIN, '_ph_', END, ''].join('\n'), 'utf8');
    const tokensPath = path.join(brandDir, 'tokens.json');
    const doc = JSON.parse(readFileSync(tokensPath, 'utf8')) as {
      color: { semantic: Record<string, unknown> };
    };
    doc.color.semantic['odd|name`x'] = { $value: '#654321' };
    writeFileSync(tokensPath, JSON.stringify(doc, null, 2), 'utf8');
    expect(compileBrand(dir, { emit: ['svg'] }).guide?.status).toBe('updated');

    const text = readFileSync(guidePath, 'utf8');
    const row = text.split('\n').find((line) => line.includes('odd'));
    expect(row).toBeDefined();
    // pipe escaped as GFM \| (not a raw cell separator), backtick-fenced span
    expect(row!).toContain('``color.semantic.odd\\|name`x``');
    // unescaped pipes still delimit exactly 3 columns (4 boundaries)
    const rawPipes = row!.split('').filter((ch, i) => ch === '|' && row![i - 1] !== '\\').length;
    expect(rawPipes).toBe(4);
  });
});

describe('codeCell (unit) — GFM table + inline-code escaping', () => {
  it('escapes pipes as GFM \\| so a hostile value cannot add table columns', () => {
    expect(codeCell('a|b')).toBe('`a\\|b`');
  });

  it('fences backtick-bearing values with a longer backtick run (CommonMark code-span rules)', () => {
    expect(codeCell('has `tick`')).toBe('`` has `tick` ``'); // padded: value ends with a backtick
    expect(codeCell('run ``two``')).toBe('``` run ``two`` ```');
    expect(codeCell('mid`dle')).toBe('``mid`dle``'); // no pad needed: ends are not backticks
    expect(codeCell('plain')).toBe('`plain`');
    expect(codeCell('')).toBe('`  `'); // padded both sides; renders as a blank span
  });

  it('flattens ALL control characters to spaces so a cell can never split its row line', () => {
    // Built from char codes — no raw control bytes authored into this source.
    const hostile = `a${String.fromCharCode(10)}b${String.fromCharCode(13)}c${String.fromCharCode(9)}d${String.fromCharCode(0)}e`;
    expect(codeCell(hostile)).toBe('`a b c d e`');
  });
});
