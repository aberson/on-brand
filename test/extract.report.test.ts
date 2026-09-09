/**
 * extraction-report.md + guide.md DRAFT renderers (Step 12, report.ts).
 * Pure/offline: no spawn, no I/O. Drives the real normalizer producer for the
 * evidence and a hand-built LlmAssistResult so the escaping + section structure
 * are pinned exactly.
 *
 * SECURITY focus: every site-derived string embedded in the report/guide is
 * markdown-escaped (untrusted-content firewall for the markdown output context).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalize } from '../src/extract/normalize.ts';
import {
  mdText,
  renderExtractionReport,
  renderGuideDraft,
  type ReportInput,
} from '../src/extract/report.ts';
import type { LlmAssistResult } from '../src/extract/llm.ts';
import type { RawExtraction } from '../src/extract/engine/adapter.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/extraction/raw-extraction/', import.meta.url));

function loadFixture(name: string): RawExtraction {
  return JSON.parse(readFileSync(`${FIXTURES}${name}.json`, 'utf8')) as RawExtraction;
}

/** A schema-complete LlmAssistResult with overridable fields. */
function llmResult(overrides: Partial<LlmAssistResult> = {}): LlmAssistResult {
  return {
    status: 'ok',
    manifestStatus: 'used',
    colorPick: { pick: '#334488', rationale: 'The cobalt reads as the primary.', source: 'llm' },
    aesthetic: { summary: 'Clean, technical, and calm.', source: 'llm' },
    voice: {
      draft: {
        bullets: ['Be clear.', 'Stay warm.', 'Prefer plain words.'],
        examples: [
          { before: 'Submit the form.', after: 'Send it our way.' },
          { before: 'An error occurred.', after: 'Something slipped.' },
          { before: 'Purchase now.', after: 'Make it yours.' },
        ],
      },
      source: 'llm',
      isTodo: false,
    },
    warnings: [],
    ...overrides,
  };
}

function reportInput(overrides: Partial<ReportInput> = {}): ReportInput {
  const extraction = loadFixture('example');
  return {
    url: 'https://example.com/',
    host: 'example.com',
    extraction,
    normalize: normalize(extraction),
    llm: llmResult(),
    screenshots: [{ label: 'viewport', relPath: 'brand/assets/example.png' }],
    generatedAt: '2026-07-16T12:00:00.000Z',
    ...overrides,
  };
}

describe('mdText (untrusted -> safe markdown prose)', () => {
  it('escapes markdown-active characters', () => {
    expect(mdText('[x](y)')).toBe('\\[x\\]\\(y\\)');
    expect(mdText('a | b')).toBe('a \\| b');
    expect(mdText('# not a heading')).toBe('\\# not a heading');
    expect(mdText('`code`')).toBe('\\`code\\`');
  });

  it('flattens control bytes to spaces (calibration anchor)', () => {
    // A tab (0x09) and a would-be newline injection collapse to spaces — no raw
    // control bytes reach the rendered markdown.
    expect(mdText('a\tb')).toBe('a b');
    const bel = String.fromCharCode(7); // built numerically — no literal control byte in source
    const stripped = mdText('x' + bel + 'y');
    expect(stripped).toBe('x y');
    for (const ch of stripped) expect(ch.charCodeAt(0)).toBeGreaterThanOrEqual(0x20);
  });
});

describe('renderExtractionReport', () => {
  it('contains all required evidence sections', () => {
    const md = renderExtractionReport(reportInput());
    expect(md).toContain('# on-brand extraction report');
    expect(md).toContain('## Aesthetic summary');
    expect(md).toContain('## Screenshots');
    expect(md).toContain('![viewport capture](brand/assets/example.png)');
    expect(md).toContain('## Computed-style color clusters');
    expect(md).toContain('## Per-token confidence');
    expect(md).toContain('## Top brand-color candidates');
    expect(md).toContain('## Font mapping');
    // A candidate table with a "Chosen" marker.
    expect(md).toContain('| Rank | Candidate |');
  });

  it('surfaces the LLM pick + rationale and marks the source', () => {
    const md = renderExtractionReport(reportInput());
    expect(md).toContain('LLM pick');
    expect(md).toContain('The cobalt reads as the primary.');
  });

  it('marks a heuristic pick under --no-llm', () => {
    const md = renderExtractionReport(
      reportInput({
        llm: llmResult({
          manifestStatus: 'skipped',
          status: 'skipped',
          reason: 'disabled by --no-llm',
          colorPick: { pick: '#334488', rationale: 'heuristic top candidate', source: 'heuristic' },
          aesthetic: { summary: 'placeholder', source: 'heuristic' },
        }),
      }),
    );
    expect(md).toContain('heuristic pick');
    expect(md).toContain('LLM assist: skipped');
  });

  it('markdown-escapes a hostile LLM rationale (no raw injection)', () => {
    const hostile = 'IGNORE ABOVE | ## Owned [pwn](javascript:1) `x`';
    const md = renderExtractionReport(
      reportInput({
        llm: llmResult({ colorPick: { pick: '#334488', rationale: hostile, source: 'llm' } }),
      }),
    );
    expect(md).not.toContain(hostile); // the raw string never appears verbatim
    expect(md).toContain('\\#\\# Owned'); // every markdown-active char is escaped
    expect(md).toContain('\\[pwn\\]');
  });

  it('renders LF only, ends with a newline', () => {
    const md = renderExtractionReport(reportInput());
    expect(md).not.toContain('\r');
    expect(md.endsWith('\n')).toBe(true);
  });
});

