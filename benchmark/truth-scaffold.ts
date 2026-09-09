/**
 * Brand-Fidelity Benchmark — ground-truth scaffolder (plan §5/§7, Step 3-prep, #31).
 *
 * PURPOSE. For every v1 corpus site this reads the committed hermetic replay
 * fixture (`<id>.raw-extraction.json`), DERIVES the extractor's *guessed* brand
 * roles from its raw role evidence, and emits a per-site truth-annotation
 * TEMPLATE (`docs/findings/eval-truth/<id>.truth.json`) pre-filled with those
 * guesses plus EMPTY gold-hex fields — so the operator (Step 3, #32) only
 * *adjusts* the pinned roles + fills the published gold-hex rather than authoring
 * from scratch.
 *
 * FROZEN-GROUND-TRUTH CONTRACT (plan §6 "Freeze human-pinned roles; don't trust
 * extractor `roles`"). The `extractorGuess` block is *extractor output* — a
 * STARTING POINT only. The operator's edits live in `pinned` + `goldHex`, which
 * become the frozen ground truth the scorer reads. Scoring must never read
 * `extractorGuess`; that would be circular/gameable. This module only produces
 * the starting template — it derives, it never scores.
 *
 * `pinned` carries per-role PROVENANCE (`source` + `confidence`) and the true
 * fonts (`pinned.fonts.{heading,body,mono}`), because font-fidelity (Step 6) has
 * no other frozen anchor — scoring a font against the extractor's own font read
 * is the same circularity §6 bans for colour. The scaffolder seeds colour hexes
 * with `source:scaffold-guess`; the schema `superRefine` REJECTS a `pinned`
 * template that still holds any `scaffold-guess` source, so extractor output can
 * never be frozen as truth by rubber-stamp (the rule is enforced, not just
 * documented).
 *
 * IDEMPOTENCY. Re-running the scaffolder MUST NOT clobber the operator's Step-3
 * work: an existing truth file is left untouched if it has been pinned
 * (`status: "pinned"`) OR otherwise differs from a fresh scaffold, unless
 * `force: true` is passed. See {@link scaffoldAllTruth}.
 *
 * Types (`RawExtraction`, `ColorCluster`, `ColorRole`, `COLOR_ROLES`) are imported
 * from the extraction adapter — the ONE source of truth for the extraction shape;
 * this module never re-declares them. Colour lightness/chroma comes from
 * colorjs.io (the plan's vendored colour-science dep), never re-derived.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Color from 'colorjs.io';
import { z } from 'zod';
import {
  COLOR_ROLES,
  type ColorCluster,
  type ColorRole,
  type RawExtraction,
} from '../src/extract/engine/adapter.ts';
import {
  archetypeSchema,
  loadCorpus,
  sliderCoordsSchema,
  type CorpusEntry,
} from './corpus.ts';

// ---------------------------------------------------------------------------
// Truth-template schema (the persisted shape later scorer steps validate against)
// ---------------------------------------------------------------------------

/** An sRGB hex string: `#rrggbb` or `#rrggbbaa` (matches the extraction fixtures). */
const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/, {
  message: 'expected an #rrggbb or #rrggbbaa hex string',
});

/** ColorRole as a Zod enum, built from the adapter's single source of truth. */
const colorRoleSchema = z.enum([...COLOR_ROLES] as [ColorRole, ...ColorRole[]]);

/** The extractor's derived accent guess + how it was reached (guess confidence). */
const guessAccentSchema = z
  .object({
    hex: hexColorSchema,
    /** The accent-role evidence count backing this guess (0 when a fallback picked it). */
    evidenceCount: z.number().int().nonnegative(),
    /**
     * Which rule picked the accent:
     *  - `accent-role`: a cluster carried `accent` role evidence (the strong case).
     *  - `saturated-fallback`: no accent evidence anywhere → most-saturated cluster.
     *  - `frequency-fallback`: no saturated cluster either → highest-frequency cluster.
     */
    source: z.enum(['accent-role', 'saturated-fallback', 'frequency-fallback']),
  })
  .strict();

/** A derived background guess: the cluster hex + its usage frequency + OKLCH lightness. */
const guessBackgroundSchema = z
  .object({
    hex: hexColorSchema,
    frequency: z.number().nonnegative(),
    /** OKLCH lightness 0..1 (rounded), the axis used to split light vs dark. */
    lightness: z.number(),
  })
  .strict();

