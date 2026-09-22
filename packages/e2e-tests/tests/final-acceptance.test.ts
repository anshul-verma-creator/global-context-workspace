import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ContextRuntime } from '@context-workspace/runtime';
import { McpServer } from '@context-workspace/mcp';
import { serializeStenoDocument, parseStenoDocument } from '@context-workspace/steno';
import { DeviceRegistry, TokenManager, AuthorizationEngine } from '@context-workspace/security';
import { globalMetrics, globalTracer } from '@context-workspace/shared';

describe('Phase 30 — Final Acceptance: Complete System Chain Verification', () => {
  let tmpDir: string;
  let runtimeAlpha: ContextRuntime;
  let runtimeBeta: ContextRuntime;

  const WORKSPACE_ID = 'ws_global_acceptance';
  const REPO_ALPHA = 'repo_acc_alpha';
  const REPO_BETA = 'repo_acc_beta';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-final-acc-'));
    runtimeAlpha = new ContextRuntime({ dbPath: path.join(tmpDir, 'runtime-alpha.db') });
    runtimeBeta = new ContextRuntime({ dbPath: path.join(tmpDir, 'runtime-beta.db') });

    await runtimeAlpha.start();
    await runtimeBeta.start();
  });

  afterEach(async () => {
    await runtimeAlpha.stop();
    await runtimeBeta.stop();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('validates the complete Global Context Workspace pipeline end-to-end', async () => {
    // =========================================================================
    // 1. Global Workspace & Isolated Repositories
    // =========================================================================
    const repoA = runtimeAlpha.repositories.create({
      id: REPO_ALPHA,
      workspaceId: WORKSPACE_ID,
      name: 'core-backend',
      rootPath: '/workspaces/core-backend',
    });
    expect(repoA.id).toBe(REPO_ALPHA);

    const repoB = runtimeBeta.repositories.create({
      id: REPO_BETA,
      workspaceId: WORKSPACE_ID,
      name: 'frontend-portal',
      rootPath: '/workspaces/frontend-portal',
    });
    expect(repoB.id).toBe(REPO_BETA);

    // =========================================================================
    // 2. Authentication, RBAC & Repository Isolation
    // =========================================================================
    const deviceRegistry = new DeviceRegistry();
    const tokenManager = new TokenManager('prod-acceptance-hmac-secret-key-32', deviceRegistry);
    const authEngine = new AuthorizationEngine(tokenManager);

    deviceRegistry.registerDevice('dev_agent_a', 'user_alice', 'Alice MacBook Pro');
    deviceRegistry.registerDevice('dev_agent_b', 'user_bob', 'Bob ThinkPad');

    const tokenA = tokenManager.issueToken({
      userId: 'user_alice',
      deviceId: 'dev_agent_a',
      role: 'developer',
      allowedRepositories: [REPO_ALPHA],
    });

    const tokenB = tokenManager.issueToken({
      userId: 'user_bob',
      deviceId: 'dev_agent_b',
      role: 'developer',
      allowedRepositories: [REPO_ALPHA],
    });

    // Agent A cannot access Repo Beta (isolation check)
    const crossRepoCheck = authEngine.authorizeRepositoryAccess(tokenA, REPO_BETA, 'read_context');
    expect(crossRepoCheck.allowed).toBe(false);
    expect(crossRepoCheck.reason).toContain('not authorized for repository');

    // =========================================================================
    // 3. Capsules & Sessions
    // =========================================================================
    const capA = runtimeAlpha.capsules.create({
      repositoryId: REPO_ALPHA,
      name: 'auth-refactor',
    });

    const sessA = runtimeAlpha.sessions.open({
      capsuleId: capA.id,
      userId: 'user_alice',
      deviceId: 'dev_agent_a',
      agentId: 'agent-alice-session-1',
    });
    expect(sessA.isActive).toBe(true);
    const sessionId = sessA.session.id;

    // =========================================================================
    // 4. Local Event Capture & Promotion
    // =========================================================================
    const captureResult = runtimeAlpha.eventLoop.processEvent({
      eventId: 'evt-acceptance-1',
      protocolVersion: 1,
      type: 'tool.executed',
      category: 'agent_activity',
      source: 'agent',
      visibility: 'repository',
      repositoryId: REPO_ALPHA,
      sessionId,
      agentId: 'agent-alice-session-1',
      workspaceId: WORKSPACE_ID,
      clientSequence: 1,
      timestamp: Date.now(),
      payload: {
        tool: 'edit_file',
        output: '+ export function verifyJwt() {}',
      },
    });
    expect(captureResult.stored).toBe(true);

    // Declare Intent & Decision Context Objects
    runtimeAlpha.objects.create({
      repositoryId: REPO_ALPHA,
      capsuleId: capA.id,
      type: 'TASK',
      scope: 'capsule',
      status: 'active',
      authority: 'agent_explicit',
      visibility: 'capsule',
      provenance: { sourceEventIds: [captureResult.eventId], sessionId },
      content: { kind: 'task', title: 'Migrate to RSA-256 JWT tokens', status: 'active' },
    });

    runtimeAlpha.objects.create({
      repositoryId: REPO_ALPHA,
      type: 'DECISION',
      scope: 'repository',
      status: 'active',
      authority: 'human',
      visibility: 'repository',
      provenance: { sourceEventIds: [captureResult.eventId], sessionId },
      content: { kind: 'decision', description: 'Use Ed25519 signing keys instead of HS256', requiresConfirmation: false },
    });

    // Declare Placeholder
    runtimeAlpha.objects.create({
      repositoryId: REPO_ALPHA,
      capsuleId: capA.id,
      type: 'PLACEHOLDER',
      scope: 'capsule',
      status: 'active',
      authority: 'agent_explicit',
      visibility: 'capsule',
      provenance: { sourceEventIds: [captureResult.eventId], sessionId },
      content: {
        kind: 'placeholder',
        resource: 'KEY_VAULT_URL',
        description: 'TODO_KEY_VAULT',
        intendedReplacement: 'HashiCorp Vault production endpoint',
        detectionMethod: 'explicit_marker',
        placeholderStatus: 'active',
      },
    });

    // Declare Structured Handoff
    runtimeAlpha.objects.create({
      repositoryId: REPO_ALPHA,
      capsuleId: capA.id,
      type: 'HANDOFF',
      scope: 'capsule',
      status: 'active',
      authority: 'agent_explicit',
      visibility: 'capsule',
      provenance: { sourceEventIds: [captureResult.eventId], sessionId },
      content: {
        kind: 'handoff',
        summary: 'Agent A completed token signing; awaiting key rotation logic',
        completed: ['Added Ed25519 verification', 'Added unit tests'],
        nextStep: 'Wire into authentication gateway',
      },
    });

    // =========================================================================
    // 5. Layered Retrieval & Minimum-Context Compilation
    // =========================================================================
    const compiled = await runtimeAlpha.context.assemble(
      sessA.session,
      {
        repositoryId: REPO_ALPHA,
        capsuleId: capA.id,
        task: 'Wire authentication gateway',
        resource: 'src/auth/jwt.ts',
      },
      { maxTokens: 1500 },
    );

    expect(compiled.estimatedTokens).toBeLessThanOrEqual(1500);
    expect(compiled.serialized.toLowerCase()).toContain('decision');
    expect(compiled.serialized).toContain('Ed25519');
    expect(compiled.serialized).toContain('KEY_VAULT_URL');

    // =========================================================================
    // 6. Steno Round-Trip Parsing & Validation
    // =========================================================================
    const parseResult = parseStenoDocument(compiled.serialized);
    expect(parseResult.ok).toBe(true);
    expect(parseResult.document?.blocks.length).toBeGreaterThanOrEqual(2);

    const serialized = serializeStenoDocument(parseResult.document!, new Map());
    expect(serialized.toLowerCase()).toContain('decision');
    expect(serialized.toLowerCase()).toContain('placeholder');

    // =========================================================================
    // 7. MCP Server Tools Verification (AI/IDE Integration)
    // =========================================================================
    const mcp = new McpServer(runtimeAlpha);

    // Test context.search
    const searchRes = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 'mcp-req-1',
      method: 'tools/call',
      params: {
        name: 'context.search',
        arguments: { repositoryId: REPO_ALPHA, query: 'Ed25519' },
      },
    });
    expect(searchRes.result.isError).toBeFalsy();
    expect(searchRes.result.content[0]?.text).toContain('Ed25519');

    // Test context.current (Agent Context Assembly via MCP)
    const currentRes = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 'mcp-req-2',
      method: 'tools/call',
      params: {
        name: 'context.current',
        arguments: {
          repositoryId: REPO_ALPHA,
          capsuleId: capA.id,
          tokenBudget: 1200,
        },
      },
    });
    expect(currentRes.result.isError).toBeFalsy();
    expect(currentRes.result.content[0]?.text).toContain('Ed25519');
    expect(currentRes.result.content[0]?.text.toLowerCase()).toContain('handoff');

    // =========================================================================
    // 8. Observability & Telemetry Verification
    // =========================================================================
    globalMetrics.incrementCounter('final_acceptance_operations_total');
    const trace = globalTracer.startTrace('trace_final_acceptance', { sessionId });

    expect(globalMetrics.getSnapshot().counters['final_acceptance_operations_total']).toBe(1);
    expect(trace).toBeDefined();
    expect(globalTracer.getTrace('trace_final_acceptance')?.spans[0]?.stage).toBe('local_capture');
  });
});
