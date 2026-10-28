// The logged-out profile hero (AUDIT-PLAN §1b phase 6, 2026-10-28; API.md
// §1.13 profile_visibility). SERVER component, rendered in two places from
// the SAME ProfileHero shape: /u/<username> without a session, and the
// owner-minted `profile` share page. Decision 11: avatar, name, one bio
// line, interests and "Joined <month>" (visibility 'full'), or avatar +
// name only ('minimal'); never last-seen, mood, counts or faces. The two
// doors — Message / Call — are GateCta: a real `/register?next=` link for
// crawlers and no-JS, the inline sign-in sheet on a click, landing back on
// /u/<username>?msg=1 | ?call=1 where the signed-in page opens the DM.
import type { ProfileHero } from '@socialchat/shared';
import GateCta from './GateCta';
import cm from './community.module.css';

function joinedLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y!, (m ?? 1) - 1, 1));
  return d.toLocaleDateString('en', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function profileDoorNext(username: string, door: 'msg' | 'audio' | 'video'): string {
  // Phase 5: ?call=audio|video is the personal call link — the signed-in
  // profile page opens the DM and offers the call of that kind.
  return door === 'msg' ? `/u/${encodeURIComponent(username)}?msg=1` : `/u/${encodeURIComponent(username)}?call=${door}`;
}

export default function ProfileHeroCard({ hero }: { hero: ProfileHero }) {
  const initial = hero.display_name.trim() ? hero.display_name.trim()[0]!.toUpperCase() : '?';
  const msgNext = profileDoorNext(hero.username, 'msg');
  const callNext = profileDoorNext(hero.username, 'audio');
  const videoNext = profileDoorNext(hero.username, 'video');
  return (
    <div className={cm.shareCard}>
      <div className={cm.shareProfileHero}>
        {hero.avatar_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className={cm.shareProfileAvatar} src={hero.avatar_url} alt="" width={96} height={96} />
        ) : (
          <span className={cm.shareProfileFallback} aria-hidden>
            {initial}
          </span>
        )}
        <h1 className={cm.shareProfileName}>{hero.display_name}</h1>
        <p className={cm.shareProfileHandle}>@{hero.username}</p>
        {hero.bio_line ? <p className={cm.shareProfileBio}>{hero.bio_line}</p> : null}
        {hero.interests.length > 0 ? (
          <div className={cm.sharedTags}>
            {hero.interests.map((tag) => (
              <span key={tag} className={cm.sharedTag}>
                {tag}
              </span>
            ))}
          </div>
        ) : null}
        {hero.joined ? <p className={cm.shareProfileJoined}>Joined {joinedLabel(hero.joined)}</p> : null}
        {hero.doors.message || hero.doors.call ? (
          <div className={cm.shareProfileDoors}>
            {hero.doors.message ? (
              <GateCta
                next={msgNext}
                fallback={`/register?next=${encodeURIComponent(msgNext)}`}
                word="chat"
                className="btn btn-primary"
              >
                Message {hero.display_name}
              </GateCta>
            ) : null}
            {hero.doors.call ? (
              <GateCta
                next={callNext}
                fallback={`/register?next=${encodeURIComponent(callNext)}`}
                word="call"
                className="btn"
              >
                Call
              </GateCta>
            ) : null}
            {hero.doors.call ? (
              <GateCta
                next={videoNext}
                fallback={`/register?next=${encodeURIComponent(videoNext)}`}
                word="video call"
                className="btn"
              >
                Video call
              </GateCta>
            ) : null}
          </div>
        ) : null}
        <p className="muted small" style={{ margin: '8px 0 0' }}>
          {hero.doors.message
            ? 'Messaging and calls need a free account — it takes a minute.'
            : 'See more with a free account — it takes a minute.'}
        </p>
      </div>
    </div>
  );
}
