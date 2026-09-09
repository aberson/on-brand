/**
 * Static gallery orchestration for `onbrand gallery` (plan.md §6, §7; Step 18)
 * — the filesystem half of src/gallery. It REUSES Step 17 discovery
 * (discover.ts) to find + classify every brand under an EXPLICIT workspace
 * root, enriches each with a few bounded extra reads (token groups, dark-mode
 * availability, a real check-gate run, an existing specimen link), hands the
 * assembled view model to the pure renderer (render.ts), and writes ONE static
 * HTML file.
 *
 * NON-MUTATING BY DESIGN (plan §6: "writing static HTML without rebuilding
 * consumers"). This command writes exactly one artifact — the gallery page —
 * and never touches any brand's brand/ or dist/ subtree. It LINKS to a
 * brand/dist/specimen.html only when one already exists (build + preview are
 * separate commands, Steps 2 and 19); a brand without a built specimen is shown
 * with a "run onbrand preview" note rather than being silently rebuilt.
 *
 * BOUNDED. Discovery is already explicit-root + depth-bounded + exclude-set
 * (discover.ts). The per-brand enrichment here reads only files inside a
 * discovered brand root (tokens.json for group names, modes.dark.json for the
 * dark overlay, dist/specimen.html for the link) and runs the production check
 * gate over the brand — every step wrapped so one bad brand degrades to a
 * "could not run" cell instead of aborting the whole page.
 *
 * SPECIMEN HREFS. Computed RELATIVE to the gallery file's own directory
 * (path.relative from dirname(outPath)), normalized to forward slashes, so the
 * page is portable and the links resolve on a file:// open regardless of where
 * the operator points --out. render.ts percent-encodes + escapes them.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runCheck } from '../check/run.ts';
import {
  discoverBrands,
  type DiscoveredBrand,
  type DiscoverResult,
} from './discover.ts';
import {
  renderGallery,
  type GalleryBrand,
  type GalleryCheckState,
  type GalleryModel,
} from './render.ts';

/** Default gallery filename written at the workspace root. */
export const DEFAULT_GALLERY_FILENAME = 'onbrand-gallery.html';

export interface GenerateGalleryOptions {
  /** REQUIRED explicit workspace root to scan (discovery never scans implicitly). */
  root: string;
  /** Output HTML file path. Default: <root>/onbrand-gallery.html. */
  out?: string;
  /** Override preset resolution root (tests / extends chains). */
  presetsRoot?: string;
  /**
   * Run the production check gate per brand (default true). Tests that only
   * exercise structure can turn it off to stay fast/deterministic.
   */
  runChecks?: boolean;
}

export interface GalleryResult {
  /** Absolute path to the written gallery HTML file. */
  outPath: string;
  /** Absolute workspace root that was scanned. */
  root: string;
  /** Number of brand sets discovered. */
  brandCount: number;
  /** Number of final (adopted) brands. */
  finalCount: number;
  /** The assembled view model (returned for inspection / tests). */
  model: GalleryModel;
}

/** Sanitize a relPath into a safe, unique `[a-z0-9-]` element id (anchor target). */
function makeId(relPath: string, used: Set<string>): string {
  const slug = relPath
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = `brand-${slug === '' ? 'root' : slug}`;
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n++;
  }
  used.add(id);
  return id;
}

/** Top-level DTCG token group names (skip $-prefixed metadata keys). [] on any failure. */
function readTokenGroups(brandDir: string): string[] {
  try {
    const raw = readFileSync(path.join(brandDir, 'tokens.json'), 'utf8');
    const doc = JSON.parse(raw) as Record<string, unknown>;
    if (doc === null || typeof doc !== 'object') return [];
    return Object.keys(doc).filter((k) => !k.startsWith('$'));
  } catch {
    return [];
  }
}

/** Whether a dark-mode overlay (brand/modes.dark.json) is present. */
function hasDarkOverlay(brandDir: string): boolean {
  try {
    return statSync(path.join(brandDir, 'modes.dark.json')).isFile();
  } catch {
    return false;
  }
}

/** Human freshness label derived purely from the Step 17 classification. */
function freshnessLabel(brand: DiscoveredBrand): string {
  if (brand.status === 'invalid') return 'unknown (sources do not load)';
  if (!brand.hasDist) return 'no built dist';
  if (brand.status === 'adopted' || brand.status === 'proposal') return 'fresh (matches sources)';
  return 'drifted from sources';
}

