# Server setup that lives outside the app code

Reference copies of the server-side pieces CallSuite v3 needs that are **not** created by
the app itself. The real files live on the server; keep these in sync when you change them.
Rebuilding a server (production cutover, a new dev clone) = the app checkout + these.

| What | Server location | Reference here |
|---|---|---|
| Apache: route the desktop app's SIP tunnel `/ws/sip` to the relay | inside the SSL `<VirtualHost>` of the CallSuite site (`/etc/httpd/conf.d/*-ssl.conf`) | [`apache-ws-sip.conf`](apache-ws-sip.conf) |
| systemd: stop pm2-rocky being killed every 90 s | `/etc/systemd/system/pm2-rocky.service.d/override.conf` | [`pm2-rocky-override.conf`](pm2-rocky-override.conf) |
| pm2 processes (backend + SIP relay) and boot start | `pm2 save` under user `rocky` | [`pm2-processes.md`](pm2-processes.md) |
| SELinux: let Apache proxy to local ports (relay 5070, backend 5060) | boolean | `setsebool -P httpd_can_network_connect on` |
| Web frontend deploy | `/var/www/dialer-frontend` | [`frontend-deploy.md`](frontend-deploy.md) |

Generated at runtime by the backend (not copied here): the campaign dialplan
(`/etc/asterisk/extensions-campaigns-cmxdialer.conf`, rebuilt on every campaign save) and
the phone endpoints (`/etc/asterisk/pjsip-phones-cmxdialer.conf`, rebuilt on phone save —
DESKTOP phones get `media_address = ${SERVER_IP}` and `qualify_frequency = 10`).

Firewall (AWS security group) for desktop-app agents: only **TCP 443** plus
**UDP 10000–20000** (call audio). Carrier trunks keep their own UDP 5060 rules.
