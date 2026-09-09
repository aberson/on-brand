/**
 * Bounded, read-only catalog export for inspiration-to-implementation traces.
 *
 * This is deliberately a producer-side file-format seam.  It discovers local
 * On Brand projects, verifies the optional inspiration trace against the
 * current tokens and generated-view provenance, and writes one portable JSON
 * artifact.  It never rebuilds a project and it never imports Dev Observatory.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSourceHash } from '../build/manifest.ts';
import { loadBrandSources } from '../build/compile.ts';
import {
  assertUnlinkedDirectoryPath,
  assertSameUnlinkedDirectory,
  createPrivateExclusiveRegularFile,
  inspectSafeRegularFileTarget,
  removeOwnedFile,
  sameFileNode,
  sameFileIdentity,
  stageFileExclusive,
  publishStagedFile,
  stableHashRegularFile,
  stableInspectRegularFile,
  stableReadRegularFile,
  type FileIdentity,
  type StableRegularFile,
} from '../filesystem.ts';
import {
  RetirementFinalizationError,
  encodeCooperativeLockRecord,
  localProcessState,
  readStrictCooperativeLockRecord,
  retireVerifiedRegularFile,
  type CooperativeLockRecord,
  type LocalProcessState,
  type RetireVerifiedRegularFileOptions,
} from '../cooperative-lock.ts';
import { isPlainObject } from '../schema/types.ts';
import type { ImageClusterAlgorithm } from '../extract/palette-evidence.ts';
import {
  discoverBrands,
  type BrandProvenance,
  type BrandStatus,
  type DiscoveredBrand,
} from '../gallery/discover.ts';
import {
  INSPIRATION_LIMITS,
  type Confidence,
  type DefaultDerivedRole,
  type ReviewStatus,
  type SelectionSource,
  type UnobservedDefault,
} from './contract.ts';
import { InspirationLoadError, loadInspirationTrace } from './load.ts';
import { InspirationResolveError, resolveInspirationTrace } from './resolve.ts';
import {
  INSPIRATION_VIEW_OUTPUT,
  inspirationOutputFreshness,
} from './views.ts';
import {
  SPECIMEN_VIEW_MAX_BYTES,
  SPECIMEN_VIEW_OUTPUT,
  recordedSpecimenContentDigest,
} from '../preview/contract.ts';
import {
  renderPosixInspirationExportRetry,
  renderPowerShellInspirationExportRetry,
} from './retry-command.ts';

/** Stable contract identifier consumed by the separately owned explorer. */
export const INSPIRATION_ARTIFACT_SCHEMA = 'onbrand.inspiration-to-implementation' as const;
/** Increment only for backwards-incompatible artifact changes. */
export const INSPIRATION_ARTIFACT_SCHEMA_VERSION = 1 as const;
/** The default producer artifact is intentionally outside every brand payload. */
export const DEFAULT_INSPIRATION_ARTIFACT_FILENAME = '.observatory/inspiration-to-implementation.json';

/** Fixed v1 export limits.  They are serialized, not configurable hints. */
export const INSPIRATION_EXPORT_LIMITS = {
  maxItems: 50,
  maxMappingsPerItem: INSPIRATION_LIMITS.maxMappings,
  maxTargetsPerMapping: INSPIRATION_LIMITS.maxTargetsPerMapping,
  maxTextLength: INSPIRATION_LIMITS.maxTextLength,
  maxAssetBytes: INSPIRATION_LIMITS.maxAssetBytes,
  maxAssetDimension: INSPIRATION_LIMITS.maxAssetDimension,
  maxDecodedPixels: INSPIRATION_LIMITS.maxDecodedPixels,
  maxBytes: 1_000_000,
} as const;

/** A stale lock is recoverable only after this conservative local timeout. */
export const INSPIRATION_EXPORT_LOCK_STALE_MS = 15 * 60 * 1_000;

export type InspirationTraceState = 'available' | 'stale' | 'invalid' | 'unavailable';

export interface InspirationBrandStatusCounts {
  adopted: number;
  proposal: number;
  incomplete: number;
  stale: number;
  invalid: number;
}

export interface InspirationTraceStateCounts {
  available: number;
  stale: number;
  invalid: number;
  unavailable: number;
}

export interface InspirationArtifactInspiration {
  creator: string;
  title: string;
  date: string;
  sourceUrl: string | null;
  rights: string;
  licenseUrl: string | null;
  retrievedAt: string | null;
  assetPath: string;
  assetSha256: string;
  assetMediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  alt: string;
  width: number;
  height: number;
  analysisAlgorithm: ImageClusterAlgorithm;
}

export interface InspirationArtifactTarget {
  tokenPath: string;
  presentation: 'surface' | 'text' | 'button-bg' | 'badge-bg' | 'chart-series' | 'swatch-only';
  relationship: 'sampled' | 'adjusted-for-contrast' | 'derived';
  usage: string;
  lightHex: string;
  darkHex: string | null;
}

export interface InspirationArtifactMapping {
  id: string;
  label: string;
  region: { x: number; y: number; width: number; height: number };
  sampleHex: string;
  sampleMethod: ImageClusterAlgorithm;
  selectionSource: SelectionSource;
  pixelShare: number;
  targets: InspirationArtifactTarget[];
  rationale: string;
  confidence: Confidence;
}

export interface InspirationArtifactImplementation {
  sourceId: string;
  basePreset: string | null;
  tokenSourceHash: string;
  unobservedDefaults: UnobservedDefault[];
  defaultDerivedColorTargets: Array<{
    tokenPath: string;
    role: DefaultDerivedRole;
    reason: 'no-qualifying-image-sample';
  }>;
  mappings: InspirationArtifactMapping[];
}

interface InspirationArtifactItemBase {
  id: string;
  label: string;
  summary: string;
  relPath: string;
  brandStatus: BrandStatus;
  brandProvenance: BrandProvenance;
  final: boolean;
  traceState: InspirationTraceState;
  traceReviewStatus: ReviewStatus | null;
  reason: string;
}

