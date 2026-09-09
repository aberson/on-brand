/**
 * Brand-Fidelity Benchmark — report generator (plan §5/§7, Step 10, #39).
 *
 * Renders a `SuiteRollup` (`src/eval/score.ts`) + a `MoodSuiteResult` into a
 * single Markdown report: per-site fidelity table, fidelity/a11y summaries,
 * slider-coverage rollup, weak-region rollup, the three known-finding
 * call-outs (#25/#26/#27), and a punch list.
 *
 * ------------------------------------------------------------------ PURE ---
 * `generateReport` is a PURE function: `(ReportInput) -> string`. No I/O, no
 * network, no wall-clock (a `generatedAt` string is accepted as an OPTIONAL
 * caller-supplied field — this module never calls `Date.now()`/`new Date()`
 * itself), no randomness. Every number in the output is read straight off the
 * `SuiteRollup` / `CorpusFidelityEntry[]` the caller (`src/eval/corpus-runner.ts`,
 * the I/O-ful assembler) computed from REAL scored results — this file never
 * re-derives a score and never special-cases a corpus id. That is what makes
 * the "known findings" section non-hard-coded: it is a straight readout of
 * `rollup.accentRecoveryFailures` / `rollup.backgroundMismatches` /
 * `rollup.categoricalSameness`, whatever those happen to contain for the
 * corpus handed in.
 *
 * ------------------------------------------------------------- replay vs refresh ---
 * `input.mode` is stamped into the report's opening scope note verbatim
 * (measurement-validity "match measurement scope to decision scope"): a
 * `'replay'` report measures NORMALIZE + PICK + RENDER fidelity against
 * committed fixtures (deterministic, reproducible) — it does NOT measure live
 * extraction drift. A `'refresh'` report additionally carries `input.drift`
 * (per-site live-vs-fixture diff summaries from `corpus-runner.ts`) and the
 * scope note says so explicitly. The report never conflates the two: a
 * replay report's "known findings" and fidelity numbers are about the
 * committed fixtures only.
 *
 * -------------------------------------------------------------- mood degrade ---
 * `input.mood.status` is one of `'judged' | 'unavailable' | 'not-run'`
 * (mirrors `mood-judge.ts`'s `MoodAxisStatus` plus a `'not-run'` state for
 * "the corpus runner was not asked to attempt mood at all", e.g. a fast
 * colour/font-only pass). `'unavailable'` renders the reason VERBATIM (never
 * a fabricated PASS/FAIL) — the report is honest that the mood axis could not
 * be judged, while every other section (colour, font, structural, a11y)
 * still renders in full: the three known findings are colour/structural, not
 * mood-dependent, so a dead `claude` auth never blocks face validity on them.
 */

import type { AggregatedVerdict } from './mood-judge.ts';
import type { CorpusFidelityEntry, SuiteRollup } from './score.ts';

// --- mood + drift input shapes ------------------------------------------------

export type MoodSuiteStatus = 'judged' | 'unavailable' | 'not-run';

export interface MoodSitePassthrough {
  siteId: string;
  overall: AggregatedVerdict;
}

export interface MoodSuiteResult {
  status: MoodSuiteStatus;
  /** Present when `status === 'unavailable'` — the real degrade reason (mirrors `mood-judge.ts`'s `MOOD_CLI_ABSENT_REASON`/`MOOD_AUTH_DEAD_REASON`), never fabricated. */
  reason?: string;
  /** Present when `status === 'judged'` — one entry per site actually judged. */
  perSite?: MoodSitePassthrough[];
}

export interface SiteDriftEntry {
  siteId: string;
  /** True when the live re-extraction's colour cluster count / top clusters differ meaningfully from the committed fixture. Left as a simple boolean signal here — `corpus-runner.ts` computes the comparison; this module only renders it. */
  changed: boolean;
  note: string;
}

export interface ReportInput {
  /** `'replay'` (default, deterministic, committed fixtures) or `'refresh'` (live re-extraction drift gate). */
  mode: 'replay' | 'refresh';
  /** Caller-supplied timestamp string (report.ts never reads the clock itself). Omit to leave the report timestamp-free (still fully valid — useful for byte-identical golden comparisons in tests). */
  generatedAt?: string;
  /** Every corpus site's full scored record, in the order to render the per-site table. */
  sites: readonly CorpusFidelityEntry[];
  /** The suite-level rollup computed from `sites` via `buildSuiteRollup` (score.ts). */
  rollup: SuiteRollup;
  /** The mood axis's suite-level result (degrades gracefully; see file header). */
  mood: MoodSuiteResult;
  /** Only meaningful when `mode === 'refresh'` — per-site live-vs-fixture drift notes. */
  drift?: SiteDriftEntry[];
}

