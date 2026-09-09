/**
 * Compile pipeline orchestrator — `onbrand build`'s engine (plan.md §7).
 *
 * Engine decision: this is the plan-pre-approved HAND-ROLLED compiler, not
 * Style Dictionary. Style Dictionary v4's own docs say the stable DTCG
 * 2025.10 format (our pinned source format) "does not have full support yet";
 * evidence + rationale in docs/findings/style-dictionary-decision.md. The
 * emitter seam below (flat token list in, files out) is where a swap to SD
 * custom formats would happen if that ever changes.
 *
 * Flow: brand/tokens.json --resolveTokensFile--> resolved+validated light doc
 *       (+ brand/modes.dark.json --applyModeOverlay--> dark doc + overridden paths)
 *       --flattenTokens--> ordered flat token lists
 *       --emitters--> files under brand/dist/ + manifest.json (source hashing).
 *
 * Determinism: emitted content is a pure function of the resolved sources
 * (JS own-property enumeration walks — see flattenTokens for the exact rule —
 * LF line endings, stable JSON rendering); the manifest timestamp contract is
 * documented in manifest.ts. dist/ writes are staged-then-renamed so a
 * mid-write failure never leaves a fresh manifest describing files that were
 * not written (or vice versa).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { applyModeOverlay } from '../schema/modes.ts';
import {
  TokenResolveError,
  packageRoot,
  readJsonFile,
  resolveTokensFile,
} from '../schema/resolve.ts';
import { TokenValidationError } from '../schema/validate.ts';
import {
  childEntries,
  isPlainObject,
  isToken,
  isTokenType,
  isUnsafeName,
  joinPath,
  type TokenType,
  type TokenValue,
  type TokensDocument,
} from '../schema/types.ts';
import {
  buildManifest,
  computeSourceHash,
  renderManifest,
  type LlmStatus,
  type Manifest,
  type SourceHashResult,
  type SourceInput,
} from './manifest.ts';
import type { ResolvedTokens } from '../schema/resolve.ts';
import { emitComponents } from './emitters/components.ts';
import { assertUniqueVarNames, emitTokensCss } from './emitters/css.ts';
import { emitDesignMd } from './emitters/design-md.ts';
import { emitTokensPy } from './emitters/py.ts';
import { emitSvg } from './emitters/svg.ts';
import { emitThemeTw } from './emitters/tailwind.ts';
import { emitThemeTs } from './emitters/ts.ts';
import { renderGuide, type GuideResult } from './guide-render.ts';
import {
  INSPIRATION_VIEW_OUTPUT,
  SPECIMEN_VIEW_OUTPUT,
  prepareInspirationView,
} from '../inspiration/views.ts';
import {
  assertFileTargetIsNotLinked,
  assertSafeRegularFileTarget,
  assertUnlinkedDirectoryPath,
  inspectSafeRegularFileTarget,
  pathIsAbsent,
  publishStagedFile,
  removeOwnedFile,
  sameFileIdentity,
  stageFileExclusive,
  stableReadRegularFile,
  type StagedFile,
} from '../filesystem.ts';
import { acquireDistPublicationLock } from './publication-lock.ts';

// ---------------------------------------------------------------------------
// Flat token model (the emitter input)
// ---------------------------------------------------------------------------

export interface FlatToken {
  /** Path segments, e.g. ["color", "semantic", "bg"]. */
  path: string[];
  /** Dot path, e.g. "color.semantic.bg". */
  dotPath: string;
  /** Resolved $type (own or inherited from the nearest ancestor group). */
  type: TokenType;
  value: TokenValue;
  description?: string;
}

/**
 * Flatten a VALIDATED tokens document into a deterministic leaf-token list.
 *
 * Ordering rule (the determinism anchor for every emitter): JS own-property
 * enumeration order at each group — canonical numeric names ("1", "2", "10")
 * enumerate numeric-ascending FIRST, then all other names in JSON authoring
 * order. This is NOT pure authoring order when a group mixes or reorders
 * numeric names (the preset's ramps author 1..12 ascending, so its output
 * reads as authored). The golden test pins this rule.
 */
