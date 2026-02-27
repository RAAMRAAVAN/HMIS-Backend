import { Server } from "socket.io";
import { createMessage } from "./models/whatsappmessage.model.js";

let io = null;

// Track users by socket id
const connectedUsers = new Map();

export function initSocket(httpServer) {
  if (io) return io; // Prevent re-init

  io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  io.on("connection", (socket) => {
    console.log("🟢 Client connected:", socket.id);

    /**
     * USER REGISTRATION
     * client must emit:
     * socket.emit("register", userID)
     */
    socket.on("register", (userID) => {
      if (!userID) {
        socket.emit("socket_error", { message: "userID is required for register" });
        return;
      }

      const roomId = userID.toString();
      console.log(`👤 User registered → user: ${userID}, socket: ${socket.id}`);
      connectedUsers.set(socket.id, roomId);

      // Join user-specific room
      socket.join(roomId);
    });

    /**
     * EXISTING GROUP CHAT FEATURE
     */
    socket.on("sendMessage", (message) => {
      console.log("📩 GROUP MESSAGE:", message);
      io.emit("receiveMessage", message);
    });

    /**
     * EXISTING FEATURE
     */
    socket.on("triggerOTUpdate", (data) => {
      console.log("📡 triggerOTUpdate:", data);
      io.emit("ot_update", data);
    });

    /**
     * ⭐ PRIVATE MESSAGE
     * Supports BOTH payload formats:
     * 1️⃣ { to: "maa", text: "hello" }
     * 2️⃣ { fromUserId:"ram", toUserId:"maa", message:"hello" }
     */
    socket.on("privateMessage", async (data) => {
      const registeredUserId = connectedUsers.get(socket.id);
      const from = data.fromID || data.fromUserId || registeredUserId;
      const to = data.toID || data.to || data.toUserId || data.receiverId;
      const text = data.text || data.message || data.body;

      if (!from || !to || !text) {
        socket.emit("socket_error", {
          message: "Invalid privateMessage payload. from, to and text are required",
        });
        return;
      }

      const fromRoom = from.toString();
      const toRoom = to.toString();
      const payload = {
        from: fromRoom,
        to: toRoom,
        text,
        conversationId: data.conversationId || null,
        createdAt: new Date().toISOString(),
      };

      io.to(toRoom).emit("privateMessage", payload);
      if (fromRoom !== toRoom) {
        io.to(fromRoom).emit("privateMessage", payload);
      }

      try {
        const senderId = Number(data.fromID ?? from);
        const receiverId = Number(data.toID ?? to);

        const savedMessage = await createMessage({
          conversationId: data.conversationId || null,
          senderId: Number.isNaN(senderId) ? null : senderId,
          receiverID: Number.isNaN(receiverId) ? null : receiverId,
          body: text
        });

        io.to(fromRoom).emit("privateMessageSaved", { id: savedMessage.id, ...payload });
      } catch (err) {
        console.error("❌ Error saving private message:", err.message);
        socket.emit("socket_error", { message: "Message not saved", error: err.message });
      }
    });

    /**
     * CLEANUP
     */
    socket.on("disconnect", () => {
      const user = connectedUsers.get(socket.id);
      console.log(`🔴 Disconnected socket: ${socket.id}, user: ${user}`);
      connectedUsers.delete(socket.id);
    });
  });

  console.log("✅ Socket.IO ready");
  return io;
}

export function getIO() {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
}
