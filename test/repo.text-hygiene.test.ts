/**
 * Repo text-hygiene gate: NO source/test/doc file may contain raw control
 * bytes (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F; tab/LF/CR allowed).
 *
 * Why this exists (stop-and-audit, 2026-07-16): the SAME bug-shape landed
 * three times in one build session — a raw NUL byte written into source where
 * an escape/separator was intended (Step 1 validate.ts, Step 2 css.ts, Step 3
 * naming.ts). A NUL trips git's binary heuristic, so the file shows as
 * `Bin N -> M bytes` in diffs — invisible to PR review, `git log -p`, blame,
 * and grep — which is exactly how it recurred unnoticed. This test makes the
 * whole class impossible to reintroduce: it sweeps every git-visible file
 * under the reviewed roots and names file + offset + byte on failure.
 *
 * Deliberately-binary assets (none exist today) must be listed in
 * BINARY_EXCEPTIONS explicitly — never widen the scan-skip silently.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Roots whose files are human/agent-reviewed text. */
const SCANNED_ROOTS = ['src', 'test', 'templates', 'bin', 'docs'];

// Extended, never rewritten: each later root arrives as its own append so two
// independent steps cannot silently clobber one another's addition.
//
// `scripts` holds the UAT PowerShell partitioned verbatim out of
// documentation/inspiration-real-artwork-uat.md - reviewed text like the rest.
SCANNED_ROOTS.push('scripts');

// `examples` holds the Phase I2I.2 Step 36 real-artwork demo: one complete
// `from-image` proposal promoted verbatim, plus a hand-authored PROVENANCE.md.
// Everything in it is reviewed text EXCEPT the one selected raster, which is
// exempted by exact path below - never by a directory-wide scan skip.
SCANNED_ROOTS.push('examples');

/** Repo-relative paths (forward slashes) that are ALLOWED to be binary. */
const BINARY_EXCEPTIONS = new Set<string>([
  // Public README captures from the released demo and synthetic gallery projects.
  'docs/images/readme/inspiration.png',
  'docs/images/readme/specimen-light.png',
  'docs/images/readme/specimen-dark.png',
  'docs/images/readme/gallery.png',
  // Step 8 spike evidence: real viewport screenshots from the live dembrandt
  // runs (2026-07-16), referenced by the raw-extraction fixtures.
  'test/fixtures/extraction/screenshots/zengarden.png',
  'test/fixtures/extraction/screenshots/stripe.png',
  'test/fixtures/extraction/screenshots/example.png',
  'test/fixtures/extraction/screenshots/blank.png',
  // Step 13 extraction-eval evidence (2026-07-17): source-site viewport
  // screenshots (dembrandt) + generated specimen screenshots (Playwright),
  // referenced by docs/findings/extraction-eval.md. Exact paths only.
  'docs/findings/eval-screenshots/csszengarden-source.png',
  'docs/findings/eval-screenshots/csszengarden-specimen.png',
  'docs/findings/eval-screenshots/stripe-source.png',
  'docs/findings/eval-screenshots/stripe-specimen.png',
  'docs/findings/eval-screenshots/workspace-fixture-source.png',
  'docs/findings/eval-screenshots/workspace-fixture-specimen.png',
  'docs/findings/eval-screenshots/garbage-anchor-source.png',
  // Brand-Fidelity benchmark Step 2 (2026-07-18): source-site viewport
  // screenshots harvested alongside the hermetic-replay fixtures under
  // docs/findings/eval-raw-extractions/benchmark/ (referenced by the matching
  // <id>.raw-extraction.json; synthetic czg skins carry no screenshot). Exact
  // paths only — see benchmark/FIXTURES.md for provenance.
  'docs/findings/eval-raw-extractions/benchmark/stripe.viewport.png',
  'docs/findings/eval-raw-extractions/benchmark/github.viewport.png',
  'docs/findings/eval-raw-extractions/benchmark/imprintgenius.viewport.png',
  'docs/findings/eval-raw-extractions/benchmark/basecamp.viewport.png',
  'docs/findings/eval-raw-extractions/benchmark/nytimes.viewport.png',
  'docs/findings/eval-raw-extractions/benchmark/duolingo.viewport.png',
  'docs/findings/eval-raw-extractions/benchmark/kurzgesagt.viewport.png',
  // Step 3 swap (2026-07-20): louisvuitton's live fixture was a bot-block deny
  // page, so it was replaced by forliving (same luxury/retail archetype).
  'docs/findings/eval-raw-extractions/benchmark/forliving.viewport.png',
  'docs/findings/eval-raw-extractions/benchmark/spotify.viewport.png',
  'docs/findings/eval-raw-extractions/benchmark/linear.viewport.png',
  'docs/findings/eval-raw-extractions/benchmark/robinhood.viewport.png',
  'docs/findings/eval-raw-extractions/benchmark/medium.viewport.png',
  'docs/findings/eval-raw-extractions/benchmark/czg-031.viewport.png',
  'docs/findings/eval-raw-extractions/benchmark/czg-113.viewport.png',
  'docs/findings/eval-raw-extractions/benchmark/czg-157.viewport.png',
  // Phase I2I.2 Step 36 (2026-08-25): the ONE operator-selected real-artwork
  // raster, copied byte-for-byte by the production `from-image` producer from
  // the institution-delivered download (M3a issue #69). Exact path only - the
  // rest of examples/ is reviewed text, and no second candidate exists.
  'examples/inspiration/water-lilies/brand/assets/inspiration.jpg',
]);

