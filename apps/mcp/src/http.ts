import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import path from 'node:path';
import fs from 'node:fs';
import { ContextRuntime } from '@context-workspace/runtime';
import { McpServer, type JsonRpcRequest, type JsonRpcResponse } from './mcp-server.js';
import { CloudBackend } from './cloud-backend.js';
import { createLogger } from '@context-workspace/shared';

const log = createLogger({ component: 'mcp-http' });

export interface HttpServerOptions {
  runtime?: ContextRuntime;
  mcpServer?: McpServer;
  cloudBackend?: CloudBackend;
  port?: number;
  host?: string;
  corsOrigin?: string | string[];
  apiKey?: string;
  dbPath?: string;
  databaseUrl?: string;
  redisUrl?: string;
}

export interface BuiltHttpServer {
  fastify: ReturnType<typeof Fastify>;
  runtime: ContextRuntime;
  mcpServer: McpServer;
  cloudBackend?: CloudBackend | undefined;
  close: () => Promise<void>;
}

/**
 * Build the Fastify HTTP server for Model Context Protocol (MCP).
 * Exposes:
 *   GET  /health  - Health check
 *   GET  /ready   - Readiness check
 *   POST /mcp     - MCP JSON-RPC 2.0 endpoint (Streamable HTTP)
 *   GET  /mcp     - MCP endpoint discovery / SSE stream
 */
