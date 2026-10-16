# ADR-007: Invite links — plaintext capability tokens + a public, token-gated avatar proxy

Status: accepted · Date: 2026-10-16

## Context

v0.2's signature growth feature: any user mints a shareable link
(`https://<domain>/join/<token>`) that shows the inviter's animated avatar to a
logged-out visitor and drops whoever registers through it straight into a DM
with the inviter, or into the group the invite is scoped to. Three tensions:

1. Session tokens are stored hashed (ADR-001). Should invite tokens be too?
   The spec'd owner experience (`GET /api/invites` re-lists links to re-copy)
   requires re-displaying the full URL, which a hash-only store cannot do.
2. The join page and OG unfurlers (Slack, WhatsApp, iMessage) are
   unauthenticated by definition, but `/api/media/:key` is auth-checked and the
   MinIO bucket is compose-network-only (ADR-004).
3. `max_uses` must hold under concurrent redemptions.

## Decision

- **Plaintext tokens, unique-indexed** (`invites.token`): 32 random bytes
  base64url (43 chars — same generator as session tokens). Not hashed, because
  an invite token is a *revocable, expiring, use-capped capability for one
  join action*, not an authentication credential: a leaked DB already contains
  everything an invite grants access to. Re-display beats hashing here.
  Mitigations: 256-bit entropy, per-IP rate limits on the public endpoints
  (60/h lookup, 120/h avatar), 7-day default expiry, 50-use default cap,
  one-click revocation.
- **Derived status, atomic redemption**: `valid|expired|exhausted|revoked` is
  computed (precedence `revoked > expired > exhausted`), never stored. Accepts
  run `UPDATE invites SET use_count = use_count + 1 WHERE id = $1 AND
  revoked_at IS NULL AND expires_at > now() AND use_count < max_uses
  RETURNING *` — zero rows = not acceptable; concurrency cannot over-redeem.
- **Scope**: `conversation_id IS NULL` = DM-with-inviter (create-or-dedupe via
  `dm_key`); set = that group (minting is admin-only, consistent with §1.4
  participant adds; relaxing to members later is a one-line policy change).
  `ON DELETE CASCADE` so a deleted group kills its invites rather than
  degrading them into DM invites.
- **Public-but-token-gated avatar proxy**
  (`GET /api/invites/:token/avatar?v=static|animated`): streams the inviter's
  current avatar without auth, because the token itself is the capability. It
  exposes no MinIO keys, 404s unless the invite is `valid` (revocation
  instantly kills it) and the avatar `ready`, is per-IP rate-limited, and sends
  `Cache-Control: private, max-age=300`. Default `static` (JPEG for unfurler
  compatibility); the join page requests `animated`, honoring
  `prefers-reduced-motion`.
- **Join mechanics reuse existing machinery**: `join_seq = last_seq` history
  floor, system message `invite_joined` (actor = joiner, target = inviter),
  `conv.new`/`conv.updated` over the Redis `events` channel. Already-member
  re-accepts are idempotent `200` without a `use_count` increment.
  Register-with-token accepts AFTER the account commit and never fails
  registration — a dead invite yields `invite: null`, not an error.

## Consequences

- Growth loop ships with zero new auth machinery and no MinIO exposure; the
  public surface is two rate-limited GETs gated on a 256-bit secret.
- A database leak exposes live invite links until expiry/revocation — accepted:
  the blast radius is "may join a group/DM the link already pointed at",
  bounded by `max_uses`, `expires_at` and revocation; it grants no account
  access. Revisit (hash + show-once) if invites ever gate paid or admin
  capabilities.
- The public lookup confirms a token's existence and inviter identity for
  anyone holding the link — inherent to the feature; unknown tokens 404
  identically, so there is no enumeration oracle beyond the link itself.
- `use_count` tells the minter how many joins a link produced (lightweight
  virality metric, no extra tables).
