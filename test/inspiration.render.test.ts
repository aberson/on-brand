/**
 * Focused structural contract for the standalone inspiration renderer's UAT
 * interaction surface. This stays pure: no filesystem, browser, or build
 * lifecycle is involved here.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FROZEN_ASSIGNMENT_TARGETS,
  INSPIRATION_SCHEMA,
  INSPIRATION_SCHEMA_VERSION,
  inspirationIdForAssetSha256,
  type InspirationTrace,
} from '../src/inspiration/contract.ts';
import { renderInspirationHtml } from '../src/inspiration/render.ts';
import type { ResolvedInspirationTrace } from '../src/inspiration/resolve.ts';

// A valid, bounded one-pixel PNG. Keeping this fixture in-process makes the
// renderer test a true model -> HTML contract rather than a loader test.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9W9QF0oAAAAASUVORK5CYII=',
  'base64',
);
const PNG_SHA256 = createHash('sha256').update(PNG).digest('hex');

function resolvedFixture(): ResolvedInspirationTrace {
  const trace: InspirationTrace = {
    schema: INSPIRATION_SCHEMA,
    schemaVersion: INSPIRATION_SCHEMA_VERSION,
    id: inspirationIdForAssetSha256(PNG_SHA256),
    reviewStatus: 'generated-draft',
    summary: 'A compact measured blue palette.',
    asset: {
      path: 'assets/inspiration.png',
      sha256: PNG_SHA256,
      mediaType: 'image/png',
      alt: 'One blue pixel.',
      creator: 'Test painter',
      title: 'Synthetic blue',
      date: '2026',
      sourceUrl: null,
      rights: 'Test-only fixture',
      licenseUrl: null,
      retrievedAt: null,
    },
    analysis: {
      sourceKind: 'image',
      algorithm: 'image-cluster-v1',
      basePreset: 'default',
      primary: { sampleId: 'sample-01', selectionSource: 'deterministic' },
      neutral: null,
      secondaries: [],
      unobservedDefaults: ['typography', 'spacing', 'radius', 'shadow', 'motion', 'status'],
      defaultDerivedColorTargets: FROZEN_ASSIGNMENT_TARGETS.slice(2).map((token) => ({
        token,
        role: token.startsWith('color.chart.') ? 'categorical' as const : 'diagram' as const,
        reason: 'no-qualifying-image-sample' as const,
      })),
    },
    mappings: [
      {
        id: 'sample-01',
        label: 'Measured blue',
        region: { x: 0, y: 0, width: 0.04, height: 0.04 },
        sample: {
          hex: '#3b63a8',
          method: 'image-cluster-v1',
          selectionSource: 'deterministic',
          pixelShare: 1,
        },
        targets: [
          'color.chart.categorical.1',
          'color.diagram.spine-accent',
          'color.primitive.brand.9',
          'color.semantic.accent',
        ].map((token) => ({
          token,
          presentation: 'swatch-only' as const,
          relationship: 'sampled' as const,
          usage: `Synthetic ${token} assignment.`,
        })),
        rationale: 'Measured sample mapped deterministically.',
        confidence: 'high',
      },
    ],
  };
  const mapping = trace.mappings[0]!;

  return {
    projectDir: 'C:/fixture',
    brandDir: 'C:/fixture/brand',
    tracePath: 'C:/fixture/brand/inspiration.json',
    traceSha256: 'a'.repeat(64),
    trace,
    asset: {
      path: 'C:/fixture/brand/assets/inspiration.png',
      relativePath: trace.asset.path,
      bytes: PNG,
      sha256: PNG_SHA256,
      mediaType: 'image/png',
      width: 1,
      height: 1,
    },
    mappings: [
      {
        ...mapping,
        targets: mapping.targets.map((target) => ({
          ...target,
          lightHex: '#3b63a8',
          darkHex: '#6e9bff',
        })),
      },
    ],
    defaultDerivedColorTargets: trace.analysis.defaultDerivedColorTargets.map((target) => ({
      ...target,
      lightHex: '#3b63a8',
      darkHex: '#6e9bff',
    })),
  };
}

describe('renderInspirationHtml UAT interaction surface', () => {
  it('renders one portable raster with overview, disclosure, mode, zoom, and specimen handoff hooks', () => {
    const html = renderInspirationHtml(resolvedFixture());

    // The modal must reuse the normal image at runtime instead of serialising a
    // second base64 copy and risking the standalone HTML size cap.
    expect(html.match(/data:image\/png;base64,/g)).toHaveLength(1);

    expect(html).toContain('<html lang="en" data-theme="light">');
    expect(html).toMatch(/<button\b[^>]*id="theme-toggle"/);
    expect(html).toMatch(/class="[^"]*\bpalette-overview\b[^"]*"/);
    expect(html).toMatch(/<details\b[^>]*class="[^"]*\bmapping-details\b[^"]*"/);
    expect(html).toMatch(/<details\b[^>]*>\s*<summary>/);

    expect(html).toMatch(/<button\b[^>]*id="image-zoom-open"/);
    expect(html).toMatch(/<dialog\b[^>]*id="image-zoom-dialog"/);
    expect(html).toMatch(/<button\b[^>]*id="image-zoom-toggle"/);

    // Both resolved modes stay in the source; the active-mode toggle decides
    // which one is presented rather than losing the provenance of either.
    expect(html).toContain('#3b63a8');
    expect(html).toContain('#6e9bff');
    expect(html).toContain('Open full component specimen');
    expect(html).toContain('href="specimen.html"');
  });

  it('keeps compact semantic DOM and assistive-technology order explicit', () => {
    const html = renderInspirationHtml(resolvedFixture());

    const sourcePrimary = html.indexOf('<section class="source-primary"');
    const implementationPrimary = html.indexOf('<section class="implementation-primary"');
    const sourceSecondary = html.indexOf('<section class="source-secondary"');
    const implementationSecondary = html.indexOf('<section class="implementation-secondary"');
    expect([sourcePrimary, implementationPrimary, sourceSecondary, implementationSecondary].every((index) => index >= 0)).toBe(true);
    expect(sourcePrimary).toBeLessThan(implementationPrimary);
    expect(implementationPrimary).toBeLessThan(sourceSecondary);
    expect(sourceSecondary).toBeLessThan(implementationSecondary);
    expect(html).not.toMatch(/\b(?:order|display): contents\b/);
    expect(html.match(/class="asset-alt"/g)).toHaveLength(1);

    const details = [...html.matchAll(/<details\b([^>]*)>/g)];
    expect(details).toHaveLength(2);
    expect(details.every((match) => !/\bopen(?:\s|=|$)/.test(match[1]!))).toBe(true);
  });

  it('exposes explicit no-JavaScript fallbacks and deterministic control semantics', () => {
    const html = renderInspirationHtml(resolvedFixture());

    expect(html).toContain('<noscript><p class="no-js-note" role="note">');
    expect(html).toMatch(/id="theme-toggle"[^>]*aria-pressed="false"[^>]*aria-controls="palette-overview mode-status"/);
    expect(html).toMatch(/id="image-zoom-open"[^>]*aria-haspopup="dialog"[^>]*aria-controls="image-zoom-dialog"/);
  });

  it('associates each numbered pin, palette item, and detail card with unique IDs', () => {
    const model = resolvedFixture();
    const first = model.mappings[0]!;
    model.mappings.push({
      ...first,
      id: 'sample-02',
      label: 'Measured violet',
      region: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 },
      sample: { ...first.sample, hex: '#6c4fa3' },
      targets: first.targets.map((target) => ({
        ...target,
        lightHex: '#6c4fa3',
        darkHex: '#b89cff',
      })),
    });

    const html = renderInspirationHtml(model);
    expect(html).toMatch(/<ol class="sr-only source-pin-fallback"[^>]*>[\s\S]*id="source-pin-fallback-1"[\s\S]*id="source-pin-fallback-2"[\s\S]*<\/ol>/);
    for (const number of [1, 2]) {
      expect(html).toMatch(new RegExp(`<span id="source-pin-${number}" class="pin"[^>]*aria-describedby="source-pin-fallback-${number}"[^>]*aria-details="mapping-detail-${number}"[^>]*data-mapping-number="${number}"`));
      expect(html).toMatch(new RegExp(`<article id="palette-item-${number}" class="palette-item"[^>]*aria-labelledby="palette-number-${number} palette-label-${number}"[^>]*aria-details="mapping-detail-${number}"[^>]*data-mapping-number="${number}"`));
      expect(html).toMatch(new RegExp(`<article id="mapping-detail-${number}" class="mapping"[^>]*aria-labelledby="mapping-detail-number-${number} mapping-${number}"[^>]*data-mapping-number="${number}"`));
    }

    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('renders authored alt fallback text and names the missing-dark-mode resolution', () => {
    const model = resolvedFixture();
    for (const mapping of model.mappings) {
      for (const target of mapping.targets) target.darkHex = null;
    }
    for (const target of model.defaultDerivedColorTargets) target.darkHex = null;

    const html = renderInspirationHtml(model);
    expect(html).toContain('<img id="inspiration-image"');
    expect(html).toContain('alt="One blue pixel."');
    expect(html).toContain('<dd class="asset-alt">One blue pixel.</dd>');
    expect(html).toContain('No dark mode file was resolved; dark previews reuse these light token values.');
    expect(html).toContain('var hasDarkMode = false;');
    expect(html).toContain('no dark mode file; using light value');
  });

  it('escapes hostile trace prose across the compact and detailed surfaces', () => {
    const model = resolvedFixture();
    const hostile = '<img src=x onerror=alert(1)>';
    model.trace.summary = hostile;
    model.trace.asset.alt = hostile;
    model.mappings[0]!.label = hostile;
    model.mappings[0]!.rationale = hostile;
    model.mappings[0]!.targets[0]!.usage = hostile;

    const html = renderInspirationHtml(model);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain(hostile);
  });
});
