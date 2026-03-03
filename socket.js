import { Server } from "socket.io";
import { createMessage, updateMessageStatus } from "./models/whatsappmessage.model.js";
import { serializeChatBody } from "./utils/chatMessageFormat.js";
import { setUserOnlineStatus } from "./models/user.model.js";
import { normalizeDbTimestampToIso } from "./utils/time.js";
import pool from "./db.js";

let io = null;

// Track users by socket id
const connectedUsers = new Map();
const lastPresenceWriteByUser = new Map();
const activeCallByUser = new Map();
const participantsByCallId = new Map();
const callMetaByCallId = new Map();
const callAnomalies = [];
const PRESENCE_WRITE_THROTTLE_MS = 15_000;
const MAX_CALL_ANOMALIES = 500;

function hasActiveSocketForUser(userId) {
  for (const connectedUser of connectedUsers.values()) {
    if (connectedUser === userId) return true;
  }
  return false;
}

function countActiveSocketsForUser(userId) {
  let count = 0;
  for (const connectedUser of connectedUsers.values()) {
    if (connectedUser === userId) count += 1;
  }
  return count;
}

function shouldWritePresence(userId) {
  const now = Date.now();
  const lastWrite = lastPresenceWriteByUser.get(userId) || 0;
  if (now - lastWrite < PRESENCE_WRITE_THROTTLE_MS) return false;
  lastPresenceWriteByUser.set(userId, now);
  return true;
}

function normalizeIdentifier(value) {
  return String(value || "").toLowerCase().trim();
}

function trackCallAnomaly(payload = {}, fallback = {}) {
  const entry = {
    source: String(payload.source || fallback.source || "unknown"),
    code: String(payload.code || "unspecified"),
    message: String(payload.message || "Call anomaly"),
    severity: payload.severity === "error" ? "error" : "warn",
    from: normalizeIdentifier(payload.from || fallback.from || ""),
    contact: normalizeIdentifier(payload.contact || ""),
    callId: String(payload.callId || fallback.callId || "").trim() || null,
    details: payload.details && typeof payload.details === "object" ? payload.details : null,
    socketId: String(fallback.socketId || "") || null,
    createdAt: new Date().toISOString(),
  };

  callAnomalies.unshift(entry);
  if (callAnomalies.length > MAX_CALL_ANOMALIES) {
    callAnomalies.length = MAX_CALL_ANOMALIES;
  }

  const logger = entry.severity === "error" ? console.error : console.warn;
  logger("[CallAnomaly]", entry);
}

function getSocketIdsForUser(userId) {
  const normalizedUser = normalizeIdentifier(userId);
  if (!normalizedUser) return [];

  const socketIds = [];
  for (const [socketId, connectedUser] of connectedUsers.entries()) {
    if (connectedUser === normalizedUser) {
      socketIds.push(socketId);
    }
  }

  return socketIds;
}

function emitToExactUser(userId, eventName, payload) {
  const socketIds = getSocketIdsForUser(userId);
  socketIds.forEach((socketId) => {
    io.to(socketId).emit(eventName, payload);
  });
  return socketIds.length;
}

function getActiveCallIdForUser(userId) {
  return activeCallByUser.get(normalizeIdentifier(userId)) || null;
}

function linkCallParticipants(callId, users = []) {
  const normalizedCallId = String(callId || "").trim();
  if (!normalizedCallId) return;

  const participantSet = participantsByCallId.get(normalizedCallId) || new Set();
  users
    .map((value) => normalizeIdentifier(value))
    .filter(Boolean)
    .forEach((identifier) => {
      participantSet.add(identifier);
      activeCallByUser.set(identifier, normalizedCallId);
    });

  participantsByCallId.set(normalizedCallId, participantSet);
}

function clearCallMapping(callId) {
  const normalizedCallId = String(callId || "").trim();
  if (!normalizedCallId) return;

  const participantSet = participantsByCallId.get(normalizedCallId);
  if (participantSet) {
    for (const identifier of participantSet.values()) {
      const mappedCallId = activeCallByUser.get(identifier);
      if (mappedCallId === normalizedCallId) {
        activeCallByUser.delete(identifier);
      }
    }
  }

  participantsByCallId.delete(normalizedCallId);
  callMetaByCallId.delete(normalizedCallId);
}

