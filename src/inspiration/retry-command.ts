/** Shell-specific rendering for copy-pasteable inspiration-export retries. */

/**
 * Render a PowerShell command whose executable and argument boundaries remain
 * literal even when paths contain whitespace, apostrophes, or metacharacters.
 */
export function renderPowerShellInspirationExportRetry(
  nodeExecutable: string,
  binPath: string,
  root: string,
  out: string,
): string {
  return `& ${powerShellQuote(nodeExecutable)} ${powerShellQuote(binPath)} inspiration-export --root ${powerShellQuote(root)} --out ${powerShellQuote(out)}`;
}

/** Render the equivalent argv-preserving command for POSIX shells. */
export function renderPosixInspirationExportRetry(
  nodeExecutable: string,
  binPath: string,
  root: string,
  out: string,
): string {
  return `${posixQuote(nodeExecutable)} ${posixQuote(binPath)} inspiration-export --root ${posixQuote(root)} --out ${posixQuote(out)}`;
}

function powerShellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}
