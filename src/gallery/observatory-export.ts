/**
 * Versioned, bounded JSON export for dev-observatory (Step 21).
 *
 * This module is deliberately a FILE-FORMAT seam. It discovers and checks
 * brands using on-brand's own production modules, then writes one JSON file.
 * It never imports, invokes, or otherwise depends on dev-observatory; that
 * project owns registry wiring, routes, labels, and presentation.
 *
 * The artifact contains only workspace-relative paths. It does not rebuild
 * consumers: discovery and check are read-only, and the sole write is the
 * caller-selected artifact itself.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { runCheck } from '../check/run.ts';
import type { CheckFinding, FindingEvidence } from '../check/finding.ts';
import {
  discoverBrands,
  type BrandProvenance,
  type BrandStatus,
  type DiscoveredBrand,
} from './discover.ts';

/** Stable identifier consumed by bounded artifact readers. */
export const OBSERVATORY_ARTIFACT_SCHEMA = 'onbrand.observatory';
/** Increment only for backwards-incompatible changes to this document. */
export const OBSERVATORY_ARTIFACT_SCHEMA_VERSION = 1;
/** Default artifact name written at the explicit workspace root. */
export const DEFAULT_OBSERVATORY_ARTIFACT_FILENAME = 'onbrand-observatory.json';

/** Hard output caps: readers never receive an unbounded workspace dump. */
export const MAX_OBSERVATORY_BRANDS = 50;
export const MAX_OBSERVATORY_FINDINGS_PER_BRAND = 12;
export const MAX_OBSERVATORY_TOKEN_GROUPS_PER_BRAND = 16;
export const MAX_OBSERVATORY_EVIDENCE_FIELDS = 12;
export const MAX_OBSERVATORY_TEXT_LENGTH = 160;
export const MAX_OBSERVATORY_ARTIFACT_BYTES = 1_000_000;

export interface ObservatoryFinding {
  severity: CheckFinding['severity'];
  category: CheckFinding['category'];
  code: CheckFinding['code'];
  message: string;
  evidence: FindingEvidence;
  evidenceTruncated: boolean;
  nextCommand: string;
  path?: string;
}

export interface ObservatoryCheckAvailable {
  state: 'available';
  ok: boolean;
  errorCount: number;
  warningCount: number;
  advisoryCount: number;
  findingCount: number;
  findingsTruncated: boolean;
  findings: ObservatoryFinding[];
}

export interface ObservatoryCheckUnavailable {
  state: 'unavailable';
  reason: string;
}

export type ObservatoryCheck = ObservatoryCheckAvailable | ObservatoryCheckUnavailable;

export interface ObservatoryBrand {
  /** Stable detail key: the root path relative to the scanned workspace. */
  id: string;
  name: string;
  relPath: string;
  status: BrandStatus;
  provenance: BrandProvenance;
  /** True only when discovery classified this as a current adopted brand. */
  final: boolean;
  hasTokens: boolean;
  hasDist: boolean;
  incompleteMarker: boolean;
  darkMode: boolean;
  tokenGroups: string[];
  tokenGroupsTruncated: boolean;
  reason: string;
  specimenPath?: string;
  error?: string;
  check: ObservatoryCheck;
}

export interface ObservatoryStatusCounts {
  adopted: number;
  proposal: number;
  incomplete: number;
  stale: number;
  invalid: number;
}

export interface ObservatoryArtifact {
  schema: typeof OBSERVATORY_ARTIFACT_SCHEMA;
  schemaVersion: typeof OBSERVATORY_ARTIFACT_SCHEMA_VERSION;
  /** Timestamp for freshness display; not a claim that brand dist was rebuilt. */
  generatedAt: string;
  /** Fixed producer-side bounds applied before serializing the document. */
  limits: {
    maxBrands: number;
    maxFindingsPerBrand: number;
    maxTokenGroupsPerBrand: number;
    maxEvidenceFields: number;
    maxTextLength: number;
    maxBytes: number;
  };
  summary: {
    discoveredBrandCount: number;
    emittedBrandCount: number;
    brandsTruncated: boolean;
    finalCount: number;
    proposalCount: number;
    statusCounts: ObservatoryStatusCounts;
  };
  brands: ObservatoryBrand[];
}

