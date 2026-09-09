/**
 * Brand-Fidelity Benchmark — corpus manifest schema + loader.
 *
 * This is the manifest layer ONLY (Brand-Fidelity plan §5, Step 1). It defines
 * the benchmark corpus as validated pure data: a list of sites/controls, each
 * tagged with an 8-axis palette coordinate, a control/real flag, a v1/later
 * tier, and a held-out flag. Ground-truth pinning and scoring arrive in later
 * steps — nothing here reads pixels, extracts, or scores; it is additive
 * pure-data + Zod schema + a throwing loader, importable in-process by the
 * later scorer code under `src/eval/`.
 *
 * The corpus data lives alongside this module in `corpus.json`. `loadCorpus()`
 * reads that file and parses it through `corpusManifestSchema`, which THROWS
 * (ZodError) on any invalid entry — the loader never returns unvalidated data.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Slider axes — the 8-dimensional palette coordinate
// ---------------------------------------------------------------------------

/** A unit-interval coordinate: a real number in [0, 1] inclusive. */
const unitInterval = z
  .number()
  .min(0, { message: 'slider coordinate must be >= 0' })
  .max(1, { message: 'slider coordinate must be <= 1' });

/**
 * The 8 palette-space axes each corpus entry is tagged with. Defined
 * EXPLICITLY as a named object (not a bare 8-tuple) so every axis is
 * self-documenting. Each is a best-estimate coordinate in [0, 1]; together
 * they place a brand's palette in an 8-D space so the fidelity report can
 * surface *which regions of that space* the extractor is systematically weak
 * in. The axes are intentionally palette-descriptive (not extractor outputs)
 * so they cannot be gamed by a future tune-loop.
 */
export const sliderCoordsSchema = z
  .object({
    /** Colour temperature. 0 = cool (blue/violet dominant), 1 = warm (red/orange/yellow dominant). */
    warmth: unitInterval,
    /** Overall chroma intensity of the palette. 0 = muted/greyed, 1 = fully saturated/vivid. */
    saturation: unitInterval,
    /** Overall lightness of the dominant surfaces. 0 = dark background, 1 = light/white background. */
    lightness: unitInterval,
    /** Foreground/background luminance separation. 0 = low contrast, 1 = high (e.g. black on white). */
    contrast: unitInterval,
    /** Spread of distinct hues in the palette. 0 = monochrome/single-hue, 1 = many hues (rainbow). */
    hueDiversity: unitInterval,
    /** How strongly a single accent colour dominates. 0 = no dominant accent, 1 = one strong signature accent. */
    accentDominance: unitInterval,
    /** Fraction of the palette that is neutral/greyscale chrome. 0 = all colourful, 1 = mostly neutral. */
    neutralRatio: unitInterval,
    /** Perceived energy/liveliness of the palette. 0 = subdued/restrained, 1 = energetic/punchy. */
    vibrancy: unitInterval,
  })
  .strict();

/**
 * Ordered list of the 8 slider-axis names, for iteration by downstream code
 * (e.g. the slider-coverage rollup). Kept in sync with `sliderCoordsSchema`:
 * `satisfies` fails the typecheck if a name drifts from the schema keys.
 */
export const SLIDER_AXES = [
  'warmth',
  'saturation',
  'lightness',
  'contrast',
  'hueDiversity',
  'accentDominance',
  'neutralRatio',
  'vibrancy',
] as const satisfies readonly (keyof SliderCoords)[];

// ---------------------------------------------------------------------------
// Corpus entry
// ---------------------------------------------------------------------------

/**
 * Archetype tag — a short brand category. Closed set (the corpus is fully
 * curated) so a typo fails validation rather than silently creating a new
 * one-member cohort. `control-czg` is reserved for the csszengarden controls.
 */
export const archetypeSchema = z.enum([
  'fintech',
  'developer-tool',
  'saas',
  'media',
  'consumer',
  'ecommerce',
  'luxury',
  'education',
  'control-czg',
]);

/** Corpus tier: `v1` = the shipping smoke-test set; `later` = staged growth candidates. */
export const tierSchema = z.enum(['v1', 'later']);

