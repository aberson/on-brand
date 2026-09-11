/** `onbrand from-image` — bounded local raster -> reviewable proposal. */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { compileBrand } from '../build/compile.ts';
import { runCheck } from '../check/run.ts';
import { INSPIRATION_USER_SCHEMA_VERSION, inspirationIdForAssetSha256, type InspirationTrace } from '../inspiration/contract.ts';
import { formatInspirationCatalogFailure } from '../inspiration/export.ts';
import { recordSpecimenView } from '../inspiration/views.ts';
import { generatePreview } from '../preview/specimen.ts';
import {
  ImagePaletteAdapter,
  readBoundedImageFile,
  type ImagePaletteEvidence,
} from './image-palette.ts';
import { renderImageGuideDraft, renderImageReport } from './image-report.ts';
import { buildTokensFromPalette, selectPaletteDecision } from './normalize.ts';
import { imageSlug, isInsideDirectory, writeAtomicBytes, writeAtomicFile } from './proposal.ts';
import { dateStamp, resolveProposalDir } from './from-url.ts';

export class FromImageUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FromImageUsageError';
  }
}

export type FromImageStage = 'preflight' | 'measure' | 'synthesize' | 'build' | 'check' | 'preview' | 'report' | 'catalog';

export interface FromImageMetadata {
  title: string;
  alt: string;
  creator?: string;
  artworkDate?: string;
  sourceUrl?: string;
  rights?: string;
  licenseUrl?: string;
  retrievedAt?: string;
}

export interface RunFromImageOptions extends FromImageMetadata {
  outDir?: string;
  /** Explicit human choice from the measured colorful samples; never invokes a model. */
  accentSampleId?: string;
  onStage?: (stage: FromImageStage) => void;
  /** Backward-compatible no-op: image v1 is deterministic and never invokes an LLM. */
  noLlm?: boolean;
  force?: boolean;
  now?: () => Date;
  /** Explicit paired catalog refresh hook, injected by the CLI integration. */
  refreshCatalog?: (proposalDir: string) => void | Promise<void>;
  /** Deterministic integration seam after proposal completion and before catalog discovery. */
  beforeCatalogRefresh?: (proposalDir: string) => void | Promise<void>;
  /** Deterministic integration seam immediately before required provenance recording. */
  beforeSpecimenRecord?: (proposalDir: string) => void;
}

export interface FromImageResult {
  /**
   * `catalog-failed` is deliberately distinct from an incomplete producer
   * transaction: the proposal, its two HTML views, and its manifest have
   * already completed, while the optional external-facing catalog did not.
   */
  status: 'complete' | 'incomplete' | 'catalog-failed';
  proposalDir: string;
  brandDir: string;
  reportPath?: string;
  stageFailed?: FromImageStage;
  error?: string;
  warnings: string[];
}

function oneLine(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    out += code < 0x20 || code === 0x7f ? ' ' : value[index]!;
  }
  return out.trim();
}

function requiredText(value: string | undefined, name: string): string {
  const clean = value === undefined ? '' : oneLine(value);
  if (clean.length === 0) throw new FromImageUsageError(`from-image requires a non-empty ${name}`);
  if (clean.length > 240) throw new FromImageUsageError(`${name} must be at most 240 characters`);
  return clean;
}

function optionalText(value: string | undefined, fallback: string, name: string): string {
  if (value === undefined) return fallback;
  const clean = oneLine(value);
  if (clean.length === 0 || clean.length > 240) throw new FromImageUsageError(`${name} must be non-empty and at most 240 characters when supplied`);
  return clean;
}

function optionalHttps(value: string | undefined, name: string): string | null {
  if (value === undefined) return null;
  const clean = oneLine(value);
  try {
    const parsed = new URL(clean);
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') throw new Error();
  } catch {
    throw new FromImageUsageError(`${name} must be an absolute https URL without credentials`);
  }
  return clean;
}

function optionalDate(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new FromImageUsageError('--retrieved-at must use YYYY-MM-DD');
  }
  return value;
}

function mediaExtension(mediaType: ImagePaletteEvidence['source'] extends { mediaType: infer M } ? M : never): string {
  if (mediaType === 'image/png') return '.png';
  if (mediaType === 'image/jpeg') return '.jpg';
  return '.webp';
}

function markerContent(stage: string, detail?: string): string {
  const lines = [
    '# INCOMPLETE proposal',
    '',
    'This `onbrand from-image` run did not finish. Partial local evidence is retained for review.',
    '',
    `- Stage: ${oneLine(stage)}`,
  ];
  if (detail !== undefined) lines.push(`- Detail: ${oneLine(detail)}`);
  lines.push('', 'Re-run `onbrand from-image <file> --title <title> --alt <alt>` after correcting the failure.', '');
  return lines.join('\n');
}

