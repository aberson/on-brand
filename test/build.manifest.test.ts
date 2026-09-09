/**
 * Unit tests for manifest hashing + the determinism contract
 * (docs/findings/style-dictionary-decision.md § Manifest determinism
 * contract): content-derived hashing with CRLF normalization, and a
 * timestamp that changes only when the source hash changes.
 */

import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  computeSourceHash,
  hashContent,
  hashBytes,
  mutateManifestOutputs,
  onbrandVersion,
  parseStrictManifest,
  renderManifest,
} from '../src/build/manifest.ts';
import { SCHEMA_VERSION } from '../src/schema/types.ts';

const T0 = '2026-07-16T00:00:00.000Z';
const T1 = '2026-07-16T01:00:00.000Z';

describe('hashContent', () => {
  it('normalizes CRLF to LF before hashing (git autocrlf cannot flip the hash)', () => {
    expect(hashContent('a\r\nb\r\n')).toBe(hashContent('a\nb\n'));
  });

  it('different content hashes differently', () => {
    expect(hashContent('a')).not.toBe(hashContent('b'));
  });
});

describe('binary source hashing', () => {
  it('does not normalize CR/LF-valued bytes', () => {
    expect(hashBytes(Uint8Array.from([0x0d, 0x0a]))).not.toBe(hashBytes(Uint8Array.from([0x0a])));
  });

  it('accepts explicitly binary source inputs beside normalized text inputs', () => {
    const binary = computeSourceHash([{ relPath: 'assets/inspiration.png', bytes: Uint8Array.from([1, 13, 10]) }]);
    const changed = computeSourceHash([{ relPath: 'assets/inspiration.png', bytes: Uint8Array.from([1, 10]) }]);
    expect(binary.sourceHash).not.toBe(changed.sourceHash);
  });
});

describe('computeSourceHash', () => {
  const inputs = [
    { relPath: 'tokens.json', content: '{"a":1}' },
    { relPath: 'modes.dark.json', content: '{"b":2}' },
  ];

  it('is stable for identical inputs', () => {
    expect(computeSourceHash(inputs).sourceHash).toBe(computeSourceHash(inputs).sourceHash);
  });

  it('changes when any file content changes', () => {
    const changed = [inputs[0]!, { relPath: 'modes.dark.json', content: '{"b":3}' }];
    expect(computeSourceHash(changed).sourceHash).not.toBe(computeSourceHash(inputs).sourceHash);
  });

  it('is order- and path-sensitive (extends chain identity matters)', () => {
    const reordered = [inputs[1]!, inputs[0]!];
    expect(computeSourceHash(reordered).sourceHash).not.toBe(computeSourceHash(inputs).sourceHash);
    const renamed = [{ relPath: 'other.json', content: '{"a":1}' }, inputs[1]!];
    expect(computeSourceHash(renamed).sourceHash).not.toBe(computeSourceHash(inputs).sourceHash);
  });

  it('records one per-file sha256 per source', () => {
    const result = computeSourceHash(inputs);
    expect(result.sources.map((s) => s.path)).toEqual(['tokens.json', 'modes.dark.json']);
    expect(result.sources[0]!.sha256).toBe(hashContent('{"a":1}'));
  });
});

