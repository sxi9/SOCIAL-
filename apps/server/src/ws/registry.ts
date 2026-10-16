// In-process socket registry (ARCHITECTURE §4): keyed by sessionId with a
// userId index, so logout / session revocation closes live sockets instantly.
import type { WebSocket } from 'ws';

/** Per-(socket, conversation) inbound receipt coalescer state (hotspot H4):
 * at most one watermark apply per RECEIPT_COALESCE_MS; frames inside the
 * window merge losslessly (watermarks are monotonic maxima). */
export interface ReceiptGate {
  timer: NodeJS.Timeout;
  pending: { seq: number; raiseRead: boolean } | null;
}

export interface SocketMeta {
  userId: string;
  sessionId: string;
  isAlive: boolean;
  strikes: number;
  presenceSubs: Set<string>;
  receiptGates: Map<string, ReceiptGate>;
}

class Registry {
  private bySession = new Map<string, Set<WebSocket>>();
  private sessionsByUser = new Map<string, Set<string>>();
  private metaBySocket = new Map<WebSocket, SocketMeta>();
  private presenceWatchers = new Map<string, Set<WebSocket>>();

  add(ws: WebSocket, meta: SocketMeta): { firstSocketForUser: boolean } {
    this.metaBySocket.set(ws, meta);
    let set = this.bySession.get(meta.sessionId);
    if (!set) {
      set = new Set();
      this.bySession.set(meta.sessionId, set);
    }
    set.add(ws);
    let sessions = this.sessionsByUser.get(meta.userId);
    const firstSocketForUser = !this.userHasSockets(meta.userId);
    if (!sessions) {
      sessions = new Set();
      this.sessionsByUser.set(meta.userId, sessions);
    }
    sessions.add(meta.sessionId);
    return { firstSocketForUser };
  }

  remove(ws: WebSocket): { meta: SocketMeta; lastSocketForUser: boolean } | null {
    const meta = this.metaBySocket.get(ws);
    if (!meta) return null;
    this.metaBySocket.delete(ws);
    for (const watched of meta.presenceSubs) {
      this.presenceWatchers.get(watched)?.delete(ws);
    }
    const set = this.bySession.get(meta.sessionId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        this.bySession.delete(meta.sessionId);
        this.sessionsByUser.get(meta.userId)?.delete(meta.sessionId);
        if (this.sessionsByUser.get(meta.userId)?.size === 0) {
          this.sessionsByUser.delete(meta.userId);
        }
      }
    }
    return { meta, lastSocketForUser: !this.userHasSockets(meta.userId) };
  }

  metaOf(ws: WebSocket): SocketMeta | undefined {
    return this.metaBySocket.get(ws);
  }

  allSockets(): IterableIterator<[WebSocket, SocketMeta]> {
    return this.metaBySocket.entries();
  }

  userHasSockets(userId: string): boolean {
    const sessions = this.sessionsByUser.get(userId);
    if (!sessions) return false;
    for (const sid of sessions) {
      if ((this.bySession.get(sid)?.size ?? 0) > 0) return true;
    }
    return false;
  }

  socketsForUser(userId: string): WebSocket[] {
    const out: WebSocket[] = [];
    const sessions = this.sessionsByUser.get(userId);
    if (!sessions) return out;
    for (const sid of sessions) {
      for (const ws of this.bySession.get(sid) ?? []) out.push(ws);
    }
    return out;
  }

  socketsForSession(sessionId: string): WebSocket[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  /** All (sessionId, userId) pairs with at least one live socket. */
  liveSessions(): { sessionId: string; userId: string }[] {
    const seen = new Map<string, string>();
    for (const meta of this.metaBySocket.values()) {
      seen.set(meta.sessionId, meta.userId);
    }
    return [...seen.entries()].map(([sessionId, userId]) => ({ sessionId, userId }));
  }

  onlineUserIds(): string[] {
    return [...this.sessionsByUser.keys()].filter((id) => this.userHasSockets(id));
  }

  subscribePresence(ws: WebSocket, userIds: string[]): void {
    const meta = this.metaBySocket.get(ws);
    if (!meta) return;
    for (const id of userIds) {
      meta.presenceSubs.add(id);
      let watchers = this.presenceWatchers.get(id);
      if (!watchers) {
        watchers = new Set();
        this.presenceWatchers.set(id, watchers);
      }
      watchers.add(ws);
    }
  }

  unsubscribePresence(ws: WebSocket, userIds: string[]): void {
    const meta = this.metaBySocket.get(ws);
    if (!meta) return;
    for (const id of userIds) {
      meta.presenceSubs.delete(id);
      const watchers = this.presenceWatchers.get(id);
      watchers?.delete(ws);
      if (watchers && watchers.size === 0) this.presenceWatchers.delete(id);
    }
  }

  watchersOf(userId: string): WebSocket[] {
    return [...(this.presenceWatchers.get(userId) ?? [])];
  }
}

export const registry = new Registry();
