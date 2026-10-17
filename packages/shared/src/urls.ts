// URL extraction shared by the web composer and the server send path. ONE
// canonical implementation so both ends extract (and therefore preview/cache)
// the same URL for the same message body — a drifted client regex would
// produce two cache rows / two different cards for one logical link.

// `URL` exists in every runtime this package targets (Node 22 and browsers);
// the shared tsconfig deliberately loads neither the DOM nor the Node libs,
// so give the constructor a minimal local type.
declare const URL: new (input: string) => { toString(): string };

/**
 * First http(s) URL in a message body, or null. The character class excludes
 * whitespace, quotes and closing `)`/`]` so a URL wrapped in parentheses or
 * brackets is extracted without the trailing punctuation.
 */
export function extractFirstUrl(body: string): string | null {
  const match = body.match(/https?:\/\/[^\s<>"')\]]+/i);
  if (!match) return null;
  try {
    return new URL(match[0]).toString();
  } catch {
    return null;
  }
}

/**
 * v0.6 watch together (API.md §1.43 + §2.12): the YouTube video id from a
 * pasted URL, or null. ONE canonical implementation for the same reason as
 * extractFirstUrl — the server parses the host's `watch.start` URL with this,
 * and the composer uses it to light the "watch together" affordance; a
 * drifted client regex would offer sessions the server then refuses.
 * Handles watch?v=, youtu.be/, shorts/, live/, embed/ (and the -nocookie
 * host); the id is exactly 11 chars of [A-Za-z0-9_-]
 * (YOUTUBE_VIDEO_ID_REGEX in constants.ts).
 */
export function extractYoutubeVideoId(url: string): string | null {
  const match = url.match(
    /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/i,
  );
  return match ? match[1] : null;
}
