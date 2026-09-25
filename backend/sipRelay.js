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

function bridge(ws, agent) {
  const ext = String(agent.extension);
  const who = `${ext} (${agent.email || agent.appUserId})`;
  const udp = dgram.createSocket("udp4");
  let alive = true;

  udp.on("message", (msg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg.toString("utf8"));
  });
  udp.on("error", (err) => {
    console.error(`[sip-relay] UDP error for ${who}:`, err.message);
    ws.close();
  });
  udp.bind(0, "127.0.0.1", () => console.log(`[sip-relay] ${who} connected as 127.0.0.1:${udp.address().port}`));

  ws.on("message", (data) => {
    const text = data.toString("utf8");
    if (/^REGISTER\s/.test(text)) {
      const to = /^(?:To|t)\s*:[^\r\n]*?sips?:([^@;>\s]+)@/im.exec(text);
      if (!to || to[1] !== ext) {
        console.warn(`[sip-relay] blocked REGISTER for "${to ? to[1] : "?"}" from ${who}`);
        return;
      }
    }
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
    console.log(`[sip-relay] ${who} disconnected`);
  });
  ws.on("error", () => ws.terminate());
}

server.listen(PORT, "127.0.0.1", () => console.log(`[sip-relay] listening on 127.0.0.1:${PORT}`));
