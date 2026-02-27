import express from "express";
import {
  getAllUsers,
  createUser,
  login,
  logout,
  sessionLogin,
} from "../controllers/user.controller.js";

const router = express.Router();

router.get("/", getAllUsers);
router.post("/", createUser);
router.post("/login", login);
router.get("/sessionLogin",sessionLogin)
router.post("/logout", logout);

export default router;
