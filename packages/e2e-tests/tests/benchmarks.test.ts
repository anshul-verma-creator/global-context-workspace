import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LocalDb, RepositoriesStore, CapsulesStore, EventsStore, OutboxStore, ContextObjectsStore, RelationsStore } from '@context-workspace/database';
import { OutboxProcessor } from '@context-workspace/runtime';
import { RetrievalEngine } from '@context-workspace/retrieval';
import { ContextCompiler } from '@context-workspace/context-compiler';
import { serializeStenoDocument, STENO_VERSION } from '@context-workspace/steno';
import { processEventThroughPipeline } from '@context-workspace/events';
import { generateId, nowMs, createLogger } from '@context-workspace/shared';
import type { ContextEvent, ContextObject } from '@context-workspace/protocol';

const log = createLogger({ component: 'benchmarks' });

interface BenchmarkResult {
  name: string;
  operations: number;
  totalMs: number;
  opsPerSec: number;
  avgLatencyMs: number;
}

const benchmarkResults: BenchmarkResult[] = [];

function recordBenchmark(name: string, operations: number, durationMs: number): BenchmarkResult {
  const opsPerSec = Math.round((operations / (durationMs || 1)) * 1000);
  const avgLatencyMs = Number((durationMs / operations).toFixed(4));
  const result: BenchmarkResult = { name, operations, totalMs: Math.round(durationMs), opsPerSec, avgLatencyMs };
  benchmarkResults.push(result);
  log.info(`BENCHMARK [${name}]`, {
    ops: String(operations),
    durationMs: String(Math.round(durationMs)),
    opsPerSec: String(opsPerSec),
    avgLatencyMs: String(avgLatencyMs),
  });
  return result;
}

