"use strict";

const crypto = require("crypto");
const fs = require("fs");
const express = require("express");
const db = require("../config/db");
const dialerService = require("../services/dialerService");
const inboundCallService = require("../services/inboundCallService");
const statsService = require("../services/statsService");
const agentStatusService = require("../services/agentStatusService");
const ws = require("../config/ws");
const ami = require("../config/ami");
const { transporter } = require("../config/mailer");
const { buildWelcomeEmail } = require("../services/emailTemplates");
const { requireRoles, requireCampaignAccess, resolveCampaignScope, resolveCampaignScopeMulti, getAssignedCampaignIds, UNRESTRICTED_CAMPAIGN_ROLES } = require("../services/accessControlService");
const monitoringService = require("../services/monitoringService");

const router = express.Router();

// UPDATED — WFM now also gets full Admin page access, per the
// access-level matrix (Users/Phone Login/Campaigns/Trunk Setup CRUD
// all stay behind this same check; WFM and Admin are the only two
// roles with unrestricted, all-campaign access to any of it).
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.authenticated || !req.session.agent) {
    return res.status(401).json({ success: false, message: "Authentication required." });
  }
  if (req.session.agent.accessLevel !== "admin" && req.session.agent.accessLevel !== "wfm") {
    return res.status(403).json({ success: false, message: "Admin access required." });
  }
  return next();
}

/*
==================================================
AVAILABLE VICIDIAL USERS
==================================================
GET /api/admin/vicidial-users/available
Unclaimed (no matching cmx_dialer.app_users row yet), active ViciDial
users — the same query we ran by hand in Workbench, now a real
endpoint.
==================================================
*/
router.get("/vicidial-users/available", requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `
        SELECT vu.user AS vicidial_user, vu.full_name, vu.phone_login
        FROM asterisk.vicidial_users vu
        LEFT JOIN cmx_dialer.app_users au ON au.vicidial_user = vu.user
        WHERE au.app_user_id IS NULL
          AND vu.active = 'Y'
        ORDER BY vu.user
      `
    );
    return res.json({ success: true, vicidialUsers: rows });
  } catch (error) {
    console.error("GET /api/admin/vicidial-users/available failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load available ViciDial users." });
  }
});

/*
==================================================
EXISTING APP USERS
==================================================
GET /api/admin/users
Lists every cmx_dialer.app_users row with their bound ViciDial
user/phone and assigned campaigns, for visibility before creating a
new one (and to avoid double-registering someone).
==================================================
*/
router.get("/users", requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `
        SELECT
          au.app_user_id,
          au.email,
          au.full_name,
          au.access_level,
          au.vicidial_user,
          au.active,
          au.priority,
          au.multi_campaign_enabled,
          vu.phone_login,
          GROUP_CONCAT(aca.campaign_id ORDER BY aca.campaign_id SEPARATOR ', ') AS campaigns
        FROM cmx_dialer.app_users au
        LEFT JOIN asterisk.vicidial_users vu ON vu.user = au.vicidial_user
        LEFT JOIN cmx_dialer.agent_campaign_assignments aca
          ON aca.app_user_id = au.app_user_id AND aca.active = 1
        GROUP BY au.app_user_id
        ORDER BY au.app_user_id DESC
      `
    );
    return res.json({ success: true, users: rows });
  } catch (error) {
    console.error("GET /api/admin/users failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load users." });
  }
});

