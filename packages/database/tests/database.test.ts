import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalDb } from '../src/local-db.js';
import { getSchemaVersion } from '../src/migrations.js';
import { RepositoriesStore } from '../src/repositories-store.js';
import { CapsulesStore } from '../src/capsules-store.js';
import { SessionsStore } from '../src/sessions-store.js';
import { EventsStore } from '../src/events-store.js';
import { OutboxStore, computeNextRetryAt } from '../src/outbox-store.js';
import { ContextObjectsStore } from '../src/context-objects-store.js';
import { RelationsStore } from '../src/relations-store.js';
import { DuplicateEventError } from '@context-workspace/shared';
import type { ContextEvent } from '@context-workspace/protocol';
import { EventTypes, EventVisibility, EventSources, PROTOCOL_VERSION } from '@context-workspace/protocol';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

function makeTmpDb(): { db: LocalDb; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-db-test-'));
  const db = new LocalDb({ dbPath: path.join(tmpDir, 'test.db') });
  return { db, tmpDir };
}

function makeEvent(overrides: Partial<ContextEvent> = {}): ContextEvent {
  return {
    eventId: crypto.randomUUID(),
    protocolVersion: PROTOCOL_VERSION,
    workspaceId: 'ws_1',
    repositoryId: 'repo_1',
    userId: 'user_1',
    deviceId: 'device_1',
    clientSequence: 1,
    timestamp: Date.now(),
    type: EventTypes.FILE_MODIFIED,
    visibility: EventVisibility.REPOSITORY,
    source: EventSources.FILESYSTEM,
    payload: { kind: 'file', path: 'src/index.ts', operation: 'modified' },
    ...overrides,
  };
}

