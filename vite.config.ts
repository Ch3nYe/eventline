import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const eventlineEventsPath = resolve(__dirname, 'data/events.jsonl');
const eventlineExportsDir = resolve(__dirname, 'data/exports');
const eventlineMcpServerPath = resolve(__dirname, 'mcp_server.py');
const eventlineExportTheme = 'light';
const eventlineImageExportVersion = 'browser-clip-v6';
const execFileAsync = promisify(execFile);

type ImageExportOptions = {
  cacheKey?: string;
  highlightedTreeIds?: string[];
  layout?: Record<string, { x: number; y: number }>;
  theme?: string;
  visibleTreeIds?: string[];
};

function readRequestBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function hashImageExportKey(eventsContent: string, theme: string): string {
  return createHash('sha256')
    .update(eventsContent)
    .update('\n')
    .update(theme)
    .update('\n')
    .update(eventlineImageExportVersion)
    .digest('hex')
    .slice(0, 16);
}

function imageExportPath(filename: string): string {
  return `/eventline-data/exports/${filename}`;
}

function jsonResponse(res: import('node:http').ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  res.statusCode = statusCode;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function normalizeStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : undefined;
}

function normalizeLayout(value: unknown): Record<string, { x: number; y: number }> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const layout: Record<string, { x: number; y: number }> = {};
  for (const [id, position] of Object.entries(value as Record<string, unknown>)) {
    if (!position || typeof position !== 'object' || Array.isArray(position)) {
      continue;
    }
    const x = Number((position as Record<string, unknown>).x);
    const y = Number((position as Record<string, unknown>).y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      layout[id] = { x, y };
    }
  }
  return Object.keys(layout).length > 0 ? layout : undefined;
}

function imageExportOptionsFromBody(rawBody: string): ImageExportOptions {
  let body: unknown = {};
  if (rawBody.trim()) {
    body = JSON.parse(rawBody) as unknown;
  }
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const theme = typeof record.theme === 'string' && record.theme.trim() ? record.theme.trim().toLowerCase() : undefined;
  const visibleTreeIds = normalizeStringArray(record.visible_tree_ids);
  const highlightedTreeIds = normalizeStringArray(record.highlighted_tree_ids);
  const layout = normalizeLayout(record.layout);
  const cacheKey = record.cache_key && typeof record.cache_key === 'string' ? record.cache_key : undefined;
  return {
    cacheKey,
    highlightedTreeIds,
    layout,
    theme,
    visibleTreeIds,
  };
}

