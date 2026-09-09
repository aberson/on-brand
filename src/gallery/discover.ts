/**
 * Explicit-root brand discovery + classification (plan.md §5, §6; Step 17).
 *
 * Given an EXPLICIT workspace root, find every valid `brand/` file-set beneath
 * it (bounded depth, bounded excludes — never an implicit whole-disk crawl) and
 * classify each into exactly one status:
 *
 *   - `adopted`    a valid, non-proposal brand whose committed dist is FRESH
 *                  (built from the current sources). The ONLY status that is
 *                  `final: true` — the gallery may present it as the current brand.
 *   - `proposal`   a valid from-url proposal brand (complete, dist built).
 *                  Visibly separate from adopted; `final: false` ALWAYS, so a
 *                  proposal can never be mislabeled as the final brand (§6, D7).
 *   - `incomplete` a proposal that did not finish (INCOMPLETE.md marker) or a
 *                  proposal with no built dist yet — nothing to show as current.
 *   - `stale`      an adopted (non-proposal) brand whose dist is missing or
 *                  drifted from its sources — the design shipped is not current.
 *   - `invalid`    a brand tokens.json that fails to load/validate — carries
 *                  the path-precise loader error for the operator.
 *
 * PROVENANCE vs HEALTH. Provenance (adopted vs proposal) is decided FIRST from
 * directory context (the "onbrand-proposal-" dir-name prefix, an INCOMPLETE.md
 * marker, or a DRAFT guide.md) and is independent of health (fresh / stale /
 * incomplete). A proposal is never promoted to `adopted`/`final` no matter how
 * fresh its dist is — the two axes never cross. This is what makes "proposal
 * fixtures cannot be mislabeled final" a structural guarantee, not a naming
 * convention.
 *
 * TRAVERSAL SAFETY. The walk requires an explicit root, bounds depth
 * (DEFAULT_MAX_DEPTH), skips a fixed exclude set (node_modules, .git, dist,
 * assets, ...) at every level, and — once a dir is identified as a brand root —
 * NEVER descends into its `brand/` subtree (so dist and assets are never
 * crawled). Sibling subtrees are still walked, so a workspace that has its own
 * `brand/` AND nested proposal dirs yields all of them.
 */

import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  computeSourceHash,
  type SourceHashResult,
} from '../build/manifest.ts';
import {
  implementedEmitterOutputs,
  loadBrandSources,
  type LoadSourcesOptions,
} from '../build/compile.ts';
import { checkDrift } from '../check/drift.ts';

/** The five mutually-exclusive discovery statuses (module header). */
export type BrandStatus = 'adopted' | 'proposal' | 'incomplete' | 'stale' | 'invalid';

/** Provenance axis — decided from directory context, independent of health. */
export type BrandProvenance = 'adopted' | 'proposal';

/** Directory names never crawled (matched case-insensitively, any level). */
export const DEFAULT_EXCLUDES: readonly string[] = [
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'assets',
  'coverage',
  '.vscode',
  '.idea',
  '.next',
  '.cache',
  '.turbo',
];

/** Directory levels below the root that the walk will descend (root = 0). */
export const DEFAULT_MAX_DEPTH = 4;

/** Prefix of a from-url proposal directory name (src/extract/from-url.ts). */
const PROPOSAL_DIR_PREFIX = 'onbrand-proposal-';

/** Marker file a from-url run leaves at the proposal root when a stage died. */
const INCOMPLETE_MARKER = 'INCOMPLETE.md';

/** DRAFT signatures the from-url guide renderer writes (src/extract/report.ts). */
const DRAFT_GUIDE_SIGNALS: readonly string[] = [
  'Brand Guide (DRAFT)',
  'GENERATED as a DRAFT by',
];

