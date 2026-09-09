/**
 * Integration tests for `onbrand brands list|show` (Step 17) and
 * `onbrand gallery` (Step 18) through the PRODUCTION entry point (spawned
 * bin/onbrand.mjs) — plan.md §5, §6.
 *
 * Fixtures are built in-process through compileBrand (fast, deterministic); the
 * commands are exercised as real subprocesses so argument parsing, exit codes,
 * stdout, and the written gallery artifact are all covered end to end. The
 * load-bearing assertion: a proposal is never reported/rendered as final, and
 * excluded trees are not listed. Human visual review of the gallery is Step 22.
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { compileBrand } from '../src/build/compile.ts';
import { generatePreview } from '../src/preview/specimen.ts';
import { EXIT_OK, EXIT_USAGE } from '../src/cli.ts';

const BIN = fileURLToPath(new URL('../bin/onbrand.mjs', import.meta.url));
const PRESET_DIR = fileURLToPath(new URL('../templates/presets/default', import.meta.url));

const tempDirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-cli-brands-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function scaffoldAndBuild(root: string): string {
  const brand = path.join(root, 'brand');
  mkdirSync(brand, { recursive: true });
  copyFileSync(path.join(PRESET_DIR, 'tokens.json'), path.join(brand, 'tokens.json'));
  copyFileSync(path.join(PRESET_DIR, 'modes.dark.json'), path.join(brand, 'modes.dark.json'));
  compileBrand(root);
  return root;
}

interface JsonBrand {
  name: string;
  relPath: string;
  status: string;
  final: boolean;
  provenance: string;
  hasDist: boolean;
}

/** A workspace with one adopted brand, one complete proposal, one excluded brand. */
function mixedWorkspace(): string {
  const ws = workspace();
  scaffoldAndBuild(path.join(ws, 'app')); // adopted
  scaffoldAndBuild(path.join(ws, 'onbrand-proposal-acme-20260101')); // proposal
  scaffoldAndBuild(path.join(ws, 'node_modules', 'pkg')); // excluded
  return ws;
}

