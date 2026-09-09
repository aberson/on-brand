/**
 * from-url end-to-end (Step 12). Three tiers:
 *
 *  A. OFFLINE, in-process — drives the real runFromUrl orchestrator with a
 *     FixtureEngine (a committed raw-extraction stands in for live dembrandt +
 *     Chromium via the adapter seam). Covers naming, -b disambiguation,
 *     never-clobber, --force, --no-llm, the LLM-used path (fake claude bin), the
 *     INCOMPLETE marker + partial evidence, and that the proposal's tokens pass
 *     check + dist is complete. Fast + deterministic (pinned clock).
 *
 *  B. OFFLINE, through the SPAWNED production CLI — `node bin/onbrand.mjs
 *     from-url ...` with the ONBRAND_FAKE_EXTRACTION + ONBRAND_NOW seams, so the
 *     whole from-url wiring runs at the process boundary (code-quality: integrate
 *     through the production caller), then `onbrand check` on the result. Also
 *     the exit-code contract (usage / pipeline failure).
 *
 *  C. LIVE dembrandt+Chromium against a local static fixture site over http —
 *     SLOW, so gated behind ONBRAND_LIVE_FROMURL=1 (skipped in npm test).
 *
 * Determinism: every run injects a pinned clock (ONBRAND_NOW / options.now) so
 * Date.now() never leaks into the proposal-dir name.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../src/cli.ts';
import { runCheck } from '../src/check/run.ts';
import {
  FixtureEngine,
  FromUrlUsageError,
  hostSlug,
  resolveProposalDir,
  runFromUrl,
} from '../src/extract/from-url.ts';
import { buildTokensForSeed, normalize } from '../src/extract/normalize.ts';
import { nodeScriptSpawner, type ClaudeSpawner } from '../src/extract/llm.ts';
import type { ExtractionEngine, RawExtraction } from '../src/extract/engine/adapter.ts';

/** Read a token leaf's $value by dot-path from a parsed tokens document. */
function leafValue(doc: unknown, dotPath: string): unknown {
  let node: unknown = doc;
  for (const key of dotPath.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node !== null && typeof node === 'object'
    ? (node as Record<string, unknown>).$value
    : undefined;
}

/**
 * An extraction with TWO chromatic brand candidates (red ranks 1 on role-weight,
 * blue ranks 2) — the fixture the divergent-LLM-pick tests need. example.json
 * yields only one candidate, so the threading bug is invisible without this.
 */
const TWO_CANDIDATE_EXTRACTION: RawExtraction = {
  url: 'https://two.example/',
  extractedAt: '2026-07-16T00:00:00.000Z',
  engine: { name: 'fake', version: '0' },
  colors: [
    { hex: '#c81e1e', frequency: 30, roles: [{ role: 'accent', count: 8 }] }, // red, rank 1
    { hex: '#1e40c8', frequency: 15, roles: [{ role: 'accent', count: 3 }] }, // blue, rank 2
    { hex: '#111111', frequency: 100, roles: [{ role: 'text', count: 50 }] }, // grey, excluded
    { hex: '#ffffff', frequency: 200, roles: [{ role: 'background', count: 100 }] },
  ],
  fonts: [{ families: ['Inter'], role: 'body', frequency: 5 }],
  typeSizes: [{ px: 16, frequency: 5 }],
  spacing: [],
  radii: [],
  shadows: [],
  screenshots: [],
};

class StaticEngine implements ExtractionEngine {
  readonly name = 'static';
  constructor(private readonly extraction: RawExtraction) {}
  async extract(): Promise<RawExtraction> {
    return this.extraction;
  }
}

/** A spawner whose color-pick pass returns a caller-chosen candidate hex. */
function pickSpawner(pickHex: string): ClaudeSpawner {
  return async (args) => {
    const i = args.indexOf('-p');
    const prompt = i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : '';
    let payload: unknown;
    if (prompt.includes('pick the single brand color')) {
      payload = { pick: pickHex, rationale: 'LLM prefers this one.' };
    } else if (prompt.includes('write a brief aesthetic summary')) {
      payload = { summary: 'Sentence one. Sentence two.' };
    } else {
      payload = {
        bullets: ['a', 'b', 'c'],
        examples: [
          { before: 'x', after: 'y' },
          { before: 'x', after: 'y' },
          { before: 'x', after: 'y' },
        ],
      };
    }
    return { stdout: JSON.stringify(payload), stderr: '', code: 0, timedOut: false };
  };
}

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO_ROOT, 'bin', 'onbrand.mjs');
const EXAMPLE_FIXTURE = path.join(REPO_ROOT, 'test/fixtures/extraction/raw-extraction/example.json');
const CLOCK = new Date('2026-07-16T12:00:00.000Z');
const EXPECTED_DIR = 'onbrand-proposal-example.com-20260716';
const fakeBin = (name: string): string =>
  fileURLToPath(new URL(`./helpers/fake-bins/${name}.js`, import.meta.url));

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-fromurl-'));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function fixtureEngine(): FixtureEngine {
  return new FixtureEngine(EXAMPLE_FIXTURE, REPO_ROOT);
}