/** A top-frequency cluster, for operator context (not scored). */
const topClusterSchema = z
  .object({
    hex: hexColorSchema,
    frequency: z.number().nonnegative(),
    /** The cluster's dominant observed role (highest count), or null if role-less. */
    dominantRole: colorRoleSchema.nullable(),
  })
  .strict();

/**
 * Provenance of a pinned value: HOW the operator sourced it. `scaffold-guess` is
 * the sentinel the scaffolder writes for a value still equal to the extractor's
 * derived guess — NOT independently sourced. The template `superRefine` forbids
 * `scaffold-guess` on any role once `status` is `pinned`, so a pinned template
 * can never freeze extractor output as ground truth (the §6 anti-circularity
 * rule, structurally ENFORCED rather than merely documented). Every other value
 * names a real, extractor-independent source.
 */
const pinnedSourceSchema = z.enum([
  'scaffold-guess',
  'official-brand-guide',
  'official-press-kit',
  'official-site-css',
  'reputable-aggregator',
  'monochrome-brand',
  'live-site-observed',
  'operator-judgment',
]);

/** Operator's confidence in a pinned value — lets Step 5 down-weight weak pins. */
const confidenceSchema = z.enum(['high', 'medium', 'low']);

/** A pinned colour role: the frozen hex + its independent provenance. */
const pinnedColorSchema = z
  .object({ hex: hexColorSchema, source: pinnedSourceSchema, confidence: confidenceSchema })
  .strict();

/**
 * A pinned font role: the site's TRUE family + acceptable free lookalikes +
 * provenance. Font-fidelity (Step 6) has no other frozen anchor — its only
 * alternative reference is the extractor's own font read, which is the exact
 * circularity §6 pins colour to avoid, so the true font is human-pinned here.
 * `lookalikes` is what lets the scorer separate an acceptable substitute
 * (`lookalike`) from a `silently-wrong` pick.
 */
const pinnedFontSchema = z
  .object({
    family: z.string().min(1),
    lookalikes: z.array(z.string()),
    source: pinnedSourceSchema,
    confidence: confidenceSchema,
  })
  .strict();

/**
 * A pinned SECONDARY accent — a real brand colour beyond the single primary
 * `accent` (Stripe's gradient orange/pink, imprintgenius's illustration magenta,
 * a polychromatic brand's palette). CAPTURED now so the frozen truth isn't lossy
 * for multi-accent brands, but NOT read by the v1 scorers — secondary-accent
 * recall arrives with the gated tune-loop (the deliberate "capture-now,
 * score-later" split, so freezing here avoids a re-annotation pass and pre-closes
 * the single-accent Goodhart hazard). `label` is a short human tag ("gradient
 * orange", "illustration magenta").
 */
const pinnedSecondarySchema = z
  .object({
    hex: hexColorSchema,
    label: z.string().min(1),
    source: pinnedSourceSchema,
    confidence: confidenceSchema,
  })
  .strict();

/**
 * One per-site ground-truth template. `.strict()` so a typo'd field fails
 * validation rather than silently persisting. A `superRefine` enforces the
 * control/gold-hex invariant (controls have no published gold-hex).
 */
