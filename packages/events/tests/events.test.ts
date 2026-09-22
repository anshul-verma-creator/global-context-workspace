import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChunkStore } from '../src/chunk-store.js';
import { normalizeEvent, SequenceCounter } from '../src/normalizer.js';
import { normalizeFsEvent } from '../src/adapters/filesystem-adapter.js';
import { normalizeGitEvent } from '../src/adapters/git-adapter.js';
import { normalizeAgentEvent } from '../src/adapters/agent-adapter.js';
import { EventTypes, EventSources, PROTOCOL_VERSION } from '@context-workspace/protocol';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('ChunkStore', () => {
  let tmpDir: string;
  let store: ChunkStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-chunk-test-'));
    store = new ChunkStore({ baseDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('appends and reads a record', () => {
    const payload = Buffer.from('hello world');
    const ref = store.append({
      eventId: '123e4567-e89b-4456-a456-426614174000',
      timestamp: Date.now(),
      payload,
    });

    expect(ref.chunkId).toBeTruthy();
    expect(ref.offset).toBe(0);
    expect(ref.length).toBeGreaterThan(0);

    const record = store.read(ref);
    expect(record.eventId).toBe('123e4567-e89b-4456-a456-426614174000');
    expect(record.payload.toString()).toBe('hello world');
  });

  it('multiple records can be appended and read back', () => {
    const refs: ReturnType<ChunkStore['append']>[] = [];
    for (let i = 0; i < 10; i++) {
      refs.push(
        store.append({
          eventId: `evt-${i.toString().padStart(32, '0')}`.substring(0, 36),
          timestamp: Date.now() + i,
          payload: Buffer.from(`payload-${i}`),
        }),
      );
    }

    for (let i = 0; i < 10; i++) {
      const ref = refs[i];
      if (ref === undefined) continue;
      const record = store.read(ref);
      expect(record.payload.toString()).toBe(`payload-${i}`);
    }
  });

  it('survives restart (read after store reopened)', () => {
    const payload = Buffer.from('durable content');
    const ref = store.append({
      eventId: '123e4567-e89b-4456-a456-426614174000',
      timestamp: 1_700_000_000_000,
      payload,
    });

    // Reopen store (simulates process restart)
    const store2 = new ChunkStore({ baseDir: tmpDir });
    const record = store2.read(ref);
    expect(record.payload.toString()).toBe('durable content');
  });

  it('chunk integrity verification works', () => {
    const ref = store.append({
      eventId: '123e4567-e89b-4456-a456-426614174000',
      timestamp: Date.now(),
      payload: Buffer.from('test'),
    });
    store.closeCurrentChunk();

    const hash = store.computeChunkHash(ref.chunkId);
    expect(store.verifyIntegrity(ref.chunkId, hash)).toBe(true);
    expect(store.verifyIntegrity(ref.chunkId, 'wrong-hash')).toBe(false);
  });

  it('rotates chunks when event count exceeded', () => {
    const smallStore = new ChunkStore({ baseDir: tmpDir, maxChunkEvents: 3 });
    const refs: string[] = [];

    for (let i = 0; i < 7; i++) {
      const ref = smallStore.append({
        eventId: `00000000-0000-4000-8000-${i.toString().padStart(12, '0')}`,
        timestamp: Date.now(),
        payload: Buffer.from(`event-${i}`),
      });
      refs.push(ref.chunkId);
    }

    // Should have rotated to multiple chunks
    const uniqueChunks = new Set(refs);
    expect(uniqueChunks.size).toBeGreaterThan(1);
  });
});

describe('Event normalizer', () => {
  const ctx = {
    workspaceId: 'ws_1',
    repositoryId: 'repo_1',
    userId: 'user_1',
    deviceId: 'device_1',
    getNextSequence: (() => {
      let seq = 0;
      return () => ++seq;
    })(),
  };

  it('normalizes a filesystem event', () => {
    const adapter = normalizeFsEvent({ type: 'modified', path: 'src/index.ts' });
    const event = normalizeEvent(adapter, ctx);

    expect(event.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(event.workspaceId).toBe('ws_1');
    expect(event.type).toBe(EventTypes.FILE_MODIFIED);
    expect(event.source).toBe(EventSources.FILESYSTEM);
    expect(event.clientSequence).toBe(1);
    expect(event.eventId).toBeTruthy();
  });

  it('normalizes a git commit event', () => {
    const adapter = normalizeGitEvent({
      op: 'commit',
      commitSha: 'abc123',
      message: 'feat: add payment retry',
      branch: 'main',
    });
    const event = normalizeEvent(adapter, ctx);

    expect(event.type).toBe(EventTypes.GIT_COMMIT);
    expect(event.source).toBe(EventSources.GIT);
    if (event.payload.kind === 'git') {
      expect(event.payload.commitSha).toBe('abc123');
    }
  });

  it('normalizes an agent intent declaration', () => {
    const adapter = normalizeAgentEvent({
      op: 'intent_declared',
      description: 'Implement queue-based retry',
      resources: ['src/payment/retry.ts'],
    });
    const event = normalizeEvent(adapter, ctx);

    expect(event.type).toBe(EventTypes.INTENT_DECLARED);
    expect(event.source).toBe(EventSources.AGENT);
    if (event.payload.kind === 'intent.declared') {
      expect(event.payload.description).toBe('Implement queue-based retry');
      expect(event.payload.resources).toContain('src/payment/retry.ts');
    }
  });

  it('sequences are monotonically increasing', () => {
    const counter = new SequenceCounter(0);
    const seqs = Array.from({ length: 100 }, () => counter.next());
    for (let i = 0; i < seqs.length - 1; i++) {
      expect(seqs[i]).toBeLessThan(seqs[i + 1]!);
    }
  });

  it('different source types produce correct event types', () => {
    const tests = [
      { input: normalizeFsEvent({ type: 'created', path: 'a.ts' }), expectedType: EventTypes.FILE_CREATED },
      { input: normalizeFsEvent({ type: 'deleted', path: 'b.ts' }), expectedType: EventTypes.FILE_DELETED },
      { input: normalizeGitEvent({ op: 'checkout', branch: 'feat/x' }), expectedType: EventTypes.GIT_CHECKOUT },
      { input: normalizeAgentEvent({ op: 'session_started' }), expectedType: EventTypes.SESSION_STARTED },
      { input: normalizeAgentEvent({ op: 'handoff_created', summary: 'done' }), expectedType: EventTypes.HANDOFF_CREATED },
    ];

    let seq = 0;
    const testCtx = { ...ctx, getNextSequence: () => ++seq };
    for (const test of tests) {
      const event = normalizeEvent(test.input, testCtx);
      expect(event.type).toBe(test.expectedType);
    }
  });
});
