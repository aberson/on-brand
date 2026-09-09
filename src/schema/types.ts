/**
 * DTCG-subset token types — the ONE source of truth for the token shape.
 * Every other module (build, check, extract, preview, cli) imports from here
 * and never re-declares these shapes (plan.md §7).
 *
 * Format: DTCG JSON, stable spec 2025.10 subset (`$value` / `$type`).
 * Conventions specific to on-brand (documented here, enforced in validate.ts):
 *   - Token IDs are dot paths of group/token names, e.g. `color.status.warning.bg`.
 *   - `dimension` values are CSS length strings ("4px", "0.25rem") or CSS
 *     expressions (clamp()/calc()/min()/max()/var()) — the fluid type scale
 *     uses clamp() (Utopia method).
 *   - `duration` values are CSS time strings ("150ms", "0.3s").
 *   - `cubicBezier` values are [x1, y1, x2, y2] number arrays or a CSS easing
 *     keyword string.
 *   - Schema version is an integer at `$extensions.onbrand.schemaVersion`
 *     (v1 = 1).
 *   - `$extensions.onbrand.extends` names a base to merge under this file
 *     (relative path or preset name), resolved at build time like tsconfig
 *     `extends` (resolve.ts).
 *   - `modes.dark.json` is an overlay with the same shape overriding COLOR
 *     values only (modes.ts).
 */

/** Current on-brand schema version (integer, at `$extensions.onbrand.schemaVersion`). */
export const SCHEMA_VERSION = 1;

/** The DTCG `$type` values this subset supports. */
export const TOKEN_TYPES = [
  'color',
  'dimension',
  'fontFamily',
  'fontWeight',
  'number',
  'duration',
  'cubicBezier',
  'shadow',
] as const;

export type TokenType = (typeof TOKEN_TYPES)[number];

/** DTCG shadow value (single layer). */
export interface ShadowValue {
  color: string;
  offsetX: string;
  offsetY: string;
  blur: string;
  spread: string;
}

/** CSS easing keywords accepted alongside cubic-bezier arrays. */
export const EASING_KEYWORDS = ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out'] as const;

export type CubicBezierValue = [number, number, number, number] | (typeof EASING_KEYWORDS)[number];

export type TokenValue =
  | string
  | number
  | string[]
  | CubicBezierValue
  | ShadowValue
  | ShadowValue[];

/** The `onbrand` vendor block inside `$extensions`. */
export interface OnbrandExtension {
  schemaVersion: number;
  /** Relative path or preset name; resolved by resolve.ts. Absent = standalone. */
  extends?: string;
  [key: string]: unknown;
}

export interface DocumentExtensions {
  onbrand?: OnbrandExtension;
  [vendor: string]: unknown;
}

/** A leaf token: has `$value`; `$type` may be inherited from an ancestor group. */
export interface Token {
  $value: TokenValue;
  $type?: TokenType;
  $description?: string;
  $extensions?: Record<string, unknown>;
}

export type TokenNode = Token | TokenGroup;

/**
 * A group: nested named tokens/groups plus optional `$`-prefixed metadata.
 *
 * The index signature is deliberately looser than the named properties: TS
 * cannot express "every non-`$` key is a TokenNode" alongside the narrower
 * metadata props, so the union must cover both. This is a JSON-driven shape —
 * runtime validation (validate.ts) is the real gate; consumers narrow with
 * the isToken()/isGroup() guards, never by trusting the index type.
 */
export interface TokenGroup {
  $type?: TokenType;
  $description?: string;
  $extensions?: DocumentExtensions;
  [name: string]: TokenNode | TokenType | string | DocumentExtensions | undefined;
}

/** A whole tokens.json / modes.dark.json document is a root group. */
export type TokensDocument = TokenGroup;

/** One path-precise validation problem. `path` is the token dot path (e.g. `color.semantic.bg.$value`). */
export interface ValidationIssue {
  path: string;
  message: string;
}

/** Keys allowed on a leaf token. */
export const RESERVED_TOKEN_KEYS = ['$value', '$type', '$description', '$extensions'] as const;

/** Keys allowed on a group (any level, including root). */
export const RESERVED_GROUP_KEYS = ['$type', '$description', '$extensions'] as const;

/** Characters DTCG forbids in token/group names (plus `$` prefix, handled separately). */
export const FORBIDDEN_NAME_CHARS = /[.{}]/;

/**
 * JavaScript object-model property names that a JSON-driven token/group name
 * must never use: assigning them on a plain object (merge, overlay apply)
 * would hijack the prototype instead of storing data. validate() rejects
 * them; merge/walk code additionally skips them as defense in depth.
 */
export const UNSAFE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

export function isUnsafeName(name: string): boolean {
  return UNSAFE_NAMES.has(name);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isToken(node: unknown): node is Token {
  // Object.hasOwn, not `in`: `in` walks the prototype chain, so a polluted or
  // exotic prototype could misclassify a group as a token.
  return isPlainObject(node) && Object.hasOwn(node, '$value');
}

export function isGroup(node: unknown): node is TokenGroup {
  return isPlainObject(node) && !Object.hasOwn(node, '$value');
}

export function isTokenType(value: unknown): value is TokenType {
  return typeof value === 'string' && (TOKEN_TYPES as readonly string[]).includes(value);
}

/** Entries of a group that are children (i.e. not `$`-prefixed metadata). */
export function childEntries(group: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(group).filter(([key]) => !key.startsWith('$'));
}

/** Join path segments into a token dot path. */
export function joinPath(segments: readonly string[]): string {
  return segments.join('.');
}

export function formatIssue(issue: ValidationIssue): string {
  return `${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`;
}

export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues.map(formatIssue).join('\n');
}
