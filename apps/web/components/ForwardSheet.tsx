'use client';

// Forward sheet (v0.5a — API.md §1.31): multi-pick up to FORWARD_MAX_TARGETS
// conversations. All-or-nothing server-side; attachments are re-referenced,
// authorship is never spoofed (the forwarder is the sender, the original
// author rides metadata.forwarded_from). The picker itself lives in
// ChatPickerSheet (shared with the §1b ShareSheet's "Send to a chat").
import type { ForwardMessageResponse, Message } from '@socialchat/shared';
import { api, ApiError } from '@/lib/api';
import * as db from '@/lib/db';
import { messageSnippet } from '@/lib/format';
import { uuidv7 } from '@/lib/ids';
import * as store from '@/lib/store';
import ChatPickerSheet, { type PickerResult } from './ChatPickerSheet';

interface ForwardSheetProps {
  message: Message;
  onClose: () => void;
}

export default function ForwardSheet({ message, onClose }: ForwardSheetProps) {
  async function forward(targets: string[]): Promise<PickerResult> {
    try {
      const res = await api.post<ForwardMessageResponse>(
        `/api/conversations/${message.conversation_id}/messages/${message.seq}/forward`,
        { client_msg_id: uuidv7(), target_conversation_ids: targets },
      );
      for (const m of res.messages) {
        store.applyMessage(m);
        void db.storeMessages(m.conversation_id, [m]).catch(() => undefined);
      }
      return { error: null, sent: targets };
    } catch (err) {
      // All-or-nothing (§1.31): nothing was delivered on any error.
      if (err instanceof ApiError && err.code === 'not_forwardable') {
        return { error: 'This kind of message stays where it happened.', sent: [] };
      }
      if (err instanceof ApiError && err.status === 404) {
        return { error: 'One of those chats is not available right now.', sent: [] };
      }
      return { error: 'Could not forward — try again.', sent: [] };
    }
  }

  return (
    <ChatPickerSheet
      title="Forward to…"
      preview={<span title={messageSnippet(message)}>{messageSnippet(message)}</span>}
      verb="Forward"
      doneLabel="Forwarded ✓"
      onClose={onClose}
      onConfirm={forward}
    />
  );
}
