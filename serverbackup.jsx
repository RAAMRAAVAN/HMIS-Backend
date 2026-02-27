import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import { initSocket } from "./socket.js";
import usersRoutes from "./routes/users.routes.js";
import otRoutes from "./routes/ot.routes.js";
import http from "http";
// import { initSocket } from "./socket.js";

dotenv.config();

const app = express();
const httpServer = createServer(app);

// Middlewares
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
// Initialize socket.io
initSocket(server);

app.use("/api/users", usersRoutes);
app.use("/api/ot", otRoutes);
// Health check
app.get("/", (req, res) => {
  res.send("🚀 HMIS Backend running");
});

// Initialize socket
initSocket(httpServer);

const PORT = process.env.PORT || 5000;

httpServer.listen(PORT, () => {
  console.log(`🚀 Server + Socket running on port ${PORT}`);
});
