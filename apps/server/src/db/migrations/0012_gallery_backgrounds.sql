-- v1.0a — Board & media pack (#94 gallery + story saver, #95 shared chat
-- backgrounds). FEATURES #94/#95, SPECS §v1.0a.

-- #94: "My gallery" saves. A save row keeps an attachment alive past its
-- binding (the orphan GC anti-joins it): today's one source is the story
-- auto-saver — on sweep expiry the author's story media moves here instead
-- of being hard-deleted. Private to the owner; deleting the save re-orphans
-- the attachment into the ordinary 24 h GC.
CREATE TABLE gallery_saves (
  user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attachment_id uuid        NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  source        text        NOT NULL DEFAULT 'story' CHECK (source IN ('story')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, attachment_id)
);
CREATE INDEX gallery_saves_attachment_idx ON gallery_saves (attachment_id);

-- #95: a background the whole conversation sees (DM: either side may set;
-- group: admins). Per-user conversation_prefs.background_attachment_id keeps
-- overriding it locally. References attachment like the 0009 prefs pattern —
-- the GC anti-joins the partial index; SET NULL on attachment loss.
ALTER TABLE conversations
  ADD COLUMN shared_background_attachment_id uuid
    REFERENCES attachments(id) ON DELETE SET NULL;
CREATE INDEX conversations_shared_background_idx
  ON conversations (shared_background_attachment_id)
  WHERE shared_background_attachment_id IS NOT NULL;
