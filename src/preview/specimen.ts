/**
 * specimen page generation for `onbrand preview` (plan.md §6, §7) — the thin
 * filesystem orchestrator of src/preview.
 *
 * Module map (split per-concern, matching src/check's granularity):
 *   dist-parse.ts — dist-output parsers + untrusted-input guards (pure strings)
 *   render.ts     — the specimen HTML template (pure model -> string)
 *   specimen.ts   — THIS file: read dist/, assemble the model, write the page,
 *                   open-in-browser helper
 *
 * `onbrand preview` generates <projectDir>/brand/dist/specimen.html: a single
 * standalone page rendering every token group on real sample components
 * (headings, body text, buttons, cards, status badges, chart swatch row,
 * diagram palette row, table, form controls) with a keyboard-accessible
 * light/dark toggle.
 *
 * DIST-ONLY CONSUMER (plan §7: "uses only dist/ outputs — enforced by test").
 * src/preview imports NOTHING from src/build or src/schema — node builtins,
 * its own siblings, and THREE justified exceptions: the shared identifier
 * char-class guards in build/emitters/naming.ts, the loadable-Google-Fonts
 * set (extract/fonts.ts's from-url lookalike table), and filesystem.ts's
 * stable-read/publication primitives. The first two are pure and read no
 * token data; the filesystem owner keeps preview's safety rules aligned with
 * the other manifest publishers. The enforcement test
 * (test/preview.specimen.test.ts) walks the import graph of every src/preview
 * file and whitelists exactly those specifiers. What it reads at runtime is a
 * project's ALREADY-BUILT dist/:
 *
 *   - tokens.css     : LINKED (<link href="tokens.css">), not inlined. Also
 *                      PARSED for the --font-* first-choice families, so a
 *                      Google-Fonts <link> can load the mapped webfonts.
 *   - components.css : LINKED. Also PARSED to discover the `.badge--<name>`
 *                      recipes so status badges are project-derived.
 *   - diagram-palette.json : READ at generation time; its light+dark VALUES
 *                      are embedded into ONE fenced <style> island (the
 *                      grep-gate carve-out — full rationale in render.ts).
 *   - palette.svg    : REFERENCED via <img> where present.
 *
 * LINK vs INLINE (deliberate choice, plan §6). specimen.html is written INTO
 * brand/dist/ alongside tokens.css + components.css, so `<link href="...">`
 * resolves as a sibling on a file:// page (Chromium loads sibling file://
 * stylesheets without CORS). Linking keeps the specimen a THIN consumer — the
 * page references the exact generated files a project ships, and the authored
 * HTML carries zero CSS bytes. Inlining would duplicate dist content into the
 * page and reintroduce authored color literals (the copied CSS declarations),
 * defeating the zero-literal grep gate.
 *
 * NO DIST -> EXIT 1 (documented decision, plan §6): preview REQUIRES an
 * existing build and errors with "run onbrand build first" rather than
 * auto-building — the plan frames preview as generating the specimen FROM a
 * build, and an implicit build would hide stale-source mistakes the check
 * gate exists to catch.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  assertFileTargetIsNotLinked,
  assertSafeRegularFileTarget,
  assertUnlinkedDirectoryPath,
  pathIsAbsent,
  publishStagedFile,
  removeOwnedFile,
  sameFileIdentity,
  stageFileExclusive,
  stableReadRegularFile,
  type FileIdentity,
  type StableRegularFile,
  type StagedFile,
} from '../filesystem.ts';
import {
  PreviewError,
  badgeNames,
  cssVarNames,
  loadableGoogleFonts,
  parseDiagramPalette,
  varsWithPrefix,
} from './dist-parse.ts';
import { renderSpecimen, type SpecimenModel } from './render.ts';
import {
  PREVIEW_COMPONENTS_CSS_INPUT,
  PREVIEW_DIAGRAM_PALETTE_INPUT,
  PREVIEW_TOKENS_CSS_INPUT,
  REQUIRED_PREVIEW_INPUTS,
  SPECIMEN_VIEW_OUTPUT,
} from './contract.ts';

// Re-export the pieces the CLI + tests reach through the preview front door.
export { PreviewError } from './dist-parse.ts';

/** dist outputs preview REQUIRES (a full `onbrand build` produces all of them). */
export const REQUIRED_DIST_FILES = REQUIRED_PREVIEW_INPUTS;