async function writeLatestImageMetadata(payload: Record<string, unknown>): Promise<void> {
  await mkdir(eventlineExportsDir, { recursive: true });
  await writeFile(resolve(eventlineExportsDir, 'latest.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

async function currentImageMetadata(options: ImageExportOptions = {}): Promise<Record<string, unknown>> {
  const eventsContent = await readFile(eventlineEventsPath, 'utf-8').catch(() => '');
  const theme = options.theme || eventlineExportTheme;
  const cacheKey = options.cacheKey || hashImageExportKey(eventsContent, theme);
  const filename = `eventline-${cacheKey}.png`;
  return {
    ok: true,
    mode: 'img',
    path: imageExportPath(filename),
    cache_key: cacheKey,
    theme,
    renderer_version: eventlineImageExportVersion,
    filename,
    outputPath: resolve(eventlineExportsDir, filename),
  };
}

async function ensureCachedImageExists(
  req: import('node:http').IncomingMessage,
  options: ImageExportOptions = {},
): Promise<Record<string, unknown>> {
  const metadata = await currentImageMetadata(options);
  const outputPath = String(metadata.outputPath);
  await mkdir(eventlineExportsDir, { recursive: true });
  try {
    await stat(outputPath);
    const payload = { ...metadata, cached: true, exported_at: new Date().toISOString() };
    delete payload.filename;
    delete payload.outputPath;
    await writeLatestImageMetadata(payload);
    return payload;
  } catch {
    // Cache miss: render a fresh browser screenshot.
  }

  const params = new URLSearchParams({ eventline_export: 'backend' });
  if (options.theme) {
    params.set('theme', options.theme);
  }
  if (options.visibleTreeIds !== undefined) {
    params.set('visible_tree_ids', options.visibleTreeIds.join(','));
  }
  if (options.highlightedTreeIds !== undefined) {
    params.set('highlighted_tree_ids', options.highlightedTreeIds.join(','));
  }
  const pageUrl = `${requestOrigin(req)}/?${params.toString()}`;
  await captureBackendEventlineImage(pageUrl, outputPath, options);
  const payload = { ...metadata, cached: false, exported_at: new Date().toISOString() };
  delete payload.filename;
  delete payload.outputPath;
  await writeLatestImageMetadata(payload);
  return payload;
}

async function findChromeExecutable(): Promise<string> {
  const candidates = [
    process.env.EVENTLINE_CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (candidate.includes('/')) {
      try {
        await stat(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    try {
      const { stdout } = await execFileAsync('which', [candidate]);
      const resolved = stdout.trim();
      if (resolved) {
        return resolved;
      }
    } catch {
      // Try the next executable name.
    }
  }

  throw new Error('No Chromium/Chrome executable found. Set EVENTLINE_CHROME_PATH to enable backend image export.');
}

async function waitForDevToolsPort(userDataDir: string): Promise<number> {
  const markerPath = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const content = await readFile(markerPath, 'utf-8');
      const port = Number(content.split(/\r?\n/)[0]);
      if (Number.isFinite(port) && port > 0) {
        return port;
      }
    } catch {
      // Chrome writes DevToolsActivePort after startup.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
  }
  throw new Error('Timed out waiting for Chrome DevTools startup.');
}

async function pageWebSocketUrl(port: number): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()) as Array<{
      type?: string;
      webSocketDebuggerUrl?: string;
    }>;
    const pageTarget = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    if (pageTarget?.webSocketDebuggerUrl) {
      return pageTarget.webSocketDebuggerUrl;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
  }
  throw new Error('Chrome DevTools did not expose a page websocket URL.');
}

type CdpClient = {
  send: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  close: () => Promise<void>;
};

async function createCdpClient(webSocketDebuggerUrl: string): Promise<CdpClient> {
  let messageId = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>();
  const socket = new WebSocket(webSocketDebuggerUrl);

  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', () => resolveOpen(), { once: true });
    socket.addEventListener('error', () => rejectOpen(new Error('Failed to connect to Chrome DevTools.')), { once: true });
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    if (!message.id) {
      return;
    }
    const request = pending.get(message.id);
    if (!request) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(message.error.message || 'Chrome DevTools command failed.'));
      return;
    }
    request.resolve(message.result);
  });

  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      request.reject(new Error('Chrome DevTools connection closed.'));
    }
    pending.clear();
  });

  return {
    send<T = unknown>(method: string, params: Record<string, unknown> = {}) {
      const id = ++messageId;
      return new Promise<T>((resolveSend, rejectSend) => {
        pending.set(id, {
          resolve: (value) => resolveSend(value as T),
          reject: rejectSend,
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      return new Promise<void>((resolveClose) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolveClose();
          return;
        }
        socket.addEventListener('close', () => resolveClose(), { once: true });
        socket.close();
      });
    },
  };
}

async function waitForEventlineExportReady(client: CdpClient): Promise<void> {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try {
      const result = await client.send<{ result?: { value?: boolean } }>('Runtime.evaluate', {
        expression: `Boolean(document.querySelector('.eventline-capture-surface') && window.__eventlineExportReady === true)`,
        returnByValue: true,
      });
      if (result.result?.value === true) {
        return;
      }
    } catch {
      // Navigation may still be replacing the runtime context.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
  }
  throw new Error('Timed out waiting for Eventline export render.');
}

async function settleEventlineExportRender(client: CdpClient): Promise<void> {
  await client.send('Runtime.evaluate', {
    expression: `new Promise((resolve) => {
      const waitFrame = () => new Promise((frameResolve) => requestAnimationFrame(() => frameResolve(undefined)));
      Promise.resolve(document.fonts?.ready).catch(() => undefined)
        .then(waitFrame)
        .then(waitFrame)
        .then(waitFrame)
        .then(() => setTimeout(resolve, 120));
    })`,
    awaitPromise: true,
    returnByValue: true,
  });
}

async function applyExportOptions(client: CdpClient, origin: string, options: ImageExportOptions): Promise<void> {
  const hasLayout = Boolean(options.layout && Object.keys(options.layout).length > 0);
  if (!hasLayout) {
    return;
  }
  await client.send('Page.navigate', { url: origin });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 240));
  await client.send('Runtime.evaluate', {
    expression: `window.localStorage.setItem('eventline:demo:layout.json', ${JSON.stringify(JSON.stringify(options.layout))})`,
    returnByValue: true,
  });
}

