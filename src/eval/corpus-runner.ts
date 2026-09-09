/**
 * Brand-Fidelity Benchmark — corpus runner (plan §5/§7, Step 10, #39).
 *
 * The I/O-ful assembler `.claude/skills/brand-fidelity/SKILL.md` invokes: reads
 * the corpus manifest + committed fixtures/truth off disk, replays each site
 * through the REAL production pipeline (`FixtureEngine` -> `normalize()` ->
 * `scoreSite()`, the exact wiring `test/eval.smoke.e2e.test.ts` proved for one
 * site — this module generalizes it to the whole corpus), optionally attempts
 * the mood axis (a real, injectable `VisionJudge`, calibrated once and
 * degrading gracefully), and hands the result to `src/eval/report.ts` for
 * rendering. `src/eval/score.ts`'s rollup logic stays PURE (no I/O); this
 * module is where the I/O lives (measurement-validity: keep the pure scoring
 * math separable from the fixture/network plumbing around it).
 *
 * ------------------------------------------------------- replay vs refresh ---
 * `replayCorpus()` is the DEFAULT, deterministic path: every site's committed
 * `raw-extraction.json` fixture is replayed through `FixtureEngine` (no
 * network, byte-identical across runs). `refreshCorpusSite()` is the SEPARATE
 * live-drift gate (plan §6): it re-extracts a real `http(s)://` corpus URL via
 * the production `DembrandtEngine` and diffs the result against the committed
 * fixture via the pure `diffAgainstFixture()` — it never feeds live data into
 * the SCORED fidelity numbers (those always come from the replay path), only
 * into a separate drift report. `fixture://` corpus entries (the synthetic
 * czg-cool/dark/warm/rainbow/luxe controls) have no live site and are skipped
 * by refresh (there is nothing to refresh against).
 *
 * -------------------------------------------------------------- mood wiring ---
 * `runMoodSuite()` calibrates ONCE against the Monet mismatch anchor
 * (`templates/presets/monet-mismatch-anchor/`, rendered to a real specimen
 * screenshot via the SAME production `compileBrand`/`generatePreview`
 * (`src/build/compile.ts` / `src/preview/specimen.ts`) + `captureScreenshot`
 * (`src/eval/capture.ts`) primitives every site's specimen uses) before
 * attempting ANY per-site mood score — "a scorer that can't fail garbage
 * can't gate" (measurement-validity + `mood-judge.ts`'s own calibration
 * doctrine). If the judge is unavailable (`claude` absent/auth-dead) or
 * miscalibrated, the WHOLE suite's mood axis is reported `'unavailable'` with
 * the real reason and NO per-site specimen/screenshot work is attempted
 * (avoids burning a Playwright launch per site when the judge can't be used
 * anyway). Only when calibration genuinely passes does per-site mood scoring
 * proceed, one real site at a time, pairing the corpus's own committed source
 * screenshot (`docs/findings/eval-raw-extractions/benchmark/<id>.viewport.png`)
 * with a freshly-rendered specimen screenshot of that site's own normalized
 * tokens. `fixture://` corpus entries (no committed source screenshot) and
 * czg controls (mood scoring is a real-brand-identity framing, mirrors the
 * #25 background-mismatch check's own real-site-only scope) are skipped.
 *
 * A parse failure (`MoodJudgeParseError`) during a real judged run propagates
 * LOUD (this module does not catch it) — a genuine instrument defect must
 * surface, never be silently absorbed into "unavailable" (mood-judge.ts's own
 * "graceful degradation is narrow" contract, mirrored here one level up).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileBrand } from '../build/compile.ts';
import { generatePreview } from '../preview/specimen.ts';
import type { RawExtraction } from '../extract/engine/adapter.ts';
import { DembrandtEngine } from '../extract/engine/dembrandt.ts';
import { FixtureEngine } from '../extract/from-url.ts';
import { getLeaf, normalize, type NormalizeResult } from '../extract/normalize.ts';
import { loadCorpus, type CorpusEntry, type CorpusTier } from '../../benchmark/corpus.ts';
import { truthTemplateSchema, type TruthTemplate } from '../../benchmark/truth-scaffold.ts';
import { captureScreenshot, fileUrlFromPath } from './capture.ts';
import {
  calibrateAgainstKnownBad,
  createClaudeVisionJudge,
  judgeMood,
  VisionJudgeUnavailableError,
  type VisionJudge,
  type VisionJudgeInput,
} from './mood-judge.ts';
import { buildSuiteRollup, scoreSite, type CorpusFidelityEntry } from './score.ts';
import { generateReport, type MoodSitePassthrough, type MoodSuiteResult, type SiteDriftEntry } from './report.ts';

// --- paths ---------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const FIXTURE_DIR = path.join(REPO_ROOT, 'docs', 'findings', 'eval-raw-extractions', 'benchmark');
export const TRUTH_DIR = path.join(REPO_ROOT, 'docs', 'findings', 'eval-truth');
const MONET_MISMATCH_DIR = path.join(REPO_ROOT, 'templates', 'presets', 'monet-mismatch-anchor');

const MONET_MISMATCH_REFERENCE_DESCRIPTION =
  'Claude Monet, "Water Lilies" (Nymphéas) series (c. 1897-1926): muted, cool-green pond ' +
  'tones, soft blues, gentle pink/lavender lily accents, a contemplative, atmospheric mood.';

// --- reading truth ---------------------------------------------------------

/** Read + schema-validate a corpus site's frozen ground truth. Throws (never returns unvalidated data) — same contract every other eval test reads truth under. */
export function readTruth(id: string, truthDir: string = TRUTH_DIR): TruthTemplate {
  const raw: unknown = JSON.parse(readFileSync(path.join(truthDir, `${id}.truth.json`), 'utf8'));
  return truthTemplateSchema.parse(raw);
}

