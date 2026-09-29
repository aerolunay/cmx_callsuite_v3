"use strict";

const crypto = require("crypto");
const ami = require("../config/ami");

/*
==================================================
monitoringService — Silent Listen
==================================================
Per explicit request: lets supervisor/training_quality/admin roles
silently join an agent's live call, completely inaudible to both the
agent and the customer. Reuses this app's existing
ConfBridge-room-per-call architecture rather than inventing a
separate mechanism (e.g. ChanSpy) — the listener is just another
participant in the SAME room, using a dedicated, always-muted, quiet
user profile (cmx_silent_listener in confbridge.conf) so their
join/leave produces no audible cue and their own audio is never mixed
in. No menu is passed to ConfBridge() here at all, so there's no DTMF
path to unmute — silence is the only possible state for this
participant, not just the default one.

Per explicit request — single "Listen" action per agent, no separate
Line 1/Line 2 buttons at all. Automatically follows whichever room the
AGENT'S OWN audio is currently bridged to (call.activeLine, this
app's own existing source of truth — see attendedTransferService.js),
migrating the listener's channel any time that changes: starting Line
2, switching between lines, completing (merging Line 2 into the main
call), or canceling back to Line 1. Conference and Blind Transfer
participants need NO separate handling at all — confirmed directly,
those features add participants to the SAME room as Line 1
(active.room in dialerRoutes.js), never a separate one, so listening
to Line 1's room already includes them automatically.

Modeled directly on conferenceService.js's addParticipant() — same
proven ConfbridgeJoin-based success confirmation (OriginateResponse
alone only confirms the channel was created, not that it actually
joined the room), same Originate-failure handling. Deliberately NOT
reusing addParticipant() itself: that function's whole purpose is
adding an audible participant to Line 2/Conference/Transfer, and its
signature (isExtension, callerIdLabel, excludeChannels, campaignCid)
carries assumptions that don't apply here — Caller ID doesn't matter
for a channel nobody will ever hear ring or speak.
==================================================
*/

const ORIGINATE_TIMEOUT_MS = 30000;

// Keyed by the listening supervisor's own appUserId -> everything
// needed to both hang up AND re-originate a migrated session without
// any external lookup: the exact, real channel name AMI assigned
// (from ConfbridgeJoin's evt.channel, NOT guessed from a naming
// pattern — ami.js's own hangupChannel() needs an exact match, and
// PJSIP channel names carry an unpredictable numeric suffix), which
// room they're currently in, which agent (appUserId) they're
// listening to (so a line-switch can find "is anyone listening to
// THIS agent"), and their own extension (so migrating doesn't need
// the caller to pass it in again).
const activeListenSessions = new Map();

/*
startSilentListen(room, listenerExtension, listenerAppUserId, targetAppUserId, excludeChannels)
Originates a channel to the requesting supervisor's own registered
softphone extension, joining them into the given room as a silent
listener. Resolves { success: true, channel } once they actually
join (confirmed via ConfbridgeJoin, not just Originate accepting the
request), or { success: false, reason } otherwise.
*/
function startSilentListen(room, listenerExtension, listenerAppUserId, targetAppUserId, excludeChannels = []) {
  return new Promise((resolve) => {
    const actionId = crypto.randomUUID();
    let settled = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ami.events.removeListener("ConfbridgeJoin", onJoin);
      ami.events.removeListener("OriginateResponse", onOriginateFailure);
      resolve(result);
    }

    const timeout = setTimeout(() => {
      finish({ success: false, reason: "timeout" });
    }, ORIGINATE_TIMEOUT_MS);

    function onJoin(evt) {
      if (evt.conference !== room) return;
      if (excludeChannels.includes(evt.channel)) return;
      activeListenSessions.set(listenerAppUserId, { channel: evt.channel, room, targetAppUserId, listenerExtension });
      finish({ success: true, channel: evt.channel });
    }

    function onOriginateFailure(evt) {
      if (evt.actionid !== actionId) return;
      if (evt.response === "Success") return;
      finish({ success: false, reason: evt.reason || "originate_failed" });
    }

    ami.events.on("ConfbridgeJoin", onJoin);
    ami.events.on("OriginateResponse", onOriginateFailure);

    const originateParams = {
      ActionID: actionId,
      Channel: `PJSIP/${listenerExtension}`,
      Application: "ConfBridge",
      Data: `${room},vici_agent_bridge,cmx_silent_listener`,
      Async: "true",
      // REAL BUG FIX, confirmed live: a supervisor without /dialer
      // page access (e.g. some admin roles) has nowhere to click
      // "Answer" at all — MiniPhone.jsx, the only UI with that
      // button, only renders on that one page, while this Originate
      // rings their browser regardless of which page they're
      // actually on (the softphone connection itself is app-wide).
      // Without this, the call just rings unanswered until the
      // 30s timeout above gives up — confirmed exactly this way with
      // a real admin account. This distinctive Caller ID lets
      // PhoneContext.jsx recognize a Silent Listen call specifically
      // and auto-answer it immediately, regardless of page, while
      // every other kind of incoming call still requires a real,
      // manual answer as before. Also relied on below by
      // syncListenerRoom's own re-originate (a migration is really
      // just another Silent Listen call, same auto-answer path).
      CallerID: '"VoxSuite Silent Listen" <9999>',
    };

    ami.originate(originateParams).catch(() => {
      finish({ success: false, reason: "originate_request_failed" });
    });
  });
}