export async function buildHttpServer(options: HttpServerOptions = {}): Promise<BuiltHttpServer> {
  const dbPath =
    options.dbPath ??
    process.env['CONTEXT_DB_PATH'] ??
    path.join(process.cwd(), '.context', 'context.db');

  // Ensure database directory exists
  try {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  } catch {
    // Ignore if directory already exists
  }

  const runtime = options.runtime ?? new ContextRuntime({ dbPath });
  if (!runtime.isStarted) {
    runtime.start();
  }

  const databaseUrl = options.databaseUrl ?? process.env['DATABASE_URL'];
  const redisUrl = options.redisUrl ?? process.env['REDIS_URL'];

  let cloudBackend = options.cloudBackend;
  if (!cloudBackend && databaseUrl) {
    cloudBackend = new CloudBackend({ databaseUrl, redisUrl });
    await cloudBackend.init();
    await cloudBackend.syncFromCloud(runtime);
  }

  const mcpServer = options.mcpServer ?? new McpServer(runtime, cloudBackend);
  const corsOrigin = options.corsOrigin ?? process.env['CORS_ORIGIN'];
  const expectedApiKey = options.apiKey ?? process.env['MCP_API_KEY'];

  const fastify = Fastify({
    logger: false, // We use structured logger to stderr
    trustProxy: true,
  });

  // Setup CORS
  await fastify.register(fastifyCors, {
    origin: corsOrigin === '*' ? '*' : (corsOrigin ?? true),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'Mcp-Session-Id', 'Accept', 'Origin'],
    exposedHeaders: ['Mcp-Session-Id'],
  });

  // Handle malformed JSON safely
  fastify.setErrorHandler((error: any, _request, reply) => {
    const message = error?.message ? String(error.message) : '';
    if (error?.statusCode === 400 && message.includes('JSON')) {
      return reply.status(400).send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON' },
      });
    }
    log.error('HTTP request error', { error: String(error) });
    return reply.status(error?.statusCode ?? 500).send({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'Internal server error' },
    });
  });

  // Health endpoint
  fastify.get('/health', async (_req, reply) => {
    return reply.status(200).send({ status: 'ok', timestamp: Date.now() });
  });

  // Readiness endpoint
  fastify.get('/ready', async (_req, reply) => {
    if (!runtime.isStarted) {
      return reply.status(503).send({ status: 'not_ready', error: 'Runtime not started' });
    }
    if (cloudBackend) {
      const health = await cloudBackend.checkHealth();
      if (!health.database) {
        return reply.status(503).send({ status: 'not_ready', error: 'Database connection failed' });
      }
    }
    return reply.status(200).send({
      status: 'ready',
      timestamp: Date.now(),
      runtime: 'initialized',
      cloud: Boolean(cloudBackend),
    });
  });

  // Helper to verify API Key if configured
  const checkAuth = (req: any, reply: any): boolean => {
    if (!expectedApiKey) return true; // Public access allowed if no key configured

    const authHeader = req.headers['authorization'] as string | undefined;
    const xApiKey = req.headers['x-api-key'] as string | undefined;

    let providedKey = '';
    if (authHeader && authHeader.startsWith('Bearer ')) {
      providedKey = authHeader.slice(7).trim();
    } else if (xApiKey) {
      providedKey = xApiKey.trim();
    }

    if (providedKey !== expectedApiKey) {
      reply.status(401).send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Unauthorized' },
      });
      return false;
    }
    return true;
  };

  // GET /mcp — Endpoint discovery & SSE fallback
  fastify.get('/mcp', async (req, reply) => {
    if (!checkAuth(req, reply)) return;

    const accept = (req.headers['accept'] ?? '') as string;
    const isSse = accept.includes('text/event-stream') || (req.query as any)?.['transport'] === 'sse';

    if (isSse) {
      // SSE transport handshake
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': corsOrigin === '*' ? '*' : (corsOrigin ?? '*'),
      });
      reply.raw.write('event: endpoint\ndata: /mcp\n\n');
      // Keep alive heartbeat
      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(': heartbeat\n\n');
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);
      req.raw.on('close', () => {
        clearInterval(heartbeat);
      });
      return;
    }

    return reply.status(200).send({
      name: 'global-context-workspace-mcp',
      version: '0.1.0',
      protocolVersion: '2024-11-05',
      transport: 'http',
      endpoint: '/mcp',
      capabilities: {
        tools: {},
        resources: {},
      },
    });
  });

  // POST /mcp — JSON-RPC 2.0 over HTTP
  fastify.post('/mcp', async (req, reply) => {
    if (!checkAuth(req, reply)) return;

    const body = req.body;
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request: expected JSON object or array' },
      });
    }

    // Support JSON-RPC batch requests
    if (Array.isArray(body)) {
      const responses = await Promise.all(
        body.map((r: JsonRpcRequest) => mcpServer.handleRequest(r)),
      );
      const nonNull = responses.filter((r): r is JsonRpcResponse => r !== null);
      if (nonNull.length === 0) {
        return reply.status(204).send();
      }
      return reply.status(200).send(nonNull);
    }

    // Single request
    const response = await mcpServer.handleRequest(body as JsonRpcRequest);
    if (response === null) {
      // Notifications produce no body per JSON-RPC 2.0 §4.1
      return reply.status(204).send();
    }
    return reply.status(200).send(response);
  });

  const close = async (): Promise<void> => {
    await fastify.close();
    if (cloudBackend) {
      await cloudBackend.close();
    }
    runtime.stop();
  };

  return { fastify, runtime, mcpServer, cloudBackend, close };
}

/**
 * Entry point when starting HTTP server directly.
 */
export async function main(): Promise<void> {
  const port = parseInt(process.env['PORT'] ?? '3000', 10);
  const host = process.env['HOST'] ?? '0.0.0.0';

  const { fastify } = await buildHttpServer();

  await fastify.listen({ port, host });

  process.stderr.write(`[MCP] HTTP Server listening on http://${host}:${port}/mcp\n`);
  process.stderr.write(`[MCP] Health check: http://${host}:${port}/health\n`);
  process.stderr.write(`[MCP] Readiness: http://${host}:${port}/ready\n`);

  const shutdown = async (): Promise<void> => {
    process.stderr.write('[MCP] Shutting down HTTP server...\n');
    await fastify.close();
    process.exit(0);
  };

  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

// Only execute main if executed directly
if (
  process.env['NODE_ENV'] !== 'test' &&
  !process.env['VITEST'] &&
  process.argv[1] &&
  (process.argv[1].replace(/\\/g, '/').endsWith('apps/mcp/src/http.ts') ||
   process.argv[1].replace(/\\/g, '/').endsWith('apps/mcp/dist/http.js'))
) {
  main().catch((err) => {
    process.stderr.write(`[MCP] Fatal server error: ${String(err)}\n`);
    process.exit(1);
  });
}
