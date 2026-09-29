"use strict";

const ami = require("../config/ami");
const db = require("../config/db");
const agentStatusService = require("./agentStatusService");

/*
==================================================
microsipOutboundService — Phase 8
==================================================
Detects when an agent places an outbound call DIRECTLY from their
MicroSIP softphone — completely bypassing this app's own dialer/AMI
Originate flow — and reflects that on the Live Status Dashboard as
MICROSIP_OUTBOUND, then restores their PRIOR status once that call
ends. No disposition step — explicit product decision: these calls
don't get the same "disposition required" treatment regular outbound
calls do. The one thing that DOES carry over automatically, with no
extra code needed: while status is MICROSIP_OUTBOUND (not READY),
inboundCallService's agent-matching (getAnyReadyAgentWithExtension,
which only ever looks for status = 'READY') already can't route an
inbound call to them — that's a natural side effect of the status
change itself, not a separate mechanism.

Per explicit product decision: restoring to READY only happens if
READY is genuinely what they were in right before the call started.
Any other prior status (NOT_READY, AD_HOC, ON_HOLD, LUNCH_BREAK,
BIO_BREAK, ADMIN, MEETING, TRAINING, or no open
status row at all) is left as it was / restored as-is — this must
never be the thing that silently pulls someone back into the queue.

==================================================
HOW APP-ORIGINATED VS MICROSIP-DIRECT ARE TOLD APART
==================================================
Every agent-leg channel THIS APP originates (see dialerService.js:
ami.originate({ Channel: `PJSIP/${agentExtension}`, Context: "default",
Exten: `2${room}`, ... })) always lands in the dialplan at
Context "default", Exten matching "2<room>" — that's the app's own,
fully-controlled convention for where the agent leg goes once answered.

A MicroSIP-direct call is the agent's OWN phone placing a call outward
on its own — it lands wherever THAT PJSIP endpoint's own dialplan
routing sends it, which will not match "default" + "2<room>".

*** VERIFY THIS ON THE SERVER BEFORE TRUSTING IT IN PRODUCTION ***
The APP_ORIGINATED_* constants below are confirmed correct (read
straight out of dialerService.js). What's NOT yet confirmed is what
context/exten a real MicroSIP-direct call actually lands in — this
code's entire correctness rests on "not the app's own pattern"
reliably meaning "must be MicroSIP-direct." That's true as long as
nothing else in the system ever originates a call to an agent's PJSIP
endpoint under Context "default" with an Exten matching "2<digits>"
for any other reason. Confirm with ONE real test call (have an agent
dial an outside number directly from MicroSIP) and check that
Newchannel event's context/exten in the Asterisk full log before
relying on this.
==================================================
*/

const APP_ORIGINATED_CONTEXT = "default";
const APP_ORIGINATED_EXTEN_PATTERN = /^2\d+$/; // matches "2<room>", e.g. "29700929"

// REAL BUG FIX, per explicit request — confirmed live: a supervisor
// using Silent Listen (monitoringService.js) was getting their own
// status flipped to MICROSIP_OUTBOUND ("Microsip Call" on the Live
// Status Dashboard) for the entire duration of their listening
// session. Root cause: monitoringService.js originates its own
// channel via Application: "ConfBridge" directly, never touching
// Context/Exten at all — so it doesn't match
// APP_ORIGINATED_CONTEXT/APP_ORIGINATED_EXTEN_PATTERN below any more
// than a genuine MicroSIP-direct call does, tripping the exact same
// "must be MicroSIP-direct" detection this whole file exists for.
// Recognized instead by the same distinctive CallerID
// monitoringService.js already sets on that Originate specifically so
// PhoneContext.jsx can auto-answer it — reused here for the opposite
// purpose: telling this detector "this is OUR OWN app calling the
// supervisor, ignore it," the same way APP_ORIGINATED_CONTEXT/
// APP_ORIGINATED_EXTEN_PATTERN already tell it "this is our own app
// calling an AGENT, ignore it" for regular calls. Per explicit
// product decision, a supervisor's status is left completely
// untouched while Silent Listening — no separate "Live Monitoring"
// status was wanted, just "don't misreport this as something else."
const SILENT_LISTEN_CALLERID_NAME = "VoxSuite Silent Listen"; // must match monitoringService.js

// AMI channel name -> { appUserId, priorStatus }
// priorStatus is null if the agent had no open status row at all right
// before this call (e.g. some out-of-band edge case) — handleHangup
// leaves status alone entirely in that case rather than inventing one.
const pendingMicrosipCalls = new Map();