function traceFromSynthesis(
  evidence: ImagePaletteEvidence,
  synthesis: ReturnType<typeof buildTokensFromPalette>,
  decision: ReturnType<typeof selectPaletteDecision>,
  metadata: Required<Pick<FromImageMetadata, 'title' | 'alt'>> & {
    creator: string;
    artworkDate: string;
    sourceUrl: string | null;
    rights: string;
    licenseUrl: string | null;
    retrievedAt: string | null;
  },
  assetPath: string,
): InspirationTrace {
  if (evidence.source.kind !== 'image') throw new Error('from-image requires image palette evidence');
  return {
    schema: 'onbrand.inspiration',
    schemaVersion: decision.primary.selectionSource === 'user' ? INSPIRATION_USER_SCHEMA_VERSION : 1,
    id: inspirationIdForAssetSha256(evidence.source.assetSha256),
    reviewStatus: 'generated-draft',
    summary: decision.primary.selectionSource === 'user'
      ? `Palette generated from ${metadata.title}. Main accent chosen by the user.`
      : `Palette generated from ${metadata.title}.`,
    asset: {
      path: assetPath,
      sha256: evidence.source.assetSha256,
      mediaType: evidence.source.mediaType,
      alt: metadata.alt,
      creator: metadata.creator,
      title: metadata.title,
      date: metadata.artworkDate,
      sourceUrl: metadata.sourceUrl,
      rights: metadata.rights,
      licenseUrl: metadata.licenseUrl,
      retrievedAt: metadata.retrievedAt,
    },
    analysis: {
      sourceKind: 'image',
      algorithm: evidence.algorithm,
      basePreset: 'default',
      primary: decision.primary,
      neutral: decision.neutral,
      secondaries: decision.secondaries,
      unobservedDefaults: synthesis.unobservedDefaults,
      defaultDerivedColorTargets: synthesis.defaultDerivedColorTargets,
    },
    mappings: synthesis.mappings,
  };
}

/**
 * Run the entire local source proposal. Usage/preflight failures throw before
 * a proposal mutation; pipeline failures retain an INCOMPLETE marker.
 */
