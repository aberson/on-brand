/**
 * LLM assist via the `claude` CLI (plan.md Step 11) — three passes over a
 * from-url extraction:
 *   (a) brand-color pick from the top-5 seed candidates + homepage screenshot;
 *   (b) a two-sentence aesthetic summary;
 *   (c) a voice & tone draft (3-6 bullets + example rewrites).
 *
 * Design (plan §9.4 "heuristics measure, LLM judges"): deterministic code
 * (Step 10) produces the candidates/evidence; this module only asks the LLM to
 * pick/label/draft. Every pass is schema-validated (zod), retried ONCE on an
 * invalid reply, then falls back to a heuristic (color pick) or a TODO stub
 * (aesthetic/voice) with a collected warning — never a throw, never a crash.
 *
 * --------------------------------------------------------------- CLI contract ---
 * Verified against `claude --help` on this machine (claude v2.1.170, subscription
 * OAuth — no API key), 2026-07-16:
 *   - NON-INTERACTIVE flag is `-p` / `--print` ("Print response and exit").
 *   - `--output-format` defaults to "text"; we keep text and extract the JSON
 *     object from the reply ourselves (robust to prose/markdown-fence wrapping).
 *   - There is NO `--image` flag. The homepage screenshot is passed by embedding
 *     its file PATH in the prompt with an instruction to use the Read tool; for
 *     that pass we allow ONLY the Read tool (`--allowedTools Read`) and expose
 *     the screenshot's directory (`--add-dir`) so Read works non-interactively.
 *
 * --------------------------------------------------------------- injection ---
 * WORKSPACE SECURITY RULE: all page-derived content (extracted colors, font
 * names, the screenshot) is UNTRUSTED. Prompts (llm-prompts.ts) fence it as data
 * and forbid following instructions inside it; this module adds the structural
 * firewall — the color pick is validated against the candidate list and REJECTED
 * if it escapes it, so a hostile page can never steer the pick outside the set.
 * Every pass ALSO spawns the CLI under a tool DENY-LIST (`--disallowedTools`):
 * DENY overrides ALLOW in the CLI permission model, so exec/mutation/network
 * tools are blocked even under an ambient auto-approve settings profile (an
 * allow-list alone merely MERGES with settings). A screenshot pass additionally
 * allows ONLY Read (scoped via `--add-dir`); a text pass denies every tool. This
 * restriction is UNCONDITIONAL (untrusted content is present on every pass), not
 * gated on screenshot presence. Verified `--disallowedTools` exists and there is
 * no dedicated no-tools flag (`claude --help` v2.1.170).
 * Read-path hardening (iteration 3): a screenshot pass pins the child's `cwd` to
 * the screenshot's directory so its ambient Read root converges with `--add-dir`
 * (otherwise `--add-dir` is ADDITIVE to the inherited cwd tree — a bounded exfil
 * channel into the persisted rationale/summary). Every pass forces
 * `--permission-mode default` so an inherited `bypassPermissions` cannot void the
 * deny-list, and denies `mcp__*`. RESIDUAL PREMISES (documented CLI-model facts,
 * not proven in-repo): (1) DENY overrides ALLOW/settings-auto-approve in the CLI
 * permission model; (2) a bare `claude -p` inherits NO `--mcp-config`, so no MCP
 * server is loaded — the `mcp__*` deny is a structural belt over this premise,
 * inert if the CLI does not prefix-match tool names.
 *
 * ------------------------------------------------------------------ testing ---
 * The subprocess seam is a `ClaudeSpawner` (default spawns the real `claude`).
 * Offline tests inject `nodeScriptSpawner(<fake-bin>)`, which runs a fake bin
 * through node (the Step 8 fake-bins pattern) so the REAL spawn/stream/timeout/
 * parse/retry code executes with no network and no live claude. One env-gated
 * LIVE smoke (ONBRAND_LIVE_LLM=1) hits the real CLI and is skipped in npm test.
 *
 * AUTHORING HAZARD: no literal control bytes in this source (text-hygiene gate);
 * sanitizeText strips them from LLM replies via char-code comparisons.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import type { LlmStatus } from '../build/manifest.ts';
import type { RawExtraction } from './engine/adapter.ts';
import { killTree } from './engine/proc.ts';
import { FALLBACK_BRAND_SEED } from './ramps.ts';
import type { SeedCandidate } from './normalize.ts';
import {
  buildAestheticPrompt,
  buildColorPickPrompt,
  buildVoicePrompt,
} from './llm-prompts.ts';

// --- Tunables + reasons ------------------------------------------------------

/** Per-pass wall-clock budget (ms). A `claude -p` call can take 30-90s; generous
 * and configurable per plan §6. Overridable via RunLlmAssistOptions.timeoutMs. */
