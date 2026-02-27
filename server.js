import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import { initSocket } from "./socket.js";
import usersRoutes from "./routes/users.routes.js";
import otRoutes from "./routes/ot.routes.js";
import cookieParser from "cookie-parser";

dotenv.config();

const app = express();
const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:3001,http://127.0.0.1:3001")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const privateNetworkOriginRegex = /^https?:\/\/(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/i;

// Middlewares
// CORS config
app.use(cors({
  origin: (origin, callback) => {
    const normalizedOrigin = origin?.trim();
    const isAllowedOrigin = normalizedOrigin && allowedOrigins.includes(normalizedOrigin);
    const isPrivateNetworkOrigin = normalizedOrigin && privateNetworkOriginRegex.test(normalizedOrigin);

    if (!normalizedOrigin || isAllowedOrigin || isPrivateNetworkOrigin) {
      return callback(null, true);
    }
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true                 // ✅ allow cookies
}));
app.use(express.json());
app.use(cookieParser());

// Create HTTP server (socket will attach to this)
const httpServer = createServer(app);

// Init Socket.IO (ONLY ONCE)
initSocket(httpServer);

// Routes
app.use("/api/users", usersRoutes);
app.use("/api/ot", otRoutes);

// Health check
app.get("/", (req, res) => {
  res.send("🚀 HMIS Backend running");
});

// Start server
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || "0.0.0.0";

httpServer.listen(PORT, HOST, () => {
  console.log(`🚀 Server + Socket running on http://${HOST}:${PORT}`);
});
