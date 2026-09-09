/**
 * dist-output parsing for `onbrand preview` (plan §7) — the "consume only
 * dist/ outputs" surface-discovery half of src/preview (module map in
 * specimen.ts's header). Pure string parsers, no filesystem.
 *
 * UNTRUSTED-INPUT DOCTRINE (applied UNIFORMLY — Step 6 review BUG-1): a dist
 * file that was hand-edited or produced by a future from-url run is untrusted
 * input, and that covers EVERY dist surface this module reads, not just
 * diagram-palette.json. Concretely:
 *   - tokens.css var NAMES are guarded by isSafeClassSuffix before they can
 *     reach a `var(--...)` inside a style attribute — htmlEscape alone is the
 *     wrong layer there: it stops tag/attribute breakout but `,`/`(`/`)` are
 *     legal attribute text, so a hostile name like
 *     `--x, url(https://evil/beacon)` would smuggle a var() FALLBACK argument
 *     (a CSS network-request primitive) past it.
 *   - diagram-palette.json KEYS are guarded the same way (selector breakout);
 *     its VALUES pass forbiddenCssValueSequence (declaration/style-element
 *     breakout AND string-token corruption — see the quote rationale there).
 *   - .badge--* suffix scanning can only accumulate identifier chars by
 *     construction.
 * All guards FAIL LOUD (PreviewError -> CLI exit 1) — the repo-wide "a silent
 * drop is never acceptable" naming-gate policy; a legit `onbrand build` can
 * never trip them (css.ts's tokenPathToCssVar normalizes var names to
 * [a-zA-Z0-9_-]; cssDeclarationValue rejects breakout values at build time).
 *
 * The char-class predicates are the SHARED ones from build/emitters/naming.ts,
 * and the loadable-Google-Fonts test reuses the from-url lookalike table's
 * target-family set from extract/fonts.ts (one source of truth — both imports
 * are pure, read no token data, and are the two whitelisted non-sibling imports
 * in the dist-only enforcement test). Sequence scanning uses numeric char-code
 * comparisons, never regex escape classes (repo authoring-hazard rule; see
 * test/repo.text-hygiene.test.ts).
 */

import { isIdentCharCode, isSafeClassSuffix } from '../build/emitters/naming.ts';
import { isGoogleFont } from '../extract/fonts.ts';

// Re-export for callers/tests reaching the guards through the preview surface.
export { isIdentCharCode, isSafeClassSuffix } from '../build/emitters/naming.ts';

/**
 * A preview cannot be generated (no built dist, or a dist file is hostile /
 * corrupt). The CLI maps this to exit 1 with the actionable message it
 * carries (plan §6). Constructor-assignment .name shape, matching
 * TokenResolveError / TokenValidationError.
 */
export class PreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviewError';
  }
}

// ---------------------------------------------------------------------------
// Value guard
// ---------------------------------------------------------------------------

/**
 * First sequence in a rendered CSS value that could corrupt a
 * `background: <v>;` declaration inside the specimen's generated <style>
 * block: ";" ends the declaration, "{"/"}" escape the block, "<"/">" could
 * form `</style>`, the comment delimiters open/close comments, quote chars
 * open a CSS string token (an UNTERMINATED string becomes a <bad-string-token>
 * that swallows the rest of the line — the `;`/`}` included — silently eating
 * later swatch rules; Step 6 review BUG-2), and control characters have no
 * place in a one-line declaration. Returns a description of the offending
 * sequence, or undefined when clean. Legitimate color values (hex, oklch()/
 * clamp() expressions) never contain any of these.
 */
