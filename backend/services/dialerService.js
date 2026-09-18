"use strict";

const crypto = require("crypto");
const { DateTime } = require("luxon");

const db = require("../config/db");
const ami = require("../config/ami");
const ws = require("../config/ws");
const agentStatusService = require("./agentStatusService");
const { getEasternDayBoundsForServerClock } = require("./statsService");

/*
==================================================
ROOM ALLOCATION
==================================================
Dialplan pattern confirmed working end-to-end against a real test call
ON PRODUCTION, which appears to have a genuine [default] context
(standard in stock ViciDial configs). SANDBOX's extensions.conf is a
stripped-down custom file with ONLY [trunkinbound] defined — no
[default] at all. The Context values below were changed from
"default" to "trunkinbound" specifically to fix sandbox; this has
NOT been re-validated against production, and should NOT be assumed
safe to deploy there without first confirming whether production's
[default] context still needs to be targeted instead. If both
environments ever need to diverge here, this should become an env var
rather than a hardcoded string.

  Agent leg:    PJSIP/<ext>  -> Exten 2<room>  (context "trunkinbound"
                on sandbox — see caveat above)
  Customer leg: Local/<room>@trunkinbound -> Exten <phone number>
where <room> is a 7-digit string "9600XXX" and only the last 3 digits
(000-999) actually vary — confirmed via the real ConfbridgeJoin event's
"conference": "9600000" field during testing.

So the thing we allocate/track per call is really just the 3-digit
suffix. This is an in-memory allocator scoped to a single Node process —
if you ever run more than one backend instance, this needs to move to a
shared store (DB row or Redis) instead, since two processes would not
know about each other's in-use rooms.
==================================================
*/
const usedRoomSuffixes = new Set();

function allocateRoomSuffix() {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const suffix = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
    if (!usedRoomSuffixes.has(suffix)) {
      usedRoomSuffixes.add(suffix);
      return suffix;
    }
  }
  throw new Error("No free room numbers available (all 000-999 in use).");
}

function releaseRoomSuffix(suffix) {
  usedRoomSuffixes.delete(suffix);
}

function roomFromSuffix(suffix) {
  return `9600${suffix}`; // matches dialplan's _9600XXX pattern
}

/*
==================================================
RECORDING PATH — NEW
==================================================
BSMSC-only, automatic, no agent control — per explicit scope decision.
callId-based (not room-based) since room numbers get reused across
different calls over time, while callId is stable and unique per call
— exactly what the later S3 upload step needs to find this file
deterministically.
==================================================
*/
const RECORDING_DIR = "/var/spool/asterisk/monitor";
function recordingPathForCall(callId) {
  return `${RECORDING_DIR}/${callId}.wav`;
}

/*
==================================================
IN-MEMORY CALL STATE
==================================================
Keyed by callId. Holds enough to answer getCallStatus() and to target
the right channels for endCall(). This does NOT persist across a
process restart — an in-flight call would become untrackable if the
backend restarts mid-call. Acceptable for now per spec's "keep it
simple" framing, but flag this as a real limitation before this goes
into anything resembling production use with concurrent agents.
==================================================
*/
const activeCalls = new Map();

function newCallId() {
  return crypto.randomUUID();
}

function broadcastCallStatus(call) {
  ws.broadcastToUser(call.appUserId, {
    type: "callStatus",
    callId: call.callId,
    status: call.status,
    room: call.room,
    onHold: call.onHold,
  });
}

