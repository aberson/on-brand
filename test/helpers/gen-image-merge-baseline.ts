/**
 * Step 41 output-preservation baseline generator.
 *
 * NOT a test (vitest only collects `test/ ** /*.test.ts`) and NOT part of any
 * build; running it is a deliberate manual action:
 *
 *   npx tsx test/helpers/gen-image-merge-baseline.ts
 *
 * It runs the CURRENT `analyzeImageRaster()` / `measureImagePalette()` over the
 * seeded PNG/JPEG/WebP fixtures at low, medium, and high cardinality and pins the
 * full merged pool, the per-pixel identity map, and the serialised evidence into
 * `test/fixtures/image-merge/baseline.json`.
 *
 * SEQUENCING MATTERS.  The committed document was generated from the pre-change
 * merge (commit 88bc3d2) precisely so it can prove the Phase I2I2B speedup did
 * not move a single cluster.  Regenerating it after an implementation change
 * would pin the NEW behaviour and destroy the gate.
 *
 * That is not left to prose.  Two mechanical controls stand in the way:
 *
 *   1. This script REFUSES to overwrite an existing baseline. Re-blessing takes
 *      an explicit `--rebaseline` flag, so it can never be the accidental
 *      consequence of "let me just re-run the generator".
 *   2. Every run records the commit and the CRLF-normalized digest of the
 *      implementation it measured. `test/extract.image-palette.test.ts` pins
 *      both, and asserts the recorded digest DIFFERS from the current
 *      `src/extract/image-palette.ts` — so a baseline regenerated against the
 *      code under test turns the suite red instead of silently blessing itself.
 *
 * Only regenerate when a fixture definition itself changes, and say so
 * explicitly in the commit message.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeImageRaster, measureImagePalette } from '../../src/extract/image-palette.ts';
import {
  MERGE_FIXTURES,
  MERGE_SOURCE_MODULE,
  type MergeBaselineDocument,
  type MergeBaselineEntry,
  pixelClustersDigest,
  sha256Hex,
  sourceDigest,
  workingRasterOf,
  writeMergeFixtures,
} from './image-merge-fixtures.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT_PATH = path.join(REPO_ROOT, 'test', 'fixtures', 'image-merge', 'baseline.json');
const REBASELINE_FLAG = '--rebaseline';

// Control 1: never overwrite an existing baseline by accident. A red
// output-preservation test means a palette moved; it does not mean the fixture
// is stale, and re-running this script must not be the reflex that hides it.
if (existsSync(OUT_PATH) && !process.argv.includes(REBASELINE_FLAG)) {
  console.error(
    `refusing to overwrite ${path.relative(REPO_ROOT, OUT_PATH)}.\n\n` +
      'This document pins the output of the PRE-change merge. If an output-preservation\n' +
      'test is red, the merge changed what it produces - that is the finding. Regenerating\n' +
      'this file would erase the evidence and permanently destroy the gate.\n\n' +
      `Only if a FIXTURE DEFINITION itself changed, re-run with ${REBASELINE_FLAG} and say so\n` +
      'explicitly in the commit message. The recorded source digest will change, and\n' +
      'test/extract.image-palette.test.ts will require that change to be made deliberately.',
  );
  process.exit(1);
}

function currentCommit(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git rev-parse HEAD failed (status ${result.status}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

// Control 2: record WHICH implementation was measured, so the claim that this
// baseline predates the code under test is checkable rather than asserted.
const measuredSource = {
  commit: currentCommit(),
  module: MERGE_SOURCE_MODULE,
  moduleSha256: sourceDigest(path.join(REPO_ROOT, MERGE_SOURCE_MODULE)),
};

const scratch = mkdtempSync(path.join(os.tmpdir(), 'onbrand-merge-baseline-'));
try {
  const files = await writeMergeFixtures(scratch);
  const fixtures: Record<string, MergeBaselineEntry> = {};

  for (const spec of MERGE_FIXTURES) {
    const file = files.get(spec.id)!;
    const bytes = readFileSync(file);
    const working = await workingRasterOf(bytes);

    const analyzeStart = performance.now();
    const analysis = analyzeImageRaster(working);
    const analyzeMs = performance.now() - analyzeStart;

    const measureStart = performance.now();
    const evidence = await measureImagePalette(file);
    const measureMs = performance.now() - measureStart;

    fixtures[spec.id] = {
      cardinality: spec.cardinality,
      format: spec.format,
      sourceWidth: spec.width,
      sourceHeight: spec.height,
      workingWidth: working.width,
      workingHeight: working.height,
      assetSha256: sha256Hex(bytes),
      clusterCount: analysis.clusters.length,
      clustersSha256: sha256Hex(JSON.stringify(analysis.clusters)),
      clustersHead: analysis.clusters.slice(0, 8),
      pixelClusterCount: analysis.pixelClusters.length,
      pixelClustersSha256: pixelClustersDigest(analysis.pixelClusters),
      evidence: JSON.parse(
        JSON.stringify({ ...evidence, source: { ...evidence.source, assetPath: spec.id } }),
      ) as unknown,
    };

    console.log(
      `${spec.id.padEnd(13)} clusters=${String(analysis.clusters.length).padStart(4)} ` +
        `samples=${evidence.samples.length} analyze=${analyzeMs.toFixed(0)}ms measure=${measureMs.toFixed(0)}ms`,
    );
  }

  const document: MergeBaselineDocument = {
    note:
      'Pinned pre-change output of analyzeImageRaster()/measureImagePalette() for the Step 41 ' +
      'merge speedup. Generated once from the pre-change implementation; regenerating it after ' +
      'an implementation change would pin the new behaviour and destroy the output-preservation gate. ' +
      'The generator refuses to overwrite this file without --rebaseline, and the source block below ' +
      'is pinned by test/extract.image-palette.test.ts.',
    generator: 'test/helpers/gen-image-merge-baseline.ts',
    source: measuredSource,
    fixtures,
  };
  writeFileSync(OUT_PATH, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  console.log(`wrote ${OUT_PATH}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
