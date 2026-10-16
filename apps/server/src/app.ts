// Fastify app factory — shared by the api entrypoint and integration tests.
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { config } from './config.js';
import { authRoutes } from './modules/auth/routes.js';
import { conversationRoutes } from './modules/conversations/routes.js';
import { inviteRoutes } from './modules/invites/routes.js';
import { messageRoutes } from './modules/messages/routes.js';
import { previewRoutes } from './modules/previews/routes.js';
import { pushRoutes } from './modules/push/routes.js';
import { reactionRoutes } from './modules/reactions/routes.js';
import { shareRoutes } from './modules/share/routes.js';
import { uploadRoutes } from './modules/uploads/routes.js';
import { userRoutes } from './modules/users/routes.js';
import { ApiError } from './lib/errors.js';

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? true,
    trustProxy: true, // behind Caddy
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
  await app.register(userRoutes);
  await app.register(conversationRoutes);
  await app.register(messageRoutes);
  await app.register(reactionRoutes);
  await app.register(inviteRoutes);
  await app.register(uploadRoutes);
  await app.register(previewRoutes);
  await app.register(shareRoutes);
  await app.register(pushRoutes);

  return app;
}
