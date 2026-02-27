import { Server } from "socket.io";
import { createMessage, updateMessageStatus } from "./models/whatsappmessage.model.js";
import { serializeChatBody } from "./utils/chatMessageFormat.js";

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
     * socket.emit("register", userEmail)
     */
    socket.on("register", (userEmail) => {
      if (!userEmail) {
        socket.emit("socket_error", { message: "userEmail is required for register" });
        return;
      }

      const roomId = userEmail.toString().toLowerCase();
      console.log(`👤 User registered → user: ${roomId}, socket: ${socket.id}`);
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
      const registeredUser = connectedUsers.get(socket.id);
      const from = data.fromEmail || data.fromUserEmail || data.from || data.fromUserId || registeredUser;
      const to = data.toEmail || data.toUserEmail || data.to || data.toUserId || data.receiverId;
      const text = data.text || data.message || data.body;
      const messageType = data.messageType === "file" ? "file" : "text";
      const file = data.file || null;

      if (!from || !to || (!text && !file)) {
        socket.emit("socket_error", {
          message: "Invalid privateMessage payload. from, to and (text or file) are required",
        });
        return;
      }

      const fromRoom = from.toString().toLowerCase();
      const toRoom = to.toString().toLowerCase();
      try {
        const senderId = Number(data.fromID);
        const receiverId = Number(data.toID);
        const receiverRoomSize = io.sockets.adapter.rooms.get(toRoom)?.size || 0;
        const initialStatus = receiverRoomSize > 0 ? "delivered" : "sent";

        const savedMessage = await createMessage({
          conversationId: data.conversationId || null,
          senderId: Number.isNaN(senderId) ? null : senderId,
          receiverID: Number.isNaN(receiverId) ? null : receiverId,
          status: initialStatus,
          isRead: false,
          body: serializeChatBody({
            text: text || file?.originalName || "",
            messageType,
            file,
          })
        });

        const payload = {
          id: savedMessage.id,
          from: fromRoom,
          to: toRoom,
          text: text || file?.originalName || "",
          messageType,
          file,
          status: initialStatus,
          isRead: false,
          conversationId: data.conversationId || null,
          createdAt: savedMessage.created_at || new Date().toISOString(),
        };

        io.to(toRoom).emit("privateMessage", payload);
        if (fromRoom !== toRoom) {
          io.to(fromRoom).emit("privateMessage", payload);
        }

        if (initialStatus === "delivered") {
          io.to(fromRoom).emit("messageStatus", {
            messageId: savedMessage.id,
            status: "delivered",
            updatedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        console.error("❌ Error saving private message:", err.message);
        socket.emit("socket_error", { message: "Message not saved", error: err.message });
      }
    });

    socket.on("messageDelivered", async (data) => {
      try {
        const messageId = data?.messageId;
        const from = String(data?.from || "").toLowerCase();
        if (!messageId || !from) return;

        const updated = await updateMessageStatus({
          messageId,
          status: "delivered",
          isRead: false,
        });

        if (!updated) return;

        io.to(from).emit("messageStatus", {
          messageId,
          status: updated.is_read ? "read" : "delivered",
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        console.error("❌ Error updating delivered status:", error.message);
      }
    });

    socket.on("messageSeen", async (data) => {
      try {
        const messageId = data?.messageId;
        const from = String(data?.from || "").toLowerCase();
        if (!messageId) return;

        const updated = await updateMessageStatus({
          messageId,
          status: "read",
          isRead: true,
        });

        if (!updated) return;

        if (from) {
          io.to(from).emit("messageStatus", {
            messageId,
            status: "read",
            updatedAt: new Date().toISOString(),
          });
        }
      } catch (error) {
        console.error("❌ Error updating seen status:", error.message);
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
