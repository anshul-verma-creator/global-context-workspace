import type Database from 'better-sqlite3';
import {
  generateId,
  nowMs,
  StorageError,
  NotFoundError,
} from '@context-workspace/shared';
import type {
  ContextObject,
  ContextObjectType,
  ContextObjectStatus,
  ContextObjectProvenance,
} from '@context-workspace/protocol';

/**
 * Data access object for context_objects table.
 *
 * Context objects are stored with:
 * - Structured metadata columns (queryable)
 * - JSON content column (flexible, type-specific)
 * - Full-text search via FTS5 virtual table
 */

interface ContextObjectRow {
  id: string;
  repository_id: string;
  capsule_id: string | null;
  type: string;
  scope: string;
  status: string;
  authority: string;
  visibility: string;
  version: number;
  resource: string | null;
  provenance: string;
  content: string;
  created_at: number;
  updated_at: number;
  valid_from: number | null;
  valid_until: number | null;
}

function rowToObject(row: ContextObjectRow): ContextObject {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    ...(row.capsule_id !== null ? { capsuleId: row.capsule_id } : {}),
    type: row.type as ContextObjectType,
    scope: row.scope as ContextObject['scope'],
    status: row.status as ContextObjectStatus,
    authority: row.authority as ContextObject['authority'],
    visibility: row.visibility as ContextObject['visibility'],
    version: row.version,
    ...(row.resource !== null ? { resource: row.resource } : {}),
    provenance: JSON.parse(row.provenance) as ContextObjectProvenance,
    content: JSON.parse(row.content) as ContextObject['content'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.valid_from !== null ? { validFrom: row.valid_from } : {}),
    ...(row.valid_until !== null ? { validUntil: row.valid_until } : {}),
  };
}


export interface ContextObjectFilter {
  repositoryId: string;
  capsuleId?: string;
  types?: ContextObjectType[];
  statuses?: ContextObjectStatus[];
  resource?: string;
  limit?: number;
  offset?: number;
}

