/**
 * Deterministic font-fidelity metric (Brand-Fidelity plan §5/§6/§9, Step 6, #35).
 *
 * Classifies how faithfully an `onbrand from-url` PROPOSAL handled each font
 * role (heading/body/mono) against the FROZEN human-pinned ground truth
 * (`docs/findings/eval-truth/<id>.truth.json`, schema in
 * `benchmark/truth-scaffold.ts`). Pure functions over structured inputs only —
 * no `.md` report parsing, no network, no wall-clock, no randomness.
 *
 * ------------------------------------------------------- anti-circularity ---
 * The ONLY trustworthy reference is `truth.pinned.fonts.{heading,body,mono}`
 * (human-sourced, frozen) — NEVER the extractor's own font read
 * (`RawExtraction.fonts` / the `FontMapping.observedFamily` the pipeline itself
 * produced). Role labels on the extractor's font read are frequently `unknown`
 * and, worse, can be flatly WRONG about which stack is "the brand face" — e.g.
 * robinhood's real fixture reports "Phonic"/"Martina Plantijn" as the
 * heading/body candidates, but the site's actual brand face is Capsule Sans
 * (Text/Display). Scoring font-fidelity against the extractor's own read would
 * re-introduce the exact circularity the accent-pin avoids in
 * `color-fidelity.ts` (plan §6 "Freeze human-pinned roles; don't trust
 * extractor `roles`") — the proposal was BUILT from that same unreliable read,
 * so it could never be caught being wrong. This is precisely why
 * `truth-scaffold.ts` seeds `pinned.fonts` as `null` rather than from a
 * derived guess (unlike the colour roles, which DO seed from a guess) and
 * requires the operator to pin the true family from an independent source.
 *
 * -------------------------------------------------------- the shipped font ---
 * "What the proposal shipped" is read from the SAME structured seam
 * `color-fidelity.ts` introduced: a `NormalizeResult` (already produced by
 * `src/extract/normalize.ts`'s production `normalize()`). `NormalizeResult.fonts`
 * (a `MappedFonts`, from `src/extract/fonts.ts`'s `mapFonts()` — the ONE
 * font-mapping implementation; this module never re-implements font
 * fingerprinting or lookalike matching) already carries, per role, both:
 *   - `observedFamily`  — the first concrete family the site's own CSS declared
 *                          (undefined if literally nothing was observed for
 *                          that role), and
 *   - `mappedFamily`    — the family the pipeline actually SHIPS: either a
 *                          curated Google-Fonts lookalike substitution, the
 *                          observed family kept-as-is because it was already a
 *                          recognized free family, or `undefined` when the
 *                          stack was unrecognized (in which case the shipped
 *                          family is `observedFamily` verbatim, extended with a
 *                          system fallback tail — see `fonts.ts`).
 * `scoreableFontsProposalFromNormalize` is the additive accessor (mirrors
 * `color-fidelity.ts`'s `scoreableProposalFromNormalize`) that exposes exactly
 * this slice — no re-parsing, no new call site into the pipeline.
 *
 * ---------------------------------------------------- classification (the 4 buckets) ---
 * For each font role (heading/body/mono) the proposal shipped, exactly one of:
 *
 *   - `mapped`          the shipped family equals the pinned TRUE family
 *                        (normalized) AND the pipeline actively changed the
 *                        family away from what the site itself used (a real
 *                        substitution occurred, and it happened to land
 *                        exactly on the true brand face).
 *   - `lookalike`       the shipped family is NOT the true family, but IS in
 *                        that role's pinned `lookalikes` set — a defensible,
 *                        licensed substitution (e.g. Söhne -> Inter).
 *   - `kept`            NO substitution was made or needed: the pipeline
 *                        shipped the SAME family the site itself used (either
 *                        because it was already a recognized free family and
 *                        `fonts.ts` kept it as-is, or because it was
 *                        unrecognized and `fonts.ts` passed it through
 *                        verbatim) — AND that family happens to already equal
 *                        the true family or an accepted lookalike.
 *   - `silently-wrong`  the shipped family is NEITHER the true family NOR an
 *                        accepted lookalike, however it got there. This is the
 *                        failure this metric exists to catch: an undetected,
 *                        silent substitution nobody flagged.
 *
 * KEPT-VS-MAPPED BOUNDARY (the design decision this Step calls out explicitly).
 * `fonts.ts`'s own `FontMapping.mapped` flag answers a DIFFERENT question than
 * ours: it is `true` for BOTH "the pipeline substituted a different family"
 * AND "the pipeline recognized the observed family as already free and kept it
 * as itself" — i.e. `mapped: true` conflates "substituted" and "kept" under one
 * flag, and `mapped: false` means only "unrecognized, kept verbatim". None of
 * that lines up with what THIS metric needs to know (did the shipped family
 * change relative to what the site actually used?), so this module does not
 * read `.mapped` at all and instead derives its own `wasKept` directly from
 * `mappedFamily` vs `observedFamily`:
 *   - `mappedFamily === undefined`                        -> kept (nothing was
 *     substituted; either unrecognized-verbatim, or — the rare empty-stack
 *     edge — no family was observed at all and even the fallback-only stack
 *     head is used, see `shippedFamily`).
 *   - `mappedFamily` defined but `observedFamily === undefined` -> NOT kept (a
 *     preset default, e.g. `DEFAULT_SANS`/`DEFAULT_MONO`, was substituted in
 *     place of zero observed evidence — there was nothing to "keep").
 *   - both defined -> kept iff they name the same family (normalized) — the
 *     "recognized as already free, chosen = observed" case in `fonts.ts`.
 * When `wasKept` is true, this module classifies purely on whether that
 * (unchanged) family happens to match truth/lookalike — `kept` or
 * `silently-wrong`, NEVER `mapped` (mapped requires an actual, deliberate
 * substitution to have occurred). When `wasKept` is false (a real substitution
 * happened), the module classifies `mapped` / `lookalike` / `silently-wrong`
 * in that priority order. This makes `kept` and `mapped` mutually exclusive by
 * construction: `kept` is "correct without trying", `mapped` is "correct
 * because the pipeline actively fixed it".
 *
 * ----------------------------------------------------- family normalization ---
 * Comparison must be robust to case, quotes, whitespace, and a full CSS
 * fallback-stack string (only the head family is compared). This module reuses
 * `fonts.ts`'s existing `fingerprint()` (lower-case, punctuation/whitespace
 * stripped — the SAME normalization `mapFontStack`'s own lookalike lookup
 * already uses; code-quality.md "one source of truth", not re-implemented
 * string matching) after first taking the comma-split head of whatever string
 * is passed (defensive: pinned `family` values and `stack[0]` are always
 * already single names in practice, but a caller handing in a raw CSS
 * `font-family` declaration must still compare correctly).
 *
 * `FAMILY_ALIASES` is a SMALL, PROVISIONAL, explicitly-named set of fingerprint
 * synonyms for cases `fingerprint()` alone cannot bridge because they are
 * genuinely different strings for what is recognizably the same family:
 * "Helvetica Neue" vs "Helvetica" (explicitly called out in the plan).
 *
 * `stripKnownSuffixes` handles a SECOND normalization: a CLOSED, mechanical
 * suffix vocabulary, applied iteratively and — because it lives inside
 * `canonicalFontFingerprint`, which `familiesEqual` calls on BOTH operands —
 * SYMMETRICALLY to whichever side (shipped or pinned) happens to carry the
 * suffix. Two documented categories, both closed enumerations, not open-ended
 * fuzzy matching:
 *   - VARIABLE-FONT PACKAGING (`variable`, `vf`): a "Variable"/"VF"-suffixed
 *     name ships the SAME family as a single variable-weight file — never a
 *     different typeface. Evidenced by linear ("Inter Variable" vs pinned
 *     "Inter") and github ("Mona Sans VF" vs pinned "Mona Sans").
 *   - WEIGHT/STYLE MODIFIERS (the closed PostScript weight/style vocabulary:
 *     Thin/ExtraLight/Light/Regular/Book/Medium/SemiBold/DemiBold/Bold/
 *     ExtraBold/Black/Heavy + Italic/Oblique/Condensed/Narrow + "UI"): a
 *     weight/style-suffixed PostScript name is the SAME family under an
 *     equally closed, mechanical convention — the code-review finding that
 *     added this category is correct that the "avoid over-eager fuzzy
 *     matching" rationale does not distinguish it from the VF-suffix case
 *     already accepted. Evidenced by THREE independent real corpus sites:
 *     kurzgesagt ("Montserrat-Medium"/"Montserrat-Regular" vs pinned
 *     "Montserrat"), spotify ("SpotifyMixUI" vs pinned "Spotify Mix"), and
 *     duolingo ("Feather" vs pinned "Feather Bold" — note this strips the
 *     suffix off the PINNED side, proof the rule is genuinely symmetric, not
 *     just shipped-side-only).
 *
 * CRITICAL EXCLUSION: "Text" and "Display" are deliberately NOT in this
 * vocabulary. robinhood pins "Capsule Sans Display" (heading) and "Capsule
 * Sans Text" (body) as genuinely DIFFERENT true families per role — stripping
 * either token would wrongly collapse them to the same fingerprint and defeat
 * the anti-circularity anchor. `test/eval.font-fidelity.test.ts` carries an
 * explicit "Display ≠ Text" regression guard on `canonicalFontFingerprint`
 * directly, independent of any one scoring test.
 *
 * ------------------------------------------------------------- thresholds ---
 * The only "threshold" here is the alias table above (a discrete allow-list,
 * not a numeric distance) and the composite `pass` gate below — both
 * PROVISIONAL (plan §8), revisited at Step 11 face-validity, mirroring
 * `color-fidelity.ts`'s threshold-provisionality convention.
 */

