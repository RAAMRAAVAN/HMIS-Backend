import express from "express";
import multer from "multer";
import {
  getAllUsers,
  createUser,
  login,
  logout,
  sessionLogin,
  getChatHistory,
  getChatOverview,
  markChatAsRead,
  uploadChatFile,
} from "../controllers/user.controller.js";
import { createRateLimiter } from "../middleware/rateLimit.middleware.js";

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const loginRateLimit = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 12,
  keyPrefix: "login",
});

const readRateLimit = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 180,
  keyPrefix: "read",
});

const writeRateLimit = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 90,
  keyPrefix: "write",
});

router.get("/", readRateLimit, getAllUsers);
router.post("/", writeRateLimit, createUser);
router.post("/login", loginRateLimit, login);
router.get("/sessionLogin", readRateLimit, sessionLogin)
router.post("/logout", writeRateLimit, logout);
router.get("/chat-overview", readRateLimit, getChatOverview);
router.get("/chat-history/:otherUserId", readRateLimit, getChatHistory);
router.post("/chat-read/:otherUserId", writeRateLimit, markChatAsRead);
router.post("/chat-upload", writeRateLimit, upload.single("file"), uploadChatFile);

export default router;