const URL_NORMALIZER_FINGERPRINT =
  'bbdd301c3239bd1568d750556bdda43c3bf6102fbe783661b0bf3e55d23e8876';

describe('from-url normalizer compatibility', () => {
  it('keeps the committed fixture normalization fingerprint unchanged', () => {
    const extraction = JSON.parse(readFileSync(EXAMPLE_FIXTURE, 'utf8')) as RawExtraction;
    const fingerprint = createHash('sha256').update(JSON.stringify(normalize(extraction))).digest('hex');
    expect(fingerprint).toBe(URL_NORMALIZER_FINGERPRINT);
  });
});

// --- A. offline, in-process --------------------------------------------------

describe('from-url (offline, in-process) — complete proposal', () => {
  it('--no-llm produces a complete, check-passing proposal with the pinned-date name', async () => {
    const out = tempDir();
    const result = await runFromUrl('https://example.com/', {
      outDir: out,
      engine: fixtureEngine(),
      now: () => CLOCK,
      noLlm: true,
    });

    expect(result.status).toBe('complete');
    expect(path.basename(result.proposalDir)).toBe(EXPECTED_DIR);
    expect(result.llmManifestStatus).toBe('skipped');

    // Full brand/-shaped set + evidence.
    const brand = result.brandDir;
    for (const rel of ['tokens.json', 'modes.dark.json', 'guide.md', 'dist/tokens.css', 'dist/manifest.json']) {
      expect(existsSync(path.join(brand, rel)), rel).toBe(true);
    }
    expect(existsSync(path.join(result.proposalDir, 'extraction-report.md'))).toBe(true);
    expect(existsSync(path.join(result.proposalDir, 'raw-extraction.json'))).toBe(true);
    // Screenshot materialized into assets/ (partial-evidence + report link target).
    expect(existsSync(path.join(brand, 'assets', 'example.png'))).toBe(true);
    // Success removes the marker.
    expect(existsSync(path.join(result.proposalDir, 'INCOMPLETE.md'))).toBe(false);

    // manifest records llm:"skipped"; guide has the TODO voice stub.
    const manifest = JSON.parse(readFileSync(path.join(brand, 'dist', 'manifest.json'), 'utf8'));
    expect(manifest.llm).toBe('skipped');
    expect(readFileSync(path.join(brand, 'guide.md'), 'utf8')).toContain(
      'the LLM voice draft was unavailable',
    );

    // tokens pass check (production gate, in-process).
    const report = runCheck(result.proposalDir);
    expect(report.ok, JSON.stringify(report.findings)).toBe(true);
  });

  it('the LLM-used path (fake claude bin) records llm:"used" and a DRAFT voice', async () => {
    const out = tempDir();
    const result = await runFromUrl('https://example.com/', {
      outDir: out,
      engine: fixtureEngine(),
      now: () => CLOCK,
      llm: { spawn: nodeScriptSpawner(fakeBin('claude-ok')) },
    });
    expect(result.status).toBe('complete');
    expect(result.llmManifestStatus).toBe('used');
    const manifest = JSON.parse(
      readFileSync(path.join(result.brandDir, 'dist', 'manifest.json'), 'utf8'),
    );
    expect(manifest.llm).toBe('used');
    const guide = readFileSync(path.join(result.brandDir, 'guide.md'), 'utf8');
    expect(guide).toContain('DRAFT (LLM-generated');
    // The report surfaces the LLM pick + rationale.
    const report = readFileSync(path.join(result.proposalDir, 'extraction-report.md'), 'utf8');
    expect(report).toContain('LLM pick');
  }, 30_000);

  it('a second same-day run lands in -b and never clobbers the first', async () => {
    const out = tempDir();
    const first = await runFromUrl('https://example.com/', {
      outDir: out,
      engine: fixtureEngine(),
      now: () => CLOCK,
      noLlm: true,
    });
    const second = await runFromUrl('https://example.com/', {
      outDir: out,
      engine: fixtureEngine(),
      now: () => CLOCK,
      noLlm: true,
    });
    expect(path.basename(first.proposalDir)).toBe(EXPECTED_DIR);
    expect(path.basename(second.proposalDir)).toBe(`${EXPECTED_DIR}-b`);
    expect(first.proposalDir).not.toBe(second.proposalDir);
    expect(existsSync(first.proposalDir)).toBe(true); // first untouched
    expect(existsSync(second.proposalDir)).toBe(true);
  });

  it('--force reuses the base name instead of disambiguating', async () => {
    const out = tempDir();
    const first = await runFromUrl('https://example.com/', {
      outDir: out,
      engine: fixtureEngine(),
      now: () => CLOCK,
      noLlm: true,
    });
    const forced = await runFromUrl('https://example.com/', {
      outDir: out,
      engine: fixtureEngine(),
      now: () => CLOCK,
      noLlm: true,
      force: true,
    });
    expect(path.basename(forced.proposalDir)).toBe(EXPECTED_DIR);
    expect(forced.proposalDir).toBe(first.proposalDir);
  });

  it('engine killed mid-run -> INCOMPLETE marker, no false "complete"', async () => {
    const out = tempDir();
    class ThrowingEngine implements ExtractionEngine {
      readonly name = 'boom';
      async extract(): Promise<RawExtraction> {
        throw new Error('engine killed mid-run');
      }
    }
    const result = await runFromUrl('https://dead.example/', {
      outDir: out,
      engine: new ThrowingEngine(),
      now: () => CLOCK,
      noLlm: true,
    });
    expect(result.status).toBe('incomplete');
    expect(result.stageFailed).toBe('extract');
    expect(existsSync(result.proposalDir)).toBe(true);
    const markerPath = path.join(result.proposalDir, 'INCOMPLETE.md');
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, 'utf8')).toContain('extract (FAILED)');
  });

  it('a post-extraction failure keeps partial evidence (screenshots + raw-extraction)', async () => {
    const out = tempDir();
    // Extraction succeeds (screenshots + raw-extraction persisted), then normalize
    // fails because the preset skeleton it reads is missing — the marker names it.
    const result = await runFromUrl('https://example.com/', {
      outDir: out,
      engine: fixtureEngine(),
      now: () => CLOCK,
      noLlm: true,
      presetsRoot: path.join(out, 'no-such-presets-root'),
    });
    expect(result.status).toBe('incomplete');
    expect(result.stageFailed).toBe('normalize');
    // Partial evidence survived the failure.
    expect(existsSync(path.join(result.proposalDir, 'raw-extraction.json'))).toBe(true);
    expect(existsSync(path.join(result.brandDir, 'assets', 'example.png'))).toBe(true);
    expect(existsSync(path.join(result.proposalDir, 'INCOMPLETE.md'))).toBe(true);
  });
});

