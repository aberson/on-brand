/**
 * extraction-report.md renderer + guide.md DRAFT renderer (plan.md §3.2, §5;
 * Step 12).
 *
 * The extraction report is the human evidence surface for a from-url proposal:
 * screenshots, computed-style cluster evidence, a per-category confidence table,
 * the top-5 brand candidates with the LLM's pick + rationale (or the heuristic
 * pick under --no-llm), the font -> lookalike mapping, and the aesthetic summary.
 * M1's acceptance is "evidence readable; nothing claims certainty it doesn't
 * have", so the confidence column is honest — a preset-fallback value is marked
 * low, not dressed up.
 *
 * ------------------------------------------------------------------ SECURITY ---
 * EVERY site-derived string embedded here is UNTRUSTED (colors, font names, the
 * URL, and the LLM passes — which read untrusted page content). This module is
 * the OUTPUT-CONTEXT escaper for the markdown surface:
 *   - VALUES (hex, font families, urls, dot paths) render as inline CODE SPANS
 *     via codeCell() (imported from the guide renderer — one source of truth for
 *     the "generated content can never break a table row / mint a marker"
 *     primitive): control bytes flatten to spaces, "|" is GFM-escaped, and the
 *     backtick fence is grown past any run inside the value.
 *   - PROSE (LLM rationale/summary/voice) is control-stripped and markdown-
 *     escaped (mdText) so a hostile string can never inject markdown structure.
 * No literal control bytes in this source (repo text-hygiene gate); every scan
 * uses numeric char-code comparisons, never a regex escape class.
 */

import { codeCell } from '../build/guide-render.ts';
import type { RawExtraction } from './engine/adapter.ts';
import type { NormalizeResult } from './normalize.ts';
import type { FontMapping } from './fonts.ts';
import type { LlmAssistResult } from './llm.ts';

/** A screenshot as the report references it: a label + a proposal-dir-relative path. */
export interface ReportScreenshot {
  label: string;
  /** Path relative to the proposal dir root (forward slashes), for the md image link. */
  relPath: string;
}

export interface ReportInput {
  url: string;
  host: string;
  extraction: RawExtraction;
  normalize: NormalizeResult;
  llm: LlmAssistResult;
  screenshots: readonly ReportScreenshot[];
  /** ISO-8601 UTC string, injected clock (deterministic in tests). */
  generatedAt: string;
}

// --- markdown escaping (untrusted -> safe prose) -----------------------------

/**
 * Neutralize control bytes (code < 0x20, and DEL 0x7f) to spaces. Char-code
 * walk, never a regex class — this repo has repeatedly corrupted escape
 * sequences into raw control bytes (see test/repo.text-hygiene.test.ts).
 */
function neutralizeControl(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out += code < 0x20 || code === 0x7f ? ' ' : text[i]!;
  }
  return out;
}

/** Markdown-active characters that begin/close inline constructs. */
const MD_ACTIVE = new Set([
  '\\',
  '`',
  '*',
  '_',
  '{',
  '}',
  '[',
  ']',
  '(',
  ')',
  '#',
  '|',
  '<',
  '>',
  '~',
  '!',
]);

/**
 * Escape untrusted PROSE for a markdown inline context: control-strip, then
 * backslash-escape every markdown-active char so the string can never inject a
 * heading, link, emphasis, code span, or table pipe. The LLM passes already run
 * sanitizeText (control-stripped, whitespace-collapsed, capped), but this is the
 * markdown output-context escaper — a second, context-correct firewall.
 */
export function mdText(text: string): string {
  const clean = neutralizeControl(text);
  let out = '';
  for (const ch of clean) {
    if (MD_ACTIVE.has(ch)) out += '\\';
    out += ch;
  }
  return out;
}

// --- confidence model (honest; M1 acceptance) --------------------------------

type Confidence = 'high' | 'medium' | 'low';

interface ConfidenceRow {
  group: string;
  source: string;
  confidence: Confidence;
  basis: string;
}

