import { useEffect, useState } from "react";
import { api } from "../../api";
import { getInboundDispositionsForCampaign, getOutboundDispositionsForCampaign } from "../../constants/dispositions";

// IVR language menu ("Require Translation") — must match TRANSLATION_LANGUAGES in
// backend/routes/campaignRoutes.js. defaultRouting is applied when a language is picked.
const TRANSLATION_LANGUAGE_OPTIONS = [
  { value: "en", label: "English", defaultRouting: "agents" },
  { value: "es", label: "Spanish", defaultRouting: "transfer" },
  { value: "zh-cmn", label: "Mandarin", defaultRouting: "ai" },
  { value: "zh-yue", label: "Cantonese", defaultRouting: "ai" },
  { value: "pt", label: "Portuguese", defaultRouting: "ai" },
  { value: "ru", label: "Russian", defaultRouting: "ai" },
  { value: "bn", label: "Bengali", defaultRouting: "ai" },
  { value: "ko", label: "Korean", defaultRouting: "ai" },
  { value: "ht", label: "Haitian Creole", defaultRouting: "ai" },
];
const TRANSLATION_ROUTING_OPTIONS = [
  { value: "agents", label: "Connect normally (agents)" },
  { value: "transfer", label: "Transfer to a number" },
  { value: "ai", label: "AI interpreter (English agent)" },
];
const DEFAULT_TRANSLATION_ROWS = [
  { key: 1, language: "en", routing: "agents", transferNumber: "" },
  { key: 2, language: "es", routing: "transfer", transferNumber: "" },
];

function parseTranslationRows(value) {
  try {
    const rows = typeof value === "string" ? JSON.parse(value) : value;
    if (Array.isArray(rows) && rows.length) {
      return rows.map((r) => ({
        key: Number(r.key),
        language: r.language,
        routing: r.routing,
        transferNumber: r.transferNumber || "",
      }));
    }
  } catch {
    /* fall through to defaults */
  }
  return DEFAULT_TRANSLATION_ROWS.map((r) => ({ ...r }));
}

/*
==================================================
ACTION ICONS — plain inline SVG, deliberately NOT a new npm dependency
==================================================
Per explicit request, to conserve horizontal space in the Existing
Campaigns table. No icon library exists anywhere else in this app
(confirmed — nothing in package.json, no lucide-react/react-icons
usage anywhere in frontend/src), so introducing one here would mean a
new npm install on the server for three small icons, adding deploy
friction for no real benefit. currentColor lets each icon inherit
whatever color its wrapping button already uses (matches the existing
plain ".link" style, no new CSS needed); title (native tooltip) +
aria-label carry the same meaning the removed text labels used to,
since the icons alone aren't self-explanatory to everyone.
==================================================
*/
function EditIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}

function DeactivateIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

/*
==================================================
ADMIN CAMPAIGNS SECTION
==================================================
Creating a campaign here also auto-creates its DID routing
(asterisk.vicidial_inbound_dids), converts + deploys its audio
prompts, and generates/reloads the dialplan that actually routes calls
for that DID — see campaignRoutes.js for the full chain. Nothing here
ever touches pjsip.conf or the shared outbound trunk (CMXSandbox) —
only the dialplan (extensions-campaigns-cmxdialer.conf) and the
database, so campaign management can never disrupt a live call on a
different campaign.

DID is treated as immutable once created — same "delete + recreate"
philosophy as Phone Login's username/extension elsewhere in this app.

Caller ID: leaving it blank means "spoof the DID as the outbound
Caller ID" — the backend does this substitution, not this component;
it's surfaced here only as a placeholder hint.

Business hours are NOT something the user explicitly asked for when
this feature was scoped, but the After Hours audio has no meaning
without a real hours/day window to gate on — defaults to 09:00-18:00,
Mon-Fri if left as-is.

VOICEMAIL — TWO independent toggles, per explicit request: business
hours and after hours can each be turned on/off separately (a campaign
could have voicemail only after hours, only during business hours,
both, or neither) — see campaignRoutes.js's buildCampaignDialplanBlock
for exactly what changes in the generated dialplan for each. Three
separate per-campaign audio uploads: the business-hours IVR prompt
(shown only when that toggle is on), the after-hours IVR prompt (shown
only when THAT toggle is on), and one shared invalid-option/fallback
prompt used by both (shown when either is on). The "leave a message
after the beep" prompt itself and the beep are NOT uploaded here —
they're a single, hardcoded sound file + Asterisk's built-in Beep()
shared by every
campaign, deployed directly to the server rather than through this
form.
==================================================
*/

const DAYS = [
  { key: "mon", label: "Mon" },
  { key: "tue", label: "Tue" },
  { key: "wed", label: "Wed" },
  { key: "thu", label: "Thu" },
  { key: "fri", label: "Fri" },
  { key: "sat", label: "Sat" },
  { key: "sun", label: "Sun" },
];

function daysStringToArray(str) {
  if (!str) return ["mon", "tue", "wed", "thu", "fri"];
  // Supports both "mon-fri" range syntax and "mon,wed,fri" list syntax
  // — GotoIfTime() accepts either, so this just needs to expand a
  // range for the checkbox UI's sake; a plain list passes through as-is.
  if (str.includes("-") && !str.includes(",")) {
    const order = DAYS.map((d) => d.key);
    const [start, end] = str.split("-");
    const startIdx = order.indexOf(start);
    const endIdx = order.indexOf(end);
    if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
      return order.slice(startIdx, endIdx + 1);
    }
  }
  return str.split(",").map((s) => s.trim());
}

