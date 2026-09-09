/**
 * Static gallery HTML rendering for `onbrand gallery` (plan.md §6, §7; Step 18)
 * — the template half of src/gallery (the discovery half is discover.ts, the
 * filesystem orchestration is index.ts). renderGallery() is PURE (view model
 * in, HTML string out; no filesystem), so the DOM/accessibility assertions the
 * step's Done-when demands run against it directly in unit tests.
 *
 * WHAT THIS PAGE IS. A single standalone responsive page over every brand a
 * workspace scan (Step 17) discovered: a LIST (a keyboard-navigable index of
 * every brand, in discovery order) followed by a DETAIL section per brand
 * (provenance, freshness, token groups, dark-mode availability, check state,
 * and — for a built brand — a link to its final specimen). The list anchors
 * (`#<id>`) target the detail sections; each detail links back to the list and,
 * where a specimen exists, out to that brand's `brand/dist/specimen.html`.
 *
 * FINAL vs PROPOSAL (the load-bearing distinction, §6 D7). A proposal is NEVER
 * presented as the final brand: `final` comes straight from Step 17
 * classification (true only for `adopted`), and this template keys every
 * "final" affordance (the FINAL badge, the "Open final specimen" call-to-action,
 * the `data-final` attribute) off that one boolean. A proposal's own preview,
 * when built, is still linked — but under a visibly separate, `data-final="false"`
 * "proposal preview (not final)" affordance. Human visual review is Step 22.
 *
 * UNTRUSTED INPUT. Brand names and relPaths are filesystem-derived and may
 * contain HTML metacharacters (a directory literally named `<script>`), quotes,
 * or spaces. Every text node and attribute value is htmlEscape()d; every
 * specimen href is percent-encoded per path segment (encodePathHref) AND
 * htmlEscape()d before it lands in an attribute. Element ids are pre-sanitized
 * by index.ts to a safe `[a-z0-9-]` slug, but are escaped here too (defense in
 * depth). This template holds NO authored color tokens — it is a meta index
 * page, not a token consumer — so its own chrome CSS uses plain literal colors
 * (no relation to the zero-literal specimen grep gate).
 */

import type { BrandProvenance, BrandStatus } from './discover.ts';

/**
 * HTML-escape text nodes / attribute values (five entities; char-code walk —
 * repo authoring-hazard rule, mirrors preview/render.ts). Tag/attribute-
 * BREAKOUT protection for values placed in text or double-quoted attributes.
 */
