import knex, { Knex } from 'knex';
import { promptDbConfig } from './config';
import { syncTable, SyncOptions, compareTable, CompareResult, getAllTables, getTablePK, getTableOrder } from './sync';

async function startMigration() {
  // ── Nhập URL từ lead ───────────────────────────────────────────────
  const dbConfig = await promptDbConfig();
  const sourceDB: Knex = knex(dbConfig.oldDB);
  const targetDB: Knex = knex(dbConfig.newDB);

  const sync = (tableName: string, options: SyncOptions) =>
    syncTable(sourceDB, targetDB, tableName, options);

  try {
    console.log('🚀 BẮT ĐẦU QUÁ TRÌNH SYNC DỮ LIỆU...\n');

    // ── 1. Auto-discover: tìm tất cả bảng trong source ────────────────
    const allTables = await getAllTables(sourceDB);
    console.log(`📋 Tìm thấy ${allTables.length} bảng trong source DB`);

    // ── 2. Sắp thứ tự theo FK dependency (cha trước, con sau) ─────────
    const orderedTables = await getTableOrder(sourceDB, allTables);
    console.log(`📐 Đã sắp xếp thứ tự sync theo FK dependency\n`);

    // ── 3. Auto-discover PK từng bảng rồi sync ────────────────────────
    // tablePKs lưu lại để dùng cho bước compare
    const tablePKs: Record<string, string | string[]> = {};

    for (const tableName of orderedTables) {
      const pkCols = await getTablePK(sourceDB, tableName);

      if (pkCols.length === 0) {
        // Không có PK → INSERT ON CONFLICT DO NOTHING, không delete
        await sync(tableName, { pk: '__no_pk__', ignoreConflict: true, enableDelete: false });
      } else {
        const pk = pkCols.length === 1 ? pkCols[0] : pkCols;
        tablePKs[tableName] = pk;
        await sync(tableName, { pk });
      }
    }

    console.log('\n🎊 TẤT CẢ ĐÃ HOÀN TẤT!');

    // ── 4. So sánh data field-by-field ────────────────────────────────
    console.log('\n' + '='.repeat(70));
    console.log('📊 SO SÁNH DATA: SOURCE vs TARGET (field-by-field)');
    console.log('='.repeat(70));

    let totalTables = 0;
    let matchedTables = 0;

    for (const [tableName, pk] of Object.entries(tablePKs)) {
      totalTables++;
      process.stdout.write(`\n🔍 ${tableName.padEnd(38)}`);

      const res: CompareResult | null = await compareTable(sourceDB, targetDB, tableName, pk);
      if (!res) {
        process.stdout.write('⚠ bỏ qua\n');
        continue;
      }

      if (res.match) {
        process.stdout.write(`✅ KHỚP  (${res.sourceCount} rows, ${res.commonColumns.length} fields)\n`);
        matchedTables++;
      } else {
        process.stdout.write('❌ CÓ KHÁC BIỆT\n');
      }

      if (res.sourceOnlyCols.length > 0) {
        console.log(`   📋 Field chỉ có ở DB cũ (chưa migrate sang DB mới): [${res.sourceOnlyCols.join(', ')}]`);
      }
      if (res.targetOnlyCols.length > 0) {
        console.log(`   📋 Field mới ở DB mới (chưa có data từ source):     [${res.targetOnlyCols.join(', ')}]`);
      }

      if (res.sourceCount !== res.targetCount) {
        const diff = res.sourceCount - res.targetCount;
        console.log(`   ❌ Số row: source=${res.sourceCount} | target=${res.targetCount} → ${diff > 0 ? 'thiếu' : 'thừa'} ${Math.abs(diff)} row`);
      }

      if (res.missingInTarget.length > 0) {
        const preview = res.missingInTarget.slice(0, 5).map((v) => JSON.stringify(v)).join(', ');
        const extra   = res.missingInTarget.length > 5 ? ` ... +${res.missingInTarget.length - 5} nữa` : '';
        console.log(`   ❌ ${res.missingInTarget.length} row ở source chưa có ở target — PK: [${preview}]${extra}`);
      }

      if (res.extraInTarget.length > 0) {
        const preview = res.extraInTarget.slice(0, 5).map((v) => JSON.stringify(v)).join(', ');
        const extra   = res.extraInTarget.length > 5 ? ` ... +${res.extraInTarget.length - 5} nữa` : '';
        console.log(`   ⚠  ${res.extraInTarget.length} row ở target không có ở source — PK: [${preview}]${extra}`);
      }

      if (res.fieldDiffs.length > 0) {
        console.log(`   🔄 ${res.fieldDiffs.length} field khác nhau (hiển thị tối đa 5):`);
        for (const diff of res.fieldDiffs.slice(0, 5)) {
          const pkStr = Object.values(diff.pk).join(', ');
          console.log(`      PK(${pkStr})  "${diff.field}":  source=${JSON.stringify(diff.sourceValue)}  →  target=${JSON.stringify(diff.targetValue)}`);
        }
        if (res.fieldDiffs.length > 5) {
          console.log(`      ... và ${res.fieldDiffs.length - 5} field diff nữa`);
        }
      }
    }

    console.log('\n' + '='.repeat(70));
    console.log(`📊 KẾT QUẢ: ${matchedTables}/${totalTables} bảng khớp hoàn toàn`);
    if (matchedTables === totalTables) {
      console.log('✅ TẤT CẢ DATA ĐÃ ĐƯỢC SYNC CHÍNH XÁC — FIELD ĐÚNG, GIÁ TRỊ ĐÚNG!');
    } else {
      console.log(`❌ ${totalTables - matchedTables} bảng cần kiểm tra lại.`);
    }
    console.log('='.repeat(70));

  } catch (err) {
    console.error('\n❌ Lỗi hệ thống:', (err as Error).message);
  } finally {
    await sourceDB.destroy();
    await targetDB.destroy();
    process.exit();
  }
}

startMigration();
