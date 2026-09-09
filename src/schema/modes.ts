/**
 * Mode-overlay merge (`modes.dark.json`).
 *
 * Documented convention (plan.md §4): an overlay has the SAME tree shape as
 * tokens.json and overrides COLOR values only. This module owns the semantic
 * checks against the base document:
 *   - every overlay leaf must exist in the base document,
 *   - the base token it targets must resolve to $type "color",
 *   - the overlay value must itself be a valid color (validate.ts, kind
 *     'overlay').
 *
 * The merge never mutates its inputs; it returns a deep-cloned base with the
 * overlay's color values applied.
 */

import {
  childEntries,
  isPlainObject,
  isToken,
  isTokenType,
  isUnsafeName,
  joinPath,
  type Token,
  type TokenType,
  type TokensDocument,
  type ValidationIssue,
} from './types.ts';
import { validate } from './validate.ts';

export interface ModeOverlayResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** Base deep-clone with every valid overlay override applied. */
  document: TokensDocument;
  /** Dot paths of tokens the overlay overrode. */
  overriddenPaths: string[];
}

interface OverlayLeaf {
  segs: string[];
  token: Record<string, unknown>;
}

/**
 * Apply a mode overlay (e.g. the parsed modes.dark.json) onto a validated
 * base document. Collects ALL problems (path-precise) instead of stopping at
 * the first; overrides that fail a check are skipped, valid ones are applied.
 */
export function applyModeOverlay(base: TokensDocument, overlay: unknown): ModeOverlayResult {
  const issues: ValidationIssue[] = [];
  const overriddenPaths: string[] = [];
  const document = structuredClone(base);

  const structural = validate(overlay, { kind: 'overlay' });
  issues.push(...structural.issues);

  if (!isPlainObject(overlay)) {
    return { ok: false, issues, document, overriddenPaths };
  }

  // A leaf whose own subtree failed structural validation (bad $value, bad
  // $type, ...) must NOT be applied — ok:false alone is not enough, the
  // returned document must exclude it too.
  const hasStructuralIssue = (tokenPath: string): boolean =>
    structural.issues.some(
      (issue) => issue.path === tokenPath || issue.path.startsWith(`${tokenPath}.$`),
    );

  const leaves: OverlayLeaf[] = [];
  collectOverlayLeaves(overlay, [], leaves);

  for (const leaf of leaves) {
    const tokenPath = joinPath(leaf.segs);
    if (hasStructuralIssue(tokenPath)) continue; // already reported by validate()
    const found = findInBase(base, leaf.segs);

    if (found === undefined) {
      issues.push({
        path: tokenPath,
        message: 'overlay token does not exist in the base tokens document',
      });
      continue;
    }
    if (!isToken(found.node)) {
      issues.push({
        path: tokenPath,
        message: 'overlay path is a group in the base tokens document, not a token',
      });
      continue;
    }
    if (found.resolvedType !== 'color') {
      issues.push({
        path: tokenPath,
        message: `mode overlays may only override color tokens (base $type is ${
          found.resolvedType === undefined ? 'undeclared' : `"${found.resolvedType}"`
        })`,
      });
      continue;
    }

    setTokenValue(document, leaf.segs, structuredClone(leaf.token['$value']));
    overriddenPaths.push(tokenPath);
  }

  return { ok: issues.length === 0, issues, document, overriddenPaths };
}

function collectOverlayLeaves(
  node: Record<string, unknown>,
  segs: string[],
  out: OverlayLeaf[],
): void {
  for (const [name, child] of childEntries(node)) {
    if (isUnsafeName(name)) continue; // rejected by validate(); never walk or apply
    if (!isPlainObject(child)) continue; // structural issue already reported by validate()
    if (Object.hasOwn(child, '$value')) {
      out.push({ segs: [...segs, name], token: child });
    } else {
      collectOverlayLeaves(child, [...segs, name], out);
    }
  }
}

interface FoundNode {
  node: unknown;
  /** $type resolved along the walk (own $type or nearest ancestor group's). */
  resolvedType: TokenType | undefined;
}

function findInBase(base: TokensDocument, segs: string[]): FoundNode | undefined {
  let node: unknown = base;
  let resolvedType: TokenType | undefined = isTokenType(base.$type) ? base.$type : undefined;

  for (const seg of segs) {
    if (isUnsafeName(seg)) return undefined; // never traverse the object model
    if (!isPlainObject(node)) return undefined;
    node = Object.hasOwn(node, seg) ? node[seg] : undefined;
    if (node === undefined) return undefined;
    if (isPlainObject(node) && isTokenType(node['$type'])) {
      resolvedType = node['$type'];
    }
  }
  return { node, resolvedType };
}

function setTokenValue(document: TokensDocument, segs: string[], value: unknown): void {
  let node: unknown = document;
  for (const seg of segs) {
    if (isUnsafeName(seg)) return; // never traverse the object model
    if (!isPlainObject(node)) return;
    node = Object.hasOwn(node, seg) ? node[seg] : undefined;
  }
  if (isToken(node)) {
    node.$value = value as Token['$value'];
  }
}