export function forbiddenCssValueSequence(css: string): string | undefined {
  for (let i = 0; i < css.length; i++) {
    const code = css.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return `control character (code ${code})`;
    const ch = css[i]!;
    if (ch === ';' || ch === '{' || ch === '}' || ch === '<' || ch === '>') return `"${ch}"`;
    if (ch === '"' || ch === "'") return `quote character (${ch})`;
    if (ch === '/' && css[i + 1] === '*') return 'comment delimiter "/*"';
    if (ch === '*' && css[i + 1] === '/') return 'comment delimiter "*' + '/"';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// tokens.css var names
// ---------------------------------------------------------------------------

/**
 * Every CSS custom-property NAME declared in a stylesheet, first-seen order,
 * de-duplicated. A declaration line is `--name: value;`; the name is the text
 * before the FIRST ":" (custom-property names never contain ":"). Dark-block
 * re-declarations collapse to the first (light :root) occurrence, preserving
 * the emitted token order.
 *
 * FAIL-LOUD GUARD (BUG-1): each extracted name's tail (after "--") must pass
 * isSafeClassSuffix — the names are later embedded as `var(<name>)` inside
 * style attributes, where a hostile tail could carry a var() fallback
 * argument (file header). A real `onbrand build` can never produce an unsafe
 * name (tokenPathToCssVar normalizes to [a-zA-Z0-9_-]), so any hit means a
 * hand-edited / hostile dist: throw, never skip silently.
 */
export function cssVarNames(css: string, sourceLabel: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const rawLine of css.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('--')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (!isSafeClassSuffix(name.slice(2))) {
      throw new PreviewError(
        `${sourceLabel} declares a custom property ${JSON.stringify(name)} whose name is not a safe ` +
          'identifier ([A-Za-z0-9_-]+ after "--") — refusing to embed it in a var() reference ' +
          '(a hostile name can smuggle a var() fallback); re-run "onbrand build"',
      );
    }
    if (seen.has(name)) continue;
    seen.add(name);
    order.push(name);
  }
  return order;
}

/** Trailing run of digits parsed as a number (for numeric ramp ordering). */
function numericSuffix(name: string): number {
  let end = name.length;
  let start = end;
  while (start > 0) {
    const code = name.charCodeAt(start - 1);
    if (code >= 0x30 && code <= 0x39) start--;
    else break;
  }
  return start < end ? Number(name.slice(start, end)) : Number.NaN;
}

/**
 * Var names under `<prefix>` (e.g. "--color-chart-categorical-"), numeric ramp
 * groups sorted by their trailing number, others left in first-seen order.
 */
export function varsWithPrefix(varNames: readonly string[], prefix: string, numeric: boolean): string[] {
  const matched = varNames.filter((n) => n.startsWith(prefix) && n.length > prefix.length);
  if (!numeric) return matched;
  return [...matched].sort((a, b) => {
    const na = numericSuffix(a);
    const nb = numericSuffix(b);
    if (Number.isNaN(na) || Number.isNaN(nb)) return 0;
    return na - nb;
  });
}

// ---------------------------------------------------------------------------
// components.css badge recipes
// ---------------------------------------------------------------------------

/**
 * `.badge--<name>` recipe suffixes emitted by components.css, first-seen order,
 * de-duplicated. Char-scan for the literal ".badge--" then the identifier tail
 * (isIdentCharCode — the shared char-class). Safe by construction: only
 * identifier characters can accumulate, so no guard/throw is needed here.
 */
export function badgeNames(componentsCss: string): string[] {
  const marker = '.badge--';
  const seen = new Set<string>();
  const order: string[] = [];
  let from = 0;
  for (;;) {
    const at = componentsCss.indexOf(marker, from);
    if (at < 0) break;
    let i = at + marker.length;
    let name = '';
    while (i < componentsCss.length && isIdentCharCode(componentsCss.charCodeAt(i))) {
      name += componentsCss[i];
      i++;
    }
    from = at + marker.length;
    if (name.length > 0 && !seen.has(name)) {
      seen.add(name);
      order.push(name);
    }
  }
  return order;
}

// ---------------------------------------------------------------------------
// diagram-palette.json
// ---------------------------------------------------------------------------

export interface DiagramEntry {
  key: string;
  className: string;
  light: string;
  dark: string;
}

interface DiagramPaletteDoc {
  light?: Record<string, unknown>;
  dark?: Record<string, unknown>;
}

/**
 * Parse dist/diagram-palette.json into ordered {key, light, dark} entries,
 * failing loud (PreviewError) on a hostile key/value — see the file header's
 * untrusted-input doctrine. key order = light-object authoring order; dark
 * falls back to the light value when absent.
 */
export function parseDiagramPalette(jsonText: string, sourceLabel: string): DiagramEntry[] {
  let doc: DiagramPaletteDoc;
  try {
    doc = JSON.parse(jsonText) as DiagramPaletteDoc;
  } catch (cause) {
    throw new PreviewError(
      `${sourceLabel} is not valid JSON (${cause instanceof Error ? cause.message : String(cause)}) — re-run "onbrand build"`,
    );
  }
  const light = doc.light;
  if (light === undefined || typeof light !== 'object') {
    throw new PreviewError(`${sourceLabel} has no "light" object — re-run "onbrand build"`);
  }
  const dark = (doc.dark ?? {}) as Record<string, unknown>;
  const entries: DiagramEntry[] = [];
  for (const key of Object.keys(light)) {
    if (!isSafeClassSuffix(key)) {
      throw new PreviewError(
        `${sourceLabel} diagram key ${JSON.stringify(key)} is not a safe CSS class suffix ` +
          '([A-Za-z0-9_-]+) — refusing to render a specimen that could break out of its selector',
      );
    }
    const lightValue = String((light as Record<string, unknown>)[key]);
    const darkRaw = dark[key];
    const darkValue = darkRaw === undefined ? lightValue : String(darkRaw);
    for (const [slot, value] of [
      ['light', lightValue],
      ['dark', darkValue],
    ] as const) {
      const forbidden = forbiddenCssValueSequence(value);
      if (forbidden !== undefined) {
        throw new PreviewError(
          `${sourceLabel} diagram ${slot} value for ${JSON.stringify(key)} contains forbidden ${forbidden} — ` +
            'refusing to embed a value that could corrupt the specimen <style> block',
        );
      }
    }
    entries.push({ key, className: `dsw--${key}`, light: lightValue, dark: darkValue });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// tokens.css font families (webfont loading)
// ---------------------------------------------------------------------------

/**
 * The `--font-*` custom properties a specimen can load a webfont for, in the
 * order they should appear in <head> (sans, heading, mono).
 */
const FONT_VARS = ['--font-sans', '--font-heading', '--font-mono'] as const;

/** Strip a single matched pair of surrounding double/single quotes, then trim. */
function stripSurroundingQuotes(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1).trim();
    }
  }
  return text;
}

