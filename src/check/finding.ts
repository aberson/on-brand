/**
 * Shared finding shape for the `onbrand check` gate — the leaf type every
 * checker (contrast, lint, drift) produces and the orchestrator aggregates.
 *
 * Severity drives the exit code (src/check/run.ts): any `error` -> exit 1;
 * `warning` / `advisory` never fail the gate (they are reported for the
 * operator). `--strict` is what turns a sub-threshold APCA advisory into an
 * error (plan.md §9.8).
 */

export type Severity = 'error' | 'warning' | 'advisory';

/** Plain-language groups for every check finding. */
export type FindingCategory = 'wcag' | 'apca' | 'schema' | 'stale-dist';

/**
 * Stable machine-readable finding identifiers. New values may be added in a
 * future report schema version, but an existing value never changes meaning.
 */
export type FindingCode =
  | 'wcag-unreadable-color'
  | 'wcag-contrast-fail'
  | 'apca-low-contrast'
  | 'schema-unknown-top-level-category'
  | 'schema-missing-dark-override'
  | 'stale-dist-missing-manifest'
  | 'stale-dist-invalid-manifest-json'
  | 'stale-dist-invalid-manifest-shape'
  | 'stale-dist-missing-output-map'
  | 'stale-dist-unsafe-output-key'
  | 'stale-dist-invalid-output-hash'
  | 'stale-dist-output-outdated'
  | 'stale-dist-output-missing'
  | 'stale-dist-output-unrecorded';

/** JSON-safe, named observations that justify a finding. */
export type FindingEvidence = Readonly<Record<string, string | number | boolean>>;

export interface CheckFinding {
  severity: Severity;
  /** A plain-language group suitable for a UI heading or filter. */
  category: FindingCategory;
  /** Stable, granular identifier for machine consumers. */
  code: FindingCode;
  /** Token dot path or dist/-relative file this finding is about (when scoped). */
  path?: string;
  /** One-line, path-precise, human-readable explanation. */
  message: string;
  /** Named observed values (never inferred by a JSON consumer from message text). */
  evidence: FindingEvidence;
  /** Safe next command, run from the affected project root. */
  nextCommand: string;
}
