import { describe, it, expect } from 'vitest';
import { ContextCompiler } from '../src/compiler.js';
import { checkPromotion, DEFAULT_PROMOTION_RULES } from '../src/promotion.js';
import type { ContextObject } from '@context-workspace/protocol';
import { TokenBudgetExceededError } from '@context-workspace/shared';
import { parseStenoDocument } from '@context-workspace/steno';

const baseObj: Omit<ContextObject, 'id' | 'type' | 'content'> = {
  repositoryId: 'repo_1',
  scope: 'repository',
  status: 'active',
  authority: 'agent_explicit',
  visibility: 'repository',
  provenance: { sourceEventIds: [] },
  createdAt: Date.now(),
  updatedAt: Date.now(),
  version: 1,
};

function makeDecision(id: string, description: string): ContextObject {
  return {
    ...baseObj,
    id,
    type: 'DECISION',
    content: {
      kind: 'decision',
      description,
      requiresConfirmation: false,
    },
  };
}

function makeHandoff(id: string): ContextObject {
  return {
    ...baseObj,
    id,
    type: 'HANDOFF',
    content: {
      kind: 'handoff',
      summary: 'Queue retry implementation complete',
      completed: ['Implemented retry queue', 'Added error handling'],
      remaining: ['Integration test'],
      nextStep: 'Replace temporary timeout value',
      contextObjectIds: [],
    },
  };
}

function makePlaceholder(id: string, resource: string): ContextObject {
  return {
    ...baseObj,
    id,
    type: 'PLACEHOLDER',
    resource,
    content: {
      kind: 'placeholder',
      resource,
      description: 'Hardcoded timeout uses temporary value of 5000ms',
      detectionMethod: 'agent_declaration',
      placeholderStatus: 'active',
      intendedReplacement: 'Replace with configurable timeout',
    },
  };
}

describe('ContextCompiler', () => {
  const compiler = new ContextCompiler();

  it('compiles empty input', () => {
    const result = compiler.compile({
      required: [],
      candidates: [],
      maxTokens: 8000,
      scope: 'session_1',
    });
    expect(result.serialized).toContain('steno:v1');
    expect(result.includedObjectIds).toHaveLength(0);
    expect(result.omittedCount).toBe(0);
  });

  it('always includes required objects', () => {
    const required = [makeDecision('dec-1', 'Use queue-based retry')];
    const result = compiler.compile({
      required,
      candidates: [],
      maxTokens: 8000,
      scope: 'session_1',
    });

    expect(result.includedObjectIds).toContain('dec-1');
    expect(result.serialized).toContain('Use queue-based retry');
  });

  it('respects token budget', () => {
    const candidates = Array.from({ length: 50 }, (_, i) =>
      makeDecision(`dec-${i}`, `Decision number ${i} which is a fairly long description to consume tokens`),
    );

    const scoredCandidates = candidates.map((obj, i) => ({
      object: obj,
      score: 10 - i,
      stages: ['exact' as const],
    }));

    const result = compiler.compile({
      required: [],
      candidates: scoredCandidates,
      maxTokens: 200, // Tight budget
      scope: 'session_1',
    });

    expect(result.estimatedTokens).toBeLessThanOrEqual(300); // Some tolerance
    expect(result.omittedCount).toBeGreaterThan(0);
  });

  it('includes decisions and handoffs correctly', () => {
    const result = compiler.compile({
      required: [makeDecision('dec-1', 'Use queue retry'), makeHandoff('handoff-1')],
      candidates: [],
      maxTokens: 8000,
      scope: 'session_1',
    });

    expect(result.serialized).toContain('decision');
    expect(result.serialized).toContain('handoff');
    expect(result.serialized).toContain('Queue retry implementation complete');
  });

  it('includes placeholders with resource info', () => {
    const result = compiler.compile({
      required: [makePlaceholder('ph-1', 'src/config.ts')],
      candidates: [],
      maxTokens: 8000,
      scope: 'session_1',
    });

    expect(result.serialized).toContain('placeholder');
    expect(result.serialized).toContain('src/config.ts');
    expect(result.serialized).toContain('Hardcoded timeout');
  });

  it('serialized output is valid Steno', () => {
    const result = compiler.compile({
      required: [makeDecision('dec-1', 'Use queue-based retry'), makeHandoff('handoff-1')],
      candidates: [],
      maxTokens: 8000,
      scope: 'session_1',
    });

    const parsed = parseStenoDocument(result.serialized);
    expect(parsed.ok).toBe(true);
  });

  it('compileStrict throws when required exceeds budget', () => {
    const required = Array.from({ length: 100 }, (_, i) =>
      makeDecision(`dec-${i}`, `Decision ${i} with lots of text to ensure budget is exceeded`),
    );

    expect(() =>
      compiler.compileStrict({
        required,
        candidates: [],
        maxTokens: 10, // Impossibly small
        scope: 'session_1',
      }),
    ).toThrow(TokenBudgetExceededError);
  });

  it('higher scored candidates are included before lower scored ones', () => {
    const high = makeDecision('high-1', 'High priority decision about payment retry');
    const low = makeDecision('low-1', 'Low priority decision about logging format');

    const result = compiler.compile({
      required: [],
      candidates: [
        { object: low, score: 1, stages: ['exact'] },
        { object: high, score: 10, stages: ['exact'] },
      ],
      maxTokens: 8000,
      scope: 'session_1',
    });

    const highIdx = result.includedObjectIds.indexOf('high-1');
    const lowIdx = result.includedObjectIds.indexOf('low-1');
    if (highIdx >= 0 && lowIdx >= 0) {
      expect(highIdx).toBeLessThan(lowIdx);
    }
  });
});

