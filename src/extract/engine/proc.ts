/**
 * Shared subprocess utilities for the extraction engines and the LLM-assist
 * wrapper — one source of truth for process-tree teardown (code-quality rule:
 * no duplicate definitions of a behavior that drifts).
 *
 * `killTree` was first written for the dembrandt wrapper (Step 8, where killing
 * only the immediate node child orphaned its Playwright Chromium subprocess);
 * Step 11's `claude` CLI wrapper needs the identical reap (a `claude -p` run can
 * spawn helper processes), so the function lives here and BOTH import it.
 */

import { spawnSync } from 'node:child_process';

/**
 * Kill a child process AND its descendants. A subprocess CLI (dembrandt's
 * Chromium, or the claude CLI's own helpers) is orphaned if only the immediate
 * process is killed. Windows: `taskkill /T /F` reaps the whole tree (workspace
 * lesson: subprocess tree-kill on Windows). POSIX: SIGKILL the child; the
 * child's own teardown is not relied on.
 */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already exited — nothing to reap
    }
  }
}
