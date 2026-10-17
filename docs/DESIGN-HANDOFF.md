# Bored Chat — Design Handoff (complete feature, screen & layout inventory)

Written 2026-10-17 for a design pass over the whole product. Everything below
EXISTS and works (shipped through v1.0a). The job is to redesign/polish the
UI on top of this inventory — modern, smooth, "royal elite" feel per the
owner — WITHOUT changing contracts or breaking the binding rules at the
bottom. Verify every screen at 390x844 and 360x740 AND desktop two-pane.

## 1. What the product is

Self-hosted social chat PWA: WhatsApp-style messaging + Instagram-style
stories/feed/profiles + a local community board + calls, all first-party.
Four bottom tabs: **Chats · Local · Feed · Profile**. Desktop: two-pane
(list + detail). TypeScript monorepo; web is Next.js App Router in
`apps/web` (all styling is hand-written CSS modules + `globals.css` tokens —
no Tailwind, no component library).

## 2. Complete feature inventory (all shipped)

### Messaging core (v0.1–v0.2)
1:1 & group chat (≤256) · sent/delivered/read ticks · exact offline sync ·
typing/presence/last-seen · animated GIF avatars (users + groups) ·
photo/video/file messages (thumbs, blurhash) · PWA share target · link
preview cards · web push · GIF invite links (`/join/<token>`) · reactions ·
two-pane desktop · emoji picker · public profiles (`/u/username`) ·
session/device management.

### Login & mascot (v0.2.1)
Bored Blob mascot: eye tracking, covers eyes on password, yawns, head-shake
on error, success bounce, party mode · pointer-reactive background, card
tilt, rotating taglines, flipping wordmark, register confetti.

### Beacons & privacy (v0.3)
"I'm bored" beacons (vibe chips, now/tonight/weekend, friends/nearby/public)
· live plan cards, "I'm in 🙋" avatar pile, spark threshold → auto
plan-group with icebreaker + venue poll · boredom radar (aggregate only) ·
rituals · afterglow photo recaps · seen-by lists · full privacy settings ·
block & report everywhere · coarse opt-in area (no GPS).

### Expression (v0.4)
Avatar stamps · voice notes · doodle messages · message effects · vibe check
(GIF answers) · chat themes/wallpapers/nicknames · disappearing messages ·
scheduled messages + time capsules · chat mini-games + daily puzzle.

### Local board & social (v0.5)
Gig/ride/room/review listings (+ photos on EVERY kind, v1.0a) · beacons as
board cards · person reviews · stories (24 h, viewer faces) · broadcast
channels · feed (posts/reactions/comments) · rich profiles (3-GIF strip,
interests, portfolio) · connections graph · replies/threads, edit/delete,
forwarding, pins, @mentions, group admins.

### Calls & discovery (v0.6–v0.7.1)
1:1 voice/video (WebRTC + self-hosted TURN) · group mesh calls ≤8 · watch
together (YouTube) · Bored Together / Roulette (mutual waves, keep-or-vanish)
· Rescue me · floating minimized call pill · incoming-call push with
Answer/Decline · connection-state UX + call self-test · TURN honesty banner.

### Interactivity (v0.7)
Tap any avatar → profile · editable beacons/listings · early spark · joiner
notifications · feed lanes (Friends/Discover) · poll posts · open
game-challenge posts · "Join my…" cross-post cards · image/GIF comments +
comment reactions · location chips (no map embeds) · "📍 Join me here" chat
drops with "On my way 🏃" · scheduled-send toast + drawer · OG invite banner.

### Identity & moods (v0.8a)
Moods (preset + custom, auto-expiring, visibility-scoped, swing mode) · 🍻
drunk mode (wobbly chip, undo, you-sure checks, care banner) · mood-reactive
message animations (per-viewer toggle) · animated display names
(glow/shimmer/rainbow) · profile activity strip with per-type privacy ·
anonymous message game (timer/riddle reveal) · people-you-may-know ·
anonymous wave nudges · discovery filters · per-user chat backgrounds.

