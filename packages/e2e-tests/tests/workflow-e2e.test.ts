/**
 * End-to-End Multi-Agent Workflow Test
 *
 * Tests the complete real scenario:
 *  Step 0:  server stack health
 *  Step 1:  create repository test-repo
 *  Step 2:  create two independent capsules (Agent A, Agent B)
 *  Step 3a: Agent A records a decision via MCP
 *  Step 3b: Agent A declares active intent/task via MCP
 *  Step 3c: Agent A creates a handoff via MCP
 *  Step 3d: Agent A registers a placeholder via MCP
 *  Step 3e: Agent A records a test result (context object)
 *  Step 4:  Agent A emits a file-modified event (offline → SQLite outbox)
 *  Step 5:  Agent B joins the same repository (fresh SQLite, simulated sync)
 *  Step 6:  Agent B requests context via MCP context.current
 *  Step 7:  Verify Agent B receives decision, handoff, placeholder — NOT raw chat history
 *  Step 8:  Repository isolation — Agent B cannot see a different repository
 *  Step 9:  Decision supersession A→B — old decision resolves as SUPERSEDED
 *  Step 10: Offline outbox events sync to live server PostgreSQL
 *  Step 11: Verify events are queryable from server PostgreSQL and Redis stream
 *  Step 12: Conflict — Agent A holds server lease, Agent B is blocked (409)
 *  Step 13: Conflict surfaced — Agent B detects via server lease check
 *  Final:   Object count assertions for both agents' local SQLite
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ContextRuntime } from '@context-workspace/runtime';
import { McpServer } from '@context-workspace/mcp';
import { DecisionValidityResolver } from '@context-workspace/retrieval';
import { PROTOCOL_VERSION, EventTypes, EventVisibility, EventSources } from '@context-workspace/protocol';

// ── Constants ───────────────────────────────────────────────────────────────────
const SERVER_URL = 'http://localhost:3000';
const REPO_ID = 'test-repo-e2e-workflow';
const REPO_B_ID = 'test-repo-e2e-isolated';
const CAPSULE_A = 'capsule-agent-a';
const CAPSULE_B = 'capsule-agent-b';
const RESOURCE = 'src/payment/processor.ts';

// ── HTTP helpers ────────────────────────────────────────────────────────────────
async function serverPost(urlPath: string, body: unknown) {
  return fetch(`${SERVER_URL}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function serverGet(urlPath: string) {
  return fetch(`${SERVER_URL}${urlPath}`);
}

// ── MCP helpers ─────────────────────────────────────────────────────────────────
async function mcpCall(
  server: McpServer,
  method: string,
  params: Record<string, unknown>,
): Promise<{ jsonrpc: string; result?: unknown; error?: { message: string } }> {
  const req = JSON.stringify({ jsonrpc: '2.0', id: Math.random(), method, params });
  const resp = await server.handleMessage(req);
  return JSON.parse(resp!) as { jsonrpc: string; result?: unknown; error?: { message: string } };
}

async function mcpTool(
  server: McpServer,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ jsonrpc: string; result?: unknown; error?: { message: string } }> {
  return mcpCall(server, 'tools/call', { name: tool, arguments: args });
}

function mcpText(resp: { result?: unknown }): string {
  return ((resp.result as { content: { text: string }[] }).content[0]!.text);
}

// ── Test state ──────────────────────────────────────────────────────────────────
let tmpDir: string;
let runtimeA: ContextRuntime;
let runtimeB: ContextRuntime;
let mcpA: McpServer;
let mcpB: McpServer;
let decisionAId: string;
let decisionBId: string;
// leaseId returned by server for cleanup
let serverLeaseId: string | undefined;

// ── Lifecycle ────────────────────────────────────────────────────────────────────
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-workflow-e2e-'));

  runtimeA = new ContextRuntime({ dbPath: path.join(tmpDir, 'agent-a.db') });
  runtimeB = new ContextRuntime({ dbPath: path.join(tmpDir, 'agent-b.db') });

  runtimeA.start();
  runtimeB.start();

  mcpA = new McpServer(runtimeA);
  mcpB = new McpServer(runtimeB);
});

afterAll(async () => {
  // Clean up server lease if we left one
  if (serverLeaseId !== undefined) {
    await fetch(`${SERVER_URL}/api/v1/leases/${serverLeaseId}?holderId=agent-a`, {
      method: 'DELETE',
    }).catch(() => undefined);
  }
  runtimeA.stop();
  runtimeB.stop();
  fs.rmSync(tmpDir, { recursive: true });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('End-to-End Multi-Agent Workflow', () => {

  // ── Step 0 ──────────────────────────────────────────────────────────────────
  it('Step 0: server stack is healthy (HTTP /health + /ready)', async () => {
    const h = await serverGet('/health');
    expect(h.status).toBe(200);
    expect(((await h.json()) as { status: string }).status).toBe('ok');

    const r = await serverGet('/ready');
    expect(r.status).toBe(200);
    expect(((await r.json()) as { status: string }).status).toBe('ready');
  });

  // ── Step 1 ──────────────────────────────────────────────────────────────────
  it('Step 1: create repository test-repo in Agent A local runtime', () => {
    const repo = runtimeA.repositories.create({
      id: REPO_ID,
      workspaceId: 'ws-e2e',
      rootPath: '/projects/test-repo',
      name: 'test-repo',
    });
    expect(repo.id).toBe(REPO_ID);

    // Isolated repo for isolation test — only in Agent A's DB
    const repoB = runtimeA.repositories.create({
      id: REPO_B_ID,
      workspaceId: 'ws-e2e',
      rootPath: '/projects/isolated',
      name: 'isolated-repo',
    });
    expect(repoB.id).toBe(REPO_B_ID);
  });

  // ── Step 2 ──────────────────────────────────────────────────────────────────
  it('Step 2: create two independent capsules for test-repo', () => {
    const cA = runtimeA.capsules.create({ id: CAPSULE_A, repositoryId: REPO_ID, name: 'Agent A' });
    expect(cA.id).toBe(CAPSULE_A);

    const cB = runtimeA.capsules.create({ id: CAPSULE_B, repositoryId: REPO_ID, name: 'Agent B' });
    expect(cB.id).toBe(CAPSULE_B);
  });

  // ── Step 3a ─────────────────────────────────────────────────────────────────
  it('Step 3a: Agent A records a decision via MCP', async () => {
    const resp = await mcpTool(mcpA, 'context.report_decision', {
      repositoryId: REPO_ID,
      capsuleId: CAPSULE_A,
      decision: 'Use PostgreSQL + pgvector for persistent context storage',
      rationale: 'Enables vector search for semantic retrieval at scale',
    });
    expect(resp.error).toBeUndefined();

    const text = mcpText(resp);
    expect(text).toContain('Decision recorded');

    const match = text.match(/\[([^\]]+)\]/);
    expect(match).not.toBeNull();
    decisionAId = match![1]!;

    // Verify in local SQLite
    const decisions = runtimeA.objects.list({ repositoryId: REPO_ID, types: ['DECISION'] });
    expect(decisions).toHaveLength(1);
    expect((decisions[0]!.content as { statement: string }).statement).toContain('PostgreSQL');
  });

  // ── Step 3b ─────────────────────────────────────────────────────────────────
  it('Step 3b: Agent A declares active intent/task via MCP', async () => {
    const resp = await mcpTool(mcpA, 'context.report_intent', {
      repositoryId: REPO_ID,
      capsuleId: CAPSULE_A,
      intent: 'Implement payment processor with idempotency keys',
      targetResources: [RESOURCE],
    });
    expect(resp.error).toBeUndefined();
    expect(mcpText(resp)).toContain('Intent recorded');

    const intents = runtimeA.objects.list({ repositoryId: REPO_ID, types: ['INTENT'] });
    expect(intents).toHaveLength(1);
    expect((intents[0]!.content as { description: string }).description).toContain('payment processor');
  });

  // ── Step 3c ─────────────────────────────────────────────────────────────────
  it('Step 3c: Agent A creates a handoff via MCP', async () => {
    const resp = await mcpTool(mcpA, 'context.handoff', {
      action: 'create',
      repositoryId: REPO_ID,
      capsuleId: CAPSULE_A,
      completed: ['Database schema designed', 'Event model defined'],
      remaining: ['Implement payment processor', 'Add idempotency tests'],
      next_step: 'Implement src/payment/processor.ts with Stripe integration',
      blockers: ['Stripe API key not yet provisioned'],
      placeholders: ['src/payment/processor.ts is a stub'],
      known_issues: ['Integration tests require sandbox credentials'],
      summary: 'Agent A completed schema; Agent B should implement payment processor',
    });
    expect(resp.error).toBeUndefined();
    expect(mcpText(resp)).toContain('Handoff created');

    const handoffs = runtimeA.objects.list({ repositoryId: REPO_ID, types: ['HANDOFF'] });
    expect(handoffs.length).toBeGreaterThan(0);
  });

  // ── Step 3d ─────────────────────────────────────────────────────────────────
  it('Step 3d: Agent A registers a placeholder via MCP', async () => {
    const resp = await mcpTool(mcpA, 'context.report_placeholder', {
      repositoryId: REPO_ID,
      capsuleId: CAPSULE_A,
      resource: RESOURCE,
      description: 'Stub implementation — throws NotImplementedError',
      intendedReplacement: 'Full Stripe payment processor with idempotency keys and webhook validation',
    });
    expect(resp.error).toBeUndefined();
    const text = mcpText(resp);
    expect(text).toContain('Registered ID:');

    const placeholders = runtimeA.objects.list({ repositoryId: REPO_ID, types: ['PLACEHOLDER'] });
    expect(placeholders.length).toBeGreaterThan(0);
  });

  // ── Step 3e ─────────────────────────────────────────────────────────────────
  it('Step 3e: Agent A records a test result context object', () => {
    const testResult = runtimeA.objects.create({
      repositoryId: REPO_ID,
      capsuleId: CAPSULE_A,
      type: 'TEST_RESULT',
      scope: 'capsule',
      status: 'active',
      authority: 'agent_explicit',
      visibility: 'repository',
      resource: 'tests/payment.test.ts',
      provenance: { sourceEventIds: [] },
      content: {
        kind: 'test_result',
        suite: 'payment-processor',
        passed: 0,
        failed: 2,
        skipped: 5,
        status: 'FAIL',
        failureReason: 'PaymentProcessor not implemented',
      },
    });
    expect(testResult.type).toBe('TEST_RESULT');
    expect((testResult.content as { status: string }).status).toBe('FAIL');
  });

  // ── Step 4 ──────────────────────────────────────────────────────────────────
  it('Step 4: Agent A emits a file-modified event → local SQLite + outbox', () => {
    const event = {
      eventId: `evt-agent-a-file-${Date.now()}`,
      protocolVersion: PROTOCOL_VERSION,
      workspaceId: 'ws-e2e',
      repositoryId: REPO_ID,
      userId: 'agent-a',
      deviceId: 'dev-a',
      clientSequence: 1,
      type: EventTypes.FILE_MODIFIED,
      timestamp: Date.now(),
      visibility: EventVisibility.REPOSITORY,
      source: EventSources.IDE,
      payload: { path: RESOURCE, action: 'modified', lines: 42 },
    };
    const result = runtimeA.eventLoop.processEvent(event);
    expect(result.stored).toBe(true);
    expect(result.enqueued).toBe(true);

    // Outbox should have at least 1 pending entry
    const pending = runtimeA.outbox.getPendingEntries(50);
    expect(pending.length).toBeGreaterThan(0);
  });

  // ── Step 5 ──────────────────────────────────────────────────────────────────
  it('Step 5: Agent B joins the same repository with a fresh SQLite (simulated sync)', () => {
    // Agent B runs on a separate SQLite database — different machine/process.
    // In production, the outbox processor syncs events and the server rebuilds
    // context objects for each agent. Here we directly mirror Agent A's context
    // objects into Agent B's DB (as sync would deliver them).
    runtimeB.repositories.create({
      id: REPO_ID,
      workspaceId: 'ws-e2e',
      rootPath: '/projects/test-repo',
      name: 'test-repo',
    });

    const aObjects = runtimeA.objects.list({ repositoryId: REPO_ID });
    for (const obj of aObjects) {
      runtimeB.objects.create(
        {
          repositoryId: obj.repositoryId,
          capsuleId: obj.capsuleId,
          type: obj.type,
          scope: obj.scope,
          status: obj.status,
          authority: obj.authority,
          visibility: obj.visibility,
          resource: obj.resource,
          provenance: obj.provenance,
          content: obj.content,
          validFrom: obj.validFrom,
          validUntil: obj.validUntil,
        },
        obj.id, // preserve IDs so relations resolve correctly
      );
    }
    // Mirror any existing relations from Agent A's objects into Agent B's DB.
    // (At step 5 there are no supersession relations yet — the second decision
    //  is recorded in step 9 — but we mirror transitively via listFrom/listAll.)
    const aObjectIds = aObjects.map((o) => o.id);
    for (const objId of aObjectIds) {
      const rels = runtimeA.relations.listAll(objId);
      for (const rel of rels) {
        try {
          runtimeB.relations.create({
            repositoryId: rel.repositoryId,
            fromId: rel.fromId,
            toId: rel.toId,
            relationType: rel.relationType,
            metadata: rel.metadata,
          });
        } catch { /* ignore duplicate */ }
      }
    }

    // Agent B must see the same objects Agent A created
    const bObjects = runtimeB.objects.list({ repositoryId: REPO_ID });
    expect(bObjects.length).toBe(aObjects.length);
  });

  // ── Step 6 ──────────────────────────────────────────────────────────────────
  it('Step 6: Agent B requests compiled context via MCP context.current', async () => {
    const resp = await mcpTool(mcpB, 'context.current', {
      repositoryId: REPO_ID,
      task: 'Implement payment processor',
      resource: RESOURCE,
      tokenBudget: 4000,
    });
    expect(resp.error).toBeUndefined();
    const text = mcpText(resp);
    // Compiled context must be non-empty
    expect(text.length).toBeGreaterThan(10);
  });

  // ── Step 7 ──────────────────────────────────────────────────────────────────
  it('Step 7: Agent B receives decision, handoff, placeholder — NOT raw chat history', async () => {
    // 7a: Decision visible to Agent B
    const decResp = await mcpTool(mcpB, 'context.search', {
      repositoryId: REPO_ID,
      query: 'PostgreSQL pgvector storage',
      types: ['DECISION'],
    });
    expect(decResp.error).toBeUndefined();
    const decResult = JSON.parse(mcpText(decResp)) as {
      count: number;
      results: { type: string; content: { statement: string } }[];
    };
    expect(decResult.count).toBeGreaterThan(0);
    expect(decResult.results[0]!.type).toBe('DECISION');
    expect(decResult.results[0]!.content.statement).toContain('PostgreSQL');

    // 7b: Handoff visible to Agent B
    const handoffResp = await mcpTool(mcpB, 'context.handoff', {
      action: 'get',
      repositoryId: REPO_ID,
    });
    expect(handoffResp.error).toBeUndefined();
    const handoffText = mcpText(handoffResp);
    expect(handoffText).not.toContain('No active handoff found');
    expect(handoffText).toContain('payment processor');
    expect(handoffText).toContain('Agent B should implement');

    // 7c: Only structured context types — no raw chat/prompt events
    const allTypes = new Set(runtimeB.objects.list({ repositoryId: REPO_ID }).map((o) => o.type));
    const ALLOWED = new Set([
      'DECISION', 'INTENT', 'HANDOFF', 'PLACEHOLDER', 'TEST_RESULT',
      'TASK', 'CONSTRAINT', 'ERROR', 'QUESTION',
    ]);
    for (const t of allTypes) {
      expect(ALLOWED.has(t)).toBe(true);
    }
  });

  // ── Step 8 ──────────────────────────────────────────────────────────────────
  it('Step 8: repository isolation — Agent B cannot retrieve context from isolated repo', async () => {
    // Agent B's SQLite has zero objects for REPO_B_ID
    const resp = await mcpTool(mcpB, 'context.search', {
      repositoryId: REPO_B_ID,
      query: 'anything',
    });
    expect(resp.error).toBeUndefined();
    const result = JSON.parse(mcpText(resp)) as { count: number };
    expect(result.count).toBe(0);

    // Direct store lookup confirms isolation
    const isolated = runtimeB.objects.list({ repositoryId: REPO_B_ID });
    expect(isolated).toHaveLength(0);
  });

  // ── Step 9 ──────────────────────────────────────────────────────────────────
  it('Step 9: decision supersession A→B — old decision resolves as SUPERSEDED', async () => {
    const resp = await mcpTool(mcpA, 'context.report_decision', {
      repositoryId: REPO_ID,
      capsuleId: CAPSULE_A,
      decision: 'Use PostgreSQL + pgvector + SQLite local-first hybrid storage',
      rationale: 'Local-first SQLite provides offline capability; pgvector handles cloud sync',
      supersedesId: decisionAId,
    });
    expect(resp.error).toBeUndefined();
    const text = mcpText(resp);
    expect(text).toContain('Decision recorded');

    const match = text.match(/\[([^\]]+)\]/);
    expect(match).not.toBeNull();
    decisionBId = match![1]!;

    // Supersession relation must exist: decision B supersedes decision A
    const supersedingRels = runtimeA.relations.listFrom(decisionBId, 'supersedes');
    expect(supersedingRels).toHaveLength(1);
    const sup = supersedingRels[0]!;
    expect(sup.toId).toBe(decisionAId);
    expect(sup.relationType).toBe('supersedes');

    // Resolve validity
    const resolver = new DecisionValidityResolver(runtimeA.relations);
    const decA = runtimeA.objects.getById(decisionAId)!;
    const decB = runtimeA.objects.getById(decisionBId)!;
    expect(decA).toBeDefined();
    expect(decB).toBeDefined();

    const resolvedA = resolver.resolve(decA);
    const resolvedB = resolver.resolve(decB);

    // Old decision is SUPERSEDED; new decision is ACTIVE
    expect(resolvedA.validity).toBe('SUPERSEDED');
    expect(resolvedA.supersededBy).toBe(decisionBId);
    expect(resolvedB.validity).toBe('ACTIVE');
    expect(resolvedB.supersedes).toContain(decisionAId);
  });

  // ── Step 10 ─────────────────────────────────────────────────────────────────
  it('Step 10: offline SQLite outbox drains to live server PostgreSQL', async () => {
    // Reset retry timers so all pending entries are immediately eligible
    runtimeA.outbox.resetPendingRetries();

    const pending = runtimeA.outbox.getPendingEntries(50);
    expect(pending.length).toBeGreaterThan(0);

    let syncedCount = 0;

    for (const item of pending) {
      const stored = runtimeA.events.getById(item.eventId);
      if (!stored) continue;

      const res = await serverPost('/api/v1/events', {
        events: [{
          eventId: stored.eventId,
          protocolVersion: PROTOCOL_VERSION,
          workspaceId: 'ws-e2e',
          repositoryId: stored.repositoryId,
          type: stored.type,
          source: stored.source,
          clientSequence: stored.clientSequence,
          timestamp: stored.timestamp,
          visibility: stored.visibility,
          payload: stored.payload ?? {},
        }],
      });

      if (res.status === 207) {
        const body = (await res.json()) as { results: { status: string }[] };
        const status = body.results[0]?.status;
        if (status === 'stored' || status === 'duplicate') {
          runtimeA.outbox.acknowledge(item.eventId);
          syncedCount++;
        }
      }
    }

    // All pending entries acknowledged
    const afterPending = runtimeA.outbox.getPendingEntries(50);
    expect(afterPending).toHaveLength(0);
    expect(syncedCount).toBeGreaterThan(0);
  });

  // ── Step 11 ─────────────────────────────────────────────────────────────────
  it('Step 11: synced events are queryable from server PostgreSQL and Redis stream', async () => {
    // PostgreSQL: events queryable by repositoryId
    const evRes = await serverGet(`/api/v1/events?repositoryId=${REPO_ID}`);
    expect(evRes.status).toBe(200);
    const evBody = (await evRes.json()) as { events: { eventId: string; type: string }[]; count: number };
    expect(evBody.count).toBeGreaterThan(0);
    const fileModified = evBody.events.find((e) => e.type === EventTypes.FILE_MODIFIED);
    expect(fileModified).toBeDefined();

    // Redis stream: events also pushed to stream on ingest
    const streamRes = await serverGet(`/api/v1/live/${REPO_ID}/stream?since=0`);
    expect(streamRes.status).toBe(200);
    const streamBody = (await streamRes.json()) as {
      events: { event: { type: string } }[];
      count: number;
    };
    expect(streamBody.count).toBeGreaterThan(0);
    const streamFileModified = streamBody.events.find((e) => e.event.type === EventTypes.FILE_MODIFIED);
    expect(streamFileModified).toBeDefined();
  });

  // ── Step 12 ─────────────────────────────────────────────────────────────────
  it('Step 12: conflict — Agent A acquires server lease, Agent B attempt returns 409', async () => {
    // Agent A acquires a lease on the shared resource
    const acquireRes = await serverPost('/api/v1/leases', {
      repositoryId: REPO_ID,
      resource: RESOURCE,
      holderId: 'agent-a',
      holderType: 'agent',
      ttlMs: 60000,
    });
    expect(acquireRes.status).toBe(201);
    const acquireBody = (await acquireRes.json()) as { lease: { id: string } };
    serverLeaseId = acquireBody.lease.id;

    // MCP local lease also acquired by Agent A
    const mcpAcquire = await mcpTool(mcpA, 'context.lease', {
      action: 'acquire',
      repositoryId: REPO_ID,
      resource: RESOURCE,
      holderId: 'agent-a',
      ttlMs: 60000,
    });
    expect(mcpAcquire.error).toBeUndefined();
    expect(mcpText(mcpAcquire)).toContain('Lease acquired');

    // Agent B attempts to acquire the same resource → server returns 409 Conflict
    const conflictRes = await serverPost('/api/v1/leases', {
      repositoryId: REPO_ID,
      resource: RESOURCE,
      holderId: 'agent-b',
      holderType: 'agent',
      ttlMs: 60000,
    });
    expect(conflictRes.status).toBe(409);
  });

  // ── Step 13 ─────────────────────────────────────────────────────────────────
  it('Step 13: conflict surfaced — Agent B detects active lease via server resource query', async () => {
    // Live state endpoint returns 200
    const liveRes = await serverGet(`/api/v1/live/${REPO_ID}/state`);
    expect(liveRes.status).toBe(200);

    // Agent B can inspect the active lease on the resource
    const leaseCheckRes = await serverGet(
      `/api/v1/leases/resource?repositoryId=${REPO_ID}&resource=${encodeURIComponent(RESOURCE)}`,
    );
    expect(leaseCheckRes.status).toBe(200);
    const leaseBody = (await leaseCheckRes.json()) as { lease: { holderId: string } };
    expect(leaseBody.lease.holderId).toBe('agent-a');

    // Agent B also detects conflict via the lease list
    const listRes = await serverGet(`/api/v1/leases?repositoryId=${REPO_ID}`);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { leases: { holderId: string; resource: string }[]; count: number };
    const conflictLease = listBody.leases.find((l) => l.resource === RESOURCE && l.holderId === 'agent-a');
    expect(conflictLease).toBeDefined();

    // Agent A releases the lease
    expect(serverLeaseId).toBeDefined();
    const releaseRes = await fetch(
      `${SERVER_URL}/api/v1/leases/${serverLeaseId}?holderId=agent-a`,
      { method: 'DELETE' },
    );
    expect(releaseRes.status).toBe(204);
    serverLeaseId = undefined; // cleanup handled

    // After release, Agent B can now acquire the resource
    const acquireB = await serverPost('/api/v1/leases', {
      repositoryId: REPO_ID,
      resource: RESOURCE,
      holderId: 'agent-b',
      holderType: 'agent',
      ttlMs: 5000,
    });
    expect(acquireB.status).toBe(201);
    // Release Agent B's lease too
    const acquireBBody = (await acquireB.json()) as { lease: { id: string } };
    await fetch(`${SERVER_URL}/api/v1/leases/${acquireBBody.lease.id}?holderId=agent-b`, { method: 'DELETE' });
  });

  // ── Final ────────────────────────────────────────────────────────────────────
  it('Final: correct object counts in both agents\' local SQLite databases', () => {
    const countsA = runtimeA.objects.countByType(REPO_ID);
    // Agent A: 2 DECISION (original + superseding), ≥1 INTENT, ≥1 HANDOFF, ≥1 PLACEHOLDER, ≥1 TEST_RESULT
    expect(countsA['DECISION'] ?? 0).toBeGreaterThanOrEqual(2);
    expect(countsA['INTENT'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(countsA['HANDOFF'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(countsA['PLACEHOLDER'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(countsA['TEST_RESULT'] ?? 0).toBeGreaterThanOrEqual(1);

    // Agent B: synced objects from Agent A (before the second decision was added)
    const countsB = runtimeB.objects.countByType(REPO_ID);
    expect(countsB['DECISION'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(countsB['HANDOFF'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(countsB['PLACEHOLDER'] ?? 0).toBeGreaterThanOrEqual(1);
  });

});
