import pool from "./db.js";

const test = async () => {
  const res = await pool.query("SELECT NOW()");
  console.log("DB OK:", res.rows[0]);
  process.exit(0);
};

test();
