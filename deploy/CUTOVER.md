# Production cutover — CallSuite v3 (this server replaces the current live one)

Production runs branch **`main`**. The language IVR / AI translation lives on **`dev`** and is
**not** part of this cutover.

## Before the day
- [ ] All `main` changes deployed and tested on this server (desktop app + web + relay).
- [ ] Resize the instance to production size (live today: 4 vCPU / 15 GB) — stop, change type, start.
- [ ] Daily snapshots on the root volume (AWS Backup or Data Lifecycle Manager).
- [ ] Production security groups: carriers' SIP rules (Telpeer, QuestBlue 128.136.235.202 UDP 5060),
      TCP 443 + 80 from anywhere, UDP 10000–20000 from anywhere, SSH from admin IPs only.
- [ ] Every agent's phone = type **DESKTOP**; desktop app (signed release build) installed with its
      firewall rule on all network profiles; agents' `appsettings.json` → production `ServerUrl`.
- [ ] Supervisors / training_quality / admins who use Listen have the desktop app too.
- [ ] Maintenance window agreed, outside calling hours.

## Cutover
1. [ ] Announce the window; agents sign out.
2. [ ] Old live server: stop the backend (`pm2 stop all`) and Asterisk (`systemctl stop asterisk`).
3. [ ] Copy live's databases here (mysqldump of `asterisk` + `cmx_dialer` → import), replacing dev's
       test data. Then run any migrations newer than live: **`sql/007_add_ring_seconds.sql`**.
       (008/009 are dev-branch IVR migrations — not needed on main.)
4. [ ] Stop the old live instance (keep it, don't terminate) and **move Elastic IP 54.198.88.159** to
       this instance — carriers, DNS and MicroSIP configs then need no change.
5. [ ] On this server, switch its own settings from the dev IP to the live IP / domain:
       `backend/.env` (`SERVER_IP=54.198.88.159`, `FRONTEND_URL`, `ASTERISK_WSS_URL`, `MYSQL_HOST`),
       Asterisk NAT (`external_media_address` / `external_signaling_address` on every transport),
       `rtp.conf` / ICE settings if set, S3 bucket + keys back to the production bucket.
6. [ ] Re-enable what dev disabled: Telpeer pjsip sections (`;DEV` prefix), Telpeer trunk active in
       the DB, remove the nftables block on 142.44.212.101, restore the live DIDs / dialplan
       (they return with live's data — re-save each campaign to regenerate the dialplan),
       re-enable the `rocky` cron jobs (recording archive).
7. [ ] Certificates: issue/confirm `callsuite.cmxinnovations.com` here; Apache + Asterisk
       `http.conf` TLS (8089, while any browser phone remains) point at it.
8. [ ] `pm2 restart all`, `sudo asterisk -rx 'core reload'`, then re-save every phone
       (Admin → Phones) so `media_address` = the live IP.
9. [ ] Tests: sign in (agent + admin), inbound call via each carrier, outbound call, recording
       uploaded to S3, callback, voicemail, supervisor Listen, desktop app from outside the office.
10. [ ] Reopen to agents.

## After
- [ ] Keep the old server stopped for 1–2 weeks as a fallback, then snapshot and terminate.
- [ ] Clone a new dev server from this one (dev-clone-setup.sh, dev-swap-numbers.sh), switch it to
      branch `dev` for the IVR / translation work.
