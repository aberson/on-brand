/**
 * guide.md fenced-block renderer (plan.md §3.1 + §5).
 *
 * `onbrand build` refreshes ONLY the auto-generated fenced blocks inside
 * <brandDir>/guide.md, delimited by `<!-- onbrand:begin <name> -->` ...
 * `<!-- onbrand:end <name> -->`. Everything OUTSIDE those markers is
 * operator-owned prose and is preserved BYTE-FOR-BYTE.
 *
 * Why bytes, not strings: the contract is byte-exact preservation of prose
 * (line endings, a possible BOM, trailing whitespace — none of it may change).
 * So the splice is done on Buffers: locate the marker byte sequences, keep the
 * head (through the begin marker) and tail (from the end marker) verbatim, and
 * replace only the bytes between them. A round trip through utf8 decode/encode
 * would usually preserve bytes, but a lone invalid byte would be lopped to
 * U+FFFD — the Buffer splice cannot corrupt what it never decodes.
 *
 * MARKER RECOGNITION CONTRACT (the structural defense; review iteration 2):
 *   1. LINE-ANCHORED. A marker counts only when the marker text is the ENTIRE
 *      trimmed content of its line (leading/trailing spaces/tabs/CR allowed,
 *      nothing else). Marker text appearing mid-line — e.g. inside a rendered
 *      table cell — is prose/data, never a fence boundary.
 *   2. CODE-FENCE-AWARE. Lines inside a markdown fenced code block (``` or
 *      ~~~, CommonMark-style open/close tracking) are never markers. A
 *      guide.md that DOCUMENTS the marker syntax in a fenced example keeps its
 *      documentation byte-for-byte while the real fence still refreshes.
 *      (Deliberate limit: use a ``` fenced block — not a 4-space-indented code
 *      block — to document marker syntax; indented code is not recognized.)
 *   3. GENERATED CONTENT CANNOT MINT MARKERS. Every generated table cell is
 *      passed through codeCell(), which flattens control characters (incl.
 *      newlines) to spaces — so every generated line starts with "|" and can
 *      never BE a line-anchored marker, regardless of hostile token names or
 *      values (the from-url threat model: fetched content is data, never
 *      structure).
 *   Together these make the splice idempotent and prose-safe even for
 *   schema-legal hostile names (token/group names are not charset-restricted
 *   beyond "."/"{"/"}").
 *
 * guide.md is NOT a dist/ artifact — it lives at brand/guide.md next to the
 * source, holds operator prose, and predates the build. So this is a POST-EMIT
 * build phase, distinct from the dist emitter registry: compile.ts runs it
 * after the dist files are staged+renamed, and only when the `svg` emitter ran
 * (the palette block embeds dist/palette.svg + the swatch table, so it is kept
 * in lockstep with the palette output; an --emit subset without svg leaves
 * guide.md untouched).
 *
 * Graceful skips (never an error, never re-adding a fence): guide.md absent, or
 * a declared fence's markers not present (unterminated, or hidden inside a code
 * block). Only the `palette` fence is rendered because that is the only fence
 * the init template (templates/guide.template.md) declares; a fence is
 * refreshed only if BOTH its markers are already there. The FIRST line-anchored
 * begin/end pair outside code blocks wins when duplicates exist.
 *
 * Determinism: the block is a pure function of the tokens; the newline style is
 * matched to the file's own so a CRLF guide stays CRLF.
 */

import path from 'node:path';
import type { EmitterContext } from './compile.ts';
import { collectPaletteRows, type PaletteRow } from './emitters/svg.ts';
import {
  inspectSafeRegularFileTarget,
  publishStagedFile,
  removeOwnedFile,
  sameFileIdentity,
  stageFileExclusive,
  stableReadRegularFile,
  type StagedFile,
} from '../filesystem.ts';

export type GuideStatus = 'updated' | 'unchanged' | 'no-fences' | 'absent';

export interface GuideResult {
  /** Absolute path to guide.md. */
  path: string;
  status: GuideStatus;
  /** Fence names that were refreshed (present + spliced). */
  refreshed: string[];
}

export interface RenderGuideOptions {
  /** Deterministic process-test barrier immediately before atomic publication. */
  beforeGuideRename?: () => void;
}

const beginMarker = (name: string): string => `<!-- onbrand:begin ${name} -->`;
const endMarker = (name: string): string => `<!-- onbrand:end ${name} -->`;

/** The file's newline style: CRLF if the first LF is preceded by CR, else LF. */
function detectNewline(buf: Buffer): string {
  const lf = buf.indexOf(0x0a);
  if (lf > 0 && buf[lf - 1] === 0x0d) return '\r\n';
  return '\n';
}

