# Design-generation prompt — Bored Chat "Royal v2" (complete app, professional IA)

Copy everything below this line into the design session.

---

Design a complete, professional UI for **Bored Chat** — a self-hosted social chat PWA
(WhatsApp + Instagram + a local community board). This is ROUND 2: round 1 ("Royal")
designed only 6 screens, and the implemented app now feels mixed — polished core screens
sitting next to unorganized ones. Round 2 must cover **the entire app** so every screen
belongs to one system.

## Keep from round 1 (do not redesign these foundations)
- The "Royal" look: charcoal-navy `#12141c` bg + white/silver accent gradient
  (`linear-gradient(160deg,#ffffff,#c7cdda)`, ink text `#12141c`), panels `#1a1e2a`/`#232838`,
  border `#2a2f3e`, text `#f3f5f9`, muted `#9aa0ae`, ok `#4cd4a0`, danger `#ff6b6b`,
  silver conic story rings, 16px radius cards / 999px pills.
- Typography: **Marcellus** (display serif: page titles, wordmark, poll questions)
  + **Instrument Sans** (everything else). Both self-hosted.
- The animated mood login (bored./happy./sad./drunk. cycle) — keep as designed.
- Outgoing chat bubbles = white/silver gradient with ink text; incoming = `#232838`.

## Fix these systemic problems (the reason for round 2)
1. **Header/icon system.** Today the Chats header is a row of raw emoji (🆘 🎭 🔗 👥 ⚙️) —
   it reads as clutter. Design ONE consistent header system: serif title left, at most
   2–3 line-style stroke icons right (1.7px stroke, like Telegram/Instagram), everything
   else behind ONE overflow (⋯ or a "+" menu). Specify the exact icon set for every
   screen's header. No emoji as UI icons anywhere (emoji stay in content: moods, reactions).
2. **Information architecture.** Settings is a long unorganized page. Restructure as
   grouped categories, Telegram-style: **Account** (profile, avatar, mood) ·
   **Privacy & Safety** (receipts, last-seen, blocks, activity visibility) ·
   **Notifications & Sounds** (push, ringtones, text sounds) · **Chats** (themes,
   wallpapers, backgrounds) · **Calls** (self-test, history) · **Devices & Security**
   (sessions, passkeys, 2FA, recovery) · **Help & About**. Design the category list page
   and each subpage pattern (header, rows with chevrons, toggles, radio groups).
3. **The stories strip is clipped** under the chat-list header — design the exact
   strip spacing/scroll behavior (Instagram-style: 64–72px rings, name under, generous
   top padding, never clipped).
4. **Alignment discipline.** Define one spacing scale (4/8/12/16/20/24), one row height
   system for lists, one card pattern — and apply it on every screen so nothing looks
   "mixed" again.

## Professional inspiration (study these, blend into Royal)
- **Telegram**: settings IA, chat list density, in-chat action sheet patterns.
- **WhatsApp**: conversation screen ergonomics, call screens, group info layout.
- **Instagram**: profile page (ring avatar, grid), stories strip + viewer, feed grid,
  share sheets.
- **Hinge/Bumble**: the discovery ("Bored Together") cards and Find People page —
  warm, card-first, zero sleaze.

## Design EVERY screen (the complete inventory — nothing may be skipped)
**Tabs:** Chats list (+ stories strip) · Local (beacon strip, Bored Together discovery,
board with filters) · Feed (**grid view default** — 3-col media mosaic with list toggle,
composer, polls, finite "all caught up" end card) · Profile (own).
**Chat:** conversation (bubbles, replies/swipe-to-reply gesture spec, reactions, voice
notes, doodles, polls, plan card, typing, date pills) · composer states (attach menu,
voice recording, mention autocomplete, scheduled) · chat info/settings sheet (group
avatar + change photo/GIF, members with roles, ADD PEOPLE, visibility modes
private/invite-only/public/ghost, themes/wallpapers/shared background, disappearing,
join requests) · new chat/group/channel creation · forward sheet · anonymous inbox +
reveal-game thread.
**Stories:** strip states, multi-story viewer (segments, hold-pause, tap zones), viewer
list (named faces, never counts), reply pill + quick reactions + voice reaction,
live comment strip (author opt-in), audience picker (public / connections / exclusive
close-friends / hide-from), canvas-story collaborative overlays, story composer
(camera roll, crop, text/doodle).
**Calls:** incoming full-screen ring (caller name+avatar) · in-call 1:1 voice ·
in-call video (PiP + two-half split template, tap-to-swap) · group call grid ·
minimized floating pill · **call history screen** (in/out/missed, callback) ·
call self-test · audio↔video switch consent prompt.
**Profiles:** own profile · other user's profile (mood, interests, pic grid feed,
posts; per-section privacy; connect/message/anon buttons) · profile share link page
(what a logged-out stranger sees) · Find People (filter chips grid) · connections/requests.
**Local/board:** beacon create/detail/edit sheets · listing create/detail/edit (all 4
kinds + photos) · "Spotted" photo+location pin card with "interested 👀" faces ·
team-up sheet · reviews.
**Media:** My Gallery (grid, filters, saved stories) · pinch-zoom lightbox · image
crop/edit sheet.
**Search:** global search page (people, groups, posts, board) with recent searches.
**System:** login/register (keep mood login) · QR cross-device login · recovery codes ·
onboarding tour · push-permission sheet · toasts · empty states for EVERY list ·
public share pages (post/beacon/listing/group card/profile — viewable logged-out,
every interaction gates to signup) · admin console (desktop: users, reports, moderation,
support inbox, authentication settings).

## Hard product rules (law — the design must comply)
- NO public numeric counts: no like counts, follower counts, view counts, or
  leaderboards — named faces instead ("You, Jonas, Priya").
- NO "seen X minutes ago" — receipts are word-only ("Read").
- Finite feed with a hard end card. No infinite scroll, no pull-to-refresh loops.
- No streaks/guilt mechanics. Never notify about something the user can't join.
- Ghost-group members render as masks (pseudonym + emoji).
- All animation must have a reduced-motion fallback. Inputs ≥16px. Mobile-first
  390×844 and 360×740, plus the desktop two-pane (list + detail) layout.

## Deliverable format (same as round 1 — it worked)
1. **One standalone interactive HTML prototype** (single file, fonts + sample images
   embedded) — starts at login, every screen reachable by tapping through, realistic
   sample data (fake names/photos fine).
2. **README.md handoff** mapping every screen → the repo files
   (`sxi9/SOCIAL-`, Next.js in `apps/web`, hand-written CSS modules + `globals.css`
   tokens, no Tailwind/component libs), with exact tokens, type sizes, spacing values,
   icon SVG specs, keyframes, and the interaction notes per screen.
3. A screen index checklist at the top of the README listing every screen designed,
   so nothing from the inventory above is missing.

Quality bar: it should look like a funded consumer app — Instagram-level finish on the
Royal palette. Every clickable element visually clickable, every list aligned to the
grid, every screen clearly part of the same family.