/**
 * A URL or fixture reference. Real sites use http(s); synthetic local control
 * skins use a `fixture://<id>` scheme (no live site exists for them).
 */
const corpusUrlSchema = z
  .string()
  .min(1)
  .refine((v) => /^(?:https?|fixture):\/\//.test(v), {
    message: "expected an http(s):// URL or a fixture://<id> reference",
  });

/**
 * One corpus entry. `.strict()` so an unknown key (a typo'd field) is a
 * validation error rather than silently-dropped data.
 */
export const corpusEntrySchema = z
  .object({
    /**
     * Stable, unique slug for this entry. This doubles as the on-disk filename
     * stem for later steps (Step 2 writes `<id>.raw-extraction.json`, Step 3-prep
     * writes `<id>.truth.json`), so it is constrained to a filename-safe charset:
     * lowercase alphanumerics and hyphens, starting with an alphanumeric. A path
     * separator or other unsafe char here would break those steps.
     */
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, {
        message: 'id must be filename-safe: lowercase alphanumerics + hyphens, starting alphanumeric',
      }),
    /** Source URL (real site) or `fixture://` reference (synthetic control skin). */
    url: corpusUrlSchema,
    /** Brand category (see archetypeSchema). */
    archetype: archetypeSchema,
    /** 8-axis palette coordinate (all axes required). */
    sliderCoords: sliderCoordsSchema,
    /** True for csszengarden controls (weighted <0.5x real sites in the rollup). */
    isControl: z.boolean(),
    /** `v1` (shipping set) or `later` (staged growth). */
    tier: tierSchema,
    /** Reserved from a future tune-loop's logs (frozen held-out split). */
    heldOut: z.boolean(),
  })
  .strict();

/**
 * The full corpus manifest. A wrapper object (not a bare array) so a
 * `schemaVersion` can gate future shape migrations. `entries` ids must be
 * unique — a duplicate is a validation error.
 */
export const corpusManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(corpusEntrySchema).superRefine((entries, ctx) => {
      const seen = new Set<string>();
      for (const [i, entry] of entries.entries()) {
        if (seen.has(entry.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate corpus id "${entry.id}"`,
            path: [i, 'id'],
          });
        }
        seen.add(entry.id);
      }
    }),
  })
  .strict();

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type SliderCoords = z.infer<typeof sliderCoordsSchema>;
export type SliderAxis = keyof SliderCoords;
export type Archetype = z.infer<typeof archetypeSchema>;
export type CorpusTier = z.infer<typeof tierSchema>;
export type CorpusEntry = z.infer<typeof corpusEntrySchema>;
export type CorpusManifest = z.infer<typeof corpusManifestSchema>;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** Absolute path to the committed corpus data, resolved relative to this module. */
export const CORPUS_JSON_PATH = fileURLToPath(new URL('./corpus.json', import.meta.url));

/**
 * Validate an already-parsed value as a corpus manifest.
 *
 * Pure (no I/O): runs `raw` through `corpusManifestSchema.parse`, which THROWS
 * a `ZodError` on any invalid entry. The returned manifest is always fully
 * validated — this helper never returns unvalidated data. `loadCorpus` is a
 * thin file-reading wrapper over this, so the throw-on-invalid contract is
 * testable without touching the filesystem.
 */
export function parseCorpus(raw: unknown): CorpusManifest {
  return corpusManifestSchema.parse(raw);
}

/**
 * Read and validate the benchmark corpus manifest.
 *
 * Reads the corpus JSON at `path` (default: the committed `corpus.json`),
 * parses the JSON, and validates it via {@link parseCorpus}. THROWS a
 * `ZodError` if any entry is invalid (or a `SyntaxError` if the file is not
 * valid JSON) — the returned manifest is always fully validated (this function
 * never returns unvalidated data). The optional `path` exists so the loader's
 * failure path is exercisable against a malformed fixture in tests.
 */
export function loadCorpus(path: string = CORPUS_JSON_PATH): CorpusManifest {
  const raw = readFileSync(path, 'utf8');
  const data: unknown = JSON.parse(raw);
  return parseCorpus(data);
}
