import { describe, expect, it } from 'vitest';
import {
  AddReactionRequestSchema,
  chunk,
  CreateConversationRequestSchema,
  extractFirstUrl,
  INVITE_MAX_USES,
  INVITE_TOKEN_REGEX,
  INVITE_TTL_S,
  InvitePublicSchema,
  ListMessagesQuerySchema,
  MAX_GROUP_PARTICIPANTS,
  MessageSchema,
  PASSWORD_MIN_LENGTH,
  PRESENCE_SUB_MAX,
  PresenceSubEventSchema,
  REACTION_EMOJI_MAX_LEN,
  REACTIONS_PER_USER_PER_MESSAGE_MAX,
  RegisterRequestSchema,
  SendMessageRequestSchema,
  ServerEventSchema,
  USERNAME_REGEX,
} from '../src/index.js';

const UUID = '018f6b2a-0000-7000-8000-000000000000';

function uuidAt(i: number): string {
  return `018f6b2a-0000-7000-8000-${String(i).padStart(12, '0')}`;
}

describe('SendMessageRequestSchema', () => {
  it('accepts a text send with a client_msg_id', () => {
    const parsed = SendMessageRequestSchema.safeParse({
      client_msg_id: UUID,
      type: 'text',
      body: 'hi',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a send without client_msg_id (idempotency is mandatory)', () => {
    expect(SendMessageRequestSchema.safeParse({ type: 'text', body: 'hi' }).success).toBe(false);
  });

  it('rejects unknown message types', () => {
    expect(
      SendMessageRequestSchema.safeParse({ client_msg_id: UUID, type: 'system', body: 'x' }).success,
    ).toBe(false);
  });
});

describe('ListMessagesQuerySchema', () => {
  it('requires exactly one of after_seq / before_seq', () => {
    expect(ListMessagesQuerySchema.safeParse({ after_seq: 0 }).success).toBe(true);
    expect(ListMessagesQuerySchema.safeParse({ before_seq: 10 }).success).toBe(true);
    expect(ListMessagesQuerySchema.safeParse({}).success).toBe(false);
    expect(ListMessagesQuerySchema.safeParse({ after_seq: 0, before_seq: 10 }).success).toBe(false);
  });

  it('caps limit at 100', () => {
    expect(ListMessagesQuerySchema.safeParse({ after_seq: 0, limit: 101 }).success).toBe(false);
  });
});

describe('CreateConversationRequestSchema', () => {
  it('accepts dm and group shapes', () => {
    expect(CreateConversationRequestSchema.safeParse({ type: 'dm', user_id: UUID }).success).toBe(true);
    expect(
      CreateConversationRequestSchema.safeParse({ type: 'group', title: 't', user_ids: [UUID] }).success,
    ).toBe(true);
  });

  it('does not Zod-reject an over-cap group — the route answers 400 group_too_large (API.md §1.4)', () => {
    const userIds = Array.from({ length: MAX_GROUP_PARTICIPANTS }, (_v, i) => uuidAt(i));
    expect(
      CreateConversationRequestSchema.safeParse({ type: 'group', title: 't', user_ids: userIds }).success,
    ).toBe(true);
  });
});

describe('extractFirstUrl (shared — ONE implementation for web + server)', () => {
  it('finds the first http(s) URL', () => {
    expect(extractFirstUrl('see https://example.com/x then https://other.test')).toBe(
      'https://example.com/x',
    );
    expect(extractFirstUrl('no links')).toBeNull();
  });

  it('does not swallow trailing quotes, parens or brackets', () => {
    expect(extractFirstUrl('("https://example.com/x")')).toBe('https://example.com/x');
    expect(extractFirstUrl('[link](https://example.com/y)')).toBe('https://example.com/y');
  });
});

describe('presence.sub chunking (API.md §2.4)', () => {
  it('chunk() splits an oversized subscription set into frames the schema accepts', () => {
    const ids = Array.from({ length: 2 * PRESENCE_SUB_MAX + 50 }, (_v, i) => uuidAt(i));
    // A single frame with the whole set is over the cap and must fail…
    expect(PresenceSubEventSchema.safeParse({ t: 'presence.sub', d: { user_ids: ids } }).success).toBe(
      false,
    );
    // …while every chunked frame is within it.
    const chunks = chunk(ids, PRESENCE_SUB_MAX);
    expect(chunks.map((c) => c.length)).toEqual([PRESENCE_SUB_MAX, PRESENCE_SUB_MAX, 50]);
    expect(chunks.flat()).toEqual(ids);
    for (const c of chunks) {
      expect(PresenceSubEventSchema.safeParse({ t: 'presence.sub', d: { user_ids: c } }).success).toBe(
        true,
      );
    }
  });

  it('chunk() handles empty input and rejects nonsense sizes', () => {
    expect(chunk([], 10)).toEqual([]);
    expect(() => chunk([1, 2], 0)).toThrow(RangeError);
  });
});

describe('ServerEventSchema', () => {
  it('parses a preview.ready event', () => {
    const parsed = ServerEventSchema.safeParse({
      t: 'preview.ready',
      d: { url_hash: 'a'.repeat(64), status: 'failed' },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('constants', () => {
  it('holds the blueprint invariants', () => {
    expect(MAX_GROUP_PARTICIPANTS).toBe(256);
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(USERNAME_REGEX.test('valid_user1')).toBe(true);
    expect(USERNAME_REGEX.test('No')).toBe(false);
  });

  it('holds the v0.2 invariants', () => {
    expect(INVITE_TTL_S).toBe(7 * 24 * 3600);
    expect(INVITE_MAX_USES).toBe(50);
    expect(REACTION_EMOJI_MAX_LEN).toBe(16);
    expect(REACTIONS_PER_USER_PER_MESSAGE_MAX).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// v0.2 — invites (API.md §1.11) + reactions (§1.12/§2.3)
// ---------------------------------------------------------------------------

const TOKEN_43 = 'a'.repeat(43); // 32 bytes base64url

describe('invite token shape', () => {
  it('accepts base64url tokens of 32..128 chars, rejects others', () => {
    expect(INVITE_TOKEN_REGEX.test(TOKEN_43)).toBe(true);
    expect(INVITE_TOKEN_REGEX.test('short')).toBe(false);
    expect(INVITE_TOKEN_REGEX.test(`${'a'.repeat(42)}/`)).toBe(false); // not url-safe
  });

  it('RegisterRequest takes an optional, deliberately LOOSE invite_token', () => {
    const base = { username: 'bored_user', email: 'x@example.com', password: 'p'.repeat(8), display_name: 'X' };
    expect(RegisterRequestSchema.safeParse(base).success).toBe(true);
    expect(RegisterRequestSchema.safeParse({ ...base, invite_token: TOKEN_43 }).success).toBe(true);
    // API.md §1.1: registration NEVER fails because of a bad invite — a
    // malformed/truncated token must pass the schema and degrade to
    // invite: null in the handler, not 400 the whole registration.
    expect(RegisterRequestSchema.safeParse({ ...base, invite_token: 'nope' }).success).toBe(true);
    expect(RegisterRequestSchema.safeParse({ ...base, invite_token: 'a'.repeat(257) }).success).toBe(false);
  });
});

describe('InvitePublicSchema', () => {
  it('parses the join-page payload with proxy avatar URLs', () => {
    const parsed = InvitePublicSchema.safeParse({
      status: 'valid',
      kind: 'group',
      group_title: 'bored people',
      inviter: {
        username: 'hk',
        display_name: 'HK',
        avatar: {
          status: 'ready',
          version: 3,
          static_url: `/api/invites/${TOKEN_43}/avatar?v=static&ver=3`,
          animated_url: `/api/invites/${TOKEN_43}/avatar?v=animated&ver=3`,
        },
      },
      expires_at: '2026-10-23T00:00:00Z',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('reactions contract', () => {
  it('Message.reactions defaults to [] so pre-v0.2 payloads parse clean', () => {
    const parsed = MessageSchema.safeParse({
      id: UUID,
      conversation_id: UUID,
      seq: 1,
      sender_id: UUID,
      type: 'text',
      body: 'hi',
      metadata: {},
      reply_to_id: null,
      attachments: [],
      created_at: '2026-10-16T00:00:00Z',
      edited_at: null,
      deleted_at: null,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.reactions).toEqual([]);
  });

  it('AddReactionRequest bounds emoji to 1..REACTION_EMOJI_MAX_LEN', () => {
    expect(AddReactionRequestSchema.safeParse({ emoji: '👍' }).success).toBe(true);
    expect(AddReactionRequestSchema.safeParse({ emoji: '' }).success).toBe(false);
    expect(
      AddReactionRequestSchema.safeParse({ emoji: 'x'.repeat(REACTION_EMOJI_MAX_LEN + 1) }).success,
    ).toBe(false);
  });

  it('ServerEventSchema parses reaction.updated', () => {
    const parsed = ServerEventSchema.safeParse({
      t: 'reaction.updated',
      d: { conversation_id: UUID, seq: 7, emoji: '🔥', count: 0, user_id: UUID, removed: true },
    });
    expect(parsed.success).toBe(true);
  });
});
