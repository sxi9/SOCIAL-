# Bored Chat — Feature Master List & Roadmap

Status: ✅ shipped · 🔨 building · 📋 planned

## ✅ Shipped (v0.1–v0.2)

1. Realtime 1:1 & group chat (≤256) over WebSockets
2. Sent / delivered / read ticks (watermark receipts)
3. Exact offline catch-up sync; sends can never be lost (idempotent retries)
4. Typing indicators, presence, last-seen
5. Animated GIF profile avatars (GIF/WebP/APNG/MP4 → animated WebP + static fallback; motion settings; groups too)
6. Photo / video / file messages — thumbnails, blurhash, private auth-checked storage
7. PWA share target (share from any app into a chat, logged-out stash included)
8. Link preview cards (worker-side, SSRF-guarded, re-hosted images, per-user budget)
9. Web push (read-elsewhere suppression, per-chat collapse) — per-chat muting 📋 Wave 1.6 (`muted_until` column exists, no writers yet)
10. GIF invite links — /join/<token> shows the inviter's animated avatar, OG unfurl, lands joiners in a DM. ✅ 2026-10-28 (phase 2 slice G): a group invite's page carries the group card (face, description, size; the unfurl uses the group's face), and the in-app invite sheet lists your links for that scope with Revoke and a QR
11. Reactions (picker, chips, live fan-out)
12. Animated login/register
13. Two-pane desktop layout
14. Emoji picker, invite-CTA empty states
15. Profile pages (/u/username) — member-only today; logged-out public share 📋 Wave 6
16. Session/device management; revocation closes live sockets
17. Hardening: argon2id, rate limits, CSRF header, CSP, magic-byte sniffing
18. One-command deploy (compose, 8 services, auto-HTTPS), ops CLI, CI (incl. image builds), ADRs

## ✅ v0.2.1 — Mascot login (shipped)

19. Bored Blob mascot login: eye tracking, covers eyes on password (peeks on "show"), idle yawn, error head-shake, success bounce, logo-tap party mode
20. Pointer-reactive background, 3D card tilt, rotating taglines, time-aware greetings, register confetti
21. Mascot waves beside the inviter's avatar on join pages
22. Invite/reaction edge-case fixes with regression tests

## ✅ v0.3 — Beacons + Privacy + Trust foundations (shipped)

23. "I'm bored — let's plan" beacon: vibe chips, now/tonight/weekend, audience friends / nearby / public
24. Live expiring plan cards; "I'm in 🙋" with avatar pile-up; spark threshold ("needs 2 more")
25. Sparked beacon → auto plan-group with icebreaker + venue poll
26. Boredom radar (aggregate counts only), recurring rituals, afterglow photo recaps, plan karma
27. Seen-by lists (who viewed / who received each message; later powers story views)
28. Privacy settings: reciprocal read-receipt toggle, last-seen visibility, typing toggle, invite controls, beacon visibility, who-can-add-me-to-groups, avatar-animation visibility
29. Block & report + blocked list (ships WITH public-facing features, never after)
30. Nearby = coarse opt-in area only; no live GPS, never shown to others

## ✅ v0.4 — Expression pack (shipped)

31. Avatar stamps (react with your own GIF face; auto sticker pack)
32. Voice notes (hold-to-talk)
33. Doodle messages
34. Message effects (trigger-word animations)
35. Vibe check (everyone answers a prompt with a GIF)
36. Chat themes, wallpapers, per-chat nicknames
37. Disappearing messages; scheduled messages; time capsules
38. Mini-games in chat + daily puzzle shared with friends (friends-who-shared strip ordered by username — no leaderboard, no ranking, per PSYCHOLOGY rule 3 and API §1.27)

## ✅ v0.5 — Local board + social layer (shipped: v0.5a social layer, v0.5b local board)

One listing system, five card kinds, all area-tagged with expiry and "Message me" → DM:

39. Work together / hire me — gig posts, portfolios, project team-ups → project group chats
40. Ride offers (route, time, seats)
41. Room & space sharing (price, photos, dates) — "looking for" posts 📋 (no such listing kind yet; kinds are gig/ride/room/place_review)
42. Place reviews with area tags (`place_review` kind) — feed/beacon venue suggestions 📋 (not wired)
43. Plan beacons join the board as one card kind; a filterable "Local" tab
44. Trust layer: person reviews after transactions (shipped v0.5b — API §1.40, ADR-012); account-age/mutual-friend signals remain 📋
45. No in-app payments — the app connects people, money settles outside; bulletin-board terms shown plainly
46. Stories (24h) with view lists; broadcast channels; feed (posts/likes/comments)
47. Rich profiles: 3-GIF strip, interest tags, work/skills portfolio
48. Connections graph; replies/threads, edit/delete, forwarding, pins, @mentions — group-admin UI 📋 (no surface yet)

## ✅ v0.6 — Calls + discovery (shipped)

49. 1:1 voice & video (browser WebRTC + self-hosted coturn TURN, HMAC time-limited creds)
50. Group calls — mesh WebRTC up to 8 participants (LiveKit SFU upgrade seam documented in ADR-014; the SFU itself remains 📋)
51. Watch together (host-synced YouTube sessions); listen together remains 📋
52. Bored Together & Bored Roulette (opt-in discovery, mutual waves, 5-min keep-or-vanish chats, private expectation feedback — gated on the v0.3 safety bundle)
53. Rescue me (ping up to 3 connections, daily-capped)

## ✅ v0.6.1 — UI correctness (shipped)

59. Overlay/placement fixes from real-device testing: rescue sheet positioning, click-blocking backdrop, beacon-sheet submit clipped on phones, SOS header overflow, roulette tap target — plus a five-viewport sweep of every sheet/button (containment, clickability, triple dismissability)

## ✅ v0.7 — Interactivity pack (shipped)

60. Clickable beacon joiners → "Who's in" sheet; most avatars → profile with Connect/Message (six surfaces still unlinked 📋 Wave 6 #60)
61. Edit live beacons (vibe/note/time/threshold, joiners see a change note) + edit board listings; custom vibe chips (emoji + word, recents remembered)
62. "Start with whoever's here" — early spark below threshold (creator button)
63. Joiner notifications: sparked / edited / starting soon / cancelled (joiners only)
64. Feed lanes: Friends / Public (Discover) toggle; public posts visible to all
65. Interactive posts: inline poll posts (song polls via options + links), open game-challenge posts (first tap joins), "Join my…" cards (cross-post a beacon/listing to the feed with a Join button)
66. GIF/image attachments on comments; emoji + avatar-stamp reactions on comments
67. Location chips on posts/beacons/listings (place name or one-tap current location → map link; no tile embeds, no API keys)
68. Chat "📍 Join me here" location drops with "On my way 🏃" quick-reply headcount
69. Scheduled-send confirmation toast + pending-count badge opening the scheduled drawer
70. OG banner image for invite links (composed 1200×630: avatar + "X invited you" + mascot; good card even with no avatar)
71. Login flipping wordmark ("[Bored|Sad|Excited|Happy] Chat") with mascot reacting per word

## ✅ v0.7.1 — Calls that just work (shipped)

87. Floating minimized call: in-call screen collapses to a draggable floating pill (avatar, timer, mute, hang-up) so the app stays usable mid-call; tap to expand; browser PiP for video where supported
88. Incoming-call push notification (ring + Answer/Decline actions) when the app is closed, not just the live overlay; respects mute/blocks like all push
89. Call connectivity UX: live connection states in the UI (connecting / connected / reconnecting / failed with the REASON), automatic ICE restart on drop, and a Settings → Call self-test page (mic/cam permission, secure context, TURN reachability, candidate types found)
90a. Global confirmation toasts: every action that has no visible immediate result confirms itself with a small popup (sent to board, beacon lit, invite copied, settings saved, report submitted, scheduled, kudos sent...) — one shared toast component, bottom-anchored above the tab bar, auto-dismiss, reduced-motion safe
90b. Notifications-on assurance: on login/first-run, detect push permission state; a friendly one-time prompt explains what notifications are for (messages, calls, sparked plans, wave nudges) with Enable now; a persistent but quiet settings row shows ON/OFF/blocked-by-browser with per-browser unblock help; incoming-call ring push depends on this and surfaces it when disabled
90. TURN honesty: when TURN_SECRET is unset or the relay is unreachable, the CALLER sees "this server has no call relay — calls only work on the same network" instead of silent failure; ./bored status and the admin panel surface TURN state; docs explain laptop-behind-NAT vs VPS reality

## ✅ v0.8 — Identity, moods & community care (shipped: v0.8a identity, v0.8b community & sharing)

72. Moods: 😴🎉💤 + custom emoji+word, auto-expiring, visibility everyone/connections/nobody; 🎢 swing mode (auto-cycling chip)
73. 🍻 Drunk mode: wobbly chip (connections-only default), 10s send-undo, "you sure?" checks for cold contacts/public posts, chat banner for others ("take tonight's messages lightly" + "Check on them 💙" button), auto-expiry with no trace
74. Mood-reactive messages: drunk = dancing bubbles, sad = rain + falling text, hyped = bounce — subtle, per-viewer toggle, reduced-motion off
75. Animated display names: Off/Glow/Shimmer/Rainbow/Surprise-me (static for reduced-motion viewers, legibility first)
76. Profile activity strip (lit/sparked beacons, posts, listings, games) with per-type privacy (public/connections/private); never leaks past the underlying object's audience
77. Anonymous message game: opt-in (default connections-only), reveal via timer (progressive avatar un-blur) or riddle; sender anonymous to recipient never to the server; reports attach identity
78. People-you-may-know suggestions (mutuals/area/groups) + post-signup "find your people" (never on the login page)
78a. Anonymous wave nudges: "Someone in the pool waved at you 👀" push/in-app — no identity revealed (no-rejection rule holds); sent only when the visible pool is large enough to keep the waver anonymous, batched per opt-in hour, user-toggleable
78b. Discovery filters: filter Bored Together cards by area, shared interests (profile tags) and what-for vibe (opt-in gains optional vibe chips); filters only ever narrow by what people chose to share — no age/gender fields exist to filter on
79a. Canvas stories: author opt-in collaborative mode — viewers add doodle strokes, tap-to-place emoji stamps (fixed scale, not draggable) and text bubbles as attributed overlay layers (small username chip on each, every overlay tappable -> highlight -> contributor profile), live-updating for all viewers, contributor strip on the story; author controls (open/approve-first/off, remove any addition, ban from my canvases), per-user caps, blocks respected, overlays reportable with author attached; layers stored as vectors, never burned into the image
79. GIF/video chat backgrounds (per-user per-chat, dimmed, paused off-screen, poster for reduced-motion)
79c. Public share pages: public posts/beacons/listings get SSR share pages (content + author chip + OG unfurl) viewable without an account; any interaction gates to signup with deep-link-back; stories only via explicit author-created revocable links (die with the story); media via share-token-gated URLs, rate-limited, reportable by non-users. ✅ 2026-10-27 (share-everything Slices C–D): one ShareSheet on every object (copy · OS share · QR · send to a chat · stop sharing); a NON-public post/plan/listing shares by an owner-minted token with a Teaser/Full choice (server-trimmed teaser, media proxy serves only what the page lists); the deep link lands ON the object (`/feed/[postId]`, `/local/[listingId]`, `/local/b/[beaconId]`); token pages are `noindex` + `robots.txt`; ✅ 2026-10-28 (Slice E): every gated CTA opens the inline sign-in sheet (password · passkey · QR · create account · TOTP) and lands on the object, `/register?next=` kept as the no-JS fallback
79d. ✅ 2026-10-28 (phase 2): signed-in visitors join / ask / withdraw / open the chat right on the group share page; admins get a `group.join_request` frame + push and a live `pending_requests` count. Group visibility modes: 🔒 private (default, unchanged) · 🎟️ invite-only (share page shows card only — never messages; join by link or request+approval) · 🌍 public (readable by anyone on a share page, interaction gated to signup; admin-confirmed switch, member banner, ONLY post-switch messages public, moderated; reportable 📋 — conversation is not yet in the takedown enum) · 👻 ghost (unlisted everywhere, direct-invite only, members wear pseudonym+emoji masks — anonymous to each other, never to the server; group admins see identities, reports carry them)
80. Discoverability: first-run tour, "✨ Things you can do" feature directory with Try-it buttons, "new since last visit" update cards
81. Admin: public-content moderation tab (public posts/beacons/listings, remove with reason, logged); support inbox (in-app Help & feedback → categorized tickets → admin replies land as a Support conversation); report-context viewer (reported message + surrounding context, reporter-consented)

## ✅ v0.9 — Auth pack (shipped)

82. Passkeys (WebAuthn): fingerprint/face login, password fallback
83. QR cross-device login (scan with logged-in phone, WhatsApp-Web style)
84. Recovery codes at signup (one-time, printable) for email-free account recovery
84b. Change password while signed in (Settings → Devices & security; re-proves the current password, signs out other devices) — added 2026-10-18
85. Optional TOTP 2FA (authenticator apps)
86. OTP-READY admin settings: an Authentication section in the admin panel to configure delivery when available — SMTP (email verification, OTP, magic links, password reset) and an SMS-gateway slot — with per-feature toggles and a test-send button; all auth features flag off instance settings so enabling OTP later is configuration, not code

## ✅ v1.0a — Board & media pack (shipped on branch; full design: SPECS.md §v1.0)

91. Photos on EVERY board kind (gig/ride/room/review, ≤6) + the iPhone HEIC fix (client converts HEIC→JPEG; server rejects undecodable images instead of storing broken rows)
92. Edit-before-upload: in-app crop/rotate with aspect presets wherever an image is picked (avatars, chat, posts, stories)
93. Full-screen pinch-zoom viewer for profile/group pics
94. Personal gallery ("My gallery"): private view over my own media + story auto-saver past 24h
95. Shared chat backgrounds: "Set for everyone" (group: admins) fanned out live; per-user override stays
95c. App-wide appearance: light / dark / system mode + accent palettes (Royal, Gold, Rose, Mint, Sky) in Settings → Appearance; device-local, applied before first paint (added 2026-10-18)
95b. Shared chat theme + wallpaper (group: admins; DM: either side) — the whole chat's look, fanned out live via `conv.appearance`; each member's own theme/wallpaper still overrides under "Your view" (migration 0013, added 2026-10-18)
96. ~~Transparent undo-send pill on every message (5 s; drunk mode keeps 10 s)~~ — pill REMOVED 2026-10-18 (owner decision, SPECS.md); the server undo path stays

## 📋 v1.0b — Stories pack

97. ✅ (shipped) Multiple active stories per author; per-story viewer list (named faces, no count headline) — `GET /api/stories` tray + author-only `/views`
98. Story audiences: public / connections / exclusive close-friends list / hide-from — server-enforced
99. Story voice reactions (≤15 s audio → story-reply DM) + quick emoji reactions
100. Story live comments (author opt-in): realtime thread all eligible viewers see and join; author moderates; die with the story

## 📋 v1.0c — Calls pack

102. Call history: global Calls tab + per-chat log (in/out/missed, duration), callback from missed row
103. ✅ Ringtone + text notification sounds — shipped early (2026-10-18): Web-Audio-synthesized tones (no audio files), ringtone choice + ringback + text tone + vibrate in Settings → Notifications & sounds, per-chat override in chat settings, mute parity; device-local prefs (`apps/web/lib/sounds.ts`)
104. Mid-call audio↔video switch (consent prompt on upgrade)
105. ✅ (shipped) 1:1 video layouts: draggable PiP + two-half split, tap-to-swap focus (`CallOverlay.tsx`)

## 📋 v1.0d — Profile, search & sharing

106. Tap any user photo anywhere → profile sheet (mood, interests, pic feed, posts — only what the viewer could already see)
107. Profile tabs (posts, gallery, groups, connections) each with public/connections/private owner toggle; ghost groups never listed
108. Global search bar: people, public/invite-only groups, board listings, my own messages
109. "Spotted" pins: photo + place on the local board, "interested 👀" named-faces reactions, beacon-style expiry
78c. ✅ (shipped v1.0, with the quick-wins round) Find-people page (/people): suggestion grid with narrowing filters (mutuals/groups/area/shared public interests), refresh, honest empty state; strips link to it ("See more")
110. Share everywhere: OG/Twitter-card unfurls for other social media, standalone profile share link, non-users can view posts and PLAY videos on share pages — login only gates interaction (never viewing public content). ✅ video playback on public share pages already works; the rest is the §1b share-everything build (Waves 4.2/6).

## ✅ v1.1 — "Royal" UI redesign (shipped on branch; from the owner's design drop)

111. Royal theme: charcoal-navy + white/silver accent system, Marcellus display serif + Instrument Sans body (self-hosted woff2), pill buttons with press feedback, silver story/avatar rings, soft top glow — token-level, so every screen/sheet inherits it
112. Animated mood login: wordmark cycles bored./happy./sad./drunk. with synced taglines, mascot faces (ivory blob; drunk = squiggle+blush+wobble, sad = tear) and mood backdrops (star twinkle / rain / drifting blobs); static under reduced motion
113. Screen treatments: edge-to-edge feed posts + silver story rings + serif poll questions + royal end card; Local beacon cards with outline join pills + dashed "I'm bored" pill + board kind-tags; chats list with pulse-glow unread badges; conversation with white-gradient outgoing bubbles (ink text) + plan-card bolt pulse + blinking typing dots; profile with conic-ring avatar + serif name; story viewer scrims + segment bars; tab bar active/inactive states with press feedback

## 📋 Backlog — operator & platform

54. ✅ (shipped v0.5b — API §1.41, ADR-013) Admin dashboard (operator-only): user list with registration/last-login IPs and sessions, reports queue with actions (warn/suspend/ban), server log viewer (api/worker), metrics (DAU, messages/day, storage), invite on/off, data export. Boundaries: metadata only — no private message contents in the UI; IP retention window (default 90 days) documented in the instance's privacy note
55. Make-it-yours kit: per-instance name, colors, mascot
56. Full-text search; multi-device polish; Capacitor Android/iOS wrappers
57. End-to-end encryption (session/device registry already in place)
58. One-click backup/restore; boredom status & mood-ring avatars; mascot evolution; i18n; federation (someday)

## Standing design rules (full research brief: docs/PSYCHOLOGY.md)

- Active connection over passive consumption: no infinite feeds to doomscroll
- No variable-reward mechanics, guilt streaks, or public like-counts
- Anticipation is a feature: countdowns to plans are wellbeing-positive
- Every public-facing feature ships together with its safety controls
