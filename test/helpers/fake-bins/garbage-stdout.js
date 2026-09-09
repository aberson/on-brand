/**
 * Fake dembrandt bin (Step 8 tests): exits 0 but emits non-JSON stdout,
 * driving DembrandtEngine.extract()'s REAL JSON.parse catch branch.
 */
process.stdout.write('this is not JSON { definitely not');
process.exit(0);
