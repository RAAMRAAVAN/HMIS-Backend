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
import { getIO } from "../socket.js";

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

    // ====== SESSION LOGIC ======
    const sessionId = uuidv4(); // generate unique session ID

    // Store session in Redis for 7 days
    await redis.set(`session:${sessionId}`, JSON.stringify({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role
    }), {
      EX: 7 * 24 * 60 * 60 // 7 days in seconds
    });

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
    if (sessionId) await redis.del(`session:${sessionId}`);
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
        status: row.status || (row.is_read ? "read" : "sent"),
        timestamp: row.created_at,
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
      ORDER BY COALESCE(last_msg.created_at, u.created_at) DESC, u.name ASC
      `,
      [sessionUser.id]
    );

    return res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("Chat overview error:", error);
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