import { fingerprint, type FontMapping } from '../extract/fonts.ts';
import type { NormalizeResult } from '../extract/normalize.ts';
import type { TruthTemplate } from '../../benchmark/truth-scaffold.ts';

// --- family normalization -----------------------------------------------------

/**
 * Fingerprint synonyms `fingerprint()` alone cannot bridge (see file header
 * "family normalization" for the evidence behind each entry). PROVISIONAL and
 * intentionally small — every entry maps a fingerprint that occurs in a real
 * corpus fixture or is explicitly named in the plan, not a speculative rule.
 */
const FAMILY_ALIASES: Readonly<Record<string, string>> = {
  helveticaneue: 'helvetica',
};

/**
 * Closed, mechanical suffix vocabulary stripped from a fingerprint before
 * comparison — see file header "family normalization" for the full rationale
 * + the real-fixture evidence per suffix, and the CRITICAL EXCLUSION of
 * "text"/"display". Sorted longest-first (by fingerprinted length) so a
 * compound suffix ("extrabold") is matched before its shorter substring
 * ("bold") could otherwise strip only part of it and leave a stray remainder
 * (e.g. stripping "bold" from "...extrabold" first would wrongly leave
 * "...extra" instead of continuing on to strip "extrabold" whole).
 */
const SUFFIX_VOCABULARY: readonly string[] = [
  // variable-font packaging (linear, github)
  'variable',
  'vf',
  // weight/style modifiers — the closed PostScript weight/style vocabulary
  // (kurzgesagt, spotify, duolingo)
  'extralight',
  'semibold',
  'demibold',
  'extrabold',
  'condensed',
  'regular',
  'oblique',
  'italic',
  'narrow',
  'medium',
  'heavy',
  'light',
  'thin',
  'bold',
  'book',
  'black',
  'ui',
].sort((a, b) => b.length - a.length);

