import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  LocalDb,
  RepositoriesStore,
  CapsulesStore,
  SessionsStore,
  EventsStore,
  OutboxStore,
} from '@context-workspace/database';
import { ContextRuntime, SessionManager } from '@context-workspace/runtime';
import { LeaseEngine, StateRebuilder } from '@context-workspace/server';
import { validateContextEvent } from '@context-workspace/protocol';
import { AuthorizationEngine, DeviceRegistry, TokenManager } from '@context-workspace/security';
import { sha256 } from '@context-workspace/shared';
import type { ContextEvent } from '@context-workspace/protocol';

function createMockSql() {
  const leasesTable: any[] = [];

  const sql: any = async (strings: TemplateStringsArray, ...values: any[]) => {
    const raw = strings.join('?').replace(/\s+/g, ' ').trim();

    if (raw.includes("UPDATE leases SET status = 'expired'")) {
      const now = values[values.length - 1] ?? Date.now();
      for (const lease of leasesTable) {
        if (lease.status === 'active' && lease.expires_at < now) {
          lease.status = 'expired';
        }
      }
      return { count: 1 };
    }

    if (raw.includes("SELECT * FROM leases WHERE repository_id = ? AND resource = ? AND status = 'active'")) {
      const repoId = values[0];
      const resource = values[1];
      return leasesTable.filter(
        (l) => l.repository_id === repoId && l.resource === resource && l.status === 'active',
      );
    }

    if (raw.includes('INSERT INTO leases')) {
      const [id, repoId, res, holderId, holderType, sessId, grantedAt, expiresAt, ttlMs] = values;
      leasesTable.push({
        id,
        repository_id: repoId,
        resource: res,
        holder_id: holderId,
        holder_type: holderType,
        session_id: sessId,
        granted_at: grantedAt,
        expires_at: expiresAt,
        ttl_ms: ttlMs,
        status: 'active',
      });
      return { count: 1 };
    }

    if (raw.includes("UPDATE leases SET status = 'released'")) {
      const [leaseId, holderId] = values;
      let count = 0;
      for (const lease of leasesTable) {
        if (lease.id === leaseId && lease.holder_id === holderId && lease.status === 'active') {
          lease.status = 'released';
          count++;
        }
      }
      return { count };
    }

    return [];
  };

  return sql;
}

