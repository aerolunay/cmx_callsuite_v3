import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useAppVersion } from "../hooks/useAppVersion";
import Setup2FAModal from "../modals/Setup2FAModal";
import logo from "../assets/voxsuite-logo.png";

// Steps:
//   EMAIL   -> just the email input + "Login" button
//   CHOOSE  -> after check-user, show "Request OTP" (+ "Login using
//              Authenticator" if this account already has TOTP enabled)
//   OTP     -> 6-digit email code entry, with expiry countdown + resend
//   TOTP    -> 6-digit authenticator code entry
const STEP_EMAIL = "email";
const STEP_CHOOSE = "choose";
const STEP_OTP = "otp";
const STEP_TOTP = "totp";

const SKIP_PROMPT_KEY_PREFIX = "cmx_dialer_skip_totp_prompt:";

function formatCountdown(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export default function LoginPage() {
  const appVersion = useAppVersion();
  const [step, setStep] = useState(STEP_EMAIL);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [totpEnabledForEmail, setTotpEnabledForEmail] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [showTotpPrompt, setShowTotpPrompt] = useState(false);
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [dontAskAgain, setDontAskAgain] = useState(false);

  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const countdownRef = useRef(null);

  const { login, setTotpEnabled } = useAuth();
  const navigate = useNavigate();

  function resetMessages() {
    setError("");
    setInfo("");
  }

  function startCountdown(totalSeconds) {
    clearInterval(countdownRef.current);
    setSecondsRemaining(totalSeconds);
    countdownRef.current = setInterval(() => {
      setSecondsRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(countdownRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  // Clean up the interval if the component unmounts mid-countdown
  // (e.g. navigating away) so it doesn't keep ticking in the background.
  useEffect(() => {
    return () => clearInterval(countdownRef.current);
  }, []);

  async function handleCheckUser(e) {
    e.preventDefault();
    resetMessages();
    setBusy(true);
    try {
      const data = await api.checkUser(email);
      setTotpEnabledForEmail(data.totpEnabled);
      setStep(STEP_CHOOSE);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRequestOtp() {
    resetMessages();
    setBusy(true);
    try {
      const data = await api.requestOtp(email);
      setInfo("If that email is registered, a login code has been sent.");
      setCode("");
      setStep(STEP_OTP);
      startCountdown(data.expiresInSeconds || 600);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleResendOtp() {
    resetMessages();
    setBusy(true);
    try {
      const data = await api.requestOtp(email);
      setInfo("A new code has been sent.");
      setCode("");
      startCountdown(data.expiresInSeconds || 600);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function finishLogin(agent) {
    login(agent);

    const skipKey = `${SKIP_PROMPT_KEY_PREFIX}${email}`;
    const alreadyDismissed = localStorage.getItem(skipKey) === "true";

    if (!agent.totpEnabled && !alreadyDismissed) {
      setShowTotpPrompt(true);
      return;
    }

    navigate("/", { state: { justLoggedIn: true } });
  }

  async function handleVerifyOtp(e) {
    e.preventDefault();
    resetMessages();
    setBusy(true);
    try {
      const data = await api.verifyOtp(email, code);
      clearInterval(countdownRef.current);
      finishLogin(data.agent);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleLoginTotp(e) {
    e.preventDefault();
    resetMessages();
    setBusy(true);
    try {
      const data = await api.loginTotp(email, code);
      finishLogin(data.agent);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function handleTotpPromptChoice(setupNow) {
    if (dontAskAgain) {
      localStorage.setItem(`${SKIP_PROMPT_KEY_PREFIX}${email}`, "true");
    }
    setShowTotpPrompt(false);

    if (setupNow) {
      setShowSetupModal(true);
    } else {
      navigate("/", { state: { justLoggedIn: true } });
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="logo-row">
          <img src={logo} alt="VoxSuite" />
        </div>
        <h1>Sign in</h1>
        <p className="subtitle">Use your registered email</p>

        {error && <div className="error">{error}</div>}
        {info && !error && <div className="success">{info}</div>}

        {step === STEP_EMAIL && (
          <form onSubmit={handleCheckUser}>
            <input
              type="email"
              placeholder="you@emaildomain.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
            <button className="primary" type="submit" disabled={busy}>
              {busy ? "Checking…" : "Login"}
            </button>
          </form>
        )}

        {step === STEP_CHOOSE && (
          <>
            <button className="primary" onClick={handleRequestOtp} disabled={busy}>
              {busy ? "Sending…" : "Request OTP"}
            </button>
            {totpEnabledForEmail && (
              <button
                className="primary"
                style={{ marginTop: 10, background: "var(--cmx-navy)" }}
                onClick={() => {
                  resetMessages();
                  setCode("");
                  setStep(STEP_TOTP);
                }}
              >
                Login using Authenticator
              </button>
            )}
            <button type="button" className="link" onClick={() => setStep(STEP_EMAIL)}>
              Use a different email
            </button>
          </>
        )}

        {step === STEP_OTP && (
          <form onSubmit={handleVerifyOtp}>
            <input
              type="text"
              inputMode="numeric"
              placeholder="- - - - - -"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={6}
              required
              autoFocus
            />
            <button className="primary" type="submit" disabled={busy}>
              {busy ? "Verifying…" : "Verify code"}
            </button>

            <div className="otp-countdown">
              {secondsRemaining > 0 ? (
                <span>Code expires in {formatCountdown(secondsRemaining)}</span>
              ) : (
                <button type="button" className="link" onClick={handleResendOtp} disabled={busy}>
                  {busy ? "Resending…" : "Resend code"}
                </button>
              )}
            </div>

            <button type="button" className="link" onClick={() => setStep(STEP_CHOOSE)}>
              Back
            </button>
          </form>
        )}

        {step === STEP_TOTP && (
          <form onSubmit={handleLoginTotp}>
            <input
              type="text"
              inputMode="numeric"
              placeholder="- - - - - -"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={6}
              required
              autoFocus
              className="text-center text-2xl font-mono tracking-[0.5em]"
            />
            <button className="primary" type="submit" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <button type="button" className="link" onClick={() => setStep(STEP_CHOOSE)}>
              Back
            </button>
          </form>
        )}

        {appVersion && <div className="auth-version">VoxSuite v{appVersion} · SIP Phone Solutions</div>}
      </div>

      {showTotpPrompt && (
        <div className="modal-overlay">
          <div className="modal-card">
            <h3>Set up your authenticator app?</h3>
            <p>
              You can sign in faster next time using an authenticator app instead of an email
              code.
            </p>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={dontAskAgain}
                onChange={(e) => setDontAskAgain(e.target.checked)}
              />
              Do not ask again
            </label>
            <div className="modal-actions">
              <button className="button-secondary" onClick={() => handleTotpPromptChoice(true)}>
                Yes, set it up
              </button>
              <button className="link" onClick={() => handleTotpPromptChoice(false)}>
                No, maybe later
              </button>
            </div>
          </div>
        </div>
      )}
      {showSetupModal && (
        <Setup2FAModal
          onClose={() => {
            setShowSetupModal(false);
            navigate("/", { state: { justLoggedIn: true } });
          }}
          onComplete={() => setTotpEnabled(true)}
        />
      )}
    </div>
  );
}
