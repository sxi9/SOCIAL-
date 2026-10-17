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

## Standing decisions made in conversation (do not relitigate silently)

- No private-chat monitor in admin; report-context viewer is the moderation
  path. No payments in-app, ever (prices are display text). No user cards on
  the login page. Single waves invisible; nudges anonymous. Marketplace star
  averages are allowed (trust/safety info, not social approval) — ADR-012.
- Puzzle/game results share as opt-in grids; never ranked leaderboards.
- Group calls are mesh ≤8 until LiveKit SFU (ADR-014 seam); listen-together
  deferred; E2EE/native wrappers/federation/make-it-yours stay backlog until
  the owner schedules them.
