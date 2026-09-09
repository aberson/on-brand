/**
 * `onbrand check` orchestrator (plan.md §6, §9.8; Step 5). Shared by the CLI
 * `check` subcommand AND `onbrand build --check` (wired through here so the
 * checks are defined once).
 *
 * Runs three gates over a project's brand/:
 *   1. Contrast — WCAG 2 AA HARD gate over every declared fg/bg pairing in BOTH
 *      modes (light from tokens.json, dark from the overlay-merged doc); APCA Lc
 *      reported alongside every pairing (advisory; `--strict` promotes a
 *      sub-threshold |Lc| to an error).
 *   2. Schema lint — unknown top-level categories + missing dark-mode coverage.
 *   3. Stale-dist drift — per-output manifest-hash comparison.
 *
 * Sources are loaded through the production assembly (compile.loadBrandSources)
 * so the check's source hash matches what `build` records (measurement-validity:
 * assemble through the production code path). Source problems (invalid tokens,
 * bad overlay, missing brand/) throw — the CLI maps them to exit 1.
 */

import path from 'node:path';
import {
  computeSourceHash,
  type SourceHashResult,
} from '../build/manifest.ts';
import { implementedEmitterOutputs, loadBrandSources } from '../build/compile.ts';
import {
  APCA_STRICT_LC,
  WCAG_AA_NORMAL,
  evaluateContrast,
} from './contrast.ts';
import { derivePairings, type Mode, type Pairing } from './pairings.ts';
import { lintSchema } from './lint.ts';
import {
  checkDrift,
  UNSAFE_MANIFEST_TARGET,
  type DriftManifestContent,
} from './drift.ts';
import type { CheckFinding } from './finding.ts';
import {
  classifyInspirationViewFreshness,
  INSPIRATION_VIEW_OUTPUT,
} from '../inspiration/views.ts';
import {
  SPECIMEN_CONTENT_SOURCE_LABEL,
  SPECIMEN_VIEW_OUTPUT,
} from '../preview/contract.ts';
import {
  inspectSafeRegularFileTarget,
  sameFileIdentity,
  stableReadRegularFile,
} from '../filesystem.ts';

/** Stable identifier for the machine-readable `onbrand check --json` report. */
export const CHECK_REPORT_SCHEMA = 'onbrand.check';
/** Increment only for a backwards-incompatible report shape change. */
export const CHECK_REPORT_SCHEMA_VERSION = 1;

export interface CheckOptions {
  /** Promote sub-threshold APCA advisories to errors (plan §9.8). */
  strict?: boolean;
  /** Override preset resolution root (tests). */
  presetsRoot?: string;
}

/** One pairing's full contrast read-out (the "reported alongside" row). */
export interface PairingReport {
  mode: Mode;
  role: string;
  fgPath: string;
  fgValue: string;
  bgPath: string;
  bgValue: string;
  wcag?: number;
  apca?: number;
  wcagPass: boolean;
  apcaPass: boolean;
  parseError?: string;
}

export interface CheckReport {
  schema: typeof CHECK_REPORT_SCHEMA;
  schemaVersion: typeof CHECK_REPORT_SCHEMA_VERSION;
  /** Sources loaded and the gate ran to completion. */
  state: 'available';
  strict: boolean;
  pairings: PairingReport[];
  findings: CheckFinding[];
  errorCount: number;
  warningCount: number;
  advisoryCount: number;
  /** True when there are no error-severity findings (gate passes). */
  ok: boolean;
}

/** Versioned JSON envelope for a source-load failure before a gate can run. */
export interface CheckUnavailableReport {
  schema: typeof CHECK_REPORT_SCHEMA;
  schemaVersion: typeof CHECK_REPORT_SCHEMA_VERSION;
  state: 'unavailable';
  error: {
    code: 'source-load-failed';
    message: string;
    nextCommand: 'onbrand check';
  };
}

export type CheckJsonReport = CheckReport | CheckUnavailableReport;

export function unavailableCheckReport(message: string): CheckUnavailableReport {
  return {
    schema: CHECK_REPORT_SCHEMA,
    schemaVersion: CHECK_REPORT_SCHEMA_VERSION,
    state: 'unavailable',
    error: { code: 'source-load-failed', message, nextCommand: 'onbrand check' },
  };
}

/** Read manifest bytes stably; distinguish true absence from an unsafe target. */
function readManifestContent(manifestPath: string): DriftManifestContent {
  const target = inspectSafeRegularFileTarget(manifestPath, { requireSingleLink: true });
  if (target.state === 'absent') return undefined;
  if (target.state === 'unsafe') return UNSAFE_MANIFEST_TARGET;
  const file = stableReadRegularFile(manifestPath, { requireSingleLink: true });
  if (file === undefined || !sameFileIdentity(file.identity, target.identity)) {
    return UNSAFE_MANIFEST_TARGET;
  }
  return file.bytes.toString('utf8');
}

