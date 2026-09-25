"use strict";

const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { authenticator } = require("otplib");
const QRCode = require("qrcode");

const db = require("../config/db");
const { transporter } = require("../config/mailer");
const { buildOtpEmail } = require("../services/emailTemplates");
const agentStatusService = require("../services/agentStatusService");
const { version: BACKEND_VERSION } = require("../package.json");

const router = express.Router();

const OTP_EXPIRY_MINUTES = Number(process.env.OTP_EXPIRY_MINUTES || 10);

/*
==================================================
GET /api/auth/version
==================================================
Per explicit request — shown on the login page (before anyone's
authenticated, hence no requireAuth here) and in the header. Reads the
backend's own version straight from its package.json, so it always
reflects whatever's actually running — no separate value to keep in
sync by hand.
==================================================
*/
router.get("/version", (req, res) => {
  return res.json({ success: true, version: BACKEND_VERSION });
});
const OTP_LENGTH = 6;
const MAX_OTP_ATTEMPTS = 5; // guesses per code before it's invalidated

function generateOtpCode() {
  // 6-digit numeric code, zero-padded.
  return String(crypto.randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");
}

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

/*
==================================================
RATE LIMITING — NEW, per explicit request
==================================================
Before this, NOTHING in this file throttled requests at all: an
attacker (or a buggy client stuck retrying) could call /request-otp as
fast as the network allowed — spamming a real user's inbox with codes
and burning SMTP send quota — and /login-totp had ZERO brute-force
protection whatsoever (unlike /verify-otp, which at least invalidates
one specific OTP code after MAX_OTP_ATTEMPTS wrong guesses, a TOTP
code is only 6 digits and totally guessable given enough unthrottled
attempts).

In-memory store (express-rate-limit's default) is fine here — this
app runs as a single Node process (see server.js's own single
httpServer.listen(), no cluster/pm2 fan-out), so there's exactly one
counter, not one per worker that would under-count. If this ever moves
to multiple instances behind a load balancer, swap in a shared store
(e.g. rate-limit-redis) — the counters need to be shared, not doubled.

TWO limiters per sensitive route, applied together as a middleware
chain, each catching a different attack shape:
  - byIp    — catches one attacker hammering MANY different emails
              from the same network.
  - byEmail — catches one attacker hammering ONE victim's email from
              rotating/many IPs. Falls back to req.ip if the request
              body has no email at all (malformed request — still
              worth counting against something).
app.set("trust proxy", 1) in server.js (production only) is what makes
req.ip resolve to the real client IP behind a reverse proxy rather than
the proxy's own address — without it every request would appear to
share one IP and byIp would over-throttle.

SCALABILITY — per explicit request. This team runs multiple physical
sites (US, DR, PH, ...), each on its OWN network — meaning each site
presents its own public IP to this server, so each site gets its OWN
independent byIp counter. That's actually good news: sizing the byIp
ceiling only needs to cover the LARGEST SINGLE SITE's headcount at
shift-start (everyone there sharing one IP), not the sum across every
site — a 100-agent site and a 5-agent site never compete for the same
counter.

That still leaves a real problem: today's largest site is ~20 agents,
but the stated growth plan is DR -> 80 and PH -> 100. Hardcoding a
number sized for "today" means another code change + redeploy every
time a site's headcount crosses that number — exactly the kind of
thing that should be a config change, not a patch. So every ceiling
below is read from process.env (same pattern OTP_EXPIRY_MINUTES above
already uses), with a default sized for the STATED future (100-agent
site), not just current headcount:
  100 agents x up to ~2 requests each (a slow-email or fat-fingered
  retry is normal) = ~200 worst-case legitimate requests in one
  window: rounded up to 300 for margin. Still far below what an
  actual automated attack would need to run to matter, so this stays
  a real defense, just centered on this team's real scale instead of
  a guess.

If a single site ever grows past what the default comfortably covers,
bump OTP_REQUEST_MAX_PER_IP / OTP_LOGIN_MAX_PER_IP / CHECK_USER_MAX_PER_IP
in that environment's .env and restart — no code change needed.

ONE assumption worth confirming once, not per-deploy: this only works
if each site's traffic actually arrives at this server AS that site's
own distinct public IP — i.e. no single upstream VPN gateway or shared
proxy silently merging multiple sites' traffic into one IP before it
reaches app.set("trust proxy", 1)'s one trusted hop. If DR and PH ever
route through a shared gateway, they'd start sharing one counter and
this sizing math would need revisiting.

The per-EMAIL limiters are deliberately NOT tied to site headcount —
they're scoped to one account regardless of requester IP, so a site
growing from 20 to 100 agents doesn't change how many times any ONE
account can be hit. Their defaults stay small and are still
env-overridable for symmetry/consistency, not because site growth
requires it.
==================================================
*/
const RATE_LIMIT_WINDOW_MINUTES = Number(process.env.RATE_LIMIT_WINDOW_MINUTES || 15);
const RATE_LIMIT_WINDOW_MS = RATE_LIMIT_WINDOW_MINUTES * 60 * 1000;

const OTP_REQUEST_MAX_PER_IP = Number(process.env.OTP_REQUEST_MAX_PER_IP || 300);
const OTP_REQUEST_MAX_PER_EMAIL = Number(process.env.OTP_REQUEST_MAX_PER_EMAIL || 5);
const OTP_LOGIN_MAX_PER_IP = Number(process.env.OTP_LOGIN_MAX_PER_IP || 300);
const OTP_LOGIN_MAX_PER_EMAIL = Number(process.env.OTP_LOGIN_MAX_PER_EMAIL || 10);
const CHECK_USER_MAX_PER_IP = Number(process.env.CHECK_USER_MAX_PER_IP || 300);

// REAL BUG FOUND live in production (2026-09-17): express-rate-limit
// v8's own startup validation flags this exact pattern — falling back
// to req.ip DIRECTLY inside a custom keyGenerator, without normalizing
// it through the library's own ipKeyGenerator() helper first, is
// unsafe for IPv6 clients specifically. The same IPv6 address has
// multiple valid textual representations (zero-compression, casing),
// so an IPv6 client could rotate representations and get a fresh
// counter each time, bypassing this limiter entirely — exactly the
// kind of hole a rate limiter shouldn't have. Logged as a non-fatal
// startup warning (did NOT crash the process — confirmed live: the
// app kept running and serving requests normally right through it),
// but real and worth fixing properly rather than leaving a known
// bypass path in a security control. ipKeyGenerator() is attached as
// a property on the default export itself (confirmed directly against
// the installed package), so no separate import line needed — this
// stays a one-line fix at each of the two call sites below.
function normalizedEmailKey(req) {
  const email = String(req.body?.email || "").trim().toLowerCase();
  return email || rateLimit.ipKeyGenerator(req.ip);
}

const otpRequestByIpLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: OTP_REQUEST_MAX_PER_IP, // this network (one site), any emails combined — see SCALABILITY comment above
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many login code requests. Please wait a few minutes and try again." },
});

const otpRequestByEmailLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: OTP_REQUEST_MAX_PER_EMAIL, // this one email, regardless of requester IP — NOT sized to site headcount, see comment above
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: normalizedEmailKey,
  message: { success: false, message: "Too many login code requests for this account. Please wait a few minutes and try again." },
});

// Applies to BOTH /verify-otp (a 6-digit OTP code) and /login-totp (a
// 6-digit TOTP code) — a higher ceiling than the request limiters
// above since a real agent fat-fingering their code a few times in a
// row is normal, but still low enough to make brute-forcing either
// code space impractical within one window.
const otpLoginByIpLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: OTP_LOGIN_MAX_PER_IP,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many login attempts. Please wait a few minutes and try again." },
});

const otpLoginByEmailLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: OTP_LOGIN_MAX_PER_EMAIL,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: normalizedEmailKey,
  message: { success: false, message: "Too many login attempts for this account. Please wait a few minutes and try again." },
});

// /check-user deliberately reveals whether an email has TOTP enabled
// (see that route's own header comment) — a lighter IP-only limiter
// here just slows down automated account enumeration, not a full
// brute-force concern the way the two above are.
const checkUserLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: CHECK_USER_MAX_PER_IP,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests. Please wait a few minutes and try again." },
});


/*
==================================================
Resolve an app_user's ViciDial extension the same way the old
password-based login did — just triggered after OTP/TOTP success
instead of before. Confirmed join logic from the verified Phase 1 work.
==================================================
*/
async function resolveAgentContext(appUser) {
  if (!appUser.vicidial_user) {
    return { extension: null, protocol: null, user_group: null };
  }

  const [rows] = await db.execute(
    `
      SELECT p.extension, p.protocol, vu.user_group
      FROM vicidial_users vu
      LEFT JOIN phones p ON p.login = vu.phone_login
      WHERE vu.user = ? AND vu.active = 'Y'
    `,
    [appUser.vicidial_user]
  );

  if (!rows.length) {
    return { extension: null, protocol: null, user_group: null };
  }

  return rows[0];
}

