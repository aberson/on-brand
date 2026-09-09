/** Generated-view lifecycle outside the dist-only preview module. */

import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  computeSourceHash,
  mutateManifestOutputs,
  parseStrictManifest,
  renderManifest,
  type ManifestOutputSource,
} from '../build/manifest.ts';
import type { BrandSources } from '../build/compile.ts';
import { acquireDistPublicationLock } from '../build/publication-lock.ts';
import {
  assertSafeRegularFileTarget,
  assertUnlinkedDirectoryPath,
  pathIsAbsent,
  publishStagedFile,
  removeOwnedFile,
  sameFileIdentity,
  sameFileNode,
  sha256Bytes,
  stageFileExclusive,
  stableReadRegularFile,
  type StagedFile,
} from '../filesystem.ts';
import type { PreviewGenerationSnapshot } from '../preview/specimen.ts';
import {
  REQUIRED_PREVIEW_INPUTS,
  SPECIMEN_CONTENT_SOURCE_LABEL,
  SPECIMEN_VIEW_OUTPUT,
} from '../preview/contract.ts';
import { loadInspirationTrace } from './load.ts';
import { renderInspirationHtml } from './render.ts';
import { resolveInspirationTrace } from './resolve.ts';

export const INSPIRATION_VIEW_OUTPUT = 'inspiration-to-implementation.html';
export { SPECIMEN_CONTENT_SOURCE_LABEL, SPECIMEN_VIEW_OUTPUT } from '../preview/contract.ts';

export interface InspirationViewFreshness {
  hash: string;
  sources: ManifestOutputSource[];
}

export type InspirationViewFreshnessClassification =
  | { state: 'absent' }
  | { state: 'invalid' }
  | { state: 'current'; freshness: InspirationViewFreshness };

/** Deterministic composite digest specified for the side-by-side HTML. */
export function inspirationOutputFreshness(
  coreSourceHash: string,
  traceSha256: string,
  assetRelativePath: string,
  assetSha256: string,
): InspirationViewFreshness {
  const tuple = [
    'onbrand-inspiration-output-v1',
    ['core', null, 'digest', coreSourceHash],
    ['trace', 'inspiration.json', 'text-lf', traceSha256],
    ['asset', assetRelativePath, 'binary', assetSha256],
  ];
  const hash = createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex');
  return {
    hash,
    sources: [
      { label: 'core', sourcePath: null, kind: 'digest', sha256: coreSourceHash },
      { label: 'trace', sourcePath: 'inspiration.json', kind: 'text-lf', sha256: traceSha256 },
      { label: 'asset', sourcePath: assetRelativePath, kind: 'binary', sha256: assetSha256 },
    ],
  };
}

/**
 * Render or remove the optional side-by-side after a full regular build.
 * `compileBrand` owns the final manifest transaction; this function only
 * returns staged content/metadata so a manifest never claims a view that was
 * not successfully produced.
 */
export function prepareInspirationView(
  projectDir: string,
  sources: BrandSources,
): { html?: string; freshness?: InspirationViewFreshness; remove: boolean } {
  const loaded = loadInspirationTrace(projectDir);
  if (loaded === undefined) return { remove: true };
  const resolved = resolveInspirationTrace(loaded, sources.resolved.document, sources.darkDocument);
  const html = renderInspirationHtml(resolved);
  const freshness = inspirationOutputFreshness(
    computeSourceHash(sources.sourceInputs).sourceHash,
    loaded.traceSha256,
    loaded.asset.relativePath,
    loaded.asset.sha256,
  );
  return { html, freshness, remove: false };
}

/**
 * Record preview provenance after its existing atomic dist-only write.
 * A legacy preview may validly be generated without a manifest; it stays
 * usable even though provenance refresh cannot complete. Callers that require
 * a completed transaction (the from-image producer) pass `{ required: true }`
 * and receive the cause.
 */