/**
 * Render a value as a GFM-table-safe inline code span. This is the "generated
 * content cannot mint markers" half of the marker contract (file header §3) —
 * comprehensive for the markdown-table + inline-code context:
 *   - Control characters (code < 0x20, incl. LF/CR/tab, plus DEL 0x7F) flatten
 *     to a space, so a cell can NEVER split its table row across lines — every
 *     generated line keeps its leading "|" and cannot be a line-anchored
 *     marker. Char-code walk, not a regex class (repo authoring-hazard rule).
 *   - "|" -> "\|" (the GFM escape for pipes inside table cells; honored inside
 *     code spans in table context).
 *   - Backticks: the span is fenced with a backtick run ONE LONGER than the
 *     longest run inside the value, space-padded when the value starts/ends
 *     with a backtick or is empty (CommonMark code-span rules) — so a value
 *     containing backticks cannot close the span early.
 * Exported for direct unit tests.
 */
export function codeCell(text: string): string {
  let clean = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    clean += code < 0x20 || code === 0x7f ? ' ' : text[i]!;
  }
  clean = clean.replaceAll('|', '\\|');
  let maxRun = 0;
  let run = 0;
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '`') {
      run++;
      if (run > maxRun) maxRun = run;
    } else {
      run = 0;
    }
  }
  const fence = '`'.repeat(maxRun + 1);
  const pad = clean.startsWith('`') || clean.endsWith('`') || clean === '' ? ' ' : '';
  return `${fence}${pad}${clean}${pad}${fence}`;
}

/**
 * The `palette` block: a note, the embedded palette.svg, and a swatch table of
 * the human-named UI colors (semantic + status) with light/dark values. The
 * ramps / chart / diagram colors are visual scales best read from palette.svg,
 * which the image embed shows in full.
 */
