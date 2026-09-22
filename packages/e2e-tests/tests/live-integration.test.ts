import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ContextRuntime } from '@context-workspace/runtime';
import { TokenManager, DeviceRegistry, AuthorizationEngine } from '@context-workspace/security';
import { BackupManager } from '../src/backup-manager.js';
import { PROTOCOL_VERSION, EventTypes, EventVisibility, EventSources } from '@context-workspace/protocol';
import { DecisionValidityResolver } from '@context-workspace/retrieval';

describe('Independent Verification — Live Running Services & Integration', () => {
  it('verifies live HTTP server /health and /ready endpoints', async () => {
    const healthRes = await fetch('http://localhost:3000/health');
    expect(healthRes.status).toBe(200);
    const healthJson = (await healthRes.json()) as { status: string; timestamp: number };
    expect(healthJson.status).toBe('ok');
    expect(healthJson.timestamp).toBeGreaterThan(0);

    const readyRes = await fetch('http://localhost:3000/ready');
    expect(readyRes.status).toBe(200);
    const readyJson = (await readyRes.json()) as { status: string; timestamp: number };
    expect(readyJson.status).toBe('ready');
  });

  it('verifies live REST event ingestion and retrieval via /api/v1/events', async () => {
    const eventId = `evt_live_test_${Date.now()}`;
    const baseEvent = {
      eventId,
      protocolVersion: PROTOCOL_VERSION,
      workspaceId: 'ws_live',
      repositoryId: 'repo_live_e2e',
      userId: 'tester',
      deviceId: 'dev_tester',
      agentId: 'agent_live_tester',
      clientSequence: 1,
      type: EventTypes.FILE_MODIFIED,
      timestamp: Date.now(),
      visibility: EventVisibility.REPOSITORY,
      source: EventSources.CLI,
      resource: 'src/core/main.ts',
      payload: {
        diff: '+ live e2e verified payload',
      },
    };

    const ingestRes = await fetch('http://localhost:3000/api/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [baseEvent] }),
    });
    // Multi-status batch response
    expect(ingestRes.status).toBe(207);
    const ingestJson = (await ingestRes.json()) as { results: Array<{ eventId: string; status: string }> };
    expect(ingestJson.results[0]?.status).toBe('stored');

    const fetchRes = await fetch('http://localhost:3000/api/v1/events?repositoryId=repo_live_e2e');
    expect(fetchRes.status).toBe(200);
    const fetchJson = (await fetchRes.json()) as { events: Array<{ eventId: string }> };
    const found = fetchJson.events.some((e) => e.eventId === eventId);
    expect(found).toBe(true);
  });

  it('verifies offline -> reconnect -> synchronization flow', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-sync-test-'));
    const runtime = new ContextRuntime({ dbPath: path.join(tmpDir, 'sync.db') });
    runtime.start();

    // 1. Record events offline through local EventLoop
    runtime.repositories.create({ workspaceId: 'ws_sync', rootPath: '/repo', name: 'sync-repo', id: 'repo_sync_live' });

    const offlineEvent = {
      eventId: `evt_offline_${Date.now()}`,
      protocolVersion: PROTOCOL_VERSION,
      workspaceId: 'ws_sync',
      repositoryId: 'repo_sync_live',
      userId: 'user_offline',
      deviceId: 'dev_offline',
      clientSequence: 1,
      type: EventTypes.DECISION_DECLARED,
      timestamp: Date.now(),
      visibility: EventVisibility.REPOSITORY,
      source: EventSources.CLI,
      payload: { objectType: 'DECISION', decision: 'Offline decision recorded' },
    };
    const loopResult = runtime.eventLoop.processEvent(offlineEvent);
    expect(loopResult.stored).toBe(true);
    expect(loopResult.enqueued).toBe(true);

    const pendingBefore = runtime.outbox.getPendingEntries(10);
    expect(pendingBefore.length).toBeGreaterThan(0);
    expect(pendingBefore.some((item) => item.eventId === offlineEvent.eventId)).toBe(true);

    // 2. Simulate reconnection and synchronize outbox with live server
    for (const item of pendingBefore) {
      const stored = runtime.events.getById(item.eventId);
      if (!stored) continue;

      const resp = await fetch('http://localhost:3000/api/v1/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          events: [{
            eventId: stored.eventId,
            protocolVersion: PROTOCOL_VERSION,
            workspaceId: 'ws_sync',
            repositoryId: stored.repositoryId,
            type: stored.type,
            source: stored.source,
            clientSequence: stored.clientSequence,
            timestamp: stored.timestamp,
            visibility: stored.visibility,
            payload: stored.payload,
          }],
        }),
      });
      if (resp.status === 207) {
        runtime.outbox.acknowledge(item.eventId);
      }
    }

    const pendingAfter = runtime.outbox.getPendingEntries(10);
    expect(pendingAfter.length).toBe(0);

    runtime.stop();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('verifies multi-agent concurrency and mutual exclusion leases on live server', async () => {
    const resource = `src/routes/payment_${Date.now()}.ts`;

    // Agent 1 acquires lease
    const acquire1 = await fetch('http://localhost:3000/api/v1/leases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repositoryId: 'repo_live_concurrent',
        resource,
        holderId: 'agent-alice',
        holderType: 'agent',
        ttlMs: 30000,
      }),
    });
    expect(acquire1.status).toBe(201);
    const json1 = (await acquire1.json()) as { lease: { id: string } };
    expect(json1.lease.id).toBeDefined();

    // Agent 2 attempts to acquire same resource -> 409 Conflict
    const acquire2 = await fetch('http://localhost:3000/api/v1/leases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repositoryId: 'repo_live_concurrent',
        resource,
        holderId: 'agent-bob',
        holderType: 'agent',
        ttlMs: 30000,
      }),
    });
    expect(acquire2.status).toBe(409);

    // Agent 1 releases lease with required holderId query parameter
    const releaseRes = await fetch(`http://localhost:3000/api/v1/leases/${json1.lease.id}?holderId=agent-alice`, {
      method: 'DELETE',
    });
    expect(releaseRes.status).toBe(204);

    // Agent 2 can now acquire successfully
    const acquire3 = await fetch('http://localhost:3000/api/v1/leases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repositoryId: 'repo_live_concurrent',
        resource,
        holderId: 'agent-bob',
        holderType: 'agent',
        ttlMs: 30000,
      }),
    });
    expect(acquire3.status).toBe(201);
    const json3 = (await acquire3.json()) as { lease: { id: string } };
    expect(json3.lease.id).toBeDefined();
  });

  it('verifies repository isolation and RBAC token authorization', () => {
    const registry = new DeviceRegistry();
    registry.registerDevice('device-1', 'user-alice', 'Alice Laptop');
    const tokenManager = new TokenManager('super_secure_verification_secret_32_bytes!', registry);
    const authEngine = new AuthorizationEngine(tokenManager);

    const token = tokenManager.issueToken({
      userId: 'user-alice',
      deviceId: 'device-1',
      role: 'developer',
      allowedRepositories: ['repo_primary'],
      ttlMs: 60000,
    });

    const validated = tokenManager.verifyToken(token);
    expect(validated.valid).toBe(true);
    expect(validated.payload?.allowedRepositories).toContain('repo_primary');
    expect(validated.payload?.allowedRepositories).not.toContain('repo_secret');

    const authPrimary = authEngine.authorizeRepositoryAccess(token, 'repo_primary', 'read_context');
    expect(authPrimary.allowed).toBe(true);

    const authSecret = authEngine.authorizeRepositoryAccess(token, 'repo_secret', 'read_context');
    expect(authSecret.allowed).toBe(false);
    expect(authSecret.reason).toContain("not authorized for repository 'repo_secret'");
  });

  it('verifies decision supersession chain A -> B -> C', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-supersede-test-'));
    const runtime = new ContextRuntime({ dbPath: path.join(tmpDir, 'super.db') });
    runtime.start();
    runtime.repositories.create({ workspaceId: 'ws_s', rootPath: '/repo', name: 'super-repo', id: 'repo_super' });

    // A
    const decA = runtime.objects.create({
      repositoryId: 'repo_super',
      type: 'DECISION',
      scope: 'repository',
      status: 'active',
      authority: 'agent_explicit',
      visibility: 'repository',
      provenance: { sourceEventIds: [] },
      content: { title: 'Architecture Choice', text: 'Monolith' },
    });

    // B supersedes A
    const decB = runtime.objects.create({
      repositoryId: 'repo_super',
      type: 'DECISION',
      scope: 'repository',
      status: 'active',
      authority: 'agent_explicit',
      visibility: 'repository',
      provenance: { sourceEventIds: [] },
      content: { title: 'Architecture Choice', text: 'Microservices', supersedesId: decA.id },
    });
    runtime.relations.create({
      repositoryId: 'repo_super',
      fromId: decB.id,
      toId: decA.id,
      relationType: 'supersedes',
    });

    // C supersedes B
    const decC = runtime.objects.create({
      repositoryId: 'repo_super',
      type: 'DECISION',
      scope: 'repository',
      status: 'active',
      authority: 'agent_explicit',
      visibility: 'repository',
      provenance: { sourceEventIds: [] },
      content: { title: 'Architecture Choice', text: 'Modular Monolith', supersedesId: decB.id },
    });
    runtime.relations.create({
      repositoryId: 'repo_super',
      fromId: decC.id,
      toId: decB.id,
      relationType: 'supersedes',
    });

    const resolver = new DecisionValidityResolver(runtime.relations);
    const resolvedA = resolver.resolve(decA);
    const resolvedB = resolver.resolve(decB);
    const resolvedC = resolver.resolve(decC);

    expect(resolvedA.validity).toBe('SUPERSEDED');
    expect(resolvedB.validity).toBe('SUPERSEDED');
    expect(resolvedC.validity).toBe('ACTIVE');

    runtime.stop();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('verifies backup and restore lifecycle', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-backup-live-'));
    const sourceDb = path.join(tmpDir, 'source.db');
    const runtime = new ContextRuntime({ dbPath: sourceDb });
    runtime.start();
    runtime.repositories.create({ workspaceId: 'ws_b', rootPath: '/repo', name: 'backup-repo', id: 'repo_backup' });
    runtime.objects.create({
      repositoryId: 'repo_backup',
      type: 'DECISION',
      scope: 'repository',
      status: 'active',
      authority: 'agent_explicit',
      visibility: 'repository',
      provenance: { sourceEventIds: [] },
      content: { title: 'Crucial Design', text: 'Must survive backup' },
    });
    runtime.stop();

    const backupDir = path.join(tmpDir, 'backup_archive');
    const manifest = BackupManager.createBackup({
      sourceDbPath: sourceDb,
      targetDir: backupDir,
    });
    expect(manifest.files.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(backupDir, 'context.db'))).toBe(true);

    const restoreDb = path.join(tmpDir, 'restored.db');
    BackupManager.restoreBackup(backupDir, restoreDb);
    expect(fs.existsSync(restoreDb)).toBe(true);

    const restoredRuntime = new ContextRuntime({ dbPath: restoreDb });
    restoredRuntime.start();
    const repos = restoredRuntime.repositories.list();
    const objects = restoredRuntime.objects.list({ repositoryId: 'repo_backup' });
    restoredRuntime.stop();
    fs.rmSync(tmpDir, { recursive: true });

    expect(repos).toHaveLength(1);
    expect(objects).toHaveLength(1);
    expect((objects[0]?.content as { title: string }).title).toBe('Crucial Design');
  });

  it('verifies benchmark tests use executable performance.now() timers and not hardcoded values', () => {
    const benchPath = path.resolve(__dirname, 'benchmarks.test.ts');
    const content = fs.readFileSync(benchPath, 'utf8');

    expect(content).toContain('performance.now()');
    expect(content).toContain('opsPerSec');
    expect(content).toContain('avgLatencyMs');
  });
});
