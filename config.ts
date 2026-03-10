// config.ts
import { Knex } from 'knex';

/**
 * Cấu hình kết nối PostgreSQL cho Neon.tech
 * Theo xác nhận từ Leader, đây là môi trường DATA TEST.
 * Chúng ta dùng chung một cấu hình cho cả Nguồn (oldDB) và Đích (newDB).
 */
const neonConnection = {
  host: 'ep-summer-rain-aexbefe7-pooler.c-2.us-east-2.aws.neon.tech',
  port: 5432,
  user: 'neondb_owner',
  password: 'npg_0pV4OAfzUqgC',
  database: 'neondb',
  // Neon BẮT BUỘC phải có SSL để kết nối từ bên ngoài (VS Code/Node.js)
  ssl: { rejectUnauthorized: false },
};

export const dbConfig: { [key: string]: Knex.Config } = {
  // DB Cũ: Nơi chứa "1 đống data" chưa được nâng cấp field
  oldDB: {
    client: 'pg',
    connection: neonConnection,
    pool: { min: 2, max: 10 }
  },

  // DB Mới: Nơi chúng ta sẽ đổ dữ liệu sau khi đã Mapping/Merge field
  // Vì là môi trường Test, Đích cũng chính là server Neon này
  newDB: {
    client: 'pg',
    connection: neonConnection,
    pool: { min: 2, max: 10 }
  }
};