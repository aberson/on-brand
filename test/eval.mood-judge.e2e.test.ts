/**
 * LIVE anchor calibration for `src/eval/mood-judge.ts` (Brand-Fidelity plan
 * Step 9, #38) — the REAL acceptance: the Monet mismatch (negative) anchor
 * genuinely FAILS the vision judge, and the Monet water-lily (positive)
 * anchor genuinely PASSES, via the PRODUCTION `createClaudeVisionJudge()`
 * calling the real `claude` CLI (subscription OAuth, no API key) over real
 * screenshots captured by `src/eval/capture.ts` — no fake bin, no injected
 * judge. This is the "assemble through the production code path" +
 * "calibrate with anchors before comparing" measurement-validity checks
 * actually exercised live, not merely unit-tested against a fake.
 *
 * SKIPPED (not failed) whenever the `claude` CLI is unavailable OR
 * unauthenticated, OR Chromium is unavailable — mirrors
 * `test/eval.capture.e2e.test.ts`'s `hasChromium` probe pattern for Chromium,
 * plus an analogous `probeClaudeCli` for claude: a cheap `--version` spawn
 * catches an absent binary (ENOENT), and a minimal real `-p` call (classified
 * through the SAME `classifySpawn` the production judge uses — one source of
 * truth, not a re-derived check) catches a present-but-unauthenticated CLI
 * (an expired/invalid OAuth token is just as unable to run the live
 * calibration as an absent binary — skip in both cases rather than failing).
 * This file must NEVER fail (as opposed to skip) in an offline/no-claude/
 * unauthenticated environment — `npm test` stays green either way.
 *
 * Both Monet anchors (`templates/presets/monet-water-lily`,
 * `templates/presets/monet-mismatch-anchor`) name the SAME reference
 * painting (Claude Monet's "Water Lilies" / Nymphéas — see
 * `templates/presets/monet-mismatch-anchor/PROVENANCE.md`), so both are
 * judged against the identical `referenceDescription` text drawn from that
 * PROVENANCE.md — there is no bundled reference-painting image in this repo
 * (the presets are hand-authored token sets, not extracted from a photo), so
 * the judge is grounded in the documented palette/mood description rather
 * than a second screenshot (see `mood-judge.ts`'s `VisionJudgeInput.
 * referenceDescription` field doc for why this is a legitimate,
 * non-image reference).
 *
 * The calibration gate (`runCalibratedMoodJudgment`) is exercised for real
 * here too: it judges the known-bad (mismatch) anchor FIRST and only then
 * runs the comparative (water-lily) judgment — the exact live sequence the
 * plan's Step 9 done-when requires ("judge calibrated against the known-bad
 * set before any comparative run").
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_OK } from '../src/cli.ts';
import {
  EXEC_DENY_TOOLS,
  MCP_DENY_TOOLS,
  SAFE_PERMISSION_MODE,
  classifySpawn,
} from '../src/extract/llm.ts';
import { captureScreenshot, fileUrlFromPath } from '../src/eval/capture.ts';
import { createClaudeVisionJudge, runCalibratedMoodJudgment, type VisionJudgeInput } from '../src/eval/mood-judge.ts';
import { defaultPresetsRoot, readJsonFile } from '../src/schema/resolve.ts';
import { isToken, type TokensDocument } from '../src/schema/types.ts';
import { assertValid } from '../src/schema/validate.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO_ROOT, 'bin', 'onbrand.mjs');
const PRESETS_ROOT = defaultPresetsRoot();

/** The reference painting BOTH Monet anchors claim (PROVENANCE.md) — used as
 * the textual reference description for both judgments (no painting image is
 * bundled in this repo). */
const WATER_LILIES_REFERENCE_DESCRIPTION =
  "Claude Monet's \"Water Lilies\" (Nymphéas) series (c. 1897-1926): muted, cool-green pond " +
  'tones, soft blues, and gentle pink/lavender lily accents, in a contemplative, atmospheric mood.';

// --- claude CLI availability probe (mirrors eval.capture.e2e.test.ts's hasChromium pattern) ---

function probeClaudeCli(): { available: boolean; reason: string } {
  const command = process.env.ONBRAND_CLAUDE_BIN ?? 'claude';
  const versionCheck = spawnSync(command, ['--version'], { timeout: 5_000, encoding: 'utf8', windowsHide: true });
  if (versionCheck.error !== undefined) {
    return { available: false, reason: `claude CLI not found/resolvable (${versionCheck.error.message})` };
  }

  // The binary resolves — now confirm it can actually AUTHENTICATE. A
  // present-but-unauthenticated CLI (expired/invalid OAuth token) is just as
  // unable to run the live calibration as an absent binary, so this probe
  // treats it the same way: skip, don't fail. A minimal, cheap real `-p` call
  // (same deny-list/permission-mode shape the production judge uses),
  // classified through the SAME `classifySpawn` `createClaudeVisionJudge`
  // itself calls — one source of truth for the ok/cli-absent/auth-dead/
  // nonzero/timeout shape, not a second hand-rolled auth check.
  const authCheck = spawnSync(
    command,
    [
      '-p',
      'reply with the single word: ok',
      '--disallowedTools',
      ...EXEC_DENY_TOOLS,
      ...MCP_DENY_TOOLS,
      '--permission-mode',
      SAFE_PERMISSION_MODE,
    ],
    { timeout: 30_000, encoding: 'utf8', windowsHide: true },
  );
  const cls = classifySpawn({
    stdout: authCheck.stdout ?? '',
    stderr: authCheck.stderr ?? '',
    code: authCheck.status,
    timedOut: false,
    ...(authCheck.error !== undefined ? { spawnError: authCheck.error } : {}),
  });
  if (cls === 'cli-absent') {
    return { available: false, reason: `claude CLI not found/resolvable on the auth probe (${command})` };
  }
  if (cls === 'auth-dead') {
    return {
      available: false,
      reason: `claude CLI resolved (${command}) but authentication failed — re-authenticate to run the live anchor test`,
    };
  }
  return { available: true, reason: `claude CLI resolved and authenticated (${command})` };
}