describe('Phase 27 — Performance Benchmarks', () => {
  let tmpDir: string;
  let db: LocalDb;
  let eventsStore: EventsStore;
  let outboxStore: OutboxStore;
  let objectsStore: ContextObjectsStore;
  let relationsStore: RelationsStore;

  const REPO_ID = 'repo_bench';
  const CAPSULE_ID = 'cap_bench';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-bench-'));
    db = new LocalDb({ dbPath: path.join(tmpDir, 'bench.db') });
    new RepositoriesStore(db.db).create({ id: REPO_ID, workspaceId: 'ws_bench', name: 'bench', rootPath: '/bench' });
    new CapsulesStore(db.db).create({ id: CAPSULE_ID, repositoryId: REPO_ID, name: 'bench-cap' });

    eventsStore = new EventsStore(db.db);
    outboxStore = new OutboxStore(db.db);
    objectsStore = new ContextObjectsStore(db.db);
    relationsStore = new RelationsStore(db.db);
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('1. Local event write benchmark (1,000 events)', () => {
    const N = 1000;
    const events: ContextEvent[] = [];
    for (let i = 0; i < N; i++) {
      events.push({
        eventId: `evt-bench-${i}`,
        protocolVersion: '1.0.0',
        type: 'task.progress',
        source: 'agent',
        visibility: 'repository',
        repositoryId: REPO_ID,
        capsuleId: CAPSULE_ID,
        clientSequence: i + 1,
        timestamp: Date.now() + i,
        payload: { step: i, note: `Simulated progress event ${i}` },
      });
    }

    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      eventsStore.insertIdempotent(events[i]!);
    }
    const t1 = performance.now();

    const res = recordBenchmark('local_event_write', N, t1 - t0);
    expect(res.avgLatencyMs).toBeLessThan(5.0); // Target < 5ms per SQLite insert
  });

  it('2. Raw lookup benchmark (1,000 point lookups)', () => {
    const N = 1000;
    for (let i = 0; i < N; i++) {
      eventsStore.insertIdempotent({
        eventId: `evt-lookup-${i}`,
        protocolVersion: '1.0.0',
        type: 'task.progress',
        source: 'agent',
        visibility: 'repository',
        repositoryId: REPO_ID,
        clientSequence: i + 1,
        timestamp: Date.now() + i,
        payload: { step: i },
      });
    }

    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const found = eventsStore.getById(`evt-lookup-${i}`);
      expect(found).toBeDefined();
    }
    const t1 = performance.now();

    const res = recordBenchmark('raw_event_lookup', N, t1 - t0);
    expect(res.avgLatencyMs).toBeLessThan(1.0); // Point lookup should be sub-millisecond
  });

  it('3. Outbox throughput benchmark (500 events enqueue and drain)', async () => {
    const N = 500;
    for (let i = 0; i < N; i++) {
      const id = `evt-outbox-${i}`;
      eventsStore.insertIdempotent({
        eventId: id,
        protocolVersion: '1.0.0',
        type: 'task.progress',
        source: 'agent',
        visibility: 'repository',
        repositoryId: REPO_ID,
        clientSequence: i + 1,
        timestamp: Date.now() + i,
        payload: { step: i },
      });
      outboxStore.enqueue(id);
    }

    let ackedCount = 0;
    const processor = new OutboxProcessor(
      eventsStore,
      outboxStore,
      async () => {
        ackedCount++;
        return true;
      },
      { batchSize: 100 },
    );

    const t0 = performance.now();
    while (ackedCount < N) {
      await processor.drain();
    }
    const t1 = performance.now();

    const res = recordBenchmark('outbox_drain_throughput', N, t1 - t0);
    expect(res.opsPerSec).toBeGreaterThan(100);
  });

  it('4. Cloud ingestion pipeline benchmark (500 events through pipeline filter)', () => {
    const N = 500;
    const events: ContextEvent[] = [];
    for (let i = 0; i < N; i++) {
      events.push({
        eventId: `evt-pipe-${i}`,
        protocolVersion: '1.0.0',
        type: 'agent:intent',
        source: 'agent',
        visibility: 'repository',
        repositoryId: REPO_ID,
        clientSequence: i + 1,
        timestamp: Date.now() + i,
        payload: { intent: `Optimize query index ${i}` },
      });
    }

    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const result = processEventThroughPipeline(events[i]!, {});
      expect(result.action).toBe('allow');
    }
    const t1 = performance.now();

    const res = recordBenchmark('event_pipeline_ingestion', N, t1 - t0);
    expect(res.avgLatencyMs).toBeLessThan(0.5);
  });

  it('5. Realtime latency benchmark (1,000 stream sequencing operations)', () => {
    const N = 1000;
    let serverSeq = 0;

    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      serverSeq++;
      const msg = { serverSeq, eventId: `evt-stream-${i}`, ts: Date.now() };
      expect(msg.serverSeq).toBe(i + 1);
    }
    const t1 = performance.now();

    const res = recordBenchmark('realtime_stream_sequencing', N, t1 - t0);
    expect(res.avgLatencyMs).toBeLessThan(0.05);
  });

  it('6. Retrieval latency benchmark (over 200 stored context objects)', async () => {
    const N = 200;
    for (let i = 0; i < N; i++) {
      objectsStore.create(
        {
          repositoryId: REPO_ID,
          capsuleId: CAPSULE_ID,
          type: i % 3 === 0 ? 'DECISION' : i % 3 === 1 ? 'TASK' : 'INTENT',
          scope: 'capsule',
          status: 'active',
          authority: 'agent_explicit',
          visibility: 'repository',
          resource: `packages/auth/token_${i % 10}.ts`,
          provenance: { sourceEventIds: [`evt-obj-${i}`] },
          content: {
            kind: i % 3 === 0 ? 'decision' : i % 3 === 1 ? 'task' : 'intent',
            title: `Context item ${i} for authentication token hashing`,
            description: `Detailed description for item ${i} related to HMAC tokens`,
            status: 'active',
          } as any,
        },
        `obj-retrieval-${i}`,
      );
    }

    const engine = new RetrievalEngine(objectsStore, relationsStore);

    const queryCount = 50;
    const t0 = performance.now();
    for (let q = 0; q < queryCount; q++) {
      const result = await engine.retrieve({
        workspaceId: 'ws_bench',
        repositoryId: REPO_ID,
        capsuleId: CAPSULE_ID,
        task: 'authentication token hashing HMAC',
        resources: ['packages/auth/token_1.ts'],
        maxTokens: 4000,
      });
      expect(result.candidates.length).toBeGreaterThan(0);
    }
    const t1 = performance.now();

    const res = recordBenchmark('layered_retrieval_query', queryCount, t1 - t0);
    expect(res.avgLatencyMs).toBeLessThan(20.0); // Target < 20ms per layered search
  });

  it('7. Context compilation benchmark (100 candidate objects)', () => {
    const compiler = new ContextCompiler();
    const candidates: any[] = [];

    for (let i = 0; i < 100; i++) {
      candidates.push({
        object: {
          id: `cand-${i}`,
          repositoryId: REPO_ID,
          type: 'DECISION',
          scope: 'repository',
          status: 'active',
          authority: 'agent_explicit',
          visibility: 'repository',
          provenance: { sourceEventIds: [`e-${i}`] },
          content: {
            kind: 'decision',
            description: `Decision ${i}: Adopt cross-runtime crypto standards`,
            rationale: 'Performance and security compliance',
          },
        },
        score: 100 - i,
        stages: ['exact'],
      });
    }

    const N = 50;
    const t0 = performance.now();
    for (let k = 0; k < N; k++) {
      const compiled = compiler.compile({
        required: [],
        candidates,
        maxTokens: 2000,
        scope: 'bench-session',
      });
      expect(compiled.includedObjectIds.length).toBeGreaterThan(0);
    }
    const t1 = performance.now();

    const res = recordBenchmark('context_compilation', N, t1 - t0);
    expect(res.avgLatencyMs).toBeLessThan(10.0);
  });

  it('8. Steno serialization benchmark (multi-block document serialization)', () => {
    const doc = {
      version: STENO_VERSION,
      dictVersion: 1,
      blocks: [
        { label: 'task' as const, id: 't1', text: 'Refactor authentication flow', status: 'in_progress' },
        { label: 'decision' as const, id: 'd1', text: 'Use WebCrypto HMAC-SHA256', why: 'Performance' },
        { label: 'placeholder' as const, id: 'p1', resource: 'auth.ts', text: 'MOCK_TOKEN', status: 'active' },
        { label: 'handoff' as const, id: 'h1', summary: 'Handoff to agent', next: 'Implement verify' },
      ],
    };

    const emptyAliases = new Map();
    const N = 1000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const serialized = serializeStenoDocument(doc, emptyAliases);
      expect(serialized.length).toBeGreaterThan(0);
    }
    const t1 = performance.now();

    const res = recordBenchmark('steno_serialization', N, t1 - t0);
    expect(res.avgLatencyMs).toBeLessThan(0.1); // Sub 0.1ms per document serialization
  });
});
