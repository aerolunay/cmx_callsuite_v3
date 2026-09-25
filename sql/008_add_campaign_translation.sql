-- ==================================================
-- Migration: campaign IVR language menu / translation
-- ==================================================
-- Run manually (dev first). Adds the per-campaign "Require Translation"
-- IVR settings edited in Admin -> Campaigns:
--
--   translation_enabled          'Y' = play the language menu after the
--                                greeting (business hours, BLENDED only);
--                                'N' = normal routing, unchanged.
--   translation_languages        JSON array, sorted by key, e.g.
--                                [{"key":1,"language":"en","routing":"agents"},
--                                 {"key":2,"language":"es","routing":"transfer","transferNumber":"6315551234"},
--                                 {"key":3,"language":"zh-cmn","routing":"ai"}]
--                                routing: agents | transfer | ai
--   language_menu_audio_filename The uploaded menu prompt ("For English
--                                press 1, para español oprima 2, ...").
-- ==================================================

ALTER TABLE cmx_dialer.campaign_settings
  ADD COLUMN IF NOT EXISTS translation_enabled CHAR(1) NOT NULL DEFAULT 'N',
  ADD COLUMN IF NOT EXISTS translation_languages TEXT NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS language_menu_audio_filename VARCHAR(255) NULL DEFAULT NULL;

-- Verify afterward:
--   SHOW COLUMNS FROM cmx_dialer.campaign_settings LIKE '%translation%';
--   SHOW COLUMNS FROM cmx_dialer.campaign_settings LIKE 'language_menu_audio_filename';