export interface DiscoveredBrand {
  /** Absolute path to the brand ROOT (the directory that CONTAINS brand/). */
  root: string;
  /**
   * Root path relative to the workspace root, forward slashes. "." for a brand
   * that sits at the workspace root itself.
   */
  relPath: string;
  /** Display name — the root dir basename, or "<workspace>" for the root itself. */
  name: string;
  /** Absolute path to the brand dir (root joined with "brand"). */
  brandDir: string;
  /** The classified status (module header). */
  status: BrandStatus;
  /**
   * True ONLY for `adopted`. Proposals — however fresh — are never final, so a
   * gallery keying "current brand" off `final` can never surface a draft (§6).
   */
  final: boolean;
  /** Provenance axis (adopted vs proposal), independent of health. */
  provenance: BrandProvenance;
  /** Whether brand/tokens.json exists. */
  hasTokens: boolean;
  /** Whether a built brand/dist/manifest.json exists. */
  hasDist: boolean;
  /** Whether an INCOMPLETE.md proposal marker sits at the root. */
  incompleteMarker: boolean;
  /** One-line, human-readable explanation of the classification. */
  reason: string;
  /** Loader/validation error text — present only when status is "invalid". */
  error?: string;
}

export interface DiscoverOptions {
  /** Max directory depth below the root to descend. Default DEFAULT_MAX_DEPTH. */
  maxDepth?: number;
  /** Extra directory names to exclude, merged with DEFAULT_EXCLUDES. */
  exclude?: readonly string[];
  /** Override preset resolution root (tests / extends chains). */
  presetsRoot?: string;
}

export interface DiscoverResult {
  /** Absolute, resolved workspace root that was scanned. */
  root: string;
  /** Discovered brands, sorted by relPath (stable, deterministic). */
  brands: DiscoveredBrand[];
}

/** True when name (case-folded) is in the exclude set. */
function isExcluded(name: string, excludes: ReadonlySet<string>): boolean {
  return excludes.has(name.toLowerCase());
}

