import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import { createDb } from './db/connection.js';
import { runMigrations } from './db/migrations.js';
import { PgEventsStore } from './db/pg-events-store.js';
import { createRedisClient } from './redis/connection.js';
import { EventStream } from './redis/event-stream.js';
import { LiveStateManager } from './redis/live-state.js';
import { LeaseEngine } from './leases/lease-engine.js';
import { eventsRoute } from './routes/events.js';
import { realtimeRoute } from './routes/realtime.js';
import { leasesRoute } from './routes/leases.js';
import { createLogger } from '@context-workspace/shared';

const log = createLogger({ component: 'server' });

export interface ServerConfig {
  port: number;
  host: string;
  databaseUrl: string;
  redisUrl: string;
  corsOrigin?: string | string[] | undefined;
}

export * from './leases/lease-engine.js';
export * from './redis/live-state.js';
export * from './redis/event-stream.js';
export * from './redis/state-rebuilder.js';
export * from './db/pg-events-store.js';

/**
 * Build and return the Fastify server instance.
 * Does NOT start listening — call server.listen() separately.
 * This separation enables testing without port binding.
 */
export async function buildServer(config: ServerConfig) {
  // Infrastructure
  const sql = createDb({ url: config.databaseUrl });
  await runMigrations(sql);

  const redis = createRedisClient({ url: config.redisUrl });

  // Service layer
  const eventsStore = new PgEventsStore(sql);
  const eventStream = new EventStream(redis);
  const liveState = new LiveStateManager(redis);
  const leaseEngine = new LeaseEngine(sql);

  // Fastify
  const fastify = Fastify({
    logger: false, // We use our own structured logger
    trustProxy: true,
  });

  // Plugins
  await fastify.register(fastifyCors, {
    origin: config.corsOrigin ?? true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });
  await fastify.register(fastifyWebsocket);

  // Health / readiness
  fastify.get('/health', async (_request, reply) => {
    return reply.send({ status: 'ok', timestamp: Date.now() });
  });

  fastify.get('/ready', async (_request, reply) => {
    try {
      // Verify DB connectivity
      await sql`SELECT 1`;
      // Verify Redis connectivity
      await redis.ping();
      return reply.send({ status: 'ready', timestamp: Date.now() });
    } catch (err) {
      return reply.status(503).send({ status: 'not_ready', error: String(err) });
    }
  });

  // Routes
  await fastify.register(eventsRoute, { eventsStore, eventStream });
  await fastify.register(realtimeRoute, { eventStream, liveState });
  await fastify.register(leasesRoute, { leaseEngine });

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    log.info('Server shutting down...');
    await fastify.close();
    await redis.quit();
    await sql.end();
    log.info('Server stopped');
  };

  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });

  return { fastify, sql, redis, shutdown };
}

/**
 * Main entry point — reads config from environment and starts server.
 */
export async function main(): Promise<void> {
  const corsOrigin = process.env['CORS_ORIGIN'];
  const config: ServerConfig = {
    port: parseInt(process.env['PORT'] ?? '3000', 10),
    host: process.env['HOST'] ?? '0.0.0.0',
    databaseUrl: process.env['DATABASE_URL'] ?? 'postgresql://localhost/context_workspace',
    redisUrl: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
    ...(corsOrigin !== undefined ? { corsOrigin } : {}),
  };

  const { fastify } = await buildServer(config);

  await fastify.listen({ port: config.port, host: config.host });

  log.info('Context Server started', {
    port: String(config.port),
    host: config.host,
  });
}

// Only execute main if this file is executed directly (not imported in tests)
if (
  process.env['NODE_ENV'] !== 'test' &&
  !process.env['VITEST'] &&
  process.argv[1] &&
  (process.argv[1].replace(/\\/g, '/').endsWith('apps/server/src/index.ts') ||
   process.argv[1].replace(/\\/g, '/').endsWith('apps/server/dist/index.js'))
) {
  main().catch((err) => {
    console.error('Server startup failed:', err);
    process.exit(1);
  });
}
