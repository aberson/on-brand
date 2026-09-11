// A separate thread keeps upload/progress requests responsive during color clustering.
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { register } from 'tsx/esm/api';

register();
const { runFromImage } = await import('../extract/from-image.ts');
const { selectPaletteDecision } = await import('../extract/normalize.ts');
try {
  const result = await runFromImage(workerData.file, {
    ...workerData.options,
    onStage: stage => parentPort.postMessage({ type: 'stage', stage }),
  });
  if (result.status !== 'complete') throw new Error(result.error ?? 'Theme generation did not finish.');
  const evidence = JSON.parse(readFileSync(path.join(result.proposalDir, 'raw-image-analysis.json'), 'utf8'));
  const trace = JSON.parse(readFileSync(path.join(result.brandDir, 'inspiration.json'), 'utf8'));
  const samples = evidence.samples.map(sample => {
    let selectable = false;
    try {
      selectPaletteDecision(evidence, { primarySampleId: sample.id, primarySelectionSource: 'user' });
      selectable = true;
    } catch { /* Neutral or insufficiently supported samples are display-only. */ }
    return { id: sample.id, hex: sample.hex, selectable };
  });
  parentPort.postMessage({ type: 'complete', proposalDir: result.proposalDir, samples, primarySampleId: trace.analysis.primary.sampleId });
} catch (error) {
  parentPort.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
}