export interface InspirationArtifactAvailableItem extends InspirationArtifactItemBase {
  traceState: 'available';
  traceReviewStatus: ReviewStatus;
  inspiration: InspirationArtifactInspiration;
  implementation: InspirationArtifactImplementation;
  standalonePath: string;
  specimenPath?: string;
  error?: never;
}

export interface InspirationArtifactStaleItem extends InspirationArtifactItemBase {
  traceState: 'stale';
  traceReviewStatus: ReviewStatus;
  inspiration: InspirationArtifactInspiration;
  implementation: InspirationArtifactImplementation;
  standalonePath?: never;
  specimenPath?: never;
  error?: never;
}

export interface InspirationArtifactUnavailableItem extends InspirationArtifactItemBase {
  traceState: 'invalid' | 'unavailable';
  traceReviewStatus: null;
  inspiration?: never;
  implementation?: never;
  standalonePath?: never;
  specimenPath?: never;
  error: string;
}

export type InspirationArtifactItem =
  | InspirationArtifactAvailableItem
  | InspirationArtifactStaleItem
  | InspirationArtifactUnavailableItem;

/** Exact v1 producer artifact.  No path in this type is absolute. */
export interface InspirationArtifact {
  schema: typeof INSPIRATION_ARTIFACT_SCHEMA;
  schemaVersion: typeof INSPIRATION_ARTIFACT_SCHEMA_VERSION;
  generatedAt: string;
  limits: typeof INSPIRATION_EXPORT_LIMITS;
  summary: {
    discoveredTraceCount: number;
    emittedItemCount: number;
    itemsTruncated: boolean;
    finalCount: number;
    proposalCount: number;
    brandStatusCounts: InspirationBrandStatusCounts;
    traceStateCounts: InspirationTraceStateCounts;
  };
  items: InspirationArtifactItem[];
}

export interface BuildInspirationArtifactOptions {
  /** Explicit workspace root.  Discovery never scans implicitly. */
  root: string;
  /** Injectable clock used only for generatedAt / lock diagnostics. */
  now?: () => Date;
  /** Test seam for local preset / extends resolution. */
  presetsRoot?: string;
}

export interface ExportInspirationArtifactOptions extends BuildInspirationArtifactOptions {
  /** Defaults to .observatory/inspiration-to-implementation.json below root. */
  out?: string;
  /**
   * Optional producer-side acceptance check, evaluated after the bounded
   * artifact is built but before any catalog bytes are staged.  This lets a
   * `from-image` transaction prove that its just-completed proposal appears
   * exactly once without risking publication of an incomplete catalog.
   */
  assertArtifact?: (artifact: InspirationArtifact) => void;
  /** Test-only seam after catalog staging and before atomic publication. */
  beforeArtifactPublish?: (stagedPath: string) => void;
  /** Test-only controller identity, liveness, and lifecycle seams. */
  retirement?: Omit<RetireVerifiedRegularFileOptions, 'sourceToken' | 'sourceOwnerStillRetirable'>;
}

export interface ExportInspirationArtifactResult {
  outPath: string;
  artifact: InspirationArtifact;
  bytes: number;
}

/** The durable, intentionally small record written into `<out>.lock`. */
export interface InspirationExportLockRecord extends CooperativeLockRecord {}

export interface RecoverInspirationExportLockOptions {
  root: string;
  out?: string;
  now?: () => Date;
  /** Test seam for owner revival immediately before stale-lock detach. */
  processState?: (pid: number) => LocalProcessState;
  /** Test-only controller identity, liveness, and lifecycle seams. */
  retirement?: Omit<RetireVerifiedRegularFileOptions, 'sourceToken' | 'sourceOwnerStillRetirable'>;
}

export interface RecoverInspirationExportLockResult {
  outPath: string;
  lockPath: string;
  recovered: boolean;
  /** True only when the lock path was safely absent at inspection time. */
  alreadyClear?: boolean;
  /** Why no lock was removed; omitted when recovery succeeded. */
  reason?: string;
}

interface CandidateItem {
  item: InspirationArtifactItem;
  /** Valid source ID when available; a private stable sentinel otherwise. */
  sourceSort: string;
}

interface HeldExportLock {
  path: string;
  record: InspirationExportLockRecord;
  identity: FileIdentity;
  bytes: Buffer;
  parentPath: string;
  parentIdentity: FileIdentity;
  retirement: ExportInspirationArtifactOptions['retirement'];
}

type ExportLockReleaseResult =
  | { released: true }
  | {
      released: false;
      residual: 'strict-recoverable' | 'detached' | 'manual';
      reason: string;
    };

type ExportLockObservation =
  | { state: 'absent' }
  | { state: 'replacement' }
  | { state: 'owned-strict'; file: StableRegularFile }
  | { state: 'owned-unsafe'; reason: string }
  | { state: 'ambiguous'; reason: string };

export interface InspirationCatalogCommandBlock {
  kind: 'command';
  label: string;
  command: string;
}

export interface InspirationCatalogManualBlock {
  kind: 'manual';
  instruction: string;
}

export type InspirationCatalogRecoveryBlock =
  | InspirationCatalogCommandBlock
  | InspirationCatalogManualBlock;

/**
 * Owned catalog failure representation shared by the standalone and paired
 * producers. Consumers render this structure; they never parse exporter prose.
 */
export class InspirationCatalogError extends Error {
  readonly summary: string;
  readonly additionalDiagnostics: readonly string[];
  readonly recoveryBlock: InspirationCatalogRecoveryBlock;

