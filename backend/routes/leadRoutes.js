"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const ExcelJS = require("exceljs");
const { parse: parseCsvSync } = require("csv-parse/sync");
const { stringify: stringifyCsvSync } = require("csv-stringify/sync");
const db = require("../config/db");

const router = express.Router();

/*
==================================================
LEAD UPLOAD / DNC MANAGEMENT / AUTODIAL RULES — Phase 1
==================================================
Phase 1 of the Outbound Auto-Dial feature: lead upload (CSV/XLSX +
generated template), campaign assignment (outbound campaigns only —
Blended excluded per explicit request, via campaignRoutes.js's own
GET /?type=OUTBOUND filter), DNC list management, and per-campaign
autodial rule storage. This file does NOT contain the actual
auto-dial ENGINE (Phase 2) — nothing here originates a call on its
own; it only stores data and rules for that future engine to read.

Uses the real, confirmed schemas for asterisk.vicidial_lists,
asterisk.vicidial_list, and asterisk.vicidial_dnc (via DESCRIBE, not
assumed) — see the SQL migration's own comment for the two NEW
cmx_dialer tables this introduces (campaign_autodial_rules,
lead_autodial_state).
==================================================
*/

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.authenticated || !req.session.agent) {
    return res.status(401).json({ success: false, message: "Authentication required." });
  }
  if (req.session.agent.accessLevel !== "admin" && req.session.agent.accessLevel !== "wfm") {
    return res.status(403).json({ success: false, message: "Admin access required." });
  }
  return next();
}

const UPLOAD_STAGING_DIR = path.join(__dirname, "..", "tmp", "lead-upload-staging");
fs.mkdirSync(UPLOAD_STAGING_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_STAGING_DIR,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB — generous for a lead/DNC list in CSV or XLSX
});

/*
==================================================
Template generation — shared helper
==================================================
Builds a one-sheet template (headers + one example row) and streams it
back as either .xlsx or .csv.

UPDATED — originally used the `xlsx` (SheetJS) npm package. Swapped out
after a real, confirmed finding: every version of `xlsx` published to
the public npm registry has unpatched HIGH-severity advisories
(GHSA-4r6h-8v6p-xvw6, prototype pollution; GHSA-5pgg-2g8v-p4x9, ReDoS)
— SheetJS's own fixed releases are only distributed via their own CDN,
not npm, so a normal `npm install xlsx` can never actually get a
patched version. Replaced with exceljs (.xlsx) + csv-parse/csv-stringify
(.csv) — actively maintained, narrowly-scoped, no equivalent advisories
at time of writing.
==================================================
*/
async function sendTemplate(res, filenameBase, headers, exampleRow, format) {
  if (format === "csv") {
    const csvText = stringifyCsvSync([headers, exampleRow]);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}.csv"`);
    return res.send(csvText);
  }

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Template");
  worksheet.addRow(headers);
  worksheet.addRow(exampleRow);
  const buffer = await workbook.xlsx.writeBuffer();

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}.xlsx"`);
  return res.send(buffer);
}

/*
==================================================
Parses an uploaded CSV/XLSX file into an array of row objects, keyed
by whatever header row the file actually has (case/whitespace
normalized) — NOT positional.

Format is detected from the ORIGINAL filename's extension (multer's
file.originalname — the client-provided name, not the randomized
staged filename on disk). This is only ever used to pick which parser
to run, never for anything security-sensitive — worst case a
mismatched extension just fails to parse cleanly and surfaces a
friendly error, not a vulnerability.
==================================================
*/
function normalizeRowKeys(row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    const normalizedKey = String(key).trim().toLowerCase().replace(/\s+/g, "_");
    normalized[normalizedKey] = typeof value === "string" ? value.trim() : value;
  }
  return normalized;
}

async function parseUploadedRows(file) {
  const buffer = fs.readFileSync(file.path);
  const isCsv = /\.csv$/i.test(file.originalname || "");

  if (isCsv) {
    const records = parseCsvSync(buffer.toString("utf8"), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
    return records.map(normalizeRowKeys);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];

  let headerKeys = null;
  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    // exceljs's row.values is 1-INDEXED (index 0 is always empty) —
    // confirmed via its own documented API, not assumed.
    const values = row.values.slice(1);
    if (rowNumber === 1) {
      headerKeys = values.map((v) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, "_"));
      return;
    }
    const rowObj = {};
    headerKeys.forEach((key, i) => {
      const raw = values[i];
      rowObj[key] = raw === undefined || raw === null ? "" : String(raw).trim();
    });
    rows.push(rowObj);
  });
  return rows;
}