/*
==================================================
CREATE USER
==================================================
POST /api/admin/users
Body: { email, fullName, accessLevel, vicidialUser, campaignIds: [] }

Creates the app_users row AND its campaign assignments in one
transaction — either both succeed or neither does, so a user is never
left half-bound to a ViciDial login with no campaign access (or vice
versa).

NOTE: requires vicidialUser to already exist (picked from the
"available" list above). For creating a BRAND NEW ViciDial user at the
same time, see POST /users/full below instead — kept as a genuinely
separate endpoint rather than modifying this one, since this flow
(binding to an EXISTING vicidial_users row) is still valid and
shouldn't be disturbed.
==================================================
*/
router.post("/users", requireAdmin, async (req, res) => {
  const { email, fullName, accessLevel, vicidialUser, campaignIds, active, priority, multiCampaignEnabled } = req.body;

  if (!email || !fullName || !accessLevel) {
    return res.status(400).json({ success: false, message: "email, fullName, and accessLevel are required." });
  }

  if (!["agent", "supervisor", "training_quality", "account_manager", "wfm", "admin"].includes(accessLevel)) {
    return res.status(400).json({ success: false, message: "accessLevel must be agent, supervisor, or admin." });
  }

  // Priority: 1 (default), 2, 3, or 4 — see agentStatusService.js's
  // getAnyReadyAgentWithExtension for what these actually do to
  // inbound queue matching. Defaults to 1 (strict FIFO) if omitted.
  // 4 is a hard opt-out — that agent never receives inbound calls.
  const resolvedPriority = priority ? Number(priority) : 1;
  if (![1, 2, 3, 4].includes(resolvedPriority)) {
    return res.status(400).json({ success: false, message: "priority must be 1, 2, 3, or 4." });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [result] = await connection.execute(
      `INSERT INTO cmx_dialer.app_users (email, full_name, access_level, vicidial_user, active, priority, multi_campaign_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [email, fullName, accessLevel, vicidialUser || null, active === false ? 0 : 1, resolvedPriority, multiCampaignEnabled ? 1 : 0]
    );

    const appUserId = result.insertId;

    if (Array.isArray(campaignIds) && campaignIds.length > 0) {
      for (const campaignId of campaignIds) {
        await connection.execute(
          `INSERT INTO cmx_dialer.agent_campaign_assignments (app_user_id, campaign_id) VALUES (?, ?)`,
          [appUserId, campaignId]
        );
      }
    }

    await connection.commit();

    // Sent AFTER commit, deliberately outside the transaction and not
    // awaited into the response's success/failure — a bounced or
    // slow-to-send welcome email should never make account creation
    // itself look like it failed. Logged, not surfaced to the admin
    // who just clicked "Create".
    transporter
      .sendMail({
        from: process.env.SMTP_FROM,
        to: email,
        ...buildWelcomeEmail({ fullName, email, accessLevel }),
      })
      .catch((err) => {
        console.error(`[adminRoutes] Failed to send welcome email to ${email}:`, err.message);
      });

    return res.json({ success: true, appUserId });
  } catch (error) {
    await connection.rollback();
    console.error("POST /api/admin/users failed:", error);

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "That email is already registered." });
    }

    return res.status(500).json({ success: false, message: "Failed to create user." });
  } finally {
    connection.release();
  }
});

/*
==================================================
CREATE USER — combined ViciDial + app_users creation
==================================================
POST /api/admin/users/full
Body: {
  email, fullName, accessLevel, campaignIds, active,       // app_users side
  vicidialUsername, phoneLogin, phonePass, userLevel, userGroup  // vicidial_users side
}

First real step of moving ViciDial's own admin.php user-creation into
this app. Writes BOTH the new asterisk.vicidial_users row AND the
cmx_dialer.app_users row in ONE transaction — either both succeed or
neither does, same principle as the existing POST /users above, just
now covering a brand new ViciDial account too instead of requiring one
to already exist.

vicidial_users.pass/pass_hash are set to a random, unusable throwaway
value — DELIBERATE, not a placeholder to fix later. admin.php's own
web login is the thing this whole project is working toward retiring;
nobody creating a user through THIS endpoint is expected to ever log
into admin.php with it. If that assumption changes, this needs real,
correctly-hashed values instead — flagging that explicitly rather than
silently leaving it half-right.

Only a practical subset of vicidial_users' 130+ columns is set here —
everything else takes ViciDial's own table defaults, which matches
what admin.php's own "Add User" form effectively does for anything the
form itself doesn't ask about.
==================================================
*/
router.post("/users/full", requireAdmin, async (req, res) => {
  const {
    email,
    fullName,
    accessLevel,
    campaignIds,
    active,
    vicidialUsername,
    phoneLogin,
    phonePass,
    userLevel,
    userGroup,
  } = req.body;

  if (!email || !fullName || !accessLevel) {
    return res.status(400).json({ success: false, message: "email, fullName, and accessLevel are required." });
  }
  if (!["agent", "supervisor", "training_quality", "account_manager", "wfm", "admin"].includes(accessLevel)) {
    return res.status(400).json({ success: false, message: "accessLevel must be agent, supervisor, or admin." });
  }
  if (!vicidialUsername) {
    return res.status(400).json({ success: false, message: "vicidialUsername is required." });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // Fixed placeholder value, per explicit request — every user
    // created through this flow gets the IDENTICAL literal string
    // "CXXXXXXXXXXC" for both pass/pass_hash, rather than a random
    // throwaway. Same underlying reasoning as before (admin.php's own
    // web login is being retired, nobody created this way is expected
    // to use it) — but worth knowing this is a real tradeoff, not a
    // pure improvement: a FIXED, identical value across every account
    // is more predictable than a random one. If admin.php's login ever
    // checks the raw pass column against user input, anyone aware of
    // this convention could attempt it against ANY account created
    // this way. Acceptable given admin.php is being phased out and
    // these accounts aren't meant to use that login path at all — just
    // flagging the tradeoff explicitly rather than changing it
    // silently.
    const throwawayPass = "CXXXXXXXXXXC";

    await connection.execute(
      `
        INSERT INTO asterisk.vicidial_users
          (user, pass, full_name, user_level, user_group, phone_login, phone_pass, email, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Y')
      `,
      [
        vicidialUsername,
        throwawayPass,
        fullName,
        userLevel || 1,
        userGroup || null,
        phoneLogin || null,
        phonePass || null,
        email,
      ]
    );

    const [result] = await connection.execute(
      `INSERT INTO cmx_dialer.app_users (email, full_name, access_level, vicidial_user, active)
       VALUES (?, ?, ?, ?, ?)`,
      [email, fullName, accessLevel, vicidialUsername, active === false ? 0 : 1]
    );

    const appUserId = result.insertId;

    if (Array.isArray(campaignIds) && campaignIds.length > 0) {
      for (const campaignId of campaignIds) {
        await connection.execute(
          `INSERT INTO cmx_dialer.agent_campaign_assignments (app_user_id, campaign_id) VALUES (?, ?)`,
          [appUserId, campaignId]
        );
      }
    }

    await connection.commit();

    // Same reasoning as POST /users above — sent after commit, never
    // awaited into the response, a slow/bounced email should never
    // make account creation itself look like it failed.
    transporter
      .sendMail({
        from: process.env.SMTP_FROM,
        to: email,
        ...buildWelcomeEmail({ fullName, email, accessLevel }),
      })
      .catch((err) => {
        console.error(`[adminRoutes] Failed to send welcome email to ${email}:`, err.message);
      });

    return res.json({ success: true, appUserId, vicidialUsername });
  } catch (error) {
    await connection.rollback();
    console.error("POST /api/admin/users/full failed:", error);

    if (error.code === "ER_DUP_ENTRY") {
      return res
        .status(409)
        .json({ success: false, message: "That ViciDial username, phone login, or email is already taken." });
    }

    return res.status(500).json({ success: false, message: "Failed to create user." });
  } finally {
    connection.release();
  }
});

/*
==================================================
PHONES CRUD
==================================================
Second piece of the ViciDial-admin-migration project (after Users) —
see the paused-work bookmark for the full sequence.

REAL SCHEMA FINDING, worth stating plainly: phones has NO single-column
primary key at all. Its actual uniqueness guarantee is a COMPOSITE
UNIQUE KEY on (extension, server_ip) — confirmed directly via
SHOW CREATE TABLE, not assumed. Every update/delete below is scoped to
BOTH columns together, never extension alone — keying on extension
only would be a real correctness gap in any multi-server ViciDial
setup (the same extension number can legitimately exist on different
servers), even though it happens to behave fine on this single-server
deployment right now.

server_ip is NEVER an admin-editable field — it's always this server's
own fixed public IP, read from SERVER_IP in .env (same "per-environment
value lives in .env" pattern as FRONTEND_URL/AMI_HOST/MYSQL_HOST
elsewhere in this app). protocol is hardcoded to PJSIP, not the
table's own legacy default of SIP — PJSIP is what this app's actual
trunk/dialplan setup uses throughout, confirmed across tonight's own
Asterisk config work.

Only a practical subset of the 90+ real columns is exposed here —
everything else takes the table's own defaults, same reasoning as
vicidial_users' MVP field set.
==================================================
*/
const SERVER_IP = process.env.SERVER_IP;
if (!SERVER_IP) {
  console.warn(
    "[adminRoutes] SERVER_IP is not set in .env — phone creation/updates will fail until it is."
  );
}

// Fixed, constant values per explicit request — every phone created
// or updated through this app uses the SAME login password and
// registration secret, rather than an admin choosing one per phone.
// pass = "Login Password" (legacy admin.php concept), conf_secret =
// "Registration Password" (the actual SIP/PJSIP registration secret a
// softphone like MicroSIP authenticates with) — confirmed directly
// against a real, working production phone row, not assumed. These
// are documented in .env specifically so whoever is manually
// configuring a physical/soft phone's SIP client knows what to type —
// the admin UI itself never asks for or displays them, since they're
// no longer a per-phone choice at all.
const PHONE_LOGIN_PASSWORD = process.env.PHONE_LOGIN_PASSWORD;
const PHONE_REGISTRATION_PASSWORD = process.env.PHONE_REGISTRATION_PASSWORD;
if (!PHONE_LOGIN_PASSWORD || !PHONE_REGISTRATION_PASSWORD) {
  console.warn(
    "[adminRoutes] PHONE_LOGIN_PASSWORD / PHONE_REGISTRATION_PASSWORD are not set in .env — phone creation/updates will fail until they are."
  );
}

/*
==================================================
PJSIP WIZARD FILE GENERATION FOR PHONES
==================================================
Real finding from tonight's investigation: this ViciDial install
normally has phones' PJSIP config regenerated by a Perl daemon
(ADMIN_keepalive_ALL.pl) that reads the phones table and rewrites
pjsip_wizard-vicidial.conf — but that daemon isn't running continuously
on sandbox (confirmed via `ps aux`), and wasn't found running on
production either when checked. Rather than depend on starting or
scheduling that external Perl process, this app generates its OWN
separate file and triggers the reload directly here — bypassing
ViciDial's mechanism entirely, matching the same direct-PJSIP-config
approach already used for the CMXSandbox trunk earlier this session.

Kept in a SEPARATE file (not pjsip.conf, not
pjsip_wizard-vicidial.conf) specifically so this never touches or
conflicts with either the manually-built trunk config or whatever
ViciDial's own daemon might someday also try to write to the same
filename.

ONE-TIME MANUAL SETUP STEP, not done by this code: add
`#include "pjsip-phones-cmxdialer.conf"` to /etc/asterisk/pjsip.conf,
and create an empty starting file at that path so the include doesn't
fail before this ever runs for the first time.

Block format confirmed directly against a REAL, working production
phone's own generated wizard block (bsmsc901) — not guessed.
inbound_auth/password uses PHONE_REGISTRATION_PASSWORD, matching
conf_secret's confirmed role.

Regenerates the WHOLE file from scratch every time (all active phones
on this server), rather than trying to patch just the one changed
entry — simpler, and correctness-by-construction: the file can never
drift from what's actually in the database.
==================================================
*/
const PHONE_WIZARD_CONF_PATH = "/etc/asterisk/pjsip-phones-cmxdialer.conf";

// WEBRTC/JSSIP DEFAULT — every extension the app creates now goes
// out over transport-wss instead of transport-udp. This is a
// deliberate change from the original MicroSIP-oriented template:
// this app's own agent phone widget (MiniPhone) is JsSIP, which only
// ever registers over wss:// — a UDP-only endpoint has no matching
// WSS transport/AOR for JsSIP to bind to and registration fails with
// a SIP 404 ("Not Found"), confirmed directly against a real new
// extension (bsmsc902) before this fix.
//
// rewrite_contact is DROPPED entirely (endpoint and aor) — under
// WebRTC, NAT traversal is handled by ICE, not by Asterisk rewriting
// the Contact header; leaving it on can interfere with ICE
// negotiation. Same change already proven manually on bsmsc901.
//
// webrtc = yes auto-sets ice_support, use_avpf, media_encryption=dtls,
// rtcp_mux, and dtls_auto_generate_cert — no need to set those
// individually.
function buildPhoneWizardBlock({ extension, login, fullname, phone_type }) {
  const callerName = (fullname || login || extension).replace(/"/g, "");
  // CMX desktop dialer: plain UDP SIP + ulaw/alaw, no WebRTC/DTLS/ICE.
  if (phone_type === "DESKTOP") {
    return [
      `[${extension}]`,
      `type = endpoint`,
      `transport = transport-udp`,
      `context = default`,
      `disallow = all`,
      `allow = ulaw,alaw`,
      `direct_media = no`,
      `rtp_symmetric = yes`,
      `force_rport = yes`,
      `rewrite_contact = yes`,
      `media_address = ${process.env.SERVER_IP}`,
      `auth = ${extension}`,
      `aors = ${extension}`,
      `callerid = "${callerName}" <0000000000>`,
      `dtmf_mode = rfc4733`,
      `send_rpid = yes`,
      `trust_id_inbound = no`,
      ``,
      `[${extension}]`,
      `type = auth`,
      `auth_type = userpass`,
      `username = ${login}`,
      `password = ${PHONE_REGISTRATION_PASSWORD}`,
      ``,
      `[${extension}]`,
      `type = aor`,
      `max_contacts = 1`,
      `remove_existing = yes`,
      `qualify_frequency = 30`,
      `maximum_expiration = 3600`,
      `minimum_expiration = 60`,
      `default_expiration = 120`,
      ``,
    ].join("\n");
  }
  return [
    `[${extension}]`,
    `type = endpoint`,
    `transport = transport-wss`,
    `context = default`,
    `disallow = all`,
    `allow = ulaw,opus`,
    `webrtc = yes`,
    `auth = ${extension}`,
    `aors = ${extension}`,
    `callerid = "${callerName}" <0000000000>`,
    `dtmf_mode = rfc4733`,
    `send_rpid = yes`,
    `trust_id_inbound = no`,
    ``,
    `[${extension}]`,
    `type = auth`,
    `auth_type = userpass`,
    `username = ${login}`,
    `password = ${PHONE_REGISTRATION_PASSWORD}`,
    ``,
    `[${extension}]`,
    `type = aor`,
    `max_contacts = 2`,
    `qualify_frequency = 15`,
    `maximum_expiration = 3600`,
    `minimum_expiration = 60`,
    `default_expiration = 120`,
    ``,
  ].join("\n");
}

async function regeneratePhoneWizardFile() {
  const [rows] = await db.execute(
    `SELECT extension, login, fullname, phone_type FROM asterisk.phones WHERE server_ip = ? AND active = 'Y'`,
    [SERVER_IP]
  );

  let content =
    "; AUTO-GENERATED by cmx_dialer's own admin panel — DO NOT EDIT MANUALLY.\n" +
    "; Regenerated automatically on every phone create/update/delete via\n" +
    "; POST/PUT/DELETE /api/admin/phones. See adminRoutes.js.\n\n";

  for (const row of rows) {
    content += buildPhoneWizardBlock(row) + "\n";
  }

  fs.writeFileSync(PHONE_WIZARD_CONF_PATH, content);
  await ami.reloadPjsip();
}

router.get("/phones", requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `
        SELECT extension, login, fullname, active, protocol, server_ip
        FROM asterisk.phones
        WHERE server_ip = ?
        ORDER BY extension ASC
      `,
      [SERVER_IP]
    );
    return res.json({ success: true, phones: rows });
  } catch (error) {
    console.error("GET /api/admin/phones failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load phones." });
  }
});

// DISABLED, per explicit request: standalone phone extension creation
// is removed. Every phone extension is now created ONLY as a side
// effect of POST /vicidial-users (see that route for the real logic) —
// extension/login/fullname all come from that flow's username, and
// pass/conf_secret always come from .env there too. Kept as a route
// (rather than deleted outright) so any existing client/integration
// gets a clear, actionable error instead of a silent 404.
router.post("/phones", requireAdmin, async (req, res) => {
  return res.status(410).json({
    success: false,
    message:
      "Standalone phone extension creation has been removed. Create a Phone Login instead (Admin → Phone Login) — its phone extension is created automatically.",
  });
});

// extension is treated as immutable once created — matching how the
// rest of this app already treats vicidial_users.user (no rename path
// exists there either). Changing which extension number a phone
// answers to is rare enough, and risky enough (an active user binding
// could be pointing at the old value), that "delete and recreate" is
// the safer, simpler path for now rather than building a rename flow.
//
// pass/conf_secret are ALWAYS reset to the current PHONE_LOGIN_PASSWORD/
// PHONE_REGISTRATION_PASSWORD on every save, not left untouched — a
// deliberate choice, not an oversight: if those fixed values are ever
// rotated in .env, saving an existing phone brings it back in sync
// with the current standard rather than silently drifting on an old one.
router.put("/phones/:extension", requireAdmin, async (req, res) => {
  const { extension } = req.params;
  const { login, fullname, active } = req.body;

  if (!SERVER_IP) {
    return res.status(500).json({ success: false, message: "SERVER_IP is not configured on this server." });
  }
  if (!PHONE_LOGIN_PASSWORD || !PHONE_REGISTRATION_PASSWORD) {
    return res
      .status(500)
      .json({ success: false, message: "PHONE_LOGIN_PASSWORD/PHONE_REGISTRATION_PASSWORD are not configured on this server." });
  }
  if (!login) {
    return res.status(400).json({ success: false, message: "login is required." });
  }

  try {
    const [result] = await db.execute(
      `
        UPDATE asterisk.phones
        SET login = ?, pass = ?, conf_secret = ?, fullname = ?, active = ?
        WHERE extension = ? AND server_ip = ?
      `,
      [login, PHONE_LOGIN_PASSWORD, PHONE_REGISTRATION_PASSWORD, fullname || null, active === false ? "N" : "Y", extension, SERVER_IP]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Phone not found on this server." });
    }

    let reloadWarning;
    try {
      await regeneratePhoneWizardFile();
    } catch (reloadError) {
      console.error(`[adminRoutes] Failed to regenerate PJSIP wizard file after updating ${extension}:`, reloadError.message);
      reloadWarning =
        "Phone was saved, but applying it to Asterisk failed — changes may not be live yet. Check server logs.";
    }

    return res.json({ success: true, reloadWarning });
  } catch (error) {
    console.error("PUT /api/admin/phones/:extension failed:", error);
    return res.status(500).json({ success: false, message: "Failed to update phone." });
  }
});

router.delete("/phones/:extension", requireAdmin, async (req, res) => {
  const { extension } = req.params;

  if (!SERVER_IP) {
    return res.status(500).json({ success: false, message: "SERVER_IP is not configured on this server." });
  }

  try {
    const [result] = await db.execute(
      `DELETE FROM asterisk.phones WHERE extension = ? AND server_ip = ?`,
      [extension, SERVER_IP]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Phone not found on this server." });
    }

    let reloadWarning;
    try {
      await regeneratePhoneWizardFile();
    } catch (reloadError) {
      console.error(`[adminRoutes] Failed to regenerate PJSIP wizard file after deleting ${extension}:`, reloadError.message);
      reloadWarning = "Phone was deleted from the database, but Asterisk wasn't reloaded. Check server logs.";
    }

    return res.json({ success: true, reloadWarning });
  } catch (error) {
    console.error("DELETE /api/admin/phones/:extension failed:", error);
    return res.status(500).json({ success: false, message: "Failed to delete phone." });
  }
});

/*
==================================================
OUTBOUND TRUNKS — NEW, per explicit request
==================================================
Fills in the "DID / Trunk Setup" placeholder — admins can now add an
outbound SIP trunk (e.g. another Telpeer extension, each pre-configured
on Telpeer's own portal with a different Caller ID) directly through
the app, instead of hand-writing pjsip.conf blocks over SSH every time.

Kept in its OWN separate file (pjsip-trunks-cmxdialer.conf), same exact
reasoning as PHONE_WIZARD_CONF_PATH above — never touches or conflicts
with the hand-maintained base pjsip.conf (CMXCallSuite, transports, the
original manually-built Telpeer block).

ONE-TIME MANUAL SETUP STEP, not done by this code: add
`#include "pjsip-trunks-cmxdialer.conf"` to /etc/asterisk/pjsip.conf,
and create an empty starting file at that path so the include doesn't
fail before this ever runs for the first time.

Block format matches EXACTLY what was manually built and CONFIRMED
WORKING for Telpeer tonight via real test calls — including two real
bugs found and fixed live: from_user must be OMITTED (it was silently
overriding the dynamic per-campaign Caller ID with the endpoint's own
fixed identity) while from_domain must be INCLUDED (removing it broke
Telpeer's own auth-realm matching, causing every call to fail
authentication). This is not a fresh guess — it's the exact verified
pattern.

trunk_name becomes the actual PJSIP section name, and is what campaigns
store in campaign_settings.outbound_trunk — validated strictly
(alphanumeric + dash only) since it flows directly into a dialplan
channel string (PJSIP/${EXTEN}@${CMXTRUNK}, see extensions.conf) and
into generated config file section headers.

sip_password stored in plaintext, matching this app's existing security
posture elsewhere (e.g. INTERNAL_API_SECRET sits in plaintext inside
the dialplan file itself) — a real tradeoff, flagged clearly rather
than silently decided.
==================================================
*/
const TRUNK_CONF_PATH = "/etc/asterisk/pjsip-trunks-cmxdialer.conf";
const TRUNK_NAME_PATTERN = /^[A-Za-z0-9-]+$/;

function buildTrunkBlock({ trunk_name, sip_username, sip_password, sip_server }) {
  return [
    `[${trunk_name}-auth]`,
    `type = auth`,
    `auth_type = userpass`,
    `username = ${sip_username}`,
    `password = ${sip_password}`,
    `realm = ${sip_server}`,
    ``,
    `[${trunk_name}-aor]`,
    `type = aor`,
    `contact = sip:${sip_server}`,
    `qualify_frequency = 60`,
    ``,
    `[${trunk_name}]`,
    `type = endpoint`,
    `transport = transport-udp`,
    `context = trunkinbound`,
    `disallow = all`,
    `allow = ulaw`,
    `outbound_auth = ${trunk_name}-auth`,
    `aors = ${trunk_name}-aor`,
    `from_domain = ${sip_server}`,
    ``,
    `[${trunk_name}-reg]`,
    `type = registration`,
    `outbound_auth = ${trunk_name}-auth`,
    `server_uri = sip:${sip_server}`,
    `client_uri = sip:${sip_username}@${sip_server}`,
    `retry_interval = 60`,
    `forbidden_retry_interval = 600`,
    `expiration = 3600`,
    `line = yes`,
    `endpoint = ${trunk_name}`,
    ``,
  ].join("\n");
}

async function regenerateTrunkConfFile() {
  const [rows] = await db.execute(
    `SELECT trunk_name, sip_username, sip_password, sip_server FROM cmx_dialer.outbound_trunks WHERE active = 1 ORDER BY trunk_name ASC`
  );

  let content =
    "; AUTO-GENERATED by cmx_dialer's own admin panel — DO NOT EDIT MANUALLY.\n" +
    "; Regenerated automatically on every trunk create/update/delete via\n" +
    "; POST/PUT/DELETE /api/admin/trunks. See adminRoutes.js.\n\n";

  for (const row of rows) {
    content += buildTrunkBlock(row) + "\n";
  }

  fs.writeFileSync(TRUNK_CONF_PATH, content);
  await ami.reloadPjsip();
}

router.get("/trunks", requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT trunk_id, trunk_name, sip_username, sip_server, description, active FROM cmx_dialer.outbound_trunks ORDER BY trunk_name ASC`
    );
    return res.json({ success: true, trunks: rows });
  } catch (error) {
    console.error("GET /api/admin/trunks failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load trunks." });
  }
});

router.post("/trunks", requireAdmin, async (req, res) => {
  const { trunkName, sipUsername, sipPassword, sipServer, description } = req.body;

  if (!trunkName || !sipUsername || !sipPassword || !sipServer) {
    return res
      .status(400)
      .json({ success: false, message: "trunkName, sipUsername, sipPassword, and sipServer are all required." });
  }
  if (!TRUNK_NAME_PATTERN.test(trunkName)) {
    return res
      .status(400)
      .json({ success: false, message: "Trunk name can only contain letters, numbers, and dashes." });
  }
  if (trunkName === "CMXCallSuite") {
    return res.status(400).json({
      success: false,
      message: "That name is reserved for the built-in default trunk — pick a different name.",
    });
  }

  try {
    await db.execute(
      `INSERT INTO cmx_dialer.outbound_trunks (trunk_name, sip_username, sip_password, sip_server, description) VALUES (?, ?, ?, ?, ?)`,
      [trunkName, sipUsername, sipPassword, sipServer, description || null]
    );

    let reloadWarning;
    try {
      await regenerateTrunkConfFile();
    } catch (reloadError) {
      console.error(`[adminRoutes] Failed to regenerate trunk config file after creating ${trunkName}:`, reloadError.message);
      reloadWarning = "Trunk was saved, but applying it to Asterisk failed — it may not be live yet. Check server logs.";
    }

    return res.json({ success: true, reloadWarning });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "A trunk with that name already exists." });
    }
    console.error("POST /api/admin/trunks failed:", error);
    return res.status(500).json({ success: false, message: "Failed to create trunk." });
  }
});

// trunk_name is treated as immutable once created — same reasoning as
// phone extensions above: campaigns reference it directly
// (campaign_settings.outbound_trunk), and a rename would silently
// orphan any campaign already pointing at the old name.
router.put("/trunks/:trunkId", requireAdmin, async (req, res) => {
  const { trunkId } = req.params;
  const { sipUsername, sipPassword, sipServer, description, active } = req.body;

  if (!sipUsername || !sipServer) {
    return res.status(400).json({ success: false, message: "sipUsername and sipServer are required." });
  }

  try {
    // Password is OPTIONAL on edit — blank means "keep the current
    // one", same convention already used elsewhere in this app for
    // sensitive/rarely-changed fields (e.g. campaign audio uploads).
    // COALESCE only overwrites when a genuinely non-empty new value
    // is provided.
    const [result] = await db.execute(
      `UPDATE cmx_dialer.outbound_trunks SET sip_username = ?, sip_password = COALESCE(NULLIF(?, ''), sip_password), sip_server = ?, description = ?, active = ? WHERE trunk_id = ?`,
      [sipUsername, sipPassword || "", sipServer, description || null, active === false ? 0 : 1, trunkId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Trunk not found." });
    }

    let reloadWarning;
    try {
      await regenerateTrunkConfFile();
    } catch (reloadError) {
      console.error(`[adminRoutes] Failed to regenerate trunk config file after updating trunk ${trunkId}:`, reloadError.message);
      reloadWarning = "Trunk was saved, but applying it to Asterisk failed — it may not be live yet. Check server logs.";
    }

    return res.json({ success: true, reloadWarning });
  } catch (error) {
    console.error("PUT /api/admin/trunks/:trunkId failed:", error);
    return res.status(500).json({ success: false, message: "Failed to update trunk." });
  }
});

router.delete("/trunks/:trunkId", requireAdmin, async (req, res) => {
  const { trunkId } = req.params;

  try {
    const [trunkRows] = await db.execute(`SELECT trunk_name FROM cmx_dialer.outbound_trunks WHERE trunk_id = ?`, [trunkId]);
    if (!trunkRows.length) {
      return res.status(404).json({ success: false, message: "Trunk not found." });
    }
    const { trunk_name: trunkName } = trunkRows[0];

    // Safety net, per explicit request-adjacent reasoning — block
    // deletion outright if any campaign currently routes outbound
    // calls through this trunk, rather than silently leaving that
    // campaign pointing at a PJSIP endpoint that no longer exists
    // (which would fail every future outbound call from it with no
    // clear signal why).
    const [inUseRows] = await db.execute(
      `SELECT campaign_id FROM cmx_dialer.campaign_settings WHERE outbound_trunk = ?`,
      [trunkName]
    );
    if (inUseRows.length) {
      const campaignList = inUseRows.map((r) => r.campaign_id).join(", ");
      return res.status(409).json({
        success: false,
        message: `Can't delete — still in use by: ${campaignList}. Switch those campaigns to a different trunk first.`,
      });
    }

    await db.execute(`DELETE FROM cmx_dialer.outbound_trunks WHERE trunk_id = ?`, [trunkId]);

    let reloadWarning;
    try {
      await regenerateTrunkConfFile();
    } catch (reloadError) {
      console.error(`[adminRoutes] Failed to regenerate trunk config file after deleting trunk ${trunkId}:`, reloadError.message);
      reloadWarning = "Trunk was deleted from the database, but Asterisk wasn't reloaded. Check server logs.";
    }

    return res.json({ success: true, reloadWarning });
  } catch (error) {
    console.error("DELETE /api/admin/trunks/:trunkId failed:", error);
    return res.status(500).json({ success: false, message: "Failed to delete trunk." });
  }
});