export interface PreviewResult {
  /** Absolute path to the written specimen.html. */
  specimenPath: string;
  /** Absolute paths of the dist files consumed. */
  consumed: string[];
  /** Present only when one stable, safe dist generation backed the render. */
  generation?: PreviewGenerationSnapshot;
}

export interface GeneratePreviewOptions {
  /** Deterministic test barrier after rendering and before specimen staging. */
  beforeSpecimenStage?: () => void;
}

export type PreviewFileIdentity = FileIdentity;

export interface PreviewConsumedFileSnapshot {
  relPath: string;
  sha256: string;
  identity: PreviewFileIdentity;
}

export interface PreviewGenerationSnapshot {
  distIdentity: PreviewFileIdentity;
  manifest: PreviewConsumedFileSnapshot & { content: string };
  specimen: PreviewConsumedFileSnapshot;
  requiredInputs: PreviewConsumedFileSnapshot[];
  palette:
    | { present: false }
    | { present: true; file: PreviewConsumedFileSnapshot };
}

function snapshot(relPath: string, file: StableRegularFile): PreviewConsumedFileSnapshot {
  return { relPath, sha256: file.sha256, identity: file.identity };
}

/**
 * Read a project's built dist/, assemble the model, and write dist/specimen.html.
 * Throws PreviewError when dist/ is not built yet (the CLI maps it to exit 1 with
 * the "run onbrand build first" hint).
 */
