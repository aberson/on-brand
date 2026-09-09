/**
 * `onbrand from-url` orchestrator (plan.md §3.2, §5, §6; Step 12).
 *
 * Wires the full pipeline: engine -> normalize -> llm -> build all emitters into
 * a proposal dir + a DRAFT guide.md + extraction-report.md.
 *
 *   <outDir>/onbrand-proposal-<host>-<YYYYMMDD>[-b|-c...]/
 *     brand/                  <- a full brand/-shaped set (adopt = copy into <project>/brand/)
 *       tokens.json  modes.dark.json  guide.md  assets/  dist/
 *     raw-extraction.json     <- the engine's RawExtraction (evidence)
 *     extraction-report.md    <- screenshots, clusters, confidence, candidates, fonts
 *     INCOMPLETE.md           <- ONLY when a stage died (removed on success)
 *
 * The brand set lives in a `brand/` SUBDIR so the existing build/check machinery
 * runs unchanged (compileBrand(proposalDir) reads proposalDir/brand) and adoption
 * is one directory copy. The report + marker sit at the proposal root.
 *
 * ----------------------------------------------------------- INCOMPLETE marker ---
 * The marker is written BEFORE the pipeline starts and DELETED only on full
 * success — so even a hard kill (SIGKILL, power loss) mid-run leaves the marker
 * in place with whatever partial evidence was captured (plan §6: "fails loud,
 * reporting which stage died and keeping partial evidence"). It is NOT written in
 * a catch block alone, which an uncatchable kill would skip. Extraction never
 * retries silently (§6): a stage failure is surfaced, not re-attempted.
 *
 * ----------------------------------------------------------------- determinism ---
 * The date in the proposal dir name is INJECTED (`now`, default system clock) so
 * tests pin it — Date.now() never leaks into the output name. The same clock
 * drives compileBrand's manifest timestamp and the report's "generated at", so a
 * whole proposal is a pure function of (extraction, clock, --no-llm).
 *
 * ----------------------------------------------------------------- SECURITY -----
 * Site-derived content is UNTRUSTED. report.ts escapes it for the markdown
 * surface; the css/guide emitters escape it for their contexts; llm.ts is the
 * injection firewall for the LLM passes. This module never interpolates raw
 * site text into a shell or a path (screenshot filenames are basename-only and
 * copied by us; the proposal dir name is a sanitized host slug). No literal
 * control bytes in this source (repo text-hygiene gate).
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { compileBrand } from '../build/compile.ts';
import type { LlmManifestStatus } from './llm.ts';
import { runLlmAssist, type ClaudeSpawner } from './llm.ts';
import { buildTokensForSeed, normalize } from './normalize.ts';
import {
  mdText,
  renderExtractionReport,
  renderGuideDraft,
  type ReportScreenshot,
} from './report.ts';
import { DembrandtEngine } from './engine/dembrandt.ts';
import type { ExtractionEngine, RawExtraction, Screenshot } from './engine/adapter.ts';

/** Thrown for a usage-class problem (bad flags/url, too many same-day dirs) -> exit 2. */
export class FromUrlUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FromUrlUsageError';
  }
}

/** Thrown when the extraction environment is missing (dembrandt/Chromium) -> exit 3. */
export class FromUrlEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FromUrlEnvironmentError';
  }
}

export type FromUrlStage = 'extract' | 'normalize' | 'llm' | 'build' | 'report';

export interface FromUrlResult {
  status: 'complete' | 'incomplete';
  /** Absolute proposal dir path (created even on an incomplete run). */
  proposalDir: string;
  /** Absolute proposalDir/brand path (the adoptable brand set). */
  brandDir: string;
  /** Present when complete: absolute extraction-report.md path. */
  reportPath?: string;
  /** Present when incomplete: which stage died. */
  stageFailed?: FromUrlStage;
  /** Present when incomplete: the stage's error message (control-stripped). */
  error?: string;
  /** Manifest llm status ('used' | 'skipped'), present once the LLM stage ran. */
  llmManifestStatus?: LlmManifestStatus;
  warnings: string[];
}

export interface RunFromUrlOptions {
  /** Output root (default cwd). The proposal dir is created under it. */
  outDir?: string;
  /** Pages to crawl + merge (default 1). */
  pages?: number;
  /** Also capture a dark variant. */
  dark?: boolean;
  /** Heuristics-only: skip the LLM passes (manifest llm:"skipped"). */
  noLlm?: boolean;
  /** Reuse/overwrite the base proposal dir name instead of auto-disambiguating. */
  force?: boolean;
  /** Injected extraction engine (default DembrandtEngine; tests inject a stand-in). */
  engine?: ExtractionEngine;
  /** Injected clock (default system now) — pins the proposal-dir date in tests. */
  now?: () => Date;
  /** Engine per-run wall-clock budget (ms). */
  timeoutMs?: number;
  /** Preset resolution root override (tests). */
  presetsRoot?: string;
  /** LLM subprocess seam + tuning (tests inject a fake spawner). */
  llm?: {
    spawn?: ClaudeSpawner;
    claudeCommand?: string;
    timeoutMs?: number;
    extraArgs?: string[];
  };
  /** Base dir to resolve a fixture engine's relative screenshot paths against. */
  screenshotBase?: string;
}