describe('buildManifest timestamp contract', () => {
  const hash = computeSourceHash([{ relPath: 'tokens.json', content: '{"a":1}' }]);

  it('stamps the current time on a first build', () => {
    const manifest = buildManifest({ hash, emitters: ['css'], outputs: ['tokens.css'], now: () => T0 });
    expect(manifest.timestamp).toBe(T0);
  });

  it('preserves the previous timestamp when the source hash is unchanged', () => {
    const first = buildManifest({ hash, emitters: ['css'], outputs: ['tokens.css'], now: () => T0 });
    const second = buildManifest({
      hash,
      emitters: ['css'],
      outputs: ['tokens.css'],
      previousManifestContent: renderManifest(first),
      now: () => T1,
    });
    expect(second.timestamp).toBe(T0);
    expect(renderManifest(second)).toBe(renderManifest(first)); // byte-identical
  });

  it('stamps fresh when the source hash changed', () => {
    const first = buildManifest({ hash, emitters: ['css'], outputs: ['tokens.css'], now: () => T0 });
    const changedHash = computeSourceHash([{ relPath: 'tokens.json', content: '{"a":2}' }]);
    const second = buildManifest({
      hash: changedHash,
      emitters: ['css'],
      outputs: ['tokens.css'],
      previousManifestContent: renderManifest(first),
      now: () => T1,
    });
    expect(second.timestamp).toBe(T1);
    expect(second.sourceHash).not.toBe(first.sourceHash);
  });

  it('stamps fresh (never crashes) when the previous manifest is corrupt', () => {
    const manifest = buildManifest({
      hash,
      emitters: ['css'],
      outputs: ['tokens.css'],
      previousManifestContent: 'not json at all {',
      now: () => T1,
    });
    expect(manifest.timestamp).toBe(T1);
  });

  it('does not preserve an invalid timestamp or one attached to an invalid source hash', () => {
    const first = buildManifest({ hash, emitters: ['css'], outputs: ['tokens.css'], now: () => T0 });
    const invalidTimestamp = { ...first, timestamp: 'not-iso' };
    expect(buildManifest({
      hash,
      emitters: ['css'],
      outputs: ['tokens.css'],
      previousManifestContent: JSON.stringify(invalidTimestamp),
      now: () => T1,
    }).timestamp).toBe(T1);

    const invalidSource = { ...first, sourceHash: 'F'.repeat(64) };
    expect(buildManifest({
      hash,
      emitters: ['css'],
      outputs: ['tokens.css'],
      previousManifestContent: JSON.stringify(invalidSource),
      now: () => T1,
    }).timestamp).toBe(T1);
  });

  it('records version, schema version, emitters, and llm status', () => {
    const manifest = buildManifest({ hash, emitters: ['css'], outputs: ['tokens.css'], now: () => T0 });
    expect(manifest.onbrandVersion).toBe(onbrandVersion());
    expect(manifest.schemaVersion).toBe(SCHEMA_VERSION);
    expect(manifest.emitters).toEqual(['css']);
    expect(manifest.llm).toBe('none');
  });

  it('renders omitted and explicit deterministic-only LLM metadata byte-identically', () => {
    const omitted = buildManifest({ hash, emitters: ['css'], outputs: ['tokens.css'], now: () => T0 });
    const explicit = buildManifest({
      hash,
      emitters: ['css'],
      outputs: ['tokens.css'],
      llm: 'none',
      now: () => T0,
    });
    expect(renderManifest(explicit)).toBe(renderManifest(omitted));
  });
});

