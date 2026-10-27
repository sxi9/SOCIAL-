# Session Handoff — continue from here

Updated 2026-10-27. A new session continues this project by reading
`CLAUDE.md` first (it auto-loads), then this file, then
`docs/AUDIT-PLAN.md`.

## State at handoff

- **2026-10-27, later the same day:** the share-everything build (AUDIT-PLAN
  §1b) started. Shipped and DEPLOYED to the box (`7c66d1e`): Wave 0 part 1
  docs, Slice A (reaction chips show faces never counts; group invite link
  reachable from chat settings; three adversarial review rounds), Slice B
  (migration 0014: `share_tokens.preview`, `users.dm_policy` — existing
  accounts backfilled to `everyone`, new default `connections` —,
  `users.profile_visibility`). Then DEPLOYED as well (`1fe499c`, 23:45): Slice C — the one
  `ShareSheet` on post/plan/listing/story/group (Copy · OS share · QR · Send
  to a chat · Stop sharing), `ChatPickerSheet` extracted from ForwardSheet,
  `GET /api/share-links/mine`, Settings → Privacy "Your share links",
  `lib/overlays.ts` topmost-only Escape. Then DEPLOYED too (`a924600`,
  2026-10-28 00:29) Slice D: non-public
  post/plan/listing share by an OWNER-minted token with a Teaser/Full choice
  (server-trimmed teaser, media proxy serves only what the page lists; the
  ShareSheet asks before minting and reuses an open token), object routes
  `/feed/[postId]`, `/local/[listingId]`, `/local/b/[beaconId]` (Local tab body
  is `components/LocalTab`; deep-linked posts live in `state.feedExtra`),
  `deepLink()` lands on the object, one gated CTA on teaser pages, `noindex` +
  `app/robots.ts`; a listing's `is_public` change EITHER way now revokes its
  token. Then Slice E, DEPLOYED (`23146bf`, 2026-10-28 00:51): the inline sign-in sheet on every share-page
  CTA (`GateCta` → `InlineSignInSheet`: password, passkey, QR, create account,
  TOTP; lands on the object; `/register?next=` href kept for no-JS), the three
  v0.9 auth minors, and the login page's suspended/banned copy. Next: phases
  2–7 per §1b (group join loop first). Open follow-up from review: the unfurl
  worker charges the sender's hourly budget for our own share URLs (short-
  circuit origin == PUBLIC_ORIGIN in the send route).
