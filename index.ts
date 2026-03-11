import { promptDbConfig } from './config';
import { runMigration } from './migrate';

async function startMigration() {
  const { sourceUrl, targetUrl } = await promptDbConfig();
  await runMigration(sourceUrl, targetUrl);
  process.exit(0);
}

startMigration();