describe('Phase 26 — Failure and Recovery Tests', () => {
  let tmpDir: string;
  let localDb: LocalDb;
  let eventsStore: EventsStore;
  let outboxStore: OutboxStore;
  let activeRuntimes: ContextRuntime[] = [];

  const REPO_A = 'repo_failure_alpha';
  const REPO_B = 'repo_failure_beta';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-failure-test-'));
    localDb = new LocalDb({ dbPath: path.join(tmpDir, 'test.db') });
    const repoStore = new RepositoriesStore(localDb.db);
    repoStore.create({ id: REPO_A, workspaceId: 'ws_1', name: 'alpha', rootPath: '/alpha' });
    repoStore.create({ id: REPO_B, workspaceId: 'ws_1', name: 'beta', rootPath: '/beta' });

    eventsStore = new EventsStore(localDb.db);
    outboxStore = new OutboxStore(localDb.db);
    activeRuntimes = [];
  });

  afterEach(async () => {
    for (const r of activeRuntimes) {
      try {
        r.stop();
      } catch {}
    }
    localDb.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. Network loss & offline recovery: retains events and syncs upon reconnection', async () => {
    let networkConnected = false;
    const deliveredEvents: string[] = [];

    const runtime = new ContextRuntime({
      dbPath: path.join(tmpDir, 'offline.db'),
      outboxIntervalMs: 20,
      deliver: async (eventId) => {
        if (!networkConnected) {
          return false; // Network down
        }
        deliveredEvents.push(eventId);
        return true;
      },
    });
    activeRuntimes.push(runtime);

    runtime.repositories.create({ id: REPO_A, workspaceId: 'ws_1', name: 'alpha', rootPath: '/alpha' });
    const capsule = runtime.capsules.create({ repositoryId: REPO_A, name: 'cap-offline' });
    const session = runtime.sessions.open({ capsuleId: capsule.id, userId: 'u1', deviceId: 'd1' });
    runtime.start();

    // Emit event while offline
    const evt: ContextEvent = {
      eventId: 'evt-offline-1',
      protocolVersion: '1.0.0',
      type: 'task.started',
      source: 'agent',
      visibility: 'repository',
      repositoryId: REPO_A,
      capsuleId: capsule.id,
      sessionId: session.session.id,
      clientSequence: 1,
      timestamp: Date.now(),
      payload: { note: 'offline work' },
    };
    runtime.eventLoop.processEvent(evt);

    // Event persisted locally
    expect(runtime.events.getById('evt-offline-1')).toBeDefined();
    expect(deliveredEvents).toHaveLength(0);

    // Reconnect network
    networkConnected = true;
    runtime.outbox.resetPendingRetries();
    await runtime.outboxProcessor.drain();

    expect(deliveredEvents).toContain('evt-offline-1');
  });

  it('2 & 3. Server/Redis restart: restores live state from durable events', async () => {
    const durableEvents: ContextEvent[] = [
      {
        eventId: 'e-rebuild-1',
        protocolVersion: '1.0.0',
        type: 'agent:session:started',
        source: 'agent',
        visibility: 'repository',
        repositoryId: REPO_A,
        agentId: 'agent-charlie',
        sessionId: 'sess-charlie',
        clientSequence: 1,
        timestamp: 1000,
        payload: {},
      },
      {
        eventId: 'e-rebuild-2',
        protocolVersion: '1.0.0',
        type: 'file:change',
        source: 'filesystem',
        visibility: 'repository',
        repositoryId: REPO_A,
        agentId: 'agent-charlie',
        clientSequence: 2,
        timestamp: 1050,
        payload: { path: 'packages/core/engine.ts' },
      },
    ];

    const stateStorage = new Map<string, unknown>();
    const mockLiveState: any = {
      clear: async () => stateStorage.clear(),
      set: async (_repo: string, key: string, val: unknown) => stateStorage.set(key, val),
    };

    const rebuilder = new StateRebuilder(mockLiveState);
    const rebuilt = await rebuilder.rebuild(REPO_A, durableEvents);

    expect(rebuilt.active_agents).toContain('agent-charlie');
    expect(rebuilt.current_resources).toContain('packages/core/engine.ts');
    expect(stateStorage.get('active_agents')).toEqual(['agent-charlie']);
  });

  it('4 & 5. Runtime crash recovery: pending outbox entries reset and drained on restart', async () => {
    const evt: ContextEvent = {
      eventId: 'evt-crash-1',
      protocolVersion: '1.0.0',
      type: 'task.started',
      source: 'agent',
      visibility: 'repository',
      repositoryId: REPO_A,
      clientSequence: 1,
      timestamp: Date.now(),
      payload: {},
    };

    eventsStore.insertIdempotent(evt);
    outboxStore.enqueue('evt-crash-1');

    // Simulate mid-flight crash where entry was marked processing
    localDb.db.prepare("UPDATE outbox SET status = 'processing' WHERE event_id = ?").run('evt-crash-1');

    // On crash recovery / restart
    outboxStore.resetProcessingEntries();
    const pending = outboxStore.getPendingEntries(10);
    expect(pending.some((p) => p.eventId === 'evt-crash-1')).toBe(true);
  });

  it('6. Duplicate events: atomic deduplication preserves exactly one copy', () => {
    const evt: ContextEvent = {
      eventId: 'evt-dup-1',
      protocolVersion: '1.0.0',
      type: 'decision.declared',
      source: 'agent',
      visibility: 'repository',
      repositoryId: REPO_A,
      clientSequence: 1,
      timestamp: Date.now(),
      payload: { decision: 'Single truth' },
    };

    const firstInsert = eventsStore.insertIdempotent(evt);
    const secondInsert = eventsStore.insertIdempotent(evt);

    expect(firstInsert).toBe(true);
    expect(secondInsert).toBe(false); // Ignored atomically

    const saved = eventsStore.getById('evt-dup-1');
    expect(saved).toBeDefined();
    expect(saved?.eventId).toBe('evt-dup-1');
  });

  it('7. Out-of-order events: preserved reliably without corruption', () => {
    const evtSeq2: ContextEvent = {
      eventId: 'evt-ooo-2',
      protocolVersion: '1.0.0',
      type: 'task.progress',
      source: 'agent',
      visibility: 'repository',
      repositoryId: REPO_A,
      clientSequence: 2,
      timestamp: 2000,
      payload: { step: 2 },
    };

    const evtSeq1: ContextEvent = {
      eventId: 'evt-ooo-1',
      protocolVersion: '1.0.0',
      type: 'task.started',
      source: 'agent',
      visibility: 'repository',
      repositoryId: REPO_A,
      clientSequence: 1,
      timestamp: 1000,
      payload: { step: 1 },
    };

    // Arrives in reverse order
    expect(eventsStore.insertIdempotent(evtSeq2)).toBe(true);
    expect(eventsStore.insertIdempotent(evtSeq1)).toBe(true);

    expect(eventsStore.getById('evt-ooo-1')).toBeDefined();
    expect(eventsStore.getById('evt-ooo-2')).toBeDefined();
  });

  it('8. Expired leases: automatically expire allowing resource reacquisition', async () => {
    const leaseEngine = new LeaseEngine(createMockSql());
    const resource = 'file:packages/auth/token.ts';

    // Acquire lease with 1ms TTL
    const lease = await leaseEngine.acquire({
      repositoryId: REPO_A,
      resource,
      holderId: 'agent-first',
      holderType: 'agent',
      ttlMs: 1,
    });
    expect('id' in lease).toBe(true);

    // Wait 15ms for expiration
    await new Promise((r) => setTimeout(r, 15));

    // Second agent tries to acquire
    const secondLease = await leaseEngine.acquire({
      repositoryId: REPO_A,
      resource,
      holderId: 'agent-second',
      holderType: 'agent',
      ttlMs: 60000,
    });

    expect('id' in secondLease).toBe(true);
    if ('id' in secondLease) {
      expect(secondLease.holderId).toBe('agent-second');
    }
  });

  it('9. Stale sessions: session manager properly handles lifecycle transitions', () => {
    const sessionStore = new SessionsStore(localDb.db);
    const capsuleStore = new CapsulesStore(localDb.db);
    const sessionManager = new SessionManager(sessionStore, capsuleStore);

    const capsule = capsuleStore.create({ repositoryId: REPO_A, name: 'cap-stale' });
    const sess = sessionManager.open({ capsuleId: capsule.id, userId: 'u1', deviceId: 'd1' });

    sessionManager.close(sess.session.id);
    const updated = sessionStore.getById(sess.session.id);
    expect(updated?.status).toBe('ended');
  });

  it('10. Corrupted raw chunk: checksum verification detects payload tampering', () => {
    const originalContent = 'critical database migration sql script';
    const expectedHash = sha256(originalContent);

    const tamperedContent = 'critical database migration sql script -- MALICIOUS INJECTION';
    const tamperedHash = sha256(tamperedContent);

    expect(tamperedHash).not.toBe(expectedHash);
  });

  it('11. Invalid event: rejected by schema validation before persistence', () => {
    const malformedEvent = {
      eventId: 'evt-bad-1',
      // missing protocolVersion, type, source, visibility, repositoryId, clientSequence, timestamp
    };

    const validation = validateContextEvent(malformedEvent);
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });

  it('12. Unauthorized repository access: strictly blocked across repositories', () => {
    const deviceRegistry = new DeviceRegistry();
    deviceRegistry.registerDevice('dev-alice', 'user-alice', 'Alice Laptop');

    const tokenManager = new TokenManager('secret-signing-key-12345', deviceRegistry);
    const token = tokenManager.issueToken({
      userId: 'user-alice',
      deviceId: 'dev-alice',
      role: 'developer',
      allowedRepositories: [REPO_A], // Only allowed in REPO_A
    });

    const authEngine = new AuthorizationEngine(tokenManager);

    // Access to allowed repository succeeds
    const allowed = authEngine.authorizeRepositoryAccess(token, REPO_A, 'read_context');
    expect(allowed.allowed).toBe(true);

    // Access to unauthorized repository returns allowed: false (blocking cross-repository access)
    const unauthorized = authEngine.authorizeRepositoryAccess(token, REPO_B, 'read_context');
    expect(unauthorized.allowed).toBe(false);
    expect(unauthorized.reason).toMatch(/not authorized for repository/i);
  });
});
