/**
 * Font-fidelity metric — Brand-Fidelity Step 6 (#35), post-review revision.
 *
 * Calibration-anchor-first (measurement-validity.md): every anchor scores the
 * PRODUCTION pipeline's real output (`normalize()` replayed over a committed
 * `docs/findings/eval-raw-extractions/benchmark/*.raw-extraction.json` fixture,
 * which internally calls the real `mapFonts()`/`mapFontStack()` from
 * `src/extract/fonts.ts`) against the REAL frozen ground truth
 * (`docs/findings/eval-truth/*.truth.json`, validated through the production
 * `truthTemplateSchema`) — no mock at the data boundary. Only the REQUIRED
 * "mapped" anchor constructs a synthetic `FontStack` input (by design, mirroring
 * `eval.color-fidelity.test.ts`'s white-chrome-guard/CVD precedent): none of the
 * 12 real pinned v1 sites happen to have a pinned true family that is reached by
 * an ACTUAL substitution away from a different observed family (the one site
 * pinned exactly "Inter", linear, already observes "Inter Variable" verbatim —
 * a `kept` case, not a substitution). That anchor still runs the REAL production
 * `mapFontStack` — never a hand-rolled reimplementation — on a hand-built
 * `FontStack`, the same "construct input, run real scorer" methodology.
 *
 * POST-REVIEW NOTES (code review + anchor-skeptics + completeness critic
 * returned NEEDS-WORK on the first version of this step):
 *  - `ROLE_CALIBRATION` now covers ALL 12 real v1 sites (was 6), with an
 *    explicit completeness self-check (mirrors `eval.color-fidelity.test.ts`'s
 *    `ACCENT_CALIBRATION` completeness assertion). The weight/style-suffix fix
 *    (`src/eval/font-fidelity.ts`'s `SUFFIX_VOCABULARY`) flips kurzgesagt,
 *    spotify, and duolingo from a false `silently-wrong` to an honest `kept` —
 *    the calibration below reflects the fix, not the pre-fix bug.
 *  - `scoreFontFidelity` no longer vacuously passes an unpinned/all-null truth
 *    (the 8 czg controls) — see the dedicated describe block below.
 *  - `matchedLookalike` is now asserted to be `undefined` outside a genuine
 *    `lookalike` classification (a `kept`-via-lookalike role does NOT report
 *    one) — see the new "kept AND matched only via lookalike" test.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { truthTemplateSchema, type TruthTemplate } from '../benchmark/truth-scaffold.ts';
import type { FontStack, RawExtraction } from '../src/extract/engine/adapter.ts';
import { mapFontStack, mapFonts } from '../src/extract/fonts.ts';
import { normalize } from '../src/extract/normalize.ts';
import {
  canonicalFontFingerprint,
  scoreFontFidelity,
  scoreFontRoleFidelity,
  scoreableFontsProposalFromNormalize,
  type PinnedFont,
  type ScoreableFontsProposal,
} from '../src/eval/font-fidelity.ts';

const BENCH_DIR = fileURLToPath(
  new URL('../docs/findings/eval-raw-extractions/benchmark/', import.meta.url),
);
const TRUTH_DIR = fileURLToPath(new URL('../docs/findings/eval-truth/', import.meta.url));

function readFixture(id: string): RawExtraction {
  return JSON.parse(readFileSync(`${BENCH_DIR}${id}.raw-extraction.json`, 'utf8')) as RawExtraction;
}

/** Read + schema-validate a REAL pinned truth file — the production contract
 * (truthTemplateSchema) is the same one that rejects a not-yet-pinned template. */
function readTruth(id: string): TruthTemplate {
  const raw = JSON.parse(readFileSync(`${TRUTH_DIR}${id}.truth.json`, 'utf8'));
  return truthTemplateSchema.parse(raw);
}

/** Build a real `ScoreableFontsProposal` by replaying a committed fixture
 * through the PRODUCTION `normalize()` (which internally calls the real
 * `mapFonts()`) — the exact producer `scoreableFontsProposalFromNormalize`'s
 * consumer contract is written against. */
function realProposal(id: string): ScoreableFontsProposal {
  return scoreableFontsProposalFromNormalize(normalize(readFixture(id)));
}

