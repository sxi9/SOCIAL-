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


PWA, mobile-first (390/360px) with desktop enhancements. **Global shell on every authed page:** bottom tab bar on mobile / slim left rail ≥900px (Chats · Local · Feed · Profile, unread/request dots, hides on mobile while a chat is open) + app-wide overlays: incoming-call overlay & in-call screen, mutual-wave "match moment", roulette goodbye screen, one-time expectation-feedback sheet, push-permission explainer sheet, spotlight onboarding tour, toasts, message-effect overlay. Root theme: dark `#0b0e14` / light `#f4f6fb`, safe-area aware, reduced-motion respected everywhere.

### Chats tab

- **/ — Home (chat list).** Two-pane shell: list is full-screen on mobile, 360px persistent sidebar on desktop with an idle "it's quiet in here" placeholder pane (doodle + Invite a friend CTA). Elements: topbar (app name, 🆘 Rescue button, 🎭 anonymous inbox link, invite button, friend-requests button w/ dot → requests sheet, new-chat pencil (desktop), settings gear), offline/error banner, **stories strip** (avatar rings, unviewed-glow first, + add-story composer w/ image edit + text/doodle canvas → full-screen story viewer), dismissible "What's new" card, conversation rows (static avatar + presence dot, title w/ 📣 channel / 👻 ghost / 🛟 support badges, time, snippet, unread badge), empty state (doodle, Invite + Start-a-chat), FAB "+" → /new.
- **/c/[id] — Conversation.** Desktop keeps the list sidebar; supports `?call=` auto-join deep link. Elements: header (back, animated avatar, styled/animated name → profile link, mood chip, presence/typing subline, audio+video call buttons w/ "Join call" chip, ⏳ disappearing-TTL chip, gear → chat-settings sheet); contextual banners: sparked-beacon plan header, roulette countdown + KEEP banner, pinned-messages bar (tap cycles + jumps), 🍻 drunk banner, 🌐 public-group banner, 👻 mask identity banner; message scroll over personal theme/wallpaper or custom image/video background + ambient mood rain; bubbles: text w/ mentions, images/video, voice notes w/ waveform, doodles, polls (inline voting), tic-tac-toe boards, vibe checks, puzzle-result cards, link preview cards, replies (tap to jump+flash), forwards, edits/tombstones, emoji + avatar-stamp reactions, sent/delivered/read ticks, seen-by sheet, 10s undo pill on own sends; typing indicator; jump-to-bottom; **composer** (plus-menu: ✏️ Doodle, 🎭 Vibe check, 🎮 Tic-tac-toe, 🧩 Daily puzzle, 📍 Join me here, 🕑 Schedule send; emoji picker, file attach w/ image-edit sheet, hold-to-record voice, @mention autocomplete, reply draft chip, scheduled-queue badge → drawer; channels show read-only notice for non-admins). Sheets/overlays: forward picker, chat info (theme palette, wallpaper, custom background, nicknames, disappearing TTL, members/roles, mute, invite), watch-together, schedule, seen-by, TTT challenge, media lightbox, report. Drunk-mode cold-contact "you sure?" confirm.
- **/new — New conversation.** Topbar w/ back; segmented mode buttons (Direct message / Group / Channel); user search w/ result rows; group: name field, member chips w/ remove, counter (cap 256), create button; channel: name field, broadcast explainer, create button.
- **/anon — Anonymous inbox.** Topbar (back, 🎭 title); thread rows (server-blurred mystery avatar or real avatar after reveal, role-aware title, snippet, time); 👻 empty-state card explaining the reveal game.
- **/anon/[id] — Anonymous thread.** Single reveal-game thread view (messages + reveal mechanics: timer / riddle / tell-them).
- **/compose — Share to… (share-target).** Topbar (back, title, Discard); shared-content line, offline-queued note, conversation picker rows (avatar, title, snippet, checkmark), full composer pre-filled with shared text/URL/attachments/preview; expired/empty share card w/ "Go to chats".
- **/puzzle — Daily word puzzle.** Topbar (back, 🧩 title); 5-letter guess grid, result card ("Solved in n/6"), on-screen QWERTY keyboard w/ letter states + backspace; "Friends who shared today" list (names, never ranked); share sheet (no-spoiler emoji grid → pick a chat).
- **/things — Feature directory.** Topbar (back, "✨ Things you can do"); search input; one card per feature (title, "new" badge, one-liner, Try-it deep-link button); no-match empty line.

### Local tab

- **/local — Local.** Topbar (Local title + 🆘 Rescue button → rescue sheet); kudos banner; **beacon strip** (live plan cards: vibe emoji, creator + joiner avatar pile, "needs N more 🔥" faces-not-counts, countdown, "IT'S ON" sparked state → plan group; create/detail/edit sheets w/ location picker, icebreaker, venue poll); **Bored Together discovery section** (60-min opt-in moment, stranger cards w/ vibe + note, wave button, encouragement line, roulette join/leave banner); **board** (filter chip row: All / 🔥 Plans / Mine / gig / ride / room / place-review, search input, listing cards w/ avatar, kind emoji, expiry, star ratings; listing create/detail/edit sheets, contact→DM, team-up sheet, review sheet + trust stars); floating "I'm bored" button → beacon create sheet. Supports `?l=` listing deep link.
- **/plans — redirect → /local** (legacy tab).

