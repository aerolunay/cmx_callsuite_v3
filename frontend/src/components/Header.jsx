import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useAppVersion } from "../hooks/useAppVersion";
import logo from "../assets/cmxlogo_white.png";

/*
==================================================
agentStatus prop — deliberately scoped to DialerPage only
==================================================
Header is shared across every page (DialerPage, Admin, Live Status,
Landing), but live call-state (READY/NOT_READY/IN_CALL/etc.) is only
ever tracked on DialerPage itself — no other page has a concept of it
at all. Rather than build a global status-tracking mechanism just for
this one button, DialerPage passes its already-known current status in
directly; every other page renders Header with no status prop at all,
so logout stays unrestricted there (there's no "mid-call" risk to
guard against on a page that was never tracking a call in the first
place). If this needs to apply more broadly later, that's a bigger
change (status would need to live somewhere shared, like AuthContext),
not just a Header tweak.

canLogout defaults to true when status is unknown (undefined) —
covers admin/no-extension accounts, which never go through these
states at all and shouldn't be blocked from logging out.
==================================================
*/
export default function Header({ agentStatus }) {
  const { agent, logout } = useAuth();
  const appVersion = useAppVersion();

  const canLogout = agentStatus === undefined || agentStatus === "NOT_READY";

  return (
    <header className="header">
      <div className="header-logo">
        <img src={logo} alt="CallMax" />
        {appVersion && <div className="header-version">CMX Call Suite V{appVersion}</div>}
      </div>

      {agent && (
        <div className="header-right">
          {/*
            ==================================================
            NAV MATRIX — per the finished access-level spec
            ==================================================
            Dialer      : REMOVED from the web app — calls are handled only in the
                          CMX CallSuite Desktop app. Agents land on their own
                          dashboard (LandingPage.jsx).
            Live Status : supervisor, training_quality, account_manager, wfm, admin
            Reports     : supervisor, account_manager, wfm, admin (NOT training_quality)
            Leads Dashboard : supervisor, account_manager, wfm, admin (same
                          split as Reports — NEW)
            Recordings  : supervisor, training_quality, account_manager, admin (NOT wfm)
            Voicemails  : supervisor, account_manager, training_quality (all
                          scoped to assigned campaigns), admin (unrestricted)
                          — NOT wfm.
            Admin       : wfm, admin

            UPDATED — Dialer previously had no Header link at all
            (reached only via the landing page's own "Start working a
            campaign" flow). That was fine while only agents ever had
            Dialer access — they land there directly and never need to
            navigate away, so no link is shown for them here either
            (per explicit request — agent's ONLY page is Dialer, a
            link back to the one place they already are is just
            noise). Once supervisor/training_quality also got Dialer
            access alongside Live Status/Recordings/etc., THEY had no
            way back to Dialer once they'd navigated to one of those
            other pages — added here to fix that real gap, for those
            two roles specifically. Links straight to /dialer — its
            own mount effect already redirects to /select-campaign if
            no campaign is stored yet, so this is safe even for
            someone who hasn't picked one. account_manager/wfm/admin
            are blocked from /dialer itself at the page level (see
            DialerPage.jsx's own guard), so no link is shown for them
            here either.
            ==================================================
          */}
          {["supervisor", "training_quality", "account_manager", "wfm", "admin"].includes(agent.accessLevel) && (
            <Link to="/live-status" className="header-admin-link">
              Live Status
            </Link>
          )}
          {["supervisor", "account_manager", "wfm", "admin"].includes(agent.accessLevel) && (
            <Link to="/reports" className="header-admin-link">
              Reports
            </Link>
          )}
          {["supervisor", "account_manager", "wfm", "admin"].includes(agent.accessLevel) && (
            <Link to="/leads-dashboard" className="header-admin-link">
              Leads Dashboard
            </Link>
          )}
          {["supervisor", "training_quality", "account_manager", "admin"].includes(agent.accessLevel) && (
            <Link to="/recordings" className="header-admin-link">
              Recordings
            </Link>
          )}
          {["supervisor", "account_manager", "training_quality", "admin"].includes(agent.accessLevel) && (
            <Link to="/voicemails" className="header-admin-link">
              Voicemails
            </Link>
          )}
          {["wfm", "admin"].includes(agent.accessLevel) && (
            <Link to="/admin" className="header-admin-link">
              Admin
            </Link>
          )}
          <div className="header-user">
            <div className="name">{agent.fullName}</div>
            <div className="meta">
              {agent.email} · {agent.accessLevel}
            </div>
          </div>
          <button
            className="logout-btn"
            onClick={logout}
            disabled={!canLogout}
            title={canLogout ? undefined : "Set your status to Not Ready before logging out."}
          >
            Log out
          </button>
        </div>
      )}
    </header>
  );
}
