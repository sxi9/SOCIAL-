# UI handoff checklist — "Gallery and post layouts" (Claude Design, 2026-10-28)

Source: `Gallery and post layouts-handoff.zip` → `design-template.html` (12 layouts, Royal v2 tokens,
390×844 frames). The handoff gives **four alternatives per screen**; alternatives within a screen are
either/or. Rules that apply regardless of pick are listed as "always".

Royal v2 tokens already exist in `apps/web/app/globals.css` (`--panel-2 #232838`, Marcellus + Instrument
Sans self-hosted). New tokens needed: `--danger #ff6b6b`, `--success #4cd4a0`, accent gradient
`linear-gradient(160deg,#fff,#c7cdda)` with ink `#12141c`, sheet radius 24, pill radius 999.

Legend: **[UI]** web only · **[API]** server/contract change · **[MIG]** migration (0021 shipped; next free: 0022) ·
**[PSY]** PSYCHOLOGY constraint · **(confirm)** owner decision.

> **Shipped 2026-10-28 (owner picked the recommended set):** story **2a + 2b + 2c + 2d**,
> comments **1e**, gallery **1a** — API.md §1.79, migration `0021_handoff_ui.sql`
> (`post_comments.parent_id`, `story_activity`). Decisions taken: "Edit" on your own story =
> the caption editor; the canvas toggle flips `canvas_mode` off ↔ open (approve-first is a
> second switch); "Who can see this" is a display-only "Connections" chip (stories have one
> audience); 2c's "Text" tool = the existing Note; "is drawing too" is derived from a fresh
> `story.updated` overlay (no presence protocol); 2d's drifting pills are MY OWN sends only.
> Not built (not picked): 1b, 1c, 1d, 1f, 1g, 1h. The sections below are the original
> checklist, kept as the spec for those.

---

## A. Story viewer (fixes the screenshot: 8 pills in two rows, emoji icons, actions over the caption)

Current: `apps/web/components/StoryViewer.tsx:335-365` own footer = Viewers · Canvas · 🔗 Share link ·
⇪ Share… · 🗑 Delete; `StoryCanvas` adds Draw/Emoji/Note chips on top. Friend footer = Share… · Report.

### Always (any pick)
- [ ] **[UI]** At most 3 visible actions on the own-story screen; everything else behind a "More" sheet.
- [ ] **[UI]** Replace emoji glyphs (🔗 ⇪ 🗑 ⚑) with inline SVG icons; pills `#ffffff14` bg, 1px `#ffffff1f` border, radius 999, 40px tall.
- [ ] **[UI]** Header: avatar 36px, line 1 serif name ("Your story" / "Priya"), line 2 muted "Gone in 10h · Feeling lucky" (the mood merges into the header; the "Lucky" chip at bottom-left goes away), ✕ at right. Progress bars 3px.
- [ ] **[UI]** Caption ("Lol") sits above the action bar, never under it; bottom gradient `transparent → #0a0c11`.
- [ ] **[UI]** Bottom bar padded for safe-area; keep the iOS `.storiesStrip { flex: none }` fix.
- [ ] **[PSY]** Viewers surface shows **named faces only**, never a count ("Seen by Jonas, Priya…").

### 2a — Your story: 3 actions + More  (recommended baseline)
- [ ] **[UI]** Bottom bar: **Viewers** pill (3 stacked 22px faces + "Seen by Jonas, Priya…"), **Edit** pill, **More** circle (⋯).
- [ ] **[UI]** "More" bottom sheet (portal to body, radius 24, handle 36×4): rows **Copy share link**, **Send to a chat…** (= existing ShareSheet), **Canvas — friends can draw on it** (toggle, on = `#4cd4a0`), **Who can see this** (value chip "Connections"), divider, **Delete story** in `#ff6b6b`.
- [ ] **[API]** Canvas toggle per story: today the author enters canvas via `CanvasModeButton`; if no stored per-story flag exists → **[MIG 0021]** `stories.canvas_enabled boolean` + PATCH route. (confirm)
- [ ] **[API]** "Who can see this": reuse the story audience value (DESIGN-PROMPT-V2:64); display-only chip unless audience may change after posting. (confirm)
- [ ] **[UI]** "Edit": the app has no post-publish story edit. Either a caption/mood editor, or drop it and make Canvas the 2nd pill. (confirm)

### 2b — Swipe-up activity drawer (combinable with 2a as the Viewers surface)
- [ ] **[UI]** Swipe-up or tap Viewers shrinks the story to a 150×260 card at top; drawer below.
- [ ] **[UI]** Icon row: Link · Send · Canvas · Delete as 48px circles with 11px labels.
- [ ] **[UI]** "Who saw it" serif list: avatar + name + line ("Reacted 😂 · 2h", "Replied in chat", "Drew on your canvas"). Replaces the current viewers sheet inside StoryViewer.
- [ ] **[API]** Viewer rows need per-viewer activity (reaction emoji, replied flag, drew-on-canvas flag). Check the viewers route payload in `stories/routes.ts`; if it only lists users, extend the DTO with joins on story reactions, canvas strokes and DM replies carrying the story ref. API-only, no migration expected.
- [ ] **[PSY]** No "N views", no seen-at timestamps beyond coarse relative age.

