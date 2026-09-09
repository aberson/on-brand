/**
 * Capture the real static UI for README.md with Playwright Chromium.
 * Run from a checkout: node scripts/capture-readme.mjs
 * Demo projects live in a temporary, ignored directory; the released example
 * is opened read-only. No HTML, CSS, or displayed values are altered for capture.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const repo = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(repo, 'docs', 'images', 'readme');
const scratchParent = path.join(repo, '.observatory');
mkdirSync(output, { recursive: true });
mkdirSync(scratchParent, { recursive: true });
const scratch = mkdtempSync(path.join(scratchParent, 'readme-capture-'));
const example = path.join(repo, 'examples', 'inspiration', 'water-lilies');

function cli(...args) {
  const result = spawnSync(process.execPath, [path.join(repo, 'bin', 'onbrand.mjs'), ...args], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${args[0]} failed:\n${result.stdout}\n${result.stderr}`);
  console.log(`PASS: onbrand ${args[0]}`);
  return result.stdout;
}

let browser;
try {
  for (const [name, preset] of [['field-notes', 'house-docs'], ['web-app', 'default']]) {
    const project = path.join(scratch, name);
    cli('init', project, '--preset', preset);
    cli('build', project);
    cli('check', project);
    cli('preview', project);
  }
  const inputImage = path.join(scratch, 'water-lilies.jpg');
  copyFileSync(path.join(example, 'brand', 'assets', 'inspiration.jpg'), inputImage);
  cli('from-image', inputImage,
    '--title', 'Water Lilies', '--alt', 'Water lilies floating on a pond.', '--out', scratch);
  const proposalName = readdirSync(scratch).find(name => name.startsWith('onbrand-proposal-'));
  assert.ok(proposalName, 'from-image must create a proposal');
  const report = JSON.parse(cli('check', path.join(scratch, proposalName), '--json'));
  assert.equal(report.ok, true);
  const galleryPath = path.join(scratch, 'gallery.html');
  cli('gallery', '--root', scratch, '--out', galleryPath);
  cli('observatory-export', '--root', scratch);
  cli('inspiration-export', '--root', scratch);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  async function open(file) {
    await page.goto(pathToFileURL(file).href, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('img:visible').evaluateAll(images =>
      images.every(img => img.complete && img.naturalWidth > 0)), true, 'images must load');
  }

  await open(path.join(example, 'brand', 'dist', 'inspiration-to-implementation.html'));
  await page.screenshot({ path: path.join(output, 'inspiration.png') });
  await page.locator('#image-zoom-open').click();
  assert.equal(await page.locator('dialog').evaluate(dialog => dialog.open), true);
  await page.locator('dialog img').evaluate(img => img.decode());
  await page.locator('#image-zoom-close').click();
  await page.locator('#theme-toggle').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.locator('#theme-toggle').click();

  await page.setViewportSize({ width: 1100, height: 990 });
  await page.getByRole('link', { name: 'Open full component specimen' }).click();
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(output, 'specimen-light.png') });
  await page.locator('#theme-toggle').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.screenshot({ path: path.join(output, 'specimen-dark.png') });

  await page.setViewportSize({ width: 1440, height: 1200 });
  await open(galleryPath);
  assert.equal(await page.locator('article.brand').count(), 3);
  assert.equal(await page.locator('article.brand[data-provenance="proposal"]').count(), 1);
  // Frame the actual list/detail UI, excluding the machine-specific root header.
  const bounds = await page.locator('.layout').boundingBox();
  const secondCard = await page.locator('article.brand').nth(1).boundingBox();
  assert.ok(bounds && secondCard);
  await page.screenshot({ path: path.join(output, 'gallery.png'),
    clip: { x: bounds.x - 12, y: bounds.y - 12, width: bounds.width + 24,
      height: secondCard.y + secondCard.height - bounds.y + 24 } });
  await page.getByRole('link', { name: 'Open final specimen', exact: true }).first().click();
  await page.waitForLoadState('load');
  assert.equal(await page.title(), 'on-brand specimen');
  assert.deepEqual(errors, [], 'browser pages must have no uncaught errors');
  console.log(`Captured four screenshots in ${output}; theme, zoom, and gallery navigation passed.`);
} finally {
  if (browser) await browser.close();
  const relative = path.relative(scratchParent, scratch);
  assert.ok(relative.startsWith('readme-capture-') && path.dirname(relative) === '.',
    'cleanup must stay inside the owned scratch directory');
  rmSync(scratch, { recursive: true, force: true });
}
