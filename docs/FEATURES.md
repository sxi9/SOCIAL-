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
9. Web push (read-elsewhere suppression, muting, per-chat collapse)
10. GIF invite links — /join/<token> shows the inviter's animated avatar, OG unfurl, lands joiners in a DM
11. Reactions (picker, chips, live fan-out)
12. Animated login/register
13. Two-pane desktop layout
14. Emoji picker, invite-CTA empty states
15. Public profile pages (/u/username)
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
41. Room & space sharing (price, photos, dates) and "looking for" posts
42. Place reviews with area tags (feed beacon venue suggestions)
43. Plan beacons join the board as one card kind; a filterable "Local" tab
44. Trust layer: person reviews after transactions (shipped v0.5b — API §1.40, ADR-012); account-age/mutual-friend signals remain 📋
45. No in-app payments — the app connects people, money settles outside; bulletin-board terms shown plainly
46. Stories (24h) with view lists; broadcast channels; feed (posts/likes/comments)
47. Rich profiles: 3-GIF strip, interest tags, work/skills portfolio
48. Connections graph; replies/threads, edit/delete, forwarding, pins, @mentions, group admins

## ✅ v0.6 — Calls + discovery (shipped)

49. 1:1 voice & video (browser WebRTC + self-hosted coturn TURN, HMAC time-limited creds)
50. Group calls — mesh WebRTC up to 8 participants (LiveKit SFU upgrade seam documented in ADR-014; the SFU itself remains 📋)
51. Watch together (host-synced YouTube sessions); listen together remains 📋
52. Bored Together & Bored Roulette (opt-in discovery, mutual waves, 5-min keep-or-vanish chats, private expectation feedback — gated on the v0.3 safety bundle)
53. Rescue me (ping up to 3 connections, daily-capped)

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
