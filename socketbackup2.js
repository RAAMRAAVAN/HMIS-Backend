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
      console.log(`👤 User registered → user: ${userID}, socket: ${socket.id}`);
      connectedUsers.set(socket.id, userID);

      // Join user-specific room
      socket.join(userID);
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
      const from = connectedUsers.get(socket.id) || data.fromUserId || "UNKNOWN";
      const to = data.to || data.toUserId;
      const text = data.text || data.message;

      const fromID = data.fromID; // numeric sender id
      const toID = data.toID;     // numeric receiver id
      const conversationId = data.conversationId;

      console.log("💬 PRIVATE MESSAGE RECEIVED");
      console.log("   🔹 From User  :", from);
      console.log("   🔹 Socket ID  :", socket.id);
      console.log("   🔹 To User    :", to);
      console.log("   🔹 Message    :", text);
      console.log("   🔹 Raw Payload:", data);
      console.log("----------------------------------");

      if (!to || !text) {
        console.log("⚠️ Invalid privateMessage payload — missing to/text");
        return;
      }

      // ------------------------
      // LIVE EMIT
      // ------------------------
      if(to !== from){
      io.to(to.toString()).emit("privateMessage", { from, to, text });
      io.to(from.toString()).emit("privateMessage", { from, to, text });
      }
      else{
        io.to(to.toString()).emit("privateMessage", { from, to, text });
      }

      // ------------------------
      // SAVE MESSAGE TO DATABASE
      // ------------------------
      try {
        const savedMessage = await createMessage({
          conversationId: conversationId,
          senderId: fromID,
          receiverID: toID,
          body: text
        });
        console.log("✅ Private message saved to DB:", savedMessage);
      } catch (err) {
        console.error("❌ Error saving private message:", err.message);
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
