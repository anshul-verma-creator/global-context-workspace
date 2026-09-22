import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ContextRuntime } from '@context-workspace/runtime';
import { McpServer, MCP_TOOLS } from '../src/mcp-server.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function makeTmpDb(): { runtime: ContextRuntime; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-mcp-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const runtime = new ContextRuntime({ dbPath });
  runtime.start();
  return { runtime, tmpDir };
}

describe('Phase 20 — MCP Server', () => {
  let runtime: ContextRuntime;
  let tmpDir: string;
  let server: McpServer;
  const repoId = 'repo_mcp_1';

  beforeEach(() => {
    ({ runtime, tmpDir } = makeTmpDb());
    runtime.repositories.create({
      workspaceId: 'ws_1',
      rootPath: '/project',
      name: 'test-project',
      id: repoId,
    });
    server = new McpServer(runtime);
  });

  afterEach(() => {
    runtime.stop();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('handles initialize handshake according to MCP specification', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    });

    expect(res.id).toBe(1);
    expect(res.result).toBeDefined();
    expect(res.result.protocolVersion).toBe('2024-11-05');
    expect(res.result.serverInfo.name).toBe('global-context-workspace-mcp');
  });

  it('lists all 10 required context tools via tools/list', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    expect(res.result).toBeDefined();
    const tools = res.result.tools as typeof MCP_TOOLS;
    expect(tools).toHaveLength(10);

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('context.search');
    expect(toolNames).toContain('context.get');
    expect(toolNames).toContain('context.current');
    expect(toolNames).toContain('context.handoff');
    expect(toolNames).toContain('context.report_decision');
    expect(toolNames).toContain('context.report_intent');
    expect(toolNames).toContain('context.report_placeholder');
    expect(toolNames).toContain('context.report_question');
    expect(toolNames).toContain('context.conflicts');
    expect(toolNames).toContain('context.lease');
  });

  it('records decisions and searches them via context.report_decision and context.search', async () => {
    // 1. Report a decision
    const reportRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'context.report_decision',
        arguments: {
          repositoryId: repoId,
          decision: 'Use Fastify over Express for low overhead',
          rationale: 'Fastify provides native TypeScript support and better schema validation',
        },
      },
    });

    expect(reportRes.result.content[0].text).toContain('Decision recorded');

    // 2. Search for the decision
    const searchRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'context.search',
        arguments: {
          repositoryId: repoId,
          query: 'Fastify Express',
        },
      },
    });

    const data = JSON.parse(searchRes.result.content[0].text);
    expect(data.count).toBeGreaterThan(0);
    expect(data.results[0].type).toBe('DECISION');
    expect(data.results[0].content.statement).toContain('Use Fastify over Express');
  });

  it('reports intent before file modifications via context.report_intent', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'context.report_intent',
        arguments: {
          repositoryId: repoId,
          intent: 'Refactoring billing checkout pipeline',
          targetResources: ['src/billing/checkout.ts', 'src/billing/stripe.ts'],
        },
      },
    });

    expect(res.result.content[0].text).toContain('Intent recorded');
  });

  it('reports placeholders with non-authoritative warnings via context.report_placeholder', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'context.report_placeholder',
        arguments: {
          repositoryId: repoId,
          resource: 'src/auth/jwt.ts',
          description: 'Hardcoded JWT test secret',
          intendedReplacement: 'AWS KMS symmetric key signing',
        },
      },
    });

    const output = res.result.content[0].text;
    expect(output).toContain('[NON-AUTHORITATIVE PLACEHOLDER]');
    expect(output).toContain('AWS KMS symmetric key signing');
    expect(output).toContain('Do not treat existing mock/stub values as authoritative');
  });

  it('records open questions via context.report_question', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'context.report_question',
        arguments: {
          repositoryId: repoId,
          question: 'Should we support multi-tenant database schemas?',
          context: 'Requested by enterprise client in security review',
        },
      },
    });

    expect(res.result.content[0].text).toContain('Question recorded');
  });

  it('handles handoffs end-to-end via context.handoff', async () => {
    // 1. Create handoff
    const createRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'context.handoff',
        arguments: {
          action: 'create',
          repositoryId: repoId,
          summary: 'Auth module complete, migrations pending',
          completed: ['Auth routes', 'JWT validation'],
          remaining: ['Run DB migration 10'],
          next_step: 'Apply migration 10 in production',
          blockers: ['Awaiting production credentials'],
        },
      },
    });

    expect(createRes.result.content[0].text).toContain('Handoff created');

    // 2. Retrieve handoff
    const getRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'context.handoff',
        arguments: {
          action: 'get',
          repositoryId: repoId,
        },
      },
    });

    const handoffText = getRes.result.content[0].text;
    expect(handoffText).toContain('=== HANDOFF [');
    expect(handoffText).toContain('SUMMARY: Auth module complete');
    expect(handoffText).toContain('NEXT_STEP: Apply migration 10 in production');
    expect(handoffText).toContain('BLOCKERS: Awaiting production credentials');
  });

  it('acquires leases, detects conflict, and releases via context.lease and context.conflicts', async () => {
    // 1. Agent 1 acquires lease
    const acq1 = await server.handleRequest({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'context.lease',
        arguments: {
          action: 'acquire',
          repositoryId: repoId,
          resource: 'src/routes/payment.ts',
          holderId: 'agent-1',
          ttlMs: 60000,
        },
      },
    });

    expect(acq1.result.content[0].text).toContain('Lease acquired on');

    // 2. Agent 2 attempts to acquire lease on same resource -> CONFLICT
    const acq2 = await server.handleRequest({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'context.lease',
        arguments: {
          action: 'acquire',
          repositoryId: repoId,
          resource: 'src/routes/payment.ts',
          holderId: 'agent-2',
        },
      },
    });

    expect(acq2.result.isError).toBe(true);
    expect(acq2.result.content[0].text).toContain('CONFLICT: Resource');
    expect(acq2.result.content[0].text).toContain("already leased to 'agent-1'");

    // 3. Check conflicts
    const confRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: {
        name: 'context.conflicts',
        arguments: { repositoryId: repoId },
      },
    });

    const confData = JSON.parse(confRes.result.content[0].text);
    expect(confData.activeLeases).toHaveLength(1);
    expect(confData.activeLeases[0].holderId).toBe('agent-1');

    // 4. Agent 1 releases lease
    const rel = await server.handleRequest({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: {
        name: 'context.lease',
        arguments: {
          action: 'release',
          repositoryId: repoId,
          resource: 'src/routes/payment.ts',
          holderId: 'agent-1',
        },
      },
    });

    expect(rel.result.content[0].text).toContain('released by \'agent-1\'');
  });

  it('compiles active context for current task via context.current', async () => {
    // Report a decision first
    await server.handleRequest({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: {
        name: 'context.report_decision',
        arguments: {
          repositoryId: repoId,
          decision: 'Use WAL mode for SQLite',
        },
      },
    });

    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: {
        name: 'context.current',
        arguments: {
          repositoryId: repoId,
          task: 'Database initialization',
          tokenBudget: 1000,
        },
      },
    });

    expect(res.result.content[0].text).toBeDefined();
  });

  it('handles JSON line message transport via handleMessage', async () => {
    const rawReq = JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'ping',
    });

    const rawResp = await server.handleMessage(rawReq);
    expect(rawResp).toBeDefined();

    const parsed = JSON.parse(rawResp!);
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.id).toBe(99);
  });

  it('declares resources capability and lists all MCP resources', async () => {
    const initRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 100,
      method: 'initialize',
    });
    expect(initRes.result.capabilities.resources).toBeDefined();

    const listRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 101,
      method: 'resources/list',
    });
    expect(listRes.result.resources).toHaveLength(4);
    const uris = listRes.result.resources.map((r: any) => r.uri);
    expect(uris).toContain('context://current');
    expect(uris).toContain('context://decisions');
    expect(uris).toContain('context://handoff');
    expect(uris).toContain('context://placeholders');
  });

  it('reads declared MCP resources via resources/read', async () => {
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 102,
      method: 'resources/read',
      params: { uri: 'context://current' },
    });
    expect(res.result.contents[0].uri).toBe('context://current');
    expect(res.result.contents[0].mimeType).toBe('text/markdown');
    expect(res.result.contents[0].text).toBeDefined();
  });

  /**
   * Regression tests for bugs found during real-client verification:
   *  1. context://decisions used objects.listByType() which does not exist
   *     → fixed to objects.list({ repositoryId, types: ['DECISION'] })
   *  2. context://placeholders used placeholders.getActive() which does not exist
   *     → fixed to placeholders.listActive()
   */
  it('regression: context://decisions resource reads without error (bug: listByType did not exist)', async () => {
    // Record a decision so the resource is non-trivial
    await server.handleRequest({
      jsonrpc: '2.0',
      id: 200,
      method: 'tools/call',
      params: {
        name: 'context.report_decision',
        arguments: {
          repositoryId: repoId,
          decision: 'Use PostgreSQL for cloud persistence',
          rationale: 'Scalable and proven',
        },
      },
    });

    // Reading context://decisions must NOT throw (was throwing before fix)
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 201,
      method: 'resources/read',
      params: { uri: 'context://decisions' },
    });

    expect(res.error).toBeUndefined();
    expect(res.result.contents[0].uri).toBe('context://decisions');
    const decisions = JSON.parse(res.result.contents[0].text) as any[];
    expect(Array.isArray(decisions)).toBe(true);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].type).toBe('DECISION');
  });

  it('regression: context://placeholders resource reads without error (bug: getActive did not exist)', async () => {
    // Register a placeholder so the resource is non-trivial
    await server.handleRequest({
      jsonrpc: '2.0',
      id: 210,
      method: 'tools/call',
      params: {
        name: 'context.report_placeholder',
        arguments: {
          repositoryId: repoId,
          resource: 'src/payment/processor.ts',
          description: 'Stub implementation',
          intendedReplacement: 'Full Stripe integration',
        },
      },
    });

    // Reading context://placeholders must NOT throw (was throwing before fix)
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 211,
      method: 'resources/read',
      params: { uri: 'context://placeholders' },
    });

    expect(res.error).toBeUndefined();
    expect(res.result.contents[0].uri).toBe('context://placeholders');
    const phs = JSON.parse(res.result.contents[0].text) as any[];
    expect(Array.isArray(phs)).toBe(true);
    expect(phs).toHaveLength(1);
    expect(phs[0].resource).toBe('src/payment/processor.ts');
    expect(phs[0].authoritative).toBe(false);
  });
});
