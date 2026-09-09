/**
 * The reviewed source contract for `brand/inspiration.json`.
 *
 * This module deliberately has no filesystem or token-resolution dependency:
 * it validates the closed JSON shape and invariants which can be decided from
 * the trace alone.  `load.ts` owns trusted local-file / raster checks and
 * `resolve.ts` verifies that every target is a real color token.
 */

import {
  SUPPORTED_IMAGE_CLUSTER_ALGORITHMS,
  type ImageClusterAlgorithm,
  type ImageMediaType,
  type MappingPresentation,
  type MappingRelationship,
  type PaletteRegion,
} from '../extract/palette-evidence.ts';
import { isPlainObject, isUnsafeName } from '../schema/types.ts';

export const INSPIRATION_SCHEMA = 'onbrand.inspiration' as const;
export const INSPIRATION_SCHEMA_VERSION = 1 as const;

/** Fixed v1 limits; they are contract values, not caller-configurable hints. */
export const INSPIRATION_LIMITS = {
  maxJsonBytes: 131_072,
  maxMappings: 12,
  maxTargetsPerMapping: 4,
  maxTextLength: 240,
  maxUrlLength: 2_048,
  maxAssetPathLength: 240,
  maxAssetBytes: 5_000_000,
  maxAssetDimension: 8_192,
  maxDecodedPixels: 20_000_000,
  maxStandaloneHtmlBytes: 8_000_000,
} as const;