export function flattenTokens(doc: TokensDocument): FlatToken[] {
  const out: FlatToken[] = [];
  const rootType = isTokenType(doc.$type) ? doc.$type : undefined;
  walk(doc, [], rootType, out);
  return out;
}

function walk(
  group: Record<string, unknown>,
  segments: string[],
  inheritedType: TokenType | undefined,
  out: FlatToken[],
): void {
  for (const [name, child] of childEntries(group)) {
    if (isUnsafeName(name) || !isPlainObject(child)) continue; // validate() rejects these upstream
    const childSegments = [...segments, name];
    if (isToken(child)) {
      const ownType = child.$type;
      const type = isTokenType(ownType) ? ownType : inheritedType;
      if (type === undefined) {
        // Unreachable for a document validated as kind 'tokens'; guard anyway.
        throw new TokenValidationError(
          [{ path: joinPath(childSegments), message: 'token has no resolvable $type' }],
          'flattenTokens',
        );
      }
      out.push({
        path: childSegments,
        dotPath: joinPath(childSegments),
        type,
        value: child.$value,
        ...(typeof child.$description === 'string' ? { description: child.$description } : {}),
      });
    } else {
      const groupType = child['$type'];
      walk(child, childSegments, isTokenType(groupType) ? groupType : inheritedType, out);
    }
  }
}

// ---------------------------------------------------------------------------
// Emitter registry (plan.md §6: css,tw,ts,py,svg,components; designmd added
// post-v1 — docs/research/design-md-adoption.md)
// ---------------------------------------------------------------------------

export interface EmittedFile {
  /** Path relative to brand/dist/, forward slashes. */
  relPath: string;
  /** Full file content, LF line endings, trailing newline. */
  content: string;
}

export interface EmitterContext {
  /** Every token, resolved light values, flattenTokens enumeration order. */
  light: FlatToken[];
  /** Overlay-overridden tokens only, dark values, same enumeration order. */
  darkOverrides: FlatToken[];
  /** The resolved light document (for emitters that need tree shape, Steps 3-4). */
  lightDocument: TokensDocument;
  /** The overlay-merged dark document (undefined when no modes.dark.json). */
  darkDocument?: TokensDocument;
}

export type Emitter = (ctx: EmitterContext) => EmittedFile[];

export const EMITTER_IDS = ['css', 'tw', 'ts', 'py', 'svg', 'components', 'designmd'] as const;
export type EmitterId = (typeof EMITTER_IDS)[number];

export function isEmitterId(name: string): name is EmitterId {
  return (EMITTER_IDS as readonly string[]).includes(name);
}

/**
 * Implemented emitters. All seven contract IDs are live (svg + components
 * landed in Step 4; designmd landed post-v1 — the derived agent-facing
 * DESIGN.md output, docs/research/design-md-adoption.md). Any ID absent here
 * would be reported as `skipped` by compileBrand — the mechanism is retained
 * for a future contract-declared but unbuilt emitter (policy:
 * docs/findings/style-dictionary-decision.md § Emitter flag policy). The `svg`
 * emitter emits TWO files (palette.svg + diagram-palette.json — the shared
 * themed-SVG / diagram family; see emitters/svg.ts).
 */
const EMITTERS: Partial<Record<EmitterId, Emitter>> = {
  css: emitTokensCss,
  tw: emitThemeTw,
  ts: emitThemeTs,
  py: emitTokensPy,
  svg: emitSvg,
  components: emitComponents,
  designmd: emitDesignMd,
};

/**
 * The dist/-relative files each implemented emitter produces — the DECLARED
 * output-name registry the check gate's "dist incomplete" sweep reads
 * (src/check/drift.ts). To keep this map from drifting into a duplicate shape
 * constant (code-quality rule: one source of truth), compileBrand ENFORCES it
 * at build time: an emitter whose emitted file set differs from its row here
 * fails the build loudly, so every build (and every byte-identity test) pins
 * the two in lockstep.
 */
export const EMITTER_OUTPUTS: Record<EmitterId, readonly string[]> = {
  css: ['tokens.css'],
  tw: ['theme.tw.css'],
  ts: ['theme.ts'],
  py: ['tokens.py'],
  svg: ['palette.svg', 'diagram-palette.json'],
  components: ['components.css'],
  designmd: ['DESIGN.md'],
};

