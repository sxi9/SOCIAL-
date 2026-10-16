# Bored Chat — Psychology-Backed Feature Brief

## The 10 that matter

1. **Never show the bored user a waiting screen.** Boredom is attention looking for something to grab — the bored person is already motivated to engage (Eastwood et al. 2012, *Perspectives on Psychological Science*). **Build (v0.3):** after the Beacon tap, go straight to active micro-tasks — vibe chips, spark threshold, pre-building the plan card — never a spinner or "waiting for friends" state.

2. **A plan isn't a plan until it has a time, place, and names.** Scheduling concrete social activity measurably lifts mood (behavioral activation: Ekers et al. 2014 meta-analysis; Richards et al. 2016 trial), and explicit "when X happens, I'll do Y" plans raise follow-through by a medium-to-large margin (Gollwitzer & Sheeran 2006, 94-study meta-analysis). **Build (v0.3):** a sparked Beacon isn't "confirmed" until time + place are locked; each joiner gets a one-tap personal reminder written in that if-then form.

3. **Show faces, not counters — and ping at "one more needed."** People join once enough others visibly have, and named early joiners tip the cascade (Granovetter 1978). Natural conversations cap at about four speakers (Dunbar et al. 1995). **Build (v0.3):** avatars of who's in plus "needs 2 more"; re-notify when one short; default thresholds yielding groups of 3-5; nudge big groups to split into squads.

4. **Give every plan named micro-roles.** Effort evaporates when contributions pool anonymously ("social loafing") and returns when each person's part is visible (Karau & Williams 1993, 78-study meta-analysis). **Build (v0.3):** tappable roles on the plan card ("Priya books the table") with per-person done states; no anonymous "3 people are handling it."

5. **Treat the wait before a plan as a feature.** Looking forward to an experience generates real happiness before it happens (Kumar et al. 2014, *Psychological Science*). **Build (v0.3):** "tonight / tomorrow / this weekend" chips so plans land 1-3 days out; countdown header, food poll, and at most one hype prompt per plan per day.

6. **Calm defaults for receipts and notifications.** "Seen" indicators create pressure to reply, worst for anxious users (Mai et al. 2015); batching non-urgent notifications improved mood and focus, while going fully silent backfired into anxiety (Fitz et al. 2019, randomized field experiment). **Build (v0.3 privacy):** reciprocal, per-chat read receipts with no "seen 43 min ago" timestamps; real-time delivery only for messages and live invites; reactions/recaps in 2-3 daily digests; settings offer "digest," never "all off."

7. **Rituals are the retention engine — built as forgiving calendars.** Repeated exposure is how acquaintances become friends (Zajonc 1968; Bornstein 1989 meta-analysis; Festinger et al. 1950 housing studies). **Build (v0.3):** one-tap "make it a ritual" after a good plan; history counts up as a scrapbook ("12 chai nights since March"); a skipped week produces silence; auto-pause after two skips.

8. **Recaps: lead with the peak, end on the last laugh, offer "Run it back."** Experiences are remembered by their best moment and ending, not their length (Redelmeier & Kahneman 1996), and nostalgia restores the sense of meaning boredom drains (van Tilburg, Igou & Sedikides 2013). **Build (v0.4 expression):** auto-build recaps peak-first, people-first; resurface one past recap to bored users with a one-tap re-Beacon of the same crew.

9. **Tell people they were liked.** After conversations, people reliably underestimate how much others enjoyed them — the "liking gap" (Boothby et al. 2018). **Build (v0.3):** post-hangout one-tap "glad you came," delivered privately; show the creator "3 people were glad you posted this."

10. **Calibrate stranger fear with the app's own data.** People wrongly predict talking to strangers will be unpleasant; it's reliably better than expected (Epley & Schroeder 2014; replicated). **Build (v0.6 discovery):** private "better or worse than expected?" tap after public beacons; show hesitant users the true aggregate ("87% said better than expected").

## Design rules
1. North-star metric is plans completed offline and conversations started — never minutes-in-app or scroll time (Ryan & Deci 2000; Ekers et al. 2014).
2. FoMO-safe by construction: a Beacon is visible only to people who can still join; recaps stay in the plan group unless participants opt in; never notify anyone about a hangout they can't join (Przybylski et al. 2013).
3. Approval signals name people, never scores: no follower counts, like tallies, public view counts, or leaderboards (Sherman et al. 2016).
4. User-pulled, not app-pushed: the user initiates ("I'm bored"); no unprompted "start a Beacon!" nudges, no XP or points — external rewards crowd out the intrinsic fun (Ryan & Deci 2000).
5. Broadcast surfaces (feed, stories) are finite and interaction-first: a hard "you're all caught up," every card leading with reply/plan actions (Verduyn et al. 2015; dichotomy caveated by Valkenburg et al. 2022).

## Never build
- **Streak counters or loss-framed ritual warnings** — streaks turned friendship into daily obligation and guilt (Hristova et al. 2022; small qualitative study, clear mechanism).
- **Teaser notifications, withheld-then-released alerts, pull-to-refresh** — the slot-machine reinforcement schedule (Ferster & Skinner 1957; app application is an extrapolation, but cheap to avoid).
- **Infinite scroll / auto-advancing stories** — passive scrolling lowered wellbeing via envy in experiments (Verduyn et al. 2015).
- **"Seen X minutes ago" timestamps** — the timestamp converts a receipt into a response deadline (Mai et al. 2015).
- **"X and Y are hanging out" pings to non-invitees** — direct FoMO manufacture (Przybylski et al. 2013).

## Weaker but interesting
- **"Go Deeper" question deck** in new plan groups — escalating mutual questions create closeness (Aron et al. 1997; strong evidence, but new scope — v0.5).
- **Plan Mode** — silence the plan chat during the hangout; phones competing during in-person time predict relationship strain (Roberts & David 2016; correlational).
- **Energy selector** ("low-key" vs "let's go out") matching the two kinds of boredom (Westgate & Wilson 2018; newer theory).
- **Weekly weak-tie card** resurfacing one dormant contact — acquaintance chat lifts mood (Sandstrom & Dunn 2014; partly correlational).
- **Fresh-start ritual timing** — suggest rituals starting "next Monday" or "the 1st" (Dai et al. 2014; archival data).