export const truthTemplateSchema = z
  .object({
    /** Corpus id (filename stem). */
    id: z.string().min(1),
    /** Source URL or `fixture://` reference (copied from the corpus). */
    url: z.string().min(1),
    /** Brand archetype (copied from the corpus; reuses the corpus enum). */
    archetype: archetypeSchema,
    /** The 8-axis slider coordinate (copied from the corpus). */
    sliderTags: sliderCoordsSchema,
    /** True for csszengarden controls (no published brand gold-hex). */
    isControl: z.boolean(),
    /**
     * The operator's judgment that this brand uses MULTIPLE signature accents
     * (Stripe, imprintgenius, Duolingo, kurzgesagt) — so a single-accent score is
     * "primary correct" but not full fidelity. MAY be true with an empty
     * `pinned.secondaryAccents` ("known multi-accent, secondaries not yet
     * captured"). Derived reports read this to separate single-seed-correct from
     * single-seed-lossy; the v1 scorers do not score the secondaries themselves.
     */
    isMultiAccent: z.boolean(),
    /**
     * The DERIVED extractor guess. A STARTING POINT the operator corrects — the
     * scorer must never read this (plan §6: don't trust extractor roles).
     */
    extractorGuess: z
      .object({
        accent: guessAccentSchema,
        backgroundLight: guessBackgroundSchema,
        backgroundDark: guessBackgroundSchema.nullable(),
        topClusters: z.array(topClusterSchema),
      })
      .strict(),
    /**
     * The operator-editable ground truth. The scaffolder seeds the colour hexes
     * from the extractor guess (a STARTING POINT, tagged `source:scaffold-guess`)
     * and leaves fonts null; Step 3 replaces each with an independently-sourced
     * pin (real `source` + `confidence`). This (+ `goldHex`) is what the scorer
     * reads once frozen. `backgroundLight` is nullable so a dark-first brand
     * (spotify/linear/robinhood) is not forced to invent a light surface, and a
     * light-only brand pins `backgroundDark: null`.
     */
    pinned: z
      .object({
        accent: pinnedColorSchema,
        backgroundLight: pinnedColorSchema.nullable(),
        backgroundDark: pinnedColorSchema.nullable(),
        fonts: z
          .object({
            heading: pinnedFontSchema.nullable(),
            body: pinnedFontSchema.nullable(),
            mono: pinnedFontSchema.nullable(),
          })
          .strict(),
        /**
         * Additional signature brand accents beyond `accent` (empty `[]` for
         * single-accent brands). Captured now, NOT scored in v1 — see
         * `pinnedSecondarySchema`.
         */
        secondaryAccents: z.array(pinnedSecondarySchema),
      })
      .strict(),
    /**
     * The site's published brand-guide hex. `""` (empty) for real sites until
     * the operator fills it; `null` for controls (which have none — see
     * `goldHexNote`).
     */
    goldHex: z.string().nullable(),
    /** Present only for controls: why there is no gold-hex. */
    goldHexNote: z.string().optional(),
    /** `scaffolded` (fresh) → operator flips to `pinned` after eyeballing. */
    status: z.enum(['scaffolded', 'pinned']),
    /** Free-form operator remarks. */
    notes: z.string(),
    /** Provenance (deterministic — no wall-clock timestamp). */
    _generated: z
      .object({
        scaffolder: z.string(),
        corpusId: z.string(),
        fromFixture: z.string(),
        note: z.string(),
      })
      .strict(),
  })
  .strict()
  .superRefine((t, ctx) => {
    // Controls have no published gold-hex → goldHex must be null + carry a note.
    // Real sites carry a (possibly-empty) string gold-hex and no note.
    if (t.isControl) {
      if (t.goldHex !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['goldHex'],
          message: 'a control must have goldHex: null (controls have no published gold-hex)',
        });
      }
      if (t.goldHexNote === undefined || t.goldHexNote.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['goldHexNote'],
          message: 'a control must carry a non-empty goldHexNote explaining the absence',
        });
      }
    } else if (typeof t.goldHex !== 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['goldHex'],
        message: 'a real site must have a string goldHex ("" until the operator pins it)',
      });
    }

    // Pinned-template invariants (the §6 anti-circularity rule, enforced): once
    // an operator flips `status` to `pinned`, no role may still carry the
    // scaffold's extractor guess — every pinned value must name an independent
    // source. Real sites must carry a non-empty published gold-hex, and the body
    // font must be pinned (font-fidelity has no other frozen anchor). Scaffolded
    // templates are exempt (they legitimately still hold the guess).
    if (t.status === 'pinned') {
      const roles: readonly [string[], { source: string } | null][] = [
        [['pinned', 'accent'], t.pinned.accent],
        [['pinned', 'backgroundLight'], t.pinned.backgroundLight],
        [['pinned', 'backgroundDark'], t.pinned.backgroundDark],
        [['pinned', 'fonts', 'heading'], t.pinned.fonts.heading],
        [['pinned', 'fonts', 'body'], t.pinned.fonts.body],
        [['pinned', 'fonts', 'mono'], t.pinned.fonts.mono],
      ];
      for (const [path, role] of roles) {
        if (role && role.source === 'scaffold-guess') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'source'],
            message: `pinned template: ${path.join('.')} is still 'scaffold-guess' — pin it from an independent source (§6 anti-circularity)`,
          });
        }
      }
      // Secondary accents (if any) are independently sourced too — the scaffolder
      // never writes one, so a scaffold-guess here would be an authoring error.
      t.pinned.secondaryAccents.forEach((s, i) => {
        if (s.source === 'scaffold-guess') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['pinned', 'secondaryAccents', i, 'source'],
            message: `pinned template: secondary accent #${i} is 'scaffold-guess' — pin it from an independent source`,
          });
        }
      });
      if (t.pinned.fonts.body === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pinned', 'fonts', 'body'],
          message: 'a pinned template must pin at least the body font (font-fidelity has no other frozen anchor)',
        });
      }
      if (!t.isControl && (typeof t.goldHex !== 'string' || t.goldHex.length === 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['goldHex'],
          message: 'a pinned real site must carry a non-empty goldHex (the independent published-brand anchor)',
        });
      }
    }
  });

