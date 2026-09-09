/**
 * Brand-Fidelity benchmark fixtures — hermetic replay + determinism (Step 2, #30).
 *
 * The committed fixture set under docs/findings/eval-raw-extractions/benchmark/ is
 * the frozen replay input for the whole benchmark: scoring runs (later steps) do
 * NOT live-extract — they replay these `raw-extraction.json` files through the
 * production normalize→build→report pipeline via the FixtureEngine seam, so the
 * benchmark measures normalize+pick+render fidelity against a fixed input (plan §6
 * "Hermetic replay"). This test is the guard that the set stays replayable and
 * deterministic.
 *
 * Three tiers:
 *
 *  1. FULL SET, in-process (fast) — every committed fixture is parsed, shape-checked
 *     against RawExtraction, and run through the production `normalize()` so we know
 *     the ENTIRE set is consumable by the real pipeline and maps 1:1 to the v1 corpus
 *     ids. ~20 fixtures in a few ms each.
 *
 *  2. FULL SET, spawned production CLI (offline) — the acceptance gate (Done-when):
 *     EVERY committed fixture is replayed once through `node bin/onbrand.mjs
 *     from-url … --no-llm` with the ONBRAND_FAKE_EXTRACTION + ONBRAND_NOW seams and
 *     asserted exit 0 + OFFLINE (the produced raw-extraction.json's colours deep-equal
 *     the committed fixture — a live fetch could not reproduce a frozen palette; the
 *     DembrandtEngine that would touch the network is never constructed when
 *     ONBRAND_FAKE_EXTRACTION is set, cli.ts). ~20 spawns, one each (~6s wall).
 *
 *     DETERMINISM is then checked on a representative subset (below) by replaying it
 *     a SECOND time and asserting the whole proposal tree is byte-identical. The
 *     subset spans the shape space AND includes `basecamp` — the one fixture whose
 *     seed falls back on chroma (a fragile tie-break, FIXTURES.md), i.e. the case
 *     most likely to expose non-determinism.
 *
 *  3. NEGATIVE ANCHORS (measurement-validity: "a bench that can't fail garbage can't
 *     gate") — a mutated replay output MUST be caught by the byte-identical check, and
 *     a corrupt fixture MUST make the CLI replay exit non-zero. These prove the green
 *     in tiers 1–2 is meaningful. Both are hermetic (no network).
 *
 * Determinism holds because a proposal is a pure function of (extraction, clock,
 * --no-llm) (from-url.ts): the pinned CLOCK removes the only non-determinism (the
 * proposal-dir date, the report "generated at", AND the manifest timestamp — from-url
 * threads the same pinned clock into compileBrand's manifest `now`, so manifest.json
 * is deterministic too, not excluded). Empirically verified: two replays of every
 * subset fixture — including basecamp — produce byte-identical trees, ALL files (see
 * treeDiff), with NO non-deterministic-by-design artifact to exclude.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_OK } from '../src/cli.ts';
import { normalize } from '../src/extract/normalize.ts';
import type { ColorCluster, RawExtraction } from '../src/extract/engine/adapter.ts';
import { loadCorpus } from '../benchmark/corpus.ts';
import { assessCapture } from '../benchmark/capture-sanity.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO_ROOT, 'bin', 'onbrand.mjs');
const BENCH_DIR = path.join(REPO_ROOT, 'docs', 'findings', 'eval-raw-extractions', 'benchmark');
/** Pinned clock — the only non-determinism in the proposal (dir name + report date + manifest ts). */
const CLOCK = '2026-07-18T12:00:00.000Z';

/**
 * Per-spawn wall-clock budget. Kept BELOW every outer test timeout below so a hung
 * spawn trips THIS (a clear spawnSync timeout) before the vitest test timeout, and a
 * test's total spawn budget (spawns × this) stays under its own timeout (finding #5).
 * A real replay is ~0.3–0.6s, so 20s is ~30× headroom.
 */
const SPAWN_TIMEOUT_MS = 20_000;

const CORPUS = loadCorpus();
const urlById = new Map(CORPUS.entries.map((e) => [e.id, e.url]));
const V1_IDS = CORPUS.entries.filter((e) => e.tier === 'v1').map((e) => e.id).sort();

