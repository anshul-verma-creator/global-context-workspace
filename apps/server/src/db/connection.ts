import postgres from 'postgres';
import { createLogger } from '@context-workspace/shared';

const log = createLogger({ component: 'db' });

export interface DbConfig {
  url: string;
  maxConnections?: number;
}

/**
 * Create a typed postgres.js connection pool.
 * Caller is responsible for calling sql.end() on shutdown.
 */
export function createDb(config: DbConfig): postgres.Sql {
  const sql = postgres(config.url, {
    max: config.maxConnections ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: (notice) => log.debug('pg notice', { message: notice['message'] }),
  });

  log.info('PostgreSQL connection pool created');
  return sql;
}

export type Sql = postgres.Sql;
