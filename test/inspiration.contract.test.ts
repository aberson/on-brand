import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultPresetsRoot, resolveTokensFile } from '../src/schema/resolve.ts';
import {
  FROZEN_ASSIGNMENT_TARGETS,
  INSPIRATION_SCHEMA,
  INSPIRATION_SCHEMA_VERSION,
  inspirationIdForAssetSha256,
  validateInspirationTrace,
  type InspirationTrace,
} from '../src/inspiration/contract.ts';
import { InspirationLoadError, loadInspirationTrace } from '../src/inspiration/load.ts';
import { renderInspirationHtml } from '../src/inspiration/render.ts';
import { InspirationResolveError, resolveInspirationTrace } from '../src/inspiration/resolve.ts';

// A tiny valid 1×1 opaque PNG. Tests only need a bounded, header-valid raster;
// no real artwork becomes a CI input.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9W9QF0oAAAAASUVORK5CYII=',
  'base64',
);
const PNG_SHA256 = createHash('sha256').update(PNG).digest('hex');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function trace(overrides: Partial<InspirationTrace> = {}): InspirationTrace {
  const source: InspirationTrace = {
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
      creator: 'unknown',
      title: 'Synthetic blue',
      date: 'unknown',
      sourceUrl: null,
      rights: 'unknown',
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
          // These four default-preset primary assignments all resolve exactly
          // to this value, exercising the sampled relationship invariant.
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
  return { ...source, ...overrides };
}

function writeTrace(input: InspirationTrace): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'onbrand-inspiration-'));
  roots.push(root);
  const assets = path.join(root, 'brand', 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(path.join(assets, 'inspiration.png'), PNG);
  writeFileSync(path.join(root, 'brand', 'inspiration.json'), `${JSON.stringify(input, null, 2)}\n`);
  return root;
}

/** The same canonical trace re-measured by the current producer algorithm. */
function v2Trace(overrides: Partial<InspirationTrace> = {}): InspirationTrace {
  const base = trace();
  return {
    ...base,
    analysis: { ...base.analysis, algorithm: 'image-cluster-v2' },
    mappings: base.mappings.map((mapping) => ({
      ...mapping,
      sample: { ...mapping.sample, method: 'image-cluster-v2' as const },
    })),
    ...overrides,
  };
}

function issueText(value: unknown): string {
  return validateInspirationTrace(value)
    .issues.map((issue) => `${issue.path}: ${issue.message}`)
    .join('\n');
}

describe('inspiration contract', () => {
  it('accepts a closed canonical trace with explicit frozen-table coverage', () => {
    const result = validateInspirationTrace(trace());
    expect(result.ok).toBe(true);
    expect(result.trace?.id).toBe(inspirationIdForAssetSha256(PNG_SHA256));
  });

  it('accepts an image-cluster-v2 trace without changing the envelope version', () => {
    const result = validateInspirationTrace(v2Trace());
    expect(result.ok).toBe(true);
    expect(result.trace?.schemaVersion).toBe(INSPIRATION_SCHEMA_VERSION);
    expect(result.trace?.analysis.algorithm).toBe('image-cluster-v2');
    expect(result.trace?.mappings[0]?.sample.method).toBe('image-cluster-v2');
  });

  it('rejects an algorithm outside the supported image-cluster vocabulary', () => {
    const unknown = v2Trace() as unknown as Record<string, unknown>;
    (unknown['analysis'] as Record<string, unknown>)['algorithm'] = 'image-cluster-v3';
    expect(issueText(unknown)).toContain('analysis.algorithm');

    const unknownMethod = trace();
    (unknownMethod.mappings[0]!.sample as unknown as Record<string, unknown>)['method'] = 'kmeans-v1';
    expect(issueText(unknownMethod)).toContain('mappings[0].sample.method');
  });

  it('rejects any analysis-versus-mapping algorithm mismatch in either direction', () => {
    const newerAnalysis = v2Trace({ mappings: trace().mappings });
    expect(issueText(newerAnalysis)).toContain(
      'mappings[0].sample.method: must equal "image-cluster-v2" (analysis.algorithm)',
    );

    const newerMapping = trace({ mappings: v2Trace().mappings });
    expect(issueText(newerMapping)).toContain(
      'mappings[0].sample.method: must equal "image-cluster-v1" (analysis.algorithm)',
    );
  });

  it('rejects unknown keys and traversal-shaped asset paths', () => {
    const hostile = trace() as unknown as Record<string, unknown>;
    hostile['surprise'] = true;
    const asset = hostile['asset'] as Record<string, unknown>;
    asset['path'] = 'assets/../outside.png';

    const result = validateInspirationTrace(hostile);
    expect(result.ok).toBe(false);
    const message = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n');
    expect(message).toContain('surprise');
    expect(message).toContain('asset.path');
  });

  it('rejects duplicate mappings targets and omitted frozen-table coverage', () => {
    const malformed = trace();
    // Stay inside the per-mapping target cap so cross-field checks run.
    malformed.mappings[0]!.targets[1] = structuredClone(malformed.mappings[0]!.targets[0]!);
    malformed.analysis.defaultDerivedColorTargets = [];
    const result = validateInspirationTrace(malformed);
    expect(result.ok).toBe(false);
    const message = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n');
    expect(message).toContain('duplicate target');
    expect(message).toContain('missing explicit mapped/default-derived coverage');
  });
});