// Ensures AFTER_CALL_WORK (and its broadcast) only fires once per call,
// since both the AMI event handlers below AND endCall() can each reach
// the "call has ended" moment — without this guard a call ended via
// endCall() after the customer already hung up would double-fire the
// status transition (harmless functionally, but noisy/confusing in the
// status_log history).
async function markCallEnded(call) {
  // Safety net for the OriginateResponse listener added in startCall()
  // (see the customer-leg-channel fix above) — if the call ends via some
  // other path (agent hangs up first, ConfbridgeLeave/Hangup fires,
  // etc.) before that listener ever gets a chance to fire on its own,
  // this stops it from leaking indefinitely on this long-running process.
  if (call._customerOriginateResponseListener) {
    ami.events.removeListener("OriginateResponse", call._customerOriginateResponseListener);
    call._customerOriginateResponseListener = null;
  }

  if (call.afterCallWorkTriggered) return;
  call.afterCallWorkTriggered = true;

  // UPDATED — was hardcoded to `call.campaignId === "CMXBSMSC"` only,
  // same class of bug found and fixed across inboundCallService.js
  // this session. Now checks the real campaign_recording column so
  // recording is correctly stopped/flushed for ANY campaign that has
  // it enabled, not just one hardcoded campaign. Stopped BEFORE
  // marking the call ended/broadcasting — guarantees the file is
  // fully flushed and closed before any later step (the S3 upload)
  // tries to read it.
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
          console.error(`[dialerService] Failed to stop recording for call ${call.callId}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error(`[dialerService] Failed to check campaign_recording for ${call.campaignId}:`, err.message);
  }

  call.status = "ended";
  call.endedAt = call.endedAt || new Date();
  broadcastCallStatus(call);

  try {
    await agentStatusService.setStatus(call.appUserId, "AFTER_CALL_WORK", {
      relatedCallDirection: "outbound",
      relatedCampaignId: call.campaignId,
      relatedCallId: call.callId,
    });
  } catch (err) {
    console.error("[dialerService] Failed to set AFTER_CALL_WORK status:", err.message);
  }
}

/*
==================================================
discardNeverConnectedCall — REAL BUG FIX, confirmed live: startCall()'s
own failure paths (agent's softphone not registered, Originate itself
rejected, the agent never joins within the 30s timeout, or the
customer leg fails to set up even after the agent DID join) were all
calling markCallEnded() — which sets the agent to AFTER_CALL_WORK,
the status the frontend's disposition form is gated on. But start-call
itself REJECTS in every one of these cases, meaning the frontend never
received a callId/lead to populate its own call/lead state with in the
first place. Net effect: the agent's backend status flips to ACW, but
there's no call/lead for the disposition form's own gating condition
to find — stuck in ACW with literally nothing on screen to act on,
confirmed via a real test where the only way out was manually purging
the agent's status_log row and hard-refreshing.

None of these cases represent a call that actually happened — nobody
ever spoke to a customer, so there's nothing to disposition at all.
This returns the agent straight to READY instead, same principle as
handleAutomaticDialOutcome's own AMD/busy/no-answer handling earlier
tonight — deliberately skipping AFTER_CALL_WORK is what keeps the
(gated on it, not on call.status) disposition form from ever
appearing for something the agent never actually experienced.
==================================================
*/
async function discardNeverConnectedCall(call) {
  if (call._customerOriginateResponseListener) {
    ami.events.removeListener("OriginateResponse", call._customerOriginateResponseListener);
    call._customerOriginateResponseListener = null;
  }

  if (call.afterCallWorkTriggered) return; // already handled via some other path
  call.afterCallWorkTriggered = true;

  activeCalls.delete(call.callId);

  try {
    await agentStatusService.setStatus(call.appUserId, "READY", {
      relatedCallDirection: "outbound",
      relatedCampaignId: call.campaignId,
    });
  } catch (err) {
    console.error("[dialerService] Failed to return agent to READY after a call that never connected:", err.message);
  }
}

/*
==================================================
getNextLead
==================================================
Per spec: try vicidial_hopper first; if empty, fall back to querying
vicidial_list directly, because AST_VDhopper.pl has a known silent-fail
bug on this server and cannot be relied on to keep the hopper populated.

NOTE: l.comments below is standard ViciDial schema (a free-text notes
field on the lead) but NOT specifically confirmed to exist on this
install — if it errors, check the real column name/existence first.
==================================================
*/
/*
==================================================
isWithinCallingHours — Phase 2, piece 1
==================================================
Real America/New_York day-of-week + time-of-day check against a
campaign's saved autodial rules. calling_days accepts the same two
formats already used elsewhere in this app for business hours
("mon-fri" range, or "mon,wed,fri" list) — day range expanded inline
here rather than importing a shared helper, since this is the only
backend consumer of that format (the frontend's day-array<->string
helpers live in AdminCampaignsSection.jsx/AdminLeadsSection.jsx, not
reusable from here without real duplication either way).
==================================================
*/
const DAY_ORDER = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function isWithinCallingHours({ calling_days, calling_start_time, calling_end_time }) {
  const now = DateTime.now().setZone("America/New_York");
  const currentDay = DAY_ORDER[now.weekday % 7]; // Luxon: 1=Mon..7=Sun; %7 maps Sun(7)->0
  const currentMinutes = now.hour * 60 + now.minute;

  let allowedDays;
  if (calling_days.includes("-") && !calling_days.includes(",")) {
    const [start, end] = calling_days.split("-");
    const startIdx = DAY_ORDER.indexOf(start);
    const endIdx = DAY_ORDER.indexOf(end);
    allowedDays =
      startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx ? DAY_ORDER.slice(startIdx, endIdx + 1) : [calling_days];
  } else {
    allowedDays = calling_days.split(",").map((d) => d.trim());
  }
  if (!allowedDays.includes(currentDay)) return false;

  const [startH, startM] = calling_start_time.split(":").map(Number);
  const [endH, endM] = calling_end_time.split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

async function getNextLead(campaignId) {
  // Phase 2, piece 1 — calling hours enforcement. Real rules stored
  // in cmx_dialer.campaign_autodial_rules (Admin -> Leads/Auto-Dial)
  // now actually checked, not just saved. If no rules row exists yet
  // for this campaign, defaults match the same 09:00-18:00 mon-fri
  // fallback used everywhere else calling hours are referenced in
  // this app. Applies to BOTH manual "Dial Next Number" and automatic
  // Auto Dial — a campaign outside its own configured hours should
  // never dial, regardless of which path triggered it.
  const [ruleRows] = await db.execute(
    `SELECT calling_days, calling_start_time, calling_end_time
     FROM cmx_dialer.campaign_autodial_rules WHERE campaign_id = ?`,
    [campaignId]
  );
  const rules = ruleRows[0] || { calling_days: "mon-fri", calling_start_time: "09:00", calling_end_time: "18:00" };

  if (!isWithinCallingHours(rules)) {
    const err = new Error("Outside this campaign's configured calling hours.");
    err.code = "OUTSIDE_CALLING_HOURS";
    throw err;
  }

  // Same terminal-status + DNC exclusions as the fallback query below
  // — a hopper entry can go stale (still 'READY' in vicidial_hopper
  // even after its lead was later disposed with a terminal outcome,
  // or added to DNC by a separate process) since nothing currently
  // guarantees the hopper is kept in sync with vicidial_list.status in
  // real time. Defense-in-depth, not just relying on the fallback path
  // alone.
  const [hopperRows] = await db.execute(
    `
      SELECT h.lead_id, h.hopper_id, l.phone_number, l.list_id,
             l.first_name, l.last_name,
             l.address1, l.address2, l.address3, l.city, l.state, l.province,
             l.postal_code, l.country_code, l.gender, l.date_of_birth,
             l.alt_phone, l.email, l.comments
      FROM vicidial_hopper h
      JOIN vicidial_list l ON l.lead_id = h.lead_id
      WHERE h.campaign_id = ? AND h.status = 'READY'
        AND l.status NOT IN ('DNC', 'NI', 'DC', 'PU', 'CALLBK', 'SCRN')
        AND NOT EXISTS (SELECT 1 FROM vicidial_dnc d WHERE d.phone_number = l.phone_number)
      ORDER BY h.priority ASC, h.hopper_id ASC
      LIMIT 1
    `,
    [campaignId]
  );

  if (hopperRows.length) {
    return { ...hopperRows[0], source: "hopper" };
  }

  // Hopper empty (or the known AST_VDhopper.pl bug never populated it) —
  // fall back to pulling directly from vicidial_list for this campaign.
  //
  // NOTE: this join assumes campaigns are tied to lists via
  // vicidial_campaigns.campaign_id = vicidial_list.list_id indirectly
  // through vicidial_lists.campaign_id — NOT CONFIRMED against this
  // install's actual schema/config yet. Verify vicidial_lists really has
  // a campaign_id column matching this campaign before trusting this path
  // — if it doesn't, this fallback will return zero rows silently.
  // REAL BUG FIX: this used to filter `status NOT IN ('DNC', 'DONE')` —
  // but per DISPOSITION_TO_VICIDIAL_STATUS below, NO disposition ever
  // actually writes the literal status 'DONE'. Only DO_NOT_CALL maps
  // to 'DNC' (correctly excluded); CALL_ENDED ('PU'), NOT_INTERESTED
  // ('NI'), WRONG_NUMBER ('DC'), and CALLBACK ('CALLBK') were ALL
  // still fully eligible for re-dial despite being terminal outcomes —
  // confirmed by reading the actual mapping, not assumed. Now excludes
  // every real status code a terminal disposition can produce.
  // CALLBACK ('CALLBK') is included here per explicit request — a
  // scheduled callback is handled through its own separate mechanism,
  // not by leaving the lead eligible for ordinary auto-dial re-pulls.
  //
  // Also excludes any phone_number present in asterisk.vicidial_dnc —
  // the native, system-wide DNC list — so a manually-uploaded DNC
  // entry blocks a lead here even if its own status was never
  // otherwise marked DNC.
  const [listRows] = await db.execute(
    `
      SELECT l.lead_id, l.phone_number, l.list_id,
             l.first_name, l.last_name,
             l.address1, l.address2, l.address3, l.city, l.state, l.province,
             l.postal_code, l.country_code, l.gender, l.date_of_birth,
             l.alt_phone, l.email, l.comments
      FROM vicidial_list l
      JOIN vicidial_lists vl ON vl.list_id = l.list_id
      WHERE vl.campaign_id = ?
        AND l.called_since_last_reset = 'N'
        AND l.status NOT IN ('DNC', 'NI', 'DC', 'PU', 'CALLBK', 'SCRN')
        AND NOT EXISTS (SELECT 1 FROM vicidial_dnc d WHERE d.phone_number = l.phone_number)
      ORDER BY l.lead_id ASC
      LIMIT 1
    `,
    [campaignId]
  );

  if (!listRows.length) {
    return null;
  }

  return { ...listRows[0], source: "vicidial_list_fallback" };
}

/*
==================================================
startCall
==================================================
Two-Originate flow, confirmed against a real test call:
  1. Originate agent leg -> Exten 2<room>. Wait for THIS call's
     ConfbridgeJoin (matched by conference === room) before firing the
     customer leg — firing both at once risks the customer connecting
     into an empty room.
  2. Originate customer leg (Local/<room>@default) once step 1 confirms.

Returns { callId, room } immediately after step 1's Originate is sent;
callers should track status via getCallStatus()/WebSocket push rather
than blocking on the full flow.
==================================================
*/
// Real bug found: a phone number with a leading "+" can't match EITHER
// outbound dialplan pattern (_1NXXNXXXXXX or _NXXNXXXXXX — both
// require the first character to be a literal digit, never "+"),
// causing a silent no-route failure. Normalizing to a bare 10-digit
// US number here fixes this for BOTH Dial Next Number and Callback,
// since they share this same function.
function normalizePhoneNumber(phoneNumber) {
  if (!phoneNumber) return phoneNumber;
  let digits = String(phoneNumber).replace(/^\+/, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  return digits;
}

function startCall({
  appUserId,
  agentUser,
  agentExtension,
  lead,
  leadId,
  phoneNumber,
  campaignCid,
  campaignId,
  callType = "REGULAR",
  shouldRunAmd = true,
  outboundTrunk,
}) {
  // REAL BUG FIX, per explicit request — see agentStatusService.js's
  // own claimAgentForOutboundDial/releaseAgentForOutboundDial comment
  // for the full race-condition writeup. This MUST be the absolute
  // first thing startCall() does, before anything else at all — JS's
  // single-threaded, run-to-completion semantics mean nothing else can
  // run before this line executes, closing the race window down to
  // zero rather than just narrowing it. Released once the real
  // IN_CALL status write actually completes, further down this same
  // function.
  agentStatusService.claimAgentForOutboundDial(appUserId);

  // REAL BUG FIX, per explicit request — this used to re-validate
  // against a single hardcoded literal "Telpeer" (`outboundTrunk ===
  // "Telpeer" ? "Telpeer" : "CMXCallSuite"`), a leftover from BEFORE
  // the dynamic multi-trunk system existed (Admin -> DID/Trunk Setup,
  // cmx_dialer.outbound_trunks — see adminRoutes.js/campaignRoutes.js).
  // Any trunk created through that feature (e.g. "TELPEER-HTA-OB")
  // failed this exact-string check and silently fell back to
  // CMXCallSuite on EVERY outbound call, regardless of what the
  // campaign's own Outbound Trunk setting actually said — confirmed
  // live via a real test call showing "Using outbound trunk:
  // CMXCallSuite" in the Asterisk CLI despite the campaign being
  // configured for a different, real, active trunk.
  //
  // outboundTrunk here already comes from cmx_dialer.campaign_
  // settings.outbound_trunk (see dialerRoutes.js's own call site),
  // which campaignRoutes.js's isValidOutboundTrunk() already validates
  // against this SAME outbound_trunks table before ever saving it —
  // so trusting that column's value here (falling back to
  // CMXCallSuite only when it's genuinely blank/falsy) matches the
  // real, current trust boundary, instead of re-applying a stale one
  // from back when "Telpeer" was the only alternate trunk that could
  // ever exist.
  const resolvedOutboundTrunk = outboundTrunk || "CMXCallSuite";
  phoneNumber = normalizePhoneNumber(phoneNumber);
  return new Promise(async (resolve, reject) => {
    let suffix;
    try {
      suffix = allocateRoomSuffix();
    } catch (err) {
      // Release the claim here too — this is the one early-exit path
      // that returns before ever reaching the release call further
      // down; without this, a room-allocation failure would leave a
      // stale claim permanently excluding this agent from inbound
      // calls until the process restarts.
      agentStatusService.releaseAgentForOutboundDial(appUserId);
      return reject(err);
    }

    const room = roomFromSuffix(suffix);
    const callId = newCallId();

    const callState = {
      callId,
      room,
      roomSuffix: suffix,
      appUserId,
      campaignId,
      lead, // full lead object — needed to restore ContactDetailsCard after a page refresh/reopen, not just leadId/phoneNumber
      leadId,
      phoneNumber,
      callType,
      agentUser,
      agentExtension,
      status: "ringing_agent",
      agentChannel: null,
      customerChannel: null,
      startedAt: new Date(),
      endedAt: null,
      afterCallWorkTriggered: false,
      onHold: false,
      // Channels added via Conference/Transfer (see dialerRoutes.js's
      // conference-add/transfer-blind routes) — NOT customerChannel or
      // agentChannel, which stay reserved for the original two legs.
      // endCall() below checks this: if any extra participants are
      // present when the agent hangs up, only THEIR OWN leg is
      // dropped — the room stays alive with the customer + whoever
      // else is in it, rather than unconditionally ending the whole
      // call (and releasing the room number for reuse) out from under
      // them.
      extraParticipants: [],
      lineTwo: null, // see attendedTransferService.js
      activeLine: 1, // which room the agent's OWN channel currently sits in — 1 or 2
      xferConfTarget: null, // set by attendedTransferService.js's completeLineTwo — the number/extension a Line 2 Xfer/Conf went to, read by saveDisposition below
    };

    activeCalls.set(callId, callState);
    broadcastCallStatus(callState);

    // Agent is now committed to this call attempt the moment dialing
    // starts, not only once someone actually answers — so IN_CALL
    // begins here rather than waiting for ConfbridgeJoin.
    try {
      await agentStatusService.setStatus(appUserId, "IN_CALL", {
        relatedCallDirection: "outbound",
        relatedCampaignId: callState.campaignId,
        relatedCallId: callState.callId,
      });
    } catch (err) {
      console.error("[dialerService] Failed to set IN_CALL status:", err.message);
    }

    // Claim released — whether the write above succeeded or failed,
    // there's no reason to keep holding it: either the agent's real
    // status now correctly reads IN_CALL (so the normal status check
    // in getAnyReadyAgentWithExtension already excludes them going
    // forward on its own), or it failed and they're stuck as READY
    // regardless of this claim, in which case an inbound match
    // reaching them is no worse than the pre-existing failure already
    // happening.
    agentStatusService.releaseAgentForOutboundDial(appUserId);

    // Listen for this call's agent ConfbridgeJoin before firing leg 2.
    // Matched on room number only (conference numbers are unique per
    // in-flight call by construction of allocateRoomSuffix()).
    let settled = false;

    const onConfbridgeJoin = async (evt) => {
      if (evt.conference !== room) return; // not our room
      if (settled) return;

      callState.agentChannel = evt.channel;
      callState.status = "agent_connected";
      broadcastCallStatus(callState);

      settled = true;
      ami.events.removeListener("ConfbridgeJoin", onConfbridgeJoin);
      clearTimeout(joinTimeout);

      try {
        await ami.originate({
          // SANDBOX-SPECIFIC FIX — was Local/${room}@default /
          // Context: "default". See ROOM ALLOCATION comment above.
          Channel: `Local/${room}@trunkinbound`,
          Context: "trunkinbound",
          Exten: phoneNumber,
          Priority: 1,
          CallerID: `"CMX Outbound" <${campaignCid}>`,
          Async: "true",
          // Per explicit request — AMD must only run for OUTBOUND
          // campaigns dialing a real lead, never for BLENDED campaigns
          // or a manually-typed number. shouldRunAmd is computed once
          // in dialerRoutes.js (the one call site) and threaded all
          // the way through as a real parameter rather than
          // re-derived here. See extensions.conf's _1NXXNXXXXXX /
          // _NXXNXXXXXX patterns — they check this exact variable
          // before deciding whether to include U(amd-check) in the
          // Dial() options string at all.
          //
          // CMXTRUNK — NEW, per explicit request: tells those same
          // dialplan patterns which trunk to actually dial through
          // (defaults to CMXCallSuite there if this is ever blank —
          // see extensions.conf's own GotoIf check — so this stays
          // fully backward-compatible even if something upstream ever
          // fails to pass it).
          //
          // Both variables combined into ONE pipe-delimited Variable
          // header (AMI's own long-standing multi-variable syntax) —
          // NOT two separate "Variable" keys, which isn't possible in
          // a plain JS object (the second would just silently
          // overwrite the first, quietly breaking AMD entirely).
          // FIX — confirmed via direct inspection of asterisk-manager's
          // own source (lib/ami.js): a plain STRING value here is sent
          // completely literally as one line; the library does NOT
          // split on "|" at all, unlike the legacy AMI convention I'd
          // assumed. Asterisk itself then parses everything after the
          // FIRST "=" as SKIP_AMD's own value — meaning CMXTRUNK was
          // NEVER actually created as its own variable, confirmed live
          // via a real test call (every attempt showed "Using outbound
          // trunk: CMXCallSuite", never Telpeer, regardless of the
          // campaign's real saved setting). A plain OBJECT here is
          // what the library actually needs — its own source shows it
          // emits one correct "Variable: name=value" line per key
          // automatically. This also fixes a real, previously
          // unnoticed side effect: SKIP_AMD's value was never cleanly
          // "0" or "1" either, meaning the AMD-skip dialplan check
          // likely never actually skipped AMD for manual dials/blended
          // campaigns as intended.
          Variable: {
            SKIP_AMD: shouldRunAmd ? "0" : "1",
            CMXTRUNK: resolvedOutboundTrunk,
          },
        });

        callState.status = "ringing_customer";
        // REAL FEATURE, per explicit request — captures when the
        // customer leg actually started ringing, so "ring time" can
        // be measured later (see ring_seconds, computed at whichever
        // of this call's two end-paths actually runs — either the
        // moment ConfbridgeJoin fires below for a real human answer,
        // or at insert time for the automatic-outcome path, using
        // this same timestamp either way).
        callState.ringingCustomerAt = new Date();
        broadcastCallStatus(callState);

        // REAL BUG FIXED HERE: previously, callState.customerChannel was
        // ONLY ever set inside ConfbridgeJoin's handler — which only
        // fires once the customer's phone actually ANSWERS. While still
        // ringing, customerChannel stayed null, so endCall() (see below)
        // had nothing to hang up if the agent ended the call before the
        // customer picked up — the dial-out just kept ringing on
        // Asterisk's side indefinitely, orphaned from callState entirely.
        // Confirmed via a real callback test: agent ended the call while
        // the customer's line was still ringing, and it never stopped.
        //
        // Fix: capture the channel from the customer leg's OWN
        // OriginateResponse instead, which fires immediately once
        // Asterisk accepts the dial attempt — regardless of whether it's
        // ever answered. Matched by room (via the Local channel's name
        // prefix), not by phoneNumber, since room is guaranteed unique
        // per in-flight call by construction of allocateRoomSuffix(),
        // whereas two simultaneous calls could in principle dial the
        // same number. One-shot: removes itself once it fires, or once
        // the call ends some other way first.
        const onCustomerOriginateResponse = (evt) => {
          if (!evt.channel || !evt.channel.startsWith(`Local/${room}@`)) return;
          if (!callState.customerChannel) {
            callState.customerChannel = evt.channel;
          }
          ami.events.removeListener("OriginateResponse", onCustomerOriginateResponse);
          callState._customerOriginateResponseListener = null;
        };
        callState._customerOriginateResponseListener = onCustomerOriginateResponse;
        ami.events.on("OriginateResponse", onCustomerOriginateResponse);

        resolve({ callId, room });
      } catch (err) {
        await discardNeverConnectedCall(callState);
        releaseRoomSuffix(suffix);
        reject(err);
      }
    };

    // Safety valve: if the agent never joins (phone doesn't ring, agent
    // doesn't pick up, extension misconfigured), don't hang the promise
    // or the room allocation forever. 30s is a starting guess, not
    // validated against real agent answer-time distributions yet.
    const joinTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      ami.events.removeListener("ConfbridgeJoin", onConfbridgeJoin);
      ami.events.removeListener("OriginateResponse", onOriginateResponse);
      discardNeverConnectedCall(callState);
      releaseRoomSuffix(suffix);
      reject(new Error(`Timed out waiting for agent to join room ${room}.`));
    }, 30000);

    ami.events.on("ConfbridgeJoin", onConfbridgeJoin);

    // Fail fast: Asterisk reports Originate failures (no answer, no
    // registered contact, etc.) via a near-immediate OriginateResponse
    // event, not by refusing the initial action call (Async Originate's
    // action-level ack just means "request accepted," not "call
    // succeeded"). Matched on Exten since it's unique per in-flight call
    // by construction of allocateRoomSuffix(). Confirmed necessary via a
    // real failed call that otherwise sat for the full 30s timeout
    // despite Asterisk reporting failure in under a second.
    const onOriginateResponse = (evt) => {
      if (settled) return;
      if (evt.exten !== `2${room}`) return; // not our agent leg
      if (evt.response !== "Failure") return; // Success is handled by ConfbridgeJoin instead

      settled = true;
      clearTimeout(joinTimeout);
      ami.events.removeListener("ConfbridgeJoin", onConfbridgeJoin);
      ami.events.removeListener("OriginateResponse", onOriginateResponse);
      discardNeverConnectedCall(callState);
      releaseRoomSuffix(suffix);
      reject(new Error(
        `Asterisk failed to originate the agent leg to ${agentExtension} (reason ${evt.reason}). ` +
        `Check whether the agent's softphone is registered.`
      ));
    };

    ami.events.on("OriginateResponse", onOriginateResponse);

    ami.originate({
      // SANDBOX-SPECIFIC FIX — was Context: "default". See ROOM
      // ALLOCATION comment above.
      Channel: `PJSIP/${agentExtension}`,
      Context: "trunkinbound",
      Exten: `2${room}`,
      Priority: 1,
      CallerID: `"${agentUser}" <${campaignCid}>`,
      Async: "true",
    }).catch((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(joinTimeout);
      ami.events.removeListener("ConfbridgeJoin", onConfbridgeJoin);
      ami.events.removeListener("OriginateResponse", onOriginateResponse);
      discardNeverConnectedCall(callState);
      releaseRoomSuffix(suffix);
      reject(err);
    });
  });
}