/** Ids for which a `<id>.raw-extraction.json` is committed, sorted. */
function committedFixtureIds(): string[] {
  return readdirSync(BENCH_DIR)
    .filter((f) => f.endsWith('.raw-extraction.json'))
    .map((f) => f.replace('.raw-extraction.json', ''))
    .sort();
}

function readFixture(id: string): RawExtraction {
  return JSON.parse(readFileSync(path.join(BENCH_DIR, `${id}.raw-extraction.json`), 'utf8')) as RawExtraction;
}

function urlFor(id: string): string {
  const url = urlById.get(id);
  if (url === undefined) throw new Error(`no corpus url for fixture id "${id}"`);
  return url;
}

// --- temp-dir bookkeeping ----------------------------------------------------
const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-bench-'));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Spawn the production CLI to replay a fixture offline (no network). Returns the
 * explicit `{ status, stdout, stderr }` shape the repo's other spawnSync wrappers
 * hand-declare (build.svg.test.ts et al.) rather than leaking spawnSync's raw type.
 */
function replayCli(
  fixture: string,
  url: string,
  out: string,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BIN, 'from-url', url, '--no-llm', '--out', out], {
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, ONBRAND_FAKE_EXTRACTION: fixture, ONBRAND_NOW: CLOCK },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The single proposal dir a replay wrote under `out`. */
function proposalDirIn(out: string): string {
  const dirs = readdirSync(out).filter((d) => d.startsWith('onbrand-proposal-'));
  expect(dirs.length, `exactly one proposal dir under ${out}`).toBe(1);
  return path.join(out, dirs[0]!);
}

/** All files under `root` as sorted forward-slash relative paths (recursive). */
function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
      else out.push(childRel);
    }
  };
  walk(root, '');
  return out.sort();
}

/**
 * Relative paths that differ (bytes) OR exist in only one of the two proposal trees.
 * Empty array == the two trees are byte-identical across EVERY file (guide.md,
 * extraction-report.md, raw-extraction.json, all brand/dist/* incl. manifest.json,
 * the assets PNG, .gitkeep — the full deterministic set, finding #2). This is the one
 * comparison harness both the positive determinism assertion and the negative anchor
 * exercise, so the anchor proves the assertion can actually fail.
 */
function treeDiff(a: string, b: string): string[] {
  const filesA = listTree(a);
  const filesB = listTree(b);
  const setA = new Set(filesA);
  const setB = new Set(filesB);
  const diffs: string[] = [];
  for (const rel of [...new Set([...filesA, ...filesB])].sort()) {
    if (!setA.has(rel) || !setB.has(rel)) {
      diffs.push(rel);
      continue;
    }
    const bytesA = readFileSync(path.join(a, ...rel.split('/')));
    const bytesB = readFileSync(path.join(b, ...rel.split('/')));
    if (!bytesA.equals(bytesB)) diffs.push(rel);
  }
  return diffs;
}

const HEX_RE = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;

function assertRawExtractionShape(id: string, x: RawExtraction): void {
  expect(typeof x.url, `${id}.url`).toBe('string');
  expect(typeof x.extractedAt, `${id}.extractedAt`).toBe('string');
  expect(typeof x.engine?.name, `${id}.engine.name`).toBe('string');
  for (const arr of ['colors', 'fonts', 'typeSizes', 'spacing', 'radii', 'shadows', 'screenshots'] as const) {
    expect(Array.isArray(x[arr]), `${id}.${arr} is array`).toBe(true);
  }
  expect(x.colors.length, `${id} has >=1 colour`).toBeGreaterThan(0);
  for (const col of x.colors) {
    expect(HEX_RE.test(col.hex), `${id} colour hex "${col.hex}"`).toBe(true);
    expect(typeof col.frequency, `${id} colour frequency`).toBe('number');
    expect(Array.isArray(col.roles), `${id} colour roles`).toBe(true);
  }
  // Screenshot paths (when present) are committed alongside the fixture and must resolve.
  for (const shot of x.screenshots) {
    const abs = path.isAbsolute(shot.path) ? shot.path : path.join(REPO_ROOT, shot.path);
    expect(existsSync(abs), `${id} screenshot committed: ${shot.path}`).toBe(true);
  }
}