// Live calibration is deliberately opt-in. A locally authenticated Codex/
// Claude session must not make the ordinary hermetic `npm test` command issue
// real model requests or wait on an interactive CLI.
const LIVE_OPT_IN = process.env.ONBRAND_LIVE_MOOD === '1';
const claudeProbe = LIVE_OPT_IN
  ? probeClaudeCli()
  : { available: false, reason: 'ONBRAND_LIVE_MOOD is not set to 1' };
if (!claudeProbe.available) {
  console.warn(
    `[eval.mood-judge.e2e] WARNING: SKIPPING the live Monet anchor test — ${claudeProbe.reason}. ` +
      'This is EXPECTED/fine offline or in CI; the live calibration only runs where the claude CLI is installed and authenticated.',
  );
}

// --- Chromium availability probe (identical idiom to eval.capture.e2e.test.ts) ---

const require = createRequire(import.meta.url);
let hasChromium = false;
let chromiumSkipReason = '';
if (LIVE_OPT_IN) {
  try {
    const chromiumModule = require('playwright') as typeof import('playwright');
    const exe = chromiumModule.chromium.executablePath();
    hasChromium = existsSync(exe);
    if (!hasChromium) chromiumSkipReason = `chromium binary not found at ${exe}`;
  } catch (e) {
    chromiumSkipReason = `playwright unavailable: ${e instanceof Error ? e.message : String(e)}`;
  }
}
if (LIVE_OPT_IN && !hasChromium) {
  console.warn(`[eval.mood-judge.e2e] WARNING: SKIPPING the live Monet anchor test — ${chromiumSkipReason}.`);
}

const LIVE_READY = LIVE_OPT_IN && claudeProbe.available && hasChromium;

// --- preset build/capture plumbing --------------------------------------------

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-mood-e2e-'));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** init -> build -> preview a named preset; returns its specimen.html path. */
function buildPresetSpecimen(presetName: string): string {
  const dir = tempDir();
  expect(runCli(['init', dir, '--preset', presetName]).status, presetName).toBe(EXIT_OK);
  expect(runCli(['build', dir]).status, presetName).toBe(EXIT_OK);
  expect(runCli(['preview', dir]).status, presetName).toBe(EXIT_OK);
  const specimenPath = path.join(dir, 'brand', 'dist', 'specimen.html');
  expect(existsSync(specimenPath), presetName).toBe(true);
  return specimenPath;
}

function tokenValue(doc: TokensDocument, dotPath: string): unknown {
  let node: unknown = doc;
  for (const seg of dotPath.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return isToken(node) ? node.$value : undefined;
}

/** A small representative palette (accent + 4 categorical swatches) read
 * directly from the preset's own tokens.json — the structured grounding the
 * judge receives alongside the pixels. */
function presetPalette(presetName: string): string[] {
  const doc = assertValid(readJsonFile(path.join(PRESETS_ROOT, presetName, 'tokens.json')));
  const paths = [
    'color.semantic.accent',
    'color.chart.categorical.1',
    'color.chart.categorical.2',
    'color.chart.categorical.3',
  ];
  return paths.map((p) => tokenValue(doc, p) as string);
}

async function buildMonetInput(presetName: string): Promise<VisionJudgeInput> {
  const specimenHtml = buildPresetSpecimen(presetName);
  const outDir = tempDir();
  const specimenPng = path.join(outDir, `${presetName}.specimen.png`);
  await captureScreenshot(fileUrlFromPath(specimenHtml), specimenPng);
  return {
    subjectId: presetName,
    images: [{ label: 'specimen', path: specimenPng }],
    palette: presetPalette(presetName),
    referenceDescription: WATER_LILIES_REFERENCE_DESCRIPTION,
  };
}

// ---------------------------------------------------------------------------

describe.skipIf(!LIVE_READY)(
  'LIVE Monet anchor calibration (real claude CLI + real Chromium)',
  () => {
    it(
      'calibration gate genuinely FAILS the mismatch anchor, then the water-lily anchor genuinely PASSES',
      async () => {
        const judge = createClaudeVisionJudge({ timeoutMs: 120_000 });
        const mismatchInput = await buildMonetInput('monet-mismatch-anchor');
        const waterLilyInput = await buildMonetInput('monet-water-lily');

        const { calibration, result } = await runCalibratedMoodJudgment(
          judge,
          mismatchInput,
          waterLilyInput,
          { k: 3 },
        );

        expect(calibration.ok, JSON.stringify(calibration.result, null, 2)).toBe(true);
        expect(calibration.result.overall).toBe('FAIL');
        expect(result.overall, JSON.stringify(result, null, 2)).toBe('PASS');
      },
      600_000,
    );
  },
);
