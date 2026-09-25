import { useEffect, useState } from "react";
import { api } from "../api";
import StatsPanel from "./StatsPanel";
import CallLogTable from "./CallLogTable";
import { formatDurationHMS } from "../utils/format";

/*
==================================================
AgentDashboard — the agent's whole web experience
==================================================
Agents no longer dial from the browser (calls are handled only in the
CMX CallSuite Desktop app), so after login this is the only page they
see: their own stats for today (US Eastern day), time in each status,
and their recent calls. Read-only — no dialing, no call-back actions.
Refreshes itself every minute.
==================================================
*/
const REFRESH_MS = 60000;

const STATUS_LABELS = {
  READY: "Ready",
  NOT_READY: "Not Ready",
  IN_CALL: "In Call",
  ON_HOLD: "On Hold",
  AFTER_CALL_WORK: "After Call Work",
  AD_HOC: "Ad-Hoc",
  LUNCH_BREAK: "Lunch / Break",
  BIO_BREAK: "Bio-Break",
  ADMIN: "Admin",
  MEETING: "Meeting",
  TRAINING: "Training",
  MICROSIP_OUTBOUND: "Direct Call",
};

// Time spent handling or available for calls.
const PRODUCTIVE = new Set(["READY", "IN_CALL", "ON_HOLD", "AFTER_CALL_WORK"]);

function formatClock(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
}

export default function AgentDashboard({ agent }) {
  const [tick, setTick] = useState(0);
  const [campaigns, setCampaigns] = useState([]);
  const [campaignId, setCampaignId] = useState("");
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    api
      .getMyCampaigns()
      .then((data) => setCampaigns(data.campaigns || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    api
      .getMyStatusSummary()
      .then((data) => {
        setSummary(data);
        setError("");
      })
      .catch((err) => setError(err.message));
  }, [tick]);

  const total = summary?.totalSeconds || 0;
  const productive = (summary?.statuses || []).filter((s) => PRODUCTIVE.has(s.status)).reduce((sum, s) => sum + s.seconds, 0);

  return (
    <>
      <div className="card">
        <p style={{ margin: 0 }}>
          Calls are handled in the <strong>CMX CallSuite Desktop</strong> app
          {agent.extension ? (
            <>
              {" "}
              (phone <strong>{agent.extension}</strong>)
            </>
          ) : null}
          . This page shows your own numbers for today (US Eastern time) and refreshes every minute.
        </p>
      </div>

      <div className="card" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <label htmlFor="dash-campaign" style={{ fontWeight: 600 }}>
          Campaign
        </label>
        <select id="dash-campaign" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
          <option value="">All my campaigns</option>
          {campaigns.map((c) => (
            <option key={c.campaign_id} value={c.campaign_id}>
              {c.campaign_name || c.campaign_id}
            </option>
          ))}
        </select>
        <button type="button" className="button-secondary" onClick={() => setTick((t) => t + 1)}>
          Refresh
        </button>
      </div>

      <StatsPanel refreshKey={tick} campaignId={campaignId || undefined} />

      <div className="card stats-panel">
        <div className="stats-header" style={{ cursor: "default" }}>
          <strong>Time in Status Today</strong>
          <span className="stats-inline-total">
            Logged: {formatDurationHMS(total)} · Productive: {total ? Math.round((productive / total) * 100) : 0}% · First
            activity: {formatClock(summary?.firstStartedAt)}
          </span>
        </div>
        {error && <div className="error">{error}</div>}
        {summary && summary.statuses.length === 0 && <p style={{ marginTop: 8 }}>No activity recorded yet today.</p>}
        {summary && summary.statuses.length > 0 && (
          <div className="stats-grid stats-grid-4">
            {summary.statuses.map((s) => (
              <div className="stats-cell" key={s.status}>
                <div className="stats-cell-label">{STATUS_LABELS[s.status] || s.status}</div>
                <div className="stats-cell-value">{formatDurationHMS(s.seconds)}</div>
                <div className="stats-cell-label">{total ? Math.round((s.seconds / total) * 100) : 0}%</div>
              </div>
            ))}
          </div>
        )}
        <p style={{ fontSize: 12, color: "#888", marginTop: 8 }}>
          Productive = Ready + In Call + On Hold + After Call Work, as a share of all time logged today (breaks and
          Not Ready included in the total).
        </p>
      </div>

      <CallLogTable refreshKey={tick} campaignId={campaignId || undefined} canCallBack={false} />
    </>
  );
}