  constructor(
    summary: string,
    recoveryBlock: InspirationCatalogRecoveryBlock,
    options: { cause?: unknown; additionalDiagnostics?: readonly string[] } = {},
  ) {
    const cleanSummary = oneLineCatalogText(summary);
    const diagnostics = (options.additionalDiagnostics ?? []).map(oneLineCatalogText);
    const cleanBlock: InspirationCatalogRecoveryBlock = recoveryBlock.kind === 'command'
      ? {
          kind: 'command',
          label: oneLineCatalogText(recoveryBlock.label),
          command: oneLineCatalogText(recoveryBlock.command),
        }
      : { kind: 'manual', instruction: oneLineCatalogText(recoveryBlock.instruction) };
    super(
      renderInspirationCatalogError(cleanSummary, diagnostics, cleanBlock),
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'InspirationCatalogError';
    this.summary = cleanSummary;
    this.additionalDiagnostics = diagnostics;
    this.recoveryBlock = cleanBlock;
  }
}


/** Stable route-safe identity, calculated over the exact v1 tuple. */
export function inspirationArtifactItemId(relPath: string, sourceId: string): string {
  return `inspiration-${createHash('sha256').update(JSON.stringify([relPath, sourceId]), 'utf8').digest('hex').slice(0, 24)}`;
}

/**
 * Build a portable artifact in memory.  This reads a bounded local workspace
 * but performs no writes, which keeps it useful for preflight and focused
 * tests.  Missing inspiration.json simply means that brand has not opted in.
 */
export function buildInspirationArtifact(options: BuildInspirationArtifactOptions): InspirationArtifact {
  const result = discoverBrands(options.root, {
    ...(options.presetsRoot !== undefined ? { presetsRoot: options.presetsRoot } : {}),
  });
  const candidates: CandidateItem[] = [];
  for (const brand of result.brands) {
    const candidate = inspectBrandTrace(brand, result.root, options.presetsRoot);
    if (candidate !== undefined) candidates.push(candidate);
  }

  candidates.sort((left, right) => {
    if (left.item.relPath < right.item.relPath) return -1;
    if (left.item.relPath > right.item.relPath) return 1;
    if (left.sourceSort < right.sourceSort) return -1;
    if (left.sourceSort > right.sourceSort) return 1;
    return 0;
  });
  assertUniqueItemIds(candidates);

  const allItems = candidates.map((candidate) => candidate.item);
  const items = allItems.slice(0, INSPIRATION_EXPORT_LIMITS.maxItems);
  return {
    schema: INSPIRATION_ARTIFACT_SCHEMA,
    schemaVersion: INSPIRATION_ARTIFACT_SCHEMA_VERSION,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    limits: INSPIRATION_EXPORT_LIMITS,
    summary: {
      discoveredTraceCount: allItems.length,
      emittedItemCount: items.length,
      itemsTruncated: items.length < allItems.length,
      finalCount: allItems.filter((item) => item.final).length,
      proposalCount: allItems.filter((item) => item.brandProvenance === 'proposal').length,
      brandStatusCounts: countBrandStatuses(allItems),
      traceStateCounts: countTraceStates(allItems),
    },
    items,
  };
}

/**
 * Build then atomically publish the artifact.  The lock covers the complete
 * read/build/write operation so two concurrent refreshes cannot overwrite one
 * another's result.  A failed write leaves the old complete artifact intact.
 */
export function exportInspirationArtifact(
  options: ExportInspirationArtifactOptions,
): ExportInspirationArtifactResult {
  const outPath = resolveInspirationArtifactOutput(options.root, options.out);
  const held = acquireExportLock(options.root, outPath, options.out, options.now, options.retirement);
  let result: ExportInspirationArtifactResult | undefined;
  let refreshError: InspirationCatalogError | undefined;
  try {
    const artifact = buildInspirationArtifact(options);
    options.assertArtifact?.(artifact);
    const json = serializeArtifact(artifact);
    writeArtifactAtomic(options.root, outPath, json, options.beforeArtifactPublish);
    result = { outPath, artifact, bytes: Buffer.byteLength(json, 'utf8') };
  } catch (cause) {
    refreshError = cause instanceof InspirationCatalogError
      ? cause
      : catalogRetryError(
          `failed while refreshing inspiration catalog (${messageOf(cause)})`,
          options.root,
          options.out,
          { cause },
        );
  }
  const release = releaseExportLock(held);
  if (!release.released) {
    const diagnostic = `owned inspiration artifact lock could not be released (${release.reason})`;
    const retainedManualRecovery = refreshError?.recoveryBlock.kind === 'manual'
      ? [refreshError.recoveryBlock.instruction]
      : [];
    throw catalogReleaseError(
      refreshError?.summary ?? `failed while refreshing inspiration catalog (${diagnostic})`,
      options.root,
      options.out,
      held.path,
      release,
      {
        ...(refreshError === undefined ? {} : { cause: refreshError }),
        ...(refreshError === undefined
          ? {}
          : {
              additionalDiagnostics: [
                ...refreshError.additionalDiagnostics,
                ...retainedManualRecovery,
                `Additionally, ${diagnostic}.`,
              ],
            }),
      },
    );
  }
  if (refreshError !== undefined) throw refreshError;
  if (result === undefined) throw new Error('inspiration catalog refresh produced no result');
  return result;
}

/**
 * Safely remove one abandoned lock.  A lock is never guessed away: it must
 * contain our exact record shape, be older than fifteen minutes, and name a
 * local PID which is demonstrably no longer alive.
 */
export function recoverStaleInspirationExportLock(
  options: RecoverInspirationExportLockOptions,
): RecoverInspirationExportLockResult {
  const outPath = resolveInspirationArtifactOutput(options.root, options.out);
  const lockPath = `${outPath}.lock`;
  const now = (options.now ?? (() => new Date()))();
  const processState = options.processState ?? localProcessState;
  try {
    const current = readStrictCooperativeLockRecord(lockPath);
    if (current === undefined) {
      const observed = inspectSafeRegularFileTarget(lockPath, { requireSingleLink: true });
      if (observed.state === 'absent') {
        return {
          outPath,
          lockPath,
          recovered: false,
          alreadyClear: true,
          reason: 'lock is already absent',
        };
      }
      return {
        outPath,
        lockPath,
        recovered: false,
        reason: observed.state === 'unsafe'
          ? 'lock path is linked, unreadable, or otherwise unsafe'
          : 'lock contents are malformed, unreadable, or oversized',
      };
    }
    const ownerStillRetirable = (): boolean => {
      const age = now.getTime() - Date.parse(current.record.startedAt);
      return Number.isFinite(age) && age > INSPIRATION_EXPORT_LOCK_STALE_MS &&
        processState(current.record.pid) === 'dead';
    };
    const age = now.getTime() - Date.parse(current.record.startedAt);
    if (!Number.isFinite(age) || age <= INSPIRATION_EXPORT_LOCK_STALE_MS) {
      return { outPath, lockPath, recovered: false, reason: 'lock is not older than fifteen minutes' };
    }
    const ownerState = processState(current.record.pid);
    if (ownerState !== 'dead') {
      return {
        outPath,
        lockPath,
        recovered: false,
        reason: ownerState === 'alive'
          ? 'recorded local lock PID is still alive'
          : 'recorded local lock PID cannot be proven dead',
      };
    }
    const rechecked = readStrictCooperativeLockRecord(lockPath);
    if (
      rechecked === undefined || rechecked.record.runToken !== current.record.runToken ||
      !rechecked.file.bytes.equals(current.file.bytes) ||
      !sameFileIdentity(rechecked.file.identity, current.file.identity)
    ) return { outPath, lockPath, recovered: false, reason: 'lock changed while recovery was attempted' };
    const parentPath = path.dirname(lockPath);
    const parentIdentity = assertUnlinkedDirectoryPath(parentPath, 'inspiration artifact lock parent');
    const retired = retireVerifiedRegularFile(
      lockPath,
      current.file,
      parentPath,
      parentIdentity,
      {
        ...options.retirement,
        sourceToken: current.record.runToken,
        sourceOwnerStillRetirable: ownerStillRetirable,
      },
    );
    return retired === 'retired'
      ? { outPath, lockPath, recovered: true }
      : {
          outPath,
          lockPath,
          recovered: false,
          reason: retired === 'contended'
            ? 'lock recovery is already in progress or has unsafe controller residue'
            : 'lock changed while recovery was attempted',
        };
  } catch (cause) {
    return { outPath, lockPath, recovered: false, reason: messageOf(cause) };
  }
}

/** Backwards-friendly verb form for callers that name the producer action. */
export const recoverStaleInspirationLock = recoverStaleInspirationExportLock;

function inspectBrandTrace(
  brand: DiscoveredBrand,
  workspaceRoot: string,
  presetsRoot: string | undefined,
): CandidateItem | undefined {
  const presence = tracePresence(brand.brandDir);
  if (presence === 'absent') return undefined;
  if (presence === 'unavailable') {
    return failedItem(brand, workspaceRoot, 'unavailable', 'could not inspect brand/inspiration.json');
  }
  if (presence === 'unsafe') {
    return failedItem(
      brand,
      workspaceRoot,
      'invalid',
      'brand/inspiration.json must be a local non-linked regular file',
    );
  }

  // Core discovery is intentionally independent from optional metadata.  If
  // the token source cannot load, we do not partly trust trace fields merely
  // to make an invalid brand look detailed; that is an unavailable trace.
  if (brand.status === 'invalid') {
    return failedItem(
      brand,
      workspaceRoot,
      'unavailable',
      brand.error ?? 'brand sources do not load, so trace token resolution is unavailable',
    );
  }

  let loaded: NonNullable<ReturnType<typeof loadInspirationTrace>>;
  try {
    const result = loadInspirationTrace(brand.root);
    if (result === undefined) return undefined; // File disappeared after the presence check.
    loaded = result;
  } catch (cause) {
    return failedItem(brand, workspaceRoot, stateForLoadFailure(cause), messageOf(cause));
  }

  let sources: ReturnType<typeof loadBrandSources>;
  let coreSourceHash: string;
  try {
    sources = loadBrandSources(brand.root, {
      ...(presetsRoot !== undefined ? { presetsRoot } : {}),
    });
    coreSourceHash = computeSourceHash(sources.sourceInputs).sourceHash;
  } catch (cause) {
    return failedItem(
      brand,
      workspaceRoot,
      'unavailable',
      `brand sources could not be resolved while inspecting the trace: ${messageOf(cause)}`,
    );
  }

  let resolved: ReturnType<typeof resolveInspirationTrace>;
  try {
    resolved = resolveInspirationTrace(loaded, sources.resolved.document, sources.darkDocument);
  } catch (cause) {
    const state = cause instanceof InspirationResolveError ? 'invalid' : 'unavailable';
    return failedItem(brand, workspaceRoot, state, messageOf(cause));
  }

  const details = exportTraceDetails(brand, resolved, coreSourceHash);
  const output = inspectGeneratedViews(brand, coreSourceHash, resolved.traceSha256, resolved.asset.relativePath, resolved.asset.sha256);
  const label = boundedText(`${resolved.trace.asset.title} — ${resolved.trace.asset.creator}`);
  const base = {
    id: inspirationArtifactItemId(brand.relPath, resolved.trace.id),
    label,
    summary: resolved.trace.summary,
    relPath: brand.relPath,
    brandStatus: brand.status,
    brandProvenance: brand.provenance,
    final: brand.final,
  };
  if (output.current) {
    const item: InspirationArtifactAvailableItem = {
      ...base,
      traceState: 'available',
      traceReviewStatus: resolved.trace.reviewStatus,
      reason: 'Trace, asset, resolved token mappings, and generated explanation are current.',
      ...details,
      standalonePath: workspacePath(brand.relPath, 'brand', 'dist', INSPIRATION_VIEW_OUTPUT),
      ...(output.specimenCurrent
        ? { specimenPath: workspacePath(brand.relPath, 'brand', 'dist', SPECIMEN_VIEW_OUTPUT) }
        : {}),
    };
    return { item, sourceSort: resolved.trace.id };
  }

  const item: InspirationArtifactStaleItem = {
    ...base,
    traceState: 'stale',
    traceReviewStatus: resolved.trace.reviewStatus,
    reason: output.reason,
    ...details,
  };
  return { item, sourceSort: resolved.trace.id };
}

function exportTraceDetails(
  brand: DiscoveredBrand,
  resolved: ReturnType<typeof resolveInspirationTrace>,
  tokenSourceHash: string,
): Pick<InspirationArtifactAvailableItem, 'inspiration' | 'implementation'> {
  const trace = resolved.trace;
  return {
    inspiration: {
      creator: trace.asset.creator,
      title: trace.asset.title,
      date: trace.asset.date,
      sourceUrl: trace.asset.sourceUrl,
      rights: trace.asset.rights,
      licenseUrl: trace.asset.licenseUrl,
      retrievedAt: trace.asset.retrievedAt,
      assetPath: workspacePath(brand.relPath, 'brand', ...resolved.asset.relativePath.split('/')),
      assetSha256: resolved.asset.sha256,
      assetMediaType: resolved.asset.mediaType,
      alt: trace.asset.alt,
      width: resolved.asset.width,
      height: resolved.asset.height,
      analysisAlgorithm: trace.analysis.algorithm,
    },
    implementation: {
      sourceId: trace.id,
      basePreset: trace.analysis.basePreset,
      tokenSourceHash,
      unobservedDefaults: [...trace.analysis.unobservedDefaults],
      defaultDerivedColorTargets: resolved.defaultDerivedColorTargets.map((target) => ({
        tokenPath: target.token,
        role: target.role,
        reason: target.reason,
      })),
      mappings: resolved.mappings.map((mapping) => ({
        id: mapping.id,
        label: mapping.label,
        region: { ...mapping.region },
        sampleHex: mapping.sample.hex,
        sampleMethod: mapping.sample.method,
        selectionSource: mapping.sample.selectionSource,
        pixelShare: mapping.sample.pixelShare,
        targets: mapping.targets.map((target) => ({
          tokenPath: target.token,
          presentation: target.presentation,
          relationship: target.relationship,
          usage: target.usage,
          lightHex: target.lightHex,
          darkHex: target.darkHex,
        })),
        rationale: mapping.rationale,
        confidence: mapping.confidence,
      })),
    },
  };
}

function failedItem(
  brand: DiscoveredBrand,
  workspaceRoot: string,
  traceState: 'invalid' | 'unavailable',
  diagnostic: string,
): CandidateItem {
  const error = portableDiagnostic(diagnostic, workspaceRoot);
  const reason = boundedText(
    traceState === 'invalid'
      ? `Inspiration trace is invalid: ${error}`
      : `Inspiration trace is unavailable: ${error}`,
  );
  // Invalid/unavailable rows deliberately do not trust decoded trace IDs.  A
  // per-state sentinel still gives one deterministic item ID per brand root.
  const sourceSort = `<${traceState}>`;
  return {
    item: {
      id: inspirationArtifactItemId(brand.relPath, sourceSort),
      label: boundedText(brand.name),
      summary: reason,
      relPath: brand.relPath,
      brandStatus: brand.status,
      brandProvenance: brand.provenance,
      // Trace health does not erase lifecycle.  The contract makes only an
      // invalid trace non-final unconditionally; an unavailable inspection of
      // an otherwise current adopted brand remains independently final.
      final: traceState === 'invalid' ? false : brand.final,
      traceState,
      traceReviewStatus: null,
      reason,
      error,
    },
    sourceSort,
  };
}

function tracePresence(brandDir: string): 'absent' | 'present' | 'unsafe' | 'unavailable' {
  try {
    const entry = lstatSync(path.join(brandDir, 'inspiration.json'));
    return entry.isFile() && !entry.isSymbolicLink() ? 'present' : 'unsafe';
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unavailable';
  }
}

function stateForLoadFailure(cause: unknown): 'invalid' | 'unavailable' {
  if (hasUnavailableIoCause(cause)) return 'unavailable';
  return cause instanceof InspirationLoadError ? 'invalid' : 'unavailable';
}

function hasUnavailableIoCause(cause: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = cause;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const code = typeof current === 'object' && current !== null
      ? (current as NodeJS.ErrnoException).code
      : undefined;
    if (
      code === 'EACCES' || code === 'EPERM' || code === 'EIO' || code === 'EMFILE' ||
      code === 'ENFILE' || code === 'EBUSY' || code === 'ENOENT'
    ) {
      return true;
    }
    current = typeof current === 'object' && current !== null
      ? ((current as { originalCause?: unknown; cause?: unknown }).originalCause ??
        (current as { cause?: unknown }).cause)
      : undefined;
  }
  return false;
}

