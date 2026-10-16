# ADR-004: Uploads proxied through the API, MinIO never exposed

Status: accepted · Date: 2026-10-16

## Context

Presigned-URL uploads require exposing MinIO through the proxy, CORS
configuration, and upload-confirm callbacks — three moving parts, a public
storage surface, and client-declared metadata the server never saw. Everything
runs on one box, where an extra hop is effectively free.

## Decision

- `POST /api/uploads` streams multipart through the API (busboy → S3 streams)
  into a private MinIO bucket reachable only on the compose network.
- The API sniffs magic bytes on the first chunk; the client-declared MIME is
  advisory only. Sniffed type decides `kind`; mismatch with the per-kind
  allowlist → 415. Size limits are enforced during the stream (avatar 15 MB,
  image 25 MB, video/file 100 MB).
- Object keys are content-hashed (`media/<sha256>.<ext>`); `GET /api/media/:key`
  is an auth-checked streaming proxy with
  `Cache-Control: private, max-age=31536000, immutable`. Generic files are
  always served `Content-Disposition: attachment` + `X-Content-Type-Options:
  nosniff`.

## Consequences

- One origin: the session cookie authenticates uploads and downloads; no CORS,
  no signed-URL expiry bugs, no confirm-callback race; validation happens while
  the bytes flow.
- MinIO has zero public surface; preview images and avatars are always served
  from our origin (readers leak no IPs to third parties).
- Cost: media bytes transit the api process twice (in and out). Accepted on a
  single VPS; if it ever matters, swapping to presigned URLs touches only the
  `uploads` module — the content-hash key scheme and media-proxy URL shape are
  the stable contract.