- `main` at `b396d09` (2026-10-27, morning). Shipped since the previous handoff, in
  order: v0.9.1 auth hardening, v1.0a board & media pack (#91-#95), v1.1
  Royal UI, Royal v2 wave A (complete round-2 reskin), and the 2026-10-18
  batch — change password (84b), Settings → Appearance light/dark/system +
  accents (95c), shared group theme/wallpaper (95b, migration 0013), sounds
  (#103), in-app ConfirmSheet replacing `window.confirm`, delete
  group/channel, missed-call card, XHR upload progress, server HEIC
  conversion, SW stale-shell self-heal, admin grant/revoke + set password,
  Tailscale Funnel as the stable public URL. The undo-send pill was REMOVED
  by owner decision (FEATURES #96 struck; server undo route stays).
- Migrations run `0000`…`0014`. **The next free number is 0015.** `0014`
  (2026-10-27) holds the share-everything plumbing only — `share_tokens.preview`,
  `users.dm_policy`, `users.profile_visibility`; the Wave 1 legal/account/report
  columns AUDIT-PLAN §10 lists go in `0015` when that wave starts (§10 allows
  the split). The product audit's "migration 0013" references are stale.
- The `wip/v0.9` and `backup/*` branches are historical only — ignore
  them (main supersedes).

## FIRST TASK for the next session: work the product audit plan

`docs/AUDIT-PLAN.md` (written 2026-10-27) is the sequenced plan derived
from the 17-benchmark product audit `AUDIT-2026-10-18.md` (kept outside
the repo in the owner's Downloads, 3,130 lines; every item was re-verified
against `b396d09`). Read it before starting anything feature-shaped:

- **§0** lists what the 2026-10-18 commits already closed and the
  remainder of each — do not redo those.
- **§1** lists ten decisions only the owner can make (age line 16+/18+,
  contacts import, YouTube carve-out, `member_count` docs-vs-code, the
  API.md §1.13 "no all-off switch" sentence, call-declined copy,
  registration default, two bans to write down, OSM tiles, pull-to-refresh).
  Ask before building anything that depends on one.
- **§1b "Share everything"** is an owner requirement from 2026-10-27:
  every object (profile = "text me / call me", call room, plan, listing,
  group, post, story, chat media) gets a sendable link whose page shows a
  teaser and gates message / call / join / more media behind sign-in,
  landing back on that object. It names what exists today and which wave
  builds each piece; decision 11 (how much a share page shows before
  login) must be answered before the non-public token links are built.
- **§2 Wave 0** is the list of docs and in-product copy that currently lie
  — hours of string edits, do it first or alongside Wave 1.
- **§3 Wave 1** is the P0 floor: legal/consent pages, account lifecycle
  (delete, change email, sign-out-everywhere, export), a sign-out that
  actually signs out, login that explains suspensions, report taxonomy + post/
  comment/story/listing/group report kinds, mute end to end,
  who-can-message + requests inbox, age gate, and the small P0 bugs.
  Start here unless the owner says otherwise.
- **§4–§9** are Waves 2–7 (chat/groups, feed/stories, notifications/
  platform, theme/shell/settings, standard parity, differentiators), each
  item with the file and line it lives at. **§10** collects the Wave 1
  columns for migration 0015 (0014 already holds the §1b share plumbing).
  **§11** is the week-by-week order.
- Three audit suggestions lean on the removed undo pill (story delete,
  comment delete, post undo window) — use `lib/confirm.ts` instead.

Hold the CLAUDE.md verification bar per wave; shoot Playwright screenshots
in the **light** scheme as well as dark (the audit's captures were all
light, and that is the theme most phones show).

## v0.9 auth audit: closed

The audit's MAJOR (TOTP rate limit) went in v0.9.1; its three MINORS shipped
2026-10-28 with Slice E (`passkeys.ts` conditional counter write, `recovery.ts`
equal-cost dummy consume + reset token minted before revoke/notify, notify
best-effort). Nothing from that audit is open.

## The agreed backlog (owner schedules, do not auto-start)

LiveKit SFU for >8-person calls · listen-together · E2EE · native wrappers
· make-it-yours kit · federation · a real SMTP mailer (turns on the stored
OTP/email toggles in admin→Authentication). These map to AUDIT-PLAN Wave 7.

## Owner's operational setup (context the new session needs)

- Production runs on the owner's Ubuntu box (see `docs/CLAUDE-MEMORY.md`
  for host, services and past incidents), driven by `./bored`
  (update/tunnel/status/backup/export-import; autoupdate cron optional).
  Stable public URL is Tailscale Funnel (bc6ad3d; Caddy `:80` catch-all);
  cloudflared quick tunnels remain the fallback; `PUBLIC_ORIGIN` in `.env`.
  Cross-network calls need a VPS or port-forwarding (ADR-017). Admin is
  granted by CLI (`./bored admin <user>`) or, since a3af7b2, from the admin
  Users tab; the CLI stays the root of trust.
- `./bored backup` is DATABASE ONLY — media in the `minio_data` volume is
  not included (AUDIT-PLAN Wave 1.9 asks to fix the message or the script).
- Passkeys bind to the domain (WEBAUTHN_RP_ID, ADR-021) — on quick
  tunnels every run is a new domain, so tell the owner to enroll passkeys
  only on a stable domain.
- Standing decisions are in `docs/SPECS.md` (bottom section) — honor them.