function daysArrayToString(arr) {
  // Collapses back to "mon-fri"-style range syntax when the selection
  // is a single contiguous block in calendar order — falls back to a
  // comma list otherwise. Both are valid GotoIfTime() syntax.
  const order = DAYS.map((d) => d.key);
  const sorted = [...arr].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const indices = sorted.map((d) => order.indexOf(d));
  const isContiguous = indices.every((idx, i) => i === 0 || idx === indices[i - 1] + 1);
  if (isContiguous && sorted.length > 1) {
    return `${sorted[0]}-${sorted[sorted.length - 1]}`;
  }
  return sorted.join(",");
}

// Mirrors campaignDispositionService.js's own slugifyValue on the
// backend — kept in sync deliberately (same uppercase/underscore
// rule) so the VALUE code an admin sees while typing a label here is
// exactly what actually gets saved, not just a client-side preview
// that might disagree with the server's own derivation.
function slugifyDispositionValue(label) {
  return String(label || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/*
==================================================
CAMPAIGN DISPOSITIONS EDITOR
==================================================
Per explicit request — lets an admin modify, add, or remove
dispositions from the generic list, saving the campaign's own
Inbound and/or Outbound list independently. Leaving a direction's
checkbox OFF (the default for every campaign that's never touched
this) means that direction keeps using the generic list exactly as it
already does today via getInboundDispositionsForCampaign/
getOutboundDispositionsForCampaign — those two functions, and the
BSMSC/BSCSR hardcoded overrides they already contain, are UNCHANGED by
this feature; this only adds a further per-campaign override on top,
checked first by DialerPage.jsx before falling through to them.

Deliberately its own small component with its own load/save/error
state, entirely separate from the surrounding campaign create/edit
form's own handleSubmit/buildFormData — dispositions have nothing to
do with the campaign's core config, don't involve file uploads, and
saving them shouldn't require re-submitting (or risk re-triggering the
audio/dialplan side effects of) the whole campaign form. Rendered with
key={campaignId} by its parent so switching which campaign is being
edited always starts this editor fresh rather than carrying over
stale rows from whichever campaign was open before.

"Load Generic as Starting Point" seeds the editable rows from
whatever that campaign already effectively shows today (which may
itself be a hardcoded override like BSMSC/BSCSR, not the bare
DISPOSITIONS/INBOUND_DISPOSITIONS list) — the more useful starting
point for an admin who wants to tweak an existing list rather than
build one from nothing.
==================================================
*/
function CampaignDispositionsEditor({ campaignId }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);

  const [inboundEnabled, setInboundEnabled] = useState(false);
  const [outboundEnabled, setOutboundEnabled] = useState(false);
  const [inboundRows, setInboundRows] = useState([]); // [{ value, label, valueTouched }]
  const [outboundRows, setOutboundRows] = useState([]);

  function load() {
    setLoading(true);
    setError("");
    api
      .getCampaignDispositionsAdmin(campaignId)
      .then((data) => {
        setInboundEnabled(Boolean(data.inboundEnabled));
        setOutboundEnabled(Boolean(data.outboundEnabled));
        setInboundRows((data.inbound || []).map((r) => ({ ...r, valueTouched: true })));
        setOutboundRows((data.outbound || []).map((r) => ({ ...r, valueTouched: true })));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: load-on-mount-and-campaign-change is this component's whole data-fetch pattern, same as every other list/table in this app.
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  function rowsSetter(direction) {
    return direction === "INBOUND" ? setInboundRows : setOutboundRows;
  }

  function loadGenericAsStartingPoint(direction) {
    const generic =
      direction === "INBOUND" ? getInboundDispositionsForCampaign(campaignId) : getOutboundDispositionsForCampaign(campaignId);
    rowsSetter(direction)(generic.map((d) => ({ value: d.value, label: d.label, valueTouched: true })));
  }

  function addRow(direction) {
    rowsSetter(direction)((prev) => [...prev, { value: "", label: "", valueTouched: false }]);
  }

  function removeRow(direction, index) {
    rowsSetter(direction)((prev) => prev.filter((_, i) => i !== index));
  }

  function updateLabel(direction, index, newLabel) {
    rowsSetter(direction)((prev) =>
      prev.map((row, i) =>
        i === index ? { ...row, label: newLabel, value: row.valueTouched ? row.value : slugifyDispositionValue(newLabel) } : row
      )
    );
  }

  function updateValue(direction, index, newValue) {
    rowsSetter(direction)((prev) =>
      prev.map((row, i) =>
        i === index ? { ...row, value: newValue.toUpperCase().replace(/\s+/g, "_"), valueTouched: true } : row
      )
    );
  }

  async function handleSave() {
    setError("");
    setSuccess("");
    setBusy(true);
    try {
      await api.saveCampaignDispositions(campaignId, {
        inboundEnabled,
        outboundEnabled,
        inbound: inboundRows.map(({ value, label }) => ({ value, label })),
        outbound: outboundRows.map(({ value, label }) => ({ value, label })),
      });
      setSuccess("Dispositions saved.");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function renderDirectionEditor(direction, enabled, setEnabled, rows) {
    const genericCount =
      direction === "INBOUND"
        ? getInboundDispositionsForCampaign(campaignId).length
        : getOutboundDispositionsForCampaign(campaignId).length;

    return (
      <div style={{ marginTop: 18 }}>
        <label className="disposition-row">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Use Custom {direction === "INBOUND" ? "Inbound" : "Outbound"} Dispositions
        </label>

        {!enabled && (
          <p style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
            Currently using the generic {direction === "INBOUND" ? "inbound" : "outbound"} list ({genericCount} options) — agents
            see this campaign's existing default dropdown. Check the box above to override it.
          </p>
        )}

        {enabled && (
          <>
            {rows.length === 0 && (
              <p style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
                No custom dispositions yet — add one below, or load the current generic list as a starting point to edit from.
              </p>
            )}
            {rows.map((row, i) => (
              <div key={i} style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center" }}>
                <input
                  type="text"
                  placeholder="Label (e.g. Screening Completed)"
                  value={row.label}
                  onChange={(e) => updateLabel(direction, i, e.target.value)}
                  style={{ flex: 2 }}
                />
                <input
                  type="text"
                  placeholder="VALUE_CODE"
                  value={row.value}
                  onChange={(e) => updateValue(direction, i, e.target.value)}
                  title="Stored value — auto-filled from the label, but editable."
                  style={{ flex: 1, fontSize: 12, color: "#888" }}
                />
                <button type="button" className="link" onClick={() => removeRow(direction, i)}>
                  Remove
                </button>
              </div>
            ))}
            <div style={{ marginTop: 8, display: "flex", gap: 12 }}>
              <button type="button" className="link" onClick={() => addRow(direction)}>
                + Add Disposition
              </button>
              <button type="button" className="link" onClick={() => loadGenericAsStartingPoint(direction)}>
                Load Generic as Starting Point
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Dispositions</h3>
      <p style={{ fontSize: 13, color: "#888" }}>
        Override this campaign's Inbound and/or Outbound disposition dropdown independently. Leave a direction unchecked to keep
        using the generic list — nothing changes for agents until you check the box and save.
      </p>

      {loading ? (
        <p>Loading…</p>
      ) : (
        <>
          {error && <div className="error">{error}</div>}
          {success && <div className="success">{success}</div>}

          {renderDirectionEditor("INBOUND", inboundEnabled, setInboundEnabled, inboundRows)}
          {renderDirectionEditor("OUTBOUND", outboundEnabled, setOutboundEnabled, outboundRows)}

          <div style={{ marginTop: 16 }}>
            <button type="button" className="button-secondary" onClick={handleSave} disabled={busy}>
              {busy ? "Saving…" : "Save Dispositions"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function AdminCampaignsSection() {
  const [campaigns, setCampaigns] = useState([]);
  const [editingCampaignId, setEditingCampaignId] = useState(null); // null = create mode

  const [campaignId, setCampaignId] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [did, setDid] = useState("");
  const [callerId, setCallerId] = useState("");
  const [outboundTrunk, setOutboundTrunk] = useState("CMXCallSuite");
  const [availableTrunks, setAvailableTrunks] = useState([]);
  const [campaignType, setCampaignType] = useState("OUTBOUND");
  const [blendedFallbackCampaignId, setBlendedFallbackCampaignId] = useState("");
  const [dialMethod, setDialMethod] = useState("MANUAL");
  const [recordingEnabled, setRecordingEnabled] = useState(true);
  const [businessHoursStart, setBusinessHoursStart] = useState("09:00");
  const [businessHoursEnd, setBusinessHoursEnd] = useState("18:00");
  const [selectedDays, setSelectedDays] = useState(["mon", "tue", "wed", "thu", "fri"]);
  const [active, setActive] = useState(true);

  const [welcomeGreetingFile, setWelcomeGreetingFile] = useState(null);
  const [afterhoursAudioFile, setAfterhoursAudioFile] = useState(null);

  // VOICEMAIL — TWO independent toggles, per explicit request (a
  // campaign can have voicemail during business hours only, after
  // hours only, both, or neither). voicemailWaitSeconds only applies
  // to business hours (after hours has no wait) + three separate
  // audio uploads.
  const [voicemailBusinessHoursEnabled, setVoicemailBusinessHoursEnabled] = useState(false);
  const [voicemailAfterhoursEnabled, setVoicemailAfterhoursEnabled] = useState(false);
  const [voicemailWaitSeconds, setVoicemailWaitSeconds] = useState(60);
  const [voicemailPromptAudioFile, setVoicemailPromptAudioFile] = useState(null);
  const [afterhoursVoicemailPromptAudioFile, setAfterhoursVoicemailPromptAudioFile] = useState(null);
  const [voicemailInvalidOptionAudioFile, setVoicemailInvalidOptionAudioFile] = useState(null);
  // IVR language menu — BLENDED campaigns only. Unchecked = normal routing, unchanged.
  const [translationEnabled, setTranslationEnabled] = useState(false);
  const [translationRows, setTranslationRows] = useState(() => DEFAULT_TRANSLATION_ROWS.map((r) => ({ ...r })));
  const [languageMenuAudioFile, setLanguageMenuAudioFile] = useState(null);
  const [hasLanguageMenuAudio, setHasLanguageMenuAudio] = useState(false);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  function loadAll() {
    setLoading(true);
    api
      .getAdminCampaigns()
      .then((data) => setCampaigns(data.campaigns))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
    // Outbound Trunk options — fetched live from Admin -> DID/Trunk
    // Setup (see AdminTrunksSection.jsx). Fails open (empty list)
    // rather than blocking campaign management entirely if this one
    // fetch has a problem — CMXCallSuite is always available
    // regardless, hardcoded in the JSX since it's the permanent
    // built-in default outside this dynamic system.
    api
      .getTrunks()
      .then((data) => setAvailableTrunks((data.trunks || []).filter((t) => t.active)))
      .catch(() => {});
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: load-on-mount is this component's whole data-fetch pattern, same as every other list/table in this app.
    loadAll();
  }, []);

  function resetForm() {
    setEditingCampaignId(null);
    setCampaignId("");
    setCampaignName("");
    setDid("");
    setCallerId("");
    setOutboundTrunk("CMXCallSuite");
    setCampaignType("OUTBOUND");
    setBlendedFallbackCampaignId("");
    setDialMethod("MANUAL");
    setRecordingEnabled(true);
    setBusinessHoursStart("09:00");
    setBusinessHoursEnd("18:00");
    setSelectedDays(["mon", "tue", "wed", "thu", "fri"]);
    setActive(true);
    setWelcomeGreetingFile(null);
    setAfterhoursAudioFile(null);
    setVoicemailBusinessHoursEnabled(false);
    setVoicemailAfterhoursEnabled(false);
    setVoicemailWaitSeconds(60);
    setVoicemailPromptAudioFile(null);
    setAfterhoursVoicemailPromptAudioFile(null);
    setVoicemailInvalidOptionAudioFile(null);
    setTranslationEnabled(false);
    setTranslationRows(DEFAULT_TRANSLATION_ROWS.map((r) => ({ ...r })));
    setLanguageMenuAudioFile(null);
    setHasLanguageMenuAudio(false);
    setError("");
    setSuccess("");
  }

  function handleStartEdit(c) {
    setEditingCampaignId(c.campaign_id);
    setCampaignId(c.campaign_id);
    setCampaignName(c.campaign_name || "");
    setDid(c.did || "");
    // REAL BUG FIX, per explicit request, following a full production
    // incident this exact gap caused — see this field's own JSX
    // comment below for the full story. Shows the raw campaign_cid
    // ONLY when it's a genuine, real override — NOT when it's just
    // the DID being used as-is (the normal case) or the fake
    // "0000000000" placeholder a DID-less campaign silently falls
    // back to. Showing that placeholder back to the admin would be
    // actively misleading — it looks like a real value sitting there,
    // when it's actually a broken state that gets a real SIP 403 from
    // QuestBlue the moment anyone tries to dial out on it.
    setCallerId(c.campaign_cid && c.campaign_cid !== c.did && c.campaign_cid !== "0000000000" ? c.campaign_cid : "");
    setOutboundTrunk(c.outbound_trunk || "CMXCallSuite");
    setCampaignType(c.campaign_type || "OUTBOUND");
    setBlendedFallbackCampaignId(c.blended_fallback_campaign_id || "");
    setDialMethod(c.dial_method === "MANUAL" ? "MANUAL" : "AUTO");
    setRecordingEnabled(c.campaign_recording !== "NEVER");
    setBusinessHoursStart(c.business_hours_start || "09:00");
    setBusinessHoursEnd(c.business_hours_end || "18:00");
    setSelectedDays(daysStringToArray(c.business_days));
    setActive(c.active === "Y");
    setWelcomeGreetingFile(null);
    setAfterhoursAudioFile(null);
    // VOICEMAIL — pre-fill from the campaign's existing row. Audio
    // files themselves are never pre-filled (same as
    // welcomeGreetingFile/afterhoursAudioFile above) — leaving a file
    // input blank on save means "keep the current file", handled
    // entirely server-side via COALESCE.
    setVoicemailBusinessHoursEnabled(c.voicemail_business_hours_enabled === "Y");
    setVoicemailAfterhoursEnabled(c.voicemail_afterhours_enabled === "Y");
    setVoicemailWaitSeconds(c.voicemail_wait_seconds || 60);
    setVoicemailPromptAudioFile(null);
    setAfterhoursVoicemailPromptAudioFile(null);
    setVoicemailInvalidOptionAudioFile(null);
    setTranslationEnabled(c.translation_enabled === "Y");
    setTranslationRows(parseTranslationRows(c.translation_languages));
    setLanguageMenuAudioFile(null);
    setHasLanguageMenuAudio(Boolean(c.language_menu_audio_filename));
    setError("");
    setSuccess("");
  }

  // ---- IVR language menu rows
  function updateTranslationRow(index, changes) {
    setTranslationRows((rows) =>
      rows.map((row, i) => {
        if (i !== index) return row;
        const next = { ...row, ...changes };
        if (changes.language) {
          const option = TRANSLATION_LANGUAGE_OPTIONS.find((o) => o.value === changes.language);
          next.routing = option ? option.defaultRouting : "agents";
        }
        return next;
      })
    );
  }

  function addTranslationRow() {
    setTranslationRows((rows) => {
      if (rows.length >= 9) return rows;
      const usedKeys = new Set(rows.map((r) => Number(r.key)));
      const usedLanguages = new Set(rows.map((r) => r.language));
      const key = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((k) => !usedKeys.has(k));
      const option = TRANSLATION_LANGUAGE_OPTIONS.find((o) => !usedLanguages.has(o.value));
      if (!key || !option) return rows;
      return [...rows, { key, language: option.value, routing: option.defaultRouting, transferNumber: "" }];
    });
  }

  function removeTranslationRow(index) {
    setTranslationRows((rows) => (rows.length <= 1 ? rows : rows.filter((_, i) => i !== index)));
  }

  function translationProblem() {
    if (!translationEnabled || campaignType !== "BLENDED") return "";
    const keys = new Set();
    const languages = new Set();
    for (const row of translationRows) {
      const label = TRANSLATION_LANGUAGE_OPTIONS.find((o) => o.value === row.language)?.label || row.language;
      if (keys.has(Number(row.key))) return `IVR option ${row.key} is used more than once.`;
      if (languages.has(row.language)) return `${label} is listed more than once.`;
      if (row.routing === "transfer" && row.transferNumber.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "").length !== 10) {
        return `${label}: enter a 10-digit transfer number.`;
      }
      keys.add(Number(row.key));
      languages.add(row.language);
    }
    return "";
  }

  async function handleDeactivate(c) {
    if (
      !window.confirm(
        `Deactivate campaign ${c.campaign_id}? Its DID (${c.did || "none"}) will stop routing calls immediately, and its dialplan block will be removed. The campaign ID stays reserved and its historical call/lead data remains intact — this does NOT permanently erase it.`
      )
    ) {
      return;
    }
    setError("");
    setBusy(true);
    try {
      await api.deactivateCampaign(c.campaign_id);
      if (editingCampaignId === c.campaign_id) resetForm();
      loadAll();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(c) {
    if (
      !window.confirm(
        `PERMANENTLY delete campaign ${c.campaign_id}? This cannot be undone. Its DID and dialplan block are removed immediately, the campaign ID itself is freed for reuse, and any historical call/lead reports referencing this campaign will no longer show its name (the underlying call records aren't deleted, just the name lookup). Use Deactivate instead if you're not sure.`
      )
    ) {
      return;
    }
    setError("");
    setBusy(true);
    try {
      await api.deleteCampaign(c.campaign_id);
      if (editingCampaignId === c.campaign_id) resetForm();
      loadAll();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function toggleDay(dayKey) {
    setSelectedDays((prev) => (prev.includes(dayKey) ? prev.filter((d) => d !== dayKey) : [...prev, dayKey]));
  }

  function buildFormData() {
    const formData = new FormData();
    formData.append("campaignName", campaignName);
    formData.append("outboundTrunk", outboundTrunk);
    formData.append("campaignType", campaignType);
    formData.append("dialMethod", campaignType === "OUTBOUND" ? dialMethod : "MANUAL");
    formData.append("blendedFallbackCampaignId", campaignType === "OUTBOUND" ? blendedFallbackCampaignId : "");
    formData.append("recordingEnabled", String(recordingEnabled));
    // Sent on EVERY save (create AND update), unlike DID which is
    // create-only — see this field's own JSX comment for the full
    // incident this addresses. Sending it every time, always
    // reflecting whatever's actually in this input right now, is
    // exactly what prevents a later, unrelated edit from silently
    // reverting it back to the "0000000000" placeholder the way the
    // missing field used to.
    formData.append("callerId", callerId);
    formData.append("businessHoursStart", businessHoursStart);
    formData.append("businessHoursEnd", businessHoursEnd);
    formData.append("businessDays", daysArrayToString(selectedDays));
    formData.append("active", String(active));
    if (!editingCampaignId) {
      formData.append("campaignId", campaignId);
      formData.append("did", did);
    }
    if (welcomeGreetingFile) formData.append("welcomeGreeting", welcomeGreetingFile);
    if (afterhoursAudioFile) formData.append("afterhoursAudio", afterhoursAudioFile);
    // VOICEMAIL
    formData.append("voicemailBusinessHoursEnabled", String(voicemailBusinessHoursEnabled));
    formData.append("voicemailAfterhoursEnabled", String(voicemailAfterhoursEnabled));
    formData.append("voicemailWaitSeconds", String(voicemailWaitSeconds));
    if (voicemailPromptAudioFile) formData.append("voicemailPromptAudio", voicemailPromptAudioFile);
    if (afterhoursVoicemailPromptAudioFile) formData.append("afterhoursVoicemailPromptAudio", afterhoursVoicemailPromptAudioFile);
    if (voicemailInvalidOptionAudioFile) formData.append("voicemailInvalidOptionAudio", voicemailInvalidOptionAudioFile);
    const translationOn = translationEnabled && campaignType === "BLENDED";
    formData.append("translationEnabled", String(translationOn));
    formData.append(
      "translationLanguages",
      JSON.stringify(
        translationOn
          ? translationRows.map((r) => ({
              key: Number(r.key),
              language: r.language,
              routing: r.routing,
              ...(r.routing === "transfer" ? { transferNumber: r.transferNumber } : {}),
            }))
          : []
      )
    );
    if (translationOn && languageMenuAudioFile) formData.append("languageMenuAudio", languageMenuAudioFile);
    return formData;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSuccess("");

    // REAL BUG FIX, per explicit request, following a full production
    // incident: a DID-less campaign on the QuestBlue trunk with no
    // Caller ID set silently falls back to a fake "0000000000"
    // placeholder — which QuestBlue rejects outright with a SIP 403
    // the moment anyone tries to place a call, with nothing in the
    // app surfacing that failure back to whoever set it up. Caught
    // here, at save time, instead of leaving it to be discovered the
    // hard way during a live test call.
    if (outboundTrunk === "CMXCallSuite" && !did.trim() && !callerId.trim()) {
      setError(
        "This campaign has no DID and no Caller ID, but uses the QuestBlue trunk — outbound calls WILL fail instantly " +
          "(QuestBlue rejects the fake placeholder Caller ID with a SIP 403). Enter a real, provisioned Caller ID below, " +
          "or add a DID, before saving."
      );
      return;
    }

    const problem = translationProblem();
    if (problem) {
      setError(problem);
      return;
    }

    setBusy(true);
    try {
      const formData = buildFormData();
      let result;
      if (editingCampaignId) {
        result = await api.updateCampaign(editingCampaignId, formData);
        setSuccess(`Campaign ${editingCampaignId} updated.${result?.reloadWarning ? ` ${result.reloadWarning}` : ""}`);
      } else {
        result = await api.createCampaign(formData);
        setSuccess(`Campaign ${campaignId} created.${result?.reloadWarning ? ` ${result.reloadWarning}` : ""}`);
      }
      resetForm();
      loadAll();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3>{editingCampaignId ? `Edit Campaign ${editingCampaignId}` : "Create Campaign"}</h3>

      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      {loading ? (
        <p>Loading…</p>
      ) : (
        <div className="dialer-layout">
          <div className="dialer-main">
            <div className="card">
              <form onSubmit={handleSubmit}>
                <label className="comments-label">Campaign ID</label>
                <input
                  type="text"
                  value={campaignId}
                  onChange={(e) => setCampaignId(e.target.value.toUpperCase())}
                  placeholder="e.g. CMXSALES"
                  maxLength={8}
                  required
                  disabled={Boolean(editingCampaignId)}
                />
                {editingCampaignId && (
                  <p style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
                    Campaign ID can't be changed once created — delete and recreate instead.
                  </p>
                )}

                <label className="comments-label">Campaign Name</label>
                <input type="text" value={campaignName} onChange={(e) => setCampaignName(e.target.value)} required />

                <label className="comments-label">DID</label>
                <input
                  type="text"
                  value={did}
                  onChange={(e) => setDid(e.target.value)}
                  placeholder="e.g. 6468016974"
                  disabled={Boolean(editingCampaignId)}
                />
                {editingCampaignId ? (
                  <p style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
                    DID can't be changed once created — delete and recreate instead.
                  </p>
                ) : (
                  <p style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
                    Leave blank for a campaign with no inbound routing at all (pure manual/outbound only).
                  </p>
                )}

                {/* REAL BUG FIX, per explicit request, following a full
                    production incident: this field was previously
                    retired on the assumption that QuestBlue campaigns
                    always have a real DID to fall back on as their
                    Caller ID — true for most campaigns, but NOT for a
                    pure-outbound campaign with no DID at all, which
                    silently fell back to a fake "0000000000"
                    placeholder instead. QuestBlue rejects that fake
                    placeholder outright with a real SIP 403 the moment
                    a call is placed — confirmed live, and the root
                    cause of a lengthy incident before this field came
                    back. Telpeer-trunked campaigns still don't need
                    this (Caller ID is controlled entirely on Telpeer's
                    own portal, per trunk) — but for QuestBlue, this is
                    the ONLY way to give a DID-less campaign a real,
                    working Caller ID. See handleSubmit's own
                    validation above, which blocks saving a
                    QuestBlue + no-DID + no-Caller-ID combination
                    outright now, rather than letting it silently fail
                    later. */}
                <label className="comments-label">Caller ID (optional — QuestBlue only)</label>
                <input
                  type="text"
                  value={callerId}
                  onChange={(e) => setCallerId(e.target.value.replace(/\D/g, "").slice(0, 10))}
                  placeholder="Leave blank to use this campaign's own DID as Caller ID"
                />
                <p style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
                  Only matters for the QuestBlue trunk (Telpeer controls Caller ID on its own portal, per trunk).
                  Leave blank if this campaign has a real DID — QuestBlue uses that automatically. Required if this
                  campaign has NO DID and uses QuestBlue, or outbound calls will fail instantly.
                </p>

                <label className="comments-label">Outbound Trunk</label>
                <select value={outboundTrunk} onChange={(e) => setOutboundTrunk(e.target.value)}>
                  <option value="CMXCallSuite">QuestBlue (default)</option>
                  {availableTrunks.map((t) => (
                    <option key={t.trunk_id} value={t.trunk_name}>
                      {t.trunk_name}
                      {t.description ? ` — ${t.description}` : ""}
                    </option>
                  ))}
                </select>
                <p style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
                  Additional trunks are managed under Admin → DID/Trunk Setup. Telpeer's Caller ID
                  is controlled entirely on Telpeer's own portal, per trunk. QuestBlue uses this
                  campaign's DID as its Caller ID unless overridden above.
                </p>

                <label className="comments-label">Campaign Type</label>
                <select value={campaignType} onChange={(e) => setCampaignType(e.target.value)}>
                  <option value="OUTBOUND">Outbound</option>
                  <option value="BLENDED">Blended</option>
                </select>

                {campaignType === "OUTBOUND" && (
                  <>
                    <label className="comments-label">Dial Method</label>
                    <select value={dialMethod} onChange={(e) => setDialMethod(e.target.value)}>
                      <option value="MANUAL">Manual Dial</option>
                      <option value="AUTO">Auto Dial</option>
                      {/* Predictive Dialing — UI placeholder only, per
                          explicit request. Deliberately NOT selectable
                          yet (disabled) until the real engine (ratio/
                          pacing across multiple agents, dialing ahead
                          of availability) is actually built — a
                          separate, larger piece of work than the
                          simple per-agent "auto-advance" that AUTO
                          currently means. Shown here now so admins can
                          see it's coming, without being able to
                          accidentally select something that doesn't
                          exist yet. */}
                      <option value="PREDICTIVE" disabled>
                        Predictive Dialing (coming soon)
                      </option>
                    </select>

                    {/* Per explicit request, confirmed as a real gap
                        via a live test call: outbound campaigns must
                        never receive inbound calls to their own
                        agents. If this campaign's DID is also used
                        as its outbound Caller ID ("spoofed number"),
                        a customer calling it back needs somewhere
                        real to go — this picks which BLENDED
                        campaign's own queue receives it instead.
                        Leaving this blank means the DID won't answer
                        at all if called back — the safest default. */}
                    <label className="comments-label" style={{ marginTop: 10 }}>
                      Inbound Callback Routes To (optional)
                    </label>
                    <select value={blendedFallbackCampaignId} onChange={(e) => setBlendedFallbackCampaignId(e.target.value)}>
                      <option value="">— None (callback won't be answered) —</option>
                      {campaigns
                        .filter((c) => c.campaign_type === "BLENDED")
                        .map((c) => (
                          <option key={c.campaign_id} value={c.campaign_id}>
                            {c.campaign_name} ({c.campaign_id})
                          </option>
                        ))}
                    </select>
                  </>
                )}

                <label className="disposition-row" style={{ marginTop: 10 }}>
                  <input type="checkbox" checked={recordingEnabled} onChange={(e) => setRecordingEnabled(e.target.checked)} />
                  Call Recording Enabled
                </label>

                <label className="comments-label" style={{ marginTop: 10 }}>
                  Business Hours (used for After Hours routing)
                </label>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input type="time" value={businessHoursStart} onChange={(e) => setBusinessHoursStart(e.target.value)} />
                  <span>to</span>
                  <input type="time" value={businessHoursEnd} onChange={(e) => setBusinessHoursEnd(e.target.value)} />
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
                  {DAYS.map((d) => (
                    <label key={d.key} className="disposition-row" style={{ marginTop: 0 }}>
                      <input type="checkbox" checked={selectedDays.includes(d.key)} onChange={() => toggleDay(d.key)} />
                      {d.label}
                    </label>
                  ))}
                </div>

                <label className="comments-label" style={{ marginTop: 10 }}>
                  Welcome Greeting {editingCampaignId && "(leave blank to keep current)"}
                </label>
                <input type="file" accept="audio/*" onChange={(e) => setWelcomeGreetingFile(e.target.files?.[0] || null)} />

                <label className="comments-label" style={{ marginTop: 10 }}>
                  After Hours Audio {editingCampaignId && "(leave blank to keep current)"}
                </label>
                <input type="file" accept="audio/*" onChange={(e) => setAfterhoursAudioFile(e.target.files?.[0] || null)} />
                <p style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
                  Any common audio format works — converted automatically to what Asterisk needs.
                </p>

                {/*
                  VOICEMAIL — TWO independent toggles, per explicit
                  request. A campaign can have voicemail during
                  business hours only, after hours only, both, or
                  neither. See campaignRoutes.js's
                  buildCampaignDialplanBlock for exactly what changes
                  in the generated dialplan when each one is on.
                */}
                <label className="disposition-row" style={{ marginTop: 14 }}>
                  <input
                    type="checkbox"
                    checked={voicemailBusinessHoursEnabled}
                    onChange={(e) => setVoicemailBusinessHoursEnabled(e.target.checked)}
                  />
                  Voicemail Capture Enabled — Business Hours
                </label>

                {voicemailBusinessHoursEnabled && (
                  <>
                    <label className="comments-label" style={{ marginTop: 10 }}>
                      Business Hours Wait Before Voicemail Offer (seconds, minimum 40)
                    </label>
                    <input
                      type="number"
                      min={40}
                      value={voicemailWaitSeconds}
                      onChange={(e) => setVoicemailWaitSeconds(Math.max(40, Number(e.target.value) || 40))}
                    />

                    <label className="comments-label" style={{ marginTop: 10 }}>
                      Business Hours IVR Prompt {editingCampaignId && "(leave blank to keep current)"}
                    </label>
                    <input type="file" accept="audio/*" onChange={(e) => setVoicemailPromptAudioFile(e.target.files?.[0] || null)} />
                    <p style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
                      Played after the wait above, e.g. "All agents are busy — please stay on the line, or press 1 to leave a
                      voicemail."
                    </p>
                  </>
                )}

                <label className="disposition-row" style={{ marginTop: 14 }}>
                  <input
                    type="checkbox"
                    checked={voicemailAfterhoursEnabled}
                    onChange={(e) => setVoicemailAfterhoursEnabled(e.target.checked)}
                  />
                  Voicemail Capture Enabled — After Hours
                </label>

                {voicemailAfterhoursEnabled && (
                  <>
                    <label className="comments-label" style={{ marginTop: 10 }}>
                      After Hours IVR Prompt {editingCampaignId && "(leave blank to keep current)"}
                    </label>
                    <input
                      type="file"
                      accept="audio/*"
                      onChange={(e) => setAfterhoursVoicemailPromptAudioFile(e.target.files?.[0] || null)}
                    />
                    <p style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
                      Played immediately after hours, e.g. "Our business hours are 9am-6pm, Monday to Friday — press 1 to leave
                      a message."
                    </p>
                  </>
                )}

                {/* Shared between both — only worth showing at all if
                    at least one of the two toggles above is on. */}
                {(voicemailBusinessHoursEnabled || voicemailAfterhoursEnabled) && (
                  <>
                    <label className="comments-label" style={{ marginTop: 10 }}>
                      Invalid Option / Fallback Prompt (shared) {editingCampaignId && "(leave blank to keep current)"}
                    </label>
                    <input
                      type="file"
                      accept="audio/*"
                      onChange={(e) => setVoicemailInvalidOptionAudioFile(e.target.files?.[0] || null)}
                    />
                    <p style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
                      Played once when an unrecognized key is pressed (in either prompt above, or after the caller records
                      their message), before trying again.
                    </p>
                  </>
                )}

                {/* IVR LANGUAGE MENU — BLENDED (inbound) campaigns only, business hours only. */}
                {campaignType === "BLENDED" && (
                  <>
                    <label className="disposition-row" style={{ marginTop: 14 }}>
                      <input
                        type="checkbox"
                        checked={translationEnabled}
                        onChange={(e) => setTranslationEnabled(e.target.checked)}
                      />
                      Require Translation (IVR language menu)
                    </label>

                    {translationEnabled && (
                      <div style={{ marginTop: 8, padding: 10, border: "1px solid #d9dee6", borderRadius: 8 }}>
                        <p style={{ fontSize: 13, color: "#888", marginTop: 0 }}>
                          Business hours only. Call flow: <strong>Language menu</strong> → Welcome Greeting → queue / hold →
                          voicemail option (if enabled). No key or an invalid key replays the menu once, then continues in
                          English. After hours is unchanged (no language menu).
                        </p>

                        <div style={{ overflowX: "auto" }}>
                          <table style={{ width: "100%", borderCollapse: "collapse" }}>
                            <thead>
                              <tr style={{ textAlign: "left", fontSize: 13 }}>
                                <th style={{ padding: 4 }}>IVR Option</th>
                                <th style={{ padding: 4 }}>Language</th>
                                <th style={{ padding: 4 }}>Routing</th>
                                <th style={{ padding: 4 }}>Transfer Number</th>
                                <th style={{ padding: 4 }} />
                              </tr>
                            </thead>
                            <tbody>
                              {translationRows.map((row, index) => {
                                const otherKeys = new Set(translationRows.filter((_, i) => i !== index).map((r) => Number(r.key)));
                                const otherLanguages = new Set(translationRows.filter((_, i) => i !== index).map((r) => r.language));
                                return (
                                  <tr key={index}>
                                    <td style={{ padding: 4 }}>
                                      <select
                                        value={row.key}
                                        onChange={(e) => updateTranslationRow(index, { key: Number(e.target.value) })}
                                      >
                                        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => (
                                          <option key={k} value={k} disabled={otherKeys.has(k)}>
                                            {k}
                                          </option>
                                        ))}
                                      </select>
                                    </td>
                                    <td style={{ padding: 4 }}>
                                      <select
                                        value={row.language}
                                        onChange={(e) => updateTranslationRow(index, { language: e.target.value })}
                                      >
                                        {TRANSLATION_LANGUAGE_OPTIONS.map((o) => (
                                          <option key={o.value} value={o.value} disabled={otherLanguages.has(o.value)}>
                                            {o.label}
                                          </option>
                                        ))}
                                      </select>
                                    </td>
                                    <td style={{ padding: 4 }}>
                                      <select
                                        value={row.routing}
                                        onChange={(e) => updateTranslationRow(index, { routing: e.target.value })}
                                      >
                                        {TRANSLATION_ROUTING_OPTIONS.filter((o) => !(row.language === "en" && o.value === "ai")).map(
                                          (o) => (
                                            <option key={o.value} value={o.value}>
                                              {o.label}
                                            </option>
                                          )
                                        )}
                                      </select>
                                    </td>
                                    <td style={{ padding: 4 }}>
                                      {row.routing === "transfer" ? (
                                        <input
                                          type="tel"
                                          placeholder="10-digit number"
                                          value={row.transferNumber}
                                          onChange={(e) => updateTranslationRow(index, { transferNumber: e.target.value })}
                                        />
                                      ) : (
                                        <span style={{ color: "#888" }}>—</span>
                                      )}
                                    </td>
                                    <td style={{ padding: 4 }}>
                                      <button
                                        type="button"
                                        className="link"
                                        onClick={() => removeTranslationRow(index)}
                                        disabled={translationRows.length <= 1}
                                      >
                                        Remove
                                      </button>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>

                        <button
                          type="button"
                          className="button-secondary"
                          style={{ marginTop: 8 }}
                          onClick={addTranslationRow}
                          disabled={translationRows.length >= 9}
                        >
                          + Add language {translationRows.length >= 9 ? "(maximum 9)" : `(${translationRows.length}/9)`}
                        </button>

                        <label className="comments-label" style={{ marginTop: 12 }}>
                          Language Selection IVR Prompt (separate from the Welcome Greeting){" "}
                          {editingCampaignId && hasLanguageMenuAudio ? "(leave blank to keep current)" : "(required)"}
                        </label>
                        <input type="file" accept="audio/*" onChange={(e) => setLanguageMenuAudioFile(e.target.files?.[0] || null)} />
                        <p style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
                          Played first, before the Welcome Greeting. One recording that lists every option above, e.g. "For
                          English press 1. Para español oprima 2. …".
                          Transfer numbers that are one of our own DIDs route straight into that campaign.
                        </p>
                      </div>
                    )}
                  </>
                )}

                <label className="disposition-row" style={{ marginTop: 10 }}>
                  <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
                  Active
                </label>

                <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                  <button className="button-secondary" type="submit" disabled={busy}>
                    {busy ? "Saving…" : editingCampaignId ? "Save Changes" : "Create Campaign"}
                  </button>
                  {editingCampaignId && (
                    <button type="button" className="link" onClick={resetForm} disabled={busy}>
                      Cancel Edit
                    </button>
                  )}
                </div>
              </form>
            </div>

            {/* Only shown for an existing campaign — dispositions
                belong to a real cmx_dialer.campaign_settings row,
                which doesn't exist yet in Create mode. key={campaignId}
                forces a fresh mount (fresh fetch, fresh local state)
                whenever the admin switches which campaign they're
                editing, instead of carrying over stale rows. */}
            {editingCampaignId && <CampaignDispositionsEditor key={editingCampaignId} campaignId={editingCampaignId} />}
          </div>

          <div className="dialer-side">
            <div className="card call-log-card">
              <h3>Existing Campaigns</h3>
              {campaigns.length === 0 && <p>No campaigns yet.</p>}
              {campaigns.length > 0 && (
                <table className="call-log-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Name</th>
                      <th>DID</th>
                      <th>Type</th>
                      <th>Recording</th>
                      <th>VM (Biz Hrs)</th>
                      <th>VM (After Hrs)</th>
                      <th>Active</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.map((c) => (
                      <tr key={c.campaign_id} className="call-log-row" onDoubleClick={() => handleStartEdit(c)}>
                        <td>{c.campaign_id}</td>
                        <td className="admin-name-cell">{c.campaign_name || "—"}</td>
                        <td>{c.did || "—"}</td>
                        <td>{c.campaign_type || "OUTBOUND"}</td>
                        <td>{c.campaign_recording === "NEVER" ? "Off" : "On"}</td>
                        <td>{c.voicemail_business_hours_enabled === "Y" ? "On" : "Off"}</td>
                        <td>{c.voicemail_afterhours_enabled === "Y" ? "On" : "Off"}</td>
                        <td>{c.active === "Y" ? "Yes" : "No"}</td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <button
                            type="button"
                            className="link"
                            onClick={() => handleStartEdit(c)}
                            disabled={busy}
                            title="Edit"
                            aria-label={`Edit ${c.campaign_id}`}
                          >
                            <EditIcon />
                          </button>{" "}
                          <button
                            type="button"
                            className="link"
                            onClick={() => handleDeactivate(c)}
                            disabled={busy}
                            title="Deactivate"
                            aria-label={`Deactivate ${c.campaign_id}`}
                          >
                            <DeactivateIcon />
                          </button>{" "}
                          <button
                            type="button"
                            className="link"
                            onClick={() => handleDelete(c)}
                            disabled={busy}
                            title="Delete"
                            aria-label={`Delete ${c.campaign_id}`}
                          >
                            <DeleteIcon />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
