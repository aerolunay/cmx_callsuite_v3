"use strict";

const crypto = require("crypto");
const { execFile } = require("child_process");
const util = require("util");
const ami = require("../config/ami");
const ws = require("../config/ws");
const db = require("../config/db");
const agentStatusService = require("./agentStatusService");
const recordingUploadService = require("./recordingUploadService");

const execFileAsync = util.promisify(execFile);
const { transporter } = require("../config/mailer");
const { buildVoicemailNotificationEmail } = require("./emailTemplates");

/*
==================================================
INBOUND CALL SERVICE — v2 (multi-call)
==================================================
Bypasses ViciDial's own agi-DID_route.agi / Inbound Group / IVR
routing entirely (see the dialplan changes: each inbound DID Answers +
allocates a room via the /internal/allocate-inbound-room endpoint,
then ConfBridges the caller into THAT room — never reaching ViciDial's
AGI script).

REPLACES v1's single fixed room (9700000, only one concurrent inbound
call system-wide). This version allocates a fresh room per call from a
9700XXX pool (mirrors dialerService.js's allocateRoomSuffix() pattern
for outbound), so multiple callers can wait/connect at once without
ever sharing a ConfBridge with a stranger.

UPDATED — DID-to-campaign lookup is now DB-backed, not hardcoded.
Previously this was a hardcoded DID_TO_CAMPAIGN object literal, which
meant a brand-new campaign's DID would silently fail
(allocateInboundRoom would throw "No campaign configured for DID") until
someone edited this file and redeployed the backend. Now reads
asterisk.vicidial_inbound_dids directly (did_pattern -> campaign_id) —
the same real, native ViciDial table campaignRoutes.js writes a row
into when a campaign is created. Still bypasses ViciDial's own
AGI/Ingroup routing entirely — this only reads did_pattern/campaign_id/
did_active from that table, nothing else.

VOICEMAIL FEATURE — a voicemail-enabled campaign's caller is NOT put
straight into the ConfBridge the way every other campaign's caller is.
Instead the dialplan holds them in a wait-loop extension (MOH + a
periodic "press 1 for voicemail" prompt) and calls
customerEnteredWaitLoop() below the moment they arrive there — before
any ConfbridgeJoin event could possibly exist for them. The new
call.customerInConfBridge flag (default true, for every existing
non-voicemail campaign's unchanged direct-ConfBridge path) tracks
whether this particular caller's channel is actually inside the room's
ConfBridge yet; tryConnectReadyAgentsInner uses it to decide whether it
needs to actively AMI-redirect the caller in before originating the
agent leg — same redirectChannel() mechanism holdInboundCall/
unholdInboundCall already use for a totally different reason (agent-
initiated hold).
==================================================
*/
async function lookupCampaignForDid(did) {
  const [rows] = await db.execute(
    `SELECT campaign_id FROM asterisk.vicidial_inbound_dids WHERE did_pattern = ? AND did_active = 'Y' LIMIT 1`,
    [did]
  );
  return rows.length > 0 ? rows[0].campaign_id : null;
}

/*
==================================================
ROOM ALLOCATION
==================================================
Mirrors dialerService.js's outbound allocator exactly — same "9700XXX,
3-digit suffix" shape, same in-memory Set, same single-Node-process
caveat (a second backend instance would not know about the other's
in-use rooms; move to a shared store if that ever changes).
==================================================
*/
// Same convention as emailTemplates.js's own FRONTEND_URL — kept as
// its own local constant here rather than importing it from that
// file (which doesn't export it), since it's a one-line env read.
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

const ROOM_PREFIX = "9700";
const usedRoomSuffixes = new Set();

function allocateRoomSuffix() {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const suffix = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
    if (!usedRoomSuffixes.has(suffix)) {
      usedRoomSuffixes.add(suffix);
      return suffix;
    }
  }
  throw new Error("No free inbound room numbers available (all 000-999 in use).");
}

function releaseRoomSuffix(suffix) {
  usedRoomSuffixes.delete(suffix);
}

function roomFromSuffix(suffix) {
  return `${ROOM_PREFIX}${suffix}`;
}

/*
==================================================
rekeyInboundCallRoom — new, for attended transfer (Line 2)
==================================================
inboundCalls is keyed by ROOM NUMBER, not callId (see inboundCalls.set
calls throughout this file) — unlike activeCalls in dialerService.js,
which is keyed by callId and therefore unaffected when a call's room
changes. Completing an attended transfer moves the customer (and the
call's own tracked room) from the original room into Line 2's private
room — without re-keying this Map, the call would become unreachable
under BOTH the old room (deleted) and the new one (never actually
stored there), breaking every later lookup (hold, hangup, disposition,
etc).
==================================================
*/
function rekeyInboundCallRoom(oldRoom, newRoom) {
  const call = inboundCalls.get(oldRoom);
  if (!call) return;
  inboundCalls.delete(oldRoom);
  call.room = newRoom;
  inboundCalls.set(newRoom, call);
}

/*
==================================================
RECORDING PATH — calls
==================================================
Same convention as dialerService.js's recordingPathForCall — kept as
its own small, duplicated helper here rather than a shared module,
since it's genuinely a one-line function and the two files don't
otherwise import from each other. What matters is that BOTH produce
the identical path format for the same callId, so the later S3 upload
step can find either an inbound or outbound recording the same way,
regardless of which file actually managed that call.
==================================================
*/
const RECORDING_DIR = "/var/spool/asterisk/monitor";
function recordingPathForCall(callId) {
  return `${RECORDING_DIR}/${callId}.wav`;
}

// Separate spool dir for voicemail captures (Record(), not
// MixMonitor) — kept apart from call recordings above so a voicemail
// file is never confused with an in-progress call recording during
// cleanup/inspection. Must match VOICEMAIL_SPOOL_DIR in
// campaignRoutes.js's dialplan generator exactly.
const VOICEMAIL_SPOOL_DIR = "/var/spool/asterisk/monitor/voicemail";
function voicemailRecordingPath(key) {
  return `${VOICEMAIL_SPOOL_DIR}/${key}.wav`;
}

// How long a pre-allocated room is allowed to sit with no customer
// ever actually joining it (e.g. the dialplan's CURL() succeeded but a
// later step failed) before it's released back to the pool. Without
// this, a run of failed calls could slowly exhaust the 1000-room pool
// with rooms nothing will ever occupy or clean up.
const UNCLAIMED_ROOM_TIMEOUT_MS = 30000;

/*
==================================================
IN-MEMORY CALL STATE
==================================================
Keyed by room (a call's room number is fixed for its whole lifetime,
unlike callId which is also fixed but less convenient for AMI event
lookups that only carry the room/conference name). Does NOT persist
across a process restart — same acceptable-for-now limitation as
dialerService.js's activeCalls Map.

Call shape:
  { callId, room, campaignId, status, customerChannel, agentChannel,
    callerIdNumber, pendingAppUserId, pendingAgentExtension,
    connectedAppUserId, onHold, startedAt, endedAt,
    customerInConfBridge }

status values: "awaiting_customer" (room allocated, dialplan CURL()
succeeded, caller not yet actually in the ConfBridge OR the voicemail
wait-loop) -> "waiting_for_agent" (caller joined the ConfBridge
directly, OR entered the voicemail wait-loop — either way, waiting) ->
"ringing_agent" -> "agent_connected" -> "ended" (stays in the Map, NOT
deleted, until the disposition is saved — same reasoning as v1: the
agent still needs caller info to fill out the intake form after the
call ends). "leaving_voicemail" is a voicemail-only branch off
"waiting_for_agent" — see markLeavingVoicemail below.
==================================================
*/
const inboundCalls = new Map();

