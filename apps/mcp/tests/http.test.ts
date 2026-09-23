import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ContextRuntime } from '@context-workspace/runtime';
import { buildHttpServer, type BuiltHttpServer } from '../src/http.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function makeTmpDb(): { runtime: ContextRuntime; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-mcp-http-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const runtime = new ContextRuntime({ dbPath });
  runtime.start();
  return { runtime, tmpDir };
}

describe('MCP HTTP Transport (apps/mcp/src/http.ts)', () => {
  let runtime: ContextRuntime;
  let tmpDir: string;
  let server: BuiltHttpServer;
  const repoId = 'repo-http-test';

  beforeEach(async () => {
    ({ runtime, tmpDir } = makeTmpDb());
    runtime.repositories.create({
      workspaceId: 'ws_http_1',
      rootPath: '/project',
      name: 'test-http-project',
      id: repoId,
    });
    server = await buildHttpServer({ runtime, corsOrigin: '*' });
  });

  afterEach(async () => {
    await server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. GET /health returns 200 OK with status: ok', async () => {
    const res = await server.fastify.inject({
      method: 'GET',
      url: '/health',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeTypeOf('number');
  });

  it('2. GET /ready returns 200 OK when runtime is initialized', async () => {
    const res = await server.fastify.inject({
      method: 'GET',
      url: '/ready',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.runtime).toBe('initialized');
  });

  it('3. GET /mcp returns server discovery metadata', async () => {
    const res = await server.fastify.inject({
      method: 'GET',
      url: '/mcp',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('global-context-workspace-mcp');
    expect(body.protocolVersion).toBe('2024-11-05');
    expect(body.endpoint).toBe('/mcp');
  });

  it('4. POST /mcp handles initialize handshake with JSON-RPC 2.0', async () => {
    const res = await server.fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0' },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe('2024-11-05');
    expect(body.result.serverInfo.name).toBe('global-context-workspace-mcp');
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.capabilities.resources).toBeDefined();
  });

  it('5. POST /mcp handles notifications/initialized returning 204 No Content', async () => {
    const res = await server.fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
  });

  it('6. POST /mcp tools/list returns all 10 context tools', async () => {
    const res = await server.fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(2);
    expect(body.result.tools).toHaveLength(10);
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toContain('context.search');
    expect(names).toContain('context.get');
    expect(names).toContain('context.current');
    expect(names).toContain('context.handoff');
    expect(names).toContain('context.report_decision');
    expect(names).toContain('context.report_intent');
    expect(names).toContain('context.report_placeholder');
    expect(names).toContain('context.report_question');
    expect(names).toContain('context.conflicts');
    expect(names).toContain('context.lease');
  });

  it('7. POST /mcp resources/list returns all 4 resources', async () => {
    const res = await server.fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: {
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/list',
        params: {},
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(3);
    expect(body.result.resources).toHaveLength(4);
    const uris = body.result.resources.map((r: any) => r.uri);
    expect(uris).toContain('context://current');
    expect(uris).toContain('context://decisions');
    expect(uris).toContain('context://handoff');
    expect(uris).toContain('context://placeholders');
  });

  it('8. POST /mcp tools/call records a decision and retrieves via search and current', async () => {
    // A. Record decision
    const reportRes = await server.fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'context.report_decision',
          arguments: {
            repositoryId: repoId,
            decision: 'Deploy HTTP MCP transport to Render',
            rationale: 'Enable remote AI agents to access global context workspace',
          },
        },
      },
    });

    expect(reportRes.statusCode).toBe(200);
    const reportBody = reportRes.json();
    expect(reportBody.id).toBe(10);
    expect(reportBody.result.content[0].text).toContain('Decision recorded');

    // B. Search decision
    const searchRes = await server.fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'context.search',
          arguments: {
            repositoryId: repoId,
            query: 'Render',
          },
        },
      },
    });

    expect(searchRes.statusCode).toBe(200);
    const searchBody = searchRes.json();
    const searchData = JSON.parse(searchBody.result.content[0].text);
    expect(searchData.count).toBe(1);
    expect(searchData.results[0].content.statement).toBe('Deploy HTTP MCP transport to Render');

    // C. Current context
    const currentRes = await server.fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'context.current',
          arguments: {
            repositoryId: repoId,
          },
        },
      },
    });

    expect(currentRes.statusCode).toBe(200);
    const currentBody = currentRes.json();
    const currentText = currentBody.result.content[0].text;
    expect(currentText).toContain('steno:v1');
    expect(currentText).toContain('Deploy HTTP MCP transport to Render');
  });

  it('9. POST /mcp handles malformed JSON safely with error -32700', async () => {
    const res = await server.fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: 'this is not valid json {{{',
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32700);
    expect(body.error.message).toContain('Parse error');
  });

  it('10. OPTIONS /mcp responds with CORS headers', async () => {
    const res = await server.fastify.inject({
      method: 'OPTIONS',
      url: '/mcp',
      headers: {
        origin: 'https://example.com',
        'access-control-request-method': 'POST',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('11. Optional API Key authentication enforces security when configured', async () => {
    const authServer = await buildHttpServer({
      runtime,
      apiKey: 'secret-mcp-key-12345',
    });

    try {
      // Missing auth header -> 401
      const unauthRes = await authServer.fastify.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'content-type': 'application/json' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      });
      expect(unauthRes.statusCode).toBe(401);

      // Wrong key -> 401
      const wrongRes = await authServer.fastify.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer wrong-key',
        },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      });
      expect(wrongRes.statusCode).toBe(401);

      // Correct Bearer key -> 200
      const okRes = await authServer.fastify.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer secret-mcp-key-12345',
        },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      });
      expect(okRes.statusCode).toBe(200);

      // Correct X-API-Key header -> 200
      const okHeaderRes = await authServer.fastify.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'secret-mcp-key-12345',
        },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      });
      expect(okHeaderRes.statusCode).toBe(200);
    } finally {
      await authServer.close();
    }
  });

  it('12. POST /mcp tools/call manages context.lease and detects conflicts', async () => {
    // A. Agent A acquires lease on src/auth.ts
    const acquireResA = await server.fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: {
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
          name: 'context.lease',
          arguments: {
            action: 'acquire',
            repositoryId: repoId,
            resource: 'src/auth.ts',
            holderId: 'agent-laptop-a',
            ttlMs: 30000,
          },
        },
      },
    });

    expect(acquireResA.statusCode).toBe(200);
    const acquireBodyA = acquireResA.json();
    expect(acquireBodyA.result.content[0].text).toContain("Lease acquired on 'src/auth.ts' by 'agent-laptop-a'");

    // B. Agent B attempts to acquire lease on src/auth.ts -> CONFLICT
    const acquireResB = await server.fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: {
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: 'context.lease',
          arguments: {
            action: 'acquire',
            repositoryId: repoId,
            resource: 'src/auth.ts',
            holderId: 'agent-laptop-b',
            ttlMs: 30000,
          },
        },
      },
    });

    expect(acquireResB.statusCode).toBe(200);
    const acquireBodyB = acquireResB.json();
    expect(acquireBodyB.result.isError).toBe(true);
    expect(acquireBodyB.result.content[0].text).toContain("CONFLICT: Resource 'src/auth.ts' is already leased to 'agent-laptop-a'");

    // C. Check conflicts tool reports the active lease
    const conflictsRes = await server.fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: {
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: {
          name: 'context.conflicts',
          arguments: {
            repositoryId: repoId,
          },
        },
      },
    });

    expect(conflictsRes.statusCode).toBe(200);
    const conflictsData = JSON.parse(conflictsRes.json().result.content[0].text);
    expect(conflictsData.activeLeases).toHaveLength(1);
    expect(conflictsData.activeLeases[0].resource).toBe('src/auth.ts');
    expect(conflictsData.activeLeases[0].holderId).toBe('agent-laptop-a');

    // D. Agent A releases lease
    const releaseRes = await server.fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: {
        jsonrpc: '2.0',
        id: 23,
        method: 'tools/call',
        params: {
          name: 'context.lease',
          arguments: {
            action: 'release',
            repositoryId: repoId,
            resource: 'src/auth.ts',
            holderId: 'agent-laptop-a',
          },
        },
      },
    });

    expect(releaseRes.statusCode).toBe(200);
    expect(releaseRes.json().result.content[0].text).toContain("Lease on 'src/auth.ts' released");

    // E. Agent B can now acquire lease
    const retryResB = await server.fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json' },
      payload: {
        jsonrpc: '2.0',
        id: 24,
        method: 'tools/call',
        params: {
          name: 'context.lease',
          arguments: {
            action: 'acquire',
            repositoryId: repoId,
            resource: 'src/auth.ts',
            holderId: 'agent-laptop-b',
            ttlMs: 30000,
          },
        },
      },
    });

    expect(retryResB.statusCode).toBe(200);
    expect(retryResB.json().result.isError).toBeUndefined();
    expect(retryResB.json().result.content[0].text).toContain("Lease acquired on 'src/auth.ts' by 'agent-laptop-b'");
  });
});
