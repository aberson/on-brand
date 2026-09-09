/**
 * Stale-dist drift detection for `onbrand check` (plan.md §3.1 drift guard,
 * Step 5). PER-OUTPUT: compares each `manifest.outputs[file]` recorded hash
 * against the CURRENT source hash (recomputed via the production assembly —
 * compile.computeBrandSourceHash — so build and check hash identically).
 *
 * Completeness sweep (the prune-false-green fix): the caller passes the
 * EXPECTED output set — every implemented emitter's declared files, from
 * compile.implementedEmitterOutputs() — and any expected output with no
 * manifest entry is an ERROR ("dist incomplete"). This is what makes the #19
 * build-time prune safe: a subset rebuild after a dist file was deleted
 * prunes the entry (with a stderr note), and the NEXT `onbrand check` fails
 * here instead of passing a dist that silently lost an output. It also means
 * a dist built by an older onbrand that lacks a since-implemented emitter's
 * output reads as incomplete until rebuilt — intended: "complete" is relative
 * to the tool doing the checking.
 *
 * Severity gradient (documented decision):
 *   - recorded hash != current sources          -> ERROR (stale dist — names
 *     the stale output; the exact thing the guard exists for).
 *   - expected output with no manifest entry    -> ERROR (dist incomplete).
 *   - recorded entry whose file is gone on disk -> ERROR (dist incomplete —
 *     deleted after the recording build).
 *   - recorded entry with a non-string hash     -> ERROR (unverifiable entry;
 *     a hand-edited/merge-corrupted manifest must never read as clean).
 *   - manifest without a usable outputs map     -> ERROR (cannot verify; no
 *     real onbrand build has ever produced one — there is deliberately NO
 *     legacy sourceHash-only fallback: fail loud beats guessing).
 *   - no dist/manifest.json at all              -> WARNING (nothing built to
 *     verify — contrast/lint still ran; run `onbrand build`). The
 *     completeness sweep is skipped: it gates "the manifest claims a build
 *     happened", and here nothing claims one.
 *
 * TRAVERSAL SAFETY (issue #19): every key is run through isCleanOutputKey
 * BEFORE it is joined onto distDir, so iterating manifest.outputs can never
 * stat a path outside dist/. An unsafe key is reported, never followed.
 */

import path from 'node:path';
import { isPlainObject } from '../schema/types.ts';
import {
  SPECIMEN_VIEW_MAX_BYTES,
  recordedOutputContentDigest,
} from '../preview/contract.ts';
import { isCleanOutputKey } from '../build/manifest.ts';
import {
  inspectSafeRegularFileTarget,
  sameFileIdentity,
  stableHashRegularFile,
  stableInspectRegularFile,
  type StableRegularFileDigest,
  type StableRegularFileMetadata,
} from '../filesystem.ts';
import type { CheckFinding, FindingCode, FindingEvidence } from './finding.ts';

/** Explicit fail-closed state supplied when manifest.json is present but unsafe. */
export const UNSAFE_MANIFEST_TARGET = Symbol('unsafe-manifest-target');
export type DriftManifestContent = string | undefined | typeof UNSAFE_MANIFEST_TARGET;

