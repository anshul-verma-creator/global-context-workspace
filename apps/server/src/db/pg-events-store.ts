import type { Sql } from './connection.js';
import type { ContextEvent } from '@context-workspace/protocol';
import { contentHash } from '@context-workspace/shared';

/**
 * PostgreSQL event store.
 *
 * Events are immutable once written. Duplicate detection uses the
 * UNIQUE constraint on event_id (INSERT ... ON CONFLICT DO NOTHING).
 */
export class PgEventsStore {
  constructor(private readonly sql: Sql) {}

  /**
   * Idempotent insert — returns true if inserted, false if duplicate.
   */
  async insertIdempotent(event: ContextEvent): Promise<boolean> {
    const payloadStr = JSON.stringify(event.payload);
    const hash = contentHash(payloadStr);
    const now = Date.now();

    // Cast to unknown record for safe property access on extended fields
    const ev = event as unknown as Record<string, unknown>;

    const result = await this.sql`
      INSERT INTO events (
        event_id, workspace_id, repository_id, capsule_id, session_id,
        type, source, agent_id, user_id, device_id,
        client_sequence, server_sequence, timestamp,
        visibility, payload, payload_hash, raw_ref, created_at
      ) VALUES (
        ${event.eventId},
        ${event.workspaceId},
        ${event.repositoryId},
        ${event.capsuleId ?? null},
        ${event.sessionId ?? null},
        ${event.type},
        ${event.source},
        ${event.agentId ?? null},
        ${(ev['userId'] as string | undefined) ?? null},
        ${(ev['deviceId'] as string | undefined) ?? null},
        ${event.clientSequence},
        ${event.serverSequence ?? null},
        ${event.timestamp},
        ${event.visibility},
        ${this.sql.json(JSON.parse(payloadStr) as any)},
        ${hash},
        ${(ev['rawRef'] as string | undefined) ?? null},
        ${now}
      )
      ON CONFLICT (event_id) DO NOTHING
    `;

    return result.count > 0;
  }

  async getById(eventId: string): Promise<ContextEvent | undefined> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT * FROM events WHERE event_id = ${eventId}
    `;

    const row = rows[0];
    if (row === undefined) return undefined;
    return this._rowToEvent(row);
  }

  async listByRepository(
    repositoryId: string,
    options: { limit?: number; since?: number } = {},
  ): Promise<ContextEvent[]> {
    const limit = options.limit ?? 100;
    const since = options.since ?? 0;

    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT * FROM events
      WHERE repository_id = ${repositoryId}
        AND timestamp > ${since}
      ORDER BY timestamp ASC
      LIMIT ${limit}
    `;

    return rows.map((r) => this._rowToEvent(r));
  }

  async listByCapsule(
    capsuleId: string,
    options: { limit?: number; since?: number } = {},
  ): Promise<ContextEvent[]> {
    const limit = options.limit ?? 100;
    const since = options.since ?? 0;

    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT * FROM events
      WHERE capsule_id = ${capsuleId}
        AND timestamp > ${since}
      ORDER BY timestamp ASC
      LIMIT ${limit}
    `;

    return rows.map((r) => this._rowToEvent(r));
  }

  async countByRepository(repositoryId: string): Promise<number> {
    const rows = await this.sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM events WHERE repository_id = ${repositoryId}
    `;
    return parseInt(rows[0]?.count ?? '0', 10);
  }

  private _rowToEvent(row: Record<string, unknown>): ContextEvent {
    return {
      eventId: row['event_id'] as string,
      workspaceId: row['workspace_id'] as string,
      repositoryId: row['repository_id'] as string,
      ...(row['capsule_id'] !== null ? { capsuleId: row['capsule_id'] as string } : {}),
      ...(row['session_id'] !== null ? { sessionId: row['session_id'] as string } : {}),
      type: row['type'] as string as ContextEvent['type'],
      source: row['source'] as string as ContextEvent['source'],
      userId: (row['user_id'] as string | null) ?? '',
      deviceId: (row['device_id'] as string | null) ?? '',
      ...(row['agent_id'] !== null ? { agentId: row['agent_id'] as string } : {}),
      clientSequence: Number(row['client_sequence']),
      ...(row['server_sequence'] !== null ? { serverSequence: Number(row['server_sequence']) } : {}),
      timestamp: Number(row['timestamp']),
      visibility: row['visibility'] as ContextEvent['visibility'],
      payload: row['payload'] as ContextEvent['payload'],
      protocolVersion: Number((row['protocol_version'] as number | undefined) ?? 1),
    };
  }
}
