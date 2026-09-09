/**
 * Font-stack fingerprint -> Google Fonts lookalike (plan.md §9.7, Step 10).
 *
 * Decision 7 ("Fonts: fingerprint, never copy"): copying a target site's
 * webfont files violates foundry EULAs, so `from-url` maps the OBSERVED stack
 * to a free Google Fonts lookalike and never ships the original. This module
 * owns the curated mapping table and the fingerprint lookup.
 *
 * License invariant: EVERY font this table maps TO is a Google Fonts family
 * distributed under the SIL Open Font License (OFL) — recorded per entry as a
 * `license` note and asserted table-wide by the tests. We never map to a
 * non-free family. When the observed family is ITSELF already free (Inter,
 * Roboto, Manrope, JetBrains Mono, ...), it is kept as-is (mapped to itself).
 *
 * Unknown stacks (no table hit) are NOT invented: the observed stack is kept
 * verbatim, extended with a system fallback chain, and flagged `mapped: false`
 * so the extraction report (Step 12) can surface "unmapped — kept observed
 * stack" rather than silently substituting a guess.
 */

import type { FontRole, FontStack } from './engine/adapter.ts';

/** License string shared by every Google Fonts target (the table invariant). */
export const OFL_LICENSE = 'SIL Open Font License 1.1 (OFL) — Google Fonts';

/** System fallback tails appended after the chosen family, per structural role. */
const SANS_FALLBACKS = ['Segoe UI', 'system-ui', 'sans-serif'];
const SERIF_FALLBACKS = ['Georgia', 'Cambria', 'serif'];
const MONO_FALLBACKS = ['Cascadia Code', 'Consolas', 'monospace'];

/** Which fallback tail a role gets; heading/body/unknown are all sans by default. */
function fallbacksFor(role: FontRole, family: string): string[] {
  if (role === 'mono' || isMonoFamily(family)) return MONO_FALLBACKS;
  if (isSerifFamily(family)) return SERIF_FALLBACKS;
  return SANS_FALLBACKS;
}

/**
 * One curated mapping entry. `match` is the set of normalized family
 * fingerprints (lower-cased, punctuation-stripped) that resolve to `family`.
 * `keep: true` marks a free family kept as-is (mapped to itself).
 */
interface LookalikeEntry {
  match: string[];
  family: string;
  license: string;
  keep?: boolean;
  note: string;
}

/**
 * The curated lookalike table (plan §9.7). Grotesque/neo-grotesque stacks map
 * to Inter; geometric-humanist display stacks (Gotham/Proxima-likes) map to
 * Montserrat or Figtree; monospace stacks map to JetBrains Mono. Already-free
 * families are kept (`keep`).
 */
export const LOOKALIKE_TABLE: readonly LookalikeEntry[] = [
  // --- Neo-grotesque / system sans -> Inter (Helvetica-likes, §9.7) ---
  {
    match: [
      'helvetica',
      'helveticaneue',
      'arial',
      'roboto',
      'systemui',
      'applesystem',
      'blinkmacsystemfont',
      'segoeui',
      'liberationsans',
      'sfprotext',
      'sfprodisplay',
      'sanfrancisco',
      'sohne',
      'sohnevar',
      'akkurat',
      'neuehaasgrotesk',
    ],
    family: 'Inter',
    license: OFL_LICENSE,
    note: 'neo-grotesque / system sans -> Inter (Helvetica-like)',
  },
  // --- Geometric / humanist display -> Montserrat (Gotham/Proxima-likes) ---
  {
    match: ['gotham', 'proximanova', 'proxima', 'futura', 'avenir', 'circular', 'brandontext'],
    family: 'Montserrat',
    license: OFL_LICENSE,
    note: 'geometric display -> Montserrat (Gotham/Proxima-like)',
  },
  // --- Humanist UI sans -> Figtree (a softer Gotham/Proxima alternative) ---
  {
    match: ['sofiapro', 'gilroy', 'poppins', 'objektiv', 'metropolis'],
    family: 'Figtree',
    license: OFL_LICENSE,
    note: 'humanist geometric -> Figtree (Gotham/Proxima-like)',
  },
  // --- Transitional / body serif -> Source Serif 4 ---
  {
    match: ['georgia', 'timesnewroman', 'times', 'garamond', 'freight', 'tiempos', 'ptserif'],
    family: 'Source Serif 4',
    license: OFL_LICENSE,
    note: 'transitional serif -> Source Serif 4',
  },
  // --- Monospace -> JetBrains Mono ---
  {
    match: [
      'menlo',
      'monaco',
      'consolas',
      'sfmono',
      'sfmonoregular',
      'couriernew',
      'courier',
      'liberationmono',
      'operatormono',
    ],
    family: 'JetBrains Mono',
    license: OFL_LICENSE,
    note: 'monospace -> JetBrains Mono',
  },
  // --- Already-free families: keep as-is (mapped to self) ---
  {
    match: [
      'inter',
      'roboto',
      'opensans',
      'lato',
      'montserrat',
      'manrope',
      'figtree',
      'worksans',
      'nunito',
      'nunitosans',
      'rubik',
      'dmsans',
      'ibmplexsans',
      'sourcesans3',
      'sourcesanspro',
    ],
    family: 'KEEP',
    license: OFL_LICENSE,
    keep: true,
    note: 'already a free (OFL) family — kept as-is',
  },
  {
    match: ['jetbrainsmono', 'firacode', 'ibmplexmono', 'sourcecodepro', 'spacemono', 'robotomono'],
    family: 'KEEP',
    license: OFL_LICENSE,
    keep: true,
    note: 'already a free (OFL) monospace — kept as-is',
  },
];

