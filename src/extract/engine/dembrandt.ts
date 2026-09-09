/**
 * dembrandt engine wrapper — implements the ExtractionEngine adapter (adapter.ts)
 * over the `dembrandt` CLI (npm package, MIT, verified v0.23.1 at the Step 8
 * spike; see docs/findings/dembrandt-spike.md).
 *
 * Two layers, deliberately split:
 *   - `mapDembrandtOutput(...)` — a PURE function from dembrandt's `--json-only`
 *     stdout JSON to our RawExtraction. No I/O. This is what the offline tests
 *     exercise against the committed fixtures under
 *     test/fixtures/extraction/dembrandt/ (no network in `npm test`).
 *   - `DembrandtEngine` — the process wrapper: spawns the dembrandt bin with
 *     `--json-only` (JSON on stdout, progress spinner on stderr), parses, maps.
 *     Only `from-url` calls this; the test suite never does.
 *
 * Mapping doctrine (kept conservative — the engine observes, the Step 10
 * normalizer interprets):
 *   - `colors.detected[]` clusters carry frequency (`count`); role evidence is
 *     layered on from `colors.semantic` (background/text/primary/secondary/
 *     accent), `borders.combinations[]` (border), `gradients[].stopColors`
 *     (gradient), `shadows[]` colors are NOT parsed here (normalizer's job),
 *     and `components` (button backgrounds and link colors -> accent: a CTA/
 *     link color is an interactive accent, not the page background).
 *   - `colors.cssVariables` (design-token custom props) are real signal but
 *     have no usage counts; v1 skips them — recorded as a known enrichment in
 *     the findings doc, not silently dropped: a warning notes the skipped count.
 *   - Typography styles aggregate to FontStack (per family+role) and TypeSize
 *     (per px). dembrandt emits `size` as "16px (1.00rem)" and `lineHeight` as
 *     a unitless multiplier string — both parsed defensively.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { killTree } from './proc.ts';
import type {
  ColorCluster,
  ColorRole,
  ExtractOptions,
  ExtractionEngine,
  FontRole,
  FontStack,
  RadiusValue,
  RawExtraction,
  Screenshot,
  ShadowObservation,
  SpacingValue,
  TypeSize,
} from './adapter.ts';

/** Default per-run wall-clock budget (ms) — the spike's disqualification line. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Cap on accumulated child stdout+stderr bytes (the spike's own runs used a
 * 64 MiB exec buffer; stripe.com, the heaviest observed site, produced 102 KB).
 * Past the cap the process tree is killed and a clean DembrandtError is thrown
 * instead of letting a pathological page grow RSS without bound.
 */
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Thrown for any engine-level failure (spawn, nonzero exit, unparseable JSON). */
export class DembrandtError extends Error {
  constructor(
    message: string,
    readonly stderrTail?: string,
  ) {
    super(message);
    this.name = 'DembrandtError';
  }
}

// --- small guards (no zod here: the input is a foreign tool's JSON; we take
// --- what matches and skip what does not, never crashing on shape drift) -----

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// --- color plumbing -----------------------------------------------------------

/**
 * Normalize a CSS color string to lowercase hex. Handles `#hex` passthrough and
 * `rgb()/rgba()` (dembrandt's semantic/component colors). Returns undefined for
 * anything else (keywords, oklch — dembrandt does not emit those today).
 */
export function cssColorToHex(css: string): string | undefined {
  const trimmed = css.trim().toLowerCase();
  if (trimmed.startsWith('#')) {
    return /^#([0-9a-f]{6}|[0-9a-f]{8}|[0-9a-f]{3,4})$/.test(trimmed) ? trimmed : undefined;
  }
  const match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(
    trimmed,
  );
  if (match === null) return undefined;
  const channel = (raw: string): string =>
    Math.max(0, Math.min(255, Math.round(Number(raw))))
      .toString(16)
      .padStart(2, '0');
  const [, r, g, b, a] = match;
  let hex = `#${channel(r!)}${channel(g!)}${channel(b!)}`;
  if (a !== undefined && Number(a) < 1) {
    hex += Math.round(Number(a) * 255)
      .toString(16)
      .padStart(2, '0');
  }
  return hex;
}

/** Parse the leading px number out of strings like "16px (1.00rem)" or "8px". */
function leadingPx(value: string): number | undefined {
  const match = /^\s*([\d.]+)px/.exec(value);
  return match === null ? undefined : Number(match[1]);
}

// --- cluster accumulator ------------------------------------------------------

class ClusterMap {
  private readonly map = new Map<string, ColorCluster>();

  ensure(hex: string, frequency: number): ColorCluster {
    let cluster = this.map.get(hex);
    if (cluster === undefined) {
      cluster = { hex, frequency, roles: [] };
      this.map.set(hex, cluster);
    }
    return cluster;
  }