/** One expected dist output (an implemented emitter's declared file). */
export interface ExpectedOutput {
  emitter: string;
  relPath: string;
  /** Optional non-core freshness digest for a generated view. */
  expectedHash?: string;
  /** False for a known optional view when no configuration requires it. */
  required?: boolean;
  /** Core discovery may deliberately ignore generated views. */
  ignoreRecorded?: boolean;
  /** Bind recorded freshness to the exact stable bytes of this output. */
  contentDigestLabel?: string;
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

function error(
  code: Extract<FindingCode, `stale-dist-${string}`>,
  pathLabel: string,
  message: string,
  evidence: FindingEvidence,
): CheckFinding {
  return {
    severity: 'error',
    category: 'stale-dist',
    code,
    path: pathLabel,
    message,
    evidence,
    nextCommand: 'onbrand build',
  };
}

type OutputInspection =
  | { state: 'absent' }
  | { state: 'file'; metadata: StableRegularFileMetadata }
  | { state: 'unsafe' };

/** Classify a dist output while retaining identity metadata, never its bytes. */
function inspectOutputFile(distDir: string, relPath: string): OutputInspection {
  if (!isCleanOutputKey(relPath)) return { state: 'unsafe' };
  const target = path.join(distDir, ...relPath.split('/'));
  const snapshot = inspectSafeRegularFileTarget(target, { requireSingleLink: true });
  if (snapshot.state !== 'file') return snapshot;
  const metadata = stableInspectRegularFile(target, { requireSingleLink: true });
  if (metadata === undefined || !sameFileIdentity(metadata.identity, snapshot.identity)) {
    return { state: 'unsafe' };
  }
  return { state: 'file', metadata };
}

/** Stream-hash only an explicitly digest-labelled output and revalidate it. */
function hashInspectedOutput(
  distDir: string,
  relPath: string,
  metadata: StableRegularFileMetadata,
): StableRegularFileDigest | undefined {
  const target = path.join(distDir, ...relPath.split('/'));
  const digest = stableHashRegularFile(target, {
    maxBytes: SPECIMEN_VIEW_MAX_BYTES,
    requireSingleLink: true,
  });
  return digest !== undefined && sameFileIdentity(digest.identity, metadata.identity)
    ? digest
    : undefined;
}

function unsafeOutputFinding(relPath: string): CheckFinding {
  return error(
    'stale-dist-output-missing',
    relPath,
    `dist output "${relPath}" is linked, non-regular, or changed during inspection; run "onbrand build"`,
    { output: relPath, safeTarget: false, fileExists: true },
  );
}

/**
 * @param distDir absolute `<project>/brand/dist`
 * @param currentSourceHash hash of the live brand/ sources (computeBrandSourceHash)
 * @param manifestContent raw manifest content, undefined when absent, or the unsafe-target sentinel
 * @param expectedOutputs implemented emitters' declared files (implementedEmitterOutputs())
 */
export function checkDrift(
  distDir: string,
  currentSourceHash: string,
  manifestContent: DriftManifestContent,
  expectedOutputs: readonly ExpectedOutput[],
): CheckFinding[] {
  const expectedInspections = new Map<string, OutputInspection>();
  const unsafeExpected = new Set<string>();
  const unsafeFindings: CheckFinding[] = [];
  for (const expected of expectedOutputs) {
    const inspected = inspectOutputFile(distDir, expected.relPath);
    expectedInspections.set(expected.relPath, inspected);
    if (inspected.state === 'unsafe') {
      unsafeExpected.add(expected.relPath);
      unsafeFindings.push(unsafeOutputFinding(expected.relPath));
    }
  }

  if (manifestContent === UNSAFE_MANIFEST_TARGET) {
    return [
      error(
        'stale-dist-invalid-manifest-shape',
        'dist/manifest.json',
        'dist/manifest.json is linked, non-regular, or changed during inspection; run "onbrand build"',
        { manifest: 'brand/dist/manifest.json', safeTarget: false },
      ),
      ...unsafeFindings,
    ];
  }
  if (manifestContent === undefined) {
    return [
      ...unsafeFindings,
      {
        severity: 'warning',
        category: 'stale-dist',
        code: 'stale-dist-missing-manifest',
        path: 'dist/manifest.json',
        message: 'no built dist/ to verify — run "onbrand build" (contrast + lint still checked)',
        evidence: {
          manifest: 'brand/dist/manifest.json',
          present: false,
        },
        nextCommand: 'onbrand build',
      },
    ];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestContent);
  } catch {
    return [
      error(
        'stale-dist-invalid-manifest-json',
        'dist/manifest.json',
        'dist/manifest.json is not valid JSON — run "onbrand build" to regenerate',
        { manifest: 'brand/dist/manifest.json', parseable: false },
      ),
    ];
  }
  if (!isPlainObject(parsed)) {
    return [
      error(
        'stale-dist-invalid-manifest-shape',
        'dist/manifest.json',
        'dist/manifest.json is not a JSON object — run "onbrand build" to regenerate',
        { manifest: 'brand/dist/manifest.json', object: false },
      ),
    ];
  }

  const outputs = parsed['outputs'];
  if (!isPlainObject(outputs)) {
    return [
      error(
        'stale-dist-missing-output-map',
        'dist/manifest.json',
        'manifest has no outputs map — cannot verify dist freshness; run "onbrand build"',
        { manifest: 'brand/dist/manifest.json', outputsMap: false },
      ),
    ];
  }

