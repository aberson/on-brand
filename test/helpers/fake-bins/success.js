/**
 * Fake dembrandt bin (Step 8 tests): the happy path. Mimics dembrandt's
 * observable contract — `--json-only` JSON on stdout, progress noise on
 * stderr, and a file written at the `--screenshot <path>` argument — so the
 * offline suite can run DembrandtEngine.extract() end-to-end (spawn, stream
 * accumulation, JSON parse, screenshot injection, mapping) with no network.
 *
 * argv shape (what the wrapper passes): <url> --json-only [--screenshot <path>]
 */
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const url = args[0] ?? 'https://missing.example';
const shotFlag = args.indexOf('--screenshot');
if (shotFlag !== -1 && args[shotFlag + 1] !== undefined) {
  writeFileSync(args[shotFlag + 1], 'fake png bytes for existence check only');
}

process.stderr.write('- Starting extraction (fake)...\n');

const payload = {
  url,
  extractedAt: '2026-07-16T00:00:00.000Z',
  meta: { dembrandtVersion: '0.23.1-fake', schemaVersion: '1.2.0', flags: {} },
  colors: {
    semantic: { background: 'rgb(255, 255, 255)', text: 'rgb(17, 17, 17)' },
    palette: [],
    cssVariables: {},
    detected: [
      { color: 'rgb(17, 17, 17)', normalized: '#111111', count: 9, confidence: 'high', sources: [] },
    ],
  },
  typography: {
    styles: [
      {
        context: 'body',
        family: 'Fake Sans',
        fallbacks: null,
        size: '16px (1.00rem)',
        weight: 400,
        lineHeight: '1.50',
        spacing: null,
        transform: null,
      },
    ],
    sources: {},
  },
  spacing: { scaleType: '8px', commonValues: [{ px: '8px', count: 3, numericValue: 8 }] },
  borderRadius: { values: [] },
  borders: { combinations: [] },
  shadows: [],
  gradients: [],
  motion: {},
  components: { buttons: [], inputs: {}, links: [], badges: {} },
};

process.stdout.write(JSON.stringify(payload));