/**
 * Expected dist outputs of every IMPLEMENTED emitter — what a full
 * `onbrand build` would produce today. The check gate compares a manifest's
 * recorded outputs against this set so a dist that is missing an implemented
 * emitter's file (deleted, pruned by a subset rebuild, never built) can never
 * pass as complete.
 */
export function implementedEmitterOutputs(): Array<{ emitter: EmitterId; relPath: string }> {
  const out: Array<{ emitter: EmitterId; relPath: string }> = [];
  for (const id of EMITTER_IDS) {
    if (EMITTERS[id] === undefined) continue;
    for (const relPath of EMITTER_OUTPUTS[id]) out.push({ emitter: id, relPath });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Source loading (shared by `build` and `check`)
// ---------------------------------------------------------------------------

/**
 * Everything both `onbrand build` and `onbrand check` derive from a project's
 * `brand/` sources — resolved once, the SAME way, so the check gate's source
 * hash is computed through the production assembly path, never a re-implemented
 * sibling (measurement-validity: assemble through the production code path).
 */
export interface BrandSources {
  /** Absolute `<projectDir>/brand`. */
  brandDir: string;
  /** Resolved + validated light document and its extends chain. */
  resolved: ResolvedTokens;
  /** Overlay-merged dark document (undefined when there is no modes.dark.json). */
  darkDocument?: TokensDocument;
  /** Overlay-overridden tokens only, dark values (flattenTokens order). */
  darkOverrides: FlatToken[];
  /** Dot paths the overlay overrode (empty when no overlay). */
  overriddenPaths: string[];
  /** Whether brand/modes.dark.json exists. */
  hasModes: boolean;
  /**
   * Source inputs in canonical order (tokens.json + extends chain, then
   * modes.dark.json), labeled with the identity keys that feed the manifest
   * source hash. Pass straight to computeSourceHash().
   */
  sourceInputs: SourceInput[];
}

export interface LoadSourcesOptions {
  /** Override preset resolution root (tests). */
  presetsRoot?: string;
}

/**
 * Resolve, validate, and overlay-merge a project's brand/ sources. Throws
 * TokenResolveError / TokenValidationError on source problems (the CLI maps
 * both to exit 1 with the path-precise messages they carry) — including a
 * missing brand/tokens.json.
 */
export function loadBrandSources(projectDir: string, options: LoadSourcesOptions = {}): BrandSources {
  const brandDir = path.join(path.resolve(projectDir), 'brand');
  const tokensPath = path.join(brandDir, 'tokens.json');
  if (!existsSync(tokensPath)) {
    throw new TokenResolveError(
      `no ${tokensPath} found — run "onbrand init" first to scaffold brand/`,
    );
  }

  const resolved = resolveTokensFile(tokensPath, {
    ...(options.presetsRoot !== undefined ? { presetsRoot: options.presetsRoot } : {}),
  });

  const modesPath = path.join(brandDir, 'modes.dark.json');
  const hasModes = existsSync(modesPath);
  let darkDocument: TokensDocument | undefined;
  let darkOverrides: FlatToken[] = [];
  let overriddenPaths: string[] = [];
  if (hasModes) {
    const overlay = readJsonFile(modesPath);
    const overlayResult = applyModeOverlay(resolved.document, overlay);
    if (!overlayResult.ok) {
      throw new TokenValidationError(overlayResult.issues, modesPath);
    }
    darkDocument = overlayResult.document;
    overriddenPaths = overlayResult.overriddenPaths;
    const overridden = new Set(overriddenPaths);
    darkOverrides = flattenTokens(darkDocument).filter((token) => overridden.has(token.dotPath));
  }

  const sourceInputs: SourceInput[] = resolved.chain.map((absPath) => ({
    relPath: sourceLabel(brandDir, absPath),
    content: readFileSync(absPath, 'utf8'),
  }));
  if (hasModes) {
    sourceInputs.push({
      relPath: sourceLabel(brandDir, modesPath),
      content: readFileSync(modesPath, 'utf8'),
    });
  }

  return {
    brandDir,
    resolved,
    ...(darkDocument !== undefined ? { darkDocument } : {}),
    darkOverrides,
    overriddenPaths,
    hasModes,
    sourceInputs,
  };
}

/** Current source hash for a project's brand/ (the drift check's live baseline). */
export function computeBrandSourceHash(
  projectDir: string,
  options: LoadSourcesOptions = {},
): SourceHashResult {
  return computeSourceHash(loadBrandSources(projectDir, options).sourceInputs);
}

// ---------------------------------------------------------------------------
// compileBrand
// ---------------------------------------------------------------------------

export interface CompileOptions {
  /** Emitters to run (default: all contract IDs). Validated by the CLI. */
  emit?: readonly EmitterId[];
  /** Override preset resolution root (tests). */
  presetsRoot?: string;
  /** LLM status recorded in the manifest (from-url passes this; build: 'none'). */
  llm?: LlmStatus;
  /** Injectable clock for the manifest timestamp (tests). */
  now?: () => string;
  /** Deterministic child-process barrier used by publication race tests. */
  beforeManifestRename?: () => void;
  /** Deterministic child-process barrier immediately before guide publication. */
  beforeGuideRename?: () => void;
}

export interface CompileResult {
  /** Absolute paths written under brand/dist/, in write order. */
  written: string[];
  /** Requested emitters skipped because they land in a later build step. */
  skipped: EmitterId[];
  manifest: Manifest;
  /** Non-fatal manifest-merge warnings (dropped/pruned outputs keys — #19). */
  manifestWarnings: string[];
  /**
   * The guide.md fenced-block refresh outcome (post-emit phase, NOT a dist
   * output). Present only when the `svg` emitter ran this build — the palette
   * fence is kept in lockstep with palette.svg (see guide-render.ts).
   */
  guide?: GuideResult;
}

/**
 * Compile `<projectDir>/brand/` into `<projectDir>/brand/dist/`.
 * Throws TokenResolveError / TokenValidationError on source problems — the
 * CLI maps both to exit 1 with the path-precise messages they carry.
 */
export function compileBrand(projectDir: string, options: CompileOptions = {}): CompileResult {
  // Resolve + validate + overlay-merge through the shared loader (the same
  // assembly `onbrand check` uses). Throws on source problems (exit 1).
  const sources = loadBrandSources(projectDir, {
    ...(options.presetsRoot !== undefined ? { presetsRoot: options.presetsRoot } : {}),
  });
  const { brandDir, resolved, darkDocument, darkOverrides } = sources;

  const ctx: EmitterContext = {
    light: flattenTokens(resolved.document),
    darkOverrides,
    lightDocument: resolved.document,
    ...(darkDocument !== undefined ? { darkDocument } : {}),
  };

  // Var-name collision gate, hoisted so EVERY emitter subset inherits it
  // (tokenPathToCssVar is shared naming — the tw emitter reuses it, and a
  // collision-carrying source set must not build clean just because --emit
  // skipped css). The css emitter re-checks as defense in depth; py/tw carry
  // their OWN gates for the collision classes their name remaps introduce
  // (see emitters/naming.ts).
  assertUniqueVarNames([...ctx.light, ...ctx.darkOverrides]);

  // Run the requested emitters; collect not-yet-built ones as skipped.
  const requested = options.emit ?? EMITTER_IDS;
  const skipped: EmitterId[] = [];
  const files: EmittedFile[] = [];
  const ranEmitters: EmitterId[] = [];
  for (const id of requested) {
    const emitter = EMITTERS[id];
    if (emitter === undefined) {
      skipped.push(id);
      continue;
    }
    const emitted = emitter(ctx);
    // Enforce the declared output-name registry (see EMITTER_OUTPUTS): the
    // check gate's completeness sweep reads that map, so an emitter renaming
    // or adding an output without updating it must fail HERE, loudly, on
    // every build — never drift silently.
    const emittedNames = emitted.map((file) => file.relPath).sort();
    const declaredNames = [...EMITTER_OUTPUTS[id]].sort();
    if (
      emittedNames.length !== declaredNames.length ||
      emittedNames.some((name, i) => name !== declaredNames[i])
    ) {
      throw new Error(
        `emitter "${id}" emitted [${emittedNames.join(', ')}] but EMITTER_OUTPUTS declares ` +
          `[${declaredNames.join(', ')}] — update the registry in src/build/compile.ts (the check gate reads it)`,
      );
    }
    files.push(...emitted);
    ranEmitters.push(id);
  }

  // Only an invocation with no --emit list is a full build. Explicit subsets
  // must leave optional generated views alone so stale provenance remains
  // visible instead of being silently refreshed or removed.
  const fullBuild = options.emit === undefined;
  const inspirationView = fullBuild ? prepareInspirationView(projectDir, sources) : undefined;
  if (inspirationView?.html !== undefined) {
    files.push({ relPath: INSPIRATION_VIEW_OUTPUT, content: inspirationView.html });
  }

  // Source hashing: tokens.json + extends chain + modes.dark.json, in that
  // canonical order, labeled with identity keys (assembled by loadBrandSources
  // above — the SAME inputs `onbrand check` hashes).
  const distDir = path.join(brandDir, 'dist');
  const manifestPath = path.join(distDir, 'manifest.json');
  const manifestWarnings: string[] = [];
  const written: string[] = [];
  let manifest!: Manifest;
  let guide: GuideResult | undefined;
  const publicationLock = acquireDistPublicationLock(projectDir);
  let publicationError: unknown;
  try {
    // The lock begins before the previous manifest read and spans manifest
    // construction, staged output publication/removal, the final manifest
    // rename, and the palette-derived guide refresh.
    if (pathIsAbsent(distDir)) mkdirSync(distDir);
    assertUnlinkedDirectoryPath(distDir, 'dist tree');
    const specimenTarget = inspectSafeRegularFileTarget(
      path.join(distDir, SPECIMEN_VIEW_OUTPUT),
      { requireSingleLink: true },
    );
    if (specimenTarget.state === 'unsafe') {
      throw new Error(`specimen target must be absent or a local unlinked regular file`);
    }
    const previousManifestContent = readPreviousManifestContent(manifestPath);
    manifest = buildManifest({
      hash: computeSourceHash(sources.sourceInputs),
      emitters: ranEmitters,
      outputs: files.map((file) => file.relPath),
      ...(inspirationView?.freshness !== undefined
        ? {
            outputHashes: { [INSPIRATION_VIEW_OUTPUT]: inspirationView.freshness.hash },
            outputSources: { [INSPIRATION_VIEW_OUTPUT]: inspirationView.freshness.sources },
          }
        : {}),
      ...(fullBuild && inspirationView?.remove === true
        ? { omitOutputs: [INSPIRATION_VIEW_OUTPUT] }
        : {}),
      carriedOutputExists: (relPath) => {
        const carriedPath = path.join(distDir, ...relPath.split('/'));
        const carried = inspectSafeRegularFileTarget(carriedPath, { requireSingleLink: true });
        if (carried.state === 'unsafe') {
          throw new Error(`carried output target ${carriedPath} must not be linked or non-regular`);
        }
        return carried.state === 'file';
      },
      onWarning: (message) => manifestWarnings.push(message),
      ...(options.llm !== undefined ? { llm: options.llm } : {}),
      ...(previousManifestContent !== undefined ? { previousManifestContent } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });

    const outputs: Array<{ absPath: string; content: string }> = files.map((file) => ({
      absPath: path.join(distDir, ...file.relPath.split('/')),
      content: file.content,
    }));
    outputs.push({ absPath: manifestPath, content: renderManifest(manifest) });
    const staged: Array<{ output: { absPath: string; content: string }; file: StagedFile }> = [];
    try {
      for (const output of outputs) {
        if (path.dirname(output.absPath) !== distDir) {
          throw new Error(`emitter output parent is outside the supported flat dist layout: ${output.absPath}`);
        }
        staged.push({ output, file: stageFileExclusive(output.absPath, output.content) });
      }
      for (const item of staged.slice(0, -1)) {
        publishStagedFile(item.file, item.output.absPath);
        written.push(item.output.absPath);
      }
      if (fullBuild && inspirationView?.remove === true) {
        const inspirationPath = path.join(distDir, INSPIRATION_VIEW_OUTPUT);
        assertSafeRegularFileTarget(inspirationPath, 'generated explanation target');
        rmSync(inspirationPath, { force: true });
      }
      options.beforeManifestRename?.();
      const manifestOutput = staged[staged.length - 1]!;
      publishStagedFile(manifestOutput.file, manifestOutput.output.absPath);
      written.push(manifestOutput.output.absPath);
    } catch (cause) {
      for (const item of staged) removeOwnedFile(item.file.path, item.file.identity);
      throw new Error(
        `failed while writing ${distDir} (${cause instanceof Error ? cause.message : String(cause)}) — ` +
          'each dist file is either fully old or fully new and the manifest was updated last; re-run "onbrand build"',
      );
    }

    // guide.md is outside dist but its generated palette fence is derived from
    // this build's cached context. Keep the same per-brand writer lock until
    // the guide is published so an older build can never overwrite a newer
    // build's guide after yielding between the two publication phases.
    if (ranEmitters.includes('svg')) {
      guide = renderGuide(brandDir, ctx, {
        ...(options.beforeGuideRename !== undefined
          ? { beforeGuideRename: options.beforeGuideRename }
          : {}),
      });
    }
  } catch (cause) {
    publicationError = cause;
    throw cause;
  } finally {
    if (!publicationLock.release() && publicationError === undefined) {
      throw new Error('dist publication completed, but its ownership lock was replaced and was not removed');
    }
  }

  return { written, skipped, manifest, manifestWarnings, ...(guide !== undefined ? { guide } : {}) };
}

/**
 * Case normalization for source labels: on win32 the filesystem is
 * case-insensitive, so an extends-spec casing variant must not produce a
 * different label (mirrors resolve.ts cycleKey()). On case-sensitive
 * filesystems two case-differing paths ARE different files, so casing is
 * preserved there.
 */
const normalizeLabelCase: (label: string) => string =
  process.platform === 'win32' ? (label) => label.toLowerCase() : (label) => label;

/**
 * Identity-key label for a source file (contract: manifest.ts
 * ManifestSource.path — labels feed the source hash, so they must be
 * machine-independent and deterministic; they are NOT promised openable):
 *   - inside brand/            -> brand/-relative ("tokens.json")
 *   - inside the on-brand pkg  -> "onbrand:<package-relative>" so a preset
 *     extends target hashes identically regardless of where on-brand or the
 *     project lives on disk (plan §3.2: content drives the hash)
 *   - anywhere else            -> brand/-relative traversal ("../base.json")
 */
function sourceLabel(brandDir: string, absPath: string): string {
  const brandRel = path.relative(brandDir, absPath);
  if (!brandRel.startsWith('..') && !path.isAbsolute(brandRel)) {
    return normalizeLabelCase(brandRel.split(path.sep).join('/'));
  }
  const pkgRel = path.relative(packageRoot(), absPath);
  if (!pkgRel.startsWith('..') && !path.isAbsolute(pkgRel)) {
    return `onbrand:${normalizeLabelCase(pkgRel.split(path.sep).join('/'))}`;
  }
  return normalizeLabelCase(brandRel.split(path.sep).join('/'));
}

/**
 * Read the previous manifest tolerantly: absent, unreadable, or dir-shaped
 * all mean "no previous manifest" (buildManifest additionally tolerates
 * corrupt JSON content). A broken old manifest must never block a rebuild.
 */
function readPreviousManifestContent(manifestPath: string): string | undefined {
  // A non-file/corrupt old target retains the established tolerant rebuild
  // path, but links are an integrity boundary and must never be read or
  // silently treated as absence.
  assertFileTargetIsNotLinked(manifestPath, 'manifest target');
  const target = inspectSafeRegularFileTarget(manifestPath, { requireSingleLink: true });
  if (target.state !== 'file') return undefined;
  const file = stableReadRegularFile(manifestPath, { requireSingleLink: true });
  if (file === undefined || !sameFileIdentity(file.identity, target.identity)) {
    throw new Error(`manifest target ${manifestPath} changed while it was being read`);
  }
  return file.bytes.toString('utf8');
}
