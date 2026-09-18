-- ==================================================
-- Migration: ring_seconds
-- ==================================================
-- Run this manually against the live database. Adds one nullable
-- column to dialer_call_log capturing outbound "ring time" — how
-- long the customer's phone was actually ringing before either a
-- human answered, or an automatic outcome (no answer, busy, AMD
-- machine detection) was reached. Mirrors inbound_call_log's existing
-- wait_seconds column (see the abandon_reason/ringing_agent_user_id
-- migrations from earlier), just for the outbound side.
--
-- Written by backend/services/dialerService.js at whichever of its
-- two call-ending paths actually runs for a given call (the normal
-- agent-disposition path, or the automatic-outcome path for calls
-- that never reached a human) — both now compute this the same way,
-- from the same two timestamps (see that file's own comments).
--
-- NULL for any call that never actually rang the customer's line at
-- all (e.g. failed before the customer leg was ever dialed) — not
-- every row will have a value, same as wait_seconds on the inbound
-- side.
-- ==================================================

ALTER TABLE cmx_dialer.dialer_call_log
  ADD COLUMN ring_seconds INT NULL DEFAULT NULL;

-- Verify afterward:
--   SHOW COLUMNS FROM cmx_dialer.dialer_call_log LIKE 'ring_seconds';