/**
 * Iteratively strip trailing suffixes from `SUFFIX_VOCABULARY` off an
 * already-fingerprinted string, e.g. "montserratmedium" -> "montserrat",
 * "featherbold" -> "feather", "monasansvf" -> "monasans". Iterates (not just
 * one pass) so a compound suffix like "SemiBold Italic" (fingerprint
 * "semibolditalic") fully reduces to "semibold" then to the base family.
 * Never strips a suffix that would consume the ENTIRE remaining string (a
 * fingerprint is never collapsed to '').
 */
function stripKnownSuffixes(fp: string): string {
  let current = fp;
  let strippedSomething = true;
  while (strippedSomething) {
    strippedSomething = false;
    for (const suffix of SUFFIX_VOCABULARY) {
      if (current.length > suffix.length && current.endsWith(suffix)) {
        current = current.slice(0, current.length - suffix.length);
        strippedSomething = true;
        break; // restart the longest-first scan against the shorter remainder
      }
    }
  }
  return current;
}

/**
 * Normalize a font-family string to a comparison key: take the comma-split
 * HEAD (defensive against a full CSS fallback-stack string being passed),
 * fingerprint it (case/whitespace/quote/punctuation-insensitive — reuses
 * `fonts.ts`'s existing normalization, not re-implemented), strip any known
 * trailing suffix, then resolve any known alias synonym. Exported so tests
 * can assert the normalization directly without going through a full role
 * score.
 */
