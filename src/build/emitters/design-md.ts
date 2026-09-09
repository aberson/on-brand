/**
 * DESIGN.md emitter (adoption decision: docs/research/design-md-adoption.md) —
 * a DERIVED agent-facing design-system description in the Google Labs
 * DESIGN.md format (github.com/google-labs-code/design.md, spec version
 * "alpha"): YAML front matter of machine-readable tokens + a markdown body of
 * tables/prose, generated entirely from brand/tokens.json (+ modes.dark.json
 * overlay). tokens.json stays the ONLY source of truth — this file is one more
 * dist/ output, never hand-maintained (code-quality: one source of truth).
 *
 * Mapping decisions (the DESIGN.md schema is looser than DTCG; each choice
 * favors honesty over fabrication):
 *   - `name` — `$extensions.onbrand.name` when present, else "Brand"
 *     (DESIGN.md requires a name; tokens.json has no name field).
 *   - `colors` — ALL color-type tokens, keys = path segments hyphen-joined
 *     with a leading `color`/`colors` group segment dropped
 *     (color.semantic.bg -> semantic-bg). Injectivity-gated (naming.ts): two
 *     paths collapsing onto one key fail the build, never last-wins.
 *   - `primary` alias — DESIGN.md's linter expects a primary color; when no
 *     token derives the key `primary`, we alias `color.semantic.accent` (or a
 *     token deriving `accent`) and say so in the body.
 *   - `spacing` / `rounded` — the conventional `space`/`spacing` and
 *     `radius`/`rounded` groups, same key rule (spacing admits dimension AND
 *     number values per the spec's map<string, Dimension|number>; rounded is
 *     dimension-only per its map<string, Dimension> — a number-typed radius
 *     token still appears in the Shapes body table).
 *   - `typography` front matter is OMITTED (it is optional): DESIGN.md wants
 *     composite styles (fontFamily+fontSize+... per style) and tokens.json
 *     holds decomposed tokens with no style grouping — composing pairs would
 *     be fabrication. The body's Typography table carries every font token.
 *   - Dark mode / motion — the DESIGN.md spec has NO mode or motion concept;
 *     the Colors table carries a Dark column (effective overlay values) and
 *     custom `## Dark Mode` / `## Motion` sections document them. Unknown
 *     sections are spec-legal (the format's PHILOSOPHY.md: user extension).
 *   - Body tables are COMPLETE (every token, classified by type first, then
 *     conventional group name); anything unclassifiable lands under
 *     `## Other Tokens` rather than being dropped silently.
 *
 * Prose NEVER uses the spec's `{path.to.token}` reference syntax except where
 * the path exists in the front matter — the DESIGN.md linter's broken-ref rule
 * checks references against front matter, so source dot paths appear as plain
 * code spans instead.
 *
 * Determinism: token order comes from ctx.light (flattenTokens enumeration
 * order), section order is fixed (spec order, then extensions), LF line
 * endings, trailing newline, ASCII-only content (repo emitted-header rule).
 */

import {
  childEntries,
  isPlainObject,
  isToken,
  type ShadowValue,
  type TokensDocument,
  type TokenValue,
} from '../../schema/types.ts';
import type { EmittedFile, EmitterContext, FlatToken } from '../compile.ts';
import { shadowToCss } from './css.ts';
import { assertInjectiveNames, isIdentCharCode, type EmittedName } from './naming.ts';

// ---------------------------------------------------------------------------
// Front-matter key derivation
// ---------------------------------------------------------------------------

/** Leading group segments dropped per front-matter map (conventional names). */
const COLOR_HEADS = ['color', 'colors'] as const;
const SPACING_HEADS = ['space', 'spacing'] as const;
const ROUNDED_HEADS = ['radius', 'rounded'] as const;

function frontMatterKey(token: FlatToken, dropHeads: readonly string[]): string {
  const segments =
    token.path.length > 1 && dropHeads.includes(token.path[0]!)
      ? token.path.slice(1)
      : token.path;
  return segments.join('-');
}

// ---------------------------------------------------------------------------
// Section classification (type first, then conventional group name)
// ---------------------------------------------------------------------------

type SectionId = 'colors' | 'typography' | 'layout' | 'elevation' | 'shapes' | 'motion' | 'other';