function contrastFindings(pairing: Pairing, report: PairingReport, strict: boolean): CheckFinding[] {
  const modeTag = `[${pairing.mode}]`;
  const where = `${pairing.fgPath} (${pairing.fgValue}) on ${pairing.bgPath} (${pairing.bgValue})`;

  if (report.parseError !== undefined) {
    return [
      {
        severity: 'error',
        category: 'wcag',
        code: 'wcag-unreadable-color',
        path: pairing.fgPath,
        message: `${modeTag} ${pairing.role}: ${report.parseError} — cannot gate ${where}`,
        evidence: {
          mode: pairing.mode,
          role: pairing.role,
          foregroundPath: pairing.fgPath,
          foreground: pairing.fgValue,
          backgroundPath: pairing.bgPath,
          background: pairing.bgValue,
          parseError: report.parseError,
        },
        nextCommand: 'onbrand check',
      },
    ];
  }

  const findings: CheckFinding[] = [];
  if (!report.wcagPass) {
    findings.push({
      severity: 'error',
      category: 'wcag',
      code: 'wcag-contrast-fail',
      path: pairing.fgPath,
      message: `${modeTag} WCAG 2 AA FAIL: ${pairing.role} — ${where} is ${report.wcag}:1 (need ${WCAG_AA_NORMAL}:1)`,
      evidence: {
        mode: pairing.mode,
        role: pairing.role,
        foregroundPath: pairing.fgPath,
        foreground: pairing.fgValue,
        backgroundPath: pairing.bgPath,
        background: pairing.bgValue,
        observedRatio: report.wcag ?? 'unavailable',
        requiredRatio: WCAG_AA_NORMAL,
      },
      nextCommand: 'onbrand check',
    });
  }
  if (!report.apcaPass) {
    const lc = report.apca;
    findings.push({
      severity: strict ? 'error' : 'advisory',
      category: 'apca',
      code: 'apca-low-contrast',
      path: pairing.fgPath,
      message: `${modeTag} APCA Lc ${lc} below ${APCA_STRICT_LC}: ${pairing.role} — ${where}${
        strict ? ' (promoted by --strict)' : ' (advisory; --strict enforces)'
      }`,
      evidence: {
        mode: pairing.mode,
        role: pairing.role,
        foregroundPath: pairing.fgPath,
        foreground: pairing.fgValue,
        backgroundPath: pairing.bgPath,
        background: pairing.bgValue,
        observedLc: lc ?? 'unavailable',
        requiredLc: APCA_STRICT_LC,
        strict,
      },
      nextCommand: 'onbrand check',
    });
  }
  return findings;
}

/** Run the full check gate over `<projectDir>/brand/`. */
export function runCheck(projectDir: string, options: CheckOptions = {}): CheckReport {
  const strict = options.strict ?? false;
  const sources = loadBrandSources(projectDir, {
    ...(options.presetsRoot !== undefined ? { presetsRoot: options.presetsRoot } : {}),
  });

  const hash: SourceHashResult = computeSourceHash(sources.sourceInputs);

  // 1. Contrast over both modes.
  const pairings: Pairing[] = [
    ...derivePairings(sources.resolved.document, 'light'),
    ...(sources.darkDocument !== undefined ? derivePairings(sources.darkDocument, 'dark') : []),
  ];
  const pairingReports: PairingReport[] = [];
  const findings: CheckFinding[] = [];
  for (const pairing of pairings) {
    const result = evaluateContrast(pairing.fgValue, pairing.bgValue);
    const report: PairingReport = {
      mode: pairing.mode,
      role: pairing.role,
      fgPath: pairing.fgPath,
      fgValue: pairing.fgValue,
      bgPath: pairing.bgPath,
      bgValue: pairing.bgValue,
      ...(result.wcag !== undefined ? { wcag: result.wcag } : {}),
      ...(result.apca !== undefined ? { apca: result.apca } : {}),
      wcagPass: result.wcagPass,
      apcaPass: result.apcaPass,
      ...(result.parseError !== undefined ? { parseError: result.parseError } : {}),
    };
    pairingReports.push(report);
    findings.push(...contrastFindings(pairing, report, strict));
  }

  // 2. Schema lint.
  findings.push(
    ...lintSchema({
      lightDocument: sources.resolved.document,
      hasModes: sources.hasModes,
      overriddenPaths: sources.overriddenPaths,
    }),
  );

  // 3. Stale-dist drift + completeness (expected outputs = every implemented
  // emitter's declared files, from the build-time-enforced registry).
  const manifestPath = path.join(sources.brandDir, 'dist', 'manifest.json');
  const inspirationFreshness = classifyInspirationViewFreshness(projectDir, hash.sourceHash);
  const expectedOutputs = [
    ...implementedEmitterOutputs(),
    ...(inspirationFreshness.state === 'current'
      ? [{
          emitter: 'generated',
          relPath: INSPIRATION_VIEW_OUTPUT,
          expectedHash: inspirationFreshness.freshness.hash,
          required: true,
        }]
      : [{
          emitter: 'generated',
          relPath: INSPIRATION_VIEW_OUTPUT,
          required: false,
          // A removed trace makes a retained recorded explanation orphaned and
          // therefore stale. Invalid optional configuration remains outside
          // the core check gate, preserving its established failure boundary.
          ignoreRecorded: inspirationFreshness.state === 'invalid',
        }]),
    {
      emitter: 'generated',
      relPath: SPECIMEN_VIEW_OUTPUT,
      required: false,
      contentDigestLabel: SPECIMEN_CONTENT_SOURCE_LABEL,
    },
  ];
  findings.push(
    ...checkDrift(
      path.join(sources.brandDir, 'dist'),
      hash.sourceHash,
      readManifestContent(manifestPath),
      expectedOutputs,
    ),
  );

  // Order findings error -> warning -> advisory (stable within a severity).
  const severityRank: Record<CheckFinding['severity'], number> = {
    error: 0,
    warning: 1,
    advisory: 2,
  };
  const ordered = [...findings].sort(
    (a, b) => severityRank[a.severity] - severityRank[b.severity],
  );

  const errorCount = ordered.filter((f) => f.severity === 'error').length;
  const warningCount = ordered.filter((f) => f.severity === 'warning').length;
  const advisoryCount = ordered.filter((f) => f.severity === 'advisory').length;

  return {
    schema: CHECK_REPORT_SCHEMA,
    schemaVersion: CHECK_REPORT_SCHEMA_VERSION,
    state: 'available',
    strict,
    pairings: pairingReports,
    findings: ordered,
    errorCount,
    warningCount,
    advisoryCount,
    ok: errorCount === 0,
  };
}

