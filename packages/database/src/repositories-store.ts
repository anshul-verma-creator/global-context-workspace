import type Database from 'better-sqlite3';
import { generateId, nowMs, StorageError, NotFoundError } from '@context-workspace/shared';

/**
 * Repository record in local SQLite.
 */
export interface LocalRepository {
  id: string;
  remoteUrl?: string;
  rootPath: string;
  workspaceId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

interface RepositoryRow {
  id: string;
  remote_url: string | null;
  root_path: string;
  workspace_id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

function rowToRepository(row: RepositoryRow): LocalRepository {
  return {
    id: row.id,
    ...(row.remote_url !== null ? { remoteUrl: row.remote_url } : {}),
    rootPath: row.root_path,
    workspaceId: row.workspace_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Data access object for the repositories table.
 */
export class RepositoriesStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(params: {
    workspaceId: string;
    rootPath: string;
    name: string;
    remoteUrl?: string;
    id?: string;
  }): LocalRepository {
    const id = params.id ?? generateId();
    const now = nowMs();

    try {
      const stmt = this.db.prepare(`
        INSERT INTO repositories (id, workspace_id, root_path, name, remote_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(id, params.workspaceId, params.rootPath, params.name, params.remoteUrl ?? null, now, now);
    } catch (e) {
      throw new StorageError(`Failed to create repository: ${String(e)}`, e instanceof Error ? e : undefined);
    }

    return {
      id,
      workspaceId: params.workspaceId,
      rootPath: params.rootPath,
      name: params.name,
      ...(params.remoteUrl !== undefined ? { remoteUrl: params.remoteUrl } : {}),
      createdAt: now,
      updatedAt: now,
    };
  }

  getById(id: string): LocalRepository | undefined {
    const stmt = this.db.prepare<[string], RepositoryRow>('SELECT * FROM repositories WHERE id = ?');
    const row = stmt.get(id);
    return row !== undefined ? rowToRepository(row) : undefined;
  }

  getByRootPath(rootPath: string): LocalRepository | undefined {
    const stmt = this.db.prepare<[string], RepositoryRow>(
      'SELECT * FROM repositories WHERE root_path = ?',
    );
    const row = stmt.get(rootPath);
    return row !== undefined ? rowToRepository(row) : undefined;
  }

  requireById(id: string): LocalRepository {
    const repo = this.getById(id);
    if (repo === undefined) {
      throw new NotFoundError('Repository', id);
    }
    return repo;
  }

  list(): LocalRepository[] {
    const stmt = this.db.prepare<[], RepositoryRow>('SELECT * FROM repositories ORDER BY created_at');
    return stmt.all().map(rowToRepository);
  }

  update(id: string, params: Partial<Pick<LocalRepository, 'name' | 'remoteUrl'>>): LocalRepository {
    const now = nowMs();
    const stmt = this.db.prepare(`
      UPDATE repositories
      SET name = COALESCE(?, name),
          remote_url = COALESCE(?, remote_url),
          updated_at = ?
      WHERE id = ?
    `);
    const changes = stmt.run(params.name ?? null, params.remoteUrl ?? null, now, id);
    if (changes.changes === 0) {
      throw new NotFoundError('Repository', id);
    }
    return this.requireById(id);
  }
}
