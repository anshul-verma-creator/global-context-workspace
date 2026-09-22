#!/usr/bin/env node
/**
 * MCP stdio transport entry-point.
 *
 * STDOUT CONTRACT: only newline-delimited JSON-RPC 2.0 messages are written to stdout.
 * All logs, structured output, and debug information go exclusively to stderr.
 *
 * This is required for compatibility with all MCP clients (Claude Desktop, Cursor,
 * VS Code extensions, Antigravity IDE, etc.) that read MCP messages from stdout.
 */
import readline from 'node:readline';
import { ContextRuntime } from '@context-workspace/runtime';
import { McpServer } from './mcp-server.js';
import path from 'node:path';

async function main() {
  const dbPath = process.env['CONTEXT_DB_PATH'] ?? path.join(process.cwd(), '.context', 'context.db');
  const runtime = new ContextRuntime({ dbPath });
  runtime.start();

  const server = new McpServer(runtime);

  // IMPORTANT: do NOT set `output` on readline — that would cause readline to
  // write prompt characters and echoed input to stdout, corrupting the MCP channel.
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false, // non-interactive; never write prompts to stdout
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return; // ignore blank lines silently — do NOT write anything to stdout

    const response = await server.handleMessage(trimmed);
    if (response !== null) {
      // stdout receives ONLY valid JSON-RPC 2.0 response strings
      process.stdout.write(response + '\n');
    }
  });

  rl.on('close', () => {
    runtime.stop();
    process.exit(0);
  });

  const cleanup = () => {
    runtime.stop();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Uncaught errors → stderr only, never stdout
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[MCP] uncaughtException: ${String(err)}\n`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[MCP] unhandledRejection: ${String(reason)}\n`);
  });
}

// Only run main if executed directly
if (
  process.env['NODE_ENV'] !== 'test' &&
  !process.env['VITEST'] &&
  process.argv[1] &&
  (process.argv[1].replace(/\\/g, '/').endsWith('apps/mcp/src/cli.ts') ||
   process.argv[1].replace(/\\/g, '/').endsWith('apps/mcp/dist/cli.js'))
) {
  main().catch((err) => {
    // Fatal startup error → stderr only
    process.stderr.write(`[MCP] Fatal startup error: ${String(err)}\n`);
    process.exit(1);
  });
}
