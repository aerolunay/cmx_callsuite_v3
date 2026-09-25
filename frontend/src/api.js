/*
Thin fetch wrapper. All requests go through Vite's dev proxy (see
vite.config.js) so relative /api/* paths reach the Express backend on
port 5060 without CORS headaches. credentials: "include" is required on
every call so the session cookie actually gets sent/received.

UPDATED — when options.body is a FormData instance (used for Campaign
audio-upload requests), Content-Type is deliberately NOT set here.
The browser must set its own multipart/form-data header WITH the
correct boundary string itself; forcing "application/json" (or any
manual multipart header) here would break the upload silently.
*/
async function request(path, options = {}) {
  const isFormData = options.body instanceof FormData;

  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {}),
    },
    ...options,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const error = new Error(data.message || `Request failed (${res.status})`);
    error.status = res.status;
    error.reason = data.reason;
    throw error;
  }

  return data;
}

export const api = {
  // Auth
  checkUser: (email) => request("/auth/check-user", { method: "POST", body: JSON.stringify({ email }) }),
  getVersion: () => request("/auth/version"),
  requestOtp: (email) =>
    request("/auth/request-otp", { method: "POST", body: JSON.stringify({ email }) }),
  verifyOtp: (email, code) =>
    request("/auth/verify-otp", { method: "POST", body: JSON.stringify({ email, code }) }),
  loginTotp: (email, code) =>
    request("/auth/login-totp", { method: "POST", body: JSON.stringify({ email, code }) }),
  me: () => request("/auth/me"),
  logout: () => request("/auth/logout", { method: "POST" }),
  totpSetup: () => request("/auth/totp/setup", { method: "POST" }),
  totpConfirm: (code) =>
    request("/auth/totp/confirm", { method: "POST", body: JSON.stringify({ code }) }),

  // Campaigns
  getCampaigns: () => request("/campaigns"),
  // Scoped to the logged-in agent's own campaign assignments — see
  // dialerRoutes.js's GET /campaigns/mine for why this is a genuinely
  // separate endpoint from getCampaigns() above, not a variant of it.
  getMyCampaigns: () => request("/campaigns/mine"),
  // Multi-campaign selection — NEW. GET returns the agent's current
  // live selection (for pre-checking boxes on load); POST replaces it
  // entirely, subject to real server-side validation (assignment
  // check, multi_campaign_enabled check, outbound-exclusivity check —
  // see dialerRoutes.js's own route comment for the full rules).
  getWorkingCampaigns: () => request("/dialer/working-campaigns"),
  setWorkingCampaigns: (campaignIds) =>
    request("/dialer/working-campaigns", { method: "POST", body: JSON.stringify({ campaignIds }) }),
  getCampaignAgents: (campaignId) => request(`/dialer/campaign-agents?campaignId=${encodeURIComponent(campaignId)}`),

  // Call history / stats
  // UPDATED — campaignId is now optional on both (empty/omitted =
  // "all campaigns," matching the same convention already used by
  // getAbandonedCalls/getTotalCalls/etc. elsewhere in this file), per
  // explicit request to retire the single "Main Campaign" concept.
  getCallLog: (campaignId) => request(`/dialer/call-log${campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : ""}`),
  getMyStatusSummary: () => request("/dialer/my-status-summary"),
  getTodayStats: (campaignId) =>
    request(`/dialer/stats/today${campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : ""}`),

  // Abandoned & Voicemail tab on DialerPage — combined feed, scoped to
  // the agent's own assigned campaigns server-side. campaignId omitted
  // means "all my campaigns" (same convention as getCallLog above);
  // startDate/endDate omitted means "today."
  getAbandonedVoicemail: (params) => {
    const query = new URLSearchParams();
    if (params?.campaignId) query.set("campaignId", params.campaignId);
    if (params?.startDate) query.set("startDate", params.startDate);
    if (params?.endDate) query.set("endDate", params.endDate);
    const qs = query.toString();
    return request(`/dialer/abandoned-voicemail${qs ? `?${qs}` : ""}`);
  },
  getAgentVoicemailPlaybackUrl: (voicemailLogId) => request(`/dialer/voicemail/${voicemailLogId}/playback-url`),
  // REDESIGNED — per explicit request: clicking "Callback" on an
  // Abandoned & Voicemail row now places a REAL call (see
  // DialerPage.jsx's handleAbandonedVoicemailCallback), reusing the
  // existing startCall/saveDisposition flow — the disposition the
  // agent picks on the NORMAL post-call form is what gets recorded on
  // that row's status server-side (see dialerRoutes.js's
  // POST /dialer/disposition/:callId). The standalone
  // setVoicemailCallback/setAbandonedCallCallback functions that used
  // to live here (a separate, inline disposition picker with no
  // actual call) are gone — their routes no longer exist either.
  // NEW — checked before placing a MANUAL dial only (never for
  // outbound campaign/lead auto-dialing) — see DialerPage.jsx's own
  // manual-dial handler.
  checkCallbackPending: (phoneNumber) =>
    request(`/dialer/check-callback-pending?phoneNumber=${encodeURIComponent(phoneNumber)}`),
  // NEW — outbound trunk management (Admin -> DID/Trunk Setup). Lets
  // an admin add/edit/remove a SIP trunk directly through the app,
  // instead of hand-writing pjsip.conf over SSH.
  getTrunks: () => request("/admin/trunks"),
  createTrunk: (payload) => request("/admin/trunks", { method: "POST", body: JSON.stringify(payload) }),
  updateTrunk: (trunkId, payload) =>
    request(`/admin/trunks/${trunkId}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteTrunk: (trunkId) => request(`/admin/trunks/${trunkId}`, { method: "DELETE" }),

  // Agent status
  getStatus: () => request("/dialer/status"),
  getWebrtcCredentials: () => request("/dialer/webrtc-credentials"),
  conferenceAdd: (target, isExtension) =>
    request("/dialer/conference-add", { method: "POST", body: JSON.stringify({ target, isExtension }) }),
  transferBlind: (target, isExtension) =>
    request("/dialer/transfer-blind", { method: "POST", body: JSON.stringify({ target, isExtension }) }),
  startLineTwo: (target, isExtension) =>
    request("/dialer/line-two/start", { method: "POST", body: JSON.stringify({ target, isExtension }) }),
  completeLineTwo: (action) =>
    request("/dialer/line-two/complete", { method: "POST", body: JSON.stringify({ action }) }),
  cancelLineTwo: () => request("/dialer/line-two/cancel", { method: "POST" }),
  switchLine: (line) => request("/dialer/line-two/switch", { method: "POST", body: JSON.stringify({ line }) }),
  getLineTwoStatus: () => request("/dialer/line-two/status"),
  holdLineTwo: () => request("/dialer/line-two/hold", { method: "POST" }),
  unholdLineTwo: () => request("/dialer/line-two/unhold", { method: "POST" }),
  setStatus: (status, campaignId) =>
    request("/dialer/status", { method: "POST", body: JSON.stringify({ status, campaignId }) }),
  hasLeads: (campaignId) => request(`/dialer/has-leads?campaignId=${encodeURIComponent(campaignId)}`),

  // Dialer
  nextLead: (campaignId) =>
    request("/dialer/next-lead", { method: "POST", body: JSON.stringify({ campaignId }) }),
  startCall: (campaignId, leadId, phoneNumber, lead, callType) =>
    request("/dialer/start-call", {
      method: "POST",
      body: JSON.stringify({ campaignId, leadId, phoneNumber, lead, callType }),
    }),
  getCurrentCall: () => request("/dialer/current-call"),
  getCurrentInboundCall: () => request("/dialer/inbound/current"),
  endCall: (callId) => request(`/dialer/end-call/${callId}`, { method: "POST" }),
  holdCall: (callId) => request(`/dialer/hold/${callId}`, { method: "POST" }),
  unholdCall: (callId) => request(`/dialer/unhold/${callId}`, { method: "POST" }),
  // callId is required on all 4 of these now — v2's multi-call inbound
  // rebuild means there's no more implicit "the" inbound call.
  holdInbound: (callId) => request(`/dialer/inbound/hold`, { method: "POST", body: JSON.stringify({ callId }) }),
  unholdInbound: (callId) => request(`/dialer/inbound/unhold`, { method: "POST", body: JSON.stringify({ callId }) }),
  endInboundCall: (callId) => request(`/dialer/inbound/end-call`, { method: "POST", body: JSON.stringify({ callId }) }),
  saveDisposition: (callId, payload) =>
    request(`/dialer/disposition/${callId}`, { method: "POST", body: JSON.stringify(payload) }),
  saveInboundDisposition: (payload) =>
    request(`/dialer/inbound-disposition`, { method: "POST", body: JSON.stringify(payload) }),

  // Admin
  getAvailableVicidialUsers: () => request("/admin/vicidial-users/available"),
  getAdminUsers: () => request("/admin/users"),
  createAdminUser: (payload) =>
    request("/admin/users", { method: "POST", body: JSON.stringify(payload) }),
  // Combined creation — writes BOTH a brand new asterisk.vicidial_users
  // row AND the matching cmx_dialer.app_users row in one transaction
  // (see adminRoutes.js's POST /users/full). Kept as a genuinely
  // separate function from createAdminUser above, which still requires
  // binding to an ALREADY-existing ViciDial user — that path is
  // untouched.
  createFullUser: (payload) =>
    request("/admin/users/full", { method: "POST", body: JSON.stringify(payload) }),
  // ViciDial Users — standalone CRUD, separated out per explicit
  // request from being bundled inside app-user creation. A user
  // created here becomes immediately bindable via
  // getAvailableVicidialUsers()'s dropdown, same as any pre-existing
  // account.
  getVicidialUsers: () => request("/admin/vicidial-users"),
  createVicidialUser: (payload) =>
    request("/admin/vicidial-users", { method: "POST", body: JSON.stringify(payload) }),
  updateVicidialUser: (username, payload) =>
    request(`/admin/vicidial-users/${encodeURIComponent(username)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  deleteVicidialUser: (username) =>
    request(`/admin/vicidial-users/${encodeURIComponent(username)}`, { method: "DELETE" }),
  // Phones — view/edit/delete only now. Standalone creation removed:
  // every phone is created as a side effect of createVicidialUser()
  // above. extension is treated as immutable — no rename endpoint
  // exists, matching adminRoutes.js's own design (delete + recreate).
  getPhones: () => request("/admin/phones"),
  updatePhone: (extension, payload) =>
    request(`/admin/phones/${encodeURIComponent(extension)}`, { method: "PUT", body: JSON.stringify(payload) }),
  deletePhone: (extension) =>
    request(`/admin/phones/${encodeURIComponent(extension)}`, { method: "DELETE" }),
  updateAdminUser: (appUserId, payload) =>
    request(`/admin/users/${appUserId}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteAdminUser: (appUserId) =>
    request(`/admin/users/${appUserId}`, { method: "DELETE" }),
  kickAgent: (appUserId) =>
    request(`/admin/users/${appUserId}/kick`, { method: "POST" }),
  startListen: (appUserId) =>
    request("/admin/listen/start", { method: "POST", body: JSON.stringify({ appUserId }) }),
  stopListen: () => request("/admin/listen/stop", { method: "POST" }),
  // Real-time priority control — used by the Live Status Dashboard's
  // "Set Prio" per-row action. Deliberately lightweight/standalone,
  // not routed through updateAdminUser's full-form PUT.
  updateAgentPriority: (appUserId, priority) =>
    request(`/admin/users/${appUserId}/priority`, { method: "PATCH", body: JSON.stringify({ priority }) }),
  getLiveStatus: (campaignId) =>
    request(`/admin/live-status${campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : ""}`),
  getQueueStatus: (campaignId) =>
    request(`/admin/queue-status${campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : ""}`),
  getAbandonedCalls: (campaignId) =>
    request(`/admin/abandoned-calls${campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : ""}`),
  getTotalCalls: (campaignId) =>
    request(`/admin/total-calls${campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : ""}`),
  getScreeningHandoffCode: () => request("/dialer/screening-handoff-code", { method: "POST" }),
  getReportingSummary: (campaignId) =>
    request(`/admin/reporting-summary${campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : ""}`),
  getAggregateStats: (campaignId) =>
    request(`/admin/stats/today${campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : ""}`),

  // Reports (from production, Phase 8)
  getCampaignAgentBreakdown: (startDate, endDate, campaignId) => {
    const params = new URLSearchParams({ startDate, endDate });
    if (campaignId) params.set("campaignId", campaignId);
    return request(`/admin/reports/campaign-agent-breakdown?${params.toString()}`);
  },
  // Second report type — one row per call, combining inbound+outbound.
  getRawCallsReport: (startDate, endDate, campaignId) => {
    const params = new URLSearchParams({ startDate, endDate });
    if (campaignId) params.set("campaignId", campaignId);
    return request(`/admin/reports/raw-calls?${params.toString()}`);
  },
  // Third/fourth report types — Abandoned Calls, aggregated and raw,
  // same startDate/endDate/campaignId shape as the two above.
  getAbandonedCallsAggregatedReport: (startDate, endDate, campaignId) => {
    const params = new URLSearchParams({ startDate, endDate });
    if (campaignId) params.set("campaignId", campaignId);
    return request(`/admin/reports/abandoned-calls-aggregated?${params.toString()}`);
  },
  getAbandonedCallsRawReport: (startDate, endDate, campaignId) => {
    const params = new URLSearchParams({ startDate, endDate });
    if (campaignId) params.set("campaignId", campaignId);
    return request(`/admin/reports/abandoned-calls-raw?${params.toString()}`);
  },
  // NEW — "Calls Flagged" (call avoidance tracking), admin/wfm only.
  getCallFlags: (startDate, endDate, campaignId) => {
    const params = new URLSearchParams();
    if (startDate) params.set("startDate", startDate);
    if (endDate) params.set("endDate", endDate);
    if (campaignId) params.set("campaignId", campaignId);
    const qs = params.toString();
    return request(`/admin/call-flags${qs ? `?${qs}` : ""}`);
  },

  // Leads Calling Dashboard — NEW. Campaign picker is OUTBOUND
  // campaigns that actually have leads uploaded (scoped server-side to
  // the caller's own assignments for every role except admin/wfm —
  // see adminRoutes.js). Summary takes a comma-separated campaignIds
  // list ("select all outbound campaigns" resolves to every id from
  // the campaigns call above before this is sent); omitting it
  // resolves server-side to "every campaign this role can see."
  getLeadsDashboardCampaigns: () => request("/admin/leads-dashboard/campaigns"),
  getLeadsDashboardSummary: (startDate, endDate, campaignIds) => {
    const params = new URLSearchParams({ startDate, endDate });
    if (campaignIds && campaignIds.length > 0) params.set("campaignIds", campaignIds.join(","));
    return request(`/admin/leads-dashboard/summary?${params.toString()}`);
  },

  // Campaign management — create/edit auto-creates the DID routing,
  // dialplan, and audio prompts server-side (see campaignRoutes.js).
  // create/update use FormData (not JSON.stringify) since both may
  // include the two audio file uploads — request() in this file
  // already knows to skip forcing a JSON Content-Type when the body
  // is a FormData instance.
  getAdminCampaigns: (queryString) => request(`/admin/campaigns${queryString ? `?${queryString}` : ""}`),
  createCampaign: (formData) => request("/admin/campaigns", { method: "POST", body: formData }),
  updateCampaign: (campaignId, formData) =>
    request(`/admin/campaigns/${encodeURIComponent(campaignId)}`, { method: "PUT", body: formData }),
  deactivateCampaign: (campaignId) =>
    request(`/admin/campaigns/${encodeURIComponent(campaignId)}/deactivate`, { method: "POST" }),
  deleteCampaign: (campaignId) =>
    request(`/admin/campaigns/${encodeURIComponent(campaignId)}`, { method: "DELETE" }),

  // Per-campaign custom disposition lists (Inbound/Outbound), editable
  // via AdminCampaignsSection.jsx's own "Dispositions" panel — see
  // campaignDispositionService.js on the backend for the full
  // reasoning. JSON body, unlike createCampaign/updateCampaign above —
  // no file uploads involved here.
  getCampaignDispositionsAdmin: (campaignId) =>
    request(`/admin/campaigns/${encodeURIComponent(campaignId)}/dispositions`),
  saveCampaignDispositions: (campaignId, payload) =>
    request(`/admin/campaigns/${encodeURIComponent(campaignId)}/dispositions`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  // Agent-facing read of the same data — used by DialerPage.jsx to
  // resolve the effective disposition list for whatever campaign the
  // active call belongs to.
  getCampaignDispositionsForAgent: (campaignId) =>
    request(`/dialer/campaigns/${encodeURIComponent(campaignId)}/dispositions`),

  // Recordings — deliberately at /recordings, not /admin/recordings,
  // since this is now its own standalone page (RecordingsPage.jsx),
  // not part of Admin — gated server-side by requireAdminOrSupervisor
  // in dialerRoutes.js, not requireAdmin.
  getRecordings: (queryString) => request(`/recordings${queryString ? `?${queryString}` : ""}`),
  getRecordingPlaybackUrl: (callId) =>
    request(`/recordings/${encodeURIComponent(callId)}/playback-url`),
  getRecordingDownloadUrl: (callId) =>
    request(`/recordings/${encodeURIComponent(callId)}/download-url`),

  // Voicemails — its own standalone page (VoicemailsPage.jsx), gated
  // server-side by voicemailRoutes.js's own access matrix, which
  // deliberately does NOT match Recordings' (training_quality is
  // unrestricted here, wfm has no access at all — see that file's own
  // comment on why). getVoicemailCampaigns() is a narrow helper ONLY
  // for admin/training_quality's "All Campaigns" dropdown — supervisor/
  // account_manager use the existing getMyCampaigns() instead.
  getVoicemails: (queryString) => request(`/voicemails${queryString ? `?${queryString}` : ""}`),
  getVoicemailCampaigns: () => request("/voicemails/campaigns"),
  getVoicemail: (voicemailLogId) => request(`/voicemails/${encodeURIComponent(voicemailLogId)}`),
  getVoicemailPlaybackUrl: (voicemailLogId) =>
    request(`/voicemails/${encodeURIComponent(voicemailLogId)}/playback-url`),
  getVoicemailDownloadUrl: (voicemailLogId) =>
    request(`/voicemails/${encodeURIComponent(voicemailLogId)}/download-url`),

  // Outbound Auto-Dial, Phase 1 — lead upload, DNC management, and
  // per-campaign autodial rules. Template downloads are plain GET
  // endpoints that return a file with Content-Disposition: attachment
  // — the component just links straight to these URLs rather than
  // routing through this fetch wrapper, so the browser handles the
  // download natively.
  uploadLeads: (formData) => request("/admin/leads/upload", { method: "POST", body: formData }),
  previewLeadsCleanup: (campaignId) =>
    request("/admin/leads/cleanup/preview", { method: "POST", body: JSON.stringify({ campaignId: campaignId || null }) }),
  confirmLeadsCleanup: (campaignId) =>
    request("/admin/leads/cleanup/confirm", { method: "POST", body: JSON.stringify({ campaignId: campaignId || null }) }),
  getDncList: () => request("/admin/dnc"),
  uploadDnc: (formData) => request("/admin/dnc/upload", { method: "POST", body: formData }),
  getAutodialRules: (campaignId) => request(`/admin/campaigns/${encodeURIComponent(campaignId)}/autodial-rules`),
  updateAutodialRules: (campaignId, rules) =>
    request(`/admin/campaigns/${encodeURIComponent(campaignId)}/autodial-rules`, {
      method: "PUT",
      body: JSON.stringify(rules),
    }),
};