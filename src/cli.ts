/**
 * onbrand CLI — subcommand dispatch + exit codes (plan.md §6, §7).
 *
 * Exit codes: 0 ok · 1 check/gate failure · 2 usage error · 3 environment
 * missing. `init` (Step 1) and `build` (Step 2: css emitter + manifest) are
 * implemented; check / from-url / preview are dispatched here but land in
 * later steps.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { applyModeOverlay } from './schema/modes.ts';
import { defaultPresetsRoot, packageRoot, readJsonFile } from './schema/resolve.ts';
import { validate } from './schema/validate.ts';
import { formatIssues } from './schema/types.ts';
import {
  EMITTER_IDS,
  compileBrand,
  computeBrandSourceHash,
  isEmitterId,
  type EmitterId,
} from './build/compile.ts';
import { onbrandVersion } from './build/manifest.ts';
import {
  formatCheckReport,
  runCheck,
  unavailableCheckReport,
  type CheckReport,
} from './check/run.ts';
import { generatePreview, openInBrowser } from './preview/specimen.ts';
import {
  FixtureEngine,
  FromUrlEnvironmentError,
  FromUrlUsageError,
  runFromUrl,
  type RunFromUrlOptions,
} from './extract/from-url.ts';
import {
  discoverBrands,
  type DiscoveredBrand,
  type DiscoverResult,
} from './gallery/discover.ts';
import { generateGallery } from './gallery/index.ts';
import { exportObservatoryArtifact } from './gallery/observatory-export.ts';
import {
  INSPIRATION_EXPORT_LIMITS,
  InspirationCatalogError,
  buildInspirationArtifact,
  exportInspirationArtifact,
  recoverStaleInspirationExportLock,
  resolveInspirationArtifactOutput,
} from './inspiration/export.ts';
import { recordSpecimenView } from './inspiration/views.ts';
import { FromImageUsageError, runFromImage, type RunFromImageOptions } from './extract/from-image.ts';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_ENVIRONMENT = 3;

export interface CliRuntimeHooks {
  /** Test-only paired from-image seam immediately before catalog discovery. */
  beforeFromImageCatalogRefresh?: (proposalDir: string) => void | Promise<void>;
}

/**
 * Declared in the §6 contract but landing in later build steps. Deliberate
 * exit-code convention: these exit 2 (usage-class) with a clear message —
 * §6 defines no dedicated code for "declared but unbuilt", and 1 would read
 * as a check/gate failure while 3 claims a missing environment; "this
 * invocation cannot be serviced by this build" is closest to usage. Every §6
 * subcommand is now live (from-url landed in Step 12) — this stays as the
 * mechanism for any future contract-declared-but-unbuilt command.
 */
const NOT_YET_IMPLEMENTED: readonly string[] = [];

const USAGE = `onbrand — per-project brand-guide file-sets (DTCG tokens -> generated outputs)

Usage:
  onbrand init [dir] [--preset <name>] [--force]   scaffold <dir>/brand/ from a preset
  onbrand build [dir] [--emit <list>] [--check]    compile brand/tokens.json -> brand/dist/
  onbrand check [dir] [--strict] [--json]          WCAG 2 AA contrast gate + lint + drift
  onbrand preview [dir] [--open]                   generate brand/dist/specimen.html
  onbrand from-url <url> [--out <dir>] [--pages n] [--dark] [--no-llm] [--force]
                                                   extract a site -> proposal dir + report
  onbrand from-image <file> --title <title> --alt <alt> [--out <dir>] [--no-llm] [--force]
                                                   measure a local raster -> reviewable proposal
  onbrand inspiration-export --root <workspace> [--out <file>] [--recover-stale-lock]
                                                   write the bounded inspiration catalog artifact
  onbrand brands list|show --root <workspace> [--json]
                                                   discover + classify brand/ sets under a workspace
  onbrand gallery --root <workspace> [--out <file>] [--open]
                                                   write a static list/detail gallery of discovered brands
  onbrand observatory-export --root <workspace> [--out <file>]
                                                   write a bounded versioned gallery/check JSON artifact
  onbrand --help | -h | help                       show this help
  onbrand --version                                print version

Exit codes: 0 ok, 1 check/gate failure, 2 usage error, 3 environment missing.
`;

const INIT_USAGE = `onbrand init [dir] [--preset <name>] [--force]

Scaffold <dir>/brand/ (default dir: ".") from a preset:
  brand/tokens.json      DTCG token source of truth (light theme)
  brand/modes.dark.json  dark-mode overlay (color values only)
  brand/guide.md         human brand guide with TODO prompts
  brand/assets/          drop logo.svg / favicon.svg here

Flags:
  --preset <name>   preset under templates/presets/ (default: "default")
  --force           overwrite existing brand files (otherwise: refuse, exit 1)
`;

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

export async function main(argv: readonly string[], hooks: CliRuntimeHooks = {}): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined) {
    err(USAGE.trimEnd());
    return EXIT_USAGE;
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    out(USAGE.trimEnd());
    return EXIT_OK;
  }
  if (command === '--version') {
    out(onbrandVersion());
    return EXIT_OK;
  }
  if (command === 'init') {
    try {
      return runInit(rest);
    } catch (e) {
      err(`onbrand init: ${e instanceof Error ? e.message : String(e)}`);
      return EXIT_FAILURE;
    }
  }
  if (command === 'build') {
    try {
      return runBuild(rest);
    } catch (e) {
      // TokenResolveError / TokenValidationError messages carry the
      // path-precise issue list (plan.md §6: build validation failure -> 1).
      err(`onbrand build: ${e instanceof Error ? e.message : String(e)}`);
      return EXIT_FAILURE;
    }
  }
  if (command === 'check') {
    try {
      return runCheckCommand(rest);
    } catch (e) {
      // Source problems (invalid tokens, bad overlay, missing brand/) carry a
      // path-precise message; a check that cannot even load its sources is a
      // gate failure (plan.md §6 -> exit 1).
      const message = e instanceof Error ? e.message : String(e);
      if (rest.includes('--json')) {
        out(JSON.stringify(unavailableCheckReport(message), null, 2));
      } else {
        err(`onbrand check: ${message}`);
      }
      return EXIT_FAILURE;
    }
  }
  if (command === 'preview') {
    try {
      return runPreview(rest);
    } catch (e) {
      // PreviewError (no built dist) + any write failure map to exit 1 with the
      // path-precise "run onbrand build first" message they carry (plan §6).
      err(`onbrand preview: ${e instanceof Error ? e.message : String(e)}`);
      return EXIT_FAILURE;
    }
  }
  if (command === 'from-url') {
    return runFromUrlCommand(rest);
  }
  if (command === 'from-image') {
    return runFromImageCommand(rest, hooks);
  }
  if (command === 'inspiration-export') {
    try {
      return runInspirationExport(rest);
    } catch (e) {
      err(`onbrand inspiration-export: ${e instanceof Error ? e.message : String(e)}`);
      return EXIT_FAILURE;
    }
  }
  if (command === 'brands') {
    try {
      return runBrands(rest);
    } catch (e) {
      // Discovery source problems (bad --root) throw with a precise message.
      err(`onbrand brands: ${e instanceof Error ? e.message : String(e)}`);
      return EXIT_FAILURE;
    }
  }
  if (command === 'gallery') {
    try {
      return runGallery(rest);
    } catch (e) {
      // Discovery source problems (bad --root) / write failures throw with a
      // precise message; a gallery that cannot even scan its root is a failure.
      err(`onbrand gallery: ${e instanceof Error ? e.message : String(e)}`);
      return EXIT_FAILURE;
    }
  }
  if (command === 'observatory-export') {
    try {
      return runObservatoryExport(rest);
    } catch (e) {
      // The exporter is a file-format seam: surface discovery/check/write
      // failures without ever invoking another project.
      err(`onbrand observatory-export: ${e instanceof Error ? e.message : String(e)}`);
      return EXIT_FAILURE;
    }
  }
  if (NOT_YET_IMPLEMENTED.includes(command)) {
    err(`onbrand ${command}: not implemented yet (planned in a later build step)`);
    return EXIT_USAGE;
  }

  err(`onbrand: unknown command ${JSON.stringify(command)}`);
  err('');
  err(USAGE.trimEnd());
  return EXIT_USAGE;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

