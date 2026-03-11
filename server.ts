/**
 * HTTP server để n8n (hoặc bất kỳ cron/automation tool nào) có thể trigger migration.
 *
 * Cách chạy:
 *   npx ts-node server.ts
 *
 * Biến môi trường:
 *   PORT          — port lắng nghe (default: 3000)
 *   MIGRATE_TOKEN — bearer token bảo vệ endpoint (bắt buộc set nếu deploy lên server thật)
 *
 * Endpoints:
 *   GET  /health   → health check (n8n dùng để check trước khi gọi)
 *   POST /migrate  → trigger migration
 *                    Body JSON: { "sourceUrl": "postgresql://...", "targetUrl": "postgresql://..." }
 *                    Headers:   Authorization: Bearer <MIGRATE_TOKEN>
 */

import http, { IncomingMessage, ServerResponse } from 'http';
import { runMigration, MigrationResult } from './migrate';

const PORT          = parseInt(process.env.PORT ?? '4000', 10);
const MIGRATE_TOKEN = process.env.MIGRATE_TOKEN;

// ── Helpers ────────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type':  'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end',  () => resolve(data));
    req.on('error', reject);
  });
}

// ── Request handler ────────────────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {

  // ── Health check (n8n dùng node trước khi trigger) ──────────────────
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
    return;
  }

  // ── Chỉ accept POST /migrate ─────────────────────────────────────────
  if (req.method !== 'POST' || req.url !== '/migrate') {
    sendJson(res, 404, { error: 'Not found. Use POST /migrate' });
    return;
  }

  // ── Kiểm tra Bearer token (nếu MIGRATE_TOKEN được set) ───────────────
  if (MIGRATE_TOKEN) {
    const authHeader = req.headers['authorization'] ?? '';
    if (authHeader !== `Bearer ${MIGRATE_TOKEN}`) {
      console.warn(`[${new Date().toISOString()}] 🚫 Unauthorized request from ${req.socket.remoteAddress}`);
      sendJson(res, 401, { error: 'Unauthorized. Set Authorization: Bearer <MIGRATE_TOKEN>' });
      return;
    }
  }

  // ── Parse request body ────────────────────────────────────────────────
  let sourceUrl: string;
  let targetUrl: string;

  try {
    const raw = await readBody(req);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.sourceUrl !== 'string' || !parsed.sourceUrl.trim()) {
      throw new Error('"sourceUrl" là bắt buộc và phải là string');
    }
    if (typeof parsed.targetUrl !== 'string' || !parsed.targetUrl.trim()) {
      throw new Error('"targetUrl" là bắt buộc và phải là string');
    }
    sourceUrl = parsed.sourceUrl.trim();
    targetUrl = parsed.targetUrl.trim();
  } catch (e) {
    sendJson(res, 400, { error: `Bad request: ${(e as Error).message}` });
    return;
  }

  // ── Chạy migration ────────────────────────────────────────────────────
  console.log(`\n[${new Date().toISOString()}] 🚀 Migration triggered via HTTP`);

  const result: MigrationResult = await runMigration(sourceUrl, targetUrl);

  sendJson(res, result.success ? 200 : 500, result);
}

// ── Server ─────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('Unhandled error:', err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Internal server error' });
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║       DB MIGRATION SERVER — đang chạy                   ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);
  console.log(`  URL:      http://localhost:${PORT}`);
  console.log(`  Endpoints: POST /migrate  |  GET /health`);
  if (MIGRATE_TOKEN) {
    console.log(`  🔒 Auth:   Bearer token required`);
  } else {
    console.log(`  ⚠  Auth:  MIGRATE_TOKEN chưa set — không an toàn nếu expose ra ngoài!`);
  }
  console.log('');
});