describe('onbrand brands (spawned through bin/onbrand.mjs)', () => {
  it('list --json reports an adopted brand and a proposal, and NEVER labels the proposal final', () => {
    const ws = mixedWorkspace();
    const run = runCli(['brands', 'list', '--root', ws, '--json']);
    expect(run.status).toBe(EXIT_OK);

    const parsed = JSON.parse(run.stdout) as { root: string; count: number; brands: JsonBrand[] };
    expect(parsed.count).toBe(2); // node_modules brand excluded
    const byRel = new Map(parsed.brands.map((b) => [b.relPath, b]));

    const app = byRel.get('app')!;
    expect(app.status).toBe('adopted');
    expect(app.final).toBe(true);
    expect(app.provenance).toBe('adopted');

    const proposal = byRel.get('onbrand-proposal-acme-20260101')!;
    expect(proposal.status).toBe('proposal');
    expect(proposal.final).toBe(false);
    expect(proposal.provenance).toBe('proposal');

    // Structural guarantee across the whole list: nothing that is a proposal is final.
    for (const b of parsed.brands) {
      if (b.provenance === 'proposal') expect(b.final).toBe(false);
      if (b.final) expect(b.status).toBe('adopted');
    }
  });

  it('list (text) prints a status table and does not surface excluded trees', () => {
    const ws = mixedWorkspace();
    const run = runCli(['brands', 'list', '--root', ws]);
    expect(run.status).toBe(EXIT_OK);
    expect(run.stdout).toContain('adopted');
    expect(run.stdout).toContain('proposal');
    expect(run.stdout).toContain('app');
    expect(run.stdout).toContain('onbrand-proposal-acme-20260101');
    expect(run.stdout).not.toContain('node_modules');
  });

  it('show <relPath> --json returns exactly that brand', () => {
    const ws = mixedWorkspace();
    const run = runCli([
      'brands',
      'show',
      'onbrand-proposal-acme-20260101',
      '--root',
      ws,
      '--json',
    ]);
    expect(run.status).toBe(EXIT_OK);
    const b = JSON.parse(run.stdout) as JsonBrand;
    expect(b.relPath).toBe('onbrand-proposal-acme-20260101');
    expect(b.status).toBe('proposal');
    expect(b.final).toBe(false);
  });

  it('show with no selector shows the sole brand, but demands a name when ambiguous', () => {
    const ws = workspace();
    scaffoldAndBuild(path.join(ws, 'only'));
    const single = runCli(['brands', 'show', '--root', ws, '--json']);
    expect(single.status).toBe(EXIT_OK);
    expect((JSON.parse(single.stdout) as JsonBrand).relPath).toBe('only');

    const many = mixedWorkspace();
    const ambiguous = runCli(['brands', 'show', '--root', many]);
    expect(ambiguous.status).toBe(EXIT_USAGE);
    expect(ambiguous.stderr).toContain('name one');
  });

  it('show with an unknown selector is a usage error listing the known brands', () => {
    const ws = mixedWorkspace();
    const run = runCli(['brands', 'show', 'nope', '--root', ws]);
    expect(run.status).toBe(EXIT_USAGE);
    expect(run.stderr).toContain('no brand matches');
    expect(run.stderr).toContain('app');
  });

  it('requires a relPath when a basename selector is ambiguous', () => {
    const ws = workspace();
    scaffoldAndBuild(path.join(ws, 'clients', 'acme'));
    scaffoldAndBuild(path.join(ws, 'vendors', 'acme'));

    const ambiguous = runCli(['brands', 'show', 'acme', '--root', ws]);
    expect(ambiguous.status).toBe(EXIT_USAGE);
    expect(ambiguous.stderr).toContain('ambiguous');
    expect(ambiguous.stderr).toContain('clients/acme');
    expect(ambiguous.stderr).toContain('vendors/acme');

    const exact = runCli(['brands', 'show', 'vendors/acme', '--root', ws, '--json']);
    expect(exact.status).toBe(EXIT_OK);
    expect((JSON.parse(exact.stdout) as JsonBrand).relPath).toBe('vendors/acme');
  });

  it('requires --root and rejects an unknown subcommand', () => {
    const noRoot = runCli(['brands', 'list']);
    expect(noRoot.status).toBe(EXIT_USAGE);
    expect(noRoot.stderr).toContain('--root');

    const badSub = runCli(['brands', 'frobnicate', '--root', workspace()]);
    expect(badSub.status).toBe(EXIT_USAGE);
    expect(badSub.stderr).toContain('unknown subcommand');
  });

  it('reports a missing --root path as a usage error', () => {
    const run = runCli(['brands', 'list', '--root', path.join(workspace(), 'nope')]);
    expect(run.status).toBe(EXIT_USAGE);
    expect(run.stderr).toContain('does not exist');
  });

  it('reports a file-valued --root as a usage error', () => {
    const ws = workspace();
    const file = path.join(ws, 'not-a-directory.txt');
    writeFileSync(file, 'not a workspace', 'utf8');
    const run = runCli(['brands', 'list', '--root', file]);
    expect(run.status).toBe(EXIT_USAGE);
    expect(run.stderr).toContain('existing directory');
  });

  it('brands --help documents list/show and exits 0', () => {
    const run = runCli(['brands', '--help']);
    expect(run.status).toBe(EXIT_OK);
    expect(run.stdout).toContain('list');
    expect(run.stdout).toContain('show');
    expect(run.stdout).toContain('--root');
  });

  it('is advertised in the top-level usage', () => {
    const run = runCli(['--help']);
    expect(run.status).toBe(EXIT_OK);
    expect(run.stdout).toContain('brands list|show');
  });
});

