import type Database from 'better-sqlite3';
import { generateId, nowMs, StorageError, NotFoundError } from '@context-workspace/shared';

/**
 * Session record — one execution inside a capsule.
 */
export interface LocalSession {
  id: string;
  capsuleId: string;
  userId: string;
  deviceId: string;
  agentId?: string;
  nativeSessionId?: string;
  status: 'active' | 'idle' | 'ended';
  startedAt: number;
  endedAt?: number;
}

interface SessionRow {
  id: string;
  capsule_id: string;
  user_id: string;
  device_id: string;
  agent_id: string | null;
  native_session_id: string | null;
  status: string;
  started_at: number;
  ended_at: number | null;
}

function rowToSession(row: SessionRow): LocalSession {
  return {
    id: row.id,
    capsuleId: row.capsule_id,
    userId: row.user_id,
    deviceId: row.device_id,
    ...(row.agent_id !== null ? { agentId: row.agent_id } : {}),
    ...(row.native_session_id !== null ? { nativeSessionId: row.native_session_id } : {}),
    status: row.status as LocalSession['status'],
    startedAt: row.started_at,
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
  };
}

/**
 * Data access object for the sessions table.
 */
export class SessionsStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(params: {
    capsuleId: string;
    userId: string;
    deviceId: string;
    agentId?: string;
    nativeSessionId?: string;
    id?: string;
  }): LocalSession {
    const id = params.id ?? generateId();
    const now = nowMs();

    try {
      const stmt = this.db.prepare(`
        INSERT INTO sessions
          (id, capsule_id, user_id, device_id, agent_id, native_session_id, status, started_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
      `);
      stmt.run(
        id,
        params.capsuleId,
        params.userId,
        params.deviceId,
        params.agentId ?? null,
        params.nativeSessionId ?? null,
        now,
      );
    } catch (e) {
      throw new StorageError(`Failed to create session: ${String(e)}`, e instanceof Error ? e : undefined);
    }

    return {
      id,
      capsuleId: params.capsuleId,
      userId: params.userId,
      deviceId: params.deviceId,
      ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
      ...(params.nativeSessionId !== undefined ? { nativeSessionId: params.nativeSessionId } : {}),
      status: 'active',
      startedAt: now,
    };
  }

  getById(id: string): LocalSession | undefined {
    const stmt = this.db.prepare<[string], SessionRow>('SELECT * FROM sessions WHERE id = ?');
    const row = stmt.get(id);
    return row !== undefined ? rowToSession(row) : undefined;
  }

  requireById(id: string): LocalSession {
    const session = this.getById(id);
    if (session === undefined) {
      throw new NotFoundError('Session', id);
    }
    return session;
  }

  findByNativeSessionId(nativeSessionId: string): LocalSession | undefined {
    const stmt = this.db.prepare<[string, string], SessionRow>(
      'SELECT * FROM sessions WHERE native_session_id = ? AND status != ? ORDER BY started_at DESC LIMIT 1',
    );
    const row = stmt.get(nativeSessionId, 'ended');
    return row !== undefined ? rowToSession(row) : undefined;
  }

  listByCapsule(capsuleId: string, status?: LocalSession['status']): LocalSession[] {
    if (status !== undefined) {
      const stmt = this.db.prepare<[string, string], SessionRow>(
        'SELECT * FROM sessions WHERE capsule_id = ? AND status = ? ORDER BY started_at DESC',
      );
      return stmt.all(capsuleId, status).map(rowToSession);
    }
    const stmt = this.db.prepare<[string], SessionRow>(
      'SELECT * FROM sessions WHERE capsule_id = ? ORDER BY started_at DESC',
    );
    return stmt.all(capsuleId).map(rowToSession);
  }

  updateStatus(id: string, status: LocalSession['status']): LocalSession {
    const endedAt = status === 'ended' ? nowMs() : null;

    const stmt = this.db.prepare(`
      UPDATE sessions
      SET status = ?, ended_at = COALESCE(?, ended_at)
      WHERE id = ?
    `);
    const result = stmt.run(status, endedAt, id);
    if (result.changes === 0) {
      throw new NotFoundError('Session', id);
    }
    return this.requireById(id);
  }

  /** Get the current sequence number for a session (max client_sequence in events). */
  getCurrentSequence(sessionId: string): number {
    const stmt = this.db.prepare<[string], { seq: number | null }>(
      'SELECT MAX(client_sequence) as seq FROM events WHERE session_id = ?',
    );
    return stmt.get(sessionId)?.seq ?? 0;
  }
}
