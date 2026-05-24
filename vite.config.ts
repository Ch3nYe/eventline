import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const eventlineEventsPath = resolve(__dirname, 'data/events.jsonl');
const eventlineMcpServerPath = resolve(__dirname, 'mcp_server.py');
const execFileAsync = promisify(execFile);

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
              const chunks: Buffer[] = [];
              req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
              req.on('end', async () => {
                await mkdir(dirname(eventlineEventsPath), { recursive: true });
                await writeFile(eventlineEventsPath, Buffer.concat(chunks).toString('utf-8'), 'utf-8');
                res.statusCode = 204;
                res.end();
              });
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
      },
    },
  ],
});