export const LLM_DEFAULT_TIMEOUT_MS = 90_000;

/** Cap on accumulated child output bytes; past it the tree is killed (a runaway
 * reply must not grow RSS without bound). A JSON pass reply is a few KB. */
export const LLM_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export const CLI_ABSENT_REASON =
  'the claude CLI was not found (spawn error / ENOENT); ran heuristics only';
export const AUTH_DEAD_REASON =
  'the claude CLI is present but authentication failed (nonzero exit with auth-shaped stderr); ran heuristics only';
export const ALL_FELL_BACK_REASON =
  'every LLM pass returned an unusable reply after a retry; ran heuristics only';
export const PARTIAL_FALLBACK_REASON =
  'one or more LLM passes fell back to a heuristic/stub after a retry — see warnings';
const HEURISTIC_PICK_RATIONALE =
  'heuristic top-scored candidate (LLM pick unavailable or invalid)';

// --- Public result shape -----------------------------------------------------

export type LlmAssistStatus = 'ok' | 'skipped' | 'degraded';

/** Value the caller writes to manifest.json's `llm` field (plan.md §3.1, §6).
 * DERIVED from manifest.ts's LlmStatus (one source of truth, not hand-duplicated):
 * the non-'none' members, since a from-url run always ran or skipped the LLM. */
export type LlmManifestStatus = Exclude<LlmStatus, 'none'>;

export interface LlmColorPick {
  /** A hex from the candidate list (LLM) or the heuristic top candidate. */
  pick: string;
  rationale: string;
  source: 'llm' | 'heuristic';
}

export interface LlmAesthetic {
  /** Two-sentence summary; capped + control-stripped. */
  summary: string;
  source: 'llm' | 'heuristic';
}

export interface LlmVoiceExample {
  before: string;
  after: string;
}

export interface LlmVoiceDraft {
  bullets: string[];
  examples: LlmVoiceExample[];
}

export interface LlmVoice {
  draft: LlmVoiceDraft;
  source: 'llm' | 'stub';
  /** True when `draft` is the TODO placeholder (consumer renders it as a stub). */
  isTodo: boolean;
}

export interface LlmAssistResult {
  status: LlmAssistStatus;
  manifestStatus: LlmManifestStatus;
  /** Present when status is 'skipped' or 'degraded' — why the LLM did not fully run. */
  reason?: string;
  colorPick: LlmColorPick;
  aesthetic: LlmAesthetic;
  voice: LlmVoice;
  /** Non-fatal notes: fallbacks, nonzero exits, invalid replies, timeouts. */
  warnings: string[];
}

// --- Subprocess seam ---------------------------------------------------------

export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  /** Set when the process could not be spawned (ENOENT etc.) or errored. */
  spawnError?: Error;
  /** Set when output exceeded LLM_MAX_OUTPUT_BYTES and the tree was killed. */
  overflowed?: boolean;
}

/** Runs one `claude`-shaped invocation and resolves (never rejects) a result.
 * `cwd`, when set, pins the child's working directory (the Read-path fix: it
 * converges the child's ambient Read root with the screenshot's --add-dir). */
export type ClaudeSpawner = (
  args: string[],
  timeoutMs: number,
  cwd?: string,
) => Promise<SpawnResult>;

/**
 * The real spawn/stream/timeout/tree-kill core, shared by the production spawner
 * (spawns `claude`) and the test spawner (spawns node + a fake bin). Never
 * rejects: ENOENT and errors surface as `spawnError`, a hang as `timedOut`.
 */
