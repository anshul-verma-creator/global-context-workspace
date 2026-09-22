import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalDb, RepositoriesStore, EventsStore, OutboxStore } from '@context-workspace/database';
import { EventLoop } from '../src/event-loop.js';
import { SyncClient, OfflineSynchronizer } from '../src/sync-client.js';
import type { ContextEvent } from '@context-workspace/protocol';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function makeTmpDb(): { db: LocalDb; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-sync-test-'));
  const db = new LocalDb({ dbPath: path.join(tmpDir, 'test.db') });
  return { db, tmpDir };
}

function makeEvent(repoId: string, id: string, seq: number): ContextEvent {
  return {
    eventId: `evt-${id}`,
    protocolVersion: '1.0.0',
    type: 'agent:intent',
    source: 'agent',
    visibility: 'repository',
    repositoryId: repoId,
    clientSequence: seq,
    timestamp: 1000 + seq,
    payload: { note: `Action ${seq}` },
  };
}

describe('Phase 8 — Offline Synchronization', () => {
  let db: LocalDb;
  let tmpDir: string;
  let eventStore: EventsStore;
  let outboxStore: OutboxStore;
  let eventLoop: EventLoop;
  const repoId = 'repo_sync_1';

  // Simulated remote cloud server in memory
  let serverEvents: Map<string, ContextEvent>;
  let serverIsUp: boolean;

  let mockFetch: typeof fetch;
  let syncClient: SyncClient;
  let synchronizer: OfflineSynchronizer;

  beforeEach(() => {
    ({ db, tmpDir } = makeTmpDb());
    const repoStore = new RepositoriesStore(db.db);
    repoStore.create({ workspaceId: 'ws_1', rootPath: '/proj', name: 'proj', id: repoId });

    eventStore = new EventsStore(db.db);
    outboxStore = new OutboxStore(db.db);
    eventLoop = new EventLoop(eventStore, outboxStore);

    serverEvents = new Map();
    serverIsUp = true;

    // Simulated fetch mimicking Cloud Context Server routes (/api/v1/events)
    mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (!serverIsUp) {
        throw new Error('TypeError: fetch failed (ECONNREFUSED)');
      }

      const urlStr = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';

      if (urlStr.includes('/api/v1/events') && method === 'POST') {
        const body = JSON.parse(init?.body as string) as { events: ContextEvent[] };
        const results: { eventId: string; status: 'stored' | 'duplicate' | 'blocked' }[] = [];

        for (const ev of body.events) {
          if (serverEvents.has(ev.eventId)) {
            results.push({ eventId: ev.eventId, status: 'duplicate' });
          } else {
            serverEvents.set(ev.eventId, ev);
            results.push({ eventId: ev.eventId, status: 'stored' });
          }
        }

        return new Response(JSON.stringify({ results }), {
          status: 207,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (urlStr.includes('/api/v1/events') && method === 'GET') {
        const url = new URL(urlStr, 'http://localhost');
        const since = parseInt(url.searchParams.get('since') ?? '0', 10);
        const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);

        const matched = Array.from(serverEvents.values())
          .filter((e) => e.repositoryId === repoId && e.timestamp >= since)
          .slice(0, limit);

        return new Response(JSON.stringify({ events: matched, count: matched.length }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not Found', { status: 404 });
    };

    syncClient = new SyncClient({
      serverUrl: 'http://cloud-context-server:3000',
      fetchFn: mockFetch,
    });

    synchronizer = new OfflineSynchronizer(eventStore, outboxStore, syncClient);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('disconnect a client, generate events, reconnect, and verify no durable event is lost or duplicated', async () => {
    // 1. Client goes offline
    serverIsUp = false;
    syncClient.setOnline(false);

    // 2. Generate 3 local events while offline
    const ev1 = makeEvent(repoId, '1', 1);
    const ev2 = makeEvent(repoId, '2', 2);
    const ev3 = makeEvent(repoId, '3', 3);

    eventLoop.processEvent(ev1);
    eventLoop.processEvent(ev2);
    eventLoop.processEvent(ev3);

    // Verify all 3 events are stored locally in SQLite
    expect(eventStore.getById(ev1.eventId)).toBeDefined();
    expect(eventStore.getById(ev2.eventId)).toBeDefined();
    expect(eventStore.getById(ev3.eventId)).toBeDefined();

    // Verify outbox has 3 pending entries
    expect(outboxStore.countPending()).toBe(3);

    // 3. Attempt sync while offline -> must handle failure cleanly
    const offlineSync = await synchronizer.sync();
    expect(offlineSync.failed).toBe(3);
    expect(offlineSync.stored).toBe(0);

    // Outbox entries are still preserved durably (with incremented attempts)
    expect(outboxStore.countPending()).toBe(3);
    const entry1 = outboxStore.getById(ev1.eventId);
    expect(entry1?.status).toBe('pending');
    expect(entry1?.attempts).toBe(1);

    // Server has received nothing yet
    expect(serverEvents.size).toBe(0);

    // 4. Reconnect client
    serverIsUp = true;
    syncClient.setOnline(true);

    // 5. Sync replays pending events on reconnect
    const onlineSync = await synchronizer.reconnectAndSync();
    expect(onlineSync.stored).toBe(3);
    expect(onlineSync.failed).toBe(0);

    // All events are now on cloud server
    expect(serverEvents.size).toBe(3);
    expect(serverEvents.has(ev1.eventId)).toBe(true);
    expect(serverEvents.has(ev2.eventId)).toBe(true);
    expect(serverEvents.has(ev3.eventId)).toBe(true);

    // Outbox is now drained (0 pending)
    expect(outboxStore.countPending()).toBe(0);

    // 6. Test duplicate protection: re-sending the same events
    // Manually add ev1 back to outbox to simulate a re-send
    outboxStore.enqueue(ev1.eventId);
    expect(outboxStore.countPending()).toBe(1);

    const replaySync = await synchronizer.sync();
    expect(replaySync.duplicate).toBe(1);
    expect(replaySync.stored).toBe(0);
    // Outbox acknowledges the duplicate and drains cleanly
    expect(outboxStore.countPending()).toBe(0);
    // Server still only has 3 unique events (no duplication!)
    expect(serverEvents.size).toBe(3);
  });

  it('reconciles latest remote events on reconnect without losing local state', async () => {
    // Simulate another agent uploading an event directly to cloud server
    const remoteEvent: ContextEvent = {
      eventId: 'evt-remote-99',
      protocolVersion: '1.0.0',
      type: 'decision:recorded',
      source: 'agent',
      visibility: 'repository',
      repositoryId: repoId,
      clientSequence: 10,
      timestamp: 5000,
      payload: { decision: 'Adopt PostgreSQL 16' },
    };
    serverEvents.set(remoteEvent.eventId, remoteEvent);

    // Local client does not have it yet
    expect(eventStore.getById(remoteEvent.eventId)).toBeUndefined();

    // Reconcile
    const result = await synchronizer.reconcile(repoId, 0);
    expect(result.fetched).toBe(1);
    expect(result.newlyInserted).toBe(1);

    // Now local store has the remote event
    const stored = eventStore.getById(remoteEvent.eventId);
    expect(stored).toBeDefined();
    expect(stored?.type).toBe('decision:recorded');

    // Reconciling again does not duplicate or fail
    const secondReconcile = await synchronizer.reconcile(repoId, 0);
    expect(secondReconcile.newlyInserted).toBe(0);
  });
});