export type TruthTemplate = z.infer<typeof truthTemplateSchema>;

// ---------------------------------------------------------------------------
// Derivation helpers (small + documented; colour science via colorjs.io)
// ---------------------------------------------------------------------------

/** OKLCH lightness + chroma of a hex, or undefined if colorjs.io can't parse it. */
function oklch(hex: string): { l: number; c: number } | undefined {
  try {
    const coords = new Color(hex).to('oklch').coords; // [L, C, H]
    return { l: coords[0] ?? 0, c: coords[1] ?? 0 };
  } catch {
    return undefined;
  }
}

/** Round to 4 decimals so persisted lightness is stable + diff-legible. */
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Total `accent`-role evidence count for a cluster (0 if none). */
function accentCount(cluster: ColorCluster): number {
  return cluster.roles
    .filter((r) => r.role === 'accent')
    .reduce((sum, r) => sum + r.count, 0);
}

/** The cluster's dominant role (highest positive count), or undefined if role-less. */
function dominantRole(cluster: ColorCluster): ColorRole | undefined {
  let bestRole: ColorRole | undefined;
  let bestCount = 0;
  for (const r of cluster.roles) {
    if (r.count > bestCount) {
      bestCount = r.count;
      bestRole = r.role;
    }
  }
  return bestRole;
}

/**
 * OKLCH chroma below which a colour is treated as near-neutral chrome
 * (`#fff`/`#000`/greys) — used by the accent fallback so a matched background is
 * never guessed as the accent (the plan's role-agnostic saturated cross-check).
 * Exported (additive; only other reader is `deriveAccent` below) so
 * `src/eval/color-fidelity.ts`'s role-agnostic saturated-top-K scorer reuses
 * the SAME near-neutral-chrome definition rather than re-declaring it
 * (code-quality.md "one source of truth for data-shape constants").
 */
export const NEAR_NEUTRAL_CHROMA_MAX = 0.04;

/** OKLCH lightness at/above which a surface is treated as a LIGHT background. */
const LIGHT_BACKGROUND_MIN = 0.5;

/**
 * Derive the accent guess. Primary rule: the cluster with the most `accent`-role
 * evidence. Fallbacks (documented, deterministic) keep the guess non-empty for
 * every site: most-saturated cluster, then highest-frequency cluster.
 */
function deriveAccent(colors: readonly ColorCluster[]): TruthTemplate['extractorGuess']['accent'] {
  if (colors.length === 0) throw new Error('cannot derive an accent from an empty colour list');

  // Primary: max accent-role count. Ties → higher frequency → lex- smaller hex.
  const withAccent = colors.filter((c) => accentCount(c) > 0);
  if (withAccent.length > 0) {
    const best = withAccent.reduce((a, b) => {
      const ca = accentCount(a);
      const cb = accentCount(b);
      if (cb !== ca) return cb > ca ? b : a;
      if (b.frequency !== a.frequency) return b.frequency > a.frequency ? b : a;
      return b.hex < a.hex ? b : a;
    });
    return { hex: best.hex, evidenceCount: accentCount(best), source: 'accent-role' };
  }

  // Fallback 1: no accent evidence anywhere → most-saturated non-neutral cluster
  // (highest chroma; ties → higher frequency → smaller hex).
  const saturated = colors
    .map((c) => ({ c, o: oklch(c.hex) }))
    .filter((x): x is { c: ColorCluster; o: { l: number; c: number } } =>
      x.o !== undefined && x.o.c >= NEAR_NEUTRAL_CHROMA_MAX,
    );
  if (saturated.length > 0) {
    const best = saturated.reduce((a, b) => {
      if (b.o.c !== a.o.c) return b.o.c > a.o.c ? b : a;
      if (b.c.frequency !== a.c.frequency) return b.c.frequency > a.c.frequency ? b : a;
      return b.c.hex < a.c.hex ? b : a;
    });
    return { hex: best.c.hex, evidenceCount: 0, source: 'saturated-fallback' };
  }

  // Fallback 2: everything is neutral → highest-frequency cluster overall.
  const best = colors.reduce((a, b) => {
    if (b.frequency !== a.frequency) return b.frequency > a.frequency ? b : a;
    return b.hex < a.hex ? b : a;
  });
  return { hex: best.hex, evidenceCount: 0, source: 'frequency-fallback' };
}

