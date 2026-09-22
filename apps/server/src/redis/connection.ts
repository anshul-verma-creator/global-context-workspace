import { Redis } from 'ioredis';
import { createLogger } from '@context-workspace/shared';

const log = createLogger({ component: 'redis' });

export interface RedisConfig {
  url: string;
  /** Max reconnect retries. Default: 10 */
  maxRetriesPerRequest?: number;
}

/**
 * Create an ioredis client with standard error handling.
 */
export function createRedisClient(config: RedisConfig): Redis {
  const client = new Redis(config.url, {
    maxRetriesPerRequest: config.maxRetriesPerRequest ?? 10,
    retryStrategy: (times: number) => {
      const delay = Math.min(times * 200, 5000);
      log.warn('Redis reconnecting', { attempt: String(times), delayMs: String(delay) });
      return delay;
    },
    lazyConnect: false,
  });

  client.on('connect', () => log.info('Redis connected'));
  client.on('error', (err: Error) => log.error('Redis error', { error: String(err) }));
  client.on('close', () => log.warn('Redis connection closed'));

  return client;
}

/** Redis stream name for a repository's event stream. */
export function repoStreamKey(repositoryId: string): string {
  return `stream:repo:${repositoryId}`;
}

/** Redis hash key for a repository's live state. */
export function repoStateKey(repositoryId: string): string {
  return `state:repo:${repositoryId}`;
}

/** Redis key for tracking the server sequence counter. */
export function serverSequenceKey(repositoryId: string): string {
  return `seq:repo:${repositoryId}`;
}

export type RedisClient = Redis;