describe('LocalDb', () => {
  it('opens and creates schema', () => {
    const { db, tmpDir } = makeTmpDb();
    try {
      const version = getSchemaVersion(db.db);
      expect(version).toBeGreaterThan(0);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('runs migrations idempotently (open twice)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-db-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    try {
      const db1 = new LocalDb({ dbPath });
      const v1 = getSchemaVersion(db1.db);
      db1.close();

      const db2 = new LocalDb({ dbPath });
      const v2 = getSchemaVersion(db2.db);
      db2.close();

      expect(v1).toBe(v2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('runs transactions correctly', () => {
    const { db, tmpDir } = makeTmpDb();
    try {
      const repos = new RepositoriesStore(db.db);
      db.transaction(() => {
        repos.create({ workspaceId: 'ws1', rootPath: '/tmp/test', name: 'test' });
        repos.create({ workspaceId: 'ws1', rootPath: '/tmp/test2', name: 'test2' });
      });
      expect(repos.list()).toHaveLength(2);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

describe('RepositoriesStore', () => {
  let db: LocalDb;
  let tmpDir: string;
  let store: RepositoriesStore;

  beforeEach(() => {
    ({ db, tmpDir } = makeTmpDb());
    store = new RepositoriesStore(db.db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('creates and retrieves a repository', () => {
    const repo = store.create({
      workspaceId: 'ws_1',
      rootPath: '/home/user/project',
      name: 'my-project',
    });

    expect(repo.id).toBeTruthy();
    expect(repo.rootPath).toBe('/home/user/project');
    expect(repo.name).toBe('my-project');

    const found = store.getById(repo.id);
    expect(found).toBeDefined();
    expect(found?.name).toBe('my-project');
  });

  it('finds repository by root path', () => {
    store.create({ workspaceId: 'ws_1', rootPath: '/proj', name: 'proj' });
    const found = store.getByRootPath('/proj');
    expect(found).toBeDefined();
    expect(found?.name).toBe('proj');
  });

  it('returns undefined for nonexistent repository', () => {
    expect(store.getById('nonexistent')).toBeUndefined();
  });

  it('throws NotFoundError for requireById', () => {
    expect(() => store.requireById('nonexistent')).toThrow();
  });

  it('lists all repositories', () => {
    store.create({ workspaceId: 'ws_1', rootPath: '/a', name: 'a' });
    store.create({ workspaceId: 'ws_1', rootPath: '/b', name: 'b' });
    expect(store.list()).toHaveLength(2);
  });
});

describe('CapsulesStore', () => {
  let db: LocalDb;
  let tmpDir: string;
  let repoStore: RepositoriesStore;
  let store: CapsulesStore;
  let repoId: string;

  beforeEach(() => {
    ({ db, tmpDir } = makeTmpDb());
    repoStore = new RepositoriesStore(db.db);
    store = new CapsulesStore(db.db);
    const repo = repoStore.create({ workspaceId: 'ws_1', rootPath: '/proj', name: 'proj' });
    repoId = repo.id;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('creates a capsule', () => {
    const capsule = store.create({ repositoryId: repoId, name: 'feature-work' });
    expect(capsule.status).toBe('active');
    expect(capsule.name).toBe('feature-work');
  });

  it('findOrCreate returns existing capsule', () => {
    const { capsule: c1, created: created1 } = store.findOrCreate({
      repositoryId: repoId,
      name: 'feature',
    });
    const { capsule: c2, created: created2 } = store.findOrCreate({
      repositoryId: repoId,
      name: 'feature',
    });
    expect(created1).toBe(true);
    expect(created2).toBe(false);
    expect(c1.id).toBe(c2.id);
  });

  it('archives a capsule', () => {
    const capsule = store.create({ repositoryId: repoId, name: 'old' });
    const updated = store.updateStatus(capsule.id, 'archived');
    expect(updated.status).toBe('archived');
    expect(updated.archivedAt).toBeDefined();
  });

  it('lists capsules by repository', () => {
    store.create({ repositoryId: repoId, name: 'a' });
    store.create({ repositoryId: repoId, name: 'b' });
    expect(store.listByRepository(repoId)).toHaveLength(2);
    expect(store.listByRepository(repoId, 'active')).toHaveLength(2);
  });
});

describe('SessionsStore', () => {
  let db: LocalDb;
  let tmpDir: string;
  let store: SessionsStore;
  let capsuleId: string;

  beforeEach(() => {
    ({ db, tmpDir } = makeTmpDb());
    const repoStore = new RepositoriesStore(db.db);
    const capsuleStore = new CapsulesStore(db.db);
    const repo = repoStore.create({ workspaceId: 'ws_1', rootPath: '/proj', name: 'proj' });
    const capsule = capsuleStore.create({ repositoryId: repo.id, name: 'main' });
    capsuleId = capsule.id;
    store = new SessionsStore(db.db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('creates and retrieves a session', () => {
    const session = store.create({
      capsuleId,
      userId: 'user_1',
      deviceId: 'device_1',
      nativeSessionId: 'native_123',
    });
    expect(session.status).toBe('active');
    expect(store.getById(session.id)?.capsuleId).toBe(capsuleId);
  });

  it('finds by native session ID', () => {
    store.create({ capsuleId, userId: 'u1', deviceId: 'd1', nativeSessionId: 'native_abc' });
    const found = store.findByNativeSessionId('native_abc');
    expect(found).toBeDefined();
  });

  it('multiple sessions can exist simultaneously in same capsule', () => {
    store.create({ capsuleId, userId: 'u1', deviceId: 'd1' });
    store.create({ capsuleId, userId: 'u2', deviceId: 'd2' });
    expect(store.listByCapsule(capsuleId, 'active')).toHaveLength(2);
  });
});

describe('EventsStore', () => {
  let db: LocalDb;
  let tmpDir: string;
  let store: EventsStore;
  let outbox: OutboxStore;

  beforeEach(() => {
    ({ db, tmpDir } = makeTmpDb());
    const repoStore = new RepositoriesStore(db.db);
    repoStore.create({ workspaceId: 'ws_1', rootPath: '/proj', name: 'proj', id: 'repo_1' });
    store = new EventsStore(db.db);
    outbox = new OutboxStore(db.db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('inserts and retrieves an event', () => {
    const event = makeEvent();
    store.insert(event);
    const found = store.getById(event.eventId);
    expect(found).toBeDefined();
    expect(found?.type).toBe(EventTypes.FILE_MODIFIED);
  });

  it('throws DuplicateEventError on duplicate insert', () => {
    const event = makeEvent();
    store.insert(event);
    expect(() => store.insert(event)).toThrow(DuplicateEventError);
  });

  it('insertIdempotent returns false on duplicate', () => {
    const event = makeEvent();
    expect(store.insertIdempotent(event)).toBe(true);
    expect(store.insertIdempotent(event)).toBe(false);
  });

  it('retrieves events by session in sequence order', () => {
    const sessionId = 'session_1';
    for (let i = 1; i <= 5; i++) {
      store.insert(makeEvent({ clientSequence: i, sessionId }));
    }
    const events = store.listBySession(sessionId);
    expect(events).toHaveLength(5);
    for (let i = 0; i < events.length; i++) {
      expect(events[i]?.clientSequence).toBe(i + 1);
    }
  });

  it('marks events as synced', () => {
    const event = makeEvent();
    store.insert(event);
    store.markSynced(event.eventId, 12345);
    const updated = store.getById(event.eventId);
    expect(updated?.synced).toBe(true);
    expect(updated?.serverSequence).toBe(12345);
  });
});

describe('OutboxStore', () => {
  let db: LocalDb;
  let tmpDir: string;
  let eventStore: EventsStore;
  let outbox: OutboxStore;

  beforeEach(() => {
    ({ db, tmpDir } = makeTmpDb());
    const repoStore = new RepositoriesStore(db.db);
    repoStore.create({ workspaceId: 'ws_1', rootPath: '/proj', name: 'proj', id: 'repo_1' });
    eventStore = new EventsStore(db.db);
    outbox = new OutboxStore(db.db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('enqueues and retrieves pending entries', () => {
    const event = makeEvent();
    eventStore.insert(event);
    outbox.enqueue(event.eventId);

    const pending = outbox.getPendingEntries();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.eventId).toBe(event.eventId);
  });

  it('acknowledges delivery', () => {
    const event = makeEvent();
    eventStore.insert(event);
    outbox.enqueue(event.eventId);
    outbox.acknowledge(event.eventId);

    const entry = outbox.getById(event.eventId);
    expect(entry?.status).toBe('acknowledged');
    expect(entry?.acknowledgedAt).toBeDefined();
    expect(outbox.getPendingEntries()).toHaveLength(0);
  });

  it('records failure with backoff', () => {
    const event = makeEvent();
    eventStore.insert(event);
    outbox.enqueue(event.eventId);

    const before = Date.now();
    outbox.recordFailure(event.eventId);
    const entry = outbox.getById(event.eventId);
    expect(entry?.attempts).toBe(1);
    expect(entry?.nextRetryAt).toBeGreaterThan(before);
  });

  it('resets processing entries on restart', () => {
    const event = makeEvent();
    eventStore.insert(event);
    outbox.enqueue(event.eventId);
    outbox.markProcessing(event.eventId);

    expect(outbox.getPendingEntries()).toHaveLength(0);
    const reset = outbox.resetProcessingEntries();
    expect(reset).toBe(1);
    expect(outbox.getPendingEntries()).toHaveLength(1);
  });

  it('counts pending entries', () => {
    for (let i = 0; i < 3; i++) {
      const event = makeEvent({ clientSequence: i + 1 });
      eventStore.insert(event);
      outbox.enqueue(event.eventId);
    }
    expect(outbox.countPending()).toBe(3);
  });

  it('computes exponential backoff delays', () => {
    // Attempt 0 → immediate
    const t0 = computeNextRetryAt(0);
    expect(t0 - Date.now()).toBeLessThan(100);

    // Attempt 1 → ~5s delay
    const t1 = computeNextRetryAt(1);
    expect(t1 - Date.now()).toBeGreaterThan(4000);
    expect(t1 - Date.now()).toBeLessThan(6000);
  });
});

describe('ContextObjectsStore', () => {
  let db: LocalDb;
  let tmpDir: string;
  let store: ContextObjectsStore;

  beforeEach(() => {
    ({ db, tmpDir } = makeTmpDb());
    const repoStore = new RepositoriesStore(db.db);
    repoStore.create({ workspaceId: 'ws_1', rootPath: '/proj', name: 'proj', id: 'repo_1' });
    store = new ContextObjectsStore(db.db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('creates and retrieves a DECISION object', () => {
    const obj = store.create({
      repositoryId: 'repo_1',
      type: 'DECISION',
      scope: 'repository',
      status: 'active',
      authority: 'agent_explicit',
      visibility: 'repository',
      provenance: { sourceEventIds: ['evt_1'] },
      content: {
        kind: 'decision',
        description: 'Use queue-based retry',
        rationale: 'Avoids duplicate execution on restart',
        requiresConfirmation: false,
      },
    });

    expect(obj.id).toBeTruthy();
    expect(obj.type).toBe('DECISION');
    expect(obj.version).toBe(1);

    const found = store.getById(obj.id);
    expect(found?.type).toBe('DECISION');
    if (found?.content.kind === 'decision') {
      expect(found.content.description).toBe('Use queue-based retry');
    }
  });

  it('updates status and increments version', () => {
    const obj = store.create({
      repositoryId: 'repo_1',
      type: 'PLACEHOLDER',
      scope: 'resource',
      status: 'active',
      authority: 'static_analysis',
      visibility: 'repository',
      provenance: { sourceEventIds: [] },
      content: {
        kind: 'placeholder',
        resource: 'src/config.ts',
        description: 'Hardcoded timeout value',
        detectionMethod: 'static_analysis',
        placeholderStatus: 'active',
      },
    });

    const updated = store.update(obj.id, { status: 'resolved' });
    expect(updated.status).toBe('resolved');
    expect(updated.version).toBe(2);
  });

  it('filters by type', () => {
    store.create({
      repositoryId: 'repo_1',
      type: 'DECISION',
      scope: 'repository',
      status: 'active',
      authority: 'agent_explicit',
      visibility: 'repository',
      provenance: { sourceEventIds: [] },
      content: { kind: 'decision', description: 'D1', requiresConfirmation: false },
    });
    store.create({
      repositoryId: 'repo_1',
      type: 'INTENT',
      scope: 'repository',
      status: 'active',
      authority: 'agent_explicit',
      visibility: 'repository',
      provenance: { sourceEventIds: [] },
      content: { kind: 'intent', description: 'Build payment retry' },
    });

    const decisions = store.list({ repositoryId: 'repo_1', types: ['DECISION'] });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.type).toBe('DECISION');
  });

  it('FTS search finds matching objects', () => {
    store.create({
      repositoryId: 'repo_1',
      type: 'DECISION',
      scope: 'repository',
      status: 'active',
      authority: 'agent_explicit',
      visibility: 'repository',
      provenance: { sourceEventIds: [] },
      content: {
        kind: 'decision',
        description: 'Use queue-based retry for payment processing',
        requiresConfirmation: false,
      },
    });

    const results = store.searchFts('repo_1', 'queue payment');
    expect(results.length).toBeGreaterThan(0);
  });
});

describe('RelationsStore', () => {
  let db: LocalDb;
  let tmpDir: string;
  let objStore: ContextObjectsStore;
  let relStore: RelationsStore;
  let obj1Id: string;
  let obj2Id: string;

  beforeEach(() => {
    ({ db, tmpDir } = makeTmpDb());
    const repoStore = new RepositoriesStore(db.db);
    repoStore.create({ workspaceId: 'ws_1', rootPath: '/proj', name: 'proj', id: 'repo_1' });
    objStore = new ContextObjectsStore(db.db);
    relStore = new RelationsStore(db.db);

    const baseObj = {
      repositoryId: 'repo_1',
      scope: 'repository' as const,
      status: 'active' as const,
      authority: 'agent_explicit' as const,
      visibility: 'repository' as const,
      provenance: { sourceEventIds: [] },
    };

    const o1 = objStore.create({
      ...baseObj,
      type: 'DECISION',
      content: { kind: 'decision', description: 'Use queue retry', requiresConfirmation: false },
    });
    const o2 = objStore.create({
      ...baseObj,
      type: 'INTENT',
      content: { kind: 'intent', description: 'Implement retry' },
    });
    obj1Id = o1.id;
    obj2Id = o2.id;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('creates a relation between objects', () => {
    const rel = relStore.create({
      repositoryId: 'repo_1',
      fromId: obj2Id,
      relationType: 'spawned_from',
      toId: obj1Id,
    });
    expect(rel.id).toBeTruthy();
    expect(rel.relationType).toBe('spawned_from');
  });

  it('retrieves neighbors via relation', () => {
    relStore.create({
      repositoryId: 'repo_1',
      fromId: obj2Id,
      relationType: 'spawned_from',
      toId: obj1Id,
    });

    const neighbors = relStore.getNeighbors(obj2Id, 'spawned_from');
    expect(neighbors).toContain(obj1Id);
  });

  it('lists relations from an object', () => {
    relStore.create({
      repositoryId: 'repo_1',
      fromId: obj1Id,
      relationType: 'related_to',
      toId: obj2Id,
    });
    const relations = relStore.listFrom(obj1Id);
    expect(relations).toHaveLength(1);
  });
});