export class ContextObjectsStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(
    params: Omit<ContextObject, 'id' | 'createdAt' | 'updatedAt' | 'version'>,
    id?: string,
  ): ContextObject {
    const objectId = id ?? generateId();
    const now = nowMs();
    const contentStr = JSON.stringify(params.content);
    const provenanceStr = JSON.stringify(params.provenance);

    try {
      const stmt = this.db.prepare(`
        INSERT INTO context_objects (
          id, repository_id, capsule_id, type, scope, status, authority,
          visibility, version, resource, provenance, content,
          created_at, updated_at, valid_from, valid_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        objectId,
        params.repositoryId,
        params.capsuleId ?? null,
        params.type,
        params.scope,
        params.status,
        params.authority,
        params.visibility,
        params.resource ?? null,
        provenanceStr,
        contentStr,
        now,
        now,
        params.validFrom ?? null,
        params.validUntil ?? null,
      );

      // Update FTS index
      this._updateFts(objectId, params.type, contentStr, params.resource);
    } catch (e) {
      throw new StorageError(
        `Failed to create context object: ${String(e)}`,
        e instanceof Error ? e : undefined,
      );
    }

    return this.requireById(objectId);
  }

  getById(id: string): ContextObject | undefined {
    const stmt = this.db.prepare<[string], ContextObjectRow>(
      'SELECT * FROM context_objects WHERE id = ?',
    );
    const row = stmt.get(id);
    return row !== undefined ? rowToObject(row) : undefined;
  }

  requireById(id: string): ContextObject {
    const obj = this.getById(id);
    if (obj === undefined) {
      throw new NotFoundError('ContextObject', id);
    }
    return obj;
  }

  list(filter: ContextObjectFilter): ContextObject[] {
    const conditions: string[] = ['repository_id = ?'];
    const params: (string | number)[] = [filter.repositoryId];

    if (filter.capsuleId !== undefined) {
      conditions.push('(capsule_id = ? OR capsule_id IS NULL)');
      params.push(filter.capsuleId);
    }

    if (filter.types !== undefined && filter.types.length > 0) {
      const placeholders = filter.types.map(() => '?').join(', ');
      conditions.push(`type IN (${placeholders})`);
      params.push(...filter.types);
    }

    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      const placeholders = filter.statuses.map(() => '?').join(', ');
      conditions.push(`status IN (${placeholders})`);
      params.push(...filter.statuses);
    }

    if (filter.resource !== undefined) {
      conditions.push('resource = ?');
      params.push(filter.resource);
    }

    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;

    const sql = `
      SELECT * FROM context_objects
      WHERE ${conditions.join(' AND ')}
      ORDER BY updated_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const stmt = this.db.prepare<(string | number)[], ContextObjectRow>(sql);
    return stmt.all(...params).map(rowToObject);
  }

  update(
    id: string,
    updates: {
      status?: ContextObjectStatus;
      content?: ContextObject['content'];
      validUntil?: number;
    },
  ): ContextObject {
    const existing = this.requireById(id);
    const now = nowMs();

    const newContent = updates.content !== undefined
      ? JSON.stringify(updates.content)
      : JSON.stringify(existing.content);

    const stmt = this.db.prepare(`
      UPDATE context_objects
      SET status = COALESCE(?, status),
          content = ?,
          version = version + 1,
          updated_at = ?,
          valid_until = COALESCE(?, valid_until)
      WHERE id = ?
    `);
    stmt.run(
      updates.status ?? null,
      newContent,
      now,
      updates.validUntil ?? null,
      id,
    );

    if (updates.content !== undefined) {
      this._updateFts(id, existing.type, newContent, existing.resource);
    }

    return this.requireById(id);
  }

  /**
   * Full-text search using SQLite FTS5.
   * Returns matching objects ordered by relevance.
   */
  searchFts(
    repositoryId: string,
    query: string,
    limit: number = 20,
  ): ContextObject[] {
    // FTS5 query: escape special chars; OR between terms for broader recall
    const terms = query
      .replace(/['\"*^()\-]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 2); // ignore very short words

    if (terms.length === 0) return [];

    // OR logic: any term matches
    const ftsQuery = terms.join(' OR ');

    try {
      const stmt = this.db.prepare<[string, string, number], ContextObjectRow>(`
        SELECT co.* FROM context_objects co
        WHERE co.id IN (
          SELECT id FROM context_objects_fts
          WHERE context_objects_fts MATCH ?
        )
          AND co.repository_id = ?
        LIMIT ?
      `);
      return stmt.all(ftsQuery, repositoryId, limit).map(rowToObject);
    } catch {
      // FTS syntax error — return empty rather than crash
      return [];
    }
  }


  /** Count by type for a repository (for observability). */
  countByType(repositoryId: string): Record<string, number> {
    const stmt = this.db.prepare<[string], { type: string; count: number }>(`
      SELECT type, COUNT(*) as count FROM context_objects
      WHERE repository_id = ?
      GROUP BY type
    `);
    const rows = stmt.all(repositoryId);
    return Object.fromEntries(rows.map((r) => [r.type, r.count]));
  }

  /**
   * Return all distinct repository IDs that have at least one context object.
   * Used by MCP server as fallback when the repositories table is not populated
   * (e.g. Agent B that joined via cloud sync without explicit repository creation).
   */
  listDistinctRepositoryIds(): string[] {
    const stmt = this.db.prepare<[], { repository_id: string }>(
      'SELECT DISTINCT repository_id FROM context_objects ORDER BY repository_id',
    );
    return stmt.all().map((r) => r.repository_id);
  }

  private _updateFts(
    id: string,
    type: string,
    content: string,
    resource?: string,
  ): void {
    try {
      // Delete old entry if it exists
      this.db.prepare('DELETE FROM context_objects_fts WHERE id = ?').run(id);
      // Insert new entry
      this.db
        .prepare(
          'INSERT INTO context_objects_fts (id, type, content, resource) VALUES (?, ?, ?, ?)',
        )
        .run(id, type, content, resource ?? '');
    } catch {
      // FTS update failure is non-critical — main record already written
    }
  }
}