// --- replay (deterministic, default) ---------------------------------------

export interface ReplayedSite {
  entry: CorpusEntry;
  extraction: RawExtraction;
  norm: NormalizeResult;
  truth: TruthTemplate;
}

export interface ReplayOptions {
  /** Corpus tier to run (default `'v1'` — the 12 real sites + 8 czg controls). */
  tier?: CorpusTier;
  fixtureDir?: string;
  truthDir?: string;
}

/**
 * Replay ONE corpus site through the REAL extraction boundary
 * (`FixtureEngine`, production `from-url.ts`) then the REAL production
 * `normalize()` — the exact no-boundary-mock wiring
 * `test/eval.smoke.e2e.test.ts` proved for stripe alone, generalized to any
 * corpus id.
 */
export async function replaySiteFromFixture(
  entry: CorpusEntry,
  options: ReplayOptions = {},
): Promise<ReplayedSite> {
  const fixtureDir = options.fixtureDir ?? FIXTURE_DIR;
  const truthDir = options.truthDir ?? TRUTH_DIR;
  const fixturePath = path.join(fixtureDir, `${entry.id}.raw-extraction.json`);
  const engine = new FixtureEngine(fixturePath, REPO_ROOT);
  const extraction = await engine.extract();
  const norm = normalize(extraction);
  const truth = readTruth(entry.id, truthDir);
  return { entry, extraction, norm, truth };
}

/**
 * `color.chart.categorical.2`..`.8` (light tokens), in that order — the #26
 * structural evidence. Reads via `getLeaf` (the SAME accessor `color-fidelity.ts`
 * reuses), never re-parses tokens.json.
 *
 * FAILS LOUD (measurement-validity "fail loud on fallback config") when a leaf
 * is missing or not a string: `applyChart()` in `normalize.ts` always sets
 * `color.chart.categorical.2`..`.8` on every proposal, so a missing/non-string
 * leaf means the scorer is being handed a malformed/incompatible
 * `NormalizeResult` — mirrors `color-fidelity.ts`'s own
 * `scoreableProposalFromNormalize` contract. Previously this coerced a missing
 * leaf via `String(undefined)` -> the literal `"undefined"` sentinel, which
 * would make `findCategoricalSameness` FALSELY MORE confident (every broken
 * site "matches" on the same broken sentinel) instead of surfacing the
 * pipeline defect (review finding, Step 10 second pass).
 */
