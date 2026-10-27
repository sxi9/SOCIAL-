# ADR-020: Share pages, group visibility & community care — one token doctrine, a public floor that never moves backward, masks the server can see through, and a consented window for moderators

Status: accepted · Date: 2026-10-17

## Context

v0.8b's outward-facing half (FEATURES #79a, #79c, #79d, #81; API.md
§1.66–§1.69): canvas stories, public share pages, group visibility modes
(invite-only, public, 👻 ghost), and the admin pack (content tab, support
inbox, report-context viewer, update banner). Each one pushes on a wall the
product promised to keep: share pages put content in front of logged-out
strangers; public groups put *conversations* there; ghost groups hide members
from each other; and the admin pack keeps brushing against the no-private-
message-reader line drawn in ADR-013. The design question everywhere is the
same: how much can open up while every earlier promise stays literally true.

## Decision

- **Canvas overlays are data, never pixels.** Each contribution is its own
  row (kind + vector payload, Zod shape authority) keyed to its contributor —
  the attribution chip, one-tap removal, per-user caps, canvas bans, reports
  and story-expiry cascade all fall out of that one choice. Burning strokes
  into the image was rejected first: it makes removal lossy, attribution
  cosmetic, and moderation a re-render. Default mode is `off` — being
  drawable is an invitation, not an ambient state (the discovery-opt-in
  instinct); `approve` holds viewer layers as `pending` (serialized only to
  the two people who need them); removal tombstones (`removed`) so a report
  filed before moderation still resolves. Bans are enforced byte-identically
  to a closed canvas — a ban you can detect is a fight you just started.

- **One share-token doctrine for five object types.** The ADR-007 invite
  token, generalized: 32 bytes base64url, plaintext + unique index, a
  revocable capability. One OPEN token per object ("stable per object" — the
  same URL every time someone shares the same post), revoked with the object
  and re-mintable only where re-minting makes sense (stories). Two layers of
  death: explicit revocation, and the LIVE re-check of the object's
  publicness on every read — narrowing an audience kills the page in the
  same instant, before any revoke lands, because the read asks the object,
  not the token. Friends-only content never mints (route-refused), so a
  public URL to private content is unrepresentable, not just forbidden.
  **Amended 2026-10-27 (AUDIT-PLAN decision 11, Slice D):** a non-public
  post / plan / listing is mintable by its OWNER only, with a Teaser/Full
  `preview` stored on the token (migration 0014); the page is trimmed
  server-side for a teaser and the media proxy serves only the attachments
  the page lists. The live re-check still kills the page when the author is
  banned or the object is gone; narrowing a listing and deleting /
  cancelling any object revoke route-side (post and plan audiences are
  immutable after creation).
  All share media rides token-gated proxies (the invite-avatar pattern):
  `/api/media/:key` stays authed, there is no open media route to enumerate,
  and author chips carry no ids and no UserLite — a stranger gets exactly
  what the OG unfurler gets. `PUBLIC_ORIGIN` governs every absolute URL (the
  §1.53/TROUBLESHOOTING lesson, now a contract line).

- **Interaction gates to signup with `?next`.** Viewing is free; acting
  requires an account and deep-links back to finish the act. The page is an
  invitation, not a shadow client — reactions, joins and comments stay
  behind the same server-side block/privacy machinery as always, which a
  logged-out surface cannot evaluate. Non-users can do exactly one thing
  besides read: report (reason required, reporter_id NULL + IP, 5/day/IP) —
  abuse handling must not require an account, but anonymous write access
  must stay nearly useless for anything else.

