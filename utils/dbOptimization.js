import pool from "../db.js";

const INDEX_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS idx_messages_sender_receiver_created_at
   ON messages (sender_id, receiver_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_receiver_sender_created_at
   ON messages (receiver_id, sender_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_unread_receiver_sender
   ON messages (receiver_id, sender_id)
   WHERE COALESCE(is_read, false) = false`,
  `CREATE INDEX IF NOT EXISTS idx_users_lower_email
   ON users (LOWER(email))`,
  `CREATE INDEX IF NOT EXISTS idx_users_lower_name
   ON users (LOWER(name))`,
  `CREATE INDEX IF NOT EXISTS idx_users_is_online
   ON users (is_online)`,
];

export async function ensureDatabaseOptimizations() {
  for (const statement of INDEX_STATEMENTS) {
    await pool.query(statement);
  }
}