/*
==================================================
getCallStatus
==================================================
Purely reads in-memory state built up by the AMI event subscriptions
below (registerCallEventTracking) — no polling, per spec.
==================================================
*/
function getCallStatus(callId) {
  const call = activeCalls.get(callId);
  if (!call) return null;

  return {
    callId: call.callId,
    room: call.room,
    status: call.status,
    campaignId: call.campaignId,
    lead: call.lead,
    leadId: call.leadId,
    phoneNumber: call.phoneNumber,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    onHold: call.onHold,
  };
}

/*
==================================================
getActiveCallForAgent
==================================================
Used to restore state after a page refresh/reopen — the ONLY thing
that ever knew about an in-progress call was React state in the
browser, which a refresh wipes even though the backend (this Map) kept
tracking the real call the whole time. Returns null if this agent has
no active call right now.
==================================================
*/
function getActiveCallForAgent(appUserId) {
  for (const call of activeCalls.values()) {
    if (call.appUserId === appUserId && call.status !== "ended") {
      return getCallStatus(call.callId);
    }
  }
  return null;
}

// Internal-only — returns the RAW in-memory call object (including
// agentChannel, an actual Asterisk channel name) for backend use only.
// Never route this through an API response; getCallStatus() above is
// the public-facing shape and deliberately omits agentChannel. Added
// for Conference/Transfer (Phase E), which needs to hang up the
// agent's own channel after a successful blind transfer.
function getRawActiveCallForAgent(appUserId) {
  for (const call of activeCalls.values()) {
    if (call.appUserId === appUserId && call.status !== "ended") {
      return call;
    }
  }
  return null;
}

