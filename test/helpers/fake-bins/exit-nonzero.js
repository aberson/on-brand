/**
 * Fake dembrandt bin (Step 8 tests): fails like dembrandt does on an
 * unreachable site — writes to stderr and exits nonzero. Lets the offline
 * suite drive DembrandtEngine.extract()'s REAL nonzero-exit branch (spawn,
 * stream accumulation, error construction) with no network and no dembrandt.
 */
process.stderr.write('deliberate failure from fake bin\n');
process.exit(3);
