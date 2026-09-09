/**
 * Fake `claude` CLI bin (Step 11 tests): the happy path. Stands in for
 * `claude -p "<prompt>"` so the REAL spawn/stream/parse/retry code in
 * runLlmAssist() executes offline (no network, no live claude). Detects which
 * of the three passes it is answering from a unique TASK phrase in the prompt,
 * and emits a single schema-valid JSON object on stdout — the observable
 * contract llm.ts consumes.
 *
 * argv shape (what llm.ts passes): -p <prompt> [--allowedTools Read --add-dir <dir>]
 */
const args = process.argv.slice(2);
const pIdx = args.indexOf('-p');
const prompt = pIdx >= 0 && args[pIdx + 1] !== undefined ? args[pIdx + 1] : args.join(' ');

/** First real 6-digit hex in the prompt = candidate 1 (the only legal picks). */
function firstHex(text) {
  const m = text.match(/#[0-9a-fA-F]{6}/);
  return m ? m[0] : '#000000';
}

let payload;
if (prompt.includes('pick the single brand color')) {
  payload = {
    pick: firstHex(prompt),
    rationale: 'Fake reviewer: the highest-chroma candidate reads as the primary brand color.',
  };
} else if (prompt.includes('write a brief aesthetic summary')) {
  payload = {
    summary: 'Clean and modern with a cool, technical palette. It reads calm, precise, and trustworthy.',
  };
} else if (prompt.includes('draft a voice & tone section')) {
  payload = {
    bullets: ['Be clear and direct.', 'Stay warm, never stiff.', 'Prefer plain words.'],
    examples: [
      { before: 'Submit the form.', after: 'Send it our way.' },
      { before: 'An error occurred.', after: 'Something slipped -- let us fix it.' },
      { before: 'Purchase now.', after: 'Make it yours.' },
    ],
  };
} else {
  payload = { error: 'fake claude bin: unrecognized task in prompt' };
}

process.stdout.write(JSON.stringify(payload));