function buildSessionAgent(appUser, vicidialContext) {
  return {
    appUserId: appUser.app_user_id,
    email: appUser.email,
    fullName: appUser.full_name,
    accessLevel: appUser.access_level,
    username: appUser.vicidial_user, // kept as "username" for continuity with dialerRoutes.js, which reads req.session.agent.username as agentUser
    extension: vicidialContext.extension,
    protocol: vicidialContext.protocol,
    userGroup: vicidialContext.user_group,
    totpEnabled: Boolean(appUser.totp_enabled),
    // NEW — multi-campaign agent selection, per explicit request.
    // Lets the frontend (CampaignSelectPage.jsx) know whether THIS
    // agent is allowed to select more than one blended campaign at
    // once, without a separate round-trip just to find out.
    multiCampaignEnabled: Boolean(appUser.multi_campaign_enabled),
  };
}

/*
==================================================
CHECK USER
==================================================
POST /api/auth/check-user
Body: { email }

Used by the login screen to decide which buttons to show BEFORE
requesting an OTP — "Request OTP" only, or both "Request OTP" and
"Login using Authenticator" if TOTP is already enrolled.

NOTE: unlike request-otp, this deliberately reveals whether an email
has TOTP enabled — a small loosening of the "don't confirm account
existence" principle used elsewhere. Acceptable for an internal tool
with known staff emails; would need reconsidering if this app were ever
exposed more publicly.
==================================================
*/
router.post("/check-user", checkUserLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required." });
    }

    const [users] = await db.execute(
      `SELECT totp_enabled FROM cmx_dialer.app_users WHERE email = ? AND active = 1`,
      [email]
    );

    const totpEnabled = users.length ? Boolean(users[0].totp_enabled) : false;

    return res.json({ success: true, totpEnabled });
  } catch (error) {
    console.error("POST /api/auth/check-user failed:", error);
    return res.status(500).json({ success: false, message: "Failed to check account." });
  }
});

/*
==================================================
REQUEST OTP
==================================================
POST /api/auth/request-otp
Body: { email }

Always responds success (even for unknown emails) to avoid leaking
which addresses are registered. Only sends an email if the app_user
actually exists and is active.
==================================================
*/
router.post("/request-otp", otpRequestByIpLimiter, otpRequestByEmailLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required." });
    }

    const [users] = await db.execute(
      `SELECT app_user_id, email, full_name FROM cmx_dialer.app_users WHERE email = ? AND active = 1`,
      [email]
    );

    if (users.length) {
      const appUser = users[0];
      const code = generateOtpCode();
      const codeHash = hashCode(code);
      const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

      await db.execute(
        `INSERT INTO cmx_dialer.otp_codes (app_user_id, code_hash, expires_at) VALUES (?, ?, ?)`,
        [appUser.app_user_id, codeHash, expiresAt]
      );

      await transporter.sendMail({
        from: process.env.SMTP_FROM,
        to: appUser.email,
        ...buildOtpEmail({ fullName: appUser.full_name, code, expiryMinutes: OTP_EXPIRY_MINUTES }),
      });
    }

    // Same response regardless of whether the email matched a real user.
    return res.json({
      success: true,
      message: "If that email is registered, a login code has been sent.",
      expiresInSeconds: OTP_EXPIRY_MINUTES * 60,
    });
  } catch (error) {
    console.error("POST /api/auth/request-otp failed:", error);
    return res.status(500).json({ success: false, message: "Failed to send login code." });
  }
});