export const REVIEW_STATUSES = ['generated-draft', 'operator-reviewed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const SELECTION_SOURCES = ['deterministic', 'llm'] as const;
export type SelectionSource = (typeof SELECTION_SOURCES)[number];

export const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const UNOBSERVED_DEFAULTS = [
  'typography',
  'spacing',
  'radius',
  'shadow',
  'motion',
  'status',
] as const;
export type UnobservedDefault = (typeof UNOBSERVED_DEFAULTS)[number];

export const DEFAULT_DERIVED_ROLES = ['categorical', 'diagram'] as const;
export type DefaultDerivedRole = (typeof DEFAULT_DERIVED_ROLES)[number];

export const DEFAULT_DERIVED_REASON = 'no-qualifying-image-sample' as const;

export const MAPPING_PRESENTATIONS = [
  'surface',
  'text',
  'button-bg',
  'badge-bg',
  'chart-series',
  'swatch-only',
] as const satisfies readonly MappingPresentation[];

export const MAPPING_RELATIONSHIPS = [
  'sampled',
  'adjusted-for-contrast',
  'derived',
] as const satisfies readonly MappingRelationship[];

/**
 * The image synthesis table frozen in the feature plan.  A trace must account
 * for every one of these paths either with a selected sample mapping or an
 * explicit default-derived entry; renderers must never infer omitted slots.
 */
export const FROZEN_ASSIGNMENT_TABLE = [
  {
    selectedRole: 'primary',
    tokenPaths: ['color.chart.categorical.1', 'color.diagram.spine-accent'],
  },
  {
    selectedRole: 'secondary-1',
    tokenPaths: ['color.chart.categorical.2', 'color.diagram.node-stroke'],
  },
  {
    selectedRole: 'secondary-2',
    tokenPaths: ['color.chart.categorical.3', 'color.diagram.chip-highlight'],
  },
  {
    selectedRole: 'secondary-3',
    tokenPaths: ['color.chart.categorical.4', 'color.diagram.link'],
  },
  { selectedRole: 'secondary-4', tokenPaths: ['color.chart.categorical.5'] },
  { selectedRole: 'secondary-5', tokenPaths: ['color.chart.categorical.6'] },
  { selectedRole: 'secondary-6', tokenPaths: ['color.chart.categorical.7'] },
  { selectedRole: 'secondary-7', tokenPaths: ['color.chart.categorical.8'] },
] as const;

export const FROZEN_ASSIGNMENT_TARGETS = FROZEN_ASSIGNMENT_TABLE.flatMap((row) => row.tokenPaths);

export const PRIMARY_ANCHOR_TARGETS = [
  'color.primitive.brand.9',
  'color.semantic.accent',
] as const;
export const NEUTRAL_ANCHOR_TARGET = 'color.primitive.neutral.9' as const;

export interface InspirationAsset {
  /** Brand-relative, forward-slash path (v1 requires `assets/...`). */
  path: string;
  sha256: string;
  mediaType: ImageMediaType;
  alt: string;
  creator: string;
  title: string;
  date: string;
  sourceUrl: string | null;
  rights: string;
  licenseUrl: string | null;
  retrievedAt: string | null;
}

export interface InspirationSelection {
  sampleId: string;
  selectionSource: SelectionSource;
}

export interface InspirationDeterministicSelection {
  sampleId: string;
  selectionSource: 'deterministic';
}

export interface InspirationDefaultDerivedTarget {
  token: string;
  role: DefaultDerivedRole;
  reason: typeof DEFAULT_DERIVED_REASON;
}

export interface InspirationAnalysis {
  sourceKind: 'image';
  /**
   * The measured image algorithm.  The envelope schemaVersion is unchanged; the
   * already-versioned algorithm vocabulary intentionally expanded to
   * {image-cluster-v1, image-cluster-v2}, and stored v1 records stay valid.
   */
  algorithm: ImageClusterAlgorithm;
  basePreset: 'default';
  primary: InspirationSelection;
  neutral: InspirationDeterministicSelection | null;
  secondaries: InspirationDeterministicSelection[];
  unobservedDefaults: UnobservedDefault[];
  defaultDerivedColorTargets: InspirationDefaultDerivedTarget[];
}

export interface InspirationTarget {
  token: string;
  presentation: MappingPresentation;
  relationship: MappingRelationship;
  usage: string;
}

export interface InspirationMapping {
  id: string;
  label: string;
  region: PaletteRegion;
  sample: {
    hex: string;
    /** Must equal `analysis.algorithm` for the same trace. */
    method: ImageClusterAlgorithm;
    selectionSource: SelectionSource;
    pixelShare: number;
  };
  targets: InspirationTarget[];
  rationale: string;
  confidence: Confidence;
}

export interface InspirationTrace {
  schema: typeof INSPIRATION_SCHEMA;
  schemaVersion: typeof INSPIRATION_SCHEMA_VERSION;
  id: string;
  reviewStatus: ReviewStatus;
  summary: string;
  asset: InspirationAsset;
  analysis: InspirationAnalysis;
  mappings: InspirationMapping[];
}

export interface InspirationValidationIssue {
  /** JSON-style path such as `mappings[0].targets[0].token`. */
  path: string;
  message: string;
}

export interface InspirationValidationResult {
  ok: boolean;
  issues: InspirationValidationIssue[];
  trace?: InspirationTrace;
}

export class InspirationValidationError extends Error {
  readonly issues: InspirationValidationIssue[];

  constructor(issues: readonly InspirationValidationIssue[], context?: string) {
    const header = context
      ? `${context}: ${issues.length} inspiration validation issue(s)`
      : `${issues.length} inspiration validation issue(s)`;
    super(`${header}\n${issues.map(formatInspirationIssue).join('\n')}`);
    this.name = 'InspirationValidationError';
    this.issues = [...issues];
  }
}

/** Render one path-precise validation problem for human diagnostics. */
export function formatInspirationIssue(issue: InspirationValidationIssue): string {
  return `${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`;
}

/** The canonical generated source ID for an exact asset hash. */
export function inspirationIdForAssetSha256(sha256: string): string {
  return `image-${sha256.slice(0, 16)}`;
}

/** Closed v1 media-type predicate, useful to acquisition and loader code. */
export function isImageMediaType(value: unknown): value is ImageMediaType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp';
}

/** Strict canonical opaque sRGB sample/implemented value shape. */
export function isCanonicalHex(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 7 || value.charCodeAt(0) !== 35) return false;
  for (let i = 1; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const hex = (code >= 48 && code <= 57) || (code >= 97 && code <= 102);
    if (!hex) return false;
  }
  return true;
}

/**
 * Validate the complete JSON value.  This intentionally aggregates failures
 * so an operator can repair an edited trace in one pass; callers that need a
 * fail-loud gate should use `assertValidInspirationTrace`.
 */