### Feed tab

- **/feed — Feed.** Topbar (Feed title); **Friends | Discover lane toggle** (radiogroup); **post composer card** (follows lane: kind picker text / poll / game / join-card, body textarea, poll question + options, cross-post reference picker, multi-image attach w/ edit/remove, audience + location chips); post cards (author chip w/ styled name + mood, body, image grid, inline poll voting w/ option tallies, open game challenge claim, live join cards, location chip, face-pile reactions — names not counts, copy-public-link button, ⋯ options menu: delete/report/share); comment thread per post (image/GIF comment attach, comment reactions, delete); finite end: "You're all caught up" end card — no infinite scroll, no pull-to-refresh.

### Profile tab

- **/settings/profile — Profile & settings (tab root; /settings redirects here).** Topbar (back, title, Devices link). Sections: **Avatar** (upload incl. GIF→animated, image-edit/crop sheet); **Details** (display name, bio, area, animated name-style picker, animated-avatars motion setting); **Mood** (current mood chip + set/change → mood sheet w/ fade timer); profile editor (interest chips, 💼 work / ✨ skills entries, 3-GIF strip picker); **Friends** (Connections card → /connections, 🆘 Rescue contacts card, 🖼 My gallery card, ✨ Things-you-can-do card); **Notifications** (push toggle w/ ON/OFF/Blocked states + call self-test link); **Privacy & safety** (links to Security, Privacy, Blocked); **Help** (→ /settings/help); **Account** (@username + email, Sign out).
- **/settings/privacy — Privacy.** Back topbar; radio/select groups per server-enforced setting: Receipts & presence (reciprocal read receipts, last-seen: everyone / chat partners / nobody, typing), Invites & groups (who can invite / add to groups), Beacons (friends / my area / public), Moods & effects, Activity on profile (per-kind: anyone / connections / only me), Anonymous & nudges (nobody / connections / everyone), Safety.
- **/settings/security — Security.** Passkeys list (add, rename, delete, last-used; cap), two-factor TOTP (enable w/ QR+code, disable), recovery codes (status, regenerate, shown once), "approve a laptop" 6-char code entry (QR-less cross-device login), link to Devices/sessions.
- **/settings/sessions — Devices.** Session rows (device/browser metadata, times, current marker) with revoke buttons; revoke-all; doubles as the device registry.
- **/settings/blocked — Blocked people.** Blocked user rows (avatar, name) + Unblock; story-canvas bans list + unban. No timestamps.
- **/settings/calls — Call self-test.** Explainer, Run button, check rows with ✓/!/× verdicts (secure context, mic/cam permission, server config, TURN relay reachability), plain-words worst-finding summary.
- **/settings/help — Help & feedback.** Category picker (🐞 bug / ❓ question / 💡 idea / ⚠️ safety), message textarea, optional screenshot attach, submit → support ticket; my-tickets list; replies arrive in the 🛟 "Bored Chat Support" chat.
- **/connections — Friends.** Back topbar; Requests section (Accept/Decline), Friends section (avatar → profile, Message, Remove w/ confirm; empty-state explainer), Sent section (Cancel); dismissible people-you-may-know suggestion cards + "more" → /people; footnote defining "friends".
- **/people — Find people.** Title + ↻ Refresh; narrowing filter chips (👥 mutuals / 💬 shared groups / 📍 my area / ✨ interests); suggestion card grid (connect + permanent dismiss); honest empty state; cross-link to Local.
- **/gallery — My gallery (private).** Title + explainer; filter chips (All / 📷 Photos / 🎞 Videos / ⭐ Saved stories); thumbnail grid (video ▶ and ⭐ badges, 🗑 delete on saved items); tap → pinch-zoom photo lightbox or full-screen video player; Load more; empty-state card.
- **/u/[username] — Public profile.** Topbar (back, ⋯ menu: Block / Report — or Edit on own profile); hero card (tap-to-zoom animated avatar, animated styled name, @username, mood chip w/ own-fade-time, online/last-seen); action card (Connect / Requested / Accept / ✓ Friends states, Message, 👻 Send anonymously → anon sheet); 3-GIF strip; bio card; "Into" interest chips; 💼 Work / ✨ Skills entries; recent-activity strip (viewer-resolved); marketplace trust panel (listing reviews, never ranked); private plan-karma line (own profile only). Blocked view = dead-end card.
- **/welcome — Find your people (post-signup, once).** Topbar w/ Skip; mascot explainer card; area input + save; people-you-may-know suggestion cards; "Done — take me in" CTA.

### Auth (logged out; animated AuthScene: living gradient, pointer-reactive mesh, floating blobs, rotating taglines, 3D-tilting frosted card, logo party-mode easter egg, reactive mascot)