export function htmlEscape(text: string): string {
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

/**
 * Percent-encode a forward-slash-separated relative path for use as an href,
 * segment by segment (slashes preserved as path separators; every other unsafe
 * byte — spaces, quotes, `<`, `>`, `&`, `%` — encoded). A leading "./" is kept
 * so the href is unambiguously relative. The result is still htmlEscape()d by
 * the caller before it enters an attribute.
 */
export function encodePathHref(relPath: string): string {
  return relPath
    .split('/')
    .map((seg) => (seg === '' || seg === '.' || seg === '..' ? seg : encodeURIComponent(seg)))
    .join('/');
}

// ---------------------------------------------------------------------------
// View model (built by index.ts; this file never touches the filesystem)
// ---------------------------------------------------------------------------

/** Structured check outcome for one brand (built from runCheck, or absent). */
export interface GalleryCheckState {
  /** Whether the check gate actually ran (false when sources do not load). */
  ran: boolean;
  /** Whether the gate passed (no error-severity findings). Present when ran. */
  ok?: boolean;
  errorCount?: number;
  warningCount?: number;
  advisoryCount?: number;
  /** Why the gate could not run (present only when ran is false). */
  note?: string;
}

/** One brand's full view row (all fields already resolved; render escapes). */
export interface GalleryBrand {
  /** Pre-sanitized, unique `[a-z0-9-]` element id (anchor target). */
  id: string;
  /** Display name (raw; escaped at render). */
  name: string;
  /** Root path relative to the workspace, forward slashes (raw; escaped). */
  relPath: string;
  status: BrandStatus;
  provenance: BrandProvenance;
  /** True ONLY for an adopted brand (Step 17 invariant); drives every final UI. */
  final: boolean;
  /** Human-readable freshness label (dist vs sources). */
  freshness: string;
  /** Whether a dark-mode overlay (modes.dark.json) is available. */
  darkMode: boolean;
  /** Top-level token group names (color, type, space, ...). */
  tokenGroups: string[];
  /** Structured check state (WCAG/lint/drift gate). */
  check: GalleryCheckState;
  /** One-line classification explanation (from Step 17). */
  reason: string;
  /** Loader/validation error text — present only for an invalid brand. */
  error?: string;
  /**
   * Forward-slash relative href (from the gallery file's own directory) to this
   * brand's built specimen.html, or undefined when none is built yet. Encoded
   * + escaped at render.
   */
  specimenHref?: string;
}

export interface GalleryModel {
  /** Absolute workspace root that was scanned (display; escaped). */
  root: string;
  /** Human label for when/how the page was produced (kept out of render for determinism). */
  generatedLabel: string;
  /** Discovered brands, in discovery order (Step 17 sorts by relPath). */
  brands: GalleryBrand[];
  /** Count of final (adopted) brands. */
  finalCount: number;
  /** Count of proposal-provenance brands. */
  proposalCount: number;
}

// ---------------------------------------------------------------------------
// Chrome CSS (this meta page consumes NO brand tokens — literal colors are fine)
// ---------------------------------------------------------------------------

const GALLERY_STYLE = `    <style>
      :root {
        color-scheme: light dark;
        --g-bg: #ffffff; --g-fg: #1a1d21; --g-muted: #5c6570; --g-border: #d8dde3;
        --g-surface: #f6f8fa; --g-accent: #0b5fff; --g-final: #1f7a3d; --g-final-bg: #e7f5ec;
        --g-proposal: #8a5a00; --g-proposal-bg: #fdf3e0; --g-bad: #b4232c; --g-bad-bg: #fdeceb;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --g-bg: #14171b; --g-fg: #e7ebef; --g-muted: #9aa4af; --g-border: #2c333b;
          --g-surface: #1c2127; --g-accent: #6aa3ff; --g-final: #5cc98a; --g-final-bg: #16311f;
          --g-proposal: #e0b562; --g-proposal-bg: #322611; --g-bad: #f08a90; --g-bad-bg: #331b1c;
        }
      }
      *, *::before, *::after { box-sizing: border-box; }
      body {
        margin: 0; font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        background: var(--g-bg); color: var(--g-fg);
      }
      a { color: var(--g-accent); }
      a:focus-visible, button:focus-visible { outline: 3px solid var(--g-accent); outline-offset: 2px; }
      .wrap { max-width: 1100px; margin: 0 auto; padding: 24px 20px 64px; }
      header.topbar h1 { margin: 0 0 4px; font-size: 1.6rem; }
      .sub { color: var(--g-muted); margin: 0 0 24px; font-size: 0.95rem; }
      .layout { display: grid; grid-template-columns: 1fr; gap: 28px; }
      @media (min-width: 860px) { .layout { grid-template-columns: 280px 1fr; align-items: start; } }
      nav.brand-list { border: 1px solid var(--g-border); border-radius: 10px; background: var(--g-surface); padding: 12px; }
      @media (min-width: 860px) { nav.brand-list { position: sticky; top: 16px; } }
      nav.brand-list h2 { margin: 4px 8px 10px; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--g-muted); }
      nav.brand-list ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
      nav.brand-list a { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-radius: 8px; text-decoration: none; color: var(--g-fg); }
      nav.brand-list a:hover { background: var(--g-bg); }
      .details { display: flex; flex-direction: column; gap: 24px; min-width: 0; }
      article.brand { border: 1px solid var(--g-border); border-radius: 12px; padding: 20px; background: var(--g-surface); scroll-margin-top: 16px; }
      article.brand > h3 { margin: 0 0 4px; font-size: 1.2rem; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .relpath { font: 0.85rem ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--g-muted); word-break: break-all; }
      .badge { display: inline-block; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--g-border); }
      .badge.final { color: var(--g-final); background: var(--g-final-bg); border-color: var(--g-final); }
      .badge.proposal { color: var(--g-proposal); background: var(--g-proposal-bg); border-color: var(--g-proposal); }
      .badge.bad { color: var(--g-bad); background: var(--g-bad-bg); border-color: var(--g-bad); }
      dl.facets { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 14px 0; }
      dl.facets dt { color: var(--g-muted); font-size: 0.85rem; }
      dl.facets dd { margin: 0; min-width: 0; word-break: break-word; }
      .chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .chip { font: 0.78rem ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--g-bg); border: 1px solid var(--g-border); border-radius: 6px; padding: 1px 7px; }
      .yes { color: var(--g-final); } .no { color: var(--g-muted); }
      .check-ok { color: var(--g-final); } .check-bad { color: var(--g-bad); }
      .specimen { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
      .specimen-link { display: inline-block; font-weight: 600; text-decoration: none; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--g-accent); }
      .specimen-link[data-final="true"] { background: var(--g-accent); color: #ffffff; border-color: var(--g-accent); }
      .specimen-link[data-final="false"] { color: var(--g-accent); background: transparent; }
      .specimen-none { color: var(--g-muted); font-size: 0.9rem; }
      .backlink { font-size: 0.85rem; }
      .reason { color: var(--g-muted); font-size: 0.9rem; margin: 4px 0 0; }
      .err { color: var(--g-bad); font: 0.82rem ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; }
      .empty { border: 1px dashed var(--g-border); border-radius: 12px; padding: 32px; text-align: center; color: var(--g-muted); }
    </style>`;

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** The provenance/finality badge shown in the list row and the detail heading. */
function statusBadge(brand: GalleryBrand): string {
  if (brand.final) return '<span class="badge final">Final</span>';
  if (brand.provenance === 'proposal') return '<span class="badge proposal">Proposal</span>';
  // Adopted-but-not-final (stale/invalid) — flag it as needing attention.
  return `<span class="badge bad">${htmlEscape(brand.status)}</span>`;
}

/** One `<li><a>` list entry — an in-page link to the brand's detail section. */
function listItem(brand: GalleryBrand): string {
  const id = htmlEscape(brand.id);
  const label = htmlEscape(brand.name);
  return (
    `        <li>\n` +
    `          <a href="#${id}" data-final="${brand.final ? 'true' : 'false'}">` +
    `<span class="li-name">${label}</span>${statusBadge(brand)}</a>\n` +
    `        </li>`
  );
}

/** The token-group chips (or a muted "none" when a brand exposes no groups). */
function tokenGroupChips(groups: readonly string[]): string {
  if (groups.length === 0) return '<span class="no">none</span>';
  return (
    `<span class="chips">` +
    groups.map((g) => `<span class="chip">${htmlEscape(g)}</span>`).join('') +
    `</span>`
  );
}

/** The structured check-state cell. */
function checkCell(check: GalleryCheckState): string {
  if (!check.ran) {
    return `<span class="no">not run${check.note !== undefined ? ` — ${htmlEscape(check.note)}` : ''}</span>`;
  }
  const cls = check.ok ? 'check-ok' : 'check-bad';
  const verdict = check.ok ? 'pass' : 'fail';
  const counts =
    `${check.errorCount ?? 0} error(s), ` +
    `${check.warningCount ?? 0} warning(s), ` +
    `${check.advisoryCount ?? 0} advisory`;
  return `<span class="${cls}">${verdict}</span> <span class="no">(${htmlEscape(counts)})</span>`;
}

/** The specimen call-to-action — final vs provenance/status-specific preview vs none. */
function specimenBlock(brand: GalleryBrand): string {
  if (brand.specimenHref === undefined) {
    return (
      `        <div class="specimen">\n` +
      `          <span class="specimen-none">No specimen built yet — run <code>onbrand preview</code> in this brand.</span>\n` +
      `        </div>`
    );
  }
  const href = htmlEscape(encodePathHref(brand.specimenHref));
  if (brand.final) {
    return (
      `        <div class="specimen">\n` +
      `          <a class="specimen-link" data-final="true" href="${href}">Open final specimen</a>\n` +
      `        </div>`
    );
  }
  const label =
    brand.provenance === 'proposal'
      ? 'Open proposal preview (not final)'
      : brand.status === 'stale'
        ? 'Open stale specimen (rebuild before use)'
        : brand.status === 'invalid'
          ? 'Open existing specimen (sources invalid)'
          : 'Open specimen (not final)';
  return (
    `        <div class="specimen">\n` +
    `          <a class="specimen-link" data-final="false" href="${href}">${label}</a>\n` +
    `        </div>`
  );
}

/** A full detail `<article>` for one brand. */
function detailArticle(brand: GalleryBrand): string {
  const id = htmlEscape(brand.id);
  const lines: string[] = [];
  lines.push(`      <article class="brand" id="${id}" data-final="${brand.final ? 'true' : 'false'}" data-status="${htmlEscape(brand.status)}" data-provenance="${htmlEscape(brand.provenance)}">`);
  lines.push(`        <h3>${htmlEscape(brand.name)} ${statusBadge(brand)}</h3>`);
  lines.push(`        <p class="relpath">${htmlEscape(brand.relPath)}</p>`);
  lines.push(`        <dl class="facets">`);
  lines.push(`          <dt>Provenance</dt><dd>${htmlEscape(brand.provenance)}</dd>`);
  lines.push(`          <dt>Status</dt><dd>${htmlEscape(brand.status)}${brand.final ? ' (final)' : ''}</dd>`);
  lines.push(`          <dt>Freshness</dt><dd>${htmlEscape(brand.freshness)}</dd>`);
  lines.push(
    `          <dt>Dark mode</dt><dd>${
      brand.darkMode ? '<span class="yes">available</span>' : '<span class="no">not provided</span>'
    }</dd>`,
  );
  lines.push(`          <dt>Token groups</dt><dd>${tokenGroupChips(brand.tokenGroups)}</dd>`);
  lines.push(`          <dt>Check</dt><dd>${checkCell(brand.check)}</dd>`);
  lines.push(`        </dl>`);
  lines.push(specimenBlock(brand));
  lines.push(`        <p class="reason">${htmlEscape(brand.reason)}</p>`);
  if (brand.error !== undefined) {
    lines.push(`        <p class="err">${htmlEscape(brand.error)}</p>`);
  }
  lines.push(`        <p class="backlink"><a href="#brand-list">Back to list</a></p>`);
  lines.push(`      </article>`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// renderGallery
// ---------------------------------------------------------------------------

/**
 * Render the full gallery.html string from a model (pure — no filesystem). The
 * DOM order is deliberate and load-bearing for keyboard navigation: the list
 * `<nav>` (with every brand's in-page link, in discovery order) comes FIRST in
 * the document, then the detail `<article>`s. So the natural tab order walks
 * every brand link before any detail control — no positive tabindex needed.
 */
export function renderGallery(model: GalleryModel): string {
  const summary = htmlEscape(
    `${model.brands.length} brand set(s) — ${model.finalCount} final, ${model.proposalCount} proposal`,
  );
  const root = htmlEscape(model.root);
  const generated = htmlEscape(model.generatedLabel);

  const body =
    model.brands.length === 0
      ? `      <p class="empty">No brand/ sets were discovered under this workspace root. Pass a workspace that contains one or more <code>brand/</code> directories.</p>`
      : `    <div class="layout">
      <nav class="brand-list" id="brand-list" aria-label="Discovered brands">
        <h2>Brands</h2>
        <ol>
${model.brands.map(listItem).join('\n')}
        </ol>
      </nav>
      <div class="details">
${model.brands.map(detailArticle).join('\n')}
      </div>
    </div>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>on-brand gallery</title>
    <!-- GENERATED by on-brand (onbrand gallery) - DO NOT EDIT.
         A static list/detail index of the brand/ sets discovered under a
         workspace root. Regenerate with \`onbrand gallery --root <workspace>\`.
         A proposal is never presented as the final brand. -->
${GALLERY_STYLE}
  </head>
  <body>
    <div class="wrap">
      <header class="topbar">
        <h1>on-brand gallery</h1>
        <p class="sub">${summary} · root <span class="relpath">${root}</span> · ${generated}</p>
      </header>
${body}
    </div>
  </body>
</html>
`;
}
