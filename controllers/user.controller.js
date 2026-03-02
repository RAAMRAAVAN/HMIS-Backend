import {
  getAllUsersFromDB,
  createUserInDB,
  findUserByNameModel,
  setUserOnlineStatus,
} from "../models/user.model.js";
import pool from "../db.js";

import bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";
import { redis } from "../src/config/redis.js";
import fs from "fs/promises";
import path from "path";
import { parseChatBody } from "../utils/chatMessageFormat.js";
import { getIO, getSocketPresenceSnapshot } from "../socket.js";
import { normalizeDbTimestampToIso } from "../utils/time.js";

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_ACTIVE_SESSIONS_PER_USER = Number(process.env.MAX_ACTIVE_SESSIONS_PER_USER || 5);

function getUserSessionIndexKey(userId) {
  return `user_sessions:${userId}`;
}

async function pruneStaleUserSessionIndex(userId) {
  const indexKey = getUserSessionIndexKey(userId);
  const sessionIds = await redis.zRange(indexKey, 0, -1);

  if (!sessionIds.length) return;

  const pipeline = redis.multi();
  for (const sessionId of sessionIds) {
    pipeline.exists(`session:${sessionId}`);
  }

  const existsResults = await pipeline.exec();
  const staleSessionIds = [];

  for (let i = 0; i < existsResults.length; i += 1) {
    const existsCount = Number(existsResults[i] || 0);
    if (existsCount === 0) {
      staleSessionIds.push(sessionIds[i]);
    }
  }

  if (staleSessionIds.length) {
    await redis.zRem(indexKey, staleSessionIds);
  }
}

async function evictOldestUserSessions(userId, sessionsToEvict) {
  if (sessionsToEvict <= 0) return;

  const indexKey = getUserSessionIndexKey(userId);
  const sessionIds = await redis.zRange(indexKey, 0, sessionsToEvict - 1);
  if (!sessionIds.length) return;

  const pipeline = redis.multi();
  for (const sessionId of sessionIds) {
    pipeline.del(`session:${sessionId}`);
  }
  pipeline.zRem(indexKey, sessionIds);
  await pipeline.exec();
}

async function getSessionUserFromRequest(req) {
  const sessionId = req.cookies.sessionId;
  if (!sessionId) return null;

  const userData = await redis.get(`session:${sessionId}`);
  if (!userData) return null;

  try {
    return JSON.parse(userData);
  } catch {
    return null;
  }
}

async function requireAdminSession(req, res) {
  const sessionUser = await getSessionUserFromRequest(req);

  if (!sessionUser?.id) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return null;
  }

  if (String(sessionUser.role || "").toLowerCase() !== "admin") {
    res.status(403).json({ success: false, message: "Admin access required" });
    return null;
  }

  return sessionUser;
}

