import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  SLIDER_AXES,
  corpusEntrySchema,
  corpusManifestSchema,
  loadCorpus,
  parseCorpus,
  sliderCoordsSchema,
  tierSchema,
  type CorpusEntry,
} from '../benchmark/corpus.ts';

const CORPUS_JSON_PATH = fileURLToPath(new URL('../benchmark/corpus.json', import.meta.url));

function readRawCorpus(): unknown {
  return JSON.parse(readFileSync(CORPUS_JSON_PATH, 'utf8'));
}

describe('corpus manifest', () => {
  it('validates the committed corpus.json against the schema', () => {
    const parsed = corpusManifestSchema.safeParse(readRawCorpus());
    expect(parsed.success).toBe(true);
  });

  it('loadCorpus() returns the validated manifest', () => {
    const manifest = loadCorpus();
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.entries.length).toBeGreaterThan(0);
  });

  it('exposes exactly the 8 documented slider axes', () => {
    expect(SLIDER_AXES).toHaveLength(8);
    expect([...SLIDER_AXES]).toEqual([
      'warmth',
      'saturation',
      'lightness',
      'contrast',
      'hueDiversity',
      'accentDominance',
      'neutralRatio',
      'vibrancy',
    ]);
    // The Zod object schema's keys match SLIDER_AXES exactly.
    expect(Object.keys(sliderCoordsSchema.shape).sort()).toEqual([...SLIDER_AXES].sort());
  });

  it('every v1-tier entry has all 8 slider axes present and numeric in [0,1]', () => {
    const v1 = loadCorpus().entries.filter((e) => e.tier === 'v1');
    expect(v1.length).toBeGreaterThan(0);

    for (const entry of v1) {
      const axisKeys = Object.keys(entry.sliderCoords);
      // exactly the 8 axes, nothing missing, nothing extra
      expect(axisKeys.sort()).toEqual([...SLIDER_AXES].sort());

      for (const axis of SLIDER_AXES) {
        const value = entry.sliderCoords[axis];
        expect(typeof value, `${entry.id}.${axis}`).toBe('number');
        expect(Number.isFinite(value), `${entry.id}.${axis}`).toBe(true);
        expect(value, `${entry.id}.${axis}`).toBeGreaterThanOrEqual(0);
        expect(value, `${entry.id}.${axis}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('includes the 12 named v1 real sites and the czg controls', () => {
    const entries = loadCorpus().entries;
    const v1Real = entries.filter((e) => e.tier === 'v1' && !e.isControl).map((e) => e.id);
    for (const id of [
      'stripe',
      'github',
      'basecamp',
      'nytimes',
      'imprintgenius',
      'duolingo',
      'kurzgesagt',
      'forliving',
      'spotify',
      'linear',
      'robinhood',
      'medium',
    ]) {
      expect(v1Real).toContain(id);
    }
    expect(v1Real).toHaveLength(12);

    const controls = entries.filter((e) => e.isControl);
    expect(controls).toHaveLength(8);
    for (const c of controls) {
      expect(c.archetype).toBe('control-czg');
      expect(c.tier).toBe('v1');
    }
    for (const id of ['czg-031', 'czg-113', 'czg-157', 'czg-cool', 'czg-dark', 'czg-warm', 'czg-rainbow', 'czg-luxe']) {
      expect(controls.map((c) => c.id)).toContain(id);
    }
  });

  it('exercises the later tier and at least one held-out entry', () => {
    const entries = loadCorpus().entries;
    const later = entries.filter((e) => e.tier === 'later');
    expect(later.length).toBeGreaterThanOrEqual(2);
    expect(entries.some((e) => e.heldOut)).toBe(true);
  });

  it('has unique ids across the manifest', () => {
    const ids = loadCorpus().entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('corpus schema rejects invalid data (throws, never returns unvalidated)', () => {
  const baseEntry: CorpusEntry = {
    id: 'x',
    url: 'https://example.com',
    archetype: 'fintech',
    sliderCoords: {
      warmth: 0.5,
      saturation: 0.5,
      lightness: 0.5,
      contrast: 0.5,
      hueDiversity: 0.5,
      accentDominance: 0.5,
      neutralRatio: 0.5,
      vibrancy: 0.5,
    },
    isControl: false,
    tier: 'v1',
    heldOut: false,
  };

  it('rejects an above-range slider coordinate (> 1)', () => {
    const bad = { ...baseEntry, sliderCoords: { ...baseEntry.sliderCoords, warmth: 1.5 } };
    expect(corpusEntrySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a below-range slider coordinate (< 0)', () => {
    const bad = { ...baseEntry, sliderCoords: { ...baseEntry.sliderCoords, warmth: -0.1 } };
    expect(corpusEntrySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a missing slider axis', () => {
    const { vibrancy: _drop, ...partial } = baseEntry.sliderCoords;
    const bad = { ...baseEntry, sliderCoords: partial };
    expect(corpusEntrySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown archetype', () => {
    const bad = { ...baseEntry, archetype: 'not-a-real-archetype' };
    expect(corpusEntrySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown tier value', () => {
    expect(tierSchema.safeParse('someday').success).toBe(false);
    const bad = { ...baseEntry, tier: 'someday' };
    expect(corpusEntrySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an id with a filename-unsafe char', () => {
    for (const badId of ['foo/bar', 'foo bar', 'Foo', '../escape', '-leading']) {
      const bad = { ...baseEntry, id: badId };
      expect(corpusEntrySchema.safeParse(bad).success, badId).toBe(false);
    }
  });

  it('rejects an unknown extra field (strict)', () => {
    const bad = { ...baseEntry, surprise: true };
    expect(corpusEntrySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a non-url / non-fixture url', () => {
    const bad = { ...baseEntry, url: 'ftp://example.com' };
    expect(corpusEntrySchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a duplicate id at the manifest level', () => {
    const manifest = { schemaVersion: 1, entries: [baseEntry, { ...baseEntry }] };
    const result = corpusManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it('.parse() throws a ZodError on invalid data', () => {
    expect(() => corpusManifestSchema.parse({ schemaVersion: 2, entries: [] })).toThrow(ZodError);
  });
});

describe('loader failure path (throws THROUGH the loader, not just the schema)', () => {
  it('parseCorpus() throws a ZodError on invalid data', () => {
    // Guards against a regression that swaps the loader's internal .parse() for
    // .safeParse() (which would silently return unvalidated data instead of throwing).
    expect(() => parseCorpus({ schemaVersion: 2, entries: [] })).toThrow(ZodError);
  });

  it('loadCorpus(path) throws when the file at path is a malformed manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corpus-loader-'));
    const badPath = join(dir, 'bad-corpus.json');
    try {
      // Structurally-valid JSON, but an entry violates the schema (bad archetype
      // + out-of-range coord) — so the throw comes from the loader's validation,
      // exercising the full readFile -> JSON.parse -> parse path, not the schema alone.
      writeFileSync(
        badPath,
        JSON.stringify({
          schemaVersion: 1,
          entries: [
            {
              id: 'bad',
              url: 'https://example.com',
              archetype: 'not-a-real-archetype',
              sliderCoords: {
                warmth: 5,
                saturation: 0.5,
                lightness: 0.5,
                contrast: 0.5,
                hueDiversity: 0.5,
                accentDominance: 0.5,
                neutralRatio: 0.5,
                vibrancy: 0.5,
              },
              isControl: false,
              tier: 'v1',
              heldOut: false,
            },
          ],
        }),
        'utf8',
      );
      expect(() => loadCorpus(badPath)).toThrow(ZodError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