/** Fixed render order: spec sections in spec order, then extension sections. */
const SECTION_ORDER: readonly SectionId[] = [
  'colors',
  'typography',
  'layout',
  'elevation',
  'shapes',
  'motion',
  'other',
];

const SECTION_HEADINGS: Record<SectionId, string> = {
  colors: '## Colors',
  typography: '## Typography',
  layout: '## Layout',
  elevation: '## Elevation & Depth',
  shapes: '## Shapes',
  motion: '## Motion',
  other: '## Other Tokens',
};

function classify(token: FlatToken): SectionId {
  if (token.type === 'color') return 'colors';
  if (token.type === 'shadow') return 'elevation';
  if (token.type === 'duration' || token.type === 'cubicBezier') return 'motion';
  if (token.type === 'fontFamily' || token.type === 'fontWeight') return 'typography';
  const head = token.path[0];
  if (head === 'font' || head === 'type' || head === 'typography') return 'typography';
  if (head === 'space' || head === 'spacing') return 'layout';
  if (head === 'radius' || head === 'rounded') return 'shapes';
  return 'other';
}

// ---------------------------------------------------------------------------
// YAML rendering (hand-rolled safe subset — no YAML dependency; every scalar
// is double-quoted via JSON.stringify, which is valid YAML double-quote style)
// ---------------------------------------------------------------------------

function isAsciiLetterCode(code: number): boolean {
  const isLower = code >= 0x61 && code <= 0x7a;
  const isUpper = code >= 0x41 && code <= 0x5a;
  return isLower || isUpper;
}

/**
 * Keys a YAML 1.1/1.2 core-schema parser resolves as bool/null when left
 * unquoted (lowercase forms; the check lowercases first). Left bare, `on:` or
 * `null:` would parse as a boolean/null key, not the intended string.
 */
const YAML_RESERVED_KEYS = new Set([
  'true',
  'false',
  'yes',
  'no',
  'on',
  'off',
  'y',
  'n',
  'null',
]);

/**
 * A key stays unquoted only when YAML cannot mis-type it: leading ASCII
 * letter, then [A-Za-z0-9_-], and not a bool/null reserved word
 * (numeric-looking keys like "1" MUST be quoted so they parse as strings,
 * not ints).
 */