/*
==================================================
VICIDIAL USERS — standalone CRUD
==================================================
Separated out per explicit request — creating a ViciDial user is now
its own, independent action (matching admin.php's own separation of
concerns), not something that only happens bundled inside app-user
creation. This is the SAME resource pool GET /vicidial-users/available
already draws from for the "bind to an existing ViciDial user"
dropdown — a user created here becomes immediately bindable to any app
user afterward, no different from a pre-existing account.

POST /users/full (further up this file) still exists and still works —
left in place rather than removed, since it's tested and functional,
just no longer the primary path the frontend uses for this. If a
future need for "create both together in one step" comes back, it's
already there.

Same practical MVP field subset and fixed-placeholder-password
reasoning as POST /users/full above.
==================================================
*/
router.get("/vicidial-users", requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `
        SELECT user, full_name, user_level, user_group, phone_login, email, active
        FROM asterisk.vicidial_users
        ORDER BY user ASC
      `
    );
    return res.json({ success: true, vicidialUsers: rows });
  } catch (error) {
    console.error("GET /api/admin/vicidial-users failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load ViciDial users." });
  }
});

/*
==================================================
CREATE VICIDIAL USER — now also creates the Phone Extension
==================================================
POST /api/admin/vicidial-users
Body: { username, fullName, userLevel, userGroup, active, createPhoneExtension }

UPDATED BEHAVIOR (per explicit request):
- `username` is now the ONE value that drives vicidial_users.user,
  phone_login, AND email (all three set to the same value) — no more
  separate phoneLogin/email inputs. Confirmed safe against real column
  widths: user/phone_login are varchar(20), email is varchar(100), and
  the placeholder ("e.g. 90099") confirms this field is meant to stay
  short/extension-style, not a full email address — so no truncation
  risk across any of these columns.
- phone_pass is now ALWAYS PHONE_LOGIN_PASSWORD from .env — no longer
  accepted from the request body, matching the same fixed-shared-
  password pattern already used for asterisk.phones.pass elsewhere in
  this file.
- ViciDial User creation now ALSO creates the phone extension
  (asterisk.phones row + regenerated PJSIP wizard file) in the SAME
  transaction — the username becomes the phone's extension, login,
  AND fullname/callerid too (matches buildPhoneWizardBlock's
  `callerName` usage), per explicit request.
- createPhoneExtension GATING: defaults to true for every user. Only
  userLevel 7, 8, or 9 may set this to false and skip phone creation —
  enforced server-side here (not just the frontend checkbox), since a
  request body can't be trusted on its own. Any other userLevel
  sending createPhoneExtension=false is silently forced back to true.
==================================================
*/
router.post("/vicidial-users", requireAdmin, async (req, res) => {
  const { username, fullName, userLevel, userGroup, active, createPhoneExtension } = req.body;

  if (!username) {
    return res.status(400).json({ success: false, message: "username is required." });
  }

  const resolvedUserLevel = userLevel ? Number(userLevel) : 1;

  const HIGH_LEVELS_ALLOWED_TO_SKIP_PHONE = [7, 8, 9];
  const wantsToSkipPhone = createPhoneExtension === false;
  const allowedToSkipPhone = HIGH_LEVELS_ALLOWED_TO_SKIP_PHONE.includes(resolvedUserLevel);
  const shouldCreatePhone = !(wantsToSkipPhone && allowedToSkipPhone);

  if (shouldCreatePhone) {
    if (!SERVER_IP) {
      return res.status(500).json({ success: false, message: "SERVER_IP is not configured on this server." });
    }
    if (!PHONE_LOGIN_PASSWORD || !PHONE_REGISTRATION_PASSWORD) {
      return res.status(500).json({
        success: false,
        message: "PHONE_LOGIN_PASSWORD/PHONE_REGISTRATION_PASSWORD are not configured on this server.",
      });
    }
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    await connection.execute(
      `
        INSERT INTO asterisk.vicidial_users
          (user, pass, full_name, user_level, user_group, phone_login, phone_pass, email, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        username,
        "CXXXXXXXXXXC",
        fullName || null,
        resolvedUserLevel,
        userGroup || null,
        username, // phone_login = username
        PHONE_LOGIN_PASSWORD, // now always from .env, not request body
        username, // email = username, per explicit request
        active === false ? "N" : "Y",
      ]
    );

    let phoneCreated = false;
    if (shouldCreatePhone) {
      // extension = login = fullname (callerid) = username, per
      // explicit request — the phone entry does NOT use the person's
      // real fullName for its callerid, it uses the username.
      await connection.execute(
        `
          INSERT INTO asterisk.phones
            (extension, server_ip, login, pass, conf_secret, fullname, active, protocol)
          VALUES (?, ?, ?, ?, ?, ?, 'Y', 'PJSIP')
        `,
        [username, SERVER_IP, username, PHONE_LOGIN_PASSWORD, PHONE_REGISTRATION_PASSWORD, username]
      );
      phoneCreated = true;
    }

    await connection.commit();

    // Regenerate the PJSIP wizard file AFTER commit — a slow/failed
    // Asterisk reload should never make the already-committed DB
    // rows look like they failed to save.
    let reloadWarning;
    if (phoneCreated) {
      try {
        await regeneratePhoneWizardFile();
      } catch (reloadError) {
        console.error(`[adminRoutes] Failed to regenerate PJSIP wizard file after creating ${username}:`, reloadError.message);
        reloadWarning =
          "ViciDial user and phone extension were saved, but applying the phone to Asterisk failed — it may not be callable yet. Check server logs.";
      }
    }

    return res.json({ success: true, username, phoneCreated, reloadWarning });
  } catch (error) {
    await connection.rollback();
    console.error("POST /api/admin/vicidial-users failed:", error);
    if (error.code === "ER_DUP_ENTRY") {
      return res
        .status(409)
        .json({ success: false, message: `ViciDial username ${username} already exists (or its phone extension does).` });
    }
    return res.status(500).json({ success: false, message: "Failed to create ViciDial user." });
  } finally {
    connection.release();
  }
});

// UPDATED: phone_login and email are no longer independently editable
// here — both are derived from the (immutable) username at creation
// time and stay in sync with it automatically, so there's nothing to
// re-enter on edit. phone_pass is now ALWAYS reset to the current
// PHONE_LOGIN_PASSWORD from .env on every save (same "always resync
// to current standard" pattern already used for phones.pass/
// conf_secret in PUT /phones/:extension), rather than an optional
// admin-entered value.
router.put("/vicidial-users/:username", requireAdmin, async (req, res) => {
  const { username } = req.params;
  const { fullName, userLevel, userGroup, active } = req.body;

  try {
    const [result] = await db.execute(
      `UPDATE asterisk.vicidial_users
       SET full_name = ?, user_level = ?, user_group = ?, active = ?, phone_pass = ?
       WHERE user = ?`,
      [
        fullName || null,
        userLevel ? Number(userLevel) : 1,
        userGroup || null,
        active === false ? "N" : "Y",
        PHONE_LOGIN_PASSWORD,
        username,
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "ViciDial user not found." });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("PUT /api/admin/vicidial-users/:username failed:", error);
    return res.status(500).json({ success: false, message: "Failed to update ViciDial user." });
  }
});

// UPDATED: deleting a ViciDial user (now labeled "Phone Login" in the
// UI) now ALSO deletes its matching asterisk.phones row, since phone
// extensions are no longer created standalone — every phone that
// exists was created alongside a ViciDial user with the same
// extension/login value. Runs in a transaction so the two deletes
// either both succeed or neither does, and the wizard file only
// regenerates after a successful commit.
router.delete("/vicidial-users/:username", requireAdmin, async (req, res) => {
  const { username } = req.params;

  const connection = await db.getConnection();
  try {
    // Guard: refuse to delete a ViciDial user still bound to an app
    // user — that would leave app_users.vicidial_user pointing at a
    // row that no longer exists. The admin needs to release the
    // binding first (edit that app user, set Phone Login to
    // None/Release) before deleting the account itself.
    const [boundCheck] = await connection.execute(
      `SELECT app_user_id FROM cmx_dialer.app_users WHERE vicidial_user = ?`,
      [username]
    );
    if (boundCheck.length > 0) {
      return res.status(409).json({
        success: false,
        message:
          "This Phone Login is still bound to an app account. Unbind it first (edit that app user, set Phone Login to None/Release).",
      });
    }

    await connection.beginTransaction();

    const [result] = await connection.execute(`DELETE FROM asterisk.vicidial_users WHERE user = ?`, [username]);

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: "Phone Login not found." });
    }

    // Matches on extension alone here (not extension+server_ip) is
    // intentional — username is globally unique in vicidial_users
    // (UNI key on `user`), so there's exactly one phone row to clean
    // up regardless of server. If this app is ever run against
    // multiple servers sharing one asterisk DB, revisit this to also
    // scope by SERVER_IP.
    const [phoneResult] = await connection.execute(`DELETE FROM asterisk.phones WHERE extension = ?`, [username]);

    await connection.commit();

    let reloadWarning;
    if (phoneResult.affectedRows > 0) {
      try {
        await regeneratePhoneWizardFile();
      } catch (reloadError) {
        console.error(`[adminRoutes] Failed to regenerate PJSIP wizard file after deleting ${username}:`, reloadError.message);
        reloadWarning =
          "Phone Login and its phone extension were deleted, but Asterisk wasn't reloaded. Check server logs.";
      }
    }

    return res.json({ success: true, phoneDeleted: phoneResult.affectedRows > 0, reloadWarning });
  } catch (error) {
    await connection.rollback();
    console.error("DELETE /api/admin/vicidial-users/:username failed:", error);
    return res.status(500).json({ success: false, message: "Failed to delete Phone Login." });
  } finally {
    connection.release();
  }
});

/*
==================================================
LIVE AGENT STATUS
==================================================
GET /api/admin/live-status?campaignId=optional

Returns every active agent's CURRENT status and how long they've been
in it. "LOGGED_OUT" isn't a real status_log value — it's derived as
"this agent has no open status row at all", using the most recent
CLOSED row's ended_at as their logout time (requires logout to
actually close the row — see authRoutes.js's fix).

Campaign filtering is done via agent_campaign_assignments (who's
ASSIGNED to a campaign), not via agent_status_log's
related_campaign_id (which is only ever set for IN_CALL/
AFTER_CALL_WORK/ON_HOLD — NOT_READY/READY/AD_HOC/LUNCH_BREAK/
BIO_BREAK/ADMIN/MEETING/TRAINING have no call to tag
at all, so filtering by that column would hide those agents entirely
under any specific campaign filter). "All Campaigns" (no campaignId)

REAL BUG FIX, per explicit request — this list previously excluded
only 'admin', letting account_manager and wfm rows show up here
despite neither role ever making or receiving a call at all (confirmed
directly: no dialer/call-placing route in this app restricts by role
in any way, but account_manager/wfm are never even given access to
DialerPage.jsx or CampaignSelectPage.jsx's UI in the first place — see
their own role guards — so they'd never realistically show anything
but LOGGED_OUT/NOT_READY here regardless). training_quality
deliberately STAYS visible — confirmed it genuinely can make/receive
calls today (DialerPage.jsx and CampaignSelectPage.jsx both explicitly
include it alongside agent/supervisor, and no backend route blocks it
either), so it's a real potential call-handler worth monitoring here,
not just noise to hide.
shows every active agent regardless of assignment.
==================================================
*/
router.get(
  "/live-status",
  requireRoles("supervisor", "training_quality", "account_manager", "wfm", "admin"),
  requireCampaignAccess,
  async (req, res) => {
  try {
    const { campaignId } = req.query;

    const [rows] = await db.execute(
      `
        SELECT
          au.app_user_id,
          au.full_name,
          au.email,
          au.vicidial_user,
          au.last_login_at,
          au.priority,
          open_row.status AS open_status,
          open_row.elapsed_seconds AS open_elapsed_seconds,
          open_row.related_call_id AS open_related_call_id,
          open_row.related_campaign_id AS open_related_campaign_id,
          open_row.related_call_direction AS open_related_call_direction,
          last_closed.logged_out_elapsed_seconds,
          working.working_campaign_count
        FROM cmx_dialer.app_users au
        LEFT JOIN (
          SELECT app_user_id, status, related_call_id, related_campaign_id, related_call_direction, TIMESTAMPDIFF(SECOND, started_at, NOW()) AS elapsed_seconds
          FROM cmx_dialer.agent_status_log
          WHERE ended_at IS NULL
        ) open_row ON open_row.app_user_id = au.app_user_id
        LEFT JOIN (
          SELECT app_user_id, TIMESTAMPDIFF(SECOND, MAX(ended_at), NOW()) AS logged_out_elapsed_seconds
          FROM cmx_dialer.agent_status_log
          WHERE ended_at IS NOT NULL
          GROUP BY app_user_id
        ) last_closed ON last_closed.app_user_id = au.app_user_id
        LEFT JOIN (
          SELECT app_user_id, COUNT(*) AS working_campaign_count
          FROM cmx_dialer.agent_working_campaigns
          GROUP BY app_user_id
        ) working ON working.app_user_id = au.app_user_id
        WHERE au.active = 1
          AND au.access_level NOT IN ('admin', 'account_manager', 'wfm')
          AND (
            ? IS NULL OR EXISTS (
              SELECT 1 FROM cmx_dialer.agent_campaign_assignments aca
              WHERE aca.app_user_id = au.app_user_id
                AND aca.campaign_id = ?
                AND aca.active = 1
            )
          )
      `,
      [campaignId || null, campaignId || null]
    );

    const callIdsNeedingTotal = rows
      .filter((r) => r.open_status === "IN_CALL" && r.open_related_call_id)
      .map((r) => r.open_related_call_id);

    const totalsByCallId = new Map();
    if (callIdsNeedingTotal.length > 0) {
      const placeholders = callIdsNeedingTotal.map(() => "?").join(",");
      const [totalRows] = await db.execute(
        `
          SELECT
            related_call_id,
            SUM(
              CASE
                WHEN ended_at IS NOT NULL THEN duration_seconds
                ELSE TIMESTAMPDIFF(SECOND, started_at, NOW())
              END
            ) AS total_seconds
          FROM cmx_dialer.agent_status_log
          WHERE related_call_id IN (${placeholders})
          GROUP BY related_call_id
        `,
        callIdsNeedingTotal
      );
      for (const t of totalRows) {
        totalsByCallId.set(t.related_call_id, Number(t.total_seconds) || 0);
      }
    }

    const callerIdsByCallId = { ...dialerService.getActiveCallPhoneNumbers() };
    for (const call of inboundCallService.getAllInboundCalls()) {
      callerIdsByCallId[call.callId] = call.callerIdNumber;
    }

    // REAL BUG FIX, per explicit request: this used to fall back to
    // "assigned_campaign_id" (a subquery guessing whichever campaign
    // sorted first alphabetically among the agent's assignments) any
    // time open_related_campaign_id was null — which was ALWAYS the
    // case right after login, before the agent's first manual status
    // change ever recorded a real campaign. That guess was
    // confirmed wrong in practice (an agent actually on CMXRNYBL
    // showed as CMXBSMSC purely because "B" < "R"). No more guessing —
    // an agent who is actively logged in (has an open status row) but
    // hasn't had a campaign recorded yet is filtered OUT of this list
    // entirely, rather than shown with a misleading campaign. LOGGED_OUT
    // agents (no open status row at all) are unaffected by this and
    // still show normally, regardless of campaign.
    // REAL BUG FIX, confirmed live: the filter below used to be
    // `!r.open_status || r.open_related_campaign_id` — which excludes
    // ANY agent whose open status lacks a related_campaign_id. But per
    // this route's own comment above, related_campaign_id is ONLY EVER
    // set for IN_CALL/ON_HOLD/AFTER_CALL_WORK — READY/NOT_READY/AD_HOC/
    // LUNCH_BREAK/BIO_BREAK/ADMIN/MEETING/TRAINING never have one AT
    // ALL, by design. Net effect: every single READY agent was being
    // filtered out of Live Dashboard entirely, always — not the "just
    // logged in, no campaign recorded yet" edge case this was meant to
    // guard against, but literally every agent in that status. Fixed
    // to only apply the "must have a campaign tag" requirement to the
    // call-related statuses that are actually supposed to have one.
    const isCallRelatedStatus = (status) => status === "IN_CALL" || status === "ON_HOLD" || status === "AFTER_CALL_WORK";

    const agents = rows
      .filter((r) => !r.open_status || !isCallRelatedStatus(r.open_status) || r.open_related_campaign_id)
      .map((r) => {
        if (r.open_status) {
          const isCallRelated =
            r.open_status === "IN_CALL" || r.open_status === "ON_HOLD" || r.open_status === "AFTER_CALL_WORK";
          const useAggregatedDuration = r.open_status === "IN_CALL";
          const totalHandlingSeconds = useAggregatedDuration ? totalsByCallId.get(r.open_related_call_id) : undefined;

          // MULTI-CAMPAIGN DISPLAY — per explicit request: while an
          // agent is in a non-call-tied status (Ready, Not Ready,
          // Lunch/Break, etc.) with more than one campaign in their
          // CURRENT working selection (agent_working_campaigns — see
          // dialerRoutes.js's working-campaigns route), show the
          // literal string "MULTI" instead of guessing at one of
          // them. The moment they actually connect to a real call
          // (IN_CALL/ON_HOLD/AFTER_CALL_WORK), open_related_campaign_id
          // already correctly reflects that SPECIFIC call's real
          // campaign — untouched here, only the non-call-tied case is
          // affected.
          const showMulti = !isCallRelated && Number(r.working_campaign_count) > 1;

          return {
            appUserId: r.app_user_id,
            fullName: r.full_name,
            email: r.email,
            vicidialUser: r.vicidial_user,
            campaignId: showMulti ? "MULTI" : r.open_related_campaign_id,
            status: r.open_status,
            direction: isCallRelated ? r.open_related_call_direction || null : null,
            callerId: isCallRelated ? callerIdsByCallId[r.open_related_call_id] || null : null,
            elapsedSeconds: totalHandlingSeconds !== undefined ? totalHandlingSeconds : r.open_elapsed_seconds,
            lastLoginAt: r.last_login_at,
            priority: r.priority,
          };
        }
        return {
          appUserId: r.app_user_id,
          fullName: r.full_name,
          email: r.email,
          vicidialUser: r.vicidial_user,
          campaignId: null,
          status: "LOGGED_OUT",
          direction: null,
          elapsedSeconds: r.logged_out_elapsed_seconds,
          lastLoginAt: r.last_login_at,
          priority: r.priority,
        };
      });

    return res.json({ success: true, agents });
  } catch (error) {
    console.error("GET /api/admin/live-status failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load live status." });
  }
});

/*
==================================================
SILENT LISTEN
==================================================
POST /api/admin/listen/start
Body: { appUserId, line } (line: 1 or 2, defaults to 1)
Lets training_quality/supervisor/admin roles silently join a live
call, completely inaudible to both the agent and the customer. See
monitoringService.js for the full mechanism and confbridge.conf's
cmx_silent_listener profile for why it's actually silent, not just
started that way.

Known limitation, not yet handled: if the underlying call ends (or
the supervisor's own browser tab just closes) without an explicit
POST /listen/stop, this listening channel is never automatically
cleaned up — left alone in an otherwise-empty room indefinitely.
Worth a follow-up once this ships.
==================================================
*/
router.post("/listen/start", requireRoles("training_quality", "supervisor", "admin"), async (req, res) => {
  try {
    const targetAppUserId = Number(req.body.appUserId);
    if (!targetAppUserId) {
      return res.status(400).json({ success: false, message: "appUserId is required." });
    }

    const listenerAppUserId = req.session.agent.appUserId;
    const listenerExtension = req.session.agent.extension;
    if (!listenerExtension) {
      return res
        .status(400)
        .json({ success: false, message: "Your own account has no phone extension configured." });
    }

    // A given agent can only ever be on one or the other at a time —
    // check outbound first, then inbound.
    let call = dialerService.getRawActiveCallForAgent(targetAppUserId);
    let direction = "outbound";
    if (!call) {
      call = inboundCallService.getInboundCallForAgent(targetAppUserId);
      direction = "inbound";
    }
    if (!call) {
      return res.status(404).json({ success: false, message: "This agent isn't on an active call right now." });
    }

    const fullyConnectedStatus = direction === "outbound" ? "customer_connected" : "agent_connected";
    if (call.status !== fullyConnectedStatus) {
      return res
        .status(409)
        .json({ success: false, message: "This call hasn't actually connected yet — nothing to listen to." });
    }

    // Campaign scoping — same principle as requireCampaignAccess:
    // enforced here, not just left to the dashboard's own filtering,
    // since a request can always be sent directly regardless of what
    // the UI shows.
    if (!UNRESTRICTED_CAMPAIGN_ROLES.includes(req.session.agent.accessLevel)) {
      const assigned = await getAssignedCampaignIds(listenerAppUserId);
      if (!assigned.includes(call.campaignId)) {
        return res.status(403).json({ success: false, message: "You don't have access to this campaign." });
      }
    }

    // Per explicit request — one "Listen" action, no separate Line
    // 1/Line 2 buttons at all. Follows call.activeLine (this app's
    // own existing source of truth for which room the agent's audio
    // is CURRENTLY bridged to — see attendedTransferService.js) at
    // the moment Listen is clicked; every subsequent switch is then
    // handled automatically by monitoringService.syncListenerRoom,
    // called from every point in attendedTransferService.js where
    // activeLine can change. Conference/Blind Transfer participants
    // need no special handling here at all — confirmed directly,
    // those join the SAME room as Line 1, never a separate one.
    const excludeChannels = [call.agentChannel, call.customerChannel].filter(Boolean);
    let room = call.room;
    if (call.activeLine === 2 && call.lineTwo) {
      room = call.lineTwo.room;
      if (call.lineTwo.targetChannel) excludeChannels.push(call.lineTwo.targetChannel);
    }

    // A supervisor can only ever be listening to one call at a time
    // — if they were already listening to someone else, end that
    // first so switching agents never leaves the old channel
    // orphaned in its room.
    await monitoringService.endSilentListen(listenerAppUserId);

    const result = await monitoringService.startSilentListen(
      room,
      listenerExtension,
      listenerAppUserId,
      targetAppUserId,
      excludeChannels
    );
    if (!result.success) {
      return res
        .status(502)
        .json({ success: false, message: "Couldn't connect — the call may have just ended.", reason: result.reason });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("POST /api/admin/listen/start failed:", error);
    return res.status(500).json({ success: false, message: "Failed to start listening." });
  }
});

router.post("/listen/stop", requireRoles("training_quality", "supervisor", "admin"), async (req, res) => {
  try {
    await monitoringService.endSilentListen(req.session.agent.appUserId);
    return res.json({ success: true });
  } catch (error) {
    console.error("POST /api/admin/listen/stop failed:", error);
    return res.status(500).json({ success: false, message: "Failed to stop listening." });
  }
});

/*
==================================================
UPDATE USER
==================================================
PUT /api/admin/users/:appUserId
Body: { email, fullName, accessLevel, vicidialUser (nullable), campaignIds: [] }
==================================================
*/
router.put("/users/:appUserId", requireAdmin, async (req, res) => {
  const { appUserId } = req.params;
  const { email, fullName, accessLevel, vicidialUser, campaignIds, active, priority, multiCampaignEnabled } = req.body;

  if (!email || !fullName || !accessLevel) {
    return res.status(400).json({ success: false, message: "email, fullName, and accessLevel are required." });
  }

  if (!["agent", "supervisor", "training_quality", "account_manager", "wfm", "admin"].includes(accessLevel)) {
    return res.status(400).json({ success: false, message: "accessLevel must be agent, supervisor, or admin." });
  }

  const resolvedPriority = priority ? Number(priority) : 1;
  if (![1, 2, 3, 4].includes(resolvedPriority)) {
    return res.status(400).json({ success: false, message: "priority must be 1, 2, 3, or 4." });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // priority_skip_count reset to 0 alongside every full-form save —
    // same reasoning as setPriority() below: a saved priority value
    // (whether it actually changed or not) starts its skip cycle
    // clean rather than carrying over a stale count.
    const [result] = await connection.execute(
      `UPDATE cmx_dialer.app_users
       SET email = ?, full_name = ?, access_level = ?, vicidial_user = ?, active = ?, priority = ?, priority_skip_count = 0, multi_campaign_enabled = ?
       WHERE app_user_id = ?`,
      [email, fullName, accessLevel, vicidialUser || null, active ? 1 : 0, resolvedPriority, multiCampaignEnabled ? 1 : 0, appUserId]
    );

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: "User not found." });
    }

    await connection.execute(
      `DELETE FROM cmx_dialer.agent_campaign_assignments WHERE app_user_id = ?`,
      [appUserId]
    );

    if (Array.isArray(campaignIds) && campaignIds.length > 0) {
      for (const campaignId of campaignIds) {
        await connection.execute(
          `INSERT INTO cmx_dialer.agent_campaign_assignments (app_user_id, campaign_id) VALUES (?, ?)`,
          [appUserId, campaignId]
        );
      }
    }

    await connection.commit();
    return res.json({ success: true });
  } catch (error) {
    await connection.rollback();
    console.error("PUT /api/admin/users/:appUserId failed:", error);

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "That email is already registered." });
    }

    return res.status(500).json({ success: false, message: "Failed to update user." });
  } finally {
    connection.release();
  }
});

/*
==================================================
DELETE USER
==================================================
DELETE /api/admin/users/:appUserId

REAL BUG FOUND AND FIXED HERE: THREE separate tables have actual
enforced foreign keys on app_user_id, confirmed via information_schema
(not assumed) — agent_campaign_assignments, agent_status_log,
otp_codes, and phone_assignments. This delete previously only cleared
agent_campaign_assignments, meaning any user who had ever actually
logged in, requested an OTP, or had a phone_assignments row at all
could never be deleted, failing with a raw FK constraint error
surfaced to the admin as a generic 500. Confirmed via multiple real
failed delete attempts, not theoretical. Fixed by clearing all four
referencing tables in the same transaction before deleting app_users
itself.

NOTE: phone_assignments appears to be an audit-trail table (assigned_at/
unassigned_at/active columns) for phone-binding history — but none of
this file's own user-creation/update endpoints currently write to it
at all. Either it's populated by something outside this file, or it's
unused by the current code paths. Worth investigating separately;
cleared here regardless since it still blocks deletion via its FK.
==================================================
*/
router.delete("/users/:appUserId", requireAdmin, async (req, res) => {
  const { appUserId } = req.params;

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    await connection.execute(
      `DELETE FROM cmx_dialer.agent_campaign_assignments WHERE app_user_id = ?`,
      [appUserId]
    );

    await connection.execute(
      `DELETE FROM cmx_dialer.agent_status_log WHERE app_user_id = ?`,
      [appUserId]
    );

    await connection.execute(
      `DELETE FROM cmx_dialer.otp_codes WHERE app_user_id = ?`,
      [appUserId]
    );

    await connection.execute(
      `DELETE FROM cmx_dialer.phone_assignments WHERE app_user_id = ?`,
      [appUserId]
    );

    const [result] = await connection.execute(
      `DELETE FROM cmx_dialer.app_users WHERE app_user_id = ?`,
      [appUserId]
    );

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: "User not found." });
    }

    await connection.commit();
    return res.json({ success: true });
  } catch (error) {
    await connection.rollback();
    console.error("DELETE /api/admin/users/:appUserId failed:", error);
    return res.status(500).json({ success: false, message: "Failed to delete user." });
  } finally {
    connection.release();
  }
});

/*
==================================================
POST /users/:appUserId/kick
==================================================
*/
router.post("/users/:appUserId/kick", requireAdmin, async (req, res) => {
  try {
    const { appUserId } = req.params;

    const [rows] = await db.execute(
      `SELECT status FROM cmx_dialer.agent_status_log WHERE app_user_id = ? AND ended_at IS NULL LIMIT 1`,
      [appUserId]
    );
    const currentStatus = rows[0]?.status;

    if (!currentStatus) {
      return res.status(400).json({ success: false, message: "This agent isn't currently logged in." });
    }
    const KICKABLE_STATUSES = ["NOT_READY", "LUNCH_BREAK", "BIO_BREAK", "ADMIN", "MEETING", "TRAINING"];
    if (!KICKABLE_STATUSES.includes(currentStatus)) {
      return res.status(400).json({
        success: false,
        message: `Can't kick an agent who is currently ${currentStatus} — only agents in a non-call status can be force-logged-out.`,
      });
    }

    await ws.forceLogout(appUserId, "kicked_by_admin");

    return res.json({ success: true });
  } catch (error) {
    console.error("POST /api/admin/users/:appUserId/kick failed:", error);
    return res.status(500).json({ success: false, message: "Failed to kick this agent." });
  }
});

