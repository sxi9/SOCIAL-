// Entrypoint: HTTP + WS process (ARCHITECTURE §2).
import { buildApp } from './app.js';
import { config } from './config.js';
import { setupGateway } from './ws/gateway.js';

async function main(): Promise<void> {
  const app = await buildApp();

  setupGateway(app.server);

  await app.listen({ host: config.host, port: config.port });

  const shutdown = async () => {
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error('api: failed to start', err);
  process.exit(1);
});