type BackgroundGuess = z.infer<typeof guessBackgroundSchema>;

function toBackgroundGuess(cluster: ColorCluster, lightness: number): BackgroundGuess {
  return { hex: cluster.hex, frequency: cluster.frequency, lightness: round4(lightness) };
}

/**
 * Derive light + dark background guesses.
 *  - light = highest-frequency background-dominant cluster with lightness ≥ 0.5;
 *    if a site has no light background-dominant cluster, the lightest background
 *    cluster (a dark site's lightest surface); if no background-dominant cluster
 *    at all, the lightest of the top-frequency clusters (untagged chrome).
 *  - dark = the darkest background-dominant cluster with lightness < 0.5, or null.
 * These are STARTING guesses; a dark-only site may guess light≈dark for the
 * operator to correct.
 */
export function deriveBackgrounds(colors: readonly ColorCluster[]): {
  backgroundLight: BackgroundGuess;
  backgroundDark: BackgroundGuess | null;
} {
  if (colors.length === 0) throw new Error('cannot derive backgrounds from an empty colour list');

  const withLightness = colors
    .map((c) => ({ c, o: oklch(c.hex) }))
    .filter((x): x is { c: ColorCluster; o: { l: number; c: number } } => x.o !== undefined);

  const bgClusters = withLightness.filter((x) => dominantRole(x.c) === 'background');

  // --- light background ---
  const lightBg = bgClusters.filter((x) => x.o.l >= LIGHT_BACKGROUND_MIN);
  let backgroundLight: BackgroundGuess;
  if (lightBg.length > 0) {
    // Highest frequency; ties → lighter → smaller hex.
    const best = lightBg.reduce((a, b) => {
      if (b.c.frequency !== a.c.frequency) return b.c.frequency > a.c.frequency ? b : a;
      if (b.o.l !== a.o.l) return b.o.l > a.o.l ? b : a;
      return b.c.hex < a.c.hex ? b : a;
    });
    backgroundLight = toBackgroundGuess(best.c, best.o.l);
  } else if (bgClusters.length > 0) {
    // No light background-dominant cluster → lightest background cluster.
    const best = bgClusters.reduce((a, b) => (b.o.l > a.o.l ? b : b.o.l < a.o.l ? a : b.c.hex < a.c.hex ? b : a));
    backgroundLight = toBackgroundGuess(best.c, best.o.l);
  } else if (withLightness.length > 0) {
    // No background-dominant cluster at all → lightest of the top-8 by frequency.
    const topByFreq = [...withLightness]
      .sort((a, b) => (b.c.frequency !== a.c.frequency ? b.c.frequency - a.c.frequency : a.c.hex < b.c.hex ? -1 : 1))
      .slice(0, 8);
    const best = topByFreq.reduce((a, b) => (b.o.l > a.o.l ? b : b.o.l < a.o.l ? a : b.c.hex < a.c.hex ? b : a));
    backgroundLight = toBackgroundGuess(best.c, best.o.l);
  } else {
    // Deepest fallback: NOT ONE cluster hex parsed as OKLCH (every hex is an
    // unresolved CSS var / "transparent" / malformed), so `withLightness` — and
    // hence every OKLCH-derived pool above — is empty. Mirror deriveAccent's
    // Fallback 2 (the immune pattern): pick the highest-frequency RAW cluster
    // and record lightness 0 (the documented neutral default, since no OKLCH
    // lightness exists). `colors` is guaranteed non-empty by the guard at the
    // top of this function, so this reduce never sees an empty array — this is
    // the branch that replaces the former empty-pool `Reduce of empty array`
    // crash.
    const best = colors.reduce((a, b) => {
      if (b.frequency !== a.frequency) return b.frequency > a.frequency ? b : a;
      return b.hex < a.hex ? b : a;
    });
    backgroundLight = toBackgroundGuess(best, 0);
  }

  // --- dark background ---
  const darkBg = bgClusters.filter((x) => x.o.l < LIGHT_BACKGROUND_MIN);
  let backgroundDark: BackgroundGuess | null = null;
  if (darkBg.length > 0) {
    // Darkest; ties → higher frequency → smaller hex.
    const best = darkBg.reduce((a, b) => {
      if (b.o.l !== a.o.l) return b.o.l < a.o.l ? b : a;
      if (b.c.frequency !== a.c.frequency) return b.c.frequency > a.c.frequency ? b : a;
      return b.c.hex < a.c.hex ? b : a;
    });
    backgroundDark = toBackgroundGuess(best.c, best.o.l);
  }

  return { backgroundLight, backgroundDark };
}