export function categoricalSecondaryOf(norm: NormalizeResult): string[] {
  const tokens = norm.tokens as unknown as Record<string, unknown>;
  const out: string[] = [];
  for (let i = 2; i <= 8; i++) {
    const dotPath = `color.chart.categorical.${i}`;
    const leaf = getLeaf(tokens, dotPath);
    if (typeof leaf !== 'string') {
      throw new Error(
        `categoricalSecondaryOf: norm.tokens is missing a string ${dotPath} leaf ` +
          `(applyChart() should always set this — the NormalizeResult is malformed; ` +
          `got ${JSON.stringify(leaf)})`,
      );
    }
    out.push(leaf);
  }
  return out;
}

/** Score one already-replayed site into a full `CorpusFidelityEntry` (score.ts's `scoreSite` + the extra shipped-value evidence the rollup/report need). */
export function scoreReplayedSite(site: ReplayedSite): CorpusFidelityEntry {
  const fidelity = scoreSite(site.entry.id, site.norm, site.extraction, site.truth);
  const tokens = site.norm.tokens as unknown as Record<string, unknown>;
  const dark = site.norm.dark as unknown as Record<string, unknown>;
  return {
    entry: site.entry,
    truth: site.truth,
    fidelity,
    shippedBackground: {
      light: String(getLeaf(tokens, 'color.semantic.bg')),
      dark: String(getLeaf(dark, 'color.semantic.bg')),
    },
    shippedSeed: site.norm.seed,
    categoricalSecondary: categoricalSecondaryOf(site.norm),
  };
}

/** Replay + score the WHOLE corpus tier (default `'v1'`: 12 real sites + 8 czg controls). Returns both the per-site replay (needed for mood specimen rendering) and the scored `CorpusFidelityEntry[]` (needed for the rollup/report). */
export async function replayAndScoreCorpus(
  options: ReplayOptions = {},
): Promise<{ replayed: ReplayedSite[]; scored: CorpusFidelityEntry[] }> {
  const tier = options.tier ?? 'v1';
  const entries = loadCorpus().entries.filter((e) => e.tier === tier);
  const replayed: ReplayedSite[] = [];
  for (const entry of entries) {
    replayed.push(await replaySiteFromFixture(entry, options));
  }
  const scored = replayed.map(scoreReplayedSite);
  return { replayed, scored };
}

// --- refresh (live-drift gate; NEVER feeds the tune-loop, plan §6) ---------

export interface SiteDriftComputation {
  siteId: string;
  changed: boolean;
  note: string;
}

/**
 * Pure diff between a committed fixture and a freshly live-extracted
 * `RawExtraction` for the SAME site — a coarse, cheap drift signal (colour
 * count delta + whether the top-3-by-frequency hex set changed), not a
 * fidelity score. No I/O, no network — safe to unit test with two hand-built
 * `RawExtraction` objects.
 */
export function diffAgainstFixture(siteId: string, committed: RawExtraction, live: RawExtraction): SiteDriftComputation {
  const topHexes = (ext: RawExtraction): string[] =>
    [...ext.colors]
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 3)
      .map((c) => c.hex);
  const committedTop = topHexes(committed);
  const liveTop = topHexes(live);
  const topChanged = JSON.stringify(committedTop) !== JSON.stringify(liveTop);
  const countDelta = live.colors.length - committed.colors.length;
  const changed = topChanged || countDelta !== 0;
  const note = changed
    ? `top-3 clusters ${topChanged ? 'CHANGED' : 'unchanged'} (committed ${committedTop.join(',')} vs live ${liveTop.join(',')}); colour count delta ${countDelta >= 0 ? '+' : ''}${countDelta}`
    : `top-3 clusters unchanged (${committedTop.join(',')}); colour count delta 0`;
  return { siteId, changed, note };
}

/** Live re-extract ONE real (http/https) corpus site via the production `DembrandtEngine` — the `--refresh` path. Never called by the default replay path or by any hermetic test (requires network + a live browser). */
export async function refreshCorpusSite(entry: CorpusEntry): Promise<RawExtraction> {
  const engine = new DembrandtEngine();
  return engine.extract(entry.url);
}

// --- mood suite (real, injectable, gated by one calibration) --------------

