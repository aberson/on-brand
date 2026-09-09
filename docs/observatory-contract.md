# on-brand observatory artifact contract

`onbrand observatory-export --root <workspace> [--out <file>]` writes a single
read-only snapshot for an observatory to consume. The default output is
`<workspace>/onbrand-observatory.json`.

An absolute `--out` must be inside `<workspace>`; a relative `--out` is resolved
from `<workspace>`. Targets inside any `brand/` source or dist payload, symlinks,
linked output ancestors, and non-file targets are rejected so an export cannot
replace consumer files through a path alias.

The command discovers existing `brand/` sets and runs the existing check gate. It
does not rebuild a consumer, open a browser, mutate token sources, or import/call
`dev-observatory`. Registry entries, labels, routes, and rendering remain owned
by dev-observatory.

## Versioning and bounds

The top level always begins with:

```json
{
  "schema": "onbrand.observatory",
  "schemaVersion": 1
}
```

Readers must reject a newer `schemaVersion` rather than guessing. Version 1 has
these producer-side limits, emitted in `limits` as well:

| Limit | Value | Behavior |
|---|---:|---|
| Brand details | 50 | Extra discovered brands are omitted and `summary.brandsTruncated` is `true`. |
| Findings per emitted brand | 12 | Extra findings are omitted and `check.findingsTruncated` is `true`. |
| Token groups per emitted brand | 16 | Extra groups are omitted and `tokenGroupsTruncated` is `true`. |
| Evidence fields per finding | 12 | Extra fields are omitted and `evidenceTruncated` is `true`. |
| Display/evidence text | 160 characters | Text is shortened with `…`; semantic locators are not shortened. |
| Complete artifact | 1,000,000 UTF-8 bytes | Export fails without replacing the target with an oversized document. |

`generatedAt` describes when on-brand observed the workspace. It is not proof
that any consumer was rebuilt or that its committed dist is fresh.

## Top-level document

```ts
interface ArtifactV1 {
  schema: 'onbrand.observatory';
  schemaVersion: 1;
  generatedAt: string; // ISO-8601 UTC
  limits: Record<string, number>;
  summary: {
    discoveredBrandCount: number; // before the brand-detail cap
    emittedBrandCount: number;
    brandsTruncated: boolean;
    finalCount: number;
    proposalCount: number;
    statusCounts: {
      adopted: number; proposal: number; incomplete: number; stale: number; invalid: number;
    };
  };
  brands: BrandV1[];
}
```

Counts cover every discovered brand, while `brands` is the bounded detail list.
This makes a sparse or truncated view visibly distinct from a true zero.

## Brand list/detail record

`id` is an opaque deterministic key derived from `relPath`. `relPath` and
`specimenPath`, when present, are always forward-slash paths relative to the
explicit workspace root; the artifact deliberately contains no absolute root or
`brandDir` path. Diagnostic paths are likewise redacted, including absolute
paths to broken external extends targets.

```ts
interface BrandV1 {
  id: string;
  name: string;
  relPath: string;
  status: 'adopted' | 'proposal' | 'incomplete' | 'stale' | 'invalid';
  provenance: 'adopted' | 'proposal';
  final: boolean; // true only for status === 'adopted'
  hasTokens: boolean;
  hasDist: boolean;
  incompleteMarker: boolean;
  darkMode: boolean;
  tokenGroups: string[];
  tokenGroupsTruncated: boolean;
  reason: string;
  specimenPath?: string; // existing <relPath>/brand/dist/specimen.html only
  error?: string; // present for invalid sources
  check: CheckAvailableV1 | CheckUnavailableV1;
}
```

An adopted brand is the only final brand. A proposal remains `final: false`
even when it has a fresh dist. A stale brand has existing output that no longer
matches sources; consumers should surface that state rather than presenting it
as current.

## Check record and findings

Checks are intentionally represented as `available` or `unavailable`; an
unavailable check is never equivalent to zero findings.

```ts
interface CheckAvailableV1 {
  state: 'available';
  ok: boolean;
  errorCount: number;
  warningCount: number;
  advisoryCount: number;
  findingCount: number; // before finding cap
  findingsTruncated: boolean;
  findings: FindingV1[];
}

interface CheckUnavailableV1 {
  state: 'unavailable';
  reason: string;
}

interface FindingV1 {
  severity: 'error' | 'warning' | 'advisory';
  category: 'wcag' | 'apca' | 'schema' | 'stale-dist';
  code: string;
  path?: string; // token dot-path or dist-relative output
  message: string;
  evidence: Record<string, string | number | boolean>;
  evidenceTruncated: boolean;
  nextCommand: string; // safe command, run from the affected project root
}
```

`code` is the stable machine-facing discriminator; `message` is explanatory
text for people. A `stale-dist-output-missing` finding, for example, contains
the missing `output` and `fileExists: false`; an outdated output includes both
recorded and current source hashes. Every finding includes named evidence and a
safe follow-up command. Source/token fixes are manual by design; their follow-up
is `onbrand check`. Generated-output drift uses `onbrand build`.

## Producer and reader rules

- Generate only from an explicit workspace root. Discovery retains its bounded
  traversal and exclusion set, and skips linked descendants/payloads.
- Treat all display strings as untrusted filesystem/token content and escape
  them at render time.
- Resolve every relative path under the configured on-brand project root; reject
  traversal, symlink escape, malformed JSON, unsupported schema versions, or an
  artifact over the reader's size limit.
- Do not invoke `onbrand` automatically while reading this file. Refreshing the
  artifact is an explicit project-owned action.

The committed representative fixture is
[`test/fixtures/gallery/observatory-v1.json`](../test/fixtures/gallery/observatory-v1.json).
It includes adopted, proposal, and stale states and is covered by the exporter
contract tests.
