/**
 * svg emitter (plan.md §3.1) — the themed-SVG / diagram family. One emitter id
 * ("svg") produces BOTH dist files, because they are the two halves of the same
 * README/diagram pipeline and are always wanted together:
 *
 *   palette.svg          — a README-embeddable swatch sheet. A SINGLE SVG with
 *                          TWO columns (light | dark), so one <img> shows both
 *                          modes side by side (plan §3.1 lists a single
 *                          palette.svg; a two-column sheet is the cleanest way
 *                          to render "light + dark variants" in one file).
 *   diagram-palette.json — the color.diagram named set (canvas, node-fill, ...)
 *                          as { light: {...}, dark: {...} }, the input the
 *                          themed-SVG diagram generator (Step 15) reads.
 *
 * XML safety: an SVG IS XML, so every dynamic string (token names, values) that
 * lands in an attribute or a text node is XML-escaped via xmlEscape() below.
 * from-url (Steps 11-12) will later feed site-derived values into tokens; per
 * the workspace security rule fetched content is data, never structure, so the
 * escaper also drops XML-invalid control characters. Escaping is implemented
 * with explicit char-code handling (no regex character classes) — this repo's
 * authoring pipeline has repeatedly corrupted escapes into raw control bytes
 * (see test/repo.text-hygiene.test.ts), and numeric literals cannot corrupt.
 *
 * Determinism: content is a pure function of ctx (flattenTokens enumeration
 * order, fixed layout arithmetic, LF line endings, trailing newline). SVG
 * carries no timestamps; diagram-palette.json key order is the diagram group's
 * authoring order.
 */

import type { TokenValue } from '../../schema/types.ts';
import type { EmittedFile, EmitterContext } from '../compile.ts';

/** One color token with both its light and dark rendered value. */
export interface PaletteRow {
  path: string[];
  dotPath: string;
  /** Group key: the parent path (everything but the leaf), e.g. color.semantic. */
  group: string;
  /** Leaf name, e.g. "bg" for color.semantic.bg. */
  leaf: string;
  light: string;
  dark: string;
}

/** Stringify a token value for display (colors are strings; guard anyway). */
function displayValue(value: TokenValue): string {
  return typeof value === 'string' ? value : String(value);
}

/**
 * Collect every color-typed token with its light value and its dark value
 * (dark override when present, else the light value — the always-both-modes
 * convention shared with theme.ts / tokens.py). Shared by palette.svg,
 * diagram-palette.json, and the guide renderer so they never drift.
 */
export function collectPaletteRows(ctx: EmitterContext): PaletteRow[] {
  const darkValues = new Map<string, TokenValue>(
    ctx.darkOverrides.map((token) => [token.dotPath, token.value]),
  );
  const rows: PaletteRow[] = [];
  for (const token of ctx.light) {
    if (token.type !== 'color') continue;
    rows.push({
      path: token.path,
      dotPath: token.dotPath,
      group: token.path.slice(0, -1).join('.'),
      leaf: token.path[token.path.length - 1]!,
      light: displayValue(token.value),
      dark: displayValue(darkValues.get(token.dotPath) ?? token.value),
    });
  }
  return rows;
}

/**
 * XML-escape a string for use in an attribute value or text node: the five XML
 * entities; XML-invalid control characters (code < 0x20 other than tab/LF/CR)
 * dropped so the document stays well-formed even on hostile from-url input;
 * and tab/LF/CR emitted as numeric character references (&#9;/&#10;/&#13;) —
 * XML attribute-value normalization collapses the LITERAL forms to spaces, so
 * a name/value containing them would silently change; the references survive
 * normalization intact and are equally valid in text nodes. Char-code walk,
 * not a regex class (see file header).
 */
export function xmlEscape(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += `&#${code};`;
      continue;
    }
    if (code < 0x20) {
      continue; // XML 1.0 forbids these control chars anywhere
    }
    const ch = text[i]!;
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&apos;';
    else out += ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// diagram-palette.json
// ---------------------------------------------------------------------------

const DIAGRAM_PREFIX = ['color', 'diagram'];

function isDiagramToken(row: PaletteRow): boolean {
  return (
    row.path.length === DIAGRAM_PREFIX.length + 1 &&
    DIAGRAM_PREFIX.every((segment, i) => row.path[i] === segment)
  );
}

/** Build brand/dist/diagram-palette.json: { $generated, light:{...}, dark:{...} }. */
function emitDiagramPalette(rows: readonly PaletteRow[]): EmittedFile {
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  for (const row of rows) {
    if (!isDiagramToken(row)) continue;
    light[row.leaf] = row.light; // leaf name = the diagram key (canvas, node-fill, ...)
    dark[row.leaf] = row.dark;
  }
  const doc = {
    $generated:
      'on-brand - DO NOT EDIT. Source: brand/tokens.json (+ modes.dark.json overlay). Regenerate with `onbrand build`.',
    light,
    dark,
  };
  return { relPath: 'diagram-palette.json', content: `${JSON.stringify(doc, null, 2)}\n` };
}

// ---------------------------------------------------------------------------
// palette.svg
// ---------------------------------------------------------------------------

// Layout arithmetic (all px; deterministic). A column is a <g translate>; rows
// use column-local coordinates.
const PAD = 16;
const COL_W = 320;
const COL_GAP = 24;
const SW = 22; // swatch square
const ROW_H = 30;
const GROUP_H = 28;
const TITLE_H = 34;
const SWATCH_X = 14;
const NAME_X = SWATCH_X + SW + 12;
const VALUE_X = COL_W - 14;

interface ModeColors {
  bg: string;
  text: string;
  muted: string;
  stroke: string;
}

