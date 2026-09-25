"use strict";
/*
 * CMX CallSuite — SIP tunnel relay.
 * Desktop app <-(WebSocket over HTTPS 443, via Apache /ws/sip)-> this relay <-(UDP)-> Asterisk.
 * One WebSocket message = one SIP datagram. Call audio (RTP) does NOT go through here.
 *
 * Security:
 *  - The WebSocket upgrade is accepted only if the request's session cookie is signed in
 *    (checked by asking the backend's own GET /api/auth/me with the same cookie).
 *  - A signed-in user may only REGISTER their own extension (session agent.extension).
 *  - Listens on 127.0.0.1 only; Apache is the only way in.
 */
const http = require("http");
const dgram = require("dgram");
const WebSocket = require("ws");

const PORT = Number(process.env.SIP_RELAY_PORT || 5070);
const AUTH_URL = process.env.SIP_RELAY_AUTH_URL || "http://127.0.0.1:5060/api/auth/me";
const ASTERISK_HOST = process.env.SIP_RELAY_ASTERISK_HOST || "127.0.0.1";
const ASTERISK_PORT = Number(process.env.SIP_RELAY_ASTERISK_PORT || 5060);
const PING_MS = 25000; // under Apache's 60s proxy idle timeout

function signedInAgent(cookieHeader) {
  return new Promise((resolve) => {
    const req = http.get(AUTH_URL, { headers: { cookie: cookieHeader || "" }, timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          resolve(res.statusCode === 200 && json.agent ? json.agent : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

const server = http.createServer((req, res) => {
  res.writeHead(404);
  res.end();
});
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", async (req, socket, head) => {
  const agent = await signedInAgent(req.headers.cookie);
  if (!agent || !agent.extension) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, agent));
});

/*
 * STABLE ADDRESS PER EXTENSION
 * Each extension always gets the SAME local UDP port (40000 + a hash of the
 * extension, 40000-49999), so the phone's address as Asterisk sees it
 * (127.0.0.1:<port>) never changes — not when the app reconnects, not after a
 * network blip. A reconnect therefore can never leave Asterisk sending calls to
 * a dead, old address. A newer connection for the same extension replaces the
 * older one (the old socket is closed first so the port can be reused).
 */
const STABLE_PORT_BASE = Number(process.env.SIP_RELAY_PORT_BASE || 40000);
const STABLE_PORT_RANGE = 10000;
const bridges = new Map(); // extension -> { ws, udp }

function stablePortFor(ext) {
  let h = 0;
  for (const ch of ext) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return STABLE_PORT_BASE + (h % STABLE_PORT_RANGE);
}

function bindStable(udp, port, attempt = 0) {
  return new Promise((resolve) => {
    const onError = (err) => {
      udp.removeListener("listening", onListening);
      if (err.code === "EADDRINUSE" && attempt < 20) {
        // Old socket for this extension still closing — retry shortly.
        setTimeout(() => bindStable(udp, port, attempt + 1).then(resolve), 100);
      } else {
        // Hash collision with another extension (or port taken): fall back to any
        // port rather than refusing service. Logged so it can be noticed.
        console.warn(`[sip-relay] stable port ${port} unavailable (${err.code}); using a random port`);
        udp.bind(0, "127.0.0.1", () => resolve(false));
      }
    };
    const onListening = () => {
      udp.removeListener("error", onError);
      resolve(true);
    };
    udp.once("error", onError);
    udp.once("listening", onListening);
    udp.bind(port, "127.0.0.1");
  });
}

async function bridge(ws, agent) {
  const ext = String(agent.extension);
  const who = `${ext} (${agent.email || agent.appUserId})`;

  // Replace any previous connection for this extension (reconnect / second app instance).
  const previous = bridges.get(ext);
  if (previous) {
    console.log(`[sip-relay] ${who} reconnected — closing the previous connection`);
    try { previous.udp.close(); } catch { /* already closed */ }
    try { previous.ws.terminate(); } catch { /* already closed */ }
  }

  const udp = dgram.createSocket("udp4");
  const entry = { ws, udp };
  bridges.set(ext, entry);
  let alive = true;
  let ready = false;
  const pending = []; // SIP from the app that arrives before the socket is bound

  udp.on("message", (msg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg.toString("utf8"));
  });

  ws.on("message", (data) => {
    const text = data.toString("utf8");
    if (/^REGISTER\s/.test(text)) {
      const to = /^(?:To|t)\s*:[^\r\n]*?sips?:([^@;>\s]+)@/im.exec(text);
      if (!to || to[1] !== ext) {
        console.warn(`[sip-relay] blocked REGISTER for "${to ? to[1] : "?"}" from ${who}`);
        return;
      }
    }
    if (!ready) return pending.push(text);
    udp.send(Buffer.from(text, "utf8"), ASTERISK_PORT, ASTERISK_HOST);
  });

  const ping = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, PING_MS);
  ws.on("pong", () => (alive = true));
  ws.on("close", () => {
    clearInterval(ping);
    try { udp.close(); } catch { /* already closed */ }
    if (bridges.get(ext) === entry) bridges.delete(ext);
    console.log(`[sip-relay] ${who} disconnected`);
  });
  ws.on("error", () => ws.terminate());

  const port = stablePortFor(ext);
  const stable = await bindStable(udp, port);
  if (ws.readyState !== WebSocket.OPEN) {
    try { udp.close(); } catch { /* ignore */ }
    if (bridges.get(ext) === entry) bridges.delete(ext);
    return;
  }
  udp.on("error", (err) => {
    console.error(`[sip-relay] UDP error for ${who}:`, err.message);
    ws.close();
  });
  ready = true;
  console.log(`[sip-relay] ${who} connected as 127.0.0.1:${udp.address().port}${stable ? " (stable)" : ""}`);
  for (const text of pending.splice(0)) udp.send(Buffer.from(text, "utf8"), ASTERISK_PORT, ASTERISK_HOST);

}

server.listen(PORT, "127.0.0.1", () => console.log(`[sip-relay] listening on 127.0.0.1:${PORT}`));
