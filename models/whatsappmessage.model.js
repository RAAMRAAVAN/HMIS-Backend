import pool from "../db.js";

export const createMessage = async ({ conversationId, senderId, receiverID, body, status = "sent", isRead = false }) => {
  const query = `
    INSERT INTO messages (conversation_id, sender_id, receiver_id, body, status, is_read)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *;
  `;
  const values = [conversationId, senderId, receiverID, body, status, isRead];
  const result = await pool.query(query, values);
  return result.rows[0];
};


export const getConversationMembers = async (receiverID, senderID) => {
  const result = await pool.query(
    `SELECT * from messages WHERE receiver_id=$1 AND sender_id=$2`,
    [receiverID, senderID]
  );
  return result.rows;
};

export const updateMessageStatus = async ({ messageId, status, isRead }) => {
  const query = `
    UPDATE messages
    SET status = CASE
          WHEN status = 'read' AND $2 = 'delivered' THEN 'read'
          ELSE $2
        END,
        is_read = CASE
          WHEN is_read = true THEN true
          ELSE COALESCE($3, is_read)
        END
    WHERE id = $1
    RETURNING *;
  `;
  const values = [messageId, status, isRead];
  const result = await pool.query(query, values);
  return result.rows[0] || null;
};
