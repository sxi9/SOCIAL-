// Wave 1 (AUDIT-PLAN §1.1, 2026-10-28) GET /api/instance — UNAUTHENTICATED,
// per-IP rate-limited: the operator contact, the resolved legal texts
// (operator markdown or the shipped default) and the age line. Read by the
// /terms /privacy /guidelines SSR pages (through API_ORIGIN, XFF re-sent),
// the auth scenes ("Hosted by") and Settings → Help & about.
import type { FastifyInstance } from 'fastify';
import { AGE_MIN, INSTANCE_PUBLIC_RATE_PER_HOUR_PER_IP, type PublicInstanceInfo } from '@socialchat/shared';
import { LEGAL_DEFAULTS } from '../../lib/legal.js';
import { rateLimited } from '../../lib/errors.js';
import { fixedWindow } from '../../lib/ratelimit.js';
import { getInstanceSettings } from '../admin/service.js';

export async function publicInstanceInfo(): Promise<PublicInstanceInfo> {
  const s = await getInstanceSettings();
  return {
    operator_contact: s.operator_contact,
    legal: {
      terms: s.legal.terms.trim() || LEGAL_DEFAULTS.terms,
      privacy: s.legal.privacy.trim() || LEGAL_DEFAULTS.privacy,
      guidelines: s.legal.guidelines.trim() || LEGAL_DEFAULTS.guidelines,
    },
    age_min: AGE_MIN,
  };
}

export async function instanceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/instance', async (req) => {
    const rate = await fixedWindow(`instance:${req.ip}`, INSTANCE_PUBLIC_RATE_PER_HOUR_PER_IP, 3600);
    if (!rate.allowed) throw rateLimited(rate.retryAfterS);
    return publicInstanceInfo();
  });
}
