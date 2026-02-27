import {
  getAllUsersFromDB,
  createUserInDB,
  findUserByNameModel,
} from "../models/user.model.js";
import pool from "../db.js";

import bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";
import { redis } from "../src/config/redis.js";

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