export async function runFromImage(sourcePath: string, options: RunFromImageOptions): Promise<FromImageResult> {
  if (typeof sourcePath !== 'string' || sourcePath.trim() === '') {
    throw new FromImageUsageError('from-image requires a local image file');
  }
  const metadata = {
    title: requiredText(options.title, '--title'),
    alt: requiredText(options.alt, '--alt'),
    creator: optionalText(options.creator, 'unknown', '--creator'),
    artworkDate: optionalText(options.artworkDate, 'unknown', '--artwork-date'),
    sourceUrl: optionalHttps(options.sourceUrl, '--source-url'),
    rights: optionalText(options.rights, 'unknown', '--rights'),
    licenseUrl: optionalHttps(options.licenseUrl, '--license-url'),
    retrievedAt: optionalDate(options.retrievedAt),
  };
  const now = options.now ?? (() => new Date());
  const clock = now();
  const outDir = path.resolve(options.outDir ?? '.');
  const slug = imageSlug(sourcePath);
  const proposalDir = resolveProposalDir(outDir, slug, dateStamp(clock), options.force ?? false);
  const brandDir = path.join(proposalDir, 'brand');
  const warnings: string[] = [];

  // This open/read happens before force cleanup. The exact returned bytes are
  // the sole input to the decoder, hash, and asset copy below.
  const loaded = readBoundedImageFile(sourcePath);
  if (isInsideDirectory(proposalDir, loaded.assetPath)) {
    throw new FromImageUsageError('image source cannot be inside its proposed output directory');
  }
  if (options.force && existsSync(proposalDir)) {
    rmSync(proposalDir, { recursive: true, force: true });
  }
  mkdirSync(path.join(brandDir, 'assets'), { recursive: true });
  const markerPath = path.join(proposalDir, 'INCOMPLETE.md');
  writeAtomicFile(markerPath, markerContent('starting'));
  let stage: FromImageStage = 'preflight';

  try {
    stage = 'measure';
    options.onStage?.(stage);
    writeAtomicFile(markerPath, markerContent('measuring deterministic raster evidence'));
    const ext = mediaExtension(loaded.mediaType);
    const assetRelativePath = `assets/inspiration${ext}`;
    const evidence = await new ImagePaletteAdapter().measure({
      bytes: loaded.bytes,
      assetPath: assetRelativePath,
      assetSha256: loaded.assetSha256,
      mediaType: loaded.mediaType,
    });

    writeAtomicFile(path.join(proposalDir, 'raw-image-analysis.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    writeAtomicBytes(path.join(brandDir, ...assetRelativePath.split('/')), loaded.bytes);

    stage = 'synthesize';
    options.onStage?.(stage);
    writeAtomicFile(markerPath, markerContent('synthesizing tokens and canonical trace'));
    const decision = selectPaletteDecision(evidence, options.accentSampleId === undefined ? {} : {
      primarySampleId: options.accentSampleId, primarySelectionSource: 'user',
    });
    const synthesis = buildTokensFromPalette(evidence, decision);
    const trace = traceFromSynthesis(evidence, synthesis, decision, metadata, assetRelativePath);
    writeAtomicFile(path.join(brandDir, 'tokens.json'), `${JSON.stringify(synthesis.tokens, null, 2)}\n`);
    writeAtomicFile(path.join(brandDir, 'modes.dark.json'), `${JSON.stringify(synthesis.dark, null, 2)}\n`);
    writeAtomicFile(path.join(brandDir, 'inspiration.json'), `${JSON.stringify(trace, null, 2)}\n`);
    writeAtomicFile(path.join(brandDir, 'guide.md'), renderImageGuideDraft(metadata.title));
    writeFileSync(path.join(brandDir, 'assets', '.gitkeep'), '', { flag: 'a' });

    stage = 'build';
    options.onStage?.(stage);
    writeAtomicFile(markerPath, markerContent('building regular outputs and side-by-side view'));
    const compilation = compileBrand(proposalDir, { llm: 'none', now: () => clock.toISOString() });

    stage = 'check';
    options.onStage?.(stage);
    writeAtomicFile(markerPath, markerContent('running normal quality gate'));
    const firstCheck = runCheck(proposalDir);
    if (!firstCheck.ok) throw new Error(`normal build/check failed: ${firstCheck.findings.map((finding) => finding.message).join('; ')}`);

    stage = 'preview';
    options.onStage?.(stage);
    writeAtomicFile(markerPath, markerContent('generating full specimen'));
    const preview = generatePreview(proposalDir);
    options.beforeSpecimenRecord?.(proposalDir);
    recordSpecimenView(
      proposalDir,
      preview.generation,
      compilation.manifest.sourceHash,
      { required: true },
    );
    const finalCheck = runCheck(proposalDir);
    if (!finalCheck.ok) throw new Error(`generated-view check failed: ${finalCheck.findings.map((finding) => finding.message).join('; ')}`);

    stage = 'report';
    options.onStage?.(stage);
    writeAtomicFile(markerPath, markerContent('writing readable evidence report'));
    const reportPath = path.join(proposalDir, 'image-report.md');
    writeAtomicFile(reportPath, renderImageReport({
      title: metadata.title,
      generatedAt: clock.toISOString(),
      evidence,
      decision,
      synthesis,
      warnings,
    }));

    if (options.refreshCatalog !== undefined) {
      stage = 'catalog';
      // The producer transaction is complete before the optional catalog
      // begins. Removing the marker first makes bounded discovery classify
      // this as a complete proposal and guarantees same-command/standalone
      // catalog bytes are identical for the same inputs and clock.
      rmSync(markerPath, { force: true });
      try {
        await options.beforeCatalogRefresh?.(proposalDir);
        await options.refreshCatalog(proposalDir);
      } catch (cause) {
        // The complete proposal remains reviewable and retryable even when a
        // separately scoped catalog writer is unavailable.  In particular,
        // do not leave an INCOMPLETE marker on a producer that already passed
        // build, check, specimen, and explanation freshness gates.
        return {
          status: 'catalog-failed',
          proposalDir,
          brandDir,
          reportPath,
          stageFailed: stage,
          error: formatInspirationCatalogFailure(cause),
          warnings,
        };
      }
    }
    rmSync(markerPath, { force: true });
    return { status: 'complete', proposalDir, brandDir, reportPath, warnings };
  } catch (cause) {
    const error = oneLine(cause instanceof Error ? cause.message : String(cause));
    try {
      writeAtomicFile(markerPath, markerContent(`${stage} (FAILED)`, error));
    } catch {
      // Preserve the original pipeline error even if the marker cannot update.
    }
    return { status: 'incomplete', proposalDir, brandDir, stageFailed: stage, error, warnings };
  }
}