// --- A2. Decision 4: LLM pick threads into shipped tokens + never-clobber edges -

describe('from-url (offline, in-process) — LLM brand-color pick threading', () => {
  it('ships tokens built from the LLM pick, not the heuristic top, when they diverge', async () => {
    const out = tempDir();
    const norm = normalize(TWO_CANDIDATE_EXTRACTION);
    const heuristicSeed = norm.seed;
    const llmPick = norm.seedCandidates[1]!.hex; // rank 2 — the LLM disagrees
    expect(llmPick).not.toBe(heuristicSeed); // divergence precondition

    const result = await runFromUrl('https://two.example/', {
      outDir: out,
      engine: new StaticEngine(TWO_CANDIDATE_EXTRACTION),
      now: () => CLOCK,
      llm: { spawn: pickSpawner(llmPick) },
    });
    expect(result.status).toBe('complete');
    expect(result.llmManifestStatus).toBe('used');

    // brand/tokens.json's brand ramp reflects the LLM-CHOSEN seed, not the heuristic.
    const shipped = JSON.parse(readFileSync(path.join(result.brandDir, 'tokens.json'), 'utf8'));
    const shippedBrand9 = leafValue(shipped, 'color.primitive.brand.9');
    const fromLlmSeed = leafValue(buildTokensForSeed(TWO_CANDIDATE_EXTRACTION, llmPick).tokens, 'color.primitive.brand.9');
    const fromHeuristic = leafValue(buildTokensForSeed(TWO_CANDIDATE_EXTRACTION, heuristicSeed).tokens, 'color.primitive.brand.9');
    expect(fromLlmSeed).not.toBe(fromHeuristic); // the two seeds really differ
    expect(shippedBrand9).toBe(fromLlmSeed);
    expect(shippedBrand9).not.toBe(fromHeuristic);

    // The report labels the LLM pick (not the heuristic seed) as chosen.
    const report = readFileSync(path.join(result.proposalDir, 'extraction-report.md'), 'utf8');
    expect(report).toContain(`**Chosen brand color:** \`${llmPick}\``);
    expect(report).not.toContain(`**Chosen brand color:** \`${heuristicSeed}\``);
    // dist tokens still pass check with the LLM-chosen seed.
    expect(runCheck(result.proposalDir).ok).toBe(true);
  }, 30_000);

  it('when the LLM agrees with the heuristic top, ships the heuristic tokens unchanged', async () => {
    const out = tempDir();
    const norm = normalize(TWO_CANDIDATE_EXTRACTION);
    const result = await runFromUrl('https://two.example/', {
      outDir: out,
      engine: new StaticEngine(TWO_CANDIDATE_EXTRACTION),
      now: () => CLOCK,
      llm: { spawn: pickSpawner(norm.seed) }, // LLM picks rank 1 (== heuristic)
    });
    const shipped = JSON.parse(readFileSync(path.join(result.brandDir, 'tokens.json'), 'utf8'));
    expect(leafValue(shipped, 'color.primitive.brand.9')).toBe(
      leafValue(buildTokensForSeed(TWO_CANDIDATE_EXTRACTION, norm.seed).tokens, 'color.primitive.brand.9'),
    );
  }, 30_000);
});