/*
==================================================
AGENT_RING_TIMEOUT_MS
==================================================
Per explicit request, following a real production incident — a call
got permanently stuck showing "ringing your phone" to one specific
agent, seemingly forever (survived the agent logging out and back in,
since it's re-fetched fresh from this same in-memory state every time
— see getCurrentInboundCall). Root cause: the agent-leg Originate
below is fire-and-forget (Async: "true", no Timeout param, and nothing
listens for its eventual OriginateResponse) — the ONLY things that
were ever supposed to move a call out of "ringing_agent" were the
agent actually answering (ConfbridgeJoin, below) or the customer
hanging up (endInboundCall's own Hangup handling). If either of those
events is ever missed for any reason (a dropped AMI event, a restart
at exactly the wrong moment, etc.), NOTHING else was watching — the
call just sat there indefinitely, with no self-healing path at all.

This is a plain safety net, not the primary mechanism — every normal
call still resolves via ConfbridgeJoin/Hangup exactly as before, long
before this timer would ever fire. It only ever DOES anything on the
rare call that would otherwise have been stuck forever.
==================================================
*/
const AGENT_RING_TIMEOUT_MS = 30000; // 30 seconds — a real phone doesn't ring meaningfully longer than this before someone gives up either way

/*
==================================================
scheduleRingTimeout / clearRingTimeout
==================================================
The timer is stored ON THE CALL OBJECT ITSELF (call.ringTimeoutHandle)
so it can be found and cancelled from wherever the call naturally
resolves — MUST be cleared the moment a call leaves "ringing_agent"
through any other path (agent answers, customer hangs up, a later
retry re-rings a DIFFERENT agent), or a stale timer could fire late
and incorrectly reset a call that's already moved on to a completely
different state.
==================================================
*/
function scheduleRingTimeout(call, appUserId) {
  clearRingTimeout(call);
  call.ringTimeoutHandle = setTimeout(async () => {
    // Re-check everything at fire time, not just at schedule time —
    // this timer could have been superseded by a real resolution (or
    // even a brand new ring attempt for the SAME call, if a later
    // pass retried it) in the 30 seconds since it was scheduled.
    if (call.status !== "ringing_agent" || call.pendingAppUserId !== appUserId) return;

    console.warn(
      `[inboundCallService] Agent ring timed out after ${AGENT_RING_TIMEOUT_MS / 1000}s with no answer/hangup detected — releasing agent and retrying (callId=${call.callId}, room=${call.room}, appUserId=${appUserId}). This should be rare; see AGENT_RING_TIMEOUT_MS's own comment.`
    );

    try {
      await agentStatusService.setStatus(appUserId, "READY", { relatedCampaignId: call.campaignId });
    } catch (err) {
      console.error("[inboundCallService] Failed to return timed-out agent to READY:", err.message);
    }

    call.status = "waiting_for_agent";
    call.pendingAppUserId = null;
    call.pendingAgentExtension = null;
    call.ringTimeoutHandle = null;
    broadcastInboundStatus(call);

    // Immediately retry with a different agent, rather than waiting
    // for some other unrelated event to eventually trigger another
    // pass — a customer who's been waiting 30+ seconds shouldn't wait
    // any longer than necessary for a second attempt.
    tryConnectReadyAgents();
  }, AGENT_RING_TIMEOUT_MS);
}

function clearRingTimeout(call) {
  if (call.ringTimeoutHandle) {
    clearTimeout(call.ringTimeoutHandle);
    call.ringTimeoutHandle = null;
  }
}

function findByCallId(callId) {
  for (const call of inboundCalls.values()) {
    if (call.callId === callId) return call;
  }
  return null;
}

function broadcastInboundStatus(call) {
  const targetAppUserId = call.pendingAppUserId || call.connectedAppUserId;
  if (!targetAppUserId) return;

  ws.broadcastToUser(targetAppUserId, {
    type: "inboundCall",
    callId: call.callId,
    status: call.status,
    room: call.room,
    callerIdNumber: call.callerIdNumber,
    onHold: call.onHold,
    // NEW — per explicit request: DialerPage.jsx highlights which of
    // a multi-campaign agent's currently-selected campaigns this
    // specific call actually came from. Wasn't included before since
    // nothing needed it; call.campaignId has been tracked internally
    // this whole time, just never broadcast to the frontend.
    campaignId: call.campaignId,
  });
}

/*
==================================================
allocateInboundRoom(did)
==================================================
Called by internalRoutes.js the instant a call arrives, BEFORE the
caller is actually put in a ConfBridge (or, for a voicemail-enabled
campaign, the wait-loop) — the dialplan's CURL() needs a room number
back to build its own ConfBridge()/wait-loop lines. Pre-registers a
Map entry in "awaiting_customer" status so the eventual
ConfbridgeJoin/customerEnteredWaitLoop event (neither of which carry
campaign info on their own) has something to attach to.

NOW ASYNC — the DID-to-campaign lookup is a real DB query (see
lookupCampaignForDid above), not an in-memory object read anymore.
internalRoutes.js already awaits this correctly since its own route
handler is async.

Throws if the DID isn't found (or isn't active) in
asterisk.vicidial_inbound_dids — internalRoutes.js turns that into a
5xx, and the dialplan should treat an empty CURL() result as "no room
allocated" (see the dialplan snippet in the handoff notes).
==================================================
*/
async function allocateInboundRoom(did, campaignIdOverride) {
  // Per explicit request — outbound campaigns must never receive
  // inbound calls to their own agents. When their DID is configured
  // to redirect to a blended campaign instead (see campaignRoutes.js's
  // dialplan generation), the CALLER already knows which campaign
  // should actually receive this — skip the normal DID lookup
  // entirely rather than resolving back to the outbound campaign's
  // own (wrong) id.
  const campaignId = campaignIdOverride || (await lookupCampaignForDid(did));
  if (!campaignId) {
    throw new Error(`No active campaign found for DID "${did}" in asterisk.vicidial_inbound_dids.`);
  }

  const suffix = allocateRoomSuffix();
  const room = roomFromSuffix(suffix);

  const call = {
    callId: crypto.randomUUID(),
    room,
    campaignId,
    status: "awaiting_customer",
    customerChannel: null,
    agentChannel: null,
    callerIdNumber: null,
    pendingAppUserId: null,
    pendingAgentExtension: null,
    connectedAppUserId: null,
    onHold: false,
    ringTimeoutHandle: null, // see AGENT_RING_TIMEOUT_MS's own comment — the safety-net timer for the current ringing_agent attempt, if any
    startedAt: new Date(),
    endedAt: null,
    // Same reasoning as dialerService.js's callState — channels added
    // via Conference/Transfer, tracked separately from
    // customerChannel/agentChannel so endInboundCall() below knows not
    // to end the whole room out from under a still-connected third
    // party when the original agent hangs up.
    extraParticipants: [],
    lineTwo: null, // see attendedTransferService.js
    activeLine: 1, // which room the agent's OWN channel currently sits in — 1 or 2
    xferConfTarget: null, // set by attendedTransferService.js's completeLineTwo — read by the inbound disposition route in dialerRoutes.js
    // VOICEMAIL — true by default: every existing, non-voicemail
    // campaign's caller goes straight into the ConfBridge, so this is
    // already accurate the moment ConfbridgeJoin fires for them.
    // customerEnteredWaitLoop() is the only thing that ever sets this
    // to false, for a voicemail-enabled campaign's caller sitting in
    // the wait-loop extension instead.
    customerInConfBridge: true,
  };
  inboundCalls.set(room, call);

  setTimeout(() => {
    const current = inboundCalls.get(room);
    if (current && current.status === "awaiting_customer") {
      inboundCalls.delete(room);
      releaseRoomSuffix(suffix);
      console.warn(`[inboundCallService] Room ${room} never had a customer join within ${UNCLAIMED_ROOM_TIMEOUT_MS}ms — released back to the pool.`);
    }
  }, UNCLAIMED_ROOM_TIMEOUT_MS);

  return room;
}