const BUILD_USAGE = `onbrand build [dir] [--emit <list>]

Compile <dir>/brand/tokens.json (+ modes.dark.json overlay, + extends chain)
into <dir>/brand/dist/ (default dir: ".") and write dist/manifest.json
(provenance + source hash for the stale-dist drift guard).

Flags:
  --emit <list>   comma-separated emitters to run (default: all)
                  known: ${EMITTER_IDS.join(', ')}
                  (svg emits palette.svg + diagram-palette.json; components
                  emits components.css; designmd emits DESIGN.md, the derived
                  agent-facing design-system file. When svg runs, the
                  brand/guide.md palette fence is refreshed too - prose
                  outside the fences is never touched.)
  --check         run the quality gate (WCAG 2 AA contrast + schema lint +
                  stale-dist drift) after building; nonzero exit on a hard fail
`;

function runBuild(args: readonly string[]): number {
  let dir: string | undefined;
  let emit: EmitterId[] | undefined;
  let check = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--emit') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) {
        err('onbrand build: --emit requires a comma-separated list of emitter names');
        return EXIT_USAGE;
      }
      const names = value.split(',').map((name) => name.trim());
      const parsed: EmitterId[] = [];
      for (const name of names) {
        if (name === '' || !isEmitterId(name)) {
          err(
            `onbrand build: unknown emitter ${JSON.stringify(name)} (known: ${EMITTER_IDS.join(', ')})`,
          );
          return EXIT_USAGE;
        }
        if (!parsed.includes(name)) parsed.push(name);
      }
      emit = parsed;
      i++;
    } else if (arg === '--check') {
      check = true;
    } else if (arg === '-h' || arg === '--help') {
      out(BUILD_USAGE.trimEnd());
      return EXIT_OK;
    } else if (arg.startsWith('-')) {
      err(`onbrand build: unknown flag ${JSON.stringify(arg)}`);
      err('');
      err(BUILD_USAGE.trimEnd());
      return EXIT_USAGE;
    } else if (dir === undefined) {
      dir = arg;
    } else {
      err(`onbrand build: unexpected extra argument ${JSON.stringify(arg)}`);
      return EXIT_USAGE;
    }
  }

  const projectDir = path.resolve(dir ?? '.');
  const result = compileBrand(projectDir, {
    ...(emit !== undefined ? { emit } : {}),
  });

  out(`Built brand/dist/ (${result.manifest.emitters.join(', ') || 'manifest only'}):`);
  for (const file of result.written) {
    out(`  ${file}`);
  }
  if (result.guide !== undefined && result.guide.status === 'updated') {
    out(`  ${result.guide.path} (palette fence refreshed)`);
  }
  for (const warning of result.manifestWarnings) {
    err(`note: ${warning}`);
  }
  if (result.skipped.length > 0) {
    err(
      `note: emitters not built yet in this version, skipped: ${result.skipped.join(', ')} (they land in later build steps)`,
    );
  }

  // --check runs the SAME gate as `onbrand check` post-build (plan §6). The
  // dist is fresh, so drift passes; a WCAG failure still exits 1.
  if (check) {
    const report = runCheck(projectDir);
    err(formatCheckReport(report));
    if (!report.ok) return EXIT_FAILURE;
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

const CHECK_USAGE = `onbrand check [dir] [--strict] [--json]

Run the quality gate over <dir>/brand/ (default dir: "."):
  - WCAG 2 AA contrast HARD gate over every declared fg/bg pairing, both modes
    (semantic text/bg, status fg/bg, chart label/chrome);
  - APCA Lc reported alongside every pairing (advisory);
  - schema lint (unknown categories, missing dark-mode coverage);
  - stale-dist drift (per-output manifest-hash comparison).

Flags:
  --strict   promote sub-threshold APCA advisories (|Lc| < 60) to errors
  --json     write the versioned machine-readable report to stdout (no prose;
             source-load failures use a state:"unavailable" error envelope)

Exit: 0 ok, 1 gate failure, 2 usage error. The full report (a per-pairing
table + findings + summary) is written to stderr unless --json is used.
`;

function runCheckCommand(args: readonly string[]): number {
  let dir: string | undefined;
  let strict = false;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--strict') {
      strict = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '-h' || arg === '--help') {
      out(CHECK_USAGE.trimEnd());
      return EXIT_OK;
    } else if (arg.startsWith('-')) {
      err(`onbrand check: unknown flag ${JSON.stringify(arg)}`);
      err('');
      err(CHECK_USAGE.trimEnd());
      return EXIT_USAGE;
    } else if (dir === undefined) {
      dir = arg;
    } else {
      err(`onbrand check: unexpected extra argument ${JSON.stringify(arg)}`);
      return EXIT_USAGE;
    }
  }

  const report: CheckReport = runCheck(path.resolve(dir ?? '.'), { strict });
  if (json) {
    out(JSON.stringify(report, null, 2));
  } else {
    err(formatCheckReport(report));
  }
  return report.ok ? EXIT_OK : EXIT_FAILURE;
}

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

const PREVIEW_USAGE = `onbrand preview [dir] [--open]

Generate <dir>/brand/dist/specimen.html (default dir: "."): a standalone page
rendering every token group on sample components (headings, body, buttons,
cards, status badges, chart swatch row, diagram palette row, table, form
controls) with a keyboard-accessible light/dark toggle. It consumes ONLY the
built dist/ outputs (links tokens.css + components.css; reads
diagram-palette.json; references palette.svg), so run "onbrand build" first.

Flags:
  --open   open the generated specimen.html in your default browser

Exit: 0 ok, 1 no built dist (run "onbrand build" first) / write failure,
2 usage error.
`;