/** Assert a replayed proposal used the committed fixture (offline), not a live fetch. */
function assertOffline(id: string, proposalDir: string): void {
  const committed = readFixture(id);
  const replayed = JSON.parse(
    readFileSync(path.join(proposalDir, 'raw-extraction.json'), 'utf8'),
  ) as RawExtraction;
  // A live network fetch could not reproduce a frozen palette — equal colours can only
  // happen if the run replayed the committed data (the network engine was never built).
  expect(replayed.colors as ColorCluster[], `${id} replay used the committed fixture, not the network`).toEqual(
    committed.colors,
  );
  expect(replayed.engine.name, `${id} replay engine provenance`).toBe(committed.engine.name);
}

// --- Tier 1: full set, in-process -------------------------------------------

describe('benchmark fixtures — full set (in-process)', () => {
  const ids = committedFixtureIds();

  it('committed fixtures map 1:1 to the v1 corpus ids (no missing, no orphans)', () => {
    for (const id of V1_IDS) expect(ids, `fixture committed for v1 id "${id}"`).toContain(id);
    for (const id of ids) expect(V1_IDS, `fixture "${id}" is a v1 corpus id`).toContain(id);
  });

  it.each(ids)('fixture %s parses, shape-checks, and runs through production normalize()', (id) => {
    const raw = readFixture(id);
    assertRawExtractionShape(id, raw);
    // Consumable by the real pipeline: normalize is the first production stage after
    // extraction and throws on a malformed extraction. A valid seed proves replayability.
    const norm = normalize(raw);
    expect(HEX_RE.test(norm.seed), `${id} normalize seed "${norm.seed}"`).toBe(true);
  });

  // Capture-sanity gate (data integrity): no REAL-SITE fixture may be a bot-block /
  // CAPTCHA / error / blank capture. This is the guard that would have caught the
  // louisvuitton deny-page fixture (thin across every structural axis) before it
  // froze as ground truth — it was instead rationalised as "minimal-real". A
  // `thin-colors` fixture (basecamp: real page, OKLCH colour read collapsed) is
  // allowed; only `likely-not-a-page` fails. Scoped to real sites: the czg controls
  // are SYNTHETIC csszengarden skins, intentionally minimal (they isolate palette
  // from layout), so they read structurally thin by design and are exempt — the gate
  // asks "is this a real captured page", which controls are not.
  const realSiteIds = CORPUS.entries.filter((e) => e.tier === 'v1' && !e.isControl).map((e) => e.id);
  it.each(realSiteIds)('real-site fixture %s is a real page, not a deny/blank capture (capture-sanity gate)', (id) => {
    const a = assessCapture(readFixture(id));
    expect(a.verdict, `${id} capture-sanity — ${a.signals.join(' | ')}`).not.toBe('likely-not-a-page');
  });
});

// --- Tier 2: full set, spawned CLI, offline (+ subset determinism) -----------

/**
 * Determinism subset — replayed TWICE and asserted byte-identical across ALL files.
 * Spans the shape space AND the fragile case: large-real (stripe), luxury-real
 * (forliving — the swap that replaced the louisvuitton bot-block deny-page fixture),
 * live-czg (czg-113), synthetic-multi-hue (czg-rainbow), and basecamp (the one fixture
 * whose seed falls back on chroma — a fragile tie-break, so the most likely to expose
 * non-determinism; finding #3).
 */
const REPLAY_SUBSET = ['stripe', 'forliving', 'czg-113', 'czg-rainbow', 'basecamp'] as const;