describe('from-url (offline, in-process) — never-clobber edges', () => {
  it('--force clears stale files from a prior run (no orphaned screenshots linger)', async () => {
    const out = tempDir();
    const first = await runFromUrl('https://example.com/', {
      outDir: out,
      engine: fixtureEngine(),
      now: () => CLOCK,
      noLlm: true,
    });
    // Plant a stale marker file that a clean --force replace must remove.
    const staleMarker = path.join(first.brandDir, 'assets', 'stale-orphan.png');
    writeFileSync(staleMarker, 'stale');
    expect(existsSync(staleMarker)).toBe(true);

    const forced = await runFromUrl('https://example.com/', {
      outDir: out,
      engine: fixtureEngine(),
      now: () => CLOCK,
      force: true,
      noLlm: true,
    });
    expect(forced.proposalDir).toBe(first.proposalDir); // reused base name
    expect(existsSync(staleMarker)).toBe(false); // stale file gone (dir was cleared)
    expect(existsSync(path.join(forced.brandDir, 'assets', 'example.png'))).toBe(true); // fresh evidence present
  });

  it('refuses (throws, writes nothing) when every same-day suffix -b..-y is taken', async () => {
    const out = tempDir();
    const host = hostSlug('https://example.com/');
    // Pre-create the base + every -b..-y suffix dir so resolution is exhausted.
    mkdirSync(path.join(out, `onbrand-proposal-${host}-20260716`), { recursive: true });
    for (let i = 1; i <= 24; i++) {
      const suffix = String.fromCharCode(0x61 + i);
      mkdirSync(path.join(out, `onbrand-proposal-${host}-20260716-${suffix}`), { recursive: true });
    }
    const before = new Set(readdirSync(out));

    await expect(
      runFromUrl('https://example.com/', {
        outDir: out,
        engine: fixtureEngine(),
        now: () => CLOCK,
        noLlm: true,
      }),
    ).rejects.toBeInstanceOf(FromUrlUsageError);

    // Nothing new was created (no partial dir, no INCOMPLETE marker).
    const after = readdirSync(out);
    expect(after.length).toBe(before.size);
    // resolveProposalDir throws directly too (the unit-level guard).
    expect(() => resolveProposalDir(out, host, '20260716', false)).toThrow(FromUrlUsageError);
  });

  it('INCOMPLETE.md markdown-escapes a hostile url (defense-in-depth)', async () => {
    const out = tempDir();
    const result = await runFromUrl('https://x.example/[p](javascript:1)#h', {
      outDir: out,
      engine: new (class implements ExtractionEngine {
        readonly name = 'boom';
        async extract(): Promise<RawExtraction> {
          throw new Error('boom');
        }
      })(),
      now: () => CLOCK,
      noLlm: true,
    });
    expect(result.status).toBe('incomplete');
    const marker = readFileSync(path.join(result.proposalDir, 'INCOMPLETE.md'), 'utf8');
    expect(marker).not.toContain('[p](javascript:1)'); // raw markdown link never survives
    expect(marker).toContain('\\[p\\]'); // escaped instead
  });
});

