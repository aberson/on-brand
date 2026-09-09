/**
 * Step 8 spike fixture generator — regenerates the mapped RawExtraction
 * fixtures from the committed raw dembrandt outputs, and prints the coverage
 * table that decided the dembrandt-spike outcome.
 *
 * NOT a test (vitest only picks up test/**\/*.test.ts) and NOT part of any
 * build; running it is a deliberate manual action:
 *
 *   npx tsx test/helpers/gen-extraction-fixtures.ts
 *
 * The raw fixtures under test/fixtures/extraction/dembrandt/ are the verbatim
 * `--json-only` stdout of live dembrandt v0.23.1 runs (2026-07-16, spike);
 * refreshing THOSE requires network + Chromium and happens only in a
 * deliberate re-spike, never in `npm test`.
 *
 * Measurement-validity: the coverage numbers printed here come from the SAME
 * exported functions (coverageOf / meetsMinimumCoverage / isNearEmpty) the
 * offline tests assert against — one code path, no hand-scored table.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MINIMUM_COVERAGE_FIELDS,
  coverageOf,
  isNearEmpty,
  meetsMinimumCoverage,
  substantiveObservationCount,
  type Coverage,
} from '../../src/extract/engine/adapter.ts';
import { mapDembrandtOutput } from '../../src/extract/engine/dembrandt.ts';
import { SPIKE_SITES, screenshotFixture } from './extraction-fixtures.ts';

const EXTRACTION_DIR = fileURLToPath(new URL('../fixtures/extraction/', import.meta.url));

const rows: string[] = [];
for (const site of SPIKE_SITES) {
  const rawPath = path.join(EXTRACTION_DIR, 'dembrandt', `${site}.json`);
  const raw: unknown = JSON.parse(readFileSync(rawPath, 'utf8'));
  const mapped = mapDembrandtOutput(raw, [screenshotFixture(site)]);
  const outPath = path.join(EXTRACTION_DIR, 'raw-extraction', `${site}.json`);
  writeFileSync(outPath, JSON.stringify(mapped, null, 2) + '\n', 'utf8');

  const cov = coverageOf(mapped);
  const covCells = (Object.keys(cov) as Array<keyof Coverage>)
    .map((k) => `${k}=${cov[k] ? 'Y' : 'n'}`)
    .join(' ');
  rows.push(
    `${site.padEnd(10)} minCoverage=${meetsMinimumCoverage(mapped) ? 'MET' : 'not-met'} ` +
      `nearEmpty=${isNearEmpty(mapped) ? 'YES' : 'no'} substantive=${substantiveObservationCount(mapped)} :: ${covCells}`,
  );
}
console.log(`minimum coverage set: ${MINIMUM_COVERAGE_FIELDS.join(', ')}`);
for (const row of rows) console.log(row);
