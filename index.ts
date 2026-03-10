import knex, { Knex } from 'knex';
import { dbConfig } from './config';

// 1. Khởi tạo kết nối với Type safety
const sourceDB: Knex = knex(dbConfig.oldDB);
const targetDB: Knex = knex(dbConfig.newDB);

/**
 * Hàm kiểm tra xem DB mới có thiếu cột nào từ DB cũ không
 */
async function checkMissingFields(tableName: string) {
  const oldCols = await sourceDB(tableName).columnInfo();
  const newCols = await targetDB(tableName).columnInfo();

  const oldFields = Object.keys(oldCols);
  const newFields = Object.keys(newCols);

  const missing = oldFields.filter(f => !newFields.includes(f));
  if (missing.length > 0) {
    console.warn(`⚠️ Chú ý: Bảng [${tableName}] ở DB mới thiếu các cột:`, missing);
  }
}

async function startMigration() {
  try {
    console.log("🚀 BẮT ĐẦU QUÁ TRÌNH MERGE DỮ LIỆU...");

    // --- BƯỚC 1: MERGE BẢNG USERS ---
    await checkMissingFields('users');
    const oldUsers = await sourceDB('users').select('*');
    console.log(`- Đang xử lý ${oldUsers.length} người dùng...`);

    let userSuccess = 0;
    for (const user of oldUsers) {
      try {
        await targetDB('users')
          .insert({
            id: user.id,
            username: user.username,
            email: user.email,
            password: user.password,
            // Field mới: gán mặc định
            status: 'active',
            phone: user.phone || null, 
            created_at: user.created_at || new Date()
          })
          .onConflict('id').merge();
        userSuccess++;
      } catch (e) {
        console.error(`❌ Lỗi tại User ID ${user.id}:`, (e as Error).message);
      }
    }
    console.log(`✅ Đã gộp thành công ${userSuccess}/${oldUsers.length} users.`);

    // --- BƯỚC 2: MERGE BẢNG POSTS ---
    await checkMissingFields('posts');
    const oldPosts = await sourceDB('posts').select('*');
    console.log(`- Đang xử lý ${oldPosts.length} bài viết...`);

    let postSuccess = 0;
    for (const post of oldPosts) {
      try {
        await targetDB('posts')
          .insert({
            id: post.id,
            title: post.title,
            content: post.content,
            // Đổi tên user_id -> author_id
            author_id: post.user_id,
            // Field mới
            category_id: 1, 
            is_published: true,
            updated_at: new Date()
          })
          .onConflict('id').merge();
        postSuccess++;
      } catch (e) {
        console.error(`❌ Lỗi tại Post ID ${post.id}:`, (e as Error).message);
      }
    }
    console.log(`✅ Đã gộp thành công ${postSuccess}/${oldPosts.length} posts.`);

    console.log("\n🎊 TẤT CẢ ĐÃ HOÀN TẤT!");

  } catch (err) {
    if (err instanceof Error) {
      console.error("❌ Lỗi hệ thống:", err.message);
    } else {
      console.error("❌ Lỗi không xác định:", err);
    }
  } finally {
    // Đóng kết nối để giải phóng bộ nhớ
    await sourceDB.destroy();
    await targetDB.destroy();
    process.exit();
  }
}

startMigration();