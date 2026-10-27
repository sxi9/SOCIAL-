// robots.txt (§1b, 2026-10-27). Capability URLs — share pages, story share
// pages, invite links — and the API are never crawl targets: a revoked link
// must leave no search-engine copy behind. The rest of the app sits behind
// sign-in anyway. The share routes also send `noindex` per page
// (SharePageRoute.sharePageMetadata) for crawlers that ignore robots.txt.
import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', disallow: ['/p/', '/s/', '/join/', '/api/'] }],
  };
}