// --- small render helpers (pure string builders, no markdown lib dependency) ---

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

function fmtScore(score: number): string {
  return score.toFixed(2);
}

function fmtDeltaE(deltaE: number): string {
  return deltaE.toFixed(1);
}

function tableRow(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

function mark(value: boolean): string {
  return value ? 'PASS' : 'FAIL';
}

function moodCellFor(siteId: string, mood: MoodSuiteResult): string {
  if (mood.status === 'not-run') return 'not run';
  if (mood.status === 'unavailable') return 'UNAVAILABLE';
  const entry = mood.perSite?.find((m) => m.siteId === siteId);
  return entry ? entry.overall : 'not judged';
}

// --- sections ------------------------------------------------------------

function renderHeader(input: ReportInput): string {
  const lines = ['# Brand-Fidelity Report', ''];
  if (input.generatedAt !== undefined) lines.push(`Generated: ${input.generatedAt}`, '');
  const scopeNote =
    input.mode === 'replay'
      ? 'Scope: **replay mode** — every site was scored by replaying its committed ' +
        '`raw-extraction.json` fixture through the production normalize/pick/render ' +
        'pipeline (deterministic, no network). This measures **normalize + pick + ' +
        'render fidelity**, NOT live extraction — a `--refresh` run is a separate, ' +
        'independent live-drift gate (see below) that the tune-loop must never touch.'
      : 'Scope: **refresh mode** — every site was additionally re-extracted LIVE and ' +
        'diffed against its committed fixture (see the Live-Drift section). Fidelity ' +
        'numbers below still come from the committed-fixture replay, unchanged by ' +
        '`--refresh` — refresh only adds the drift signal on top.';
  lines.push(scopeNote, '');
  return lines.join('\n');
}

function renderPerSiteTable(input: ReportInput): string {
  const lines = [
    '## Per-site fidelity',
    '',
    tableRow(['id', 'archetype', 'control', 'accent ΔE', 'recovered', 'bg ΔE (L/D)', 'font', 'a11y', 'mood', 'overall']),
    tableRow(['---', '---', '---', '---', '---', '---', '---', '---', '---', '---']),
  ];
  for (const site of input.sites) {
    const bg = site.fidelity.color.background;
    const bgCell = `${bg.light ? fmtDeltaE(bg.light.deltaE) : '-'}/${bg.dark ? fmtDeltaE(bg.dark.deltaE) : '-'}`;
    lines.push(
      tableRow([
        site.entry.id,
        site.entry.archetype,
        site.entry.isControl ? 'yes' : '',
        fmtDeltaE(site.fidelity.color.accent.deltaE),
        site.fidelity.color.accentRecovered ? 'yes' : 'no',
        bgCell,
        mark(site.fidelity.font.pass),
        site.fidelity.cvd.allDistinguishable ? 'ok' : 'FAIL',
        moodCellFor(site.entry.id, input.mood),
        mark(site.fidelity.pass),
      ]),
    );
  }
  lines.push('');
  return lines.join('\n');
}

function renderFidelitySummary(rollup: SuiteRollup): string {
  const f = rollup.fidelity;
  return [
    '## Fidelity rollup',
    '',
    `- Sites scored: ${f.sitesScored} (real: ${f.real.total}, czg controls: ${f.control.total}, ` +
      `controls weighted ${f.control.total > 0 ? 'x0.4 in the weighted rate below' : 'n/a'}).`,
    `- Real-site pass rate (unweighted): ${f.real.total > 0 ? pct(f.real.passed / f.real.total) : 'n/a'} (${f.real.passed}/${f.real.total}).`,
    `- Control-site pass rate (unweighted): ${f.control.total > 0 ? pct(f.control.passed / f.control.total) : 'n/a'} (${f.control.passed}/${f.control.total}).`,
    `- Weighted overall pass rate (czg controls at 0.4x): ${pct(f.weightedPassRate)}.`,
    `- Weighted mean colour-fidelity score: ${fmtScore(f.weightedMeanColorScore)}.`,
    '- Monet mood-anchor presets are EXCLUDED from this rollup entirely (they are not corpus entries — see the Mood section).',
    '',
  ].join('\n');
}

function renderA11y(rollup: SuiteRollup): string {
  const a = rollup.a11y;
  const lines = [
    '## Accessibility / CVD axis (reported separately — never folded into fidelity)',
    '',
    `- Sites checked: ${a.sitesChecked}.`,
    `- Distinguishable (all 3 dichromat types x light+dark): ${pct(a.distinguishableRate)} (${a.distinguishableCount}/${a.sitesChecked}).`,
  ];
  if (a.failingSiteIds.length > 0) {
    lines.push(`- Failing sites: ${a.failingSiteIds.join(', ')}.`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderSliderCoverage(rollup: SuiteRollup): string {
  const lines = [
    '## Slider-coverage rollup (8 palette-space axes x low/mid/high tercile)',
    '',
    tableRow(['axis', 'bucket', 'sites', 'weighted pass rate', 'mean colour score']),
    tableRow(['---', '---', '---', '---', '---']),
  ];
  for (const bucket of rollup.sliderCoverage) {
    lines.push(
      tableRow([
        bucket.axis,
        bucket.bucket,
        String(bucket.siteIds.length),
        bucket.siteIds.length > 0 ? pct(bucket.weightedPassRate) : 'n/a',
        bucket.siteIds.length > 0 ? fmtScore(bucket.meanColorScore) : 'n/a',
      ]),
    );
  }
  lines.push('');
  return lines.join('\n');
}

function renderWeakRegions(rollup: SuiteRollup): string {
  const lines = ['## Weak-region rollup', ''];
  if (rollup.sliderWeakRegions.length === 0) {
    lines.push('- No palette-space slider bucket fell below the weak-region pass-rate bar with enough weighted evidence.');
  } else {
    for (const region of rollup.sliderWeakRegions) {
      lines.push(`- ${region.description}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function renderKnownFindings(rollup: SuiteRollup): string {
  const lines = ['## Known-finding reproduction (derived from the scores above, not hard-coded)', ''];

  // #27 — accent-vs-action-blue gap.
  lines.push('### #27 — accent-recovery failures ("the accent-vs-action-blue gap")', '');
  if (rollup.accentRecoveryFailures.length === 0) {
    lines.push('- No real site failed accent recovery in this run.');
  } else {
    for (const f of rollup.accentRecoveryFailures) {
      lines.push(`- **${f.siteId}**: shipped seed \`${f.shippedSeedHex}\` vs true accent \`${f.pinnedAccentHex}\` (ΔE ${fmtDeltaE(f.deltaE)}).`);
    }
  }
  lines.push('');

  // #25 — GitHub's dark-background mismatch. DISCRIMINATING: only MATERIAL
  // mismatches (fail color-fidelity.ts's own calibrated backgroundMatch gate),
  // worst-first, magnitude-scaled severity — see score.ts's file header for
  // why an earlier "any non-exact ΔE" version was noise, not signal.
  lines.push('### #25 — material background mismatches ("GitHub\'s dark-background mismatch")', '');
  if (rollup.materialBackgroundMismatches.length === 0) {
    lines.push('- No real site\'s background MATERIALLY missed its pinned truth in this run (all cleared color-fidelity.ts\'s own backgroundMatch gate).');
  } else {
    lines.push(`- ${rollup.materialBackgroundMismatches.length} material mismatch(es), worst first:`);
    for (const m of rollup.materialBackgroundMismatches) {
      lines.push(
        `  - **${m.siteId}** (${m.side}, ${m.severity}): shipped \`${m.shippedHex}\` vs true \`${m.pinnedHex}\` (ΔE ${fmtDeltaE(m.deltaE)}, ${(m.severityRatio).toFixed(2)}x the pass gate, confidence: ${m.confidence}).`,
      );
    }
  }
  const exact = rollup.backgroundExactMatchStats;
  lines.push(
    '',
    `- _Informational, not itself a finding_: ${exact.exactCount}/${exact.sidesChecked} real-site background sides are a BYTE-exact reproduction of the pinned truth ` +
      '(`color.semantic.bg` is always ramp-synthesized by construction, so a low count here is expected and is not, on its own, evidence of a fidelity problem).',
  );
  const cross = rollup.issue25CrossCheck;
  if (cross !== null) {
    lines.push(
      '',
      `- **Face-validity cross-check (issue #25's own historical claim, ${cross.siteId}/${cross.side})**: shipped \`${cross.shippedHex}\` vs true \`${cross.pinnedHex}\` — ΔE ${fmtDeltaE(cross.deltaE)} against a materiality gate of ${cross.materialityThreshold.toFixed(1)}. ` +
        (cross.flaggedAsMaterial
          ? 'The current instrument AGREES with the original operator eyeball: this is flagged as a material mismatch above.'
          : 'The current instrument DISAGREES with the original operator eyeball ("the background color doesn\'t really match") — this ΔE clears the materiality gate and is not one of the worse real-site offenders. Either the ΔE2000 gate is too lenient for near-black tones, or issue #25\'s real complaint (the tool never reuses a site\'s own extracted dark-background cluster, even when one is clearly observed) is not fully captured by a pinned-hex distance at all. Flagged here for Step 11 operator judgment, not silently dropped.'),
    );
  }
  lines.push('');

  // #26 — categorical-sameness.
  lines.push('### #26 — categorical-sameness (structural)', '');
  const cs = rollup.categoricalSameness;
  const total = cs.matchingSiteIds.length + cs.differingSiteIds.length;
  if (cs.detected) {
    lines.push(
      `- **Detected**: ${cs.matchingSiteIds.length}/${total} sites (${pct(cs.matchFraction)}) ship a BYTE-IDENTICAL ` +
        `\`chart.categorical.2-8\` tail regardless of brand — only \`categorical-1\` tracks the seed.`,
      `  - Shared tail: ${(cs.sharedPalette ?? []).join(', ')}`,
    );
    if (cs.differingSiteIds.length > 0) {
      lines.push(`  - Sites that differ: ${cs.differingSiteIds.join(', ')}`);
    }
  } else {
    lines.push(
      `- Not detected in this run: only ${cs.matchingSiteIds.length}/${total} sites (${pct(cs.matchFraction)}) share an identical categorical tail (below the ${pct(0.9)} bar).`,
    );
  }
  lines.push('');

  return lines.join('\n');
}

function renderMood(mood: MoodSuiteResult): string {
  const lines = ['## Mood axis', ''];
  if (mood.status === 'not-run') {
    lines.push('- Not run for this report.');
  } else if (mood.status === 'unavailable') {
    lines.push(`- **UNAVAILABLE**: ${mood.reason ?? 'no reason recorded'} — no score fabricated.`);
  } else {
    lines.push(`- Judged for ${mood.perSite?.length ?? 0} site(s):`);
    for (const site of mood.perSite ?? []) {
      lines.push(`  - ${site.siteId}: ${site.overall}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function renderDrift(input: ReportInput): string {
  if (input.mode !== 'refresh') return '';
  const lines = ['## Live-drift (--refresh)', ''];
  if (input.drift === undefined || input.drift.length === 0) {
    lines.push('- No drift data was supplied for this refresh run.');
  } else {
    for (const d of input.drift) {
      lines.push(`- **${d.siteId}**: ${d.changed ? 'CHANGED' : 'unchanged'} — ${d.note}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function renderPunchList(rollup: SuiteRollup): string {
  const lines = ['## Punch list', ''];
  if (rollup.punchList.length === 0) {
    lines.push('- Nothing to flag.');
  } else {
    for (const item of rollup.punchList) {
      lines.push(`- **[${item.severity}] ${item.id}** — ${item.summary}`);
      lines.push(`  - Evidence: ${item.evidence}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Render the full brand-fidelity report as Markdown. Pure function of
 * `input` — see file header. Section order: header/scope, per-site table,
 * fidelity rollup, a11y axis, slider-coverage rollup, weak-region rollup,
 * known-finding reproduction (#25/#27/#26), mood axis, live-drift (refresh
 * only), punch list.
 */
export function generateReport(input: ReportInput): string {
  const sections = [
    renderHeader(input),
    renderPerSiteTable(input),
    renderFidelitySummary(input.rollup),
    renderA11y(input.rollup),
    renderSliderCoverage(input.rollup),
    renderWeakRegions(input.rollup),
    renderKnownFindings(input.rollup),
    renderMood(input.mood),
    renderDrift(input),
    renderPunchList(input.rollup),
  ].filter((s) => s.length > 0);

  return sections.join('\n');
}