export function validateInspirationTrace(value: unknown): InspirationValidationResult {
  const issues: InspirationValidationIssue[] = [];
  if (!isPlainObject(value)) {
    issues.push({ path: '', message: 'document must be a JSON object' });
    return { ok: false, issues };
  }

  rejectUnknownKeys(value, '', ['schema', 'schemaVersion', 'id', 'reviewStatus', 'summary', 'asset', 'analysis', 'mappings'], issues);
  validateLiteral(value['schema'], INSPIRATION_SCHEMA, 'schema', issues);
  validateLiteral(value['schemaVersion'], INSPIRATION_SCHEMA_VERSION, 'schemaVersion', issues);
  validateId(value['id'], 'id', issues, 'source');
  enumField(value['reviewStatus'], REVIEW_STATUSES, 'reviewStatus', issues);
  textField(value['summary'], 'summary', issues);

  validateAsset(value['asset'], issues);
  validateAnalysis(value['analysis'], issues);
  validateMappings(value['mappings'], issues);

  if (issues.length === 0) {
    // All validation routines above establish this exact JSON-only shape.
    const trace = value as unknown as InspirationTrace;
    validateCrossFieldInvariants(trace, issues);
    if (issues.length === 0) return { ok: true, issues, trace };
  }
  return { ok: false, issues };
}

/** Like validateInspirationTrace(), but throws a path-rich typed error. */
export function assertValidInspirationTrace(value: unknown, context?: string): InspirationTrace {
  const result = validateInspirationTrace(value);
  if (!result.ok || result.trace === undefined) {
    throw new InspirationValidationError(result.issues, context);
  }
  return result.trace;
}

/**
 * Asset paths are deliberately conservative: no absolute, drive, traversal,
 * backslash, control byte, or unsafe object-model segment can reach a loader.
 */
export function isCleanInspirationAssetPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > INSPIRATION_LIMITS.maxAssetPathLength) {
    return false;
  }
  if (!value.startsWith('assets/') || value.startsWith('/') || value.startsWith('\\')) return false;
  const first = value.charCodeAt(0);
  const alpha = (first >= 65 && first <= 90) || (first >= 97 && first <= 122);
  if (alpha && value.charCodeAt(1) === 58) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 127 || code === 92) return false;
  }
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..' && !isUnsafeName(segment));
}

function validateAsset(value: unknown, issues: InspirationValidationIssue[]): void {
  const at = 'asset';
  if (!isPlainObject(value)) {
    issues.push({ path: at, message: 'must be an object' });
    return;
  }
  rejectUnknownKeys(
    value,
    at,
    ['path', 'sha256', 'mediaType', 'alt', 'creator', 'title', 'date', 'sourceUrl', 'rights', 'licenseUrl', 'retrievedAt'],
    issues,
  );
  if (!isCleanInspirationAssetPath(value['path'])) {
    issues.push({ path: `${at}.path`, message: 'must be a clean brand-relative assets/... forward-slash path' });
  }
  sha256Field(value['sha256'], `${at}.sha256`, issues);
  if (!isImageMediaType(value['mediaType'])) {
    issues.push({ path: `${at}.mediaType`, message: 'must be image/png, image/jpeg, or image/webp' });
  }
  for (const key of ['alt', 'creator', 'title', 'date', 'rights'] as const) textField(value[key], `${at}.${key}`, issues);
  nullableHttpsUrl(value['sourceUrl'], `${at}.sourceUrl`, issues);
  nullableHttpsUrl(value['licenseUrl'], `${at}.licenseUrl`, issues);
  const retrievedAt = value['retrievedAt'];
  if (retrievedAt !== null && (typeof retrievedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(retrievedAt))) {
    issues.push({ path: `${at}.retrievedAt`, message: 'must be null or a YYYY-MM-DD date' });
  }
}

