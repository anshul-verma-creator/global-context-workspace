import type { Sql } from '../db/connection.js';
import { generateId, nowMs, createLogger } from '@context-workspace/shared';

const log = createLogger({ component: 'lease-engine' });

export interface Lease {
  id: string;
  repositoryId: string;
  resource: string;
  holderId: string;
  holderType: 'agent' | 'session' | 'user';
  sessionId?: string;
  grantedAt: number;
  expiresAt: number;
  ttlMs: number;
  status: 'active' | 'expired' | 'released';
}

export interface ConflictDescriptor {
  resource: string;
  existingHolder: Lease;
  challenger: { holderId: string; holderType: string; sessionId?: string };
  severity: 'critical' | 'high' | 'low';
  detectedAt: number;
}

export interface AcquireLeaseParams {
  repositoryId: string;
  resource: string;
  holderId: string;
  holderType: 'agent' | 'session' | 'user';
  sessionId?: string;
  ttlMs?: number;
}

/**
 * Resource lease engine.
 *
 * Per spec §11 (Architecture):
 * - Each resource can have at most one active lease holder
 * - Leases have TTL and heartbeat; stale leases expire automatically
 * - Conflict occurs when a second holder attempts to acquire an active lease
 * - Conflict severity: critical when resource is under active editing, high otherwise
 *
 * PostgreSQL is used for durability. The UNIQUE INDEX on (repository_id, resource)
 * WHERE status = 'active' enforces the single-holder invariant atomically.
 */
export class LeaseEngine {
  private readonly DEFAULT_TTL_MS = 60_000; // 1 minute

  constructor(private readonly sql: Sql) {}

  /**
   * Attempt to acquire a lease.
   *
   * Returns the new lease if successful, or a ConflictDescriptor if another
   * holder already holds an active lease on the resource.
   */
  async acquire(params: AcquireLeaseParams): Promise<Lease | ConflictDescriptor> {
    const ttlMs = params.ttlMs ?? this.DEFAULT_TTL_MS;
    const now = nowMs();
    const expiresAt = now + ttlMs;
    const id = generateId();

    // First expire any stale leases for this resource
    await this._expireStaleLeases(params.repositoryId, params.resource);

    // Check for active lease
    const existing = await this._getActiveLease(params.repositoryId, params.resource);

    if (existing !== undefined) {
      // Conflict — return descriptor
      const conflict: ConflictDescriptor = {
        resource: params.resource,
        existingHolder: existing,
        challenger: {
          holderId: params.holderId,
          holderType: params.holderType,
          ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
        },
        severity: 'high',
        detectedAt: now,
      };

      log.warn('Lease conflict detected', {
        resource: params.resource,
        existing: existing.holderId,
        challenger: params.holderId,
      });

      return conflict;
    }

    // No conflict — grant lease
    await this.sql`
      INSERT INTO leases (
        id, repository_id, resource, holder_id, holder_type,
        session_id, granted_at, expires_at, ttl_ms, status
      ) VALUES (
        ${id}, ${params.repositoryId}, ${params.resource},
        ${params.holderId}, ${params.holderType},
        ${params.sessionId ?? null}, ${now}, ${expiresAt}, ${ttlMs}, 'active'
      )
    `;

    log.info('Lease granted', {
      id,
      resource: params.resource,
      holder: params.holderId,
      expiresAt: String(expiresAt),
    });

    return {
      id,
      repositoryId: params.repositoryId,
      resource: params.resource,
      holderId: params.holderId,
      holderType: params.holderType,
      ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
      grantedAt: now,
      expiresAt,
      ttlMs,
      status: 'active',
    };
  }

  /**
   * Renew an existing lease, extending its TTL.
   */
  async renew(leaseId: string, ttlMs?: number): Promise<Lease | undefined> {
    const existing = await this._getById(leaseId);
    if (existing === undefined || existing.status !== 'active') return undefined;

    const now = nowMs();
    const expiresAt = now + (ttlMs ?? existing.ttlMs);

    await this.sql`
      UPDATE leases SET expires_at = ${expiresAt} WHERE id = ${leaseId} AND status = 'active'
    `;

    return { ...existing, expiresAt };
  }

  /**
   * Release a lease voluntarily.
   */
  async release(leaseId: string, holderId: string): Promise<boolean> {
    const result = await this.sql`
      UPDATE leases SET status = 'released'
      WHERE id = ${leaseId} AND holder_id = ${holderId} AND status = 'active'
    `;

    const released = result.count > 0;
    if (released) {
      log.info('Lease released', { leaseId, holderId });
    }
    return released;
  }

  /**
   * Get active lease for a resource.
   */
  async getActiveLease(repositoryId: string, resource: string): Promise<Lease | undefined> {
    await this._expireStaleLeases(repositoryId, resource);
    return this._getActiveLease(repositoryId, resource);
  }

  /**
   * List all active leases for a repository.
   */
  async listActive(repositoryId: string): Promise<Lease[]> {
    await this._expireAllStale(repositoryId);

    const rows = await this.sql<any[]>`
      SELECT * FROM leases
      WHERE repository_id = ${repositoryId} AND status = 'active'
      ORDER BY granted_at ASC
    `;

    return rows.map((r) => this._rowToLease(r));
  }

  private async _getActiveLease(repositoryId: string, resource: string): Promise<Lease | undefined> {
    const rows = await this.sql<any[]>`
      SELECT * FROM leases
      WHERE repository_id = ${repositoryId}
        AND resource = ${resource}
        AND status = 'active'
      LIMIT 1
    `;
    return rows[0] !== undefined ? this._rowToLease(rows[0]) : undefined;
  }

  private async _getById(id: string): Promise<Lease | undefined> {
    const rows = await this.sql<any[]>`SELECT * FROM leases WHERE id = ${id}`;
    return rows[0] !== undefined ? this._rowToLease(rows[0]) : undefined;
  }

  private async _expireStaleLeases(repositoryId: string, resource: string): Promise<void> {
    await this.sql`
      UPDATE leases SET status = 'expired'
      WHERE repository_id = ${repositoryId}
        AND resource = ${resource}
        AND status = 'active'
        AND expires_at < ${nowMs()}
    `;
  }

  private async _expireAllStale(repositoryId: string): Promise<void> {
    await this.sql`
      UPDATE leases SET status = 'expired'
      WHERE repository_id = ${repositoryId}
        AND status = 'active'
        AND expires_at < ${nowMs()}
    `;
  }

  private _rowToLease(row: any): Lease {
    return {
      id: row.id as string,
      repositoryId: row.repository_id as string,
      resource: row.resource as string,
      holderId: row.holder_id as string,
      holderType: row.holder_type as 'agent' | 'session' | 'user',
      ...(row.session_id !== null ? { sessionId: row.session_id as string } : {}),
      grantedAt: row.granted_at as number,
      expiresAt: row.expires_at as number,
      ttlMs: row.ttl_ms as number,
      status: row.status as Lease['status'],
    };
  }
}