- **/login.** Modes within one card: password form (username/email w/ passkey autofill, password w/ show-hide + mascot cover/peek, Sign in), "or" row → 🔑 passkey sign-in, 📱 log in with phone (QR + short display code, polling), two-factor code step, "Lost everything?" recovery-code form, new-password form; links to Register; `?next=` aware.
- **/register.** Join-the-fun form (username, display name, email, password), carries invite token, confetti on success → recovery-codes save screen → /welcome.
- **/link/[code] — Approve a laptop (phone side).** Opened by QR scan or typed code; auth-gated; consent sheet showing requesting browser/OS + network hint, countdown, Approve/Deny.

### Share & public (unauthenticated, SSR, OG/unfurl metadata)

- **/join/[token] — Invite landing.** AuthScene backdrop; inviter's big animated avatar + waving mascot; headline + Join/Accept (signed-in) or Create-an-account / Log-in (signed-out, token carried through); friendly error cards (expired / exhausted / revoked / own link / group full).
- **/p/[token] — Public share page.** Renders any share variant for strangers: post, beacon, listing, group card, live public group (paged messages w/ cursor); author chips (avatar, display name, @username), media grid, story doodle/text/emoji overlays; every interaction gates to /register?next=…; report link.
- **/s/[token] — Story share page.** Same machinery for author-minted, revocable story links (image/video + canvas overlays); dead links 404 identically.
- **/share (POST route, no UI).** PWA share-target receiver → /compose (logged in) or login + stash.
- **/share/claim/[id].** Headless claim screen promoting a logged-out share stash after login → /compose; error card w/ link home.

### Admin (desktop-oriented operator console; hidden — non-admins see "This page does not exist")

Shared layout: header "Bored Chat *operator*" badge, horizontal section nav (Overview / Users / Reports / Content / Support / Logs / Settings / Authentication), "← app" link.