function spawnCollect(
  command: string,
  args: string[],
  timeoutMs: number,
  cwd?: string,
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    let settled = false;
    const done = (r: SpawnResult): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const decode = (): { stdout: string; stderr: string } => ({
      // Buffer.concat before decoding so a UTF-8 code point split across chunk
      // boundaries never decodes as replacement characters.
      stdout: Buffer.concat(outChunks).toString('utf8'),
      stderr: Buffer.concat(errChunks).toString('utf8'),
    });

    let child;
    try {
      child = spawn(command, args, { windowsHide: true, ...(cwd !== undefined ? { cwd } : {}) });
    } catch (err) {
      done({ stdout: '', stderr: '', code: null, timedOut: false, spawnError: err as Error });
      return;
    }

    let total = 0;
    let timedOut = false;
    let overflowed = false;
    // We own the timer and reap the whole tree (a `claude -p` run may spawn
    // helper processes); Node's built-in spawn timeout hits only the child.
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    const onChunk = (sink: Buffer[]) => (chunk: Buffer): void => {
      total += chunk.length;
      if (total > LLM_MAX_OUTPUT_BYTES) {
        if (!overflowed) {
          overflowed = true;
          killTree(child.pid);
        }
        return;
      }
      sink.push(chunk);
    };
    child.stdout?.on('data', onChunk(outChunks));
    child.stderr?.on('data', onChunk(errChunks));
    child.on('error', (cause) => {
      clearTimeout(timer);
      const { stdout, stderr } = decode();
      done({ stdout, stderr, code: null, timedOut, spawnError: cause });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const { stdout, stderr } = decode();
      done({ stdout, stderr, code, timedOut, ...(overflowed ? { overflowed: true } : {}) });
    });
  });
}

/**
 * Production spawner: runs the `claude` CLI directly. EXPORTED (Step 9,
 * #38): `src/eval/mood-judge.ts`'s production `VisionJudge` reuses this EXACT
 * spawn/timeout/tree-kill core (via `spawnCollect`, kept module-private)
 * rather than re-implementing subprocess handling — one source of truth for
 * a security/reliability-relevant mechanism (code-quality.md).
 */
export function makeDefaultSpawner(command: string): ClaudeSpawner {
  return (args, timeoutMs, cwd) => spawnCollect(command, args, timeoutMs, cwd);
}

/**
 * Test spawner: runs a Node script (a fake `claude` bin, Step 8 pattern) as the
 * CLI stand-in, so the real spawn/stream/parse/timeout code runs offline.
 * Exported for the offline suite only.
 */
export function nodeScriptSpawner(scriptPath: string): ClaudeSpawner {
  return (args, timeoutMs, cwd) =>
    spawnCollect(process.execPath, [scriptPath, ...args], timeoutMs, cwd);
}

// --- Reply extraction + sanitization -----------------------------------------

/** The first balanced `{...}` object in `text`, string-literal-aware, or undefined. */
function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * Extract a JSON value from raw CLI stdout. Tolerant of prose or markdown fences
 * around the object (finds the first balanced object). Returns undefined when no
 * parseable object is present — the caller treats that as an invalid reply.
 */
export function extractJson(stdout: string): unknown {
  const slice = firstJsonObject(stdout);
  if (slice === undefined) return undefined;
  try {
    return JSON.parse(slice);
  } catch {
    return undefined;
  }
}

/**
 * Neutralize an untrusted LLM string for use in a token/report/guide: drop C0
 * control bytes and DEL, collapse whitespace, trim, and cap length. Char-code
 * comparisons only — no literal control bytes in this source (text-hygiene gate).
 */
export function sanitizeText(input: string, maxLen: number): string {
  let out = '';
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      out += ' ';
      continue;
    }
    out += ch;
  }
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > maxLen) out = out.slice(0, maxLen).trimEnd();
  return out;
}

// --- Per-pass zod schemas ----------------------------------------------------

/**
 * The color-pick schema is built PER CALL because the legal picks are the
 * runtime candidate hexes. `pick` must be one of them (case-insensitive) — the
 * structural injection firewall. Empty candidate list => nothing validates =>
 * the pass always falls back to the heuristic seed.
 */