/** Whether the extraction supplied usable evidence for a category. */
function confidenceRows(input: ReportInput): ConfidenceRow[] {
  const { extraction, normalize } = input;
  const rows: ConfidenceRow[] = [];

  // Brand seed.
  if (normalize.seedFromFallback) {
    rows.push({
      group: 'color.primitive.brand (seed)',
      source: 'preset fallback',
      confidence: 'low',
      basis: 'no brand-colored candidate in the extraction (only greys/near-neutrals)',
    });
  } else {
    const top = normalize.seedCandidates[0];
    const second = normalize.seedCandidates[1];
    const dominant =
      second === undefined || (top !== undefined && top.score >= 2 * second.score);
    rows.push({
      group: 'color.primitive.brand (seed)',
      source: 'extracted',
      confidence: dominant ? 'high' : 'medium',
      basis: dominant
        ? 'one candidate dominates the role-weighted score'
        : 'several candidates score close together — verify the pick below',
    });
  }

  // Neutral + gated surface is seed-independent by construction.
  rows.push({
    group: 'color.semantic / status / chart.label (gated surface)',
    source: 'derived (WCAG-safe by construction)',
    confidence: 'high',
    basis: 'assembled from fixed-lightness ramps + conventional status hues, not the seed',
  });

  // Fonts.
  const fontConf = (m: FontMapping): Confidence =>
    m.observedFamily === undefined ? 'low' : m.mapped ? 'high' : 'medium';
  rows.push({
    group: 'font.sans / heading / mono',
    source: extraction.fonts.length > 0 ? 'extracted -> Google Fonts lookalike' : 'preset default',
    confidence:
      extraction.fonts.length === 0
        ? 'low'
        : fontConf(normalize.fonts.sans) === 'high' &&
            fontConf(normalize.fonts.heading) === 'high'
          ? 'high'
          : 'medium',
    basis:
      extraction.fonts.length > 0
        ? 'observed stacks mapped by the curated lookalike table (see font mapping below)'
        : 'no font stacks observed; preset stacks kept',
  });

  // Type scale.
  rows.push({
    group: 'type.size.base + weights + line-heights',
    source: extraction.typeSizes.length > 0 ? 'extracted' : 'preset default',
    confidence: extraction.typeSizes.length >= 3 ? 'high' : extraction.typeSizes.length > 0 ? 'medium' : 'low',
    basis: `${extraction.typeSizes.length} distinct type size(s) observed`,
  });

  // Spacing / radii / shadows.
  rows.push({
    group: 'space scale',
    source: extraction.spacing.length > 0 ? 'extracted (4px grid snap)' : 'preset default',
    confidence: extraction.spacing.length >= 3 ? 'high' : extraction.spacing.length > 0 ? 'medium' : 'low',
    basis: `${extraction.spacing.length} spacing value(s) observed`,
  });
  rows.push({
    group: 'radius.sm / md / lg',
    source: extraction.radii.length >= 3 ? 'extracted' : 'preset default',
    confidence: extraction.radii.length >= 3 ? 'medium' : 'low',
    basis: `${extraction.radii.length} radius value(s) observed (need 3 to override)`,
  });
  rows.push({
    group: 'shadow.elevation-1..3',
    source: extraction.shadows.length > 0 ? 'extracted' : 'preset default',
    confidence: extraction.shadows.length >= 3 ? 'medium' : 'low',
    basis: `${extraction.shadows.length} shadow value(s) observed`,
  });

  return rows;
}

// --- section renderers -------------------------------------------------------

function renderScreenshots(input: ReportInput): string[] {
  const lines: string[] = ['## Screenshots', ''];
  if (input.screenshots.length === 0) {
    lines.push('_No screenshots were captured (extraction did not produce a viewport capture)._');
    return lines;
  }
  for (const shot of input.screenshots) {
    lines.push(`### ${mdText(shot.label)}`, '');
    // The alt text is untrusted-label-derived; the path is proposal-dir-local
    // and constructed by us (never site-derived), so it is safe unescaped.
    lines.push(`![${mdText(shot.label)} capture](${shot.relPath})`, '');
  }
  return lines;
}

function renderClusters(input: ReportInput): string[] {
  const lines: string[] = ['## Computed-style color clusters', ''];
  const clusters = [...input.extraction.colors].slice(0, 20);
  if (clusters.length === 0) {
    lines.push('_No color clusters were observed._');
    return lines;
  }
  lines.push('| Color | Frequency | Roles (count) |', '| --- | --- | --- |');
  for (const c of clusters) {
    const roles =
      c.roles.length === 0
        ? '(none)'
        : c.roles.map((r) => `${r.role}:${r.count}`).join(', ');
    lines.push(`| ${codeCell(c.hex)} | ${codeCell(String(c.frequency))} | ${codeCell(roles)} |`);
  }
  return lines;
}

function renderConfidence(input: ReportInput): string[] {
  const lines: string[] = ['## Per-token confidence', ''];
  lines.push('| Token group | Source | Confidence | Basis |', '| --- | --- | --- | --- |');
  for (const row of confidenceRows(input)) {
    lines.push(
      `| ${codeCell(row.group)} | ${mdText(row.source)} | ${row.confidence.toUpperCase()} | ${mdText(row.basis)} |`,
    );
  }
  return lines;
}

