/** Local-only image creation UI. Each job creates a new ordinary proposal. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { MAX_IMAGE_BYTES } from '../extract/image-palette.ts';
import { imageSlug } from '../extract/proposal.ts';
import { assertUnlinkedDirectoryPath, stableReadRegularFile } from '../filesystem.ts';

interface Sample { id: string; hex: string; selectable: boolean }
interface Job {
  id: string;
  status: 'running' | 'complete' | 'error';
  stage: string;
  error?: string;
  proposalDir?: string;
  samples?: Sample[];
  primarySampleId?: string;
}
type WorkerMessage = { type: 'stage'; stage: string }
  | { type: 'error'; error: string }
  | { type: 'complete'; proposalDir: string; samples: Sample[]; primarySampleId: string };

const OUTPUT_TYPES: Record<string, string> = {
  'specimen.html': 'text/html; charset=utf-8',
  'inspiration-to-implementation.html': 'text/html; charset=utf-8',
  'tokens.css': 'text/css; charset=utf-8',
  'components.css': 'text/css; charset=utf-8',
  'palette.svg': 'image/svg+xml',
};

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function imageBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  if (Number(req.headers['content-length']) > MAX_IMAGE_BYTES) {
    req.resume();
    throw new RequestError(413, 'Choose an image smaller than 5 MB.');
  }
  await new Promise<void>((resolve, reject) => {
    req.on('data', (bytes: Buffer) => {
      length += bytes.length;
      if (length > MAX_IMAGE_BYTES) {
        chunks.length = 0;
        reject(new RequestError(413, 'Choose an image smaller than 5 MB.'));
      } else chunks.push(bytes);
    });
    req.on('end', resolve);
    req.on('error', reject);
    req.on('aborted', () => reject(new RequestError(400, 'The image upload was interrupted.')));
  });
  if (length === 0) throw new RequestError(400, 'Choose a PNG, JPEG, or WebP image.');
  return Buffer.concat(chunks, length);
}

export async function startStudio(options: { outDir: string; port?: number }): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const outDir = path.resolve(options.outDir);
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535.');
  mkdirSync(outDir, { recursive: true });
  assertUnlinkedDirectoryPath(outDir, 'brand output directory');
  const token = randomUUID();
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8').replace('__ONBRAND_TOKEN__', token);
  const jobs = new Map<string, Job>();
  let origin = '';
  let busy = false;
  let active: { worker: Worker; cleanup: () => void } | undefined;

  function startJob(job: Job, file: string, uploadDir: string, title: string, alt: string, accent?: string): void {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      // The worker registers its own TS loader; do not inherit eval/test/debug flags.
      execArgv: [],
      workerData: { file, options: { outDir, title, alt, ...(accent === undefined ? {} : { accentSampleId: accent }) } },
    });
    let settled = false;
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      busy = false;
      active = undefined;
      // uploadDir is exclusively created with mkdtemp under the OS temporary root.
      rmSync(uploadDir, { recursive: true, force: true });
    };
    const fail = (message: string): void => {
      if (settled) return;
      job.status = 'error';
      job.error ??= message;
      cleanup();
    };
    const timer = setTimeout(() => {
      job.status = 'error';
      job.error = 'This image took too long to process. Try a smaller or simpler image.';
      void worker.terminate().finally(cleanup);
    }, 120_000);
    active = { worker, cleanup };
    worker.on('message', (message: WorkerMessage) => {
      if (settled) return;
      if (message.type === 'stage') job.stage = message.stage;
      else if (message.type === 'error') fail(message.error);
      else {
        Object.assign(job, { status: 'complete', stage: 'complete', proposalDir: message.proposalDir,
          samples: message.samples, primarySampleId: message.primarySampleId });
        cleanup();
      }
    });
    worker.on('error', (error) => fail(error.message));
    worker.on('exit', () => fail('The image worker stopped before finishing.'));
  }

  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
    void (async () => {
      if (req.headers.host !== new URL(origin).host) throw new RequestError(403, 'Open the local address printed by onbrand studio.');
      if ((req.url?.length ?? 0) > 4096) throw new RequestError(400, 'Request is too long.');
      const url = new URL(req.url ?? '/', origin);
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (url.pathname.startsWith('/api/')) {
        if (req.headers['x-onbrand-token'] !== token) throw new RequestError(403, 'Reload the Create brand page and try again.');
        if (req.method === 'POST' && req.headers.origin !== origin) throw new RequestError(403, 'Only this local page can start generation.');
      }
      if (req.method === 'GET' && url.pathname === '/api/session') {
        reply(res, 200, { outDir, maxImageBytes: MAX_IMAGE_BYTES });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/shutdown') {
        if (busy) throw new RequestError(409, 'Wait for generation to finish before closing.');
        reply(res, 200, { stopped: true });
        setImmediate(() => { void closeStudio(); });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/jobs') {
        if (busy) throw new RequestError(409, 'An image is already being processed. Wait for it to finish.');
        if (req.headers['content-type'] !== 'application/octet-stream') throw new RequestError(415, 'Send a PNG, JPEG, or WebP image.');
        const name = url.searchParams.get('name') ?? 'image.png';
        const title = (url.searchParams.get('title') ?? 'Untitled brand').trim();
        const alt = (url.searchParams.get('alt') ?? `Source image for ${title}`).trim();
        const accent = url.searchParams.get('accent') ?? undefined;
        if (name.length > 240 || title.length < 1 || title.length > 120 || alt.length < 1 || alt.length > 240) {
          throw new RequestError(400, 'Use a name of 1–120 characters and a description of 1–240 characters.');
        }
        if (accent !== undefined && !/^sample-\d{2}$/.test(accent)) throw new RequestError(400, 'Choose an accent from this image’s swatches.');
        busy = true;
        let uploadDir: string | undefined;
        try {
          const bytes = await imageBody(req);
          assertUnlinkedDirectoryPath(outDir, 'brand output directory');
          uploadDir = mkdtempSync(path.join(os.tmpdir(), 'onbrand-upload-'));
          // Prefix avoids reserved Windows names such as CON; original names never become paths.
          const file = path.join(uploadDir, `image-${imageSlug(name)}.png`);
          writeFileSync(file, bytes, { flag: 'wx' });
          const job: Job = { id: randomUUID(), status: 'running', stage: 'measure' };
          // Bound session memory, retaining files on disk even when old links expire.
          if (jobs.size >= 50) jobs.delete(jobs.keys().next().value!);
          jobs.set(job.id, job);
          startJob(job, file, uploadDir, title, alt, accent);
          reply(res, 202, job);
        } catch (error) {
          busy = false;
          if (uploadDir !== undefined) rmSync(uploadDir, { recursive: true, force: true });
          throw error;
        }
        return;
      }
      const status = /^\/api\/jobs\/([a-f0-9-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && status) {
        const job = jobs.get(status[1]!);
        if (!job) throw new RequestError(404, 'This session no longer has that preview. Saved themes remain on disk.');
        reply(res, 200, job);
        return;
      }
      const output = /^\/jobs\/([a-f0-9-]+)\/([a-z.-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && output) {
        const job = jobs.get(output[1]!);
        const name = output[2]!;
        if (job?.status !== 'complete' || !job.proposalDir || !Object.hasOwn(OUTPUT_TYPES, name)) throw new RequestError(404, 'Preview not found.');
        const dist = path.join(job.proposalDir, 'brand', 'dist');
        assertUnlinkedDirectoryPath(dist, 'preview directory');
        const file = stableReadRegularFile(path.join(dist, name), { maxBytes: 8_000_000, requireSingleLink: true });
        if (!file) throw new RequestError(404, 'Preview file is unavailable.');
        res.writeHead(200, { 'Content-Type': OUTPUT_TYPES[name]! });
        res.end(file.bytes);
        return;
      }
      throw new RequestError(404, 'Not found.');
    })().catch((error: unknown) => {
      if (!res.headersSent) reply(res, error instanceof RequestError ? error.status : 500,
        { error: error instanceof Error ? error.message : 'The local request failed.' });
      else res.end();
    });
  });
  server.requestTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('Could not start the local studio.')); return; }
      origin = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
  let closing: Promise<void> | undefined;
  function closeStudio(): Promise<void> {
    closing ??= (async () => {
      const running = active;
      if (running) { await running.worker.terminate(); running.cleanup(); }
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    })();
    return closing;
  }
  return { url: origin + '/', close: closeStudio };
}