function colorPickSchema(candidateHexes: readonly string[]): z.ZodType<{ pick: string; rationale: string }> {
  const set = new Set(candidateHexes.map((h) => h.trim().toLowerCase()));
  return z.object({
    pick: z.string().refine((v) => set.has(v.trim().toLowerCase()), {
      message: 'pick is not one of the provided candidate hexes',
    }),
    rationale: z.string().min(1),
  });
}

const aestheticSchema = z.object({
  summary: z.string().min(1),
});

const voiceSchema = z.object({
  bullets: z.array(z.string().min(1)).min(3).max(6),
  examples: z.array(z.object({ before: z.string().min(1), after: z.string().min(1) })).min(3).max(8),
});

// --- Spawn classification ----------------------------------------------------

/** EXPORTED (Step 9, #38): `mood-judge.ts`'s production `VisionJudge` classifies
 * its own `claude` spawns through this SAME function — one source of truth for
 * the ok/cli-absent/auth-dead/nonzero/timeout shape, rather than a second,
 * driftable copy of the classification rules. */
export type SpawnClassification = 'ok' | 'cli-absent' | 'auth-dead' | 'nonzero' | 'timeout';

/** Unavailable-service markers: a nonzero exit carrying one cannot complete an
 * LLM pass (skip, do not retry). Over-matching only costs a skip instead of a
 * retry. */
const AUTH_MARKERS = [
  'invalid api key',
  'authentication',
  'unauthorized',
  'not logged in',
  'please run /login',
  'run /login',
  'oauth',
  'auth token',
  'credit balance',
  'spend limit',
  'usage limit',
  'token expired',
  'session expired',
  '401',
  '403',
];

/**
 * Checks BOTH `stdout` AND `stderr` for an auth marker (Step 9, #38 finding):
 * on this workspace's installed `claude` CLI (v2.1.170), an expired/invalid
 * OAuth token prints "Failed to authenticate. API Error: 401 ..." to
 * STDOUT, not stderr (empirically verified running the real CLI while
 * building the Step 9 live anchor test) — a stderr-only check silently
 * misclassifies a genuine auth-dead exit as a generic 'nonzero' failure,
 * which would retry pointlessly instead of skipping with a clear reason.
 * Over-matching only costs a skip instead of a retry, so checking both
 * streams is strictly safer than checking either alone.
 */
function isAuthShaped(res: Pick<SpawnResult, 'stdout' | 'stderr'>): boolean {
  const s = `${res.stdout}\n${res.stderr}`.toLowerCase();
  return AUTH_MARKERS.some((m) => s.includes(m));
}

export function classifySpawn(res: SpawnResult): SpawnClassification {
  if (res.spawnError !== undefined) return 'cli-absent';
  if (res.timedOut) return 'timeout';
  if (res.code !== 0) return isAuthShaped(res) ? 'auth-dead' : 'nonzero';
  return 'ok';
}

/** A short, single-line tail of stderr for a warning (no control bytes).
 * EXPORTED (Step 9, #38): reused by `mood-judge.ts`'s production `VisionJudge`
 * for the same purpose (a short, control-stripped stderr excerpt on a
 * non-auth nonzero exit) — one source of truth, not a re-derived copy. */
export function stderrTail(stderr: string): string {
  return sanitizeText(stderr, 200);
}

// --- One pass (spawn + retry-once) -------------------------------------------

interface PassOutcome<T> {
  /** Set iff a schema-valid LLM reply was obtained. */
  value?: T;
  /** Set when the whole assist must stop spawning (CLI absent / auth dead). */
  hardStop?: 'cli-absent' | 'auth-dead';
  warnings: string[];
}