/*
endSilentListen(listenerAppUserId)
Hangs up the supervisor's own listening channel, using the exact
channel name recorded when the session started. If there's no
recorded session (e.g. it already ended, or never actually
succeeded), this is a no-op rather than an error — nothing to clean
up either way.
*/
async function endSilentListen(listenerAppUserId) {
  const session = activeListenSessions.get(listenerAppUserId);
  if (!session) return { success: true, alreadyEnded: true };

  activeListenSessions.delete(listenerAppUserId);
  try {
    await ami.hangupChannel(session.channel);
    return { success: true };
  } catch (err) {
    // The channel may have already been torn down naturally (e.g. the
    // call itself ended while the supervisor was still listening) —
    // that's a success from this function's point of view, not a
    // failure worth surfacing.
    return { success: true, note: err.message };
  }
}

/*
==================================================
syncListenerRoom
==================================================
Per explicit request — automatic Line 1/Line 2 switching, no manual
re-clicking. Called from attendedTransferService.js at every single
point where an agent's active line can change (starting Line 2,
switching either direction, completing, canceling) — see that file's
own calls to this function for the full list. A no-op, cheaply and
safely, in the overwhelmingly common case where nobody is currently
listening to this specific agent at all.

targetAppUserId: the AGENT whose call this is (not the listener).
newRoom: whichever room the agent's own audio is NOW bridged to.
excludeChannels: same purpose as startSilentListen's own param — the
agent/customer channels already known to be in newRoom, so the
ConfbridgeJoin confirmation below doesn't false-positive on their
join event instead of the migrated listener's own.

Fire-and-forget by design (never awaited by any caller) — a
migration failing should never block or delay the actual call-control
action (switching lines, completing Line 2, etc.) that triggered it.
Errors are logged, not thrown.
==================================================
*/
function syncListenerRoom(targetAppUserId, newRoom, excludeChannels = []) {
  let listenerAppUserId = null;
  let session = null;
  for (const [id, s] of activeListenSessions.entries()) {
    if (s.targetAppUserId === targetAppUserId) {
      listenerAppUserId = id;
      session = s;
      break;
    }
  }

  if (!session) return; // nobody listening to this agent right now — nothing to do
  if (session.room === newRoom) return; // already correctly placed

  const { listenerExtension } = session;

  // Hang up the old channel first, then re-originate into the new
  // room — same as endSilentListen + startSilentListen individually,
  // just without the caller needing to orchestrate both steps
  // separately or re-supply the extension.
  ami
    .hangupChannel(session.channel)
    .catch((err) => {
      if (!ami.isExpectedAlreadyGoneError(err)) {
        console.error("[monitoringService] Failed to hang up old channel during room sync:", err.message);
      }
    })
    .finally(() => {
      startSilentListen(newRoom, listenerExtension, listenerAppUserId, targetAppUserId, excludeChannels).then((result) => {
        if (!result.success) {
          console.error("[monitoringService] Failed to re-originate listener during room sync:", result.reason);
          activeListenSessions.delete(listenerAppUserId);
        }
      });
    });
}

module.exports = { startSilentListen, endSilentListen, syncListenerRoom };