/** Shell-neutral argv display: copy the JSON array into any suitable runner. */
function localOnbrandArgv(command: 'build' | 'preview', projectDir: string): string {
  const args = [process.execPath, path.join(packageRoot(), 'bin', 'onbrand.mjs'), command, projectDir];
  return JSON.stringify(args);
}

function runPreview(args: readonly string[]): number {
  let dir: string | undefined;
  let open = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--open') {
      open = true;
    } else if (arg === '-h' || arg === '--help') {
      out(PREVIEW_USAGE.trimEnd());
      return EXIT_OK;
    } else if (arg.startsWith('-')) {
      err(`onbrand preview: unknown flag ${JSON.stringify(arg)}`);
      err('');
      err(PREVIEW_USAGE.trimEnd());
      return EXIT_USAGE;
    } else if (dir === undefined) {
      dir = arg;
    } else {
      err(`onbrand preview: unexpected extra argument ${JSON.stringify(arg)}`);
      return EXIT_USAGE;
    }
  }

  const projectDir = path.resolve(dir ?? '.');
  const result = generatePreview(projectDir);
  // Preview itself remains a dist-only renderer. When a valid manifest is
  // available, refresh its core-hash provenance afterward. A failed refresh
  // does not determine whether an older exact digest is still current.
  let recorded = false;
  try {
    recorded = recordSpecimenView(
      projectDir,
      result.generation,
      computeBrandSourceHash(projectDir).sourceHash,
    );
  } catch {
    // Legacy preview compatibility: a corrupt/missing manifest must not turn a
    // successfully written standalone specimen into a failed CLI invocation.
  }
  out(`Wrote ${result.specimenPath}`);
  if (!recorded) {
    err('onbrand preview: warning: specimen.html is usable, but its provenance refresh failed.');
    err('onbrand preview: remediation: after any active publication finishes, invoke these shell-neutral argv arrays:');
    err(`onbrand preview: remediation argv (build): ${localOnbrandArgv('build', projectDir)}`);
    err(`onbrand preview: remediation argv (preview): ${localOnbrandArgv('preview', projectDir)}`);
  }
  out('Open it in a browser to view the specimen (light/dark toggle, top-right).');
  if (open) {
    openInBrowser(result.specimenPath, {
      onError: (message) => err(`onbrand preview: ${message}`),
    });
    out('Opening in your default browser...');
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// from-url
// ---------------------------------------------------------------------------

const FROMURL_USAGE = `onbrand from-url <url> [--out <dir>] [--pages <n>] [--dark] [--no-llm] [--force]

Extract a website's look-and-feel into a proposal directory under <dir>
(default: current directory):

  onbrand-proposal-<host>-<YYYYMMDD>[-b|-c...]/
    brand/                a full brand/-shaped set — copy it into <project>/brand/
      tokens.json  modes.dark.json  guide.md (DRAFT)  assets/  dist/
    raw-extraction.json   the raw computed-style extraction (evidence)
    extraction-report.md  screenshots, clusters, confidence, candidates, fonts

Pipeline: engine (dembrandt + Chromium) -> normalize -> LLM assist -> build all
emitters. A second run for the same host+day lands in "-b"/"-c" (never clobbers).
On any stage failure the dir is kept with an INCOMPLETE.md marker + partial
evidence; extraction never retries silently.

Flags:
  --out <dir>    output root for the proposal dir (default: ".")
  --pages <n>    pages to crawl and merge (default: 1)
  --dark         also capture a dark-mode variant
  --no-llm       skip the LLM passes (heuristics only; manifest llm:"skipped")
  --force        reuse/overwrite the base proposal dir instead of "-b"/"-c"

Exit: 0 ok, 1 pipeline failure (INCOMPLETE dir kept), 2 usage error,
3 environment missing (dembrandt/Chromium).
`;

async function runFromUrlCommand(args: readonly string[]): Promise<number> {
  let url: string | undefined;
  let outDir: string | undefined;
  let pages: number | undefined;
  let dark = false;
  let noLlm = false;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--out') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) {
        err('onbrand from-url: --out requires a directory');
        return EXIT_USAGE;
      }
      outDir = value;
      i++;
    } else if (arg === '--pages') {
      const value = args[i + 1];
      const n = value === undefined ? NaN : Number(value);
      if (!Number.isInteger(n) || n < 1) {
        err('onbrand from-url: --pages requires a positive integer');
        return EXIT_USAGE;
      }
      pages = n;
      i++;
    } else if (arg === '--dark') {
      dark = true;
    } else if (arg === '--no-llm') {
      noLlm = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '-h' || arg === '--help') {
      out(FROMURL_USAGE.trimEnd());
      return EXIT_OK;
    } else if (arg.startsWith('-')) {
      err(`onbrand from-url: unknown flag ${JSON.stringify(arg)}`);
      err('');
      err(FROMURL_USAGE.trimEnd());
      return EXIT_USAGE;
    } else if (url === undefined) {
      url = arg;
    } else {
      err(`onbrand from-url: unexpected extra argument ${JSON.stringify(arg)}`);
      return EXIT_USAGE;
    }
  }

  if (url === undefined) {
    err('onbrand from-url: missing <url> argument');
    err('');
    err(FROMURL_USAGE.trimEnd());
    return EXIT_USAGE;
  }

  // Test/offline seams (unset in normal use): a committed raw-extraction JSON
  // stands in for live dembrandt+Chromium; a fixed clock pins the proposal date.
  const options: RunFromUrlOptions = {
    ...(outDir !== undefined ? { outDir } : {}),
    ...(pages !== undefined ? { pages } : {}),
    dark,
    noLlm,
    force,
  };
  const fakeExtraction = process.env.ONBRAND_FAKE_EXTRACTION;
  if (fakeExtraction !== undefined && fakeExtraction !== '') {
    options.engine = new FixtureEngine(fakeExtraction, packageRoot());
  }
  const fakeNow = process.env.ONBRAND_NOW;
  if (fakeNow !== undefined && fakeNow !== '') {
    const pinned = new Date(fakeNow);
    if (!Number.isNaN(pinned.getTime())) options.now = () => pinned;
  }

  try {
    const result = await runFromUrl(url, options);
    if (result.status === 'complete') {
      out(`Wrote proposal: ${result.proposalDir}`);
      out(`  brand set:  ${result.brandDir}  (copy into <project>/brand/ to adopt)`);
      if (result.reportPath !== undefined) out(`  report:     ${result.reportPath}`);
      out(`  LLM assist: ${result.llmManifestStatus ?? 'skipped'}`);
      for (const w of result.warnings.slice(0, 20)) err(`note: ${w}`);
      return EXIT_OK;
    }
    // Incomplete: loud failure, dir + marker kept (plan §6).
    err(`onbrand from-url: pipeline FAILED at stage "${result.stageFailed}" — ${result.error}`);
    err(`  INCOMPLETE proposal kept for forensics: ${result.proposalDir}`);
    err('  (see INCOMPLETE.md; partial evidence — screenshots/raw-extraction — is preserved)');
    return EXIT_FAILURE;
  } catch (e) {
    if (e instanceof FromUrlUsageError) {
      err(`onbrand from-url: ${e.message}`);
      return EXIT_USAGE;
    }
    if (e instanceof FromUrlEnvironmentError) {
      err(`onbrand from-url: ${e.message}`);
      return EXIT_ENVIRONMENT;
    }
    err(`onbrand from-url: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_FAILURE;
  }
}

// ---------------------------------------------------------------------------
// from-image
// ---------------------------------------------------------------------------

const FROMIMAGE_USAGE = `onbrand from-image <file> --title <title> --alt <alt> [options]

Measure one bounded local PNG/JPEG/WebP raster and create a reviewable proposal:

  onbrand-proposal-<image-slug>-<YYYYMMDD>[-b|-c...]/
    raw-image-analysis.json  deterministic measured evidence
    image-report.md          readable evidence report
    brand/                   tokens, trace, exact asset, dist, specimen, explanation

Required:
  --title <text>             operator-supplied artwork title
  --alt <text>               objective operator-supplied image description

Optional metadata:
  --creator <text>  --artwork-date <text>  --source-url <https-url>
  --rights <text>  --license-url <https-url>  --retrieved-at <YYYY-MM-DD>

Output:
  --out <dir>                proposal parent (default: current directory)
  --force                    reuse only the unsuffixed proposal directory
  --no-llm                   accepted compatibility no-op (image v1 invokes no model)
  --catalog-root <workspace> --catalog-out <file>
                              paired explicit post-success catalog refresh

Exit: 0 complete, 1 incomplete proposal kept, 2 usage error.
`;

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function workspaceRelativePath(root: string, candidate: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' ? '.' : relative.split(path.sep).join('/');
}

/**
 * Validate every catalog condition before `from-image` is allowed to create
 * its proposal. The exporter repeats these filesystem-safety checks when it
 * writes; this preflight keeps invalid paired flags side-effect free.
 */
function preflightFromImageCatalog(rootInput: string, outInput: string, proposalParent: string): {
  root: string;
  out: string;
} {
  const root = path.resolve(rootInput);
  if (!existsSync(root)) throw new FromImageUsageError(`--catalog-root ${JSON.stringify(rootInput)} does not exist`);
  if (!statSync(root).isDirectory()) throw new FromImageUsageError(`--catalog-root ${JSON.stringify(rootInput)} must be an existing directory`);
  if (!isPathWithin(root, proposalParent)) {
    throw new FromImageUsageError('--out must resolve inside --catalog-root when paired catalog flags are used');
  }

  const relativeParent = path.relative(root, proposalParent);
  const parentSegments = relativeParent === '' ? [] : relativeParent.split(path.sep);
  const excluded = new Set([
    'brand', 'node_modules', '.git', '.hg', '.svn', 'dist', 'assets', 'coverage',
    '.vscode', '.idea', '.next', '.cache', '.turbo',
  ]);
  if (parentSegments.some((segment) => excluded.has(segment.toLowerCase()))) {
    throw new FromImageUsageError('--out must not place a proposal below an excluded catalog directory');
  }
  // The proposal itself is one more directory level and must remain visible
  // to the bounded, explicit-root catalog discovery walk.
  if (parentSegments.length + 1 > 4) {
    throw new FromImageUsageError('--out is too deep below --catalog-root for bounded catalog discovery');
  }

  // This performs containment, symlink, regular-file, and excluded-output
  // validation without locking or writing anything.
  const outPath = resolveInspirationArtifactOutput(root, outInput);
  const out = path.isAbsolute(outInput) ? outPath : path.relative(root, outPath);
  const existing = buildInspirationArtifact({ root });
  if (existing.summary.discoveredTraceCount >= INSPIRATION_EXPORT_LIMITS.maxItems) {
    throw new FromImageUsageError(
      `--catalog-root already has ${existing.summary.discoveredTraceCount} inspiration traces; the bounded catalog allows ${INSPIRATION_EXPORT_LIMITS.maxItems}`,
    );
  }
  return { root, out };
}

async function runFromImageCommand(args: readonly string[], hooks: CliRuntimeHooks): Promise<number> {
  let input: string | undefined;
  let title: string | undefined;
  let alt: string | undefined;
  let outDir: string | undefined;
  let creator: string | undefined;
  let artworkDate: string | undefined;
  let sourceUrl: string | undefined;
  let rights: string | undefined;
  let licenseUrl: string | undefined;
  let retrievedAt: string | undefined;
  let catalogRoot: string | undefined;
  let catalogOut: string | undefined;
  let force = false;
  let noLlm = false;
  const takeValue = (flag: string, index: number): string | undefined => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('-')) {
      err(`onbrand from-image: ${flag} requires a value`);
      return undefined;
    }
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--title' || arg === '--alt' || arg === '--out' || arg === '--creator' ||
      arg === '--artwork-date' || arg === '--source-url' || arg === '--rights' ||
      arg === '--license-url' || arg === '--retrieved-at' || arg === '--catalog-root' || arg === '--catalog-out') {
      const value = takeValue(arg, i);
      if (value === undefined) return EXIT_USAGE;
      if (arg === '--title') title = value;
      else if (arg === '--alt') alt = value;
      else if (arg === '--out') outDir = value;
      else if (arg === '--creator') creator = value;
      else if (arg === '--artwork-date') artworkDate = value;
      else if (arg === '--source-url') sourceUrl = value;
      else if (arg === '--rights') rights = value;
      else if (arg === '--license-url') licenseUrl = value;
      else if (arg === '--retrieved-at') retrievedAt = value;
      else if (arg === '--catalog-root') catalogRoot = value;
      else catalogOut = value;
      i++;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--no-llm') {
      noLlm = true;
    } else if (arg === '-h' || arg === '--help') {
      out(FROMIMAGE_USAGE.trimEnd());
      return EXIT_OK;
    } else if (arg.startsWith('-')) {
      err(`onbrand from-image: unknown flag ${JSON.stringify(arg)}`);
      err('');
      err(FROMIMAGE_USAGE.trimEnd());
      return EXIT_USAGE;
    } else if (input === undefined) {
      input = arg;
    } else {
      err(`onbrand from-image: unexpected extra argument ${JSON.stringify(arg)}`);
      return EXIT_USAGE;
    }
  }
  if (input === undefined || title === undefined || alt === undefined) {
    err('onbrand from-image: <file>, --title, and --alt are required');
    err('');
    err(FROMIMAGE_USAGE.trimEnd());
    return EXIT_USAGE;
  }
  if ((catalogRoot === undefined) !== (catalogOut === undefined)) {
    err('onbrand from-image: --catalog-root and --catalog-out must be supplied together');
    return EXIT_USAGE;
  }

  let catalog: { root: string; out: string } | undefined;
  if (catalogRoot !== undefined && catalogOut !== undefined) {
    try {
      catalog = preflightFromImageCatalog(catalogRoot, catalogOut, path.resolve(outDir ?? '.'));
    } catch (cause) {
      err(`onbrand from-image: ${cause instanceof Error ? cause.message : String(cause)}`);
      return cause instanceof FromImageUsageError ? EXIT_USAGE : EXIT_FAILURE;
    }
  }

  const options: RunFromImageOptions = {
    title,
    alt,
    ...(outDir !== undefined ? { outDir } : {}),
    ...(creator !== undefined ? { creator } : {}),
    ...(artworkDate !== undefined ? { artworkDate } : {}),
    ...(sourceUrl !== undefined ? { sourceUrl } : {}),
    ...(rights !== undefined ? { rights } : {}),
    ...(licenseUrl !== undefined ? { licenseUrl } : {}),
    ...(retrievedAt !== undefined ? { retrievedAt } : {}),
    force,
    noLlm,
  };
  // Test seam shared with from-url: makes proposal names/reports deterministic
  // through the spawned production CLI without influencing normal use.
  const fakeNow = process.env.ONBRAND_NOW;
  if (fakeNow !== undefined && fakeNow !== '') {
    const pinned = new Date(fakeNow);
    if (!Number.isNaN(pinned.getTime())) options.now = () => pinned;
  }
  if (catalog !== undefined) {
    const configuredCatalog = catalog;
    if (hooks.beforeFromImageCatalogRefresh !== undefined) {
      options.beforeCatalogRefresh = hooks.beforeFromImageCatalogRefresh;
    }
    options.refreshCatalog = (proposalDir) => {
      const expectedRelPath = workspaceRelativePath(configuredCatalog.root, proposalDir);
      exportInspirationArtifact({
        root: configuredCatalog.root,
        out: configuredCatalog.out,
        ...(options.now !== undefined ? { now: options.now } : {}),
        assertArtifact: (artifact) => {
          const matching = artifact.items.filter((item) => item.relPath === expectedRelPath);
          if (matching.length === 0 && artifact.summary.itemsTruncated) {
            throw new InspirationCatalogError(
              `the completed proposal ${expectedRelPath} was omitted from the bounded inspiration catalog ` +
                `(${artifact.summary.discoveredTraceCount} discovered; ${artifact.summary.emittedItemCount} emitted)`,
              {
                kind: 'manual',
                instruction:
                  `catalog capacity requires operator action: reduce ${configuredCatalog.root} to at most ` +
                  `${INSPIRATION_EXPORT_LIMITS.maxItems} discoverable inspiration traces, then rerun inspiration-export.`,
              },
            );
          }
          if (matching.length !== 1) {
            throw new Error('the completed proposal is not represented exactly once in the bounded inspiration catalog');
          }
          const item = matching[0]!;
          if (item.traceState !== 'available' || item.standalonePath === undefined || item.specimenPath === undefined) {
            throw new Error('the completed proposal does not have current standalone and specimen views in the inspiration catalog');
          }
        },
      });
    };
  }

  try {
    const result = await runFromImage(input, options);
    if (result.status === 'complete') {
      out(`Wrote proposal: ${result.proposalDir}`);
      out(`  brand set:  ${result.brandDir}  (review before adoption)`);
      if (result.reportPath !== undefined) out(`  report:     ${result.reportPath}`);
      return EXIT_OK;
    }
    if (result.status === 'catalog-failed') {
      out(`Wrote proposal: ${result.proposalDir}`);
      out(`  brand set:  ${result.brandDir}  (review before adoption)`);
      if (result.reportPath !== undefined) out(`  report:     ${result.reportPath}`);
      err(`onbrand from-image: catalog refresh FAILED — ${result.error}`);
      err('  The proposal is complete; catalog refresh is pending.');
      return EXIT_FAILURE;
    }
    err(`onbrand from-image: pipeline FAILED at stage "${result.stageFailed}" â€” ${result.error}`);
    err(`  INCOMPLETE proposal kept for forensics: ${result.proposalDir}`);
    return EXIT_FAILURE;
  } catch (cause) {
    if (cause instanceof FromImageUsageError) {
      err(`onbrand from-image: ${cause.message}`);
      return EXIT_USAGE;
    }
    err(`onbrand from-image: ${cause instanceof Error ? cause.message : String(cause)}`);
    return EXIT_FAILURE;
  }
}

// ---------------------------------------------------------------------------
// inspiration-export (Step 27: bounded producer-side trace catalog)
// ---------------------------------------------------------------------------

const INSPIRATION_EXPORT_USAGE = `onbrand inspiration-export --root <workspace> [--out <file>] [--recover-stale-lock]

Write one bounded, versioned inspiration-to-implementation catalog from local
On Brand projects. It reads existing files only: it never rebuilds a brand or
invokes Dev Observatory.

Flags:
  --root <workspace>       REQUIRED explicit workspace root to scan
  --out <file>             catalog path inside the root
                            (default: .observatory/inspiration-to-implementation.json)
  --recover-stale-lock     remove one verified dead lock older than 15 minutes,
                            then continue the refresh

Exit: 0 ok, 1 export/write/lock failure, 2 usage error.
`;

function runInspirationExport(args: readonly string[]): number {
  let root: string | undefined;
  let outFile: string | undefined;
  let recoverStaleLock = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--root' || arg === '--out') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) {
        err(`onbrand inspiration-export: ${arg} requires a ${arg === '--root' ? 'workspace directory' : 'file path'}`);
        return EXIT_USAGE;
      }
      if (arg === '--root') root = value;
      else outFile = value;
      index++;
    } else if (arg === '--recover-stale-lock') {
      recoverStaleLock = true;
    } else if (arg === '-h' || arg === '--help') {
      out(INSPIRATION_EXPORT_USAGE.trimEnd());
      return EXIT_OK;
    } else if (arg.startsWith('-')) {
      err(`onbrand inspiration-export: unknown flag ${JSON.stringify(arg)}`);
      err('');
      err(INSPIRATION_EXPORT_USAGE.trimEnd());
      return EXIT_USAGE;
    } else {
      err(`onbrand inspiration-export: unexpected extra argument ${JSON.stringify(arg)}`);
      return EXIT_USAGE;
    }
  }

  if (root === undefined) {
    err('onbrand inspiration-export: --root <workspace> is required (discovery never scans implicitly)');
    err('');
    err(INSPIRATION_EXPORT_USAGE.trimEnd());
    return EXIT_USAGE;
  }
  const resolvedRoot = path.resolve(root);
  if (!existsSync(resolvedRoot)) {
    err(`onbrand inspiration-export: --root ${JSON.stringify(root)} does not exist`);
    return EXIT_USAGE;
  }
  if (!statSync(resolvedRoot).isDirectory()) {
    err(`onbrand inspiration-export: --root ${JSON.stringify(root)} must be an existing directory`);
    return EXIT_USAGE;
  }
  try {
    // Validate before a possible recovery mutation, preserving the old catalog
    // and lock when the requested destination is unsafe.
    resolveInspirationArtifactOutput(resolvedRoot, outFile);
  } catch (cause) {
    err(`onbrand inspiration-export: ${cause instanceof Error ? cause.message : String(cause)}`);
    return EXIT_USAGE;
  }

  const fakeNow = process.env.ONBRAND_NOW;
  const pinned = fakeNow === undefined || fakeNow === '' ? undefined : new Date(fakeNow);
  const now = pinned === undefined || Number.isNaN(pinned.getTime()) ? undefined : () => pinned;
  const exportOptions = {
    root: resolvedRoot,
    ...(outFile !== undefined ? { out: outFile } : {}),
    ...(now !== undefined ? { now } : {}),
  };
  if (recoverStaleLock) {
    const recovery = recoverStaleInspirationExportLock(exportOptions);
    if (!recovery.recovered && recovery.alreadyClear !== true) {
      err(`onbrand inspiration-export: stale lock was not recovered (${recovery.reason ?? 'unknown reason'})`);
      return EXIT_FAILURE;
    }
    if (recovery.recovered) out(`Recovered stale lock: ${recovery.lockPath}`);
    else out(`No stale lock remains at ${recovery.lockPath}; continuing the catalog refresh.`);
  }

  const result = exportInspirationArtifact(exportOptions);
  out(`Wrote ${result.outPath}`);
  out(
    `  schema ${result.artifact.schema} v${result.artifact.schemaVersion}; ` +
      `${result.artifact.summary.emittedItemCount}/${result.artifact.summary.discoveredTraceCount} trace item(s); ${result.bytes} bytes`,
  );
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// brands (Step 17: explicit-root discovery + classification)
// ---------------------------------------------------------------------------

const BRANDS_USAGE = `onbrand brands list|show --root <workspace> [--json]

Discover every valid brand/ file-set under an EXPLICIT workspace root (bounded
depth + excludes; dist/ and assets/ are never crawled) and classify each into:
  adopted     valid, non-proposal brand with a FRESH committed dist/ (final)
  proposal    valid from-url proposal with a built dist/ (visibly NOT final)
  incomplete  a proposal that did not finish (INCOMPLETE.md) or has no dist yet
  stale       adopted brand whose dist/ is missing/drifted from its sources
  invalid     brand/tokens.json that fails to load or validate

Subcommands:
  list                     list every discovered brand and its status
  show <name-or-relPath>   show one brand in detail (omit when exactly one exists)

Flags:
  --root <workspace>   REQUIRED explicit workspace root to scan
  --json               emit machine-readable JSON instead of a text table

Exit: 0 ok, 2 usage error (missing --root / bad selector / no match).
`;

interface BrandsArgs {
  sub?: string;
  root?: string;
  selector?: string;
  json: boolean;
}

function parseBrandsArgs(args: readonly string[]): BrandsArgs | number {
  const parsed: BrandsArgs = { json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--root') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) {
        err('onbrand brands: --root requires a workspace directory');
        return EXIT_USAGE;
      }
      parsed.root = value;
      i++;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '-h' || arg === '--help') {
      out(BRANDS_USAGE.trimEnd());
      return EXIT_OK;
    } else if (arg.startsWith('-')) {
      err(`onbrand brands: unknown flag ${JSON.stringify(arg)}`);
      err('');
      err(BRANDS_USAGE.trimEnd());
      return EXIT_USAGE;
    } else if (parsed.sub === undefined) {
      parsed.sub = arg;
    } else if (parsed.selector === undefined) {
      parsed.selector = arg;
    } else {
      err(`onbrand brands: unexpected extra argument ${JSON.stringify(arg)}`);
      return EXIT_USAGE;
    }
  }
  return parsed;
}

/** JSON-safe projection of a discovered brand (drops absolute-path noise last). */
function brandToJson(brand: DiscoveredBrand): Record<string, unknown> {
  return {
    name: brand.name,
    relPath: brand.relPath,
    status: brand.status,
    final: brand.final,
    provenance: brand.provenance,
    hasTokens: brand.hasTokens,
    hasDist: brand.hasDist,
    incompleteMarker: brand.incompleteMarker,
    reason: brand.reason,
    root: brand.root,
    brandDir: brand.brandDir,
    ...(brand.error !== undefined ? { error: brand.error } : {}),
  };
}

function runBrands(args: readonly string[]): number {
  const parsed = parseBrandsArgs(args);
  if (typeof parsed === 'number') return parsed;

  const { sub, root, selector, json } = parsed;
  if (sub !== 'list' && sub !== 'show') {
    err(
      sub === undefined
        ? 'onbrand brands: missing subcommand (expected "list" or "show")'
        : `onbrand brands: unknown subcommand ${JSON.stringify(sub)} (expected "list" or "show")`,
    );
    err('');
    err(BRANDS_USAGE.trimEnd());
    return EXIT_USAGE;
  }
  if (root === undefined) {
    err('onbrand brands: --root <workspace> is required (discovery never scans implicitly)');
    err('');
    err(BRANDS_USAGE.trimEnd());
    return EXIT_USAGE;
  }
  const resolvedRoot = path.resolve(root);
  if (!existsSync(resolvedRoot)) {
    err(`onbrand brands: --root ${JSON.stringify(root)} does not exist`);
    return EXIT_USAGE;
  }
  if (!statSync(resolvedRoot).isDirectory()) {
    err(`onbrand brands: --root ${JSON.stringify(root)} must be an existing directory`);
    return EXIT_USAGE;
  }

  const result: DiscoverResult = discoverBrands(root);

  if (sub === 'list') {
    return json ? emitBrandsListJson(result) : emitBrandsListText(result);
  }
  return json ? runBrandsShow(result, selector, true) : runBrandsShow(result, selector, false);
}

function emitBrandsListJson(result: DiscoverResult): number {
  out(
    JSON.stringify(
      { root: result.root, count: result.brands.length, brands: result.brands.map(brandToJson) },
      null,
      2,
    ),
  );
  return EXIT_OK;
}

function emitBrandsListText(result: DiscoverResult): number {
  out(`onbrand brands — ${result.brands.length} brand set(s) under ${result.root}`);
  if (result.brands.length === 0) {
    out('  (none found — pass a workspace that contains one or more brand/ directories)');
    return EXIT_OK;
  }
  out('');
  out('  STATUS      FINAL  RELPATH');
  for (const b of result.brands) {
    const status = b.status.padEnd(10);
    const final = (b.final ? 'yes' : 'no').padEnd(5);
    out(`  ${status}  ${final}  ${b.relPath}`);
  }
  return EXIT_OK;
}

function runBrandsShow(result: DiscoverResult, selector: string | undefined, json: boolean): number {
  const { brands } = result;
  let brand: DiscoveredBrand | undefined;

  if (selector === undefined) {
    if (brands.length === 1) {
      brand = brands[0];
    } else if (brands.length === 0) {
      err(`onbrand brands show: no brand sets found under ${result.root}`);
      return EXIT_USAGE;
    } else {
      err(
        `onbrand brands show: ${brands.length} brand sets found — name one: ${brands
          .map((b) => b.relPath)
          .join(', ')}`,
      );
      return EXIT_USAGE;
    }
  } else {
    const relPathMatch = brands.find((b) => b.relPath === selector);
    const nameMatches = brands.filter((b) => b.name === selector);
    if (relPathMatch !== undefined) {
      brand = relPathMatch;
    } else if (nameMatches.length === 1) {
      brand = nameMatches[0];
    } else if (nameMatches.length > 1) {
      err(
        `onbrand brands show: ${JSON.stringify(selector)} is ambiguous — name one by relPath: ${nameMatches
          .map((b) => b.relPath)
          .join(', ')}`,
      );
      return EXIT_USAGE;
    } else {
      err(
        `onbrand brands show: no brand matches ${JSON.stringify(selector)} (known: ${
          brands.map((b) => b.relPath).join(', ') || 'none'
        })`,
      );
      return EXIT_USAGE;
    }
  }

  if (json) {
    out(JSON.stringify(brandToJson(brand!), null, 2));
    return EXIT_OK;
  }

  const b = brand!;
  out(`onbrand brand — ${b.relPath}`);
  out(`  status:      ${b.status}${b.final ? ' (final)' : ''}`);
  out(`  provenance:  ${b.provenance}`);
  out(`  brand dir:   ${b.brandDir}`);
  out(`  has tokens:  ${b.hasTokens ? 'yes' : 'no'}`);
  out(`  has dist:    ${b.hasDist ? 'yes' : 'no'}`);
  out(`  incomplete:  ${b.incompleteMarker ? 'yes (INCOMPLETE.md marker)' : 'no'}`);
  out(`  reason:      ${b.reason}`);
  if (b.error !== undefined) out(`  error:       ${b.error}`);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// gallery (Step 18: static list/detail gallery over discovered brands)
// ---------------------------------------------------------------------------

const GALLERY_USAGE = `onbrand gallery --root <workspace> [--out <file>] [--open]

Discover every valid brand/ file-set under an EXPLICIT workspace root (Step 17
discovery: bounded depth + excludes; dist/ and assets/ are never crawled) and
write ONE static, responsive list/detail gallery HTML file over them. Each brand
shows its provenance, freshness, token groups, dark-mode availability, and check
state; a final (adopted) brand links to its built specimen. A proposal is NEVER
presented as the final brand.

The command writes only the gallery file — it never rebuilds a brand. It links a
brand/dist/specimen.html only when one already exists (run "onbrand build" then
"onbrand preview" in a brand to produce one).

Flags:
  --root <workspace>   REQUIRED explicit workspace root to scan
  --out <file>         gallery HTML path (default: <root>/onbrand-gallery.html)
  --open               open the generated gallery in your default browser

Exit: 0 ok, 1 write failure, 2 usage error (missing --root / bad flag).
`;

function runGallery(args: readonly string[]): number {
  let root: string | undefined;
  let outFile: string | undefined;
  let open = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--root') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) {
        err('onbrand gallery: --root requires a workspace directory');
        return EXIT_USAGE;
      }
      root = value;
      i++;
    } else if (arg === '--out') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) {
        err('onbrand gallery: --out requires a file path');
        return EXIT_USAGE;
      }
      outFile = value;
      i++;
    } else if (arg === '--open') {
      open = true;
    } else if (arg === '-h' || arg === '--help') {
      out(GALLERY_USAGE.trimEnd());
      return EXIT_OK;
    } else if (arg.startsWith('-')) {
      err(`onbrand gallery: unknown flag ${JSON.stringify(arg)}`);
      err('');
      err(GALLERY_USAGE.trimEnd());
      return EXIT_USAGE;
    } else {
      err(`onbrand gallery: unexpected extra argument ${JSON.stringify(arg)}`);
      return EXIT_USAGE;
    }
  }

  if (root === undefined) {
    err('onbrand gallery: --root <workspace> is required (discovery never scans implicitly)');
    err('');
    err(GALLERY_USAGE.trimEnd());
    return EXIT_USAGE;
  }
  const resolvedRoot = path.resolve(root);
  if (!existsSync(resolvedRoot)) {
    err(`onbrand gallery: --root ${JSON.stringify(root)} does not exist`);
    return EXIT_USAGE;
  }
  if (!statSync(resolvedRoot).isDirectory()) {
    err(`onbrand gallery: --root ${JSON.stringify(root)} must be an existing directory`);
    return EXIT_USAGE;
  }

  const result = generateGallery({
    root,
    ...(outFile !== undefined ? { out: outFile } : {}),
  });

  out(`Wrote ${result.outPath}`);
  out(
    `  ${result.brandCount} brand set(s) — ${result.finalCount} final, ${result.model.proposalCount} proposal`,
  );
  out('Open it in a browser to browse the list/detail gallery.');
  if (open) {
    openInBrowser(result.outPath, {
      onError: (message) => err(`onbrand gallery: ${message}`),
    });
    out('Opening in your default browser...');
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// observatory-export (Step 21: bounded gallery/check artifact only)
// ---------------------------------------------------------------------------

const OBSERVATORY_EXPORT_USAGE = `onbrand observatory-export --root <workspace> [--out <file>]

Write one bounded, versioned JSON artifact containing the discovered brand
list/detail data plus structured check findings. It reads existing brand files
only: it never rebuilds consumers, opens a browser, imports dev-observatory, or
changes observatory labels/registry wiring.

Flags:
  --root <workspace>   REQUIRED explicit workspace root to scan
  --out <file>         artifact path (default: <root>/onbrand-observatory.json)

Exit: 0 ok, 1 export/write failure, 2 usage error (missing --root / bad flag).
`;

function runObservatoryExport(args: readonly string[]): number {
  let root: string | undefined;
  let outFile: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--root') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) {
        err('onbrand observatory-export: --root requires a workspace directory');
        return EXIT_USAGE;
      }
      root = value;
      i++;
    } else if (arg === '--out') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) {
        err('onbrand observatory-export: --out requires a file path');
        return EXIT_USAGE;
      }
      outFile = value;
      i++;
    } else if (arg === '-h' || arg === '--help') {
      out(OBSERVATORY_EXPORT_USAGE.trimEnd());
      return EXIT_OK;
    } else if (arg.startsWith('-')) {
      err(`onbrand observatory-export: unknown flag ${JSON.stringify(arg)}`);
      err('');
      err(OBSERVATORY_EXPORT_USAGE.trimEnd());
      return EXIT_USAGE;
    } else {
      err(`onbrand observatory-export: unexpected extra argument ${JSON.stringify(arg)}`);
      return EXIT_USAGE;
    }
  }

  if (root === undefined) {
    err('onbrand observatory-export: --root <workspace> is required (discovery never scans implicitly)');
    err('');
    err(OBSERVATORY_EXPORT_USAGE.trimEnd());
    return EXIT_USAGE;
  }
  const resolvedRoot = path.resolve(root);
  if (!existsSync(resolvedRoot)) {
    err(`onbrand observatory-export: --root ${JSON.stringify(root)} does not exist`);
    return EXIT_USAGE;
  }
  if (!statSync(resolvedRoot).isDirectory()) {
    err(`onbrand observatory-export: --root ${JSON.stringify(root)} must be an existing directory`);
    return EXIT_USAGE;
  }

  const result = exportObservatoryArtifact({
    root,
    ...(outFile !== undefined ? { out: outFile } : {}),
  });
  out(`Wrote ${result.outPath}`);
  out(
    `  schema ${result.artifact.schema} v${result.artifact.schemaVersion}; ` +
      `${result.artifact.summary.emittedBrandCount}/${result.artifact.summary.discoveredBrandCount} brand set(s); ${result.bytes} bytes`,
  );
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
const PROTECTED_BRAND_FILES = ['tokens.json', 'modes.dark.json', 'guide.md'] as const;

function runInit(args: readonly string[]): number {
  let dir: string | undefined;
  let preset = 'default';
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--force') {
      force = true;
    } else if (arg === '--preset') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) {
        err('onbrand init: --preset requires a value');
        return EXIT_USAGE;
      }
      preset = value;
      i++;
    } else if (arg === '-h' || arg === '--help') {
      out(INIT_USAGE.trimEnd());
      return EXIT_OK;
    } else if (arg.startsWith('-')) {
      err(`onbrand init: unknown flag ${JSON.stringify(arg)}`);
      err('');
      err(INIT_USAGE.trimEnd());
      return EXIT_USAGE;
    } else if (dir === undefined) {
      dir = arg;
    } else {
      err(`onbrand init: unexpected extra argument ${JSON.stringify(arg)}`);
      return EXIT_USAGE;
    }
  }

  const presetsRoot = defaultPresetsRoot();
  const presetDir = path.join(presetsRoot, preset);
  const presetTokensPath = path.join(presetDir, 'tokens.json');
  const presetModesPath = path.join(presetDir, 'modes.dark.json');
  if (!existsSync(presetTokensPath) || !existsSync(presetModesPath)) {
    err(
      `onbrand init: unknown preset ${JSON.stringify(preset)} (available: ${listPresets(presetsRoot).join(', ') || 'none'})`,
    );
    return EXIT_USAGE;
  }

  const targetDir = path.resolve(dir ?? '.');
  const brandDir = path.join(targetDir, 'brand');

  // Never-clobber contract: check BEFORE writing anything (plan.md §3.1).
  const existing = PROTECTED_BRAND_FILES.filter((f) => existsSync(path.join(brandDir, f)));
  if (existing.length > 0 && !force) {
    err(
      `onbrand init: refusing to overwrite existing ${existing.join(', ')} in ${brandDir} — re-run with --force to overwrite`,
    );
    return EXIT_FAILURE;
  }

  // Defense-in-depth: a preset that fails its own schema is a bug; refuse to
  // scaffold garbage.
  const presetTokensDoc = readJsonFile(presetTokensPath);
  const tokensResult = validate(presetTokensDoc, { kind: 'tokens' });
  if (!tokensResult.ok || tokensResult.document === undefined) {
    err(`onbrand init: preset ${JSON.stringify(preset)} tokens.json is invalid (bug in the preset):`);
    err(formatIssues(tokensResult.issues));
    return EXIT_FAILURE;
  }
  const presetModesDoc = readJsonFile(presetModesPath);
  const overlayResult = applyModeOverlay(tokensResult.document, presetModesDoc);
  if (!overlayResult.ok) {
    err(`onbrand init: preset ${JSON.stringify(preset)} modes.dark.json is invalid (bug in the preset):`);
    err(formatIssues(overlayResult.issues));
    return EXIT_FAILURE;
  }

  const guideTemplate = readFileSync(
    path.join(packageRoot(), 'templates', 'guide.template.md'),
    'utf8',
  );
  const projectName = path.basename(targetDir);
  const guide = guideTemplate.replaceAll('{{PROJECT_NAME}}', projectName);

  const assetsDir = path.join(brandDir, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  const gitkeepPath = path.join(assetsDir, '.gitkeep');
  if (!existsSync(gitkeepPath)) {
    writeFileSync(gitkeepPath, '', 'utf8');
  }

  // Stage-then-rename so a mid-init failure (AV lock, EBUSY, disk-full) never
  // leaves a half-written protected file that a later init would refuse as
  // "existing". Content is written to temp siblings first; the renames into
  // place are per-file atomic (each final is either fully old or fully new).
  // On failure: temp files are always removed, and on a FRESH scaffold (no
  // --force, nothing pre-existing) any finals already renamed are removed too,
  // returning brand/ to its empty state.
  // Preset files are copied byte-for-byte (deterministic source for Step 2 hashing).
  const writes: Array<{ final: string; content: string }> = [
    { final: path.join(brandDir, 'tokens.json'), content: readFileSync(presetTokensPath, 'utf8') },
    { final: path.join(brandDir, 'modes.dark.json'), content: readFileSync(presetModesPath, 'utf8') },
    { final: path.join(brandDir, 'guide.md'), content: guide },
  ];
  const tmpSuffix = `.onbrand-tmp-${process.pid}`;
  const renamed: string[] = [];
  try {
    for (const w of writes) {
      writeFileSync(`${w.final}${tmpSuffix}`, w.content, 'utf8');
    }
    for (const w of writes) {
      renameSync(`${w.final}${tmpSuffix}`, w.final);
      renamed.push(w.final);
    }
  } catch (cause) {
    for (const w of writes) {
      rmSync(`${w.final}${tmpSuffix}`, { force: true });
    }
    if (existing.length === 0) {
      // fresh scaffold: leave no partial brand/ behind
      for (const f of renamed) {
        rmSync(f, { force: true });
      }
    }
    throw new Error(
      `failed while writing ${brandDir} (${cause instanceof Error ? cause.message : String(cause)}) — ` +
        (existing.length === 0
          ? 'partial files were cleaned up; re-run init'
          : 'each brand file is either fully old or fully new; re-run init --force'),
    );
  }

  out(`Scaffolded brand/ from preset "${preset}":`);
  for (const f of [...PROTECTED_BRAND_FILES, path.join('assets', '.gitkeep')]) {
    out(`  ${path.join(brandDir, f)}`);
  }
  out('Next: fill in the TODO sections of brand/guide.md and edit brand/tokens.json;');
  out('run "onbrand build" to generate brand/dist/.');
  return EXIT_OK;
}

function listPresets(presetsRoot: string): string[] {
  if (!existsSync(presetsRoot)) return [];
  return readdirSync(presetsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(path.join(presetsRoot, entry.name, 'tokens.json')))
    .map((entry) => entry.name)
    .sort();
}