/** True only for a regular local file (never follows a symlink/junction). */
function isRegularFile(p: string): boolean {
  try {
    const entry = lstatSync(p);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Whether an existing expected file is a link or a non-file payload. */
function hasUnsafeFilePayload(p: string): boolean {
  try {
    const entry = lstatSync(p);
    return entry.isSymbolicLink() || !entry.isFile();
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** Whether an existing expected directory is a link or a non-directory payload. */
function hasUnsafeDirectoryPayload(p: string): boolean {
  try {
    const entry = lstatSync(p);
    return entry.isSymbolicLink() || !entry.isDirectory();
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * Whether p is a real directory, tolerating races / broken links. Directory
 * symlinks/junctions are intentionally never traversed: an explicit workspace
 * root must not silently escape into an outside tree through a link.
 */
function isRealDir(p: string): boolean {
  try {
    const entry = lstatSync(p);
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Whether an explicit root is an existing directory (it may itself be a link). */
function isExistingDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Whether dir/brand/tokens.json is a local regular file (the brand-root marker). */
function hasBrandDir(dir: string): boolean {
  const brandDir = path.join(dir, 'brand');
  return isRealDir(brandDir) && isRegularFile(path.join(brandDir, 'tokens.json'));
}

/** Safe directory read — returns [] on any I/O error (permission, race). */
function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Provenance signals read from directory context (never from token content):
 *   - the root dir name starts with the proposal prefix, OR
 *   - an INCOMPLETE.md marker sits at the root, OR
 *   - brand/guide.md carries the from-url DRAFT signature.
 * Any one makes the brand a PROPOSAL.
 */
function detectProvenance(root: string): {
  provenance: BrandProvenance;
  incompleteMarker: boolean;
} {
  const incompleteMarker = isRegularFile(path.join(root, INCOMPLETE_MARKER));

  const base = path.basename(root);
  let proposal = incompleteMarker || base.startsWith(PROPOSAL_DIR_PREFIX);

  if (!proposal) {
    const guidePath = path.join(root, 'brand', 'guide.md');
    if (isRegularFile(guidePath)) {
      let guide = '';
      try {
        guide = readFileSync(guidePath, 'utf8');
      } catch {
        guide = '';
      }
      if (DRAFT_GUIDE_SIGNALS.some((sig) => guide.includes(sig))) proposal = true;
    }
  }

  return { provenance: proposal ? 'proposal' : 'adopted', incompleteMarker };
}

/** dist freshness for a loadable brand — false when missing or drifted. */
function isDistFresh(
  brandDir: string,
  hash: SourceHashResult,
): { hasDist: boolean; fresh: boolean } {
  const distDir = path.join(brandDir, 'dist');
  // Checking a leaf with lstat still follows an intermediate linked dist/
  // directory. Treat that as absent rather than allowing discovery to observe
  // output from outside the explicit workspace.
  if (!isRealDir(distDir)) return { hasDist: false, fresh: false };
  const manifestPath = path.join(distDir, 'manifest.json');
  let manifestContent: string | undefined;
  try {
    if (isRegularFile(manifestPath)) manifestContent = readFileSync(manifestPath, 'utf8');
  } catch {
    manifestContent = undefined;
  }
  if (manifestContent === undefined) return { hasDist: false, fresh: false };

  // Reuse the production drift checker so "fresh" here means exactly what
  // `onbrand check` means by it (per-output hash match + completeness sweep).
  // Gallery lifecycle classification is intentionally about the regular build
  // outputs.  The optional inspiration explanation and preview have their own
  // freshness contracts and must not make an otherwise fresh brand look stale
  // merely because their output hash is broader than the core token hash.
  const drift = checkDrift(distDir, hash.sourceHash, manifestContent, [
    ...implementedEmitterOutputs(),
    { emitter: 'generated', relPath: 'specimen.html', required: false, ignoreRecorded: true },
    {
      emitter: 'generated',
      relPath: 'inspiration-to-implementation.html',
      required: false,
      ignoreRecorded: true,
    },
  ]);
  const fresh = !drift.some((f) => f.severity === 'error');
  return { hasDist: true, fresh };
}

/**
 * Classify a single brand root. Pure w.r.t. the filesystem it reads; the status
 * decision tree is: invalid (unloadable) then provenance-gated health
 * (proposal: complete gives proposal / else incomplete; adopted: fresh gives
 * adopted / else stale). INCOMPLETE.md always wins for a proposal.
 */
export function classifyBrand(
  root: string,
  options: { presetsRoot?: string } = {},
): Omit<DiscoveredBrand, 'relPath' | 'name'> {
  const absRoot = path.resolve(root);
  const brandDir = path.join(absRoot, 'brand');
  const hasTokens = isRegularFile(path.join(brandDir, 'tokens.json'));
  const { provenance, incompleteMarker } = detectProvenance(absRoot);

  const base = {
    root: absRoot,
    brandDir,
    provenance,
    hasTokens,
    incompleteMarker,
  };

  // Discovery must never follow a linked source file out of the explicit
  // workspace. A missing optional overlay is fine; a present non-file/link is
  // an invalid local brand payload rather than an external source to trust.
  const tokensPath = path.join(brandDir, 'tokens.json');
  const modesPath = path.join(brandDir, 'modes.dark.json');
  const distPath = path.join(brandDir, 'dist');
  if (
    hasUnsafeFilePayload(tokensPath) ||
    hasUnsafeFilePayload(modesPath) ||
    hasUnsafeDirectoryPayload(distPath)
  ) {
    const unsafePath = hasUnsafeFilePayload(tokensPath)
      ? 'tokens.json'
      : hasUnsafeFilePayload(modesPath)
        ? 'modes.dark.json'
        : 'dist';
    return {
      ...base,
      status: 'invalid',
      final: false,
      hasDist: false,
      reason: `brand/${unsafePath} must be a local non-linked payload; linked or invalid payloads are not scanned`,
      error: `refused unsafe brand/${unsafePath} payload`,
    };
  }

  // 1. Load the sources through the production assembly. A failure (missing or
  //    invalid tokens.json, bad overlay, broken extends) is invalid.
  const loadOpts: LoadSourcesOptions = {
    ...(options.presetsRoot !== undefined ? { presetsRoot: options.presetsRoot } : {}),
  };
  let hash: SourceHashResult;
  try {
    const sources = loadBrandSources(absRoot, loadOpts);
    hash = computeSourceHash(sources.sourceInputs);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ...base,
      status: 'invalid',
      final: false,
      hasDist: isRegularFile(path.join(brandDir, 'dist', 'manifest.json')),
      reason: `brand/ sources do not load — ${message}`,
      error: message,
    };
  }

  const { hasDist, fresh } = isDistFresh(brandDir, hash);

  // 2. A proposal that did not finish (marker present) is always incomplete.
  if (incompleteMarker) {
    return {
      ...base,
      status: 'incomplete',
      final: false,
      hasDist,
      reason: 'proposal did not finish — INCOMPLETE.md marker present; not adoptable yet',
    };
  }

  // 3. Provenance-gated health. A proposal never becomes adopted/final.
  if (provenance === 'proposal') {
    return fresh
      ? {
          ...base,
          status: 'proposal',
          final: false,
          hasDist,
          reason: 'valid from-url proposal with a built dist — visibly separate from adopted brands',
        }
      : {
          ...base,
          status: 'incomplete',
          final: false,
          hasDist,
          reason: hasDist
            ? 'proposal dist is drifted from its sources — rebuild before adopting'
            : 'proposal has no built dist yet — run "onbrand build" in the proposal to complete it',
        };
  }

  // 4. Adopted (non-proposal) brand: fresh dist gives final; else stale.
  return fresh
    ? {
        ...base,
        status: 'adopted',
        final: true,
        hasDist,
        reason: 'valid adopted brand with a fresh committed dist — current and final',
      }
    : {
        ...base,
        status: 'stale',
        final: false,
        hasDist,
        reason: hasDist
          ? 'adopted brand dist is drifted from its sources — run "onbrand build" (the gallery would show an old design as current)'
          : 'adopted brand has no built dist — run "onbrand build" before it can be shown',
      };
}

/**
 * Walk workspaceRoot (bounded depth + excludes) collecting every brand root,
 * NEVER descending into a discovered brand's `brand/` subtree. Returns the
 * absolute roots in a deterministic (sorted) order.
 */
function collectBrandRoots(
  workspaceRoot: string,
  maxDepth: number,
  excludes: ReadonlySet<string>,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const walk = (dir: string, depth: number): void => {
    if (hasBrandDir(dir) && !seen.has(dir)) {
      found.push(dir);
      seen.add(dir);
      // Consume the brand root: do NOT crawl its brand/ subtree (dist, assets
      // never touched). Sibling subdirs below are still walked.
    }
    if (depth >= maxDepth) return;
    for (const entry of safeReadDir(dir).sort()) {
      if (entry === 'brand') continue; // never crawl a brand/ payload
      if (isExcluded(entry, excludes)) continue;
      const child = path.join(dir, entry);
      if (!isRealDir(child)) continue;
      walk(child, depth + 1);
    }
  };

  walk(path.resolve(workspaceRoot), 0);
  return found;
}

/**
 * Discover and classify every brand file-set beneath an EXPLICIT workspace root.
 * Throws if the root does not exist / is not a directory (the CLI maps that to a
 * usage error — discovery never silently scans "somewhere").
 */
export function discoverBrands(workspaceRoot: string, options: DiscoverOptions = {}): DiscoverResult {
  const absRoot = path.resolve(workspaceRoot);
  if (!isExistingDir(absRoot)) {
    throw new Error(`workspace root ${JSON.stringify(workspaceRoot)} is not an existing directory`);
  }

  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const excludes = new Set<string>(
    [...DEFAULT_EXCLUDES, ...(options.exclude ?? [])].map((n) => n.toLowerCase()),
  );

  const roots = collectBrandRoots(absRoot, maxDepth, excludes);
  const brands: DiscoveredBrand[] = roots.map((root) => {
    const classified = classifyBrand(root, {
      ...(options.presetsRoot !== undefined ? { presetsRoot: options.presetsRoot } : {}),
    });
    const rel = path.relative(absRoot, root);
    const relPath = rel === '' ? '.' : rel.split(path.sep).join('/');
    const name = rel === '' ? '<workspace>' : path.basename(root);
    return { ...classified, relPath, name };
  });

  brands.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { root: absRoot, brands };
}