export function canonicalFontFingerprint(family: string): string {
  const head = family.split(',')[0] ?? family;
  const fp = stripKnownSuffixes(fingerprint(head));
  return FAMILY_ALIASES[fp] ?? fp;
}

/** True when two family strings name the same family under normalization. */
function familiesEqual(a: string, b: string): boolean {
  return canonicalFontFingerprint(a) === canonicalFontFingerprint(b);
}

// --- the scoreable proposal (in-process, no .md parsing) ---------------------

/**
 * The structured slice of an `onbrand from-url` proposal the font-fidelity
 * scorer needs — one `FontMapping` per structural role, read verbatim from
 * `NormalizeResult.fonts` (never re-parsed or re-derived).
 */
export interface ScoreableFontsProposal {
  heading: FontMapping;
  body: FontMapping;
  mono: FontMapping;
}

/**
 * Build a `ScoreableFontsProposal` from a production `NormalizeResult` — the
 * SAME producer `color-fidelity.ts`'s `scoreableProposalFromNormalize` reads
 * (plan §4 impact table: an additive accessor, not a new call site). Note
 * `NormalizeResult.fonts.sans` is the BODY role (see `fonts.ts`'s `MappedFonts`
 * doc comment); this accessor renames it to `body` to match the pinned-truth
 * shape (`pinned.fonts.{heading,body,mono}`) 1:1.
 */
export function scoreableFontsProposalFromNormalize(norm: NormalizeResult): ScoreableFontsProposal {
  return {
    heading: norm.fonts.heading,
    body: norm.fonts.sans,
    mono: norm.fonts.mono,
  };
}

// --- kept-vs-mapped + classification -----------------------------------------

/** The final family the tokens.json build actually ships for this role (the
 * literal `font.*` leaf value's first entry) — see file header "the shipped
 * font". Falls back to `stack[0]` only in the rare empty-stack edge where
 * BOTH `mappedFamily` and `observedFamily` are undefined. */
function shippedFamily(mapping: FontMapping): string {
  return mapping.mappedFamily ?? mapping.observedFamily ?? mapping.stack[0] ?? '';
}

/**
 * True when NO substitution was made or needed — see file header "kept-vs-mapped
 * boundary" for the full rationale. Deliberately does NOT read
 * `FontMapping.mapped` (a different axis; see header).
 */
function wasKept(mapping: FontMapping): boolean {
  if (mapping.mappedFamily === undefined) return true;
  if (mapping.observedFamily === undefined) return false;
  return familiesEqual(mapping.mappedFamily, mapping.observedFamily);
}