async function runPass<T>(
  label: string,
  spawner: ClaudeSpawner,
  invocation: { args: string[]; cwd?: string },
  schema: z.ZodType<T>,
  timeoutMs: number,
): Promise<PassOutcome<T>> {
  const warnings: string[] = [];
  const maxAttempts = 2; // initial + one retry (plan: "retry ONCE")
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await spawner(invocation.args, timeoutMs, invocation.cwd);
    const cls = classifySpawn(res);
    if (cls === 'cli-absent') return { hardStop: 'cli-absent', warnings };
    if (cls === 'auth-dead') return { hardStop: 'auth-dead', warnings };
    if (cls === 'timeout') {
      warnings.push(
        `${label}: claude CLI timed out after ${timeoutMs}ms (attempt ${attempt}/${maxAttempts}; process tree killed)`,
      );
      continue;
    }
    if (cls === 'nonzero') {
      warnings.push(
        `${label}: claude CLI exited ${String(res.code)} (attempt ${attempt}/${maxAttempts}): ${stderrTail(res.stderr)}`,
      );
      continue;
    }
    // Clean exit: extract + validate the JSON reply.
    const json = extractJson(res.stdout);
    if (json === undefined) {
      warnings.push(`${label}: reply had no parseable JSON object (attempt ${attempt}/${maxAttempts})`);
      continue;
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const detail = first !== undefined ? `${first.path.join('.')}: ${first.message}` : 'schema mismatch';
      warnings.push(`${label}: reply failed schema validation (attempt ${attempt}/${maxAttempts}): ${detail}`);
      continue;
    }
    return { value: parsed.data, warnings };
  }
  return { warnings };
}

// --- Heuristic fallbacks -----------------------------------------------------

function heuristicAesthetic(extraction: RawExtraction): LlmAesthetic {
  const nColors = extraction.colors.length;
  const nFonts = extraction.fonts.length;
  let host = extraction.url;
  try {
    host = new URL(extraction.url).hostname;
  } catch {
    // keep the raw url string when it is not a parseable URL
  }
  const summary = sanitizeText(
    `Extraction observed ${nColors} color clusters and ${nFonts} font families for ${host}. ` +
      `No LLM aesthetic summary was generated; this is a neutral heuristic placeholder to edit.`,
    300,
  );
  return { summary, source: 'heuristic' };
}

/** A fresh TODO voice stub (returned by value so callers can never mutate a shared one). */
function voiceTodoStub(): LlmVoice {
  return {
    draft: {
      bullets: [
        'TODO: describe the brand voice in 3-6 short bullets (LLM assist was unavailable).',
        'TODO: note the tone (for example warm, precise, playful, or authoritative).',
        'TODO: list one thing the voice deliberately avoids.',
      ],
      examples: [
        { before: 'TODO: a plain sentence.', after: 'TODO: the same sentence in the brand voice.' },
        { before: 'TODO: a second plain sentence.', after: 'TODO: rewritten in the brand voice.' },
        { before: 'TODO: a third plain sentence.', after: 'TODO: rewritten in the brand voice.' },
      ],
    },
    source: 'stub',
    isTodo: true,
  };
}

function sanitizeVoice(draft: { bullets: string[]; examples: LlmVoiceExample[] }): LlmVoiceDraft {
  return {
    bullets: draft.bullets.map((b) => sanitizeText(b, 200)),
    examples: draft.examples.map((e) => ({
      before: sanitizeText(e.before, 200),
      after: sanitizeText(e.after, 200),
    })),
  };
}

/** The canonical candidate hex matching `pick` (case-insensitive), or undefined. */
function canonicalCandidate(pick: string, candidates: readonly SeedCandidate[]): string | undefined {
  const want = pick.trim().toLowerCase();
  return candidates.find((c) => c.hex.trim().toLowerCase() === want)?.hex;
}

// --- Options + orchestration -------------------------------------------------

export interface RunLlmAssistOptions {
  /** Disable all LLM passes (`--no-llm`) — returns status 'skipped'. */
  noLlm?: boolean;
  /** Command the default spawner runs (default: env ONBRAND_CLAUDE_BIN, else 'claude'). */
  claudeCommand?: string;
  /** Per-pass wall-clock budget in ms (default LLM_DEFAULT_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Heuristic seed used when the color-pick pass has no candidates (default FALLBACK_BRAND_SEED). */
  fallbackSeed?: string;
  /** Override the whole subprocess seam (offline tests: nodeScriptSpawner). */
  spawn?: ClaudeSpawner;
  /** Extra args appended to every `claude -p` invocation (e.g. --model). */
  extraArgs?: string[];
}

function resolveCommand(options: RunLlmAssistOptions): string {
  return options.claudeCommand ?? process.env.ONBRAND_CLAUDE_BIN ?? 'claude';
}

