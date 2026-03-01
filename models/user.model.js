import pool from "../db.js";

export const getAllUsersFromDB = async () => {
  const result = await pool.query(
    `
      SELECT
        id,
        name,
        email,
        role,
        created_at,
        (is_online IS NOT NULL) AS is_online,
        CASE
          WHEN is_online IS NULL THEN NULL
          ELSE to_char(is_online, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS online_at,
        CASE
          WHEN last_seen IS NULL THEN NULL
          ELSE to_char(last_seen, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS last_seen
      FROM users
      ORDER BY id DESC
    `
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

export const setUserOnlineStatus = async ({ identifier, isOnline }) => {
  if (!identifier) return;

  await pool.query(
    `
      UPDATE users
      SET
        is_online = CASE WHEN $2::boolean THEN (NOW() AT TIME ZONE 'UTC') ELSE NULL END,
        last_seen = CASE WHEN $2::boolean THEN last_seen ELSE (NOW() AT TIME ZONE 'UTC') END
      WHERE LOWER(email) = LOWER($1) OR LOWER(name) = LOWER($1)
    `,
    [String(identifier), Boolean(isOnline)]
  );
};