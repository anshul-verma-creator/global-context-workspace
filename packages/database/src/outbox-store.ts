import type Database from 'better-sqlite3';
import { nowMs, StorageError, OutboxError } from '@context-workspace/shared';
import { Duration } from '@context-workspace/shared';

/**
 * Outbox entry — tracks sync state for events.
 * Per spec §5: outbox survives process restart.
 */
export interface OutboxEntry {
  eventId: string;
  attempts: number;
  status: OutboxStatus;
  nextRetryAt?: number;
  createdAt: number;
  acknowledgedAt?: number;
}

export type OutboxStatus = 'pending' | 'processing' | 'acknowledged' | 'failed';

interface OutboxRow {
  event_id: string;
  attempts: number;
  status: string;
  next_retry_at: number | null;
  created_at: number;
  acknowledged_at: number | null;
}

function rowToEntry(row: OutboxRow): OutboxEntry {
  return {
    eventId: row.event_id,
    attempts: row.attempts,
    status: row.status as OutboxStatus,
    ...(row.next_retry_at !== null ? { nextRetryAt: row.next_retry_at } : {}),
    createdAt: row.created_at,
    ...(row.acknowledged_at !== null ? { acknowledgedAt: row.acknowledged_at } : {}),
  };
}


/**
 * Exponential backoff delays for retry.
 * Attempt 0: immediate, 1: 5s, 2: 15s, 3: 60s, 4+: 5min
 */
const BACKOFF_DELAYS_MS = [
  0,
  Duration.seconds(5),
  Duration.seconds(15),
  Duration.minutes(1),
  Duration.minutes(5),
];

export function computeNextRetryAt(attempts: number): number {
  const delay = BACKOFF_DELAYS_MS[Math.min(attempts, BACKOFF_DELAYS_MS.length - 1)] ?? Duration.minutes(5);
  return nowMs() + delay;
}

/**
 * Data access object for the outbox table.
 *
 * The outbox is the durability layer between local SQLite and cloud sync.
 * Events are inserted into the outbox when written locally.
 * The sync worker reads pending entries and marks them acknowledged.
 * This survives process restart — pending entries are re-sent on restart.
 */
export class OutboxStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Add an event to the outbox for delivery.
   * Called atomically with event insertion.
   */
  enqueue(eventId: string): OutboxEntry {
    const now = nowMs();
    try {
      const stmt = this.db.prepare(`
        INSERT INTO outbox (event_id, attempts, status, next_retry_at, created_at)
        VALUES (?, 0, 'pending', ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET
          status = 'pending',
          next_retry_at = excluded.next_retry_at,
          attempts = 0
      `);
      stmt.run(eventId, now, now);
    } catch (e) {
      throw new StorageError(`Failed to enqueue event: ${String(e)}`, e instanceof Error ? e : undefined);
    }

    return {
      eventId,
      attempts: 0,
      status: 'pending',
      nextRetryAt: now,
      createdAt: now,
    };
  }

  /**
   * Get pending entries ready for delivery.
   * Returns entries where status='pending' and next_retry_at <= now.
   */
  getPendingEntries(limit: number = 50): OutboxEntry[] {
    const now = nowMs();
    const stmt = this.db.prepare<[string, number, number], OutboxRow>(`
      SELECT * FROM outbox
      WHERE status = ? AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY created_at ASC
      LIMIT ?
    `);
    return stmt.all('pending', now, limit).map(rowToEntry);
  }

  /**
   * Mark an entry as processing (in-flight).
   * Prevents concurrent workers from double-sending.
   */
  markProcessing(eventId: string): void {
    const stmt = this.db.prepare(`
      UPDATE outbox SET status = 'processing' WHERE event_id = ? AND status = 'pending'
    `);
    stmt.run(eventId);
  }

  /**
   * Mark an entry as acknowledged (successfully delivered).
   * The entry is kept for audit — not deleted.
   */
  acknowledge(eventId: string): void {
    const now = nowMs();
    const stmt = this.db.prepare(`
      UPDATE outbox
      SET status = 'acknowledged', acknowledged_at = ?
      WHERE event_id = ?
    `);
    const result = stmt.run(now, eventId);
    if (result.changes === 0) {
      throw new OutboxError(`No outbox entry for event: ${eventId}`);
    }
  }

  /**
   * Record a delivery failure with exponential backoff.
   */
  recordFailure(eventId: string): OutboxEntry {
    const entry = this.getById(eventId);
    if (entry === undefined) {
      throw new OutboxError(`No outbox entry for event: ${eventId}`);
    }

    const newAttempts = entry.attempts + 1;
    const maxAttempts = 20;

    if (newAttempts >= maxAttempts) {
      const stmt = this.db.prepare(`
        UPDATE outbox SET attempts = ?, status = 'failed' WHERE event_id = ?
      `);
      stmt.run(newAttempts, eventId);
    } else {
      const nextRetry = computeNextRetryAt(newAttempts);
      const stmt = this.db.prepare(`
        UPDATE outbox SET attempts = ?, status = 'pending', next_retry_at = ? WHERE event_id = ?
      `);
      stmt.run(newAttempts, nextRetry, eventId);
    }

    return this.getById(eventId) ?? entry;
  }

  /**
   * Reset processing entries back to pending (recovery on restart).
   * Call this at startup to recover in-flight entries from previous crash.
   */
  resetProcessingEntries(): number {
    const stmt = this.db.prepare(`
      UPDATE outbox SET status = 'pending', next_retry_at = ?
      WHERE status = 'processing'
    `);
    const result = stmt.run(nowMs());
    return result.changes;
  }

  /**
   * Reset retry timer for all pending entries so they are processed immediately upon reconnect.
   */
  resetPendingRetries(): number {
    const stmt = this.db.prepare(`
      UPDATE outbox SET next_retry_at = ?
      WHERE status = 'pending'
    `);
    const result = stmt.run(nowMs());
    return result.changes;
  }

  getById(eventId: string): OutboxEntry | undefined {
    const stmt = this.db.prepare<[string], OutboxRow>('SELECT * FROM outbox WHERE event_id = ?');
    const row = stmt.get(eventId);
    return row !== undefined ? rowToEntry(row) : undefined;
  }

  /** Count pending entries for observability metrics. */
  countPending(): number {
    const stmt = this.db.prepare<[], { count: number }>(
      "SELECT COUNT(*) as count FROM outbox WHERE status = 'pending'",
    );
    return stmt.get()?.count ?? 0;
  }

  /** Count failed entries (permanent failures). */
  countFailed(): number {
    const stmt = this.db.prepare<[], { count: number }>(
      "SELECT COUNT(*) as count FROM outbox WHERE status = 'failed'",
    );
    return stmt.get()?.count ?? 0;
  }
}
