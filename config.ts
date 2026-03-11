import { input } from '@inquirer/prompts';

/** Validate d?nh d?ng URL PostgreSQL (throw n?u sai) */
function validateUrl(url: string): void {
  try {
    const u = new URL(url);
    if (!u.hostname) throw new Error('Thi?u host');
    if (!u.pathname || u.pathname === '/') throw new Error('Thi?u t�n database');
  } catch {
    throw new Error(
      `URL kh�ng h?p l?: "${url}"\n` +
      `�?nh d?ng d�ng: postgresql://user:password@host:5432/database`
    );
  }
}

/**
 * L?y DB URLs theo th? t? uu ti�n:
 *  1. Bi?n m�i tru?ng SOURCE_DB_URL / TARGET_DB_URL  ? d�ng cho automation/n8n
 *  2. H?i tr?c ti?p qua terminal                    ? d�ng khi ch?y tay
 */
export async function promptDbConfig(): Promise<{ sourceUrl: string; targetUrl: string }> {
  const envSource = process.env.SOURCE_DB_URL;
  const envTarget = process.env.TARGET_DB_URL;

  if (envSource && envTarget) {
    validateUrl(envSource);
    validateUrl(envTarget);
    console.log('?  D�ng k?t n?i t? bi?n m�i tru?ng (SOURCE_DB_URL / TARGET_DB_URL)');
    return { sourceUrl: envSource, targetUrl: envTarget };
  }

  // Ch?y tay ? h?i qua terminal
  console.log('\n+----------------------------------------------------------+');
  console.log('�       DB MIGRATION TOOL � Nh?p th�ng tin k?t n?i        �');
  console.log('+----------------------------------------------------------+');
  console.log('?  �?nh d?ng: postgresql://user:password@host:5432/database\n');

  const sourceUrl = await input({
    message: '??  DB Ngu?n (cu)  URL:',
    validate: (v) => {
      try { validateUrl(v); return true; }
      catch (e) { return (e as Error).message; }
    },
  });

  const targetUrl = await input({
    message: '??  DB ��ch  (m?i) URL:',
    validate: (v) => {
      try { validateUrl(v); return true; }
      catch (e) { return (e as Error).message; }
    },
  });

  console.log('');

  return { sourceUrl, targetUrl };
}