async function findUserByEmail(email) {
  const normalizedEmail = normalizeIdentifier(email);
  if (!normalizedEmail) return null;

  const result = await pool.query(
    `SELECT id, LOWER(email) AS email FROM users WHERE LOWER(email) = $1 LIMIT 1`,
    [normalizedEmail]
  );

  return result.rows[0] || null;
}

function formatDurationLabel(durationMs) {
  const safeDurationMs = Math.max(0, Number(durationMs) || 0);
  const totalSeconds = Math.floor(safeDurationMs / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

async function createCallEventMessage({
  callId,
  callType,
  from,
  to,
  eventType,
  durationMs = 0,
  startedAt = null,
  answeredAt = null,
  endedAt = null,
  reason = null,
}) {
  const [sender, receiver] = await Promise.all([findUserByEmail(from), findUserByEmail(to)]);
  if (!sender?.id || !receiver?.id) return null;

  const voiceOrVideo = callType === "video" ? "Video" : "Voice";
  let text = `${voiceOrVideo} call`;

  if (eventType === "missed") {
    text = `Missed ${voiceOrVideo.toLowerCase()} call`;
  } else if (eventType === "declined") {
    text = `${voiceOrVideo} call declined`;
  } else if (eventType === "completed") {
    text = `${voiceOrVideo} call • ${formatDurationLabel(durationMs)}`;
  }

  const savedMessage = await createMessage({
    conversationId: null,
    senderId: sender.id,
    receiverID: receiver.id,
    status: "sent",
    isRead: false,
    body: serializeChatBody({
      text,
      messageType: "call",
      call: {
        callId,
        callType,
        eventType,
        durationMs: Math.max(0, Number(durationMs) || 0),
        startedAt,
        answeredAt,
        endedAt,
        reason: reason || null,
      },
    }),
  });

  const payload = {
    id: savedMessage.id,
    from: normalizeIdentifier(from),
    to: normalizeIdentifier(to),
    text,
    messageType: "call",
    file: null,
    call: {
      callId,
      callType,
      eventType,
      durationMs: Math.max(0, Number(durationMs) || 0),
      startedAt,
      answeredAt,
      endedAt,
      reason: reason || null,
    },
    status: "sent",
    isRead: false,
    createdAtMs: Number(savedMessage.created_at_ms) || Date.now(),
    timestampMs: Number(savedMessage.created_at_ms) || Date.now(),
    timestamp: Number(savedMessage.created_at_ms) || Date.now(),
    createdAt: normalizeDbTimestampToIso(savedMessage.created_at) || new Date().toISOString(),
    fromID: sender.id,
    toID: receiver.id,
  };

  io.to(payload.to).emit("privateMessage", payload);
  if (payload.from !== payload.to) {
    io.to(payload.from).emit("privateMessage", payload);
  }

  return payload;
}

async function persistCallEventForBothParticipants({
  callId,
  callType,
  from,
  to,
  eventType,
  durationMs = 0,
  startedAt = null,
  answeredAt = null,
  endedAt = null,
  reason = null,
}) {
  if (!from || !to) return;

  try {
    await createCallEventMessage({
      callId,
      callType,
      from,
      to,
      eventType,
      durationMs,
      startedAt,
      answeredAt,
      endedAt,
      reason,
    });
  } catch (error) {
    console.error("❌ Failed to persist call event:", error.message);
  }
}

export function getSocketPresenceSnapshot() {
  const counts = new Map();

  for (const [socketId, identifier] of connectedUsers.entries()) {
    const current = counts.get(identifier) || { identifier, connectionCount: 0, socketIds: [] };
    current.connectionCount += 1;
    current.socketIds.push(socketId);
    counts.set(identifier, current);
  }

  return {
    totalSockets: connectedUsers.size,
    users: Array.from(counts.values()).sort((a, b) => b.connectionCount - a.connectionCount),
  };
}

export function getCallAnomaliesSnapshot({ limit = 100, severity = "", sinceMs = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), MAX_CALL_ANOMALIES);
  const normalizedSeverity = String(severity || "").toLowerCase();
  const validSeverity = normalizedSeverity === "error" || normalizedSeverity === "warn" ? normalizedSeverity : "";
  const thresholdMs = Math.max(0, Number(sinceMs) || 0);

  const data = [];
  for (const item of callAnomalies) {
    if (validSeverity && item.severity !== validSeverity) continue;
    if (thresholdMs > 0 && Date.parse(item.createdAt) < thresholdMs) continue;

    data.push({
      ...item,
      details: item.details ? { ...item.details } : null,
    });

    if (data.length >= safeLimit) break;
  }

  return {
    totalTracked: callAnomalies.length,
    returned: data.length,
    filters: {
      limit: safeLimit,
      severity: validSeverity || null,
      sinceMs: thresholdMs || null,
    },
    data,
  };
}

export function initSocket(httpServer) {
  if (io) return io; // Prevent re-init

  io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    },
    pingInterval: 20000,
    pingTimeout: 20000,
    maxHttpBufferSize: 1e6,
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

      const previousUser = connectedUsers.get(socket.id);
      if (previousUser === roomId) {
        if (!socket.rooms.has(roomId)) {
          socket.join(roomId);
        }
        return;
      }

      if (previousUser && previousUser !== roomId) {
        connectedUsers.delete(socket.id);
        if (!hasActiveSocketForUser(previousUser)) {
          setUserOnlineStatus({ identifier: previousUser, isOnline: false }).catch((error) => {
            console.error("❌ Failed to set previous user offline:", error.message);
          });

          io.emit("presenceUpdate", {
            identifier: previousUser,
            isOnline: false,
            lastSeen: new Date().toISOString(),
          });
        }
      }

      connectedUsers.set(socket.id, roomId);

      // Join user-specific room
      socket.join(roomId);

      const activeCount = countActiveSocketsForUser(roomId);
      console.log(`🧮 Active sockets for ${roomId}: ${activeCount}`);

      setUserOnlineStatus({ identifier: roomId, isOnline: true }).catch((error) => {
        console.error("❌ Failed to set user online:", error.message);
      });
      lastPresenceWriteByUser.set(roomId, Date.now());

      io.emit("presenceUpdate", {
        identifier: roomId,
        isOnline: true,
        lastSeen: null,
      });
    });

    socket.on("presencePing", () => {
      const user = connectedUsers.get(socket.id);
      if (!user) return;

      if (!shouldWritePresence(user)) return;

      setUserOnlineStatus({ identifier: user, isOnline: true }).catch((error) => {
        console.error("❌ Failed to refresh user presence:", error.message);
      });
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
          createdAtMs: Number(savedMessage.created_at_ms) || Date.now(),
          timestampMs: Number(savedMessage.created_at_ms) || Date.now(),
          timestamp: Number(savedMessage.created_at_ms) || Date.now(),
          createdAt: normalizeDbTimestampToIso(savedMessage.created_at) || new Date().toISOString(),
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

    socket.on("call:offer", (payload = {}) => {
      const registeredUser = normalizeIdentifier(connectedUsers.get(socket.id));
      const from = registeredUser;
      const to = normalizeIdentifier(payload.to || payload.toEmail);
      const callType = payload.callType === "video" ? "video" : "audio";
      const sdp = payload?.sdp;
      const callId = String(payload.callId || "").trim();
      const phase = payload.phase === "renegotiate" ? "renegotiate" : "invite";

      if (!registeredUser || !from || !to || from === to || !sdp || !callId) {
        socket.emit("socket_error", { message: "Invalid call:offer payload" });
        return;
      }

      if (phase === "invite") {
        const fromActiveCallId = getActiveCallIdForUser(from);
        const toActiveCallId = getActiveCallIdForUser(to);

        if ((fromActiveCallId && fromActiveCallId !== callId) || (toActiveCallId && toActiveCallId !== callId)) {
          emitToExactUser(from, "call:busy", {
            callId,
            from: to,
            to: from,
            reason: "engaged",
            createdAt: Date.now(),
          });
          return;
        }
      }

      const deliveredCount = emitToExactUser(to, "call:offer", {
        callId,
        from,
        to,
        phase,
        callType,
        sdp,
        createdAt: Date.now(),
      });

      if (deliveredCount === 0) {
        socket.emit("call:unavailable", {
          callId,
          to,
          reason: "offline",
          createdAt: Date.now(),
        });
        if (phase === "invite") {
          persistCallEventForBothParticipants({
            callId,
            callType,
            from,
            to,
            eventType: "missed",
            durationMs: 0,
            startedAt: null,
            answeredAt: null,
            endedAt: new Date().toISOString(),
            reason: "offline",
          });
          clearCallMapping(callId);
        }
        return;
      }

      if (phase === "invite") {
        linkCallParticipants(callId, [from, to]);
        callMetaByCallId.set(callId, {
          callId,
          callType,
          from,
          to,
          startedAt: Date.now(),
          answeredAt: null,
        });
      }
    });

    socket.on("call:answer", (payload = {}) => {
      const registeredUser = normalizeIdentifier(connectedUsers.get(socket.id));
      const from = registeredUser;
      const to = normalizeIdentifier(payload.to || payload.toEmail);
      const sdp = payload?.sdp;
      const callId = String(payload.callId || "").trim();

      if (!registeredUser || !from || !to || from === to || !sdp || !callId) {
        socket.emit("socket_error", { message: "Invalid call:answer payload" });
        return;
      }

      emitToExactUser(to, "call:answer", {
        callId,
        from,
        to,
        sdp,
        createdAt: Date.now(),
      });

      linkCallParticipants(callId, [from, to]);
      const meta = callMetaByCallId.get(callId) || {
        callId,
        callType: payload.callType === "video" ? "video" : "audio",
        from: to,
        to: from,
        startedAt: Date.now(),
        answeredAt: null,
      };
      meta.answeredAt = Date.now();
      callMetaByCallId.set(callId, meta);
    });

    socket.on("call:ice-candidate", (payload = {}) => {
      const registeredUser = normalizeIdentifier(connectedUsers.get(socket.id));
      const from = registeredUser;
      const to = normalizeIdentifier(payload.to || payload.toEmail);
      const candidate = payload?.candidate;
      const callId = String(payload.callId || "").trim();

      if (!registeredUser || !from || !to || from === to || !candidate || !callId) return;

      emitToExactUser(to, "call:ice-candidate", {
        callId,
        from,
        to,
        candidate,
      });
    });

    socket.on("call:reject", (payload = {}) => {
      const registeredUser = normalizeIdentifier(connectedUsers.get(socket.id));
      const from = registeredUser;
      const to = normalizeIdentifier(payload.to || payload.toEmail);
      const callId = String(payload.callId || "").trim();

      if (!registeredUser || !from || !to || from === to || !callId) return;

      emitToExactUser(to, "call:reject", {
        callId,
        from,
        to,
        reason: String(payload.reason || "declined"),
        createdAt: Date.now(),
      });

      const meta = callMetaByCallId.get(callId) || {
        callId,
        callType: payload.callType === "video" ? "video" : "audio",
        from: to,
        to: from,
        startedAt: Date.now(),
        answeredAt: null,
      };

      const endedAtIso = new Date().toISOString();
      const eventType = "declined";

      persistCallEventForBothParticipants({
        callId,
        callType: meta.callType || "audio",
        from: meta.from || to,
        to: meta.to || from,
        eventType,
        durationMs: 0,
        startedAt: meta.startedAt ? new Date(meta.startedAt).toISOString() : null,
        answeredAt: meta.answeredAt ? new Date(meta.answeredAt).toISOString() : null,
        endedAt: endedAtIso,
        reason: String(payload.reason || "declined"),
      });

      clearCallMapping(callId);
    });

    socket.on("call:end", (payload = {}) => {
      const registeredUser = normalizeIdentifier(connectedUsers.get(socket.id));
      const from = registeredUser;
      const to = normalizeIdentifier(payload.to || payload.toEmail);
      const callId = String(payload.callId || "").trim();

      if (!registeredUser || !from || !to || from === to || !callId) return;

      emitToExactUser(to, "call:end", {
        callId,
        from,
        to,
        createdAt: Date.now(),
      });

      const meta = callMetaByCallId.get(callId) || {
        callId,
        callType: payload.callType === "video" ? "video" : "audio",
        from,
        to,
        startedAt: Date.now(),
        answeredAt: null,
      };

      const endMs = Date.now();
      const answeredAtMs = Number(meta.answeredAt) || null;
      const durationMs = answeredAtMs ? Math.max(0, endMs - answeredAtMs) : 0;

      persistCallEventForBothParticipants({
        callId,
        callType: meta.callType || "audio",
        from: meta.from || from,
        to: meta.to || to,
        eventType: answeredAtMs ? "completed" : "missed",
        durationMs,
        startedAt: meta.startedAt ? new Date(meta.startedAt).toISOString() : null,
        answeredAt: answeredAtMs ? new Date(answeredAtMs).toISOString() : null,
        endedAt: new Date(endMs).toISOString(),
        reason: answeredAtMs ? null : "no-answer",
      });

      clearCallMapping(callId);
    });

    socket.on("call:hold", (payload = {}) => {
      const registeredUser = normalizeIdentifier(connectedUsers.get(socket.id));
      const from = registeredUser;
      const to = normalizeIdentifier(payload.to || payload.toEmail);
      const callId = String(payload.callId || "").trim();
      const onHold = Boolean(payload.onHold);

      if (!registeredUser || !from || !to || from === to || !callId) return;
      if (getActiveCallIdForUser(from) !== callId || getActiveCallIdForUser(to) !== callId) return;

      emitToExactUser(to, "call:hold", {
        callId,
        from,
        to,
        onHold,
        createdAt: Date.now(),
      });
    });

    socket.on("call:media-state", (payload = {}) => {
      const registeredUser = normalizeIdentifier(connectedUsers.get(socket.id));
      const from = registeredUser;
      const to = normalizeIdentifier(payload.to || payload.toEmail);
      const callId = String(payload.callId || "").trim();

      if (!registeredUser || !from || !to || from === to || !callId) return;
      if (getActiveCallIdForUser(from) !== callId || getActiveCallIdForUser(to) !== callId) return;

      emitToExactUser(to, "call:media-state", {
        callId,
        from,
        to,
        micEnabled: payload.micEnabled !== false,
        cameraEnabled: payload.cameraEnabled !== false,
        createdAt: Date.now(),
      });
    });

    socket.on("call:anomaly", (payload = {}) => {
      const registeredUser = normalizeIdentifier(connectedUsers.get(socket.id));
      trackCallAnomaly(payload, {
        source: "frontend",
        from: registeredUser,
        socketId: socket.id,
      });
    });

    /**
     * CLEANUP
     */
    socket.on("disconnect", () => {
      const user = connectedUsers.get(socket.id);
      console.log(`🔴 Disconnected socket: ${socket.id}, user: ${user}`);
      connectedUsers.delete(socket.id);

      if (!user) return;

      const normalizedUser = normalizeIdentifier(user);
      if (!hasActiveSocketForUser(user)) {
        const activeCallId = getActiveCallIdForUser(normalizedUser);
        if (activeCallId) {
          const participants = participantsByCallId.get(activeCallId) || new Set();
          const callMeta = callMetaByCallId.get(activeCallId) || null;
          for (const participant of participants.values()) {
            if (participant !== normalizedUser) {
              emitToExactUser(participant, "call:end", {
                callId: activeCallId,
                from: normalizedUser,
                to: participant,
                createdAt: Date.now(),
              });
            }
          }

          if (callMeta?.from && callMeta?.to) {
            const endMs = Date.now();
            const answeredAtMs = Number(callMeta.answeredAt) || null;
            const durationMs = answeredAtMs ? Math.max(0, endMs - answeredAtMs) : 0;

            persistCallEventForBothParticipants({
              callId: activeCallId,
              callType: callMeta.callType || "audio",
              from: callMeta.from,
              to: callMeta.to,
              eventType: answeredAtMs ? "completed" : "missed",
              durationMs,
              startedAt: callMeta.startedAt ? new Date(callMeta.startedAt).toISOString() : null,
              answeredAt: answeredAtMs ? new Date(answeredAtMs).toISOString() : null,
              endedAt: new Date(endMs).toISOString(),
              reason: "disconnect",
            });
          }

          clearCallMapping(activeCallId);
        }
      }

      if (!hasActiveSocketForUser(user)) {
        setUserOnlineStatus({ identifier: user, isOnline: false }).catch((error) => {
          console.error("❌ Failed to set user offline:", error.message);
        });
        lastPresenceWriteByUser.delete(user);

        io.emit("presenceUpdate", {
          identifier: user,
          isOnline: false,
          lastSeen: new Date().toISOString(),
        });
      } else {
        const activeCount = countActiveSocketsForUser(user);
        console.log(`🧮 Remaining active sockets for ${user}: ${activeCount}`);
      }
    });
  });

  console.log("✅ Socket.IO ready");
  return io;
}

export function getIO() {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
}
