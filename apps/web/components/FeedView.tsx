'use client';

// The Feed tab (v0.5a §1.36 + v0.7 §1.49–§1.52, PSYCHOLOGY design rule 5).
// FINITE by construction IN BOTH LANES: keyset pages to a hard "all caught up"
// end card and STOPS — no wraparound, no ranking, no pull-to-refresh loop.
// v0.7: the Friends | Discover lane toggle (§1.49), the post kind picker
// (text / poll / game / join card, §1.50), inline poll voting (a tally on
// OPTIONS — never approval on a person; ADR-016), open game challenges
// (first tap claims, advisory-locked server-side), join cards riding live
// viewer-resolved summaries, image/GIF comments and comment reactions with
// capped FACES lists (§1.51), and location chips (§1.52). Reactions render
// FACES, never counts; nothing here pings anyone.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type {
  Attachment,
  Conversation,
  CreatePostRequest,
  FeedLane,
  JoinCardSummary,
  Listing,
  ShareLanding,
  Location,
  Post,
  PostAudience,
  PostComment,
  PostKind,
  ReactionKind,
  UploadResponse,
  UserLite,
} from '@socialchat/shared';
import {
  POLL_OPTION_MAX_CHARS,
  POLL_OPTIONS_MAX,
  POLL_OPTIONS_MIN,
  POST_BODY_MAX_CHARS,
  POST_COMMENT_MAX_CHARS,
  POST_MAX_ATTACHMENTS,
  POST_POLL_QUESTION_MAX_CHARS,
  STAMP_REACTION_KEY,
} from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import { HeicUnreadableError, maybeConvertImage } from '@/lib/imageUpload';
import ImageEditSheet from './ImageEditSheet';
import { vibeEmojiOf, vibeLabelOf } from '@/lib/beacons';
import { QUICK_REACTIONS } from '@/lib/emoji';
import {
  addComment,
  addCommentReaction,
  claimGame,
  createPost,
  deleteComment,
  deletePost,
  listComments,
  loadMoreFeed,
  patchCommentReaction,
  refetchPost,
  refreshFeed,
  removeCommentReaction,
  togglePostReaction,
  votePostPoll,
} from '@/lib/feed';
import { formatTime } from '@/lib/format';
import { KIND_EMOJI, KIND_LABEL, listMine } from '@/lib/listings';
import { isSelfDrunk } from '@/lib/mood';
import { ShareButton } from './ShareSheet';
import { getPost } from '@/lib/feed';
import { getShareLanding } from '@/lib/share';
import OutsideAudienceSheet from './OutsideAudienceSheet';
import { toast } from '@/lib/toast';
import * as store from '@/lib/store';
import { useAppState } from '@/lib/useStore';
import Avatar from './Avatar';
import DrunkConfirmSheet from './DrunkConfirmSheet';
import SuggestionCards from './SuggestionCards';
import { LocationChip, LocationField } from './LocationPicker';
import Portal from './Portal';
import ReactionPicker from './ReactionPicker';
import bz from './beacons.module.css';
import st from './social.module.css';
import tb from './topbar.module.css';
import { confirmDialog } from '@/lib/confirm';

const LONG_PRESS_MS = 420;

// Owner fix round: the feed's grid|list layout choice — a per-device
// convenience only (localStorage), never server state.
const FEED_LAYOUT_KEY = 'feed.layout';
type FeedLayout = 'grid' | 'list';

