import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import Header from "../components/Header";
import Setup2FAModal from "../modals/Setup2FAModal";
import AgentDashboard from "../components/AgentDashboard";
import { useAuth } from "../context/AuthContext";

export default function LandingPage() {
  const { agent, setTotpEnabled } = useAuth();
  const [showSetupModal, setShowSetupModal] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  // UPDATED — the web dialer and campaign selection were removed: calls are
  // handled only in the CMX CallSuite Desktop app. Agents never leave this
  // page; it IS their dashboard (AgentDashboard below), on every visit, not
  // just right after login. Every other role keeps the existing behavior:
  // the welcome/2FA card right after a fresh login (LoginPage.jsx tags that
  // navigation with justLoggedIn), otherwise straight to its home page:
  //   - admin/wfm -> /admin
  //   - supervisor, training_quality, account_manager, anything else -> /live-status
  const isAgent = agent?.accessLevel === "agent";

  useEffect(() => {
    if (location.state?.justLoggedIn) return;
    if (!agent || agent.accessLevel === "agent") return;

    if (["admin", "wfm"].includes(agent.accessLevel)) {
      navigate("/admin", { replace: true });
    } else {
      navigate("/live-status", { replace: true });
    }
  }, [location.state, agent, navigate]);

  if (!isAgent && !location.state?.justLoggedIn) {
    return null; // redirecting — nothing to render
  }

  return (
    <>
      <Header />
      <div className="page-content">
        <h2>Welcome, {agent.fullName.split(" ")[0]}</h2>
        <span className="badge">{agent.accessLevel}</span>

        <div style={{ marginTop: 20 }}>
          {isAgent ? (
            <AgentDashboard agent={agent} />
          ) : (
            <div className="card">
              <p>
                Calls are handled in the <strong>CMX CallSuite Desktop</strong> app. See the navigation above for what's
                available to you here.
              </p>
            </div>
          )}
        </div>

        <div className="card">
          {agent.totpEnabled ? (
            <p>Two-factor authentication is enabled on your account.</p>
          ) : (
            <>
              <p>Two-factor authentication is currently disabled on your account.</p>
              <button className="button-secondary" onClick={() => setShowSetupModal(true)}>
                Set up an authenticator app
              </button>
            </>
          )}
        </div>
      </div>

      {showSetupModal && (
        <Setup2FAModal
          onClose={() => setShowSetupModal(false)}
          onComplete={() => setTotpEnabled(true)}
        />
      )}
    </>
  );
}