/** Run the production check gate for a loadable brand; degrade gracefully. */
function checkState(brand: DiscoveredBrand, presetsRoot?: string, runChecks = true): GalleryCheckState {
  if (!runChecks) return { ran: false, note: 'checks skipped' };
  if (brand.status === 'invalid') return { ran: false, note: 'sources do not load' };
  try {
    const report = runCheck(brand.root, {
      ...(presetsRoot !== undefined ? { presetsRoot } : {}),
    });
    return {
      ran: true,
      ok: report.ok,
      errorCount: report.errorCount,
      warningCount: report.warningCount,
      advisoryCount: report.advisoryCount,
    };
  } catch (e) {
    return { ran: false, note: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Compute the forward-slash href from the gallery file's directory to a brand's
 * built specimen.html, or undefined when none exists. RELATIVE so the page is
 * portable; render.ts encodes + escapes it.
 */
function specimenHref(brand: DiscoveredBrand, outDir: string): string | undefined {
  const specimenAbs = path.join(brand.brandDir, 'dist', 'specimen.html');
  if (!existsSync(specimenAbs)) return undefined;
  const rel = path.relative(outDir, specimenAbs).split(path.sep).join('/');
  // Keep it unambiguously relative (a same-dir target has no leading segment).
  return rel.startsWith('.') || rel.startsWith('/') ? rel : `./${rel}`;
}

/**
 * Build the pure view model from a discovery result + the resolved output path.
 * Reads only inside discovered brand roots; every enrichment is failure-tolerant.
 */
export function buildGalleryModel(
  result: DiscoverResult,
  outPath: string,
  options: { presetsRoot?: string; runChecks?: boolean; generatedLabel?: string } = {},
): GalleryModel {
  const outDir = path.dirname(path.resolve(outPath));
  const used = new Set<string>();
  const brands: GalleryBrand[] = result.brands.map((b) => {
    const galleryBrand: GalleryBrand = {
      id: makeId(b.relPath, used),
      name: b.name,
      relPath: b.relPath,
      status: b.status,
      provenance: b.provenance,
      final: b.final,
      freshness: freshnessLabel(b),
      darkMode: hasDarkOverlay(b.brandDir),
      tokenGroups: readTokenGroups(b.brandDir),
      check: checkState(b, options.presetsRoot, options.runChecks ?? true),
      reason: b.reason,
      ...(b.error !== undefined ? { error: b.error } : {}),
    };
    const href = specimenHref(b, outDir);
    if (href !== undefined) galleryBrand.specimenHref = href;
    return galleryBrand;
  });

  const finalCount = brands.filter((b) => b.final).length;
  const proposalCount = brands.filter((b) => b.provenance === 'proposal').length;

  return {
    root: result.root,
    generatedLabel: options.generatedLabel ?? `generated by onbrand gallery`,
    brands,
    finalCount,
    proposalCount,
  };
}

/**
 * Discover + classify every brand under an EXPLICIT workspace root, assemble the
 * gallery model, render it, and write ONE static HTML file (stage-then-rename so
 * a mid-write failure never leaves a torn page). Returns the resolved paths and
 * counts. Throws if the root does not exist / is not a directory (discovery's
 * contract) — the CLI maps that to a usage error.
 */
export function generateGallery(options: GenerateGalleryOptions): GalleryResult {
  const result = discoverBrands(options.root, {
    ...(options.presetsRoot !== undefined ? { presetsRoot: options.presetsRoot } : {}),
  });

  const outPath =
    options.out !== undefined
      ? path.resolve(options.out)
      : path.join(result.root, DEFAULT_GALLERY_FILENAME);

  const model = buildGalleryModel(result, outPath, {
    ...(options.presetsRoot !== undefined ? { presetsRoot: options.presetsRoot } : {}),
    runChecks: options.runChecks ?? true,
    generatedLabel: `generated by onbrand gallery on ${new Date().toISOString()}`,
  });

  const html = renderGallery(model);

  // Ensure the output directory exists (a caller-chosen --out may nest).
  mkdirSync(path.dirname(outPath), { recursive: true });

  const tmpPath = `${outPath}.onbrand-tmp-${process.pid}`;
  try {
    writeFileSync(tmpPath, html, 'utf8');
    renameSync(tmpPath, outPath);
  } catch (cause) {
    rmSync(tmpPath, { force: true });
    throw new Error(
      `failed while writing ${outPath} (${cause instanceof Error ? cause.message : String(cause)}) — re-run "onbrand gallery"`,
    );
  }

  return {
    outPath,
    root: result.root,
    brandCount: model.brands.length,
    finalCount: model.finalCount,
    model,
  };
}
