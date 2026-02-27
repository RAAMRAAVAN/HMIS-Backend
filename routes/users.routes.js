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

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

router.get("/", getAllUsers);
router.post("/", createUser);
router.post("/login", login);
router.get("/sessionLogin",sessionLogin)
router.post("/logout", logout);
router.get("/chat-overview", getChatOverview);
router.get("/chat-history/:otherUserId", getChatHistory);
router.post("/chat-read/:otherUserId", markChatAsRead);
router.post("/chat-upload", upload.single("file"), uploadChatFile);

export default router;
