/**
 * Fake `claude` CLI bin (Step 9 tests, #38): the happy path for
 * `src/eval/mood-judge.ts`'s production `VisionJudge`. Emits a single
 * schema-valid JSON object with all 4 mood attributes PASS, regardless of
 * prompt content (mood-judge's prompt has only one shape, unlike llm.ts's 3
 * distinct passes) -- stands in for the real claude CLI so the REAL
 * spawn/stream/parse/classify code in `createClaudeVisionJudge()` executes
 * offline (no network, no live claude), mirroring the Step 11 fake-bins
 * pattern (`test/helpers/fake-bins/claude-ok.js`).
 */
const payload = {
  temperature: { verdict: 'PASS', rationale: 'Fake reviewer: cool tones match the reference.' },
  value: { verdict: 'PASS', rationale: 'Fake reviewer: tonal register matches.' },
  saturation: { verdict: 'PASS', rationale: 'Fake reviewer: muted chroma matches.' },
  mood: { verdict: 'PASS', rationale: 'Fake reviewer: contemplative atmosphere matches.' },
};
process.stdout.write(JSON.stringify(payload));