- **/admin — Overview.** Update-available banner (dev/update/up-to-date states); stat tiles (users, messages, open reports, storage); 30-day bar-chart series (registrations, active users, messages) + DAU-is-a-proxy note.
- **/admin/users.** Search input; table (user, joined, coarse last-seen, reg. IP, last session, sessions, storage, flags, actions); Suspend/Unsuspend, Ban/Unban, Export buttons; Load more.
- **/admin/reports.** Status filter chips; report rows (metadata-only target preview, reporter's reason text, consented context slice); note field + close actions.
- **/admin/content.** Public-surfaces-only moderation: type filter chips (posts / beacons / listings), search, row excerpts, takedown w/ required reason (author gets one neutral Support notice).
- **/admin/support.** Status filter chips; ticket rows (category, user, body, screenshot); dialogue view + reply box (replies sent as the brand, never a named admin).
- **/admin/logs.** Level filter chips (warn / error / admin audit trail); newest-first log ring tail; load more.
- **/admin/settings.** Invite-links on/off switch card; read-only TURN relay status card.
- **/admin/auth.** SMTP config block + test-send; four auth feature toggles (incl. email codes), visible-but-inert behind "needs SMTP" note; text-message codes section.

## 4. Overlays, sheets & global components


Base dir: `/home/user/SOCIAL-/apps/web/components/` (styles live in sibling `*.module.css`; shared helpers in `/home/user/SOCIAL-/apps/web/lib/`). All sheets/overlays render through `Portal.tsx` into `document.body`.

### Infrastructure / shells
| Component | What it is / when it appears |
|---|---|
| `Portal.tsx` | Overlay portal into `document.body`; every sheet/backdrop renders through it (fixes `position:fixed`-inside-transform clipping). |
| `GlobalOverlays.tsx` | Mounted once in AppShell so overlays work on every page: incoming-call overlay + in-call screen, mutual-wave match moment, roulette navigation/goodbye screen, pending expectation-feedback sheet, and the Toast host. |
| `Tabs.tsx` | App tab shell: Chats / Local / Feed / Profile. Bottom bar on mobile, slim left rail ≥900px; hides on mobile while a chat is open; carries `data-tour` anchors for the spotlight tour. |
| `TabPage.tsx` | Shell for non-chat tabs: the Tabs bar around one scrolling pane. |
| `TwoPane.tsx` | WhatsApp-Web-style shell for `/` + `/c/:id`: list fullscreen on mobile; ≥900px a persistent 360px sidebar + open chat. |
| `Toast.tsx` + `lib/toast.ts` | THE one toast surface: bottom-anchored above the tab bar (z 80), auto-dismissing, tap-to-dismiss, `role="status"`. Confirmations of the user's OWN actions only (posted, copied, saved, report sent) — never incoming-event notifications. `toast(text, ttl?)` is the only entry point. |
| `Avatar.tsx` | Avatar renderer (photo or initial). `animated` only on profile pages + open chat header (lists/bubbles/search stay static); renders a ghost-mask emoji instead of a photo when the UserLite is a mask. |
| `Mascot.tsx` | The "Bored Blob" auth-page mascot: pure SVG/CSS state machine — idle/watch (pointer-tracked eyes, blinks, yawns when bored), cover (hands over eyes on password focus), plus celebrate/error states. |

### Sheets (bottom sheets / modals)
| Sheet | When it appears / what it does |
|---|---|
| `AnonSendSheet.tsx` | "Send anonymously" from a profile — opens/continues your anon thread with a first message; all refusals are one indistinguishable 404. |
| `BeaconCreateSheet.tsx` | "I'm bored" → create a beacon: vibe chips, time-window presets as countdown previews, audience, group-size stepper; no waiting state after submit. |
| `BeaconDetailSheet.tsx` | Tap a beacon card: full card, "Who's in" faces, join/leave, creator tools (Edit, "Start with whoever's here", Take it down), report. |
| `BeaconEditSheet.tsx` | Creator edits an open beacon; sends only changed fields; lowering threshold to current joiners sparks the plan (warned in-sheet). |
| `ChannelMembersSheet.tsx` | Owner/admin channel member management: paged username-ordered list + prefix search, promote/demote/remove; deliberately no member count. |
| `ChatInfoSheet.tsx` | Chat settings: personal appearance (theme palette, wallpaper, per-member nicknames — "my view only") + disappearing-message TTL; hosts `GroupSettingsSection` (group visibility mode, description, join-request queue, share link, ghost masks). |
| `ConnectionRequestsSheet.tsx` | Pending connection requests; accept pings the requester, decline silently deletes. |
| `DoodleSheet.tsx` | Full-screen doodle canvas (4 colors, eraser, undo) → sends as a PNG image message (`metadata.doodle`). |
| `DrunkConfirmSheet.tsx` | Client-side "you sure?" interposed while drunk mode is live, before cold/new DMs and any public write. |
| `ForwardSheet.tsx` | Forward a message to up to N conversations (multi-pick, all-or-nothing); original author rides `metadata.forwarded_from`. |
| `ImageEditSheet.tsx` | Edit-before-upload: crop (drag + corner handles), rotate 90°, aspect presets; pure canvas; static images only. |
| `InviteSheet.tsx` | Invite link: reuses the newest open invite or mints one; copy + native share. |
| `ListingCreateSheet.tsx` | Post to the local board: kind picker → per-kind form; prices are display text only; room photos via the normal upload pipeline. |
| `ListingDetailSheet.tsx` | Listing detail: safety note on gig/ride/room; one CTA "Message <author>" → DM; author gets close/delete + gig team-up. |
| `ListingEditSheet.tsx` | Author edits an active listing; kind + area immutable; details fully revalidated. |
| `MoodSheet.tsx` | Mood picker: preset chips, custom emoji+word, swing mode (rotating), drunk mode (guardrailed, defaults connections-only); ~4h auto-expiry, fade time shown owner-only. |
| `ReportSheet.tsx` | Report anything (one short reason). Message reports have an unchecked include-context consent checkbox; anon/canvas reports say real identity is attached. |
| `RescueSheet.tsx` | "Rescue me": ping up to 3 friends to call you out of a boring situation; urgent push that beats mute (never blocks); 3/day cap. |
| `ReviewSheet.tsx` | Person review after a real listing contact; one per (listing, reviewer); subject never pinged. |
| `ScheduleSheet.tsx` | Scheduled sends + time capsules: preset chips + custom picker; capsule seals delivery in an envelope bubble. |
| `ScheduledDrawer.tsx` | Drawer of my pending scheduled messages for this conversation with one-tap cancel; invisible to others. |
| `SeenBySheet.tsx` | Seen-by: faces + names ordered by username, NO timestamps; explains the reciprocity 403 when your own receipts are off. |
| `TeamUpSheet.tsx` | Gig author picks up to N contacters → server creates the team-up group (one per listing). |
| `TttChallengeSheet.tsx` | Group tic-tac-toe: pick an opponent among active members (skipped in DMs). |
| `VibeCheckSheet.tsx` | Vibe-check composer: pick a rotating prompt or write your own → sends a `vibe_check` message. |
| `WatchTogetherSheet.tsx` | Synced YouTube watch-together (youtube-nocookie iframe); host's play/pause/seek drives everyone via `watch.sync` frames. |

### Overlays / viewers
| Component | When it appears / what it does |
|---|---|
| `CallOverlay.tsx` | All of calls: incoming-ring overlay (anywhere), full in-call screen (local preview, remote mesh grid, mute/camera/flip/end, TURN honesty banner), draggable floating pill (timer, mute, hang-up, PiP) and the ended-call card. Media state lives in `lib/webrtc.ts` and survives navigation. |
| `EffectOverlay.tsx` | One-shot full-screen message effect, played exactly once per viewer (claim via `lib/effects`); never under reduced-motion (static badge instead); no sound. |
| `MediaLightbox.tsx` | Full-screen pinch-zoom media viewer: pinch + pan, wheel zoom, double-tap 1x/2.5x, Esc/backdrop/✕ to close; unmounts when closed. |
| `StoryViewer.tsx` | Full-screen stories: tap-through within an author, tap (never auto) between authors, hold to pause; own stories get the viewers sheet (no timestamps). Pairs with `StoryCanvas.tsx` (attributed vector overlay layers, never rasterized) and `StoriesStrip.tsx` (avatar-ring tray, username-ordered, finite). |

### Pickers / onboarding / one-time surfaces
| Component | When it appears / what it does |
|---|---|
| `LocationPicker.tsx` | THE one location picker + chip set (posts, beacons, listings, chat "Join me here"): `{label, lat?, lng?}`, coords are explicit one-tap snapshots; map opens in the user's own map app via links — no tiles/SDKs/keys. |
| `ReactionPicker.tsx` | Quick-react popover above a bubble: avatar STAMP first (react with your face, one per user/message), six common emoji, "+" expands to the ~40-emoji static grid. |
| `VibePicker.tsx` | Beacon vibe picker: preset grid + "Custom" (emoji grid + one-word label); recents are localStorage-only. |
| `SpotlightTour.tsx` | First-run spotlight tour, once per device (localStorage), skippable every step; anchors to tabs via `[data-tour]`; reduced motion = plain cards. |
| `PushExplainer.tsx` | One-time post-login push explainer (Enable now / Not now); only when permission is `default`, no sub, never seen on this device; never re-nags. |
| `WhatsNewCard.tsx` | "New since your last visit" dismissible card stack on the chat list after login; no badges, no re-surfacing. |

### Message / chat building blocks
| Component | Role |
|---|---|
| `ChatView.tsx` | The chat screen. Internal pieces: `MessageRow` (the bubble: body, attachments, reactions row, reply quote, long-press 420ms → `MessageActionsOverlay` for react/reply/forward/pin/edit/delete/report, swipe-right 64px to reply), `UndoPillRow` (delete undo), `LocationDrop` ("Join me here" bubble), `MentionedBody` (@mention highlighting), `CallHeaderButtons`, jump-to-message paging. |
| `Composer.tsx` | The composer: text input (16px+, "Message"), "+" menu (poll, doodle, vibe check, game, location drop, watch together…), emoji popover, file attach, pre-send attachment chips with Edit image / Remove, hold-to-record voice note (slide-to-cancel 72px), send button with hold-to-schedule (450ms → ScheduleSheet), effect suggestion + armed-effect chip, @-mention autocomplete listbox, scheduled-count pill (opens ScheduledDrawer), link-preview debounce → `PreviewCard`. |
| `AttachmentView.tsx` | Renders a message's attachments: image/video with blurhash placeholder + aspect box → MediaLightbox; audio → AudioBubble; generic file chip (ext badge + size). |
| `AudioBubble.tsx` | Voice-note bubble: 48-bucket waveform scrubber inlined on the DTO, duration label, 1×/1.5×/2× speed, never autoplays. |
| `BlurhashCanvas.tsx` | Blurhash placeholder canvas behind loading media. |
| `Ticks.tsx` | Sender-side delivered/read ticks, derived locally from participant watermarks vs `message.seq`. |
| `SeenBySheet.tsx` | The receipts detail surface (see Sheets): faces, no timestamps. |
| `TypingIndicator.tsx` | "X is typing" from ephemeral WS signals; self-expires ~6s, no stop event. |
| `PreviewCard.tsx` | Link-preview card: dismissible inside the composer, clickable inside a bubble. |
| `PinnedBar.tsx` | Pinned-messages bar at chat top; tap cycles pins and jumps to each. |
| `ChatBackground.tsx` | Personal GIF/video chat background behind the scroll under a legibility scrim; muted/looped; paused off-screen + low battery; static under reduced motion. |
| `PollView.tsx` | Poll bubble: live bars with counts only (never voter names); tap to vote / re-tap to unvote. |
| `GameTttView.tsx` | Tic-tac-toe bubble; state lives in `metadata.game`, moves server-validated; no win tallies. |
| `PuzzleResultView.tsx` | Daily-puzzle share bubble: server-built spoiler-free score grid. |
| `VibeCheckView.tsx` | Vibe-check bubble: prompt card + growing collage of reply refs + reply CTA (one reply per user). |
| `RouletteBanner.tsx` | Provisional roulette-DM countdown + KEEP button at chat top (5-min window, both must keep; other party's state never shown). |
| `DrunkBanner.tsx` | Soft "they're in drunk mode" banner with "Check on them 💙" preset/call; passive render of the server-resolved chip. |
| `PlanHeader.tsx` | Sparked-plan group header: countdown, named micro-roles with done states, "make it a ritual" counter (counts up only). |
| `AfterglowCard.tsx` | Post-plan recap riding a system message: faces, photos, "Run it back", one-time private kudos prompt. |
| `ListingReviewNudge.tsx` | One-time inline, dismissible nudge in listing DMs after close/expiry; "not now" remembered per device forever. |
| `MoodChip.tsx` | Server-resolved mood chip next to names (drunk wobbles, swing morphs; static under reduced motion). |
| `StyledName.tsx` | Animated display names — profile pages, chat headers, group sender names only; pure CSS, legibility-first. |

### Notes for the design pass
- Binding constraints from `docs/PSYCHOLOGY.md`: no public counts/scores, no seen-at timestamps, finite feeds, no auto-advance, no re-nags; reduced-motion always gets a full static replacement.
- Every sheet: portal to body, `max-height` + internal scroll + safe-area/tab-bar padding, inputs ≥16px; hidden overlays use `display:none`/`pointer-events:none`, never `opacity:0`.
- Verified at 390x844 and 360x740 phone widths plus desktop; z-scale lives in `globals.css` (toast layer = 80).

## 5. Current design system (tokens & conventions)


Sources: `/home/user/SOCIAL-/apps/web/app/globals.css`, `/home/user/SOCIAL-/apps/web/components/*.module.css` (18 modules), themes/wallpapers in `/home/user/SOCIAL-/apps/web/components/expression.module.css`, lists in `/home/user/SOCIAL-/packages/shared/src/constants.ts`.

Identity: "hand-rolled, mobile-first, dark-first". "Bored Blob" design language: soft radii, playful pops/bounce easings, warm yellow for boredom, strict reduced-motion guards.

### 1. Color tokens (`:root` in globals.css)

| Token | Dark (default) | Light (`@media (prefers-color-scheme: light)`) |
|---|---|---|
| `--bg` | `#0b0e14` | `#f4f6fb` |
| `--panel` | `#131826` | `#ffffff` |
| `--panel-2` | `#1a2134` | `#eef1f8` |
| `--border` | `#242d44` | `#d9dfec` |
| `--text` | `#e8ecf4` | `#17202f` |
| `--muted` | `#8b94ab` | `#5e6a81` |
| `--accent` | `#6f8cff` | `#3d5ef0` |
| `--accent-strong` | `#4f6fff` | `#2946d8` |
| `--accent-soft` | `rgba(111,140,255,.16)` | `rgba(61,94,240,.12)` |
| `--danger` | `#ff6b6b` | `#d64545` |
| `--ok` | `#4cd4a0` | `#16906a` |
| `--bubble-in` | `#1c2437` | `#e8ecf5` |
| `--bubble-out` | `#2c3f8f` | `#d7e0ff` |
| `--shadow` | `0 8px 28px rgba(0,0,0,.35)` | `0 8px 24px rgba(23,32,47,.12)` |
| `--radius` | `14px` | (same) |

Dark/light handling: pure OS-driven via `prefers-color-scheme` + `color-scheme: dark|light`. **No manual theme toggle, no `data-theme` attribute.** Everything else derives from tokens, often via `color-mix(in srgb, …)` (used heavily: translucent topbar `color-mix(in srgb, var(--bg) 88%, transparent)`, tinted borders, wallpaper tints).

Secondary "Bored" palette (scoped class `.beaconVars` in beacons.module.css — beacons/plans/FAB): `--bored-yellow: #ffd166`, `--bored-yellow-deep: #f4b83f` (light: `#efae2f`), `--bored-ink: #3b2d07`, `--fire: #ff9d5c` (light `#e07a35`). Warn text (globals): `#ffd166`. Rainbow name gradient stops: `#ff6b6b #f7b955 #4cd4a0 #6f8cff #b36bff`. Doodle paper: `#fffdf5` with 2.5px `var(--text)` sketchy border (`border-radius: 255px 18px 225px 18px / 18px 225px 18px 255px`, rotate −0.6deg).

### 2. Typography
- Font stack: `system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif` — **no webfonts anywhere** (self-hosted ethos).
- Body 15px / line-height 1.45, antialiased. Page h1 (topbar) 17px; chat header h1 16px; auth h1 20px; sheet h2 18px; settings section h2 14px uppercase, letter-spacing .06em, muted.
- Micro sizes in constant use: 10.5–13.5px (meta 10.5px, badges 12px, labels 13px, `.small` 12.5px).
- **All form controls ≥16px font** (iOS Safari zoom-stick rule) even though body is 15px.
- Focus: global `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }` (keyboard only).

### 3. Radius & shadow scale (by convention, mostly literal)
- `--radius:14px` = card default. Observed ladder: 6px (small nubs/focus), 8px, 10px (buttons, inputs, media boxes), 12px (composer, tabs, menus, tiles), 13–14px (cards, pickers, popovers), 16px (chat bubbles, canvases), 22px (bottom sheets, top corners only on mobile), `999px` pill (chips, toasts, badges, FAB, system messages), 50% circles (avatars, dots).
- Shadow: single token `var(--shadow)`; FAB adds glow `0 10px 26px rgba(244,184,63,.35)`.

### 4. Buttons (globals.css)
- `.btn` — base: inline-flex, gap 6px, `1px solid var(--border)`, bg `var(--panel-2)`, text color, radius 10px, padding 9px 14px, 14px font, `transition: filter 120ms`; hover `brightness(1.1)`; disabled opacity .55.
- `.btn-primary` — bg+border `var(--accent-strong)`, white text.
- `.btn-danger` — **outline style**: text `var(--danger)`, border `color-mix(in srgb, var(--danger) 45%, var(--border))` (not filled).
- `.btn-ghost` — transparent bg + border.
- `.btn-icon` — padding 8px, line-height 0.
- FAB pattern (`.boredBtn`): pill, yellow gradient `linear-gradient(145deg, var(--bored-yellow), var(--bored-yellow-deep))`, ink text, 700 weight, idle wobble animation (5.2s), `:active { scale(0.95) }`.

### 5. Inputs / forms
- `.field`: column, gap 5px, margin-bottom 14px; label 13px muted.
- `.input` (also `textarea.input`, `select.input`): bg `var(--panel-2)`, 1px border, radius 10px, padding 10px 12px, `font-family: inherit` (Chromium textarea monospace fix), **font-size 16px**, focus = `border-color: var(--accent)` + ring `box-shadow: 0 0 0 3px var(--accent-soft)`.
- Chat composer textarea: radius 12px, min-height 40px / max-height 120px, `min-width: 0` (390px overflow guard), 16px font.
- Status text: `.error-text` danger 13px, `.ok-text` ok, `.warn-text #ffd166`.

### 6. Cards, chips, badges, avatars
- `.card`: `var(--panel)` + 1px border + `var(--radius)` + 20px padding. `.auth-card` adds max-width 380px + shadow.
- `.chip`: pill, `var(--accent-soft)` bg, padding 4px 10px, 13px. Reaction chip: `var(--panel-2)` + border pill; own reaction = `accent-soft` bg + accent border; carries a 16px face pile of the first `MESSAGE_REACTORS_PREVIEW_MAX` reactors plus a "+" when `has_more` — faces, never a count (PSYCHOLOGY rule 3), like stamps below; each face pops in on mount.
- `.badge` (unread): min 20px pill, `var(--accent-strong)` bg, white 12px/600.
- `.avatar`: circle, `accent-soft` bg + accent initial, 600 weight; `.presence-dot` 10px circle, `--ok` when online, 2px panel ring. Reaction "stamps" = piled avatar faces (−6px overlap, 2px `var(--bg)` ring) — faces, never counters (PSYCHOLOGY rule).
- Ticks: muted → `var(--accent)` when read.
- Dashed-border = "personal/opt-in" affordance (`.personalTag`, capsule toggle, effect chip: `1.5px dashed var(--accent)`).

### 7. Sheets, popovers, toasts (overlay kit)
- **Z ladder (documented in globals.css header):** 10 sticky topbars · 15 FABs · 20 tab bar · 30 menu backdrops / 31 popovers · 40 modal sheets+backdrops · 55 watch dock · 60 full-screen viewers/effects · 69 minimized call pill · 70 in-call / 71 incoming ring · 72 match-moment · 80 toasts. **All overlays portal to `<body>`** (components/Portal.tsx) — `position:fixed` breaks inside the blurred topbar or any transformed ancestor.
- Bottom sheet (canonical: beacons.module.css `.sheetBackdrop`/`.sheet`; invite/watch have twins): backdrop `rgba(0,0,0,.45)` fade-in 160ms, sheet bottom-anchored, `max-width 480px`, `max-height calc(100dvh - 24px)`, internal scroll, bg panel + border, radius `22px 22px 0 0`, padding `18px 18px calc(18px + env(safe-area-inset-bottom))`, rise animation 230ms `cubic-bezier(0.2,0.9,0.3,1.05)`; sticky `.sheetHead` pins inside the scrollport (negative-margin trick). **≥600px: sheet centers as a modal, radius 22px all corners.**
- Popovers (reaction picker, msg menu, composer emoji, plus-menu): panel bg, border, radius 12–14px, `var(--shadow)`, `picker-pop` 160ms `cubic-bezier(0.2,0.9,0.3,1.2)`, transform-origin at anchored corner, z 31.
- Toasts: fixed, bottom `calc(76px + safe-area)` (above tab bar), z 80, pill, panel bg, 13.5px/600, `toast-in` 200ms rise.
- Topbar: sticky, `backdrop-filter: blur(10px)`, 88% bg translucency, bottom border; title ellipsizes, trailing actions `flex:none`.

### 8. Animation conventions
- Signature easing: overshoot cubic-beziers `cubic-bezier(0.2, 0.9, 0.3, 1.05–1.35)` for every pop/rise ("playful pop"). Micro transitions 100–140ms ease; entrance anims 160–260ms; ambient loops (wobble, capsule-bob, mic-pulse) 1.1–5.2s.
- Message entrance `msg-in` 240ms (new arrivals only — history renders instantly, gated by created_at > mount).
- ~68 keyframes total (stamp-in, chip-pop, sheet-rise, fx-fall/rise/burst confetti, mascot breathe/wave/dance, name-glow/shimmer/rainbow, ring-glow, toast-in…).
- **Reduced-motion is a hard contract**: every module ends with a `@media (prefers-reduced-motion: reduce)` block that sets `animation: none` / `transition: none`; motion is *replaced*, never removed (effect badge stays as static marker, shimmer freezes to a tinted first frame, animated chat backgrounds render the static poster instead — enforced in ChatBackground.tsx via `useReducedMotion`).

### 9. Chat themes & wallpapers (personal-only, per conversation)
`CHAT_THEMES` (packages/shared/src/constants.ts): `classic, sunset, ocean, forest, grape, bubblegum, mono, midnight`. Implemented as `.theme_*` classes on MY chat page only (expression.module.css) that override 4 tokens (midnight also overrides `--bubble-in`):

| Theme | Dark: accent / strong / bubble-out | Light: accent / strong / bubble-out |
|---|---|---|
| classic | `#6f8cff / #4f6fff / #2c3f8f` | `#3d5ef0 / #2946d8 / #d7e0ff` |
| sunset | `#ff8a63 / #e8603a / #8f3b2c` | `#d85a2f / #c04e26 / #ffd9c7` |
| ocean | `#4fc3e8 / #2596c4 / #14537a` | `#1577a8 / #0f6490 / #cdeafb` |
| forest | `#58d08f / #2f9e5f / #1f6b43` | `#1f7f4a / #176b3d / #d2f0dd` |
| grape | `#b08ae8 / #8d5bd4 / #5b3a96` | `#7444c0 / #6338ab / #e6dafa` |
| bubblegum | `#f48ebd / #e2639c / #93396b` | `#d44487 / #bb3a76 / #fcd9ea` |
| mono | `#9aa4b5 / #6b7687 / #3a4150` | `#4b5563 / #374151 / #dfe3ea` |
| midnight | `#7d95ff / #5570e8 / #1b2440` (+bubble-in `#11182b`) | `#33448c / #273771 / #c9d4f5` (+bubble-in `#e8ecf5`) |

(`--accent-soft` per theme = accent at .16 alpha dark / .12 light.)

`CHAT_WALLPAPERS`: `dots, grid, waves, stars, scribbles, blobs` — pure CSS patterns (`.wp_*`), tinted from the active accent via `color-mix` (7–36% alpha), so they follow theme + color scheme; static by construction; `.wpPreview` has a denser star tiling for 34px swatches. Separate v0.8a feature: uploaded GIF/video chat background behind the scroll under a scrim at `CHAT_BG_OVERLAY_OPACITY = 0.45`; paused off-screen/low battery; poster under reduced motion.

Chat bubbles: max-width `min(78%, 480px)` column; radius 16px with 6px "tail" corner (bottom-left incoming / bottom-right outgoing); incoming `--bubble-in`, outgoing `--bubble-out`; meta 10.5px floated right; system messages = centered muted pill on `--panel-2`.

### 10. Safe-area handling
`env(safe-area-inset-*)` added everywhere via `calc()`: topbar/chat header top (+10px/+8px), topbar left/right, tab bar bottom (+4px), composer bottom (+8px), sheets bottom (+14–28px), toasts bottom (+76px), FABs bottom (+14px), fullscreen viewers/image editor all edges, call controls (+18–22px), desktop rail top. Heights always use `100dvh` (never `100vh`).

### 11. Breakpoints & two-pane desktop
- Content column: `.page` max-width **680px** centered (chat page likewise 680px).
- **900px** is THE breakpoint: below = mobile (bottom `.tabbar`, one pane at a time, `/` list vs `/c/:id` chat, tab bar hidden while a chat is open); at `min-width: 900px` the `.shell` flips to a row — tab bar becomes a **72px left vertical rail** (order −1), `.split-side` list pane fixed **360px** with right border, `.split-main` chat fills the rest on tinted bg `color-mix(in srgb, var(--panel) 35%, var(--bg))` (WhatsApp-Web style), back button hidden, `.idle-pane` placeholder when no chat open, chat `max-width: none`, scroll padding grows 12px→16/24px.
- **600px**: bottom sheets become centered modals.
- Other defenses: `overflow-x: hidden` guards on chat page/scroll, `min-width: 0` on every flex text column, ellipsis truncation convention, `@media (hover: none)` hides the hover react button (touch uses long-press).

### 12. Misc patterns worth carrying over
- Spinner: 18px circle, border-top accent, 0.8s linear (none under reduced motion).
- Banners: `.offline-banner` accent-soft strip; `.error-banner` solid danger; pill retry button with `currentColor` border.
- Gallery grid: `repeat(auto-fill, minmax(104px,1fr))`, gap 6px, square cells radius 10px, `cursor: zoom-in`.
- Swatch picker (themes): 4-col grid, `.swatchOn` = accent border + accent-soft bg; swatch dot 24px circle ringed by panel+border.
- Link preview card: 3px accent left border; file row: 34px uppercase extension tile in accent-soft.
- Mascot ("Bored Blob", mascot.module.css): CSS-built character with ambient loops (look-around, breathe, happy-bounce, arm-wave/dance, head-shake, yawn) — the brand's personality layer, also fully reduced-motion-guarded.
- Hard product constraints that bind any redesign (docs/PSYCHOLOGY.md): no public numeric like-counts (named faces), no seen-at timestamps, finite feeds with hard end, no streaks/variable reward, overlays always portal to body, hidden overlays use `display:none`/`pointer-events:none` never bare `opacity:0`.

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
