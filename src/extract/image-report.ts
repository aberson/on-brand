/**
 * Readable, deterministic evidence report for a local-image proposal.
 *
 * This is intentionally a presentation-only companion to the machine-readable
 * raw-image-analysis.json and brand/inspiration.json. It never remeasures the
 * image or infers token mappings from rendered colors.
 */

import type {
  PaletteDecision,
  PaletteEvidence,
  PaletteSynthesisResult,
} from './palette-evidence.ts';

function oneLine(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    out += code < 0x20 || code === 0x7f ? ' ' : value[i]!;
  }
  return out.trim();
}

function code(value: string): string {
  const safe = oneLine(value).replaceAll('|', '\\|');
  let ticks = '`';
  while (safe.includes(ticks)) ticks += '`';
  return `${ticks}${safe}${ticks}`;
}

export interface ImageReportInput {
  title: string;
  generatedAt: string;
  evidence: PaletteEvidence;
  decision: PaletteDecision;
  synthesis: PaletteSynthesisResult;
  warnings?: readonly string[];
}

/** Render a bounded markdown surface with no untrusted markdown interpolation. */
export function renderImageReport(input: ImageReportInput): string {
  const lines = [
    '# Image palette analysis (DRAFT)',
    '',
    `Generated: ${code(input.generatedAt)}`,
    `Title: ${code(input.title)}`,
    `Algorithm: ${code(input.evidence.algorithm)}`,
    '',
    '## Measured samples',
    '',
    '| ID | Hex | Pixel share | Region |',
    '| --- | --- | ---: | --- |',
  ];
  for (const sample of input.evidence.samples) {
    const region = sample.region === null
      ? 'not localized'
      : `${sample.region.x.toFixed(2)}, ${sample.region.y.toFixed(2)} (${sample.region.width.toFixed(2)} × ${sample.region.height.toFixed(2)})`;
    lines.push(`| ${code(sample.id)} | ${code(sample.hex)} | ${(sample.pixelShare * 100).toFixed(2)}% | ${code(region)} |`);
  }
  lines.push('', '## Selected implementation', '');
  lines.push(`- Primary: ${code(input.decision.primary.sampleId)} (${code(input.decision.primary.selectionSource)})`);
  if (input.decision.neutral !== null) {
    lines.push(`- Neutral tint: ${code(input.decision.neutral.sampleId)}`);
  } else {
    lines.push('- Neutral tint: derived from the primary/default ramp');
  }
  lines.push(`- Secondary samples: ${input.decision.secondaries.length === 0 ? 'none' : input.decision.secondaries.map((entry) => code(entry.sampleId)).join(', ')}`);
  lines.push('', '## Mappings', '');
  for (const mapping of input.synthesis.mappings) {
    lines.push(`- ${code(mapping.id)}: ${mapping.targets.map((target) => code(target.token)).join(', ')}`);
  }
  if (input.synthesis.defaultDerivedColorTargets.length > 0) {
    lines.push('', '## Explicit default-derived color slots', '');
    for (const target of input.synthesis.defaultDerivedColorTargets) {
      lines.push(`- ${code(target.token)} (${code(target.role)}): ${code(target.reason)}`);
    }
  }
  if ((input.warnings?.length ?? 0) > 0) {
    lines.push('', '## Notes', '');
    for (const warning of input.warnings!.slice(0, 40)) lines.push(`- ${code(warning)}`);
  }
  lines.push('', 'This evidence is generated draft material. Metadata and artwork rights require operator review.', '');
  return lines.join('\n');
}

/** A short DRAFT guide that lets existing build guide refreshes run normally. */
export function renderImageGuideDraft(title: string): string {
  return [
    `# ${oneLine(title)} Brand Guide (DRAFT)`,
    '',
    'GENERATED as a DRAFT by `onbrand from-image`. Review the inspiration trace, artwork metadata, and generated tokens before adopting this proposal.',
    '',
    '## Palette',
    '',
    '<!-- onbrand:begin palette -->',
    '<!-- onbrand:end palette -->',
    '',
  ].join('\n');
}