function pinnedFont(overrides: Partial<PinnedFont> = {}): PinnedFont {
  return {
    family: 'Inter',
    lookalikes: [],
    source: 'operator-judgment',
    confidence: 'high',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// canonicalFontFingerprint — family normalization
// ---------------------------------------------------------------------------

describe('canonicalFontFingerprint', () => {
  it('is case/whitespace/quote insensitive', () => {
    expect(canonicalFontFingerprint('Inter')).toBe(canonicalFontFingerprint('  inter  '));
    expect(canonicalFontFingerprint('"Capsule Sans Text"')).toBe(
      canonicalFontFingerprint('Capsule Sans Text'),
    );
  });

  it('compares only the head of a full CSS fallback stack', () => {
    expect(canonicalFontFingerprint('Capsule Sans Text, Inter, sans-serif')).toBe(
      canonicalFontFingerprint('Capsule Sans Text'),
    );
  });

  it('aliases "Helvetica Neue" to "Helvetica" (explicitly named in the plan)', () => {
    expect(canonicalFontFingerprint('Helvetica Neue')).toBe(canonicalFontFingerprint('Helvetica'));
  });

  it('strips a variable-font packaging suffix: "Inter Variable" -> "Inter" (real linear fixture)', () => {
    expect(canonicalFontFingerprint('Inter Variable')).toBe(canonicalFontFingerprint('Inter'));
  });

  it('strips a variable-font packaging suffix: "Mona Sans VF" -> "Mona Sans" (real github fixture)', () => {
    expect(canonicalFontFingerprint('Mona Sans VF')).toBe(canonicalFontFingerprint('Mona Sans'));
  });

  // --- weight/style-suffix stripping (review finding #1) ---------------------

  it('strips a PostScript weight suffix: "Montserrat-Medium"/"Montserrat-Regular" -> "Montserrat" (real kurzgesagt fixture)', () => {
    expect(canonicalFontFingerprint('Montserrat-Medium')).toBe(canonicalFontFingerprint('Montserrat'));
    expect(canonicalFontFingerprint('Montserrat-Regular')).toBe(canonicalFontFingerprint('Montserrat'));
  });

  it('strips a trailing "UI" suffix: "SpotifyMixUI" -> "Spotify Mix" (real spotify fixture)', () => {
    expect(canonicalFontFingerprint('SpotifyMixUI')).toBe(canonicalFontFingerprint('Spotify Mix'));
  });

  it('strips a weight suffix off the PINNED side too (symmetric): "Feather" (shipped) == "Feather Bold" (pinned true family, real duolingo fixture)', () => {
    // This is the proof the strip is genuinely symmetric (finding #1) — the
    // suffix here is on the TRUTH side, not the shipped side.
    expect(canonicalFontFingerprint('Feather')).toBe(canonicalFontFingerprint('Feather Bold'));
  });

  it('a compound weight+style suffix reduces fully (iterative stripping): "Montserrat-SemiBold-Italic" -> "Montserrat"', () => {
    expect(canonicalFontFingerprint('Montserrat-SemiBold-Italic')).toBe(
      canonicalFontFingerprint('Montserrat'),
    );
  });

  it('does NOT collapse two genuinely different families', () => {
    expect(canonicalFontFingerprint('Inter')).not.toBe(canonicalFontFingerprint('Roboto'));
    expect(canonicalFontFingerprint('Capsule Sans Display')).not.toBe(
      canonicalFontFingerprint('Phonic'),
    );
  });

  // --- CRITICAL EXCLUSION regression guard (review finding #1) ---------------

  it('CRITICAL EXCLUSION: does NOT strip "Text"/"Display" — robinhood pins these as genuinely DIFFERENT true families per role', () => {
    const display = canonicalFontFingerprint('Capsule Sans Display');
    const text = canonicalFontFingerprint('Capsule Sans Text');
    expect(display).not.toBe(text);
    expect(display).toBe('capsulesansdisplay');
    expect(text).toBe('capsulesanstext');
  });
});

// ---------------------------------------------------------------------------
// scoreableFontsProposalFromNormalize — the producer/consumer seam
// ---------------------------------------------------------------------------

describe('scoreableFontsProposalFromNormalize', () => {
  it('builds a well-formed proposal from the real stripe fixture via production normalize(), correctly renaming fonts.sans -> body', () => {
    const norm = normalize(readFixture('stripe'));
    const proposal = scoreableFontsProposalFromNormalize(norm);
    expect(proposal.body).toBe(norm.fonts.sans); // same object — no re-derivation
    expect(proposal.heading).toBe(norm.fonts.heading);
    expect(proposal.mono).toBe(norm.fonts.mono);
    expect(proposal.heading.stack.length).toBeGreaterThan(0);
    expect(proposal.body.stack.length).toBeGreaterThan(0);
    expect(proposal.mono.stack.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// kept-vs-mapped boundary — direct unit tests on constructed FontMapping shapes
// (pins the exact semantics unambiguously, independent of any real fixture)
// ---------------------------------------------------------------------------

describe('scoreFontRoleFidelity — kept-vs-mapped boundary (constructed FontMapping shapes)', () => {
  it('mappedFamily undefined (unrecognized, kept verbatim) + matches true -> kept, never mapped', () => {
    const mapping = mapFontStack({ families: ['Graphik'], role: 'body', frequency: 1 });
    expect(mapping.mapped).toBe(false); // sanity: fonts.ts genuinely didn't recognize it
    const result = scoreFontRoleFidelity('body', mapping, pinnedFont({ family: 'Graphik' }));
    expect(result.substituted).toBe(false);
    expect(result.classification).toBe('kept');
  });

  it('mappedFamily defined + observedFamily undefined (DEFAULT_SANS: a preset default substituted for zero evidence) is NEVER "kept"', () => {
    // mapFonts([]) is the real production path that reaches DEFAULT_SANS: no
    // FontStack at all was observed for the body role (as opposed to
    // mapFontStack on an empty-families stack, which leaves BOTH fields
    // undefined — a different shape, exercised by the mono-fallback anchors
    // elsewhere in this file).
    const mapping = mapFonts([]).sans;
    expect(mapping.mappedFamily).toBe('Inter');
    expect(mapping.observedFamily).toBeUndefined();
    const result = scoreFontRoleFidelity('body', mapping, pinnedFont({ family: 'Inter' }));
    expect(result.substituted).toBe(true); // never "kept" — there was nothing to keep
    expect(result.classification).toBe('mapped'); // matches true, but only via substitution
  });

  it('mappedFamily === observedFamily (recognized as already-free, kept as itself) -> kept, not substituted', () => {
    const mapping = mapFontStack({ families: ['Inter'], role: 'body', frequency: 1 });
    expect(mapping.mapped).toBe(true); // fonts.ts DOES flag this mapped:true ("keep" entry)
    expect(mapping.mappedFamily).toBe(mapping.observedFamily); // identity — no real substitution
    const result = scoreFontRoleFidelity('body', mapping, pinnedFont({ family: 'Inter' }));
    expect(result.substituted).toBe(false); // OUR axis disagrees with .mapped's axis — by design (see file header)
    expect(result.classification).toBe('kept');
  });

  it('mappedFamily !== observedFamily (a genuine substitution) that lands on true -> mapped, never kept', () => {
    const mapping = mapFontStack({ families: ['Helvetica'], role: 'body', frequency: 1 });
    expect(mapping.mappedFamily).toBe('Inter');
    expect(mapping.observedFamily).toBe('Helvetica');
    const result = scoreFontRoleFidelity('body', mapping, pinnedFont({ family: 'Inter' }));
    expect(result.substituted).toBe(true);
    expect(result.classification).toBe('mapped');
  });

  it('kept AND matched only via a lookalike (not the exact true family) -> kept, with matchedLookalike left undefined (findings #5 + #6)', () => {
    // "Graphik" is unrecognized by fonts.ts's lookalike table (real production
    // behavior, verified in the test above) -> kept verbatim, no substitution.
    const mapping = mapFontStack({ families: ['Graphik'], role: 'body', frequency: 1 });
    expect(mapping.mapped).toBe(false);
    // Pinned truth names a DIFFERENT true family, but lists the shipped
    // family ("Graphik") as an accepted lookalike for it.
    const pinned = pinnedFont({ family: 'Circular', lookalikes: ['Graphik', 'Inter'] });

    const result = scoreFontRoleFidelity('body', mapping, pinned);

    expect(result.substituted).toBe(false); // no substitution occurred — this is the "kept" branch
    expect(result.classification).toBe('kept'); // NOT 'lookalike' — kept wins when no substitution was needed
    // matchedLookalike is populated ONLY for classification === 'lookalike'
    // (finding #5) — a kept role never reports one, even though the match
    // technically went through the lookalike list.
    expect(result.matchedLookalike).toBeUndefined();
  });

  it('the empty-stack edge (BOTH mappedFamily and observedFamily undefined) falls back to the system-fallback stack head, and is treated as "kept" (nothing was substituted)', () => {
    // mapFontStack on a FontStack whose families are all blank strings — a
    // different shape than mapFonts([]) (DEFAULT_SANS/DEFAULT_MONO, which
    // DOES set mappedFamily) or a stack with a real first family (which sets
    // observedFamily). Neither field is defined here.
    const mapping = mapFontStack({ families: [], role: 'mono', frequency: 0 });
    expect(mapping.mappedFamily).toBeUndefined();
    expect(mapping.observedFamily).toBeUndefined();
    expect(mapping.stack[0]).toBeDefined(); // the fallback tail always has a head

    const result = scoreFontRoleFidelity('mono', mapping, pinnedFont({ family: 'JetBrains Mono' }));

    expect(result.shippedFamily).toBe(mapping.stack[0]); // fell back to the stack head
    expect(mapping.stack[0]).toBe('Segoe UI'); // fonts.ts's empty-stack branch always uses SANS_FALLBACKS regardless of role — a pre-existing quirk, out of scope here (scope guard: never change fonts.ts)
    expect(result.substituted).toBe(false); // wasKept: mappedFamily undefined -> kept
    // The system-fallback head is almost never the pinned true family, so this
    // genuinely (and correctly) reads as a miss — not a crash, not a false pass.
    expect(result.classification).toBe('silently-wrong');
  });
});

// ---------------------------------------------------------------------------
// REQUIRED ANCHOR — a correctly-mapped stack scores "mapped"
// ---------------------------------------------------------------------------
//
// SYNTHETIC BY DESIGN (see file header): none of the 12 real pinned v1 sites
// have a pinned true family reached by an ACTUAL substitution away from a
// different real observed family. This anchor runs the REAL production
// `mapFontStack` (never reimplemented) on a hand-built `FontStack` whose first
// family ("Helvetica") is a genuine `LOOKALIKE_TABLE` entry that resolves to
// "Inter" — paired with a pinned truth whose true family is "Inter" (the exact
// value linear itself pins for real).

describe('scoreFontRoleFidelity — REQUIRED calibration anchor: a correctly-mapped stack scores "mapped"', () => {
  it('a real Helvetica -> Inter substitution (production mapFontStack), scored against a pinned true family of "Inter", classifies as mapped', () => {
    const stack: FontStack = { families: ['Helvetica'], role: 'heading', frequency: 10 };
    const mapping = mapFontStack(stack);
    const truePin = pinnedFont({ family: 'Inter', lookalikes: ['Helvetica'] });

    const result = scoreFontRoleFidelity('heading', mapping, truePin);

    expect(result.shippedFamily).toBe('Inter');
    expect(result.substituted).toBe(true);
    expect(result.classification).toBe('mapped');
  });
});

// ---------------------------------------------------------------------------
// REQUIRED ANCHOR — a wrong-font pairing is forced to "silently-wrong"
// (the garbage anchor — mirrors color-fidelity.ts's Hacker-News-orange swap)
// ---------------------------------------------------------------------------

describe('scoreFontRoleFidelity — REQUIRED calibration anchor: a wrong-font pairing is forced to silently-wrong (garbage anchor)', () => {
  it('the real stripe proposal (a genuinely GOOD Söhne -> Inter substitution) scored against a deliberately-wrong pinned family scores silently-wrong', () => {
    const proposal = realProposal('stripe');
    // Deliberately wrong reference: nothing about stripe's real site uses
    // "Papyrus", and it shares no lookalike relationship with "Inter" either.
    const garbagePin = pinnedFont({ family: 'Papyrus', lookalikes: [] });

    const result = scoreFontRoleFidelity('heading', proposal.heading, garbagePin);

    // The instrument is genuinely falsifiable here: stripe's real shipped
    // family ("Inter") is a DEFENSIBLE, licensed substitution for its REAL
    // pinned truth (Söhne) — proven by the calibration-lock test below, which
    // scores this exact same shipped family against the REAL truth and gets
    // `lookalike`. Swapping in a garbage reference must still force the
    // failure mode, not be rescued by "well, Inter is a reasonable font".
    expect(result.classification).toBe('silently-wrong');
    expect(result.matchedLookalike).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// REQUIRED ANCHOR — robinhood anti-circularity
// ---------------------------------------------------------------------------
//
// robinhood's real extraction reports "Phonic" as the heading/body candidate
// (see fixture below) — but the site's real brand face is Capsule Sans
// (Text/Display/Text Mono). If this scorer read the extractor's OWN font
// evidence as if it were truth, "Phonic" could never be caught as wrong. It
// must classify honestly against the FROZEN pinned Capsule Sans truth instead.

describe('scoreFontFidelity — REQUIRED calibration anchor: robinhood anti-circularity', () => {
  it('robinhood: the real shipped "Phonic" heading/body is honestly silently-wrong against pinned Capsule Sans — never rescued by the extractor\'s own (wrong) read', () => {
    const proposal = realProposal('robinhood');
    const truth = readTruth('robinhood');

    // Sanity on the fixture itself: the real extraction's own font evidence is
    // indeed "Phonic", not Capsule Sans — confirms this is a genuine hard case,
    // not a strawman.
    expect(proposal.heading.observedFamily).toBe('Phonic');
    expect(proposal.body.observedFamily).toBe('Phonic');
    expect(truth.pinned.fonts.heading?.family).toBe('Capsule Sans Display');
    expect(truth.pinned.fonts.body?.family).toBe('Capsule Sans Text');

    const result = scoreFontFidelity(proposal, truth);

    expect(result.heading?.classification).toBe('silently-wrong');
    expect(result.body?.classification).toBe('silently-wrong');
    expect(result.silentlyWrongRoles).toEqual(expect.arrayContaining(['heading', 'body']));
    expect(result.pass).toBe(false);
  });

  it('robinhood: mono legitimately recovers via lookalike (no mono was observed at all, so the DEFAULT JetBrains Mono fallback shipped, which happens to be pinned as an accepted lookalike) — real, not synthetic', () => {
    const proposal = realProposal('robinhood');
    const truth = readTruth('robinhood');
    expect(proposal.mono.observedFamily).toBeUndefined(); // no mono evidence in the real fixture at all
    expect(truth.pinned.fonts.mono?.lookalikes).toContain('JetBrains Mono');

    const result = scoreFontRoleFidelity('mono', proposal.mono, truth.pinned.fonts.mono!);
    expect(result.shippedFamily).toBe('JetBrains Mono');
    expect(result.classification).toBe('lookalike');
    expect(result.matchedLookalike).toBe('JetBrains Mono');
  });
});

// ---------------------------------------------------------------------------
// Symmetric-nullable skip (mirrors color-fidelity.ts's background discipline;
// imprintgenius chosen deliberately — same site, same concept)
// ---------------------------------------------------------------------------

describe('scoreFontFidelity — symmetric-nullable skip', () => {
  it('imprintgenius: a null pinned mono is SKIPPED (returns null), never scored against a synthesized value', () => {
    const proposal = realProposal('imprintgenius');
    const truth = readTruth('imprintgenius');
    expect(truth.pinned.fonts.mono).toBeNull(); // sanity on the fixture itself

    const result = scoreFontFidelity(proposal, truth);

    expect(result.mono).toBeNull();
    expect(result.scoredRoles).toEqual(['heading', 'body']);
    expect(result.scoredRoles).not.toContain('mono');
  });

  it('imprintgenius: heading + body are genuinely "kept" (Noi Grotesk is unrecognized by the lookalike table, kept verbatim, and happens to equal the pinned true family) — composite passes', () => {
    const proposal = realProposal('imprintgenius');
    const truth = readTruth('imprintgenius');
    const result = scoreFontFidelity(proposal, truth);

    expect(result.heading?.classification).toBe('kept');
    expect(result.body?.classification).toBe('kept');
    expect(result.pass).toBe(true);
  });

  it('a null pinned HEADING is also skipped (finding #8b — previously only mono-null was exercised); body + mono are still scored', () => {
    // Constructed from a real, schema-valid pinned truth (stripe) with ONLY
    // `pinned.fonts.heading` overridden to null — mirrors
    // `eval.color-fidelity.test.ts`'s garbage-anchor construction style
    // (spread a real truth, override one field, re-validate through the
    // production schema). Valid per truthTemplateSchema: only `body` is
    // required non-null on a pinned template; heading may be null.
    const realTruth = readTruth('stripe');
    const truth = truthTemplateSchema.parse({
      ...realTruth,
      pinned: { ...realTruth.pinned, fonts: { ...realTruth.pinned.fonts, heading: null } },
    });
    expect(truth.pinned.fonts.heading).toBeNull();
    expect(truth.pinned.fonts.body).not.toBeNull();

    const proposal = realProposal('stripe');
    const result = scoreFontFidelity(proposal, truth);

    expect(result.heading).toBeNull();
    expect(result.body).not.toBeNull();
    expect(result.mono).not.toBeNull();
    expect(result.scoredRoles).toEqual(['body', 'mono']);
    expect(result.scoredRoles).not.toContain('heading');
  });
});

// ---------------------------------------------------------------------------
// Calibration lock — classification across real v1 sites (review-durable)
// ---------------------------------------------------------------------------
//
// Locks the documented classification for every scored role across a spread of
// real sites, so a future normalize()/fonts.ts regression that nudges a
// classification shows up as a test failure instead of silently invalidating
// the calibration. Deliberately covers all 4 buckets with real, non-synthetic
// data (mapped is the one exception — see the REQUIRED ANCHOR above for why).

interface RoleCalibration {
  id: string;
  role: 'heading' | 'body' | 'mono';
  classification: 'mapped' | 'lookalike' | 'kept' | 'silently-wrong';
}

/** All 12 real (non-control) v1 corpus sites — same set `eval.color-fidelity.test.ts`'s `ACCENT_CALIBRATION` locks. */
const ALL_12_REAL_SITES = [
  'basecamp', 'duolingo', 'forliving', 'github', 'imprintgenius', 'kurzgesagt',
  'linear', 'medium', 'nytimes', 'robinhood', 'spotify', 'stripe',
] as const;

/** The 6 sites that pin a non-null mono (the other 6 pin `mono: null` and are
 * covered by heading/body only — see the symmetric-nullable-skip block). */
const MONO_PINNED_SITES = new Set(['basecamp', 'github', 'linear', 'medium', 'robinhood', 'stripe']);

// Every entry below was VERIFIED by replaying the real fixture through
// production normalize() + fonts.ts (not hand-computed) — see the dev report
// for the full 12-site audit table. Post-review-fix values (kurzgesagt,
// spotify, duolingo flip from a false `silently-wrong` to an honest `kept`
// once the weight/style-suffix vocabulary is applied).
const ROLE_CALIBRATION: readonly RoleCalibration[] = [
  // forliving: "Ppfragment"/"Instrument Sans" kept verbatim (unrecognized by
  // the lookalike table), both equal the pinned true family exactly.
  { id: 'forliving', role: 'heading', classification: 'kept' },
  { id: 'forliving', role: 'body', classification: 'kept' },
  // imprintgenius: "Noi Grotesk" kept verbatim, equals the pinned true family.
  { id: 'imprintgenius', role: 'heading', classification: 'kept' },
  { id: 'imprintgenius', role: 'body', classification: 'kept' },
  // medium: heading picks a DIFFERENT (tied-frequency, first-seen) stack
  // ("gt-super") than the pinned true "Söhne" -> a genuine miss; body's real
  // Söhne->Inter substitution is scored against the pinned true "Charter"
  // (medium pins DIFFERENT true families per role) -> also a genuine miss.
  { id: 'medium', role: 'heading', classification: 'silently-wrong' },
  { id: 'medium', role: 'body', classification: 'silently-wrong' },
  { id: 'medium', role: 'mono', classification: 'lookalike' },
  // robinhood: "Phonic" is neither the pinned "Capsule Sans Display/Text" nor
  // an accepted lookalike -> the anti-circularity anchor's genuine miss.
  { id: 'robinhood', role: 'heading', classification: 'silently-wrong' },
  { id: 'robinhood', role: 'body', classification: 'silently-wrong' },
  { id: 'robinhood', role: 'mono', classification: 'lookalike' },
  // spotify: "SpotifyMixUI" strips its trailing "UI" suffix to match the
  // pinned true "Spotify Mix" exactly (review finding #1, real anchor 2/3).
  { id: 'spotify', role: 'heading', classification: 'kept' },
  { id: 'spotify', role: 'body', classification: 'kept' },
  // stripe: Söhne -> Inter is a genuine, defensible lookalike substitution.
  { id: 'stripe', role: 'heading', classification: 'lookalike' },
  { id: 'stripe', role: 'body', classification: 'lookalike' },
  // stripe mono: "SourceCodePro" was already free — recognized + kept as
  // itself, and it happens to equal the pinned true family verbatim.
  { id: 'stripe', role: 'mono', classification: 'kept' },
  // duolingo: "Feather" (shipped) strips the pinned true family's "Bold"
  // suffix ("Feather Bold") to match — review finding #1, real anchor 3/3,
  // and the proof the strip is symmetric (the suffix is on the TRUTH side
  // here, not the shipped side). "Duolingo Sans" matches "Duolingo Sans"
  // directly, no suffix needed.
  { id: 'duolingo', role: 'heading', classification: 'kept' },
  { id: 'duolingo', role: 'body', classification: 'kept' },
  // kurzgesagt: real observed "Montserrat-Medium"/"Montserrat-Regular" NOW
  // normalize to the pinned true "Montserrat" (review finding #1, real
  // anchor 1/3 — this FLIPS from the pre-fix `silently-wrong`).
  { id: 'kurzgesagt', role: 'heading', classification: 'kept' },
  { id: 'kurzgesagt', role: 'body', classification: 'kept' },
  // nytimes: real observed "nyt-franklin"/"nyt-cheltenham-small" are neither
  // the pinned "NYT Cheltenham"/"NYT Imperial" nor an accepted lookalike ->
  // genuine misses, unrelated to any suffix (mono is pinned null for nytimes).
  { id: 'nytimes', role: 'heading', classification: 'silently-wrong' },
  { id: 'nytimes', role: 'body', classification: 'silently-wrong' },
  // github: "Mona Sans VF" VF-suffix-normalizes to the pinned true "Mona Sans".
  { id: 'github', role: 'heading', classification: 'kept' },
  { id: 'github', role: 'body', classification: 'kept' },
  { id: 'github', role: 'mono', classification: 'lookalike' },
  // linear: "Inter Variable" kept verbatim, VF-suffix-normalizes to the true
  // pinned "Inter" — kept, not mapped (no substitution occurred).
  { id: 'linear', role: 'heading', classification: 'kept' },
  { id: 'linear', role: 'body', classification: 'kept' },
  // linear mono: no mono observed at all -> DEFAULT JetBrains Mono, which is
  // pinned as an accepted lookalike for the true "Berkeley Mono".
  { id: 'linear', role: 'mono', classification: 'lookalike' },
  // basecamp: "Graphik" is unrecognized by the lookalike table, kept verbatim,
  // and equals the pinned true family exactly (no suffix needed).
  { id: 'basecamp', role: 'heading', classification: 'kept' },
  { id: 'basecamp', role: 'body', classification: 'kept' },
  // basecamp mono: no mono observed -> DEFAULT JetBrains Mono, an accepted
  // lookalike for the pinned true "Berkeley Mono" (finding #3: was missing).
  { id: 'basecamp', role: 'mono', classification: 'lookalike' },
];

describe('ROLE_CALIBRATION completeness (finding #3 — mirrors ACCENT_CALIBRATION\'s completeness lock)', () => {
  it('covers exactly the 12 real v1 corpus sites (no missing, no orphans)', () => {
    const ids = [...new Set(ROLE_CALIBRATION.map((c) => c.id))].sort();
    expect(ids).toEqual([...ALL_12_REAL_SITES].sort());
  });

  it('covers heading + body for every one of the 12 sites', () => {
    for (const id of ALL_12_REAL_SITES) {
      const roles = new Set(ROLE_CALIBRATION.filter((c) => c.id === id).map((c) => c.role));
      expect(roles.has('heading'), `${id} heading`).toBe(true);
      expect(roles.has('body'), `${id} body`).toBe(true);
    }
  });

  it('covers mono for exactly the 6 sites that pin a non-null mono (no missing, no orphans)', () => {
    const monoIds = new Set(ROLE_CALIBRATION.filter((c) => c.role === 'mono').map((c) => c.id));
    expect(monoIds).toEqual(MONO_PINNED_SITES);
    // Cross-check against the truth files themselves, not just our own list.
    for (const id of ALL_12_REAL_SITES) {
      const truth = readTruth(id);
      expect(truth.pinned.fonts.mono !== null, `${id} pinned mono non-null`).toBe(
        MONO_PINNED_SITES.has(id),
      );
    }
  });
});

describe.each(ROLE_CALIBRATION)(
  'scoreFontRoleFidelity — calibration lock: $id/$role -> $classification',
  ({ id, role, classification }) => {
    it(`${id}/${role} classifies as ${classification}`, () => {
      const proposal = realProposal(id);
      const truth = readTruth(id);
      const pinned = truth.pinned.fonts[role];
      expect(pinned, `${id}'s pinned.fonts.${role} must not be null for this anchor`).not.toBeNull();
      const result = scoreFontRoleFidelity(role, proposal[role], pinned!);
      expect(result.classification, `${id}/${role}`).toBe(classification);
    });
  },
);

// ---------------------------------------------------------------------------
// Composite scoreFontFidelity — pass/fail rollup
// ---------------------------------------------------------------------------

describe('scoreFontFidelity — composite pass/fail rollup', () => {
  it('stripe: every scored role avoids silently-wrong -> composite passes', () => {
    const proposal = realProposal('stripe');
    const truth = readTruth('stripe');
    const result = scoreFontFidelity(proposal, truth);
    expect(result.scoredRoles).toEqual(['heading', 'body', 'mono']);
    expect(result.silentlyWrongRoles).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it('medium: at least one scored role is silently-wrong -> composite fails', () => {
    const proposal = realProposal('medium');
    const truth = readTruth('medium');
    const result = scoreFontFidelity(proposal, truth);
    expect(result.silentlyWrongRoles.length).toBeGreaterThan(0);
    expect(result.pass).toBe(false);
  });

  it('kurzgesagt: mono is skipped (null pin), and heading + body are honestly "kept" post-fix -> composite PASSES (finding #2 — this used to be a false fail before the weight-suffix fix)', () => {
    const proposal = realProposal('kurzgesagt');
    const truth = readTruth('kurzgesagt');
    expect(truth.pinned.fonts.mono).toBeNull();
    const result = scoreFontFidelity(proposal, truth);
    expect(result.mono).toBeNull();
    expect(result.scoredRoles).toEqual(['heading', 'body']);
    expect(result.silentlyWrongRoles).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it('nytimes: mono is skipped (null pin) and both scored roles are genuine misses -> composite fails, scoredRoles excludes mono', () => {
    const proposal = realProposal('nytimes');
    const truth = readTruth('nytimes');
    expect(truth.pinned.fonts.mono).toBeNull();
    const result = scoreFontFidelity(proposal, truth);
    expect(result.mono).toBeNull();
    expect(result.scoredRoles).toEqual(['heading', 'body']);
    expect(result.silentlyWrongRoles).toEqual(['heading', 'body']);
    expect(result.pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// REQUIRED REGRESSION GUARD — vacuous pass (finding #4)
// ---------------------------------------------------------------------------
//
// scoreFontFidelity must NOT report pass:true for a truth that was never
// scored at all. JS's `[].every(...)` is vacuously true, so a naive
// `scoredRoles.every(...)` composite would silently PASS every one of the 8
// czg controls (permanently `status: 'scaffolded'`, all-null pinned fonts) —
// exactly the false-green a corpus-wide Step 10 run must never produce.

describe('scoreFontFidelity — REQUIRED regression guard: an unpinned/all-null truth does NOT vacuously pass', () => {
  it('czg-031 (status "scaffolded", pinned.fonts all null) is NOT scored and does NOT pass', () => {
    const truth = readTruth('czg-031');
    expect(truth.status).toBe('scaffolded'); // sanity on the fixture itself
    expect(truth.pinned.fonts).toEqual({ heading: null, body: null, mono: null });

    // Proposal content is irrelevant here — even a real, well-formed proposal
    // must not be scored against an unfrozen truth. Use czg-031's own real
    // fixture so this isn't a strawman either.
    const proposal = realProposal('czg-031');
    const result = scoreFontFidelity(proposal, truth);

    expect(result.heading).toBeNull();
    expect(result.body).toBeNull();
    expect(result.mono).toBeNull();
    expect(result.scoredRoles).toEqual([]);
    expect(result.silentlyWrongRoles).toEqual([]);
    expect(result.pass).toBe(false); // NEVER a vacuous true
  });

  it('the same guard fires for a status !== "pinned" truth even if pinned.fonts happens to carry non-null values (defense in depth)', () => {
    // Constructed: a status:'scaffolded' truth that (hypothetically, contrary
    // to the normal invariant) already has non-null pinned fonts filled in —
    // e.g. a hand-edit made before flipping status to 'pinned'. This must
    // still be treated as unfrozen/untrustworthy and skipped entirely, not
    // read from `pinned.fonts` at all.
    const realTruth = readTruth('stripe');
    const notYetPinned: TruthTemplate = { ...realTruth, status: 'scaffolded' };
    const proposal = realProposal('stripe');

    const result = scoreFontFidelity(proposal, notYetPinned);

    expect(result.scoredRoles).toEqual([]);
    expect(result.pass).toBe(false);
  });
});