describe('ContextCompiler - conflicts', () => {
  it('includes critical conflicts', () => {
    const compiler = new ContextCompiler();
    const result = compiler.compile({
      required: [],
      candidates: [],
      maxTokens: 8000,
      scope: 'session_1',
      conflicts: [
        { resource: 'src/payment/processor.ts', severity: 'critical', agentId: 'agent-2', message: 'Concurrent modification detected' },
      ],
    });

    expect(result.serialized).toContain('conflicts');
    expect(result.serialized).toContain('critical');
  });
});

describe('PromotionEngine', () => {
  it('promotes agent_inferred candidate with enough evidence', () => {
    const obj: ContextObject = {
      ...baseObj,
      id: 'obj-1',
      type: 'DECISION',
      authority: 'agent_inferred',
      status: 'candidate',
      content: { kind: 'decision', description: 'test', requiresConfirmation: false },
    };

    const result = checkPromotion(obj, 3, DEFAULT_PROMOTION_RULES);
    expect(result.eligible).toBe(true);
    expect(result.toStatus).toBe('active');
    expect(result.requiresConfirmation).toBe(false);
  });

  it('does not promote with insufficient evidence', () => {
    const obj: ContextObject = {
      ...baseObj,
      id: 'obj-1',
      type: 'DECISION',
      authority: 'agent_inferred',
      status: 'candidate',
      content: { kind: 'decision', description: 'test', requiresConfirmation: false },
    };

    const result = checkPromotion(obj, 1, DEFAULT_PROMOTION_RULES);
    expect(result.eligible).toBe(false);
  });

  it('promotes agent_explicit immediately', () => {
    const obj: ContextObject = {
      ...baseObj,
      id: 'obj-1',
      type: 'INTENT',
      authority: 'agent_explicit',
      status: 'candidate',
      content: { kind: 'intent', description: 'test' },
    };

    const result = checkPromotion(obj, 1, DEFAULT_PROMOTION_RULES);
    expect(result.eligible).toBe(true);
    expect(result.toStatus).toBe('active');
  });
});
