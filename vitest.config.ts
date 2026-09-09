import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 30_000,
    // Issue #85. Hooks fell back to Vitest's 10s default while tests had 30s -
    // an asymmetry nobody chose. Four suites launch real Chromium in beforeAll
    // and close it in afterAll, and under `pool: 'forks'` those lifecycle calls
    // contend, so a browser close could exceed 10s and fail the FILE with zero
    // failed tests. Parity with testTimeout keeps a hard ceiling: a genuinely
    // hung hook still fails, it just is not raced by unrelated load.
    hookTimeout: 30_000,
  },
});