function paletteBlock(rows: readonly PaletteRow[]): string {
  const named = rows.filter((row) => row.path[1] === 'semantic' || row.path[1] === 'status');
  const lines: string[] = [
    '<!-- AUTO-GENERATED by `onbrand build` - do not edit between the palette markers. -->',
    '',
    '![Brand palette (light and dark)](./dist/palette.svg)',
    '',
    '| Token | Light | Dark |',
    '| --- | --- | --- |',
  ];
  for (const row of named) {
    lines.push(`| ${codeCell(row.dotPath)} | ${codeCell(row.light)} | ${codeCell(row.dark)} |`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Line-anchored, code-fence-aware marker scan (file header: marker contract)
// ---------------------------------------------------------------------------

const SPACE = 0x20;
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const BACKTICK = 0x60; // "`"
const TILDE = 0x7e; // "~"

interface FencePosition {
  /** Offset just past the begin-marker text (head = bytes [0, afterBegin)). */
  afterBegin: number;
  /** Offset of the end-marker text's first byte (tail = bytes [endStart, ...)). */
  endStart: number;
}

/**
 * Find the first line-anchored begin/end marker pair for `name`, skipping any
 * line inside a markdown fenced code block. Returns null when no complete pair
 * exists outside code blocks (graceful skip).
 *
 * Line model: lines are byte ranges split on LF; a line's "trimmed content" is
 * the range minus leading/trailing spaces, tabs, and CR. A marker matches only
 * when the trimmed content EQUALS the marker bytes. Code-fence tracking is
 * CommonMark-shaped: a trimmed line starting with a run of >= 3 backticks (or
 * tildes) opens a fence; it closes on a trimmed line that is ONLY a run of >=
 * the opening length of the same character; an unclosed fence runs to EOF.
 */
function findFencePair(buf: Buffer, name: string): FencePosition | null {
  const begin = Buffer.from(beginMarker(name), 'utf8');
  const end = Buffer.from(endMarker(name), 'utf8');

  let inCodeFence = false;
  let codeFenceChar = 0;
  let codeFenceLen = 0;
  let afterBegin = -1;

  let lineStart = 0;
  while (lineStart <= buf.length) {
    let lineEnd = buf.indexOf(LF, lineStart);
    if (lineEnd < 0) lineEnd = buf.length;

    // Trim spaces/tabs/CR at both ends of [lineStart, lineEnd).
    let ts = lineStart;
    while (ts < lineEnd && (buf[ts] === SPACE || buf[ts] === TAB)) ts++;
    let te = lineEnd;
    while (te > ts && (buf[te - 1] === SPACE || buf[te - 1] === TAB || buf[te - 1] === CR)) te--;
    const content = buf.subarray(ts, te);

    // Code-fence open/close tracking.
    const first = content.length > 0 ? content[0]! : 0;
    if (inCodeFence) {
      if (first === codeFenceChar) {
        let runLen = 0;
        while (runLen < content.length && content[runLen] === codeFenceChar) runLen++;
        if (runLen >= codeFenceLen && runLen === content.length) {
          inCodeFence = false; // closing fence: the run and nothing else
        }
      }
    } else if (first === BACKTICK || first === TILDE) {
      let runLen = 0;
      while (runLen < content.length && content[runLen] === first) runLen++;
      if (runLen >= 3) {
        inCodeFence = true;
        codeFenceChar = first;
        codeFenceLen = runLen;
      }
    }

    // Marker recognition — only outside code fences, only whole-trimmed-line.
    if (!inCodeFence) {
      if (afterBegin < 0) {
        if (content.equals(begin)) afterBegin = ts + begin.length;
      } else if (content.equals(end)) {
        return { afterBegin, endStart: ts };
      }
    }

    if (lineEnd >= buf.length) break;
    lineStart = lineEnd + 1;
  }
  return null;
}

/**
 * Splice one fence's content in a Buffer. Returns the new Buffer, or null when
 * no line-anchored marker pair exists outside code blocks (skip gracefully).
 * The bytes up to and including the begin marker, and from the end marker
 * onward, are preserved verbatim; only the between-markers bytes (plus any
 * trailing whitespace on the begin-marker line / indentation on the end-marker
 * line — auto-generated territory) are replaced.
 */
function spliceFence(buf: Buffer, name: string, blockLf: string): Buffer | null {
  const pos = findFencePair(buf, name);
  if (pos === null) return null;
  const nl = detectNewline(buf);
  const block = nl === '\n' ? blockLf : blockLf.split('\n').join(nl);
  const middle = Buffer.from(`${nl}${block}${nl}`, 'utf8');
  return Buffer.concat([buf.subarray(0, pos.afterBegin), middle, buf.subarray(pos.endStart)]);
}

/**
 * Refresh the auto-generated fences in <brandDir>/guide.md from the resolved
 * tokens. Post-emit build phase (see file header); returns what happened
 * without throwing on the graceful-skip cases.
 */
export function renderGuide(
  brandDir: string,
  ctx: EmitterContext,
  options: RenderGuideOptions = {},
): GuideResult {
  const guidePath = path.join(brandDir, 'guide.md');
  const guideTarget = inspectSafeRegularFileTarget(guidePath, { requireSingleLink: true });
  if (guideTarget.state === 'absent') {
    return { path: guidePath, status: 'absent', refreshed: [] };
  }
  if (guideTarget.state === 'unsafe') {
    throw new Error(`${guidePath} must be a local unlinked regular file`);
  }

  const originalFile = stableReadRegularFile(guidePath, { requireSingleLink: true });
  if (
    originalFile === undefined ||
    !sameFileIdentity(originalFile.identity, guideTarget.identity)
  ) {
    throw new Error(`${guidePath} changed while it was being read; re-run "onbrand build"`);
  }
  const original = originalFile.bytes;
  const rows = collectPaletteRows(ctx);

  // Extensible over multiple fences; today the template declares only palette.
  const fences: Array<{ name: string; block: string }> = [
    { name: 'palette', block: paletteBlock(rows) },
  ];

  let buf: Buffer = original;
  const refreshed: string[] = [];
  for (const fence of fences) {
    const next = spliceFence(buf, fence.name, fence.block);
    if (next !== null) {
      buf = next;
      refreshed.push(fence.name);
    }
  }

  if (refreshed.length === 0) {
    return { path: guidePath, status: 'no-fences', refreshed };
  }
  if (buf.equals(original)) {
    return { path: guidePath, status: 'unchanged', refreshed };
  }

  // Shared exclusive staging uses an unpredictable sibling and preserves the
  // exact guide identity read above. A linked/replaced guide or staging inode
  // is rejected before the atomic rename, so operator prose stays fully old
  // or fully new.
  let staged: StagedFile | undefined;
  try {
    staged = stageFileExclusive(guidePath, buf, { exactMode: originalFile.mode });
    if (
      staged.targetSnapshot.state !== 'file' ||
      !sameFileIdentity(staged.targetSnapshot.identity, originalFile.identity)
    ) {
      throw new Error('guide.md changed after it was read');
    }
    options.beforeGuideRename?.();
    publishStagedFile(staged, guidePath);
  } catch (cause) {
    if (staged !== undefined) removeOwnedFile(staged.path, staged.identity);
    throw new Error(
      `failed while writing ${guidePath} (${cause instanceof Error ? cause.message : String(cause)}) — ` +
        'guide.md prose is unchanged; re-run "onbrand build"',
    );
  }
  return { path: guidePath, status: 'updated', refreshed };
}