const MONO_FINGERPRINTS = new Set([
  'menlo',
  'monaco',
  'consolas',
  'sfmono',
  'sfmonoregular',
  'couriernew',
  'courier',
  'liberationmono',
  'jetbrainsmono',
  'firacode',
  'ibmplexmono',
  'sourcecodepro',
  'spacemono',
  'robotomono',
  'operatormono',
  'cascadiacode',
]);

const SERIF_FINGERPRINTS = new Set([
  'georgia',
  'timesnewroman',
  'times',
  'garamond',
  'freight',
  'tiempos',
  'ptserif',
  'sourceserif4',
  'cambria',
]);

/**
 * Normalize a raw CSS family to a comparison fingerprint: strip quotes, spaces,
 * and non-alphanumerics; lower-case. "SF Pro Display" -> "sfprodisplay",
 * "\"Helvetica Neue\"" -> "helveticaneue". A char-code scan (no regex escape
 * classes) keeps the source control-byte-clean.
 */
export function fingerprint(family: string): string {
  let out = '';
  for (const ch of family) {
    const code = ch.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    if (isDigit || isLower) out += ch;
    else if (isUpper) out += String.fromCharCode(code + 32);
    // everything else (space, quote, hyphen, comma) is dropped
  }
  return out;
}

/**
 * Loadable Google Fonts family fingerprints — DERIVED from LOOKALIKE_TABLE so
 * there is ONE source of truth (never a hand-maintained duplicate that drifts
 * from the mapping table). Two contributors:
 *   - every non-`keep` entry's TARGET `family` (Inter, Montserrat, Figtree,
 *     Source Serif 4, JetBrains Mono — the free family a fingerprint maps TO), and
 *   - every `keep` entry's `match` fingerprints (families that are ALREADY free
 *     Google Fonts, kept as-is).
 * A `keep` entry's `family` is the "KEEP" sentinel (not a loadable name), so it
 * contributes its match list instead. Consumed by the specimen preview (via
 * isGoogleFont) to decide which mapped families to <link> from fonts.googleapis.com.
 */
export const GOOGLE_FONT_FINGERPRINTS: ReadonlySet<string> = new Set(
  LOOKALIKE_TABLE.flatMap((entry) =>
    entry.keep === true ? entry.match : [fingerprint(entry.family)],
  ),
);

/**
 * True when a font family (as authored in a stack / a tokens.css `--font-*`
 * var) is a loadable Google Fonts family — its fingerprint is in
 * GOOGLE_FONT_FINGERPRINTS. System families ("Verdana") and variable-font blobs
 * ("Mona Sans VF") return false, so a specimen correctly leaves them to the
 * system fallback chain rather than requesting a webfont that does not exist.
 */
export function isGoogleFont(family: string): boolean {
  return GOOGLE_FONT_FINGERPRINTS.has(fingerprint(family));
}

function isMonoFamily(family: string): boolean {
  return MONO_FINGERPRINTS.has(fingerprint(family));
}

function isSerifFamily(family: string): boolean {
  return SERIF_FINGERPRINTS.has(fingerprint(family));
}

export interface FontMapping {
  /** Structural role this stack serves (heading/body/mono/unknown). */
  role: FontRole;
  /** The observed first concrete family, verbatim (evidence). */
  observedFamily: string | undefined;
  /** The chosen Google Fonts family, or the kept observed family. */
  mappedFamily: string | undefined;
  /** The final fontFamily token value: chosen family + fallback tail. */
  stack: string[];
  /** True when a curated lookalike (or keep-as-free) hit; false = unmapped. */
  mapped: boolean;
  /** OFL note for the mapped family (table invariant). undefined when unmapped. */
  license: string | undefined;
  /** Human explanation for the extraction report. */
  note: string;
}

/**
 * Fingerprint a font stack and map its first concrete family to a Google Fonts
 * lookalike. Unknown families are kept verbatim + flagged `mapped: false`.
 */