/**
 * A fixture engine that reads a committed RawExtraction JSON at extract() time
 * (the adapter seam the offline tests + the ONBRAND_FAKE_EXTRACTION env seam use
 * in place of live dembrandt+Chromium). Reading lazily inside extract() means a
 * missing/invalid fixture surfaces as an EXTRACT-stage failure (INCOMPLETE), not
 * a pre-pipeline throw — exactly a stand-in for a dead engine.
 */
export class FixtureEngine implements ExtractionEngine {
  readonly name = 'fixture';

  constructor(
    private readonly fixturePath: string,
    private readonly screenshotBase: string,
  ) {}

  async extract(): Promise<RawExtraction> {
    const raw = JSON.parse(readFileSync(this.fixturePath, 'utf8')) as RawExtraction;
    // Resolve relative screenshot paths against the base so downstream copy works
    // regardless of the process cwd (fixtures reference repo-relative PNGs).
    const screenshots: Screenshot[] = (raw.screenshots ?? []).map((s) => ({
      ...s,
      path: path.isAbsolute(s.path) ? s.path : path.join(this.screenshotBase, s.path),
    }));
    return { ...raw, screenshots };
  }
}

// --- helpers -----------------------------------------------------------------

/** Strip control bytes (code < 0x20 / DEL) to spaces; char-code walk (hygiene). */
function oneLine(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out += code < 0x20 || code === 0x7f ? ' ' : text[i]!;
  }
  return out.trim();
}

/** Sanitized host slug from a URL. MIRRORS dembrandt's hostname-sanitize rule
 * (hostname, non-[a-z0-9.-] -> "_") rather than sharing it: dembrandt's is a
 * one-line inline regex on a pre-validated http(s) URL (engine/dembrandt.ts),
 * while this adds a schemeless-URL retry + empty-string fallback its call site
 * doesn't need — a shared 3-line util would be over-engineering for a repo that
 * keeps such helpers local (cf. llm.ts sanitizeText). Char-code walk (no regex
 * escape classes); a wholly-unparseable url falls back to a slug of the raw text. */
export function hostSlug(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    try {
      host = new URL(`https://${url}`).hostname;
    } catch {
      host = url;
    }
  }
  let out = '';
  for (const ch of host.toLowerCase()) {
    const code = ch.charCodeAt(0);
    const ok =
      (code >= 0x61 && code <= 0x7a) || // a-z
      (code >= 0x30 && code <= 0x39) || // 0-9
      ch === '.' ||
      ch === '-';
    out += ok ? ch : '_';
  }
  return out === '' ? 'site' : out;
}

/** YYYYMMDD (UTC) of a Date — cross-machine deterministic for pinned test clocks. */
export function dateStamp(date: Date): string {
  const y = date.getUTCFullYear().toString().padStart(4, '0');
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * Resolve the proposal dir: base name, or the first free `-b`/`-c`... under
 * never-clobber (plan §3.2). `--force` reuses the base name (writing over it).
 */
export function resolveProposalDir(
  outDir: string,
  host: string,
  stamp: string,
  force: boolean,
): string {
  const base = path.join(outDir, `onbrand-proposal-${host}-${stamp}`);
  if (force) return base;
  if (!existsSync(base)) return base;
  for (let i = 1; i <= 24; i++) {
    const suffix = String.fromCharCode(0x61 + i); // 'b' (i=1) .. 'y' (i=24)
    const candidate = `${base}-${suffix}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new FromUrlUsageError(
    `too many same-day proposals for "${host}" (${base}-b .. -y all exist) — remove some or pass --force`,
  );
}

function markerContent(host: string, url: string, stage: string, detail?: string): string {
  // INCOMPLETE.md is a second markdown-surface this module writes, so route the
  // potentially-untrusted fields (url; detail, which may echo an engine/site error
  // in future) through mdText() — the same markdown output-context firewall
  // report.ts uses — not just oneLine's control-strip. `host` is our own sanitized
  // slug and `stage` is fixed vocabulary, so oneLine suffices for those.
  const lines = [
    '# INCOMPLETE proposal',
    '',
    'This `onbrand from-url` run did not finish. The directory is kept for forensics',
    'and partial evidence (extraction never retries silently — plan §6).',
    '',
    `- Source: ${mdText(url)}`,
    `- Host: ${oneLine(host)}`,
    `- Stage reached: ${oneLine(stage)}`,
  ];
  if (detail !== undefined) lines.push(`- Detail: ${mdText(detail)}`);
  lines.push('', 'Re-run `onbrand from-url <url>` to try again.', '');
  return lines.join('\n');
}

/** Copy each screenshot into brandDir/assets and return report-relative refs. */
function materializeScreenshots(
  extraction: RawExtraction,
  assetsDir: string,
): ReportScreenshot[] {
  const used = new Set<string>();
  const out: ReportScreenshot[] = [];
  for (const shot of extraction.screenshots) {
    if (!existsSync(shot.path)) continue; // no PNG on disk: nothing to reference
    let base = path.basename(shot.path);
    if (used.has(base)) {
      const ext = path.extname(base);
      base = `${path.basename(base, ext)}-${used.size + 1}${ext}`;
    }
    used.add(base);
    const dest = path.join(assetsDir, base);
    const destResolved = path.resolve(dest);
    const srcResolved = path.resolve(shot.path);
    if (srcResolved !== destResolved) copyFileSync(srcResolved, destResolved);
    out.push({ label: shot.label, relPath: `brand/assets/${base}` });
  }
  return out;
}

/** Write file content atomically (temp sibling + rename), mirroring compile.ts. */
function writeAtomic(absPath: string, content: string): void {
  const tmp = `${absPath}.onbrand-tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, absPath);
  } catch (cause) {
    rmSync(tmp, { force: true });
    throw cause;
  }
}