/*
==================================================
customerEnteredWaitLoop(room, channel, callerIdNumber)
==================================================
NEW — voicemail feature. Called by internalRoutes.js's
/internal/customer-waiting route. Mirrors the "awaiting_customer" ->
"waiting_for_agent" transition ConfbridgeJoin normally does for a
non-voicemail campaign — except here the caller isn't in a ConfBridge
at all yet, they're in the dialplan's own MOH-then-Read() loop.
Idempotent: if this fires more than once for the same room
(defensive — the dialplan only calls it once per call, but a retried
CURL from Asterisk shouldn't cause harm), only the first call actually
changes anything.
==================================================
*/
function customerEnteredWaitLoop(room, channel, callerIdNumber) {
  const call = inboundCalls.get(room);
  if (!call) return false;
  if (call.status !== "awaiting_customer") return true; // already past this point, no-op

  call.customerChannel = channel;
  call.callerIdNumber = callerIdNumber || null;
  call.customerInConfBridge = false;
  call.status = "waiting_for_agent";
  broadcastInboundStatus(call);
  tryConnectReadyAgents();
  return true;
}

/*
==================================================
markLeavingVoicemail(room)
==================================================
NEW — voicemail feature. Called right before the dialplan's Record()
step starts, business-hours path only. Pulled OUT of
"waiting_for_agent" so tryConnectReadyAgentsInner's own filter
(status === "waiting_for_agent") stops matching this call to any
newly-ready agent — the caller has already committed to leaving a
message, an agent showing up now would have nothing to connect to.
==================================================
*/
function markLeavingVoicemail(room) {
  const call = inboundCalls.get(room);
  if (!call) return false;
  call.status = "leaving_voicemail";
  broadcastInboundStatus(call);
  return true;
}

/*
==================================================
recordVoicemail({ room, uniqueId, campaignId, callerIdNumber, isAfterHours })
==================================================
NEW — voicemail feature. Called once the caller has confirmed they're
satisfied with the recording (pressed 1 at the dialplan's confirmation
prompt, or timed out/pressed something unrecognized — deliberately
defaults to "save" rather than discarding a real caller's message on
ambiguous input; see campaignRoutes.js's dialplan generator for where
that default is actually applied). Two distinct cleanup paths:

- room present (business-hours path): the call has a real
  inboundCalls Map entry and an allocated 9700XXX room that must be
  released back to the pool, exactly like endInboundCall's own
  cleanup — done directly here rather than calling endInboundCall,
  since this is neither the "abandoned" nor the "normal agent-
  connected" outcome that function's two branches are built around.
- uniqueId present (after-hours path): no Map entry exists at all
  (after-hours voicemail never calls allocateInboundRoom) — nothing
  to clean up beyond the S3 upload + log insert.

RECORDING UPLOAD — uses recordingUploadService.js's dedicated
uploadVoicemailRecording/voicemailKeyForRecording pair (NOT
uploadRecording — that one is shaped for ConfbridgeStartRecord/
MixMonitor's auto-timestamped filenames, which Record() doesn't
produce; see that file's own comment on the distinction). Best-effort:
a failed S3 upload is logged, not thrown — the voicemail_log row still
gets written with a null recording_key rather than losing the whole
capture (campaign_id, caller ID, timestamps, duration) over an upload
hiccup. The local .wav file is left in place either way; this app has
no deletion capability against local recordings by explicit design
(same as call recordings — see uploadRecording's own comment).

DURATION — REAL BUG FIX, confirmed via a real test call: this used to
compute duration as (leftAt - callStartedAt), where callStartedAt fell
back to `new Date()` for the after-hours path (no allocateInboundRoom
ever runs there, so there's no real call-start timestamp to use at
all) — meaning both timestamps ended up within milliseconds of each
other every time, showing 00:00:00 regardless of how long the caller
actually spoke. Business-hours had a quieter version of the same
problem: callStartedAt there is the moment the ROOM was allocated, at
the very start of the whole call — so "duration" included all the
hold-music/IVR-navigation time before the caller ever started
recording, not the recording itself. Fixed by measuring the ACTUAL
audio file's duration directly via ffprobe (already part of this app's
ffmpeg toolchain — see campaignRoutes.js's convertToUlaw) — correct
for both paths, and no longer dependent on any call-state timestamp at
all. Falls back to 0 (logged, not thrown) if ffprobe itself is
unavailable or the file is unreadable, rather than blocking the whole
save over a duration measurement.
==================================================
*/
async function getAudioDurationSeconds(localPath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    localPath,
  ]);
  const seconds = parseFloat(stdout.trim());
  return Number.isFinite(seconds) ? Math.round(seconds) : 0;
}

