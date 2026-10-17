'use client';

// 🍻 The soft counterparty banner (v0.8a — API.md §1.57, FEATURES #73).
// Renders for a participant whose view of the drunk user resolves
// mood.kind === 'drunk' — i.e. exactly those the visibility already admits;
// the server stamped the chip, this is a passive render of it. NEVER a push,
// never a system message, never stored; it vanishes the moment the mood does
// (user.updated nulls the chip). "Check on them 💙" sends the caring preset
// as an ordinary §1.5 message, or starts an ordinary §1.42 call.
import { useState } from 'react';
import { DRUNK_CHECK_IN_BODY, type ConversationListItem } from '@socialchat/shared';
import { sendMessage } from '@/lib/connection';
import { uuidv7 } from '@/lib/ids';
import { toast } from '@/lib/toast';
import { startCall } from '@/lib/webrtc';
import { PhoneIcon } from './CallOverlay';
import Mascot from './Mascot';
import idm from './identity.module.css';

export default function DrunkBanner({
  conv,
  meId,
  nameFor,
}: {
  conv: ConversationListItem;
  meId: string;
  nameFor: (userId: string, fallback: string) => string;
}) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  // Channels have no calls and no peers-in-the-round sense — dm/group only.
  if (conv.type === 'channel') return null;
  const drunk = conv.participants.find(
    (p) => p.left_at === null && p.user.id !== meId && p.user.mood?.kind === 'drunk'
  );
  if (!drunk) return null;
  const name = nameFor(drunk.user.id, drunk.user.display_name);

  async function checkIn(): Promise<void> {
    if (busy || sent) return;
    setBusy(true);
    try {
      await sendMessage(conv.id, {
        client_msg_id: uuidv7(),
        type: 'text',
        body: DRUNK_CHECK_IN_BODY,
      });
      setSent(true);
      toast('Check-in sent 💙');
    } catch {
      toast('Could not send it — try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={idm.drunkBanner} role="status">
      {/* Mildly concerned, never alarmed. */}
      <Mascot state="wince" size={36} />
      <span className={idm.drunkBannerText}>
        🍻 {name} is in drunk mode — take tonight&rsquo;s messages lightly.
      </span>
      <span className={idm.drunkBannerBtns}>
        <button
          type="button"
          className={idm.checkInBtn}
          disabled={busy || sent}
          onClick={() => void checkIn()}
        >
          {sent ? 'Checked in 💙' : 'Check on them 💙'}
        </button>
        <button
          type="button"
          className={idm.checkInBtn}
          aria-label={`Call ${name}`}
          onClick={() => void startCall(conv.id, 'audio')}
        >
          <PhoneIcon /> Call
        </button>
      </span>
    </div>
  );
}