// --- B. offline, through the spawned production CLI --------------------------

function runCli(args: string[], env: Record<string, string> = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('from-url (offline, spawned production CLI)', () => {
  it('from-url via the env seam produces a proposal that check passes', () => {
    const out = tempDir();
    const res = runCli(['from-url', 'https://example.com/', '--out', out, '--no-llm'], {
      ONBRAND_FAKE_EXTRACTION: EXAMPLE_FIXTURE,
      ONBRAND_NOW: '2026-07-16T12:00:00.000Z',
    });
    expect(res.status, res.stderr).toBe(EXIT_OK);
    const proposal = path.join(out, EXPECTED_DIR);
    expect(statSync(proposal).isDirectory()).toBe(true);

    const check = runCli(['check', proposal]);
    expect(check.status, check.stderr).toBe(EXIT_OK);
    expect(check.stderr).toContain('check PASS');
  }, 60_000);

  it('a dead engine (missing fixture) exits 1 and keeps an INCOMPLETE dir', () => {
    const out = tempDir();
    const res = runCli(['from-url', 'https://example.com/', '--out', out], {
      ONBRAND_FAKE_EXTRACTION: path.join(out, 'does-not-exist.json'),
      ONBRAND_NOW: '2026-07-16T12:00:00.000Z',
    });
    expect(res.status).toBe(EXIT_FAILURE);
    expect(res.stderr).toContain('INCOMPLETE');
    expect(existsSync(path.join(out, EXPECTED_DIR, 'INCOMPLETE.md'))).toBe(true);
  }, 60_000);

  it('missing <url> is a usage error (exit 2)', () => {
    const res = runCli(['from-url']);
    expect(res.status).toBe(EXIT_USAGE);
    expect(res.stderr).toContain('missing <url>');
  });
});

// --- C. live dembrandt against a local static fixture site (env-gated) -------

const LIVE = process.env.ONBRAND_LIVE_FROMURL === '1';
const SITE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'site');

/** Serve the static fixture site on an ephemeral 127.0.0.1 port. */
function serveSite(): Promise<{ server: Server; port: number }> {
  const types: Record<string, string> = { '.html': 'text/html', '.css': 'text/css' };
  const server = createServer((req, res) => {
    const rel = req.url === undefined || req.url === '/' ? '/index.html' : req.url.split('?')[0]!;
    const file = path.join(SITE_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(SITE_DIR) || !existsSync(file)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

/**
 * Async spawn: the LIVE test serves the fixture site from THIS process, so the
 * from-url child must run non-blocking — spawnSync would freeze this event loop
 * and starve the http server, hanging dembrandt to its 120s timeout (diagnosed
 * 2026-07-17). The offline spawned-CLI tests have no in-process server, so they
 * keep the simpler spawnSync.
 */
function spawnCliAsync(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env },
    });
    let stderr = '';
    child.stderr?.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

describe.skipIf(!LIVE)('from-url (LIVE dembrandt + Chromium, ONBRAND_LIVE_FROMURL=1)', () => {
  it('extracts the local fixture site into a complete, check-passing proposal', async () => {
    const { server, port } = await serveSite();
    let res: { status: number | null; stderr: string };
    try {
      const out = tempDir();
      // Non-blocking: the server keeps answering dembrandt while from-url runs.
      res = await spawnCliAsync(['from-url', `http://127.0.0.1:${port}/`, '--out', out, '--no-llm'], {
        ONBRAND_NOW: '2026-07-16T12:00:00.000Z',
      });
      expect(res.status, res.stderr).toBe(EXIT_OK);
      const proposal = path.join(out, 'onbrand-proposal-127.0.0.1-20260716');
      expect(existsSync(path.join(proposal, 'brand', 'dist', 'tokens.css'))).toBe(true);
      // Server no longer needed for the check gate.
      server.close();
      const check = runCli(['check', proposal]);
      expect(check.status, check.stderr).toBe(EXIT_OK);
    } finally {
      server.close();
    }
  }, 180_000);
});
