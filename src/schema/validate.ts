/**
 * Zod validation for the DTCG-subset token documents, with path-precise
 * errors: every issue carries the token dot path it belongs to, e.g.
 * `color.semantic.bg.$value`.
 *
 * Three validation kinds:
 *   - 'tokens'   (default) — a full standalone tokens.json: requires
 *                 `$extensions.onbrand.schemaVersion` and every leaf must
 *                 resolve a `$type` (own or inherited from an ancestor group).
 *   - 'fragment' — a tokens.json that declares `$extensions.onbrand.extends`:
 *                 sparse overrides are allowed, so a leaf without a resolvable
 *                 `$type` is NOT an error here (the merged result is validated
 *                 as 'tokens' by resolve.ts).
 *   - 'overlay'  — a modes.dark.json overlay: same tree shape, but every leaf
 *                 must be a color value (the documented convention: mode
 *                 overlays override color values only). Semantic checks
 *                 against the base document live in modes.ts.
 */

import { z } from 'zod';
import {
  FORBIDDEN_NAME_CHARS,
  RESERVED_GROUP_KEYS,
  RESERVED_TOKEN_KEYS,
  SCHEMA_VERSION,
  TOKEN_TYPES,
  childEntries,
  formatIssues,
  isPlainObject,
  isTokenType,
  isUnsafeName,
  joinPath,
  type TokenType,
  type TokensDocument,
  type ValidationIssue,
} from './types.ts';

export type ValidateKind = 'tokens' | 'fragment' | 'overlay';

export interface ValidateOptions {
  kind?: ValidateKind;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** The document, typed, when ok. */
  document?: TokensDocument;
}