/** Top-N clusters by frequency (ties → smaller hex), with their dominant role. */
function deriveTopClusters(
  colors: readonly ColorCluster[],
  n = 6,
): TruthTemplate['extractorGuess']['topClusters'] {
  return [...colors]
    .sort((a, b) => (b.frequency !== a.frequency ? b.frequency - a.frequency : a.hex < b.hex ? -1 : 1))
    .slice(0, n)
    .map((c) => ({ hex: c.hex, frequency: c.frequency, dominantRole: dominantRole(c) ?? null }));
}

// ---------------------------------------------------------------------------
// Template builder (pure)
// ---------------------------------------------------------------------------

const SCAFFOLDER_NAME = 'benchmark/truth-scaffold.ts';

function fixtureRelPath(id: string): string {
  return `docs/findings/eval-raw-extractions/benchmark/${id}.raw-extraction.json`;
}

/**
 * Build the per-site truth template from a corpus entry + its raw extraction.
 * PURE — no I/O. Derives the extractor guess, initialises `pinned` to that
 * guess, leaves `goldHex` empty (real) / null (control), status `scaffolded`.
 * Key order here is the canonical persisted order (kept stable so the committed
 * templates are a deterministic function of the fixture).
 */
export function buildTruthTemplate(entry: CorpusEntry, rawExtraction: RawExtraction): TruthTemplate {
  const colors = rawExtraction.colors;
  const accent = deriveAccent(colors);
  const { backgroundLight, backgroundDark } = deriveBackgrounds(colors);
  const topClusters = deriveTopClusters(colors);

  const template: TruthTemplate = {
    id: entry.id,
    url: entry.url,
    archetype: entry.archetype,
    sliderTags: entry.sliderCoords,
    isControl: entry.isControl,
    // Multi-accent is an operator judgment (default false); secondary accents are
    // captured in Step 3, never derived here.
    isMultiAccent: false,
    extractorGuess: { accent, backgroundLight, backgroundDark, topClusters },
    pinned: {
      // Colour hexes seed from the guess as a STARTING POINT (source
      // `scaffold-guess`); Step 3 replaces each with an independent source.
      // Fonts start null — the extractor's font read is too unreliable to seed
      // from (role labels are frequently `unknown`), so the operator pins the
      // researched true font from scratch.
      accent: { hex: accent.hex, source: 'scaffold-guess', confidence: 'low' },
      backgroundLight: { hex: backgroundLight.hex, source: 'scaffold-guess', confidence: 'low' },
      backgroundDark: backgroundDark
        ? { hex: backgroundDark.hex, source: 'scaffold-guess', confidence: 'low' }
        : null,
      fonts: { heading: null, body: null, mono: null },
      secondaryAccents: [],
    },
    goldHex: entry.isControl ? null : '',
    ...(entry.isControl
      ? {
          goldHexNote:
            'csszengarden control: identical DOM across skins, no published brand gold-hex. Scored as a control (weighted <0.5x real sites), never against a gold anchor.',
        }
      : {}),
    status: 'scaffolded',
    notes: '',
    _generated: {
      scaffolder: SCAFFOLDER_NAME,
      corpusId: entry.id,
      fromFixture: fixtureRelPath(entry.id),
      note:
        'Scaffolded template. `extractorGuess` is a STARTING POINT (extractor output, not ground truth); `pinned` colour hexes seed from it with source `scaffold-guess`, and `pinned.fonts` start null. Operator (Step 3): replace each pinned role with an independently-sourced value (real `source` + `confidence`), pin the true fonts, fill `goldHex`, then set `status` to "pinned". A pinned template CANNOT keep any `scaffold-guess` source (schema-enforced §6 anti-circularity). Re-running the scaffolder will NOT overwrite a pinned or hand-edited file (see benchmark/truth-scaffold.ts).',
    },
  };

  // Self-check: a construction bug (wrong shape / broken control invariant)
  // throws here rather than persisting a malformed template.
  truthTemplateSchema.parse(template);
  return template;
}