export function generatePreview(
  projectDir: string,
  options: GeneratePreviewOptions = {},
): PreviewResult {
  const resolvedProject = path.resolve(projectDir);
  const distDir = path.join(resolvedProject, 'brand', 'dist');
  const missing = REQUIRED_DIST_FILES.filter((f) => !existsSync(path.join(distDir, f)));
  if (missing.length > 0) {
    throw new PreviewError(
      `no built dist at ${distDir} (missing ${missing.join(', ')}) — run "onbrand build" first, then "onbrand preview"`,
    );
  }

  const tokensCssPath = path.join(distDir, PREVIEW_TOKENS_CSS_INPUT);
  const componentsCssPath = path.join(distDir, PREVIEW_COMPONENTS_CSS_INPUT);
  const diagramPath = path.join(distDir, PREVIEW_DIAGRAM_PALETTE_INPUT);
  const paletteSvgPath = path.join(distDir, 'palette.svg');

  let distIdentity: FileIdentity;
  try {
    assertUnlinkedDirectoryPath(resolvedProject, 'preview project tree');
    assertUnlinkedDirectoryPath(path.join(resolvedProject, 'brand'), 'preview brand tree');
    distIdentity = assertUnlinkedDirectoryPath(distDir, 'preview project tree');
  } catch (cause) {
    throw new PreviewError(cause instanceof Error ? cause.message : String(cause));
  }
  const manifestPath = path.join(distDir, 'manifest.json');
  try {
    assertFileTargetIsNotLinked(manifestPath, 'manifest target');
  } catch (cause) {
    throw new PreviewError(cause instanceof Error ? cause.message : String(cause));
  }
  const manifestBefore = stableReadRegularFile(manifestPath, { requireSingleLink: true });
  const tokensRead = stableReadRegularFile(tokensCssPath, { requireSingleLink: true });
  const componentsRead = stableReadRegularFile(componentsCssPath, { requireSingleLink: true });
  const diagramRead = stableReadRegularFile(diagramPath, { requireSingleLink: true });
  if (tokensRead === undefined || componentsRead === undefined || diagramRead === undefined) {
    throw new PreviewError('required dist inputs must be stable local non-linked regular files');
  }
  const tokensCss = tokensRead.bytes.toString('utf8');
  const componentsCss = componentsRead.bytes.toString('utf8');
  const diagramJson = diagramRead.bytes.toString('utf8');

  const paletteRead = stableReadRegularFile(paletteSvgPath, { requireSingleLink: true });
  const paletteSafelyAbsent = pathIsAbsent(paletteSvgPath);
  if (!paletteSafelyAbsent && paletteRead === undefined) {
    throw new PreviewError('optional dist/palette.svg must be a stable local single-link regular file');
  }
  const hasPaletteSvg = paletteRead !== undefined;

  const varNames = cssVarNames(tokensCss, `dist/${PREVIEW_TOKENS_CSS_INPUT}`);
  const model: SpecimenModel = {
    chartCategorical: varsWithPrefix(varNames, '--color-chart-categorical-', true),
    chartSequential: varsWithPrefix(varNames, '--color-chart-sequential-', true),
    chartChrome: varsWithPrefix(varNames, '--color-chart-chrome-', false),
    statusBadges: badgeNames(componentsCss),
    diagram: parseDiagramPalette(diagramJson, `dist/${PREVIEW_DIAGRAM_PALETTE_INPUT}`),
    hasPaletteSvg,
    fonts: loadableGoogleFonts(tokensCss),
  };

  const html = renderSpecimen(model);

  // Stage-then-rename (mirrors compile.ts) so a mid-write failure never leaves
  // a torn specimen.html.
  const specimenPath = path.join(distDir, SPECIMEN_VIEW_OUTPUT);
  let staged: StagedFile | undefined;
  try {
    assertSafeRegularFileTarget(specimenPath, 'specimen target');
    options.beforeSpecimenStage?.();
    staged = stageFileExclusive(specimenPath, html);
    publishStagedFile(staged, specimenPath);
  } catch (cause) {
    if (staged !== undefined) removeOwnedFile(staged.path, staged.identity);
    throw new PreviewError(
      `failed while writing ${specimenPath} (${cause instanceof Error ? cause.message : String(cause)}) — re-run "onbrand preview"`,
    );
  }

  const manifestAfter = stableReadRegularFile(manifestPath, { requireSingleLink: true });
  const specimenRead = stableReadRegularFile(specimenPath, { requireSingleLink: true });
  const stableManifest = manifestBefore !== undefined && manifestAfter !== undefined &&
    sameFileIdentity(manifestBefore.identity, manifestAfter.identity) &&
    manifestBefore.bytes.equals(manifestAfter.bytes);
  const generation: PreviewGenerationSnapshot | undefined = stableManifest && specimenRead !== undefined &&
    (hasPaletteSvg ? paletteRead !== undefined : paletteSafelyAbsent)
    ? {
        distIdentity,
        manifest: {
          ...snapshot('manifest.json', manifestBefore),
          content: manifestBefore.bytes.toString('utf8'),
        },
        specimen: snapshot(SPECIMEN_VIEW_OUTPUT, specimenRead),
        requiredInputs: [
          snapshot(PREVIEW_TOKENS_CSS_INPUT, tokensRead),
          snapshot(PREVIEW_COMPONENTS_CSS_INPUT, componentsRead),
          snapshot(PREVIEW_DIAGRAM_PALETTE_INPUT, diagramRead),
        ],
        palette: paletteRead !== undefined
          ? { present: true, file: snapshot('palette.svg', paletteRead) }
          : { present: false },
      }
    : undefined;

  return {
    specimenPath,
    consumed: [tokensCssPath, componentsCssPath, diagramPath, ...(model.hasPaletteSvg ? [paletteSvgPath] : [])],
    ...(generation !== undefined ? { generation } : {}),
  };
}

// ---------------------------------------------------------------------------
// openInBrowser
// ---------------------------------------------------------------------------