async function recordVoicemail({ room, uniqueId, campaignId, callerIdNumber, isAfterHours }) {
  const key = room || uniqueId;
  const localWavPath = voicemailRecordingPath(key);

  let callStartedAt = new Date();
  let call = null;
  if (room) {
    call = inboundCalls.get(room);
    if (call) callStartedAt = call.startedAt;
  }
  const leftAt = new Date();

  let durationSeconds = 0;
  try {
    durationSeconds = await getAudioDurationSeconds(localWavPath);
  } catch (err) {
    console.error(`[inboundCallService] Failed to measure voicemail duration for ${key}:`, err.message);
  }

  let recordingKey = null;
  try {
    const s3Key = recordingUploadService.voicemailKeyForRecording(campaignId, key);
    recordingKey = await recordingUploadService.uploadVoicemailRecording(localWavPath, s3Key);
  } catch (err) {
    console.error(`[inboundCallService] Failed to upload voicemail recording for ${key}:`, err.message);
  }

  let voicemailLogId = null;
  try {
    const [insertResult] = await db.execute(
      `
        INSERT INTO cmx_dialer.voicemail_log
          (campaign_id, caller_id_number, call_started_at, left_at, duration_seconds, recording_key, is_after_hours)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [campaignId, callerIdNumber, callStartedAt, leftAt, durationSeconds, recordingKey, isAfterHours ? "Y" : "N"]
    );
    voicemailLogId = insertResult.insertId;
  } catch (err) {
    console.error(`[inboundCallService] Failed to insert voicemail_log row for campaign ${campaignId}:`, err.message);
  }

  // EMAIL NOTIFICATION — per explicit request, one email per saved
  // voicemail to every supervisor/account_manager assigned to THIS
  // campaign (not admin/training_quality — they already have
  // unrestricted visibility on the Voicemails page and don't need a
  // per-message alert for every campaign). Best-effort: a failed
  // lookup or a down SMTP server should never undo the voicemail_log
  // insert that already succeeded above, so this is deliberately its
  // own try/catch, after that insert, not wrapping it.
  if (voicemailLogId) {
    try {
      const [campaignRows] = await db.execute(
        `SELECT campaign_name FROM asterisk.vicidial_campaigns WHERE campaign_id = ?`,
        [campaignId]
      );
      const campaignName = campaignRows[0]?.campaign_name || null;

      const [recipientRows] = await db.execute(
        `
          SELECT DISTINCT au.email, au.full_name
          FROM cmx_dialer.app_users au
          JOIN cmx_dialer.agent_campaign_assignments aca
            ON aca.app_user_id = au.app_user_id AND aca.active = 1
          WHERE aca.campaign_id = ?
            AND au.access_level IN ('supervisor', 'account_manager')
            AND au.active = 1
        `,
        [campaignId]
      );

      const playUrl = `${FRONTEND_URL}/voicemails/${voicemailLogId}`;

      await Promise.all(
        recipientRows.map((recipient) =>
          transporter
            .sendMail({
              from: process.env.SMTP_FROM,
              to: recipient.email,
              ...buildVoicemailNotificationEmail({
                fullName: recipient.full_name,
                campaignName,
                campaignId,
                callerIdNumber,
                leftAt,
                playUrl,
              }),
            })
            .catch((err) => {
              console.error(`[inboundCallService] Failed to send voicemail notification to ${recipient.email}:`, err.message);
            })
        )
      );
    } catch (err) {
      console.error(`[inboundCallService] Failed to notify supervisors/account managers for voicemail ${voicemailLogId}:`, err.message);
    }
  }

  if (room && call) {
    inboundCalls.delete(room);
    const suffix = room.slice(ROOM_PREFIX.length);
    releaseRoomSuffix(suffix);
    tryConnectReadyAgents();
  }

  return true;
}

/*
==================================================
tryConnectReadyAgents (plural) — mutex wrapper
==================================================
REAL BUG FIXED HERE: this function has FOUR separate, uncoordinated
call sites (customer join, agent goes READY, call ends, abandonment
cleanup) with no serialization between them. Two overlapping passes
could each read a stale "who's ready" snapshot before an earlier
pass's IN_CALL status write for an agent had actually committed,
letting BOTH independently claim the SAME agent for two different
waiting calls. Only one Originate() would actually land; the other
left an agent's phone ringing into nothing and the caller stuck on
hold music — exactly the "only one agent connects properly" symptom
reported with multiple simultaneous callers and agents.

Fix: a synchronous guard checked BEFORE any await, so two overlapping
invocations can never interleave — the second one just flags that
another pass is needed once the current one finishes, rather than
running concurrently or being silently dropped. The 4 existing call
sites are UNCHANGED — they still just call tryConnectReadyAgents();
this wrapper handles serialization transparently underneath them.
==================================================
*/
let isProcessingReadyAgents = false;
let rerunReadyAgentsRequested = false;

async function tryConnectReadyAgents() {
  if (isProcessingReadyAgents) {
    rerunReadyAgentsRequested = true;
    return;
  }

  isProcessingReadyAgents = true;
  try {
    await tryConnectReadyAgentsInner();
  } finally {
    isProcessingReadyAgents = false;
    if (rerunReadyAgentsRequested) {
      rerunReadyAgentsRequested = false;
      tryConnectReadyAgents();
    }
  }
}

/*
==================================================
tryConnectReadyAgentsInner
==================================================
Drains as many waiting calls as possible per pass, FIFO by arrival
time (startedAt) — not just "the one call" like v1. Builds up an
exclusion set of appUserIds already claimed WITHIN THIS SAME PASS (plus
anyone already pending/connected on a different call from an earlier
pass) so two waiting calls can never be matched to the same agent —
agentStatusService.getAnyReadyAgentWithExtension() skips anyone in that
set entirely, moving on to the next real candidate. Now guaranteed to
only ever run one pass at a time — see the tryConnectReadyAgents()
wrapper above — so this exclusion set can no longer be undermined by a
second, concurrently-running pass.

VOICEMAIL FEATURE — a call whose customerInConfBridge is false means
the caller is physically sitting in the dialplan's voicemail wait-loop,
not the ConfBridge, even though status is "waiting_for_agent". Before
originating the agent leg, this now actively redirects that channel
into the room's ConfBridge via AMI — same mechanism holdInboundCall/
unholdInboundCall already use to move a channel between extensions —
so the agent has an actual bridge to land in. Every existing,
non-voicemail campaign's calls have customerInConfBridge === true
already (set in allocateInboundRoom), so this is a no-op for them,
identical to today's behavior.
==================================================
*/
async function tryConnectReadyAgentsInner() {
  const waiting = Array.from(inboundCalls.values())
    .filter((call) => call.status === "waiting_for_agent")
    .sort((a, b) => a.startedAt - b.startedAt);

  if (!waiting.length) return;

  const claimedThisPass = new Set();
  for (const call of inboundCalls.values()) {
    if (call.pendingAppUserId) claimedThisPass.add(call.pendingAppUserId);
    if (call.connectedAppUserId) claimedThisPass.add(call.connectedAppUserId);
  }

  for (const call of waiting) {
    // Re-check at this point in the loop, not just at collection time —
    // an earlier iteration's originate() could theoretically finish an
    // agent onto ANOTHER call synchronously enough to matter, or this
    // call could have ended while we were mid-loop on a previous one.
    if (call.status !== "waiting_for_agent") continue;

    let agent;
    try {
      agent = await agentStatusService.getAnyReadyAgentWithExtension(call.campaignId, Array.from(claimedThisPass));
    } catch (err) {
      console.error("[inboundCallService] Failed to look up a ready agent:", err.message);
      continue;
    }

    if (!agent) continue; // no (more) ready+connected agents this pass

    claimedThisPass.add(agent.appUserId);

    call.status = "ringing_agent";
    call.pendingAppUserId = agent.appUserId;
    call.pendingAgentExtension = agent.extension;

    // VOICEMAIL — pull the caller into the ConfBridge if they're not
    // already in it (i.e. they're currently in the wait-loop
    // extension). Must happen before the agent is originated, so the
    // room actually has the customer in it by the time the agent's
    // leg lands.
    if (!call.customerInConfBridge) {
      try {
        await ami.redirectChannel(call.customerChannel, { context: "trunkinbound", exten: call.room });
        call.customerInConfBridge = true;
      } catch (err) {
        console.error(`[inboundCallService] Failed to redirect voicemail-wait-loop customer into ConfBridge for room ${call.room}:`, err.message);
        call.status = "waiting_for_agent";
        call.pendingAppUserId = null;
        call.pendingAgentExtension = null;
        claimedThisPass.delete(agent.appUserId);
        continue;
      }
    }

    try {
      await agentStatusService.setStatus(agent.appUserId, "IN_CALL", {
        relatedCallDirection: "inbound",
        relatedCampaignId: call.campaignId,
        relatedCallId: call.callId,
      });
    } catch (err) {
      console.error("[inboundCallService] Failed to set IN_CALL for inbound-answering agent:", err.message);
    }

    // The call may have ended (caller hung up) while we were mid-loop
    // above — re-check before broadcasting/originating.
    if (call.status !== "ringing_agent") continue;

    broadcastInboundStatus(call);

    try {
      await ami.originate({
        Channel: `PJSIP/${agent.extension}`,
        // Was "default" — that context doesn't exist in extensions.conf
        // at all (confirmed via `grep "^\[" extensions.conf` on sandbox,
        // Aug 22 JsSIP rollout session). Every _29700XXX/_9700XXX/etc.
        // agent-leg pattern actually lives in [trunkinbound], so that's
        // the only context this Originate can ever reach.
        Context: "trunkinbound",
        Exten: `2${call.room}`,
        Priority: 1,
        CallerID: `"Inbound Caller" <${call.room}>`,
        Async: "true",
      });

      // REAL BUG FIX, per explicit request — see AGENT_RING_TIMEOUT_MS's
      // own comment above for the full incident writeup. Scheduled only
      // once the Originate action itself has been accepted (this whole
      // try block hasn't thrown) — if it fails outright, the catch below
      // already handles putting the call back to waiting_for_agent
      // immediately, no timeout needed for that path.
      scheduleRingTimeout(call, agent.appUserId);
    } catch (err) {
      console.error("[inboundCallService] Failed to originate agent leg for inbound call:", err.message);

      if (call.status === "ringing_agent") {
        call.status = "waiting_for_agent";
        call.pendingAppUserId = null;
        call.pendingAgentExtension = null;
        claimedThisPass.delete(agent.appUserId);
      }
    }
  }
}

/*
==================================================
recordAbandonedCall
==================================================
Writes one row to cmx_dialer.abandoned_call_log — see
abandoned_call_log.sql in the handoff notes for the CREATE TABLE.
wait_seconds is computed HERE, once, from call.startedAt/endedAt (both
set via new Date() in this same Node process) — a fixed historical
value at the moment of writing, not something recomputed later, so
there's no live-ticking clock concern for this one at all.

REAL FIX, per explicit request following a real data-analysis gap: two
completely different scenarios were both being recorded identically —
a caller hanging up before ANY agent was ever paged (previousStatus
"waiting_for_agent" — genuinely nobody available) versus a caller
hanging up while a REAL agent's phone was actively ringing
(previousStatus "ringing_agent" — someone was right there about to
answer). Confirmed live: an ad-hoc query joining agent_status_log to
find "was any agent READY during this call's wait window" couldn't
tell these apart at all, since both produce the exact same row shape
with no trace of which one actually happened — a "ringing_agent"
abandonment inherently HAD a matched, ringing agent (that's what
ringing_agent means), while "waiting_for_agent" never had one at all.
abandonReason now captures that distinction directly, taken from the
SAME previousStatus value endInboundCall (this function's only caller)
already has in hand at the exact moment it decides this was abandoned —
no new lookup needed, no way for it to drift out of sync with the
real cause.
==================================================
*/
async function recordAbandonedCall(call, previousStatus) {
  const waitSeconds = Math.floor((call.endedAt.getTime() - call.startedAt.getTime()) / 1000);
  const abandonReason = previousStatus === "ringing_agent" ? "AGENT_RINGING_NO_ANSWER" : "NEVER_MATCHED";
  await db.execute(
    `
      INSERT INTO cmx_dialer.abandoned_call_log
        (campaign_id, caller_id_number, call_started_at, call_ended_at, wait_seconds, abandon_reason)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [call.campaignId, call.callerIdNumber, call.startedAt, call.endedAt, waitSeconds, abandonReason]
  );
}

/*
==================================================
endInboundCall(room)
==================================================
Marks the call at this room ended. Explicitly hangs up whichever leg
is still connected — same reasoning as v1 and as outbound: one party
leaving does NOT auto-close a ConfBridge room, and a lingering channel
could otherwise collide with a FUTURE call into this same room number
once it's reallocated.

THREE DIFFERENT OUTCOMES depending on how far the call got:

1. LEAVING VOICEMAIL (NEW) — the call ends while status is
   "leaving_voicemail". recordVoicemail (triggered by the dialplan's
   own /internal/voicemail-recorded CURL, AFTER this same Hangup's
   Record() line returns) does the REAL cleanup — Map deletion, room
   release, the voicemail_log insert. This branch only makes sure a
   channel hangup arriving during/after that window doesn't ALSO try
   to hang up an already-gone channel, or fall through into the
   abandoned/normal branches below and record this as something it
   isn't. Checked FIRST, before either of the other two outcomes.

2. ABANDONED — the call ends while still "waiting_for_agent" (nobody
   ever assigned) or "ringing_agent" (an agent's phone was ringing but
   the caller left before they answered). Recorded to
   abandoned_call_log and cleaned up IMMEDIATELY — deleted from the Map,
   room released — since there's no agent who ever actually took this
   call, so there's nothing for anyone to disposition. If an agent WAS
   mid-ring (ringing_agent), they're returned straight to READY, not
   AFTER_CALL_WORK — they never actually connected to anything, so
   wrap-up time doesn't apply; same "auto-READY" assumption already
   used elsewhere in this file, not a new one. NOTE: never reaches
   recording start/stop at all — an abandoned call never had an agent
   join, so nothing was ever recording in the first place.

3. NORMAL — the call had reached "agent_connected" before ending. Same
   as before: agent flips to AFTER_CALL_WORK, and the call stays in the
   Map (NOT deleted) until the disposition is saved (finalizeInboundCall)
   — the agent still needs caller info to fill out the intake form.
   Recording (if it was started — BSMSC only) is stopped here, BEFORE
   the AFTER_CALL_WORK transition, guaranteeing the file is flushed and
   closed before the later S3 upload step (triggered wherever the
   inbound disposition actually gets saved) tries to read it.
==================================================
*/
async function endInboundCall(room) {
  const call = inboundCalls.get(room);
  if (!call || call.status === "ended") return;

  const previousStatus = call.status;
  const appUserId = call.connectedAppUserId || call.pendingAppUserId;

  clearRingTimeout(call); // call is ending through this path regardless of status — any pending ring-timeout is no longer relevant

  call.status = "ended";
  call.endedAt = new Date();
  broadcastInboundStatus(call);

  // VOICEMAIL — see outcome (1) above. Checked before anything else;
  // deliberately does NOT touch the Map/room pool at all, since
  // recordVoicemail owns that cleanup once it runs.
  if (previousStatus === "leaving_voicemail") {
    if (call.customerChannel) {
      ami.hangupChannel(call.customerChannel).catch((err) => {
        if (!ami.isExpectedAlreadyGoneError(err)) {
          console.error(`[inboundCallService] Failed to hang up voicemail customer channel ${call.customerChannel}:`, err.message);
        }
      });
    }
    return;
  }

  // REAL FIX, per explicit request — "just keep conference, but allow
  // agents to hang up": when a Conference/Transfer participant is
  // still in the room, the ORIGINAL agent's own leg ending must NOT
  // also end the call for everyone — only their own leg drops,
  // leaving the customer connected with whoever else is in the room.
  // Previously this unconditionally hung up customerChannel too,
  // whether the agent's OWN hangup triggered this or the customer's
  // own hangup did — either way disconnecting everyone regardless of
  // a still-active third party.
  const hasExtraParticipants = call.extraParticipants && call.extraParticipants.length > 0;

  const hangups = [];
  if (!hasExtraParticipants && call.customerChannel) {
    hangups.push(
      ami.hangupChannel(call.customerChannel).catch((err) => {
        if (ami.isExpectedAlreadyGoneError(err)) return;
        console.error(`[inboundCallService] Failed to hang up customer channel ${call.customerChannel}:`, err.message);
      })
    );
  }
  if (call.agentChannel) {
    hangups.push(
      ami.hangupChannel(call.agentChannel).catch((err) => {
        if (ami.isExpectedAlreadyGoneError(err)) return;
        console.error(`[inboundCallService] Failed to hang up agent channel ${call.agentChannel}:`, err.message);
      })
    );
  }
  await Promise.all(hangups);

  const wasAbandoned = previousStatus === "waiting_for_agent" || previousStatus === "ringing_agent";

  if (wasAbandoned) {
    try {
      await recordAbandonedCall(call, previousStatus);
    } catch (err) {
      console.error("[inboundCallService] Failed to record abandoned call:", err.message);
    }

    if (appUserId && previousStatus === "ringing_agent") {
      try {
        // Same fix as dialerService.js's own saveDisposition — call is
        // already in scope here, just needed to actually pass it.
        await agentStatusService.setStatus(appUserId, "READY", { relatedCampaignId: call.campaignId });
      } catch (err) {
        console.error("[inboundCallService] Failed to return ringing agent to READY after abandonment:", err.message);
      }
    }

    inboundCalls.delete(room);
    const suffix = room.slice(ROOM_PREFIX.length);
    releaseRoomSuffix(suffix);
    tryConnectReadyAgents();
    return;
  }

  // UPDATED — was hardcoded to `call.campaignId === "CMXBSMSC"` only,
  // same class of bug as the recording-START gate fixed earlier this
  // session. Now checks the real campaign_recording column, so a
  // campaign with recording enabled has its recording correctly
  // stopped/flushed here regardless of which campaign it is.
  try {
    const [recRows] = await db.execute(
      `SELECT campaign_recording FROM asterisk.vicidial_campaigns WHERE campaign_id = ?`,
      [call.campaignId]
    );
    const recordingSetting = recRows[0]?.campaign_recording;
    if (recordingSetting && recordingSetting !== "NEVER") {
      try {
        await ami.stopRecording(call.room);
      } catch (err) {
        if (!ami.isExpectedAlreadyGoneError(err)) {
          console.error(`[inboundCallService] Failed to stop recording for call ${call.callId}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error(`[inboundCallService] Failed to check campaign_recording for ${call.campaignId}:`, err.message);
  }

  if (appUserId) {
    try {
      await agentStatusService.setStatus(appUserId, "AFTER_CALL_WORK", {
        relatedCallDirection: "inbound",
        relatedCampaignId: call.campaignId,
        relatedCallId: call.callId,
      });
    } catch (err) {
      console.error("[inboundCallService] Failed to set AFTER_CALL_WORK after inbound call:", err.message);
    }
  }

  // A slot just freed up — see if anyone still waiting can connect now.
  tryConnectReadyAgents();
}

// Hangup events don't carry a conference/room field, unlike
// ConfbridgeJoin/Leave — so ending a call by channel means scanning
// for whichever call currently owns that channel.
function findByChannel(channel) {
  for (const call of inboundCalls.values()) {
    if (call.customerChannel === channel || call.agentChannel === channel) return call;
  }
  return null;
}

/*
==================================================
FAST RETRY WHEN THE AGENT'S PHONE CAN'T BE RUNG
==================================================
The agent leg is an Async Originate: the action "succeeds" immediately and
Asterisk reports the real outcome later via OriginateResponse. A Failure
(phone momentarily unreachable, contact marked unavailable, busy, etc.)
arrives within a second — but nothing listened for it here, so the waiting
caller sat until AGENT_RING_TIMEOUT_MS (30 s). Now a failed agent leg puts
the agent back to READY and the caller back in the queue, and retries after
AGENT_RING_FAILURE_RETRY_MS (the same agent, if still the only one Ready,
or someone else). dialerService.js does the same for outbound calls.
==================================================
*/
const AGENT_RING_FAILURE_RETRY_MS = 3000;

function handleAgentLegFailure(evt) {
  if (evt.response !== "Failure") return;
  const exten = String(evt.exten || "");
  if (!exten.startsWith("2")) return;
  const call = inboundCalls.get(exten.slice(1)); // agent legs dial 2<room>
  if (!call || call.status !== "ringing_agent") return;

  const appUserId = call.pendingAppUserId;
  console.warn(
    `[inboundCallService] Agent leg failed to ring (reason ${evt.reason}) — back to the queue, retrying in ${AGENT_RING_FAILURE_RETRY_MS / 1000}s (callId=${call.callId}, room=${call.room}, appUserId=${appUserId})`
  );
  clearRingTimeout(call);
  call.status = "waiting_for_agent";
  call.pendingAppUserId = null;
  call.pendingAgentExtension = null;
  broadcastInboundStatus(call);

  (async () => {
    if (appUserId) {
      try {
        await agentStatusService.setStatus(appUserId, "READY", { relatedCampaignId: call.campaignId });
      } catch (err) {
        console.error("[inboundCallService] Failed to return agent to READY after a failed ring:", err.message);
      }
    }
    setTimeout(() => tryConnectReadyAgents(), AGENT_RING_FAILURE_RETRY_MS);
  })();
}

function registerInboundEventTracking() {
  ami.events.on("OriginateResponse", handleAgentLegFailure);

  ami.events.on("ConfbridgeJoin", async (evt) => {
    const call = inboundCalls.get(evt.conference);
    if (!call) return; // not one of our rooms, or a room nobody pre-registered

    if (call.status === "awaiting_customer") {
      // First (and only) join expected before an agent is ever
      // originated — this is the customer. calleridnum is present
      // directly on the ConfbridgeJoin event itself — confirmed from a
      // real test call trace on the v1 build.
      call.customerChannel = evt.channel;
      call.callerIdNumber = evt.calleridnum || null;
      call.status = "waiting_for_agent";
      // VOICEMAIL — direct-ConfBridge path (every non-voicemail
      // campaign, unchanged): the customer's first join IS them
      // entering the ConfBridge, so this is already true here.
      call.customerInConfBridge = true;
      tryConnectReadyAgents();
      return;
    }

    if (evt.channel === call.customerChannel) {
      // VOICEMAIL — this fires when tryConnectReadyAgentsInner's AMI
      // redirect lands a voicemail-wait-loop customer into the
      // ConfBridge for the first time. For every non-voicemail
      // campaign this is just the ordinary "duplicate/already
      // tracked" no-op it always was.
      call.customerInConfBridge = true;
      return;
    }

    if (call.status === "ringing_agent") {
      clearRingTimeout(call); // agent genuinely answered — the ring-timeout safety net is no longer needed for this attempt
      call.agentChannel = evt.channel;
      call.connectedAppUserId = call.pendingAppUserId;
      call.pendingAppUserId = null;
      call.status = "agent_connected";
      // How long the caller actually waited before reaching a real
      // agent — measured from the moment the room was allocated
      // (before the greeting even plays) to right now. Stored on the
      // call itself so it can be persisted into inbound_call_log at
      // disposition time; used for both the new "Average Wait Time"
      // KPI and Service Level's "answered within 20 seconds" count.
      call.waitSeconds = Math.floor((new Date() - call.startedAt) / 1000);
      broadcastInboundStatus(call);

      // UPDATED — was hardcoded to `call.campaignId === "CMXBSMSC"` only
      // (per an earlier explicit scope decision, never generalized).
      // Now checks the real, native campaign_recording column on
      // asterisk.vicidial_campaigns instead, so every campaign's own
      // recording toggle (set at creation via campaignRoutes.js) is
      // actually honored, not just the one campaign this was first
      // built for. NEVER = off, everything else (ONDEMAND/ALLCALLS/
      // ALLFORCE) = on for this always-record-the-whole-room
      // mechanism — ONDEMAND doesn't have a separate "on demand"
      // trigger built anywhere in this app, so it's treated as "on"
      // here rather than silently never recording; revisit if a real
      // on-demand toggle is ever built.
      try {
        const [recRows] = await db.execute(
          `SELECT campaign_recording FROM asterisk.vicidial_campaigns WHERE campaign_id = ?`,
          [call.campaignId]
        );
        const recordingSetting = recRows[0]?.campaign_recording;
        if (recordingSetting && recordingSetting !== "NEVER") {
          ami.startRecording(call.room, recordingPathForCall(call.callId)).catch((err) => {
            console.error(`[inboundCallService] Failed to start recording for call ${call.callId}:`, err.message);
          });
        }
      } catch (err) {
        console.error(`[inboundCallService] Failed to check campaign_recording for ${call.campaignId}:`, err.message);
      }
    }
  });

  ami.events.on("ConfbridgeLeave", (evt) => {
    const call = inboundCalls.get(evt.conference);
    if (!call) return;

    // REAL BUG FIX, confirmed via a real test call: this listener was
    // never guarded against Line 2 at all — only the separate Hangup
    // listener below got that guard. The MOMENT Line 2 starts, the
    // agent's own channel is intentionally redirected OUT of room1
    // (into Line 2's private room) — which fires a real
    // ConfbridgeLeave event for evt.channel === call.agentChannel.
    // Without this guard, that looked exactly like the agent hanging
    // up, ending the whole call immediately (customer disconnected,
    // agent sent to ACW) the instant Line 2 was even attempted.
    if (call.lineTwo) return;

    // If the customer is on hold, WE caused this leave (redirected them
    // to the cmxhold extension) — not a real hangup. A genuine
    // disconnect while on hold still fires a real Hangup event below,
    // which isn't suppressed by this check.
    if (call.onHold && evt.channel === call.customerChannel) return;

    if (evt.channel === call.customerChannel || evt.channel === call.agentChannel) {
      endInboundCall(call.room);
    }
  });

  ami.events.on("Hangup", (evt) => {
    const call = findByChannel(evt.channel);
    if (!call) return;
    // Same reasoning as dialerService.js's own fix — defer entirely to
    // attendedTransferService while Line 2 is active, rather than
    // disrupting the agent's still-live private conversation the
    // instant the original customer (or, in principle, the agent's own
    // relocated channel) triggers a Hangup event here.
    if (call.lineTwo) return;
    endInboundCall(call.room);
  });

  agentStatusService.statusEvents.on("statusChanged", ({ status }) => {
    if (status === "READY") {
      tryConnectReadyAgents();
    }
  });
}

registerInboundEventTracking();

/*
==================================================
getInboundCallForAgent
==================================================
Used to restore state after a page refresh/reopen, and to render the
DialerPage's inbound panel at all. Scans all calls for one where this
agent is pending or connected — at most one per agent at a time, since
tryConnectReadyAgents()'s per-pass exclusion set prevents the same
agent ever being claimed by two calls simultaneously.
==================================================
*/
function getInboundCallForAgent(appUserId) {
  for (const call of inboundCalls.values()) {
    if (call.pendingAppUserId === appUserId || call.connectedAppUserId === appUserId) {
      return call;
    }
  }
  return null;
}

// Called once the agent actually saves the intake/disposition form —
// this is the ONLY thing that deletes the call from inboundCalls and
// releases its room back to the pool, returning the agent to READY (or
// NOT_READY, if the agent checked the "set me Not Ready after this"
// checkbox). Until this runs, the call record (and caller ID) stays
// available for the frontend to read.
async function finalizeInboundCall(callId, appUserId, setNotReady = false) {
  const call = findByCallId(callId);
  if (call) {
    inboundCalls.delete(call.room);
    const suffix = call.room.slice(ROOM_PREFIX.length);
    releaseRoomSuffix(suffix);
  }
  // Same fix as dialerService.js's own saveDisposition and the
  // abandonment-recovery path above — this is the MAIN, everyday
  // inbound disposition-save path, so this was the single biggest
  // contributor to the "no inbound call ever reaches a Ready agent"
  // bug. call may be null if it was already gone by the time this
  // ran, hence the optional chaining.
  return agentStatusService.setStatus(appUserId, setNotReady ? "NOT_READY" : "READY", {
    relatedCampaignId: call?.campaignId,
  });
}

/*
==================================================
holdInboundCall / unholdInboundCall
==================================================
Redirects the customer out of THIS call's ConfBridge room into the
shared "cmxhold" MOH loop, and back again via the room's own
_9700XXX customer-rejoin extension. Only valid once the agent has
actually connected — matches outbound's equivalent guard. Keyed by
callId now (v1 had exactly one call, so no ambiguity — v2 needs to
know WHICH call).

NOTE ON RECORDING: same as outbound's holdCall() — deliberately does
NOT pause/resume recording during hold. ConfbridgeStartRecord keeps
recording the whole room regardless of who's in it, so a hold segment
just captures MOH audio. Acceptable for a first version.
==================================================
*/
async function holdInboundCall(callId) {
  const call = findByCallId(callId);
  if (!call) {
    throw new Error("No active inbound call with that ID.");
  }
  if (call.status !== "agent_connected") {
    throw new Error("Can only hold once the agent has connected.");
  }
  if (call.onHold) {
    throw new Error("Call is already on hold.");
  }

  // Same fix as outbound's holdCall() — set BEFORE issuing the
  // redirect so the ConfbridgeLeave guard is armed before the event it
  // needs to suppress can possibly arrive.
  call.onHold = true;

  try {
    // Same class of bug as outbound's holdCall() and the earlier
    // agent-leg Originate fix — [default] doesn't exist in
    // extensions.conf, only [trunkinbound] does.
    await ami.redirectChannel(call.customerChannel, { context: "trunkinbound", exten: "cmxhold" });
  } catch (err) {
    call.onHold = false;
    throw err;
  }

  broadcastInboundStatus(call);

  if (call.connectedAppUserId) {
    try {
      await agentStatusService.setStatus(call.connectedAppUserId, "ON_HOLD", {
        relatedCallDirection: "inbound",
        relatedCampaignId: call.campaignId,
        relatedCallId: call.callId,
      });
    } catch (err) {
      console.error("[inboundCallService] Failed to set ON_HOLD status:", err.message);
    }
  }

  return call;
}

async function unholdInboundCall(callId) {
  const call = findByCallId(callId);
  if (!call) {
    throw new Error("No active inbound call with that ID.");
  }
  if (!call.onHold) {
    throw new Error("Call is not currently on hold.");
  }

  await ami.redirectChannel(call.customerChannel, { context: "trunkinbound", exten: call.room });

  call.onHold = false;
  broadcastInboundStatus(call);

  if (call.connectedAppUserId) {
    try {
      await agentStatusService.setStatus(call.connectedAppUserId, "IN_CALL", {
        relatedCallDirection: "inbound",
        relatedCampaignId: call.campaignId,
        relatedCallId: call.callId,
      });
    } catch (err) {
      console.error("[inboundCallService] Failed to set IN_CALL status after unhold:", err.message);
    }
  }

  return call;
}

/*
==================================================
getQueueStatus
==================================================
Real aggregation across every currently-waiting call, grouped by
campaign — replaces v1's hardcoded 0-or-1 guess. Only counts calls
genuinely waiting for an agent (not yet ringing/connected/ended) —
that's what "in queue" means on the Live Status Dashboard. A call in
"leaving_voicemail" is deliberately excluded — it's no longer waiting
for an agent at all.

oldestWaitingSeconds: how long the LONGEST-waiting call in that
campaign has been waiting. Computed here, in Node, against Node's OWN
Date.now() — call.startedAt was ALSO set via new Date() in this same
process (see allocateInboundRoom), so this is one clock measuring
against itself, not the MySQL-timestamp-vs-browser-clock mismatch that
caused the two earlier timezone bugs tonight. Still returning a plain
number rather than a raw timestamp, to keep this file consistent with
the "let the source compute elapsed time, never make the frontend diff
a timestamp itself" rule the rest of this codebase now follows.
==================================================
*/
function getQueueStatus() {
  const buckets = new Map(); // campaignId -> { waiting, oldestStartedAt }

  for (const call of inboundCalls.values()) {
    if (call.status !== "waiting_for_agent") continue;

    const bucket = buckets.get(call.campaignId) || { waiting: 0, oldestStartedAt: null };
    bucket.waiting += 1;
    if (!bucket.oldestStartedAt || call.startedAt < bucket.oldestStartedAt) {
      bucket.oldestStartedAt = call.startedAt;
    }
    buckets.set(call.campaignId, bucket);
  }

  const now = Date.now();
  return Array.from(buckets.entries()).map(([campaignId, b]) => ({
    campaignId,
    waiting: b.waiting,
    oldestWaitingSeconds: Math.floor((now - b.oldestStartedAt.getTime()) / 1000),
  }));
}

function getAllInboundCalls() {
  return Array.from(inboundCalls.values());
}

/*
==================================================
getAbandonedCallsToday
==================================================
Reuses statsService.js's own Eastern-day-boundary helper (same
self-calibrating logic used for Today's Stats) rather than duplicating
it — "today" should mean the same thing everywhere in this app.
Requiring statsService.js here (not at the top of the file) avoids a
circular require, since statsService.js doesn't require this file back
so it's not strictly necessary, but keeps this one lazy/local to where
it's actually used, matching the pattern already used for ws.js's
lazy requires elsewhere in this codebase.

UPDATED — campaignId now also accepts an array (e.g. every campaign an
agent is assigned to, for DialerPage's own Abandoned/Voicemail tab —
see dialerRoutes.js's GET /dialer/abandoned-voicemail), not just a
single id or null. Also accepts an optional startDate/endDate
("yyyy-MM-dd" strings) for that same tab's date-range filter — when
both are given, uses statsService's already-existing
getEasternRangeBoundsForServerClock (built for Reports' own date-range
filter) instead of "today" only. Existing single-campaign/no-date
callers (admin's own GET /admin/abandoned-calls) are unaffected —
omitting startDate/endDate still means "today," exactly as before.
==================================================
*/
async function getAbandonedCallsToday(campaignId, startDate, endDate, statusFilter) {
  const statsService = require("./statsService");
  const { start, end } =
    startDate && endDate
      ? await statsService.getEasternRangeBoundsForServerClock(startDate, endDate)
      : await statsService.getEasternDayBoundsForServerClock();

  const campaignIds = Array.isArray(campaignId) ? campaignId : campaignId ? [campaignId] : [];

  const params = [start, end];
  let campaignFilter = "";
  if (campaignIds.length) {
    campaignFilter = `AND campaign_id IN (${campaignIds.map(() => "?").join(",")})`;
    params.push(...campaignIds);
  }

  // NEW — optional, per explicit request: DialerPage's own Abandoned &
  // Voicemail tab only ever wants status = 'NEW' rows (anything else
  // has already been called back — see dialerRoutes.js's own
  // GET /dialer/abandoned-voicemail, the only caller that passes this).
  // Left undefined by every other caller (e.g. GET /admin/abandoned-
  // calls), which still sees every row regardless of status, matching
  // its existing, unchanged reporting behavior.
  let statusClause = "";
  if (statusFilter) {
    statusClause = "AND acl.status = ?";
    params.push(statusFilter);
  }

  const [rows] = await db.execute(
    `
      SELECT acl.abandoned_call_log_id, acl.campaign_id, c.campaign_name, acl.caller_id_number, acl.call_started_at, acl.wait_seconds, acl.status, acl.abandon_reason
      FROM cmx_dialer.abandoned_call_log acl
      LEFT JOIN asterisk.vicidial_campaigns c ON c.campaign_id = acl.campaign_id
      WHERE acl.call_started_at >= ? AND acl.call_started_at <= ?
      ${campaignFilter.replace("campaign_id", "acl.campaign_id")}
      ${statusClause}
      ORDER BY acl.call_started_at DESC
      LIMIT 200
    `,
    params
  );

  return rows.map((r) => ({
    abandonedCallLogId: r.abandoned_call_log_id,
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    callerIdNumber: r.caller_id_number,
    callStartedAt: r.call_started_at,
    waitSeconds: r.wait_seconds,
    status: r.status,
    abandonReason: r.abandon_reason,
  }));
}

module.exports = {
  allocateInboundRoom,
  getInboundCallForAgent,
  finalizeInboundCall,
  holdInboundCall,
  unholdInboundCall,
  endInboundCall,
  getQueueStatus,
  getAllInboundCalls,
  getAbandonedCallsToday,
  findByCallId,
  recordingPathForCall,
  releaseRoomSuffix,
  rekeyInboundCallRoom,
  // VOICEMAIL — new exports
  customerEnteredWaitLoop,
  markLeavingVoicemail,
  recordVoicemail,
};