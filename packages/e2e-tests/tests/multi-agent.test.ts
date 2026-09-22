import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ContextRuntime, PlaceholderManager, HandoffManager } from '@context-workspace/runtime';
import { LeaseEngine, type Lease } from '@context-workspace/server';
import type { ContextEvent } from '@context-workspace/protocol';

/**
 * In-memory SQL emulator for LeaseEngine testing without external Postgres.
 */
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

    if (raw.includes('SELECT * FROM leases WHERE repository_id = ? AND resource = ? AND status = \'active\'')) {
      const repoId = values[0];
      const resource = values[1];
      const found = leasesTable.filter(
        (l) => l.repository_id === repoId && l.resource === resource && l.status === 'active',
      );
      return found;
    }

    if (raw.includes('SELECT * FROM leases WHERE repository_id = ? AND status = \'active\'')) {
      const repoId = values[0];
      return leasesTable.filter((l) => l.repository_id === repoId && l.status === 'active');
    }

    if (raw.includes('SELECT * FROM leases WHERE id = ?')) {
      const id = values[0];
      return leasesTable.filter((l) => l.id === id);
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

    if (raw.includes('UPDATE leases SET status = \'released\'')) {
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

    if (raw.includes('UPDATE leases SET expires_at = ?')) {
      const [expiresAt, leaseId] = values;
      for (const lease of leasesTable) {
        if (lease.id === leaseId && lease.status === 'active') {
          lease.expires_at = expiresAt;
        }
      }
      return { count: 1 };
    }

    return [];
  };

  return sql;
}