export default function FeedView({
  initialPostId,
  shareToken = null,
  onDeepLinkDone,
}: {
  /** /feed/<id> (§1b deep-link back): open that post in the sheet, whichever
   * lane holds it — fetched on its own, never injected into a lane window. */
  initialPostId?: string | null;
  /** Phase 3: the share token the deep link arrived with — a 404 then asks
   * the landing endpoint whether this is "outside the audience". */
  shareToken?: string | null;
  onDeepLinkDone?: () => void;
} = {}) {
  const state = useAppState();
  const [outside, setOutside] = useState<ShareLanding | null>(null);
  // The deep-linked post lives in the STORE (state.feedExtra), never in a
  // component snapshot: reactions, votes, comments and delete go through
  // replacePost / removePostLocal and must show in the open sheet.
  const [deepId, setDeepId] = useState<string | null>(null);
  useEffect(() => {
    if (!initialPostId || state.authed !== true) return;
    let cancelled = false;
    void getPost(initialPostId)
      .then((p) => {
        if (cancelled) return;
        store.setExtraPost(p);
        setDeepId(p.id);
      })
      .catch(async () => {
        if (cancelled) return;
        // Phase 3: with a live token this may be "outside the audience".
        if (shareToken) {
          try {
            const landing = await getShareLanding(shareToken);
            if (cancelled) return;
            if (landing.state === 'outside') {
              setOutside(landing);
              return;
            }
          } catch {
            /* nothing to ask about */
          }
        }
        if (!cancelled) {
          toast('That post is not available.');
          onDeepLinkDone?.();
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPostId, state.authed]);
  const [lane, setLane] = useState<FeedLane>('friends');
  const [loading, setLoading] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  // Owner ask: the feed renders as a 3-up tile mosaic by DEFAULT; list stays
  // one tap away. Initialized to grid and read from storage after mount so
  // the server and first client render always agree (no hydration drift).
  const [layout, setLayout] = useState<FeedLayout>('grid');
  // Which post is open in the grid's bottom sheet — tracked BY ID so store
  // updates (reactions, votes, new comments) flow straight into the open card.
  const [openPostId, setOpenPostId] = useState<string | null>(null);

  const laneState = state.feed[lane];
  const posts = laneState.posts;

  // First open of a lane loads its window; switching back keeps it.
  useEffect(() => {
    if (laneState.posts === null && state.authed === true) {
      setLoading(true);
      void refreshFeed(lane)
        .catch(() => undefined)
        .finally(() => setLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lane, laneState.posts === null, state.authed]);

  const refresh = useCallback(() => {
    setLoading(true);
    void refreshFeed(lane)
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [lane]);

  const more = useCallback(() => {
    setMoreBusy(true);
    void loadMoreFeed(lane)
      .catch(() => undefined)
      .finally(() => setMoreBusy(false));
  }, [lane]);

  // Pick up the device's remembered layout; grid stays the default whenever
  // storage is blocked or empty (private windows, cleared site data).
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(FEED_LAYOUT_KEY);
      if (saved === 'list' || saved === 'grid') setLayout(saved);
    } catch {
      /* storage blocked — stay on the grid default */
    }
  }, []);

  const pickLayout = useCallback((next: FeedLayout) => {
    setLayout(next);
    try {
      window.localStorage.setItem(FEED_LAYOUT_KEY, next);
    } catch {
      /* storage blocked — the choice just doesn't persist */
    }
  }, []);

  // Escape closes the grid's post sheet (the ✕ and a backdrop tap do too).
  useEffect(() => {
    if (openPostId === null && !deepId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSheet();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPostId, deepId]);

  // The sheet renders the LIVE store post; a post that leaves the lane
  // (deleted, lane switch) simply unmounts the sheet. A deep-linked post
  // reads from state.feedExtra (a lane copy wins when one holds it); once
  // deleted it leaves feedExtra too, so the sheet closes like any other.
  const openedPost =
    openPostId === null
      ? deepId
        ? ((posts ?? []).find((p) => p.id === deepId) ?? state.feedExtra.get(deepId) ?? null)
        : null
      : ((posts ?? []).find((p) => p.id === openPostId) ?? null);
  const closeSheet = () => {
    setOpenPostId(null);
    if (deepId) {
      store.clearExtraPost(deepId);
      setDeepId(null);
      onDeepLinkDone?.();
    }
  };
  // A deep-linked post deleted from inside its sheet leaves the store (lanes
  // and feedExtra) and the sheet unmounts — finish the deep link's
  // bookkeeping too, so the URL goes back to /feed.
  useEffect(() => {
    if (deepId && openPostId === null && openedPost === null) {
      setDeepId(null);
      onDeepLinkDone?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepId, openPostId, openedPost]);
  // Leaving the tab mid-deep-link: drop the extra copy.
  useEffect(() => {
    return () => {
      if (deepId) store.clearExtraPost(deepId);
    };
  }, [deepId]);

  // Royal v2 (ref 09): the feed lands on the mosaic — the composer stays
  // collapsed until the header compose icon opens it, then gets focus.
  const [composeOpen, setComposeOpen] = useState(false);
  const composerBodyRef = useRef<HTMLTextAreaElement | null>(null);
  const focusComposer = useCallback(() => {
    if (!composerBodyRef.current) {
      setComposeOpen(true);
      return;
    }
    const el = composerBodyRef.current;
    let smooth = true;
    try {
      smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      /* no matchMedia — smooth is fine */
    }
    el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
    el.focus({ preventScroll: true });
  }, []);

  // Focus lands once the newly-opened composer has rendered.
  useEffect(() => {
    if (!composeOpen) return;
    composerBodyRef.current?.focus({ preventScroll: true });
  }, [composeOpen]);

  // Royal v2 mosaic: the FIRST media post renders as the 2×2 hero tile.
  const gridHeroId = (posts ?? []).find((p) => p.attachments.length > 0)?.id ?? null;

  return (
    <div className="page">
      <header className="topbar">
        {/* Royal v2 header system: serif wordmark left; the grid|list
            segmented toggle + the compose stroke icon are the ONLY header
            actions (≤3 icons, no emoji — handoff ref 09). */}
        <h1 className={st.feedTitle} aria-label="Feed">
          bored.
        </h1>
        <div className={st.layoutToggle} role="group" aria-label="Feed layout">
          <button
            type="button"
            className={st.layoutBtn}
            aria-pressed={layout === 'grid'}
            aria-label="Grid view"
            onClick={() => pickLayout('grid')}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
              <rect x="1" y="1" width="6" height="6" rx="1.4" fill="currentColor" />
              <rect x="9" y="1" width="6" height="6" rx="1.4" fill="currentColor" />
              <rect x="1" y="9" width="6" height="6" rx="1.4" fill="currentColor" />
              <rect x="9" y="9" width="6" height="6" rx="1.4" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className={st.layoutBtn}
            aria-pressed={layout === 'list'}
            aria-label="List view"
            onClick={() => pickLayout('list')}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
              <rect x="1" y="2.2" width="14" height="3" rx="1.2" fill="currentColor" />
              <rect x="1" y="6.5" width="14" height="3" rx="1.2" fill="currentColor" />
              <rect x="1" y="10.8" width="14" height="3" rx="1.2" fill="currentColor" />
            </svg>
          </button>
        </div>
        <button type="button" className={tb.iconBtn} aria-label="Write a post" onClick={focusComposer}>
          <IconPlus />
        </button>
      </header>
      <div className={st.feedWrap}>
        {/* v0.7 (§1.49): the lane toggle — two finite windows, no ranking.
            Royal v2: the layout toggle moved to the header; the manual
            refresh keeps a quiet icon on this bar. */}
        <div className={st.laneBar}>
          <div className={st.laneRow} role="radiogroup" aria-label="Feed lane">
            <button
              type="button"
              role="radio"
              aria-checked={lane === 'friends'}
              className={`${st.laneBtn}${lane === 'friends' ? ` ${st.laneOn}` : ''}`}
              onClick={() => setLane('friends')}
            >
              Friends
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={lane === 'discover'}
              className={`${st.laneBtn}${lane === 'discover' ? ` ${st.laneOn}` : ''}`}
              onClick={() => setLane('discover')}
            >
              Discover
            </button>
          </div>
          <button
            type="button"
            className={st.laneRefresh}
            aria-label="Check for new posts"
            onClick={refresh}
            disabled={loading}
          >
            {loading ? <span className="spinner" /> : <IconRefresh />}
          </button>
        </div>

        {composeOpen ? <PostComposerCard lane={lane} bodyRef={composerBodyRef} /> : null}
        {/* v0.8b §1.64: people-you-may-know — Feed-Discover only, dismissible,
            pull-only. Never a login-page surface. */}
        {lane === 'discover' ? <SuggestionCards moreHref="/people" /> : null}
        {posts === null ? (
          <p className="muted small" style={{ textAlign: 'center' }}>
            <span className="spinner" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 8 }} />
            {lane === 'friends' ? 'Loading your people…' : 'Loading public posts…'}
          </p>
        ) : posts.length === 0 ? (
          <div className={st.endCard}>
            <span className={st.endEmoji} aria-hidden>
              🫧
            </span>
            {lane === 'friends' ? (
              <>
                <h3>Nothing here yet</h3>
                <p>
                  Posts from your friends land here — connect with people from their{' '}
                  <Link href="/connections">profiles</Link>, or post something first.
                </p>
              </>
            ) : (
              <>
                <h3>No public posts yet</h3>
                <p>Discover shows what anyone on this server shares publicly. Be the first.</p>
              </>
            )}
          </div>
        ) : (
          <>
            {layout === 'grid' ? (
              // Owner ask: the 3-up tile mosaic — same posts, same order,
              // same pagination; only the rendering changes. A tile opens
              // the full existing card in a sheet.
              <div className={st.feedGrid}>
                {posts.map((post) => (
                  <FeedGridTile
                    key={post.id}
                    post={post}
                    hero={post.id === gridHeroId}
                    onOpen={() => setOpenPostId(post.id)}
                  />
                ))}
              </div>
            ) : (
              posts.map((post) => <PostCard key={post.id} post={post} meId={state.me?.id ?? ''} />)
            )}
            {laneState.cursor !== null ? (
              <button type="button" className={st.refreshPill} onClick={more} disabled={moreBusy}>
                {moreBusy ? 'Loading…' : 'Show older posts'}
              </button>
            ) : null}
            {laneState.caughtUp ? (
              // The HARD end, per lane. No wraparound, no "keep scrolling" —
              // a visit has a bottom, and this is it (PSYCHOLOGY rule 5).
              <div className={st.endCard} role="status">
                <span className={st.endCheck} aria-hidden>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M5 12.5 10 17.5 19 7"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <h3>You&rsquo;re all caught up</h3>
                <p>
                  {lane === 'friends'
                    ? 'nothing new from your people — go make a plan'
                    : 'That’s every public post here. The feed has a bottom on purpose.'}
                </p>
              </div>
            ) : null}
          </>
        )}
        {outside && shareToken ? (
          <OutsideAudienceSheet
            landing={outside}
            token={shareToken}
            onClose={() => {
              setOutside(null);
              onDeepLinkDone?.();
            }}
            onVisible={() => {
              // The door opened right away: read the post and open its sheet.
              void getPost(outside.object_id)
                .then((p) => {
                  store.setExtraPost(p);
                  setDeepId(p.id);
                })
                .catch(() => toast('That post is not available.'));
            }}
          />
        ) : null}
        {openedPost ? (
          // Grid tile → the FULL existing post card in a bottom sheet: the
          // beacons sheet pattern, portaled to body, unmounted when closed.
          // Reactions, comments, polls, claims all work unchanged inside.
          <Portal>
            <div
              className={bz.sheetBackdrop}
              role="presentation"
              onClick={(e) => {
                if (e.target === e.currentTarget) closeSheet();
              }}
            >
              <div
                className={bz.sheet}
                role="dialog"
                aria-modal="true"
                aria-label={`Post by ${openedPost.author.display_name}`}
              >
                <div className={bz.sheetHead}>
                  <h2>Post</h2>
                  <button
                    type="button"
                    className={bz.sheetClose}
                    aria-label="Close"
                    onClick={closeSheet}
                  >
                    ×
                  </button>
                </div>
                <div className={st.sheetPostWrap}>
                  <PostCard post={openedPost} meId={state.me?.id ?? ''} />
                </div>
              </div>
            </div>
          </Portal>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grid tiles (owner fix round): the 3-up mosaic. A media post shows its first
// image / video poster; a text post shows a clamped excerpt. Tiles carry a
// kind symbol at most — never a number (PSYCHOLOGY rule 3 holds here too).
// ---------------------------------------------------------------------------

function tileExcerpt(post: Post): string {
  if (post.body) return post.body;
  if (post.kind === 'poll' && post.poll) return post.poll.question;
  if (post.kind === 'game') return 'Open tic-tac-toe challenge — first tap plays them.';
  if (post.kind === 'join_card') {
    const s = post.ref_summary;
    if (!s) return 'This one is no longer available.';
    return s.type === 'beacon'
      ? `${vibeEmojiOf(s)} ${vibeLabelOf(s)}${s.note ? ` — ${s.note}` : ''}`
      : s.title;
  }
  return '';
}

function FeedGridTile({ post, hero, onOpen }: { post: Post; hero: boolean; onOpen: () => void }) {
  const media = post.attachments[0] ?? null;

  // Royal v2 (ref 09): poll posts render as panel cards in the mosaic.
  if (post.kind === 'poll' && post.poll) {
    return (
      <button
        type="button"
        className={`${st.gridTile} ${st.gridTilePoll}`}
        aria-label={`Open poll by ${post.author.display_name}`}
        onClick={onOpen}
      >
        <span className={st.gridPollIcon} aria-hidden>
          <IconBars size={16} />
        </span>
        <span className={st.gridPollQ}>{post.poll.question}</span>
        <span className={st.gridPollMeta}>poll · tap to vote</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`${st.gridTile}${media ? '' : ` ${st.gridTileText}`}${hero && media ? ` ${st.gridTileHero}` : ''}`}
      aria-label={`Open post by ${post.author.display_name}`}
      onClick={onOpen}
    >
      {media ? (
        media.kind === 'video' && !media.thumb_url ? (
          // A video with no poster yet (still processing): a quiet play slate.
          <span className={st.gridVideoSlate} aria-hidden>
            <IconPlay size={22} />
          </span>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={media.thumb_url ?? media.url} alt="" loading="lazy" />
        )
      ) : (
        <>
          <span className={st.gridTileBody}>{tileExcerpt(post)}</span>
          <span className={st.gridTileAuthor}>{post.author.display_name}</span>
        </>
      )}
      {/* Royal v2: the 2×2 hero tile carries the author pill overlay. */}
      {hero && media ? (
        <span className={st.gridAuthorPill} aria-hidden>
          <Avatar avatar={post.author.avatar} name={post.author.display_name} size={18} />
          {post.author.display_name}
        </span>
      ) : null}
      {media?.kind === 'video' && media.thumb_url ? (
        <span className={st.gridBadge} aria-hidden>
          <IconPlay size={15} />
        </span>
      ) : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Composer: kind picker (§1.50) + audience (§1.49) + location (§1.52)
// ---------------------------------------------------------------------------

// Royal v2: text-only kind chips — no emoji as UI icons (hard rule).
const KIND_PICKS: { kind: PostKind; label: string }[] = [
  { kind: 'text', label: 'Post' },
  { kind: 'poll', label: 'Poll' },
  { kind: 'game', label: 'Challenge' },
  { kind: 'join_card', label: 'Join my…' },
];

interface RefCandidate {
  type: 'beacon' | 'listing';
  id: string;
  title: string;
  sub: string;
  emoji: string;
  /** Audiences the §1.50 nesting table allows for this ref. */
  allowed: PostAudience[];
}

function PostComposerCard({
  lane,
  bodyRef,
}: {
  lane: FeedLane;
  /** The header compose icon scrolls to / focuses this textarea (ref 09). */
  bodyRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const state = useAppState();
  const [kind, setKind] = useState<PostKind>('text');
  const [audience, setAudience] = useState<PostAudience>('friends_of');
  // v0.8a §1.57: pending drunk-mode "you sure?" before a PUBLIC post.
  const [drunkAsk, setDrunkAsk] = useState(false);

  // Fixer r1: the composer FOLLOWS the active lane — writing from Discover
  // defaults the audience chip to Public (and the placeholder with it), so the
  // post lands in the lane the user is looking at. The chip stays manually
  // flippable after the lane switch.
  useEffect(() => {
    setAudience(lane === 'discover' ? 'public' : 'friends_of');
  }, [lane]);
  const [body, setBody] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // v1.0a (#92): which attachment is open in the edit sheet (crop/rotate).
  const [editing, setEditing] = useState<Attachment | null>(null);
  const [uploading, setUploading] = useState(0);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [location, setLocation] = useState<Location | null>(null);
  // poll
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  // join_card
  const [refSel, setRefSel] = useState<{ type: 'beacon' | 'listing'; id: string } | null>(null);
  const [myListings, setMyListings] = useState<Listing[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Candidates for a join card: MY open beacons (already in the store) + MY
  // active listings (one fetch when the picker opens). Eligibility follows the
  // §1.50 audience-NESTING table — a card never shows a thing to someone who
  // cannot act on it.
  useEffect(() => {
    if (kind !== 'join_card' || myListings !== null) return;
    void listMine()
      .then((all) => setMyListings(all.filter((l) => l.status === 'active')))
      .catch(() => setMyListings([]));
  }, [kind, myListings]);

  const candidates: RefCandidate[] = [];
  if (kind === 'join_card') {
    for (const b of state.beacons.values()) {
      if (b.my_state !== 'creator' || b.status !== 'open') continue;
      candidates.push({
        type: 'beacon',
        id: b.id,
        title: `${vibeEmojiOf(b)} ${vibeLabelOf(b)}${b.note ? ` — ${b.note}` : ''}`,
        sub: `beacon · ${b.audience === 'public' ? 'public' : b.audience === 'friends' ? 'friends' : 'my area'}`,
        emoji: '🔥',
        allowed:
          b.audience === 'public'
            ? ['friends_of', 'public']
            : b.audience === 'friends'
              ? ['friends_of']
              : [], // 'area' is incomparable with both post audiences (§1.50)
      });
    }
    for (const l of myListings ?? []) {
      candidates.push({
        type: 'listing',
        id: l.id,
        title: l.title,
        sub: `${KIND_LABEL[l.kind].toLowerCase()} · ${l.is_public ? 'public' : 'area only'}`,
        emoji: KIND_EMOJI[l.kind],
        allowed: l.is_public ? ['friends_of', 'public'] : [],
      });
    }
  }

  async function upload(files: FileList | null): Promise<void> {
    if (!files) return;
    setError(null);
    for (const file of Array.from(files)) {
      if (attachments.length + uploading >= POST_MAX_ATTACHMENTS) {
        setError(`Up to ${POST_MAX_ATTACHMENTS} images per post.`);
        break;
      }
      setUploading((n) => n + 1);
      try {
        const up = await maybeConvertImage(file); // v1.0a #91: HEIC → JPEG
        const form = new FormData();
        form.append('file', up, up.name);
        setUploadPct(0);
        const res = await api.uploadForm<UploadResponse>('/api/uploads', form, setUploadPct);
        setAttachments((prev) => (prev.length < POST_MAX_ATTACHMENTS ? [...prev, res.attachment] : prev));
      } catch (err) {
        if (err instanceof HeicUnreadableError) setError(err.message);
        else if (err instanceof ApiError && err.status === 413) setError(`${file.name} is too large.`);
        else if (err instanceof ApiError && err.status === 415) setError(`${file.name}: unsupported type.`);
        else setError(`Could not upload ${file.name}.`);
      } finally {
        setUploading((n) => n - 1);
        setUploadPct(null);
      }
    }
  }

  const trimmedOptions = options.map((o) => o.trim()).filter((o) => o.length > 0);
  const canPost = ((): boolean => {
    if (busy || uploading > 0) return false;
    if (kind === 'text') return body.trim().length > 0 || attachments.length > 0;
    if (kind === 'poll') return question.trim().length > 0 && trimmedOptions.length >= POLL_OPTIONS_MIN;
    if (kind === 'game') return true; // the caption is optional trash talk
    return refSel !== null;
  })();

  async function post(force = false): Promise<void> {
    if (!canPost) return;
    // v0.8a §1.57 drunk guardrail (client-side, binding): a PUBLIC post while
    // drunk gets a "you sure?" first. Never a server rejection — nothing is
    // recorded about the hesitation.
    if (!force && audience === 'public' && isSelfDrunk()) {
      setDrunkAsk(true);
      return;
    }
    setBusy(true);
    setError(null);
    const req: CreatePostRequest = {
      kind,
      audience,
      body: body.trim(),
      attachment_ids: kind === 'text' ? attachments.map((a) => a.id) : [],
      ...(kind === 'poll' ? { poll: { question: question.trim(), options: trimmedOptions } } : {}),
      ...(kind === 'join_card' && refSel ? { ref: refSel } : {}),
      ...(location ? { location } : {}),
    };
    try {
      await createPost(req);
      setBody('');
      setAttachments([]);
      setQuestion('');
      setOptions(['', '']);
      setRefSel(null);
      setLocation(null);
      setKind('text');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ref_audience_mismatch') {
        setError('That card’s own audience is narrower than the post’s — switch the post to Friends.');
      } else if (err instanceof ApiError && err.code === 'ref_closed') {
        setError('That one already closed — pick something still live.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError('Easy there — posting limit for this hour.');
      } else if (err instanceof ApiError && err.status === 400) {
        setError('That post shape didn’t work — check the fields and try again.');
      } else {
        setError('Could not post — try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={st.composerCard}>
      <div className={st.kindRow} role="radiogroup" aria-label="Post kind">
        {KIND_PICKS.map((k) => (
          <button
            key={k.kind}
            type="button"
            role="radio"
            aria-checked={kind === k.kind}
            className={`${st.kindBtn}${kind === k.kind ? ` ${st.kindBtnOn}` : ''}`}
            onClick={() => setKind(k.kind)}
          >
            {k.label}
          </button>
        ))}
      </div>

      {/* Royal v2 (ref 44): avatar + borderless writing area. */}
      <div className={st.composerTop}>
        {state.me ? (
          <Avatar avatar={state.me.avatar} name={state.me.display_name} size={36} />
        ) : null}
        <textarea
          ref={bodyRef}
          value={body}
          maxLength={POST_BODY_MAX_CHARS}
          placeholder={
            kind === 'poll'
              ? 'Anything to add under the poll? (song links go here)'
              : kind === 'game'
                ? 'Talk your trash — first tap plays you.'
                : kind === 'join_card'
                  ? 'Say why they should jump in…'
                  : audience === 'public'
                    ? "What's up? Anyone on this server can see it."
                    : "What's up? Your friends will see it."
          }
          aria-label="Write a post"
          onChange={(e) => setBody(e.target.value)}
        />
      </div>

      {kind === 'poll' ? (
        // Royal v2 (ref 44): the poll builder rides a raised card.
        <div className={st.pollBuilder}>
          <div className={st.pollBuilderHead}>
            <span>Add a poll</span>
            <span aria-hidden>
              <IconBars size={16} />
            </span>
          </div>
          <input
            className="input"
            placeholder="The question — “song for the ride?”"
            aria-label="Poll question"
            value={question}
            maxLength={POST_POLL_QUESTION_MAX_CHARS}
            onChange={(e) => setQuestion(e.target.value)}
          />
          {options.map((opt, i) => (
            <div key={i} className={st.pollEditorRow}>
              <input
                className="input"
                placeholder={`option ${i + 1}${i === 0 ? ' — thursday 7pm' : i === 1 ? ' — friday 8pm' : ''}`}
                aria-label={`Poll option ${i + 1}`}
                value={opt}
                maxLength={POLL_OPTION_MAX_CHARS}
                onChange={(e) =>
                  setOptions((prev) => prev.map((o, j) => (j === i ? e.target.value : o)))
                }
              />
              {options.length > POLL_OPTIONS_MIN ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label={`Remove option ${i + 1}`}
                  onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              ) : null}
            </div>
          ))}
          {options.length < POLL_OPTIONS_MAX ? (
            <button
              type="button"
              className={st.addOptionBtn}
              onClick={() => setOptions((prev) => [...prev, ''])}
            >
              + add option
            </button>
          ) : null}
        </div>
      ) : null}

      {kind === 'game' ? (
        <p className="muted small" style={{ margin: '8px 0 0' }}>
          An open tic-tac-toe challenge — the first person to tap Claim plays you (you move
          first). The board opens in a DM between you two.
        </p>
      ) : null}

      {kind === 'join_card' ? (
        <div className={st.refPickList} role="radiogroup" aria-label="What to cross-post">
          {myListings === null && candidates.length === 0 ? (
            <p className="muted small" style={{ margin: 0 }}>
              Looking for your live beacons and listings…
            </p>
          ) : candidates.length === 0 ? (
            <p className="muted small" style={{ margin: 0 }}>
              Nothing live to share — light a beacon or post to the board first.
            </p>
          ) : (
            candidates.map((c) => {
              const ok = c.allowed.includes(audience);
              const on = refSel !== null && refSel.type === c.type && refSel.id === c.id;
              return (
                <button
                  key={`${c.type}:${c.id}`}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`${st.refPick}${on ? ` ${st.refPickOn}` : ''}`}
                  disabled={!ok}
                  onClick={() => setRefSel({ type: c.type, id: c.id })}
                >
                  <span aria-hidden>{c.emoji}</span>
                  <span className={st.refPickText}>
                    <strong>{c.title}</strong>
                    <span>
                      {c.sub}
                      {!ok
                        ? audience === 'public'
                          ? ' — not public, so it can’t go in a public post'
                          : ' — its audience doesn’t cover your friends'
                        : ''}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      ) : null}

      {kind === 'text' ? (
        // Royal v2 (ref 44): photo thumbs + the dashed add tile.
        <div className={st.photoStrip}>
          {attachments.map((a) => (
            <span key={a.id} className={st.photoThumb}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={a.thumb_url ?? a.url} alt="" />
              <button
                type="button"
                className={st.gifToolBtn}
                style={{ position: 'absolute', top: 4, right: 4 }}
                aria-label="Remove image"
                onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
              >
                ×
              </button>
              {/* v1.0a (#92): crop/rotate before posting (static images). */}
              {a.kind === 'image' ? (
                <button
                  type="button"
                  className={st.gifToolBtn}
                  style={{ position: 'absolute', bottom: 4, right: 4 }}
                  aria-label="Edit image"
                  onClick={() => setEditing(a)}
                >
                  <IconPencil size={12} />
                </button>
              ) : null}
            </span>
          ))}
          <input
            ref={fileRef}
            type="file"
            hidden
            multiple
            accept="image/*,video/mp4,video/webm"
            onChange={(e) => {
              void upload(e.target.files);
              e.target.value = '';
            }}
          />
          {attachments.length < POST_MAX_ATTACHMENTS ? (
            <button
              type="button"
              className={st.photoAddTile}
              aria-label="Add images"
              disabled={uploading > 0}
              onClick={() => fileRef.current?.click()}
            >
              {uploading > 0 ? (
                uploadPct !== null && uploadPct < 100 ? (
                  <span className="small" aria-live="polite">{uploadPct}%</span>
                ) : (
                  <span className="spinner" />
                )
              ) : (
                <IconPlus size={20} />
              )}
            </button>
          ) : null}
        </div>
      ) : null}
      {editing ? (
        <ImageEditSheet
          source={editing.url}
          fileName={editing.file_name ?? 'photo.jpg'}
          onCancel={() => setEditing(null)}
          onDone={(file) => {
            const target = editing;
            setEditing(null);
            void (async () => {
              setUploading((n) => n + 1);
              try {
                const form = new FormData();
                form.append('file', file, file.name);
                const res = await api.postForm<UploadResponse>('/api/uploads', form);
                // Swap in place; the replaced upload is unbound → orphan GC.
                setAttachments((prev) => prev.map((x) => (x.id === target.id ? res.attachment : x)));
              } catch {
                setError('Could not save the edited image.');
              } finally {
                setUploading((n) => n - 1);
              }
            })();
          }}
        />
      ) : null}

      <div style={{ marginTop: 10 }}>
        <LocationField value={location} onChange={setLocation} />
      </div>

      {/* §1.49 audience as the Royal v2 row (ref 44): label left, value +
          chevron right; the tap still just flips friends-of ↔ public. */}
      <button
        type="button"
        className={st.audienceRow}
        aria-label={`Audience: ${audience === 'public' ? 'public — anyone on this server' : 'friends'}. Tap to switch`}
        onClick={() => setAudience((a) => (a === 'public' ? 'friends_of' : 'public'))}
      >
        <span aria-hidden>
          <IconPerson />
        </span>
        <span>Audience</span>
        <span className={st.audienceVal}>{audience === 'public' ? 'Public' : 'Connections'} ›</span>
      </button>
      <p className={st.composerNote}>
        Replies are named faces — your post never shows public counts.
      </p>

      {error ? <p className="error-text">{error}</p> : null}
      <div className={st.composerFoot}>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-primary" disabled={!canPost} onClick={() => void post()}>
          {busy ? 'Posting…' : 'Post'}
        </button>
      </div>
      {drunkAsk ? (
        <DrunkConfirmSheet
          text="You're in drunk mode and this would go out to EVERYONE on this server. Tonight-you is sure?"
          confirmLabel="Post it 🍻"
          onConfirm={() => {
            setDrunkAsk(false);
            void post(true);
          }}
          onCancel={() => setDrunkAsk(false)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Post card
// ---------------------------------------------------------------------------

function PostCard({ post, meId }: { post: Post; meId: string }) {
  const own = post.author.id === meId;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function react(emoji: string): Promise<void> {
    setPickerOpen(false);
    setError(null);
    const chip = post.reactions.find((r) => r.emoji === emoji);
    try {
      await togglePostReaction(post, emoji, chip?.mine ?? false);
    } catch {
      setError('Reaction limit reached (8 per post).');
    }
  }

  async function remove(): Promise<void> {
    setMenuOpen(false);
    if (!(await confirmDialog('Delete this post? Comments and reactions go with it.'))) return;
    try {
      await deletePost(post.id);
    } catch {
      setError('Could not delete the post.');
    }
  }

  return (
    <article className={st.postCard}>
      <div className={st.postHead}>
        <Link href={`/u/${encodeURIComponent(post.author.username)}`}>
          <Avatar avatar={post.author.avatar} name={post.author.display_name} size={38} />
        </Link>
        <span className={st.postHeadName}>
          <strong>{post.author.display_name}</strong>
          <span>
            @{post.author.username} · {formatTime(post.created_at)}
            {post.audience === 'public' ? ' · public' : ''}
          </span>
        </span>
        {/* v0.8b §1.67: PUBLIC posts get the one stable share link (mint-or-
            return + copy). Friends-only content never gets a URL. */}
        {/* §1b: public posts are shareable by anyone who can see them; a
            friends-only post by its AUTHOR only, as a token link with the
            Teaser/Full choice (the ShareSheet handles the switch). */}
        {post.audience === 'public' || own ? (
          <ShareButton
            type="post"
            id={post.id}
            className="btn btn-ghost btn-icon"
            ariaLabel="Share this post"
            nonPublic={post.audience !== 'public'}
          >
            <span aria-hidden>
              <IconLink />
            </span>
          </ShareButton>
        ) : null}
        {own ? (
          <span className={bz.cardRel}>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label="Post options"
              onClick={() => setMenuOpen((v) => !v)}
            >
              ⋯
            </button>
            {menuOpen ? (
              <>
                <button type="button" className={bz.menuBackdrop} aria-label="Close menu" onClick={() => setMenuOpen(false)} />
                <div className={bz.cardMenu} role="menu" style={{ right: 0, top: 34 }}>
                  <button type="button" role="menuitem" className={bz.menuDanger} onClick={() => void remove()}>
                    Delete post
                  </button>
                </div>
              </>
            ) : null}
          </span>
        ) : null}
      </div>

      {post.body ? <p className={st.postBody}>{post.body}</p> : null}

      {/* ---- v0.7 kind riders (§1.50) ---- */}
      {post.kind === 'poll' && post.poll ? <PostPollView post={post} /> : null}
      {post.kind === 'game' && post.game ? <PostGameView post={post} meId={meId} /> : null}
      {post.kind === 'join_card' ? <JoinCardView post={post} meId={meId} /> : null}

      {post.attachments.length > 0 ? (
        <div className={`${st.postImages} ${st[`postImages${Math.min(post.attachments.length, 4)}`]}`}>
          {post.attachments.map((a) =>
            a.kind === 'video' && a.status === 'ready' ? (
              <video key={a.id} src={a.url} poster={a.thumb_url ?? undefined} controls playsInline preload="metadata" />
            ) : (
              <a key={a.id} href={a.url} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.thumb_url ?? a.url} alt="" loading="lazy" />
              </a>
            )
          )}
        </div>
      ) : null}

      {post.location ? (
        <div style={{ margin: '2px 0 6px' }}>
          <LocationChip location={post.location} />
        </div>
      ) : null}

      {/* FACES, never counts: first reactors as an avatar pile + "…" for more. */}
      <div className={st.postReactRow}>
        {post.reactions.map((r) => (
          <button
            key={r.emoji}
            type="button"
            className={`${st.faceChip}${r.mine ? ` ${st.faceChipMine}` : ''}`}
            aria-label={`${r.emoji} — ${r.reactors.map((u) => u.display_name).join(', ')}${r.has_more ? ' and more' : ''}${r.mine ? '. You reacted — tap to remove' : '. Tap to react too'}`}
            onClick={() => void react(r.emoji)}
          >
            <span aria-hidden>{r.emoji}</span>
            <span className={st.facePile} aria-hidden>
              {r.reactors.slice(0, 5).map((u) => (
                <Avatar key={u.id} avatar={u.avatar} name={u.display_name} size={20} />
              ))}
            </span>
            {r.has_more ? (
              <span className={st.faceMore} aria-hidden>
                &amp; more
              </span>
            ) : null}
          </button>
        ))}
        <span className={bz.cardRel}>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="React to this post"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((v) => !v)}
          >
            <span aria-hidden>
              <IconSmilePlus />
            </span>
          </button>
        </span>
        {pickerOpen ? (
          <>
            <button type="button" className={bz.menuBackdrop} aria-label="Close picker" onClick={() => setPickerOpen(false)} />
            {/* Anchored to the reaction ROW (position:relative), not the tiny
                .cardRel span: the row is as wide as the card, so left:0 +
                bottom:100% always lands inside the viewport. The inline style
                overrides .cardMenu's default top/right anchor — setting all
                four would over-constrain the box and collapse it (v0.6.1). */}
            <div
              className={bz.cardMenu}
              role="menu"
              aria-label="React to this post"
              style={{ left: 0, right: 'auto', top: 'auto', bottom: 'calc(100% + 4px)', display: 'flex', flexWrap: 'wrap', maxWidth: '100%' }}
            >
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  role="menuitem"
                  // .cardMenu buttons are block/full-width list rows; emoji sit in a compact row
                  style={{ fontSize: 19, width: 'auto', padding: '9px 10px' }}
                  onClick={() => void react(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
      {error ? <p className="error-text">{error}</p> : null}

      <PostComments post={post} meId={meId} />
    </article>
  );
}

// ---------------------------------------------------------------------------
// Poll posts (§1.50): counts on OPTIONS are a decision tool (ADR-016) — no
// voter lists, no timestamps, ever. Tap to vote, tap again to unvote, tap
// another option to revote (UPSERT).
// ---------------------------------------------------------------------------

function PostPollView({ post }: { post: Post }) {
  const poll = post.poll!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function vote(idx: number): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await votePostPoll(post.id, poll.my_vote === idx ? null : idx);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setError('This poll is gone.');
      else setError('Could not vote — try again.');
    } finally {
      setBusy(false);
    }
  }

  // Royal: before MY vote the options read as plain outline buttons; once I
  // vote they become result rows with the soft fill bar at the percent width.
  const voted = poll.my_vote !== null;

  return (
    <div className={st.postPoll}>
      <p className={st.postPollQ}>{poll.question}</p>
      {poll.options.map((opt, i) => {
        const count = poll.counts[i] ?? 0;
        const pct = poll.total_votes > 0 ? Math.round((count / poll.total_votes) * 100) : 0;
        const mine = poll.my_vote === i;
        return (
          <button
            key={i}
            type="button"
            className={`${st.postPollOpt}${mine ? ` ${st.postPollOptMine}` : ''}`}
            style={{ '--w': `${pct}%` } as React.CSSProperties}
            disabled={busy}
            aria-pressed={mine}
            aria-label={`${opt} — ${count} ${count === 1 ? 'vote' : 'votes'}${mine ? '. Your vote — tap to remove' : '. Tap to vote'}`}
            onClick={() => void vote(i)}
          >
            {voted ? <span className={st.postPollBar} aria-hidden /> : null}
            <span className={st.postPollLabel}>
              {opt}
              {mine ? <span className={st.pollYourVote}> · your vote</span> : null}
            </span>
            <span className={st.postPollCount} aria-hidden>
              {count}
            </span>
          </button>
        );
      })}
      <span className={st.postPollMeta}>
        {poll.total_votes === 0
          ? 'No votes yet — be the tiebreaker before there’s a tie.'
          : `${poll.total_votes} ${poll.total_votes === 1 ? 'vote' : 'votes'} · tap again to change`}
      </span>
      {error ? <p className="error-text" style={{ margin: 0 }}>{error}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Game posts (§1.50): the open challenge — first Claim wins (server-side
// advisory lock), and the claimer lands straight on the §1.27 board in a DM.
// ---------------------------------------------------------------------------

function PostGameView({ post, meId }: { post: Post; meId: string }) {
  const router = useRouter();
  const game = post.game!;
  const own = post.author.id === meId;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function claim(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await claimGame(post.id);
      // Land on the board: make sure the DM is locally known, then go.
      if (!store.state.conversations.has(res.conversation_id)) {
        try {
          const conv = await api.get<{ conversation: Conversation }>(
            `/api/conversations/${res.conversation_id}`
          );
          store.upsertConversation(conv.conversation);
        } catch {
          /* the conv.new frame will carry it */
        }
      }
      router.push(`/c/${res.conversation_id}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'game_claimed') {
        setError('Someone was faster — the gauntlet is taken.');
        void refetchPost(post.id);
      } else if (err instanceof ApiError && err.code === 'game_own') {
        setError('You can’t claim your own challenge 😄');
      } else {
        setError('Could not claim — try again.');
      }
      setBusy(false);
    }
  }

  return (
    <div className={st.gameCard}>
      <span aria-hidden style={{ fontSize: 22 }}>
        🎮
      </span>
      <span className={st.gameCardText}>
        {game.state === 'open' ? (
          own ? (
            <>Open tic-tac-toe challenge — waiting for a taker. You move first.</>
          ) : (
            <>
              <strong>{post.author.display_name}</strong> threw down an open tic-tac-toe gauntlet.
              First tap plays them.
            </>
          )
        ) : game.claimed_by ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Avatar avatar={game.claimed_by.avatar} name={game.claimed_by.display_name} size={22} />
            <span>
              <strong>{game.claimed_by.id === meId ? 'You' : game.claimed_by.display_name}</strong>{' '}
              claimed it — the board lives in their DM.
            </span>
          </span>
        ) : (
          <>Claimed.</>
        )}
        {error ? <span className="error-text" style={{ display: 'block' }}>{error}</span> : null}
      </span>
      {game.state === 'open' && !own ? (
        <button type="button" className={st.gameClaimBtn} disabled={busy} onClick={() => void claim()}>
          {busy ? 'Claiming…' : 'Claim 🎯'}
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Join cards (§1.50): the viewer-resolved live summary; the Join button is
// the EXISTING join/contact route, then a single-post refetch.
// ---------------------------------------------------------------------------

function JoinCardView({ post, meId }: { post: Post; meId: string }) {
  const router = useRouter();
  const own = post.author.id === meId;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summary: JoinCardSummary | null = post.ref_summary;

  if (!summary) {
    // Deleted, blocked or otherwise invisible — the honest "gone" card.
    return <p className={st.joinCardGone}>This one is no longer available.</p>;
  }

  async function joinBeaconRef(id: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/beacons/${id}/join`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'beacon_own') setError('That one is yours 😄');
      else if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
        setError('Too late — it just closed.');
      } else {
        setError('Could not join — try again.');
      }
    } finally {
      await refetchPost(post.id);
      setBusy(false);
    }
  }

  async function contactListingRef(id: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ conversation_id: string }>(`/api/listings/${id}/contact`, {});
      if (!store.state.conversations.has(res.conversation_id)) {
        try {
          const conv = await api.get<{ conversation: Conversation }>(
            `/api/conversations/${res.conversation_id}`
          );
          store.upsertConversation(conv.conversation);
        } catch {
          /* conv.new will carry it */
        }
      }
      void refetchPost(post.id);
      router.push(`/c/${res.conversation_id}`);
      return;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'listing_closed') setError('This one just closed.');
      else if (err instanceof ApiError && err.status === 404) setError('This listing is gone.');
      else setError('Could not open a chat — try again.');
      void refetchPost(post.id);
    }
    setBusy(false);
  }

  if (summary.type === 'beacon') {
    const live = summary.status === 'open';
    const statusLabel =
      summary.status === 'open'
        ? summary.needs > 0
          ? `needs ${summary.needs} more 🔥`
          : 'sparking…'
        : summary.status === 'sparked'
          ? 'IT’S ON 🎉'
          : summary.status === 'cancelled'
            ? 'called off'
            : 'wrapped up';
    return (
      <div className={st.joinCard}>
        <div className={st.joinCardHead}>
          <span aria-hidden>{vibeEmojiOf(summary)}</span>
          <span>
            {vibeLabelOf(summary)}
            {summary.note ? ` — ${summary.note}` : ''}
          </span>
          <span className={st.joinCardStatus}>{statusLabel}</span>
        </div>
        <div className={st.joinCardMeta}>
          {summary.joiners.length > 0 ? (
            <span className={st.facePile} aria-label={`${summary.joiners.length} in`}>
              {summary.joiners.map((u) => (
                <Avatar key={u.id} avatar={u.avatar} name={u.display_name} size={22} />
              ))}
            </span>
          ) : null}
          <span>
            starts{' '}
            {new Date(summary.starts_at).toLocaleString([], {
              weekday: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
          {summary.location ? <LocationChip location={summary.location} /> : null}
        </div>
        {error ? <p className="error-text" style={{ margin: 0 }}>{error}</p> : null}
        {live ? (
          summary.my_state === 'creator' ? (
            <span className={st.joinCardMeta}>your beacon — watching the pile</span>
          ) : summary.my_state === 'joined' ? (
            <span className={st.joinCardMeta}>you&rsquo;re in 🙌</span>
          ) : (
            <button
              type="button"
              className={st.joinCardBtn}
              disabled={busy}
              onClick={() => void joinBeaconRef(summary.id)}
            >
              {busy ? 'Joining…' : 'Join 🙋'}
            </button>
          )
        ) : null}
      </div>
    );
  }

  const live = summary.status === 'active';
  return (
    <div className={st.joinCard}>
      <div className={st.joinCardHead}>
        <span aria-hidden>{KIND_EMOJI[summary.kind]}</span>
        <span>{summary.title}</span>
        <span className={st.joinCardStatus}>{live ? KIND_LABEL[summary.kind].toLowerCase() : summary.status}</span>
      </div>
      <div className={st.joinCardMeta}>
        <span>📍 {summary.area}</span>
        {summary.price_text ? <span>{summary.price_text}</span> : null}
        {summary.location ? <LocationChip location={summary.location} /> : null}
      </div>
      {error ? <p className="error-text" style={{ margin: 0 }}>{error}</p> : null}
      {live && !own ? (
        <button
          type="button"
          className={st.joinCardBtn}
          disabled={busy}
          onClick={() => void contactListingRef(summary.id)}
        >
          {busy ? 'Opening…' : summary.my_contacted ? 'Open your chat →' : 'Message them'}
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Comments (§1.51): image/GIF attachments + reactions with capped FACES.
// ---------------------------------------------------------------------------

function PostComments({ post, meId }: { post: Post; meId: string }) {
  const state = useAppState();
  // Inline: the DTO's latest 3 (ASC) until expanded, then the full paged list.
  const [expanded, setExpanded] = useState<PostComment[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const shown = expanded ?? post.comments;

  const meLite: UserLite | null = state.me
    ? {
        id: state.me.id,
        username: state.me.username,
        display_name: state.me.display_name,
        avatar: state.me.avatar,
        mood: state.me.mood,
        name_style: state.me.name_style,
        mask_emoji: null,
      }
    : null;

  /** Patch one comment wherever it is rendered from (expanded or the DTO). */
  const patchLocal = useCallback(
    (next: PostComment): void => {
      if (expanded) {
        setExpanded((prev) => (prev ? prev.map((c) => (c.id === next.id ? next : c)) : prev));
      } else {
        store.replacePost({
          ...post,
          comments: post.comments.map((c) => (c.id === next.id ? next : c)),
        });
      }
    },
    [expanded, post]
  );

  async function expand(): Promise<void> {
    try {
      const res = await listComments(post.id, null);
      setExpanded(res.comments);
      setCursor(res.next_cursor);
    } catch {
      setError('Could not load comments.');
    }
  }

  async function moreExpanded(): Promise<void> {
    if (!cursor) return;
    try {
      const res = await listComments(post.id, cursor);
      setExpanded((prev) => [...(prev ?? []), ...res.comments]);
      setCursor(res.next_cursor);
    } catch {
      setError('Could not load more comments.');
    }
  }

  async function uploadAttachment(files: FileList | null): Promise<void> {
    const file = files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const up = await maybeConvertImage(file); // v1.0a #91: HEIC → JPEG
      const form = new FormData();
      form.append('file', up, up.name);
      const res = await api.postForm<UploadResponse>('/api/uploads', form);
      if (res.attachment.kind !== 'image') setError('Comments take images and GIFs only.');
      else setAttachment(res.attachment);
    } catch (err) {
      if (err instanceof HeicUnreadableError) setError(err.message);
        else if (err instanceof ApiError && err.status === 413) setError('That image is too large.');
      else if (err instanceof ApiError && err.status === 415) setError('Unsupported image type.');
      else setError('Could not upload that image.');
    } finally {
      setUploading(false);
    }
  }

  async function submit(): Promise<void> {
    const body = draft.trim();
    // §1.51: at least one of body / attachment — an image-only reply is legal.
    if ((!body && !attachment) || busy || uploading) return;
    setBusy(true);
    setError(null);
    try {
      const comment = await addComment(post.id, body, attachment?.id);
      setDraft('');
      setAttachment(null);
      if (expanded) setExpanded([...expanded, comment]);
      else await refetchPost(post.id);
    } catch {
      setError('Could not comment — try again.');
    } finally {
      setBusy(false);
    }
  }

  async function removeComment(comment: PostComment): Promise<void> {
    try {
      await deleteComment(post.id, comment.id);
      if (expanded) setExpanded(expanded.filter((c) => c.id !== comment.id));
      else await refetchPost(post.id);
    } catch {
      setError('Could not delete that comment.');
    }
  }

  /** §1.51 toggle: optimistic faces patch, then the feed's pull reconciles. */
  async function toggleReaction(comment: PostComment, kind: ReactionKind, emoji: string): Promise<void> {
    if (!meLite) return;
    const key = kind === 'stamp' ? STAMP_REACTION_KEY : emoji;
    const chip = comment.reactions.find((r) => r.kind === kind && r.emoji === key);
    const removing = chip?.mine ?? false;
    patchLocal(patchCommentReaction(comment, kind, emoji, meLite, !removing));
    try {
      if (removing) await removeCommentReaction(post.id, comment.id, kind, emoji);
      else await addCommentReaction(post.id, comment.id, kind, kind === 'emoji' ? emoji : undefined);
    } catch (err) {
      // Roll back on failure; name the one interesting error.
      patchLocal(comment);
      if (err instanceof ApiError && err.code === 'reaction_limit') {
        setError('Reaction limit reached (8 per comment).');
      } else if (err instanceof ApiError && err.code === 'stamp_no_avatar') {
        setError('Add an avatar first to stamp with your face.');
      }
    }
  }

  return (
    <div>
      {shown.map((c) => (
        <CommentRow
          key={c.id}
          comment={c}
          meId={meId}
          canDelete={c.author.id === meId || post.author.id === meId}
          onDelete={() => void removeComment(c)}
          onToggleReaction={(kind, emoji) => void toggleReaction(c, kind, emoji)}
        />
      ))}
      {expanded === null && post.has_more_comments ? (
        <button type="button" className={st.moreComments} onClick={() => void expand()}>
          See earlier comments
        </button>
      ) : null}
      {expanded !== null && cursor !== null ? (
        <button type="button" className={st.moreComments} onClick={() => void moreExpanded()}>
          More comments
        </button>
      ) : null}
      {error ? <p className="error-text">{error}</p> : null}
      {attachment ? (
        <span className={st.commentAttachChip}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={attachment.thumb_url ?? attachment.url} alt="" />
          <button
            type="button"
            className={st.gifToolBtn}
            style={{ position: 'absolute', top: 2, right: 2 }}
            aria-label="Remove image"
            onClick={() => setAttachment(null)}
          >
            ×
          </button>
        </span>
      ) : null}
      <div className={st.commentInputRow}>
        <input
          ref={fileRef}
          type="file"
          hidden
          accept="image/*"
          onChange={(e) => {
            void uploadAttachment(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="btn btn-icon"
          aria-label="Attach an image or GIF to your comment"
          disabled={uploading || attachment !== null}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? <span className="spinner" /> : <IconImage />}
        </button>
        <input
          value={draft}
          maxLength={POST_COMMENT_MAX_CHARS}
          placeholder={attachment ? 'Add words too? (optional)' : 'Say something back…'}
          aria-label="Write a comment"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button
          type="button"
          className="btn"
          disabled={busy || uploading || (!draft.trim() && !attachment)}
          onClick={() => void submit()}
        >
          Reply
        </button>
      </div>
    </div>
  );
}

function CommentRow({
  comment,
  meId,
  canDelete,
  onDelete,
  onToggleReaction,
}: {
  comment: PostComment;
  meId: string;
  canDelete: boolean;
  onDelete: () => void;
  onToggleReaction: (kind: ReactionKind, emoji: string) => void;
}) {
  const state = useAppState();
  const [picker, setPicker] = useState(false);
  const bubbleRef = useRef<HTMLSpanElement | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPress = useCallback(() => {
    if (pressTimer.current !== null) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }, []);
  useEffect(() => cancelPress, [cancelPress]);

  const myStamped = comment.reactions.some((r) => r.kind === 'stamp' && r.mine);

  return (
    <div className={st.commentRow}>
      <Link href={`/u/${encodeURIComponent(comment.author.username)}`} aria-label={`${comment.author.display_name} — open profile`}>
        <Avatar avatar={comment.author.avatar} name={comment.author.display_name} size={26} />
      </Link>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          ref={bubbleRef}
          className={st.commentBubble}
          style={{ display: 'block' }}
          // §1.51: long-press opens the reaction picker (desktop has the 🙂 button).
          onTouchStart={() => {
            cancelPress();
            pressTimer.current = setTimeout(() => setPicker(true), LONG_PRESS_MS);
          }}
          onTouchEnd={cancelPress}
          onTouchMove={cancelPress}
          onTouchCancel={cancelPress}
        >
          <strong>{comment.author.display_name}</strong>
          {comment.body ? <p>{comment.body}</p> : null}
          {comment.attachment ? (
            <a href={comment.attachment.url} target="_blank" rel="noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className={st.commentImg}
                src={comment.attachment.thumb_url ?? comment.attachment.url}
                alt=""
                loading="lazy"
              />
            </a>
          ) : null}
        </span>
        {/* One chip per (emoji, kind): capped FACES, never totals (§1.51). */}
        <span className={st.commentReactRow}>
          {comment.reactions.map((r) => (
            <button
              key={`${r.kind}:${r.emoji}`}
              type="button"
              className={`${st.commentFaceChip}${r.mine ? ` ${st.commentFaceChipMine}` : ''}`}
              aria-label={`${r.kind === 'stamp' ? 'Avatar stamp' : r.emoji} — ${r.reactors
                .map((u) => u.display_name)
                .join(', ')}${r.has_more ? ' and more' : ''}${r.mine ? '. Yours — tap to remove' : '. Tap to react too'}`}
              onClick={() => onToggleReaction(r.kind, r.kind === 'stamp' ? STAMP_REACTION_KEY : r.emoji)}
            >
              {r.kind === 'emoji' ? <span aria-hidden>{r.emoji}</span> : null}
              <span className={st.facePile} aria-hidden>
                {r.reactors.map((u) => (
                  <Avatar key={u.id} avatar={u.avatar} name={u.display_name} size={16} />
                ))}
              </span>
              {r.has_more ? (
                <span className={st.faceMore} aria-hidden>
                  &amp; more
                </span>
              ) : null}
            </button>
          ))}
          <button
            type="button"
            className={st.commentReactBtn}
            aria-label="React to this comment"
            aria-expanded={picker}
            onClick={() => setPicker((v) => !v)}
          >
            <IconSmilePlus size={15} />
          </button>
        </span>
      </span>
      {canDelete ? (
        <button type="button" className={st.commentDelete} aria-label="Delete comment" onClick={onDelete}>
          ×
        </button>
      ) : null}
      {picker ? (
        <CommentReactionOverlay anchorRef={bubbleRef}>
          <ReactionPicker
            onPick={(emoji) => {
              setPicker(false);
              onToggleReaction('emoji', emoji);
            }}
            onClose={() => setPicker(false)}
            onStamp={() => {
              setPicker(false);
              onToggleReaction('stamp', STAMP_REACTION_KEY);
            }}
            stamped={myStamped}
            myAvatar={state.me?.avatar ?? null}
          />
        </CommentReactionOverlay>
      ) : null}
    </div>
  );
}

/** The ChatView MessageActionsOverlay pattern, trimmed: the picker renders
 * through Portal into <body>, FIXED at the comment bubble's rect, so the feed
 * card's overflow and stacking contexts cannot clip it (v0.6.1 class). */
function CommentReactionOverlay({
  anchorRef,
  children,
}: {
  anchorRef: React.RefObject<HTMLSpanElement | null>;
  children: ReactNode;
}) {
  const [rect] = useState(() => {
    const el = anchorRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
  const layoutBox = useCallback((box: HTMLDivElement | null) => {
    if (!box) return;
    const picker = box.querySelector<HTMLElement>('[data-overlay-part="picker"]');
    if (!picker) return;
    const pr = picker.getBoundingClientRect();
    if (pr.top < 8) {
      // Bubble near the top of the viewport: drop the picker below instead.
      picker.style.bottom = 'auto';
      picker.style.top = `calc(100% + 6px)`;
    }
    if (pr.left < 8) {
      picker.style.left = '0';
    } else if (pr.right > window.innerWidth - 8) {
      picker.style.left = 'auto';
      picker.style.right = '0';
    }
  }, []);
  if (!rect) return null;
  return (
    <Portal>
      <div
        ref={layoutBox}
        // z 41: one above the sheet layer (z 40) so the picker also works for
        // a card opened from the GRID's post sheet; both portal to <body>.
        style={{ position: 'fixed', zIndex: 41, left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      >
        {children}
      </div>
    </Portal>
  );
}

// ---------------------------------------------------------------------------
// Royal v2 stroke icons — the Tabs.tsx family (24 viewBox, 1.7px stroke,
// round caps). No emoji as UI icons (hard contract).
// ---------------------------------------------------------------------------

function IconPlus({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function IconRefresh({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M19.5 12a7.5 7.5 0 1 1-2.1-5.2M19.7 3.6v3.6h-3.6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconBars({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6.5 18v-6M12 18V6.5M17.5 18v-3.5"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconPerson({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="8.4" r="3.6" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M5 19.5 c1.4 -3.4 4 -5 7 -5 s5.6 1.6 7 5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconLink({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M10.2 13.8a4.1 4.1 0 0 0 5.8 0l3.2-3.2a4.1 4.1 0 0 0-5.8-5.8L11.8 6.4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13.8 10.2a4.1 4.1 0 0 0-5.8 0l-3.2 3.2a4.1 4.1 0 0 0 5.8 5.8l1.6-1.6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconSmilePlus({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="10.5" cy="13" r="7" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M7.6 14.6c.7 1.2 1.7 1.8 2.9 1.8s2.2-.6 2.9-1.8"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path d="M8.5 11.2h.01M12.5 11.2h.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M19 3.5v5M16.5 6h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function IconImage({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4" y="5" width="16" height="14" rx="3" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="9" cy="10" r="1.6" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M5 17l4.5-4.5 3 3 2.5-2.5 4 4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconPencil({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4.5 19.5l.9-3.6L16.3 5a2 2 0 0 1 2.8 2.8L8.1 18.6l-3.6.9z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconPlay({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M9 6.8v10.4L18 12z" fill="currentColor" />
    </svg>
  );
}