  addRole(cssColor: string, role: ColorRole, count: number): void {
    const hex = cssColorToHex(cssColor);
    if (hex === undefined || count <= 0) return;
    // A role observation on a never-detected color is still an observation:
    // materialize the cluster with the evidence count as its frequency.
    const cluster = this.ensure(hex, count);
    const existing = cluster.roles.find((r) => r.role === role);
    if (existing !== undefined) existing.count += count;
    else cluster.roles.push({ role, count });
  }

  values(): ColorCluster[] {
    // Deterministic: by frequency desc, then hex asc.
    return [...this.map.values()].sort(
      (a, b) => b.frequency - a.frequency || a.hex.localeCompare(b.hex),
    );
  }
}

/** dembrandt semantic slot -> our role vocabulary. */
const SEMANTIC_ROLE: Record<string, ColorRole> = {
  background: 'background',
  text: 'text',
  primary: 'accent',
  secondary: 'accent',
  accent: 'accent',
};

/** dembrandt typography `context` -> our FontRole. */
function contextToFontRole(context: string): FontRole {
  if (/^heading/.test(context)) return 'heading';
  if (context === 'body' || context === 'paragraph') return 'body';
  if (/^(code|pre|kbd|samp|mono)/.test(context)) return 'mono';
  return 'unknown';
}

// --- the pure mapper ----------------------------------------------------------

/**
 * Map dembrandt `--json-only` output to RawExtraction. Pure: no I/O, no clock —
 * `screenshots` are injected by the caller (the CLI only writes a PNG when
 * `--screenshot <path>` was passed; the JSON itself never references it).
 * Throws DembrandtError on structurally-unusable input (not an object, or a
 * dembrandt error envelope) — shape drift in optional sections degrades to
 * empty arrays instead.
 */