function inspectGeneratedViews(
  brand: DiscoveredBrand,
  coreSourceHash: string,
  traceSha256: string,
  assetRelativePath: string,
  assetSha256: string,
): { current: boolean; specimenCurrent: boolean; reason: string } {
  const distDir = path.join(brand.brandDir, 'dist');
  const manifestPath = path.join(distDir, 'manifest.json');
  let parsed: unknown;
  try {
    assertUnlinkedDirectoryPath(distDir, 'catalog dist tree');
    const manifest = stableReadRegularFile(manifestPath, {
      maxBytes: INSPIRATION_EXPORT_LIMITS.maxBytes,
      requireSingleLink: true,
    });
    if (manifest === undefined) {
      return { current: false, specimenCurrent: false, reason: 'Trace is valid, but its generated-view manifest is absent or unusable.' };
    }
    parsed = JSON.parse(manifest.bytes.toString('utf8')) as unknown;
  } catch {
    return { current: false, specimenCurrent: false, reason: 'Trace is valid, but its generated-view manifest cannot be read.' };
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed['outputs'])) {
    return { current: false, specimenCurrent: false, reason: 'Trace is valid, but its generated-view manifest is invalid.' };
  }

  const expected = inspirationOutputFreshness(coreSourceHash, traceSha256, assetRelativePath, assetSha256);
  const outputs = parsed['outputs'];
  const outputSources = isPlainObject(parsed['outputSources']) ? parsed['outputSources'] : undefined;
  const stale = {
    current: false,
    specimenCurrent: false,
    reason: 'Trace, asset, and resolved token mappings are valid, but the generated explanation is absent, untracked, or stale.',
  } as const;
  if (
    outputs[INSPIRATION_VIEW_OUTPUT] !== expected.hash ||
    !isCurrentOutputSources(outputSources?.[INSPIRATION_VIEW_OUTPUT], expected.sources)
  ) {
    return stale;
  }
  const explanation = stableInspectRegularFile(path.join(distDir, INSPIRATION_VIEW_OUTPUT), {
    maxBytes: INSPIRATION_LIMITS.maxStandaloneHtmlBytes,
    requireSingleLink: true,
  });
  if (explanation === undefined) return stale;

  // The optional specimen is inspected only after every required explanation
  // prerequisite passes. Its exact-content row is the sole catalog reason to
  // read generated-output bytes, and that digest uses a fixed-memory stream.
  const recordedSpecimenDigest = recordedSpecimenContentDigest(parsed);
  if (outputs[SPECIMEN_VIEW_OUTPUT] !== coreSourceHash || recordedSpecimenDigest === undefined) {
    return { current: true, specimenCurrent: false, reason: '' };
  }
  const specimen = stableHashRegularFile(path.join(distDir, SPECIMEN_VIEW_OUTPUT), {
    maxBytes: SPECIMEN_VIEW_MAX_BYTES,
    requireSingleLink: true,
  });
  return {
    current: true,
    specimenCurrent: specimen !== undefined && recordedSpecimenDigest === specimen.sha256,
    reason: '',
  };
}

