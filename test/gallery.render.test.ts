/**
 * Step 18 unit tests for the PURE gallery renderer (src/gallery/render.ts). The
 * Done-when demands DOM/accessibility assertions covering keyboard order,
 * list/detail links, and the final/proposal distinction — all provable against
 * the rendered HTML string without a browser (Step 22 owns human visual review).
 *
 * These also pin the load-bearing safety properties: a proposal is NEVER marked
 * final, and hostile filesystem-derived names / paths are escaped and encoded.
 */

import { describe, expect, it } from 'vitest';
import {
  encodePathHref,
  htmlEscape,
  renderGallery,
  type GalleryBrand,
  type GalleryModel,
} from '../src/gallery/render.ts';

function brand(overrides: Partial<GalleryBrand> = {}): GalleryBrand {
  return {
    id: 'brand-app',
    name: 'app',
    relPath: 'app',
    status: 'adopted',
    provenance: 'adopted',
    final: true,
    freshness: 'fresh (matches sources)',
    darkMode: true,
    tokenGroups: ['color', 'type', 'space'],
    check: { ran: true, ok: true, errorCount: 0, warningCount: 0, advisoryCount: 1 },
    reason: 'valid adopted brand with a fresh committed dist — current and final',
    specimenHref: './app/brand/dist/specimen.html',
    ...overrides,
  };
}

function model(brands: GalleryBrand[]): GalleryModel {
  return {
    root: '/ws',
    generatedLabel: 'generated for a test',
    brands,
    finalCount: brands.filter((b) => b.final).length,
    proposalCount: brands.filter((b) => b.provenance === 'proposal').length,
  };
}

const FINAL = brand();
const PROPOSAL = brand({
  id: 'brand-onbrand-proposal-acme-20260101',
  name: 'onbrand-proposal-acme-20260101',
  relPath: 'onbrand-proposal-acme-20260101',
  status: 'proposal',
  provenance: 'proposal',
  final: false,
  freshness: 'fresh (matches sources)',
  reason: 'valid from-url proposal with a built dist — visibly separate from adopted brands',
  specimenHref: './onbrand-proposal-acme-20260101/brand/dist/specimen.html',
});