export function mapDembrandtOutput(raw: unknown, screenshots: Screenshot[] = []): RawExtraction {
  if (!isObj(raw)) {
    throw new DembrandtError('dembrandt output is not a JSON object');
  }
  if (isObj(raw['error'])) {
    const code = asString(raw['error']['code']) ?? 'UNKNOWN';
    const message = asString(raw['error']['message']) ?? '';
    throw new DembrandtError(`dembrandt extraction failed (${code}): ${message}`);
  }

  const warnings: string[] = [];
  const clusters = new ClusterMap();
  const colors = isObj(raw['colors']) ? raw['colors'] : {};

  // 1. Detected clusters: the frequency backbone.
  for (const entry of asArray(colors['detected'])) {
    if (!isObj(entry)) continue;
    const hex = asString(entry['normalized']) ?? cssColorToHex(asString(entry['color']) ?? '');
    const count = asNumber(entry['count']);
    if (hex === undefined || count === undefined) continue;
    clusters.ensure(hex.toLowerCase(), count);
  }

  // 2. Curated palette entries not already present (e.g. hover/focus colors).
  for (const entry of asArray(colors['palette'])) {
    if (!isObj(entry)) continue;
    const hex = asString(entry['normalized']) ?? cssColorToHex(asString(entry['color']) ?? '');
    const count = asNumber(entry['count']) ?? 1;
    if (hex === undefined) continue;
    clusters.ensure(hex.toLowerCase(), count);
  }

  // 3. Role evidence layers.
  const semantic = isObj(colors['semantic']) ? colors['semantic'] : {};
  for (const [slot, value] of Object.entries(semantic)) {
    const role = SEMANTIC_ROLE[slot];
    const css = asString(value);
    if (role === undefined || css === undefined) continue;
    const hex = cssColorToHex(css);
    const detectedFreq = hex === undefined ? undefined : clusters.ensure(hex, 1).frequency;
    clusters.addRole(css, role, detectedFreq ?? 1);
  }

  const borders = isObj(raw['borders']) ? raw['borders'] : {};
  for (const combo of asArray(borders['combinations'])) {
    if (!isObj(combo)) continue;
    const css = asString(combo['color']);
    const count = asNumber(combo['count']) ?? 1;
    if (css !== undefined) clusters.addRole(css, 'border', count);
  }

  for (const gradient of asArray(raw['gradients'])) {
    if (!isObj(gradient)) continue;
    const count = asNumber(gradient['count']) ?? 1;
    for (const stop of asArray(gradient['stopColors'])) {
      const css = asString(stop);
      if (css !== undefined) clusters.addRole(css, 'gradient', count);
    }
  }

  const components = isObj(raw['components']) ? raw['components'] : {};
  for (const button of asArray(components['buttons'])) {
    if (!isObj(button) || !isObj(button['states'])) continue;
    const state = isObj(button['states']['default']) ? button['states']['default'] : {};
    const bg = asString(state['backgroundColor']);
    const fg = asString(state['color']);
    if (bg !== undefined) clusters.addRole(bg, 'accent', 1);
    if (fg !== undefined) clusters.addRole(fg, 'text', 1);
  }
  for (const link of asArray(components['links'])) {
    if (!isObj(link)) continue;
    const css = asString(link['color']);
    if (css !== undefined) clusters.addRole(css, 'accent', 1);
  }

  const cssVarCount = Object.keys(isObj(colors['cssVariables']) ? colors['cssVariables'] : {}).length;
  if (cssVarCount > 0) {
    warnings.push(
      `${cssVarCount} color-valued CSS custom properties reported by dembrandt were not mapped (no usage counts; v1 skips them)`,
    );
  }

  // 4. Typography -> font stacks + type sizes.
  const typography = isObj(raw['typography']) ? raw['typography'] : {};
  const fontAgg = new Map<string, FontStack>();
  const sizeAgg = new Map<number, TypeSize>();
  for (const style of asArray(typography['styles'])) {
    if (!isObj(style)) continue;
    const family = asString(style['family']);
    const context = asString(style['context']) ?? 'unknown';
    if (family !== undefined) {
      const fallbacks = asString(style['fallbacks']);
      const families = [
        family,
        ...(fallbacks === undefined ? [] : fallbacks.split(',').map((f) => f.trim())),
      ].filter((f) => f !== '');
      const role = contextToFontRole(context);
      const key = `${families.join('|')} :: ${role}`;
      const existing = fontAgg.get(key);
      if (existing !== undefined) existing.frequency += 1;
      else fontAgg.set(key, { families, role, frequency: 1 });
    }
    const sizeStr = asString(style['size']);
    const px = sizeStr === undefined ? undefined : leadingPx(sizeStr);
    if (px !== undefined) {
      const existing = sizeAgg.get(px);
      if (existing !== undefined) {
        existing.frequency += 1;
      } else {
        const size: TypeSize = { px, frequency: 1 };
        const weight = asNumber(style['weight']);
        if (weight !== undefined) size.fontWeight = weight;
        const lineHeight = asString(style['lineHeight']);
        if (lineHeight !== undefined) {
          const lhPx = lineHeight.endsWith('px') ? leadingPx(lineHeight) : Number(lineHeight) * px;
          if (lhPx !== undefined && Number.isFinite(lhPx)) size.lineHeightPx = lhPx;
        }
        sizeAgg.set(px, size);
      }
    }
  }

  // 5. Spacing, radii, shadows.
  const spacingObj = isObj(raw['spacing']) ? raw['spacing'] : {};
  const spacing: SpacingValue[] = [];
  for (const entry of asArray(spacingObj['commonValues'])) {
    if (!isObj(entry)) continue;
    const px = asNumber(entry['numericValue']);
    const count = asNumber(entry['count']) ?? 1;
    if (px !== undefined) spacing.push({ px, frequency: count });
  }

  const radiusObj = isObj(raw['borderRadius']) ? raw['borderRadius'] : {};
  const radii: RadiusValue[] = [];
  for (const entry of asArray(radiusObj['values'])) {
    if (!isObj(entry)) continue;
    const px = asNumber(entry['numericValue']);
    const count = asNumber(entry['count']) ?? 1;
    if (px !== undefined) radii.push({ px, frequency: count });
  }

  const shadows: ShadowObservation[] = [];
  for (const entry of asArray(raw['shadows'])) {
    if (!isObj(entry)) continue;
    const css = asString(entry['shadow']);
    const count = asNumber(entry['count']) ?? 1;
    if (css !== undefined) shadows.push({ css, frequency: count });
  }

  const meta = isObj(raw['meta']) ? raw['meta'] : {};
  const result: RawExtraction = {
    url: asString(raw['url']) ?? '',
    extractedAt: asString(raw['extractedAt']) ?? '',
    engine: { name: 'dembrandt', version: asString(meta['dembrandtVersion']) ?? 'unknown' },
    colors: clusters.values(),
    fonts: [...fontAgg.values()],
    typeSizes: [...sizeAgg.values()].sort((a, b) => a.px - b.px),
    spacing: spacing.sort((a, b) => a.px - b.px),
    radii: radii.sort((a, b) => a.px - b.px),
    shadows,
    screenshots,
  };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}

// --- the process wrapper -------------------------------------------------------

/**
 * Resolve the dembrandt CLI entry from our node_modules.
 *
 * Deliberately `require.resolve('dembrandt')` with NO subpath: dembrandt's
 * `exports` map routes "." to `dist/index.js` (which IS the bin — its
 * package.json declares `"bin": { "dembrandt": "dist/index.js" }`), while any
 * subpath not in the map — including `./package.json` — throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED under Node's exports encapsulation. Resolving
 * `dembrandt/package.json` here broke every no-arg `new DembrandtEngine()`
 * at construction time (iteration-2 critical fix; pinned by an offline test
 * through this exact production default path).
 */
