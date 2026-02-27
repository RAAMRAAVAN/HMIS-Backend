import express from "express";
import {
  getAllUsers,
  createUser,
  login,
  logout,
  sessionLogin,
  getChatHistory,
  getChatOverview,
  markChatAsRead,
} from "../controllers/user.controller.js";

const router = express.Router();

router.get("/", getAllUsers);
router.post("/", createUser);
router.post("/login", login);
router.get("/sessionLogin",sessionLogin)
router.post("/logout", logout);
router.get("/chat-overview", getChatOverview);
router.get("/chat-history/:otherUserId", getChatHistory);
router.post("/chat-read/:otherUserId", markChatAsRead);

export default router;