/*
==================================================
Ongoing event tracking (customer connect / hangup / room close)
==================================================
Confirmed from the real test call transcript:
  - Newstate with channelstatedesc === "Up" on the CUSTOMER's channel
    (PJSIP/QUESTBLUE-... in this test) is the real "customer answered"
    signal on the trunk side.
  - ConfbridgeLeave / Hangup on the customer's Local channel half is the
    real "customer disconnected" signal — the agent's channel stays in
    the room afterward and does NOT close it automatically. This is why
    endCall() below explicitly hangs up the agent leg too.
==================================================
*/
function registerCallEventTracking() {
  // REAL BUG FIX, per explicit request — confirmed live: when the
  // CUSTOMER hangs up first, the ConfbridgeLeave/Hangup listeners
  // below used to call bare markCallEnded(call) — which updates
  // status/broadcasts/sets AFTER_CALL_WORK, but never actually hangs
  // up the agent's own channel or releases the room. The agent's own
  // comment above this function already knew the agent's channel
  // "does NOT close it automatically... this is why endCall() below
  // explicitly hangs up the agent leg too" — but that fix only ever
  // lived in the AGENT-initiated endCall() path, never here. Net
  // effect: agent's UI correctly showed "call ended" / the
  // disposition form, but their own SIP leg stayed live in the
  // ConfBridge until they manually clicked Hang Up — exactly the
  // reported symptom.
  //
  // Mirrors endCall()'s own hasExtraParticipants guard exactly: if a
  // Conference/Transfer third party is still in the room, the agent
  // should stay connected to them, not get forcibly hung up just
  // because the ORIGINAL customer happened to leave first.
  async function finalizeCustomerInitiatedEnd(call) {
    const hasExtraParticipants = call.extraParticipants && call.extraParticipants.length > 0;

    if (!hasExtraParticipants && call.agentChannel) {
      await ami.hangupChannel(call.agentChannel).catch((err) => {
        if (ami.isExpectedAlreadyGoneError(err)) return;
        console.error(`[dialerService] Failed to hang up agent channel ${call.agentChannel}:`, err.message);
      });
    }

    await markCallEnded(call);

    if (!hasExtraParticipants) {
      releaseRoomSuffix(call.roomSuffix);
    }
  }

  ami.events.on("ConfbridgeJoin", async (evt) => {
    for (const call of activeCalls.values()) {
      if (evt.conference !== call.room) continue;
      // Second join into an already-agent_connected room is the customer.
      if (call.status === "ringing_customer") {
        call.customerChannel = evt.channel;
        call.status = "customer_connected";
        // REAL FEATURE, per explicit request — the real human-answer
        // path's half of ring_seconds. Computed here, once, at the
        // exact moment of answer (matching inboundCallService.js's
        // own waitSeconds pattern for the same reasoning) — the
        // automatic-outcome path below computes it the other way,
        // from ringingCustomerAt straight to call-end, since
        // customer_connected never fires there.
        if (call.ringingCustomerAt) {
          call.ringSeconds = Math.floor((new Date() - call.ringingCustomerAt) / 1000);
        }
        broadcastCallStatus(call);

        // UPDATED — was hardcoded to `call.campaignId === "CMXBSMSC"`
        // only. Now checks the real campaign_recording column on
        // asterisk.vicidial_campaigns (set at campaign creation via
        // campaignRoutes.js) so every campaign's own recording toggle
        // is actually honored. Starts HERE (not at agent_connected) so
        // the recording captures the actual conversation, not just the
        // agent sitting alone waiting for the customer to pick up.
        try {
          const [recRows] = await db.execute(
            `SELECT campaign_recording FROM asterisk.vicidial_campaigns WHERE campaign_id = ?`,
            [call.campaignId]
          );
          const recordingSetting = recRows[0]?.campaign_recording;
          if (recordingSetting && recordingSetting !== "NEVER") {
            ami.startRecording(call.room, recordingPathForCall(call.callId)).catch((err) => {
              console.error(`[dialerService] Failed to start recording for call ${call.callId}:`, err.message);
            });
          }
        } catch (err) {
          console.error(`[dialerService] Failed to check campaign_recording for ${call.campaignId}:`, err.message);
        }
      }
    }
  });

  ami.events.on("ConfbridgeLeave", (evt) => {
    for (const call of activeCalls.values()) {
      if (evt.conference !== call.room) continue;
      // If this call is on hold, WE caused this leave (redirected the
      // customer to the cmxhold extension) — not a real hangup.
      if (call.onHold && evt.channel === call.customerChannel) continue;
      if (evt.channel === call.customerChannel) {
        finalizeCustomerInitiatedEnd(call);
      }
    }
  });

  ami.events.on("Hangup", (evt) => {
    for (const call of activeCalls.values()) {
      if (evt.channel === call.customerChannel) {
        // REAL BUG FIX, per a real test call: while Line 2 is active,
        // defer entirely to attendedTransferService's own
        // completeLineTwo/cancelLineTwo — those already handle "the
        // customer hung up while on hold" gracefully. Marking the call
        // ended here immediately would disrupt the agent's still-live,
        // private Line 2 conversation the instant the original
        // customer left, before they'd even gotten a chance to decide
        // what to do about it.
        if (call.lineTwo) continue;
        finalizeCustomerInitiatedEnd(call);
      }
    }
  });
}

