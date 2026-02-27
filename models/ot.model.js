import pool from "../db.js";

export const getOTRoomsModel = async () => {
  const result = await pool.query(
    "SELECT * FROM ot_rooms order by room_name"
  );
  return result.rows;
};

export async function getOTEntryById(entry_id) {
  const sql = `
    SELECT * FROM ot_entries
    WHERE entry_id = $1
    LIMIT 1
  `;

  const { rows } = await pool.query(sql, [entry_id]);

  return rows[0] || null;
}

export const getOTEntriesModel = async () => {
  const result = await pool.query(
    "SELECT * from ot_entries order by entry_id"
  )
  return result.rows;
}

export async function insertOTEntry(data) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const now = new Date();
    const admissionDate = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const admissionTime = now.toTimeString().slice(0, 8); // HH:MM:SS

    const insertQuery = `
      INSERT INTO ot_entries
      (
        room_id,
        patient_name,
        uhid,
        age,
        gender,
        diagnosis,
        surgeon,
        active_status,
        is_waiting,
        admission_date,
        admission_time,
        is_under_preparation,
        is_in_preop
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `;

    const insertValues = [
      data.room_id,
      data.PatientName,
      data.UHID,
      data.Age,
      data.Gender,
      data.Diagnosis,
      data.Surgeon,
      true,   // active_status
      true,   // is_waiting
      admissionDate,
      admissionTime,
      false,
      false
    ];

    await client.query(insertQuery, insertValues);

    const updateRoomQuery = `
      UPDATE ot_rooms
      SET occupancy_status = true
      WHERE room_id = $1
    `;

    await client.query(updateRoomQuery, [data.room_id]);

    await client.query("COMMIT");

    return { success: true };

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export const getLatestOTEntryByRoomIdModel = async (roomId) => {
  const query = `
    SELECT *
    FROM ot_entries
    WHERE room_id = $1
    ORDER BY entry_id DESC
    LIMIT 1
  `;

  const result = await pool.query(query, [roomId]);

  return result.rows.length ? result.rows[0] : null;
};


export async function updateOTEntryModel(data) {

  const sql = `
    UPDATE ot_entries SET
      patient_name = $1,
      uhid = $2,
      age = $3,
      gender = $4,
      diagnosis = $5,
      surgeon = $6,
      is_waiting = $7,
      is_in_preop = $8,
      is_under_preparation = $9,
      is_in_ot = $10,
      is_surgery_started = $11,
      is_surgery_completed = $12,
      is_shifted_recovery = $13
    WHERE entry_id = $14
  `;

  const values = [
    data.patient_name,
    data.uhid,
    data.age,
    data.gender,
    data.diagnosis,
    data.surgeon,
    data.is_waiting ?? 0,
    data.is_in_preop ?? 0,
    data.is_under_preparation ?? 0,
    data.is_in_ot ?? 0,
    data.is_surgery_started ?? 0,
    data.is_surgery_completed ?? 0,
    data.is_shifted_recovery ?? 0,
    data.entry_id
  ];

  const result = await pool.query(sql, values);
  return result;
}

export async function cancelOTEntryModel(entry_id) {

  const sql = `
    UPDATE ot_entries
    SET is_cancelled = True
    WHERE entry_id = $1
  `;

  const result = await pool.query(sql, [entry_id]);
  return result;
}

export async function revertcancelOTEntryModel(entry_id) {

  const sql = `
    UPDATE ot_entries
    SET is_cancelled = False
    WHERE entry_id = $1
  `;

  const result = await pool.query(sql, [entry_id]);
  return result;
}

export async function dischargeOTEntryModel(entry_id, room_id) {

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Current timestamp in DB (server time)
    const result1 = await client.query(
      `
      UPDATE ot_entries
      SET discharge_date = CURRENT_DATE,
          discharge_time = NOW()::time
      WHERE entry_id = $1
      `,
      [entry_id]
    );

    // Free the room
    const result2 = await client.query(
      `
      UPDATE ot_rooms
      SET occupancy_status = FALSE
      WHERE room_id = $1
      `,
      [room_id]
    );

    await client.query("COMMIT");

    return { entryUpdated: result1.rowCount, roomUpdated: result2.rowCount };

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
