import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { createLogger } from '@context-workspace/shared';
import { runMigrations } from './migrations.js';

const log = createLogger({ component: 'local-db' });

/**
 * Options for opening a local SQLite database.
 */
export interface LocalDbOptions {
  /** Absolute path to the database file */
  dbPath: string;
  /** Enable verbose mode (logs all statements). Off in production. */
  verbose?: boolean;
}

/**
 * The local SQLite database instance.
 *
 * Implementation decisions:
 * - Uses better-sqlite3 (synchronous API) for simplicity and reliability.
 *   SQLite calls are fast enough that async overhead is unnecessary here.
 * - WAL mode is required by spec for better concurrency.
 * - Migrations run on every open to keep schema up to date.
 *
 * This class is a thin wrapper. All queries are in the store modules.
 */
export class LocalDb {
  public readonly db: Database.Database;
  private _closed = false;

  constructor(options: LocalDbOptions) {
    const dir = path.dirname(options.dbPath);
    fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(options.dbPath, {
      verbose: options.verbose === true ? (sql) => log.debug(`SQL: ${sql}`) : undefined,
    });

    this._configure();
    runMigrations(this.db);

    log.info('Local SQLite database opened', { dbPath: options.dbPath });
  }

  private _configure(): void {
    // WAL mode — required by spec for better concurrent read performance
    this.db.pragma('journal_mode = WAL');
    // Synchronous NORMAL is safe with WAL and faster than FULL
    this.db.pragma('synchronous = NORMAL');
    // Foreign keys enforcement
    this.db.pragma('foreign_keys = ON');
    // Memory-mapped I/O for performance (64MB)
    this.db.pragma('mmap_size = 67108864');
    // Busy timeout to handle concurrent access
    this.db.pragma('busy_timeout = 5000');
  }

  /**
   * Execute a function inside a transaction.
   * Automatically commits on success and rolls back on error.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    if (!this._closed) {
      this.db.close();
      this._closed = true;
      log.info('Local SQLite database closed');
    }
  }

  get isClosed(): boolean {
    return this._closed;
  }
}

/**
 * Open the local database for a specific repository.
 * Creates directories and runs migrations automatically.
 */
export function openLocalDb(
  runtimeDataDir: string,
  repositoryId: string,
  options?: Partial<LocalDbOptions>,
): LocalDb {
  const dbPath = path.join(runtimeDataDir, 'repos', repositoryId, 'local.db');
  return new LocalDb({ dbPath, ...options });
}