describe('buildManifest per-output provenance (the subset-build guard)', () => {
  const h1 = computeSourceHash([{ relPath: 'tokens.json', content: '{"a":1}' }]);
  const h2 = computeSourceHash([{ relPath: 'tokens.json', content: '{"a":2}' }]);

  it('stamps outputs emitted this run with the current source hash', () => {
    const manifest = buildManifest({ hash: h1, emitters: ['css'], outputs: ['tokens.css'], now: () => T0 });
    expect(manifest.outputs).toEqual({ 'tokens.css': h1.sourceHash });
  });

  it('carries forward entries for outputs NOT regenerated this run — stale stays detectable', () => {
    const full = buildManifest({ hash: h1, emitters: ['css'], outputs: ['tokens.css'], now: () => T0 });
    // sources changed, but this run emitted nothing (e.g. --emit tw today)
    const subset = buildManifest({
      hash: h2,
      emitters: [],
      outputs: [],
      previousManifestContent: renderManifest(full),
      now: () => T1,
    });
    expect(subset.sourceHash).toBe(h2.sourceHash);
    expect(subset.outputs['tokens.css']).toBe(h1.sourceHash); // carried forward
    expect(subset.outputs['tokens.css']).not.toBe(subset.sourceHash); // guard-detectable
  });

  it('re-stamps a carried-forward output once it is regenerated', () => {
    const full = buildManifest({ hash: h1, emitters: ['css'], outputs: ['tokens.css'], now: () => T0 });
    const stale = buildManifest({
      hash: h2,
      emitters: [],
      outputs: [],
      previousManifestContent: renderManifest(full),
      now: () => T1,
    });
    const regen = buildManifest({
      hash: h2,
      emitters: ['css'],
      outputs: ['tokens.css'],
      previousManifestContent: renderManifest(stale),
      now: () => T1,
    });
    expect(regen.outputs['tokens.css']).toBe(h2.sourceHash);
  });

  it('sorts output keys for byte-determinism', () => {
    const manifest = buildManifest({
      hash: h1,
      emitters: ['css'],
      outputs: ['theme.tw.css', 'tokens.css', 'diagram-palette.json'],
      now: () => T0,
    });
    expect(Object.keys(manifest.outputs)).toEqual([
      'diagram-palette.json',
      'theme.tw.css',
      'tokens.css',
    ]);
  });

  it('fails closed for invalid current output keys, digests, and outputSources', () => {
    const warnings: string[] = [];
    for (const invalid of [null, [], 7]) {
      expect(() => buildManifest({
        hash: h1,
        emitters: ['generated'],
        outputs: ['specimen.html'],
        outputSources: invalid as never,
        onWarning: (warning) => warnings.push(warning),
        now: () => T0,
      })).toThrow(/current provenance map.*not an object/);
    }
    for (const invalid of [null, [], 7]) {
      expect(() => buildManifest({
        hash: h1,
        emitters: ['generated'],
        outputs: ['specimen.html'],
        outputHashes: invalid as never,
        onWarning: (warning) => warnings.push(warning),
        now: () => T0,
      })).toThrow(/current digest map.*not an object/);
    }
    expect(() => buildManifest({
      hash: h1,
      emitters: ['generated'],
      outputs: ['../escaped.html'],
      onWarning: (warning) => warnings.push(warning),
      now: () => T0,
    })).toThrow(/current output.*clean dist\/-relative path/);
    expect(() => buildManifest({
      hash: h1,
      emitters: ['generated'],
      outputs: ['specimen.html'],
      outputHashes: { 'specimen.html': 'not-a-digest' },
      onWarning: (warning) => warnings.push(warning),
      now: () => T0,
    })).toThrow(/current digest.*lowercase SHA-256/);
    expect(() => buildManifest({
      hash: h1,
      emitters: ['generated'],
      outputs: ['specimen.html'],
      outputSources: {
        'specimen.html': [{
          label: 'specimen-html',
          sourcePath: null,
          kind: 'digest',
          sha256: 'not-a-digest',
        }],
      },
      onWarning: (warning) => warnings.push(warning),
      now: () => T0,
    })).toThrow(/invalid current provenance/);
    expect(() => buildManifest({
      hash: h1,
      emitters: ['css'],
      outputs: ['tokens.css'],
      outputSources: {
        '../escaped.html': [{
          label: 'core', sourcePath: null, kind: 'digest', sha256: h1.sourceHash,
        }],
      },
      onWarning: (warning) => warnings.push(warning),
      now: () => T0,
    })).toThrow(/current provenance names non-emitted output/);
    expect(warnings).toEqual([]);
  });

  it('warns and drops parseable corrupt carried output provenance as repair input', () => {
    const previous = buildManifest({
      hash: h1,
      emitters: ['css'],
      outputs: ['tokens.css'],
      now: () => T0,
    }) as ReturnType<typeof buildManifest> & { outputSources?: Record<string, unknown> };
    previous.outputs['bad-digest.html'] = 'not-a-digest';
    previous.outputs['carried.html'] = h1.sourceHash;
    previous.outputSources = {
      'carried.html': [{
        label: 'carried', sourcePath: null, kind: 'digest', sha256: 'not-a-digest',
      }],
    };
    const warnings: string[] = [];
    const repaired = buildManifest({
      hash: h2,
      emitters: [],
      outputs: [],
      previousManifestContent: JSON.stringify(previous),
      carriedOutputExists: () => true,
      onWarning: (warning) => warnings.push(warning),
      now: () => T1,
    });

    expect(repaired.outputs).not.toHaveProperty('bad-digest.html');
    expect(repaired.outputs['carried.html']).toBe(h1.sourceHash);
    expect(repaired.outputSources).toBeUndefined();
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('bad-digest.html'),
      expect.stringContaining('invalid carried provenance'),
    ]));
  });

  it('does not carry an older valid source row across current regeneration without one', () => {
    const previous = buildManifest({
      hash: h1,
      emitters: ['generated'],
      outputs: ['generated.html'],
      outputSources: {
        'generated.html': [{
          label: 'old-content', sourcePath: null, kind: 'digest', sha256: h1.sourceHash,
        }],
      },
      now: () => T0,
    });
    const regenerated = buildManifest({
      hash: h2,
      emitters: ['generated'],
      outputs: ['generated.html'],
      previousManifestContent: renderManifest(previous),
      now: () => T1,
    });

    expect(regenerated.outputs['generated.html']).toBe(h2.sourceHash);
    expect(regenerated.outputSources).toBeUndefined();
  });

  it('uses current provenance instead of a valid carried row when regenerating an output', () => {
    const previous = buildManifest({
      hash: h1,
      emitters: ['generated'],
      outputs: ['generated.html'],
      outputSources: {
        'generated.html': [{
          label: 'generated-content', sourcePath: null, kind: 'digest', sha256: h1.sourceHash,
        }],
      },
      now: () => T0,
    });
    const currentSources = [{
      label: 'generated-content', sourcePath: null, kind: 'digest' as const, sha256: h2.sourceHash,
    }];
    const regenerated = buildManifest({
      hash: h2,
      emitters: ['generated'],
      outputs: ['generated.html'],
      outputSources: { 'generated.html': currentSources },
      previousManifestContent: renderManifest(previous),
      now: () => T1,
    });

    expect(regenerated.outputSources?.['generated.html']).toEqual(currentSources);
    expect(regenerated.outputSources?.['generated.html']).not.toEqual(
      previous.outputSources?.['generated.html'],
    );
  });
});

