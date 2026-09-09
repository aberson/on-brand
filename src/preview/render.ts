/**
 * specimen HTML rendering for `onbrand preview` — the template half of
 * src/preview (module map in specimen.ts's header). renderSpecimen() is PURE
 * (model in, HTML string out; no filesystem), so the zero-literal grep gate
 * can run against it directly in unit tests.
 *
 * ZERO AUTHORED COLOR LITERALS (Step 6 Done-when grep gate). Every color this
 * template shows is a var() reference (chart swatches: style="background:
 * var(--color-chart-categorical-1)") or comes from the linked components.css
 * classes. The ONE exception is the diagram palette row:
 * dist/diagram-palette.json holds RAW color values (not CSS vars), so its
 * light+dark values are emitted into a single fenced <style> island delimited
 * by `onbrand:begin diagram-palette` / `onbrand:end diagram-palette` (the
 * guide-render.ts marker scheme, in CSS comments). Those values are
 * DIST-SOURCED, not authored by this template; the grep-gate test strips
 * exactly that fence and asserts everything else is literal-free
 * (test/helpers/color-literals.ts). This is how the diagram row demonstrates
 * consuming a non-CSS dist artifact.
 *
 * This file is one concern (the HTML/CSS/JS template — mostly literal
 * blocks); the parsers feeding it live in dist-parse.ts, the filesystem
 * orchestration in specimen.ts.
 */

import type { DiagramEntry } from './dist-parse.ts';

/**
 * Fence markers around the one dist-sourced (non-authored) color block —
 * guide-render.ts's `onbrand:begin <name>` / `onbrand:end <name>` scheme,
 * rendered inside CSS comments here (guide.md uses HTML comments).
 */
export const DIAGRAM_FENCE_BEGIN = 'onbrand:begin diagram-palette';
export const DIAGRAM_FENCE_END = 'onbrand:end diagram-palette';

/**
 * HTML-escape text nodes / attribute values (five entities; char-code walk —
 * repo authoring-hazard rule). NOTE: this is tag/attribute-BREAKOUT
 * protection only. Values that land in a CSS context (style attributes,
 * <style> blocks) additionally need the dist-parse.ts guards — see BUG-1's
 * var()-fallback rationale there.
 */
