/**
 * Step 21 contract tests. The artifact is intentionally tested without any
 * dev-observatory import: on-brand produces a portable file only.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { compileBrand } from '../src/build/compile.ts';
import { EXIT_OK, EXIT_USAGE } from '../src/cli.ts';
import {
  DEFAULT_OBSERVATORY_ARTIFACT_FILENAME,
  OBSERVATORY_ARTIFACT_SCHEMA,
  OBSERVATORY_ARTIFACT_SCHEMA_VERSION,
  buildObservatoryArtifact,
  exportObservatoryArtifact,
  type ObservatoryArtifact,
} from '../src/gallery/observatory-export.ts';
import { generatePreview } from '../src/preview/specimen.ts';

const BIN = fileURLToPath(new URL('../bin/onbrand.mjs', import.meta.url));
const PRESET_DIR = fileURLToPath(new URL('../templates/presets/default', import.meta.url));
const CONTRACT_FIXTURE = fileURLToPath(new URL('./fixtures/gallery/observatory-v1.json', import.meta.url));
const tempDirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-observatory-export-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function scaffoldAndBuild(root: string): string {
  const brand = path.join(root, 'brand');
  mkdirSync(brand, { recursive: true });
  copyFileSync(path.join(PRESET_DIR, 'tokens.json'), path.join(brand, 'tokens.json'));
  copyFileSync(path.join(PRESET_DIR, 'modes.dark.json'), path.join(brand, 'modes.dark.json'));
  compileBrand(root);
  return root;
}

function mixedWorkspace(): { root: string; app: string; stale: string } {
  const root = workspace();
  const app = scaffoldAndBuild(path.join(root, 'app'));
  scaffoldAndBuild(path.join(root, 'onbrand-proposal-acme-20260101'));
  const stale = scaffoldAndBuild(path.join(root, 'stale-app'));
  const tokensPath = path.join(stale, 'brand', 'tokens.json');
  writeFileSync(
    tokensPath,
    readFileSync(tokensPath, 'utf8').replace('#3b63a8', '#0000aa'),
    'utf8',
  );
  generatePreview(app);
  return { root, app, stale };
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('on-brand observatory artifact', () => {
  it('round-trips adopted, proposal, and stale states with relative paths and structured checks', () => {
    const { root } = mixedWorkspace();
    const artifact = buildObservatoryArtifact({
      root,
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    });
    const roundTripped = JSON.parse(JSON.stringify(artifact)) as ObservatoryArtifact;

    expect(roundTripped.schema).toBe(OBSERVATORY_ARTIFACT_SCHEMA);
    expect(roundTripped.schemaVersion).toBe(OBSERVATORY_ARTIFACT_SCHEMA_VERSION);
    expect(roundTripped.generatedAt).toBe('2026-08-08T12:00:00.000Z');
    expect(roundTripped.summary).toMatchObject({
      discoveredBrandCount: 3,
      emittedBrandCount: 3,
      brandsTruncated: false,
      finalCount: 1,
      proposalCount: 1,
      statusCounts: { adopted: 1, proposal: 1, stale: 1 },
    });

    const byPath = new Map(roundTripped.brands.map((brand) => [brand.relPath, brand]));
    const adopted = byPath.get('app')!;
    expect(adopted).toMatchObject({
      status: 'adopted',
      provenance: 'adopted',
      final: true,
      specimenPath: 'app/brand/dist/specimen.html',
    });

    const proposal = byPath.get('onbrand-proposal-acme-20260101')!;
    expect(proposal).toMatchObject({ status: 'proposal', provenance: 'proposal', final: false });

    const stale = byPath.get('stale-app')!;
    expect(stale).toMatchObject({ status: 'stale', final: false, check: { state: 'available', ok: false } });
    if (stale.check.state === 'available') {
      expect(stale.check.findings.some((finding) => finding.code === 'stale-dist-output-outdated')).toBe(true);
      expect(stale.check.findings.every((finding) => finding.nextCommand.length > 0)).toBe(true);
    }

    // The producer must not leak a machine-specific workspace path into the portable artifact.
    expect(JSON.stringify(roundTripped)).not.toContain(root);
    expect(JSON.stringify(roundTripped)).not.toContain('brandDir');
  });

  it('writes only the artifact and does not rebuild a stale consumer', () => {
    const { root, stale } = mixedWorkspace();
    const manifestPath = path.join(stale, 'brand', 'dist', 'manifest.json');
    const before = readFileSync(manifestPath, 'utf8');
    const out = path.join(root, 'reports', 'brands.json');
    const result = exportObservatoryArtifact({
      root,
      out,
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    });

    expect(result.outPath).toBe(path.resolve(out));
    expect(result.bytes).toBeGreaterThan(0);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(manifestPath, 'utf8')).toBe(before);
    expect((JSON.parse(readFileSync(out, 'utf8')) as ObservatoryArtifact).brands).toHaveLength(3);
  });

  it('redacts an invalid brand\'s workspace path before it crosses the artifact boundary', () => {
    const root = workspace();
    const invalid = scaffoldAndBuild(path.join(root, 'invalid-app'));
    const tokensPath = path.join(invalid, 'brand', 'tokens.json');
    const tokens = JSON.parse(readFileSync(tokensPath, 'utf8')) as {
      color: { semantic: { bg: { $value: unknown } } };
    };
    tokens.color.semantic.bg.$value = 42;
    writeFileSync(tokensPath, `${JSON.stringify(tokens, null, 2)}\n`, 'utf8');

    const artifact = buildObservatoryArtifact({ root, now: () => new Date('2026-08-08T12:00:00.000Z') });
    const brand = artifact.brands[0]!;
    expect(brand.status).toBe('invalid');
    expect(brand.error).toContain('<workspace>');
    expect(JSON.stringify(artifact)).not.toContain(root);
  });

  it('redacts every absolute path in an invalid extends diagnostic', () => {
    const root = workspace();
    const app = scaffoldAndBuild(path.join(root, 'app'));
    const tokensPath = path.join(app, 'brand', 'tokens.json');
    const tokens = JSON.parse(readFileSync(tokensPath, 'utf8')) as Record<string, unknown>;
    const external = path.join(path.dirname(root), 'outside', 'missing-base.json');
    const extensions = tokens.$extensions as { onbrand: Record<string, unknown> };
    extensions.onbrand.extends = external;
    writeFileSync(tokensPath, `${JSON.stringify(tokens, null, 2)}\n`, 'utf8');

    const artifact = buildObservatoryArtifact({ root, now: () => new Date('2026-08-08T12:00:00.000Z') });
    const serialized = JSON.stringify(artifact);
    expect(artifact.brands[0]!.status).toBe('invalid');
    expect(serialized).not.toContain(external);
    expect(serialized).not.toMatch(/[a-z]:[\\/]/i);
  });

  it('rejects linked dist payloads rather than exporting outside output as current', () => {
    const root = workspace();
    const app = scaffoldAndBuild(path.join(root, 'app'));
    const outside = scaffoldAndBuild(path.join(root, 'outside'));
    generatePreview(outside);
    const localDist = path.join(app, 'brand', 'dist');
    rmSync(localDist, { recursive: true, force: true });
    symlinkSync(path.join(outside, 'brand', 'dist'), localDist, 'junction');

    const brand = buildObservatoryArtifact({ root, now: () => new Date('2026-08-08T12:00:00.000Z') })
      .brands.find((candidate) => candidate.relPath === 'app')!;
    expect(brand).toMatchObject({ status: 'invalid', hasDist: false, check: { state: 'unavailable' } });
    expect(brand.specimenPath).toBeUndefined();
  });

  it('preserves long semantic locators and token group names rather than silently truncating them', () => {
    const root = workspace();
    const app = scaffoldAndBuild(path.join(root, 'app'));
    const tokensPath = path.join(app, 'brand', 'tokens.json');
    const tokens = JSON.parse(readFileSync(tokensPath, 'utf8')) as Record<string, unknown>;
    const longCategory = `colour-${'x'.repeat(200)}`;
    tokens[longCategory] = { $type: 'color', oops: { $value: '#123456' } };
    writeFileSync(tokensPath, `${JSON.stringify(tokens, null, 2)}\n`, 'utf8');

    const brand = buildObservatoryArtifact({ root, now: () => new Date('2026-08-08T12:00:00.000Z') }).brands[0]!;
    expect(brand.tokenGroups).toContain(longCategory);
    if (brand.check.state === 'available') {
      expect(
        brand.check.findings.find((finding) => finding.code === 'schema-unknown-top-level-category')?.path,
      ).toBe(longCategory);
    }
  });

  it('refuses output paths outside the workspace or inside a brand payload', () => {
    const { root, app } = mixedWorkspace();
    const tokensPath = path.join(app, 'brand', 'tokens.json');
    const before = readFileSync(tokensPath, 'utf8');
    expect(() => exportObservatoryArtifact({ root, out: tokensPath })).toThrow(/must not be inside a brand/);
    expect(readFileSync(tokensPath, 'utf8')).toBe(before);
    expect(() => exportObservatoryArtifact({ root, out: path.join(path.dirname(root), 'outside.json') })).toThrow(
      /must resolve inside/,
    );
  });

  it('refuses a linked output ancestor that aliases a brand payload', () => {
    const { root, app } = mixedWorkspace();
    const tokensPath = path.join(app, 'brand', 'tokens.json');
    const before = readFileSync(tokensPath, 'utf8');
    const reports = path.join(root, 'reports');
    mkdirSync(reports, { recursive: true });
    symlinkSync(path.join(app, 'brand'), path.join(reports, 'alias'), 'junction');

    expect(() => exportObservatoryArtifact({ root, out: path.join(reports, 'alias', 'tokens.json') })).toThrow(
      /must not traverse linked/,
    );
    expect(readFileSync(tokensPath, 'utf8')).toBe(before);
  });

  it('keeps a committed v1 fixture parseable and representative of the three key states', () => {
    const fixture = JSON.parse(readFileSync(CONTRACT_FIXTURE, 'utf8')) as ObservatoryArtifact;
    expect(fixture.schema).toBe(OBSERVATORY_ARTIFACT_SCHEMA);
    expect(fixture.schemaVersion).toBe(OBSERVATORY_ARTIFACT_SCHEMA_VERSION);
    expect(new Set(fixture.brands.map((brand) => brand.status))).toEqual(
      new Set(['adopted', 'proposal', 'stale']),
    );
    expect(fixture.brands.find((brand) => brand.status === 'proposal')!.final).toBe(false);
    const stale = fixture.brands.find((brand) => brand.status === 'stale')!;
    expect(stale.check.state).toBe('available');
    for (const brand of fixture.brands) {
      const expectedId = `brand-${createHash('sha256').update(brand.relPath).digest('hex').slice(0, 24)}`;
      expect(brand.id).toBe(expectedId);
    }
  });
});

describe('onbrand observatory-export (spawned production CLI)', () => {
  it('writes the default artifact and advertises its versioned file contract', () => {
    const { root } = mixedWorkspace();
    const run = runCli(['observatory-export', '--root', root]);
    expect(run.status).toBe(EXIT_OK);
    expect(run.stdout).toContain('onbrand.observatory v1');
    expect(existsSync(path.join(root, DEFAULT_OBSERVATORY_ARTIFACT_FILENAME))).toBe(true);
  });

  it('requires an explicit root and documents --out', () => {
    const missing = runCli(['observatory-export']);
    expect(missing.status).toBe(EXIT_USAGE);
    expect(missing.stderr).toContain('--root');

    const help = runCli(['observatory-export', '--help']);
    expect(help.status).toBe(EXIT_OK);
    expect(help.stdout).toContain('--out');
  });
});
