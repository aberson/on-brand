import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/check/run.ts';
import { buildInspirationArtifact } from '../src/inspiration/export.ts';
import { validateInspirationTrace } from '../src/inspiration/contract.ts';
import { startStudio } from '../src/studio/server.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

async function sourceImage(): Promise<Buffer> {
  const width = 384;
  const pixels = Buffer.alloc(width * 180 * 3);
  for (let y = 0; y < 180; y++) for (let x = 0; x < width; x++) {
    const rgb = x < 180 ? [100, 114, 143] : x < 290 ? [16, 16, 19] : x < 330 ? [244, 245, 246] : [228, 25, 30];
    pixels.set(rgb, (y * width + x) * 3);
  }
  return sharp(pixels, { raw: { width, height: 180, channels: 3 } }).png().toBuffer();
}

interface JobResult {
  id: string; status: string; error?: string; proposalDir: string;
  samples: { id: string; hex: string; selectable: boolean }[]; primarySampleId: string;
}

async function finished(url: string, token: string, id: string): Promise<JobResult> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await fetch(url + 'api/jobs/' + id, { headers: { 'X-Onbrand-Token': token } });
    const job = await result.json() as JobResult;
    if (job.status !== 'running') return job;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Studio job did not finish within 20 seconds.');
}

describe('local image studio', () => {
  it('generates a real proposal, changes to a measured red accent, and preserves the automatic version', async () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-studio-'));
    const studio = await startStudio({ outDir });
    try {
      const html = await (await fetch(studio.url)).text();
      const token = /name="onbrand-token" content="([^"]+)"/.exec(html)![1]!;
      const headers = { 'X-Onbrand-Token': token, Origin: new URL(studio.url).origin, 'Content-Type': 'application/octet-stream' };
      const bytes = await sourceImage();
      const begin = async (suffix = '') => {
        const res = await fetch(studio.url + 'api/jobs?name=palette.png&title=Test%20palette' + suffix,
          { method: 'POST', headers, body: new Uint8Array(bytes) });
        expect(res.status).toBe(202);
        return finished(studio.url, token, ((await res.json()) as { id: string }).id);
      };
      const automatic = await begin();
      expect(automatic.status, automatic.error).toBe('complete');
      const firstTokens = readFileSync(path.join(automatic.proposalDir, 'brand/tokens.json'));
      const red = automatic.samples.find(sample => sample.hex === '#e4191e')!;
      expect(red.selectable).toBe(true);
      expect(automatic.primarySampleId).not.toBe(red.id);
      const selected = await begin('&accent=' + red.id);
      expect(selected.status, selected.error).toBe('complete');
      expect(selected.proposalDir).not.toBe(automatic.proposalDir);
      expect(readFileSync(path.join(automatic.proposalDir, 'brand/tokens.json')).equals(firstTokens)).toBe(true);
      expect(readFileSync(path.join(selected.proposalDir, 'raw-image-analysis.json')).equals(
        readFileSync(path.join(automatic.proposalDir, 'raw-image-analysis.json')))).toBe(true);
      const trace = JSON.parse(readFileSync(path.join(selected.proposalDir, 'brand/inspiration.json'), 'utf8'));
      expect(trace.schemaVersion).toBe(2);
      expect(trace.analysis.primary).toEqual({ sampleId: red.id, selectionSource: 'user' });
      expect(trace.mappings[0].sample.hex).toBe(red.hex);
      expect(trace.reviewStatus).toBe('generated-draft');
      expect(validateInspirationTrace(trace).ok).toBe(true);
      expect(validateInspirationTrace({ ...trace, schemaVersion: 1 }).ok).toBe(false);
      expect(validateInspirationTrace({ ...trace, schemaVersion: 999 }).ok).toBe(false);
      expect(runCheck(selected.proposalDir).ok).toBe(true);
      const manifest = JSON.parse(readFileSync(path.join(selected.proposalDir, 'brand/dist/manifest.json'), 'utf8'));
      expect(manifest.llm).toBe('none');
      const catalog = buildInspirationArtifact({ root: outDir });
      expect(catalog.schemaVersion).toBe(2);
      expect(catalog.items.every(item => item.traceState === 'available')).toBe(true);
      const preview = await fetch(studio.url + 'jobs/' + selected.id + '/specimen.html');
      expect(preview.status).toBe(200);
      expect(await preview.text()).toContain('tokens.css');
      const css = await (await fetch(studio.url + 'jobs/' + selected.id + '/tokens.css')).text();
      expect(css).toContain('--color-semantic-accent: #e20000');
      expect((await fetch(studio.url + 'jobs/' + selected.id + '/manifest.json')).status).toBe(404);
      expect((await fetch(studio.url + 'jobs/' + selected.id + '/../../package.json')).status).toBe(404);
    } finally { await studio.close(); rmSync(outDir, { recursive: true, force: true }); }
  });

  it('rejects foreign requests and bounded upload failures, then recovers for a valid image', async () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-studio-guards-'));
    const studio = await startStudio({ outDir });
    try {
      const token = /name="onbrand-token" content="([^"]+)"/.exec(await (await fetch(studio.url)).text())![1]!;
      const headers = { 'X-Onbrand-Token': token, Origin: new URL(studio.url).origin, 'Content-Type': 'application/octet-stream' };
      const endpoint = studio.url + 'api/jobs?name=bad.png';
      expect((await fetch(endpoint, { method: 'POST', body: 'bad' })).status).toBe(403);
      expect((await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: 'bad' })).status).toBe(403);
      const foreignHost = await new Promise<number>((resolve, reject) => {
        const req = request(studio.url, { headers: { Host: 'example.com' } }, res => {
          res.resume(); res.on('end', () => resolve(res.statusCode!));
        });
        req.on('error', reject); req.end();
      });
      expect(foreignHost).toBe(403);
      expect((await fetch(endpoint, { method: 'POST', headers, body: new Uint8Array(5_000_001) })).status).toBe(413);
      expect(readdirSync(outDir)).toEqual([]);
      const chunkedStatus = await new Promise<number>((resolve, reject) => {
        const req = request(endpoint, { method: 'POST', headers: { ...headers, 'Transfer-Encoding': 'chunked' } }, res => {
          res.resume(); res.on('end', () => resolve(res.statusCode!));
        });
        req.on('error', reject);
        req.write(Buffer.alloc(2_500_000)); req.end(Buffer.alloc(2_500_001));
      });
      expect(chunkedStatus).toBe(413);
      const invalid = await fetch(endpoint, { method: 'POST', headers, body: 'not a PNG' });
      const failed = await finished(studio.url, token, ((await invalid.json()) as { id: string }).id);
      expect(failed.status).toBe('error');
      expect(failed.error).toBeTruthy();
      const valid = await fetch(endpoint, { method: 'POST', headers, body: new Uint8Array(await sourceImage()) });
      const done = await finished(studio.url, token, ((await valid.json()) as { id: string }).id);
      expect(done.status, done.error).toBe('complete');
    } finally { await studio.close(); rmSync(outDir, { recursive: true, force: true }); }
  });

  it('opens through the production CLI and supports drop, accent selection, preview modes, and Quit', async () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-studio-browser-'));
    const input = path.join(outDir, 'palette.png');
    const bytes = await sourceImage();
    writeFileSync(input, bytes);
    const child = spawn(process.execPath, [path.join(root, 'bin/onbrand.mjs'), 'studio', '--out', outDir],
      { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const exited = once(child, 'exit');
    const browser = await chromium.launch({ headless: true });
    try {
      await expect.poll(() => /Create brand: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(stdout)?.[1], { timeout: 10_000 }).toBeTruthy();
      const url = /Create brand: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(stdout)![1]!;
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route(/^https:/, route => route.abort());
      await page.goto(url);
      // Exercise real browser drag/drop, including the File passed to the upload request.
      const transfer = await page.evaluateHandle(`(() => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([Uint8Array.from(${JSON.stringify([...bytes])})], 'palette.png', { type: 'image/png' }));
        return transfer;
      })()`);
      await page.locator('#drop').dispatchEvent('drop', { dataTransfer: transfer });
      await expect.poll(() => page.locator('#status').textContent(), { timeout: 20_000 }).toContain('Theme saved');
      const firstPath = await page.locator('#saved-path').textContent();
      await page.getByRole('button', { name: 'Use #e4191e as main accent' }).click();
      await expect.poll(() => page.locator('#saved-path').textContent(), { timeout: 20_000 }).not.toBe(firstPath);
      await expect.poll(() => page.frameLocator('#preview').locator('html').getAttribute('data-theme')).toBe('dark');
      await page.locator('#mode').click();
      await expect.poll(() => page.frameLocator('#preview').locator('html').getAttribute('data-theme')).toBe('light');
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      }
      expect(errors).toEqual([]);
      await page.locator('#quit').click();
      await expect.poll(() => page.locator('#status').textContent()).toContain('Studio closed');
      expect((await exited)[0], stderr).toBe(0);
    } finally {
      await browser.close();
      if (child.exitCode === null) { child.kill(); await exited; }
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});