  const findings: CheckFinding[] = [...unsafeFindings];
  const expectedByPath = new Map(expectedOutputs.map((expected) => [expected.relPath, expected]));
  /** Keys the manifest RECORDS (verified or already-errored) — the
   * completeness sweep must not double-report these. */
  const recordedKeys = new Set<string>();

  for (const [key, recorded] of Object.entries(outputs)) {
    if (!isCleanOutputKey(key)) {
      // Never join an unsafe key onto distDir — report and skip.
      findings.push(
        error(
          'stale-dist-unsafe-output-key',
          'dist/manifest.json',
          `manifest.outputs contains an unsafe key ${JSON.stringify(key)} — refused to inspect it (rebuild to clean the manifest)`,
          { manifest: 'brand/dist/manifest.json', output: key, safePath: false },
        ),
      );
      continue;
    }
    recordedKeys.add(key);
    const expected = expectedByPath.get(key);
    const inspected = expectedInspections.get(key) ?? inspectOutputFile(distDir, key);
    if (inspected.state === 'unsafe') {
      if (!unsafeExpected.has(key)) findings.push(unsafeOutputFinding(key));
      continue;
    }
    if (expected?.ignoreRecorded === true) continue;
    if (typeof recorded !== 'string') {
      // A non-string hash is unverifiable — silently skipping it would let a
      // hand-corrupted manifest read as clean (review finding, iteration 2).
      findings.push(
        error(
          'stale-dist-invalid-output-hash',
          key,
          `manifest.outputs entry for "${key}" is not a hash string — cannot verify it; run "onbrand build"`,
          { output: key, recordedType: typeof recorded },
        ),
      );
      continue;
    }
    const expectedHash = expected?.expectedHash ?? currentSourceHash;
    if (recorded !== expectedHash) {
      findings.push(
        error(
          'stale-dist-output-outdated',
          key,
          `stale dist output "${key}" — built from sources ${shortHash(recorded)}…, current sources are ${shortHash(currentSourceHash)}…; run "onbrand build"`,
          {
            output: key,
            recordedSourceHash: recorded,
            currentSourceHash: expectedHash,
            hashesMatch: false,
          },
        ),
      );
      continue;
    }
    if (inspected.state === 'absent') {
      findings.push(
        error(
          'stale-dist-output-missing',
          key,
          `dist incomplete — manifest records "${key}" as current but the file is missing; run "onbrand build"`,
          { output: key, recordedSourceHash: recorded, fileExists: false },
        ),
      );
      continue;
    }
    if (expected?.contentDigestLabel !== undefined) {
      const recordedDigest = recordedOutputContentDigest(parsed, key, expected.contentDigestLabel);
      const current = hashInspectedOutput(distDir, key, inspected.metadata);
      if (current === undefined) {
        if (!unsafeExpected.has(key)) findings.push(unsafeOutputFinding(key));
        continue;
      }
      if (recordedDigest !== current.sha256) {
        findings.push(
          error(
            'stale-dist-output-outdated',
            key,
            `stale dist output "${key}" — recorded ${expected.contentDigestLabel} content digest does not match the live file; run "onbrand build"`,
            {
              output: key,
              digestLabel: expected.contentDigestLabel,
              recordedContentSha256: recordedDigest ?? 'missing-or-invalid',
              currentContentSha256: current.sha256,
              hashesMatch: false,
            },
          ),
        );
      }
    }
  }

  // Completeness sweep: the manifest claims a build happened, so every
  // implemented emitter's declared output must have a manifest entry. A
  // pruned / never-built / hand-deleted output surfaces HERE (file header).
  for (const expected of expectedOutputs) {
    if (expected.required === false) continue;
    if (unsafeExpected.has(expected.relPath)) continue;
    if (recordedKeys.has(expected.relPath)) continue;
    findings.push(
      error(
        'stale-dist-output-unrecorded',
        expected.relPath,
        `dist incomplete — no provenance recorded for "${expected.relPath}" (the "${expected.emitter}" emitter is implemented) while the manifest claims a build; run "onbrand build"`,
        {
          output: expected.relPath,
          emitter: expected.emitter,
          manifestRecordsOutput: false,
        },
      ),
    );
  }

  return findings;
}