function isCurrentOutputSources(value: unknown, expected: readonly {
  label: string;
  sourcePath: string | null;
  kind: 'text-lf' | 'binary' | 'digest';
  sha256: string;
}[]): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  return value.every((entry, index) => {
    const wanted = expected[index];
    return isPlainObject(entry) && wanted !== undefined &&
      entry['label'] === wanted.label &&
      entry['sourcePath'] === wanted.sourcePath &&
      entry['kind'] === wanted.kind &&
      entry['sha256'] === wanted.sha256;
  });
}

function countBrandStatuses(items: readonly InspirationArtifactItem[]): InspirationBrandStatusCounts {
  const counts: InspirationBrandStatusCounts = { adopted: 0, proposal: 0, incomplete: 0, stale: 0, invalid: 0 };
  for (const item of items) counts[item.brandStatus]++;
  return counts;
}

function countTraceStates(items: readonly InspirationArtifactItem[]): InspirationTraceStateCounts {
  const counts: InspirationTraceStateCounts = { available: 0, stale: 0, invalid: 0, unavailable: 0 };
  for (const item of items) counts[item.traceState]++;
  return counts;
}

function assertUniqueItemIds(candidates: readonly CandidateItem[]): void {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.item.id)) {
      throw new Error(`inspiration artifact item ID collision for ${JSON.stringify(candidate.item.relPath)}`);
    }
    seen.add(candidate.item.id);
  }
}

