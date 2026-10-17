// v1.0a (#91) — photos on every board kind + honest undecodable-image 415.
// Needs live Postgres/Redis AND an S3 endpoint (uploads write real objects);
// skips cleanly without them, like every integration suite here.
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Listing } from '@socialchat/shared';

const infra = Boolean(
  process.env.DATABASE_URL && process.env.REDIS_URL && process.env.MINIO_ENDPOINT,
);

const CSRF = { 'x-requested-with': 'fetch' } as const;
const run = Date.now().toString(36);

let ipCounter = 0;
const ipBase = Date.now() & 0xffffff;
function nextIp(): string {
  ipCounter += 1;
  const n = (ipBase + ipCounter * 13) & 0xffffff;
  return `17.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

interface Session {
  sid: string;
  userId: string;
}

describe.runIf(infra)('v1.0a board photos + undecodable images', () => {
  let app: FastifyInstance;
  let author: Session;
  const AREA = `photoville-${run}`;

  async function register(username: string): Promise<Session> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { ...CSRF, 'x-forwarded-for': nextIp() },
      payload: {
        username,
        email: `${username}@example.com`,
        password: 'password123',
        display_name: username,
      },
    });
    expect(res.statusCode).toBe(201);
    return {
      sid: res.cookies.find((c) => c.name === 'sid')!.value,
      userId: (res.json() as { user: { id: string } }).user.id,
    };
  }

  /** Binary multipart body with a single `file` part. */
  function filePart(name: string, mime: string, buf: Buffer) {
    const boundary = `----vitest${Math.random().toString(36).slice(2)}`;
    const head = Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${name}"\r\n` +
        `content-type: ${mime}\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    return {
      payload: Buffer.concat([head, buf, tail]),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  async function uploadPng(me: Session): Promise<string> {
    const png = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 10, g: 120, b: 200 } },
    })
      .png()
      .toBuffer();
    const { payload, contentType } = filePart('p.png', 'image/png', png);
    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { ...CSRF, 'content-type': contentType },
      cookies: { sid: me.sid },
      payload,
    });
    expect(res.statusCode).toBe(201);
    const att = (res.json() as { attachment: { id: string; thumb_url: string | null } })
      .attachment;
    expect(att.thumb_url).not.toBeNull(); // decodable images always get a thumb
    return att.id;
  }

  async function createListing(me: Session, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/api/listings',
      headers: CSRF,
      cookies: { sid: me.sid },
      payload,
    });
  }

  beforeAll(async () => {
    const { applyMigrations } = await import('./helpers/migrations.js');
    await applyMigrations(process.env.DATABASE_URL!);
    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });
    await app.ready();
    author = await register(`va_author_${run}`);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: CSRF,
      cookies: { sid: author.sid },
      payload: { area: AREA },
    });
    expect(res.statusCode).toBe(200);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('gig listings carry photos (#91 — previously room-only)', async () => {
    const attId = await uploadPng(author);
    const res = await createListing(author, {
      kind: 'gig',
      title: 'I paint murals',
      details: { direction: 'offering', tags: ['art'], attachment_ids: [attId] },
    });
    expect(res.statusCode).toBe(201);
    const listing = (res.json() as { listing: Listing }).listing;
    expect(listing.photos).toHaveLength(1);
    expect(listing.photos[0].id).toBe(attId);
  });

  it('ride and place_review listings carry photos too', async () => {
    for (const payload of [
      {
        kind: 'ride',
        title: 'Airport run',
        details: {
          from_text: 'Town',
          to_text: 'Airport',
          departs_at: new Date(Date.now() + 3600_000).toISOString(),
          seats: 2,
          attachment_ids: [await uploadPng(author)],
        },
      },
      {
        kind: 'place_review',
        title: 'Chai corner',
        details: { place_name: 'Chai Corner', rating: 5, attachment_ids: [await uploadPng(author)] },
      },
    ]) {
      const res = await createListing(author, payload);
      expect(res.statusCode).toBe(201);
      expect((res.json() as { listing: Listing }).listing.photos).toHaveLength(1);
    }
  });

  it('a bound attachment cannot be attached to a second listing (400 bad_attachment)', async () => {
    const attId = await uploadPng(author);
    const first = await createListing(author, {
      kind: 'gig',
      title: 'First',
      details: { direction: 'seeking', tags: [], attachment_ids: [attId] },
    });
    expect(first.statusCode).toBe(201);
    const second = await createListing(author, {
      kind: 'gig',
      title: 'Second',
      details: { direction: 'seeking', tags: [], attachment_ids: [attId] },
    });
    expect(second.statusCode).toBe(400);
    expect((second.json() as { error: string }).error).toBe('bad_attachment');
  });

  it('PATCH re-binds photos on a gig (add + drop)', async () => {
    const keep = await uploadPng(author);
    const dropped = await uploadPng(author);
    const created = await createListing(author, {
      kind: 'gig',
      title: 'Editable',
      details: { direction: 'offering', tags: [], attachment_ids: [dropped] },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { listing: Listing }).listing.id;
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/listings/${id}`,
      headers: CSRF,
      cookies: { sid: author.sid },
      payload: {
        kind: 'gig',
        details: { direction: 'offering', tags: [], attachment_ids: [keep] },
      },
    });
    expect(patched.statusCode).toBe(200);
    const listing = (patched.json() as { listing: Listing }).listing;
    expect(listing.photos.map((p) => p.id)).toEqual([keep]);
    // the dropped one is unbound again — attachable to a fresh listing
    const reuse = await createListing(author, {
      kind: 'gig',
      title: 'Reuse',
      details: { direction: 'offering', tags: [], attachment_ids: [dropped] },
    });
    expect(reuse.statusCode).toBe(201);
  });

  it('suggestion filters narrow (#78c): interests flag + shared_interests decoration', async () => {
    // Three fresh users in one fresh area: two share a public interest tag.
    const area = `sugg-${run}`;
    const x = await register(`va_x_${run}`);
    const y = await register(`va_y_${run}`);
    const z = await register(`va_z_${run}`);
    for (const [who, interests] of [
      [x, ['chess', 'tea']],
      [y, ['chess']],
      [z, ['running']],
    ] as const) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/users/me',
        headers: CSRF,
        cookies: { sid: who.sid },
        payload: { area },
      });
      expect(res.statusCode).toBe(200);
      // interests live on the §1.37 profile (full-replace per present field)
      const prof = await app.inject({
        method: 'PATCH',
        url: '/api/users/me/profile',
        headers: CSRF,
        cookies: { sid: who.sid },
        payload: { interests: [...interests] },
      });
      expect(prof.statusCode).toBe(200);
    }
    const get = (qs: string) =>
      app.inject({ method: 'GET', url: `/api/suggestions${qs}`, cookies: { sid: x.sid } });

    const all = (await get('')).json() as { suggestions: { user: { id: string } }[] };
    const allIds = all.suggestions.map((s2) => s2.user.id);
    expect(allIds).toContain(y.userId); // same area
    expect(allIds).toContain(z.userId);

    const narrowed = (await get('?interests=1')).json() as {
      suggestions: { user: { id: string }; shared_interests: string[] }[];
    };
    const ids = narrowed.suggestions.map((s2) => s2.user.id);
    expect(ids).toContain(y.userId); // shares 'chess'
    expect(ids).not.toContain(z.userId); // no overlap
    const yCard = narrowed.suggestions.find((s2) => s2.user.id === y.userId)!;
    expect(yCard.shared_interests).toEqual(['chess']);

    // area flag with an area keeps both; a user with NO area gets honest empty
    const areaIds = ((await get('?area=1')).json() as { suggestions: { user: { id: string } }[] })
      .suggestions.map((s2) => s2.user.id);
    expect(areaIds).toContain(y.userId);
    expect(areaIds).toContain(z.userId);

    const mutIds = ((await get('?mutuals=1')).json() as { suggestions: { user: { id: string } }[] })
      .suggestions.map((s2) => s2.user.id);
    expect(mutIds).toHaveLength(0); // x has no connections yet
  });

  it('gallery (#94): bound media lists; story auto-saves on sweep; save delete re-orphans', async () => {
    const g = await register(`va_gal_${run}`);
    // A posted image is in the gallery (bound, saved=false).
    const postAtt = await uploadPng(g);
    const posted = await app.inject({
      method: 'POST',
      url: '/api/posts',
      headers: CSRF,
      cookies: { sid: g.sid },
      payload: { kind: 'text', audience: 'friends_of', body: 'pic', attachment_ids: [postAtt] },
    });
    expect(posted.statusCode).toBe(201);

    // A story that expires → auto-saved to the gallery, attachment survives.
    const storyAtt = await uploadPng(g);
    const story = await app.inject({
      method: 'POST',
      url: '/api/stories',
      headers: CSRF,
      cookies: { sid: g.sid },
      payload: { attachment_id: storyAtt, caption: '' },
    });
    expect(story.statusCode).toBe(201);
    const { db } = await import('../src/db/index.js');
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`UPDATE stories SET expires_at = now() - interval '1 minute'
      WHERE attachment_id = ${storyAtt}::uuid`);
    const { runStorySweep } = await import('../src/modules/stories/service.js');
    await runStorySweep();
    const [attRow] = (await db.execute(
      sql`SELECT id FROM attachments WHERE id = ${storyAtt}::uuid`,
    )) as unknown as { id: string }[];
    expect(attRow).toBeDefined(); // survived the sweep (#94)

    const gal = await app.inject({
      method: 'GET',
      url: '/api/users/me/gallery',
      cookies: { sid: g.sid },
    });
    expect(gal.statusCode).toBe(200);
    const items = (gal.json() as { items: { attachment: { id: string }; saved: boolean }[] }).items;
    const ids = items.map((i) => i.attachment.id);
    expect(ids).toContain(postAtt);
    expect(ids).toContain(storyAtt);
    expect(items.find((i) => i.attachment.id === storyAtt)!.saved).toBe(true);
    expect(items.find((i) => i.attachment.id === postAtt)!.saved).toBe(false);

    // saved filter narrows; deleting the save removes it
    const savedOnly = (
      (await app.inject({
        method: 'GET',
        url: '/api/users/me/gallery?saved=1',
        cookies: { sid: g.sid },
      })).json() as { items: { attachment: { id: string } }[] }
    ).items.map((i) => i.attachment.id);
    expect(savedOnly).toEqual([storyAtt]);
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/users/me/gallery/${storyAtt}`,
      headers: CSRF,
      cookies: { sid: g.sid },
    });
    expect(del.statusCode).toBe(204);
    const after = (
      (await app.inject({ method: 'GET', url: '/api/users/me/gallery', cookies: { sid: g.sid } }))
        .json() as { items: { attachment: { id: string } }[] }
    ).items.map((i) => i.attachment.id);
    expect(after).not.toContain(storyAtt);
  });

  it('shared chat background (#95): DM member sets for both; group non-admin 403; clear works', async () => {
    const a = await register(`va_bga_${run}`);
    const b = await register(`va_bgb_${run}`);
    // DM
    const dm = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: CSRF,
      cookies: { sid: a.sid },
      payload: { type: 'dm', user_id: b.userId },
    });
    expect(dm.statusCode).toBe(201);
    const dmId = (dm.json() as { conversation: { id: string } }).conversation.id;
    const att = await uploadPng(a);
    const set = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${dmId}/background`,
      headers: CSRF,
      cookies: { sid: a.sid },
      payload: { attachment_id: att },
    });
    expect(set.statusCode).toBe(200);
    // BOTH sides see it through the prefs read
    for (const who of [a, b]) {
      const prefs = await app.inject({
        method: 'GET',
        url: `/api/conversations/${dmId}/prefs`,
        cookies: { sid: who.sid },
      });
      expect(prefs.statusCode).toBe(200);
      const got = (prefs.json() as { prefs: { shared_background: { id: string } | null } }).prefs;
      expect(got.shared_background?.id).toBe(att);
    }
    // someone else's upload cannot be my shared background
    const notMine = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${dmId}/background`,
      headers: CSRF,
      cookies: { sid: b.sid },
      payload: { attachment_id: att }, // a's upload
    });
    expect(notMine.statusCode).toBe(400);
    // clear
    const clear = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${dmId}/background`,
      headers: CSRF,
      cookies: { sid: a.sid },
      payload: { attachment_id: null },
    });
    expect(clear.statusCode).toBe(200);

    // Group: plain member → 403 not_admin
    const grp = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: CSRF,
      cookies: { sid: a.sid },
      payload: { type: 'group', title: 'bg test', user_ids: [b.userId] },
    });
    expect(grp.statusCode).toBe(201);
    const grpId = (grp.json() as { conversation: { id: string } }).conversation.id;
    const bAtt = await uploadPng(b);
    const denied = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${grpId}/background`,
      headers: CSRF,
      cookies: { sid: b.sid },
      payload: { attachment_id: bAtt },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('an undecodable image (HEVC HEIC) is rejected 415, never stored broken (#91)', async () => {
    // A sniff-valid HEIC header sharp cannot decode (no HEVC codec).
    const fake = Buffer.alloc(2048);
    fake.writeUInt32BE(24, 0);
    fake.write('ftypheic', 4);
    const { payload, contentType } = filePart('IMG_0001.heic', 'image/heic', fake);
    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { ...CSRF, 'content-type': contentType },
      cookies: { sid: author.sid },
      payload,
    });
    expect(res.statusCode).toBe(415);
    expect((res.json() as { error: string }).error).toBe('image_undecodable');
  });
});