export interface OpenInBrowserOptions {
  /** Injectable spawn (tests assert the composed command without launching). */
  spawnFn?: typeof spawn;
  /** Platform override (tests exercise all three branches). Default: process.platform. */
  platform?: NodeJS.Platform;
  /**
   * Diagnostic sink for a launch failure. openInBrowser never throws and never
   * changes the caller's exit code (a preview/gallery that WROTE successfully
   * must not fail because a browser could not launch), but a swallowed error is
   * indistinguishable from a working `--open` — the M1 UAT `-LiteralPath` bug
   * shipped precisely because the failure was silent. `onError` is the seam that
   * makes the failure VISIBLE: the CLI wires it to a stderr warning, and unit
   * tests assert both the compose-time (synchronous spawn throw) and the
   * async 'error'-event paths route a single composed diagnostic here.
   */
  onError?: (message: string) => void;
}

/** Human-facing name of the opener for the platform (used in diagnostics). */
function openerName(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'powershell.exe Start-Process';
  if (platform === 'darwin') return 'open';
  return 'xdg-open';
}

/**
 * Open a file in the OS default browser (best-effort; cross-platform).
 * Detached so the browser outlives the CLI. The short-lived OS opener remains
 * referenced until it exits so nonzero launch failures can be reported before
 * the Node process terminates. `--open` is NOT exercised
 * end-to-end in tests (no browser side effects in CI); the command COMPOSITION
 * is unit-tested through the injectable seam above. Failure never throws and
 * never changes the exit code — a preview that wrote successfully must not exit
 * nonzero because a browser could not launch — but it IS surfaced through the
 * optional `onError` sink so the launch is never a silent no-op.
 *
 * win32: PowerShell `Start-Process -FilePath '<path>'`, NOT `cmd /c start`.
 * cmd.exe %VAR%-expands the path even through array-args spawn (empirically
 * confirmed: a path containing %USERNAME% had the real username substituted
 * before `start` saw it, and %%-doubling does NOT round-trip in command-line
 * context — it produced `%value%`). A PS single-quoted literal round-trips
 * `%`, `$`, backtick, and quotes exactly; its ONLY escape is doubling embedded
 * single quotes, applied below. (Step 6 review BUG-3.)
 *
 * `-FilePath` is Start-Process's target parameter; an earlier revision used
 * `-LiteralPath` (which Start-Process does NOT define — that's Invoke-Item's),
 * so `--open` threw "A parameter cannot be found that matches parameter name
 * 'LiteralPath'" and the swallowed error made it look like a no-op on Windows.
 * The composition test below asserts the exact param; a win32 regression test
 * verifies against the real Start-Process cmdlet that -FilePath exists and
 * -LiteralPath does not (M1 UAT finding).
 */
export function openInBrowser(target: string, options: OpenInBrowserOptions = {}): void {
  const spawnFn = options.spawnFn ?? spawn;
  const platform = options.platform ?? process.platform;
  const report = (cause: unknown): void => {
    options.onError?.(
      `could not open ${target} via ${openerName(platform)}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  };

  let child;
  try {
    if (platform === 'win32') {
      const literal = target.replaceAll("'", "''");
      child = spawnFn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference='Stop'; Start-Process -FilePath '${literal}'`,
        ],
        { detached: true, stdio: 'ignore' },
      );
    } else if (platform === 'darwin') {
      child = spawnFn('open', [target], { detached: true, stdio: 'ignore' });
    } else {
      child = spawnFn('xdg-open', [target], { detached: true, stdio: 'ignore' });
    }
  } catch (cause) {
    // Some spawn failures surface synchronously (e.g. an EACCES on the opener
    // binary); route them through the same diagnostic rather than crashing.
    report(cause);
    return;
  }

  // The common launch failure (opener binary not found: ENOENT) arrives on the
  // async 'error' event, not as a throw — surface it instead of swallowing.
  child.on('error', report);
  child.on('exit', (code, signal) => {
    if (code !== 0) {
      report(
        new Error(
          code === null
            ? `opener terminated by signal ${signal ?? 'unknown'}`
            : `opener exited with code ${code}`,
        ),
      );
    }
  });
}