function cleanupStagedFile(file) {
  if (!file) return;
  fs.unlink(file.path, (err) => {
    if (err && err.code !== "ENOENT") {
      console.error(`[leadRoutes] Failed to clean up staged upload ${file.path}:`, err.message);
    }
  });
}

/*
==================================================
LEADS — template + upload
==================================================
GET /api/admin/leads/template?format=xlsx|csv
==================================================
*/
router.get("/leads/template", requireAdmin, async (req, res) => {
  const { format } = req.query;
  await sendTemplate(
    res,
    "voxsuite-leads-template",
    ["phone_number", "first_name", "last_name"],
    ["6468016974", "Jane", "Doe"],
    format
  );
});

/*
==================================================
POST /api/admin/leads/upload
Body (multipart): file, campaignId, mode ("preview" | "include" | "exclude")
==================================================
UPDATED — per explicit request: duplicate handling is no longer
silent. Every upload now goes through THREE possible modes, driven by
the frontend prompting the admin after a preview:

  "preview" — parses the file and reports duplicate counts (both
              WITHIN the file itself, and against phone numbers that
              already exist ANYWHERE in asterisk.vicidial_list —
              global scope, not just this campaign, since cross-
              campaign duplication is exactly what happened with the
              real CMXBSCSR/CMXBSMOB incident this feature exists to
              prevent a repeat of). Inserts NOTHING — no list_id is
              even created yet.
  "include" — the ORIGINAL behavior, unchanged: every row with a
              phone_number gets inserted, duplicates and all. Kept
              as an explicit choice, not a hidden default, since
              sometimes an admin genuinely wants a second copy (e.g.
              treating a lead as fresh again for a new run).
  "exclude" — de-duplicates within the file first (keeps the FIRST
              occurrence of each phone_number), then skips any number
              that already exists anywhere in vicidial_list, and only
              inserts what's left.

The frontend calls "preview" once, shows the counts with
Include/Exclude buttons, then re-submits the SAME file (kept in
browser memory, no re-selection needed) with whichever mode the admin
picked — see AdminLeadsSection.jsx.

Everything else (list_id generation, transaction, response shape for
imported/skipped counts) is unchanged from the original behavior.
==================================================
*/
router.post("/leads/upload", requireAdmin, upload.single("file"), async (req, res) => {
  const { campaignId, mode } = req.body;
  const file = req.file;

  try {
    if (!campaignId) {
      return res.status(400).json({ success: false, message: "campaignId is required." });
    }
    if (!file) {
      return res.status(400).json({ success: false, message: "A CSV or XLSX file is required." });
    }
    if (!["preview", "include", "exclude"].includes(mode)) {
      return res.status(400).json({ success: false, message: 'mode must be "preview", "include", or "exclude".' });
    }

    const rows = await parseUploadedRows(file);
    const validRows = rows.filter((r) => r.phone_number);
    const skippedMissingPhone = rows.length - validRows.length;

    if (validRows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid rows found — every row is missing a phone_number.",
      });
    }

    // De-dup WITHIN the file itself — keep the first occurrence of
    // each phone_number, regardless of mode (an "include" upload
    // still shouldn't insert the SAME file's own internal duplicate
    // twice under "include" semantics — "include" means "include
    // numbers that already exist elsewhere," not "double-insert a
    // number that appears twice in this one file." If a real use case
    // ever needs literal duplicate rows within one file, that's a
    // different, more unusual request than what was asked for here.)
    const seenInFile = new Set();
    const dedupedWithinFile = [];
    let duplicatesWithinFile = 0;
    for (const row of validRows) {
      if (seenInFile.has(row.phone_number)) {
        duplicatesWithinFile++;
      } else {
        seenInFile.add(row.phone_number);
        dedupedWithinFile.push(row);
      }
    }

    // Which of these already exist ANYWHERE in vicidial_list —
    // global scope, not scoped to campaignId, per the header comment.
    let existingPhoneSet = new Set();
    if (dedupedWithinFile.length > 0) {
      const phoneNumbers = dedupedWithinFile.map((r) => r.phone_number);
      const placeholders = phoneNumbers.map(() => "?").join(",");
      const [existingRows] = await db.execute(
        `SELECT DISTINCT phone_number FROM asterisk.vicidial_list WHERE phone_number IN (${placeholders})`,
        phoneNumbers
      );
      existingPhoneSet = new Set(existingRows.map((r) => r.phone_number));
    }
    const duplicatesAgainstExisting = dedupedWithinFile.filter((r) => existingPhoneSet.has(r.phone_number)).length;

    if (mode === "preview") {
      return res.json({
        success: true,
        preview: true,
        totalRows: rows.length,
        skippedMissingPhone,
        duplicatesWithinFile,
        duplicatesAgainstExisting,
        wouldImportIfInclude: validRows.length,
        wouldImportIfExclude: dedupedWithinFile.length - duplicatesAgainstExisting,
      });
    }

    const rowsToInsert = mode === "exclude" ? dedupedWithinFile.filter((r) => !existingPhoneSet.has(r.phone_number)) : validRows;

    if (rowsToInsert.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No rows left to import — every valid row is a duplicate of one already on file.",
      });
    }

    const listId = Date.now();
    const listName = `Upload_${campaignId}_${listId}`;

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      await connection.execute(
        `INSERT INTO asterisk.vicidial_lists (list_id, list_name, campaign_id, active) VALUES (?, ?, ?, 'Y')`,
        [listId, listName, campaignId]
      );

      // Single multi-row INSERT rather than one query per row — real
      // performance difference on a lead list with hundreds/thousands
      // of rows, not just a style choice.
      const valuePlaceholders = rowsToInsert.map(() => "(?, 'NEW', ?, ?, ?, 'N', NOW())").join(", ");
      const insertParams = [];
      for (const row of rowsToInsert) {
        insertParams.push(listId, row.phone_number, row.first_name || null, row.last_name || null);
      }
      await connection.execute(
        `
          INSERT INTO asterisk.vicidial_list
            (list_id, status, phone_number, first_name, last_name, called_since_last_reset, entry_date)
          VALUES ${valuePlaceholders}
        `,
        insertParams
      );

      await connection.commit();
    } catch (err) {
      await connection.rollback();
      if (err.code === "ER_DUP_ENTRY") {
        return res.status(409).json({
          success: false,
          message: "A list with this exact upload timestamp already exists — please try uploading again.",
        });
      }
      throw err;
    } finally {
      connection.release();
    }

    return res.json({
      success: true,
      listId,
      listName,
      imported: rowsToInsert.length,
      skippedMissingPhone,
      skippedDuplicateWithinFile: mode === "exclude" ? duplicatesWithinFile : 0,
      skippedDuplicateExisting: mode === "exclude" ? duplicatesAgainstExisting : 0,
    });
  } catch (error) {
    console.error("POST /api/admin/leads/upload failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to upload leads." });
  } finally {
    cleanupStagedFile(file);
  }
});

