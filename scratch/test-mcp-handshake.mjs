import { spawn } from 'node:child_process';

const p = spawn('node', ['apps/mcp/dist/cli.js'], {
  cwd: 'e:/VSCode prj/global context workspace/context-workspace',
  stdio: ['pipe', 'pipe', 'inherit'],
});

const lines = [];
p.stdout.on('data', (d) => {
  const str = d.toString();
  for (const line of str.split('\n')) {
    if (line.trim()) lines.push(line.trim());
  }
});

function send(obj) {
  p.stdin.write(JSON.stringify(obj) + '\n');
}

// 1. initialize
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'antigravity-test', version: '1.0' },
  },
});

setTimeout(() => {
  // 2. notifications/initialized (notification - no response expected)
  send({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  });
}, 50);

setTimeout(() => {
  // 3. tools/list (with empty params)
  send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });
}, 100);

setTimeout(() => {
  // 4. resources/list (with empty params)
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'resources/list',
    params: {},
  });
}, 150);

setTimeout(() => {
  // 5. tools/call - report a decision
  send({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'context.report_decision',
      arguments: {
        repositoryId: 'repo-e2e-test',
        decision: 'Use SQLite WAL mode and strict MCP JSON-RPC 2.0',
        rationale: 'High concurrency and standard client compatibility',
      },
    },
  });
}, 200);

setTimeout(() => {
  // 6. tools/call - search context
  send({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'context.search',
      arguments: {
        repositoryId: 'repo-e2e-test',
        query: 'WAL',
      },
    },
  });
}, 250);

setTimeout(() => {
  // 7. resources/read - read decisions resource
  send({
    jsonrpc: '2.0',
    id: 6,
    method: 'resources/read',
    params: {
      uri: 'context://decisions',
    },
  });
}, 300);

setTimeout(() => {
  p.stdin.end();
  p.kill();

  console.log(`\n=== RECEIVED ${lines.length} RESPONSES ===`);
  let allValid = true;
  lines.forEach((l, idx) => {
    try {
      const parsed = JSON.parse(l);
      console.log(`[Message ${idx + 1}] ID=${parsed.id} jsonrpc=${parsed.jsonrpc} error=${Boolean(parsed.error)}`);
      if (parsed.error) console.log('  Error detail:', parsed.error);
      if (parsed.result?.content) console.log('  Content:', parsed.result.content[0]?.text?.slice(0, 80));
    } catch (e) {
      console.error(`Invalid JSON line: ${l}`);
      allValid = false;
    }
  });

  if (allValid && lines.length === 6) {
    console.log('\n>>> ALL 6 MCP REQUEST/RESPONSES MATCHED AND VALID! <<<');
  } else {
    console.error(`\n>>> MISMATCH: expected 6 responses, got ${lines.length} <<<`);
    process.exit(1);
  }
}, 600);