export type FontStructuralRole = 'heading' | 'body' | 'mono';
export type FontFidelityClassification = 'mapped' | 'lookalike' | 'kept' | 'silently-wrong';

/** One pinned font role (`pinned.fonts.heading`/`.body`/`.mono`) — non-null
 * (a null role is SKIPPED by the caller before this is ever built; see
 * `scoreFontFidelity`). */
export type PinnedFont = NonNullable<TruthTemplate['pinned']['fonts'][FontStructuralRole]>;

export interface FontRoleFidelityResult {
  role: FontStructuralRole;
  classification: FontFidelityClassification;
  /** The family the proposal actually ships for this role (normalized comparisons use this verbatim string as input). */
  shippedFamily: string;
  /** The pinned TRUE family for this role. */
  trueFamily: string;
  /** Which pinned lookalike (verbatim, as authored in the truth file) matched — populated ONLY when `classification === 'lookalike'`; `undefined` for every other classification, including a `kept` role that happens to have matched via a lookalike rather than the true family (a lookalike-shaped match that required no substitution is reported as `kept`, not as a lookalike hit — see file header). */
  matchedLookalike: string | undefined;
  /** Whether the pipeline actively changed the family away from what the site itself used (the `wasKept` inverse — see file header). */
  substituted: boolean;
  /**
   * The pinned truth's confidence for this role (`pinned.fonts.<role>.confidence`
   * — the same 3-level enum `color-fidelity.ts`'s `CONFIDENCE_WEIGHT` down-
   * weights). Surfaced here for a future consumer (Step 10/11), but NOT used
   * to down-weight anything in this module: unlike `color-fidelity.ts`'s
   * continuous 0..1 score, this metric's output is a categorical
   * classification with no natural weighted-average target to fold a
   * down-weight into — a low-confidence pin makes a `silently-wrong` verdict
   * less certain, not less true. Left as an explicit scope decision for
   * Step 11 (e.g. an "advisory" tier for low-confidence misses) rather than
   * invented here.
   */
  confidence: PinnedFont['confidence'];
}

/**
 * Score a single font role's fidelity against its pinned truth. Pure; no I/O.
 * See file header for the full classification + kept-vs-mapped rationale.
 */
export function scoreFontRoleFidelity(
  role: FontStructuralRole,
  mapping: FontMapping,
  pinned: PinnedFont,
): FontRoleFidelityResult {
  const shipped = shippedFamily(mapping);
  const kept = wasKept(mapping);
  const matchesTrue = familiesEqual(shipped, pinned.family);
  const lookalikeMatch = pinned.lookalikes.find((l) => familiesEqual(shipped, l));

  let classification: FontFidelityClassification;
  if (kept) {
    // No substitution occurred — `mapped` is reserved for a deliberate,
    // successful substitution (see file header); a match here can only ever
    // be `kept`, never `mapped`.
    classification = matchesTrue || lookalikeMatch !== undefined ? 'kept' : 'silently-wrong';
  } else if (matchesTrue) {
    classification = 'mapped';
  } else if (lookalikeMatch !== undefined) {
    classification = 'lookalike';
  } else {
    classification = 'silently-wrong';
  }

  return {
    role,
    classification,
    shippedFamily: shipped,
    trueFamily: pinned.family,
    // Only ever surfaced for a genuine `lookalike` classification (finding 5)
    // — a `kept` role that happened to match via the lookalike set (no
    // substitution needed) does NOT report a matchedLookalike, since `kept`
    // means "matches truth-or-lookalike" without distinguishing which.
    matchedLookalike: classification === 'lookalike' ? lookalikeMatch : undefined,
    substituted: !kept,
    confidence: pinned.confidence,
  };
}

// --- composite (per-site, symmetrically nullable) ----------------------------

const FONT_ROLES: readonly FontStructuralRole[] = ['heading', 'body', 'mono'];

/** Classifications that count as a font-fidelity SUCCESS for the composite
 * pass gate — every bucket except the one failure mode this metric exists to
 * catch. PROVISIONAL (plan §8), like `color-fidelity.ts`'s thresholds. */
