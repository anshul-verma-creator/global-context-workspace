import type { ContextEvent } from '@context-workspace/protocol';
import type { SessionsStore, CapsulesStore, LocalSession, LocalCapsule } from '@context-workspace/database';
import { generateId, nowMs, createLogger } from '@context-workspace/shared';

const log = createLogger({ component: 'session-manager' });

/**
 * Runtime session — extends the stored session with live process state.
 */
export interface RuntimeSession {
  /** Canonical session row from the database */
  session: LocalSession;
  /** Capsule this session belongs to */
  capsule: LocalCapsule;
  /** Native agent/IDE session identifier (e.g. Claude session ID) */
  nativeSessionId?: string;
  /** When the runtime process attached to this session */
  attachedAt: number;
  /** True while the session is active in this runtime process */
  isActive: boolean;
}

export interface SessionOpenParams {
  capsuleId: string;
  /** User identifier — required by the sessions table */
  userId: string;
  /** Device identifier — required by the sessions table */
  deviceId: string;
  /** Agent identifier stored in the session row */
  agentId?: string;
  /** Native IDE/agent session ID for reverse-lookup */
  nativeSessionId?: string;
  /** Re-use an existing session ID instead of creating a new one */
  existingSessionId?: string;
}

/**
 * Session manager — creates, discovers, attaches to, and closes sessions.
 *
 * Per spec §9 (Architecture): multiple AI sessions in the same repository
 * must not mix their identity. Each session is scoped to exactly one capsule.
 *
 * Lifecycle:
 *   open() → active → close()
 *
 * The manager maintains an in-process map so the event loop can route
 * events to the correct session without re-querying the DB every time.
 */
export class SessionManager {
  private readonly liveSessions: Map<string, RuntimeSession> = new Map();
  private readonly sessionStore: SessionsStore;
  private readonly capsuleStore: CapsulesStore;

  constructor(sessionStore: SessionsStore, capsuleStore: CapsulesStore) {
    this.sessionStore = sessionStore;
    this.capsuleStore = capsuleStore;
  }

  /**
   * Open a new session, or attach to an existing one.
   */
  open(params: SessionOpenParams): RuntimeSession {
    if (params.existingSessionId !== undefined) {
      return this._attachExisting(params.existingSessionId, params.nativeSessionId);
    }
    return this._createNew(params);
  }

  /**
   * Get a live runtime session by session ID.
   */
  get(sessionId: string): RuntimeSession | undefined {
    return this.liveSessions.get(sessionId);
  }

  /**
   * Get all currently active runtime sessions.
   */
  getAll(): RuntimeSession[] {
    return [...this.liveSessions.values()];
  }

  /**
   * Close a session — marks ended in DB, removes from live map.
   */
  close(sessionId: string): void {
    const rts = this.liveSessions.get(sessionId);
    if (rts === undefined) {
      log.warn('Attempted to close unknown session', { sessionId });
      return;
    }

    this.sessionStore.updateStatus(sessionId, 'ended');
    rts.isActive = false;
    this.liveSessions.delete(sessionId);

    log.info('Session closed', { sessionId, capsuleId: rts.session.capsuleId });
  }

  /**
   * Find the active runtime session for a given agent + capsule combination.
   * Used by the event loop to route incoming events.
   */
  findForEvent(event: ContextEvent): RuntimeSession | undefined {
    if (event.agentId === undefined) return undefined;
    for (const rts of this.liveSessions.values()) {
      if (
        rts.session.agentId === event.agentId &&
        rts.capsule.repositoryId === event.repositoryId
      ) {
        return rts;
      }
    }
    return undefined;
  }

  /**
   * Find by native session ID — for adapter-level session detection.
   */
  findByNativeId(nativeSessionId: string): RuntimeSession | undefined {
    for (const rts of this.liveSessions.values()) {
      if (rts.nativeSessionId === nativeSessionId) return rts;
    }
    // Fall back to DB lookup
    const dbSession = this.sessionStore.findByNativeSessionId(nativeSessionId);
    if (dbSession === undefined) return undefined;
    return this._attachExisting(dbSession.id, nativeSessionId);
  }

  private _createNew(params: SessionOpenParams): RuntimeSession {
    const capsule = this.capsuleStore.getById(params.capsuleId);
    if (capsule === undefined) {
      throw new Error(`Cannot open session: capsule '${params.capsuleId}' not found`);
    }

    const session = this.sessionStore.create({
      id: generateId(),
      capsuleId: params.capsuleId,
      userId: params.userId,
      deviceId: params.deviceId,
      ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
      ...(params.nativeSessionId !== undefined ? { nativeSessionId: params.nativeSessionId } : {}),
    });

    const rts: RuntimeSession = {
      session,
      capsule,
      isActive: true,
      attachedAt: nowMs(),
      ...(params.nativeSessionId !== undefined ? { nativeSessionId: params.nativeSessionId } : {}),
    };

    this.liveSessions.set(session.id, rts);

    log.info('Session opened', {
      sessionId: session.id,
      capsuleId: params.capsuleId,
      ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    });

    return rts;
  }

  private _attachExisting(sessionId: string, nativeSessionId?: string): RuntimeSession {
    const existing = this.liveSessions.get(sessionId);
    if (existing !== undefined) {
      log.debug('Re-attaching to already-active session', { sessionId });
      return existing;
    }

    const session = this.sessionStore.getById(sessionId);
    if (session === undefined) {
      throw new Error(`Cannot attach: session '${sessionId}' not found`);
    }

    const capsule = this.capsuleStore.getById(session.capsuleId);
    if (capsule === undefined) {
      throw new Error(`Cannot attach: capsule '${session.capsuleId}' not found for session '${sessionId}'`);
    }

    const rts: RuntimeSession = {
      session,
      capsule,
      isActive: true,
      attachedAt: nowMs(),
      ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
    };

    this.liveSessions.set(sessionId, rts);

    log.info('Attached to existing session', { sessionId, capsuleId: session.capsuleId });
    return rts;
  }
}
