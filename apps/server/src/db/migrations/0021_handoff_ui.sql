-- 0021 — "Gallery and post layouts" handoff (2026-10-28). 0020 is never reused.

-- Threaded comments (handoff 1e): ONE reply level. parent_id points at a
-- top-level comment on the SAME post (both route-enforced: a reply to a
-- reply is 400 reply_depth; a parent on another post is 404 comment_not_found).
-- Deleting the parent cascades its replies (a takedown removes the thread).
ALTER TABLE post_comments
  ADD COLUMN parent_id uuid REFERENCES post_comments(id) ON DELETE CASCADE;
CREATE INDEX post_comments_by_parent_idx ON post_comments (parent_id, created_at)
  WHERE parent_id IS NOT NULL;

-- Story activity (handoff 2b/2d): what a VIEWER did on a story — one emoji
-- reaction (the latest wins) and whether they replied in chat. One row per
-- (story, viewer); NO timestamp column, matching story_views (the "who saw
-- it" list is names, never a timeline — PSYCHOLOGY never-build list). Dies
-- with the story (cascade). The reply/reaction itself lands as a DM message
-- carrying metadata.story_ref; this row only feeds the author's named list.
CREATE TABLE story_activity (
  story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji text,
  replied boolean NOT NULL DEFAULT false,
  PRIMARY KEY (story_id, viewer_id),
  CONSTRAINT story_activity_emoji_check CHECK (emoji IS NULL OR char_length(emoji) BETWEEN 1 AND 16)
);