export function resolveDembrandtBin(): string {
  const require = createRequire(import.meta.url);
  return require.resolve('dembrandt');
}

/**
 * ExtractionEngine implementation spawning the dembrandt CLI.
 * Spike-verified behaviors this wrapper encodes:
 *   - dembrandt prepends `https://` to schemeless input, so non-http(s) URLs
 *     (about:blank, file:) can never work — rejected up front with a clear error.
 *   - `--json-only` writes pure JSON to stdout, progress/spinner to stderr.
 *   - screenshots only exist when `--screenshot <path>` is passed (viewport-only).
 *   - a blank-ish page can take ~90s in content-wait heuristics; the default
 *     timeout stays at the 120s spike budget.
 */
export class DembrandtEngine implements ExtractionEngine {
  readonly name = 'dembrandt';

  /** `binPath` is public so callers/tests can verify what will be spawned. */
  constructor(readonly binPath: string = resolveDembrandtBin()) {}

  async extract(url: string, options: ExtractOptions = {}): Promise<RawExtraction> {
    if (!/^https?:\/\//i.test(url)) {
      throw new DembrandtError(
        `dembrandt only navigates http(s) URLs (got "${url}"); it rewrites schemeless input to https:// and fails on about:/file: schemes`,
      );
    }

    const args = [this.binPath, url, '--json-only'];
    if (options.dark === true) args.push('--dark-mode');
    if (options.pages !== undefined && options.pages > 1) {
      args.push('--crawl', String(options.pages));
    }
    let screenshotPath: string | undefined;
    if (options.screenshotDir !== undefined) {
      const slug = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_');
      // Unique per invocation: two concurrent extractions of the same host
      // (parallel batch, retry racing the original) must never race on one
      // filename and observe each other's — or a half-written — PNG.
      screenshotPath = path.join(options.screenshotDir, `${slug}-${randomUUID().slice(0, 8)}.png`);
      args.push('--screenshot', screenshotPath);
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const run = await new Promise<{
      stdout: string;
      stderr: string;
      code: number | null;
      timedOut: boolean;
      overflowed: boolean;
    }>((resolve, reject) => {
      // No spawn `timeout` option: Node's built-in kill hits only the
      // immediate child and leaves dembrandt's Chromium subprocess orphaned.
      // We own the timer and reap the whole tree (killTree above).
      const child = spawn(process.execPath, args, { windowsHide: true });
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let totalBytes = 0;
      let timedOut = false;
      let overflowed = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, timeoutMs);
      const onChunk = (sink: Buffer[]) => (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_OUTPUT_BYTES) {
          if (!overflowed) {
            overflowed = true;
            killTree(child.pid);
          }
          return; // stop accumulating; the tree is already being reaped
        }
        sink.push(chunk);
      };
      child.stdout.on('data', onChunk(outChunks));
      child.stderr.on('data', onChunk(errChunks));
      child.on('error', (cause) => {
        clearTimeout(timer);
        reject(new DembrandtError(`failed to spawn dembrandt (${cause.message})`));
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve({
          // Buffer.concat before decoding: a UTF-8 code point split across
          // chunk boundaries must not decode as replacement characters.
          stdout: Buffer.concat(outChunks).toString('utf8'),
          stderr: Buffer.concat(errChunks).toString('utf8'),
          code: exitCode,
          timedOut,
          overflowed,
        });
      });
    });

    if (run.timedOut) {
      throw new DembrandtError(
        `dembrandt timed out after ${timeoutMs}ms for ${url} (process tree killed)`,
        run.stderr.slice(-2000),
      );
    }
    if (run.overflowed) {
      throw new DembrandtError(
        `dembrandt output exceeded ${MAX_OUTPUT_BYTES} bytes for ${url} (process tree killed)`,
        run.stderr.slice(-2000),
      );
    }
    if (run.code !== 0) {
      // dembrandt writes an error envelope to stdout on failures; surface both.
      throw new DembrandtError(`dembrandt exited ${run.code} for ${url}`, run.stderr.slice(-2000));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(run.stdout);
    } catch {
      throw new DembrandtError(
        `dembrandt stdout was not valid JSON (${run.stdout.length} bytes)`,
        run.stderr.slice(-2000),
      );
    }

    const screenshots: Screenshot[] =
      screenshotPath !== undefined && existsSync(screenshotPath)
        ? [{ label: 'viewport', path: screenshotPath }]
        : [];
    return mapDembrandtOutput(parsed, screenshots);
  }
}