function renderCandidates(input: ReportInput): string[] {
  const { normalize, llm } = input;
  const top5 = normalize.seedCandidates.slice(0, 5);
  const lines: string[] = ['## Top brand-color candidates', ''];

  // The CHOSEN color of record is the LLM's pick (llm.colorPick.pick), NOT the
  // heuristic top (normalize.seed) — from-url ships the tokens built from this
  // pick, so the report must label the same color (plan §9 Decision 4). Under
  // --no-llm / fallback, source==='heuristic' and pick == the heuristic seed.
  const chosenHex = llm.colorPick.pick;
  const pickSourceLabel =
    llm.colorPick.source === 'llm' ? 'LLM pick' : 'heuristic pick (LLM unavailable / --no-llm)';
  lines.push(
    `**Chosen brand color:** ${codeCell(chosenHex)} — ${mdText(pickSourceLabel)}.`,
    '',
    `**Rationale:** ${mdText(llm.colorPick.rationale)}`,
    '',
  );
  if (normalize.seedFromFallback) {
    lines.push(
      '_The extraction yielded no brand-colored candidate; the chosen color is the preset fallback. Treat the pick as a placeholder._',
      '',
    );
  }

  if (top5.length === 0) {
    lines.push('_No chromatic candidates were found in the extraction._');
    return lines;
  }
  lines.push('| Rank | Candidate | Score | Frequency | Chroma | Chosen |', '| --- | --- | --- | --- | --- | --- |');
  const chosenKey = chosenHex.trim().toLowerCase();
  top5.forEach((cand, i) => {
    const chosen = cand.hex.trim().toLowerCase() === chosenKey ? 'yes' : '';
    lines.push(
      `| ${i + 1} | ${codeCell(cand.hex)} | ${codeCell(cand.score.toFixed(2))} | ${codeCell(
        String(cand.frequency),
      )} | ${codeCell(cand.chroma.toFixed(3))} | ${chosen} |`,
    );
  });
  return lines;
}

function renderFontMapping(input: ReportInput): string[] {
  const lines: string[] = ['## Font mapping (fingerprint -> free lookalike)', ''];
  lines.push('| Role | Observed | Mapped | Free? | Note |', '| --- | --- | --- | --- | --- |');
  const mappings: Array<[string, FontMapping]> = [
    ['sans', input.normalize.fonts.sans],
    ['heading', input.normalize.fonts.heading],
    ['mono', input.normalize.fonts.mono],
  ];
  for (const [role, m] of mappings) {
    const observed = m.observedFamily ?? '(none observed)';
    const mapped = m.mappedFamily ?? m.stack[0] ?? '(fallback chain)';
    lines.push(
      `| ${codeCell(role)} | ${codeCell(observed)} | ${codeCell(mapped)} | ${m.mapped ? 'yes' : 'no'} | ${mdText(m.note)} |`,
    );
  }
  lines.push(
    '',
    '_Fonts are fingerprinted and mapped to free (OFL) Google Fonts lookalikes — never copied (plan Decision 7)._',
  );
  return lines;
}

function renderWarnings(input: ReportInput): string[] {
  const all = [...input.normalize.warnings, ...input.llm.warnings];
  if (all.length === 0) return [];
  const lines: string[] = ['## Notes & warnings', ''];
  for (const w of all.slice(0, 40)) lines.push(`- ${mdText(w)}`);
  return lines;
}

/**
 * Render the extraction-report.md for a from-url proposal. Pure — no I/O; the
 * caller writes the returned string. LF line endings, trailing newline.
 */