function validateAnalysis(value: unknown, issues: InspirationValidationIssue[]): void {
  const at = 'analysis';
  if (!isPlainObject(value)) {
    issues.push({ path: at, message: 'must be an object' });
    return;
  }
  rejectUnknownKeys(
    value,
    at,
    ['sourceKind', 'algorithm', 'basePreset', 'primary', 'neutral', 'secondaries', 'unobservedDefaults', 'defaultDerivedColorTargets'],
    issues,
  );
  validateLiteral(value['sourceKind'], 'image', `${at}.sourceKind`, issues);
  enumField(value['algorithm'], SUPPORTED_IMAGE_CLUSTER_ALGORITHMS, `${at}.algorithm`, issues);
  validateLiteral(value['basePreset'], 'default', `${at}.basePreset`, issues);
  validateSelection(value['primary'], `${at}.primary`, issues, true);
  const neutral = value['neutral'];
  if (neutral !== null) validateSelection(neutral, `${at}.neutral`, issues, false);

  const secondaries = value['secondaries'];
  if (!Array.isArray(secondaries)) {
    issues.push({ path: `${at}.secondaries`, message: 'must be an array' });
  } else {
    if (secondaries.length > 7) issues.push({ path: `${at}.secondaries`, message: 'must contain at most 7 selections' });
    secondaries.forEach((entry, index) => validateSelection(entry, `${at}.secondaries[${index}]`, issues, false));
  }

  const defaults = value['unobservedDefaults'];
  if (!Array.isArray(defaults)) {
    issues.push({ path: `${at}.unobservedDefaults`, message: 'must be an array' });
  } else {
    validateUniqueEnumArray(defaults, UNOBSERVED_DEFAULTS, `${at}.unobservedDefaults`, issues);
  }

  const derived = value['defaultDerivedColorTargets'];
  if (!Array.isArray(derived)) {
    issues.push({ path: `${at}.defaultDerivedColorTargets`, message: 'must be an array' });
  } else {
    if (derived.length > FROZEN_ASSIGNMENT_TARGETS.length) {
      issues.push({ path: `${at}.defaultDerivedColorTargets`, message: `must contain at most ${FROZEN_ASSIGNMENT_TARGETS.length} entries` });
    }
    derived.forEach((entry, index) => validateDefaultDerivedTarget(entry, `${at}.defaultDerivedColorTargets[${index}]`, issues));
  }
}

function validateSelection(value: unknown, at: string, issues: InspirationValidationIssue[], primary: boolean): void {
  if (!isPlainObject(value)) {
    issues.push({ path: at, message: 'must be an object' });
    return;
  }
  rejectUnknownKeys(value, at, ['sampleId', 'selectionSource'], issues);
  validateSampleId(value['sampleId'], `${at}.sampleId`, issues);
  if (primary) enumField(value['selectionSource'], SELECTION_SOURCES, `${at}.selectionSource`, issues);
  else validateLiteral(value['selectionSource'], 'deterministic', `${at}.selectionSource`, issues);
}

function validateDefaultDerivedTarget(value: unknown, at: string, issues: InspirationValidationIssue[]): void {
  if (!isPlainObject(value)) {
    issues.push({ path: at, message: 'must be an object' });
    return;
  }
  rejectUnknownKeys(value, at, ['token', 'role', 'reason'], issues);
  tokenPathField(value['token'], `${at}.token`, issues);
  enumField(value['role'], DEFAULT_DERIVED_ROLES, `${at}.role`, issues);
  validateLiteral(value['reason'], DEFAULT_DERIVED_REASON, `${at}.reason`, issues);
}

function validateMappings(value: unknown, issues: InspirationValidationIssue[]): void {
  const at = 'mappings';
  if (!Array.isArray(value)) {
    issues.push({ path: at, message: 'must be an array' });
    return;
  }
  if (value.length === 0) issues.push({ path: at, message: 'must contain at least one selected sample mapping' });
  if (value.length > INSPIRATION_LIMITS.maxMappings) {
    issues.push({ path: at, message: `must contain at most ${INSPIRATION_LIMITS.maxMappings} mappings` });
  }
  value.forEach((mapping, index) => validateMapping(mapping, `${at}[${index}]`, issues));
}

