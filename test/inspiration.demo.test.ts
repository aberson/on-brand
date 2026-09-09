/**
 * Phase I2I.2 Steps 36 and 39 (issues #71, #74): the checked-in real-artwork
 * demo, now released.
 *
 * `examples/inspiration/water-lilies/` is one complete `onbrand from-image`
 * proposal, promoted verbatim from the candidate the operator selected at
 * Manual UAT M3a (issue #69) and accepted at Manual UAT M3b (issue #72). This
 * suite is the regression gate for it.
 *
 * Two deliberate boundaries, both load-bearing:
 *
 * 1. **Offline.** Every persistent assertion reads the committed tree and
 *    nothing else. The M3a/M3b handoffs (`%LOCALAPPDATA%`) and the GitHub
 *    issues they were posted to were the Step 36 and Step 39 PRE-WRITE gates —
 *    one-time checks, not a CI dependency. A test that re-read them would go
 *    red the moment the operator's staging directory was cleaned up, and would
 *    make `npm test` depend on network and credentials. The stable selection
 *    and acceptance evidence is transcribed into `PROVENANCE.md` and
 *    `documentation/findings/inspiration-real-artwork-demo/acceptance.md`
 *    instead, and THAT transcription is what is asserted here.
 *
 * 2. **Read-only on the tracked tree.** The committed example is validated in
 *    place; anything that invokes a production writer copies or recreates
 *    under an OS temp directory first. Rebuilding the tracked demo in place
 *    would create review noise and could half-publish it. A final case
 *    re-hashes the whole tracked tree to prove no case in this file moved a
 *    single byte of it.
 *
 * The two review-status bindings below are deliberately NOT one constant. The
 * committed trace is `operator-reviewed` — Step 39 promoted it after the M3b
 * acceptance record authenticated this exact tree — while the PRODUCER still
 * emits `generated-draft` and always will: a fresh proposal has, by
 * definition, not been reviewed by anyone. So the smoke case, which recreates
 * a proposal from scratch under OS temp, expects PRODUCER_REVIEW_STATUS, and
 * the committed-tree assertions expect EXPECTED_REVIEW_STATUS. Collapsing them
 * would either assert a producer that certifies its own output or a committed
 * demo that lost its acceptance.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { hashContent } from '../src/build/manifest.ts';
import { runCheck } from '../src/check/run.ts';
import { REVIEW_STATUSES, assertValidInspirationTrace } from '../src/inspiration/contract.ts';
import {
  INSPIRATION_VIEW_OUTPUT,
  SPECIMEN_CONTENT_SOURCE_LABEL,
  SPECIMEN_VIEW_OUTPUT,
} from '../src/inspiration/views.ts';
import { EXIT_OK } from '../src/cli.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO_ROOT, 'bin', 'onbrand.mjs');
const THIS_FILE = fileURLToPath(import.meta.url);

/** The validated M3a `demoSlug`; the enum's other two values never entered Git. */
const DEMO_SLUG = 'water-lilies';
const EXAMPLES_INSPIRATION = path.join(REPO_ROOT, 'examples', 'inspiration');
const DEMO_DIR = path.join(EXAMPLES_INSPIRATION, DEMO_SLUG);
const DEMO_BRAND = path.join(DEMO_DIR, 'brand');

/** The producer names the copied asset from the source media type, not the input name. */
const ASSET_RELATIVE = 'assets/inspiration.jpg';
const ASSET_SHA256 = '06367197ac8d6745537dcfe6722ff4b8ef2cb33e044168d8c471782b55f7dd39';
const ASSET_BYTES = 278_626;

/**
 * The stable, non-machine-local M3a selection evidence. Every value here is
 * transcribed into PROVENANCE.md and must survive in the trace; the record's
 * `stagingPath` deliberately is NOT among them (see the exclusion case below).
 */
const SELECTION = {
  runId: 'f5c1fcd7-2990-4ab8-b85a-bf8b090384ae',
  issueNumber: 69,
  planStep: 34,
  decision: 'ACCEPT',
  repository: 'aberson/on-brand',
  title: 'Water Lilies',
  alt: 'Water lilies floating on a pond.',
  creator: 'Claude Monet',
  artworkDate: '1906',
  sourceUrl: 'https://www.artic.edu/artworks/16568/water-lilies',
  mediaDownloadUrl:
    'https://www.artic.edu/iiif/2/3c27b499-af56-f0d5-93b5-a7f2f1ad5813/full/843,/0/default.jpg',
  rights: 'CC0 Public Domain Designation',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  retrievedAt: '2026-08-25',
  mediaType: 'image/jpeg',
} as const;