function getFileKind(mimeType = "") {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

function buildChatKey({ fromID, toID, fromEmail, toEmail }) {
  const idA = Number(fromID);
  const idB = Number(toID);

  if (!Number.isNaN(idA) && !Number.isNaN(idB) && idA > 0 && idB > 0) {
    const [minId, maxId] = [idA, idB].sort((a, b) => a - b);
    return `user_${minId}_user_${maxId}`;
  }

  const emailA = String(fromEmail || "").toLowerCase().replace(/[^a-z0-9@._-]/g, "_");
  const emailB = String(toEmail || "").toLowerCase().replace(/[^a-z0-9@._-]/g, "_");
  const [minEmail, maxEmail] = [emailA, emailB].sort();
  return `email_${minEmail}__${maxEmail}`;
}

async function updateUserPassword(userId, hashedPassword) {
  await pool.query(
    "UPDATE users SET password = $1 WHERE id = $2",
    [hashedPassword, userId]
  );
}

export const getAllUsers = async (req, res) => {
  try {
    const users = await getAllUsersFromDB();
    res.json({ success: true, data: users });
  } catch (error) {
    console.error("Get users error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

export const createUser = async (req, res) => {
  try {
    const adminUser = await requireAdminSession(req, res);
    if (!adminUser) return;

    const { name, email, username, userId, password, role = "user" } = req.body;
    const resolvedName = name || username;
    const resolvedEmail = email || userId;

    if (!resolvedName || !resolvedEmail || !password) {
      return res
        .status(400)
        .json({ success: false, message: "name, email and password are required" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await createUserInDB({
      name: resolvedName,
      email: resolvedEmail,
      password: hashedPassword,
      role,
    });

    res.status(201).json({ success: true, data: user });
  } catch (error) {
    if (error?.code === "23505") {
      return res.status(409).json({ success: false, message: "User already exists" });
    }
    console.error("Create user error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

export const updateUserByAdmin = async (req, res) => {
  try {
    const adminUser = await requireAdminSession(req, res);
    if (!adminUser) return;

    const targetUserId = Number(req.params.id);
    if (!targetUserId) {
      return res.status(400).json({ success: false, message: "Invalid user id" });
    }

    const { name, email, role, password } = req.body || {};

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (typeof name === "string" && name.trim()) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name.trim());
    }

    if (typeof email === "string" && email.trim()) {
      updates.push(`email = $${paramIndex++}`);
      values.push(email.trim().toLowerCase());
    }

    if (typeof role === "string" && role.trim()) {
      const normalizedRole = role.trim().toLowerCase();
      const allowedRoles = new Set(["user", "admin", "superadmin"]);
      if (!allowedRoles.has(normalizedRole)) {
        return res.status(400).json({ success: false, message: "Invalid role" });
      }
      updates.push(`role = $${paramIndex++}`);
      values.push(normalizedRole);
    }

    if (typeof password === "string" && password.length > 0) {
      const hashedPassword = await bcrypt.hash(password, 10);
      updates.push(`password = $${paramIndex++}`);
      values.push(hashedPassword);
    }

    if (!updates.length) {
      return res.status(400).json({ success: false, message: "No valid fields to update" });
    }

    values.push(targetUserId);

    const result = await pool.query(
      `
        UPDATE users
        SET ${updates.join(", ")}
        WHERE id = $${paramIndex}
        RETURNING id, name, email, role
      `,
      values
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    return res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error?.code === "23505") {
      return res.status(409).json({ success: false, message: "Email already exists" });
    }
    console.error("Update user error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export const deleteUserByAdmin = async (req, res) => {
  try {
    const adminUser = await requireAdminSession(req, res);
    if (!adminUser) return;

    const targetUserId = Number(req.params.id);
    if (!targetUserId) {
      return res.status(400).json({ success: false, message: "Invalid user id" });
    }

    if (Number(adminUser.id) === targetUserId) {
      return res.status(400).json({ success: false, message: "You cannot delete your own account" });
    }

    const deleteResult = await pool.query(
      `DELETE FROM users WHERE id = $1 RETURNING id, name, email, role`,
      [targetUserId]
    );

    if (!deleteResult.rows.length) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const userSessionIndexKey = getUserSessionIndexKey(targetUserId);
    const sessionIds = await redis.zRange(userSessionIndexKey, 0, -1);
    if (sessionIds.length) {
      const pipeline = redis.multi();
      for (const sessionId of sessionIds) {
        pipeline.del(`session:${sessionId}`);
      }
      pipeline.del(userSessionIndexKey);
      await pipeline.exec();
    } else {
      await redis.del(userSessionIndexKey);
    }

    return res.json({ success: true, data: deleteResult.rows[0] });
  } catch (error) {
    console.error("Delete user error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};


export async function login(req, res) {
  try {
    const { userId, email, username, password } = req.body;
    const loginId = userId || email || username;

    if (!loginId || !password) {
      return res.status(400).json({
        success: false,
        message: "email/username and password are required",
      });
    }

    const user = await findUserByNameModel(loginId);
    if (!user) {
      return res.status(400).json({ success: false, message: "User not found" });
    }

    let isMatch = false;
    const isHashed = user.password.startsWith("$2");

    if (isHashed) {
      isMatch = await bcrypt.compare(password, user.password);
    } else {
      isMatch = password === user.password;
      if (isMatch) {
        const newHash = await bcrypt.hash(password, 10);
        await updateUserPassword(user.id, newHash);
      }
    }

    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: "Invalid password",
      });
    }

    await pruneStaleUserSessionIndex(user.id);

    const userSessionIndexKey = getUserSessionIndexKey(user.id);
    const activeSessions = await redis.zCard(userSessionIndexKey);
    if (activeSessions >= MAX_ACTIVE_SESSIONS_PER_USER) {
      const sessionsToEvict = activeSessions - MAX_ACTIVE_SESSIONS_PER_USER + 1;
      await evictOldestUserSessions(user.id, sessionsToEvict);
    }

    // ====== SESSION LOGIC ======
    const sessionId = uuidv4(); // generate unique session ID
    const sessionPayload = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      sessionId,
      createdAt: new Date().toISOString(),
    };

    // Store session in Redis for 7 days
    await redis.set(`session:${sessionId}`, JSON.stringify(sessionPayload), {
      EX: SESSION_TTL_SECONDS
    });

    await redis.zAdd(userSessionIndexKey, [{
      score: Date.now(),
      value: sessionId,
    }]);
    await redis.expire(userSessionIndexKey, SESSION_TTL_SECONDS);

    // Send cookie to client
    res.cookie("sessionId", sessionId, {
      httpOnly: true,
      secure: false,     // set true in production HTTPS
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    return res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

export const logout = async (req, res) => {
  try {
    const sessionUser = await getSessionUserFromRequest(req);

    if (sessionUser?.email || sessionUser?.name) {
      const identifier = String(sessionUser.email || sessionUser.name).toLowerCase();
      await setUserOnlineStatus({ identifier, isOnline: false });

      try {
        const io = getIO();
        io.emit("presenceUpdate", {
          identifier,
          isOnline: false,
          lastSeen: new Date().toISOString(),
        });
      } catch {
      }
    }

    const sessionId = req.cookies.sessionId;
    if (sessionId) {
      await redis.del(`session:${sessionId}`);

      if (sessionUser?.id) {
        const userSessionIndexKey = getUserSessionIndexKey(sessionUser.id);
        await redis.zRem(userSessionIndexKey, sessionId);
      }
    }
    res.clearCookie("sessionId");
    res.json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

export const sessionLogin = async (req,res)=>{
  try {
    const sessionId = req.cookies.sessionId;

    if (!sessionId) {
      return res.status(401).json({ success:false });
    }

    const userData = await redis.get(`session:${sessionId}`);

    if (!userData) {
      return res.status(401).json({ success:false });
    }

    return res.json({
      success:true,
      user: JSON.parse(userData)
    });
  } catch (error) {
    console.error("Session login error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export const getSessionDiagnostics = async (req, res) => {
  try {
    const sessionGroups = new Map();
    const sessionKeyPrefix = "session:";

    let cursor = "0";
    do {
      const scanResult = await redis.scan(cursor, {
        MATCH: `${sessionKeyPrefix}*`,
        COUNT: 200,
      });

      cursor = String(scanResult?.cursor ?? "0");
      const keys = scanResult?.keys || [];

      for (const key of keys) {
        const sessionId = String(key).slice(sessionKeyPrefix.length);
        const value = await redis.get(key);
        if (!value) continue;

        let parsed;
        try {
          parsed = JSON.parse(value);
        } catch {
          continue;
        }

        const identifier = String(parsed?.email || parsed?.name || parsed?.id || "unknown").toLowerCase();
        const group = sessionGroups.get(identifier) || {
          identifier,
          userId: parsed?.id ?? null,
          name: parsed?.name ?? null,
          email: parsed?.email ?? null,
          redisSessionCount: 0,
          redisSessionIds: [],
        };

        group.redisSessionCount += 1;
        group.redisSessionIds.push(sessionId);
        sessionGroups.set(identifier, group);
      }
    } while (cursor !== "0");

    const socketSnapshot = getSocketPresenceSnapshot();
    const socketMap = new Map(socketSnapshot.users.map((item) => [item.identifier, item]));

    for (const [identifier, group] of sessionGroups.entries()) {
      const socketInfo = socketMap.get(identifier);
      group.socketConnectionCount = socketInfo?.connectionCount || 0;
      group.socketIds = socketInfo?.socketIds || [];
      group.inferredOnline = group.socketConnectionCount > 0;
    }

    for (const socketInfo of socketSnapshot.users) {
      if (sessionGroups.has(socketInfo.identifier)) continue;
      sessionGroups.set(socketInfo.identifier, {
        identifier: socketInfo.identifier,
        userId: null,
        name: null,
        email: socketInfo.identifier,
        redisSessionCount: 0,
        redisSessionIds: [],
        socketConnectionCount: socketInfo.connectionCount,
        socketIds: socketInfo.socketIds,
        inferredOnline: socketInfo.connectionCount > 0,
      });
    }

    const data = Array.from(sessionGroups.values()).sort((a, b) => {
      if (b.socketConnectionCount !== a.socketConnectionCount) {
        return b.socketConnectionCount - a.socketConnectionCount;
      }
      if (b.redisSessionCount !== a.redisSessionCount) {
        return b.redisSessionCount - a.redisSessionCount;
      }
      return a.identifier.localeCompare(b.identifier);
    });

    return res.json({
      success: true,
      summary: {
        totalRedisSessions: data.reduce((sum, item) => sum + item.redisSessionCount, 0),
        totalSocketConnections: socketSnapshot.totalSockets,
        usersTracked: data.length,
      },
      data,
    });
  } catch (error) {
    console.error("Session diagnostics error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export const getChatHistory = async (req, res) => {
  try {
    const sessionUser = await getSessionUserFromRequest(req);
    if (!sessionUser?.id) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const otherUserId = Number(req.params.otherUserId);
    if (!otherUserId) {
      return res.status(400).json({ success: false, message: "Invalid user id" });
    }

    const result = await pool.query(
      `
      SELECT
        m.id,
        m.sender_id,
        m.receiver_id,
        m.body,
        m.created_at,
        (EXTRACT(EPOCH FROM (m.created_at AT TIME ZONE 'UTC')) * 1000)::bigint AS created_at_ms,
        m.status,
        COALESCE(m.is_read, false) AS is_read,
        LOWER(s.email) AS sender_email,
        LOWER(r.email) AS receiver_email
      FROM messages m
      LEFT JOIN users s ON s.id = m.sender_id
      LEFT JOIN users r ON r.id = m.receiver_id
      WHERE
        (m.sender_id = $1 AND m.receiver_id = $2)
        OR
        (m.sender_id = $2 AND m.receiver_id = $1)
      ORDER BY m.created_at ASC, m.id ASC
      `,
      [sessionUser.id, otherUserId]
    );

    const data = result.rows.map((row) => {
      const parsedBody = parseChatBody(row.body);

      return {
        id: row.id,
        from: row.sender_email,
        to: row.receiver_email,
        text: parsedBody.text,
        messageType: parsedBody.messageType,
        file: parsedBody.file,
        call: parsedBody.call || null,
        status: row.status || (row.is_read ? "read" : "sent"),
        timestampMs: Number(row.created_at_ms) || Date.now(),
        timestamp: Number(row.created_at_ms) || Date.now(),
        createdAt: normalizeDbTimestampToIso(row.created_at),
        fromID: row.sender_id,
        toID: row.receiver_id,
        isRead: row.is_read,
      };
    });

    return res.json({ success: true, data });
  } catch (error) {
    console.error("Chat history error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export const getChatOverview = async (req, res) => {
  try {
    const sessionUser = await getSessionUserFromRequest(req);
    if (!sessionUser?.id) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const result = await pool.query(
      `
      SELECT
        u.id,
        u.name,
        LOWER(u.email) AS email,
        COALESCE(last_msg.body, '') AS last_message,
        last_msg.created_at AS last_message_at,
        (EXTRACT(EPOCH FROM (last_msg.created_at AT TIME ZONE 'UTC')) * 1000)::bigint AS last_message_at_ms,
        COALESCE(unseen.unseen_count, 0) AS unseen_count
      FROM users u
      LEFT JOIN LATERAL (
        SELECT m.body, m.created_at
        FROM messages m
        WHERE
          (m.sender_id = $1 AND m.receiver_id = u.id)
          OR
          (m.sender_id = u.id AND m.receiver_id = $1)
        ORDER BY m.created_at DESC
        LIMIT 1
      ) last_msg ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS unseen_count
        FROM messages m
        WHERE
          m.sender_id = u.id
          AND m.receiver_id = $1
          AND COALESCE(m.is_read, false) = false
      ) unseen ON true
      WHERE u.id <> $1
        AND last_msg.created_at IS NOT NULL
      ORDER BY last_msg.created_at DESC, u.name ASC
      `,
      [sessionUser.id]
    );

    const data = result.rows.map((row) => {
      const parsedBody = parseChatBody(row.last_message || "");
      return {
        ...row,
        last_message: parsedBody.text || "",
        last_message_at_ms: row.last_message_at_ms ? Number(row.last_message_at_ms) : null,
      };
    });

    return res.json({ success: true, data });
  } catch (error) {
    console.error("Chat overview error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export const getChatSuggestions = async (req, res) => {
  try {
    const sessionUser = await getSessionUserFromRequest(req);
    if (!sessionUser?.id) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const queryText = String(req.query.q || "").trim().toLowerCase();
    if (!queryText) {
      return res.json({ success: true, data: [] });
    }

    const requestedLimit = Number(req.query.limit || 12);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 30)
      : 12;

    const result = await pool.query(
      `
      SELECT
        u.id,
        u.name,
        LOWER(u.email) AS email,
        (
          u.is_online IS NOT NULL
          AND u.is_online >= ((NOW() AT TIME ZONE 'UTC') - INTERVAL '40 seconds')
        ) AS is_online,
        CASE
          WHEN u.last_seen IS NULL THEN NULL
          ELSE to_char(u.last_seen, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS last_seen,
        COALESCE(last_msg.body, '') AS last_message,
        (EXTRACT(EPOCH FROM (last_msg.created_at AT TIME ZONE 'UTC')) * 1000)::bigint AS last_message_at_ms,
        (last_msg.created_at IS NOT NULL) AS has_history
      FROM users u
      LEFT JOIN LATERAL (
        SELECT m.body, m.created_at
        FROM messages m
        WHERE
          (m.sender_id = $1 AND m.receiver_id = u.id)
          OR
          (m.sender_id = u.id AND m.receiver_id = $1)
        ORDER BY m.created_at DESC
        LIMIT 1
      ) last_msg ON true
      WHERE
        u.id <> $1
        AND (
          LOWER(u.name) LIKE $2
          OR LOWER(u.email) LIKE $2
        )
      ORDER BY
        (last_msg.created_at IS NOT NULL) DESC,
        COALESCE(last_msg.created_at, u.created_at) DESC,
        u.name ASC
      LIMIT $3
      `,
      [sessionUser.id, `%${queryText}%`, limit]
    );

    const data = result.rows.map((row) => {
      const parsedBody = parseChatBody(row.last_message || "");
      return {
        ...row,
        last_message: parsedBody.text || "",
        has_history: Boolean(row.has_history),
        is_online: Boolean(row.is_online),
        last_message_at_ms: row.last_message_at_ms ? Number(row.last_message_at_ms) : null,
      };
    });

    return res.json({ success: true, data });
  } catch (error) {
    console.error("Chat suggestions error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export const markChatAsRead = async (req, res) => {
  try {
    const sessionUser = await getSessionUserFromRequest(req);
    if (!sessionUser?.id) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const otherUserId = Number(req.params.otherUserId);
    if (!otherUserId) {
      return res.status(400).json({ success: false, message: "Invalid user id" });
    }

    const updateResult = await pool.query(
      `
      UPDATE messages
      SET is_read = true, status = 'read'
      WHERE
        sender_id = $1
        AND receiver_id = $2
        AND COALESCE(is_read, false) = false
      RETURNING id
      `,
      [otherUserId, sessionUser.id]
    );

    if (updateResult.rowCount > 0) {
      const senderResult = await pool.query(
        `SELECT LOWER(email) AS email FROM users WHERE id = $1 LIMIT 1`,
        [otherUserId]
      );
      const senderEmail = senderResult.rows?.[0]?.email;

      if (senderEmail) {
        const io = getIO();
        updateResult.rows.forEach((row) => {
          io.to(senderEmail).emit("messageStatus", {
            messageId: row.id,
            status: "read",
            updatedAt: new Date().toISOString(),
          });
        });
      }
    }

    return res.json({ success: true, updated: updateResult.rowCount });
  } catch (error) {
    console.error("Mark chat read error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

export const uploadChatFile = async (req, res) => {
  try {
    const sessionUser = await getSessionUserFromRequest(req);
    if (!sessionUser?.id) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: "File is required" });
    }

    const { fromID, toID, fromEmail, toEmail } = req.body;
    const chatKey = buildChatKey({ fromID, toID, fromEmail, toEmail });

    const uploadsBaseDir = path.join(process.cwd(), "uploads", "chats", chatKey);
    const filesDir = path.join(uploadsBaseDir, "files");
    await fs.mkdir(filesDir, { recursive: true });

    const extension = path.extname(req.file.originalname || "") || "";
    const storedName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${extension}`;
    const absoluteFilePath = path.join(filesDir, storedName);
    await fs.writeFile(absoluteFilePath, req.file.buffer);

    const relativePath = `/uploads/chats/${chatKey}/files/${storedName}`;
    const fileDetails = {
      kind: getFileKind(req.file.mimetype || ""),
      originalName: req.file.originalname,
      storedName,
      mimeType: req.file.mimetype,
      size: req.file.size,
      url: relativePath,
    };

    const metadataPath = path.join(uploadsBaseDir, "metadata.json");
    let metadata = [];

    try {
      const existing = await fs.readFile(metadataPath, "utf-8");
      metadata = JSON.parse(existing);
      if (!Array.isArray(metadata)) metadata = [];
    } catch {
      metadata = [];
    }

    metadata.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      senderId: Number(fromID) || null,
      receiverId: Number(toID) || null,
      senderEmail: String(fromEmail || "").toLowerCase(),
      receiverEmail: String(toEmail || "").toLowerCase(),
      uploadedAt: new Date().toISOString(),
      ...fileDetails,
    });

    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");

    return res.json({ success: true, file: fileDetails });
  } catch (error) {
    console.error("Chat file upload error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
