import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { eventsRoute } from '../src/routes/events.js';
import { leasesRoute } from '../src/routes/leases.js';
import { realtimeRoute } from '../src/routes/realtime.js';
import type { PgEventsStore } from '../src/db/pg-events-store.js';
import type { EventStream } from '../src/redis/event-stream.js';
import type { LiveStateManager } from '../src/redis/live-state.js';
import type { LeaseEngine, Lease, ConflictDescriptor } from '../src/leases/lease-engine.js';
import type { ContextEvent } from '@context-workspace/protocol';

describe('apps/server - Route Tests', () => {
  describe('Events Route (/api/v1/events)', () => {
    let mockEventsStore: Partial<PgEventsStore>;
    let mockEventStream: Partial<EventStream>;
    let app: ReturnType<typeof Fastify>;

    beforeEach(async () => {
      mockEventsStore = {
        insertIdempotent: vi.fn().mockResolvedValue(true),
        listByRepository: vi.fn().mockResolvedValue([]),
      };
      mockEventStream = {
        publish: vi.fn().mockResolvedValue({ streamId: '1000-0', serverSeq: 1 }),
      };

      app = Fastify();
      await app.register(eventsRoute, {
        eventsStore: mockEventsStore as PgEventsStore,
        eventStream: mockEventStream as EventStream,
      });
    });

    it('rejects malformed request body with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/events',
        payload: { invalid: 'data' },
      });

      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.body);
      expect(json.error).toBe('Invalid request body');
    });

    it('blocks events containing secrets and stores safe events', async () => {
      const safeEvent: ContextEvent = {
        eventId: 'evt_safe_1',
        eventType: 'agent:intent',
        source: 'agent',
        visibility: 'repository',
        repositoryId: 'repo-1',
        capsuleId: 'cap-1',
        sessionId: 'sess-1',
        timestamp: Date.now(),
        payload: { intent: 'Refactor user service' },
      };

      const secretEvent: ContextEvent = {
        eventId: 'evt_secret_1',
        eventType: 'file:change',
        source: 'filesystem',
        visibility: 'repository',
        repositoryId: 'repo-1',
        capsuleId: 'cap-1',
        sessionId: 'sess-1',
        timestamp: Date.now(),
        payload: {
          path: '.env',
          content: 'DATABASE_PASSWORD=supersecretpassword123',
        },
      };

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/events',
        payload: {
          events: [safeEvent, secretEvent],
        },
      });

      expect(res.statusCode).toBe(207);
      const json = JSON.parse(res.body);
      expect(json.results).toEqual([
        { eventId: 'evt_safe_1', status: 'stored' },
        { eventId: 'evt_secret_1', status: 'blocked' },
      ]);

      expect(mockEventsStore.insertIdempotent).toHaveBeenCalledTimes(1);
      expect(mockEventStream.publish).toHaveBeenCalledTimes(1);
    });

    it('detects duplicate events and marks them as duplicate', async () => {
      (mockEventsStore.insertIdempotent as any).mockResolvedValue(false);

      const event: ContextEvent = {
        eventId: 'evt_dup_1',
        eventType: 'task:created',
        source: 'agent',
        visibility: 'repository',
        repositoryId: 'repo-1',
        capsuleId: 'cap-1',
        sessionId: 'sess-1',
        timestamp: Date.now(),
        payload: { title: 'Existing Task' },
      };

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/events',
        payload: {
          events: [event],
        },
      });

      expect(res.statusCode).toBe(207);
      const json = JSON.parse(res.body);
      expect(json.results).toEqual([{ eventId: 'evt_dup_1', status: 'duplicate' }]);
      expect(mockEventStream.publish).not.toHaveBeenCalled();
    });

    it('lists events for a repository with pagination and filters', async () => {
      const mockList: ContextEvent[] = [
        {
          eventId: 'evt_1',
          eventType: 'agent:intent',
          source: 'agent',
          visibility: 'repository',
          repositoryId: 'repo-1',
          capsuleId: 'cap-1',
          sessionId: 'sess-1',
          timestamp: 1000,
          payload: {},
        },
      ];
      (mockEventsStore.listByRepository as any).mockResolvedValue(mockList);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/events?repositoryId=repo-1&since=500&limit=10',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.count).toBe(1);
      expect(json.events).toEqual(mockList);
      expect(mockEventsStore.listByRepository).toHaveBeenCalledWith('repo-1', {
        since: 500,
        limit: 10,
      });
    });

    it('returns 400 when repositoryId is missing from GET /api/v1/events', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/events',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('Leases Route (/api/v1/leases)', () => {
    let mockLeaseEngine: Partial<LeaseEngine>;
    let app: ReturnType<typeof Fastify>;

    beforeEach(async () => {
      mockLeaseEngine = {
        acquire: vi.fn(),
        renew: vi.fn(),
        release: vi.fn(),
        listActive: vi.fn().mockResolvedValue([]),
        getActiveLease: vi.fn(),
      };

      app = Fastify();
      await app.register(leasesRoute, {
        leaseEngine: mockLeaseEngine as LeaseEngine,
      });
    });

    it('acquires a lease successfully (201)', async () => {
      const fakeLease: Lease = {
        id: 'lease-123',
        repositoryId: 'repo-1',
        resource: 'src/index.ts',
        holderId: 'agent-1',
        holderType: 'agent',
        grantedAt: 1000,
        expiresAt: 61000,
        ttlMs: 60000,
        status: 'active',
      };
      (mockLeaseEngine.acquire as any).mockResolvedValue(fakeLease);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/leases',
        payload: {
          repositoryId: 'repo-1',
          resource: 'src/index.ts',
          holderId: 'agent-1',
          holderType: 'agent',
        },
      });

      expect(res.statusCode).toBe(201);
      const json = JSON.parse(res.body);
      expect(json.lease).toEqual(fakeLease);
    });

    it('returns 409 conflict when another holder owns the resource lease', async () => {
      const fakeConflict: ConflictDescriptor = {
        resource: 'src/index.ts',
        existingHolder: {
          id: 'lease-123',
          repositoryId: 'repo-1',
          resource: 'src/index.ts',
          holderId: 'agent-1',
          holderType: 'agent',
          grantedAt: 1000,
          expiresAt: 61000,
          ttlMs: 60000,
          status: 'active',
        },
        challenger: {
          holderId: 'agent-2',
          holderType: 'agent',
        },
        severity: 'high',
        detectedAt: 2000,
      };
      (mockLeaseEngine.acquire as any).mockResolvedValue(fakeConflict);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/leases',
        payload: {
          repositoryId: 'repo-1',
          resource: 'src/index.ts',
          holderId: 'agent-2',
          holderType: 'agent',
        },
      });

      expect(res.statusCode).toBe(409);
      const json = JSON.parse(res.body);
      expect(json.conflict).toEqual(fakeConflict);
    });

    it('renews an existing lease', async () => {
      const renewedLease: Lease = {
        id: 'lease-123',
        repositoryId: 'repo-1',
        resource: 'src/index.ts',
        holderId: 'agent-1',
        holderType: 'agent',
        grantedAt: 1000,
        expiresAt: 120000,
        ttlMs: 60000,
        status: 'active',
      };
      (mockLeaseEngine.renew as any).mockResolvedValue(renewedLease);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/leases/lease-123/renew',
        payload: { ttlMs: 60000 },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.lease.expiresAt).toBe(120000);
    });

    it('releases a lease voluntarily (204)', async () => {
      (mockLeaseEngine.release as any).mockResolvedValue(true);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/leases/lease-123?holderId=agent-1',
      });

      expect(res.statusCode).toBe(204);
      expect(mockLeaseEngine.release).toHaveBeenCalledWith('lease-123', 'agent-1');
    });

    it('returns 404 when releasing a non-existent or wrong holder lease', async () => {
      (mockLeaseEngine.release as any).mockResolvedValue(false);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/leases/lease-123?holderId=wrong-agent',
      });

      expect(res.statusCode).toBe(404);
    });

    it('lists active leases for a repository', async () => {
      const activeList: Lease[] = [
        {
          id: 'l1',
          repositoryId: 'repo-1',
          resource: 'file1.ts',
          holderId: 'agent-1',
          holderType: 'agent',
          grantedAt: 100,
          expiresAt: 60100,
          ttlMs: 60000,
          status: 'active',
        },
      ];
      (mockLeaseEngine.listActive as any).mockResolvedValue(activeList);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/leases?repositoryId=repo-1',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.count).toBe(1);
      expect(json.leases).toEqual(activeList);
    });
  });

  describe('Realtime Route (/api/v1/live)', () => {
    let mockEventStream: Partial<EventStream>;
    let mockLiveState: Partial<LiveStateManager>;
    let app: ReturnType<typeof Fastify>;

    beforeEach(async () => {
      mockEventStream = {
        read: vi.fn().mockResolvedValue([]),
      };
      mockLiveState = {
        getAll: vi.fn().mockResolvedValue({
          active_agents: ['agent-1', 'agent-2'],
          active_sessions: ['sess-1'],
        }),
      };

      app = Fastify();
      await app.register(fastifyWebsocket);
      await app.register(realtimeRoute, {
        eventStream: mockEventStream as EventStream,
        liveState: mockLiveState as LiveStateManager,
      });
    });

    it('returns current live state for a repository', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/live/repo-1/state',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.repositoryId).toBe('repo-1');
      expect(json.state.active_agents).toEqual(['agent-1', 'agent-2']);
    });

    it('polls events from Redis stream via HTTP fallback', async () => {
      (mockEventStream.read as any).mockResolvedValue([
        {
          streamId: '100-0',
          event: {
            eventId: 'evt-1',
            eventType: 'task:created',
            source: 'agent',
            visibility: 'repository',
            repositoryId: 'repo-1',
            capsuleId: 'cap-1',
            sessionId: 'sess-1',
            timestamp: 1000,
            data: {},
          },
        },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/live/repo-1/stream?since=0&count=10',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.count).toBe(1);
      expect(json.lastStreamId).toBe('100-0');
      expect(mockEventStream.read).toHaveBeenCalledWith('repo-1', '0', 10);
    });
  });

  describe('Phase 10 — State Rebuilder & Materialized State', () => {
    it('materializes and rebuilds live state from durable events', async () => {
      const { reduceEventsToLiveState, StateRebuilder } = await import(
        '../src/redis/state-rebuilder.js'
      );

      const events: ContextEvent[] = [
        {
          eventId: 'e1',
          protocolVersion: 1,
          workspaceId: 'ws_1',
          userId: 'u1',
          deviceId: 'd1',
          type: 'agent:started' as any,
          source: 'agent' as any,
          visibility: 'repository' as any,
          repositoryId: 'repo-1',
          agentId: 'agent-alice',
          sessionId: 'sess-1',
          clientSequence: 1,
          timestamp: 1000,
          payload: {},
        },
        {
          eventId: 'e2',
          protocolVersion: 1,
          workspaceId: 'ws_1',
          userId: 'u1',
          deviceId: 'd1',
          type: 'task:created' as any,
          source: 'agent' as any,
          visibility: 'repository' as any,
          repositoryId: 'repo-1',
          agentId: 'agent-alice',
          sessionId: 'sess-1',
          clientSequence: 2,
          timestamp: 1050,
          payload: { taskId: 'task-42', title: 'Implement Redis State' },
        },
        {
          eventId: 'e3',
          protocolVersion: 1,
          workspaceId: 'ws_1',
          userId: 'u1',
          deviceId: 'd1',
          type: 'file:change' as any,
          source: 'filesystem' as any,
          visibility: 'repository' as any,
          repositoryId: 'repo-1',
          agentId: 'agent-alice',
          clientSequence: 3,
          timestamp: 1100,
          payload: { path: 'packages/core/index.ts' },
        },
        {
          eventId: 'e4',
          protocolVersion: 1,
          workspaceId: 'ws_1',
          userId: 'u2',
          deviceId: 'd2',
          type: 'agent:started' as any,
          source: 'agent' as any,
          visibility: 'repository' as any,
          repositoryId: 'repo-1',
          agentId: 'agent-bob',
          sessionId: 'sess-2',
          clientSequence: 1,
          timestamp: 1200,
          payload: {},
        },
        {
          eventId: 'e5',
          protocolVersion: 1,
          workspaceId: 'ws_1',
          userId: 'u2',
          deviceId: 'd2',
          type: 'conflict:detected' as any,
          source: 'agent' as any,
          visibility: 'repository' as any,
          repositoryId: 'repo-1',
          clientSequence: 2,
          timestamp: 1250,
          payload: { conflictId: 'conf-1', resource: 'packages/core/index.ts', severity: 'high' },
        },
        {
          eventId: 'e6',
          protocolVersion: 1,
          workspaceId: 'ws_1',
          userId: 'u1',
          deviceId: 'd1',
          type: 'task:completed' as any,
          source: 'agent' as any,
          visibility: 'repository' as any,
          repositoryId: 'repo-1',
          agentId: 'agent-alice',
          clientSequence: 4,
          timestamp: 1300,
          payload: { taskId: 'task-42' },
        },
        {
          eventId: 'e7',
          protocolVersion: 1,
          workspaceId: 'ws_1',
          userId: 'u2',
          deviceId: 'd2',
          type: 'agent:stopped' as any,
          source: 'agent' as any,
          visibility: 'repository' as any,
          repositoryId: 'repo-1',
          agentId: 'agent-bob',
          sessionId: 'sess-2',
          clientSequence: 3,
          timestamp: 1400,
          payload: {},
        },
      ];

      // 1. Reduce directly
      const state = reduceEventsToLiveState(events);
      expect(state.active_agents).toEqual(['agent-alice']); // bob stopped
      expect(state.active_sessions).toEqual(['sess-1']); // sess-2 stopped
      expect(state.current_resources).toEqual(['packages/core/index.ts']);
      expect(state.current_tasks).toHaveLength(0); // completed
      expect(state.conflicts).toHaveLength(1);
      expect(state.presence['agent-alice']).toBe(1300);
      expect(state.presence['agent-bob']).toBe(1400);

      // 2. Rebuild via StateRebuilder & mock LiveStateManager
      const storage = new Map<string, any>();
      const mockLiveState = {
        clear: vi.fn().mockImplementation(async () => {
          storage.clear();
        }),
        set: vi.fn().mockImplementation(async (_repo: string, key: string, val: any) => {
          storage.set(key, val);
        }),
      };

      const rebuilder = new StateRebuilder(mockLiveState as any);
      const rebuilt = await rebuilder.rebuild('repo-1', events);

      expect(mockLiveState.clear).toHaveBeenCalledWith('repo-1');
      expect(rebuilt.active_agents).toEqual(['agent-alice']);
      expect(storage.get('active_agents')).toEqual(['agent-alice']);
      expect(storage.get('current_resources')).toEqual(['packages/core/index.ts']);
    });
  });
});
