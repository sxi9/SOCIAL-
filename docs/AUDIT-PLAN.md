# Audit action plan — what to add or update after AUDIT-2026-10-18

Written 2026-10-27 against `main` at `b396d09`. Source: the 17-benchmark audit
`AUDIT-2026-10-18.md` (3,130 lines, 13 per-area sections + front matter), read in
full and every item re-checked against the current tree, because nine commits
landed on 2026-10-18 *after* the audit was written (it reflects roughly `e8a1337`).

Status words used below: **DONE** (shipped since the audit, do not redo),
**PARTIAL** (half landed, remainder named), everything else is open.

---

## 0. Already closed since the audit (do not redo)

| Audit item | Shipped by | Remainder |
|---|---|---|
| Change password while signed in (P0 #2) | 06dfc91 — `POST /api/auth/password`, Security-page sheet, FEATURES 84b, API §1.72 | Revoking other devices is forced not optional; no Support-chat notice on change; password rule still `min(8)` only; lives under Devices & security, not an Account page |
| Theme toggle Dark/Light/System (P0 #14, half) | 06dfc91 — `settings/appearance`, `data-theme`/`data-accent`, pre-paint script, accent palettes | Light palette itself is still "derived" (`globals.css:81`); no text-size / motion row; device-local only |
| 15 native `window.confirm`/`alert` sites | 31836af — `lib/confirm.ts` + `ConfirmSheet` in `GlobalOverlays` | One `window.alert` left at `ChatView.tsx:448` (pin board full); Sign out on `settings/page.tsx:206` still has no confirm; no "Delete for me / for everyone" variant |
| Delete group / close abandoned channel | 31836af — `DELETE /api/conversations/:id` + sheet row + test | Transfer ownership still open; `routes.ts:579` comment "transfer/deletion is future scope" now half-stale |
| Missed-call row → card with who/when/call-back | 06dfc91 | Push itself has no actions; no call history (#102); `call_ended`/`call_failed` events still absent |
| Upload behind a spinner | 06dfc91 — XHR `api.uploadForm` with percent in Composer, Feed, Listing | No cancel/abort, no retry, one number per batch not per file; Stories composer still uses `api.postForm` (one-line adoption) |
| Stale shell after deploy | 507e674 — cache bumped to v2 + `healStaleShell()` on 404 of `/_next/static` | Still a hand-bumped string, no `controllerchange` "Reload to update" toast; `TROUBLESHOOTING.md:26` still says "close and reopen twice" |
| Chat opens at top on phones / keyboard pops | 31836af — lands on first unread; autofocus only on fine pointer | No "N unread" divider drawn; no jump-to-bottom pill |
| HEIC uploads | 06dfc91 — server `heif-convert` fallback for general uploads | Avatar route still rejects raw HEIC (`AVATAR_SOURCE_MIME_ALLOWLIST`, `settings/account/page.tsx:171` accept list); animated and video EXIF legs still verbatim |
| Hang-up latency; shared background 404 for non-uploader | 338e144 | — |
| Ringtone / ringback / text tone / vibrate-for-calls | 281abd9 | Device-local by design; `stopVibrate()` still fires `navigator.vibrate(0)` on every store change |
| Admin grant/revoke admin + set user password from Users tab | a3af7b2 | `API.md:611` "CLI reset remains the operator path" now stale |
| `cli.ts:36` "log in and change it" | true by implication now | — |

Audit claims that were wrong even at the time (don't chase them):
- `DELETE /api/push/subscriptions` **exists** (`push/routes.ts:51-67`). The real bug is that `logout()` never calls `disablePush()`.
- The admin half of group join requests (list / approve / deny in `GroupSettingsSection.tsx`, `lib/groups.ts`) shipped on 2026-10-17. Only the requester half (`joinGroup()` has zero callers; share page sends signed-in users to `/login?next=`) is missing.
- Migration numbering: the audit says "migration 0013" for `dm_policy` / `pinned_at` etc. `0013_shared_appearance.sql` now exists — **next free number is 0015** (`0014_share_plumbing.sql`, 2026-10-27, holds only the §1b plumbing: `share_tokens.preview`, `users.dm_policy`, `users.profile_visibility`; the Wave 1/2 columns below go in 0015).
- `FeedView.tsx` line references ≥515 have drifted by about +12.

Audit suggestions that now **conflict with the owner's 2026-10-18 decision** (undo pill removed, SPECS.md standing decision) — substitute `confirmDialog()` in every case:
- "route story delete through the undo pill (#96)"; "undo window after posting"; "comment delete with undo".

---

## 1. Decisions the owner must make before some of the work (one line each)

1. **Age line at signup: 16+ or 18+?** The no-DOB rule (#78b) bans a stored field, not a non-stored attestation. Discovery/roulette would refuse accounts without it.
2. **Contacts import** — the audit's final position is "P1 growth gap, build it self-hosted as salted-hash matching with a delete control" (it overrules the UI section's "keep it missing"). Yes/no.
3. **YouTube iframe in watch-together** — the one third-party runtime script in a "no third-party SaaS" product. Either amend rule 7 with an explicit carve-out, or build co-watch of self-hosted MP4.
4. **`member_count` in the group header** vs ADR-020:67-69 / API.md §1.68 saying it stays off every in-app surface. Fix the docs or the header.
5. **API.md §1.13 "no all-off notification switch"** — product already allows all-off and the digest it cites was never built. Build the digest (Wave 7) or delete the sentence.
6. **Call-declined copy** — API.md (~:1697) says declines are silent, `CallOverlay.tsx:931` shows "Call declined." live. Soften to "No answer." or let (planned) history show it to the caller only.
7. **Registration default** when `registration_mode` lands: `open` or `invite_only` for the current box?
8. Write down two bans that are enforced only by habit: **call recording** and **algorithmic lead-photo ordering** (Smart Photos) → PSYCHOLOGY never-build list.
9. **Self-hosted OSM tiles** for rides/rooms — the audit reads "no map" as a no-SaaS rule, not a product rule. Allow on the roadmap or keep "LINK, never an embed".
10. **Pull-to-refresh** — audit says the ban is overreach; leave as is, but make manual refresh a "New posts" pill. (No decision needed unless you disagree.)
11. **How much a share page shows before login — RESOLVED 2026-10-27 (owner):** the per-object model in §1b. Public objects are fully viewable (the 2026-10-17 line stands: videos play for strangers). Non-public objects shared by capability token show a **teaser**, and the sharer gets a **Teaser / Full** switch at mint time (stored on the token; the server decides what to render). **Other people's identities are never shown to a stranger** (joiner faces, members, commenters, reactors, story viewers). **Every action is behind sign-in**, shown as an inline login/register sheet over the share page that then re-renders in place and lands on that object. Operational counts ("3 people are here", "12 members", "a few spots left") are allowed on share pages; social-approval counts stay banned. Friends-only story teasers show the clear poster frame with overlays (not blurred).

---

## 1b. Share everything (owner requirement, 2026-10-27)

Every object a member can point at must have a link they can send to a friend outside the app: "call me from here", "text me over here", "video call / meet over", "join me in the plan", "room something", "join the group". The link opens a page that shows enough to know what it is and who sent it, and every further step (message, call, join, see more pictures or video) asks the visitor to sign in or sign up and then lands them back on that exact object. The audit treats this piecemeal (FEATURES #110, Platform §B4, Calls P2 "call links", Groups join loop, Board "share area-only listings"); this section is the one place that states it, with what exists today.

**What exists today (`packages/shared/src/constants.ts:1192` `SHARE_OBJECT_TYPES = post | beacon | listing | story | group`):** share pages at `/s/[token]` and `/p/[token]` with full OG/Twitter meta (`SharePageRoute`), media visible and video playable logged-out, every interaction routed to `/register?next=` (`SharePageView.tsx:3,24`); invite links at `/join/[token]` for "connect with me" and "join this group". Share links are revocable capability tokens (ADR-007; `DELETE /api/share-links/:token`, auto-revoke on narrowing). **Since Slice D (2026-10-27):** a non-public post / plan / listing is minted by its OWNER only, with a Teaser/Full choice stored on the token and a server-trimmed teaser page; anyone else gets `not_public`. Groups can be minted by admins only (public / invite-only; private and ghost never).

| Object | Today | Target | Plan wave |
|---|---|---|---|
| **Profile — "text me over here"** | No share link; `/u/[username]` is `'use client'` behind `AppShell`, `GET /api/users/:username` requires auth, no OG. | Add `profile` to `SHARE_OBJECT_TYPES`; `/u/[username]` renders a logged-out hero (avatar, name, bio line, interests, mutual faces, never counts) via `generateMetadata`; CTAs **Message** and **Call** gated by login, landing in the DM compose / ringing after sign-in; `dm_policy` still applies (a stranger lands in Requests, Wave 1.7); Share sheet on `/u/` and the own tab with Copy link · OS share · QR (`QrCode.tsx` exists) · Copy @username. | 6 (ProfileView + growth), depends on 1.7 |
| **Call — "call me from here", "video call", "meet over"** | Nothing. No link route in `calls/routes.ts`; audit lists "call links" as standard P2. | (a) Personal call link: `/u/[username]?call=audio\|video` deep link → login → DM call starts. (b) Room link: `POST /api/calls/links` mints a token for a DM/group call; `/call/[token]` shows "<name> invites you to a video call · faces of who is in" and **Join** after login; token expires with the call (`call_ended`); busy/Silence rules from Wave 4.1; mesh cap ≤8 (ADR-014) enforced at join. | 6 (calls bullet — added) |
| **Plan / beacon — "join me in the plan"** | ✅ Slice D: the host mints a token for any plan (teaser = host, vibe, when, coarse area, note, needs); `deepLink()` lands on `/local/b/<id>`. Still missing: Join-after-login → request / "Ask host" (phase 3), add-to-calendar. | Any beacon the host owns can be shared by token. Page shows host, vibe, when, where-coarse, joiner faces, "N spots left" if `max_joiners` set, `LISTING_SAFETY_NOTE`; **Join** after login: inside the audience → joins; outside → becomes a request to the host (host approval, Wave 7.1) or, until that lands, "Ask <host> to add you" opening a DM. "Add to calendar" (`.ics`) works logged-out. | 4.2 (`deepLink`), 6 (board/beacon), 7.1 (approval) |
| **Listing / room — "room something"** | ✅ Slice D: the author mints a token for an area-only listing (teaser = kind, title, price, first photo, area, status); the safety note rides the share page; `deepLink()` lands on `/local/<id>`. Still missing: Message-the-poster after login → contact row (phase 3). | Token link for area-only listings showing kind, title, price chip, first photo, posted time, area; **Message the poster** after login (→ contact row); `sell`/`lost_found` kinds inherit it. | 1.8 (safety note), 4.2 (`deepLink` → `/local?l=<id>`), 6 (board) |
| **Group — "join the group"** | Share page for public/invite-only groups (admin-minted) + invite link `/join/[token]`; signed-in visitors are bounced to `/login?next=`; `joinGroup()` has no caller; join page shows only the title. | Share page shows avatar, name, description, size, a few member faces; **Join** / **Request to join** works both signed-in and after signup; "Requested" state with withdraw; invite QR; list/revoke invites; `conversation_bans` honoured on accept. Private (ghost) groups stay unshareable by design. | 2.5 |
| **Post** | ✅ Slice D: the author mints a token for a friends-only post (teaser = author, first 280 chars, first photo — no video, poll or location; Full = as public); `deepLink()` lands on `/feed/<id>`. Still missing: ⋯ → Share on every card is there (Slice C); "Send to a chat" is there; `/feed/[postId]` is there. | Every post gets ⋯ → Share (Copy link · OS share · Send to a chat); friends-only via token with a teaser (author, first line, first image) and "Join to see more"; `/feed/[postId]` as the in-app landing. | 3.1, 4.2, 6 (growth) |
| **Story** | Share page + ShareSheet (copy · OS share · QR · send to a chat · stop sharing — every object has the revoke now, 2026-10-27). | OS share from the viewer; deep link to the author's stories. | 3.3 |
| **Chat message / media — "even the chat"** | No Share action; clipboard only. | Long-press → Share (OS share of text / media file) and **Send to a chat** via `ForwardSheet`; a DM itself is not a shareable object (the profile link is the "text me" door). | 2.2, 3.1 |
| **Connect with me** | `/join/[token]` exists. | `sms:` / `mailto:` buttons and QR in `InviteSheet`; invite list + revoke. | 2.5, 6 (growth) |

**What a stranger sees vs. what asks for sign-in (decision 11, the contract every share page implements):**

| Object | Visible without sign-in | Behind sign-in |
|---|---|---|
| Post, public | Full text, every photo, video plays | React, reply, who reacted, comments |
| Post, friends-only (token, Teaser) | Author, first 280 characters, first photo | Rest of text, more photos, video, all of the above |
| Post, friends-only (token, Full) | As public | React, reply, who reacted, comments |
| Story | Poster frame with its overlays | Video playback, reply, who saw it |
| Profile ("text me / call me") | Avatar, name, one bio line, interests, "Joined <month>" | Photo strip, posts, work and skills, mutual faces, Message, Call |
| Plan / beacon ("join me") | Host, vibe, date and time, area, note, "a few spots left", Add to calendar | Exact location, who is going, the chat, Join |
| Listing / room | Kind, title, price, first photo, area, posted time, safety note | Remaining photos, poster's trust panel, Message the poster |
| Group | Avatar, name, description, size, area or tags | Member faces, messages, Join / Request to join |
| Call room ("meet over") | "<name> invites you to a video call", audio or video, "3 people are here", time left | Join |
| Connect-with-me invite | Inviter avatar and name | Connect |
| Chat message / media | n/a — OS share sends the text or file itself; "Send to a chat" needs the app | — |

Rules behind the table: **show the thing, hide the people, gate the action.** `profile_visibility` (Wave 6) can reduce the profile teaser to avatar + name. Ghost groups and DMs are never shareable objects. The token carries `preview: teaser | full` for non-public objects; public objects have no switch.

**Common plumbing to build once (Wave 4.2 + 6 growth, about 2 days):**
- ✅ **built 2026-10-27 (Slice C)** except the Teaser/Full switch, which is wired but hidden until non-public minting lands — One `ShareSheet` component (Copy link · OS share via `navigator.share` with clipboard fallback · QR · Send to a chat · Revoke link · **Preview: Teaser / Full** for non-public objects) mounted on every object above; retire the five `copyShareLink` callers.
- **Inline sign-in on share pages:** tapping a gated element opens the login / register sheet over the page (passkey, password, QR hand-off) and the page re-renders in place with gates removed; the redirect form (`/register?next=`) stays as the fallback for crawlers and no-JS.
- ✅ **2026-10-27 (Slice D):** share pages end in one gated CTA; `deepLink()` lands ON the object via the new routes `/feed/[postId]`, `/local/[listingId]`, `/local/b/[beaconId]` (the Local tab body is `LocalTab`; `/local` keeps `?l=`/`?b=`). Still to come: `/call/[token]` (phase 5), public `/u/[username]` (phase 6).
- ✅ **2026-10-27 (Slice D):** token-scoped minting for non-public post/plan/listing — the OWNER mints with a Teaser/Full choice stored on the token (default teaser); the page is trimmed server-side and the media proxy serves only what the page lists; the ShareSheet asks Teaser/Full BEFORE minting for non-public objects. Still to come: the post-login re-check that turns "outside the audience" into a request (phases 2/3 request flows + the inline sign-in sheet, Slice E). `DELETE` + auto-revoke on narrowing kept (listings revoke on narrowing; post and plan audiences are immutable, delete/cancel revoke).
- ✅ **2026-10-27 (Slice D):** `noindex` on every token page + `app/robots.ts` disallowing `/p/`, `/s/`, `/join/`, `/api/`. OG meta was already on every share page.
- Rate-limit unauthenticated media streaming on token pages (already share-token-gated for `/p/`).

---

## 2. Wave 0 — docs and copy that lie (hours, no migration)

Do this first or alongside Wave 1; every item is a string.

**docs/**
- `FEATURES.md:15` #9 claims "muting" — mark planned until Wave 1.6 lands. `#48` "group admins" (no UI). `#41` room "looking for" direction. `#42` place reviews feed venue polls. `#54` "warn" outcome and "documented in the instance's privacy note". `#15` "Public profile pages" (member-only today). `#60` "every avatar anywhere → profile" (six components have no link). `#79a` "draggable emoji stamps" (tap-to-place, `scale:1`). `#79d` public groups "moderated/reportable" (takedown enum excludes conversations).
- `FEATURES.md` underclaims: **#97** multi-story and **#105** call layouts are shipped but listed under 📋; **#110** "non-users can PLAY videos on share pages" already works.
- `API.md`: `:763` all-off sentence (decision 5); `:1647`/`:1663` admin export "for deletion requests" / "Neither deletes anything" (no delete exists); `:1654` privacy note; `:2622` client "completes the deep link back to the object" (it cannot); `:2655-2657` member_count (decision 4); `:611`/`:2859` "CLI reset remains the operator path"; §1.65 has no roulette-scope rule (and the code has the bug); `:1374`, `:3078-3082` describe mute behaviour nothing can trigger.
- `ADR-013:118` privacy note; `ADR-013:53` "admin never reads private message content" needs the "policy, not encryption" qualifier wherever it is surfaced to users. `ADR-020:67-69` member_count.
- `SPECS.md:130` 79d "PUBLIC = appears in discovery" (unimplemented); `:287` #110 OS share sheet (ShareSheet on post/plan/listing/story/group since 2026-10-27; profile pending Wave 6); `~:247` layouts "remembered per user" (not persisted).
- `PSYCHOLOGY.md:13, 39-41` §5 "Build (v0.3)" items (food poll, hype prompt, Go Deeper, Plan Mode) read as shipped — mark planned. Add the two bans from decision 8.
- `DESIGN-HANDOFF.md:113` claims jump-to-bottom pill, mute row, and the removed undo pill; `:128` claims ⋯ delete/report/share on posts.
- `SYSTEM-MAP.md:69` "participants, mute, disappear TTL".
- `TROUBLESHOOTING.md:26` stale-shell "reopen twice" — rewrite after Wave 4.
- `apps/server/src/modules/conversations/routes.ts:579` comment "transfer/deletion is future scope".

**In-product copy**
- `constants.ts:1037-1065` FEATURE_DIRECTORY: 12 "Try it" links go to `/`, 3 to `/settings`, Beacons/Rituals to `/plans` (a bare redirect), Stories to `/feed` (no tray). `constants.ts:1011` tour promises polls; `:1018` tour step anchors `tab-plans` (no such tab); `:1029` tour copy points Stories at Profile.
- `login/page.tsx:464` "Settings → Security" (page is "Devices & security"); `:685` QR door at phone width; `:694` and `register/page.tsx:175` "Join the fun" hides the verb.
- `ChatInfoSheet.tsx:965` role chip "Mod" → "Admin". Add-people error copy tells admins to "share an invite link" when private groups have none.
- `StoriesStrip.tsx:206` "Friends see it" (actual audience: connections + anyone ever DMed).
- `Composer.tsx:849` placeholder "Message… try @" in 1:1 DMs.
- `FeedView.tsx:341` end card "You're all caught up" for zero-connection accounts; `connections/page.tsx:208` "No more requests" for accounts that never had one.
- `settings/help/page.tsx:220-224` no about/version/operator/legal line (`GIT_COMMIT` exists in `config.ts:43`).
- `settings/security/page.tsx:880` "(localhost)" dev-speak; recovery "generated 3:58" with no date; "Authenticator codes OFF" + "Turn on".
- `settings/calls/page.tsx:258` "Call history is coming soon." (delete now or ship #102).
- `InviteSheet.tsx:67` "Revoke one" names a button that does not exist.
- `PushExplainer.tsx:113-115` lists 4 of ~20 push triggers.
- `BoardView.tsx:267` "Plans are the live cards up top" on a chip that filters to nothing.
- `u/[username]/page.tsx:526` "Only you see this line." (counters ride `UserPublic`).
- `gallery/page.tsx:111, :183` same sentence twice, links Stories to `/feed`.
- `bored` `cmd_backup` prints a DB-only dump as "backup".

---

## 3. Wave 1 — the P0 floor (legal, safety, account, mute). ~2 engineer-weeks

Everything here is "a user hits it in the first hour" or "operator liability". Order within the wave is the audit's.

### 1.1 Legal and consent surface (1 day)
- `/terms`, `/privacy`, `/guidelines` pages rendered from operator-editable markdown in `InstanceSettingsSchema` (`packages/shared/src/api.ts:2906-2910`, currently `invites_enabled`, `release_notes`, `auth` only), with a shipped default that states: email, IPs for 90 days, messages and media stored in plaintext; no admin route reads chats but chats are not E2EE and the operator holds the database; what a report forwards; no ads, no contact sync.
- `operator_contact` field in instance settings (used by the 403 screen, About block, appeals).
- Consent sentence + age checkbox in `RegisterRequestSchema` (`api.ts:783-795`) and `register/page.tsx`; store `terms_accepted_at` / `age_attested_at` (migration **0015**).
- "Hosted by <operator>" and three lines of what the app is on auth pages; About block in `settings/help`.
- `noindex` meta on `/s/[token]` share pages + `public/robots.txt`.

### 1.2 Account lifecycle (2 days, migration 0015)
- `DELETE /api/users/me` — password re-proof, `scheduled_deletion_at` with 7–14-day grace, cancel-on-login, then tombstone + cascade (profile, posts, listings, beacons, stories, media refcounts, sessions, push). Admin "delete user" action beside suspend/ban. Optional reason survey.
- `PATCH /api/users/me/email` — re-proof, nulls `email_verified_at`, verify link when SMTP ever lands. `UpdateMeRequestSchema` (`api.ts:855-865`) has no email today; `settings/account/page.tsx:225-227` renders it as an unlabelled grey line.
- `POST /api/auth/logout-all` reusing `revokeOtherSessions()` (`auth/service.ts:113`, helper exists since 06dfc91) + a "Sign out all other devices" button on the Devices page.
- `GET /api/users/me/export` reusing the admin export job plus `profile_entries`/`profile_media` and message bodies.
- Deactivate / pause (self-serve on `suspended_at`) — standard tier, can slip to Wave 6.
- Rename `/settings/account` to "Edit profile"; build a real Account page: username row with a reason it is locked, labelled email with Verified/Change, Change password (move here or link), Download my data, Delete account in danger red at the bottom.

### 1.3 Login that tells the truth (afternoon)
- `login/page.tsx:148-154` branch on 403 `account_suspended` / `account_banned` with the operator contact as the appeal path (server already returns them, `auth/routes.ts:114-118`); an unauthenticated "request a review" form that lands in Support.
- `?reason=revoked|expired|suspended` banner on every bounce (`connection.ts:160-175` 4401 → `authed=false` today).
- Surface `Retry-After` in `ApiError` (`lib/api.ts:5-13` discards it) and fix every "try again in a minute" string.
- Inline "Forgot password?" → recovery code route + operator contact; hide the QR door on touch-only devices (`login/page.tsx:685`); static wordmark on `/login`, `/register`, `/join` (`AuthScene.tsx:34,104`).
- Real Deny on the login-approval sheet (`link/[code]/page.tsx:59-63` is a client no-op; no deny route in `links.ts`).
- Debounced `GET /api/auth/username-available` + inline rules (3-24, a-z0-9_, 8-char password) + Display name marked optional.

### 1.4 A sign-out that signs out (1 day)
- `logout()` (`connection.ts:117-127`) clears `messages`, `conv_meta`, `outbox`, `seen_fx` stores (`db.ts:33-46` — add a clear-all), calls `disablePush()` (route exists), and goes through `confirmDialog` mentioning unsent queued messages.
- Nullable `session_id` on `push_subscriptions` (migration 0015) so remote session revoke kills that browser's push.
- `sw.js:165` stop showing notifications when the device has no session.

### 1.5 Reporting that can be triaged (1 day)
- `reason` enum on reports (`spam, harassment, hate, nudity, self_harm, scam, impersonation, underage, off_platform, ip, other`), required pick in `ReportSheet.tsx:37`, column on `reports` (0015).
- Add `post`, `comment`, `story`, `listing`, `group` to `ReportKindSchema` (`api.ts:1288-1295`), `reports/routes.ts`, `ReportSheet.tsx:22-26`, `reports.target_listing_id` etc.; `ADMIN_CONTENT_TYPES` (`constants.ts:1240`) gains comment/story/message/overlay so takedown acts on a reported id.
- "Also block @user" checkbox; `GET /api/reports/mine` (received → reviewed) shown under Settings → Privacy; admin queue lanes by reason; `legal` in `SUPPORT_CATEGORIES`; a formal `warn` outcome delivered via `sendSupportMessage` (so FEATURES #54 stops lying); report-to-suspend shortcut in the queue.
- Null `reports.reporter_ip` in `jobs/gc.ts` retention sweep (schema comment at `schema.ts:971` promises it).
- Rate limits: `fixedWindow` on message POST (`MESSAGE_RATE_PER_MINUTE`), comments (`feed/routes.ts:566`), reactions (`:497`), comment reactions (`:682`).

### 1.6 Mute end to end (1 day)
- `PATCH /api/conversations/:id/mute { until: iso | null }` writing `conversation_participants.muted_until` (`schema.ts:391`, exists since 0000; readers in `pushGuard.ts`, `jobs/push.ts`, `dto.ts`, `sounds.ts:428` — zero writers).
- Mute row (8 h / 1 week / Always / Unmute) at the top of `ChatInfoSheet`; same action from the chat-row long-press sheet (Wave 2.4); muted-bell glyph + greyed badge in `ConversationListView`; test beside `test/v05.integration.test.ts`; API.md §1.4; then correct FEATURES #9 and SYSTEM-MAP.

### 1.7 Who can message me + requests inbox (2 days, migration 0014)
- `users.dm_policy` (`everyone | connections | nobody`; **landed in 0014: default `connections` for NEW accounts, and every pre-existing account backfilled to `everyone`** — owner decision 2026-10-27, so nothing closes on anyone silently once this is enforced; the `anon_messages` precedent) enforced at `POST /api/conversations {type:'dm'}` (`conversations/routes.ts:153-164`, checks blocks only) and call creation, 404-shaped like blocks; match and roulette DMs exempt.
- `conversation_participants.accepted_at` so a stranger's first DM parks in a Requests row pinned atop the chat list with Accept / Delete / Block / Report; no receipts, ring or typing before acceptance; stranger banner inside the chat.
- `PickerRow`s on Privacy for dm_policy, who-can-send-requests, discoverable-by-search, appear-in-suggestions.

### 1.8 Age gate enforcement + stranger safety copy (1 day)
- `PUT /api/discovery/optin` and roulette join refuse accounts without `age_attested_at` (403 `age_attestation_required`); one-time consent sheet before the first "Make me discoverable" (`DiscoverySection.tsx` has none); `LISTING_SAFETY_NOTE` as a one-line strip on OptinSheet, MatchOverlay, RouletteBanner, BeaconDetailSheet and `SharePageView.tsx` (only `ListingDetailSheet.tsx:462` renders it).
- DM safety rows in `ChatInfoSheet` (identity hero → Mute → Report user · Block · End chat via existing `DELETE …/participants/:me`; suppress the `participant_left` system message for DMs at `routes.ts:598-615`).
- Block from the profile page goes through `confirmDialog` (`u/[username]/page.tsx:136-147` calls `api.put` directly).

### 1.9 Small P0 bugs (half day total)
- Strip `beacons_created`/`beacons_sparked` for non-owners in `userPublicDto` (`api.ts:246-247`, `dto.ts:209-210`) — a rule-3 leak under "Only you see this line".
- Roulette pairs "My area" users instance-wide: scope predicate in `discovery/service.ts:209-221` + integration test next to v06:582 + API.md §1.65 line.
- Coarsen `formatLastSeen` (`lib/format.ts:18-26`) to "active today / this week"; `appear_offline` honoured in `ws/gateway.ts:550-562, 861`; stop `/u/` showing "last seen 43m ago" with default Everyone.
- Watch-together gated like typing for channels/ghost groups and host id masked (`gateway.ts:725-760`).
- Three one-line story filters: author-facing block set at `stories/service.ts:130` and `routes.ts:336`; `banned_at IS NULL` in `loadOverlayRowsFor` (`service.ts:63`) and `sharepages/service.ts:290-296`.
- `registration_mode: open | invite_only | closed` in `InstanceSettingsSchema`, enforced in `POST /api/auth/register`, surfaced on admin settings.
- `./bored backup` either includes MinIO or prints "DATABASE ONLY — media is not included" in red.

---

## 4. Wave 2 — chat and groups table stakes. ~1.5 weeks, mostly client

### 2.1 Conversation rendering pass (2 days, `ChatView.tsx`, `chat.module.css`, `globals.css`, `lib/format.ts`)
- Day pills (sticky, reuse `.system`); same-sender clustering within ~5 min (tail + stamp on the last bubble, 28 px avatar on the first incoming bubble of a group run, per-user hue for sender names).
- "N unread messages" divider from `last_read_seq` (31836af already scrolls there) + floating ↓ pill with count when `stickRef` is false.
- One time formatter: `hour:'numeric'` (today), weekday ≤7 d, else date; kill `formatClock` "03:47 PM" vs `formatTime` "3:47"; comment/feed/list share it.
- Tokens: light `--bubble-in: #ffffff` + 1 px shadow (today 1.04:1), dark `#2a3042`; `--on-bubble-out` / `--on-bubble-out-muted` for every string inside `.own .bubble` (`expression.module.css:939` TTT "Your turn" at 1.15:1, `beacons.module.css:873` poll meta 2.94:1); delivered/read ticks use one colour language with the list.
- Group snippet "Arjun: …" prefix (`format.ts:90`, `ConversationListView.tsx:203`); typing moves into the header subline (`ChatView.tsx:835` row shifts layout); `ListingReviewNudge` moves inside the scroll (`ChatView.tsx:827`); `.meta` ≥11.5 px.

### 2.2 Long-press menu completion (1 day)
- Copy (no clipboard call in `ChatView.tsx` today), Delete for me (`message_hides(conversation_id, seq, user_id)` 0015, filtered in list + sync), Share via `navigator.share`, Select mode later.
- `onContextMenu` + pointer-event long-press (`ChatView.tsx:1441` is `onTouchStart` only) with a 10 ms vibrate on commit.
- Replace the last `window.alert` (`ChatView.tsx:448`) with an inline "10/10 pinned" in the pinned bar; `confirmDialog` on Sign out; "Delete for me / for everyone" sheet.
- "Delete / clear a DM" as a per-user hide of the conversation row using the same table; silent DM leave.
- Per-message failed state with Retry (`connection.ts:583` silently drops permanently rejected sends); blocker sees "You blocked X" not "Send failed." (`Composer.tsx:351`).

### 2.3 Wire the server halves (1 day, no migration)
- Poll tile and Camera tile (`<input accept="image/*,video/*" capture="environment">`) in `Composer.tsx:524-533`; Gallery/File split; 2-column popover above "+" on desktop; `onPaste`/`onDrop`.
- Group rename from the sheet hero via existing `PATCH /api/conversations/:id {title}` (`routes.ts:308`, zero callers; hero is a static `<strong>` at `ChatInfoSheet.tsx:503`).
- Mount `ChannelMembersSheet` for groups (today only inside the `isChannel` block, `ChatInfoSheet.tsx:542-546`) so admins get Remove / Make admin / Demote via existing `DELETE …/participants/:userId` and `PUT …/role` (`channels.ts:60-64` already accepts group admins); server-side sole-admin guard (named 403 like `owner_cannot_leave`); `title_changed` / `role_changed` / `avatar_changed` system messages; "Mod" → "Admin".
- Read-only description row for ordinary members (`GroupSettingsSection.tsx:189-199` admin textarea only); "N members · created by X" on the hero (decision 4).
- Drafts per conversation in `lib/db.ts` with a "Draft:" label on the row; Enter = newline on coarse pointers (`Composer.tsx:883-886`); auto-grow textarea; linkify bare domains/emails.

### 2.4 Chat-list management (1 day, migration 0015)
- `pinned_at` / `archived_at` on participants; `PATCH /api/conversations/:id/participant`.
- Inline filter field replacing `<Link href="/people">` at `ConversationListView.tsx:81-84`; long-press / right-click row sheet (Mute · Pin · Mark unread · Archive); swipe actions; pinned section; All / Unread / Groups chips; `hash(user_id) % 6` avatar tints (`Avatar.tsx`, `globals.css:608`); animate the unread badge once instead of `pulseGlow … infinite` (`list.module.css:169`); single-row chip for a lone "Your story" ring (`StoriesStrip.tsx:38`).

### 2.5 Close the group join loop (1.5 days)
- Auth-aware `SharePageView` / join page: Join or Request to join calling `joinGroup()` (`lib/groups.ts:35`, zero callers; `SharePageView.tsx:108` sends signed-in users to `/login?next=`); render the 202 "Requested" state with withdraw; `group.join_request` WS frame + push to admins; `pending_requests` count on the conversation DTO; group avatar/description/size on the invite page (`JoinClient.tsx:145-168`).
- Invite list + revoke via existing `GET /api/invites` / `DELETE /api/invites/:id` (`InviteSheet.tsx` only GET/POST); invite QR from `QrCode.tsx`; a `conversation_bans` table checked on invite accept (kicked member walks back in today); admin delete-any-message in groups (`messages/routes.ts:574`); transfer ownership; sender name in group push bodies (`jobs/push.ts:419-446`); "you were added to a group" and listing enquiries push (`messages/service.ts:167` skips sender-less rows).

---

## 5. Wave 3 — feed and stories to the basic bar. ~1.5 weeks

### 3.1 Feed safety + plumbing (3 days, no migration except `edited_at`)
- ⋯ on every card (`FeedView.tsx:988` renders it only when `own`): own = Edit · Share (ShareSheet) · Delete; others = Report · Hide · Block. Comment delete behind long-press + `confirmDialog` (bare "×" hard-deletes today, `:1734`).
- `MediaLightbox` with `items[]` + start index + swipe/arrow keys (`MediaLightbox.tsx:16-27` takes one `src`), used by feed posts/comments (`:1025`, `:1686` are `<a target="_blank">`), chat albums, gallery; pending-video slate instead of the `<img>` branch (`:1022-1027`); "Add images" → "Add photos or video" (`:843`); `BlurhashCanvas` under feed images; `URL_RE` linkify + `PreviewCard` unfurl on bodies; comment timestamps; avatar+name+handle as one profile link; `capture` on the input; character counter; stale-closure attachment cap (`:574-585`); load-failure state with Try again (`:108-124` swallow errors).
- Poll: hide body when `kind=poll` (`:1012` + `:1144` render twice); gate tallies on `voted` (`:1165-1174`); replace hard-coded `#3a4052` (`social.module.css:1484`).
- Composer: Cancel button (`setComposeOpen` only ever `true`, `:165-169`), close + toast on post, Friends lane defaults to list (`:95` `'grid'`), audience row becomes a two-option sheet (`:895-896` flips silently), add tile collapses into a toolbar, localStorage draft.
- `/feed/[postId]` rendering the card + full thread; `post.deleted` and `post.updated` WS frames from DELETE and admin takedown (`ws.ts:346` has only `post.new`); `GET /api/users/:username/posts` so the profile Posts segment stops deriving itself from the first friends-feed page (`settings/profile/page.tsx:85-87`); `ActivityStrip` links to it.
- `PATCH /api/posts/:id` with `edited_at` + "Edited" label; then `saved_posts` bookmarks, `post_comments.parent_id` threads, @mentions on posts/comments, "See more" truncation, per-post comments-off, author sensitive flag + blur, send-into-chat via `ForwardSheet` (needs a message kind + audience-nesting enforcement).
- Quiet count-free dot on the Feed tab when `post.new` / `story.new` arrives (`Tabs.tsx:34` dots Chats/Profile only) — the audit's stated position: user-pulled, build it.

### 3.2 Stories shipping bugs (1 day)
- `stories/routes.ts:366` let the author through when `canvas_mode === 'off'` (403 `canvas_closed` today while `StoryCanvas.tsx:352` shows the tools).
- Mount `StoriesStrip` in `FeedView` (only `ConversationListView.tsx:115` today) and fix the three pointers (`constants.ts:1049`, `:1029`, `gallery/page.tsx:111`).
- Gate Post on `attachment.ready` (`StoriesStrip.tsx:160` posts immediately → 400 `bad_attachment` on the first video); adopt `api.uploadForm` for progress; `<video muted>` + tap-to-unmute + visible fallback when `play()` rejects (`StoryViewer.tsx:211-217`, `:91`); `story.deleted` WS frame from `hardDeleteStory`; delete through `confirmDialog` (not the undo pill); make the "+" add-more badge a real button (`StoriesStrip.tsx:78-87` is an `aria-hidden` span); honour `read_receipts` for story views (`routes.ts:260-277`); `STORY_VIDEO_MAX_DURATION_S = 60`; accept `video/quicktime` and transcode HEVC in `jobs/media.ts` (`-c copy` today); mark #97 shipped.

### 3.3 Stories that can be interacted with (3 days)
- Viewer footer for other people's stories: header avatar/name → `/u/`, Reply opening the DM with a story ref (the #99 seam), ⋯ with Report (kind from Wave 1.5), Mute stories (`hidden_story_authors`), Block; posted-ago in the header; pause on `visibilitychange`; blurhash + next-segment warm-up; swipe gestures; pinch-zoom via `MediaLightbox`.
- Composer: text-only story rendered client-side to 1080×1920 PNG through the attachment path; `capture`; full-frame preview; 9:16 preset in `ImageEditSheet`; `multiple` select → several segments; emoji stamp scale from `OVERLAY_EMOJI_SCALE_MIN/MAX` (`StoryCanvas.tsx:168` hard-codes 1).
- Archive that keeps caption, date, overlays and viewers (sweep keeps pixels only, `service.ts:186-194`); Save own story from the author footer.

---

## 6. Wave 4 — notifications and platform honesty. ~1 week

### 4.1 Notifications (3 days)
- Push on logout (Wave 1.4); `message_preview: full | name | none` in `UserSettings` respected in `jobs/push.ts:42-62, 440-445`.
- `pushsubscriptionchange` listener in `sw.js` (listeners today: install/activate/fetch/push/notificationclick), re-POST on boot when granted, `GET /api/push/subscriptions`, `POST /api/push/test` + button, TTL on beacon/reminder pushes (`jobs/push.ts:123` passes no options; "Starting in 30 minutes" can arrive hours late), `renotify: true`, sender avatar as icon.
- `navigator.setAppBadge(totalUnread)` + `document.title "(3) Bored Chat"` + numeric count on the Chats tab.
- `notify` map in `UserSettings` keyed by user-visible trigger (messages, calls, mentions, plans, requests, waves, anon, support, comments) checked at enqueue; move Wave nudges out of Privacy; one `<Switch>` component; timed pause (DND); All / Mentions-only / Nothing per group; comment-on-my-post as a push trigger that also writes an `activity` row; bell sheet off the Chats topbar listing comments, kudos (make them durable: `beacons/routes.ts:679-695` is POST only), matches, plan changes, requests; new-device login and credential-change notices through `sendSupportMessage` (only recovery triggers it today, `recovery.ts:184`).
- Inline reply / mark-read actions on message notifications; in-page `Notification` fallback for a hidden desktop tab; SW notification on `call.invite` when `document.hidden`; busy reject reason → "On another call" and no missed row (`webrtc.ts:785`); Silence button on the incoming ring; Screen Wake Lock during calls.

### 4.2 Platform (2 days)
- Versioned SW cache name from `GIT_COMMIT` (`sw.js:13` hand-bumped) + "Reload to update" toast on `controllerchange` in `ServiceWorkerRegister.tsx`; Background Sync for the outbox.
- Object routes `/feed/[postId]`, `/local/[listingId]`, `/local/b/[beaconId]` and a fixed `SharePageView.deepLink()` (`:123-135` returns tab roots) + `safeNext()` so a shared post lands on the post after signup.
- `error.tsx`, `not-found.tsx`, `loading.tsx` with one shimmer primitive reused by Chats, Feed, Board (about 95 "Loading…" strings, 0 skeletons); rate-limited `POST /api/client-log` from the error boundary; `Wordmark` on the `AppShell.tsx:34` boot gate.
- Caddy `handle /api/healthz` → api (unreachable from outside today); Referrer-Policy, Permissions-Policy, nosniff beside the existing CSP/HSTS; api/web/worker compose healthchecks.
- Short commit hash in Help and on every support ticket; admin release-notes textarea (`PATCH release_notes` exists, no UI) and seeded notes for v1.0a, #103, v1.1 Royal and the 2026-10-18 batch; `plans_completed` and `dm_started` in admin metrics; durable moderation log table instead of the Redis ring; parsed device names on the Devices page (`describeUserAgent()` exists, `sessions/page.tsx:78-82` prints raw UA + IP); `manifest.json` maskable icon + apple-touch-icon + description/screenshots/shortcuts; `beforeinstallprompt` install card + iOS hint.

---

## 7. Wave 5 — theme, tokens, shell, settings. ~1.5 weeks

### 5.1 Theme and token pass (2 days)
- Design the light palette as first-class (`globals.css:81-85` comment says "not designed"): `--bubble-in #ffffff` + shadow, `--panel-2 ≥ #e6eaf3` (chips 1.13:1 today), `--border #cfd6e4` (1.24:1), light shadow token; delete `#3a4052` and `.warn-text #ffd166` and the `calls.module.css` hexes; `--faint` for hairlines only, readable copy → `--muted` ≥13 px (10 usages at 2.13:1); `.tab` labels `--muted` 11–12 px with a filled active icon and constant weight (2.85:1 today); `.btn:disabled` → outline at 40% + helper (disabled "Post"/"Light it"/"Post story" read enabled at 55% ink gradient).
- `html { font-size: 100% }` + rem ramp with a 12 px floor (0 rem units; OS text scaling does nothing); `--fs-*`, `--r-*`, `--space-*` tokens (27 font sizes, 214 half-px, 23 radii); `themeColor` and `manifest.json` → `#12141c` (ten minutes).
- Appearance page gains text size, motion toggle, name style, OLED/dim; re-shoot every screen in light.

### 5.2 Shell and navigation (1 day)
- Mount `Tabs` in the authed layout, hide only inside `/c/[id]`, viewers and calls (tab bar vanishes on `/u/`, `/new`, `/anon`, `/things`, `/puzzle`, `/welcome`, `/settings`, every sub-page); rail on every desktop route with avatar + gear at the bottom (`Tabs.tsx:17-20` has no Settings entry).
- `router.back()` with a logical-parent fallback for the 25 hard Back links (0 `router.back()` today; profile Back → `/`, Find people → `/connections`).
- `::before { inset: -8px }` on `.iconBtn` 38×38, `.orbBtn` 36×36, `.cardKebab` 28×28, `.layoutBtn` 34×26; 36–40 px pills for "+ LIST SOMETHING" / "+ FIND" / "Copy".
- Rewrite `TOUR_STEPS` (`constants.ts:1012-1030`) to the four real tabs, start only on the Chats root (fires over Devices & security today); fold the five first-run interruptions (recovery codes → /welcome → tour → push explainer → What's new) into one flow; move recovery codes to Settings → Security.
- One labelled 44 px "Rescue" pill on every tab root (🆘 icon on Local, overflow row on Chats, card on Profile, absent on Feed); shared `<Icon>` module (24 px grid, 1.75 stroke) as the first step of retiring 297 emoji-as-chrome; `aria-hidden` on decorative emoji in `<h1>`s.
- One `Sheet` primitive with grabber, detents, sticky footer, `useFocusTrap`, return-focus and `pushState`/`popstate` (51 `aria-modal` sheets, 0 focus traps, Android Back leaves the page); migrate the 25 `*Sheet.tsx`; destructive items in ⋯ menus in red with separators.

### 5.3 Settings and desktop structure (3 days)
- `SettingsGroup` + `SettingsRow`, one `.eyebrow` token (serif uppercase Marcellus has no small caps), one `<Switch>` (three boolean vocabularies today), `PickerRow` → radio sheet (9 native `<select>`s on Privacy); Account = identity + credentials only; fill Chats (text size, Enter-to-send, media auto-download, upload quality, data saver, archived) and Calls (history, ringtone, vibrate — currently under Notifications) or hide them; delete "coming soon"; Appearance absorbs mood effects / avatar motion / name style; "Edit profile" gets one Done button + dirty flag + "Discard changes?" (three save models, silent loss today); About card.
- Desktop: `.page` max-width 760–840 px; second pane at ≥1100 px for Feed (opened post) and Local (beacon/listing detail); two-pane Settings at ≥900 px; horizontal profile header; a handful of global shortcuts; tablet breakpoints 600–899 px; 360 px pass.
- Chat settings sheet reordered: identity hero + call buttons → Mute · Search · Media · Disappearing · Pinned → Appearance collapsed → Clear · Block · Report · Leave; "Only you see this" once.

---

## 8. Wave 6 — standard parity (the audit's seven-week block, minus what Waves 1–5 already cover)

- **Calls that leave a trace (2 days):** `call_ended` (with `duration_s`) and `call_failed` system messages beside `call_missed` (`calls/service.ts:192`), rendered next to the call-back card; `GET /api/calls` + `/calls` page All/Missed (#102); faces on the Join chip from `participant_ids`; live-call chip on list rows; `call.media {mic, cam}` frame; who-can-call follows `dm_policy`; **call links** per §1b (`POST /api/calls/links`, `/call/[token]`, personal `/u/[username]?call=`); then audio→video upgrade with consent (#104), `getDisplayMedia` screen share, pre-join lobby, device picker / `setSinkId`, voice-note lock + listen-back, `getStats` quality bars, hide-IP relay toggle.
- **Stop shipping full-size media (2.5 days):** 2048 px client downscale in `imageUpload.ts` behind "Send original"; server max-dimension cap in `pipeline.ts:181`; one ffmpeg 1080p H.264 leg in `jobs/media.ts:190-196` (remux only today); upload cancel + retry; Upload quality and Data saver settings; per-chat Media / Links / Files tab; 2–4 attachments as an album grid; alt text + sensitive flag on attachments; GIF animation (`pipeline.ts:179` `animated:false`); video autoplay preference.
- **Private account, mute-a-person, discoverability (1.5 days):** `users.profile_visibility`, hidden-authors list enforced in feed/stories/tray queries, opt-out of name search and suggestions (authenticated prefix search enumerates everyone, `users/routes.ts:114-134`), who-can-send-requests, restrict/ignore, hidden words.
- **One `ProfileView` + real profile content (3 days):** one component for `/settings/profile` and `/u/[username]` with `isMe` swapping the action row; bio always rendered (hidden on the own tab whenever activity exists, `settings/profile/page.tsx:228-236`); Posts/Pics segments; `created_at` → "Joined Oct 2026"; pronouns, links, verified chip from an operator flag, role/tenure badges, mutual faces (query exists in suggestions); `/u/` links in `StoriesStrip`, `StoryViewer`, `SeenBySheet`, `ChannelMembersSheet`, `PollView`, `UserSearch`; call buttons; HEIC avatar (`maybeConvertImage` import + `image/heic` in `AVATAR_SOURCE_MIME_ALLOWLIST`); drop the cover band or build it from the blurred avatar; ring only with a live story; profile share link + QR + "Copy @username" (#110, `QrCode.tsx` exists); `generateMetadata` with a logged-out hero; one People page (Requests · Your people · Suggestions).
- **A board people will use (5 days):** `sell` and `lost_found` kinds in `LISTING_KINDS` (`constants.ts:459`) with numeric price/currency/Free/condition/close reason; `POST /:id/renew`; close reason on every kind ("Sold" instead of a 410); room `direction`; posted time, excerpt, location, placeholder tile on `ListingCard`; sort/filters; bookmark; drafts per kind in localStorage; reorder photos; review reply/edit/report; "who asked" for all kinds (`GET /:id/contacts` exists); board search over body, gig tags, ride legs (`listings/routes.ts:232` is title + place only); delete the dead "Plans" chip; "Pick a time" chip on the beacon create sheet exposing the edit sheet's datetime pickers; `BEACON_MAX_HORIZON_S` 7 → 45 days; optional title; `max_joiners` independent of `spark_threshold` (410 `beacon_full`; threshold doubles as cap today); `GET /api/beacons/:id/calendar.ics` + "Add to calendar"; invite specific people; co-hosts; exact location only to joiners (`BeaconDetailSheet.tsx:186-189` shows it to the whole audience); ritual paused state + resume; `areas` table seeded from existing values with autocomplete and case folding; vibe/date filter on `GET /api/beacons`; Local hierarchy (full-width primary "I'm bored", sticky segmented Plans · Bored now · Board, search above chips, edge fade).
- **Discovery card worth waving on (1.5 days):** `media` on `DiscoveryCardSchema`, profile link from the card (#106), server-side `discovery_passes` with undo (pass is a local Set today, `DiscoverySection.tsx:308`), `lower()` fold on interest overlap (`discovery/routes.ts:99`, `suggestions/routes.ts:54`), interests chip-grid + `INTEREST_PRESETS` at onboarding, non-algorithmic shuffle once >50 opt-ins, post-meet check-in, share-my-plan with a trusted contact, review/undo dismissed suggestions, `/welcome` invite card (`welcome/page.tsx:93` mounts `SuggestionCards` without `showEmpty`/`inviteCard`).
- **Quiet security gaps (1.5 days):** the three v0.9 auth-audit minors still listed in `HANDOFF.md` (passkey counter update should be `GREATEST`/conditional, `passkeys.ts:288-291`; equal-cost dummy consume for unknown users on `/api/auth/recover`, `recovery.ts:175`; mint the reset token before revoking sessions and notifying, `recovery.ts:181-196`); step-up re-auth for passkey add/delete and TOTP enable; per-account lockout (`login:${ip}` only); dummy argon2 verify for unknown users; reserved usernames (`admin`, `support`, `boredchat`, `moderator`, `help`, `security`); require UV on passkey assertion when the credential reported it (`passkeys.ts:107, 270`); `needsRehash` on login; credential-change notices; password strength + common-password list (`min(8)` only, also on the new change-password sheet); `SESSIONS_MAX`; app lock (PIN / WebAuthn re-auth with idle timer); anti-bot challenge at register.
- **Growth plumbing the ethos allows (3 days):** ~~`navigator.share` with clipboard fallback at the five `copyShareLink` callers~~ ✅ done 2026-10-27 (`ShareSheet.tsx`; `copyShareLink` is gone); `sms:` / `mailto:` buttons in `InviteSheet`; install prompt; branch the feed end card on connection count; contacts import per decision 2; `/compose` share-target into a post or story.
- **Operator controls (1.5 days):** admin UI for instance settings beyond invites; durable moderation log; `plans_completed`/`dm_started`; report-to-suspend shortcut; device/IP bans later; admin console at phone width (`admin.module.css` has 0 `@media`).

---

## 9. Wave 7 — differentiating (finish what is already ahead)

1. A beacon inside an existing group (`conversation_id` on `BeaconCreateSheet`), co-hosts, host approval of joiners, guest-list visibility, monthly rituals, ride linked to a plan.
2. The 2–3-per-day named-faces digest on the `activity` table (reactions, comments, kudos, plan changes, requests) — this is what makes API.md §1.13 true (decision 5).
3. Story audiences and replies (#98, #99): Everyone / Connections / Close friends / Hide-from; reply into the DM quoting the story; quick reactions as faces; canvas before publish (drag, resize, rotate, eraser, undo); Highlights from the real archive.
4. Places and recommendations: `places` entity, "Priya and 3 friends recommend", area-scoped lane, "ask for recommendations" post kind, pull-only notices kind, self-hosted OSM tiles per decision 9.
5. Co-watch of self-hosted MP4 (decision 3), listen-together, LiveKit SFU when mesh ≤8 is the limit.
6. Search (#108): people, public groups, listings, messages; public group directory by area (`conversations.area`).
7. Mailer → email verification, forgot-password, magic link, OTP (admin toggles already persist, SPECS 175-180); then E2EE for DMs; i18n before the component count grows further.

---

## 10. Migrations 0014 / 0015 — everything above that needs a column

`users.terms_accepted_at`, `users.age_attested_at`, `users.scheduled_deletion_at` / `deleted_at`, `users.dm_policy`, `users.profile_visibility`, `users.appear_offline`, `users.discoverable`; `push_subscriptions.session_id` (nullable); `reports.reason` enum, `reports.target_listing_id` / `target_post_id` / `target_comment_id` / `target_story_id` / `target_conversation_id`; `conversation_participants.pinned_at`, `archived_at`, `accepted_at`; `message_hides(conversation_id, seq, user_id)`; `conversation_bans`; `posts.edited_at`; `post_comments.parent_id`; `saved_posts`; `discovery_passes`; `activity`; `beacons.max_joiners`, `beacons.title`, `beacons.guest_list`; `instance_settings` keys (`registration_mode`, `operator_contact`, legal markdown). Split into 0014/0015 by wave if preferred, but never reuse 0013. **Split taken (2026-10-27):** `0014_share_plumbing.sql` carries only `share_tokens.preview`, `users.dm_policy`, `users.profile_visibility` (the §1b build); everything else above goes in `0015` with Wave 1.

---

## 11. Suggested sequencing

| Week | Work | Why this order |
|---|---|---|
| 1 | Wave 0 docs/copy + Wave 1.1–1.4 (legal, account lifecycle, login truth, real sign-out) | Operator liability and the four things every benchmark has |
| 2 | Wave 1.5–1.9 (report taxonomy, mute, who-can-message + requests, age gate, small P0 bugs) | Safety control layer before any new public surface |
| 3 | Wave 2 (chat rendering, long-press, server halves, chat-list, join loop) | Mostly client, no new tables beyond 0015 |
| 4 | Wave 3 (feed safety + plumbing, stories bugs, story viewer) | Feed is 22/68 and stories 14/42, the weakest areas |
| 5 | Wave 4 (notifications, SW, object routes, error pages, ops honesty) | Makes push and deploys trustworthy before more users |
| 6–7 | Wave 5 (theme/tokens, shell, sheets, settings, desktop) | Re-shoot light screens only once the palette is designed |
| 8–13 | Wave 6 in the audit's own order (calls trace, media sizes, private account, ProfileView, board, discovery, security, growth, operator) | Standard parity |
| after | Wave 7 | Differentiators finished properly |

Verification bar per CLAUDE.md applies to every wave: `pnpm -r build`, server suites one file at a time on live Postgres/Redis, Playwright at 390×844 and 1280×800 in **light** scheme (the audit's screenshots were all light), API.md updated with every route, FEATURES.md flipped only when code exists.