export interface MoodRunOptions {
  /** Default `true`. Set `false` to skip mood entirely (fast colour/font/structural-only runs, and every hermetic test). */
  enabled?: boolean;
  /** Injectable judge — default the REAL production judge (`createClaudeVisionJudge()`). Tests inject a fake. */
  judge?: VisionJudge;
  k?: number;
  /** Root working dir for temp brand builds + screenshots (default a fresh `os.tmpdir()` dir, removed when done). */
  workDir?: string;
  /**
   * Injectable calibration-input builder — default `buildMismatchAnchorInput`
   * (renders a REAL specimen screenshot of `templates/presets/monet-mismatch-anchor`
   * via `compileBrand`/`generatePreview`/`captureScreenshot`). Tests that only
   * want to exercise the suite-level calibrate-then-degrade ORCHESTRATION
   * (already-tested mechanics live in `mood-judge.ts`'s own test suite) inject
   * a fast fake here to avoid paying a real Playwright launch when the judge
   * itself is also faked to report unavailable.
   */
  buildKnownBadInput?: (workDir: string) => Promise<VisionJudgeInput>;
}

function sourceScreenshotPath(id: string, fixtureDir: string): string | undefined {
  const p = path.join(fixtureDir, `${id}.viewport.png`);
  return existsSync(p) ? p : undefined;
}

/** Write tokens/dark to a temp `brand/` dir, compile, generate the preview, and screenshot the resulting specimen.html — the same production `compileBrand`/`generatePreview`/`captureScreenshot` primitives a real `onbrand build && onbrand preview` invocation uses. */
async function buildSpecimenScreenshot(
  tokens: unknown,
  dark: unknown,
  buildDir: string,
  outPngPath: string,
): Promise<string> {
  const brandDir = path.join(buildDir, 'brand');
  mkdirSync(brandDir, { recursive: true });
  writeFileSync(path.join(brandDir, 'tokens.json'), JSON.stringify(tokens, null, 2), 'utf8');
  writeFileSync(path.join(brandDir, 'modes.dark.json'), JSON.stringify(dark, null, 2), 'utf8');
  compileBrand(buildDir);
  const { specimenPath } = generatePreview(buildDir);
  await captureScreenshot(fileUrlFromPath(specimenPath), outPngPath);
  return outPngPath;
}

async function buildMismatchAnchorInput(workDir: string): Promise<VisionJudgeInput> {
  const tokens: unknown = JSON.parse(readFileSync(path.join(MONET_MISMATCH_DIR, 'tokens.json'), 'utf8'));
  const dark: unknown = JSON.parse(readFileSync(path.join(MONET_MISMATCH_DIR, 'modes.dark.json'), 'utf8'));
  const pngPath = path.join(workDir, 'monet-mismatch-anchor.png');
  await buildSpecimenScreenshot(tokens, dark, path.join(workDir, 'monet-mismatch-anchor-build'), pngPath);
  return {
    subjectId: 'monet-mismatch-anchor',
    images: [{ label: 'specimen', path: pngPath }],
    palette: [],
    referenceDescription: MONET_MISMATCH_REFERENCE_DESCRIPTION,
  };
}

/**
 * Run the suite-level mood axis: ONE calibration check against the Monet
 * mismatch anchor, then (only if that passes) one judged pass per real,
 * screenshot-having corpus site. Degrades to `{status:'unavailable', reason}`
 * the moment the judge is unavailable OR miscalibrated — never a fabricated
 * score, and never a per-site specimen build wasted once unavailability is
 * known. See file header for the full contract.
 */
