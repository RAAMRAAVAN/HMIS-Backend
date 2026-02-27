import pool from "../db.js";

export const createMessage = async ({ conversationId, senderId, receiverID, body }) => {
  const query = `
    INSERT INTO messages (conversation_id, sender_id, receiver_id, body)
    VALUES ($1, $2, $3, $4)
    RETURNING *;
  `;
  const values = [conversationId, senderId, receiverID, body];
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