/*
==================================================
PATCH /api/admin/users/:appUserId/priority
==================================================
Lightweight, standalone endpoint — deliberately separate from the full
PUT /users/:appUserId form save above. Powers the Live Status
Dashboard's real-time "Set Prio" control: an admin/WFM changes an
agent's priority tier on the fly, with no need to open/submit the full
user-edit form for it. Takes effect immediately on the very next
inbound-call matching pass — agentStatusService.getAnyReadyAgentWithExtension
reads priority/priority_skip_count live from the DB on every call, no
caching anywhere in that path.

Uses agentStatusService.setPriority() directly, same helper the full
PUT route's own priority handling is conceptually equivalent to — both
reset priority_skip_count to 0 alongside the change, so a newly-set
tier always starts its skip cycle clean.
==================================================
*/
router.patch("/users/:appUserId/priority", requireAdmin, async (req, res) => {
  const { appUserId } = req.params;
  const { priority } = req.body;

  try {
    await agentStatusService.setPriority(appUserId, priority);
    return res.json({ success: true, priority: Number(priority) });
  } catch (error) {
    console.error(`PATCH /api/admin/users/${appUserId}/priority failed:`, error);
    if (error.message === "priority must be 1, 2, 3, or 4.") {
      return res.status(400).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: "Failed to update priority." });
  }
});

