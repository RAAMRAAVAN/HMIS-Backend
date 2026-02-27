// db.js
import pkg from "pg";
import dotenv from "dotenv";

const { Pool } = pkg;
dotenv.config();

const pool = new Pool({
  user: process.env.DB_USER || "hmis_user",
  password: process.env.DB_PASSWORD || "",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "hmis",
  port: Number(process.env.DB_PORT) || 5432,
});

pool.on("connect", () => {
  console.log("✅ PostgreSQL pool connected");
});

pool.on("error", (err) => {
  console.error("❌ PostgreSQL pool error:", err);
});

export default pool;
// docker exec -it hmis-postgres psql -U hmis_user -d hmis