describe('Phase 25 — End-to-End Multi-Agent Coordination', () => {
  let tmpDirA: string;
  let tmpDirB: string;
  let runtimeA: ContextRuntime;
  let runtimeB: ContextRuntime;
  let leaseEngine: LeaseEngine;

  const REPO_ID = 'repo_e2e_core';
  const WORKSPACE_ID = 'ws_e2e';

  beforeEach(async () => {
    tmpDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-e2e-a-'));
    tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-e2e-b-'));

    runtimeA = new ContextRuntime({ dbPath: path.join(tmpDirA, 'runtimeA.db') });
    runtimeB = new ContextRuntime({ dbPath: path.join(tmpDirB, 'runtimeB.db') });

    await runtimeA.start();
    await runtimeB.start();

    // Register repository in both local runtimes
    runtimeA.repositories.create({
      id: REPO_ID,
      workspaceId: WORKSPACE_ID,
      name: 'core-repo',
      rootPath: '/work/core-repo',
    });

    runtimeB.repositories.create({
      id: REPO_ID,
      workspaceId: WORKSPACE_ID,
      name: 'core-repo',
      rootPath: '/work/core-repo',
    });

    leaseEngine = new LeaseEngine(createMockSql());
  });

  afterEach(async () => {
    await runtimeA.stop();
    await runtimeB.stop();
    fs.rmSync(tmpDirA, { recursive: true, force: true });
    fs.rmSync(tmpDirB, { recursive: true, force: true });
  });

  it('executes full 12-step multi-agent coordination without manual context copying', async () => {
    // ─── Step 1: Agent A starts a task ──────────────────────────────────────
    const capsuleA = runtimeA.capsules.create({ repositoryId: REPO_ID, name: 'feature-auth-refactor' });
    const runtimeSessionA = runtimeA.sessions.open({
      capsuleId: capsuleA.id,
      userId: 'user-alice',
      deviceId: 'laptop-a',
      agentId: 'agent-alice',
    });
    const sessionA = runtimeSessionA.session;

    const taskId = 'task-auth-001';
    const taskEvent: ContextEvent = {
      eventId: 'evt-task-a1',
      protocolVersion: 1,
      type: 'task.started',
      source: 'agent',
      visibility: 'repository',
      repositoryId: REPO_ID,
      capsuleId: capsuleA.id,
      sessionId: sessionA.id,
      agentId: 'agent-alice',
      workspaceId: WORKSPACE_ID,
      clientSequence: 1,
      timestamp: Date.now(),
      payload: { note: 'Refactor session authorization' },
    };
    runtimeA.eventLoop.processEvent(taskEvent);

    runtimeA.objects.create(
      {
        repositoryId: REPO_ID,
        capsuleId: capsuleA.id,
        type: 'TASK',
        scope: 'capsule',
        status: 'active',
        authority: 'agent_explicit',
        visibility: 'repository',
        provenance: {
          sourceEventIds: ['evt-task-a1'],
          sessionId: sessionA.id,
          capsuleId: capsuleA.id,
          description: 'Task started by Agent Alice',
        },
        content: {
          kind: 'task',
          title: 'Refactor session authorization',
          description: 'Refactor session authorization to use WebCrypto',
          status: 'active',
        },
      },
      taskId,
    );

    // ─── Step 2: Agent A modifies a file and acquires lease ─────────────────
    const resourcePath = 'file:packages/auth/src/session.ts';
    const leaseResultA = await leaseEngine.acquire({
      repositoryId: REPO_ID,
      resource: resourcePath,
      holderId: 'agent-alice',
      holderType: 'agent',
      sessionId: sessionA.id,
      ttlMs: 60000,
    });

    expect('id' in leaseResultA).toBe(true);
    const leaseA = leaseResultA as Lease;
    expect(leaseA.holderId).toBe('agent-alice');
    expect(leaseA.status).toBe('active');

    // ─── Step 3: Agent A declares an intent ─────────────────────────────────
    const intentId = 'intent-webcrypto-001';
    const intentEvent: ContextEvent = {
      eventId: 'evt-intent-a1',
      protocolVersion: 1,
      type: 'intent.declared',
      source: 'agent',
      visibility: 'repository',
      repositoryId: REPO_ID,
      capsuleId: capsuleA.id,
      sessionId: sessionA.id,
      agentId: 'agent-alice',
      workspaceId: WORKSPACE_ID,
      clientSequence: 2,
      timestamp: Date.now(),
      payload: {
        note: 'Migrate legacy node crypto tokens to WebCrypto HMAC-SHA256',
      },
    };
    runtimeA.eventLoop.processEvent(intentEvent);

    const intentCreated = runtimeA.objects.create(
      {
        repositoryId: REPO_ID,
        type: 'INTENT',
        scope: 'repository',
        status: 'active',
        authority: 'agent_explicit',
        visibility: 'repository',
        provenance: {
          sourceEventIds: ['evt-intent-a1'],
          sessionId: sessionA.id,
          capsuleId: capsuleA.id,
        },
        content: {
          kind: 'intent',
          description: 'Migrate legacy node crypto tokens to WebCrypto HMAC-SHA256',
        },
      },
      intentId,
    );

    // ─── Step 4: Agent B starts another session in same repository ──────────
    const capsuleB = runtimeB.capsules.create({ repositoryId: REPO_ID, name: 'maintenance-auth' });
    const runtimeSessionB = runtimeB.sessions.open({
      capsuleId: capsuleB.id,
      userId: 'user-bob',
      deviceId: 'laptop-b',
      agentId: 'agent-bob',
    });
    const sessionB = runtimeSessionB.session;

    // Sync state to B's local database (simulating cloud sync down to Laptop B)
    runtimeB.objects.create(
      {
        repositoryId: intentCreated.repositoryId,
        type: intentCreated.type,
        scope: intentCreated.scope,
        status: intentCreated.status,
        authority: intentCreated.authority,
        visibility: intentCreated.visibility,
        provenance: intentCreated.provenance,
        content: intentCreated.content,
      },
      intentCreated.id,
    );

    // ─── Step 5: B receives relevant live context ───────────────────────────
    const assembledB = await runtimeB.context.assemble(
      sessionB,
      {
        task: 'WebCrypto HMAC-SHA256',
        repositoryId: REPO_ID,
      },
      { maxTokens: 2000 },
    );

    expect(assembledB.includedObjectIds).toContain(intentId);
    expect(assembledB.serialized).toContain('WebCrypto HMAC-SHA256');

    // ─── Step 6: B attempts overlapping work on leased resource ─────────────
    const leaseAttemptB = await leaseEngine.acquire({
      repositoryId: REPO_ID,
      resource: resourcePath,
      holderId: 'agent-bob',
      holderType: 'agent',
      sessionId: sessionB.id,
    });

    // ─── Step 7: Conflict is detected ───────────────────────────────────────
    expect('severity' in leaseAttemptB).toBe(true);
    if ('severity' in leaseAttemptB) {
      expect(leaseAttemptB.resource).toBe(resourcePath);
      expect(leaseAttemptB.existingHolder.holderId).toBe('agent-alice');
      expect(leaseAttemptB.challenger.holderId).toBe('agent-bob');
      expect(leaseAttemptB.severity).toBe('high');
    }

    // ─── Step 8: Agent A creates a decision ─────────────────────────────────
    const decisionId = 'dec-webcrypto-001';
    const decisionCreated = runtimeA.objects.create(
      {
        repositoryId: REPO_ID,
        type: 'DECISION',
        scope: 'repository',
        status: 'active',
        authority: 'agent_explicit',
        visibility: 'repository',
        resource: resourcePath,
        provenance: {
          sourceEventIds: ['evt-dec-a1'],
          sessionId: sessionA.id,
          capsuleId: capsuleA.id,
        },
        content: {
          kind: 'decision',
          description: 'Use WebCrypto HMAC-SHA256 for session tokens',
          rationale: 'WebCrypto is cross-runtime compatible and hardware accelerated',
          requiresConfirmation: false,
        },
      },
      decisionId,
    );

    // ─── Step 9: Agent A creates a handoff and declares placeholder ─────────
    const placeholderMgrA = new PlaceholderManager(runtimeA.objects);
    const placeholder = placeholderMgrA.register({
      repositoryId: REPO_ID,
      capsuleId: capsuleA.id,
      resource: 'packages/auth/src/auth-helper.ts',
      description: 'MOCK_TOKEN_SIGNER in auth-helper.ts',
      intendedReplacement: 'WebCryptoSigner with HMAC key',
      detectionMethod: 'agent_declaration',
      initialStatus: 'active',
    });

    const handoffMgrA = new HandoffManager(runtimeA.objects);
    const handoff = handoffMgrA.createHandoff({
      repositoryId: REPO_ID,
      capsuleId: capsuleA.id,
      completed: ['Implemented HMAC secret hashing utility in packages/auth'],
      remaining: ['Wire session verification into request handler', 'Replace MOCK_TOKEN_SIGNER'],
      next_step: 'Replace mock signer in packages/auth/src/auth-helper.ts with WebCryptoSigner',
      placeholders: ['MOCK_TOKEN_SIGNER in auth-helper.ts'],
      summary: 'Auth refactor partially complete; token verification remains.',
      authorAgentId: 'agent-alice',
    });

    // Agent A voluntarily releases the lease on session.ts
    const released = await leaseEngine.release(leaseA.id, 'agent-alice');
    expect(released).toBe(true);

    // ─── Step 10: B retrieves the decision and handoff ───────────────────────
    // Sync objects to B (simulating cloud sync)
    runtimeB.objects.create(
      {
        repositoryId: decisionCreated.repositoryId,
        ...(decisionCreated.capsuleId !== undefined ? { capsuleId: decisionCreated.capsuleId } : {}),
        type: decisionCreated.type,
        scope: decisionCreated.scope,
        status: decisionCreated.status,
        authority: decisionCreated.authority,
        visibility: decisionCreated.visibility,
        ...(decisionCreated.resource !== undefined ? { resource: decisionCreated.resource } : {}),
        provenance: decisionCreated.provenance,
        content: decisionCreated.content,
      },
      decisionCreated.id,
    );

    runtimeB.objects.create(
      {
        repositoryId: placeholder.repositoryId,
        ...(placeholder.capsuleId !== undefined ? { capsuleId: placeholder.capsuleId } : {}),
        type: placeholder.type,
        scope: placeholder.scope,
        status: placeholder.status,
        authority: placeholder.authority,
        visibility: placeholder.visibility,
        ...(placeholder.resource !== undefined ? { resource: placeholder.resource } : {}),
        provenance: placeholder.provenance,
        content: placeholder.content,
      },
      placeholder.id,
    );

    runtimeB.objects.create(
      {
        repositoryId: handoff.repositoryId,
        ...(handoff.capsuleId !== undefined ? { capsuleId: handoff.capsuleId } : {}),
        type: handoff.type,
        scope: handoff.scope,
        status: handoff.status,
        authority: handoff.authority,
        visibility: handoff.visibility,
        ...(handoff.resource !== undefined ? { resource: handoff.resource } : {}),
        provenance: handoff.provenance,
        content: handoff.content,
      },
      handoff.id,
    );

    const handoffMgrB = new HandoffManager(runtimeB.objects);
    const latestHandoff = handoffMgrB.getLatestHandoff(REPO_ID);
    expect(latestHandoff).toBeDefined();
    expect((latestHandoff?.content as any).next_step).toBe(
      'Replace mock signer in packages/auth/src/auth-helper.ts with WebCryptoSigner',
    );

    // ─── Step 11: Placeholder is visible with warning ───────────────────────
    const placeholderMgrB = new PlaceholderManager(runtimeB.objects);
    const placeholderView = placeholderMgrB.formatForRetrieval(placeholder);
    expect(placeholderView.warning).toContain('NON-AUTHORITATIVE PLACEHOLDER');
    expect(placeholderView.intendedReplacement).toBe('WebCryptoSigner with HMAC key');

    // ─── Step 12: B continues without needing original chat history ─────────
    // B successfully acquires lease now that A released it
    const leaseResultB2 = await leaseEngine.acquire({
      repositoryId: REPO_ID,
      resource: resourcePath,
      holderId: 'agent-bob',
      holderType: 'agent',
      sessionId: sessionB.id,
    });
    expect('id' in leaseResultB2).toBe(true);

    // B starts work on the exact next step without needing A's raw chat log
    const taskBId = 'task-auth-002';
    runtimeB.objects.create(
      {
        repositoryId: REPO_ID,
        capsuleId: capsuleB.id,
        type: 'TASK',
        scope: 'capsule',
        status: 'active',
        authority: 'agent_explicit',
        visibility: 'repository',
        provenance: {
          sourceEventIds: ['evt-task-b1'],
          sessionId: sessionB.id,
          capsuleId: capsuleB.id,
        },
        content: {
          kind: 'task',
          title: (latestHandoff!.content as any).next_step,
          description: 'Carry forward handoff from agent-alice',
          status: 'active',
        },
      },
      taskBId,
    );

    // Verify assembled Steno context on Laptop B contains all essential semantic context
    const assembledB2 = await runtimeB.context.assemble(
      sessionB,
      {
        task: (latestHandoff!.content as any).next_step,
        repositoryId: REPO_ID,
      },
      { maxTokens: 2000 },
    );

    expect(assembledB2.serialized).toContain('steno:v1');
    expect(assembledB2.serialized).toContain('Replace mock signer');
    expect(assembledB2.includedObjectIds.length).toBeGreaterThan(0);

    // Acceptance satisfied: full workflow succeeded without copying any chat history!
  });
});