registerCallEventTracking();

/*
==================================================
endCall
==================================================
Explicitly hangs up BOTH legs, per spec — confirmed necessary because
a customer hangup alone does not close the ConfBridge room; the agent's
channel otherwise sits in it until the agent manually hangs up MicroSIP.
==================================================
*/
async function endCall(callId) {
  const call = activeCalls.get(callId);
  if (!call) {
    throw new Error(`No active call found for callId ${callId}.`);
  }

  // NEW — call avoidance tracking, per explicit request: flags every
  // instance of the agent clicking Hang Up while the customer is still
  // actively connected (status === "customer_connected" AND their
  // channel is still set — i.e. they haven't already left on their
  // own). This function is confirmed agent-initiated ONLY — a
  // customer hanging up first goes through the completely separate
  // finalizeCustomerInitiatedEnd() path in registerCallEventTracking()
  // below instead, so this can safely fire unconditionally here
  // without ever misattributing a customer-initiated end to the
  // agent. Fire-and-forget — a failure here must never block or fail
  // the actual hangup itself. Judgment about whether any given row
  // represents genuine avoidance happens on the human review side
  // (the "Calls Flagged" admin page), not here.
  if (call.status === "customer_connected" && call.customerChannel) {
    const durationSeconds = Math.floor((new Date() - call.startedAt) / 1000);
    db.execute(
      `INSERT INTO cmx_dialer.call_flags
        (call_id, direction, agent_user, campaign_id, phone_number, call_started_at, call_duration_seconds)
       VALUES (?, 'outbound', ?, ?, ?, ?, ?)`,
      [call.callId, call.agentUser, call.campaignId, call.phoneNumber, call.startedAt, durationSeconds]
    ).catch((err) => {
      console.error(`[dialerService] Failed to record call flag for ${call.callId}:`, err.message);
    });
  }

  const hasExtraParticipants = call.extraParticipants && call.extraParticipants.length > 0;
  const hangups = [];

  // REAL FIX, per explicit request — "just keep conference, but allow
  // agents to hang up": when a Conference/Transfer participant is
  // still in the room, the ORIGINAL agent hanging up must NOT end the
  // call for everyone — only their own leg should drop, leaving the
  // customer connected with whoever else is in the room. Previously
  // this unconditionally hung up customerChannel too (and released
  // the room number for reuse), which would have disconnected the
  // customer AND left a real room-number collision risk — a future,
  // unrelated call could get assigned the same room number while this
  // one's third party was still actively using it.
  if (!hasExtraParticipants && call.customerChannel) {
    hangups.push(ami.hangupChannel(call.customerChannel).catch((err) => {
      if (ami.isExpectedAlreadyGoneError(err)) return;
      console.error(`[dialerService] Failed to hang up customer channel ${call.customerChannel}:`, err.message);
    }));
  }

  if (call.agentChannel) {
    hangups.push(ami.hangupChannel(call.agentChannel).catch((err) => {
      if (ami.isExpectedAlreadyGoneError(err)) return;
      console.error(`[dialerService] Failed to hang up agent channel ${call.agentChannel}:`, err.message);
    }));
  }

  await Promise.all(hangups);

  await markCallEnded(call);

  // Same reasoning — only release the room number for reuse once the
  // room is actually empty. If someone else is still in it, releasing
  // this now would let a brand new future call collide with the same
  // room number while it's still genuinely occupied.
  if (!hasExtraParticipants) {
    releaseRoomSuffix(call.roomSuffix);
  }

  return getCallStatus(callId);
}

/*
==================================================
AMD / AUTOMATIC DIAL OUTCOME HANDLING — Phase 1 (AMD) + foundation for
Phase 2 (max attempts), per explicit request
==================================================
Called from internalRoutes.js's /internal/dial-result, itself called
directly from the dialplan's CURL() the moment Dial() on the customer
leg returns — for EVERY outbound attempt, not just ones that reach a
human. Three real outcomes this cares about, all of which end the
call WITHOUT ever reaching the agent's normal disposition form (the
form is gated on agentStatus === "AFTER_CALL_WORK" in the frontend —
skipping straight to READY here is what keeps it from ever appearing,
deliberately, no new status value or flag needed):

  - MACHINE (DIALSTATUS=ANSWER, AMDSTATUS=MACHINE): AMD caught it and
    hung up the customer's own leg BEFORE ever bridging to the agent,
    per explicit request — the agent never heard anything at all.
  - BUSY (DIALSTATUS=BUSY)
  - NO_ANSWER (DIALSTATUS=NOANSWER/CONGESTION/CHANUNAVAIL — anything
    else Dial() can return that isn't a real human connection)

DIALSTATUS=ANSWER with AMDSTATUS=HUMAN (or blank/NOTSURE, if AMD
itself couldn't decide) is NOT handled here at all — that's a normal,
successful connection that already bridged to the agent via the
dialplan's own ConfBridge() line; the ordinary disposition flow
applies once THAT call ends, completely unchanged.
==================================================
*/