describe('inspiration load / resolve / render seam', () => {
  it('loads exact contained bytes, resolves real current tokens, and renders safe portable HTML', () => {
    const root = writeTrace(trace());
    const loaded = loadInspirationTrace(root);
    expect(loaded).toBeDefined();
    expect(loaded?.asset).toMatchObject({ sha256: PNG_SHA256, width: 1, height: 1, mediaType: 'image/png' });

    const light = resolveTokensFile(path.join(defaultPresetsRoot(), 'default', 'tokens.json')).document;
    const resolved = resolveInspirationTrace(loaded!, light);
    const html = renderInspirationHtml(resolved);
    expect(html).toContain(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(html).toContain('color.chart.categorical.1');
    expect(html).toContain('Open full component specimen');
    expect(html).toContain('<dd class="asset-alt">One blue pixel.</dd>');
    expect(html).toContain('No dark mode file was resolved; dark previews reuse these light token values.');
    expect(html).toContain('no dark mode file; using light value');
    expect(html).toMatch(/<noscript><style>[^<]*\.light-value, \.dark-value \{ display: inline !important; \}/);
    expect(html).toMatch(/aria-label="color\.chart\.categorical\.1: light (#(?:[0-9a-f]{6})), dark \1"/);

    const escapedTrace = trace({ summary: '<img src=x onerror=alert(1)>' });
    const escapedRoot = writeTrace(escapedTrace);
    const escapedLoaded = loadInspirationTrace(escapedRoot)!;
    const escapedHtml = renderInspirationHtml(resolveInspirationTrace(escapedLoaded, light));
    expect(escapedHtml).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(escapedHtml).not.toContain('<img src=x onerror=alert(1)>');
  });

  it('fails a present trace whose checked-in raster hash is wrong', () => {
    const bad = trace();
    bad.asset.sha256 = '0'.repeat(64);
    bad.id = inspirationIdForAssetSha256(bad.asset.sha256);
    const root = writeTrace(bad);
    expect(() => loadInspirationTrace(root)).toThrow(InspirationLoadError);
    expect(() => loadInspirationTrace(root)).toThrow(/SHA-256/);
  });

  it('fails sampled mappings whose resolved implementation value differs', () => {
    const root = writeTrace(trace());
    const loaded = loadInspirationTrace(root)!;
    const light = resolveTokensFile(path.join(defaultPresetsRoot(), 'default', 'tokens.json')).document;
    loaded.trace.mappings[0]!.sample.hex = '#000000';
    expect(() => resolveInspirationTrace(loaded, light)).toThrow(InspirationResolveError);
    expect(() => resolveInspirationTrace(loaded, light)).toThrow(/requires source #000000 to equal/);
  });
});