function validateMapping(value: unknown, at: string, issues: InspirationValidationIssue[]): void {
  if (!isPlainObject(value)) {
    issues.push({ path: at, message: 'must be an object' });
    return;
  }
  rejectUnknownKeys(value, at, ['id', 'label', 'region', 'sample', 'targets', 'rationale', 'confidence'], issues);
  validateSampleId(value['id'], `${at}.id`, issues);
  textField(value['label'], `${at}.label`, issues);
  validateRegion(value['region'], `${at}.region`, issues);
  validateSample(value['sample'], `${at}.sample`, issues);
  textField(value['rationale'], `${at}.rationale`, issues);
  enumField(value['confidence'], CONFIDENCE_LEVELS, `${at}.confidence`, issues);

  const targets = value['targets'];
  if (!Array.isArray(targets)) {
    issues.push({ path: `${at}.targets`, message: 'must be an array' });
  } else {
    if (targets.length === 0) issues.push({ path: `${at}.targets`, message: 'must contain at least one token target' });
    if (targets.length > INSPIRATION_LIMITS.maxTargetsPerMapping) {
      issues.push({ path: `${at}.targets`, message: `must contain at most ${INSPIRATION_LIMITS.maxTargetsPerMapping} targets` });
    }
    targets.forEach((target, index) => validateTarget(target, `${at}.targets[${index}]`, issues));
  }
}

function validateRegion(value: unknown, at: string, issues: InspirationValidationIssue[]): void {
  if (!isPlainObject(value)) {
    issues.push({ path: at, message: 'must be an object' });
    return;
  }
  rejectUnknownKeys(value, at, ['x', 'y', 'width', 'height'], issues);
  const x = value['x'];
  const y = value['y'];
  const width = value['width'];
  const height = value['height'];
  for (const [name, number] of [['x', x], ['y', y], ['width', width], ['height', height]] as const) {
    if (typeof number !== 'number' || !Number.isFinite(number)) {
      issues.push({ path: `${at}.${name}`, message: 'must be a finite number' });
    }
  }
  if (typeof x === 'number' && (x < 0 || x > 1)) issues.push({ path: `${at}.x`, message: 'must be in [0, 1]' });
  if (typeof y === 'number' && (y < 0 || y > 1)) issues.push({ path: `${at}.y`, message: 'must be in [0, 1]' });
  if (typeof width === 'number' && (width <= 0 || width > 1)) issues.push({ path: `${at}.width`, message: 'must be in (0, 1]' });
  if (typeof height === 'number' && (height <= 0 || height > 1)) issues.push({ path: `${at}.height`, message: 'must be in (0, 1]' });
  if (
    typeof x === 'number' && typeof y === 'number' && typeof width === 'number' && typeof height === 'number' &&
    Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height) &&
    (x + width > 1 || y + height > 1)
  ) {
    issues.push({ path: at, message: 'rectangle must stay inside normalized image bounds' });
  }
}

function validateSample(value: unknown, at: string, issues: InspirationValidationIssue[]): void {
  if (!isPlainObject(value)) {
    issues.push({ path: at, message: 'must be an object' });
    return;
  }
  rejectUnknownKeys(value, at, ['hex', 'method', 'selectionSource', 'pixelShare'], issues);
  if (!isCanonicalHex(value['hex'])) {
    issues.push({ path: `${at}.hex`, message: 'must be a lowercase opaque #rrggbb value' });
  }
  enumField(value['method'], SUPPORTED_IMAGE_CLUSTER_ALGORITHMS, `${at}.method`, issues);
  enumField(value['selectionSource'], SELECTION_SOURCES, `${at}.selectionSource`, issues);
  const pixelShare = value['pixelShare'];
  if (typeof pixelShare !== 'number' || !Number.isFinite(pixelShare) || pixelShare <= 0 || pixelShare > 1) {
    issues.push({ path: `${at}.pixelShare`, message: 'must be a finite number in (0, 1]' });
  }
}

function validateTarget(value: unknown, at: string, issues: InspirationValidationIssue[]): void {
  if (!isPlainObject(value)) {
    issues.push({ path: at, message: 'must be an object' });
    return;
  }
  rejectUnknownKeys(value, at, ['token', 'presentation', 'relationship', 'usage'], issues);
  tokenPathField(value['token'], `${at}.token`, issues);
  enumField(value['presentation'], MAPPING_PRESENTATIONS, `${at}.presentation`, issues);
  enumField(value['relationship'], MAPPING_RELATIONSHIPS, `${at}.relationship`, issues);
  textField(value['usage'], `${at}.usage`, issues);
}