export function mapFontStack(stack: FontStack): FontMapping {
  // Runtime guard: families is TYPED string[] but nothing validates a
  // directly-constructed RawExtraction, and a JSON null/undefined entry must
  // not crash `.trim()` (never-a-crash contract; review iteration 2, medium).
  const first = stack.families.find((f) => typeof f === 'string' && f.trim() !== '');
  if (first === undefined) {
    return {
      role: stack.role,
      observedFamily: undefined,
      mappedFamily: undefined,
      stack: [...SANS_FALLBACKS],
      mapped: false,
      license: undefined,
      note: 'empty stack — no observed family; system fallback chain only',
    };
  }

  const fp = fingerprint(first);
  const entry = LOOKALIKE_TABLE.find((e) => e.match.includes(fp));
  const fallbacks = fallbacksFor(stack.role, first);

  if (entry === undefined) {
    // No invention: keep the observed family, add fallbacks, flag unmapped.
    return {
      role: stack.role,
      observedFamily: first,
      mappedFamily: undefined,
      stack: dedupeStack([first, ...fallbacks]),
      mapped: false,
      license: undefined,
      note: `unmapped stack "${first}" — kept observed family with system fallbacks (no free lookalike in the curated table)`,
    };
  }

  const chosen = entry.keep === true ? first : entry.family;
  return {
    role: stack.role,
    observedFamily: first,
    mappedFamily: chosen,
    stack: dedupeStack([chosen, ...fallbacks]),
    mapped: true,
    license: entry.license,
    note: entry.keep === true ? entry.note : `${entry.note} (observed "${first}")`,
  };
}

/** Drop later duplicate family names (case-insensitive) from a stack. */
function dedupeStack(families: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of families) {
    const key = f.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

export interface MappedFonts {
  sans: FontMapping;
  heading: FontMapping;
  mono: FontMapping;
}

/**
 * Reduce all observed stacks to the three font tokens (sans/heading/mono). Picks
 * the highest-frequency stack per role; falls back to the body stack for a
 * missing heading, and to a default sans/mono when a role is absent entirely.
 * Deterministic: ties broken by first-seen order.
 */
export function mapFonts(fonts: readonly FontStack[]): MappedFonts {
  const byRole = (role: FontRole): FontStack | undefined => {
    let best: FontStack | undefined;
    for (const f of fonts) {
      if (f.role !== role) continue;
      if (best === undefined || f.frequency > best.frequency) best = f;
    }
    return best;
  };

  const body = byRole('body') ?? byRole('unknown');
  const heading = byRole('heading') ?? body;
  const mono = byRole('mono') ?? findMonoByFamily(fonts);

  const sansMapping = body !== undefined ? mapFontStack(body) : DEFAULT_SANS;
  const headingMapping = heading !== undefined ? mapFontStack(heading) : sansMapping;
  const monoMapping = mono !== undefined ? forceMono(mapFontStack(mono)) : DEFAULT_MONO;

  return {
    sans: { ...sansMapping, role: 'body' },
    heading: { ...headingMapping, role: 'heading' },
    mono: { ...monoMapping, role: 'mono' },
  };
}

/** A stack whose first family fingerprints as monospace, even if role != mono. */
function findMonoByFamily(fonts: readonly FontStack[]): FontStack | undefined {
  for (const f of fonts) {
    // Same runtime guard as mapFontStack: tolerate non-string entries.
    const first = f.families.find((x) => typeof x === 'string' && x.trim() !== '');
    if (first !== undefined && isMonoFamily(first)) return f;
  }
  return undefined;
}

/** Ensure a mono mapping carries the mono fallback tail. */
function forceMono(mapping: FontMapping): FontMapping {
  const head = mapping.mappedFamily ?? mapping.observedFamily;
  const stack = head !== undefined ? dedupeStack([head, ...MONO_FALLBACKS]) : [...MONO_FALLBACKS];
  return { ...mapping, role: 'mono', stack };
}

/** Default sans mapping (preset default) when no sans/body stack was observed. */
const DEFAULT_SANS: FontMapping = {
  role: 'body',
  observedFamily: undefined,
  mappedFamily: 'Inter',
  stack: ['Inter', ...SANS_FALLBACKS],
  mapped: true,
  license: OFL_LICENSE,
  note: 'no sans/body stack observed — default Inter',
};

/** Default mono mapping (preset default) when no mono stack was observed. */
const DEFAULT_MONO: FontMapping = {
  role: 'mono',
  observedFamily: undefined,
  mappedFamily: 'JetBrains Mono',
  stack: ['JetBrains Mono', ...MONO_FALLBACKS],
  mapped: true,
  license: OFL_LICENSE,
  note: 'no mono stack observed — default JetBrains Mono',
};