/*
==================================================
VERIFY OTP -> creates session
==================================================
POST /api/auth/verify-otp
Body: { email, code }
==================================================
*/
router.post("/verify-otp", otpLoginByIpLimiter, otpLoginByEmailLimiter, async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ success: false, message: "Email and code are required." });
    }

    const [users] = await db.execute(
      `SELECT * FROM cmx_dialer.app_users WHERE email = ? AND active = 1`,
      [email]
    );

    if (!users.length) {
      return res.status(401).json({ success: false, message: "Invalid email or code." });
    }

    const appUser = users[0];

    const [otpRows] = await db.execute(
      `
        SELECT * FROM cmx_dialer.otp_codes
        WHERE app_user_id = ? AND consumed_at IS NULL AND expires_at > NOW()
        ORDER BY otp_id DESC LIMIT 1
      `,
      [appUser.app_user_id]
    );

    if (!otpRows.length) {
      return res.status(401).json({ success: false, message: "Code expired or not found. Request a new one." });
    }

    const otp = otpRows[0];

    if (otp.attempt_count >= MAX_OTP_ATTEMPTS) {
      return res.status(429).json({ success: false, message: "Too many attempts. Request a new code." });
    }

    if (otp.code_hash !== hashCode(code)) {
      await db.execute(`UPDATE cmx_dialer.otp_codes SET attempt_count = attempt_count + 1 WHERE otp_id = ?`, [otp.otp_id]);
      return res.status(401).json({ success: false, message: "Invalid email or code." });
    }

    await db.execute(`UPDATE cmx_dialer.otp_codes SET consumed_at = NOW() WHERE otp_id = ?`, [otp.otp_id]);

    const vicidialContext = await resolveAgentContext(appUser);

    req.session.regenerate((err) => {
      if (err) {
        console.error("Session regenerate failed:", err);
        return res.status(500).json({ success: false, message: "Login failed." });
      }

      req.session.authenticated = true;
      req.session.agent = buildSessionAgent(appUser, vicidialContext);

      req.session.save(async (saveErr) => {
        if (saveErr) {
          console.error("Session save failed:", saveErr);
          return res.status(500).json({ success: false, message: "Login failed." });
        }

        // Every fresh login starts the agent in NOT_READY — they
        // explicitly switch to READY once actually at their desk. Not
        // firing this here would leave getCurrentStatus() returning
        // null until the agent's first manual status change.
        try {
          await agentStatusService.setStatus(appUser.app_user_id, "NOT_READY");
        } catch (statusErr) {
          console.error("Failed to initialize agent status on login:", statusErr);
          // Non-fatal — login itself already succeeded; DialerPage will
          // just show no status until the agent changes it manually.
        }

        // Powers the Live Status Dashboard's Logged Out table (Last
        // Login Date column) — non-fatal on failure, same reasoning as
        // the status init right above: login itself already succeeded.
        try {
          await db.execute(
            "UPDATE cmx_dialer.app_users SET last_login_at = NOW() WHERE app_user_id = ?",
            [appUser.app_user_id]
          );
        } catch (loginTimeErr) {
          console.error("Failed to record last_login_at:", loginTimeErr);
        }

        return res.json({
          success: true,
          message: "Login successful.",
          agent: req.session.agent,
          totpEnabled: Boolean(appUser.totp_enabled),
        });
      });
    });
  } catch (error) {
    console.error("POST /api/auth/verify-otp failed:", error);
    return res.status(500).json({ success: false, message: "Login failed." });
  }
});

/*
==================================================
TOTP ENROLLMENT
==================================================
POST /api/auth/totp/setup — generates a secret + QR code, but does NOT
enable TOTP yet. Requires an active session (i.e. the user already
logged in via OTP once).
POST /api/auth/totp/confirm — verifies the first real code from the
authenticator app and only THEN flips totp_enabled on.
==================================================
*/
function requireAuth(req, res, next) {
  if (!req.session || !req.session.authenticated || !req.session.agent) {
    return res.status(401).json({ success: false, message: "Authentication required." });
  }
  next();
}

router.post("/totp/setup", requireAuth, async (req, res) => {
  try {
    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(req.session.agent.email, "CMX Dialer", secret);
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl);

    // Stored but not yet "enabled" — confirmed only after /totp/confirm.
    await db.execute(
      `UPDATE cmx_dialer.app_users SET totp_secret = ? WHERE app_user_id = ?`,
      [secret, req.session.agent.appUserId]
    );

    return res.json({ success: true, qrDataUrl, secret });
  } catch (error) {
    console.error("POST /api/auth/totp/setup failed:", error);
    return res.status(500).json({ success: false, message: "Failed to start TOTP setup." });
  }
});