describe('encodePathHref / htmlEscape', () => {
  it('percent-encodes unsafe path segments but keeps slashes and dot-prefix', () => {
    expect(encodePathHref('./app/brand/dist/specimen.html')).toBe(
      './app/brand/dist/specimen.html',
    );
    expect(encodePathHref('./a b/"><x/dist/specimen.html')).toBe(
      './a%20b/%22%3E%3Cx/dist/specimen.html',
    );
  });

  it('escapes the five HTML entities', () => {
    expect(htmlEscape(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
});

describe('renderGallery — keyboard order', () => {
  it('emits every list link BEFORE any detail article (natural tab order = list order)', () => {
    const html = renderGallery(model([FINAL, PROPOSAL]));
    // The whole list <nav> (and thus every in-page list link) closes before the
    // first detail <article> opens, so the natural tab order walks the list first.
    const navEnd = html.indexOf('</nav>');
    const firstArticle = html.indexOf('<article');
    expect(navEnd).toBeGreaterThan(-1);
    expect(firstArticle).toBeGreaterThan(navEnd);
    // And the nav genuinely holds both list links.
    const nav = html.slice(0, navEnd);
    expect(nav).toContain('href="#brand-app"');
    expect(nav).toContain('href="#brand-onbrand-proposal-acme-20260101"');
  });

  it('orders the list links to match brand (discovery) order', () => {
    const html = renderGallery(model([FINAL, PROPOSAL]));
    const iFinal = html.indexOf('href="#brand-app"');
    const iProposal = html.indexOf('href="#brand-onbrand-proposal-acme-20260101"');
    expect(iFinal).toBeGreaterThan(-1);
    expect(iProposal).toBeGreaterThan(iFinal);
  });

  it('adds no positive tabindex (relies on document order for focus)', () => {
    const html = renderGallery(model([FINAL, PROPOSAL]));
    expect(html).not.toMatch(/tabindex\s*=\s*"?[1-9]/);
  });
});

describe('renderGallery — list/detail links resolve', () => {
  it('every list-link target has a matching detail article id', () => {
    const html = renderGallery(model([FINAL, PROPOSAL]));
    const targets = [...html.matchAll(/href="#(brand-[^"]+)"/g)].map((m) => m[1]);
    const detailTargets = targets.filter((t) => t !== 'brand-list');
    expect(detailTargets.length).toBe(2);
    for (const id of detailTargets) {
      expect(html).toContain(`<article class="brand" id="${id}"`);
    }
  });

  it('each detail article links back to the list anchor', () => {
    const html = renderGallery(model([FINAL, PROPOSAL]));
    expect(html).toContain('id="brand-list"');
    const backlinks = [...html.matchAll(/<a href="#brand-list">Back to list<\/a>/g)];
    expect(backlinks.length).toBe(2);
  });

  it('the final brand detail links out to its specimen with an encoded href', () => {
    const html = renderGallery(model([FINAL]));
    expect(html).toContain('href="./app/brand/dist/specimen.html"');
  });
});

describe('renderGallery — final vs proposal distinction', () => {
  it('marks the adopted brand final and the proposal NOT final (badge + data-final)', () => {
    const html = renderGallery(model([FINAL, PROPOSAL]));
    // FINAL badge appears; the final article carries data-final="true".
    expect(html).toContain('<span class="badge final">Final</span>');
    expect(html).toContain('<article class="brand" id="brand-app" data-final="true"');
    // The proposal is rendered with the proposal badge and data-final="false".
    expect(html).toContain('<span class="badge proposal">Proposal</span>');
    expect(html).toContain(
      '<article class="brand" id="brand-onbrand-proposal-acme-20260101" data-final="false"',
    );
  });

  it('NEVER labels a proposal as the final specimen — its link is data-final="false"', () => {
    const html = renderGallery(model([PROPOSAL]));
    expect(html).toContain('Open proposal preview (not final)');
    expect(html).toContain('data-final="false"');
    expect(html).not.toContain('Open final specimen');
    // The word "Final" badge must not attach to a proposal-only page.
    expect(html).not.toContain('<span class="badge final">Final</span>');
  });

  it('a final brand offers the "Open final specimen" call-to-action (data-final="true")', () => {
    const html = renderGallery(model([FINAL]));
    expect(html).toContain('>Open final specimen</a>');
    expect(html).toMatch(/class="specimen-link" data-final="true"/);
  });

  it('labels a stale adopted specimen as stale, never as a proposal', () => {
    const html = renderGallery(
      model([
        brand({
          status: 'stale',
          provenance: 'adopted',
          final: false,
          freshness: 'stale (sources changed after build)',
        }),
      ]),
    );
    expect(html).toContain('Open stale specimen (rebuild before use)');
    expect(html).not.toContain('Open proposal preview');
    expect(html).toContain('data-final="false"');
  });

  it('a brand with no built specimen shows the preview hint, not a broken link', () => {
    const html = renderGallery(model([brand({ specimenHref: undefined })]));
    expect(html).toContain('No specimen built yet');
    expect(html).not.toContain('<a class="specimen-link"');
  });
});

describe('renderGallery — facets rendered', () => {
  it('surfaces provenance, freshness, dark-mode, token groups, and check state', () => {
    const html = renderGallery(model([FINAL]));
    expect(html).toContain('<dt>Provenance</dt><dd>adopted</dd>');
    expect(html).toContain('fresh (matches sources)');
    expect(html).toContain('<dd><span class="yes">available</span></dd>');
    expect(html).toContain('<span class="chip">color</span>');
    expect(html).toContain('<span class="chip">type</span>');
    expect(html).toContain('class="check-ok"');
  });

  it('renders dark-mode absence and a failing check honestly', () => {
    const html = renderGallery(
      model([
        brand({
          darkMode: false,
          check: { ran: true, ok: false, errorCount: 2, warningCount: 1, advisoryCount: 0 },
        }),
      ]),
    );
    expect(html).toContain('not provided');
    expect(html).toContain('class="check-bad"');
    expect(html).toContain('2 error(s), 1 warning(s), 0 advisory');
  });

  it('renders "not run" when the check gate could not run', () => {
    const html = renderGallery(
      model([brand({ check: { ran: false, note: 'sources do not load' } })]),
    );
    expect(html).toContain('not run — sources do not load');
  });

  it('shows an invalid brand error text', () => {
    const html = renderGallery(
      model([
        brand({
          status: 'invalid',
          final: false,
          error: 'color.semantic.bg: expected a color string',
        }),
      ]),
    );
    expect(html).toContain('class="err"');
    expect(html).toContain('color.semantic.bg: expected a color string');
  });
});

describe('renderGallery — untrusted content is neutralized', () => {
  it('escapes hostile names/relpaths and encodes hostile specimen hrefs', () => {
    const hostile = brand({
      id: 'brand-x',
      name: '<script>alert(1)</script>',
      relPath: 'a"b/<img src=x onerror=alert(1)>',
      specimenHref: './a"b/<img>/brand/dist/specimen.html',
      tokenGroups: ['<b>color</b>'],
    });
    const html = renderGallery(model([hostile]));
    // No raw hostile markup survives.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<b>color</b>');
    // Escaped forms are present.
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // The href is percent-encoded (no raw quote or angle bracket in the attr).
    expect(html).toContain('href="./a%22b/%3Cimg%3E/brand/dist/specimen.html"');
  });
});

describe('renderGallery — empty workspace', () => {
  it('renders an empty-state message and no list/detail scaffold', () => {
    const html = renderGallery(model([]));
    expect(html).toContain('No brand/ sets were discovered');
    expect(html).not.toContain('<article');
    expect(html).not.toContain('id="brand-list"');
  });
});
