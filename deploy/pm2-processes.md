# pm2 processes (user `rocky`)

| Name | Start command (from `~/app/cmx_dialer/backend`) | Listens |
|---|---|---|
| `cmx-dialer-backend` | `pm2 start server.js --name cmx-dialer-backend` | 127.0.0.1:5060 (HTTP API + /ws/dialer) |
| `cmx-sip-relay` | `pm2 start sipRelay.js --name cmx-sip-relay` | 127.0.0.1:5070 (desktop SIP tunnel) |

After adding or renaming a process: `pm2 save` (the `pm2-rocky` systemd service restores the
saved list at boot).

Relay environment (all optional): `SIP_RELAY_PORT` (5070), `SIP_RELAY_AUTH_URL`
(`http://127.0.0.1:5060/api/auth/me`), `SIP_RELAY_ASTERISK_HOST`/`_PORT` (127.0.0.1:5060),
`SIP_RELAY_PORT_BASE` (40000 — each extension gets a fixed UDP port 40000–49999 so its
address never changes across reconnects).

Logs: `pm2 logs cmx-sip-relay --lines 30 --nostream` — every connect shows
`cmx401 (...) connected as 127.0.0.1:<port> (stable)`.
