/**
 * Fake dembrandt bin (Step 8 tests): hangs like dembrandt on a never-loading
 * page — keeps the event loop alive far past any test timeout so the wrapper's
 * own timer must fire, tree-kill the process, and surface the timeout error.
 */
setTimeout(() => {}, 120_000);
