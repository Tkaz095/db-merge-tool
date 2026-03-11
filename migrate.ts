import knex, { Knex } from 'knex';
import {
  syncTable,
  compareTable,
  getAllTables,
  getTablePK,
  getTableOrder,
  CompareResult,
} from './sync';

// ── Interfaces ─────────────────────────────────────────────────────────────

export interface TableMigrationResult {
  name: string;
  inserted: number;
  updated: number;
  deleted: number;
  failed: number;
  hasPK: boolean;
  /** true nếu data khớp hoàn toàn sau khi so sánh */
  matched: boolean;
}

export interface MigrationResult {
  success: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totalTables: number;
  /** Số bảng có PK và data khớp hoàn toàn */
  matchedTables: number;
  tables: TableMigrationResult[];
  /** Lỗi hệ thống (nếu có) */
  error?: string;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function buildKnexConfig(url: string): Knex.Config {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`URL không hợp lệ: "${url}". Định dạng đúng: postgresql://user:pass@host:5432/db`);
  }
  return {
    client: 'pg',
    connection: {
      host:     u.hostname,
      port:     u.port ? parseInt(u.port, 10) : 5432,
      user:     decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ''),
      ssl:      { rejectUnauthorized: false },
    },
    pool: { min: 2, max: 10 },
  };
}

// ── Core migration function ─────────────────────────────────────────────────

/**
 * Chạy toàn bộ pipeline: sync data từ source → target, rồi compare.
 * Có thể gọi từ CLI (index.ts) hoặc HTTP server (server.ts).
 */
