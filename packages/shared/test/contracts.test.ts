import { describe, expect, it } from 'vitest';
import {
  CreateConversationRequestSchema,
  ListMessagesQuerySchema,
  MAX_GROUP_PARTICIPANTS,
  PASSWORD_MIN_LENGTH,
  SendMessageRequestSchema,
  ServerEventSchema,
  USERNAME_REGEX,
} from '../src/index.js';

const UUID = '018f6b2a-0000-7000-8000-000000000000';

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
});
