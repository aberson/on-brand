/**
 * Fake `claude` CLI bin (Step 9 review finding 2, #38): a REAL, schema-valid
 * mood verdict whose "mood" rationale happens to mention the hex "#4019a3"
 * (which contains the substring "401") -- but the process ALSO exits nonzero
 * (simulating some unrelated post-processing quirk after a genuine reply was
 * already written). Proves the vision-path auth-dead tightening in
 * `createClaudeVisionJudge`: a parseable JSON payload must win over an
 * auth-marker false-positive, so this reply must be JUDGED (parsed) like any
 * other reply -- never misclassified 'auth-dead' and silently absorbed by
 * `scoreMoodAxis`'s degrade path.
 */
const payload = {
  temperature: { verdict: 'PASS', rationale: 'Cool tones match the reference.' },
  value: { verdict: 'PASS', rationale: 'Tonal register matches.' },
  saturation: { verdict: 'PASS', rationale: 'Muted chroma matches.' },
  mood: { verdict: 'PASS', rationale: 'The accent hex #4019a3 reads as contemplative.' },
};
process.stdout.write(JSON.stringify(payload));
process.exitCode = 1;