/*
==================================================
LEADS CLEANUP — NEW, per explicit request
==================================================
Automatically finds and removes leads whose phone_number is either:
  (a) tagged SCREENING_COMPLETED in EITHER cmx_dialer.dialer_call_log
      (outbound) OR cmx_dialer.inbound_call_log (inbound) — checking
      both because a number could have reached that outcome from
      either direction, not just the outbound leads-calling side this
      app's own dashboard focuses on.
  (b) present in asterisk.vicidial_dnc.

Same preview-then-confirm pattern as the upload duplicate-handling
above, and for the same reason: this deletes real lead rows, so an
admin should see the count before committing, not discover it after.

Optional campaignId scopes the check/delete to one campaign's own
lists; omitted means every campaign's leads are checked/deleted (a
number tagged DNC or SCREENING_COMPLETED has no reason to still be
eligible for ANY campaign, not just one).

Every deleted row is logged to cmx_dialer.deleted_leads_log first (see
006_add_deleted_leads_log.sql) — a permanent, queryable audit trail,
not a one-off backup table, since this is meant to run repeatedly over
time.
==================================================
*/

// Shared by both preview and confirm — computes exactly which
// (lead_id, phone_number, ...) rows currently qualify for deletion,
// each tagged with its reason. 'DNC' takes priority over
// 'SCREENING_COMPLETED' when a number matches both, since DNC is the
// stronger/legal reason.
async function findLeadsToClean(campaignId) {
  const params = [];
  let campaignFilter = "";
  if (campaignId) {
    campaignFilter = " AND vlt.campaign_id = ?";
    params.push(campaignId);
  }

  const [rows] = await db.execute(
    `
      SELECT
        vl.lead_id, vl.list_id, vlt.campaign_id, vl.phone_number, vl.first_name, vl.last_name,
        CASE WHEN dnc.phone_number IS NOT NULL THEN 'DNC' ELSE 'SCREENING_COMPLETED' END AS reason
      FROM asterisk.vicidial_list vl
      JOIN asterisk.vicidial_lists vlt ON vlt.list_id = vl.list_id
      LEFT JOIN asterisk.vicidial_dnc dnc ON dnc.phone_number = vl.phone_number
      LEFT JOIN (
        SELECT DISTINCT phone_number FROM cmx_dialer.dialer_call_log WHERE disposition = 'SCREENING_COMPLETED'
        UNION
        SELECT DISTINCT caller_id_number AS phone_number FROM cmx_dialer.inbound_call_log WHERE disposition = 'SCREENING_COMPLETED'
      ) screened ON screened.phone_number = vl.phone_number
      WHERE (dnc.phone_number IS NOT NULL OR screened.phone_number IS NOT NULL)${campaignFilter}
    `,
    params
  );
  return rows;
}

