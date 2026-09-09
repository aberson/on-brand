/**
 * `$extensions.onbrand.extends` resolution — like tsconfig `extends`.
 *
 * The spec value is either:
 *   - a relative path (contains a path separator, starts with "." or ends in
 *     ".json"), resolved against the directory of the extending file; a
 *     directory target resolves to its `tokens.json`; or
 *   - a preset name, resolved to `templates/presets/<name>/tokens.json` in
 *     the on-brand repo.
 *
 * Chains are allowed (a extends b extends c); cycles are an error. Merge
 * semantics: the extending file's values win per token; groups merge
 * recursively; if either side of a collision is a leaf token, the extending
 * side replaces the node wholesale. The `extends` key itself is consumed by
 * resolution and absent from the merged result.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isPlainObject,
  isToken,
  isUnsafeName,
  type TokensDocument,
} from './types.ts';
import { TokenValidationError, validate } from './validate.ts';

export class TokenResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenResolveError';
  }
}

/** Absolute path of the on-brand package root (the directory holding package.json). */
export function packageRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

/** Absolute path of the built-in presets directory (`templates/presets/`). */
export function defaultPresetsRoot(): string {
  return path.join(packageRoot(), 'templates', 'presets');
}

export interface ResolveOptions {
  /** Override where preset names resolve from (default: the repo's templates/presets/). */
  presetsRoot?: string;
}

export interface ResolvedTokens {
  /** The fully merged, fully validated document (extends consumed). */
  document: TokensDocument;
  /** Files visited, extender first, deepest base last. */
  chain: string[];
}

/** Read + parse a JSON file with friendly errors. */
export function readJsonFile(filePath: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new TokenResolveError(
      `cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new TokenResolveError(
      `invalid JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function looksLikePath(spec: string): boolean {
  return (
    spec.startsWith('.') ||
    spec.includes('/') ||
    spec.includes('\\') ||
    spec.endsWith('.json') ||
    path.isAbsolute(spec)
  );
}

/**
 * Resolve an extends spec to the absolute path of the base tokens.json.
 * Exposed for tests and for future `build`-time diagnostics.
 */
export function resolveExtendsTarget(
  spec: string,
  sourceDir: string,
  presetsRoot: string,
): string {
  let target = looksLikePath(spec)
    ? path.resolve(sourceDir, spec)
    : path.join(presetsRoot, spec, 'tokens.json');

  if (existsSync(target) && statSync(target).isDirectory()) {
    target = path.join(target, 'tokens.json');
  }
  if (!existsSync(target)) {
    throw new TokenResolveError(
      `extends target ${JSON.stringify(spec)} not found (resolved to ${target})`,
    );
  }
  return target;
}

/**
 * Deep-merge two token trees: `override` wins. Groups merge recursively; a
 * collision where either side is a leaf token is replaced wholesale by the
 * override side. Inputs are not mutated.
 *
 * Prototype-pollution guard: a literal "__proto__"/"constructor"/"prototype"
 * own-property (JSON.parse can produce one) would, via plain assignment,
 * rewrite the merged object's [[Prototype]] instead of storing data — so
 * unsafe keys are skipped here outright. validate() rejects such names
 * upstream (resolveTokensFile validates every file before merging); this is
 * defense in depth for direct mergeTokenTrees callers.
 */
export function mergeTokenTrees(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = structuredClone(base);
  for (const [key, overrideValue] of Object.entries(override)) {
    if (isUnsafeName(key)) continue;
    const baseValue = merged[key];
    if (
      isPlainObject(baseValue) &&
      isPlainObject(overrideValue) &&
      !isToken(baseValue) &&
      !isToken(overrideValue)
    ) {
      merged[key] = mergeTokenTrees(baseValue, overrideValue);
    } else {
      merged[key] = structuredClone(overrideValue);
    }
  }
  return merged;
}

/**
 * Load a tokens.json, resolve its extends chain (if any), and return the
 * merged document. Every file in the chain is validated individually
 * ('fragment' when it declares extends, 'tokens' otherwise) and the merged
 * result is validated as a full 'tokens' document. Throws TokenResolveError /
 * TokenValidationError on failure.
 */
export function resolveTokensFile(filePath: string, options: ResolveOptions = {}): ResolvedTokens {
  const presetsRoot = options.presetsRoot ?? defaultPresetsRoot();
  const chain: string[] = [];
  const merged = resolveRecursive(path.resolve(filePath), presetsRoot, new Set(), chain);

  const result = validate(merged, { kind: 'tokens' });
  if (!result.ok || result.document === undefined) {
    throw new TokenValidationError(result.issues, `resolved result of ${filePath}`);
  }
  return { document: result.document, chain };
}

function cycleKey(absPath: string): string {
  // Windows paths are case-insensitive; normalize so a/B.json === A/b.json.
  return path.normalize(absPath).toLowerCase();
}

function resolveRecursive(
  absPath: string,
  presetsRoot: string,
  seen: Set<string>,
  chain: string[],
): Record<string, unknown> {
  const key = cycleKey(absPath);
  if (seen.has(key)) {
    throw new TokenResolveError(
      `circular extends chain: ${[...chain, absPath].join(' -> ')}`,
    );
  }
  seen.add(key);
  chain.push(absPath);

  const doc = readJsonFile(absPath);
  if (!isPlainObject(doc)) {
    throw new TokenResolveError(`${absPath}: document must be a JSON object`);
  }

  const ext = doc['$extensions'];
  const onbrand = isPlainObject(ext) ? ext['onbrand'] : undefined;
  const extendsSpec =
    isPlainObject(onbrand) && typeof onbrand['extends'] === 'string'
      ? onbrand['extends']
      : undefined;

  const kind = extendsSpec !== undefined ? 'fragment' : 'tokens';
  const result = validate(doc, { kind });
  if (!result.ok) {
    throw new TokenValidationError(result.issues, absPath);
  }

  // Consume the extends key: it must not survive into the merged document.
  const cloned = structuredClone(doc);
  const clonedExt = cloned['$extensions'];
  if (isPlainObject(clonedExt) && isPlainObject(clonedExt['onbrand'])) {
    delete (clonedExt['onbrand'] as Record<string, unknown>)['extends'];
  }

  if (extendsSpec === undefined) {
    return cloned;
  }

  const target = resolveExtendsTarget(extendsSpec, path.dirname(absPath), presetsRoot);
  const base = resolveRecursive(target, presetsRoot, seen, chain);
  return mergeTokenTrees(base, cloned);
}
