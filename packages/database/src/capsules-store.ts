import type Database from 'better-sqlite3';
import { generateId, nowMs, StorageError, NotFoundError } from '@context-workspace/shared';

/**
 * Capsule record — represents one AI working context/chat.
 */
export interface LocalCapsule {
  id: string;
  repositoryId: string;
  name: string;
  status: 'active' | 'idle' | 'archived';
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

interface CapsuleRow {
  id: string;
  repository_id: string;
  name: string;
  status: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

function rowToCapsule(row: CapsuleRow): LocalCapsule {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    name: row.name,
    status: row.status as LocalCapsule['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.archived_at !== null ? { archivedAt: row.archived_at } : {}),
  };
}


/**
 * Data access object for the capsules table.
 */
export class CapsulesStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(params: {
    repositoryId: string;
    name: string;
    id?: string;
  }): LocalCapsule {
    const id = params.id ?? generateId();
    const now = nowMs();

    try {
      const stmt = this.db.prepare(`
        INSERT INTO capsules (id, repository_id, name, status, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?)
      `);
      stmt.run(id, params.repositoryId, params.name, now, now);
    } catch (e) {
      throw new StorageError(`Failed to create capsule: ${String(e)}`, e instanceof Error ? e : undefined);
    }

    return {
      id,
      repositoryId: params.repositoryId,
      name: params.name,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
  }

  getById(id: string): LocalCapsule | undefined {
    const stmt = this.db.prepare<[string], CapsuleRow>('SELECT * FROM capsules WHERE id = ?');
    const row = stmt.get(id);
    return row !== undefined ? rowToCapsule(row) : undefined;
  }

  requireById(id: string): LocalCapsule {
    const capsule = this.getById(id);
    if (capsule === undefined) {
      throw new NotFoundError('Capsule', id);
    }
    return capsule;
  }

  /** Find active capsule by repository and name (for session attachment). */
  findByRepositoryAndName(repositoryId: string, name: string): LocalCapsule | undefined {
    const stmt = this.db.prepare<[string, string], CapsuleRow>(`
      SELECT * FROM capsules
      WHERE repository_id = ? AND name = ? AND status != 'archived'
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = stmt.get(repositoryId, name);
    return row !== undefined ? rowToCapsule(row) : undefined;
  }

  listByRepository(
    repositoryId: string,
    status?: LocalCapsule['status'],
  ): LocalCapsule[] {
    if (status !== undefined) {
      const stmt = this.db.prepare<[string, string], CapsuleRow>(
        'SELECT * FROM capsules WHERE repository_id = ? AND status = ? ORDER BY updated_at DESC',
      );
      return stmt.all(repositoryId, status).map(rowToCapsule);
    }
    const stmt = this.db.prepare<[string], CapsuleRow>(
      'SELECT * FROM capsules WHERE repository_id = ? ORDER BY updated_at DESC',
    );
    return stmt.all(repositoryId).map(rowToCapsule);
  }

  updateStatus(id: string, status: LocalCapsule['status']): LocalCapsule {
    const now = nowMs();
    const archivedAt = status === 'archived' ? now : null;

    const stmt = this.db.prepare(`
      UPDATE capsules
      SET status = ?, updated_at = ?, archived_at = COALESCE(?, archived_at)
      WHERE id = ?
    `);
    const result = stmt.run(status, now, archivedAt, id);
    if (result.changes === 0) {
      throw new NotFoundError('Capsule', id);
    }
    return this.requireById(id);
  }

  /** Find or create a capsule for a repository/name pair. */
  findOrCreate(params: { repositoryId: string; name: string }): {
    capsule: LocalCapsule;
    created: boolean;
  } {
    const existing = this.findByRepositoryAndName(params.repositoryId, params.name);
    if (existing !== undefined) {
      return { capsule: existing, created: false };
    }
    const capsule = this.create(params);
    return { capsule, created: true };
  }
}
