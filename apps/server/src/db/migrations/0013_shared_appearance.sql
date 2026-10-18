-- #95b (2026-10-18, owner ask): theme + wallpaper the WHOLE conversation sees,
-- the shared-background pattern extended to the two §1.24 palette prefs.
-- DM: either side sets; group: admins. Per-user conversation_prefs.theme /
-- .wallpaper keep overriding locally (my view wins over the shared one).
-- Plain text, validated by the shared Zod enums (CHAT_THEMES / CHAT_WALLPAPERS)
-- so adding a palette never needs a migration.
ALTER TABLE conversations
  ADD COLUMN shared_theme text,
  ADD COLUMN shared_wallpaper text;
