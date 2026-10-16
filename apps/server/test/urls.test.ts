import { describe, expect, it } from 'vitest';
import { extractFirstUrl, normalizeUrl, urlHash } from '../src/lib/urls.js';

describe('normalizeUrl', () => {
  it('lowercases the host and strips the fragment', () => {
    expect(normalizeUrl('https://Example.COM/Path#section')).toBe('https://example.com/Path');
  });

  it('strips utm_* and known tracking params, keeps the rest', () => {
    expect(normalizeUrl('https://example.com/a?utm_source=x&fbclid=y&q=1')).toBe(
      'https://example.com/a?q=1',
    );
  });

  it('throws on unparseable input', () => {
    expect(() => normalizeUrl('not a url')).toThrow();
  });
});

describe('urlHash', () => {
  it('is a stable 64-char hex sha256', () => {
    const h = urlHash('https://example.com/');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(urlHash('https://example.com/')).toBe(h);
    expect(urlHash('https://example.org/')).not.toBe(h);
  });
});

describe('extractFirstUrl', () => {
  it('finds the first http(s) URL in a body', () => {
    expect(extractFirstUrl('look at https://example.com/x and https://other.test')).toBe(
      'https://example.com/x',
    );
  });

  it('returns null when there is no URL', () => {
    expect(extractFirstUrl('no links here')).toBeNull();
  });

  it('does not swallow trailing quotes/brackets', () => {
    expect(extractFirstUrl('("https://example.com/x")')).toBe('https://example.com/x');
  });
});
