import postgres from 'postgres';
import { Redis } from 'ioredis';
import type { ContextRuntime } from '@context-workspace/runtime';
import type { ContextObject } from '@context-workspace/protocol';
import { createLogger, generateId, nowMs } from '@context-workspace/shared';

const log = createLogger({ component: 'mcp-cloud-backend' });

export interface CloudBackendConfig {
  databaseUrl: string;
  redisUrl?: string | undefined;
}

export interface CloudLeaseResult {
  conflict: boolean;
  holderId?: string;
  expiresAt?: number;
  lease?: {
    id: string;
    repositoryId: string;
    resource: string;
    holderId: string;
    expiresAt: number;
  };
}

/**
 * CloudBackend — connects the HTTP MCP service to shared PostgreSQL and Redis.
 *
 * Ensures:
 * 1. Multiple remote MCP clients (Laptop A, Laptop B) see the exact same shared
 *    context objects and relations for the repository.
 * 2. Leases are coordinated atomically in PostgreSQL across all clients.
 * 3. State survives container restarts on Render.
 */
export class CloudBackend {
  private readonly sql: postgres.Sql;
  private readonly redis?: Redis;
  private _isReady = false;

  constructor(config: CloudBackendConfig) {
    this.sql = postgres(config.databaseUrl, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: (notice) => log.debug('pg notice', { message: notice['message'] }),
    });