/**
 * First-choice family declared for a `--font-*` custom property in tokens.css,
 * or undefined when the property is absent. The declared value is
 * `Family, "Fallback", system-ui, ...`; we take the text up to the first comma,
 * trim it, and strip one layer of surrounding quotes ("JetBrains Mono" ->
 * JetBrains Mono). Pure string parse (no filesystem) — the unit-test seam. The
 * trailing `:` on the prefix keeps `--font-sans` from matching a hypothetical
 * `--font-sans-serif` declaration.
 */
export function firstFontFamily(tokensCss: string, varName: string): string | undefined {
  const prefix = `${varName}:`;
  for (const rawLine of tokensCss.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith(prefix)) continue;
    let value = line.slice(prefix.length).trim();
    const semi = value.indexOf(';');
    if (semi >= 0) value = value.slice(0, semi);
    const first = value.split(',')[0]?.trim() ?? '';
    const family = stripSurroundingQuotes(first);
    return family.length > 0 ? family : undefined;
  }
  return undefined;
}

/**
 * A font-family display name safe to place in a Google Fonts URL + <link>:
 * ASCII letters, digits, and single spaces only (real families like "Source
 * Serif 4" / "JetBrains Mono" pass). Char-code scan, no regex escape classes
 * (repo authoring-hazard rule). Safe-by-construction gate mirroring the naming
 * guards — a hostile hand-edited font value carrying quotes/brackets is excluded
 * rather than smuggled into the emitted markup.
 */
function isSafeFontFamily(family: string): boolean {
  if (family.length === 0) return false;
  for (let i = 0; i < family.length; i++) {
    const code = family.charCodeAt(i);
    const ok =
      (code >= 0x30 && code <= 0x39) || // 0-9
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a) || // a-z
      code === 0x20; // space
    if (!ok) return false;
  }
  return true;
}

/**
 * The loadable Google Fonts families a specimen should <link>: the first-choice
 * family of each --font-* role (sans, heading, mono) that is BOTH a curated
 * Google Fonts family (extract/fonts.ts's lookalike table is the one source of
 * truth) AND a safe display name. Deduped case-insensitively, order-stable
 * (sans, heading, mono). Families that are not Google Fonts (system stacks like
 * "Verdana", variable-font blobs like "Mona Sans VF") are omitted so they fall
 * back to the system chain.
 */
export function loadableGoogleFonts(tokensCss: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const varName of FONT_VARS) {
    const family = firstFontFamily(tokensCss, varName);
    if (family === undefined || !isSafeFontFamily(family) || !isGoogleFont(family)) continue;
    const key = family.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(family);
  }
  return out;
}