/** Byte values allowed below 0x20: tab, LF, CR. */
const ALLOWED_LOW_BYTES = new Set([9, 10, 13]);

interface ControlByteHit {
  offset: number;
  byte: number;
}

/** Return every forbidden control byte in the buffer (offset + value). */
function findControlBytes(bytes: Uint8Array): ControlByteHit[] {
  const hits: ControlByteHit[] = [];
  for (let offset = 0; offset < bytes.length; offset++) {
    const byte = bytes[offset]!;
    if (byte < 0x20 && !ALLOWED_LOW_BYTES.has(byte)) {
      hits.push({ offset, byte });
    }
  }
  return hits;
}

/**
 * Every file git can see under the scanned roots: tracked/staged (--cached)
 * plus untracked-but-not-ignored (--others --exclude-standard), so a
 * brand-new corrupted file is caught BEFORE it is ever staged. Fails loud if
 * git itself fails — a silently-empty file list would be a fake green
 * (measurement-validity: fail loud on fallback).
 */
function gitVisibleFiles(): string[] {
  const result = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...SCANNED_ROOTS],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000 },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `git ls-files failed (status ${result.status}): ${result.error?.message ?? result.stderr}`,
    );
  }
  const files = result.stdout.split('\n').filter((line) => line !== '');
  if (files.length === 0) {
    throw new Error('git ls-files returned no files — the scan would be a fake green');
  }
  return files;
}

describe('repo text hygiene (control-byte gate)', () => {
  it('calibration anchor: the scanner flags a NUL and passes clean text', () => {
    // measurement-validity: an instrument that cannot fail garbage cannot gate.
    const garbage = Uint8Array.from([0x61, 0x00, 0x62]); // "a<NUL>b"
    expect(findControlBytes(garbage)).toEqual([{ offset: 1, byte: 0 }]);
    const clean = new TextEncoder().encode('plain text\twith\r\nallowed whitespace\n');
    expect(findControlBytes(clean)).toEqual([]);
  });

  it('no git-visible file under src/test/templates/bin/docs contains control bytes', () => {
    const violations: string[] = [];
    let scanned = 0;
    for (const relPath of gitVisibleFiles()) {
      if (BINARY_EXCEPTIONS.has(relPath)) continue;
      const absPath = path.join(REPO_ROOT, relPath);
      if (!existsSync(absPath)) continue; // staged deletion: nothing on disk to review
      const bytes = readFileSync(absPath);
      scanned++;
      for (const hit of findControlBytes(bytes)) {
        violations.push(`${relPath}: byte 0x${hit.byte.toString(16)} at offset ${hit.offset}`);
      }
    }
    expect(scanned).toBeGreaterThan(20); // the repo has far more than 20 text files
    expect(violations).toEqual([]);
  });
});

/**
 * Repo text-hygiene gate, part two: the checked-in UAT PowerShell.
 *
 * `scripts/uat/*.ps1` was partitioned VERBATIM out of the three fences that
 * documentation/inspiration-real-artwork-uat.md carried at 538fec3 (the
 * runbook holds prose and one invocation per phase now). Two properties are
 * load-bearing and invisible to review:
 *
 * 1. A UTF-8 BOM. PowerShell 5.1 decodes a BOM-less `.ps1` as ANSI/cp1252, so
 *    a non-ASCII byte can be silently misread and corrupt string/brace parsing
 *    with NO parse error - a false green.
 * 2. No non-ASCII beyond the two U+2014 em-dashes that live inside PowerShell
 *    string literals and carry meaning: the official National Gallery of Art
 *    title written into the evidence record (the `parasol` candidate's `Title`
 *    in scripts/uat/Invoke-UatM3a.ps1) and this repo's commit-subject
 *    convention (`$step36Subject` in scripts/uat/Invoke-UatM3b.ps1). Replacing
 *    either with an ASCII hyphen would corrupt evidence data or break the
 *    convention.
 *
 * The allowlist is exact `(file, line-content)` pairs, so ANY new non-ASCII
 * character anywhere in these files fails the suite.
 *
 * Note: the UTF-8 BOM bytes EF BB BF are all >= 0x20, so this gate does not
 * conflict with the control-byte gate above.
 */

/** UAT PowerShell lines that are ALLOWED to hold non-ASCII, verbatim. */
const UAT_PS1_NON_ASCII_ALLOWLIST: ReadonlyArray<readonly [string, string]> = [
  [
    'scripts/uat/Invoke-UatM3a.ps1',
    "    Title = 'Woman with a Parasol \u2014 Madame Monet and Her Son'",
  ],
  [
    'scripts/uat/Invoke-UatM3b.ps1',
    "$step36Subject = 'checkpoint: step 36 complete \u2014 Promote the selected real-artwork draft demo'",
  ],
];