function findCallByRoom(room) {
  for (const call of activeCalls.values()) {
    if (call.room === room) return call;
  }
  return null;
}

// ViciDial-standard status codes — matches this schema's existing
// convention (asterisk.vicidial_list.status already uses these short
// abbreviations elsewhere in this app).
const AUTODIAL_OUTCOME_INFO = {
  machine: { disposition: "MACHINE", vicidialStatus: "AM", counterColumn: "attempts_machine_today" },
  busy: { disposition: "BUSY", vicidialStatus: "B", counterColumn: "attempts_busy_today" },
  no_answer: { disposition: "NO_ANSWER", vicidialStatus: "NA", counterColumn: "attempts_no_answer_today" },
};

/*
recordAutodialAttempt — per-lead, per-outcome-type counters, reset
daily. Schema already existed from an earlier session (Phase 1 data
setup) — this is the first thing that actually writes to it. UPSERT
rather than SELECT-then-UPDATE: two attempts landing in the same
instant (unlikely but not impossible with two agents on the same
lead, or a retry racing a fresh dial) shouldn't be able to lose an
increment to a race between reading and writing.
*/
async function recordAutodialAttempt(leadId, outcomeType) {
  const { counterColumn } = AUTODIAL_OUTCOME_INFO[outcomeType];
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, server-local — matches attempts_date's own DATE type

  await db.execute(
    `
      INSERT INTO cmx_dialer.lead_autodial_state (lead_id, ${counterColumn}, attempts_date, last_attempt_at)
      VALUES (?, 1, ?, NOW())
      ON DUPLICATE KEY UPDATE
        ${counterColumn} = IF(attempts_date = ?, ${counterColumn} + 1, 1),
        attempts_busy_today = IF(attempts_date = ?, attempts_busy_today, 0),
        attempts_no_answer_today = IF(attempts_date = ?, attempts_no_answer_today, 0),
        attempts_machine_today = IF(attempts_date = ?, attempts_machine_today, 0),
        attempts_date = ?,
        last_attempt_at = NOW()
    `,
    [leadId, today, today, today, today, today, today]
  );
}

/*
handleAutomaticDialOutcome — the actual per-call handling once a
non-human outcome is confirmed. Ends the call entirely: hangs up the
agent's own leg (nobody for them to talk to — the customer's leg is
either already hung up by the dialplan itself, for MACHINE, or never
answered at all, for BUSY/NO_ANSWER), writes the log row directly
(bypassing the normal disposition-submission route entirely, since
there's no form for the agent to fill out), updates the lead's
vicidial_list status, records the attempt for Phase 2's future
max-attempts enforcement, and returns the agent straight to READY.
*/
async function handleAutomaticDialOutcome(room, outcomeType) {
  const call = findCallByRoom(room);
  if (!call) {
    console.warn(`[dialerService] handleAutomaticDialOutcome: no active call found for room ${room} (outcome: ${outcomeType}) — it may have already ended through another path.`);
    return;
  }

  const info = AUTODIAL_OUTCOME_INFO[outcomeType];
  if (!info) {
    console.error(`[dialerService] handleAutomaticDialOutcome: unrecognized outcomeType "${outcomeType}" for room ${room}.`);
    return;
  }

  if (call.agentChannel) {
    await ami.hangupChannel(call.agentChannel).catch((err) => {
      if (ami.isExpectedAlreadyGoneError(err)) return;
      console.error(`[dialerService] Failed to hang up agent channel after ${outcomeType} outcome:`, err.message);
    });
  }

  const endedAt = new Date();
  // REAL FEATURE, per explicit request — the automatic-outcome path's
  // half of ring_seconds. customer_connected never fires here (that's
  // specifically the real-human-answer path), so this computes it the
  // other way: straight from when the customer leg started ringing to
  // right now, when this automatic outcome (no answer, busy, AMD
  // machine detection) was reached. NULL if the customer leg somehow
  // never even started ringing at all (e.g. failed before that point).
  const ringSeconds = call.ringingCustomerAt ? Math.floor((endedAt - call.ringingCustomerAt) / 1000) : null;

  try {
    await db.execute(
      `
        INSERT INTO cmx_dialer.dialer_call_log
          (agent_user, campaign_id, lead_id, phone_number, first_name, last_name,
           room_number, call_id, call_type, call_started_at, call_ended_at, disposition,
           comments, callback_at, xfer_conf, xfer_conf_target, ring_seconds)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'N', NULL, ?)
      `,
      [
        call.agentUser, call.campaignId, call.leadId, call.phoneNumber, call.lead?.first_name || null, call.lead?.last_name || null,
        room, call.callId, call.callType || "REGULAR", call.startedAt, endedAt, info.disposition,
        `Automatically detected — ${outcomeType.replace("_", " ")}. No agent interaction occurred.`, null, ringSeconds,
      ]
    );

    await db.execute(
      `UPDATE asterisk.vicidial_list SET status = ?, called_since_last_reset = 'Y' WHERE lead_id = ?`,
      [info.vicidialStatus, call.leadId]
    );

    await recordAutodialAttempt(call.leadId, outcomeType);
  } catch (err) {
    console.error(`[dialerService] Failed to record automatic ${outcomeType} outcome for call ${call.callId}:`, err.message);
  }

  activeCalls.delete(call.callId);
  releaseRoomSuffix(call.roomSuffix);

  // Deliberately READY, not AFTER_CALL_WORK — this is what keeps the
  // frontend's disposition form (gated on agentStatus ===
  // "AFTER_CALL_WORK") from ever appearing for a call the agent never
  // actually took part in.
  try {
    await agentStatusService.setStatus(call.appUserId, "READY", {
      relatedCallDirection: "outbound",
      relatedCampaignId: call.campaignId,
      relatedCallId: call.callId,
    });
  } catch (err) {
    console.error("[dialerService] Failed to return agent to READY after automatic dial outcome:", err.message);
  }

  ws.broadcastToUser(call.appUserId, {
    type: "callAutoResolved",
    callId: call.callId,
    outcome: outcomeType,
  });
}

/*
==================================================
holdCall / unholdCall (outbound)
==================================================
Redirects the CUSTOMER's channel out of the ConfBridge room into the
shared "cmxhold" MOH loop, and back again. Only valid once the
customer has actually joined (customer_connected) — can't hold a call
that hasn't connected yet.

This is also what finally makes ON_HOLD attributable to a real call —
tagging the transition with relatedCallDirection is what makes Avg
IB/OB Hold in Today's Stats computable, instead of structurally
impossible as it was before this feature existed.

NOTE ON RECORDING: deliberately does NOT pause/resume recording during
hold — ConfbridgeStartRecord keeps recording the whole room regardless
of who's in it at any given moment, so a hold segment just captures MOH
audio rather than conversation. Acceptable for a first version; revisit
only if silence/hold-music-heavy recordings turn out to be a real
problem worth solving.
==================================================
*/
async function holdCall(callId) {
  const call = activeCalls.get(callId);
  if (!call) {
    throw new Error(`No active call found for callId ${callId}.`);
  }
  if (call.status !== "customer_connected") {
    throw new Error("Can only hold a call once the customer has connected.");
  }
  if (call.onHold) {
    throw new Error("Call is already on hold.");
  }

  // Set BEFORE issuing the redirect, not after awaiting it — a real
  // bug found during testing: the ConfbridgeLeave event this redirect
  // triggers (as a side effect of the customer actually leaving the
  // ConfBridge room) can arrive before the AMI action's own
  // acknowledgment resolves, meaning the "onHold" guard in
  // registerCallEventTracking() wasn't armed yet and the call was
  // incorrectly treated as hung up.
  call.onHold = true;

  try {
    // Was context: "default" — same class of bug as the earlier
    // inboundCallService.js Originate fix: [default] doesn't exist
    // anywhere in extensions.conf, only [trunkinbound] does. This was
    // never exercised by the earlier fix since that only touched the
    // agent-leg Originate, not hold/unhold's Redirect calls.
    await ami.redirectChannel(call.customerChannel, { context: "trunkinbound", exten: "cmxhold" });
  } catch (err) {
    call.onHold = false; // redirect itself failed — revert
    throw err;
  }

  broadcastCallStatus(call);

  try {
    await agentStatusService.setStatus(call.appUserId, "ON_HOLD", {
      relatedCallDirection: "outbound",
      relatedCampaignId: call.campaignId,
      relatedCallId: call.callId,
    });
  } catch (err) {
    console.error("[dialerService] Failed to set ON_HOLD status:", err.message);
  }

  return getCallStatus(callId);
}