// extension (e.g. "bsmsc905") -> { appUserId, vicidialUser }
let extensionMap = new Map();
let extensionMapLoadedAt = 0;
const EXTENSION_MAP_TTL_MS = 60 * 1000;

async function loadExtensionMap() {
  const [rows] = await db.execute(`
    SELECT p.extension, au.app_user_id, au.vicidial_user
    FROM asterisk.phones p
    JOIN asterisk.vicidial_users vu ON vu.phone_login = p.login
    JOIN cmx_dialer.app_users au ON au.vicidial_user = vu.user
    WHERE vu.active = 'Y'
  `);
  const map = new Map();
  for (const row of rows) {
    map.set(row.extension, { appUserId: row.app_user_id, vicidialUser: row.vicidial_user });
  }
  extensionMap = map;
  extensionMapLoadedAt = Date.now();
}

async function getAgentByExtension(extension) {
  if (Date.now() - extensionMapLoadedAt > EXTENSION_MAP_TTL_MS) {
    await loadExtensionMap().catch((err) => {
      console.error("[microsipOutboundService] Failed to refresh extension map:", err);
    });
  }
  return extensionMap.get(extension) || null;
}

function extractExtensionFromChannel(channelName) {
  // PJSIP channel names look like "PJSIP/<endpoint>-00000123".
  const match = /^PJSIP\/([^-]+)-/.exec(channelName || "");
  return match ? match[1] : null;
}

async function handleNewchannel(evt) {
  const extension = extractExtensionFromChannel(evt.channel);
  if (!extension) return;

  const agent = await getAgentByExtension(extension);
  if (!agent) return; // not a known agent extension — ignore (trunk/Local/etc. channels)

  const isAppOriginatedAgentLeg =
    evt.context === APP_ORIGINATED_CONTEXT && APP_ORIGINATED_EXTEN_PATTERN.test(evt.exten || "");
  if (isAppOriginatedAgentLeg) return; // this app rang their phone itself — not a direct MicroSIP call

  if (evt.calleridname === SILENT_LISTEN_CALLERID_NAME) return; // this app rang them for Silent Listen — not a direct MicroSIP call either

  try {
    const current = await agentStatusService.getCurrentStatus(agent.appUserId);
    const priorStatus = current ? current.status : null;

    // Don't reprocess an agent already mid-call (app-tracked, or a
    // MICROSIP_OUTBOUND call already in progress) — multiple Newchannel
    // events can fire for further legs of what's really the same call.
    if (priorStatus === "IN_CALL" || priorStatus === "ON_HOLD" || priorStatus === "AFTER_CALL_WORK" || priorStatus === "MICROSIP_OUTBOUND") {
      return;
    }

    pendingMicrosipCalls.set(evt.channel, { appUserId: agent.appUserId, priorStatus });

    await agentStatusService.setStatus(agent.appUserId, "MICROSIP_OUTBOUND", {
      relatedCallDirection: "outbound",
    });

    console.log(
      `[microsipOutboundService] Direct MicroSIP outbound detected for ${agent.vicidialUser} ` +
      `(channel ${evt.channel}) — was ${priorStatus || "logged out / no open status"}.`
    );
  } catch (err) {
    console.error("[microsipOutboundService] Failed to set MICROSIP_OUTBOUND status:", err);
  }
}

async function handleHangup(evt) {
  const pending = pendingMicrosipCalls.get(evt.channel);
  if (!pending) return;

  pendingMicrosipCalls.delete(evt.channel);

  try {
    const restoreTo = pending.priorStatus;
    if (!restoreTo) {
      // No open status row existed before this call — nothing sensible
      // to restore to. Leave MICROSIP_OUTBOUND as the last real record
      // rather than inventing a status (e.g. forcing READY) for them.
      return;
    }

    await agentStatusService.setStatus(pending.appUserId, restoreTo);
    console.log(
      `[microsipOutboundService] MicroSIP call ended (channel ${evt.channel}) — ` +
      `restored app_user_id ${pending.appUserId} to ${restoreTo}.`
    );
  } catch (err) {
    console.error("[microsipOutboundService] Failed to restore status after MicroSIP call:", err);
  }
}

function start() {
  ami.events.on("Newchannel", handleNewchannel);
  ami.events.on("Hangup", handleHangup);
  loadExtensionMap().catch((err) => {
    console.error("[microsipOutboundService] Initial extension map load failed:", err);
  });
  console.log("[microsipOutboundService] Listening for direct MicroSIP outbound calls.");
}

module.exports = { start };