/** True when the buffer starts with the UTF-8 byte-order mark (EF BB BF). */
function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

interface NonAsciiHit {
  line: number;
  content: string;
}

/** Every line (1-indexed, BOM stripped) holding a codepoint above U+007F. */
function findNonAsciiLines(text: string): NonAsciiHit[] {
  const hits: NonAsciiHit[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const content = lines[index]!;
    for (const character of content) {
      if (character.codePointAt(0)! > 0x7f) {
        hits.push({ line: index + 1, content });
        break;
      }
    }
  }
  return hits;
}

describe('repo text hygiene (UAT PowerShell BOM + non-ASCII gate)', () => {
  it('calibration anchor: the gate fails a BOM-less file and a stray-non-ASCII line', () => {
    // measurement-validity: an instrument that cannot fail garbage cannot gate.
    expect(hasUtf8Bom(new TextEncoder().encode('$x = 1\n'))).toBe(false);
    expect(hasUtf8Bom(new TextEncoder().encode('\uFEFF$x = 1\n'))).toBe(true);
    expect(hasUtf8Bom(Uint8Array.from([0xef, 0xbb]))).toBe(false);

    expect(findNonAsciiLines('\uFEFF$x = 1\n$y = 2\n')).toEqual([]);
    expect(findNonAsciiLines("\uFEFF$x = 1\n$y = 'caf\u00e9'\n")).toEqual([
      { line: 2, content: "$y = 'caf\u00e9'" },
    ]);
  });

  it('every scripts/uat/*.ps1 starts with a UTF-8 BOM', () => {
    const files = gitVisibleFiles().filter((relPath) => /^scripts\/uat\/.*\.ps1$/.test(relPath));
    expect(files.length).toBeGreaterThanOrEqual(4);
    const missing = files.filter((relPath) => !hasUtf8Bom(readFileSync(path.join(REPO_ROOT, relPath))));
    expect(missing).toEqual([]);
  });

  it('scripts/uat/*.ps1 holds no non-ASCII beyond the two allowlisted em-dash lines', () => {
    const allowed = new Set(
      UAT_PS1_NON_ASCII_ALLOWLIST.map(([relPath, content]) => `${relPath}\u0000${content}`),
    );
    const files = gitVisibleFiles().filter((relPath) => /^scripts\/uat\/.*\.ps1$/.test(relPath));
    expect(files.length).toBeGreaterThanOrEqual(4);

    const violations: string[] = [];
    const seen = new Set<string>();
    for (const relPath of files) {
      const text = readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
      for (const hit of findNonAsciiLines(text)) {
        const key = `${relPath}\u0000${hit.content}`;
        if (allowed.has(key)) {
          seen.add(key);
          continue;
        }
        violations.push(`${relPath}:${hit.line}: ${hit.content}`);
      }
    }
    expect(violations).toEqual([]);
    // Both allowlisted lines must still be present: an allowlist entry that no
    // longer matches would mean the evidence text was silently rewritten.
    expect([...seen].sort()).toEqual([...allowed].sort());
  });
});

/**
 * Repo text-hygiene gate, part three: the UAT runbook's two section anchors.
 *
 * `## M3a — qualify and select` and `## M3b — accept the integrated demo` are
 * referenced BY NAME from issues #69/#70/#72/#73 and from
 * documentation/inspiration-real-artwork-demo-plan.md. Both carry a U+2014
 * em-dash, and `documentation` is deliberately outside SCANNED_ROOTS, so
 * nothing else in the repo would catch an em-dash -> ASCII-hyphen substitution
 * or a mojibake round-trip that silently breaks every one of those references.
 *
 * Appended as its own block, like the SCANNED_ROOTS extension above: never
 * folded into an earlier describe, so two independent steps cannot clobber one
 * another's addition.
 */

/** The runbook other artifacts cite by section name. */
const UAT_RUNBOOK = 'documentation/inspiration-real-artwork-uat.md';

/** Headings that must stay byte-exact for those citations to resolve. */
const UAT_RUNBOOK_ANCHORS: readonly string[] = [
  '## M3a \u2014 qualify and select',
  '## M3b \u2014 accept the integrated demo',
];

describe('UAT runbook section anchors', () => {
  it('holds each externally referenced heading exactly once, byte-exact', () => {
    const text = readFileSync(path.join(REPO_ROOT, UAT_RUNBOOK), 'utf8');
    for (const anchor of UAT_RUNBOOK_ANCHORS) {
      expect(`${anchor} => ${text.split(anchor).length - 1}`).toBe(`${anchor} => 1`);
    }
  });

  it('calibration: the same check rejects a hyphenated or mojibake runbook', () => {
    const text = readFileSync(path.join(REPO_ROOT, UAT_RUNBOOK), 'utf8');
    const hyphenated = text.replace(/\u2014/g, '-');
    const mojibake = text.replace(/\u2014/g, '\u00e2\u20ac\u201d');
    for (const corrupted of [hyphenated, mojibake]) {
      const found = UAT_RUNBOOK_ANCHORS.filter((anchor) => corrupted.includes(anchor));
      expect(found).toEqual([]);
    }
  });
});