### 2c — Canvas mode as its own state (replaces the chips stacked over the viewer)
- [ ] **[UI]** Entering canvas hides viewer chrome; top row = **Undo** pill · centre "Jonas is drawing too" · **Done** gradient pill (accent gradient, ink text).
- [ ] **[UI]** Right tool rail 52px circles: Draw · Text · Sticker · Note (active = white bg, ink icon). Maps to StoryCanvas Draw / Emoji→Sticker / Note; **Text** is new. (confirm or drop)
- [ ] **[UI]** Left colour dots `#ff6b6b #ffffff #f2c76b #8ee6c2 #9ec3ff` (selected 22px with ring); bottom Brush slider.
- [ ] **[API]** "X is drawing too" presence: strokes already stream over WS; add an ephemeral `canvas.active` signal if absent (check gateway).

### 2d — Friend's story: reply first
- [ ] **[UI]** Header avatar with conic-gradient ring (`#fff, #c7cdda, #fff`), name + "3h · Feeling bored", ⋯ (sheet: Share… / Report / Mute stories) and ✕.
- [ ] **[UI]** Live comment pills drifting up the left edge (DESIGN-PROMPT-V2:64; wire to the live-comment stream if shipped, else build).
- [ ] **[UI]** Reaction row 😂 😮 ❤️ 🔥 👏 (26px glyphs in 44px circles) above the composer.
- [ ] **[UI]** Bottom: "Reply to Priya…" pill composer + **Voice** circle (hold-to-record → voice message to the DM with the story quoted).
- [ ] **[API]** Reactions and text/voice replies must land as DM messages referencing the story. Check `stories/routes.ts` for react/reply routes; if missing → `POST /api/stories/:id/reply {body | attachment_id | emoji}` creating a DM message with story context; likely **[MIG]** `messages.story_id`.
- [ ] **[PSY]** The author only ever sees a named list (2b); nobody sees who did not react.

---

## B. Post comments (`apps/web/components/FeedView.tsx` ~1560–1870, `social.module.css .comment*`)

Current: flat list, `.commentBubble`, named reactions via `CommentReactionAggregate`, "Reply" prefixes `@name` (no threading), one image attachment, no end marker. `post_comments` has no `parent_id`.

### Always
- [ ] **[PSY]** Header line "Liked by Jonas, Priya & you" from the post reaction aggregate (reactors + `mine`); names, never counts.
- [ ] **[UI]** Hard end marker "That's every comment" after the last page (finite feed rule).
- [ ] **[UI]** Composer pill `#1a1e2a`, radius 999, "Add a comment…", own 32px avatar at left; send = accent-gradient circle.
- [ ] **[UI]** Comment row: 32px avatar initials, name 13.5px + "· 2h" muted, body 14px `#c9cdd8`, action row **Reply · Like** + "Jonas liked" (named).

### 1e — Threaded sheet  (closest to today's code)
- [ ] **[UI]** Sheet snaps to 70% (`max-height 600px`) with the post visible behind; "Comments" serif title.
- [ ] **[UI]** One reply level: `margin-left 18px; padding-left 30px; border-left 1.5px #2a2f3e` rail.
- [ ] **[MIG 0021]** `post_comments.parent_id uuid null references post_comments(id) on delete cascade` + index. **[API]** `POST /api/posts/:id/comments {parent_id?}` (one level only: parent must itself have `parent_id null`), `CommentSchema.parent_id`, list ordered parent-then-children; takedown / `hardDeleteComment` cascade.
- [ ] **[UI]** "Reply" sets `parent_id` instead of inserting `@name`.

