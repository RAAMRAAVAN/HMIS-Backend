import pool from "../db.js";

export const getAllUsersFromDB = async () => {
  const result = await pool.query(
    "SELECT id, name, email, role, created_at, is_online, last_seen FROM users ORDER BY id DESC"
  );
  return result.rows;
};

export const createUserInDB = async ({ name, email, password, role }) => {
  const result = await pool.query(
    `INSERT INTO users (name, email, password, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, email, role`,
    [name, email, password, role]
  );

  return result.rows[0];
};

export async function findUserByNameModel(identifier) {
  const result = await pool.query(
    "SELECT id, name, email, password, role FROM users WHERE email = $1 OR name = $1",
    [identifier]
  );

  return result.rows[0];   // undefined if no user
}