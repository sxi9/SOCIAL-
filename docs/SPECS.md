# Bored Chat — Detailed Specs for Queued Releases

The full designs agreed with the owner, preserved verbatim-in-substance so any
future session can build them exactly as intended. Roadmap index:
`docs/FEATURES.md` (items 87-90b = v0.7.1, 72-81 = v0.8, 82-86 = v0.9).
Binding rules still apply from `docs/PSYCHOLOGY.md` and `CLAUDE.md`.

## v0.7.1 — Calls that just work

**Floating call (87):** connected call collapses to a draggable floating pill
(avatar, live timer, mute, hang-up) rendered via Portal above everything;
tap expands back to full screen; browser PiP for video where supported. The
app remains fully usable mid-call.

**Ring push (88):** incoming-call web push with Answer/Decline actions when
no socket is live; Answer deep-links into the call screen; respects mute and
blocks like all push; stops ringing the instant the call is handled anywhere.

**Connectivity UX (89):** call screen states say the truth — connecting /
connected / reconnecting (automatic ICE restart on drop) / failed WITH the
reason. Settings → Call self-test: mic+cam permission, secure context,
TURN reachability, candidate types found, verdict in plain words.

**TURN honesty (90):** when TURN_SECRET is unset or relay unreachable, the
CALLER sees "this server has no call relay — calls only work on the same
network" instead of silent failure. `./bored status` and admin surface TURN
state. Docs explain: laptop-behind-NAT + quick tunnel can never relay media
(tunnel is HTTP-only; coturn unreachable behind home NAT) — cross-network
calls require the VPS deploy or port forwarding. Same-WiFi and same-machine
calls work without TURN. Phones must open the app via HTTPS (the tunnel URL),
never a plain LAN IP — browsers block mic/cam on insecure origins.

**Toasts (90a):** ONE shared toast component (Portal, bottom-anchored above
the tab bar, auto-dismiss, reduced-motion safe). Every action without a
visible immediate result confirms itself: posted to board, beacon lit, invite
copied, settings saved, report sent, scheduled-for-<time>, kudos sent.

**Notifications-on (90b):** one-time post-login explainer prompt (what push
is for: messages, calls, sparked plans, wave nudges) with Enable now; never
re-nags after decline. Settings row shows ON / OFF / blocked-by-browser with
per-browser unblock steps. Ring-dependent features surface the OFF state
instead of failing silently.

## v0.8 — Identity, moods & community care

**Moods (72):** preset chips (😴 bored, 🎉 hyped, 💤 lazy, …) + custom
emoji+word; auto-expire after a few hours (always-current, never stale);
visibility everyone / connections / nobody. 🎢 SWING MODE: the chip
auto-cycles through chosen moods every ~30min/random with a morph animation.
Moods NEVER appear in activity history (no trace afterward).

**🍻 Drunk mode (73):** a mood with guardrails. Chip wobbles; visibility
defaults to CONNECTIONS-ONLY even if other moods are public (overridable).
While active: (a) 10-second undo window on every send; (b) "you sure?"
confirm before messaging anyone not talked to in >1 month and before public
posts; (c) others in a chat with the drunk user (who may see the mood) get a
soft banner — "🍻 X is in drunk mode — take tonight's messages lightly" —
with a "Check on them 💙" button (caring preset message / start call). A
passive banner, NEVER a push blast. Auto-sober on expiry, no trace, mascot
slightly concerned.

**Mood-reactive messages (74):** when a sender's mood is visible to the
viewer, their bubbles perform it — drunk: tipsy wobble-in, settle crooked,
straighten; sad: soft rain overlay in the chat + text falls into place;
hyped: bounce-in. Subtle-first (reading never blocked), per-viewer "mood
effects" toggle, reduced-motion disables all, only while the mood is active.

**Animated names (75):** profile setting Off / Glow / Shimmer / Rainbow /
Surprise-me (rotates daily). Renders on profile, chat headers, group message
sender names. Pure CSS text effects; reduced-motion viewers get a static
tint; legibility always wins.

