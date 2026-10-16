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