// ---------------------------------------------------------------------------
// Human-readable rendering
// ---------------------------------------------------------------------------

function signed(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}

function pairingRow(report: PairingReport): string {
  const mode = report.mode.padEnd(5);
  if (report.parseError !== undefined) {
    return `  ${mode}  ${'ERR'.padStart(7)}  ${'ERR'.padStart(7)}  parse  ${report.fgPath} on ${report.bgPath}`;
  }
  const wcag = (report.wcag ?? 0).toFixed(2).padStart(7);
  const apca = signed(report.apca ?? 0).padStart(7);
  const verdict = report.wcagPass ? (report.apcaPass ? 'ok  ' : 'adv ') : 'FAIL';
  return `  ${mode}  ${wcag}  ${apca}  ${verdict}   ${report.fgPath} on ${report.bgPath} (${report.role})`;
}

const SEVERITY_TAG: Record<CheckFinding['severity'], string> = {
  error: 'ERROR',
  warning: 'WARN ',
  advisory: 'ADVIS',
};

const CATEGORY_LABEL: Record<CheckFinding['category'], string> = {
  wcag: 'WCAG',
  apca: 'APCA',
  schema: 'Schema',
  'stale-dist': 'Stale dist',
};

function formatEvidence(finding: CheckFinding): string {
  return Object.keys(finding.evidence)
    .sort()
    .map((key) => `${key}=${JSON.stringify(finding.evidence[key]!)}`)
    .join(', ');
}

/** Render a check report to a human-readable, path-precise multi-line string. */
export function formatCheckReport(report: CheckReport): string {
  const lines: string[] = [];
  lines.push(
    `onbrand check — ${report.pairings.length} declared pairing(s), both modes` +
      ` (WCAG 2 AA hard gate at ${WCAG_AA_NORMAL}:1; APCA Lc ${report.strict ? 'ENFORCED' : 'advisory'} at ${APCA_STRICT_LC})`,
  );
  if (report.pairings.length > 0) {
    lines.push('');
    lines.push('  MODE     WCAG     APCA  RESULT  PAIRING');
    for (const p of report.pairings) lines.push(pairingRow(p));
  }

  if (report.findings.length > 0) {
    lines.push('');
    lines.push('Findings:');
    for (const f of report.findings) {
      lines.push(`  [${SEVERITY_TAG[f.severity]}] ${CATEGORY_LABEL[f.category]}: ${f.message}`);
      lines.push(`           Evidence: ${formatEvidence(f)}`);
      lines.push(`           Next: ${f.nextCommand}`);
    }
  }

  lines.push('');
  lines.push(
    `check ${report.ok ? 'PASS' : 'FAIL'} — ${report.errorCount} error, ` +
      `${report.warningCount} warning, ${report.advisoryCount} advisory`,
  );
  return lines.join('\n');
}
