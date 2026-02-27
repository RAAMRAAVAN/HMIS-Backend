import { Server } from "socket.io";
import pool from "./db.js";   // <-- your PostgreSQL pool

let io = null;

// Store mapping userId → socketId
const userSockets = new Map();

export function initSocket(httpServer) {
  console.log("🔌 Initializing Socket.IO...");

  io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  io.on("connection", async (socket) => {

    // ------------------------------------------------
    // LOGIN + USER REGISTRATION
    // ------------------------------------------------
    socket.on("login", async ({ userId }) => {
      if (!userId) return;

      console.log(`🟢 Client connected: ${socket.id} User: ${userId}`);

      // Save mapping
      userSockets.set(userId, socket.id);

      // Attach to socket
      socket.userId = userId;

      console.log(`👤 User registered → user: ${userId}, socket: ${socket.id}`);

      io.emit("onlineUsers", Array.from(userSockets.keys()));
    });

    // ------------------------------------------------
    // PRIVATE MESSAGE
    // ------------------------------------------------
    socket.on("privateMessage", async ({ senderId, receiverId, text }) => {
      console.log(`💬 PRIVATE MESSAGE: ${senderId} → ${receiverId}: ${text}`);

      try {
        const result = await pool.query(
          `INSERT INTO messages (sender_id, receiver_id, body)
           VALUES ($1,$2,$3)
           RETURNING *`,
          [senderId, receiverId, text]
        );

        const savedMessage = result.rows[0];
        console.log("✅ Private message saved:", savedMessage);

        const receiverSocket = userSockets.get(receiverId);

        if (receiverSocket) {
          io.to(receiverSocket).emit("receiveMessage", savedMessage);
        }

        // Sender also receives confirmation
        io.to(socket.id).emit("messageSent", savedMessage);

      } catch (err) {
        console.error("❌ Error saving message:", err.message);
      }
    });

    // ------------------------------------------------
    // TYPING INDICATOR
    // ------------------------------------------------
    socket.on("typing", ({ from, to }) => {
      const receiverSocket = userSockets.get(to);
      if (receiverSocket) {
        io.to(receiverSocket).emit("typing", { from });
      }
    });

    socket.on("stopTyping", ({ from, to }) => {
      const receiverSocket = userSockets.get(to);
      if (receiverSocket) {
        io.to(receiverSocket).emit("stopTyping", { from });
      }
    });

    // ------------------------------------------------
    // MESSAGE READ
    // ------------------------------------------------
    socket.on("markRead", async ({ userId, senderId }) => {
      try {
        await pool.query(
          `UPDATE messages
           SET is_read = true
           WHERE receiver_id=$1 AND sender_id=$2`,
          [userId, senderId]
        );

        const senderSocket = userSockets.get(senderId);
        if (senderSocket) {
          io.to(senderSocket).emit("messagesRead", { userId });
        }
      } catch (err) {
        console.error("❌ Read update error:", err.message);
      }
    });

    // ------------------------------------------------
    // DISCONNECT
    // ------------------------------------------------
    socket.on("disconnect", () => {
      if (socket.userId) {
        userSockets.delete(socket.userId);
        console.log(`🔴 Disconnected user: ${socket.userId}`);
      }

      io.emit("onlineUsers", Array.from(userSockets.keys()));
    });
  });

  console.log("✅ Socket.IO ready");
  return io;
}

export function getIO() {
  if (!io) throw new Error("Socket.IO not initialized");
  return io;
}