export class TokenValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[], context?: string) {
    const header = context
      ? `${context}: ${issues.length} validation issue(s)`
      : `${issues.length} validation issue(s)`;
    super(`${header}\n${formatIssues(issues)}`);
    this.name = 'TokenValidationError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Per-type $value schemas
// ---------------------------------------------------------------------------

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const COLOR_FN_RE = /^(?:oklch|oklab|lab|lch|rgb|rgba|hsl|hsla|hwb|color)\(.+\)$/;
const DIMENSION_RE = /^-?(?:\d+|\d*\.\d+)(?:px|rem|em|vw|vh|vmin|vmax|%|ch|ex)$/;
const DIMENSION_EXPR_RE = /^(?:clamp|calc|min|max|var)\(.+\)$/;
const DURATION_RE = /^(?:\d+|\d*\.\d+)(?:ms|s)$/;

const colorSchema = z
  .string()
  .refine((v) => HEX_COLOR_RE.test(v) || COLOR_FN_RE.test(v), {
    message:
      'expected a hex color string ("#rrggbb", "#rrggbbaa") or a CSS color function string ("oklch(...)")',
  });

const dimensionSchema = z
  .string()
  .refine((v) => DIMENSION_RE.test(v) || DIMENSION_EXPR_RE.test(v), {
    message: 'expected a CSS length string ("4px", "0.25rem") or a clamp()/calc() expression',
  });

const fontFamilySchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const fontWeightSchema = z.number().int().min(1).max(1000);

const numberSchema = z.number().finite();

const durationSchema = z.string().regex(DURATION_RE, {
  message: 'expected a duration string ("150ms", "0.3s")',
});

const cubicBezierSchema = z.union([
  z.tuple([z.number(), z.number(), z.number(), z.number()]),
  z.enum(['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out']),
]);

const shadowSingleSchema = z
  .object({
    color: colorSchema,
    offsetX: dimensionSchema,
    offsetY: dimensionSchema,
    blur: dimensionSchema,
    spread: dimensionSchema,
  })
  .strict();

const shadowSchema = z.union([shadowSingleSchema, z.array(shadowSingleSchema).min(1)]);

const VALUE_SCHEMAS: Record<TokenType, z.ZodTypeAny> = {
  color: colorSchema,
  dimension: dimensionSchema,
  fontFamily: fontFamilySchema,
  fontWeight: fontWeightSchema,
  number: numberSchema,
  duration: durationSchema,
  cubicBezier: cubicBezierSchema,
  shadow: shadowSchema,
};

/** Human hints used when a zod union fails (union errors are unhelpfully generic). */
const TYPE_HINTS: Record<TokenType, string> = {
  color: 'a hex color string ("#rrggbb", "#rrggbbaa") or a CSS color function string',
  dimension: 'a CSS length string ("4px", "0.25rem") or a clamp()/calc() expression',
  fontFamily: 'a font stack string or a non-empty array of font name strings',
  fontWeight: 'an integer between 1 and 1000',
  number: 'a finite number',
  duration: 'a duration string ("150ms", "0.3s")',
  cubicBezier: 'an array of four numbers [x1, y1, x2, y2] or a CSS easing keyword',
  shadow: 'a shadow object { color, offsetX, offsetY, blur, spread } or an array of them',
};

const onbrandExtensionSchema = z
  .object({
    schemaVersion: z.number({
      required_error: 'schemaVersion is required (integer; current version is 1)',
      invalid_type_error: 'schemaVersion must be an integer',
    }),
    extends: z
      .string({ invalid_type_error: 'extends must be a string (relative path or preset name)' })
      .min(1, 'extends must be a non-empty string (relative path or preset name)')
      .optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Validation walk
// ---------------------------------------------------------------------------

/**
 * Validate a token document. Never throws; returns all issues found, each with
 * a precise token dot path.
 */
export function validate(doc: unknown, options: ValidateOptions = {}): ValidationResult {
  const kind = options.kind ?? 'tokens';
  const issues: ValidationIssue[] = [];

  if (!isPlainObject(doc)) {
    issues.push({ path: '', message: 'document must be a JSON object' });
    return { ok: false, issues };
  }

  validateRootExtensions(doc, kind, issues);
  validateGroupMeta(doc, [], kind, issues);

  const rootType = isTokenType(doc['$type']) ? doc['$type'] : undefined;
  walkGroup(doc, [], rootType, kind, issues);

  const ok = issues.length === 0;
  return { ok, issues, document: ok ? (doc as TokensDocument) : undefined };
}

/** Like validate() but throws a TokenValidationError carrying all issues. */
export function assertValid(
  doc: unknown,
  options: ValidateOptions = {},
  context?: string,
): TokensDocument {
  const result = validate(doc, options);
  if (!result.ok || result.document === undefined) {
    throw new TokenValidationError(result.issues, context);
  }
  return result.document;
}

function validateRootExtensions(
  doc: Record<string, unknown>,
  kind: ValidateKind,
  issues: ValidationIssue[],
): void {
  const ext = doc['$extensions'];

  if (ext === undefined) {
    if (kind !== 'overlay') {
      issues.push({
        path: '$extensions.onbrand',
        message: `missing — a tokens file must declare { "$extensions": { "onbrand": { "schemaVersion": ${SCHEMA_VERSION} } } }`,
      });
    }
    return;
  }

  if (!isPlainObject(ext)) {
    issues.push({ path: '$extensions', message: 'must be an object' });
    return;
  }

  const onbrand = ext['onbrand'];
  if (onbrand === undefined) {
    if (kind !== 'overlay') {
      issues.push({
        path: '$extensions.onbrand',
        message: `missing — a tokens file must declare { "schemaVersion": ${SCHEMA_VERSION} }`,
      });
    }
    return;
  }

  const parsed = onbrandExtensionSchema.safeParse(onbrand);
  if (!parsed.success) {
    for (const zi of parsed.error.issues) {
      const sub = zi.path.length > 0 ? `.${zi.path.join('.')}` : '';
      issues.push({ path: `$extensions.onbrand${sub}`, message: zi.message });
    }
    return;
  }

  const { schemaVersion, extends: extendsSpec } = parsed.data;
  if (!Number.isInteger(schemaVersion)) {
    issues.push({
      path: '$extensions.onbrand.schemaVersion',
      message: `must be an integer (got ${JSON.stringify(schemaVersion)})`,
    });
  } else if (schemaVersion !== SCHEMA_VERSION) {
    issues.push({
      path: '$extensions.onbrand.schemaVersion',
      message: `unsupported schemaVersion ${schemaVersion} (this build supports ${SCHEMA_VERSION})`,
    });
  }

  if (kind === 'overlay' && extendsSpec !== undefined) {
    issues.push({
      path: '$extensions.onbrand.extends',
      message: 'extends is not supported in mode overlay files',
    });
  }
}

function validateGroupMeta(
  group: Record<string, unknown>,
  pathSegs: string[],
  kind: ValidateKind,
  issues: ValidationIssue[],
): void {
  const here = (suffix: string): string =>
    pathSegs.length === 0 ? suffix : `${joinPath(pathSegs)}.${suffix}`;

  for (const key of Object.keys(group)) {
    if (!key.startsWith('$')) continue;
    if (!(RESERVED_GROUP_KEYS as readonly string[]).includes(key)) {
      issues.push({
        path: here(key),
        message: `unknown $-property on a group (allowed: ${RESERVED_GROUP_KEYS.join(', ')})`,
      });
    }
  }

  const groupType = group['$type'];
  if (groupType !== undefined) {
    if (!isTokenType(groupType)) {
      issues.push({
        path: here('$type'),
        message: `unknown $type ${JSON.stringify(groupType)} (supported: ${TOKEN_TYPES.join(', ')})`,
      });
    } else if (kind === 'overlay' && groupType !== 'color') {
      issues.push({
        path: here('$type'),
        message: `mode overlays may only carry color tokens (got $type "${groupType}")`,
      });
    }
  }

  const description = group['$description'];
  if (description !== undefined && typeof description !== 'string') {
    issues.push({ path: here('$description'), message: 'must be a string' });
  }
}

function walkGroup(
  group: Record<string, unknown>,
  pathSegs: string[],
  inheritedType: TokenType | undefined,
  kind: ValidateKind,
  issues: ValidationIssue[],
): void {
  for (const [name, child] of childEntries(group)) {
    const parentPath = joinPath(pathSegs);
    const namedPath = parentPath === '' ? name : `${parentPath}.${name}`;

    if (isUnsafeName(name)) {
      issues.push({
        path: namedPath,
        message: `unsafe token/group name ${JSON.stringify(name)} — reserved JavaScript object property names are not allowed`,
      });
      continue;
    }

    if (FORBIDDEN_NAME_CHARS.test(name)) {
      issues.push({
        path: namedPath,
        message: `invalid token/group name ${JSON.stringify(name)} — names must not contain ".", "{" or "}"`,
      });
      continue;
    }

    const childSegs = [...pathSegs, name];
    const childPath = joinPath(childSegs);

    if (!isPlainObject(child)) {
      issues.push({
        path: childPath,
        message:
          'expected an object (a token is { "$value": ... }; a group is a nested object of tokens)',
      });
      continue;
    }

    if (Object.hasOwn(child, '$value')) {
      validateLeaf(child, childSegs, inheritedType, kind, issues);
    } else {
      validateGroupMeta(child, childSegs, kind, issues);
      const childType = child['$type'];
      const effective = isTokenType(childType) ? childType : inheritedType;
      walkGroup(child, childSegs, effective, kind, issues);
    }
  }
}

function validateLeaf(
  token: Record<string, unknown>,
  pathSegs: string[],
  inheritedType: TokenType | undefined,
  kind: ValidateKind,
  issues: ValidationIssue[],
): void {
  const tokenPath = joinPath(pathSegs);

  for (const key of Object.keys(token)) {
    if (key.startsWith('$')) {
      if (!(RESERVED_TOKEN_KEYS as readonly string[]).includes(key)) {
        issues.push({
          path: `${tokenPath}.${key}`,
          message: `unknown $-property on a token (allowed: ${RESERVED_TOKEN_KEYS.join(', ')})`,
        });
      }
    } else {
      issues.push({
        path: `${tokenPath}.${key}`,
        message: 'a token (an object with "$value") cannot contain nested children',
      });
    }
  }

  const description = token['$description'];
  if (description !== undefined && typeof description !== 'string') {
    issues.push({ path: `${tokenPath}.$description`, message: 'must be a string' });
  }

  const ownType = token['$type'];
  if (ownType !== undefined && !isTokenType(ownType)) {
    issues.push({
      path: `${tokenPath}.$type`,
      message: `unknown $type ${JSON.stringify(ownType)} (supported: ${TOKEN_TYPES.join(', ')})`,
    });
    return; // cannot pick a value schema; avoid a cascading second error
  }

  let resolvedType: TokenType | undefined;
  if (kind === 'overlay') {
    // Documented convention: mode overlays override color values only.
    if (ownType !== undefined && ownType !== 'color') {
      issues.push({
        path: `${tokenPath}.$type`,
        message: `mode overlays may only override color tokens (got $type "${ownType}")`,
      });
      return;
    }
    resolvedType = 'color';
  } else {
    resolvedType = ownType ?? inheritedType;
    if (resolvedType === undefined) {
      if (kind === 'tokens') {
        issues.push({
          path: tokenPath,
          message: 'token has no $type and none is inherited from an ancestor group',
        });
      }
      // 'fragment': sparse override; the merged document is re-validated later.
      return;
    }
  }

  const schema = VALUE_SCHEMAS[resolvedType];
  const parsed = schema.safeParse(token['$value']);
  if (!parsed.success) {
    const seen = new Set<string>();
    for (const zi of parsed.error.issues) {
      const sub = zi.path.length > 0 ? `.${zi.path.join('.')}` : '';
      const message =
        zi.code === 'invalid_union'
          ? `invalid ${resolvedType} value: expected ${TYPE_HINTS[resolvedType]}`
          : `invalid ${resolvedType} value: ${zi.message}`;
      const path = `${tokenPath}.$value${sub}`;
      const dedupeKey = `${path}\u0000${message}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      issues.push({ path, message });
    }
  }
}
