/**
 * Schema lint for `onbrand check` (plan.md §9.8, Step 5).
 *
 * Lint ADDS checks on top of validate() (which already ran in loadBrandSources);
 * it never re-implements validation. Two checks:
 *
 *   1. Unknown top-level category — a root group whose name is not one of the
 *      §4 categories. Severity WARNING: a project may legitimately carry an
 *      extra namespace, and validate() already accepts it structurally; we
 *      surface it so a typo'd category ("colour", "spacing") is visible rather
 *      than silently emitting nothing.
 *
 *   2. Missing dark-mode coverage — a SURFACE-level color token (color.semantic
 *      / color.status / color.chart / color.diagram) with no override in
 *      modes.dark.json, when an overlay exists. Severity WARNING, and scoped to
 *      surface groups deliberately: color.primitive ramps are the palette
 *      SOURCE (a project may redefine the whole ramp in dark, or share it), so
 *      flagging every primitive step would be noise. A missing surface override
 *      is real drift risk (the survey's clearest finding: dark mode is
 *      inconsistent) but not a hard failure — a project may intend some surface
 *      colors to be mode-invariant, so an error would be wrong.
 */

import { flattenTokens } from '../build/compile.ts';
import { childEntries, type TokensDocument } from '../schema/types.ts';
import type { CheckFinding } from './finding.ts';

/** The §4 top-level token categories. */
export const KNOWN_TOP_CATEGORIES = [
  'color',
  'font',
  'type',
  'space',
  'radius',
  'shadow',
  'motion',
] as const;

/** color subgroups whose tokens are SURFACE colors expected to flip in dark mode. */
const SURFACE_COLOR_PREFIXES = [
  'color.semantic.',
  'color.status.',
  'color.chart.',
  'color.diagram.',
];

export interface LintInput {
  /** Resolved light document. */
  lightDocument: TokensDocument;
  /** Whether brand/modes.dark.json exists. */
  hasModes: boolean;
  /** Dot paths the dark overlay overrode (empty when no overlay). */
  overriddenPaths: readonly string[];
}

export function lintSchema(input: LintInput): CheckFinding[] {
  const findings: CheckFinding[] = [];

  // 1. Unknown top-level categories.
  const known = new Set<string>(KNOWN_TOP_CATEGORIES);
  for (const [name] of childEntries(input.lightDocument)) {
    if (!known.has(name)) {
      findings.push({
        severity: 'warning',
        category: 'schema',
        code: 'schema-unknown-top-level-category',
        path: name,
        message: `unknown top-level category "${name}" (known: ${KNOWN_TOP_CATEGORIES.join(', ')}) — a typo'd category emits nothing`,
        evidence: {
          category: name,
          knownCategories: KNOWN_TOP_CATEGORIES.join(', '),
        },
        nextCommand: 'onbrand check',
      });
    }
  }

  // 2. Missing dark-mode coverage for surface colors.
  if (input.hasModes) {
    const overridden = new Set(input.overriddenPaths);
    for (const token of flattenTokens(input.lightDocument)) {
      if (token.type !== 'color') continue;
      const isSurface = SURFACE_COLOR_PREFIXES.some((prefix) => token.dotPath.startsWith(prefix));
      if (!isSurface) continue;
      if (!overridden.has(token.dotPath)) {
        findings.push({
          severity: 'warning',
          category: 'schema',
          code: 'schema-missing-dark-override',
          path: token.dotPath,
          message: `surface color "${token.dotPath}" has no modes.dark.json override — it will not flip in dark mode`,
          evidence: {
            token: token.dotPath,
            overlay: 'brand/modes.dark.json',
            overridden: false,
          },
          nextCommand: 'onbrand check',
        });
      }
    }
  }

  return findings;
}