/*
==================================================
PATCH /api/admin/users/:appUserId/multi-campaign
==================================================
NEW — per explicit request: "Admin / WFM controls whether agent can
select multiple blended campaigns to work on." Same lightweight,
standalone pattern as the priority PATCH right above — no need to open
the full user-edit form for a single toggle. requireAdmin here already
covers both admin AND wfm (see its own definition above), matching
exactly who should control this.

Turning this OFF for an agent does NOT retroactively clear any
campaigns they've already selected in agent_working_campaigns — if
they currently have 2 selected and an admin disables the feature, they
keep receiving calls for both until they next change their own
selection (at which point dialerRoutes.js's working-campaigns route
would reject anything beyond one). Simpler and safer than surprise-
dropping a call source out from under an agent mid-shift; the
practical effect (can't add MORE) still takes hold immediately.
==================================================
*/
router.patch("/users/:appUserId/multi-campaign", requireAdmin, async (req, res) => {
  const { appUserId } = req.params;
  const { enabled } = req.body;

  try {
    await db.execute(`UPDATE cmx_dialer.app_users SET multi_campaign_enabled = ? WHERE app_user_id = ?`, [
      enabled ? 1 : 0,
      appUserId,
    ]);
    return res.json({ success: true, multiCampaignEnabled: Boolean(enabled) });
  } catch (error) {
    console.error(`PATCH /api/admin/users/${appUserId}/multi-campaign failed:`, error);
    return res.status(500).json({ success: false, message: "Failed to update multi-campaign setting." });
  }
});

