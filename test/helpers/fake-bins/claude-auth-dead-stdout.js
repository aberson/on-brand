/**
 * Fake `claude` CLI bin (Step 9 review finding 1, #38): auth is dead, but —
 * unlike `claude-auth-dead.js` (which writes the marker to stderr) — this
 * fake bin reproduces the REAL shape observed on this workspace's installed
 * claude CLI (v2.1.170): the "Failed to authenticate" message prints to
 * STDOUT, stderr is clean, and the exit code is nonzero. This pins the
 * empirical premise `isAuthShaped`'s stdout+stderr check rests on — the OLD
 * stderr-only check would have silently misclassified this exact shape as a
 * generic 'nonzero' failure instead of 'auth-dead'.
 */
process.stdout.write(
  'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.\n',
);
process.exitCode = 1;