async function unholdCall(callId) {
  const call = activeCalls.get(callId);
  if (!call) {
    throw new Error(`No active call found for callId ${callId}.`);
  }
  if (!call.onHold) {
    throw new Error("Call is not currently on hold.");
  }

  await ami.redirectChannel(call.customerChannel, { context: "trunkinbound", exten: call.room });

  call.onHold = false;
  broadcastCallStatus(call);

  try {
    await agentStatusService.setStatus(call.appUserId, "IN_CALL", {
      relatedCallDirection: "outbound",
      relatedCampaignId: call.campaignId,
      relatedCallId: call.callId,
    });
  } catch (err) {
    console.error("[dialerService] Failed to set IN_CALL status after unhold:", err.message);
  }

  return getCallStatus(callId);
}

/*
==================================================
saveDisposition
==================================================
Per spec:
  1. Insert into cmx_dialer.dialer_call_log (own schema, NOT asterisk).
  2. Update vicidial_list.status to the closest matching ViciDial status
     code.
  3. Set called_since_last_reset = 'Y'.

STATUS CODE MAPPING BELOW IS CONFIRMED against this install's real
`vicidial_statuses` table (queried directly, 2026-08-10) EXCEPT for
CALL_ENDED, CX_HUNG_UP, and WRONG_NUMBER — this install has no status
that actually matches those three concepts. They're mapped to the
closest available code (all falling back to "PU"/"DC") as a stopgap.
This loses real information in ViciDial's own reporting (e.g. "customer
hung up" and "call completed cleanly" become indistinguishable). Flag
this to whoever owns campaign config — cheap fix is adding 2-3 custom
statuses to vicidial_statuses so these have honest equivalents.
==================================================
*/
const DISPOSITION_TO_VICIDIAL_STATUS = {
  CALL_ENDED: "PU", // no real equivalent — "Call Picked Up" is closest
  CX_HUNG_UP: "PU", // no real equivalent — loses the "hung up" distinction
  NO_ANSWER: "N", // confirmed — "N" (manual), NOT "NA" (autodial-specific)
  VOICEMAIL: "A", // confirmed — "A" (manual), NOT "AM"/"AL"/"AA" (auto variants)
  WRONG_NUMBER: "DC", // no real equivalent — "Disconnected Number" is closest, not the same thing
  NOT_INTERESTED: "NI", // confirmed exact match
  DO_NOT_CALL: "DNC", // confirmed exact match
  CALLBACK: "CALLBK", // confirmed exact match
  // Per explicit request — CMXBSMSC-only outbound option. Given a real,
  // dedicated status ("SCRN") rather than reusing PU, since this is a
  // genuinely distinct, trackable outcome (screening finished), not
  // just a generic "call ended." See 008_add_screening_completed_status.sql
  // for the corresponding asterisk.vicidial_statuses row — that table
  // was found completely empty tonight (0 rows), a separate,
  // pre-existing gap worth addressing broadly at some point, but not
  // required for THIS app's own logic to work (it never queries that
  // table for validation — everything here is this hardcoded map).
  SCREENING_COMPLETED: "SCRN",
  // Per explicit request — same reasoning as SCREENING_COMPLETED right
  // above: no real ViciDial-native equivalent, so a new, dedicated
  // status code rather than reusing an unrelated existing one. Same
  // caveat applies too — asterisk.vicidial_statuses doesn't have a
  // corresponding row for this either, but that table is never
  // queried for validation here, so it's not required for this app's
  // own logic to work.
  NOT_ELIGIBLE: "NOTELIG",
  // REAL BUG FOUND AND FIXED, per final review: XFER_CONF has always
  // been part of the base outbound DISPOSITIONS list on the frontend
  // (dispositions.js) — offered to agents on every single campaign —
  // but had no entry here at all, meaning selecting "Transferred Call
  // / Conference Call" as a disposition would throw "Unknown
  // disposition code: XFER_CONF" and fail to save, exactly the same
  // class of bug found earlier for NOT_ELIGIBLE. Pre-existing, not
  // introduced by tonight's own work — just never caught until this
  // review compared the frontend's full disposition value set against
  // this map's own keys directly. Same reasoning as the other two
  // custom codes above: no real ViciDial-native equivalent, so a
  // dedicated new status code rather than reusing an unrelated one.
  XFER_CONF: "XFERCONF",
};