// --- orchestrator ------------------------------------------------------------

/**
 * Run the full from-url pipeline. NEVER throws for a mid-pipeline stage failure —
 * it returns `{ status: 'incomplete', stageFailed, error }` with the INCOMPLETE
 * marker + partial evidence on disk. It DOES throw for pre-pipeline problems:
 * FromUrlUsageError (bad input) and FromUrlEnvironmentError (engine missing),
 * which the CLI maps to exit 2 / 3.
 */
export async function runFromUrl(url: string, options: RunFromUrlOptions = {}): Promise<FromUrlResult> {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new FromUrlUsageError('from-url requires a <url> argument');
  }

  const now = options.now ?? (() => new Date());
  const clock = now();
  const outDir = path.resolve(options.outDir ?? '.');
  const host = hostSlug(url);
  const stamp = dateStamp(clock);

  // Resolve the engine up front so a missing extraction environment fails as
  // exit 3 BEFORE any directory is created (nothing to keep — the environment,
  // not the run, is broken).
  let engine: ExtractionEngine;
  if (options.engine !== undefined) {
    engine = options.engine;
  } else {
    try {
      engine = new DembrandtEngine();
    } catch (cause) {
      throw new FromUrlEnvironmentError(
        `extraction engine unavailable (dembrandt not resolvable): ${
          cause instanceof Error ? cause.message : String(cause)
        } — run "npm install" and "npx playwright install chromium" in the on-brand repo`,
      );
    }
  }

  const force = options.force ?? false;
  const proposalDir = resolveProposalDir(outDir, host, stamp, force);
  // Under --force we REUSE the base name (resolveProposalDir returned it, no
  // "-b" bump): clear any prior run's contents first so stale, now-unreferenced
  // files (e.g. a previous run's randomized-UUID screenshot) never linger in the
  // "overwritten" dir. The non-force path never clobbers (it bumped to a fresh
  // name), so nothing to clear there. Safe: proposalDir is always our own
  // constructed "onbrand-proposal-<slug>-<stamp>" path, never operator-arbitrary.
  if (force && existsSync(proposalDir)) {
    rmSync(proposalDir, { recursive: true, force: true });
  }
  const brandDir = path.join(proposalDir, 'brand');
  const assetsDir = path.join(brandDir, 'assets');
  mkdirSync(assetsDir, { recursive: true });

  const markerPath = path.join(proposalDir, 'INCOMPLETE.md');
  // Kill-safe: written NOW, removed only on full success.
  writeAtomic(markerPath, markerContent(host, url, 'starting'));

  const warnings: string[] = [];
  let stage: FromUrlStage = 'extract';
  let llmManifestStatus: LlmManifestStatus | undefined;

  try {
    // 1. Extract.
    stage = 'extract';
    writeAtomic(markerPath, markerContent(host, url, 'extract (running engine)'));
    const extraction = await engine.extract(url, {
      dark: options.dark ?? false,
      pages: options.pages ?? 1,
      screenshotDir: assetsDir,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });

    // Partial evidence: screenshots + the raw extraction, persisted immediately.
    const screenshots = materializeScreenshots(extraction, assetsDir);
    const evidence: RawExtraction = {
      ...extraction,
      screenshots: extraction.screenshots.map((s) => ({
        ...s,
        path: existsSync(s.path) ? `brand/assets/${path.basename(s.path)}` : s.path,
      })),
    };
    writeAtomic(
      path.join(proposalDir, 'raw-extraction.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );

    // 2. Normalize.
    stage = 'normalize';
    writeAtomic(markerPath, markerContent(host, url, 'normalize'));
    const norm = normalize(extraction, {
      ...(options.presetsRoot !== undefined ? { presetsRoot: options.presetsRoot } : {}),
    });
    warnings.push(...norm.warnings);

    // 3. LLM assist (never throws; degrades to heuristics/stub).
    stage = 'llm';
    writeAtomic(markerPath, markerContent(host, url, 'llm assist'));
    const llm = await runLlmAssist(extraction, norm.seedCandidates, {
      noLlm: options.noLlm ?? false,
      ...(options.llm?.spawn !== undefined ? { spawn: options.llm.spawn } : {}),
      ...(options.llm?.claudeCommand !== undefined ? { claudeCommand: options.llm.claudeCommand } : {}),
      ...(options.llm?.timeoutMs !== undefined ? { timeoutMs: options.llm.timeoutMs } : {}),
      ...(options.llm?.extraArgs !== undefined ? { extraArgs: options.llm.extraArgs } : {}),
    });
    llmManifestStatus = llm.manifestStatus;
    warnings.push(...llm.warnings);

    // 4. Build: honor the LLM's brand-color pick, then write + compile.
    stage = 'build';
    writeAtomic(markerPath, markerContent(host, url, 'build (emitters + guide)'));
    // Decision 4 (heuristics measure, LLM judges): the normalizer proposes a
    // heuristic seed (seedCandidates[0]); the LLM may pick a DIFFERENT top-5
    // candidate. Rebuild the tokens from whichever color was CHOSEN so the shipped
    // brand/tokens.json + dist + report all reflect the LLM's pick — not the
    // heuristic top mislabeled as the LLM's. When they agree (or --no-llm /
    // heuristic fallback, where pick == seed) the initial `norm` is shipped as-is.
    let shipNorm = norm;
    const chosenPick = llm.colorPick.pick;
    if (chosenPick.trim().toLowerCase() !== norm.seed.trim().toLowerCase()) {
      const rebuilt = buildTokensForSeed(extraction, chosenPick, {
        ...(options.presetsRoot !== undefined ? { presetsRoot: options.presetsRoot } : {}),
      });
      warnings.push(...rebuilt.warnings);
      shipNorm = {
        ...norm,
        tokens: rebuilt.tokens,
        dark: rebuilt.dark,
        seed: chosenPick,
        fonts: rebuilt.fonts,
        contrastSuggestions: rebuilt.contrastSuggestions,
        warnings: [...norm.warnings, ...rebuilt.warnings],
      };
    }
    writeAtomic(path.join(brandDir, 'tokens.json'), `${JSON.stringify(shipNorm.tokens, null, 2)}\n`);
    writeAtomic(path.join(brandDir, 'modes.dark.json'), `${JSON.stringify(shipNorm.dark, null, 2)}\n`);
    writeAtomic(
      path.join(brandDir, 'guide.md'),
      renderGuideDraft({
        projectName: host,
        host,
        url,
        llm,
        normalize: shipNorm,
      }),
    );
    const gitkeep = path.join(assetsDir, '.gitkeep');
    if (!existsSync(gitkeep)) writeFileSync(gitkeep, '', 'utf8');

    compileBrand(proposalDir, {
      llm: llm.manifestStatus,
      now: () => clock.toISOString(),
      ...(options.presetsRoot !== undefined ? { presetsRoot: options.presetsRoot } : {}),
    });

    // 5. Report (evidence surface).
    stage = 'report';
    writeAtomic(markerPath, markerContent(host, url, 'report'));
    const reportPath = path.join(proposalDir, 'extraction-report.md');
    writeAtomic(
      reportPath,
      renderExtractionReport({
        url,
        host,
        extraction,
        normalize: shipNorm,
        llm,
        screenshots,
        generatedAt: clock.toISOString(),
      }),
    );

    // Success: remove the marker LAST (the directory is now complete).
    rmSync(markerPath, { force: true });
    return {
      status: 'complete',
      proposalDir,
      brandDir,
      reportPath,
      llmManifestStatus,
      warnings,
    };
  } catch (cause) {
    const message = oneLine(cause instanceof Error ? cause.message : String(cause));
    // Re-stamp the marker with the failed stage + detail (partial evidence kept).
    try {
      writeAtomic(markerPath, markerContent(host, url, `${stage} (FAILED)`, message));
    } catch {
      // A marker-write failure must not mask the original stage failure.
    }
    return {
      status: 'incomplete',
      proposalDir,
      brandDir,
      stageFailed: stage,
      error: message,
      ...(llmManifestStatus !== undefined ? { llmManifestStatus } : {}),
      warnings,
    };
  }
}