// ---------------------------------------------------------------------------
// Scaffold runner (I/O + idempotency guard)
// ---------------------------------------------------------------------------

/** Default output dir for the committed templates, resolved from this module. */
export const TRUTH_OUT_DIR = fileURLToPath(new URL('../docs/findings/eval-truth/', import.meta.url));
/** Committed fixture dir (the hermetic replay inputs from Step 2). */
export const FIXTURE_DIR = fileURLToPath(
  new URL('../docs/findings/eval-raw-extractions/benchmark/', import.meta.url),
);

export interface ScaffoldOptions {
  /** Directory to write `<id>.truth.json` into (default: docs/findings/eval-truth/). */
  outDir?: string;
  /** Directory the `<id>.raw-extraction.json` fixtures live in (default: the committed set). */
  fixtureDir?: string;
  /** Overwrite pinned / hand-edited templates (default false: protect operator edits). */
  force?: boolean;
}

export interface ScaffoldResult {
  /** Ids whose template was written (created or force-overwritten). */
  written: string[];
  /** Ids whose existing template was left untouched (already pinned/edited, or unchanged). */
  skipped: string[];
}

/** Serialise a template deterministically (2-space, trailing newline, no BOM). */
function serialize(template: TruthTemplate): string {
  return `${JSON.stringify(template, null, 2)}\n`;
}

/**
 * Scaffold a truth template for every v1 corpus entry.
 *
 * IDEMPOTENCY (protects the operator's Step-3 edits): with `force` false (the
 * default), ANY already-existing template is left untouched and reported in
 * `skipped` — whether it is pinned, hand-edited, stale, or a byte-identical
 * pristine scaffold. This is the strongest guarantee: the default run can never
 * clobber operator work, and a re-run after the fixtures change is a deliberate
 * `force: true` action. `force: true` regenerates every template from the
 * current fixture. A brand-new (absent) file is always written.
 */
export function scaffoldAllTruth(options: ScaffoldOptions = {}): ScaffoldResult {
  const outDir = options.outDir ?? TRUTH_OUT_DIR;
  const fixtureDir = options.fixtureDir ?? FIXTURE_DIR;
  const force = options.force ?? false;

  mkdirSync(outDir, { recursive: true });

  const written: string[] = [];
  const skipped: string[] = [];

  const v1Entries = loadCorpus().entries.filter((e) => e.tier === 'v1');
  for (const entry of v1Entries) {
    const outPath = join(outDir, `${entry.id}.truth.json`);

    // Default mode never overwrites an existing template — protect Step-3 edits.
    if (existsSync(outPath) && !force) {
      skipped.push(entry.id);
      continue;
    }

    const fixturePath = join(fixtureDir, `${entry.id}.raw-extraction.json`);
    const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as RawExtraction;
    const template = buildTruthTemplate(entry, raw);
    writeFileSync(outPath, serialize(template), 'utf8');
    written.push(entry.id);
  }

  return { written, skipped };
}

// ---------------------------------------------------------------------------
// Runnable entry: `npx tsx benchmark/truth-scaffold.ts [--force]`
// ---------------------------------------------------------------------------

function main(): void {
  const force = process.argv.includes('--force');
  const { written, skipped } = scaffoldAllTruth({ force });
  console.log(
    `truth-scaffold: wrote ${written.length} template(s), skipped ${skipped.length}` +
      `${skipped.length ? ` (${skipped.join(', ')})` : ''}.`,
  );
  if (written.length) console.log(`  written: ${written.join(', ')}`);
  console.log(`  out dir: ${TRUTH_OUT_DIR}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