**Activity strip + privacy (76):** profile shows recent activity (lit/sparked
beacons, posts, listings, puzzle/games). Settings → Privacy → Activity:
per-type toggle public/connections/private. HARD RULE: activity never leaks
past the underlying object's audience — a friends-only beacon never shows in
public activity regardless of the toggle; viewer must already be allowed to
see the thing itself.

**Anonymous reveal game (77):** recipient opt-in ("who can send me anonymous
messages": nobody / connections / everyone; DEFAULT connections). Sender is
anonymous to the RECIPIENT only, never the server; blocks apply invisibly;
rate-limited; text only at first. Recipient may Request reveal → sender picks:
TIMER (1h/6h/24h — recipient watches the sender's avatar un-blur
progressively until full reveal), RIDDLE (sender sets a question; sender taps
"that's right" on a satisfying answer → instant reveal), or reveal anytime.
Reporting an anonymous message ATTACHES the sender's identity to the report.

**Wave nudges (78a):** push/in-app "👀 Someone in the pool waved at you…" —
no identity. Sent only when the visible pool is large enough to keep the
waver anonymous (small-pool suppression); multiple waves batch into one per
opt-in hour; user-toggleable. Preserves the single-waves-are-invisible
no-rejection rule.

**Suggestions + find-your-people (78):** people-you-may-know (mutual
connections with count, same area, shared groups/plans) in Feed-Discover and
the connections page, dismissible. Post-signup "find your people" step
(area + mutuals). NEVER user cards on the login page (unauthenticated
enumeration of members is forbidden — the earlier decision stands).

**Discovery filters (78b):** filter Bored Together cards by area, shared
interests (profile tags), and a what-for vibe (opt-in gains optional vibe
chips). Filters only narrow on data people chose to share; no age/gender
fields exist.

**Canvas stories (79a):** per-story author mode: Just viewing / Open canvas
(DEFAULT OFF — being drawable is always the author's invitation). Viewers add
doodle strokes (v0.4 brush), draggable emoji stamps, short text bubbles —
each stored as a SEPARATE VECTOR OVERLAY LAYER keyed to its contributor
(never burned into the image). Every overlay carries a small username chip
and is tappable → highlight + "drawn by @x" → profile. Live updates to all
viewers; contributor strip ("🎨 maya, arjun +3"). Author controls: open /
approve-first / off, one-tap remove any overlay, ban user from my canvases.
Blocks respected both ways; per-user overlay cap per story; overlays
reportable with author attached; everything expires with the story.

**Public share pages (79c):** every PUBLIC-audience post/beacon/listing gets
an unauthenticated SSR page (like /join/<token>): content, author chip,
brand, full OG/twitter tags so links unfurl. Viewing free; ANY interaction
(react, comment, join, profile, more) -> signup/login gate with ?next deep
link back to complete the action. ~~Friends-only content NEVER gets a public
URL.~~ Superseded 2026-10-27 (AUDIT-PLAN decision 11, Slice D): non-public
content is minted by its OWNER only, as a capability token carrying a
Teaser/Full choice; the teaser is trimmed server-side and the deep link lands
on the object. Stories: author-initiated "Create share link" only — revocable, expires
with the story. Media served via share-token-gated endpoints (invite-avatar
pattern): no open media routes, no enumeration, rate-limited. Pages
reportable by non-users (feeds admin queue). PUBLIC_ORIGIN governs the URLs.

**Group visibility modes (79d):** owner/admin setting per group. PRIVATE =
today's behavior. INVITE-ONLY = public share page renders the group CARD only
(name, avatar, member count, description — never messages); joining via
invite links or request->approval queue. PUBLIC = group appears in discovery
and gets a read-only live share page (no login to read; reply/react/join
gates to signup with deep-link back); the switch requires admin confirm +
system message + persistent member banner; ONLY messages after the switch
render publicly (history never retro-exposed); page reportable, covered by
admin content moderation. GHOST = unlisted everywhere (no discovery, no
share page, never in activity/suggestions); direct invite only; members wear
masks (chosen pseudonym + emoji avatar) — anonymous to each other, never to
the server; group admins can see real identities for abuse handling and
reports always attach them (same precedent as the anonymous game, item 77).

**GIF/video chat backgrounds (79):** per-user per-chat upload through the
existing pipeline; auto-dimmed behind bubbles; muted+looped; paused when
off-screen / battery saver; static poster for reduced-motion; size caps.

**Discoverability (80):** first-run spotlight tour (3-4 steps, skippable,
never repeats); "✨ Things you can do" directory page (every feature, one-
liner, Try-it deep link, searchable); "new since your last visit" cards after
server updates.

**Admin (81):** (a) Content tab: ALL public surfaces (public posts, public
beacons, listings) browsable/searchable with Remove-with-reason (author
neutrally notified, action logged). Private chats stay private — the
earlier decision stands: no private-message reader; moderation of private
content happens via reports, where the REPORTER consented to disclose the
reported message + surrounding context (report-context viewer). (b) Support
inbox: in-app Settings → Help & feedback (🐞/❓/💡/⚠️ + optional screenshot)
→ tickets in an admin Inbox tab; admin replies arrive to the user as a
"Bored Chat Support" conversation; statuses open/answered/closed; logged.
(c) "Update available" banner in admin: running git commit (baked at build)
vs origin/main, with changelog; update itself still runs on the host
(./bored update / autoupdate) — the container never gets docker.sock.

## v0.9 — Auth pack

**Passkeys (82):** WebAuthn register/login (platform authenticators),
password fallback retained; manage passkeys in settings.
**QR login (83):** login page shows a QR (ephemeral channel id); logged-in
phone scans → approves → laptop session minted. Pure first-party, built on
the sessions table; codes short-lived, single-use.
**Recovery codes (84):** 6 one-time codes offered at signup (and
regenerable); recovery consumes one, revokes all sessions, forces new
password.
**TOTP 2FA (85):** optional authenticator-app second factor; recovery codes
bypass.
**OTP-ready settings (86):** admin → Authentication: SMTP config (host/port/
user/pass via env or encrypted instance settings) + Test send; SMS-gateway
slot; per-feature toggles (email verification required, email OTP at login,
magic links, password reset). ALL auth features flag off instance settings at
runtime — enabling OTP later is configuration, not code. Until configured,
toggles are visible but disabled with "needs SMTP" notes.

## v1.0 — The owner's big UX wave (four packs, polish woven in)

Owner's 2026-10-17 wishlist, triaged. Ship order: a → b → c → d, each at the
full verification bar. Every pack ships its screens polished (animations,
alignment, reduced-motion safe); a final global alignment audit closes v1.0.
Constraints that bind all four: PSYCHOLOGY rule 3 (named faces, never public
numeric counts — no Instagram-style stats), ghost groups stay unenumerable
(ADR-020), blocks/privacy enforced server-side at every new surface, media
self-hosted in MinIO through the auth proxy (bundled sounds, no tile keys).

### v1.0a — Board & media pack

**Board photos (91):** BUG — owner could not attach photos to a board post;
`POST /api/posts` already takes `attachment_ids ≤ 4`. Root-cause the
composer; then every post/board composer (feed compose, local board, group
contexts) gets the photo picker with previews and remove-before-send.
**Edit before upload (92):** in-app crop/rotate editor (canvas-based, no new
deps) offered wherever an image is picked: profile/group avatars, chat
sends, posts, stories. Aspect presets (free/1:1/4:5/16:9). Output re-encoded
client-side; server pipeline unchanged.
**Pic zoom (93):** tapping any full avatar/profile pic opens a full-screen
pinch-zoom/pan viewer (portal to body, safe-area aware).
**Personal gallery + story saver (94):** private "My gallery" page: my
uploaded media across chats/posts/stories, filterable; my stories auto-save
here past their 24 h (private, deletable). Nothing new is shared — it is a
view over my own attachments.
**Shared chat backgrounds (95):** background picker gains "Set for everyone"
(DMs: either side; groups: admins) → stored on the conversation, fanned out
via WS; each member may still override locally (per-user row wins). Both
sides see the shared one by default — the owner's ask.
**Transparent undo-send (96):** every message send shows a small translucent
Undo pill for `UNDO_SEND_WINDOW_S` (5 s; shared constant) — generalizes the
drunk-mode 10 s undo (drunk keeps 10). Undo = the existing delete-for-
everyone path before anyone's watermark passes the seq.
**Owner decision 2026-10-18: the undo pill is GONE from the chat UI** (both
the 5 s and the drunk 10 s variant) — it was in the way on phones. The
server route (`DELETE …/messages/:seq?undo=1`) and its window checks stay;
do not re-add the pill. Same day: chats open at the first unread message
(else the bottom), and the composer no longer autofocuses on touch devices
(the keyboard was popping over the chat). **No `window.confirm()` anywhere**:
every confirmation goes through `lib/confirm.ts` + `ConfirmSheet` (the
browser box reads "<host> says" and looks like a system alert on phones).
**Groups and channels are deletable** by a group admin / the channel owner
(`DELETE /api/conversations/:id`, API.md §1.4) — the owner's ask; DMs stay
undeletable (leave or block).

### v1.0b — Stories pack

**Multiple stories (97):** several active stories per author; tray groups by
author, auto-advance; per-story viewer list for the author (named faces,
chronological, NO view count headline — the list itself is the signal).
**Audiences (98):** per-story audience: public / connections / exclusive
list (reusable "close friends" list) / connections-minus-hide-from list.
Server-enforced at read/fan-out like every §1.14 rule; public stories feed
the existing share pages.
**Voice reactions (99):** holding the reaction mic records ≤ 15 s audio sent
to the author as a story-reply DM (existing audio message type); quick emoji
reactions stay.
**Live comments (100):** author opt-in per story: a comment strip all
eligible viewers can read and join (realtime via WS), author can remove
comments / ban users from their stories; blocks invisible-enforced;
reportable. Comments die with the story.

### v1.0c — Calls pack

**Call history (102):** `call_sessions` style log (caller, callees, in/out/
missed, duration) → per-chat header entry + global Calls tab; owner-only
delete of own history rows. Missed-call row doubles as callback button.
**Sounds (103) — SHIPPED 2026-10-18:** ringtone + message-notification
sounds, synthesized with the Web Audio API instead of shipped OGG/MP3
assets (no binary blobs, nothing to license, zero deps); settings: ring
choice (Classic/Soft/Pulse/Off, each previews on tap), text sound on/off,
vibrate, per-chat override (Default/On/Off in chat settings); respects the
server-side mute, never dings for the chat on screen, own sends, system
rows, or mid-call; blocked senders never reach the client (server-enforced).
Prefs are device-local (localStorage), by design — a sound is a device
choice. Caller hears a standard ringback while the callee's phone rings.
**Audio↔video switch (104):** mid-call upgrade to video prompts the other
side (consent), downgrade is instant; renegotiation over the existing
signaling channel (ADR-014/017 patterns).
**Layouts (105):** 1:1 video gets layout templates: classic PiP (draggable,
snap corners) and two-half split; tap a tile to swap focus; remembered per
user. Group calls keep the grid.

### v1.0d — Profile, search & sharing

**Tap-photo → profile (106):** tapping a user's avatar/photo anywhere opens
the profile sheet: pic, mood (per its visibility), interests, pic feed +
posts the viewer may already see. Strictly a navigation feature — it reveals
nothing the viewer couldn't reach at `/u/username`.
**Profile sections + privacy (107):** profile gains tabs (posts, gallery,
groups, connections) — each with owner toggle public/connections/private.
Groups tab lists ONLY public + invite-only groups the owner opted to show
(ghost: never; private: never). Gallery tab shows only media already public
to that viewer. Defaults conservative (connections).
**Global search (108):** persistent search bar: people (existing `?q=`),
public/invite-only groups, board listings, my own messages (per-user pg
trigram/FTS on my conversations only). All results pass block/privacy
filters server-side; backlog item 56 partially lands here.
**Location pins (109):** "Spotted" pins — photo + place on the local board
(listing-flavored, lat/lng optional label + OSM/Google link-out, no embedded
tile maps); others tap "interested 👀" (named faces strip, no counts);
pins expire like beacons; reportable, block-filtered.
**Share audit (110):** every shareable surface (story, post, beacon,
listing, group, profile) carries the share button wired to the existing
share pages/links + OS share sheet; stranger lands on the SSR page, signup
gates interaction (79c/79d machinery — surface, don't rebuild). Owner
emphasis (2026-10-17): sharing must work to OTHER social media — share pages
get full OG/Twitter-card meta so links unfurl in Instagram/WhatsApp/etc.;
profiles get a standalone share link (public profile page + copy-link
button — shipped 2026-10-28 as the §1b phase 6 profile share: `/u/<username>`
renders a logged-out hero, `profile_visibility` decides how much); posts AND videos on share pages are viewable/PLAYABLE by non-users
(share-token-gated streaming, rate-limited), with every interaction gating
to signup + deep-link-back. Growth loop: viewer → login wall only at the
moment of interaction, never at view time for public content.
Owner emphasis (2026-10-27): "everything shareable" — the set widens to
every object a member can point at: profile as a "text me / call me" link,
a call room link ("video call / meet over", `/call/<token>`), any plan
("join me"), any listing/room, any group, any post, story, chat media
(OS share + send-to-chat). Each page shows a teaser (what + who) and gates
message / call / join / further pics and video behind sign-in, then lands
on that exact object. Non-public objects share by capability token (the
existing revocable share-link machinery); after login the gated action
re-checks audience, blocks and dm_policy and turns "outside the audience"
into a request, never a 404. The full per-object matrix, what exists
today, and the wave that builds each piece are in `docs/AUDIT-PLAN.md`
§1b. Owner decision (2026-10-27, AUDIT-PLAN decision 11): public objects
stay fully viewable (the 2026-10-17 line above stands); non-public objects
shared by token show a TEASER by default with a sharer-side Teaser/Full
switch at mint time (stored on the token, server-rendered); other people's
identities (joiner faces, members, commenters, reactors, viewers) are never
shown to a stranger; every action (message, call, join, react, reply, more
pics, video on private objects) sits behind an INLINE sign-in sheet that
re-renders the page in place. Operational counts ("3 people are here",
"12 members", "a few spots left") are allowed on share pages. The
per-object visible/gated table is in AUDIT-PLAN §1b.

**Explicitly NOT building:** public numeric profile stats (follower/like
counts) — banned by PSYCHOLOGY rule 3; the Instagram-style grid + share
link ship without numbers.

## Standing decisions made in conversation (do not relitigate silently)

- No private-chat monitor in admin; report-context viewer is the moderation
  path. No payments in-app, ever (prices are display text). No user cards on
  the login page. Single waves invisible; nudges anonymous. Marketplace star
  averages are allowed (trust/safety info, not social approval) — ADR-012.
- Puzzle/game results share as opt-in grids; never ranked leaderboards.
- Group calls are mesh ≤8 until LiveKit SFU (ADR-014 seam); listen-together
  deferred; E2EE/native wrappers/federation/make-it-yours stay backlog until
  the owner schedules them.
- Share pages (2026-10-27): "show the thing, hide the people, gate the
  action". Public objects fully viewable; non-public objects by token with a
  sharer-chosen Teaser/Full preview; strangers never see other members'
  identities; every action behind an inline sign-in sheet. Per-object table
  in `docs/AUDIT-PLAN.md` §1b.
