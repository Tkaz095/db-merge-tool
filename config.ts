import { Knex } from 'knex';
import { input } from '@inquirer/prompts';

/**
 * Parse một PostgreSQL connection URL thành Knex config.
 * Định dạng: postgresql://user:password@host:5432/database
 */
function parseConnectionUrl(url: string): Knex.PgConnectionConfig {
  try {
    const u = new URL(url);
    return {
      host:     u.hostname,
      port:     u.port ? parseInt(u.port, 10) : 5432,
      user:     decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ''),
      ssl:      { rejectUnauthorized: false },
    };
  } catch {
    throw new Error(
      `URL không hợp lệ: "${url}"\n` +
      `Định dạng đúng: postgresql://user:password@host:5432/database`
    );
  }
}

function makeKnexConfig(conn: Knex.PgConnectionConfig): Knex.Config {
  return { client: 'pg', connection: conn, pool: { min: 2, max: 10 } };
}

/** Hỏi lead nhập 2 URL rồi trả về Knex config cho source và target */
export async function promptDbConfig(): Promise<{ oldDB: Knex.Config; newDB: Knex.Config }> {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║       DB MIGRATION TOOL — Nhập thông tin kết nối        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('ℹ  Định dạng: postgresql://user:password@host:5432/database\n');

  const sourceUrl = await input({
    message: '🔴  DB Nguồn (cũ)  URL:',
    validate: (v) => {
      try { parseConnectionUrl(v); return true; }
      catch (e) { return (e as Error).message; }
    },
  });

  const targetUrl = await input({
    message: '🟢  DB Đích  (mới) URL:',
    validate: (v) => {
      try { parseConnectionUrl(v); return true; }
      catch (e) { return (e as Error).message; }
    },
  });

  console.log('');

  return {
    oldDB: makeKnexConfig(parseConnectionUrl(sourceUrl)),
    newDB: makeKnexConfig(parseConnectionUrl(targetUrl)),
  };
}

