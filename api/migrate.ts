import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runMigration } from '../migrate';

const MIGRATE_TOKEN = process.env.MIGRATE_TOKEN;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST /api/migrate' });
  }

  // ── Kiểm tra Bearer token ─────────────────────────────────────────────
  if (MIGRATE_TOKEN) {
    const auth = (req.headers['authorization'] as string) ?? '';
    if (auth !== `Bearer ${MIGRATE_TOKEN}`) {
      return res.status(401).json({ error: 'Unauthorized. Set Authorization: Bearer <MIGRATE_TOKEN>' });
    }
  }

  // ── Validate body ─────────────────────────────────────────────────────
  const { sourceUrl, targetUrl } = (req.body ?? {}) as { sourceUrl?: string; targetUrl?: string };

  if (!sourceUrl?.trim() || !targetUrl?.trim()) {
    return res.status(400).json({
      error: 'Body JSON phải có "sourceUrl" và "targetUrl"',
      example: {
        sourceUrl: 'postgresql://user:pass@old-host:5432/old_db',
        targetUrl: 'postgresql://user:pass@new-host:5432/new_db',
      },
    });
  }

  // ── Chạy migration ────────────────────────────────────────────────────
  const result = await runMigration(sourceUrl.trim(), targetUrl.trim());

  return res.status(result.success ? 200 : 500).json(result);
}