/**
 * The stable, non-machine-local M3b acceptance evidence (issue #72). Step 39's
 * pre-write gate compared this record against the issue comment, re-derived
 * every digest it names, and proved `reviewedCommit` was an ancestor of HEAD
 * whose demo tree was byte-identical to the working tree. That gate ran once;
 * these are the values it transcribed into the two durable records below, and
 * this is where a future edit that quietly rewrites either one goes red.
 *
 * `reviewedCommit` intentionally names the DRAFT tree the operator looked at,
 * not this promoted one — the acceptance is evidence about that exact commit.
 */
const ACCEPTANCE = {
  runId: '06696feb-b081-4777-a0cc-7743c1cfeb8b',
  selectionRunId: SELECTION.runId,
  issueNumber: 72,
  planStep: 37,
  decision: 'ACCEPT',
  reviewedCommit: '9f23d0610f9e934a4c3ef587887ca96fb68741a7',
  evidenceCreatedAt: '2026-08-25T19:57:40.289Z',
  /** Every viewport/content gate the operator recorded, all PASS. */
  gates: ['desktop', 'narrow', 'sourceRights', 'paletteCallouts', 'explanationVsSpecimen'],
} as const;

/**
 * The eight digests the M3b record itself names, pinned as literals.
 *
 * These are the operator's own numbers, recorded on issue #72 BEFORE this step
 * ran, so they are an INDEPENDENT source of truth about the reviewed tree —
 * the same reason ASSET_SHA256 above is a literal rather than something read
 * back from the file it describes. Re-deriving them from the committed tree
 * would compare that tree against itself, which cannot see the case where the
 * tree and the record are wrong together.
 *
 * Three of them (`inspirationSha256`, `manifestSha256`, `explanationSha256`)
 * are deliberately STALE with respect to the current tree: Step 39 changed
 * those three files, so their released digests differ by design. See
 * AS_REVIEWED / AS_RELEASED below, which is where that split is made explicit.
 */
const M3B_DIGESTS = {
  assetSha256: ASSET_SHA256,
  rawImageAnalysisSha256: '989297f79bed1fa2cfef511fda869e22baf76ec48e1ec51205d21c01f1bfb644',
  tokensSha256: 'ca613053e5b08bbe21d5c697249353c2edfba9f1c53c48d212d59c161c8db4f8',
  darkModeSha256: 'cd526171d994b52dae117e6377a4d058ee98956ee20b3e52d3d09cbf10824158',
  inspirationSha256: '641732006d02adc27d1cddd93f49a9b4e3394eec41ff179f35f04fe09e8b8c09',
  manifestSha256: 'c9dda56f7dd69b1f7dd022f395555e167d78fb41c8e823fe98faad3701d8e1ed',
  explanationSha256: '88ad36c7e7a9c8e7840c094cf3a5d6ceeda432f1ed2aaaa5d5a3153e504bbe80',
  specimenSha256: 'f0a221439aaf0eaf45e6555f17eb90dac16c2d6190a73ffb5c2e4f36122cc3f8',
} as const;

/** The durable Step 39 acceptance record, repo-relative. */
const ACCEPTANCE_RECORD = path.join(
  REPO_ROOT,
  'documentation',
  'findings',
  'inspiration-real-artwork-demo',
  'acceptance.md',
);

/**
 * The state the producer emits, taken from the contract's own enum rather
 * than re-typed as a literal here. A duplicated shape constant is exactly the
 * drift dev/.claude/rules/code-quality.md § "One source of truth for
 * data-shape constants" warns about, and neither side's tests can see it once
 * the two copies diverge; deriving means a rename or reorder of
 * REVIEW_STATUSES fails these assertions instead of passing against a stale
 * literal.
 */
const PRODUCER_REVIEW_STATUS = REVIEW_STATUSES[0];

/**
 * What the COMMITTED tree must currently carry. Step 36 shipped the producer's
 * own state; Step 39 moved this ONE binding to REVIEW_STATUSES[1]
 * ('operator-reviewed'), which is the released value. It is deliberately NOT
 * `PRODUCER_REVIEW_STATUS` — see the two-binding note in the file header.
 */
const EXPECTED_REVIEW_STATUS = REVIEW_STATUSES[1];

/** Every file the promoted producer tree must carry, repo-relative to DEMO_DIR. */
const REQUIRED_FILES = [
  'PROVENANCE.md',
  'raw-image-analysis.json',
  'image-report.md',
  'brand/tokens.json',
  'brand/modes.dark.json',
  'brand/guide.md',
  'brand/inspiration.json',
  `brand/${ASSET_RELATIVE}`,
  'brand/dist/manifest.json',
  `brand/dist/${INSPIRATION_VIEW_OUTPUT}`,
  `brand/dist/${SPECIMEN_VIEW_OUTPUT}`,
] as const;