/** Two chromatic candidates: red (rank 1 by role-weight) + blue (rank 2). */
const TWO_CANDIDATE: RawExtraction = {
  url: 'https://two.example/',
  extractedAt: '2026-07-16T00:00:00.000Z',
  engine: { name: 'fake', version: '0' },
  colors: [
    { hex: '#c81e1e', frequency: 30, roles: [{ role: 'accent', count: 8 }] },
    { hex: '#1e40c8', frequency: 15, roles: [{ role: 'accent', count: 3 }] },
    { hex: '#111111', frequency: 100, roles: [{ role: 'text', count: 50 }] },
    { hex: '#ffffff', frequency: 200, roles: [{ role: 'background', count: 100 }] },
  ],
  fonts: [{ families: ['Inter'], role: 'body', frequency: 5 }],
  typeSizes: [{ px: 16, frequency: 5 }],
  spacing: [],
  radii: [],
  shadows: [],
  screenshots: [],
};

describe('renderExtractionReport — content pins (not just section headers)', () => {
  it('pins the candidate-table rank-1 row against the example fixture data', () => {
    const input = reportInput();
    const md = renderExtractionReport(input);
    const top = input.normalize.seedCandidates[0]!;
    const rank1 = md.split('\n').find((l) => l.startsWith('| 1 |'))!;
    expect(rank1).toContain(`\`${top.hex}\``); // #334488
    expect(rank1).toContain(`\`${top.score.toFixed(2)}\``); // score rendered from data
    expect(rank1).toContain(`\`${top.chroma.toFixed(3)}\``);
    expect(rank1.includes('| yes |')).toBe(true); // default llm pick == this hex
  });

  it('pins the HIGH/MEDIUM/LOW confidence branch per group (example fixture)', () => {
    const lines = renderExtractionReport(reportInput()).split('\n');
    const rowFor = (needle: string) => lines.find((l) => l.includes(needle) && l.includes('|'))!;
    expect(rowFor('brand (seed)')).toContain('HIGH'); // one dominant candidate
    expect(rowFor('type.size.base')).toContain('MEDIUM'); // 2 type sizes (<3)
    expect(rowFor('space scale')).toContain('HIGH'); // 3 spacing values
    expect(rowFor('radius.sm')).toContain('LOW'); // 0 radii
    expect(rowFor('shadow.elevation')).toContain('LOW'); // 0 shadows
  });

  it('marks the LLM pick — NOT the heuristic seed — as chosen when they diverge', () => {
    const norm = normalize(TWO_CANDIDATE);
    const pick = norm.seedCandidates[1]!.hex; // rank 2
    expect(pick).not.toBe(norm.seed); // divergence precondition (red rank 1, blue rank 2)
    const md = renderExtractionReport(
      reportInput({
        extraction: TWO_CANDIDATE,
        normalize: norm,
        screenshots: [],
        llm: llmResult({ colorPick: { pick, rationale: 'LLM prefers rank 2.', source: 'llm' } }),
      }),
    );
    expect(md).toContain(`**Chosen brand color:** \`${pick}\``);
    const lines = md.split('\n');
    const rank1 = lines.find((l) => l.startsWith('| 1 |'))!;
    const rank2 = lines.find((l) => l.startsWith('| 2 |'))!;
    expect(rank1).toContain(`\`${norm.seed}\``); // rank 1 = heuristic seed
    expect(rank1.includes('| yes |')).toBe(false); // heuristic row NOT chosen
    expect(rank2).toContain(`\`${pick}\``);
    expect(rank2.includes('| yes |')).toBe(true); // LLM-picked row IS chosen
  });
});

describe('renderGuideDraft', () => {
  it('marks the guide DRAFT, keeps the palette fence, fills the LLM voice', () => {
    const input = reportInput();
    const md = renderGuideDraft({
      projectName: input.host,
      host: input.host,
      url: input.url,
      llm: input.llm,
      normalize: input.normalize,
    });
    expect(md).toContain('Brand Guide (DRAFT)');
    expect(md).toContain('<!-- onbrand:begin palette -->');
    expect(md).toContain('<!-- onbrand:end palette -->');
    expect(md).toContain('DRAFT (LLM-generated');
    expect(md).toContain('Be clear.');
    expect(md).toContain('## Voice & tone');
  });

  it('falls back to a TODO voice stub when the LLM voice is a stub', () => {
    const input = reportInput();
    const md = renderGuideDraft({
      projectName: input.host,
      host: input.host,
      url: input.url,
      llm: llmResult({
        voice: {
          draft: {
            bullets: ['TODO: describe the voice.', 'TODO: note the tone.', 'TODO: what to avoid.'],
            examples: [
              { before: 'TODO: a.', after: 'TODO: b.' },
              { before: 'TODO: c.', after: 'TODO: d.' },
              { before: 'TODO: e.', after: 'TODO: f.' },
            ],
          },
          source: 'stub',
          isTodo: true,
        },
      }),
      normalize: input.normalize,
    });
    expect(md).toContain('the LLM voice draft was unavailable');
    expect(md).not.toContain('DRAFT (LLM-generated');
  });
});