### Community & sharing (v0.8b)
Canvas stories (collaborative overlays, attributed, author-moderated) ·
public share pages (SSR, OG unfurls, signup-gated interaction) · group
visibility modes: 🔒 private · 🎟️ invite-only · 🌍 public · 👻 ghost
(pseudonym masks) · first-run tour · "✨ Things you can do" directory ·
admin: moderation tab, support inbox, report-context viewer.

### Auth pack (v0.9)
Passkeys · QR cross-device login · recovery codes · TOTP 2FA · admin
Authentication settings (SMTP/OTP-ready toggles).

### Board & media pack (v1.0a — just shipped)
Photos on every board kind + iPhone HEIC fix · crop/rotate editor with
aspect presets everywhere images are picked · full-screen pinch-zoom viewer
(chat, board, profile pics) · My gallery (private; stories auto-save on
expiry; saved items deletable) · shared chat backgrounds ("Set for
everyone", admin-gated in groups, personal override survives) · transparent
undo-send pill on every message (5 s; drunk 10 s) · re-askable
notifications prompt in Settings · caller name+avatar always on rings (incl.
group push body) · Find People page (filters: mutuals/groups/area/interests).

### Queued next (designs in docs/SPECS.md §v1.0)
**v1.0b Stories pack:** multiple stories per author · viewer list ·
voice reactions · live comment strip · audiences (public/connections/
exclusive/hide-from).
**v1.0c Calls pack:** call history · ringtones + text sounds ·
audio↔video switch · PiP/split-screen layouts.
**v1.0d Profile/search/sharing:** tap-photo→profile sheet · profile tabs
with per-section privacy · global search · "Spotted" photo+location pins ·
share-everywhere audit (OG unfurls to other social media, standalone profile
links, videos playable for non-users, login only gates interaction).

## 3. Every screen (routes)

<!-- ROUTES -->

## 4. Overlays, sheets & global components

<!-- OVERLAYS -->

## 5. Current design system (tokens & conventions)

<!-- TOKENS -->

## 6. Binding rules the redesign MUST keep (docs/PSYCHOLOGY.md is law)

- **No public numeric counts**: no like counts, follower counts, view
  counts, leaderboards. Named faces instead, always.
- **No "seen X minutes ago" timestamps** — receipts yes, deadlines no.
- **No infinite feeds** — finite, with a visible hard end.
- **No streaks / guilt / variable-reward mechanics**; notifications are
  calm (digests, batching), never "come back" nudges.
- Never notify someone about something they cannot join.
- Blocks & privacy are server-enforced; mentions may override mute, never
  blocks. Ghost-group members stay masked; member enumeration is forbidden.
- Self-hosted ethos: no third-party SaaS (no Giphy/map tiles/payment UI);
  all media via the auth-checked proxy; money never moves in-app.
- Sheets/overlays portal to `<body>` (never `position:fixed` inside a
  transformed ancestor); hidden overlays use `display:none`/unmount, never
  `opacity:0`; bottom sheets: `max-height` + internal scroll + safe-area +
  tab-bar padding; inputs ≥16 px font (iOS zoom); prefer `100dvh`;
  `prefers-reduced-motion` honored on every animation.
- Accessibility floor: ARIA roles/labels as they exist today (every control
  reachable and labeled), focus not regressed.

## 7. Verification bar (CLAUDE.md — hold it for every screen you touch)

`pnpm -r build` clean twice · full test suite vs live Postgres/Redis · curl
smoke of changed journeys · Playwright screenshots at 390x844 + 360x740 +
desktop, reviewed · read-only security audit of anything touching authz/
privacy. Zero new dependencies (pin exact versions if truly unavoidable).

## 8. Where things live

- Web app: `apps/web/app/*` (routes), `apps/web/components/*` (+ a CSS
  module per domain), `apps/web/lib/*` (state in `lib/store.ts`, one global
  subscription model).
- Contract: `packages/shared` (Zod DTOs + constants). `docs/API.md` wins on
  any disagreement.
- Full map: `docs/SYSTEM-MAP.md`. Designs for queued packs: `docs/SPECS.md`.