function validateCrossFieldInvariants(trace: InspirationTrace, issues: InspirationValidationIssue[]): void {
  // A mapping may never claim a different measurement than the analysis it
  // belongs to: mixed-algorithm evidence is not reproducible from one source.
  trace.mappings.forEach((mapping, index) => {
    if (mapping.sample.method !== trace.analysis.algorithm) {
      issues.push({
        path: `mappings[${index}].sample.method`,
        message: `must equal ${JSON.stringify(trace.analysis.algorithm)} (analysis.algorithm)`,
      });
    }
  });

  if (trace.id !== inspirationIdForAssetSha256(trace.asset.sha256)) {
    issues.push({ path: 'id', message: `must equal ${JSON.stringify(inspirationIdForAssetSha256(trace.asset.sha256))} for asset.sha256` });
  }

  const expectedExts = extensionsForMediaType(trace.asset.mediaType);
  if (!expectedExts.some((extension) => trace.asset.path.toLowerCase().endsWith(extension))) {
    issues.push({ path: 'asset.path', message: `must end in ${expectedExts.join(' or ')} for ${trace.asset.mediaType}` });
  }

  const selected = [
    trace.analysis.primary,
    ...(trace.analysis.neutral === null ? [] : [trace.analysis.neutral]),
    ...trace.analysis.secondaries,
  ];
  const seenSelections = new Set<string>();
  selected.forEach((selection, index) => {
    if (seenSelections.has(selection.sampleId)) {
      issues.push({ path: index === 0 ? 'analysis.primary.sampleId' : 'analysis', message: `selected sample ID ${JSON.stringify(selection.sampleId)} is duplicated` });
    }
    seenSelections.add(selection.sampleId);
  });

  const mappingsById = new Map<string, InspirationMapping>();
  trace.mappings.forEach((mapping, index) => {
    if (mappingsById.has(mapping.id)) issues.push({ path: `mappings[${index}].id`, message: `duplicate mapping ID ${JSON.stringify(mapping.id)}` });
    mappingsById.set(mapping.id, mapping);
  });
  for (const sampleId of seenSelections) {
    if (!mappingsById.has(sampleId)) {
      issues.push({ path: 'mappings', message: `selected sample ${JSON.stringify(sampleId)} must have a mapping` });
    }
  }
  for (const mapping of trace.mappings) {
    if (!seenSelections.has(mapping.id)) {
      issues.push({ path: `mappings[${trace.mappings.indexOf(mapping)}].id`, message: 'mapping must refer to a selected primary, neutral, or secondary sample' });
    }
  }

  const selectionRows: Array<readonly [string, SelectionSource]> = [
    [trace.analysis.primary.sampleId, trace.analysis.primary.selectionSource],
    ...(trace.analysis.neutral === null
      ? []
      : [[trace.analysis.neutral.sampleId, 'deterministic'] as const]),
    ...trace.analysis.secondaries.map(
      (secondary): readonly [string, SelectionSource] => [secondary.sampleId, 'deterministic'],
    ),
  ];
  const expectedSelectionSource = new Map<string, SelectionSource>(selectionRows);
  for (const mapping of trace.mappings) {
    const expected = expectedSelectionSource.get(mapping.id);
    if (expected !== undefined && mapping.sample.selectionSource !== expected) {
      issues.push({ path: `mappings[${trace.mappings.indexOf(mapping)}].sample.selectionSource`, message: 'must match the analysis selection provenance for this sample' });
    }
  }

  const targets = new Map<string, string>();
  trace.mappings.forEach((mapping, mappingIndex) => {
    mapping.targets.forEach((target, targetIndex) => {
      const previous = targets.get(target.token);
      const here = `mappings[${mappingIndex}].targets[${targetIndex}].token`;
      if (previous !== undefined) issues.push({ path: here, message: `duplicate target ${JSON.stringify(target.token)} (also ${previous})` });
      else targets.set(target.token, here);
    });
  });

  const derived = new Map<string, InspirationDefaultDerivedTarget>();
  trace.analysis.defaultDerivedColorTargets.forEach((entry, index) => {
    if (derived.has(entry.token)) {
      issues.push({ path: `analysis.defaultDerivedColorTargets[${index}].token`, message: `duplicate default-derived target ${JSON.stringify(entry.token)}` });
    }
    derived.set(entry.token, entry);
    if (targets.has(entry.token)) {
      issues.push({ path: `analysis.defaultDerivedColorTargets[${index}].token`, message: 'must not overlap a mapped token target' });
    }
    const expectedRole = defaultDerivedRoleForTarget(entry.token);
    if (expectedRole === undefined) {
      issues.push({ path: `analysis.defaultDerivedColorTargets[${index}].token`, message: 'must be a frozen categorical or diagram assignment target' });
    } else if (entry.role !== expectedRole) {
      issues.push({ path: `analysis.defaultDerivedColorTargets[${index}].role`, message: `must be ${JSON.stringify(expectedRole)} for ${entry.token}` });
    }
  });

  for (const target of FROZEN_ASSIGNMENT_TARGETS) {
    if (!targets.has(target) && !derived.has(target)) {
      issues.push({ path: 'analysis.defaultDerivedColorTargets', message: `missing explicit mapped/default-derived coverage for ${target}` });
    }
  }

  const selectedRoleById = new Map<string, number>([
    [trace.analysis.primary.sampleId, 0],
    ...trace.analysis.secondaries.map((secondary, index) => [secondary.sampleId, index + 1] as const),
  ]);
  trace.mappings.forEach((mapping, mappingIndex) => {
    const roleIndex = selectedRoleById.get(mapping.id);
    for (const target of mapping.targets) {
      const targetRow = FROZEN_ASSIGNMENT_TABLE.findIndex((row) =>
        (row.tokenPaths as readonly string[]).includes(target.token),
      );
      if (targetRow >= 0 && targetRow !== roleIndex) {
        issues.push({
          path: `mappings[${mappingIndex}].targets`,
          message: `${target.token} is assigned only to ${FROZEN_ASSIGNMENT_TABLE[targetRow]!.selectedRole}`,
        });
      }
      if ((PRIMARY_ANCHOR_TARGETS as readonly string[]).includes(target.token) && mapping.id !== trace.analysis.primary.sampleId) {
        issues.push({ path: `mappings[${mappingIndex}].targets`, message: `${target.token} is a primary-only anchor target` });
      }
      if (target.token === NEUTRAL_ANCHOR_TARGET && mapping.id !== trace.analysis.neutral?.sampleId) {
        issues.push({ path: `mappings[${mappingIndex}].targets`, message: `${target.token} is a neutral-only anchor target` });
      }
    }
  });

  requireTargetsForMapping(
    mappingsById.get(trace.analysis.primary.sampleId),
    [...FROZEN_ASSIGNMENT_TABLE[0].tokenPaths, ...PRIMARY_ANCHOR_TARGETS],
    'analysis.primary',
    issues,
  );
  if (trace.analysis.neutral !== null) {
    requireTargetsForMapping(mappingsById.get(trace.analysis.neutral.sampleId), [NEUTRAL_ANCHOR_TARGET], 'analysis.neutral', issues);
  }
  trace.analysis.secondaries.forEach((secondary, index) => {
    const row = FROZEN_ASSIGNMENT_TABLE[index + 1];
    if (row !== undefined) requireTargetsForMapping(mappingsById.get(secondary.sampleId), row.tokenPaths, `analysis.secondaries[${index}]`, issues);
  });

  const defaults = trace.analysis.unobservedDefaults;
  if (defaults.length !== UNOBSERVED_DEFAULTS.length || !UNOBSERVED_DEFAULTS.every((name) => defaults.includes(name))) {
    issues.push({ path: 'analysis.unobservedDefaults', message: 'image traces must explicitly declare typography, spacing, radius, shadow, motion, and status as unobserved defaults' });
  }
}