export function recordSpecimenView(
  projectDir: string,
  generation: PreviewGenerationSnapshot | undefined,
  coreSourceHash: string,
  options: {
    required?: boolean;
    /** Deterministic collision seam for filesystem-real staging tests. */
    randomBytesFn?: (size: number) => Buffer;
    /** Deterministic child-process barrier immediately before final rename. */
    beforeManifestRename?: () => void;
  } = {},
): boolean {
  const distDir = path.join(path.resolve(projectDir), 'brand', 'dist');
  const manifestPath = path.join(distDir, 'manifest.json');
  const specimenPath = path.join(distDir, SPECIMEN_VIEW_OUTPUT);
  try {
    const publicationLock = acquireDistPublicationLock(projectDir);
    let publicationError: unknown;
    try {
      assertUnlinkedDirectoryPath(distDir, 'dist tree');
      assertSafeRegularFileTarget(manifestPath, 'manifest target');
      assertSafeRegularFileTarget(specimenPath, 'specimen target');
      if (generation === undefined) {
        throw new Error('cannot record specimen provenance: preview generation was not stable and trackable');
      }
      // This is the authoritative validation and deliberately begins only
      // after the same lock used by compileBrand has been acquired.
      if (!matchesGeneration(distDir, specimenPath, generation, coreSourceHash)) {
        throw new Error('cannot record specimen provenance: consumed dist generation changed or is unsafe');
      }
      const next = mutateManifestOutputs(generation.manifest.content, {
        set: {
          [SPECIMEN_VIEW_OUTPUT]: {
            sha256: coreSourceHash,
            // The output hash keeps its public v1 meaning (core source hash).
            // This existing v1 provenance row binds that claim to the exact
            // HTML inode/bytes validated below. A later lock-free preview can
            // still replace the page, but different bytes are then classified
            // stale instead of being accepted under a false-current core hash.
            sources: [{
              label: SPECIMEN_CONTENT_SOURCE_LABEL,
              sourcePath: null,
              kind: 'digest',
              sha256: generation.specimen.sha256,
            }],
          },
        },
      });
      let staged: StagedFile | undefined;
      try {
        staged = stageFileExclusive(manifestPath, renderManifest(next), {
          ...(options.randomBytesFn !== undefined ? { randomBytesFn: options.randomBytesFn } : {}),
        });
        options.beforeManifestRename?.();
        // Keep the deterministic seam before the truly final validation so
        // an interposed lock-free preview writer is observed, not certified.
        if (!matchesGeneration(distDir, specimenPath, generation, coreSourceHash)) {
          throw new Error('cannot record specimen provenance: dist changed before manifest publication');
        }
        publishStagedFile(staged, manifestPath);
        staged = undefined;
        return true;
      } finally {
        if (staged !== undefined) removeOwnedFile(staged.path, staged.identity);
      }
    } catch (cause) {
      publicationError = cause;
      throw cause;
    } finally {
      if (!publicationLock.release() && publicationError === undefined) {
        throw new Error('specimen provenance published, but its ownership lock was replaced and was not removed');
      }
    }
  } catch (cause) {
    if (options.required) throw cause;
    return false;
  }
}

function matchesGeneration(
  distDir: string,
  specimenPath: string,
  generation: PreviewGenerationSnapshot,
  coreSourceHash: string,
): boolean {
  let distIdentity;
  try {
    distIdentity = assertUnlinkedDirectoryPath(distDir, 'dist tree');
  } catch {
    return false;
  }
  const specimen = stableReadRegularFile(specimenPath, { requireSingleLink: true });
  if (
    !sameFileNode(distIdentity, generation.distIdentity) ||
    generation.specimen.relPath !== SPECIMEN_VIEW_OUTPUT ||
    specimen === undefined ||
    !sameFileIdentity(specimen.identity, generation.specimen.identity) ||
    specimen.sha256 !== generation.specimen.sha256 ||
    generation.manifest.relPath !== 'manifest.json' ||
    sha256Bytes(Buffer.from(generation.manifest.content, 'utf8')) !== generation.manifest.sha256
  ) {
    return false;
  }

  const manifestRead = stableReadRegularFile(path.join(distDir, 'manifest.json'), {
    requireSingleLink: true,
  });
  if (
    manifestRead === undefined ||
    !sameFileIdentity(manifestRead.identity, generation.manifest.identity) ||
    manifestRead.sha256 !== generation.manifest.sha256 ||
    manifestRead.bytes.toString('utf8') !== generation.manifest.content
  ) {
    return false;
  }

  let parsed;
  try {
    parsed = parseStrictManifest(generation.manifest.content);
  } catch {
    return false;
  }
  if (parsed.sourceHash !== coreSourceHash) return false;

  const required = new Map(generation.requiredInputs.map((input) => [input.relPath, input]));
  if (
    required.size !== REQUIRED_PREVIEW_INPUTS.length ||
    REQUIRED_PREVIEW_INPUTS.some((relPath) => !required.has(relPath))
  ) {
    return false;
  }
  for (const relPath of REQUIRED_PREVIEW_INPUTS) {
    const captured = required.get(relPath)!;
    const current = stableReadRegularFile(path.join(distDir, relPath), { requireSingleLink: true });
    if (
      parsed.outputs[relPath] !== coreSourceHash ||
      current === undefined ||
      !sameFileIdentity(current.identity, captured.identity) ||
      current.sha256 !== captured.sha256
    ) {
      return false;
    }
  }

  const palettePath = path.join(distDir, 'palette.svg');
  if (!generation.palette.present) return pathIsAbsent(palettePath);
  if (generation.palette.file.relPath !== 'palette.svg' || parsed.outputs['palette.svg'] !== coreSourceHash) {
    return false;
  }
  const palette = stableReadRegularFile(palettePath, { requireSingleLink: true });
  return palette !== undefined &&
    sameFileIdentity(palette.identity, generation.palette.file.identity) &&
    palette.sha256 === generation.palette.file.sha256;
}

/** Classify the optional explanation inputs for the check gate. */
export function classifyInspirationViewFreshness(
  projectDir: string,
  coreSourceHash: string,
): InspirationViewFreshnessClassification {
  try {
    const loaded = loadInspirationTrace(projectDir);
    if (loaded === undefined) return { state: 'absent' };
    return {
      state: 'current',
      freshness: inspirationOutputFreshness(
        coreSourceHash,
        loaded.traceSha256,
        loaded.asset.relativePath,
        loaded.asset.sha256,
      ),
    };
  } catch {
    // `onbrand check` intentionally stays a core gate. A malformed optional
    // trace makes a full build fail, while the dedicated exporter reports it.
    return { state: 'invalid' };
  }
}