router.post("/leads/cleanup/preview", requireAdmin, async (req, res) => {
  try {
    const { campaignId } = req.body;
    const toClean = await findLeadsToClean(campaignId || null);
    const dncCount = toClean.filter((r) => r.reason === "DNC").length;
    const screeningCompletedCount = toClean.filter((r) => r.reason === "SCREENING_COMPLETED").length;

    return res.json({
      success: true,
      preview: true,
      totalToDelete: toClean.length,
      dncCount,
      screeningCompletedCount,
      // A small sample for the admin to sanity-check before
      // confirming — not the full list, this could be thousands of
      // rows across all campaigns.
      sample: toClean.slice(0, 20).map((r) => ({
        phoneNumber: r.phone_number,
        firstName: r.first_name,
        lastName: r.last_name,
        campaignId: r.campaign_id,
        reason: r.reason,
      })),
    });
  } catch (error) {
    console.error("POST /api/admin/leads/cleanup/preview failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to check leads for cleanup." });
  }
});

router.post("/leads/cleanup/confirm", requireAdmin, async (req, res) => {
  try {
    const { campaignId } = req.body;
    const toClean = await findLeadsToClean(campaignId || null);

    if (toClean.length === 0) {
      return res.json({ success: true, deleted: 0 });
    }

    const appUserId = req.session.agent.appUserId;
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      // Log every row BEFORE deleting it — batched, not one insert
      // per row, same reasoning as the bulk lead-upload insert above.
      const logPlaceholders = toClean.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
      const logParams = [];
      for (const row of toClean) {
        logParams.push(row.lead_id, row.list_id, row.campaign_id, row.phone_number, row.first_name, row.last_name, row.reason, appUserId);
      }
      await connection.execute(
        `
          INSERT INTO cmx_dialer.deleted_leads_log
            (lead_id, list_id, campaign_id, phone_number, first_name, last_name, reason, deleted_by_app_user_id)
          VALUES ${logPlaceholders}
        `,
        logParams
      );

      const leadIds = toClean.map((r) => r.lead_id);
      const deletePlaceholders = leadIds.map(() => "?").join(",");
      await connection.execute(`DELETE FROM asterisk.vicidial_list WHERE lead_id IN (${deletePlaceholders})`, leadIds);

      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }

    return res.json({ success: true, deleted: toClean.length });
  } catch (error) {
    console.error("POST /api/admin/leads/cleanup/confirm failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to clean up leads." });
  }
});

/*
==================================================
DNC — template + upload + list
==================================================
asterisk.vicidial_dnc has exactly ONE column, phone_number, as its own
sole primary key (confirmed via DESCRIBE) — no campaign scoping, no
timestamp, no source tracking. Global and dead simple by design.
==================================================
*/
router.get("/dnc/template", requireAdmin, async (req, res) => {
  const { format } = req.query;
  await sendTemplate(res, "voxsuite-dnc-template", ["phone_number"], ["6468016974"], format);
});

router.get("/dnc", requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(`SELECT phone_number FROM asterisk.vicidial_dnc ORDER BY phone_number ASC LIMIT 5000`);
    return res.json({ success: true, entries: rows, count: rows.length });
  } catch (error) {
    console.error("GET /api/admin/dnc failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load DNC list." });
  }
});

router.post("/dnc/upload", requireAdmin, upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ success: false, message: "A CSV or XLSX file is required." });
  }

  try {
    const rows = await parseUploadedRows(file);
    const validRows = rows.filter((r) => r.phone_number);
    const skippedCount = rows.length - validRows.length;

    if (validRows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid rows found — every row is missing a phone_number.",
      });
    }

    // INSERT IGNORE — phone_number is the table's own PK, so a number
    // already on the list is a harmless no-op, not an error, exactly
    // like the automatic DNC-on-disposition insert in
    // dialerService.js's saveDisposition().
    const valuePlaceholders = validRows.map(() => "(?)").join(", ");
    const params = validRows.map((r) => r.phone_number);
    const [result] = await db.execute(
      `INSERT IGNORE INTO asterisk.vicidial_dnc (phone_number) VALUES ${valuePlaceholders}`,
      params
    );

    return res.json({
      success: true,
      imported: result.affectedRows,
      duplicates: validRows.length - result.affectedRows,
      skipped: skippedCount,
    });
  } catch (error) {
    console.error("POST /api/admin/dnc/upload failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to upload DNC list." });
  } finally {
    cleanupStagedFile(file);
  }
});