/** First usable screenshot path (prefers a viewport/full/light capture). */
function pickScreenshotPath(extraction: RawExtraction): string | undefined {
  if (extraction.screenshots.length === 0) return undefined;
  const preferred = extraction.screenshots.find((s) =>
    ['viewport', 'full', 'light'].includes(s.label),
  );
  return (preferred ?? extraction.screenshots[0])?.path;
}

/**
 * Tools an untrusted-content pass must never reach. EVERY pass embeds untrusted
 * page-derived data (url, font names, palette, screenshot), so the restriction
 * is applied on EVERY pass — NOT gated on screenshot presence (the review's
 * load-bearing fix). It rides `--disallowedTools`, not just `--allowedTools`:
 * in the claude CLI permission model DENY overrides ALLOW, so a deny-list blocks
 * these tools even under an ambient auto-approve settings profile (this operator's
 * global settings auto-approve Bash/Edit/Write). An allow-list alone MERGES with
 * settings and would not block them. Verified against `claude --help` v2.1.170:
 * both `--allowedTools` and `--disallowedTools` exist; there is no dedicated
 * no-tools flag, so "no tools" is expressed as a deny-list of every tool.
 *
 * EXPORTED (Step 9, #38): this list (and `READ_DENY_TOOLS`, `MCP_DENY_TOOLS`,
 * `SAFE_PERMISSION_MODE` below) is the security-critical SHAPE of the
 * tool-restriction firewall. `mood-judge.ts`'s production `VisionJudge` spawns
 * `claude` the same untrusted-content way this module does (a screenshot/PNG
 * path embedded in the prompt, read via the Read tool) and MUST apply the
 * identical deny-list — duplicating this list would be exactly the drift
 * `code-quality.md`'s "one source of truth for data-shape constants" rule
 * exists to prevent for a firewall this load-bearing.
 *
 * REMOVED (Step 9, #38 finding): `'SlashCommand'` was previously listed here
 * but is NOT a recognized `--disallowedTools` tool name on this workspace's
 * installed `claude` CLI (v2.1.170, verified empirically while building the
 * Step 9 live anchor test) — passing it makes the ENTIRE invocation exit 1
 * with "Permission deny rule "SlashCommand" matches no known tool", which
 * would silently have broken every real (non-fake-bin) `claude -p` call this
 * module makes. Removing it does not widen the actual attack surface: slash
 * commands are a feature of the interactive prompt loop, not a callable tool
 * the model can invoke mid-turn in headless `-p`/print mode, so there was
 * nothing this entry was correctly denying in the first place.
 */
export const EXEC_DENY_TOOLS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Edit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
] as const;

/** Read-family tools: allowed (scoped, Read only) on a screenshot pass; denied otherwise. */
export const READ_DENY_TOOLS = ['Read', 'Glob', 'Grep'] as const;

/**
 * MCP-tool deny (iteration-3 low). The enumerated deny-lists above cover the
 * built-ins; MCP tools are named `mcp__<server>__<fn>`. A bare non-interactive
 * `claude -p` does NOT load the operator's MCP servers without an explicit
 * `--mcp-config` (and this module never passes one), so no MCP tool is reachable
 * today — but we deny `mcp__*` structurally anyway. `claude --help` v2.1.170
 * documents no tool-name wildcard, so this entry is inert if the CLI does not
 * prefix-match and blocks all MCP tools if it does — belt over the documented
 * "no MCP config is inherited" suspenders. Harmless either way (an unmatched
 * deny entry is a no-op, never a parse error).
 */
export const MCP_DENY_TOOLS = ['mcp__*'] as const;

/** The claude CLI permission mode forced on every pass. `default` honors the
 * deny-list; passing it explicitly prevents an inherited/ambient
 * `bypassPermissions` from silently voiding the whole firewall (iteration-3 low). */
export const SAFE_PERMISSION_MODE = 'default';

/**
 * Args + cwd for one pass: prompt + an UNCONDITIONAL tool restriction + a forced
 * safe permission mode. A screenshot pass allows ONLY Read (scoped via --add-dir
 * AND a pinned `cwd` so the child's ambient Read root is exactly the screenshot
 * dir, not the inherited cwd tree — the iteration-3 Read-path fix) and denies
 * everything else; a text pass denies ALL tools and runs with no cwd override.
 * Read is kept out of the deny-list on the screenshot pass so the allow wins
 * (deny would otherwise override it). `opts.screenshotPath` is the SAME value
 * runLlmAssist already resolved to absolute and embedded in the prompt (single
 * source — see the resolve there); the `path.resolve` below is a defensive
 * idempotent normalize so buildPassArgs stays correct even if called standalone,
 * and can never diverge from the prompt's embedded path.
 */