describe('onbrand gallery (spawned through bin/onbrand.mjs)', () => {
  it('writes a static gallery HTML at the default path and reports counts', () => {
    const ws = mixedWorkspace();
    const run = runCli(['gallery', '--root', ws]);
    expect(run.status).toBe(EXIT_OK);

    const outPath = path.join(ws, 'onbrand-gallery.html');
    expect(existsSync(outPath)).toBe(true);
    expect(run.stdout).toContain(outPath);
    // node_modules brand excluded -> exactly 2 discovered, 1 final, 1 proposal.
    expect(run.stdout).toContain('2 brand set(s)');
    expect(run.stdout).toContain('1 final');
    expect(run.stdout).toContain('1 proposal');
  });

  it('separates the adopted (final) brand from the proposal and NEVER labels the proposal final', () => {
    const ws = mixedWorkspace();
    const run = runCli(['gallery', '--root', ws]);
    expect(run.status).toBe(EXIT_OK);
    const html = readFileSync(path.join(ws, 'onbrand-gallery.html'), 'utf8');

    // The adopted brand carries the final affordance.
    expect(html).toContain('<span class="badge final">Final</span>');
    expect(html).toContain('id="brand-app" data-final="true"');

    // The proposal is present, provenance=proposal, and data-final="false".
    expect(html).toContain('data-provenance="proposal"');
    expect(html).toContain('id="brand-onbrand-proposal-acme-20260101" data-final="false"');

    // Structural guarantee: no article that is a proposal is also final.
    const proposalArticles = [
      ...html.matchAll(/<article class="brand"[^>]*data-provenance="proposal"[^>]*>/g),
    ];
    expect(proposalArticles.length).toBe(1);
    for (const m of proposalArticles) expect(m[0]).toContain('data-final="false"');

    // Excluded tree never surfaces.
    expect(html).not.toContain('node_modules');
  });

  it('links a built brand specimen (relative href) once one exists', () => {
    const ws = workspace();
    const app = scaffoldAndBuild(path.join(ws, 'app'));
    // Produce the specimen the gallery links (build + preview are separate
    // commands; the gallery never rebuilds — it only links what already exists).
    generatePreview(app);

    const run = runCli(['gallery', '--root', ws]);
    expect(run.status).toBe(EXIT_OK);
    const html = readFileSync(path.join(ws, 'onbrand-gallery.html'), 'utf8');
    expect(html).toContain('>Open final specimen</a>');
    expect(html).toContain('href="./app/brand/dist/specimen.html"');
  });

  it('honors --out and computes specimen hrefs relative to that file', () => {
    const ws = workspace();
    const app = scaffoldAndBuild(path.join(ws, 'app'));
    generatePreview(app);
    const outFile = path.join(ws, 'reports', 'gallery.html');

    const run = runCli(['gallery', '--root', ws, '--out', outFile]);
    expect(run.status).toBe(EXIT_OK);
    expect(existsSync(outFile)).toBe(true);
    const html = readFileSync(outFile, 'utf8');
    // From <ws>/reports/ up to <ws>/app/brand/dist/specimen.html.
    expect(html).toContain('href="../app/brand/dist/specimen.html"');
  });

  it('shows a "run onbrand preview" hint for a built-but-un-previewed brand', () => {
    const ws = workspace();
    scaffoldAndBuild(path.join(ws, 'app'));
    const run = runCli(['gallery', '--root', ws]);
    expect(run.status).toBe(EXIT_OK);
    const html = readFileSync(path.join(ws, 'onbrand-gallery.html'), 'utf8');
    expect(html).toContain('No specimen built yet');
    expect(html).not.toContain('<a class="specimen-link"');
  });

  it('renders an empty-state gallery for a workspace with no brands', () => {
    const ws = workspace();
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    const run = runCli(['gallery', '--root', ws]);
    expect(run.status).toBe(EXIT_OK);
    const html = readFileSync(path.join(ws, 'onbrand-gallery.html'), 'utf8');
    expect(html).toContain('No brand/ sets were discovered');
  });

  it('requires --root', () => {
    const run = runCli(['gallery']);
    expect(run.status).toBe(EXIT_USAGE);
    expect(run.stderr).toContain('--root');
  });

  it('reports a missing --root path as a usage error', () => {
    const run = runCli(['gallery', '--root', path.join(workspace(), 'nope')]);
    expect(run.status).toBe(EXIT_USAGE);
    expect(run.stderr).toContain('does not exist');
  });

  it('reports a file-valued --root as a usage error', () => {
    const ws = workspace();
    const file = path.join(ws, 'not-a-directory.txt');
    writeFileSync(file, 'not a workspace', 'utf8');
    const run = runCli(['gallery', '--root', file]);
    expect(run.status).toBe(EXIT_USAGE);
    expect(run.stderr).toContain('existing directory');
  });

  it('rejects an unknown flag', () => {
    const run = runCli(['gallery', '--root', workspace(), '--frobnicate']);
    expect(run.status).toBe(EXIT_USAGE);
    expect(run.stderr).toContain('unknown flag');
  });

  it('gallery --help documents --root/--out/--open and exits 0', () => {
    const run = runCli(['gallery', '--help']);
    expect(run.status).toBe(EXIT_OK);
    expect(run.stdout).toContain('--root');
    expect(run.stdout).toContain('--out');
    expect(run.stdout).toContain('--open');
  });

  it('is advertised in the top-level usage', () => {
    const run = runCli(['--help']);
    expect(run.status).toBe(EXIT_OK);
    expect(run.stdout).toContain('gallery --root');
  });
});
