import type Database from 'better-sqlite3';
import {
  StorageError,
  NotFoundError,
  DuplicateEventError,
} from '@context-workspace/shared';
import type { ContextEvent } from '@context-workspace/protocol';
import { contentHash } from '@context-workspace/shared';

/**
 * Stored event row.
 */
export interface StoredEvent {
  eventId: string;
  repositoryId: string;
  capsuleId?: string;
  sessionId?: string;
  type: string;
  source: string;
  clientSequence: number;
  serverSequence?: number;
  timestamp: number;
  rawRef?: string;
  payloadHash: string;
  payload: EventPayloadStored;
  visibility: string;
  synced: boolean;
  chunkId?: string;
  chunkOffset?: number;
  chunkLength?: number;
}

// The payload is stored as JSON text in SQLite
type EventPayloadStored = Record<string, unknown>;

interface EventRow {
  event_id: string;
  repository_id: string;
  capsule_id: string | null;
  session_id: string | null;
  type: string;
  source: string;
  client_sequence: number;
  server_sequence: number | null;
  timestamp: number;
  raw_ref: string | null;
  payload_hash: string;
  payload: string;
  visibility: string;
  synced: number;
  chunk_id: string | null;
  chunk_offset: number | null;
  chunk_length: number | null;
}

function rowToStoredEvent(row: EventRow): StoredEvent {
  return {
    eventId: row.event_id,
    repositoryId: row.repository_id,
    ...(row.capsule_id !== null ? { capsuleId: row.capsule_id } : {}),
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    type: row.type,
    source: row.source,
    clientSequence: row.client_sequence,
    ...(row.server_sequence !== null ? { serverSequence: row.server_sequence } : {}),
    timestamp: row.timestamp,
    ...(row.raw_ref !== null ? { rawRef: row.raw_ref } : {}),
    payloadHash: row.payload_hash,
    payload: JSON.parse(row.payload) as EventPayloadStored,
    visibility: row.visibility,
    synced: row.synced === 1,
    ...(row.chunk_id !== null ? { chunkId: row.chunk_id } : {}),
    ...(row.chunk_offset !== null ? { chunkOffset: row.chunk_offset } : {}),
    ...(row.chunk_length !== null ? { chunkLength: row.chunk_length } : {}),
  };

}

/**
 * Data access object for the events table.
 *
 * Events are immutable after insertion. Updates are only allowed for
 * server_sequence and synced status (set after cloud acknowledgement).
 */