const SUCCESS_CLASSIFICATIONS: ReadonlySet<FontFidelityClassification> = new Set([
  'mapped',
  'lookalike',
  'kept',
]);

export interface FontFidelityResult {
  /** `null` when `truth.pinned.fonts.heading` is null, OR when `truth.status !== 'pinned'` — SKIPPED, never scored (symmetric-nullable, mirrors `color-fidelity.ts`'s background skip discipline). */
  heading: FontRoleFidelityResult | null;
  body: FontRoleFidelityResult | null;
  mono: FontRoleFidelityResult | null;
  /** Which roles were actually scored (had a non-null pinned truth AND `truth.status === 'pinned'`). Empty when the truth isn't frozen yet — callers MUST check this (not just `pass`) to distinguish "nothing was scored" from "genuinely failed". */
  scoredRoles: FontStructuralRole[];
  /** Which of the scored roles came back `silently-wrong`. */
  silentlyWrongRoles: FontStructuralRole[];
  /**
   * `true` iff `scoredRoles` is non-empty AND every scored role avoided
   * `silently-wrong` (PROVISIONAL gate — Step 11). Deliberately NOT
   * `scoredRoles.every(...)` alone: `Array.prototype.every` on an empty array
   * is vacuously `true` in JS, which would silently report a font-fidelity
   * PASS for a site that was never scored at all (e.g. the 8 csszengarden
   * controls, which are permanently `status: 'scaffolded'` with all-null
   * pinned fonts) — exactly the false-green measurement-validity failure this
   * gate exists to prevent. An unscored site must read as `pass: false` with
   * an empty `scoredRoles`, never as a silent pass.
   */
  pass: boolean;
}

/**
 * Score all 3 font roles for one site against its pinned truth. A role whose
 * `pinned.fonts.<role>` is `null` is SKIPPED (returns `null` for that role),
 * never scored against a synthesized value — mirrors
 * `color-fidelity.ts`'s `scoreBackgroundFidelity` symmetric-nullable
 * discipline (plan §6). `body` is the one role a PINNED template can never
 * leave null (schema-enforced in `truth-scaffold.ts`), so every pinned real
 * site scores at least `body`.
 *
 * `truth.status !== 'pinned'` (e.g. the 8 csszengarden controls, which stay
 * permanently `scaffolded` — `truth-scaffold.ts` never derives a font guess,
 * so `pinned.fonts` is null for them by construction) skips EVERY role
 * unconditionally, without even reading `pinned.fonts` — a template that
 * hasn't been frozen carries no trustworthy ground truth yet (the anti-
 * circularity contract), so it must never be scored, not even vacuously.
 */
export function scoreFontFidelity(
  proposal: ScoreableFontsProposal,
  truth: Pick<TruthTemplate, 'pinned' | 'status'>,
): FontFidelityResult {
  const results: Record<FontStructuralRole, FontRoleFidelityResult | null> = {
    heading: null,
    body: null,
    mono: null,
  };

  if (truth.status === 'pinned') {
    for (const role of FONT_ROLES) {
      const pinned = truth.pinned.fonts[role];
      if (pinned === null) continue;
      results[role] = scoreFontRoleFidelity(role, proposal[role], pinned);
    }
  }

  const scoredRoles = FONT_ROLES.filter((role) => results[role] !== null);
  const silentlyWrongRoles = scoredRoles.filter(
    (role) => results[role]!.classification === 'silently-wrong',
  );
  // See FontFidelityResult.pass doc comment for why `scoredRoles.length > 0`
  // is a required conjunct, not just `scoredRoles.every(...)`.
  const pass =
    scoredRoles.length > 0 &&
    scoredRoles.every((role) => SUCCESS_CLASSIFICATIONS.has(results[role]!.classification));

  return {
    heading: results.heading,
    body: results.body,
    mono: results.mono,
    scoredRoles,
    silentlyWrongRoles,
    pass,
  };
}