### 1f — Media-first split
- [ ] **[UI]** Full-bleed 400px photo with overlaid author row + caption gradient; "Jonas, Priya and Leo loved this" faces row.
- [ ] **[UI]** Flat comments in `Name body` style; "View replies to Priya" expanders (needs 1e's `parent_id`).
- [ ] **[UI]** Quick-reaction row ❤️😂😮🔥👏🥲 above the composer (post reactions, existing route) + gradient "Post" button.
- [ ] **[PSY]** The design's "View 2 replies" is a count → "View replies to Priya".

### 1g — Conversation-style (chat bubbles)
- [ ] **[UI]** Reuse the chat bubble system; header "Leo's post" with 36px post thumb; date pill "Today"; "Leo · author" label; own bubbles in accent gradient with ink text; quoted reply block (needs `parent_id`).
- [ ] **[UI]** Reaction chips on bubbles ("🔥 Leo", named); composer "+  Reply to the post…".
- [ ] **[API]** Typing indicator: comments have no typing channel → ephemeral WS `comment.typing` on post rooms, or drop it. (confirm)

### 1h — Pinned to the photo
- [ ] **[MIG 0021]** `post_comments.pin_x numeric(5,4) null, pin_y numeric(5,4) null` (0–1 of the image box; image posts only). **[API]** accept on create, return in DTO.
- [ ] **[UI]** Long-press on the image places a pin and opens the composer ("Hold the photo to pin a comment"); avatar pins 32px, `border-radius 50% 50% 50% 4px`, 2px white border, selected gets a 6px `#ffffff26` glow; "Pins on" toggle pill.
- [ ] **[UI]** List rows "Mei on the window / Jonas on the cat / Ana on the post" (label typed by the author or omitted, no auto-labelling); selected row = highlighted card.
- [ ] Multi-image posts: pins per attachment (needs `attachment_id` on the comment pin). (confirm scope)

---

## C. My gallery (`apps/web/app/gallery/page.tsx`, `globals.css .gallery*`)

Current: `GET /api/users/me/gallery?kind=&saved=&cursor=` → `{attachment, saved, source: 'story' | null}`; CSS grid `minmax(104px, 1fr)` gap 6, radius 10; chips All / Photos / Videos / Saved stories as `.btn`.

### Always
- [ ] **[UI]** Filter chip row: active = accent gradient with ink text, inactive `#232838` pills, horizontally scrollable.
- [ ] **[UI]** Tile radius 8 (grid) / 12 (masonry); ▶ video badge (22px circle); "Story" pill badge `#000000a6` on saved stories; keep `.galleryDelete`.
- [ ] **[PSY]** Private only; no "on this day", no streaks, no counts in headers.
- [ ] **[API]** Every variant except 1a needs an **origin** per item: extend `GalleryItem` with `origin: { kind: 'story' | 'dm' | 'group' | 'post' | 'listing' | 'background', label, href }`, derived from the existing bindings (`message_id → conversation`, `post_id`, `listing_id`, `gallery_saves.source`). One SELECT join in `gallery/routes.ts`, no migration. Tap jumps to `href`.

### 1a — Months with a hero tile  (no API change)
- [ ] **[UI]** Group by `attachment.created_at` month; sticky serif header "October · this month"; 3-col grid gap 4; first tile of each month spans 2×2.
- [ ] **[API]** `created_at` must be in the attachment DTO (check `AttachmentSchema`; add if absent). Cursor paging continues across month groups (grouped client-side).

### 1b — Masonry with origin
- [ ] **[UI]** 2 columns at native aspect (needs `width`/`height` in `AttachmentSchema`; check), radius 12, caption under each tile = `origin.label` ("Story · saved Oct 26", "Sent to Jonas", "Board · bike for sale", "Posted to Feed", "Group · Allotment crew").
- [ ] **[UI]** Header "Filter" pill opens a sheet (replaces the chip row).

### 1c — Rails by where it lives
- [ ] **[UI]** Horizontal shelves: Saved stories (96×160), one per DM/group with photos ("Chat with Priya" 110×110), Your posts (110×110), Board listings (150×100); title + sub + "See all" → scoped grid.
- [ ] **[API]** `GET /api/users/me/gallery/shelves` (first 8 per shelf + scope key). Client-side grouping of the paged list breaks on large galleries, so a server route is recommended.

### 1d — Calendar diary
- [ ] **[UI]** "October 2026" header with ‹ › 36px circles, M–S row, 7-col grid of 44px cells (day number over photo bg, `#1a1e2a` when empty, selected ring 2px #fff); selected-day strip below with label "Saturday 24 · canal ride · chat with Jonas", one 2:1 tile + two stacked.
- [ ] **[API]** `GET /api/users/me/gallery/days?month=2026-10` → `{ day, cover_attachment }` (cover only; no counts) + `?day=` filter on the list route.
- [ ] **[PSY]** Empty days stay plain; no "you missed" states.

---

## Decisions needed before building (handoff README: confirm ambiguity first)
1. Story viewer: **2a** alone, or **2a + 2b** (drawer as the Viewers surface) + **2c** (canvas state)? 2d is independent: build it?
2. What does **Edit** do on your own story (caption/mood editor, or replace it with Canvas)?
3. Comments: pick **one** of 1e / 1f / 1g / 1h. 1e is the smallest step from today's code; 1f and 1g also need 1e's `parent_id`; 1h is a separate pin feature.
4. Gallery: pick **one** of 1a / 1b / 1c / 1d. 1a needs no API change; 1b/1c need `origin`; 1d needs the days route.
5. Migration 0021 contents follow from the picks: `parent_id`, `pin_x/pin_y`, `stories.canvas_enabled`, `messages.story_id`.