function requireTargetsForMapping(
  mapping: InspirationMapping | undefined,
  required: readonly string[],
  at: string,
  issues: InspirationValidationIssue[],
): void {
  if (mapping === undefined) return;
  const actual = new Set(mapping.targets.map((target) => target.token));
  for (const target of required) {
    if (!actual.has(target)) issues.push({ path: at, message: `selected sample mapping must include ${target}` });
  }
}

function defaultDerivedRoleForTarget(token: string): DefaultDerivedRole | undefined {
  if (token.startsWith('color.chart.categorical.')) return 'categorical';
  if (token.startsWith('color.diagram.')) return 'diagram';
  return undefined;
}

function extensionsForMediaType(mediaType: ImageMediaType): readonly string[] {
  if (mediaType === 'image/png') return ['.png'];
  if (mediaType === 'image/jpeg') return ['.jpg', '.jpeg'];
  return ['.webp'];
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  at: string,
  allowed: readonly string[],
  issues: InspirationValidationIssue[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.push({ path: at === '' ? key : `${at}.${key}`, message: `unknown key (allowed: ${allowed.join(', ')})` });
    }
  }
}

function validateLiteral(value: unknown, literal: string | number, at: string, issues: InspirationValidationIssue[]): void {
  if (value !== literal) issues.push({ path: at, message: `must equal ${JSON.stringify(literal)}` });
}