/*
==================================================
QUEUE STATUS
==================================================
GET /api/admin/queue-status?campaignId=optional
==================================================
*/
router.get(
  "/queue-status",
  requireRoles("supervisor", "training_quality", "account_manager", "wfm", "admin"),
  requireCampaignAccess,
  async (req, res) => {
  try {
    const { campaignId } = req.query;
    let queues = inboundCallService.getQueueStatus();

    if (campaignId) {
      queues = queues.filter((q) => q.campaignId === campaignId);
    }

    return res.json({ success: true, queues });
  } catch (error) {
    console.error("GET /api/admin/queue-status failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load queue status." });
  }
});

/*
==================================================
ABANDONED CALLS
==================================================
GET /api/admin/abandoned-calls?campaignId=optional
==================================================
*/
router.get(
  "/abandoned-calls",
  requireRoles("supervisor", "training_quality", "account_manager", "wfm", "admin"),
  requireCampaignAccess,
  async (req, res) => {
  try {
    const { campaignId } = req.query;
    const calls = await inboundCallService.getAbandonedCallsToday(campaignId || null);
    return res.json({ success: true, calls });
  } catch (error) {
    console.error("GET /api/admin/abandoned-calls failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load abandoned calls." });
  }
});

/*
==================================================
TOTAL CALLS (Live Status Dashboard's "Total Calls" widget)
==================================================
GET /api/admin/total-calls?campaignId=optional
==================================================
*/
router.get(
  "/total-calls",
  requireRoles("supervisor", "training_quality", "account_manager", "wfm", "admin"),
  requireCampaignAccess,
  async (req, res) => {
  try {
    const { campaignId } = req.query;
    const { start, end } = await statsService.getEasternDayBoundsForServerClock();

    // Bumped from 200 to 2000, per explicit request — same reasoning
    // as the crowding-out fix right below: keep this a named constant
    // (not a magic number pasted 3x) so the inner-per-direction caps
    // and the outer combined cap stay in the documented 2:1 ratio if
    // this ever needs adjusting again.
    const PER_DIRECTION_LIMIT = 2000;

    const outboundParams = [start, end];
    let outboundCampaignFilter = "";
    if (campaignId) {
      outboundCampaignFilter = "AND campaign_id = ?";
      outboundParams.push(campaignId);
    }
    outboundParams.push(PER_DIRECTION_LIMIT);

    const inboundParams = [start, end];
    let inboundCampaignFilter = "";
    if (campaignId) {
      inboundCampaignFilter = "AND campaign_id = ?";
      inboundParams.push(campaignId);
    }
    inboundParams.push(PER_DIRECTION_LIMIT);

    // REAL BUG FIX, per explicit request — same class of bug as
    // dialerService.js's getCallLog: LIMIT 200 used to apply only
    // once, to the COMBINED outbound+inbound UNION ALL result (the
    // date-range/campaign filter and ORDER BY/LIMIT all lived on the
    // OUTER query, after combining). With a specific campaign
    // selected, combined volume for just that one campaign routinely
    // stayed under 200, so nothing was ever lost. With "All Campaigns"
    // selected (no campaignId), every campaign's outbound call volume
    // stacked together into one much larger pool, and since outbound
    // dial attempts vastly outnumber inbound calls across a whole
    // day's worth of every campaign combined, they silently crowded
    // nearly all inbound calls out of the top-200 window — confirmed
    // live: only 3 inbound calls showing in All Campaigns view (should
    // have been far more), full list correct the moment a single
    // campaign was selected instead. Each direction now filters AND
    // limits independently, inside its own UNION branch, before ever
    // being combined — so inbound calls always get their own fair 200
    // regardless of how many outbound calls happened that day.
    const [rows] = await db.execute(
      `
        SELECT
          combined.campaign_id,
          combined.phone_number,
          combined.call_started_at,
          combined.direction,
          combined.wait_seconds,
          agg.handle_time_seconds,
          au.full_name AS agent_name,
          combined.agent_user
        FROM (
          (
            SELECT campaign_id, phone_number, call_id, call_started_at, agent_user, 'outbound' AS direction, NULL AS wait_seconds
            FROM cmx_dialer.dialer_call_log
            WHERE call_started_at >= ? AND call_started_at <= ?
            ${outboundCampaignFilter}
            ORDER BY call_started_at DESC
            LIMIT ?
          )
          UNION ALL
          (
            SELECT campaign_id, caller_id_number AS phone_number, call_id, call_started_at, agent_user, 'inbound' AS direction, wait_seconds
            FROM cmx_dialer.inbound_call_log
            WHERE call_started_at >= ? AND call_started_at <= ?
            ${inboundCampaignFilter}
            ORDER BY call_started_at DESC
            LIMIT ?
          )
        ) combined
        LEFT JOIN (
          SELECT related_call_id, SUM(duration_seconds) AS handle_time_seconds
          FROM cmx_dialer.agent_status_log
          WHERE related_call_id IS NOT NULL AND ended_at IS NOT NULL
          GROUP BY related_call_id
        ) agg ON agg.related_call_id = combined.call_id
        LEFT JOIN cmx_dialer.app_users au ON au.vicidial_user = combined.agent_user
        ORDER BY combined.call_started_at DESC
        LIMIT ${PER_DIRECTION_LIMIT * 2}
      `,
      [...outboundParams, ...inboundParams]
    );

    const calls = rows.map((r) => ({
      campaignId: r.campaign_id,
      phoneNumber: r.phone_number,
      callStartedAt: r.call_started_at,
      direction: r.direction,
      // Only meaningful for inbound (NULL for outbound, per the union
      // above) — how long the caller waited before reaching this
      // agent. Already computed and persisted on inbound_call_log at
      // disposition time (see inboundCallService.js), just wasn't
      // being selected here until now.
      waitSeconds: r.wait_seconds,
      handleTimeSeconds: r.handle_time_seconds,
      // Falls back to the raw vicidial_user if the app_users join
      // doesn't resolve (e.g. an agent account since deleted) — same
      // "agent_name || agent_user" fallback pattern already used by
      // getRawCallsReport() elsewhere in this file, for consistency.
      agentName: r.agent_name || r.agent_user || null,
    }));

    return res.json({ success: true, calls });
  } catch (error) {
    console.error("GET /api/admin/total-calls failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load total calls." });
  }
});