/**
 * The ONLY paths Step 39's promotion is permitted to change inside this tree
 * (plan §7 Step 39). A fresh `generated-draft` regeneration must reproduce
 * every OTHER file byte-for-byte, today and after promotion; these four are
 * compared structurally instead, so Step 39 does not have to rewrite the
 * smoke's byte-identity contract. PROVENANCE.md is hand-authored and has no
 * producer counterpart at all.
 */
const PROMOTION_MUTABLE: ReadonlySet<string> = new Set([
  'PROVENANCE.md',
  'brand/inspiration.json',
  'brand/dist/manifest.json',
  `brand/dist/${INSPIRATION_VIEW_OUTPUT}`,
]);

/**
 * The five files the M3b record names that Step 39 was NOT permitted to touch,
 * each paired with the digest the OPERATOR accepted. This pairing is the
 * "we did not disturb what was reviewed" guarantee, and it only carries that
 * meaning because the right-hand values come from the acceptance record rather
 * than from the tree they describe.
 */
const AS_REVIEWED: ReadonlyArray<readonly [relative: string, reviewed: string]> = [
  [`brand/${ASSET_RELATIVE}`, M3B_DIGESTS.assetSha256],
  ['raw-image-analysis.json', M3B_DIGESTS.rawImageAnalysisSha256],
  ['brand/tokens.json', M3B_DIGESTS.tokensSha256],
  ['brand/modes.dark.json', M3B_DIGESTS.darkModeSha256],
  [`brand/dist/${SPECIMEN_VIEW_OUTPUT}`, M3B_DIGESTS.specimenSha256],
];

/**
 * The four files the promotion DID change, pinned at their as-RELEASED digests.
 *
 * Three of them have an M3b counterpart, and it must NOT match any more: that
 * inequality is the positive proof the promotion actually took effect, in the
 * same style as the reviewStatus regression guards further down. PROVENANCE.md
 * is hand-authored and the M3b record never named it, so `reviewed` is null —
 * there is no accepted digest for it to have moved away from.
 */
const AS_RELEASED: ReadonlyArray<{
  readonly relative: string;
  readonly released: string;
  readonly reviewed: string | null;
}> = [
  {
    relative: 'brand/inspiration.json',
    released: 'f4c934d7130bd49cb569c27db20aab8588676ad42a2b4d1ca05d9943838e4ca0',
    reviewed: M3B_DIGESTS.inspirationSha256,
  },
  {
    relative: 'brand/dist/manifest.json',
    released: 'ecabd45ed9d279b9ce4536b129b61d6688dfabff106f047927a282308c5c684b',
    reviewed: M3B_DIGESTS.manifestSha256,
  },
  {
    relative: `brand/dist/${INSPIRATION_VIEW_OUTPUT}`,
    released: 'f60cbb894d83d758107a2792f85797ed302d1d4405b9bfaea2c2e4abb60d66ee',
    reviewed: M3B_DIGESTS.explanationSha256,
  },
  {
    relative: 'PROVENANCE.md',
    released: '5a278a9edee997fe89a65e1af07324eee161c97082aa846c64e3bde16fae5069',
    reviewed: null,
  },
];

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Every regular file under `dir`, as forward-slash relative path -> sha256. */
function inventory(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const absolute = path.join(current, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      // A symlink would let generated output escape the root it is contained
      // in; record it as a distinct, always-failing marker rather than
      // silently following it.
      if (lstatSync(absolute).isSymbolicLink()) {
        found.set(relative, 'SYMLINK');
        continue;
      }
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) {
        found.set(relative, createHash('sha256').update(readFileSync(absolute)).digest('hex'));
      }
    }
  };
  walk(dir, '');
  return found;
}

/** The tracked tree exactly as this suite found it, before any case ran. */
const TRACKED_INVENTORY_AT_START = inventory(DEMO_DIR);

function readDemoText(relative: string): string {
  return readFileSync(path.join(DEMO_DIR, ...relative.split('/')), 'utf8');
}

interface DemoManifest {
  sourceHash: string;
  timestamp: string;
  llm: string;
  outputs: Record<string, string>;
  outputSources?: Record<
    string,
    Array<{ label: string; sourcePath: string | null; kind: string; sha256: string }>
  >;
}

function demoManifest(): DemoManifest {
  return JSON.parse(readDemoText('brand/dist/manifest.json')) as DemoManifest;
}