function htmlEscape(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&#39;';
    else out += ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface SpecimenModel {
  /** --color-chart-categorical-* var names (ordered). */
  chartCategorical: string[];
  /** --color-chart-sequential-* var names (ordered). */
  chartSequential: string[];
  /** --color-chart-chrome-* var names (first-seen order). */
  chartChrome: string[];
  /** .badge--<name> suffixes from components.css. */
  statusBadges: string[];
  /** diagram-palette.json entries (dist-sourced values). */
  diagram: DiagramEntry[];
  /** Whether dist/palette.svg exists (embedded via <img> when true). */
  hasPaletteSvg: boolean;
  /**
   * Loadable Google Fonts families to <link> from fonts.googleapis.com (the
   * first-choice family of each --font-* role that is a curated Google Fonts
   * family). Empty when the brand uses only system/unmapped families.
   */
  fonts: string[];
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** A single labeled swatch whose color comes from a CSS var (zero literals). */
function varSwatch(varName: string, label: string): string {
  const safeVar = htmlEscape(varName);
  return (
    `      <div class="swatch">\n` +
    `        <div class="csw" style="background: var(${safeVar})"></div>\n` +
    `        <span class="sw-label">${htmlEscape(label)}</span>\n` +
    `      </div>`
  );
}

/** Short trailing label for a var (text after the prefix), for swatch captions. */
function varLabel(varName: string, prefix: string): string {
  return varName.startsWith(prefix) ? varName.slice(prefix.length) : varName;
}

/** The one fenced, dist-sourced <style> island mapping diagram keys to colors. */
function diagramStyleBlock(entries: readonly DiagramEntry[]): string {
  const lines: string[] = [];
  lines.push('    <style>');
  lines.push(
    `      /* ${DIAGRAM_FENCE_BEGIN} — values from dist/diagram-palette.json ` +
      '(dist-sourced, NOT authored literals; the grep gate excludes this fence) */',
  );
  for (const entry of entries) {
    lines.push(`      .${entry.className} { background: ${entry.light}; }`);
    lines.push(`      [data-theme="dark"] .${entry.className} { background: ${entry.dark}; }`);
  }
  lines.push(`      /* ${DIAGRAM_FENCE_END} */`);
  lines.push('    </style>');
  return lines.join('\n');
}

/** Authored layout styles — colors are var() ONLY (grep-gate compliant). */
const LAYOUT_STYLE = `    <style>
      /* Authored layout — every color is a var() reference; zero literals. */
      *, *::before, *::after { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: var(--font-sans);
        font-size: var(--type-scale-step-0);
        line-height: var(--type-line-height-base);
        background: var(--color-semantic-bg);
        color: var(--color-semantic-text);
      }
      .wrap { max-width: 980px; margin: 0 auto; padding: var(--space-6) var(--space-5); }
      .topbar {
        display: flex; align-items: center; justify-content: space-between;
        gap: var(--space-4); flex-wrap: wrap; margin-bottom: var(--space-4);
      }
      section { margin: var(--space-7) 0; }
      h1, h2, h3 { font-family: var(--font-heading); color: var(--color-semantic-text); margin: 0 0 var(--space-3); }
      h1 { font-size: var(--type-scale-step-4); line-height: var(--type-line-height-tight); }
      h2 {
        font-size: var(--type-scale-step-2); line-height: var(--type-line-height-tight);
        padding-bottom: var(--space-2); border-bottom: 1px solid var(--color-semantic-border);
      }
      h3 { font-size: var(--type-scale-step-1); }
      p { margin: 0 0 var(--space-3); max-width: 62ch; }
      .muted { color: var(--color-semantic-text-muted); }
      code, .mono {
        font-family: var(--font-mono); font-size: var(--type-scale-step--1);
        background: var(--color-semantic-code-bg); color: var(--color-semantic-text);
        padding: 0 var(--space-1); border-radius: var(--radius-sm);
      }
      .cluster { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; }
      .stack { display: flex; flex-direction: column; gap: var(--space-3); }
      .grid-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-4); }
      .swatches { display: flex; flex-wrap: wrap; gap: var(--space-3); }
      .swatch { display: flex; flex-direction: column; align-items: center; gap: var(--space-1); }
      .csw, .dsw { width: 48px; height: 48px; border-radius: var(--radius-md); border: 1px solid var(--color-semantic-border); }
      .sw-label { font-family: var(--font-mono); font-size: var(--type-scale-step--1); color: var(--color-semantic-text-muted); }
      .ramp { display: flex; border-radius: var(--radius-md); overflow: hidden; border: 1px solid var(--color-semantic-border); }
      .ramp > span { flex: 1 1 0; height: 34px; }
      .bars { display: flex; flex-direction: column; gap: var(--space-2); max-width: 420px; }
      .bar { height: 16px; border-radius: var(--radius-sm); }
      .chrome-demo {
        padding: var(--space-4); border: 1px solid var(--color-chart-chrome-grid);
        border-radius: var(--radius-md); background: var(--color-semantic-surface);
      }
      .chrome-demo .axis { height: 1px; background: var(--color-chart-chrome-axis); margin: var(--space-3) 0; }
      .chrome-demo .axis-label { color: var(--color-chart-chrome-label); font-size: var(--type-scale-step--1); }
      .palette-img { max-width: 100%; height: auto; border: 1px solid var(--color-semantic-border); border-radius: var(--radius-md); }
      .footnote { font-size: var(--type-scale-step--1); color: var(--color-semantic-text-muted); }
    </style>`;

function section(title: string, bodyLines: string[]): string {
  return [`    <section>`, `      <h2>${htmlEscape(title)}</h2>`, ...bodyLines, `    </section>`].join('\n');
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function typographySection(): string {
  return section('Typography', [
    '      <h1>The quick brown fox</h1>',
    '      <h3>Heading three, still on the heading stack</h3>',
    '      <p>Body copy set in the sans stack at the base fluid step. Design tokens keep' +
      ' the type scale, spacing rhythm, and color roles in one source of truth.</p>',
    '      <p class="muted">Muted secondary text — used for captions and metadata.</p>',
    '      <p>Inline <code>code</code> uses the mono stack and the code-bg surface.</p>',
  ]);
}

function buttonsSection(): string {
  return section('Buttons', [
    '      <div class="cluster">',
    '        <button type="button" class="btn">Primary</button>',
    '        <button type="button" class="btn btn--secondary">Secondary</button>',
    '        <button type="button" class="btn btn--ghost">Ghost</button>',
    '      </div>',
  ]);
}

function cardsSection(): string {
  return section('Cards', [
    '      <div class="grid-cards">',
    '        <div class="card">',
    '          <h3 class="card__title">Card title</h3>',
    '          <p class="muted">Surface, border, radius, and elevation shadow all come from tokens.</p>',
    '        </div>',
    '        <div class="card">',
    '          <h3 class="card__title">Another card</h3>',
    '          <p class="muted">The recipe lives in components.css, built purely on the CSS vars.</p>',
    '        </div>',
    '      </div>',
  ]);
}

function badgesSection(model: SpecimenModel): string {
  const badges =
    model.statusBadges.length > 0
      ? model.statusBadges
          .map((name) => `        <span class="badge badge--${name}">${htmlEscape(name)}</span>`)
          .join('\n')
      : '        <span class="badge">no status badges in this brand</span>';
  return section('Status badges', ['      <div class="cluster">', '        <span class="badge">neutral</span>', badges, '      </div>']);
}

function chartSection(model: SpecimenModel): string {
  const lines: string[] = [];

  lines.push('      <h3>Categorical series</h3>');
  lines.push('      <div class="swatches">');
  if (model.chartCategorical.length > 0) {
    lines.push(
      model.chartCategorical
        .map((v, i) => varSwatch(v, String(i + 1)))
        .join('\n'),
    );
  } else {
    lines.push('        <span class="sw-label">no categorical chart tokens</span>');
  }
  lines.push('      </div>');

  // A small faux bar chart proving the categorical vars drive real marks.
  if (model.chartCategorical.length > 0) {
    const widths = [92, 76, 60, 48, 34, 27, 20, 14];
    lines.push('      <div class="bars">');
    lines.push(
      model.chartCategorical
        .map((v, i) => {
          const width = widths[i % widths.length]!;
          return `        <div class="bar" style="width: ${width}%; background: var(${htmlEscape(v)})"></div>`;
        })
        .join('\n'),
    );
    lines.push('      </div>');
  }

  if (model.chartSequential.length > 0) {
    lines.push('      <h3>Sequential ramp</h3>');
    lines.push('      <div class="ramp">');
    lines.push(
      model.chartSequential
        .map((v) => `        <span style="background: var(${htmlEscape(v)})"></span>`)
        .join('\n'),
    );
    lines.push('      </div>');
  }

  if (model.chartChrome.length > 0) {
    lines.push('      <h3>Chart chrome</h3>');
    lines.push('      <div class="chrome-demo">');
    lines.push('        <span class="axis-label">axis label</span>');
    lines.push('        <div class="axis"></div>');
    lines.push('        <div class="swatches">');
    lines.push(
      model.chartChrome
        .map((v) => varSwatch(v, varLabel(v, '--color-chart-chrome-')))
        .join('\n'),
    );
    lines.push('        </div>');
    lines.push('      </div>');
  }

  return section('Charts', lines);
}

function diagramSection(model: SpecimenModel): string {
  const swatches =
    model.diagram.length > 0
      ? model.diagram
          .map(
            (entry) =>
              `        <div class="swatch">\n` +
              `          <div class="dsw ${entry.className}"></div>\n` +
              `          <span class="sw-label">${htmlEscape(entry.key)}</span>\n` +
              `        </div>`,
          )
          .join('\n')
      : '        <span class="sw-label">no diagram palette</span>';
  return section('Diagram palette', [
    '      <p class="muted">Rendered from <code>dist/diagram-palette.json</code> values (dist-sourced), flips with the theme.</p>',
    '      <div class="swatches">',
    swatches,
    '      </div>',
  ]);
}

function tableSection(): string {
  return section('Table', [
    '      <table class="table">',
    '        <thead><tr><th>Token group</th><th>Purpose</th><th>Modes</th></tr></thead>',
    '        <tbody>',
    '          <tr><td>color.semantic</td><td>bg / surface / text / border</td><td>light + dark</td></tr>',
    '          <tr><td>color.status</td><td>success / warning / danger / info</td><td>light + dark</td></tr>',
    '          <tr><td>color.chart</td><td>categorical + sequential + chrome</td><td>light + dark</td></tr>',
    '        </tbody>',
    '      </table>',
  ]);
}

function formSection(): string {
  return section('Form controls', [
    '      <div class="stack" style="max-width: 360px">',
    '        <div class="field">',
    '          <label class="field__label" for="specimen-name">Name</label>',
    '          <input class="input" id="specimen-name" type="text" placeholder="Ada Lovelace">',
    '        </div>',
    '        <div class="field">',
    '          <label class="field__label" for="specimen-role">Role</label>',
    '          <select class="select" id="specimen-role">',
    '            <option>Designer</option>',
    '            <option>Engineer</option>',
    '          </select>',
    '        </div>',
    '        <div class="field">',
    '          <label class="field__label" for="specimen-notes">Notes</label>',
    '          <textarea class="textarea" id="specimen-notes" rows="3" placeholder="Notes..."></textarea>',
    '        </div>',
    '      </div>',
  ]);
}

function paletteSvgSection(model: SpecimenModel): string {
  if (!model.hasPaletteSvg) return '';
  return section('Palette sheet (palette.svg)', [
    '      <img class="palette-img" src="palette.svg" alt="Brand palette swatch sheet (light and dark)">',
  ]);
}

/** The keyboard-accessible theme toggle (a native <button>: Enter/Space work). */
const TOGGLE_SCRIPT = `    <script>
      (function () {
        var root = document.documentElement;
        var btn = document.getElementById('theme-toggle');
        if (!btn) return;
        function apply(theme) {
          root.setAttribute('data-theme', theme);
          btn.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
          btn.textContent = theme === 'dark' ? 'Switch to light' : 'Switch to dark';
        }
        btn.addEventListener('click', function () {
          var current = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
          apply(current === 'dark' ? 'light' : 'dark');
        });
      })();
    </script>`;

/**
 * The Google Fonts <link> for the loadable families (spaces -> "+"; families
 * joined with "&family="), or "" when there are none. Pure so the URL
 * composition is unit-testable. Adds NO color literal, so the zero-literal grep
 * gate stays intact — the only new head element is this stylesheet <link>.
 */
export function googleFontsLink(families: readonly string[]): string {
  if (families.length === 0) return '';
  const params = families.map((f) => `family=${f.replaceAll(' ', '+')}`).join('&');
  return `    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?${params}&display=swap">`;
}

// ---------------------------------------------------------------------------
// renderSpecimen
// ---------------------------------------------------------------------------

/**
 * Render the full specimen.html string from a model (pure — no filesystem).
 * Linked stylesheets are sibling dist files (tokens.css, components.css) plus,
 * when the brand maps loadable Google Fonts, one webfont <link> to
 * fonts.googleapis.com; the only inline colors are inside the fenced
 * diagram-palette <style> island.
 */
export function renderSpecimen(model: SpecimenModel): string {
  const sections = [
    typographySection(),
    buttonsSection(),
    cardsSection(),
    badgesSection(model),
    chartSection(model),
    diagramSection(model),
    tableSection(),
    formSection(),
    paletteSvgSection(model),
  ].filter((s) => s !== '');

  // Optional webfont <link> line (with its own trailing newline) so an
  // empty-fonts brand leaves no blank line in the emitted head.
  const fontLinkLine = model.fonts.length > 0 ? `${googleFontsLink(model.fonts)}\n` : '';

  return `<!doctype html>
<html lang="en" data-theme="light">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>on-brand specimen</title>
    <!-- GENERATED by on-brand (onbrand preview) - DO NOT EDIT.
         A specimen of brand/dist/ tokens on sample components. Regenerate with
         \`onbrand preview\`. Links the sibling dist stylesheets; the only inline
         colors live in the fenced diagram-palette block below (dist-sourced). -->
    <link rel="stylesheet" href="tokens.css">
    <link rel="stylesheet" href="components.css">
${fontLinkLine}${LAYOUT_STYLE}
${diagramStyleBlock(model.diagram)}
  </head>
  <body>
    <div class="wrap">
      <header class="topbar">
        <h1 style="margin: 0">on-brand specimen</h1>
        <button id="theme-toggle" class="btn btn--secondary" type="button" aria-pressed="false">Switch to dark</button>
      </header>
      <p class="footnote">Every color below is a token: linked <code>tokens.css</code> + <code>components.css</code>, both modes. Toggle the theme top-right.</p>
${sections.join('\n')}
    </div>
${TOGGLE_SCRIPT}
  </body>
</html>
`;
}