describe('renderManifest', () => {
  it('renders LF-only JSON with a trailing newline that round-trips', () => {
    const manifest = buildManifest({
      hash: computeSourceHash([{ relPath: 'tokens.json', content: '{}' }]),
      emitters: ['css'],
      outputs: ['tokens.css'],
      now: () => T0,
    });
    const rendered = renderManifest(manifest);
    expect(rendered.endsWith('\n')).toBe(true);
    expect(rendered).not.toContain('\r');
    expect(JSON.parse(rendered)).toEqual(manifest);
  });
});

describe('mutateManifestOutputs', () => {
  it('adds generated-view provenance without altering the core source hash', () => {
    const core = computeSourceHash([{ relPath: 'tokens.json', content: '{}' }]);
    const original = buildManifest({ hash: core, emitters: ['css'], outputs: ['tokens.css'], now: () => T0 });
    const digest = 'a'.repeat(64);
    const next = mutateManifestOutputs(renderManifest(original), {
      set: {
        'specimen.html': { sha256: core.sourceHash },
        'inspiration-to-implementation.html': {
          sha256: digest,
          sources: [
            { label: 'core', sourcePath: null, kind: 'digest', sha256: core.sourceHash },
            { label: 'trace', sourcePath: 'inspiration.json', kind: 'text-lf', sha256: digest },
          ],
        },
      },
    });
    expect(next.sourceHash).toBe(core.sourceHash);
    expect(next.outputs['specimen.html']).toBe(core.sourceHash);
    expect(next.outputs['inspiration-to-implementation.html']).toBe(digest);
    expect(next.outputSources?.['inspiration-to-implementation.html']).toHaveLength(2);
  });

  it('removes an optional output and its composite provenance as one coupled mutation', () => {
    const core = computeSourceHash([{ relPath: 'tokens.json', content: '{}' }]);
    const digest = 'a'.repeat(64);
    const original = mutateManifestOutputs(
      renderManifest(buildManifest({ hash: core, emitters: ['css'], outputs: ['tokens.css'], now: () => T0 })),
      {
        set: {
          'inspiration-to-implementation.html': {
            sha256: digest,
            sources: [{ label: 'core', sourcePath: null, kind: 'digest', sha256: core.sourceHash }],
          },
        },
      },
    );

    const next = mutateManifestOutputs(renderManifest(original), {
      remove: ['inspiration-to-implementation.html'],
    });
    expect(next.outputs).not.toHaveProperty('inspiration-to-implementation.html');
    expect(next.outputSources).toBeUndefined();
  });
});

describe('parseStrictManifest', () => {
  const core = computeSourceHash([{ relPath: 'tokens.json', content: '{}' }]);

  function validManifest() {
    return buildManifest({ hash: core, emitters: ['css'], outputs: ['tokens.css'], now: () => T0 });
  }

  it('round-trips the complete production envelope', () => {
    const manifest = validManifest();
    expect(parseStrictManifest(renderManifest(manifest))).toEqual(manifest);
  });

  it('rejects partial envelopes and source rows that do not reconstruct sourceHash', () => {
    expect(() => parseStrictManifest(JSON.stringify({ outputs: { 'tokens.css': core.sourceHash } }))).toThrow(
      'invalid manifest envelope',
    );
    const manifest = validManifest();
    manifest.sources[0]!.sha256 = 'a'.repeat(64);
    expect(() => parseStrictManifest(renderManifest(manifest))).toThrow('invalid manifest envelope');
  });

  it('rejects unknown envelope keys and malformed composite provenance', () => {
    const unknown = { ...validManifest(), unexpected: true };
    expect(() => parseStrictManifest(JSON.stringify(unknown))).toThrow('invalid manifest envelope');

    const malformed = validManifest() as ReturnType<typeof validManifest> & {
      outputSources?: Record<string, unknown>;
    };
    malformed.outputSources = {
      'tokens.css': [{ label: 'core', sourcePath: null, kind: 'digest', sha256: 'not-a-sha256' }],
    };
    expect(() => parseStrictManifest(JSON.stringify(malformed))).toThrow('invalid manifest envelope');
  });
});
