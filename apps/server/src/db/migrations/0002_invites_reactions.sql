-- 0002_invites_reactions — v0.2: invite links (ADR-007) + message reactions.
-- Mirrors docs/SCHEMA.sql; Drizzle twin in src/db/schema.ts.

-- ================================ invites ===================================
-- Tokens are stored PLAINTEXT with a unique index — deliberately NOT hashed
-- like session tokens: GET /api/invites must re-display the full /join/<token>
-- URL to its owner, and an invite token is a revocable, expiring, use-capped
-- capability for a share link, not an authentication credential. 32 random
-- bytes base64url (43 url-safe chars) keeps guessing infeasible; the public
-- endpoints that consume it are rate-limited per IP. See ADR-007.

CREATE TABLE invites (
  id              uuid PRIMARY KEY,                 -- uuidv7, app-side
  token           text NOT NULL UNIQUE,             -- plaintext capability (see above)
  inviter_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- NULL = DM-with-inviter invite; set = group the invite joins. CASCADE: a
  -- deleted group must not silently degrade its invites into DM invites.
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '7 days'),  -- INVITE_TTL_S
  max_uses        int NOT NULL DEFAULT 50 CHECK (max_uses > 0),             -- INVITE_MAX_USES
  use_count       int NOT NULL DEFAULT 0  CHECK (use_count >= 0),
  revoked_at      timestamptz                       -- set by DELETE /api/invites/:id
);
-- status (valid|expired|exhausted|revoked) is DERIVED, never stored:
-- revoked_at set > expires_at <= now() > use_count >= max_uses > valid.
-- Accepts run the atomic guard
--   UPDATE invites SET use_count = use_count + 1
--   WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()
--     AND use_count < max_uses
--   RETURNING *;
-- (0 rows = not acceptable) so concurrent accepts can never exceed max_uses.
CREATE INDEX invites_by_inviter_idx ON invites (inviter_id, created_at DESC);

-- =========================== message reactions ==============================
-- Message identity is (conversation_id, seq) — the messages PK — so the
-- composite FK rides the existing index, cascades with message/conversation
-- deletion, and the reactions PK serves the per-message aggregate
-- (GROUP BY emoji) as a pure PK-prefix scan. No surrogate id needed.
-- REACTIONS_PER_USER_PER_MESSAGE_MAX (8 distinct emoji per user per message)
-- is enforced in the route transaction, not by a CHECK.

CREATE TABLE message_reactions (
  conversation_id uuid   NOT NULL,
  seq             bigint NOT NULL,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji           text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 16),  -- REACTION_EMOJI_MAX_LEN
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, seq, user_id, emoji),
  FOREIGN KEY (conversation_id, seq)
    REFERENCES messages (conversation_id, seq) ON DELETE CASCADE
);
