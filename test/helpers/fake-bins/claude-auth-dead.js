/**
 * Fake `claude` CLI bin (Step 11 tests): auth is dead. Exits nonzero with an
 * auth-shaped stderr message, driving llm.ts's classifySpawn() -> 'auth-dead'
 * branch: the assist stops spawning and reports status 'skipped' with an
 * auth reason (no pointless retry against a dead token).
 */
process.stderr.write('Invalid API key. Please run /login to authenticate (OAuth token expired).\n');
process.exit(1);
