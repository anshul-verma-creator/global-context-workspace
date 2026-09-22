import { describe, it, expect, vi } from 'vitest';
import { UniversalAgentAdapter } from '../src/adapters/agent-adapter.js';

describe('Phase 21 — Agent Adapter Framework', () => {
  it('discovers capabilities accurately without pretending unsupported features exist', () => {
    const adapter = new UniversalAgentAdapter({
      adapterId: 'claude-desktop-adapter',
      adapterName: 'Claude Desktop Integration',
      provider: 'claude',
      capabilities: {
        canDetectSessions: true,
        canInjectContext: true,
        canStreamEvents: false, // E.g., no live streaming on this provider
        canCaptureContent: true,
        models: ['claude-3-5-sonnet-20241022'],
      },
    });

    const caps = adapter.getCapabilities();
    expect(caps.provider).toBe('claude');
    expect(caps.canDetectSessions).toBe(true);
    expect(caps.canInjectContext).toBe(true);
    expect(caps.canStreamEvents).toBe(false);
    expect(caps.canCaptureContent).toBe(true);
    expect(caps.models).toEqual(['claude-3-5-sonnet-20241022']);
  });

  it('discovers active sessions', async () => {
    const adapter = new UniversalAgentAdapter();
    adapter.registerSession({
      nativeSessionId: 'sess_vscode_chat_1',
      capsuleName: 'auth-refactor',
      provider: 'cursor',
      startedAt: Date.now(),
    });

    const sessions = await adapter.detectSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.nativeSessionId).toBe('sess_vscode_chat_1');
    expect(sessions[0]?.capsuleName).toBe('auth-refactor');
  });

  it('captures agent events and normalizes into canonical AdapterEvents', async () => {
    const adapter = new UniversalAgentAdapter();

    // 1. Intent declared
    const intentEvents = await adapter.captureEvent({
      op: 'intent_declared',
      description: 'Refactoring session store to use Redis cluster',
      resources: ['src/session.ts'],
    });

    expect(intentEvents).toHaveLength(1);
    expect(intentEvents[0]?.type).toBe('intent.declared');
    expect((intentEvents[0]?.payload as any).description).toContain('Refactoring session store');

    // 2. Decision declared
    const decisionEvents = await adapter.captureEvent({
      op: 'decision_declared',
      description: 'Adopt SQLite WAL mode',
      rationale: 'Concurrent reads while writing',
    });

    expect(decisionEvents).toHaveLength(1);
    expect(decisionEvents[0]?.type).toBe('decision.declared');

    // 3. Placeholder declared
    const placeholderEvents = await adapter.captureEvent({
      op: 'placeholder_declared',
      resource: 'src/mock-db.ts',
      description: 'Mock DB implementation',
      intendedReplacement: 'PostgreSQL connection pool',
    });

    expect(placeholderEvents).toHaveLength(1);
    expect(placeholderEvents[0]?.type).toBe('placeholder.declared');
  });

  it('injects context into agent side-channel and retrieves it', async () => {
    const adapter = new UniversalAgentAdapter();
    const sessionId = 'sess_123';
    const contextSteno = '=== CONTEXT ===\nTASK: Auth Implementation\nDECISION: Use JWT';

    await adapter.sendContext(sessionId, contextSteno);
    expect(adapter.getContext(sessionId)).toBe(contextSteno);
  });

  it('supports live update streaming to subscribers', async () => {
    const adapter = new UniversalAgentAdapter({ capabilities: { canStreamEvents: true } });
    const sessionId = 'sess_live_1';

    const handler = vi.fn();
    const unsubscribe = await adapter.subscribeLiveUpdates(sessionId, handler);

    await adapter.captureEvent({
      op: 'task_started',
      title: 'Run Integration Tests',
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].type).toBe('task.started');

    unsubscribe();

    // After unsubscribe, no more calls
    await adapter.captureEvent({
      op: 'task_completed',
      title: 'Run Integration Tests',
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
