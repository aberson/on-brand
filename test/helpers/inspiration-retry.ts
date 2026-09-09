import { expect } from 'vitest';

/** Extract the single exporter-owned command that follows a retry label. */
export function rawInspirationRetryCommand(stderr: string): string {
  const lines = stderr.split(/\r?\n/);
  const labels = lines.reduce<number[]>((all, line, index) => (
    line.endsWith('retry with:') ? [...all, index] : all
  ), []);
  expect(labels).toHaveLength(1);
  const command = lines[labels[0]! + 1];
  expect(command).toBeDefined();
  expect(command).not.toContain('retry with:');
  return command!;
}