/*
==================================================
AGGREGATE STATS (everyone, optionally filtered by campaign)
==================================================
GET /api/admin/stats/today?campaignId=optional
==================================================
*/
router.get("/stats/today", requireAdmin, async (req, res) => {
  try {
    const { campaignId } = req.query;
    const stats = await statsService.getTodayStatsAggregate(campaignId || null);
    return res.json({ success: true, stats });
  } catch (error) {
    console.error("GET /api/admin/stats/today failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load aggregate stats." });
  }
});

/*
==================================================
REPORTING SUMMARY (Inbound / Outbound KPI cards)
==================================================
GET /api/admin/reporting-summary?campaignId=optional
==================================================
*/
router.get(
  "/reporting-summary",
  requireRoles("supervisor", "training_quality", "account_manager", "wfm", "admin"),
  requireCampaignAccess,
  async (req, res) => {
  try {
    const { campaignId } = req.query;
    const summary = await statsService.getReportingSummary(campaignId || null);
    return res.json({ success: true, summary });
  } catch (error) {
    console.error("GET /api/admin/reporting-summary failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load reporting summary." });
  }
});

/*
==================================================
REPORTS — campaign-level down to agent-level breakdown (from
production, Phase 8)
==================================================
GET /api/admin/reports/campaign-agent-breakdown?startDate=yyyy-MM-dd&endDate=yyyy-MM-dd&campaignId=optional

startDate/endDate are required (both inclusive, interpreted as
America/New_York calendar days — same self-calibrating boundary
technique used everywhere else in this app). campaignId is optional
("All Campaigns" = no filter). See statsService.getCampaignAgentBreakdown
for the actual aggregation.

NOTE: statsService.getCampaignAgentBreakdown itself needs to be pulled
in from production too (backend/services/statsService.js) — this route
alone won't work without that corresponding function existing.
==================================================
*/
router.get(
  "/reports/campaign-agent-breakdown",
  requireRoles("supervisor", "account_manager", "wfm", "admin"),
  resolveCampaignScope,
  async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, message: "startDate and endDate query params are required." });
    }

    const report = await statsService.getCampaignAgentBreakdown({
      startDate,
      endDate,
      campaignIds: req.campaignScope,
    });
    return res.json({ success: true, report });
  } catch (error) {
    console.error("GET /api/admin/reports/campaign-agent-breakdown failed:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to load report." });
  }
});

/*
==================================================
GET /api/admin/reports/raw-calls?startDate=&endDate=&campaignId=optional
==================================================
Second report type, per explicit request — "Raw Data for inbound and
outbound calls (combined)", alongside the existing aggregated
breakdown above. Returns one row PER CALL (not aggregated at all),
combining dialer_call_log (outbound) and inbound_call_log (inbound)
via UNION ALL, same pattern already used for GET /recordings and
GET /total-calls.

UPDATED — per explicit follow-up request, each row now also includes:
- Contact first/last name (straight from the call-log tables — both
  already have these columns).
- Talk time, hold time, ACW time, and handle time ("AHT" per the
  request's own wording, even though it's a per-CALL value here, not
  an average — labeled that way in the CSV/table to match what was
  asked for) — these do NOT exist as columns on either call-log table
  at all. They're derived from cmx_dialer.agent_status_log, the SAME
  source and SAME segment-summing logic already used (and already
  bug-fixed once) in computeDirectionStats above — status IN
  ('IN_CALL','ON_HOLD','AFTER_CALL_WORK'), grouped by related_call_id,
  summed per call. Reusing that exact definition here rather than
  inventing a second, potentially-inconsistent one — this app already
  had a real, confirmed bug once from two different AHT definitions
  disagreeing with each other.

Same role gate + requireCampaignAccess as the aggregated report —
"the data to be downloaded must also be filtered based on the user's
assigned campaigns, except WFM and Admin" is enforced by
requireCampaignAccess here exactly the same way it already is for the
aggregated report and every Live Dashboard endpoint: campaignId is
REQUIRED and must be one of the caller's real assignments for every
role except wfm/admin, checked server-side regardless of what the
frontend sends.

Uses the same Eastern-timezone day-bounds resolution as the aggregated
report (getEasternRangeBoundsForServerClock) so both report types
agree on what "startDate to endDate" actually means in real server
time — these previously disagreeing between different report/stats
functions was a real bug found and fixed elsewhere in this app
(see computeDirectionStats's own comment).
==================================================
*/
router.get(
  "/reports/raw-calls",
  requireRoles("supervisor", "account_manager", "wfm", "admin"),
  resolveCampaignScope,
  async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      if (!startDate || !endDate) {
        return res.status(400).json({ success: false, message: "startDate and endDate query params are required." });
      }

      const { start, end } = await statsService.getEasternRangeBoundsForServerClock(startDate, endDate);
      const campaignIds = req.campaignScope; // null = truly unrestricted (admin/wfm "All"), array = one or more specific campaigns

      const params = [start, end];
      let campaignFilter = "";
      if (campaignIds && campaignIds.length > 0) {
        campaignFilter = `AND combined.campaign_id IN (${campaignIds.map(() => "?").join(",")})`;
        params.push(...campaignIds);
      }

      const [rows] = await db.execute(
        `
          SELECT combined.call_id, combined.campaign_id, combined.agent_user, au.full_name AS agent_name,
                 combined.phone_number, combined.first_name, combined.last_name,
                 combined.call_started_at, combined.call_ended_at,
                 combined.direction, combined.disposition, combined.comments, combined.wait_seconds,
                 combined.xfer_conf, combined.xfer_conf_target
          FROM (
            SELECT
              d.call_id, d.campaign_id, d.agent_user, d.phone_number, d.first_name, d.last_name,
              d.call_started_at, d.call_ended_at, 'outbound' AS direction,
              d.disposition, d.comments, NULL AS wait_seconds, d.xfer_conf, d.xfer_conf_target
            FROM cmx_dialer.dialer_call_log d

            UNION ALL

            SELECT
              i.call_id, i.campaign_id, i.agent_user, i.caller_id_number AS phone_number, i.first_name, i.last_name,
              i.call_started_at, i.call_ended_at, 'inbound' AS direction,
              i.disposition, i.comments, i.wait_seconds, i.xfer_conf, i.xfer_conf_target
            FROM cmx_dialer.inbound_call_log i
          ) combined
          LEFT JOIN cmx_dialer.app_users au ON au.vicidial_user = combined.agent_user
          WHERE combined.call_started_at >= ? AND combined.call_started_at <= ? ${campaignFilter}
          ORDER BY combined.call_started_at DESC
        `,
        params
      );

      // Per-call talk/hold/ACW — same segment-aggregation query as
      // computeDirectionStats, just not scoped to one direction/agent
      // at a time since this report already combines both directions
      // in one pass. Bounded by the same date range (and campaign
      // scope, via related_campaign_id) as the raw call rows above.
      const segParams = [start, end];
      let segCampaignFilter = "";
      if (campaignIds && campaignIds.length > 0) {
        segCampaignFilter = `AND related_campaign_id IN (${campaignIds.map(() => "?").join(",")})`;
        segParams.push(...campaignIds);
      }
      const [segRows] = await db.execute(
        `
          SELECT related_call_id, status, SUM(duration_seconds) AS seg_seconds
          FROM cmx_dialer.agent_status_log
          WHERE status IN ('IN_CALL', 'ON_HOLD', 'AFTER_CALL_WORK')
            AND ended_at IS NOT NULL
            AND related_call_id IS NOT NULL
            AND started_at BETWEEN ? AND ?
            ${segCampaignFilter}
          GROUP BY related_call_id, status
        `,
        segParams
      );

      const segByCallId = new Map();
      for (const r of segRows) {
        // Same STRING-vs-NUMBER coercion fix already applied in
        // computeDirectionStats — mysql2 returns SUM() as a string.
        const segSeconds = Number(r.seg_seconds) || 0;
        const entry = segByCallId.get(r.related_call_id) || { talk: 0, hold: 0, acw: 0 };
        if (r.status === "IN_CALL") entry.talk += segSeconds;
        else if (r.status === "ON_HOLD") entry.hold += segSeconds;
        else if (r.status === "AFTER_CALL_WORK") entry.acw += segSeconds;
        segByCallId.set(r.related_call_id, entry);
      }

      const calls = rows.map((row) => {
        const seg = segByCallId.get(row.call_id) || { talk: 0, hold: 0, acw: 0 };
        return {
          ...row,
          talk_seconds: seg.talk,
          hold_seconds: seg.hold,
          acw_seconds: seg.acw,
          aht_seconds: seg.talk + seg.hold + seg.acw,
        };
      });

      return res.json({ success: true, calls });
    } catch (error) {
      console.error("GET /api/admin/reports/raw-calls failed:", error);
      return res.status(500).json({ success: false, message: error.message || "Failed to load raw call data." });
    }
  }
);

/*
==================================================
LEADS CALLING DASHBOARD — NEW, per explicit request
==================================================
Role gate: same set as the other Reports-family endpoints
(supervisor, account_manager, wfm, admin) — this dashboard is a
reporting view over lead-calling activity, not a dialing/admin action,
so it follows Reports' access matrix rather than inventing a new one.
Adjust LEADS_DASHBOARD_ROLES below if the business wants a different
split later.
==================================================
*/
const LEADS_DASHBOARD_ROLES = ["supervisor", "account_manager", "wfm", "admin"];

/*
GET /api/admin/leads-dashboard/campaigns
Campaign picker for the dashboard — OUTBOUND campaigns that actually
have leads uploaded, scoped to the caller's own assignments for every
role except admin/wfm (same "not just hidden in the dropdown, enforced
server-side" principle used everywhere else in this file).
*/
router.get("/leads-dashboard/campaigns", requireRoles(...LEADS_DASHBOARD_ROLES), async (req, res) => {
  try {
    const { accessLevel, appUserId } = req.session.agent;
    const scopeCampaignIds = UNRESTRICTED_CAMPAIGN_ROLES.includes(accessLevel)
      ? null
      : await getAssignedCampaignIds(appUserId);

    const campaigns = await statsService.getLeadsCampaignsWithLeads(scopeCampaignIds);
    return res.json({ success: true, campaigns });
  } catch (error) {
    console.error("GET /api/admin/leads-dashboard/campaigns failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load campaigns." });
  }
});

