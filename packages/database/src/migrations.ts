import type Database from 'better-sqlite3';
import { createLogger } from '@context-workspace/shared';

const log = createLogger({ component: 'migrations' });

/**
 * Database migration system.
 *
 * Migrations are append-only. Each migration has a version number.
 * The schema_migrations table tracks which migrations have been applied.
 *
 * Design decision: We use a simple integer-versioned migration table rather
 * than file-based migration tools to keep the database package self-contained
 * and dependency-free from migration frameworks.
 */

interface Migration {
  version: number;
  description: string;
  up: string;
}

/**
 * All migrations in order.
 * Never modify existing migrations — add new ones instead.
 * Each migration is a single SQL string (can include multiple statements).
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Create schema_migrations table',
    up: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        description TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    description: 'Create repositories table',
    up: `
      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY,
        remote_url TEXT,
        root_path TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 3,
    description: 'Create capsules table',
    up: `
      CREATE TABLE IF NOT EXISTS capsules (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id),
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_capsules_repository
        ON capsules(repository_id, status);
    `,
  },
  {
    version: 4,
    description: 'Create sessions table',
    up: `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        capsule_id TEXT NOT NULL REFERENCES capsules(id),
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        agent_id TEXT,
        native_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_capsule
        ON sessions(capsule_id, status);
      CREATE INDEX IF NOT EXISTS idx_sessions_native
        ON sessions(native_session_id);
    `,
  },
  {
    version: 5,
    description: 'Create events table with indexes',
    up: `
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        capsule_id TEXT,
        session_id TEXT,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        client_sequence INTEGER NOT NULL,
        server_sequence INTEGER,
        timestamp INTEGER NOT NULL,
        raw_ref TEXT,
        payload_hash TEXT NOT NULL,
        payload TEXT NOT NULL,
        visibility TEXT NOT NULL,
        synced INTEGER NOT NULL DEFAULT 0,
        chunk_id TEXT,
        chunk_offset INTEGER,
        chunk_length INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_events_session
        ON events(session_id, client_sequence);

      CREATE INDEX IF NOT EXISTS idx_events_capsule
        ON events(capsule_id, timestamp);

      CREATE INDEX IF NOT EXISTS idx_events_type
        ON events(type, timestamp);

      CREATE INDEX IF NOT EXISTS idx_events_raw_ref
        ON events(raw_ref);

      CREATE INDEX IF NOT EXISTS idx_events_repo_ts
        ON events(repository_id, timestamp);

      CREATE INDEX IF NOT EXISTS idx_events_synced
        ON events(synced, repository_id);
    `,
  },
  {
    version: 6,
    description: 'Create outbox table',
    up: `
      CREATE TABLE IF NOT EXISTS outbox (
        event_id TEXT PRIMARY KEY REFERENCES events(event_id),
        attempts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        next_retry_at INTEGER,
        created_at INTEGER NOT NULL,
        acknowledged_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_outbox_status
        ON outbox(status, next_retry_at);
    `,
  },
  {
    version: 7,
    description: 'Create context_objects table',
    up: `
      CREATE TABLE IF NOT EXISTS context_objects (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        capsule_id TEXT,
        type TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        authority TEXT NOT NULL,
        visibility TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        resource TEXT,
        provenance TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        valid_from INTEGER,
        valid_until INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_context_objects_repo
        ON context_objects(repository_id, type, status);

      CREATE INDEX IF NOT EXISTS idx_context_objects_capsule
        ON context_objects(capsule_id, type);

      CREATE INDEX IF NOT EXISTS idx_context_objects_resource
        ON context_objects(resource);

      CREATE INDEX IF NOT EXISTS idx_context_objects_type_status
        ON context_objects(type, status, updated_at);

      -- Full-text search on content (standalone FTS5 table, manually populated)
      CREATE VIRTUAL TABLE IF NOT EXISTS context_objects_fts USING fts5(
        id UNINDEXED,
        type,
        content,
        resource
      );

    `,
  },
  {
    version: 8,
    description: 'Create relations table',
    up: `
      CREATE TABLE IF NOT EXISTS relations (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        from_id TEXT NOT NULL REFERENCES context_objects(id),
        relation_type TEXT NOT NULL,
        to_id TEXT NOT NULL REFERENCES context_objects(id),
        created_at INTEGER NOT NULL,
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_relations_from
        ON relations(from_id, relation_type);

      CREATE INDEX IF NOT EXISTS idx_relations_to
        ON relations(to_id, relation_type);

      CREATE INDEX IF NOT EXISTS idx_relations_repo
        ON relations(repository_id);
    `,
  },
  {
    version: 9,
    description: 'Create chunk_registry table',
    up: `
      CREATE TABLE IF NOT EXISTS chunk_registry (
        chunk_id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        capsule_id TEXT,
        session_id TEXT,
        file_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        closed_at INTEGER,
        event_count INTEGER NOT NULL DEFAULT 0,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_repo
        ON chunk_registry(repository_id, created_at);
    `,
  },
];

/**
 * Run all pending migrations against the database.
 * Uses a transaction per migration for atomicity.
 */
export function runMigrations(db: Database.Database): void {
  // Ensure migration tracking table exists (version 1)
  const firstMigration = MIGRATIONS[0];
  if (firstMigration === undefined) {
    throw new Error('No migrations defined');
  }
  db.exec(firstMigration.up);

  const getVersion = db.prepare<[], { version: number }>(
    'SELECT COALESCE(MAX(version), 0) as version FROM schema_migrations',
  );

  const result = getVersion.get();
  const currentVersion = result?.version ?? 0;

  const insertMigration = db.prepare(
    'INSERT INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?)',
  );

  let appliedCount = 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    if (migration.version === 1) {
      // Already applied above
      db.transaction(() => {
        insertMigration.run(migration.version, Date.now(), migration.description);
      })();
      appliedCount++;
      continue;
    }

    log.info(`Applying migration ${migration.version}: ${migration.description}`);

    db.transaction(() => {
      db.exec(migration.up);
      insertMigration.run(migration.version, Date.now(), migration.description);
    })();

    appliedCount++;
  }

  if (appliedCount > 0) {
    log.info(`Applied ${appliedCount} migration(s)`);
  }
}

/**
 * Get the current schema version.
 */
export function getSchemaVersion(db: Database.Database): number {
  try {
    const stmt = db.prepare<[], { version: number }>(
      'SELECT COALESCE(MAX(version), 0) as version FROM schema_migrations',
    );
    return stmt.get()?.version ?? 0;
  } catch {
    return 0;
  }
}