    if (config.redisUrl) {
      this.redis = new Redis(config.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 3,
      });
      log.info('Redis client created for cloud MCP backend');
    }
  }

  get isReady(): boolean {
    return this._isReady;
  }

  /**
   * Run PostgreSQL migrations to ensure all required tables exist.
   */
  async init(): Promise<void> {
    try {
      await this.runMigrations();
      if (this.redis) {
        await this.redis.connect().catch((err) => {
          log.warn('Redis connect error (non-fatal, continuing with PostgreSQL)', { error: String(err) });
        });
      }
      this._isReady = true;
      log.info('Cloud backend initialized successfully with PostgreSQL');
    } catch (err) {
      log.error('Failed to initialize cloud backend', { error: String(err) });
      throw err;
    }
  }

  async checkHealth(): Promise<{ database: boolean; redis: boolean }> {
    let dbOk = false;
    let redisOk = true;

    try {
      await this.sql`SELECT 1`;
      dbOk = true;
    } catch {
      dbOk = false;
    }

    if (this.redis) {
      try {
        await this.redis.ping();
      } catch {
        redisOk = false;
      }
    }

    return { database: dbOk, redis: redisOk };
  }

  async close(): Promise<void> {
    this._isReady = false;
    if (this.redis) {
      try {
        await this.redis.quit();
      } catch {
        // ignore
      }
    }
    await this.sql.end();
    log.info('Cloud backend connections closed');
  }

  /**
   * Synchronize objects and relations from PostgreSQL into the local ContextRuntime SQLite stores.
   * This ensures the runtime context compiler and retrieval engine query current cloud data.
   */
  async syncFromCloud(runtime: ContextRuntime, repositoryId?: string): Promise<{ objects: number; relations: number }> {
    try {
      // 1. Fetch context_objects from PostgreSQL
      const objRows = repositoryId
        ? await this.sql<Record<string, any>[]>`
            SELECT * FROM context_objects WHERE repository_id = ${repositoryId}
          `
        : await this.sql<Record<string, any>[]>`
            SELECT * FROM context_objects
          `;

      let objCount = 0;
      for (const row of objRows) {
        const existing = runtime.objects.getById(row['id']);
        const content = typeof row['content'] === 'string' ? JSON.parse(row['content']) : row['content'];
        const provenance = row['provenance']
          ? (typeof row['provenance'] === 'string' ? JSON.parse(row['provenance']) : row['provenance'])
          : { sourceEventIds: [`cloud-import-${row['id']}`] };

        if (!existing) {
          try {
            runtime.objects.create(
              {
                repositoryId: row['repository_id'],
                ...(row['capsule_id'] ? { capsuleId: row['capsule_id'] } : {}),
                type: row['type'],
                scope: row['scope'] ?? 'repository',
                visibility: row['visibility'] ?? 'repository',
                status: row['status'] ?? 'active',
                authority: row['authority'] ?? 'agent_explicit',
                ...(row['resource'] ? { resource: row['resource'] } : {}),
                provenance,
                validFrom: row['valid_from'] ? Number(row['valid_from']) : Number(row['created_at']),
                ...(row['valid_until'] ? { validUntil: Number(row['valid_until']) } : {}),
                content,
              },
              row['id'],
            );
            objCount++;
          } catch {
            // Already created or collision, continue
          }
        } else if (Number(row['updated_at']) > existing.updatedAt) {
          try {
            runtime.objects.update(row['id'], {
              status: row['status'],
              content,
              ...(row['valid_until'] ? { validUntil: Number(row['valid_until']) } : {}),
            });
            objCount++;
          } catch {
            // ignore
          }
        }
      }

      // 2. Fetch relations from PostgreSQL
      const relRows = repositoryId
        ? await this.sql<Record<string, any>[]>`
            SELECT * FROM relations WHERE repository_id = ${repositoryId}
          `
        : await this.sql<Record<string, any>[]>`
            SELECT * FROM relations
          `;

      let relCount = 0;
      for (const row of relRows) {
        const existingRel = runtime.relations.listFrom(row['from_id'], row['relation_type']);
        const alreadyExists = existingRel.some((r) => r.toId === row['to_id']);
        if (!alreadyExists) {
          try {
            runtime.relations.create({
              repositoryId: row['repository_id'],
              fromId: row['from_id'],
              relationType: row['relation_type'],
              toId: row['to_id'],
              metadata: row['metadata'] ? (typeof row['metadata'] === 'string' ? JSON.parse(row['metadata']) : row['metadata']) : undefined,
            });
            relCount++;
          } catch {
            // ignore
          }
        }
      }

      log.debug('Synchronized from PostgreSQL', { objects: String(objCount), relations: String(relCount) });
      return { objects: objCount, relations: relCount };
    } catch (err) {
      log.warn('syncFromCloud encountered error (using local state)', { error: String(err) });
      return { objects: 0, relations: 0 };
    }
  }

  /**
   * Persist a context object to PostgreSQL.
   */
  async persistObject(obj: ContextObject): Promise<void> {
    try {
      const contentJson = this.sql.json(obj.content as any);

      await this.sql`
        INSERT INTO context_objects (
          id, repository_id, capsule_id, type, scope, status, authority, visibility,
          resource, content, valid_until, version, created_at, updated_at
        ) VALUES (
          ${obj.id},
          ${obj.repositoryId},
          ${obj.capsuleId ?? null},
          ${obj.type},
          ${obj.scope},
          ${obj.status},
          ${obj.authority},
          ${obj.visibility},
          ${obj.resource ?? null},
          ${contentJson},
          ${obj.validUntil ?? null},
          ${obj.version},
          ${obj.createdAt},
          ${obj.updatedAt}
        )
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          content = EXCLUDED.content,
          valid_until = EXCLUDED.valid_until,
          version = EXCLUDED.version,
          updated_at = EXCLUDED.updated_at
      `;

      // If Redis is available, update live state
      if (this.redis) {
        const hashKey = `state:repo:${obj.repositoryId}`;
        await this.redis.hset(hashKey, `obj:${obj.type}:${obj.id}`, JSON.stringify({
          id: obj.id,
          type: obj.type,
          status: obj.status,
          updatedAt: obj.updatedAt,
        })).catch(() => {});
      }

      log.debug('Object persisted to PostgreSQL', { id: obj.id, type: obj.type });
    } catch (err) {
      log.error('Failed to persist context object to PostgreSQL', { id: obj.id, error: String(err) });
    }
  }

  /**
   * Persist a relation to PostgreSQL.
   */
  async persistRelation(rel: {
    id?: string;
    repositoryId: string;
    fromId: string;
    relationType: string;
    toId: string;
    createdAt?: number;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<void> {
    try {
      const id = rel.id ?? generateId();
      const createdAt = rel.createdAt ?? nowMs();
      const metaJson = rel.metadata ? this.sql.json(rel.metadata as any) : null;

      await this.sql`
        INSERT INTO relations (
          id, repository_id, from_id, relation_type, to_id, created_at, metadata
        ) VALUES (
          ${id},
          ${rel.repositoryId},
          ${rel.fromId},
          ${rel.relationType},
          ${rel.toId},
          ${createdAt},
          ${metaJson}
        )
        ON CONFLICT (id) DO NOTHING
      `;

      log.debug('Relation persisted to PostgreSQL', { id, fromId: rel.fromId, toId: rel.toId });
    } catch (err) {
      log.error('Failed to persist relation to PostgreSQL', { error: String(err) });
    }
  }

  /**
   * Acquire a resource lease atomically in PostgreSQL.
   */
  async acquireLease(
    repositoryId: string,
    resource: string,
    holderId: string,
    ttlMs = 60_000,
  ): Promise<CloudLeaseResult> {
    const now = nowMs();
    const expiresAt = now + ttlMs;

    try {
      // 1. Expire stale leases
      await this.sql`
        UPDATE leases
        SET status = 'expired'
        WHERE repository_id = ${repositoryId}
          AND resource = ${resource}
          AND status = 'active'
          AND expires_at <= ${now}
      `;

      // 2. Check for active lease
      const activeRows = await this.sql<Record<string, any>[]>`
        SELECT * FROM leases
        WHERE repository_id = ${repositoryId}
          AND resource = ${resource}
          AND status = 'active'
        LIMIT 1
      `;

      const active = activeRows[0];
      if (active) {
        if (active['holder_id'] === holderId) {
          // Renew existing lease held by the same holder
          await this.sql`
            UPDATE leases
            SET expires_at = ${expiresAt}, ttl_ms = ${ttlMs}
            WHERE id = ${active['id']}
          `;
          return {
            conflict: false,
            lease: {
              id: active['id'],
              repositoryId,
              resource,
              holderId,
              expiresAt,
            },
          };
        }

        // Conflict: held by another agent/session
        return {
          conflict: true,
          holderId: active['holder_id'],
          expiresAt: Number(active['expires_at']),
        };
      }

      // 3. Insert new lease
      const leaseId = generateId();
      await this.sql`
        INSERT INTO leases (
          id, repository_id, resource, holder_id, holder_type, granted_at, expires_at, ttl_ms, status
        ) VALUES (
          ${leaseId},
          ${repositoryId},
          ${resource},
          ${holderId},
          'agent',
          ${now},
          ${expiresAt},
          ${ttlMs},
          'active'
        )
      `;

      return {
        conflict: false,
        lease: {
          id: leaseId,
          repositoryId,
          resource,
          holderId,
          expiresAt,
        },
      };
    } catch (err) {
      log.error('Lease acquisition error in PostgreSQL', { resource, holderId, error: String(err) });
      // In case of error, assume conflict to be safe
      return { conflict: true, holderId: 'unknown' };
    }
  }

  /**
   * Release a resource lease.
   */
  async releaseLease(repositoryId: string, resource: string, holderId: string): Promise<boolean> {
    try {
      const result = await this.sql`
        UPDATE leases
        SET status = 'released'
        WHERE repository_id = ${repositoryId}
          AND resource = ${resource}
          AND holder_id = ${holderId}
          AND status = 'active'
      `;
      return result.count > 0;
    } catch (err) {
      log.error('Lease release error in PostgreSQL', { resource, holderId, error: String(err) });
      return false;
    }
  }

  /**
   * Check an active lease on a resource.
   */
  async checkLease(repositoryId: string, resource: string): Promise<Record<string, any> | undefined> {
    const now = nowMs();
    try {
      const rows = await this.sql<Record<string, any>[]>`
        SELECT * FROM leases
        WHERE repository_id = ${repositoryId}
          AND resource = ${resource}
          AND status = 'active'
          AND expires_at > ${now}
        LIMIT 1
      `;
      return rows[0];
    } catch {
      return undefined;
    }
  }

  /**
   * List all active leases in a repository.
   */
  async getActiveLeases(
    repositoryId: string,
    resource?: string,
  ): Promise<Array<{ resource: string; holderId: string; expiresAt: number }>> {
    const now = nowMs();
    try {
      const rows = resource
        ? await this.sql<Record<string, any>[]>`
            SELECT resource, holder_id, expires_at FROM leases
            WHERE repository_id = ${repositoryId}
              AND resource = ${resource}
              AND status = 'active'
              AND expires_at > ${now}
          `
        : await this.sql<Record<string, any>[]>`
            SELECT resource, holder_id, expires_at FROM leases
            WHERE repository_id = ${repositoryId}
              AND status = 'active'
              AND expires_at > ${now}
          `;

      return rows.map((r) => ({
        resource: r['resource'],
        holderId: r['holder_id'],
        expiresAt: Number(r['expires_at']),
      }));
    } catch (err) {
      log.error('getActiveLeases error in PostgreSQL', { error: String(err) });
      return [];
    }
  }

  /**
   * Execute schema migrations to ensure cloud tables exist.
   */
  private async runMigrations(): Promise<void> {
    // 1. Create schema_migrations
    await this.sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at BIGINT NOT NULL
      );
    `;

    // 2. Create context_objects
    await this.sql`
      CREATE TABLE IF NOT EXISTS context_objects (
        id            TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        capsule_id    TEXT,
        type          TEXT NOT NULL,
        scope         TEXT NOT NULL,
        status        TEXT NOT NULL,
        authority     TEXT NOT NULL,
        visibility    TEXT NOT NULL,
        resource      TEXT,
        content       JSONB NOT NULL,
        valid_until   BIGINT,
        version       INTEGER NOT NULL DEFAULT 1,
        created_at    BIGINT NOT NULL,
        updated_at    BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ctx_objects_repository ON context_objects(repository_id, type, status);
      CREATE INDEX IF NOT EXISTS idx_ctx_objects_resource ON context_objects(resource) WHERE resource IS NOT NULL;
    `;

    // 3. Create relations
    await this.sql`
      CREATE TABLE IF NOT EXISTS relations (
        id            TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        from_id       TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        to_id         TEXT NOT NULL,
        created_at    BIGINT NOT NULL,
        metadata      JSONB
      );
      CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_id, relation_type);
      CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_id, relation_type);
    `;

    // 4. Create leases
    await this.sql`
      CREATE TABLE IF NOT EXISTS leases (
        id            TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        resource      TEXT NOT NULL,
        holder_id     TEXT NOT NULL,
        holder_type   TEXT NOT NULL,
        session_id    TEXT,
        granted_at    BIGINT NOT NULL,
        expires_at    BIGINT NOT NULL,
        ttl_ms        INTEGER NOT NULL,
        status        TEXT NOT NULL DEFAULT 'active'
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_leases_active_resource
        ON leases(repository_id, resource)
        WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_leases_expires ON leases(expires_at) WHERE status = 'active';
    `;
  }
}
