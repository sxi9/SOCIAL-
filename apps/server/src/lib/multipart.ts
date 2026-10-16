// Thin busboy wrapper: fields collected, file streams handed to the caller as
// they arrive (multipart parts are sequential). Fastify's content-type parser
// for multipart is a no-op so req.raw still carries the body.
import busboy from 'busboy';
import type { FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { badRequest } from './errors.js';

export interface FileInfo {
  filename?: string;
  mimeType: string;
}

export type OnFile = (fieldname: string, file: Readable, info: FileInfo) => Promise<void> | void;

export function parseMultipart(
  req: FastifyRequest,
  onFile: OnFile,
  opts?: { maxFiles?: number },
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let bb: busboy.Busboy;
    try {
      bb = busboy({
        headers: req.headers as Record<string, string>,
        limits: { files: opts?.maxFiles ?? 10, fields: 20, fieldSize: 64 * 1024 },
      });
    } catch {
      reject(badRequest('bad_multipart'));
      return;
    }
    const fields: Record<string, string> = {};
    const tasks: Promise<void>[] = [];
    let settled = false;

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      try {
        req.raw.unpipe(bb);
      } catch {
        // ignore
      }
      reject(err);
    };

    bb.on('field', (name, value) => {
      fields[name] = value;
    });
    bb.on('file', (name, file, info) => {
      if (settled) {
        file.resume();
        return;
      }
      tasks.push(
        (async () => {
          try {
            await onFile(name, file, { filename: info.filename, mimeType: info.mimeType });
          } catch (err) {
            file.resume();
            fail(err);
          }
        })(),
      );
    });
    bb.on('error', (err) => fail(err));
    bb.on('close', () => {
      void Promise.all(tasks).then(() => {
        if (!settled) {
          settled = true;
          resolve(fields);
        }
      });
    });
    req.raw.pipe(bb);
  });
}