/*
GET /api/admin/leads-dashboard/summary?startDate=yyyy-MM-dd&endDate=yyyy-MM-dd&campaignIds=A,B,C

campaignIds is a comma-separated list — the frontend's "select all
outbound campaigns" checkbox resolves to every id from the /campaigns
endpoint above and sends them all explicitly here; resolveCampaignScopeMulti
re-validates that list (or fills in the caller's full assignment set if
omitted) server-side regardless of what the UI sent.

Returns cards/chart data (per-campaign + grand totals) and the
per-agent aggregated table in one response — see
statsService.getLeadsCallingDashboard for the actual metric
definitions (Contact Rate, Connect Rate, Remaining Leads).
*/
router.get(
  "/leads-dashboard/summary",
  requireRoles(...LEADS_DASHBOARD_ROLES),
  resolveCampaignScopeMulti,
  async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      if (!startDate || !endDate) {
        return res.status(400).json({ success: false, message: "startDate and endDate query params are required." });
      }

      // req.campaignScope (from resolveCampaignScopeMulti) is either
      // null (admin/wfm, no explicit selection -> truly unrestricted)
      // or an array (an explicit selection, or a scoped role's own
      // assignment list as the "All" default) — in EVERY case, run it
      // back through getLeadsCampaignsWithLeads so the dashboard only
      // ever operates on OUTBOUND campaigns that actually have leads
      // right now, never a leadless/blended campaign a scoped role
      // happens to also be assigned to. This is also what turns
      // admin/wfm's null ("All") into a real id list, since
      // getLeadsCallingDashboard itself requires a concrete array —
      // see that function's own header comment for why it never
      // treats an empty/missing campaignIds as "everything".
      const eligibleCampaigns = await statsService.getLeadsCampaignsWithLeads(req.campaignScope);
      const campaignIds = eligibleCampaigns.map((c) => c.campaignId);

      const dashboard = await statsService.getLeadsCallingDashboard({ startDate, endDate, campaignIds });
      return res.json({ success: true, dashboard });
    } catch (error) {
      console.error("GET /api/admin/leads-dashboard/summary failed:", error);
      return res.status(500).json({ success: false, message: error.message || "Failed to load leads calling dashboard." });
    }
  }
);

/*
==================================================
GET /api/admin/reports/abandoned-calls-aggregated?startDate=&endDate=&campaignId=optional
==================================================
Third report type, per explicit request — "Abandoned calls
(aggregated/raw data)" in the Reports section, alongside the existing
call-based reports above. This is the aggregated half: per-campaign
totals (count, broken down by abandon_reason — see
inboundCallService.js's own comment on that column for what
NEVER_MATCHED vs AGENT_RINGING_NO_ANSWER actually mean — plus average
wait time), with a grand-total row across every campaign in scope.

Same role gate + resolveCampaignScope + Eastern-day-bounds resolution
as both call reports above, for the same reasons already documented
there — one shared definition of "startDate to endDate" and "which
campaigns this caller is allowed to see," not a second one invented
for this report specifically.

unknownReasonCount exists for rows logged BEFORE abandon_reason existed
at all (NULL on that column) — shown separately rather than silently
folded into either real category, since a NULL genuinely isn't known
to be either one.
==================================================
*/
router.get(
  "/reports/abandoned-calls-aggregated",
  requireRoles("supervisor", "account_manager", "wfm", "admin"),
  resolveCampaignScope,
  async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      if (!startDate || !endDate) {
        return res.status(400).json({ success: false, message: "startDate and endDate query params are required." });
      }

      const { start, end } = await statsService.getEasternRangeBoundsForServerClock(startDate, endDate);
      const campaignIds = req.campaignScope; // null = truly unrestricted (admin/wfm "All"), array = one or more specific campaigns

      const params = [start, end];
      let campaignFilter = "";
      if (campaignIds && campaignIds.length > 0) {
        campaignFilter = `AND acl.campaign_id IN (${campaignIds.map(() => "?").join(",")})`;
        params.push(...campaignIds);
      }

      const [rows] = await db.execute(
        `
          SELECT
            acl.campaign_id, c.campaign_name,
            COUNT(*) AS total_abandoned,
            SUM(CASE WHEN acl.abandon_reason = 'NEVER_MATCHED' THEN 1 ELSE 0 END) AS never_matched_count,
            SUM(CASE WHEN acl.abandon_reason = 'AGENT_RINGING_NO_ANSWER' THEN 1 ELSE 0 END) AS agent_ringing_no_answer_count,
            SUM(CASE WHEN acl.abandon_reason IS NULL THEN 1 ELSE 0 END) AS unknown_reason_count,
            AVG(acl.wait_seconds) AS avg_wait_seconds
          FROM cmx_dialer.abandoned_call_log acl
          LEFT JOIN asterisk.vicidial_campaigns c ON c.campaign_id = acl.campaign_id
          WHERE acl.call_started_at >= ? AND acl.call_started_at <= ? ${campaignFilter}
          GROUP BY acl.campaign_id, c.campaign_name
          ORDER BY total_abandoned DESC
        `,
        params
      );

      const campaigns = rows.map((r) => ({
        campaignId: r.campaign_id,
        campaignName: r.campaign_name,
        totalAbandoned: Number(r.total_abandoned) || 0,
        neverMatchedCount: Number(r.never_matched_count) || 0,
        agentRingingNoAnswerCount: Number(r.agent_ringing_no_answer_count) || 0,
        unknownReasonCount: Number(r.unknown_reason_count) || 0,
        avgWaitSeconds: r.avg_wait_seconds !== null ? Math.round(Number(r.avg_wait_seconds)) : null,
      }));

      const grandTotals = campaigns.reduce(
        (acc, c) => {
          acc.totalAbandoned += c.totalAbandoned;
          acc.neverMatchedCount += c.neverMatchedCount;
          acc.agentRingingNoAnswerCount += c.agentRingingNoAnswerCount;
          acc.unknownReasonCount += c.unknownReasonCount;
          acc.totalWaitSeconds += (c.avgWaitSeconds || 0) * c.totalAbandoned;
          return acc;
        },
        { totalAbandoned: 0, neverMatchedCount: 0, agentRingingNoAnswerCount: 0, unknownReasonCount: 0, totalWaitSeconds: 0 }
      );
      const avgWaitSecondsOverall =
        grandTotals.totalAbandoned > 0 ? Math.round(grandTotals.totalWaitSeconds / grandTotals.totalAbandoned) : null;

      return res.json({
        success: true,
        report: {
          campaigns,
          grandTotals: {
            totalAbandoned: grandTotals.totalAbandoned,
            neverMatchedCount: grandTotals.neverMatchedCount,
            agentRingingNoAnswerCount: grandTotals.agentRingingNoAnswerCount,
            unknownReasonCount: grandTotals.unknownReasonCount,
            avgWaitSeconds: avgWaitSecondsOverall,
          },
        },
      });
    } catch (error) {
      console.error("GET /api/admin/reports/abandoned-calls-aggregated failed:", error);
      return res.status(500).json({ success: false, message: error.message || "Failed to load abandoned calls report." });
    }
  }
);

/*
==================================================
GET /api/admin/reports/abandoned-calls-raw?startDate=&endDate=&campaignId=optional
==================================================
Fourth report type — the raw-data half of the same request. One row
per abandoned call, no aggregation, no LIMIT (same "a report should
return everything in the requested range" convention as
/reports/raw-calls above — this app's other abandoned-call reads
elsewhere, like the Live Status Dashboard and DialerPage's own tab,
deliberately cap at 200 since those are live "today" views, not
historical exports; a report has no reason to share that cap).

Does NOT yet include which agent was ringing for an
AGENT_RINGING_NO_ANSWER row — that requires the ringing_agent_user_id
column (see sql/006_add_ringing_agent_user_id.sql), which is a
separate, not-yet-applied migration as of this route being written.
Once that migration and its accompanying code are live, this query can
be extended with a LEFT JOIN to app_users the same way
getAbandonedCallsToday already does.
==================================================
*/
router.get(
  "/reports/abandoned-calls-raw",
  requireRoles("supervisor", "account_manager", "wfm", "admin"),
  resolveCampaignScope,
  async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      if (!startDate || !endDate) {
        return res.status(400).json({ success: false, message: "startDate and endDate query params are required." });
      }

      const { start, end } = await statsService.getEasternRangeBoundsForServerClock(startDate, endDate);
      const campaignIds = req.campaignScope;

      const params = [start, end];
      let campaignFilter = "";
      if (campaignIds && campaignIds.length > 0) {
        campaignFilter = `AND acl.campaign_id IN (${campaignIds.map(() => "?").join(",")})`;
        params.push(...campaignIds);
      }

      const [rows] = await db.execute(
        `
          SELECT
            acl.abandoned_call_log_id, acl.campaign_id, c.campaign_name, acl.caller_id_number,
            acl.call_started_at, acl.call_ended_at, acl.wait_seconds, acl.abandon_reason
          FROM cmx_dialer.abandoned_call_log acl
          LEFT JOIN asterisk.vicidial_campaigns c ON c.campaign_id = acl.campaign_id
          WHERE acl.call_started_at >= ? AND acl.call_started_at <= ? ${campaignFilter}
          ORDER BY acl.call_started_at DESC
        `,
        params
      );

      const calls = rows.map((r) => ({
        abandonedCallLogId: r.abandoned_call_log_id,
        campaignId: r.campaign_id,
        campaignName: r.campaign_name,
        callerIdNumber: r.caller_id_number,
        callStartedAt: r.call_started_at,
        callEndedAt: r.call_ended_at,
        waitSeconds: r.wait_seconds,
        abandonReason: r.abandon_reason,
      }));

      return res.json({ success: true, calls });
    } catch (error) {
      console.error("GET /api/admin/reports/abandoned-calls-raw failed:", error);
      return res.status(500).json({ success: false, message: error.message || "Failed to load raw abandoned call data." });
    }
  }
);

/*
==================================================
GET /api/admin/call-flags?startDate=&endDate=&campaignId=optional
==================================================
NEW — "Calls Flagged", per explicit request: surfaces every row from
cmx_dialer.call_flags — every instance of an agent clicking Hang Up
while the customer was still actively connected, across both inbound
and outbound calls (see dialerService.js's endCall() and
dialerRoutes.js's own inbound end-call route, the two places that
actually write these rows). A real, raw signal for investigating
possible call avoidance — this route only surfaces the data; judgment
about whether any given row represents genuine avoidance happens on
the human review side.

Restricted to admin/wfm ONLY, per explicit request — reuses
requireAdmin exactly as-is (already admin+wfm, nothing else), the same
gate every other admin/wfm-only action in this file already uses.

startDate/endDate default to today (same self-calibrating Eastern
day-bounds technique used everywhere else in this app) if not given.
campaignId is optional — omitted means every campaign, matching the
"campaignId ? filter : no filter" convention already used throughout
this file and statsService.js.
==================================================
*/
router.get("/call-flags", requireAdmin, async (req, res) => {
  try {
    const { startDate, endDate, campaignId } = req.query;
    const { start, end } =
      startDate && endDate
        ? await statsService.getEasternRangeBoundsForServerClock(startDate, endDate)
        : await statsService.getEasternDayBoundsForServerClock();

    const params = [start, end];
    let campaignFilter = "";
    if (campaignId) {
      campaignFilter = "AND cf.campaign_id = ?";
      params.push(campaignId);
    }

    const [rows] = await db.execute(
      `
        SELECT
          cf.flag_id, cf.call_id, cf.direction, cf.agent_user, au.full_name AS agent_name,
          cf.campaign_id, c.campaign_name, cf.phone_number, cf.call_started_at,
          cf.call_duration_seconds, cf.flagged_at
        FROM cmx_dialer.call_flags cf
        LEFT JOIN cmx_dialer.app_users au ON au.vicidial_user = cf.agent_user
        LEFT JOIN asterisk.vicidial_campaigns c ON c.campaign_id = cf.campaign_id
        WHERE cf.flagged_at >= ? AND cf.flagged_at <= ? ${campaignFilter}
        ORDER BY cf.flagged_at DESC
        LIMIT 500
      `,
      params
    );

    const flags = rows.map((r) => ({
      flagId: r.flag_id,
      callId: r.call_id,
      direction: r.direction,
      agentUser: r.agent_user,
      agentName: r.agent_name || r.agent_user,
      campaignId: r.campaign_id,
      campaignName: r.campaign_name || r.campaign_id,
      phoneNumber: r.phone_number,
      callStartedAt: r.call_started_at,
      callDurationSeconds: r.call_duration_seconds,
      flaggedAt: r.flagged_at,
    }));

    return res.json({ success: true, flags });
  } catch (error) {
    console.error("GET /api/admin/call-flags failed:", error);
    return res.status(500).json({ success: false, message: "Failed to load call flags." });
  }
});

module.exports = router;