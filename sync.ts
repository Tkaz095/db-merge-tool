import { Knex } from 'knex';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

/** Tuỳ chọn cho một bảng khi sync */
export interface SyncOptions {
  /** Tên cột PK (hoặc composite PK) */
  pk: string | string[];
  /** Có xóa row ở target nếu không còn ở source không? (default: true) */
  enableDelete?: boolean;
  /** Số bản ghi insert mỗi batch (default: 100) */
  chunkSize?: number;
  /** INSERT ... ON CONFLICT DO NOTHING — dùng khi bảng không có unique constraint */
  ignoreConflict?: boolean;
}

export interface SyncResult {
  table: string;
  inserted: number;
  updated: number;
  deleted: number;
  /** Cột có ở source nhưng chưa có ở target — bỏ qua khi sync */
  skippedCols: string[];
  failed: number;
}

export interface FieldDiff {
  /** Giá trị PK của row bị lệch */
  pk: Record<string, unknown>;
  /** Tên field bị lệch */
  field: string;
  sourceValue: unknown;
  targetValue: unknown;
}

export interface CompareResult {
  table: string;
  sourceCount: number;
  targetCount: number;
  /** Cột chung giữa source và target */
  commonColumns: string[];
  /** Cột chỉ có ở source (target chưa có field này) */
  sourceOnlyCols: string[];
  /** Cột chỉ có ở target (field mới được thêm vào DB mới) */
  targetOnlyCols: string[];
  /** PK có ở source nhưng thiếu ở target */
  missingInTarget: unknown[];
  /** PK có ở target nhưng không có ở source */
  extraInTarget: unknown[];
  /** Các field lệch giá trị (tối đa maxDiffs) */
  fieldDiffs: FieldDiff[];
  /** true nếu data hoàn toàn khớp */
  match: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE: syncTable
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Đồng bộ data từ source → target cho một bảng.
 *
 * - Tự động lấy giao cột (columns có ở cả 2 DB) để sync
 * - Cột chỉ có ở source → bỏ qua, log ra màn hình
 * - Cột chỉ có ở target → giữ nguyên giá trị hiện có (không đụng vào)
 * - INSERT nếu PK mới, UPDATE nếu PK đã có
 * - DELETE row dư ở target nếu enableDelete = true
 */
export async function syncTable(
  sourceDB: Knex,
  targetDB: Knex,
  tableName: string,
  options: SyncOptions
): Promise<SyncResult> {
  const {
    pk,
    enableDelete,
    chunkSize = 100,
    ignoreConflict = false,
  } = options;

  const pkCols = Array.isArray(pk) ? pk : [pk];
  const isCompositePk = pkCols.length > 1;
  const shouldDelete = enableDelete ?? !ignoreConflict;

  const result: SyncResult = {
    table: tableName,
    inserted: 0,
    updated: 0,
    deleted: 0,
    skippedCols: [],
    failed: 0,
  };

  // ── 1. Tính giao cột source ∩ target ──────────────────────────────
  let keepCols: string[];
  try {
    const [srcColRows, tgtColRows]: [{ column_name: string }[], { column_name: string }[]] =
      await Promise.all([
        sourceDB('information_schema.columns')
          .select('column_name')
          .where({ table_schema: 'public', table_name: tableName }),
        targetDB('information_schema.columns')
          .select('column_name')
          .where({ table_schema: 'public', table_name: tableName }),
      ]);

    if (tgtColRows.length === 0) {
      console.warn(`  ⚠ "${tableName}": chưa tồn tại ở target — bỏ qua`);
      return result;
    }

    const tgtColSet = new Set(tgtColRows.map((c) => c.column_name));
    const srcColNames = srcColRows.map((c) => c.column_name);

    keepCols = srcColNames.filter((c) => tgtColSet.has(c));
    result.skippedCols = srcColNames.filter((c) => !tgtColSet.has(c));

    if (result.skippedCols.length > 0) {
      console.log(`  ℹ  "${tableName}": bỏ qua ${result.skippedCols.length} cột chưa có ở target: [${result.skippedCols.join(', ')}]`);
    }
  } catch (e) {
    console.warn(`  ⚠ "${tableName}": lỗi đọc thông tin cột: ${(e as Error).message.split('\n')[0]}`);
    return result;
  }

  // ── 2. Đọc data từ source (chỉ lấy cột chung) ─────────────────────
  let sourceRows: Record<string, unknown>[];
  try {
    sourceRows = keepCols.length > 0
      ? await sourceDB(tableName).select(keepCols)
      : [];
  } catch (e) {
    console.warn(`  ⚠ "${tableName}": không đọc được source: ${(e as Error).message.split('\n')[0]}`);
    return result;
  }

  if (sourceRows.length === 0) {
    console.log(`  → "${tableName}": không có dữ liệu ở source`);
    // Vẫn tiếp tục clean-up nếu target có data thừa
  }

  // ── 3. Lấy PK hiện có ở target để phân biệt insert/update ─────────
  // (bỏ qua nếu ignoreConflict vì không cần phân biệt insert/update)
  let existingPkSet: Set<string> = new Set();
  if (!ignoreConflict) {
    try {
      const tgtPkRows = await targetDB(tableName).select(pkCols);
      existingPkSet = new Set(
        tgtPkRows.map((r) => pkCols.map((c) => String(r[c])).join('|'))
      );
    } catch {
      // giữ empty set
    }
  }

  // ── 4. Upsert theo batch ───────────────────────────────────────────
  for (let i = 0; i < sourceRows.length; i += chunkSize) {
    const chunk = sourceRows.slice(i, i + chunkSize);

    let batchInserted = 0;
    let batchUpdated = 0;
    for (const row of chunk) {
      const key = pkCols.map((c) => String(row[c])).join('|');
      if (existingPkSet.has(key)) { batchUpdated++; } else { batchInserted++; }
    }

    try {
      if (ignoreConflict) {
        await targetDB(tableName).insert(chunk).onConflict().ignore();
      } else if (isCompositePk) {
        await targetDB(tableName).insert(chunk).onConflict(pkCols as string[]).merge();
      } else {
        await targetDB(tableName).insert(chunk).onConflict(pkCols[0]).merge();
      }
      result.inserted += batchInserted;
      result.updated  += batchUpdated;
    } catch {
      // Batch lỗi → fallback từng row
      for (const row of chunk) {
        const key = pkCols.map((c) => String(row[c])).join('|');
        const isUpdate = existingPkSet.has(key);
        try {
          if (ignoreConflict) {
            await targetDB(tableName).insert(row).onConflict().ignore();
          } else if (isCompositePk) {
            await targetDB(tableName).insert(row).onConflict(pkCols as string[]).merge();
          } else {
            await targetDB(tableName).insert(row).onConflict(pkCols[0]).merge();
          }
          if (isUpdate) { result.updated++; } else { result.inserted++; }
        } catch (rowErr) {
          result.failed++;
          if (result.failed <= 3) {
            console.error(
              `    ⚠ Lỗi upsert row trong "${tableName}":`,
              (rowErr as Error).message.split('\n')[0]
            );
          }
        }
      }
    }
  }

  // ── 5. Clean-up: xóa row ở target không còn ở source ──────────────
  if (shouldDelete) {
    try {
      if (!isCompositePk) {
        const sourceIds = sourceRows.map((r) => r[pkCols[0]]);
        if (sourceIds.length > 0) {
          result.deleted = await targetDB(tableName)
            .whereNotIn(pkCols[0], sourceIds as (string | number)[])
            .delete();
        } else {
          result.deleted = await targetDB(tableName).delete();
        }
      } else {
        const sourcePkSet = new Set(
          sourceRows.map((r) => pkCols.map((c) => String(r[c])).join('|'))
        );
        const tgtPkRows = await targetDB(tableName).select(pkCols);
        const toDelete = tgtPkRows.filter(
          (r) => !sourcePkSet.has(pkCols.map((c) => String(r[c])).join('|'))
        );
        for (const row of toDelete) {
          try {
            const where = Object.fromEntries(pkCols.map((c) => [c, row[c]]));
            await targetDB(tableName).where(where).delete();
            result.deleted++;
          } catch (delErr) {
            result.failed++;
            if (result.failed <= 3) {
              console.error(
                `    ⚠ Lỗi xóa row trong "${tableName}":`,
                (delErr as Error).message.split('\n')[0]
              );
            }
          }
        }
      }
    } catch (e) {
      console.error(`    ⚠ Lỗi clean-up "${tableName}":`, (e as Error).message.split('\n')[0]);
    }
  }

  // ── 6. Log kết quả ─────────────────────────────────────────────────
  const parts = [
    result.inserted > 0 ? `+${result.inserted} thêm mới` : '',
    result.updated  > 0 ? `~${result.updated} cập nhật`  : '',
    result.deleted  > 0 ? `-${result.deleted} đã xóa`    : '',
    result.failed   > 0 ? `✗${result.failed} lỗi`        : '',
  ].filter(Boolean).join('  ');
  console.log(`  ✅ "${tableName}": ${parts || 'không có thay đổi'}`);

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPARE — So sánh data field-by-field giữa source và target
// ─────────────────────────────────────────────────────────────────────────────

/**
 * So sánh data field-by-field của một bảng giữa source và target.
 *
 * - Chỉ so sánh các cột CHUNG (giao của source ∩ target)
 * - Báo cáo: cột thừa/thiếu, row thiếu/thừa, field lệch giá trị
 */
export async function compareTable(
  sourceDB: Knex,
  targetDB: Knex,
  tableName: string,
  pk: string | string[],
  options: { maxDiffs?: number } = {}
): Promise<CompareResult | null> {
  const { maxDiffs = 20 } = options;
  const pkCols = Array.isArray(pk) ? pk : [pk];

  const result: CompareResult = {
    table: tableName,
    sourceCount: 0,
    targetCount: 0,
    commonColumns: [],
    sourceOnlyCols: [],
    targetOnlyCols: [],
    missingInTarget: [],
    extraInTarget: [],
    fieldDiffs: [],
    match: false,
  };

  try {
    // ── 1. So sánh danh sách cột ──────────────────────────────────────
    const [srcColRows, tgtColRows]: [{ column_name: string }[], { column_name: string }[]] =
      await Promise.all([
        sourceDB('information_schema.columns')
          .select('column_name')
          .where({ table_schema: 'public', table_name: tableName }),
        targetDB('information_schema.columns')
          .select('column_name')
          .where({ table_schema: 'public', table_name: tableName }),
      ]);

    if (srcColRows.length === 0) {
      console.warn(`  ⚠ "${tableName}": không tìm thấy ở source — bỏ qua`);
      return null;
    }
    if (tgtColRows.length === 0) {
      console.warn(`  ⚠ "${tableName}": chưa tồn tại ở target — bỏ qua`);
      return null;
    }

    const srcColSet = new Set(srcColRows.map((c) => c.column_name));
    const tgtColSet = new Set(tgtColRows.map((c) => c.column_name));
    result.commonColumns  = [...srcColSet].filter((c) => tgtColSet.has(c));
    result.sourceOnlyCols = [...srcColSet].filter((c) => !tgtColSet.has(c));
    result.targetOnlyCols = [...tgtColSet].filter((c) => !srcColSet.has(c));

    if (result.commonColumns.length === 0) return result;

    // ── 2. Fetch rows (chỉ lấy cột chung) ────────────────────────────
    const [srcRows, tgtRows]: [Record<string, unknown>[], Record<string, unknown>[]] =
      await Promise.all([
        sourceDB(tableName).select(result.commonColumns),
        targetDB(tableName).select(result.commonColumns),
      ]);

    result.sourceCount = srcRows.length;
    result.targetCount = tgtRows.length;

    // ── 3. Build PK maps ──────────────────────────────────────────────
    const pkKey = (r: Record<string, unknown>) =>
      pkCols.map((c) => JSON.stringify(r[c])).join('|');

    const pkVal = (row: Record<string, unknown>) =>
      pkCols.length === 1
        ? row[pkCols[0]]
        : Object.fromEntries(pkCols.map((c) => [c, row[c]]));

    const srcMap = new Map<string, Record<string, unknown>>();
    for (const row of srcRows) srcMap.set(pkKey(row), row);

    const tgtMap = new Map<string, Record<string, unknown>>();
    for (const row of tgtRows) tgtMap.set(pkKey(row), row);

    // ── 4. Row diff ───────────────────────────────────────────────────
    for (const [key, row] of srcMap) {
      if (!tgtMap.has(key)) result.missingInTarget.push(pkVal(row));
    }
    for (const [key, row] of tgtMap) {
      if (!srcMap.has(key)) result.extraInTarget.push(pkVal(row));
    }

    // ── 5. Field-level diff cho các row khớp PK ───────────────────────
    const nonPkCols = result.commonColumns.filter((c) => !pkCols.includes(c));
    for (const [key, srcRow] of srcMap) {
      if (result.fieldDiffs.length >= maxDiffs) break;
      const tgtRow = tgtMap.get(key);
      if (!tgtRow) continue;
      for (const col of nonPkCols) {
        if (JSON.stringify(srcRow[col]) !== JSON.stringify(tgtRow[col])) {
          result.fieldDiffs.push({
            pk:          Object.fromEntries(pkCols.map((c) => [c, srcRow[c]])),
            field:       col,
            sourceValue: srcRow[col],
            targetValue: tgtRow[col],
          });
          if (result.fieldDiffs.length >= maxDiffs) break;
        }
      }
    }

    result.match =
      result.missingInTarget.length === 0 &&
      result.extraInTarget.length === 0 &&
      result.fieldDiffs.length === 0;

    return result;
  } catch (e) {
    console.error(`  ❌ Lỗi compare "${tableName}":`, (e as Error).message.split('\n')[0]);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-DISCOVERY — Tự nhận diện bảng, PK, thứ tự theo FK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lấy tất cả tên bảng trong DB (schema public).
 */
export async function getAllTables(db: Knex): Promise<string[]> {
  const rows: { table_name: string }[] = await db
    .select('table_name')
    .from('information_schema.tables')
    .where({ table_schema: 'public', table_type: 'BASE TABLE' })
    .orderBy('table_name');
  return rows.map((r) => r.table_name);
}

/**
 * Tự động lấy danh sách cột PK của một bảng từ information_schema.
 * Trả về [] nếu bảng không có PK.
 */
export async function getTablePK(db: Knex, tableName: string): Promise<string[]> {
  const rows: { column_name: string }[] = await db
    .select('kcu.column_name')
    .from('information_schema.table_constraints as tc')
    .join('information_schema.key_column_usage as kcu', function () {
      this.on('tc.constraint_name', '=', 'kcu.constraint_name')
        .andOn('tc.table_schema', '=', 'kcu.table_schema')
        .andOn('tc.table_name', '=', 'kcu.table_name');
    })
    .where({
      'tc.table_schema': 'public',
      'tc.table_name': tableName,
      'tc.constraint_type': 'PRIMARY KEY',
    })
    .orderBy('kcu.ordinal_position');
  return rows.map((r) => r.column_name);
}

/**
 * Sắp xếp bảng theo thứ tự FK dependency (topological sort — Kahn's algorithm).
 * Bảng cha luôn đứng trước bảng con → tránh vi phạm FK constraint khi insert.
 */
export async function getTableOrder(db: Knex, tables: string[]): Promise<string[]> {
  const tableSet = new Set(tables);

  // Lấy các FK dependency: child_table phụ thuộc vào parent_table
  let fkRows: { child_table: string; parent_table: string }[] = [];
  try {
    fkRows = await db
      .select(
        'kcu.table_name as child_table',
        'ccu.table_name as parent_table'
      )
      .from('information_schema.referential_constraints as rc')
      .join('information_schema.key_column_usage as kcu', function () {
        this.on('rc.constraint_name', '=', 'kcu.constraint_name')
          .andOn(db.raw('kcu.table_schema = ?', ['public']));
      })
      .join('information_schema.constraint_column_usage as ccu', function () {
        this.on('rc.unique_constraint_name', '=', 'ccu.constraint_name')
          .andOn(db.raw('ccu.table_schema = ?', ['public']));
      })
      .whereIn('kcu.table_name', tables)
      .whereIn('ccu.table_name', tables);
  } catch {
    // Nếu query FK thất bại → trả về theo alphabet
    return tables;
  }

  // Kahn's topological sort
  const inDegree = new Map<string, number>(tables.map((t) => [t, 0]));
  const adjList  = new Map<string, string[]>(tables.map((t) => [t, []]));

  for (const { child_table, parent_table } of fkRows) {
    if (child_table === parent_table) continue; // self-reference
    if (!tableSet.has(child_table) || !tableSet.has(parent_table)) continue;
    adjList.get(parent_table)!.push(child_table);
    inDegree.set(child_table, (inDegree.get(child_table) ?? 0) + 1);
  }

  const queue  = tables.filter((t) => (inDegree.get(t) ?? 0) === 0);
  const sorted: string[] = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const neighbor of (adjList.get(node) ?? [])) {
      const deg = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, deg);
      if (deg === 0) queue.push(neighbor);
    }
  }

  // Nếu có cycle FK → append các bảng còn lại cuối danh sách
  if (sorted.length < tables.length) {
    const inSorted = new Set(sorted);
    tables.filter((t) => !inSorted.has(t)).forEach((t) => sorted.push(t));
  }

  return sorted;
}

