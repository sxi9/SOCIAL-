// IndexedDB persistence (hand-rolled, no deps). Delivered receipts are only
// sent after these writes commit — the receipt-honesty rule (API.md §2.4).
import type { Message, SendMessageRequest } from '@socialchat/shared';

const DB_NAME = 'socialchat';
const DB_VERSION = 1;

export interface ConvMeta {
  conversation_id: string;
  /** All visible messages up to this seq are durably stored. */
  max_seq_stored: number;
}

export interface OutboxItem {
  client_msg_id: string;
  conversation_id: string;
  payload: SendMessageRequest;
  created_at: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('indexeddb unavailable'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('messages')) {
          db.createObjectStore('messages', { keyPath: ['conversation_id', 'seq'] });
        }
        if (!db.objectStoreNames.contains('conv_meta')) {
          db.createObjectStore('conv_meta', { keyPath: 'conversation_id' });
        }
        if (!db.objectStoreNames.contains('outbox')) {
          db.createObjectStore('outbox', { keyPath: 'client_msg_id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexeddb open failed'));
    });
  }
  return dbPromise;
}

function reqDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('idb tx aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('idb tx error'));
  });
}

/**
 * Durably store messages; advances max_seq_stored through the contiguous run
 * and returns the new watermark (the seq a `delivered` frame may claim).
 */
export async function storeMessages(conversationId: string, messages: Message[]): Promise<number> {
  const db = await openDb();
  const tx = db.transaction(['messages', 'conv_meta'], 'readwrite');
  const msgStore = tx.objectStore('messages');
  const metaStore = tx.objectStore('conv_meta');
  const prev = await reqDone<ConvMeta | undefined>(metaStore.get(conversationId) as IDBRequest<ConvMeta | undefined>);
  let max = prev?.max_seq_stored ?? 0;
  const seqs = new Set<number>();
  for (const m of messages) {
    msgStore.put(m);
    seqs.add(m.seq);
  }
  while (seqs.has(max + 1)) max += 1;
  const meta: ConvMeta = { conversation_id: conversationId, max_seq_stored: max };
  metaStore.put(meta);
  await txDone(tx);
  return max;
}

/** Force the stored watermark forward (visibility-floor jumps, adoption). */
export async function setMaxSeqStored(conversationId: string, seq: number): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('conv_meta', 'readwrite');
  const metaStore = tx.objectStore('conv_meta');
  const prev = await reqDone<ConvMeta | undefined>(metaStore.get(conversationId) as IDBRequest<ConvMeta | undefined>);
  const max = Math.max(prev?.max_seq_stored ?? 0, seq);
  metaStore.put({ conversation_id: conversationId, max_seq_stored: max } satisfies ConvMeta);
  await txDone(tx);
}

/** Adopt a snapshot conversation wholesale (API.md §2.8 step 3). */
export async function adoptConversation(
  conversationId: string,
  lastSeq: number,
  lastMessage: Message | null
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['messages', 'conv_meta'], 'readwrite');
  if (lastMessage) tx.objectStore('messages').put(lastMessage);
  const metaStore = tx.objectStore('conv_meta');
  const prev = await reqDone<ConvMeta | undefined>(metaStore.get(conversationId) as IDBRequest<ConvMeta | undefined>);
  const max = Math.max(prev?.max_seq_stored ?? 0, lastSeq);
  metaStore.put({ conversation_id: conversationId, max_seq_stored: max } satisfies ConvMeta);
  await txDone(tx);
}

export async function getAllMeta(): Promise<Map<string, number>> {
  const db = await openDb();
  const tx = db.transaction('conv_meta', 'readonly');
  const rows = await reqDone<ConvMeta[]>(tx.objectStore('conv_meta').getAll() as IDBRequest<ConvMeta[]>);
  const out = new Map<string, number>();
  for (const row of rows) out.set(row.conversation_id, row.max_seq_stored);
  return out;
}

export async function dropConversation(conversationId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['messages', 'conv_meta'], 'readwrite');
  tx.objectStore('conv_meta').delete(conversationId);
  tx.objectStore('messages').delete(
    IDBKeyRange.bound([conversationId, 0], [conversationId, Number.MAX_SAFE_INTEGER])
  );
  await txDone(tx);
}

/** Newest `limit` stored messages for a conversation, ascending by seq. */
export async function getMessagesTail(conversationId: string, limit: number): Promise<Message[]> {
  const db = await openDb();
  const tx = db.transaction('messages', 'readonly');
  const range = IDBKeyRange.bound([conversationId, 0], [conversationId, Number.MAX_SAFE_INTEGER]);
  const out: Message[] = [];
  await new Promise<void>((resolve, reject) => {
    const cursorReq = tx.objectStore('messages').openCursor(range, 'prev');
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor && out.length < limit) {
        out.push(cursor.value as Message);
        cursor.continue();
      } else {
        resolve();
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error ?? new Error('idb cursor failed'));
  });
  return out.reverse();
}

// ---- Outbound queue of unsent messages (API.md §2.8 step 5) ----

export async function addOutbox(item: OutboxItem): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('outbox', 'readwrite');
  tx.objectStore('outbox').put(item);
  await txDone(tx);
}

export async function listOutbox(): Promise<OutboxItem[]> {
  const db = await openDb();
  const tx = db.transaction('outbox', 'readonly');
  const rows = await reqDone<OutboxItem[]>(tx.objectStore('outbox').getAll() as IDBRequest<OutboxItem[]>);
  return rows.sort((a, b) => a.created_at - b.created_at);
}

export async function removeOutbox(clientMsgId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('outbox', 'readwrite');
  tx.objectStore('outbox').delete(clientMsgId);
  await txDone(tx);
}

export async function clearOutbox(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('outbox', 'readwrite');
  tx.objectStore('outbox').clear();
  await txDone(tx);
}
