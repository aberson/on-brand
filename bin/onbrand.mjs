#!/usr/bin/env node
// onbrand CLI entry. Registers tsx so the TypeScript sources run directly
// (no build step — plan.md §2: tsx + tsc + vitest, no bundler).
async function run() {
  let register;
  try {
    ({ register } = await import('tsx/esm/api'));
  } catch {
    console.error(
      'onbrand: dependencies not installed — run "npm install" in the on-brand repo first.',
    );
    process.exitCode = 3; // exit 3 = environment missing (plan.md §6)
    return;
  }
  register();
  const { main } = await import(new URL('../src/cli.ts', import.meta.url).href);
  process.exitCode = await main(process.argv.slice(2));
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