export function renderExtractionReport(input: ReportInput): string {
  const { llm } = input;
  const llmLine =
    llm.manifestStatus === 'skipped'
      ? `LLM assist: skipped (${mdText(llm.reason ?? 'heuristics only')})`
      : `LLM assist: used (status ${llm.status})`;

  const lines: string[] = [
    '# on-brand extraction report',
    '',
    `**Source:** ${codeCell(input.url)}`,
    '',
    `**Host:** ${codeCell(input.host)}`,
    '',
    `**Extracted at:** ${codeCell(input.extraction.extractedAt || '(unknown)')}`,
    '',
    `**Report generated:** ${codeCell(input.generatedAt)}`,
    '',
    `**Engine:** ${codeCell(`${input.extraction.engine.name} ${input.extraction.engine.version}`)}`,
    '',
    `**${llmLine}**`,
    '',
    '## Aesthetic summary',
    '',
    mdText(llm.aesthetic.summary),
    '',
    ...renderScreenshots(input),
    '',
    ...renderClusters(input),
    '',
    ...renderConfidence(input),
    '',
    ...renderCandidates(input),
    '',
    ...renderFontMapping(input),
    '',
    ...renderWarnings(input),
    '',
    '---',
    '',
    '_This is a generated proposal. The brand color pick is advisory (the disambiguation ceiling is ~68% even with ML — plan §10); confirm it against the candidates above before adopting. Copy `brand/` into `<project>/brand/` to adopt._',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

// --- guide.md DRAFT ----------------------------------------------------------

export interface GuideDraftInput {
  projectName: string;
  host: string;
  url: string;
  llm: LlmAssistResult;
  normalize: NormalizeResult;
}

/**
 * Render a DRAFT guide.md for a from-url proposal (plan §5): the voice & tone
 * section is drafted by the LLM pass and clearly marked DRAFT (or a TODO stub
 * under --no-llm / when the CLI is absent); identity is seeded from the
 * aesthetic summary; typography names the mapped stacks; the rest is scaffolded
 * exactly like `onbrand init`. The `palette` fence is left intact so the
 * following `onbrand build` renders the swatch table into it.
 *
 * All LLM/site-derived text is markdown-escaped (mdText) — untrusted output.
 */
export function renderGuideDraft(input: GuideDraftInput): string {
  const { llm, normalize } = input;
  const isStub = llm.voice.isTodo;

  const voiceLines: string[] = [];
  if (isStub) {
    voiceLines.push(
      '<!-- TODO: the LLM voice draft was unavailable (--no-llm or claude CLI absent).',
      '     Write 3-6 bullets describing how this project writes, then 3 before/after rewrites. -->',
      '',
    );
    for (const b of llm.voice.draft.bullets) voiceLines.push(`- ${mdText(b)}`);
    voiceLines.push('');
    for (const ex of llm.voice.draft.examples) {
      voiceLines.push(`- _${mdText(ex.before)}_ -> _${mdText(ex.after)}_`);
    }
  } else {
    voiceLines.push('> DRAFT (LLM-generated from the source site — review and edit before adopting).', '');
    for (const b of llm.voice.draft.bullets) voiceLines.push(`- ${mdText(b)}`);
    voiceLines.push('', '**Example rewrites:**', '');
    for (const ex of llm.voice.draft.examples) {
      voiceLines.push(`- _${mdText(ex.before)}_ -> _${mdText(ex.after)}_`);
    }
  }

  const sans = normalize.fonts.sans.stack[0] ?? 'Inter';
  const heading = normalize.fonts.heading.stack[0] ?? sans;
  const mono = normalize.fonts.mono.stack[0] ?? 'JetBrains Mono';

  const lines: string[] = [
    `# ${mdText(input.projectName)} — Brand Guide (DRAFT)`,
    '',
    '<!-- GENERATED as a DRAFT by `onbrand from-url`. Voice & tone is LLM-drafted;',
    '     everything else is a scaffold. Sections marked TODO are yours to write.',
    '     Content between `onbrand:begin`/`onbrand:end` markers is auto-generated by',
    '     `onbrand build` — never edit inside those fences. -->',
    '',
    `> Proposed from ${codeCell(input.url)} — this is a starting point, not a finished guide.`,
    '',
    '## Identity',
    '',
    mdText(llm.aesthetic.summary),
    '',
    '<!-- TODO: refine into one line — what this project is and the feeling its surfaces should give. -->',
    '',
    '## Logo & assets',
    '',
    '<!-- TODO: note the canonical logo/favicon files under brand/assets/, clear-space and',
    '     minimum-size rules, and any usage restrictions. Delete if the project has no logo. -->',
    '',
    '## Palette',
    '',
    '<!-- onbrand:begin palette -->',
    '_Palette table is auto-generated. Run `onbrand build` to render it here._',
    '<!-- onbrand:end palette -->',
    '',
    '## Typography',
    '',
    `Proposed stacks (free Google Fonts lookalikes — see the extraction report for the mapping):`,
    '',
    `- **Sans / body:** ${codeCell(sans)}`,
    `- **Heading:** ${codeCell(heading)}`,
    `- **Mono:** ${codeCell(mono)}`,
    '',
    '## Spacing & radius',
    '',
    '<!-- TODO: one paragraph — how the 4px spacing grid (`space.1`-`space.10`) and the',
    '     radius scale (sm/md/lg/pill) are applied. -->',
    '',
    '## Voice & tone',
    '',
    ...voiceLines,
    '',
    "## Do's and don'ts",
    '',
    '<!-- TODO: short list of always/never rules for this project\'s surfaces. -->',
    '',
  ];
  return `${lines.join('\n')}\n`;
}