function yamlKey(name: string): string {
  if (name.length === 0) return JSON.stringify(name);
  if (!isAsciiLetterCode(name.charCodeAt(0))) return JSON.stringify(name);
  if (YAML_RESERVED_KEYS.has(name.toLowerCase())) return JSON.stringify(name);
  for (let i = 0; i < name.length; i++) {
    if (!isIdentCharCode(name.charCodeAt(i))) return JSON.stringify(name);
  }
  return name;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Markdown rendering helpers
// ---------------------------------------------------------------------------

/**
 * Escape table-breaking characters: newlines collapse to spaces (a
 * $description may legally contain them — validate.ts only requires a string)
 * and pipes are escaped so a cell can never split its row.
 */
function mdCell(text: string): string {
  return text.replace(/\r\n|[\r\n]/g, ' ').split('|').join('\\|');
}

/**
 * Code span; content containing a backtick (legal in token names — only
 * `.{}` are forbidden) gets a space-padded double-backtick fence per GFM so
 * the span cannot be closed early.
 */
function mdCode(text: string): string {
  const escaped = mdCell(text);
  return escaped.includes('`') ? `\`\` ${escaped} \`\`` : `\`${escaped}\``;
}

function isShadowObject(value: TokenValue): value is ShadowValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Render a token $value as a single table-cell string (CSS-ish forms). */
export function tokenValueToText(value: TokenValue): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map((item) => tokenValueToText(item as TokenValue)).join(', ');
  if (isShadowObject(value)) return shadowToCss(value); // one source of truth with css.ts
  // Unreachable for validated documents; fail loud rather than emit garbage.
  throw new Error(`DESIGN.md emitter: unsupported token value ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// Document metadata ($extensions.onbrand + root $description)
// ---------------------------------------------------------------------------

function onbrandExtension(doc: TokensDocument): Record<string, unknown> {
  const ext = (doc as { $extensions?: unknown }).$extensions;
  if (!isPlainObject(ext)) return {};
  const onbrand = ext['onbrand'];
  return isPlainObject(onbrand) ? onbrand : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Group $description strings, in tree order, keyed by group dot path. */
function collectGroupDescriptions(doc: TokensDocument): Array<{ dotPath: string; text: string }> {
  const out: Array<{ dotPath: string; text: string }> = [];
  walkGroups(doc, [], out);
  return out;
}

function walkGroups(
  group: Record<string, unknown>,
  segments: string[],
  out: Array<{ dotPath: string; text: string }>,
): void {
  for (const [name, child] of childEntries(group)) {
    if (!isPlainObject(child) || isToken(child)) continue;
    const childSegments = [...segments, name];
    const description = child['$description'];
    if (typeof description === 'string' && description.length > 0) {
      out.push({ dotPath: childSegments.join('.'), text: description });
    }
    walkGroups(child, childSegments, out);
  }
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

interface FrontMatterEntry {
  key: string;
  token: FlatToken;
}

function frontMatterEntries(
  tokens: readonly FlatToken[],
  dropHeads: readonly string[],
  emitterLabel: string,
): FrontMatterEntry[] {
  const entries = tokens.map((token) => ({ key: frontMatterKey(token, dropHeads), token }));
  const names: EmittedName[] = entries.map((entry) => ({
    name: entry.key,
    dotPath: entry.token.dotPath,
    label: `token "${entry.token.dotPath}"`,
  }));
  assertInjectiveNames(
    names,
    emitterLabel,
    'hyphen-joining path segments collapsed two token paths onto one DESIGN.md front-matter key - rename one of the tokens',
  );
  return entries;
}

function renderFrontMatterMap(key: string, entries: readonly FrontMatterEntry[]): string[] {
  if (entries.length === 0) return [];
  const lines = [`${key}:`];
  for (const entry of entries) {
    lines.push(`  ${yamlKey(entry.key)}: ${yamlString(tokenValueToText(entry.token.value))}`);
  }
  return lines;
}

function renderTable(
  tokens: readonly FlatToken[],
  darkValues: ReadonlyMap<string, TokenValue>,
): string[] {
  const hasDark = tokens.some((token) => darkValues.has(token.dotPath));
  const hasNotes = tokens.some((token) => token.description !== undefined);
  const header = ['Token', hasDark ? 'Light' : 'Value'];
  if (hasDark) header.push('Dark');
  if (hasNotes) header.push('Notes');
  const lines = [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => ' --- ').join('|')}|`,
  ];
  for (const token of tokens) {
    const cells = [mdCode(token.dotPath), mdCode(tokenValueToText(token.value))];
    if (hasDark) {
      const dark = darkValues.get(token.dotPath);
      cells.push(dark === undefined ? '' : mdCode(tokenValueToText(dark)));
    }
    if (hasNotes) cells.push(token.description === undefined ? '' : mdCell(token.description));
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines;
}

/** Emit brand/dist/DESIGN.md. */
export function emitDesignMd(ctx: EmitterContext): EmittedFile[] {
  const doc = ctx.lightDocument;
  const extension = onbrandExtension(doc);
  const name = stringOrUndefined(extension['name']) ?? 'Brand';
  const description =
    stringOrUndefined(extension['description']) ??
    stringOrUndefined((doc as { $description?: unknown }).$description);

  // Partition every token into exactly one section (classify is total).
  const sections = new Map<SectionId, FlatToken[]>(SECTION_ORDER.map((id) => [id, []]));
  for (const token of ctx.light) sections.get(classify(token))!.push(token);

  const colorTokens = sections.get('colors')!;
  const spacingTokens = sections
    .get('layout')!
    .filter((token) => token.type === 'dimension' || token.type === 'number');
  const roundedTokens = sections.get('shapes')!.filter((token) => token.type === 'dimension');

  const colorEntries = frontMatterEntries(colorTokens, COLOR_HEADS, 'DESIGN.md emitter (colors)');
  const spacingEntries = frontMatterEntries(
    spacingTokens,
    SPACING_HEADS,
    'DESIGN.md emitter (spacing)',
  );
  const roundedEntries = frontMatterEntries(
    roundedTokens,
    ROUNDED_HEADS,
    'DESIGN.md emitter (rounded)',
  );

  // Linter-friendly `primary` alias when no token derives that key itself.
  let primaryAliasSource: string | undefined;
  if (!colorEntries.some((entry) => entry.key === 'primary')) {
    const aliasToken =
      colorTokens.find((token) => token.dotPath === 'color.semantic.accent') ??
      colorEntries.find((entry) => entry.key === 'accent')?.token;
    if (aliasToken !== undefined) {
      colorEntries.unshift({ key: 'primary', token: aliasToken });
      primaryAliasSource = aliasToken.dotPath;
    }
  }

  const darkValues = new Map<string, TokenValue>(
    ctx.darkOverrides.map((token) => [token.dotPath, token.value]),
  );
  const groupDescriptions = collectGroupDescriptions(doc);
  const hasOverlay = ctx.darkDocument !== undefined;

  const lines: string[] = [
    '---',
    '# GENERATED by on-brand - DO NOT EDIT.',
    hasOverlay
      ? '# Source of truth: brand/tokens.json (+ modes.dark.json overlay).'
      : '# Source of truth: brand/tokens.json.',
    '# Regenerate with `onbrand build`.',
    '# Format: DESIGN.md spec, github.com/google-labs-code/design.md',
    `name: ${yamlString(name)}`,
    'version: "alpha" # the DESIGN.md spec version this file targets',
    ...(description !== undefined ? [`description: ${yamlString(description)}`] : []),
    ...renderFrontMatterMap('colors', colorEntries),
    ...renderFrontMatterMap('spacing', spacingEntries),
    ...renderFrontMatterMap('rounded', roundedEntries),
    '---',
    '',
    '## Overview',
    '',
  ];
  if (description !== undefined) lines.push(description, '');
  if (hasOverlay) {
    lines.push(
      'This file is generated by on-brand from `brand/tokens.json` (light values) and',
      '`brand/modes.dark.json` (dark-mode color overlay). Do not edit it by hand;',
    );
  } else {
    lines.push('This file is generated by on-brand from `brand/tokens.json`. Do not edit it by hand;');
  }
  lines.push(
    'regenerate with `onbrand build`. The YAML front matter above carries the',
    'machine-readable token maps; the tables below are the complete token set.',
    'When writing code, prefer importing the sibling `brand/dist/` outputs over',
    'copying raw values from this document.',
  );

  const placedGroupBullets = new Set<string>();
  for (const id of SECTION_ORDER) {
    const tokens = sections.get(id)!;
    if (tokens.length === 0) continue;
    lines.push('', SECTION_HEADINGS[id], '');
    if (id === 'colors') {
      lines.push(
        'Front-matter `colors` keys are the source token paths below with the leading',
        '`color` group dropped and dots replaced by hyphens.',
      );
      if (primaryAliasSource !== undefined) {
        lines.push(`The front-matter \`primary\` entry aliases \`${primaryAliasSource}\`.`);
      }
      lines.push('');
    }
    if (id === 'motion') {
      lines.push(
        'Motion tokens have no DESIGN.md front-matter slot; this extension section',
        'carries them (`duration` values and `cubicBezier` easing curves).',
        '',
      );
    }
    if (id === 'other') {
      lines.push('Tokens that fit no standard DESIGN.md section.', '');
    }
    // First section (in render order) containing a group's token wins the
    // bullet — a mixed-type group must not print its description twice.
    const bullets = groupDescriptions.filter(
      (group) =>
        !placedGroupBullets.has(group.dotPath) &&
        tokens.some(
          (token) =>
            token.dotPath === group.dotPath || token.dotPath.startsWith(`${group.dotPath}.`),
        ),
    );
    for (const bullet of bullets) {
      placedGroupBullets.add(bullet.dotPath);
      lines.push(`- ${mdCode(bullet.dotPath)} - ${mdCell(bullet.text)}`);
    }
    if (bullets.length > 0) lines.push('');
    lines.push(...renderTable(tokens, darkValues));
  }

  // Gate on actual overrides, not just overlay presence: an existing-but-empty
  // modes.dark.json yields no Dark column anywhere, so describing one would lie.
  if (ctx.darkDocument !== undefined && ctx.darkOverrides.length > 0) {
    lines.push(
      '',
      '## Dark Mode',
      '',
      'Dark values come from `brand/modes.dark.json`, a color-only overlay over',
      '`brand/tokens.json`. The Dark column in the Colors table shows the effective',
      'dark value for each overridden token; tokens without a Dark entry keep their',
      'light value in dark mode. The DESIGN.md format has no mode concept, so this',
      'extension section documents the convention.',
    );
  }

  return [{ relPath: 'DESIGN.md', content: `${lines.join('\n')}\n` }];
}
