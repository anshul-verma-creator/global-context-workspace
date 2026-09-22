import type Database from 'better-sqlite3';
import { generateId, nowMs, StorageError, NotFoundError } from '@context-workspace/shared';
import type { ContextRelation, RelationType } from '@context-workspace/protocol';

interface RelationRow {
  id: string;
  repository_id: string;
  from_id: string;
  relation_type: string;
  to_id: string;
  created_at: number;
  metadata: string | null;
}

function rowToRelation(row: RelationRow): ContextRelation {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    fromId: row.from_id,
    relationType: row.relation_type as RelationType,
    toId: row.to_id,
    createdAt: row.created_at,
    ...(row.metadata !== null ? { metadata: JSON.parse(row.metadata) as Record<string, string> } : {}),
  };
}

/**
 * Data access object for the relations table.
 * Relations form the graph between context objects.
 * Per spec §8 (Architecture): graph initially implemented with PostgreSQL relations.
 * Same pattern here in SQLite local storage.
 */
export class RelationsStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(params: {
    repositoryId: string;
    fromId: string;
    relationType: RelationType;
    toId: string;
    metadata?: Record<string, string>;
    id?: string;
  }): ContextRelation {
    const id = params.id ?? generateId();
    const now = nowMs();

    try {
      const stmt = this.db.prepare(`
        INSERT INTO relations (id, repository_id, from_id, relation_type, to_id, created_at, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        id,
        params.repositoryId,
        params.fromId,
        params.relationType,
        params.toId,
        now,
        params.metadata !== undefined ? JSON.stringify(params.metadata) : null,
      );
    } catch (e) {
      throw new StorageError(
        `Failed to create relation: ${String(e)}`,
        e instanceof Error ? e : undefined,
      );
    }

    return {
      id,
      repositoryId: params.repositoryId,
      fromId: params.fromId,
      relationType: params.relationType,
      toId: params.toId,
      createdAt: now,
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
    };
  }

  getById(id: string): ContextRelation | undefined {
    const stmt = this.db.prepare<[string], RelationRow>('SELECT * FROM relations WHERE id = ?');
    const row = stmt.get(id);
    return row !== undefined ? rowToRelation(row) : undefined;
  }

  /** Get all relations from a given object. */
  listFrom(
    fromId: string,
    relationType?: RelationType,
  ): ContextRelation[] {
    if (relationType !== undefined) {
      const stmt = this.db.prepare<[string, string], RelationRow>(
        'SELECT * FROM relations WHERE from_id = ? AND relation_type = ? ORDER BY created_at',
      );
      return stmt.all(fromId, relationType).map(rowToRelation);
    }
    const stmt = this.db.prepare<[string], RelationRow>(
      'SELECT * FROM relations WHERE from_id = ? ORDER BY created_at',
    );
    return stmt.all(fromId).map(rowToRelation);
  }

  /** Get all relations to a given object. */
  listTo(toId: string, relationType?: RelationType): ContextRelation[] {
    if (relationType !== undefined) {
      const stmt = this.db.prepare<[string, string], RelationRow>(
        'SELECT * FROM relations WHERE to_id = ? AND relation_type = ? ORDER BY created_at',
      );
      return stmt.all(toId, relationType).map(rowToRelation);
    }
    const stmt = this.db.prepare<[string], RelationRow>(
      'SELECT * FROM relations WHERE to_id = ? ORDER BY created_at',
    );
    return stmt.all(toId).map(rowToRelation);
  }

  /** Get all relations involving an object (either direction). */
  listAll(objectId: string): ContextRelation[] {
    const stmt = this.db.prepare<[string, string], RelationRow>(
      'SELECT * FROM relations WHERE from_id = ? OR to_id = ? ORDER BY created_at',
    );
    return stmt.all(objectId, objectId).map(rowToRelation);
  }

  /** Get neighbors of an object via a specific relation type. */
  getNeighbors(objectId: string, relationType: RelationType): string[] {
    const fromStmt = this.db.prepare<[string, string], { to_id: string }>(
      'SELECT to_id FROM relations WHERE from_id = ? AND relation_type = ?',
    );
    const toStmt = this.db.prepare<[string, string], { from_id: string }>(
      'SELECT from_id FROM relations WHERE to_id = ? AND relation_type = ?',
    );

    const outgoing = fromStmt.all(objectId, relationType).map((r) => r.to_id);
    const incoming = toStmt.all(objectId, relationType).map((r) => r.from_id);

    return [...new Set([...outgoing, ...incoming])];
  }

  delete(id: string): void {
    const stmt = this.db.prepare('DELETE FROM relations WHERE id = ?');
    const result = stmt.run(id);
    if (result.changes === 0) {
      throw new NotFoundError('Relation', id);
    }
  }
}
