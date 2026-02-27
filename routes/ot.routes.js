import express from "express";
import { cancelOTEntryController, createOTEntry, dischargeOTEntryController, getLatestOTEntryController, getOTEntriesController, getOTRoomsController, revertcancelOTEntryController, updateOTController } from "../controllers/ot.controller.js";

const router = express.Router();

router.get("/ot-rooms", getOTRoomsController);
router.post("/ot-entry", createOTEntry);
router.get("/ot-entries", getOTEntriesController);
router.get("/ot-entries/:room_id", getLatestOTEntryController);
router.post("/ot-update", updateOTController);
router.post("/cancel", cancelOTEntryController);
router.post("/revert-cancel", revertcancelOTEntryController);
router.post("/discharge", dischargeOTEntryController);

export default router;
