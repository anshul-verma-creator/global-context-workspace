import { LocalDb } from '@context-workspace/database';
import {
  RepositoriesStore,
  CapsulesStore,
  SessionsStore,
  EventsStore,
  OutboxStore,
  ContextObjectsStore,
  RelationsStore,
} from '@context-workspace/database';
import { createLogger } from '@context-workspace/shared';
import { SessionManager } from './session-manager.js';
import { EventLoop } from './event-loop.js';
import { OutboxProcessor } from './outbox-processor.js';
import { RuntimeContextAssembler } from './runtime-context.js';
import type { DeliverFn } from './outbox-processor.js';

const log = createLogger({ component: 'context-runtime' });

export interface RuntimeConfig {
  /** Path to the SQLite database file */
  dbPath: string;
  /** Pluggable delivery function for outbox sync. No-op if not provided. */
  deliver?: DeliverFn;
  /** Outbox drain interval in ms. Default: 5000 */
  outboxIntervalMs?: number;
}

/**
 * ContextRuntime — top-level orchestrator for the local runtime process.
 *
 * Wires together:
 * - LocalDb (SQLite)
 * - All data stores
 * - SessionManager (session lifecycle)
 * - EventLoop (adapter event → SQLite → outbox)
 * - OutboxProcessor (outbox drain with exponential backoff)
 * - RuntimeContextAssembler (retrieval → compile → Steno)
 *
 * Usage:
 *   const runtime = new ContextRuntime({ dbPath: './ctx.db' });
 *   runtime.start();
 *   // ... use runtime.sessions, runtime.eventLoop, runtime.context
 *   runtime.stop();
 */
export class ContextRuntime {
  readonly db: LocalDb;

  // Stores
  readonly repositories: RepositoriesStore;
  readonly capsules: CapsulesStore;
  readonly rawSessions: SessionsStore;
  readonly events: EventsStore;
  readonly outbox: OutboxStore;
  readonly objects: ContextObjectsStore;
  readonly relations: RelationsStore;

  // Runtime components
  readonly sessions: SessionManager;
  readonly eventLoop: EventLoop;
  readonly outboxProcessor: OutboxProcessor;
  readonly context: RuntimeContextAssembler;

  private _started = false;

  constructor(config: RuntimeConfig) {
    this.db = new LocalDb({ dbPath: config.dbPath });

    // Stores
    this.repositories = new RepositoriesStore(this.db.db);
    this.capsules = new CapsulesStore(this.db.db);
    this.rawSessions = new SessionsStore(this.db.db);
    this.events = new EventsStore(this.db.db);
    this.outbox = new OutboxStore(this.db.db);
    this.objects = new ContextObjectsStore(this.db.db);
    this.relations = new RelationsStore(this.db.db);

    // Runtime components
    this.sessions = new SessionManager(this.rawSessions, this.capsules);
    this.eventLoop = new EventLoop(this.events, this.outbox);

    const deliver: DeliverFn = config.deliver ?? (() => Promise.resolve(false));
    this.outboxProcessor = new OutboxProcessor(
      this.events,
      this.outbox,
      deliver,
      { intervalMs: config.outboxIntervalMs ?? 5_000 },
    );

    this.context = new RuntimeContextAssembler(this.objects, this.relations);
  }

  /**
   * Start the runtime — begins outbox draining.
   */
  start(): void {
    if (this._started) return;
    this._started = true;
    this.outboxProcessor.start();
    log.info('ContextRuntime started', { dbPath: this.db.db.name });
  }

  /**
   * Stop the runtime — halts outbox draining and closes the database.
   */
  stop(): void {
    if (!this._started) return;
    this._started = false;
    this.outboxProcessor.stop();
    this.db.close();
    log.info('ContextRuntime stopped');
  }

  get isStarted(): boolean {
    return this._started;
  }
}