function buildPassArgs(
  prompt: string,
  opts: { screenshotPath?: string; extraArgs?: readonly string[] },
): { args: string[]; cwd?: string } {
  const args = ['-p', prompt];
  let cwd: string | undefined;
  if (opts.screenshotPath !== undefined) {
    const dir = path.dirname(path.resolve(opts.screenshotPath));
    args.push('--allowedTools', 'Read');
    args.push(
      '--disallowedTools',
      ...EXEC_DENY_TOOLS,
      ...READ_DENY_TOOLS.filter((t) => t !== 'Read'),
      ...MCP_DENY_TOOLS,
    );
    args.push('--add-dir', dir);
    // Converge the child's ambient Read root with --add-dir: --add-dir is
    // ADDITIVE to the startup cwd, so without pinning cwd the model could Read
    // the whole inherited tree and smuggle a file into the persisted
    // rationale/summary. Pin cwd to exactly the screenshot's directory.
    cwd = dir;
  } else {
    args.push('--disallowedTools', ...EXEC_DENY_TOOLS, ...READ_DENY_TOOLS, ...MCP_DENY_TOOLS);
  }
  args.push('--permission-mode', SAFE_PERMISSION_MODE);
  if (opts.extraArgs !== undefined) args.push(...opts.extraArgs);
  return { args, cwd };
}

/**
 * Run the three LLM-assist passes over an extraction. NEVER throws: any failure
 * degrades to a heuristic pick / stub with a collected warning. Step 12's
 * from-url command is the production caller; `manifestStatus` is written to
 * manifest.json's `llm` field.
 */
