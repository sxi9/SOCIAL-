import { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { config } from './config.js';

// MinIO is compose-network-only; never exposed through the proxy.
export const s3 = new S3Client({
  endpoint: config.minio.endpoint,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.minio.accessKeyId,
    secretAccessKey: config.minio.secretAccessKey,
  },
});

export const BUCKET = config.minio.bucket;

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }),
  );
}

// Streaming upload of unknown length (proxied multipart) via lib-storage.
export async function uploadStream(
  key: string,
  body: Readable,
  contentType: string,
): Promise<void> {
  const up = new Upload({
    client: s3,
    params: { Bucket: BUCKET, Key: key, Body: body, ContentType: contentType },
  });
  await up.done();
}

export async function copyObject(fromKey: string, toKey: string): Promise<void> {
  await s3.send(
    new CopyObjectCommand({
      Bucket: BUCKET,
      Key: toKey,
      CopySource: `${BUCKET}/${encodeURIComponent(fromKey)}`,
    }),
  );
}

export async function deleteObject(key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch {
    // best-effort; GC re-sweeps
  }
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export interface S3ObjectStream {
  body: Readable;
  contentLength: number | undefined;
  contentType: string | undefined;
  contentRange: string | undefined;
}

export async function getObjectStream(key: string, range?: string): Promise<S3ObjectStream> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key, Range: range }));
  return {
    body: res.Body as Readable,
    contentLength: res.ContentLength,
    contentType: res.ContentType,
    contentRange: res.ContentRange,
  };
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks: Buffer[] = [];
  for await (const chunk of res.Body as Readable) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function listKeys(prefix: string): Promise<{ key: string; lastModified: Date | undefined }[]> {
  const out: { key: string; lastModified: Date | undefined }[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) out.push({ key: obj.Key, lastModified: obj.LastModified });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}