- **Public groups expose a floor, not a history.** `public_since_seq` is
  stamped inside the admin-confirmed switch transaction and is the ONLY gate
  the share page reads through: messages at or below it are structurally
  unreachable (the §1.4 join_seq floor logic, pointed outward). Leaving
  `public` clears the floor and revokes the token; re-publicizing stamps a
  fresh one — so no toggle dance can ever retro-expose a word said in
  private. The switch drops a system message and the DTO's floor doubles as
  the persistent member banner: everyone writing into a public group knows,
  from the room itself, that the room is public. Member identities DO render
  on the public page (real conversations need real voices; the banner and
  confirm are the consent), but tombstones, undone messages and system noise
  never do. `member_count` appears on group CARDS only — join-decision
  utility, the ADR-012 trust-information argument re-made; it stays off every
  in-app surface (§1.35's no-member-counts rule is untouched).

- **Ghost groups: anonymous to each other, never to the server — and a
  one-way door.** Masks (pseudonym + emoji, unique per group, auto-assigned
  at join/switch) replace member identity AT SERIALIZATION for non-admin
  members: pseudo-id derived per (group, member) with a server secret
  (stable inside, linkable nowhere), empty avatar, no mood, no name_style.
  The #77 principle carries over exactly: group admins see real identities
  (abuse needs a responsible adult) and reports always attach them. The
  side channels got closed rather than masked: presence, typing, last-seen,
  seen-by are suppressed outright (a masked typing indicator still leaks
  rhythm), @mentions are not parsed, push says the group title only, ghost
  groups appear in no listing, no suggestion signal, no activity record, no
  share token. And `ghost` is permanent — `400 ghost_is_forever` — because
  people spoke under masks: an admin toggle that unmasked them retroactively
  would be the worst broken promise this product could make. De-ghosting is
  a new group.

- **Join requests decide silently.** invite_only's queue row is presence-only;
  approve inserts the participant and deletes the row in one transaction,
  deny just deletes it. No deny event, no state the requester can poll for a
  rejection — ADR-015's no-rejection-surface rule, re-applied to rooms.

- **The support inbox is a conversation, not a CRM.** Tickets are index
  cards; the dialogue is an ordinary per-user conversation (type `group`,
  one member, `metadata.support`) so delivery, push, unread, receipts and
  offline sync come free from machinery that already holds the product's
  hardest guarantees. Operator messages are `sender_id NULL` + a metadata
  rider rendered as the "Bored Chat Support" brand — a named admin in a
  user's inbox is a target and an inconsistency (the next admin answers as
  the same voice). Takedown notices ride the same channel for the same
  reason: one neutral operator voice, author told the reason, no public
  mark. Reading this conversation from the admin side is NOT private-chat
  reading: it has one human party, and that party is talking *to the
  operator* — consent is structural, which is exactly the test ADR-013 set.

- **The content tab can only see what is already public.** Public posts,
  public beacons, board listings — things any member reads today. The
  endpoint is incapable of returning a private object (the queries filter on
  audience, not on admin intent), so the no-private-reader promise holds by
  construction, not policy. Takedowns reuse each module's own delete
  semantics — a moderator's removal and an author's removal are the same
  state machine, just a different actor and a logged reason.

- **The report-context viewer is a consented window, not a reader.** The
  reporter — a legitimate party to the conversation — may check one box
  (exact copy in the contract, unchecked by default) that discloses the
  reported message ± 5. Without the bit: 404, byte-identical to wrong-kind,
  so consent is not probeable. The slice resolves live (tombstones show as
  deleted — the viewer never resurrects what the room removed), bodies
  render (the one admin surface where they do, and the reporter opened it),
  attachments stay metadata-only, ghost masks do not apply (the server was
  never anonymous), and every view is ring-logged. Snapshotting the slice at
  report time was rejected: a frozen copy of counterparties' words sitting
  in a report row is a second archive with its own leak surface; live
  resolution keeps exactly one source of truth.

- **The update banner tells the truth and touches nothing.** Build arg
  commit vs the repo remote's HEAD via the git HTTPS smart protocol — first-
  party git plumbing, no API, no key (golden rule 7). Unreachable remote →
  `update_available: null`, rendered as "couldn't check", never as a guess
  (the §1.55 TURN-honesty posture). The container never gets docker.sock;
  the banner's whole power is a sentence telling the operator to run
  `./bored update` on the host.

## Consequences

- `UserLite.mask_emoji` is the one DTO field whose presence changes the
  meaning of its siblings (the whole UserLite becomes a mask). Serializers
  must build masked frames atomically — a half-masked UserLite (real avatar,
  mask name) is the bug class to test for, alongside the gateway surfaces
  (§2.11 grows the ghost suppression rules).
- The share pages add the project's first logged-out SSR beyond /join:
  `/p/<token>`, `/s/<token>` must copy the join-page patterns exactly
  (publicOrigin, x-forwarded-for re-send, fresh-link OG testing).
- Reports now admit reporter-less rows; every reports consumer must treat
  `reporter` as nullable (the Zod contract already forces it).
- Takedown/revocation cascades cross module boundaries (delete object →
  revoke token → notify author): each owning module keeps its own delete,
  and the admin module composes them in one transaction — no second delete
  path is written.
- The gc worker gains two small sweeps (dead share tokens, anon timer
  reveals ride `timers`), and the orphan-attachment anti-join gains the
  support-ticket index beside the chat-background one (0009's documented
  exception now has exactly two members — a third should prompt a helper).
- Deferred, explicitly: share-page comments for non-users (never — identity
  is the moderation anchor), public group SEARCH beyond the discovery
  listing, mask re-rolls with history, LiveKit-era public audio rooms, and
  admin takedown of §1.36 friends-only posts (reports remain that path).