export class EventsStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Insert an event. Throws DuplicateEventError if eventId already exists.
   * This is idempotent by design: duplicate detection happens here.
   */
  insert(event: ContextEvent, options?: {
    chunkId?: string;
    chunkOffset?: number;
    chunkLength?: number;
    rawRef?: string;
  }): StoredEvent {
    const payloadStr = JSON.stringify(event.payload);
    const hash = contentHash(payloadStr);

    try {
      const stmt = this.db.prepare(`
        INSERT INTO events (
          event_id, repository_id, capsule_id, session_id,
          type, source, client_sequence, server_sequence,
          timestamp, raw_ref, payload_hash, payload,
          visibility, synced, chunk_id, chunk_offset, chunk_length
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      `);

      stmt.run(
        event.eventId,
        event.repositoryId,
        event.capsuleId ?? null,
        event.sessionId ?? null,
        event.type,
        event.source,
        event.clientSequence,
        event.serverSequence ?? null,
        event.timestamp,
        options?.rawRef ?? null,
        hash,
        payloadStr,
        event.visibility,
        options?.chunkId ?? null,
        options?.chunkOffset ?? null,
        options?.chunkLength ?? null,
      );
    } catch (e) {
      // SQLite UNIQUE constraint violation
      if (e instanceof Error && e.message.includes('UNIQUE constraint failed')) {
        throw new DuplicateEventError(event.eventId);
      }
      throw new StorageError(`Failed to insert event: ${String(e)}`, e instanceof Error ? e : undefined);
    }

    return this.requireById(event.eventId);
  }

  /**
   * Idempotent upsert — inserts if not exists, ignores if already present.
   * Returns true if inserted, false if duplicate.
   */
  insertIdempotent(event: ContextEvent): boolean {
    const payloadStr = JSON.stringify(event.payload);
    const hash = contentHash(payloadStr);

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO events (
        event_id, repository_id, capsule_id, session_id,
        type, source, client_sequence, server_sequence,
        timestamp, raw_ref, payload_hash, payload,
        visibility, synced
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);

    const result = stmt.run(
      event.eventId,
      event.repositoryId,
      event.capsuleId ?? null,
      event.sessionId ?? null,
      event.type,
      event.source,
      event.clientSequence,
      event.serverSequence ?? null,
      event.timestamp,
      null,
      hash,
      payloadStr,
      event.visibility,
    );

    return result.changes > 0;
  }

  getById(eventId: string): StoredEvent | undefined {
    const stmt = this.db.prepare<[string], EventRow>('SELECT * FROM events WHERE event_id = ?');
    const row = stmt.get(eventId);
    return row !== undefined ? rowToStoredEvent(row) : undefined;
  }

  requireById(eventId: string): StoredEvent {
    const event = this.getById(eventId);
    if (event === undefined) {
      throw new NotFoundError('Event', eventId);
    }
    return event;
  }

  /** Get events for a session in client_sequence order. */
  listBySession(
    sessionId: string,
    options?: { limit?: number; offset?: number },
  ): StoredEvent[] {
    const limit = options?.limit ?? 1000;
    const offset = options?.offset ?? 0;
    const stmt = this.db.prepare<[string, number, number], EventRow>(`
      SELECT * FROM events
      WHERE session_id = ?
      ORDER BY client_sequence ASC
      LIMIT ? OFFSET ?
    `);
    return stmt.all(sessionId, limit, offset).map(rowToStoredEvent);
  }

  /** Get events for a capsule ordered by timestamp. */
  listByCapsule(
    capsuleId: string,
    options?: { limit?: number; since?: number },
  ): StoredEvent[] {
    if (options?.since !== undefined) {
      const stmt = this.db.prepare<[string, number, number], EventRow>(`
        SELECT * FROM events
        WHERE capsule_id = ? AND timestamp > ?
        ORDER BY timestamp ASC
        LIMIT ?
      `);
      return stmt.all(capsuleId, options.since, options.limit ?? 1000).map(rowToStoredEvent);
    }
    const stmt = this.db.prepare<[string, number], EventRow>(`
      SELECT * FROM events
      WHERE capsule_id = ?
      ORDER BY timestamp ASC
      LIMIT ?
    `);
    return stmt.all(capsuleId, options?.limit ?? 1000).map(rowToStoredEvent);
  }

  /** Get events pending sync (not yet acknowledged by server). */
  listPendingSync(repositoryId: string, limit: number = 100): StoredEvent[] {
    const stmt = this.db.prepare<[string, number], EventRow>(`
      SELECT e.* FROM events e
      INNER JOIN outbox o ON e.event_id = o.event_id
      WHERE e.repository_id = ? AND o.status = 'pending'
      ORDER BY e.timestamp ASC
      LIMIT ?
    `);
    return stmt.all(repositoryId, limit).map(rowToStoredEvent);
  }

  /** Mark an event as synced with server sequence. */
  markSynced(eventId: string, serverSequence: number): void {
    const stmt = this.db.prepare(`
      UPDATE events
      SET synced = 1, server_sequence = ?
      WHERE event_id = ?
    `);
    stmt.run(serverSequence, eventId);
  }

  /** Get events by type for a repository since a timestamp. */
  listByType(
    repositoryId: string,
    type: string,
    since?: number,
  ): StoredEvent[] {
    if (since !== undefined) {
      const stmt = this.db.prepare<[string, string, number], EventRow>(`
        SELECT * FROM events
        WHERE repository_id = ? AND type = ? AND timestamp >= ?
        ORDER BY timestamp ASC
      `);
      return stmt.all(repositoryId, type, since).map(rowToStoredEvent);
    }
    const stmt = this.db.prepare<[string, string], EventRow>(`
      SELECT * FROM events
      WHERE repository_id = ? AND type = ?
      ORDER BY timestamp ASC
    `);
    return stmt.all(repositoryId, type).map(rowToStoredEvent);
  }

  /** Count events by repository for observability. */
  countByRepository(repositoryId: string): number {
    const stmt = this.db.prepare<[string], { count: number }>(
      'SELECT COUNT(*) as count FROM events WHERE repository_id = ?',
    );
    return stmt.get(repositoryId)?.count ?? 0;
  }
}