function workspacePath(relPath: string, ...segments: string[]): string {
  return [...(relPath === '.' ? [] : relPath.split('/')), ...segments].join('/');
}

function boundedText(value: string): string {
  if (value.length <= INSPIRATION_EXPORT_LIMITS.maxTextLength) return value;
  return `${value.slice(0, INSPIRATION_EXPORT_LIMITS.maxTextLength - 1)}…`;
}

/** Strip machine-specific file locations from a portable artifact diagnostic. */
function portableDiagnostic(value: string, workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot);
  const variants = new Set([root, root.replaceAll('\\', '/'), root.replaceAll('/', '\\')]);
  let portable = value;
  for (const variant of variants) {
    portable = portable.replace(new RegExp(regexEscape(variant), 'gi'), '<workspace>');
  }
  portable = portable
    .replace(/file:\/\/\/[^\s"'`()[\]{}<>]+/gi, '<path>')
    .replace(/[a-z]:[\\/][^\s"'`()[\]{}<>]*/gi, '<path>')
    .replace(/(^|[\s("'])\/(?:[^\s"'`()[\]{}<>]*)/g, '$1<path>');
  return boundedText(portable === '' ? 'no diagnostic was provided' : portable);
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function serializeArtifact(artifact: InspirationArtifact): string {
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > INSPIRATION_EXPORT_LIMITS.maxBytes) {
    throw new Error(
      `inspiration artifact is ${bytes} bytes, over the ${INSPIRATION_EXPORT_LIMITS.maxBytes}-byte limit; reduce the workspace scope before exporting`,
    );
  }
  return json;
}

/**
 * Validate and resolve a catalog destination without creating a lock or
 * writing anything.  The CLI uses this during paired-command preflight, so
 * invalid catalog flags fail before `from-image` creates a proposal.
 */
export function resolveInspirationArtifactOutput(root: string, out: string | undefined): string {
  const resolvedRoot = path.resolve(root);
  assertUnlinkedDirectoryPath(resolvedRoot, 'inspiration workspace root');
  const outPath = out === undefined
    ? path.join(resolvedRoot, ...DEFAULT_INSPIRATION_ARTIFACT_FILENAME.split('/'))
    : path.isAbsolute(out)
      ? path.resolve(out)
      : path.resolve(resolvedRoot, out);
  if (!isInside(resolvedRoot, outPath) || outPath === resolvedRoot) {
    throw new Error('inspiration artifact --out must resolve to a file inside the explicit workspace root');
  }

  const relSegments = path.relative(resolvedRoot, outPath).split(path.sep);
  const excluded = new Set(['brand', 'node_modules', '.git', '.hg', '.svn', 'dist', 'assets', 'coverage', '.vscode', '.idea', '.next', '.cache', '.turbo']);
  if (relSegments.some((segment) => excluded.has(segment.toLowerCase()))) {
    throw new Error('inspiration artifact --out must not be inside a brand payload or excluded workspace directory');
  }
  assertSafeOutputAncestors(resolvedRoot, outPath);
  const realRoot = realpathSync(resolvedRoot);
  const existingParent = nearestExistingParent(path.dirname(outPath));
  if (!isInside(realRoot, realpathSync(existingParent))) {
    throw new Error('inspiration artifact --out parent resolves outside the explicit workspace root');
  }
  try {
    const entry = lstatSync(outPath);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error('inspiration artifact --out must name a regular file, not a symlink or directory');
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
  return outPath;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function nearestExistingParent(candidate: string): string {
  let current = candidate;
  while (!existsSync(current)) {
    const next = path.dirname(current);
    if (next === current) throw new Error(`could not find an existing parent for ${candidate}`);
    current = next;
  }
  return current;
}

function assertSafeOutputAncestors(root: string, outPath: string): void {
  const parent = path.dirname(outPath);
  const relative = path.relative(root, parent);
  if (relative === '') return;
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const entry = lstatSync(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error('inspiration artifact --out must not traverse linked or non-directory ancestors');
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw cause;
    }
  }
}

/**
 * Create only below an already-inspected, unlinked workspace tree, then prove
 * both the root and completed parent still name the directories we accepted.
 */
function prepareSafeOutputParent(
  root: string,
  target: string,
  description: string,
): FileIdentity {
  const resolvedRoot = path.resolve(root);
  const rootIdentity = assertUnlinkedDirectoryPath(resolvedRoot, 'inspiration workspace root');
  assertSafeOutputAncestors(resolvedRoot, target);
  const realRoot = realpathSync(resolvedRoot);
  const existingParent = nearestExistingParent(path.dirname(target));
  if (!isInside(realRoot, realpathSync(existingParent))) {
    throw new Error('inspiration artifact --out parent resolves outside the explicit workspace root');
  }

  mkdirSync(path.dirname(target), { recursive: true });
  assertSameUnlinkedDirectory(resolvedRoot, rootIdentity, 'inspiration workspace root');
  assertSafeOutputAncestors(resolvedRoot, target);
  const parentIdentity = assertUnlinkedDirectoryPath(path.dirname(target), description);
  if (!isInside(realRoot, realpathSync(path.dirname(target)))) {
    throw new Error('inspiration artifact --out parent resolves outside the explicit workspace root');
  }
  assertSameUnlinkedDirectory(resolvedRoot, rootIdentity, 'inspiration workspace root');
  assertSameUnlinkedDirectory(path.dirname(target), parentIdentity, description);
  return parentIdentity;
}

function writeArtifactAtomic(
  root: string,
  outPath: string,
  json: string,
  beforePublish: ((stagedPath: string) => void) | undefined,
): void {
  prepareSafeOutputParent(root, outPath, 'inspiration artifact parent');
  let staged: ReturnType<typeof stageFileExclusive> | undefined;
  try {
    staged = stageFileExclusive(outPath, json);
    beforePublish?.(staged.path);
    publishStagedFile(staged, outPath);
  } catch (cause) {
    if (staged !== undefined) removeOwnedFile(staged.path, staged.identity, { nodeOnly: true });
    throw cause;
  }
}

function acquireExportLock(
  root: string,
  outPath: string,
  requestedOut: string | undefined,
  now: (() => Date) | undefined,
  retirement: ExportInspirationArtifactOptions['retirement'],
): HeldExportLock {
  const lockPath = `${outPath}.lock`;
  const parentPath = path.dirname(lockPath);
  const parentIdentity = prepareSafeOutputParent(root, lockPath, 'inspiration artifact lock parent');
  const record: InspirationExportLockRecord = {
    runToken: randomUUID(),
    pid: process.pid,
    startedAt: (now ?? (() => new Date()))().toISOString(),
  };
  const bytes = encodeCooperativeLockRecord(record);
  try {
    const identity = createPrivateExclusiveRegularFile(
      lockPath,
      bytes,
      `inspiration artifact lock ${lockPath}`,
    );
    return { path: lockPath, record, identity, bytes, parentPath, parentIdentity, retirement };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
    const existing = readStrictCooperativeLockRecord(lockPath)?.record;
    if (existing !== undefined) {
      throw catalogRetryError(
        `inspiration catalog is already being refreshed by PID ${existing.pid}, started ${existing.startedAt}`,
        root,
        requestedOut,
      );
    }
    const observed = inspectSafeRegularFileTarget(lockPath, { requireSingleLink: true });
    if (observed.state === 'absent') {
      throw catalogRetryError(
        'inspiration catalog lock cleared while acquisition was being diagnosed',
        root,
        requestedOut,
      );
    }
    throw new InspirationCatalogError(
      `inspiration catalog lock ${lockPath} is malformed, oversized, unreadable, linked, or otherwise unsafe`,
      catalogManualLockRecoveryBlock(lockPath),
    );
  }
}

function releaseExportLock(held: HeldExportLock): ExportLockReleaseResult {
  const initial = observeExportLock(held);
  if (initial.state === 'absent' || initial.state === 'replacement') return { released: true };
  if (initial.state === 'owned-unsafe' || initial.state === 'ambiguous') {
    return { released: false, residual: 'manual', reason: initial.reason };
  }

  try {
    const retired = retireVerifiedRegularFile(
      held.path,
      initial.file,
      held.parentPath,
      held.parentIdentity,
      { ...held.retirement, sourceToken: held.record.runToken },
    );
    if (retired === 'retired') return { released: true };
    return classifyResidualAfterReleaseAttempt(
      held,
      retired === 'contended'
        ? 'controller lease is contended or unsafe'
        : 'owned lock changed before release',
    );
  } catch (cause) {
    if (cause instanceof RetirementFinalizationError && cause.primaryDetached) {
      return { released: false, residual: 'detached', reason: messageOf(cause) };
    }
    return classifyResidualAfterReleaseAttempt(held, messageOf(cause));
  }
}

/** Strict parsing is advisory here: identity-only inspection prevents an
 * oversized, unreadable, or malformed same-node residual from looking absent. */
function observeExportLock(held: HeldExportLock): ExportLockObservation {
  try {
    assertSameUnlinkedDirectory(held.parentPath, held.parentIdentity, 'inspiration artifact lock parent');
  } catch (cause) {
    return { state: 'ambiguous', reason: messageOf(cause) };
  }

  const strict = readStrictCooperativeLockRecord(held.path);
  if (strict !== undefined) {
    if (!sameFileNode(strict.file.identity, held.identity)) return { state: 'replacement' };
    if (strict.record.runToken !== held.record.runToken) {
      return { state: 'owned-unsafe', reason: 'owned lock token changed on the acquired inode' };
    }
    if (
      !sameFileIdentity(strict.file.identity, held.identity) ||
      !strict.file.bytes.equals(held.bytes)
    ) {
      return { state: 'owned-unsafe', reason: 'owned lock bytes or identity changed before release' };
    }
    return { state: 'owned-strict', file: strict.file };
  }

  const inspected = inspectSafeRegularFileTarget(held.path, { requireSingleLink: true });
  if (inspected.state === 'absent') return { state: 'absent' };
  if (inspected.state === 'unsafe') {
    return { state: 'ambiguous', reason: 'owned lock path is unreadable, linked, or otherwise unsafe' };
  }
  if (sameFileNode(inspected.identity, held.identity)) {
    return {
      state: 'owned-unsafe',
      reason: 'owned lock is present but oversized, unreadable, malformed, or identity-mutated',
    };
  }
  return { state: 'replacement' };
}

function classifyResidualAfterReleaseAttempt(
  held: HeldExportLock,
  attemptReason: string,
): ExportLockReleaseResult {
  const residual = observeExportLock(held);
  if (residual.state === 'replacement') return { released: true };
  if (residual.state === 'absent') {
    return { released: false, residual: 'detached', reason: attemptReason };
  }
  if (residual.state === 'owned-strict') {
    return { released: false, residual: 'strict-recoverable', reason: attemptReason };
  }
  return { released: false, residual: 'manual', reason: residual.reason };
}

function retryCommand(root: string, out: string | undefined, recoverStaleLock = false): string {
  const resolvedRoot = path.resolve(root);
  const output = out === undefined
    ? path.join(resolvedRoot, ...DEFAULT_INSPIRATION_ARTIFACT_FILENAME.split('/'))
    : path.isAbsolute(out) ? path.resolve(out) : path.resolve(resolvedRoot, out);
  const binPath = fileURLToPath(new URL('../../bin/onbrand.mjs', import.meta.url));
  const command = process.platform === 'win32'
    ? renderPowerShellInspirationExportRetry(process.execPath, binPath, resolvedRoot, output)
    : renderPosixInspirationExportRetry(process.execPath, binPath, resolvedRoot, output);
  return recoverStaleLock ? `${command} --recover-stale-lock` : command;
}

function catalogRetryError(
  summary: string,
  root: string,
  out: string | undefined,
  options: {
    cause?: unknown;
    recoverStaleLock?: boolean;
    additionalDiagnostics?: readonly string[];
  } = {},
): InspirationCatalogError {
  const recoverStaleLock = options.recoverStaleLock === true;
  return new InspirationCatalogError(
    summary,
    {
      kind: 'command',
      label: recoverStaleLock
        ? 'after the lock is older than 15 minutes, recover and retry with:'
        : 'retry with:',
      command: retryCommand(root, out, recoverStaleLock),
    },
    {
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      ...(options.additionalDiagnostics === undefined
        ? {}
        : { additionalDiagnostics: options.additionalDiagnostics }),
    },
  );
}

function catalogReleaseError(
  summary: string,
  root: string,
  out: string | undefined,
  lockPath: string,
  release: Exclude<ExportLockReleaseResult, { released: true }>,
  options: { cause?: unknown; additionalDiagnostics?: readonly string[] } = {},
): InspirationCatalogError {
  if (release.residual === 'strict-recoverable') {
    return catalogRetryError(summary, root, out, { ...options, recoverStaleLock: true });
  }
  if (release.residual === 'detached') {
    return catalogRetryError(summary, root, out, options);
  }
  return new InspirationCatalogError(
    summary,
    catalogManualLockRecoveryBlock(lockPath),
    options,
  );
}

function catalogManualLockRecoveryBlock(lockPath: string): InspirationCatalogManualBlock {
  return {
    kind: 'manual',
    instruction: `manual inspection required for ${lockPath}: verify that no publisher owns the residual path, remove it safely, then rerun inspiration-export.`,
  };
}

function renderInspirationCatalogError(
  summary: string,
  additionalDiagnostics: readonly string[],
  recoveryBlock: InspirationCatalogRecoveryBlock,
): string {
  return recoveryBlock.kind === 'command'
    ? [summary, ...additionalDiagnostics, recoveryBlock.label, recoveryBlock.command].join('\n')
    : [summary, ...additionalDiagnostics, recoveryBlock.instruction].join('\n');
}

function oneLineCatalogText(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    result += code < 0x20 || code === 0x7f ? ' ' : value[index]!;
  }
  return result.trim();
}

/** Preserve only exporter-owned command structure; flatten all foreign errors. */
export function formatInspirationCatalogFailure(cause: unknown): string {
  if (cause instanceof InspirationCatalogError) return cause.message;
  return oneLineCatalogText(messageOf(cause));
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