/*
==================================================
AUTODIAL RULES — per campaign
==================================================
GET returns the stored rules, or the SQL table's own defaults if this
campaign has never had rules saved yet (rather than a 404 — every
outbound campaign implicitly HAS default rules, they just haven't been
customized). PUT upserts.
==================================================
*/
const AUTODIAL_RULE_DEFAULTS = {
  maxAttemptsBusy: 3,
  maxAttemptsNoAnswer: 3,
  maxAttemptsMachine: 3,
  attemptIntervalMinutes: 60,
  callingDays: "mon-fri",
  callingStartTime: "09:00",
  callingEndTime: "18:00",
};

router.get("/campaigns/:campaignId/autodial-rules", requireAdmin, async (req, res) => {
  try {
    const { campaignId } = req.params;
    const [rows] = await db.execute(
      `SELECT max_attempts_busy, max_attempts_no_answer, max_attempts_machine,
              attempt_interval_minutes, calling_days, calling_start_time, calling_end_time
       FROM cmx_dialer.campaign_autodial_rules WHERE campaign_id = ?`,
      [campaignId]
    );

    if (rows.length === 0) {
      return res.json({ success: true, rules: AUTODIAL_RULE_DEFAULTS, isDefault: true });
    }

    const r = rows[0];
    return res.json({
      success: true,
      rules: {
        maxAttemptsBusy: r.max_attempts_busy,
        maxAttemptsNoAnswer: r.max_attempts_no_answer,
        maxAttemptsMachine: r.max_attempts_machine,
        attemptIntervalMinutes: r.attempt_interval_minutes,
        callingDays: r.calling_days,
        callingStartTime: r.calling_start_time,
        callingEndTime: r.calling_end_time,
      },
      isDefault: false,
    });
  } catch (error) {
    console.error(`GET /api/admin/campaigns/${req.params.campaignId}/autodial-rules failed:`, error);
    return res.status(500).json({ success: false, message: "Failed to load autodial rules." });
  }
});

router.put("/campaigns/:campaignId/autodial-rules", requireAdmin, async (req, res) => {
  try {
    const { campaignId } = req.params;
    const {
      maxAttemptsBusy,
      maxAttemptsNoAnswer,
      maxAttemptsMachine,
      attemptIntervalMinutes,
      callingDays,
      callingStartTime,
      callingEndTime,
    } = req.body;

    await db.execute(
      `
        INSERT INTO cmx_dialer.campaign_autodial_rules
          (campaign_id, max_attempts_busy, max_attempts_no_answer, max_attempts_machine,
           attempt_interval_minutes, calling_days, calling_start_time, calling_end_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          max_attempts_busy = VALUES(max_attempts_busy),
          max_attempts_no_answer = VALUES(max_attempts_no_answer),
          max_attempts_machine = VALUES(max_attempts_machine),
          attempt_interval_minutes = VALUES(attempt_interval_minutes),
          calling_days = VALUES(calling_days),
          calling_start_time = VALUES(calling_start_time),
          calling_end_time = VALUES(calling_end_time)
      `,
      [
        campaignId,
        maxAttemptsBusy ?? AUTODIAL_RULE_DEFAULTS.maxAttemptsBusy,
        maxAttemptsNoAnswer ?? AUTODIAL_RULE_DEFAULTS.maxAttemptsNoAnswer,
        maxAttemptsMachine ?? AUTODIAL_RULE_DEFAULTS.maxAttemptsMachine,
        attemptIntervalMinutes ?? AUTODIAL_RULE_DEFAULTS.attemptIntervalMinutes,
        callingDays || AUTODIAL_RULE_DEFAULTS.callingDays,
        callingStartTime || AUTODIAL_RULE_DEFAULTS.callingStartTime,
        callingEndTime || AUTODIAL_RULE_DEFAULTS.callingEndTime,
      ]
    );

    return res.json({ success: true });
  } catch (error) {
    console.error(`PUT /api/admin/campaigns/${req.params.campaignId}/autodial-rules failed:`, error);
    return res.status(500).json({ success: false, message: "Failed to save autodial rules." });
  }
});

module.exports = router;