async function saveDisposition({
  callId,
  appUserId,
  agentUser,
  campaignId,
  leadId,
  phoneNumber,
  firstName,
  lastName,
  room,
  disposition,
  callbackAt,
  comments,
}) {
  const vicidialStatus = DISPOSITION_TO_VICIDIAL_STATUS[disposition];
  if (!vicidialStatus) {
    throw new Error(`Unknown disposition code: ${disposition}`);
  }

  // Required at the application layer, not just via the frontend's
  // disabled-button check — a direct API call shouldn't be able to
  // skip this by bypassing the UI.
  if (!comments || !comments.trim()) {
    throw new Error("Comments are required to save a disposition.");
  }

  const call = activeCalls.get(callId);
  const startedAt = call ? call.startedAt : new Date();
  const endedAt = (call && call.endedAt) || new Date();
  const callType = (call && call.callType) || "REGULAR";
  // REAL FEATURE, per explicit request — prefers the value already
  // computed at the exact moment of answer (see customer_connected's
  // own comment above) since that's the most accurate; falls back to
  // computing it here, ringingCustomerAt-to-endedAt, for the rarer
  // case of an agent manually ending/dispositioning a call that was
  // still ringing when they did — same fallback the automatic-outcome
  // path above uses for its own always-never-connected case.
  const ringSeconds = call
    ? call.ringSeconds ?? (call.ringingCustomerAt ? Math.floor((endedAt - call.ringingCustomerAt) / 1000) : null)
    : null;

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    await connection.execute(
      `
        INSERT INTO cmx_dialer.dialer_call_log
          (agent_user, campaign_id, lead_id, phone_number, first_name, last_name,
           room_number, call_id, call_type, call_started_at, call_ended_at, disposition,
           comments, callback_at, xfer_conf, xfer_conf_target, ring_seconds)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        agentUser, campaignId, leadId, phoneNumber, firstName || null, lastName || null,
        room, callId, callType, startedAt, endedAt, disposition, comments.trim(), callbackAt || null,
        call && call.xferConfTarget ? "Y" : "N", (call && call.xferConfTarget) || null, ringSeconds,
      ]
    );

    await connection.execute(
      `
        UPDATE vicidial_list
        SET status = ?, called_since_last_reset = 'Y'
        WHERE lead_id = ?
      `,
      [vicidialStatus, leadId]
    );

    // Per explicit request — every call disposed as DO_NOT_CALL gets
    // added to the native, system-wide asterisk.vicidial_dnc list
    // immediately, not just marked DNC on this one lead row. That
    // table's sole column is phone_number (confirmed via DESCRIBE,
    // not assumed) — INSERT IGNORE since it's the table's own PK, so
    // a number already on the list is a harmless no-op, not an error.
    if (disposition === "DO_NOT_CALL") {
      await connection.execute(`INSERT IGNORE INTO vicidial_dnc (phone_number) VALUES (?)`, [phoneNumber]);
    }

    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }

  if (call) {
    activeCalls.delete(callId);
  }

  // TODO (next step, not yet built): if campaignId === "CMXBSMSC" and a
  // recording file exists at recordingPathForCall(callId), kick off the
  // S3 upload here — fire-and-forget, same pattern as the welcome email
  // elsewhere in this codebase, never blocking this function's return
  // on the upload finishing.

  // Finishing a disposition always drops the agent back to READY —
  // a product assumption, not confirmed with anyone. The alternative
  // would be returning them to whatever they were in before the call
  // (e.g. NOT_READY), which ViciDial itself doesn't do by default
  // either — but that transition (and the actual campaign tag) is
  // handled entirely by the route handler below, not here.
  //
  // REAL BUG FIX, confirmed live: this used to ALSO call setStatus
  // here, independently of the route handler (dialerRoutes.js) doing
  // the exact same thing right after this function returned — meaning
  // every disposition save created TWO status rows within the same
  // request, milliseconds apart. The route's own call is the original,
  // authoritative one (it's what supports the "set me Not Ready after
  // this" checkbox, which this function has no knowledge of at all),
  // so removed the duplicate here rather than the other way around.
  // See dialerRoutes.js's own comment on this for the full story.

  return { disposition, vicidialStatus };
}

/*
==================================================
getCallLog
==================================================
Call history for the current agent — used by the DialerPage's
"Call Logs" table. Combines BOTH outbound (dialer_call_log) and
inbound (inbound_call_log) — separate tables by design, since inbound
has genuinely different fields (caller_id_number, no lead/campaign) —
tagging each row with its direction so the UI can show which is which.

Filtered to "today" using the same self-calibrating EST/EDT boundary
as statsService.js. NOTE: this filter was missing entirely until now —
a real bug, not a timezone-math issue — which is why "yesterday's"
calls were showing: there was no date filter applied at all before.
==================================================
*/
/*
==================================================
getCallLog — UPDATED, per explicit request
==================================================
campaignId is now OPTIONAL — omitted/falsy means "every campaign this
agent has touched today," not "no calls at all" (same "campaignId ?
filter : no filter" convention already used by statsService.js's
computeDirectionStats, matched here for consistency). Still always
scoped to agentUser — this agent's own calls only, never anyone
else's — so "all campaigns" naturally can't leak another agent's data.

campaign_id and campaign_name are now SELECTED (previously only used
to FILTER, never returned) — powers the new "Campaign" column
CallLogTable.jsx shows now that a single agent's log can span more
than one campaign in the same day. campaign_name comes via a LEFT
JOIN against asterisk.vicidial_campaigns — LEFT, not INNER, so a call
against a since-deleted campaign still shows (falls back to the raw
campaign_id in that case, same graceful-degradation pattern used
elsewhere in this app for a missing campaign name).
==================================================
*/
async function getCallLog(agentUser, campaignId, limit = 2000) {
  const { start, end } = await getEasternDayBoundsForServerClock();

  const outboundParams = [agentUser];
  let outboundFilter = "";
  if (campaignId) {
    outboundFilter = " AND dcl.campaign_id = ?";
    outboundParams.push(campaignId);
  }
  outboundParams.push(start, end, limit);

  const inboundParams = [agentUser];
  let inboundFilter = "";
  if (campaignId) {
    inboundFilter = " AND icl.campaign_id = ?";
    inboundParams.push(campaignId);
  }
  inboundParams.push(start, end, limit);

  // REAL BUG FIX, per explicit request — LIMIT used to apply only
  // once, to the COMBINED outbound+inbound result after UNION ALL +
  // ORDER BY. That meant a single shared cap across both directions,
  // not `limit` rows of EACH — harmless when campaignId narrows things
  // down enough that combined volume stays under the cap, but with
  // "All Campaigns" selected (campaignId empty, no filter on either
  // subquery), an agent's outbound call volume across every campaign
  // combined routinely swamps the cap by itself, silently crowding out
  // older inbound calls entirely — confirmed live: inbound calls
  // "missing" specifically (and only) in All Campaigns view, never
  // when a single campaign is selected. Each direction now gets its
  // OWN `ORDER BY ... LIMIT ?` inside its own subquery — so inbound
  // calls are never at the mercy of how many outbound calls happened
  // to also occur today — before the outer query re-sorts and trims
  // the combined (up to 2×limit) rows down to `limit` again for the
  // final response.
  const [rows] = await db.execute(
    `
      (
        SELECT
          'outbound' AS direction,
          dcl.call_log_id,
          dcl.call_id,
          dcl.lead_id,
          dcl.call_type,
          dcl.call_started_at,
          dcl.first_name,
          dcl.last_name,
          dcl.phone_number,
          NULL AS callback_number,
          dcl.disposition,
          dcl.xfer_conf,
          dcl.xfer_conf_target,
          dcl.campaign_id,
          c1.campaign_name
        FROM cmx_dialer.dialer_call_log dcl
        LEFT JOIN asterisk.vicidial_campaigns c1 ON c1.campaign_id = dcl.campaign_id
        WHERE dcl.agent_user = ?
          ${outboundFilter}
          AND dcl.call_started_at BETWEEN ? AND ?
        ORDER BY dcl.call_started_at DESC
        LIMIT ?
      )
      UNION ALL
      (
        SELECT
          'inbound' AS direction,
          icl.call_log_id,
          icl.call_id,
          NULL AS lead_id,
          NULL AS call_type,
          icl.call_started_at,
          icl.first_name,
          icl.last_name,
          icl.caller_id_number AS phone_number,
          icl.callback_number,
          icl.disposition,
          icl.xfer_conf,
          icl.xfer_conf_target,
          icl.campaign_id,
          c2.campaign_name
        FROM cmx_dialer.inbound_call_log icl
        LEFT JOIN asterisk.vicidial_campaigns c2 ON c2.campaign_id = icl.campaign_id
        WHERE icl.agent_user = ?
          ${inboundFilter}
          AND icl.call_started_at BETWEEN ? AND ?
        ORDER BY icl.call_started_at DESC
        LIMIT ?
      )
      ORDER BY call_started_at DESC
      LIMIT ?
    `,
    [...outboundParams, ...inboundParams, limit]
  );

  return rows;
}

/*
==================================================
getActiveCallPhoneNumbers
==================================================
Used by adminRoutes.js's /live-status to show the customer's phone
number ("Caller ID" column) for agents currently IN_CALL/ON_HOLD/ACW —
NOT available from any database table for a still-in-progress call,
since dialer_call_log only gets a row once the disposition is SAVED
(i.e. the call has already ended). This is the one place that phone
number actually lives while the call is still live: right here, in
this in-memory Map. Returns a plain { [callId]: phoneNumber } object,
not the full call objects, since that's all reporting needs.
==================================================
*/
function getActiveCallPhoneNumbers() {
  const result = {};
  for (const call of activeCalls.values()) {
    if (call.status !== "ended") {
      result[call.callId] = call.phoneNumber;
    }
  }
  return result;
}

module.exports = {
  getNextLead,
  startCall,
  getCallStatus,
  getActiveCallForAgent,
  getRawActiveCallForAgent,
  getActiveCallPhoneNumbers,
  endCall,
  holdCall,
  unholdCall,
  saveDisposition,
  // NEW — exported per explicit request: the new agent-facing
  // callback-disposition routes (see dialerRoutes.js's PATCH
  // /dialer/voicemail/:id/status and PATCH /dialer/abandoned-call/:id/
  // status) need a real, known list of valid disposition VALUES to
  // validate against before constructing a "CB - <label>" status
  // string — this map's own keys are exactly that list, already
  // proven correct elsewhere in this file (saveDisposition's own
  // lookup). Exporting the KEYS only, not the whole map, since nothing
  // outside this file needs the ViciDial-status side of it.
  KNOWN_DISPOSITION_VALUES: Object.keys(DISPOSITION_TO_VICIDIAL_STATUS),
  getCallLog,
  recordingPathForCall,
  allocateRoomSuffix,
  releaseRoomSuffix,
  roomFromSuffix,
  findCallByRoom,
  handleAutomaticDialOutcome,
};