export interface BuildObservatoryArtifactOptions {
  /** Explicit workspace root; passed through to bounded Step-17 discovery. */
  root: string;
  /** Test seam for deterministic artifacts. */
  now?: () => Date;
  /** Test seam for resolution of token extends chains. */
  presetsRoot?: string;
}

export interface ExportObservatoryArtifactOptions extends BuildObservatoryArtifactOptions {
  /** Output path; default is <root>/onbrand-observatory.json. */
  out?: string;
}

export interface ExportObservatoryArtifactResult {
  outPath: string;
  artifact: ObservatoryArtifact;
  bytes: number;
}

/** Return a string short enough for a bounded artifact while preserving the fact it was shortened. */
function boundedText(value: string): string {
  if (value.length <= MAX_OBSERVATORY_TEXT_LENGTH) return value;
  return `${value.slice(0, MAX_OBSERVATORY_TEXT_LENGTH - 1)}…`;
}

/** Escape a literal string for safe use in a case-insensitive replacement regex. */
function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Keep useful token/error text while replacing the machine-specific workspace
 * root. Discovery errors normally quote absolute source paths, which must not
 * cross the portable artifact boundary.
 */
function portableDiagnostic(value: string, workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot);
  const variants = new Set([root, root.replaceAll('\\', '/'), root.replaceAll('/', '\\')]);
  let portable = value;
  for (const variant of variants) {
    portable = portable.replace(new RegExp(regexEscape(variant), 'gi'), '<workspace>');
  }
  // Resolver errors can name an external extends target. The artifact has no
  // business disclosing any host filesystem location, not only its workspace.
  // Keep surrounding diagnostic context while replacing Windows, file-URL,
  // and POSIX absolute path tokens.
  portable = portable
    .replace(/file:\/\/\/[^\s"'`()[\]{}<>]+/gi, '<path>')
    .replace(/[a-z]:[\\/][^\s"'`()[\]{}<>]*/gi, '<path>')
    .replace(/(^|[\s("'])\/(?:[^\s"'`()[\]{}<>]*)/g, '$1<path>');
  return boundedText(portable);
}

function boundedEvidence(evidence: FindingEvidence): {
  evidence: FindingEvidence;
  evidenceTruncated: boolean;
} {
  const entries = Object.entries(evidence).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const selected = entries.slice(0, MAX_OBSERVATORY_EVIDENCE_FIELDS);
  return {
    evidence: Object.fromEntries(
      selected.map(([key, value]) => [boundedText(key), typeof value === 'string' ? boundedText(value) : value]),
    ),
    evidenceTruncated: selected.length !== entries.length,
  };
}

function exportFinding(finding: CheckFinding): ObservatoryFinding {
  const bounded = boundedEvidence(finding.evidence);
  return {
    severity: finding.severity,
    category: finding.category,
    code: finding.code,
    message: boundedText(finding.message),
    evidence: bounded.evidence,
    evidenceTruncated: bounded.evidenceTruncated,
    nextCommand: boundedText(finding.nextCommand),
    ...(finding.path !== undefined ? { path: finding.path } : {}),
  };
}

/** Read only the top-level token-group names from a discovered brand. */
function tokenGroups(brandDir: string): { groups: string[]; truncated: boolean } {
  try {
    const parsed = JSON.parse(readFileSync(path.join(brandDir, 'tokens.json'), 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { groups: [], truncated: false };
    }
    const groups = Object.keys(parsed)
      .filter((key) => !key.startsWith('$'))
      .sort();
    return {
      groups: groups.slice(0, MAX_OBSERVATORY_TOKEN_GROUPS_PER_BRAND),
      truncated: groups.length > MAX_OBSERVATORY_TOKEN_GROUPS_PER_BRAND,
    };
  } catch {
    return { groups: [], truncated: false };
  }
}

function darkModeAvailable(brandDir: string): boolean {
  try {
    const entry = lstatSync(path.join(brandDir, 'modes.dark.json'));
    return entry.isFile() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Workspace-relative specimen path only when a built file exists. */
function specimenPath(brand: DiscoveredBrand): string | undefined {
  try {
    const distEntry = lstatSync(path.join(brand.brandDir, 'dist'));
    if (!distEntry.isDirectory() || distEntry.isSymbolicLink()) return undefined;
    const entry = lstatSync(path.join(brand.brandDir, 'dist', 'specimen.html'));
    if (!entry.isFile() || entry.isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }
  const prefix = brand.relPath === '.' ? [] : brand.relPath.split('/');
  return [...prefix, 'brand', 'dist', 'specimen.html'].join('/');
}

/** Opaque, deterministic, bounded detail key; relPath remains the real locator. */
function brandId(relPath: string): string {
  return `brand-${createHash('sha256').update(relPath).digest('hex').slice(0, 24)}`;
}

function checkForArtifact(
  brand: DiscoveredBrand,
  workspaceRoot: string,
  presetsRoot?: string,
): ObservatoryCheck {
  if (brand.status === 'invalid') {
    return { state: 'unavailable', reason: 'brand sources do not load; see the brand error field' };
  }
  try {
    const report = runCheck(brand.root, {
      ...(presetsRoot !== undefined ? { presetsRoot } : {}),
    });
    const findings = report.findings.map(exportFinding);
    return {
      state: 'available',
      ok: report.ok,
      errorCount: report.errorCount,
      warningCount: report.warningCount,
      advisoryCount: report.advisoryCount,
      findingCount: findings.length,
      findingsTruncated: findings.length > MAX_OBSERVATORY_FINDINGS_PER_BRAND,
      findings: findings.slice(0, MAX_OBSERVATORY_FINDINGS_PER_BRAND),
    };
  } catch (cause) {
    return {
      state: 'unavailable',
      reason: portableDiagnostic(cause instanceof Error ? cause.message : String(cause), workspaceRoot),
    };
  }
}

function statusCounts(brands: readonly DiscoveredBrand[]): ObservatoryStatusCounts {
  const counts: ObservatoryStatusCounts = {
    adopted: 0,
    proposal: 0,
    incomplete: 0,
    stale: 0,
    invalid: 0,
  };
  for (const brand of brands) counts[brand.status]++;
  return counts;
}

function exportBrand(
  brand: DiscoveredBrand,
  workspaceRoot: string,
  presetsRoot?: string,
): ObservatoryBrand {
  const groups = tokenGroups(brand.brandDir);
  const specimen = specimenPath(brand);
  return {
    id: brandId(brand.relPath),
    name: boundedText(brand.name),
    relPath: brand.relPath,
    status: brand.status,
    provenance: brand.provenance,
    final: brand.final,
    hasTokens: brand.hasTokens,
    hasDist: brand.hasDist,
    incompleteMarker: brand.incompleteMarker,
    darkMode: darkModeAvailable(brand.brandDir),
    tokenGroups: groups.groups,
    tokenGroupsTruncated: groups.truncated,
    reason: portableDiagnostic(brand.reason, workspaceRoot),
    ...(specimen !== undefined ? { specimenPath: specimen } : {}),
    ...(brand.error !== undefined
      ? { error: portableDiagnostic(brand.error, workspaceRoot) }
      : {}),
    check: checkForArtifact(brand, workspaceRoot, presetsRoot),
  };
}

/**
 * Build the whole portable document in memory. It reads workspace data but
 * performs no writes, so callers/tests can inspect or serialize it directly.
 */
export function buildObservatoryArtifact(
  options: BuildObservatoryArtifactOptions,
): ObservatoryArtifact {
  const result = discoverBrands(options.root, {
    ...(options.presetsRoot !== undefined ? { presetsRoot: options.presetsRoot } : {}),
  });
  const allBrands = result.brands;
  const emitted = allBrands.slice(0, MAX_OBSERVATORY_BRANDS);
  const counts = statusCounts(allBrands);

  return {
    schema: OBSERVATORY_ARTIFACT_SCHEMA,
    schemaVersion: OBSERVATORY_ARTIFACT_SCHEMA_VERSION,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    limits: {
      maxBrands: MAX_OBSERVATORY_BRANDS,
      maxFindingsPerBrand: MAX_OBSERVATORY_FINDINGS_PER_BRAND,
      maxTokenGroupsPerBrand: MAX_OBSERVATORY_TOKEN_GROUPS_PER_BRAND,
      maxEvidenceFields: MAX_OBSERVATORY_EVIDENCE_FIELDS,
      maxTextLength: MAX_OBSERVATORY_TEXT_LENGTH,
      maxBytes: MAX_OBSERVATORY_ARTIFACT_BYTES,
    },
    summary: {
      discoveredBrandCount: allBrands.length,
      emittedBrandCount: emitted.length,
      brandsTruncated: emitted.length !== allBrands.length,
      finalCount: allBrands.filter((brand) => brand.final).length,
      proposalCount: allBrands.filter((brand) => brand.provenance === 'proposal').length,
      statusCounts: counts,
    },
    brands: emitted.map((brand) => exportBrand(brand, result.root, options.presetsRoot)),
  };
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Nearest existing parent, used to detect a symlink escape before mkdir writes. */
function nearestExistingParent(candidate: string): string {
  let current = candidate;
  while (!existsSync(current)) {
    const next = path.dirname(current);
    if (next === current) throw new Error(`could not find an existing parent for ${candidate}`);
    current = next;
  }
  return current;
}

/** Reject existing linked/non-directory ancestors before an output write. */
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
        throw new Error('artifact --out must not traverse linked or non-directory ancestors');
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw cause;
    }
  }
}

/**
 * Resolve a safe artifact target. Relative --out values are workspace-relative;
 * artifacts cannot escape that root or overwrite anything in a brand/ payload.
 */
function resolveArtifactOutput(root: string, out: string | undefined): string {
  const resolvedRoot = path.resolve(root);
  const outPath =
    out === undefined
      ? path.join(resolvedRoot, DEFAULT_OBSERVATORY_ARTIFACT_FILENAME)
      : path.isAbsolute(out)
        ? path.resolve(out)
        : path.resolve(resolvedRoot, out);
  if (!isInside(resolvedRoot, outPath)) {
    throw new Error('artifact --out must resolve inside the explicit workspace root');
  }

  const relativeSegments = path.relative(resolvedRoot, outPath).split(path.sep);
  if (relativeSegments.some((segment) => segment.toLowerCase() === 'brand')) {
    throw new Error('artifact --out must not be inside a brand/ source or dist directory');
  }

  assertSafeOutputAncestors(resolvedRoot, outPath);

  const realRoot = realpathSync(resolvedRoot);
  const existingParent = nearestExistingParent(path.dirname(outPath));
  if (!isInside(realRoot, realpathSync(existingParent))) {
    throw new Error('artifact --out parent resolves outside the explicit workspace root');
  }
  try {
    const existing = lstatSync(outPath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error('artifact --out must name a regular file, not a symlink or directory');
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
  return outPath;
}

function serializeArtifact(artifact: ObservatoryArtifact): string {
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_OBSERVATORY_ARTIFACT_BYTES) {
    throw new Error(
      `observatory artifact is ${bytes} bytes, over the ${MAX_OBSERVATORY_ARTIFACT_BYTES}-byte limit; reduce the workspace scope before exporting`,
    );
  }
  return json;
}

/**
 * Create a bounded artifact with stage-then-rename semantics. A write failure
 * never leaves a torn JSON document at the target path.
 */
export function exportObservatoryArtifact(
  options: ExportObservatoryArtifactOptions,
): ExportObservatoryArtifactResult {
  const artifact = buildObservatoryArtifact(options);
  const json = serializeArtifact(artifact);
  const outPath = resolveArtifactOutput(options.root, options.out);

  mkdirSync(path.dirname(outPath), { recursive: true });
  assertSafeOutputAncestors(path.resolve(options.root), outPath);
  // Re-check the physical parent after mkdir; a symlinked parent must never
  // redirect the staging file outside the explicit root.
  if (!isInside(realpathSync(path.resolve(options.root)), realpathSync(path.dirname(outPath)))) {
    throw new Error('artifact --out parent resolves outside the explicit workspace root');
  }
  let tmpPath: string | undefined;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `${outPath}.onbrand-tmp-${randomBytes(16).toString('hex')}`;
      try {
        writeFileSync(candidate, json, { encoding: 'utf8', flag: 'wx' });
        tmpPath = candidate;
        break;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      }
    }
    if (tmpPath === undefined) throw new Error('could not reserve a unique artifact staging file');
    renameSync(tmpPath, outPath);
  } catch (cause) {
    if (tmpPath !== undefined) rmSync(tmpPath, { force: true });
    throw new Error(
      `failed while writing ${outPath} (${cause instanceof Error ? cause.message : String(cause)}) — re-run "onbrand observatory-export"`,
    );
  }

  return { outPath, artifact, bytes: Buffer.byteLength(json, 'utf8') };
}