describe('real-artwork demo — the committed bytes', () => {
  it('carries exactly the M3a-selected raster, by digest and by size', () => {
    const asset = readFileSync(path.join(DEMO_BRAND, ...ASSET_RELATIVE.split('/')));
    expect(createHash('sha256').update(asset).digest('hex')).toBe(ASSET_SHA256);
    expect(asset.byteLength).toBe(ASSET_BYTES);
    // The v1 producer contract this candidate had to satisfy without any
    // recompression, crop, or resize of the institution-delivered file.
    expect(asset.byteLength).toBeLessThanOrEqual(5_000_000);
    // JPEG magic, matching the recorded mediaType - the extension proves nothing.
    expect([asset[0], asset[1], asset[2]]).toEqual([0xff, 0xd8, 0xff]);
  });

  it('holds one complete producer tree and no INCOMPLETE marker', () => {
    for (const relative of REQUIRED_FILES) {
      expect(existsSync(path.join(DEMO_DIR, ...relative.split('/'))), relative).toBe(true);
    }
    expect(existsSync(path.join(DEMO_DIR, 'INCOMPLETE.md'))).toBe(false);
  });

  it('admits no unselected candidate bytes', () => {
    // Only the one qualified candidate may enter Git. `water-lilies` was the
    // only candidate carried through the local qualification cycle; `parasol`
    // was staged as an input but not carried through, and `parliament-sunset`
    // was never staged. None of them ever entered Git.
    expect(readdirSync(EXAMPLES_INSPIRATION).sort()).toEqual([DEMO_SLUG]);
    // Exactly one raster, at exactly one path - no second copy of the image
    // anywhere in the tree (the explanation embeds it as a data: URI instead).
    const rasters = [...TRACKED_INVENTORY_AT_START.keys()].filter((relative) =>
      /\.(jpe?g|png|webp|gif|avif|bmp|tiff?)$/i.test(relative),
    );
    expect(rasters).toEqual([`brand/${ASSET_RELATIVE}`]);
    expect(TRACKED_INVENTORY_AT_START.get(`brand/${ASSET_RELATIVE}`)).toBe(ASSET_SHA256);
  });
});