export async function runMoodSuite(
  replayed: readonly ReplayedSite[],
  options: MoodRunOptions = {},
): Promise<MoodSuiteResult> {
  if (options.enabled === false) return { status: 'not-run' };

  const judge = options.judge ?? createClaudeVisionJudge();
  const kOpt = options.k !== undefined ? { k: options.k } : {};
  const workDir = options.workDir ?? mkdtempSync(path.join(tmpdir(), 'onbrand-mood-'));
  const ownWorkDir = options.workDir === undefined;

  try {
    const buildKnownBadInput = options.buildKnownBadInput ?? buildMismatchAnchorInput;
    const knownBadInput = await buildKnownBadInput(workDir);

    let calibration;
    try {
      calibration = await calibrateAgainstKnownBad(judge, knownBadInput, kOpt);
    } catch (err) {
      if (err instanceof VisionJudgeUnavailableError) {
        return { status: 'unavailable', reason: err.message };
      }
      throw err;
    }
    if (!calibration.ok) {
      return { status: 'unavailable', reason: calibration.reason ?? 'mood-judge calibration failed' };
    }

    const perSite: MoodSitePassthrough[] = [];
    for (const site of replayed) {
      if (site.entry.isControl) continue; // real-brand-identity framing only (mirrors #25's scope choice)
      const sourcePng = sourceScreenshotPath(site.entry.id, FIXTURE_DIR);
      if (sourcePng === undefined) continue; // no committed source shot (e.g. a fixture:// synthetic entry)

      const specimenPng = path.join(workDir, `${site.entry.id}-specimen.png`);
      await buildSpecimenScreenshot(
        site.norm.tokens,
        site.norm.dark,
        path.join(workDir, `${site.entry.id}-build`),
        specimenPng,
      );
      const subjectInput: VisionJudgeInput = {
        subjectId: site.entry.id,
        images: [
          { label: 'source', path: sourcePng },
          { label: 'specimen', path: specimenPng },
        ],
        palette: [site.norm.seed],
      };
      const result = await judgeMood(judge, subjectInput, kOpt);
      perSite.push({ siteId: site.entry.id, overall: result.overall });
    }

    return { status: 'judged', perSite };
  } finally {
    if (ownWorkDir) rmSync(workDir, { recursive: true, force: true });
  }
}

// --- runnable entry: `npx tsx src/eval/corpus-runner.ts [--refresh] [--no-mood] [--out <path>]` ---

export interface ParsedCliArgs {
  refresh: boolean;
  mood: boolean;
  out?: string;
}

/** Parse the corpus-runner CLI's own argv (see the module comment above `main()`). Unrecognized flags are simply ignored (not an error) — exported so `test/eval.corpus-runner.e2e.test.ts` can exercise flag parsing directly without spawning a subprocess. */
export function parseArgs(argv: readonly string[]): ParsedCliArgs {
  const refresh = argv.includes('--refresh');
  const mood = !argv.includes('--no-mood');
  const outIdx = argv.indexOf('--out');
  const out = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  return { refresh, mood, out };
}

/** The runnable entry `npx tsx src/eval/corpus-runner.ts` invokes. Exported (additive) so a test can smoke it end-to-end through the hermetic `--no-mood` path without spawning a subprocess. */
export async function main(): Promise<void> {
  const { refresh, mood, out } = parseArgs(process.argv.slice(2));

  const { replayed, scored } = await replayAndScoreCorpus({ tier: 'v1' });
  const rollup = buildSuiteRollup(scored);
  const moodResult = await runMoodSuite(replayed, { enabled: mood });

  let drift: SiteDriftEntry[] | undefined;
  if (refresh) {
    drift = [];
    for (const site of replayed) {
      if (!site.entry.url.startsWith('http')) continue; // fixture:// entries have no live counterpart
      const live = await refreshCorpusSite(site.entry);
      const d = diffAgainstFixture(site.entry.id, site.extraction, live);
      drift.push(d);
    }
  }

  const report = generateReport({
    mode: refresh ? 'refresh' : 'replay',
    sites: scored,
    rollup,
    mood: moodResult,
    ...(drift !== undefined ? { drift } : {}),
  });

  const outPath = out ?? path.join(REPO_ROOT, 'docs', 'findings', 'brand-fidelity-report.md');
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, report, 'utf8');
  console.log(`brand-fidelity: wrote report to ${outPath} (${scored.length} sites, mode=${refresh ? 'refresh' : 'replay'}, mood=${moodResult.status})`);
}

// Mirrors `benchmark/truth-scaffold.ts`'s own runnable-entry guard (one
// source of truth for the idiom): only run `main()` when this file is the
// process's entry script, never when imported (e.g. by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  });
}
