// Regression: a busboy file stream delivered in one synchronous burst emits
// 'end' in the microtask gap between collectHead() resolving (listeners
// removed) and the next pipeline stage attaching its own 'end' listener.
// bufferRest/streamToTmp must treat `readableEnded` as ended or the upload
// awaits an 'end' that never fires again (v0.4 voice-note smoke deadlock).
// Pure stream test — no Postgres/Redis/S3 needed.
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { bufferRest, collectHead } from '../src/modules/uploads/pipeline.js';

function oneBurstStream(payload: Buffer): Readable {
  const s = new Readable({ read() {} });
  // One synchronous burst: all data plus EOF before any consumer microtask.
  s.push(payload);
  s.push(null);
  return s;
}

describe('upload pipeline one-burst stream race', () => {
  it('bufferRest resolves when the stream ended between collectHead and wiring', async () => {
    const payload = Buffer.alloc(8 * 1024, 7); // > SNIFF_BYTES (4KB), one chunk
    const file = oneBurstStream(payload);
    const head = await collectHead(file, 4096);
    expect(head.ended).toBe(false); // collectHead paused mid-"stream"
    // The await above yielded to the event loop: 'end' has already fired.
    expect(file.readableEnded).toBe(true);
    const buf = await Promise.race([
      bufferRest(file, head, 10 * 1024 * 1024),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock: bufferRest never resolved')), 2000)),
    ]);
    expect(buf.equals(payload)).toBe(true);
  });

  it('still consumes the remainder when the stream has not ended', async () => {
    const s = new Readable({ read() {} });
    s.push(Buffer.alloc(4096, 1));
    const headPromise = collectHead(s, 4096);
    const head = await headPromise;
    expect(head.ended).toBe(false);
    const rest = bufferRest(s, head, 1024 * 1024);
    s.push(Buffer.alloc(100, 2));
    s.push(null);
    const buf = await rest;
    expect(buf.length).toBe(4196);
  });
});