describe('benchmark fixtures — hermetic replay (spawned CLI, offline)', () => {
  const ids = committedFixtureIds();

  it('the determinism subset is a subset of the committed fixtures', () => {
    const committed = new Set(ids);
    for (const id of REPLAY_SUBSET) expect(committed.has(id), `subset id "${id}" is committed`).toBe(true);
  });

  // Acceptance gate (Done-when): EVERY committed fixture replays via the real CLI,
  // exit 0, offline — the full emitters + compileBrand + report path, not just
  // in-process normalize() (finding #1). One spawn each.
  it.each(ids)(
    '%s replays through the production CLI (exit 0, offline, no network)',
    (id) => {
      const fixture = path.join(BENCH_DIR, `${id}.raw-extraction.json`);
      expect(existsSync(fixture), `${id} fixture exists`).toBe(true);
      const out = tempDir();
      const r = replayCli(fixture, urlFor(id), out);
      expect(r.status, `${id} replay exit\n${r.stderr}`).toBe(EXIT_OK);
      assertOffline(id, proposalDirIn(out));
    },
    30_000,
  );

  // Determinism: two independent replays produce a byte-identical proposal tree —
  // EVERY file (guide.md, extraction-report.md, raw-extraction.json, all dist/*
  // incl. manifest.json, assets) is a pure function of (extraction, clock, --no-llm)
  // (finding #2). Two spawns → outer timeout > 2 × SPAWN_TIMEOUT_MS (finding #5).
  it.each(REPLAY_SUBSET)(
    '%s is byte-identical across two independent replays (whole tree)',
    (id) => {
      const fixture = path.join(BENCH_DIR, `${id}.raw-extraction.json`);
      const url = urlFor(id);
      const outA = tempDir();
      const outB = tempDir();
      const rA = replayCli(fixture, url, outA);
      expect(rA.status, `${id} run A exit\n${rA.stderr}`).toBe(EXIT_OK);
      const rB = replayCli(fixture, url, outB);
      expect(rB.status, `${id} run B exit\n${rB.stderr}`).toBe(EXIT_OK);

      const pA = proposalDirIn(outA);
      const pB = proposalDirIn(outB);
      assertOffline(id, pA);
      const diffs = treeDiff(pA, pB);
      expect(diffs, `${id} non-deterministic files across replays: ${diffs.join(', ')}`).toEqual([]);
    },
    50_000,
  );
});

// --- Tier 3: negative anchors (the green must be falsifiable) ----------------

describe('benchmark fixtures — negative anchors (assertions can fail)', () => {
  // Anchor A — the byte-identical determinism check MUST catch a mismatch. Replay one
  // fixture twice (identical), confirm treeDiff sees them as identical, then mutate one
  // leaf of run B and confirm treeDiff now reports exactly that file. Proves the
  // positive determinism green (treeDiff == []) is meaningful, not vacuous.
  it('the determinism check catches a mutated replay output', () => {
    const id = 'stripe';
    const fixture = path.join(BENCH_DIR, `${id}.raw-extraction.json`);
    const url = urlFor(id);
    const outA = tempDir();
    const outB = tempDir();
    expect(replayCli(fixture, url, outA).status, 'anchor run A exit').toBe(EXIT_OK);
    expect(replayCli(fixture, url, outB).status, 'anchor run B exit').toBe(EXIT_OK);

    const pA = proposalDirIn(outA);
    const pB = proposalDirIn(outB);
    expect(treeDiff(pA, pB), 'baseline: two clean replays are byte-identical').toEqual([]);

    // Mutate one deterministic leaf of run B, then re-compare with the SAME harness.
    const mutated = path.join(pB, 'brand', 'tokens.json');
    writeFileSync(mutated, `${readFileSync(mutated, 'utf8')}\n/* tamper */\n`, 'utf8');
    const diffs = treeDiff(pA, pB);
    expect(diffs, 'a mutated output must be detected').toContain('brand/tokens.json');
  }, 50_000);

  // Anchor B — a corrupt/malformed fixture MUST make the CLI replay exit non-zero
  // (FixtureEngine parses lazily → extract-stage failure → EXIT_FAILURE, from-url.ts).
  // Proves the exit-0 assertion in tier 2 is meaningful. Hermetic: the bad fixture is a
  // local temp file, ONBRAND_FAKE_EXTRACTION is set, so no network is ever touched.
  it('a corrupt fixture makes the CLI replay exit non-zero', () => {
    const dir = tempDir();
    const bad = path.join(dir, 'corrupt.raw-extraction.json');
    writeFileSync(bad, '{ not valid json ]', 'utf8');
    const r = replayCli(bad, 'https://example.com', path.join(dir, 'out'));
    expect(r.status, `corrupt fixture should not exit 0\n${r.stderr}`).not.toBe(EXIT_OK);
  }, 30_000);
});
