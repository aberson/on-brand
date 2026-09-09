/**
 * Shared naming guards: the injectivity gate for emitter name mappings
 * (Step 3) plus the identifier char-class predicates (hoisted in Step 6 —
 * isIdentCharCode / isSafeClassSuffix below) that components.ts and
 * src/preview's dist parsers share.
 *
 * Every emitter that NORMALIZES token paths into a flat identifier space has
 * the same failure class as tokens.css's var mapping (see css.ts
 * assertUniqueVarNames): the mapping is deliberately human-readable but NOT
 * injective, so two distinct dot paths can collapse onto one emitted name
 * (color.semantic.text-muted vs color.semantic.text.muted both become
 * COLOR_SEMANTIC_TEXT_MUTED / --color-semantic-text-muted). A silent
 * last-declared-wins drop is never acceptable — the build fails with a
 * path-precise error naming BOTH parties.
 *
 * Users:
 *   - py.ts  — the UPPER_SNAKE constant map (light + DARK_-prefixed + the
 *     reserved list constants);
 *   - tailwind.ts — the namespace-remapped Tailwind theme var map (the
 *     hoisted tokenPathToCssVar gate in compile.ts does NOT cover the
 *     remap: space.1 -> --spacing-1 and type.weight.bold -> --font-weight-bold
 *     introduce collision classes the raw mapping never sees, e.g.
 *     font.weight-bold vs type.weight.bold).
 *   - ts.ts needs NO gate: theme.ts keys are the exact token names nested in
 *     the exact group structure (no normalization), so the mapping is
 *     injective by construction.
 *
 * css.ts keeps its own assertUniqueVarNames (it predates this helper and is
 * additionally hoisted into compile.ts as the every-subset gate).
 */

import type { ValidationIssue } from '../../schema/types.ts';
import { TokenValidationError } from '../../schema/validate.ts';

// ---------------------------------------------------------------------------
// Shared identifier char-class guards
// ---------------------------------------------------------------------------

/**
 * The safe identifier char-class shared by every "safe suffix / safe name"
 * guard: [A-Za-z0-9_-]. ONE definition (code-quality: one source of truth) —
 * components.ts badge derivation, badge-name scanning, and the preview dist
 * parsers all consume THIS predicate rather than re-declaring the ranges.
 * Char-code comparisons, not a regex class (repo authoring-hazard rule; see
 * test/repo.text-hygiene.test.ts).
 */
export function isIdentCharCode(code: number): boolean {
  const isLower = code >= 0x61 && code <= 0x7a;
  const isUpper = code >= 0x41 && code <= 0x5a;
  const isDigit = code >= 0x30 && code <= 0x39;
  const isDashUnderscore = code === 0x2d || code === 0x5f;
  return isLower || isUpper || isDigit || isDashUnderscore;
}

/**
 * A CSS class-name suffix (or custom-property name tail) must be a safe
 * identifier tail ([A-Za-z0-9_-]+, non-empty). Status names in the §4 schema
 * (success/warning/danger/info) already are; anything else (a space, a quote,
 * an empty name — all schema-legal, only "."/"{"/"}" are name-forbidden)
 * would be emitted into a selector / var() reference it could break out of.
 *
 * Hoisted here from components.ts (Step 6 review): src/preview's dist parsers
 * need the same guard, and a re-declared copy drifts — this predicate once
 * shipped with an inverted empty-string check that review caught, pinned by
 * test/build.naming.test.ts at THIS shared site. components.ts re-exports it
 * for its own callers.
 */
export function isSafeClassSuffix(name: string): boolean {
  if (name.length === 0) return false;
  for (let i = 0; i < name.length; i++) {
    if (!isIdentCharCode(name.charCodeAt(i))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Injectivity gate
// ---------------------------------------------------------------------------

export interface EmittedName {
  /** The emitted identifier / variable name. */
  name: string;
  /** Token dot path — becomes the path-precise ValidationIssue path. */
  dotPath: string;
  /**
   * Human wording for collision messages, e.g. `token "color.semantic.bg"`
   * or `the dark-mode constant of token "color.semantic.bg"`. Entries with
   * the same name AND the same label are one logical token seen twice (dark
   * overrides re-visit their base token) and never collide with themselves.
   */
  label: string;
}

/**
 * Throw a TokenValidationError (path-precise, naming both parties) when two
 * distinct entries collapse onto one emitted name. `hint` explains the
 * mapping-specific reason (what normalization collided) and the fix.
 */
export function assertInjectiveNames(
  entries: readonly EmittedName[],
  emitterLabel: string,
  hint: string,
): void {
  const seen = new Map<string, EmittedName>();
  const reported = new Set<string>();
  const issues: ValidationIssue[] = [];
  for (const entry of entries) {
    const existing = seen.get(entry.name);
    if (existing === undefined) {
      seen.set(entry.name, entry);
      continue;
    }
    // Same logical token revisited (e.g. a dark override of its own base).
    if (existing.dotPath === entry.dotPath && existing.label === entry.label) continue;
    const dedupeKey = `${entry.name} ${entry.label} ${entry.dotPath}`;
    if (reported.has(dedupeKey)) continue;
    reported.add(dedupeKey);
    issues.push({
      path: entry.dotPath,
      message: `emitted name ${entry.name} (for ${entry.label}) collides with ${existing.label} — ${hint}`,
    });
  }
  if (issues.length > 0) {
    throw new TokenValidationError(issues, emitterLabel);
  }
}
