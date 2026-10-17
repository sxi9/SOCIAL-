// Fastify app factory — shared by the api entrypoint and integration tests.
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { config } from './config.js';
import { authRoutes } from './modules/auth/routes.js';
import { beaconRoutes } from './modules/beacons/routes.js';
import { blockRoutes } from './modules/blocks/routes.js';
import { channelRoutes } from './modules/conversations/channels.js';
import { connectionRoutes } from './modules/connections/routes.js';
import { conversationRoutes } from './modules/conversations/routes.js';
import { feedRoutes } from './modules/feed/routes.js';
import { pinRoutes } from './modules/pins/routes.js';
import { profileRoutes } from './modules/profiles/routes.js';
import { storyRoutes } from './modules/stories/routes.js';
import { gameRoutes } from './modules/games/routes.js';
import { inviteRoutes } from './modules/invites/routes.js';
import { messageRoutes } from './modules/messages/routes.js';
import { pollRoutes } from './modules/polls/routes.js';
import { prefsRoutes } from './modules/prefs/routes.js';
import { puzzleRoutes } from './modules/puzzle/routes.js';
import { scheduledRoutes } from './modules/scheduled/routes.js';
import { previewRoutes } from './modules/previews/routes.js';
import { pushRoutes } from './modules/push/routes.js';
import { reactionRoutes } from './modules/reactions/routes.js';
import { reportRoutes } from './modules/reports/routes.js';
import { settingsRoutes } from './modules/settings/routes.js';
import { shareRoutes } from './modules/share/routes.js';
import { uploadRoutes } from './modules/uploads/routes.js';
import { userRoutes } from './modules/users/routes.js';
import { moodRoutes } from './modules/users/mood.js';
import { activityRoutes } from './modules/activity/routes.js';
import { releaseRoutes } from './modules/releases/routes.js';
import { listingRoutes } from './modules/listings/routes.js';
import { personReviewRoutes } from './modules/listings/reviews.js';
import { adminRoutes } from './modules/admin/routes.js';
import { adminContentRoutes } from './modules/admin/content.js';
import { anonRoutes } from './modules/anon/routes.js';
import { callRoutes } from './modules/calls/routes.js';
import { groupVisibilityRoutes } from './modules/conversations/visibility.js';
import { discoveryRoutes } from './modules/discovery/routes.js';
import { rouletteRoutes } from './modules/discovery/roulette.js';
import { rescueRoutes } from './modules/rescue/routes.js';
import { sharePageRoutes } from './modules/sharepages/routes.js';
import { suggestionRoutes } from './modules/suggestions/routes.js';
import { supportRoutes } from './modules/support/routes.js';
import { ApiError } from './lib/errors.js';
import { createRingLogStream } from './lib/logring.js';

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // v0.5b (§1.41): the pino destination tees warn+error lines into the admin
    // log ring (lib/logring.ts) while stdout keeps every line verbatim.
    logger: (opts.logger ?? true) ? { stream: createRingLogStream() } : false,
    // Fixer r1: exactly ONE trusted hop (Caddy). `true` trusted every hop and
    // made req.ip the LEFTMOST (client-forged) X-Forwarded-For entry — which
    // v0.5b stores as registration_ip/sessions.ip and keys rate limits on.
    // With 1, req.ip is the entry Caddy appended (the address Caddy saw).
    trustProxy: 1,
    bodyLimit: 1024 * 1024,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifyCookie, { secret: config.sessionSecret });

  // Multipart bodies are consumed manually (busboy on req.raw) — the parser is
  // a no-op so uploads stream instead of buffering.
  app.addContentTypeParser('multipart/form-data', (_req, _payload, done) => {
    done(null, undefined);
  });

  app.decorateRequest('auth', null);

  // CSRF (ARCHITECTURE §4): every mutating /api route requires the custom
  // header — a cross-origin form can't set it without passing CORS preflight.
  app.addHook('onRequest', async (req, reply) => {
    if (!MUTATING_METHODS.has(req.method)) return;
    if (!req.url.startsWith('/api/')) return;
    if (req.headers['x-requested-with'] !== 'fetch') {
      await reply.status(403).send({ error: 'csrf' });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      if (err.retryAfterS !== undefined) reply.header('retry-after', String(err.retryAfterS));
      const body: { error: string; message?: string } = { error: err.code };
      if (err.message && err.message !== err.code) body.message = err.message;
      return reply.status(err.statusCode).send(body);
    }
    if (err.validation) {
      return reply.status(400).send({ error: 'validation', message: err.message });
    }
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error(err);
    return reply
      .status(status)
      .send({ error: status >= 500 ? 'internal' : 'bad_request', message: status >= 500 ? undefined : err.message });
  });

  app.get('/healthz', async () => ({ ok: true as const }));

  await app.register(authRoutes);
  await app.register(profileRoutes); // v0.5a §1.37 (/users/me/profile before userRoutes' :username is path-distinct)
  await app.register(moodRoutes); // v0.8a §1.57 (/users/me/mood — path-distinct from :username)
  await app.register(activityRoutes); // v0.8a §1.59 (/users/:username/activity)
  await app.register(releaseRoutes); // v0.8a §1.61 (/api/releases)
  await app.register(userRoutes);
  await app.register(settingsRoutes); // v0.3 §1.13 (before userRoutes' :username catch is fine — paths are distinct)
  await app.register(blockRoutes); // v0.3 §1.14
  await app.register(reportRoutes); // v0.3 §1.14
  await app.register(connectionRoutes); // v0.5a §1.28
  await app.register(conversationRoutes);
  await app.register(channelRoutes); // v0.5a §1.35
  await app.register(pinRoutes); // v0.5a §1.32
  await app.register(messageRoutes);
  await app.register(reactionRoutes);
  await app.register(pollRoutes); // v0.3 §1.17
  await app.register(beaconRoutes); // v0.3 §1.15/§1.16
  await app.register(prefsRoutes); // v0.4 §1.24
  await app.register(scheduledRoutes); // v0.4 §1.26
  await app.register(gameRoutes); // v0.4 §1.27
  await app.register(puzzleRoutes); // v0.4 §1.27
  await app.register(storyRoutes); // v0.5a §1.34
  await app.register(feedRoutes); // v0.5a §1.36
  await app.register(listingRoutes); // v0.5b §1.38/§1.39
  await app.register(personReviewRoutes); // v0.5b §1.40
  await app.register(adminRoutes); // v0.5b §1.41
  await app.register(adminContentRoutes); // v0.8b §1.69 (content tab, takedowns, context, update)
  await app.register(supportRoutes); // v0.8b §1.69 (help & feedback + admin inbox)
  await app.register(anonRoutes); // v0.8b §1.62 (anonymous reveal game)
  await app.register(suggestionRoutes); // v0.8b §1.64 (people you may know)
  await app.register(groupVisibilityRoutes); // v0.8b §1.68 (visibility, joins, masks)
  await app.register(sharePageRoutes); // v0.8b §1.67 (share links + public pages)
  await app.register(callRoutes); // v0.6 §1.42
  await app.register(discoveryRoutes); // v0.6 §1.44/§1.45
  await app.register(rouletteRoutes); // v0.6 §1.45
  await app.register(rescueRoutes); // v0.6 §1.46
  await app.register(inviteRoutes);
  await app.register(uploadRoutes);
  await app.register(previewRoutes);
  await app.register(shareRoutes);
  await app.register(pushRoutes);

  return app;
}
