-- ==================================================
-- Migration: language-menu invalid-option prompt
-- ==================================================
-- Run manually (dev first), after 008. Adds the separate prompt played when
-- a caller presses a key that isn't in the campaign's language menu
-- (Admin -> Campaigns -> Require Translation). Independent of the voicemail
-- invalid-option prompt.
-- ==================================================

ALTER TABLE cmx_dialer.campaign_settings
  ADD COLUMN IF NOT EXISTS language_invalid_option_audio_filename VARCHAR(255) NULL DEFAULT NULL;

-- Verify afterward:
--   SHOW COLUMNS FROM cmx_dialer.campaign_settings LIKE 'language_invalid_option_audio_filename';