router.post("/totp/confirm", requireAuth, async (req, res) => {
  try {
    const { code } = req.body;

    const [rows] = await db.execute(
      `SELECT totp_secret FROM cmx_dialer.app_users WHERE app_user_id = ?`,
      [req.session.agent.appUserId]
    );

    if (!rows.length || !rows[0].totp_secret) {
      return res.status(400).json({ success: false, message: "No TOTP setup in progress." });
    }

    const valid = authenticator.check(code, rows[0].totp_secret);
    if (!valid) {
      return res.status(401).json({ success: false, message: "Invalid code." });
    }

    await db.execute(
      `UPDATE cmx_dialer.app_users SET totp_enabled = 1 WHERE app_user_id = ?`,
      [req.session.agent.appUserId]
    );

    req.session.agent.totpEnabled = true;

    return res.json({ success: true, message: "Authenticator enabled." });
  } catch (error) {
    console.error("POST /api/auth/totp/confirm failed:", error);
    return res.status(500).json({ success: false, message: "Failed to confirm TOTP setup." });
  }
});

/*
==================================================
TOTP LOGIN (returning users who already enrolled)
==================================================
POST /api/auth/login-totp
Body: { email, code }
==================================================
*/
router.post("/login-totp", otpLoginByIpLimiter, otpLoginByEmailLimiter, async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ success: false, message: "Email and code are required." });
    }

    const [users] = await db.execute(
      `SELECT * FROM cmx_dialer.app_users WHERE email = ? AND active = 1 AND totp_enabled = 1`,
      [email]
    );

    if (!users.length) {
      return res.status(401).json({ success: false, message: "Invalid email or code." });
    }

    const appUser = users[0];
    const valid = authenticator.check(code, appUser.totp_secret);

    if (!valid) {
      return res.status(401).json({ success: false, message: "Invalid email or code." });
    }

    const vicidialContext = await resolveAgentContext(appUser);

    req.session.regenerate((err) => {
      if (err) {
        console.error("Session regenerate failed:", err);
        return res.status(500).json({ success: false, message: "Login failed." });
      }

      req.session.authenticated = true;
      req.session.agent = buildSessionAgent(appUser, vicidialContext);

      req.session.save(async (saveErr) => {
        if (saveErr) {
          console.error("Session save failed:", saveErr);
          return res.status(500).json({ success: false, message: "Login failed." });
        }

        try {
          await agentStatusService.setStatus(appUser.app_user_id, "NOT_READY");
        } catch (statusErr) {
          console.error("Failed to initialize agent status on login:", statusErr);
        }

        // Powers the Live Status Dashboard's Logged Out table (Last
        // Login Date column) — non-fatal on failure, same reasoning as
        // the status init right above: login itself already succeeded.
        try {
          await db.execute(
            "UPDATE cmx_dialer.app_users SET last_login_at = NOW() WHERE app_user_id = ?",
            [appUser.app_user_id]
          );
        } catch (loginTimeErr) {
          console.error("Failed to record last_login_at:", loginTimeErr);
        }

        return res.json({ success: true, message: "Login successful.", agent: req.session.agent });
      });
    });
  } catch (error) {
    console.error("POST /api/auth/login-totp failed:", error);
    return res.status(500).json({ success: false, message: "Login failed." });
  }
});

router.get("/me", requireAuth, (req, res) => {
  return res.json({ success: true, agent: req.session.agent });
});

router.post("/logout", async (req, res) => {
  // Close the current open status row BEFORE destroying the session —
  // without this, the row stays open forever, indistinguishable from
  // the agent still genuinely being in that status. This is what
  // makes "Logged Out" a real, detectable state on the live-status
  // dashboard rather than something that just silently never happens.
  // Only a PHONE session (the desktop app) ends the agent's status on logout.
  // Signing out of the web dashboard must not knock a still-running desktop
  // app out of its Ready/In Call status. See dialerRoutes.js webrtc-credentials.
  if (req.session && req.session.agent && req.session.dialerSession) {
    try {
      await agentStatusService.closeCurrentStatus(req.session.agent.appUserId);
    } catch (err) {
      console.error("Failed to close status on logout:", err.message);
    }
  }

  req.session.destroy((err) => {
    if (err) {
      console.error("Logout failed:", err);
      return res.status(500).json({ success: false, message: "Logout failed." });
    }
    res.clearCookie(process.env.SESSION_NAME || "cmx_dialer_session");
    return res.json({ success: true, message: "Logged out." });
  });
});

module.exports = router;