async function killChrome(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.killed || child.exitCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
    new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1800)),
  ]);
  if (!child.killed && child.exitCode === null) {
    child.kill('SIGKILL');
  }
}

async function captureBackendEventlineImage(
  pageUrl: string,
  outputPath: string,
  options: ImageExportOptions = {},
): Promise<void> {
  const chromePath = await findChromeExecutable();
  const userDataDir = await mkdtemp(join(tmpdir(), 'eventline-chrome-'));
  const child = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let client: CdpClient | null = null;
  try {
    const port = await waitForDevToolsPort(userDataDir);
    client = await createCdpClient(await pageWebSocketUrl(port));
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const origin = new URL(pageUrl).origin;
    await applyExportOptions(client, origin, options);
    await client.send('Page.navigate', { url: pageUrl });
    await waitForEventlineExportReady(client);
    await settleEventlineExportRender(client);
    const clipResult = await client.send<{ result?: { value?: { x: number; y: number; width: number; height: number } } }>('Runtime.evaluate', {
      expression: `(() => {
        const surface = document.querySelector('.eventline-capture-surface');
        if (!surface) return null;
        const surfaceRect = surface.getBoundingClientRect();
        const padding = 72;
        const graphElements = Array.from(surface.querySelectorAll(
          '.react-flow__node, .react-flow__edge, .react-flow__edge-label, .event-edge-label'
        )).filter((element) => {
          return !element.closest('[data-capture-exclude="true"], .eventline-controls, .eventline-minimap, .react-flow__attribution');
        });
        const bounds = graphElements.reduce((current, element) => {
          const rect = element.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return current;
          const next = {
            left: rect.left - surfaceRect.left,
            top: rect.top - surfaceRect.top,
            right: rect.right - surfaceRect.left,
            bottom: rect.bottom - surfaceRect.top
          };
          if (!current) return next;
          return {
            left: Math.min(current.left, next.left),
            top: Math.min(current.top, next.top),
            right: Math.max(current.right, next.right),
            bottom: Math.max(current.bottom, next.bottom)
          };
        }, null);
        if (!bounds) {
          return {
            x: Math.max(0, Math.floor(surfaceRect.left)),
            y: Math.max(0, Math.floor(surfaceRect.top)),
            width: Math.max(1, Math.ceil(surfaceRect.width)),
            height: Math.max(1, Math.ceil(surfaceRect.height))
          };
        }
        const x = Math.max(0, Math.floor(surfaceRect.left + bounds.left - padding));
        const y = Math.max(0, Math.floor(surfaceRect.top + bounds.top - padding));
        const right = Math.min(window.innerWidth, Math.ceil(surfaceRect.left + bounds.right + padding));
        const bottom = Math.min(window.innerHeight, Math.ceil(surfaceRect.top + bounds.bottom + padding));
        return {
          x,
          y,
          width: Math.max(1, right - x),
          height: Math.max(1, bottom - y)
        };
      })()`,
      returnByValue: true,
    });
    const clip = clipResult.result?.value;
    if (!clip) {
      throw new Error('Eventline capture surface was not found.');
    }
    const screenshot = await client.send<{ data?: string }>('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      clip: { ...clip, scale: 1 },
    });
    if (!screenshot.data) {
      throw new Error('Chrome did not return screenshot data.');
    }
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(screenshot.data, 'base64'));
  } finally {
    await client?.close().catch(() => undefined);
    await killChrome(child).catch(() => undefined);
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function requestOrigin(req: import('node:http').IncomingMessage): string {
  const host = req.headers.host || '127.0.0.1:5174';
  return `http://${host}`;
}

function mcpImageExportPort(): number | null {
  const raw = process.env.EVENTLINE_FRONTEND_PORT || '5174';
  const port = Number(raw);
  return Number.isFinite(port) && port > 0 ? port : null;
}

export default defineConfig({
  plugins: [
    react({ babel: { compact: false } }),
    {
      name: 'eventline-jsonl-dev-store',
      configureServer(server) {
        server.middlewares.use('/eventline-data/events.jsonl', async (req, res) => {
          try {
            if (req.method === 'GET') {
              const content = await readFile(eventlineEventsPath, 'utf-8').catch(() => '');
              res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
              res.end(content);
              return;
            }
            if (req.method === 'PUT') {
              const body = await readRequestBody(req);
              await mkdir(dirname(eventlineEventsPath), { recursive: true });
              await writeFile(eventlineEventsPath, body, 'utf-8');
              res.statusCode = 204;
              res.end();
              return;
            }
            res.statusCode = 405;
            res.end('Method not allowed');
          } catch (error) {
            res.statusCode = 500;
            res.end(error instanceof Error ? error.message : String(error));
          }
        });
        server.middlewares.use('/eventline-data/tool-schema.json', async (req, res) => {
          try {
            if (req.method !== 'GET') {
              res.statusCode = 405;
              res.end('Method not allowed');
              return;
            }
            const { stdout } = await execFileAsync('uv', [
              'run',
              'python',
              eventlineMcpServerPath,
              '--print-tool-schema',
            ], {
              cwd: __dirname,
              maxBuffer: 1024 * 1024,
            });
            res.setHeader('cache-control', 'no-store');
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(stdout);
          } catch (error) {
            res.statusCode = 500;
            res.end(error instanceof Error ? error.message : String(error));
          }
        });
        server.middlewares.use('/eventline-data/exports/', async (req, res) => {
          try {
            if (req.method !== 'GET') {
              res.statusCode = 405;
              res.end('Method not allowed');
              return;
            }
            const filename = decodeURIComponent((req.url || '').split('?')[0].replace(/^\/+/, ''));
            if (!/^[a-zA-Z0-9._-]+\.(svg|png|json)$/.test(filename)) {
              res.statusCode = 400;
              res.end('Invalid export filename');
              return;
            }
            const content = await readFile(resolve(eventlineExportsDir, filename));
            res.setHeader('cache-control', 'no-store');
            res.setHeader('content-type', filename.endsWith('.png')
              ? 'image/png'
              : filename.endsWith('.json')
                ? 'application/json; charset=utf-8'
                : 'image/svg+xml; charset=utf-8');
            res.end(content);
          } catch (error) {
            res.statusCode = 404;
            res.end(error instanceof Error ? error.message : String(error));
          }
        });
        server.middlewares.use('/eventline-data/export-image', async (req, res) => {
          try {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end('Method not allowed');
              return;
            }
            const options = imageExportOptionsFromBody(await readRequestBody(req));
            jsonResponse(res, 200, await ensureCachedImageExists(req, options));
          } catch (error) {
            jsonResponse(res, 500, {
              ok: false,
              mode: 'img',
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
        server.middlewares.use('/eventline-data/latest-image', async (req, res) => {
          try {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end('Method not allowed');
              return;
            }
            await readRequestBody(req);
            const metadata = await currentImageMetadata();
            try {
              await stat(String(metadata.outputPath));
              const payload = { ...metadata, cached: true, exported_at: new Date().toISOString() };
              delete payload.filename;
              delete payload.outputPath;
              await writeLatestImageMetadata(payload);
              jsonResponse(res, 200, payload);
              return;
            } catch {
              jsonResponse(res, 404, {
                ok: false,
                mode: 'img',
                error: 'No cached backend-rendered image exists for the current events.jsonl and light theme.',
              });
            }
          } catch (error) {
            jsonResponse(res, 500, {
              ok: false,
              mode: 'img',
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
        server.middlewares.use('/eventline-data/mcp-export-image', async (req, res) => {
          try {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.end('Method not allowed');
              return;
            }
            const options = imageExportOptionsFromBody(await readRequestBody(req));
            const port = mcpImageExportPort();
            if (!port) {
              jsonResponse(res, 500, {
                ok: false,
                mode: 'img',
                error: 'EVENTLINE_FRONTEND_PORT is not a valid port.',
              });
              return;
            }
            const fakeReq = {
              headers: {
                host: `127.0.0.1:${port}`,
              },
            } as import('node:http').IncomingMessage;
            jsonResponse(res, 200, await ensureCachedImageExists(fakeReq, options));
          } catch (error) {
            jsonResponse(res, 500, {
              ok: false,
              mode: 'img',
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
      },
    },
  ],
});