function pick(rows: readonly PaletteRow[], dotPath: string, mode: 'light' | 'dark'): string | undefined {
  const row = rows.find((r) => r.dotPath === dotPath);
  return row === undefined ? undefined : row[mode];
}

function modeColors(rows: readonly PaletteRow[], mode: 'light' | 'dark'): ModeColors {
  const fallback: Record<'light' | 'dark', ModeColors> =
    // Static defaults used only when a project's tokens drop a semantic color;
    // the default preset always supplies all four (so these never render).
    {
      light: { bg: '#ffffff', text: '#1f242c', muted: '#566070', stroke: '#dcdfe6' },
      dark: { bg: '#161c26', text: '#edeff3', muted: '#7c8698', stroke: '#333c4a' },
    };
  const fb = fallback[mode];
  return {
    bg: pick(rows, 'color.semantic.bg', mode) ?? fb.bg,
    text: pick(rows, 'color.semantic.text', mode) ?? fb.text,
    muted: pick(rows, 'color.semantic.text-muted', mode) ?? fb.muted,
    stroke: pick(rows, 'color.semantic.border', mode) ?? fb.stroke,
  };
}

/** Ordered [groupKey, rows[]] preserving first-seen (flattenTokens) order. */
function groupRows(rows: readonly PaletteRow[]): Array<[string, PaletteRow[]]> {
  const order: string[] = [];
  const byGroup = new Map<string, PaletteRow[]>();
  for (const row of rows) {
    let bucket = byGroup.get(row.group);
    if (bucket === undefined) {
      bucket = [];
      byGroup.set(row.group, bucket);
      order.push(row.group);
    }
    bucket.push(row);
  }
  return order.map((key) => [key, byGroup.get(key)!]);
}

/** Total content height for the row set (both columns share it). */
function contentHeight(groups: ReadonlyArray<[string, PaletteRow[]]>): number {
  let h = PAD + TITLE_H;
  for (const [, groupTokens] of groups) {
    h += GROUP_H + groupTokens.length * ROW_H;
  }
  return h + PAD;
}

/** Render one mode column as SVG element lines (column-local coordinates). */
function renderColumn(
  groups: ReadonlyArray<[string, PaletteRow[]]>,
  colors: ModeColors,
  mode: 'light' | 'dark',
  height: number,
  id: string,
  xOffset: number,
): string[] {
  const lines: string[] = [];
  lines.push(`  <g id="${id}" transform="translate(${xOffset}, 0)">`);
  lines.push(
    `    <rect x="0" y="0" width="${COL_W}" height="${height}" fill="${xmlEscape(colors.bg)}"/>`,
  );
  lines.push(
    `    <text x="${SWATCH_X}" y="${PAD + 20}" font-family="sans-serif" font-size="16" font-weight="700" fill="${xmlEscape(
      colors.text,
    )}">${mode === 'light' ? 'Light' : 'Dark'}</text>`,
  );

  let y = PAD + TITLE_H;
  for (const [groupKey, groupTokens] of groups) {
    lines.push(
      `    <text x="${SWATCH_X}" y="${y + 18}" font-family="sans-serif" font-size="12" font-weight="700" fill="${xmlEscape(
        colors.text,
      )}">${xmlEscape(groupKey)}</text>`,
    );
    y += GROUP_H;
    for (const row of groupTokens) {
      const value = mode === 'light' ? row.light : row.dark;
      const swatchY = y + (ROW_H - SW) / 2;
      const textY = y + ROW_H / 2 + 4;
      lines.push(
        `    <rect x="${SWATCH_X}" y="${swatchY}" width="${SW}" height="${SW}" rx="3" ` +
          `fill="${xmlEscape(value)}" stroke="${xmlEscape(colors.stroke)}" stroke-width="1"/>`,
      );
      lines.push(
        `    <text x="${NAME_X}" y="${textY}" font-family="sans-serif" font-size="12.5" fill="${xmlEscape(
          colors.text,
        )}">${xmlEscape(row.leaf)}</text>`,
      );
      lines.push(
        `    <text x="${VALUE_X}" y="${textY}" text-anchor="end" font-family="ui-monospace, monospace" ` +
          `font-size="11.5" fill="${xmlEscape(colors.muted)}">${xmlEscape(value)}</text>`,
      );
      y += ROW_H;
    }
  }
  lines.push('  </g>');
  return lines;
}

/** Build brand/dist/palette.svg (single file, light + dark columns). */
function emitPaletteSvg(rows: readonly PaletteRow[]): EmittedFile {
  const groups = groupRows(rows);
  const height = contentHeight(groups);
  const width = PAD + COL_W + COL_GAP + COL_W + PAD;
  const darkX = PAD + COL_W + COL_GAP;
  const lightColumn = renderColumn(groups, modeColors(rows, 'light'), 'light', height, 'palette-light', PAD);
  const darkColumn = renderColumn(groups, modeColors(rows, 'dark'), 'dark', height, 'palette-dark', darkX);

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!-- GENERATED by on-brand - DO NOT EDIT.',
    '     Source of truth: brand/tokens.json (+ modes.dark.json overlay).',
    '     Regenerate with `onbrand build`. -->',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}" role="img" aria-label="Brand palette (light and dark)">`,
    ...lightColumn,
    ...darkColumn,
    '</svg>',
  ];
  return { relPath: 'palette.svg', content: `${lines.join('\n')}\n` };
}

/** Emit brand/dist/palette.svg + brand/dist/diagram-palette.json. */
export function emitSvg(ctx: EmitterContext): EmittedFile[] {
  const rows = collectPaletteRows(ctx);
  return [emitPaletteSvg(rows), emitDiagramPalette(rows)];
}
