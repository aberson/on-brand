/**
 * Shared constants for the Step 8 extraction fixtures — imported by both the
 * offline tests (test/extract.*.test.ts) and the regeneration script
 * (gen-extraction-fixtures.ts) so the two can never disagree about what a
 * fixture's screenshot entry looks like.
 */

import type { Screenshot } from '../../src/extract/engine/adapter.ts';

/** The four spike runs (3 fixed sites + the blank-page garbage anchor). */
export const SPIKE_SITES = ['zengarden', 'stripe', 'example', 'blank'] as const;

export type SpikeSite = (typeof SPIKE_SITES)[number];

/**
 * The screenshot entry a spike run carries in its mapped fixture. Paths are
 * repo-relative with forward slashes (diff-legible, OS-independent); the PNGs
 * are the real viewport captures from the 2026-07-16 live runs.
 */
export function screenshotFixture(site: SpikeSite): Screenshot {
  return {
    label: 'viewport',
    path: `test/fixtures/extraction/screenshots/${site}.png`,
    width: 1920,
    height: 1080,
  };
}
