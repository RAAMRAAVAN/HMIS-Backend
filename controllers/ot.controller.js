import { cancelOTEntryModel, dischargeOTEntryModel, getLatestOTEntryByRoomIdModel, getOTEntriesModel, getOTRoomsModel, revertcancelOTEntryModel, updateOTEntryModel } from "../models/ot.model.js";
import { insertOTEntry } from "../models/ot.model.js";
import { getIO } from "../socket.js";

export const getOTRoomsController = async (req, res) => {
  try {
    const users = await getOTRoomsModel();
    res.json({ success: true, data: users });
  } catch (error) {
    console.error("Get OT Rooms error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

export const getOTEntriesController = async (req, res) => {
  try {
    const entries = await getOTEntriesModel();
    res.json({ success: true, data: entries });
  } catch (error) {
    console.error("Get OT Entries error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};



export async function createOTEntry(req, res) {
  try {

    console.log("🔔 createOTEntry CALLED");
    console.log("📨 Request body:", req.body);

    const io = getIO();

    if (!io) {
      console.error("❌ getIO() returned NULL / UNDEFINED");
    } else {
      console.log("🟢 Socket instance OK");
    }

    const data = await insertOTEntry(req.body);

    console.log("📦 DB Insert result:", data);

    const payload = {
      room_id: req.body.room_id,
      type: "NEW_ADMISSION",
      data,   // ⬅ match frontend naming
    };

    console.log("📤 Emitting socket event:", payload);

    io?.emit("ot_update", payload);

    console.log("✅ Event emitted successfully");

    res.json({
      success: true,
      message: "Inserted & room updated successfully"
    });

  } catch (err) {

    console.error("💥 OT Insert Error:", err);

    res.status(500).json({
      success: false,
      error: err.message
    });
  }
}


export const getLatestOTEntryController = async (req, res) => {
  try {
    const { room_id } = req.params;

    if (!room_id) {
      return res.status(400).json({
        success: false,
        message: "room_id is required",
      });
    }

    const data = await getLatestOTEntryByRoomIdModel(room_id);

    return res.json({
      success: true,
      data,
    });

  } catch (error) {
    console.error("Get OT Entry Error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

export async function updateOTController(req, res) {
  try {
    const body = req.body;
    const io = getIO();
    if (!io) {
      console.error("❌ getIO() returned NULL / UNDEFINED");
    } else {
      console.log("🟢 Socket instance OK");
    }
    const {
      entry_id,
      room_id
    } = body;

    if (!entry_id || !room_id) {
      return res.status(400).json({
        success: false,
        error: "entry_id and room_id are required"
      });
    }

    const result = await updateOTEntryModel(body);

    const payload = {
      room_id: req.body.room_id,
      type: "NEW_ADMISSION",
      data: result,   // ⬅ match frontend naming
    };

    console.log("📤 Emitting socket event:", payload);

    io?.emit("ot_update", payload);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: "No record found for this entry_id"
      });
    }

    // notify SSE
    // notifyOTUpdate(body);

    return res.json({
      success: true,
      message: "OT entry updated successfully"
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
}

export async function cancelOTEntryController(req, res) {
  try {
    const { entry_id } = req.body;
    const io = getIO();
    if (!entry_id) {
      return res.status(400).json({
        success: false,
        error: "entry_id is required",
      });
    }

    const result = await cancelOTEntryModel(entry_id);

    const payload = {
      room_id: req.body.room_id,
      type: "NEW_ADMISSION",
      data: result,   // ⬅ match frontend naming
    };

    console.log("📤 Emitting socket event:", payload);

    io?.emit("ot_update", payload);

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: "No record found for this entry_id",
      });
    }

    // 🔥 Notify SSE listeners
    // notifyOTUpdate({ action: "cancel" });

    res.json({
      success: true,
      message: "OT entry cancelled successfully",
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}

export async function revertcancelOTEntryController(req, res) {
  try {
    const { entry_id } = req.body;
    const io = getIO();
    if (!entry_id) {
      return res.status(400).json({
        success: false,
        error: "entry_id is required",
      });
    }

    const result = await revertcancelOTEntryModel(entry_id);
    const payload = {
      room_id: req.body.room_id,
      type: "NEW_ADMISSION",
      data: result,   // ⬅ match frontend naming
    };

    console.log("📤 Emitting socket event:", payload);

    io?.emit("ot_update", payload);

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: "No record found for this entry_id",
      });
    }

    // 🔥 Notify SSE listeners
    // notifyOTUpdate({ action: "cancel" });

    res.json({
      success: true,
      message: "OT entry cancellation reverted successfully",
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}

export async function dischargeOTEntryController(req, res) {
  try {
    const { entry_id, room_id } = req.body;
    const io = getIO();
    if (!entry_id || !room_id) {
      return res.status(400).json({
        success: false,
        error: "entry_id and room_id are required",
      });
    }

    const result = await dischargeOTEntryModel(entry_id, room_id);

    const payload = {
      room_id: req.body.room_id,
      type: "NEW_ADMISSION",
      data: result,   // ⬅ match frontend naming
    };

    console.log("📤 Emitting socket event:", payload);

    io?.emit("ot_update", payload);

    if (result.entryUpdated === 0) {
      return res.status(404).json({
        success: false,
        error: "No OT entry found",
      });
    }

    // 🔥 Notify UI dashboards
    // notifyOTUpdate({
    //   action: "discharge",
    //   entry_id,
    // });

    res.json({
      success: true,
      message: "Patient discharged and room freed",
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}