export async function runMigration(sourceUrl: string, targetUrl: string): Promise<MigrationResult> {
  const startedAt = new Date().toISOString();
  const startMs   = Date.now();
  const tableResults: TableMigrationResult[] = [];

  const sourceDB: Knex = knex(buildKnexConfig(sourceUrl));
  const targetDB: Knex = knex(buildKnexConfig(targetUrl));

  try {
    console.log('🚀 BẮT ĐẦU QUÁ TRÌNH SYNC DỮ LIỆU...\n');

    // ── 1. Auto-discover tất cả bảng ─────────────────────────────────
    const allTables = await getAllTables(sourceDB);
    console.log(`📋 Tìm thấy ${allTables.length} bảng trong source DB`);

    // ── 2. Sắp thứ tự theo FK dependency ─────────────────────────────
    const orderedTables = await getTableOrder(sourceDB, allTables);
    console.log(`📐 Đã sắp xếp thứ tự sync theo FK dependency\n`);

    // ── 3. Sync từng bảng ────────────────────────────────────────────
    const tablePKs: Record<string, string | string[]> = {};

    for (const tableName of orderedTables) {
      const pkCols = await getTablePK(sourceDB, tableName);

      if (pkCols.length === 0) {
        const result = await syncTable(sourceDB, targetDB, tableName, {
          pk:             '__no_pk__',
          ignoreConflict: true,
          enableDelete:   false,
        });
        tableResults.push({
          name:     tableName,
          inserted: result.inserted,
          updated:  result.updated,
          deleted:  result.deleted,
          failed:   result.failed,
          hasPK:    false,
          matched:  false,
        });
      } else {
        const pk = pkCols.length === 1 ? pkCols[0] : pkCols;
        tablePKs[tableName] = pk;
        const result = await syncTable(sourceDB, targetDB, tableName, { pk });
        tableResults.push({
          name:     tableName,
          inserted: result.inserted,
          updated:  result.updated,
          deleted:  result.deleted,
          failed:   result.failed,
          hasPK:    true,
          matched:  false,
        });
      }
    }

    console.log('\n🎊 SYNC HOÀN TẤT!');

    // ── 4. Compare data field-by-field ────────────────────────────────
    console.log('\n' + '='.repeat(70));
    console.log('📊 SO SÁNH DATA: SOURCE vs TARGET (field-by-field)');
    console.log('='.repeat(70));

    let matchedTables = 0;

    for (const [tableName, pk] of Object.entries(tablePKs)) {
      process.stdout.write(`\n🔍 ${tableName.padEnd(38)}`);

      const res: CompareResult | null = await compareTable(sourceDB, targetDB, tableName, pk);
      const tableResult = tableResults.find(t => t.name === tableName);

      if (!res) {
        process.stdout.write('⚠ bỏ qua\n');
        continue;
      }

      if (res.match) {
        process.stdout.write(`✅ KHỚP  (${res.sourceCount} rows, ${res.commonColumns.length} fields)\n`);
        matchedTables++;
        if (tableResult) tableResult.matched = true;
      } else {
        process.stdout.write('❌ CÓ KHÁC BIỆT\n');
      }

      if (res.sourceOnlyCols.length > 0)
        console.log(`   📋 Field chỉ có ở DB cũ (chưa migrate): [${res.sourceOnlyCols.join(', ')}]`);
      if (res.targetOnlyCols.length > 0)
        console.log(`   📋 Field mới ở DB mới (chưa có data):   [${res.targetOnlyCols.join(', ')}]`);

      if (res.sourceCount !== res.targetCount) {
        const diff = res.sourceCount - res.targetCount;
        console.log(
          `   ❌ Số row: source=${res.sourceCount} | target=${res.targetCount} → ` +
          `${diff > 0 ? 'thiếu' : 'thừa'} ${Math.abs(diff)} row`,
        );
      }

      if (res.missingInTarget.length > 0) {
        const preview = res.missingInTarget.slice(0, 5).map(v => JSON.stringify(v)).join(', ');
        const extra   = res.missingInTarget.length > 5 ? ` ... +${res.missingInTarget.length - 5} nữa` : '';
        console.log(`   ❌ ${res.missingInTarget.length} row ở source chưa có ở target — PK: [${preview}]${extra}`);
      }

      if (res.extraInTarget.length > 0) {
        const preview = res.extraInTarget.slice(0, 5).map(v => JSON.stringify(v)).join(', ');
        const extra   = res.extraInTarget.length > 5 ? ` ... +${res.extraInTarget.length - 5} nữa` : '';
        console.log(`   ⚠  ${res.extraInTarget.length} row ở target không có ở source — PK: [${preview}]${extra}`);
      }

      if (res.fieldDiffs.length > 0) {
        console.log(`   🔄 ${res.fieldDiffs.length} field khác nhau (hiển thị tối đa 5):`);
        for (const diff of res.fieldDiffs.slice(0, 5)) {
          const pkStr = Object.values(diff.pk).join(', ');
          console.log(
            `      PK(${pkStr})  "${diff.field}":  ` +
            `source=${JSON.stringify(diff.sourceValue)}  →  target=${JSON.stringify(diff.targetValue)}`,
          );
        }
        if (res.fieldDiffs.length > 5)
          console.log(`      ... và ${res.fieldDiffs.length - 5} field diff nữa`);
      }
    }

    const totalPKTables = Object.keys(tablePKs).length;
    console.log('\n' + '='.repeat(70));
    console.log(`📊 KẾT QUẢ: ${matchedTables}/${totalPKTables} bảng khớp hoàn toàn`);
    if (matchedTables === totalPKTables) {
      console.log('✅ TẤT CẢ DATA ĐÃ ĐƯỢC SYNC CHÍNH XÁC — FIELD ĐÚNG, GIÁ TRỊ ĐÚNG!');
    } else {
      console.log(`❌ ${totalPKTables - matchedTables} bảng cần kiểm tra lại.`);
    }
    console.log('='.repeat(70));

    return {
      success:       true,
      startedAt,
      finishedAt:    new Date().toISOString(),
      durationMs:    Date.now() - startMs,
      totalTables:   tableResults.length,
      matchedTables,
      tables:        tableResults,
    };

  } catch (err) {
    console.error('\n❌ Lỗi hệ thống:', (err as Error).message);
    return {
      success:       false,
      startedAt,
      finishedAt:    new Date().toISOString(),
      durationMs:    Date.now() - startMs,
      totalTables:   tableResults.length,
      matchedTables: 0,
      tables:        tableResults,
      error:         (err as Error).message,
    };
  } finally {
    await sourceDB.destroy();
    await targetDB.destroy();
  }
}