describe('real-artwork demo — trace, outputs, and provenance agree offline', () => {
  it('validates as an operator-reviewed trace bound to the committed asset', () => {
    const trace = assertValidInspirationTrace(JSON.parse(readDemoText('brand/inspiration.json')));
    // EXPECTED_REVIEW_STATUS is derived from the contract's own enum, so pin
    // the shape that derivation assumes without re-typing its values: two
    // states, the producer's first and Step 39's promotion target second.
    expect(REVIEW_STATUSES).toHaveLength(2);
    expect(REVIEW_STATUSES[1]).not.toBe(PRODUCER_REVIEW_STATUS);
    // Released by Step 39 against the validated M3b ACCEPT record; the
    // producer never writes this value, so it cannot regress by accident.
    expect(trace.reviewStatus).toBe(EXPECTED_REVIEW_STATUS);
    expect(trace.reviewStatus).not.toBe(PRODUCER_REVIEW_STATUS);
    expect(trace.asset.path).toBe(ASSET_RELATIVE);
    expect(trace.asset.sha256).toBe(ASSET_SHA256);
    expect(trace.asset.mediaType).toBe(SELECTION.mediaType);
    expect(trace.analysis.sourceKind).toBe('image');
    expect(trace.mappings.length).toBeGreaterThan(0);
  });

  it('matches every stable M3a metadata value in the trace', () => {
    const trace = assertValidInspirationTrace(JSON.parse(readDemoText('brand/inspiration.json')));
    expect({
      title: trace.asset.title,
      alt: trace.asset.alt,
      creator: trace.asset.creator,
      artworkDate: trace.asset.date,
      sourceUrl: trace.asset.sourceUrl,
      rights: trace.asset.rights,
      licenseUrl: trace.asset.licenseUrl,
      retrievedAt: trace.asset.retrievedAt,
    }).toEqual({
      title: SELECTION.title,
      alt: SELECTION.alt,
      creator: SELECTION.creator,
      artworkDate: SELECTION.artworkDate,
      sourceUrl: SELECTION.sourceUrl,
      rights: SELECTION.rights,
      licenseUrl: SELECTION.licenseUrl,
      retrievedAt: SELECTION.retrievedAt,
    });
  });

  it('transcribes the stable M3a selection evidence into PROVENANCE.md', () => {
    const provenance = readDemoText('PROVENANCE.md');
    for (const value of [
      SELECTION.runId,
      SELECTION.title,
      SELECTION.creator,
      SELECTION.artworkDate,
      SELECTION.sourceUrl,
      SELECTION.mediaDownloadUrl,
      SELECTION.rights,
      SELECTION.licenseUrl,
      SELECTION.retrievedAt,
      SELECTION.repository,
      SELECTION.decision,
      SELECTION.mediaType,
      ASSET_SHA256,
      String(ASSET_BYTES),
      `#${SELECTION.issueNumber}`,
      ASSET_RELATIVE,
    ]) {
      expect(provenance.includes(value), `PROVENANCE.md transcribes ${value}`).toBe(true);
    }
    // The current status must be stated in prose too, so a reader of the
    // directory does not have to open the JSON to learn what it is.
    expect(provenance).toContain(EXPECTED_REVIEW_STATUS);
  });

  it('transcribes the stable M3b acceptance evidence into PROVENANCE.md', () => {
    const provenance = readDemoText('PROVENANCE.md');
    for (const value of [
      ACCEPTANCE.runId,
      ACCEPTANCE.selectionRunId,
      ACCEPTANCE.reviewedCommit,
      ACCEPTANCE.evidenceCreatedAt,
      ACCEPTANCE.decision,
      `#${ACCEPTANCE.issueNumber}`,
      String(ACCEPTANCE.planStep),
      ...ACCEPTANCE.gates,
    ]) {
      expect(provenance.includes(value), `PROVENANCE.md transcribes ${value}`).toBe(true);
    }
    // The draft claim Step 36 wrote here is a statement about a tree that no
    // longer exists; leaving it would make this file contradict the trace it
    // sits beside. The `generated-draft` string may still appear as the name
    // of the state the tree WAS in, but never as the state it IS in.
    expect(provenance).not.toMatch(/is a \*\*`?generated-draft`?\*\*/);
  });

  it('excludes the machine-local staging path from PROVENANCE.md', () => {
    const provenance = readDemoText('PROVENANCE.md');
    // The M3a record's `stagingPath` names one workstation's private layout.
    // It proves nothing about the artwork, goes stale the moment the operator
    // cleans up, and must never be published in the repo; the run ID is the
    // durable handle instead. Assert the SHAPES, not one literal string, so a
    // future edit cannot reintroduce a different absolute path.
    // A drive-letter path, but NOT a URL scheme: the lookbehind rejects
    // `C:\...` and `D:/...` while letting `https://...` through, since the
    // recorded object and media URLs are exactly what this file must publish.
    expect(provenance).not.toMatch(/(?<![A-Za-z])[A-Za-z]:[\\/]/);
    expect(provenance).not.toMatch(/\\\\/); // any UNC path
    expect(provenance).not.toContain('inspiration-uat'); // the staging root
    expect(provenance).not.toContain('LOCALAPPDATA');
    expect(provenance).not.toContain('AppData');
    expect(provenance).not.toContain('onbrand-proposal-'); // the trial dir name
    expect(provenance).not.toContain('/trials/');
    expect(provenance).toContain(SELECTION.runId);
  });

  it('agrees between the committed bytes, the trace, and the generated explanation', () => {
    const trace = assertValidInspirationTrace(JSON.parse(readDemoText('brand/inspiration.json')));
    const explanation = readDemoText(`brand/dist/${INSPIRATION_VIEW_OUTPUT}`);
    expect(explanation).toContain(`Review status: ${EXPECTED_REVIEW_STATUS}`);
    // The artwork travels INSIDE the standalone view as a data: URI, so the
    // page needs no sibling file and hotlinks nothing.
    expect(explanation).toContain(`data:${SELECTION.mediaType};base64,`);
    for (const value of [
      SELECTION.title,
      SELECTION.creator,
      SELECTION.rights,
      SELECTION.sourceUrl,
    ]) {
      expect(explanation.includes(value), `explanation shows ${value}`).toBe(true);
    }
    // The explanation is a distinct artifact from the full specimen and says so.
    expect(explanation).toContain('Open full component specimen');
    // Every mapping names a sample that the measured evidence actually holds.
    const evidence = JSON.parse(readDemoText('raw-image-analysis.json')) as {
      samples: Array<{ id: string; hex: string }>;
    };
    for (const mapping of trace.mappings) {
      const measured = evidence.samples.find((sample) => sample.id === mapping.id);
      expect(measured, `mapping ${mapping.id} names a measured sample`).toBeDefined();
      expect(mapping.sample.hex).toBe(measured?.hex);
    }
  });

  it('carries current manifest rows for the explanation and the specimen', () => {
    const manifest = demoManifest();
    const traceText = readDemoText('brand/inspiration.json');
    expect(manifest.llm).toBe('none');
    // The specimen is a plain compile output; the explanation is composed from
    // three inputs, so its digest deliberately differs from the source hash.
    expect(manifest.outputs[SPECIMEN_VIEW_OUTPUT]).toBe(manifest.sourceHash);
    expect(manifest.outputs[INSPIRATION_VIEW_OUTPUT]).not.toBe(manifest.sourceHash);
    expect(manifest.outputSources?.[INSPIRATION_VIEW_OUTPUT]).toEqual([
      { label: 'core', sourcePath: null, kind: 'digest', sha256: manifest.sourceHash },
      { label: 'trace', sourcePath: 'inspiration.json', kind: 'text-lf', sha256: hashContent(traceText) },
      { label: 'asset', sourcePath: ASSET_RELATIVE, kind: 'binary', sha256: ASSET_SHA256 },
    ]);
    expect(manifest.outputSources?.[SPECIMEN_VIEW_OUTPUT]).toEqual([
      {
        label: SPECIMEN_CONTENT_SOURCE_LABEL,
        sourcePath: null,
        kind: 'digest',
        sha256: createHash('sha256')
          .update(readFileSync(path.join(DEMO_BRAND, 'dist', SPECIMEN_VIEW_OUTPUT)))
          .digest('hex'),
      },
    ]);
  });

  it('stays hermetic: it spawns only the production bin and touches no external source', () => {
    // The Step 36 pre-write gate consumed the operator's local record and the
    // GitHub issue ONCE. If a later edit reintroduced either here, `npm test`
    // would silently acquire a credential and network dependency and would go
    // red the moment that staging directory was cleaned up. Assert it against
    // this file's own source so the regression cannot land unnoticed.
    const source = readFileSync(THIS_FILE, 'utf8');
    // Drop the block and line comments that legitimately DISCUSS the gate;
    // what remains is the executable text.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Every child process this suite starts is the production Node binary.
    const spawnTargets = [...code.matchAll(/spawnSync\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
    expect(spawnTargets.length).toBeGreaterThan(0);
    expect([...new Set(spawnTargets)]).toEqual(['process']); // process.execPath

    // This suite READS no environment variable at all. That is the precise
    // property that keeps the operator's private staging root unreachable
    // from here - stronger than banning one variable's name, which the
    // PROVENANCE.md exclusion case above legitimately quotes as content.
    // `{ ...process.env }` is a spread with no property access and is fine;
    // `ONBRAND_NOW` is a value this suite WRITES into a child's env.
    const envReads = [...code.matchAll(/process\s*\.\s*env\s*\.\s*([A-Za-z_$][\w$]*)/g)].map(
      (m) => m[1],
    );
    expect(envReads).toEqual([]);

    // Each needle is assembled from pieces so that this list cannot match
    // itself - the check would be vacuous otherwise.
    const forbidden = [`node:${'http'}`, `node:${'net'}`, `api.${'github'}.com`, `${'fetch'}(`];
    for (const needle of forbidden) {
      expect(code.includes(needle), `executable test code must not name ${needle}`).toBe(false);
    }
  });
});

describe('real-artwork demo — the Step 39 acceptance record', () => {
  it('exists and carries the reviewed commit, both run IDs, and the limitations', () => {
    expect(existsSync(ACCEPTANCE_RECORD)).toBe(true);
    const record = readFileSync(ACCEPTANCE_RECORD, 'utf8');
    for (const value of [
      ACCEPTANCE.reviewedCommit,
      ACCEPTANCE.runId,
      ACCEPTANCE.selectionRunId,
      ACCEPTANCE.evidenceCreatedAt,
      ACCEPTANCE.decision,
      `#${ACCEPTANCE.issueNumber}`,
      `#${SELECTION.issueNumber}`,
      ASSET_SHA256,
      EXPECTED_REVIEW_STATUS,
      ...ACCEPTANCE.gates,
    ]) {
      expect(record.includes(value), `acceptance.md records ${value}`).toBe(true);
    }
    // The M3b record's `acceptedLimitations` array was empty. An empty array is
    // a real answer, and the file must SAY so rather than leave a reader unable
    // to tell "none" apart from "not transcribed". Only the record's own text
    // can settle that, so this regex is the whole check.
    expect(record).toMatch(/accepted limitations[\s\S]{0,400}?\bnone\b/i);
  });

  it('leaves every as-reviewed file byte-identical to the M3b record', () => {
    const record = readFileSync(ACCEPTANCE_RECORD, 'utf8');
    // The operator accepted these five digests before this step ran, so they
    // are the independent authority here - the committed tree is what is on
    // trial, and it does not get to supply its own expected values.
    for (const [relative, reviewed] of AS_REVIEWED) {
      expect(PROMOTION_MUTABLE.has(relative), `${relative} is not promotion-mutable`).toBe(false);
      expect(
        TRACKED_INVENTORY_AT_START.get(relative),
        `${relative} must still hash to the accepted M3b value`,
      ).toBe(reviewed);
      expect(record.includes(reviewed), `acceptance.md publishes the ${relative} digest`).toBe(true);
    }
  });

  it('publishes as-released digests for exactly the files promotion changed', () => {
    const record = readFileSync(ACCEPTANCE_RECORD, 'utf8');
    // One list of promotion-mutable paths, not two: if the smoke's exemption
    // set and this table ever diverge, a file could be silently exempted from
    // byte-identity while nothing pinned its released digest.
    expect(new Set(AS_RELEASED.map((row) => row.relative))).toEqual(PROMOTION_MUTABLE);
    for (const { relative, released, reviewed } of AS_RELEASED) {
      expect(
        TRACKED_INVENTORY_AT_START.get(relative),
        `${relative} must hash to its pinned as-released value`,
      ).toBe(released);
      expect(
        record.includes(released),
        `acceptance.md publishes the released ${relative} digest`,
      ).toBe(true);
      if (reviewed === null) continue;
      // Positive proof the promotion took effect: a released digest equal to
      // the reviewed one would mean nothing moved. Same guard style as the
      // reviewStatus assertions above.
      expect(released, `${relative} released digest must differ from its M3b value`).not.toBe(
        reviewed,
      );
      expect(TRACKED_INVENTORY_AT_START.get(relative)).not.toBe(reviewed);
    }
  });

  it('publishes no machine-local path', () => {
    const record = readFileSync(ACCEPTANCE_RECORD, 'utf8');
    // Same rule as PROVENANCE.md: the operator's private staging layout is
    // evidence about one workstation, not about the artwork, and goes stale
    // the moment that directory is cleaned up.
    expect(record).not.toMatch(/(?<![A-Za-z])[A-Za-z]:[\\/]/);
    expect(record).not.toMatch(/\\\\/);
    expect(record).not.toContain('inspiration-uat');
    expect(record).not.toContain('LOCALAPPDATA');
    expect(record).not.toContain('AppData');
    expect(record).not.toContain('onbrand-proposal-');
  });
});

describe('real-artwork demo — production check on a temporary copy', () => {
  it('passes the production check gate without touching the tracked tree', () => {
    const root = tempDir('onbrand-demo-check-');
    const copy = path.join(root, DEMO_SLUG);
    cpSync(DEMO_DIR, copy, { recursive: true });
    expect(inventory(copy)).toEqual(TRACKED_INVENTORY_AT_START);

    const report = runCheck(copy);
    expect(report.ok, JSON.stringify(report.findings)).toBe(true);
    expect(report.errorCount).toBe(0);

    // The gate is read-only: neither the copy nor the tracked tree moved.
    expect(inventory(copy)).toEqual(TRACKED_INVENTORY_AT_START);
    expect(inventory(DEMO_DIR)).toEqual(TRACKED_INVENTORY_AT_START);
  });
});

describe('real-artwork demo — production from-image smoke', () => {
  it(
    'recreates the whole proposal from the committed raster under OS temp, in under 60s',
    () => {
      const root = tempDir('onbrand-demo-smoke-');
      const inputDir = path.join(root, 'input');
      const outDir = path.join(root, 'out');
      mkdirSync(inputDir, { recursive: true });
      // The proposal directory is named from the input file's slug, so the
      // copy keeps the demo slug as its basename.
      const inputFile = path.join(inputDir, `${DEMO_SLUG}.jpg`);
      copyFileSync(path.join(DEMO_BRAND, ...ASSET_RELATIVE.split('/')), inputFile);

      // The producer is deterministic given the same bytes, the same operator
      // metadata, and a pinned clock; pin it to THIS tree's manifest timestamp
      // so the regeneration is comparable byte-for-byte.
      const pinnedNow = demoManifest().timestamp;
      const started = Date.now();
      const run = spawnSync(
        process.execPath,
        [
          BIN,
          'from-image',
          inputFile,
          '--title', SELECTION.title,
          '--alt', SELECTION.alt,
          '--creator', SELECTION.creator,
          '--artwork-date', SELECTION.artworkDate,
          '--source-url', SELECTION.sourceUrl,
          '--rights', SELECTION.rights,
          '--license-url', SELECTION.licenseUrl,
          '--retrieved-at', SELECTION.retrievedAt,
          '--out', outDir,
          '--no-llm',
          // No --catalog-root / --catalog-out: the paired catalog refresh is
          // Dev Observatory's boundary and is out of scope for this phase.
        ],
        { encoding: 'utf8', timeout: 110_000, env: { ...process.env, ONBRAND_NOW: pinnedNow } },
      );
      const elapsedMs = Date.now() - started;
      expect(run.status, run.stderr).toBe(EXIT_OK);
      // The 60s bound is MANDATED by the plan (Step 36 Done-when: "a
      // no-mock/no-network/no-catalog production smoke recreates the proposal
      // under OS temp within 60 seconds") - do not loosen or soften it.
      // Measured margin, recorded here so it is not re-litigated: 18.0 / 19.3 /
      // 19.6s isolated, and 33.5s worst under a full `npm test` run PLUS three
      // extra concurrent `from-image` processes (harder than real CI), leaving
      // 26.5s / 44% headroom with the whole suite still green. If this ever
      // does flake, the fix is the recorded follow-up (the greedy merge in
      // src/extract/image-palette.ts), not a looser gate.
      expect(elapsedMs, `from-image took ${elapsedMs}ms`).toBeLessThan(60_000);

      // Containment: the run produced exactly one proposal directory, entirely
      // inside the temp --out root, with no symlink escape and no catalog.
      expect(readdirSync(outDir)).toHaveLength(1);
      const proposal = path.join(outDir, readdirSync(outDir)[0]!);
      const produced = inventory(proposal);
      // Two properties that can actually go red, rather than a string test on
      // inventory()'s own keys: those keys are built by concatenating entry
      // names under `proposal`, so `path.relative` on them can never yield a
      // `..` segment and the old check was vacuously true.
      //   (a) inventory() records any symlink it meets as SYMLINK instead of
      //       following it, so an empty SYMLINK set means the producer emitted
      //       no link at all - a producer that began writing one fails here.
      //   (b) each produced file AND the root are resolved through the real
      //       filesystem, which catches an escape the walk cannot see: a
      //       reparse point / junction / mount lstat did not report as a link,
      //       or any entry whose real target lives outside the temp root.
      expect([...produced.values()]).not.toContain('SYMLINK');
      const proposalReal = realpathSync(proposal);
      for (const relative of produced.keys()) {
        const real = realpathSync(path.join(proposal, ...relative.split('/')));
        expect(
          real === proposalReal || real.startsWith(proposalReal + path.sep),
          `${relative} resolves to ${real}, outside ${proposalReal}`,
        ).toBe(true);
      }
      expect(existsSync(path.join(proposal, 'INCOMPLETE.md'))).toBe(false);
      expect(existsSync(path.join(root, '.observatory'))).toBe(false);
      expect([...produced.keys()].some((relative) => relative.includes('.observatory'))).toBe(false);

      // Build, preview, and check all succeed against the fresh proposal, and
      // all three are idempotent against a pinned clock.
      for (const command of ['build', 'preview', 'check']) {
        const step = spawnSync(process.execPath, [BIN, command, proposal], {
          encoding: 'utf8',
          timeout: 110_000,
          env: { ...process.env, ONBRAND_NOW: pinnedNow },
        });
        expect(step.status, `${command}: ${step.stderr}`).toBe(EXIT_OK);
      }
      expect(inventory(proposal)).toEqual(produced);
      expect(runCheck(proposal).ok).toBe(true);

      // Reproducibility: every file the producer owns must come back
      // byte-for-byte. The four promotion-mutable paths are compared
      // structurally instead, so Step 39 can flip reviewStatus without
      // rewriting this contract.
      const expectedProducerFiles = new Map(
        [...TRACKED_INVENTORY_AT_START].filter(([relative]) => !PROMOTION_MUTABLE.has(relative)),
      );
      const producedProducerFiles = new Map(
        [...produced].filter(([relative]) => !PROMOTION_MUTABLE.has(relative)),
      );
      expect(producedProducerFiles).toEqual(expectedProducerFiles);
      // PROVENANCE.md is hand-authored, so the producer must NOT emit one.
      expect(produced.has('PROVENANCE.md')).toBe(false);
      for (const relative of PROMOTION_MUTABLE) {
        if (relative === 'PROVENANCE.md') continue;
        expect(produced.has(relative), `producer emits ${relative}`).toBe(true);
      }

      // The regenerated draft agrees with the committed trace on everything
      // except the review status Step 39 owns.
      const freshTrace = assertValidInspirationTrace(
        JSON.parse(readFileSync(path.join(proposal, 'brand', 'inspiration.json'), 'utf8')),
      );
      const committedTrace = assertValidInspirationTrace(
        JSON.parse(readDemoText('brand/inspiration.json')),
      );
      // A fresh run always emits the producer's own state, which stays true
      // after Step 39 promotes the committed tree - hence PRODUCER_ and not
      // EXPECTED_REVIEW_STATUS here. Still the contract's enum, not a literal.
      expect(freshTrace.reviewStatus).toBe(PRODUCER_REVIEW_STATUS);
      expect({ ...freshTrace, reviewStatus: null }).toEqual({ ...committedTrace, reviewStatus: null });

      // Nothing in the repo moved: the whole cycle lived under OS temp.
      expect(inventory(DEMO_DIR)).toEqual(TRACKED_INVENTORY_AT_START);
    },
    // The 60s budget is asserted on the measured from-image duration above.
    // The case timeout is larger on purpose: the follow-on build/preview/check
    // spawns are outside that budget, and a real overrun should surface as the
    // explicit assertion failure rather than an opaque vitest timeout.
    180_000,
  );
});

describe('real-artwork demo — tracked-tree immutability', () => {
  it('leaves the committed example byte-identical after every case above', () => {
    expect(inventory(DEMO_DIR)).toEqual(TRACKED_INVENTORY_AT_START);
    // A guard against the inventory itself going vacuously empty.
    expect(TRACKED_INVENTORY_AT_START.size).toBeGreaterThanOrEqual(REQUIRED_FILES.length);
  });
});