export async function runLlmAssist(
  extraction: RawExtraction,
  candidates: readonly SeedCandidate[],
  options: RunLlmAssistOptions = {},
): Promise<LlmAssistResult> {
  const warnings: string[] = [];
  const top5 = candidates.slice(0, 5);
  const candidateHexes = top5.map((c) => c.hex);
  const heuristicPick = top5[0]?.hex ?? options.fallbackSeed ?? FALLBACK_BRAND_SEED;
  const heuristicColorPick: LlmColorPick = {
    pick: heuristicPick,
    rationale: HEURISTIC_PICK_RATIONALE,
    source: 'heuristic',
  };

  // --no-llm: skip everything up front (heuristics only).
  if (options.noLlm === true) {
    return {
      status: 'skipped',
      manifestStatus: 'skipped',
      reason: 'disabled by --no-llm',
      colorPick: heuristicColorPick,
      aesthetic: heuristicAesthetic(extraction),
      voice: voiceTodoStub(),
      warnings,
    };
  }

  const spawner = options.spawn ?? makeDefaultSpawner(resolveCommand(options));
  const timeoutMs = options.timeoutMs ?? LLM_DEFAULT_TIMEOUT_MS;
  // SINGLE SOURCE OF TRUTH for the screenshot path: resolve to absolute exactly
  // ONCE here, then feed this SAME value to BOTH the prompt builders (embedded
  // verbatim for the Read tool) AND buildPassArgs (whose cwd/--add-dir is its
  // directory). Because the screenshot pass pins the child's cwd to that
  // directory, a relative path in the prompt would resolve against the wrong
  // base and the Read would silently fail — so the caller may pass either form
  // (relative or absolute) and it is normalized here before it can diverge.
  const rawScreenshot = pickScreenshotPath(extraction);
  const screenshotPath = rawScreenshot !== undefined ? path.resolve(rawScreenshot) : undefined;
  const paletteHexes = extraction.colors.slice(0, 8).map((c) => c.hex);
  const fontFamilies = extraction.fonts
    .map((f) => f.families.find((x) => typeof x === 'string' && x.trim() !== ''))
    .filter((x): x is string => x !== undefined)
    .slice(0, 6);

  let colorPick = heuristicColorPick;
  let aesthetic = heuristicAesthetic(extraction);
  let voice = voiceTodoStub();
  let anyLlmOutput = false;
  let hardStop: 'cli-absent' | 'auth-dead' | undefined;

  // Pass (a): brand-color pick (uses the screenshot).
  {
    const prompt = buildColorPickPrompt({ candidates: top5, screenshotPath, url: extraction.url });
    const invocation = buildPassArgs(prompt, { screenshotPath, extraArgs: options.extraArgs });
    const pass = await runPass(
      'brand-color-pick',
      spawner,
      invocation,
      colorPickSchema(candidateHexes),
      timeoutMs,
    );
    warnings.push(...pass.warnings);
    if (pass.hardStop !== undefined) {
      hardStop = pass.hardStop;
    } else if (pass.value !== undefined) {
      const canonical = canonicalCandidate(pass.value.pick, top5) ?? heuristicPick;
      colorPick = { pick: canonical, rationale: sanitizeText(pass.value.rationale, 240), source: 'llm' };
      anyLlmOutput = true;
    } else {
      warnings.push('brand-color-pick: fell back to the heuristic top candidate after a retry');
    }
  }

  // Pass (b): aesthetic summary.
  if (hardStop === undefined) {
    const prompt = buildAestheticPrompt({ paletteHexes, fontFamilies, screenshotPath, url: extraction.url });
    const invocation = buildPassArgs(prompt, { screenshotPath, extraArgs: options.extraArgs });
    const pass = await runPass('aesthetic-summary', spawner, invocation, aestheticSchema, timeoutMs);
    warnings.push(...pass.warnings);
    if (pass.hardStop !== undefined) {
      hardStop = pass.hardStop;
    } else if (pass.value !== undefined) {
      aesthetic = { summary: sanitizeText(pass.value.summary, 300), source: 'llm' };
      anyLlmOutput = true;
    } else {
      warnings.push('aesthetic-summary: fell back to a heuristic stub after a retry');
    }
  }

  // Pass (c): voice & tone draft (no screenshot).
  if (hardStop === undefined) {
    const prompt = buildVoicePrompt({
      fontFamilies,
      aestheticSummary: aesthetic.source === 'llm' ? aesthetic.summary : undefined,
      url: extraction.url,
    });
    const invocation = buildPassArgs(prompt, { extraArgs: options.extraArgs });
    const pass = await runPass('voice-tone', spawner, invocation, voiceSchema, timeoutMs);
    warnings.push(...pass.warnings);
    if (pass.hardStop !== undefined) {
      hardStop = pass.hardStop;
    } else if (pass.value !== undefined) {
      voice = { draft: sanitizeVoice(pass.value), source: 'llm', isTodo: false };
      anyLlmOutput = true;
    } else {
      warnings.push('voice-tone: fell back to the TODO stub after a retry');
    }
  }

  // Finalize status + reason.
  let status: LlmAssistStatus;
  let reason: string | undefined;
  if (hardStop !== undefined) {
    const base = hardStop === 'cli-absent' ? CLI_ABSENT_REASON : AUTH_DEAD_REASON;
    status = anyLlmOutput ? 'degraded' : 'skipped';
    // When earlier passes already used the LLM, the base "ran heuristics only"
    // text is imprecise — note the partial success.
    reason = anyLlmOutput ? `${base}; earlier pass(es) had already used the LLM` : base;
  } else if (colorPick.source === 'llm' && aesthetic.source === 'llm' && voice.source === 'llm') {
    status = 'ok';
  } else if (anyLlmOutput) {
    // Most common degraded path: 1-2 passes fell back. reason is documented as
    // present for ANY degraded result (LlmAssistResult.reason) — set it here too.
    status = 'degraded';
    reason = PARTIAL_FALLBACK_REASON;
  } else {
    status = 'degraded';
    reason = ALL_FELL_BACK_REASON;
  }
  const manifestStatus: LlmManifestStatus = anyLlmOutput ? 'used' : 'skipped';

  return {
    status,
    manifestStatus,
    ...(reason !== undefined ? { reason } : {}),
    colorPick,
    aesthetic,
    voice,
    warnings,
  };
}