function enumField<T extends string>(value: unknown, values: readonly T[], at: string, issues: InspirationValidationIssue[]): void {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    issues.push({ path: at, message: `must be one of ${values.map((entry) => JSON.stringify(entry)).join(', ')}` });
  }
}

function validateUniqueEnumArray<T extends string>(
  value: unknown[],
  values: readonly T[],
  at: string,
  issues: InspirationValidationIssue[],
): void {
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || !values.includes(entry as T)) {
      issues.push({ path: `${at}[${index}]`, message: `must be one of ${values.map((item) => JSON.stringify(item)).join(', ')}` });
      return;
    }
    if (seen.has(entry)) issues.push({ path: `${at}[${index}]`, message: `duplicate value ${JSON.stringify(entry)}` });
    seen.add(entry);
  });
}

function validateId(value: unknown, at: string, issues: InspirationValidationIssue[], kind: 'source' | 'sample'): void {
  if (typeof value !== 'string' || !isRouteSafeId(value)) {
    const expected = kind === 'source' ? 'image- plus 16 lowercase hex characters' : 'sample-01 through sample-12';
    issues.push({ path: at, message: `must be a route-safe ${expected}` });
  }
}

function validateSampleId(value: unknown, at: string, issues: InspirationValidationIssue[]): void {
  if (typeof value !== 'string' || !/^sample-(?:0[1-9]|1[0-2])$/.test(value)) {
    issues.push({ path: at, message: 'must be a deterministic sample-01 through sample-12 ID' });
  }
}

function isRouteSafeId(value: string): boolean {
  return /^image-[0-9a-f]{16}$/.test(value);
}

function sha256Field(value: unknown, at: string, issues: InspirationValidationIssue[]): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    issues.push({ path: at, message: 'must be a lowercase 64-character SHA-256 hexadecimal digest' });
  }
}

function tokenPathField(value: unknown, at: string, issues: InspirationValidationIssue[]): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 160 || !isCleanTokenPath(value)) {
    issues.push({ path: at, message: 'must be a clean dot-separated token path' });
  }
}

function isCleanTokenPath(value: string): boolean {
  const segments = value.split('.');
  if (segments.length < 2 || !value.startsWith('color.')) return false;
  return segments.every((segment) => {
    if (segment.length === 0 || isUnsafeName(segment)) return false;
    for (let i = 0; i < segment.length; i++) {
      const code = segment.charCodeAt(i);
      const alpha = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
      const digit = code >= 48 && code <= 57;
      if (!alpha && !digit && code !== 45 && code !== 95) return false;
    }
    return true;
  });
}

function textField(value: unknown, at: string, issues: InspirationValidationIssue[]): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > INSPIRATION_LIMITS.maxTextLength || hasControlCharacter(value)) {
    issues.push({ path: at, message: `must be non-empty, control-character-free text of at most ${INSPIRATION_LIMITS.maxTextLength} characters` });
  }
}

function nullableHttpsUrl(value: unknown, at: string, issues: InspirationValidationIssue[]): void {
  if (value === null) return;
  if (typeof value !== 'string' || value.length === 0 || value.length > INSPIRATION_LIMITS.maxUrlLength || hasControlCharacter(value)) {
    issues.push({ path: at, message: `must be null or an absolute https URL of at most ${INSPIRATION_LIMITS.maxUrlLength} characters` });
    return;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hostname === '') {
      issues.push({ path: at, message: 'must be an absolute https URL without credentials' });
    }
  } catch {
    issues.push({ path: at, message: 'must be an absolute https URL without credentials' });
  }
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 127) return true;
  }
  return false;
}
