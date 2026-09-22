import { describe, it, expect } from 'vitest';
import { serializeStenoDocument } from '../src/serializer.js';
import { parseStenoDocument } from '../src/parser.js';
import { STENO_VERSION } from '../src/grammar.js';
import type { StenoDocument } from '../src/grammar.js';
import { AliasDictionaryManager } from '../src/alias-dictionary.js';
import { estimateTokens, heuristicEstimator } from '../src/token-estimator.js';

function makeDoc(overrides: Partial<StenoDocument> = {}): StenoDocument {
  return {
    version: STENO_VERSION,
    dictVersion: 1,
    blocks: [],
    ...overrides,
  };
}

describe('Steno serializer + parser round-trip', () => {
  it('round-trips a decision block', () => {
    const doc = makeDoc({
      blocks: [
        {
          label: 'decision',
          id: 'dec-1',
          text: 'Use queue-based retry for payment processing',
          why: 'Prevents duplicate execution on restart',
          resources: ['src/payment/retry.ts'],
        },
      ],
    });

    const serialized = serializeStenoDocument(doc, new Map());
    expect(serialized).toContain('decision');
    expect(serialized).toContain('Use queue-based retry');
    expect(serialized).toContain('Prevents duplicate execution');

    const parsed = parseStenoDocument(serialized);
    expect(parsed.ok).toBe(true);
    expect(parsed.document?.blocks).toHaveLength(1);

    const block = parsed.document?.blocks[0];
    if (block?.label === 'decision') {
      expect(block.text).toContain('Use queue-based retry');
      expect(block.why).toContain('Prevents duplicate execution');
    }
  });

  it('round-trips a handoff block', () => {
    const doc = makeDoc({
      blocks: [
        {
          label: 'handoff',
          summary: 'Queue retry implementation complete',
          done: ['Implemented retry queue', 'Added error handling'],
          remaining: ['Integration test', 'Performance test'],
          next: 'Replace temporary timeout value',
          blockers: ['Waiting for infra team approval'],
        },
      ],
    });

    const serialized = serializeStenoDocument(doc, new Map());
    const parsed = parseStenoDocument(serialized);

    expect(parsed.ok).toBe(true);
    const block = parsed.document?.blocks[0];
    if (block?.label === 'handoff') {
      expect(block.summary).toContain('Queue retry');
      expect(block.done).toContain('Implemented retry queue');
      expect(block.remaining).toContain('Integration test');
      expect(block.next).toBe('Replace temporary timeout value');
    }
  });

  it('round-trips a placeholder block', () => {
    const doc = makeDoc({
      blocks: [
        {
          label: 'placeholder',
          resource: 'src/config.ts',
          text: 'Hardcoded timeout uses temporary value of 5000ms',
          replacement: 'Replace with configurable timeout from environment',
          status: 'active',
        },
      ],
    });

    const serialized = serializeStenoDocument(doc, new Map());
    const parsed = parseStenoDocument(serialized);

    expect(parsed.ok).toBe(true);
    const block = parsed.document?.blocks[0];
    if (block?.label === 'placeholder') {
      expect(block.resource).toBe('src/config.ts');
      expect(block.text).toContain('Hardcoded timeout');
      expect(block.status).toBe('active');
    }
  });

  it('round-trips multiple blocks', () => {
    const doc = makeDoc({
      blocks: [
        { label: 'task', text: 'Implement payment retry system', status: 'active' },
        { label: 'intent', text: 'Use queue-based approach for durability' },
        { label: 'decision', text: 'Use Redis-backed job queue', why: 'Existing infrastructure' },
        { label: 'placeholder', resource: 'src/queue.ts', text: 'TODO: replace mock queue implementation' },
        { label: 'question', text: 'Should we use BullMQ or custom queue?', blocking: true },
      ],
    });

    const serialized = serializeStenoDocument(doc, new Map());
    const parsed = parseStenoDocument(serialized);

    expect(parsed.ok).toBe(true);
    expect(parsed.document?.blocks.length).toBeGreaterThanOrEqual(5);
  });

  it('handles empty block list', () => {
    const doc = makeDoc({ blocks: [] });
    const serialized = serializeStenoDocument(doc, new Map());
    const parsed = parseStenoDocument(serialized);
    expect(parsed.ok).toBe(true);
    expect(parsed.document?.blocks).toHaveLength(0);
  });
});

describe('Alias dictionary', () => {
  it('does not alias short strings', () => {
    const mgr = new AliasDictionaryManager('session', 1, 2);
    const result = mgr.recordUsage('short');
    expect(result).toBe('short');
  });

  it('aliases long strings after threshold', () => {
    const mgr = new AliasDictionaryManager('session', 1, 2);
    const longValue = 'src/payment/services/retry-handler.ts';

    mgr.recordUsage(longValue);
    const alias = mgr.recordUsage(longValue);

    expect(alias).toMatch(/^~/);
    expect(alias.length).toBeLessThan(longValue.length);
  });

  it('resolves alias back to canonical value', () => {
    const mgr = new AliasDictionaryManager('session', 1, 2);
    const longValue = 'src/payment/services/retry-handler.ts';

    mgr.recordUsage(longValue);
    const alias = mgr.recordUsage(longValue);
    expect(mgr.resolve(alias)).toBe(longValue);
  });

  it('does not alias the same string twice', () => {
    const mgr = new AliasDictionaryManager('session', 1, 2);
    const value = 'src/payment/services/very-long-path-name.ts';

    mgr.recordUsage(value);
    const alias1 = mgr.recordUsage(value);
    const alias2 = mgr.recordUsage(value);

    expect(alias1).toBe(alias2);
  });
});

describe('Token estimator', () => {
  it('heuristic estimator returns positive counts', () => {
    expect(estimateTokens('hello world')).toBeGreaterThan(0);
  });

  it('longer text estimates more tokens', () => {
    const short = estimateTokens('hello');
    const long = estimateTokens('hello world this is a longer sentence with more content');
    expect(long).toBeGreaterThan(short);
  });

  it('estimates approximately 4 chars per token', () => {
    const text = 'hello world'; // 11 chars → ~3 tokens
    const estimate = heuristicEstimator.estimate(text);
    expect(estimate).toBe(3); // ceil(11/4)
  });
});
