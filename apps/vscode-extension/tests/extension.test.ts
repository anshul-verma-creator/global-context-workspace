import { describe, it, expect, vi } from 'vitest';
import { IdeExtensionController } from '../src/extension-controller.js';
import type { ContextEvent } from '@context-workspace/protocol';

describe('Phase 22 — IDE Extension', () => {
  const repoId = 'repo_ide_1';

  it('refreshes live agent activity and presence from server state', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        state: {
          active_agents: ['agent-alice', 'agent-bob'],
          presence: {
            'agent-alice': 1700000000,
            'agent-bob': 1700000500,
          },
          conflicts: [],
        },
      }),
    });

    const controller = new IdeExtensionController({
      serverUrl: 'http://localhost:3000',
      repositoryId: repoId,
      fetchFn: mockFetch as any,
    });

    await controller.refresh();

    expect(controller.isConnected).toBe(true);
    expect(controller.agents).toHaveLength(2);
    expect(controller.agents.map((a) => a.agentId)).toEqual(['agent-alice', 'agent-bob']);
    expect(controller.agents[0]?.lastSeen).toBe(1700000000);
  });

  it('developer can see live agent activity and conflicts from real-time events', () => {
    const controller = new IdeExtensionController({
      serverUrl: 'http://localhost:3000',
      repositoryId: repoId,
    });

    const listener = vi.fn();
    controller.onStateChange(listener);

    // 1. Conflict detected event arrives
    const conflictEvent: ContextEvent = {
      eventId: 'evt-conf-1',
      protocolVersion: 1,
      workspaceId: 'ws_1',
      userId: 'u1',
      deviceId: 'd1',
      type: 'conflict:detected' as any,
      source: 'agent' as any,
      visibility: 'repository' as any,
      repositoryId: repoId,
      clientSequence: 1,
      timestamp: 2000,
      payload: {
        resource: 'packages/core/db.ts',
        existingHolder: 'agent-alice',
        challenger: 'agent-bob',
        severity: 'critical',
      },
    };

    controller.handleStreamEvent(conflictEvent);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(controller.conflicts).toHaveLength(1);
    expect(controller.conflicts[0]?.resource).toBe('packages/core/db.ts');
    expect(controller.conflicts[0]?.existingHolder).toBe('agent-alice');
    expect(controller.conflicts[0]?.severity).toBe('critical');
    expect(controller.notifications).toContain('⚠️ Conflict detected on packages/core/db.ts');

    // 2. Conflict resolved event arrives
    const resolveEvent: ContextEvent = {
      eventId: 'evt-conf-2',
      protocolVersion: 1,
      workspaceId: 'ws_1',
      userId: 'u1',
      deviceId: 'd1',
      type: 'conflict:resolved' as any,
      source: 'agent' as any,
      visibility: 'repository' as any,
      repositoryId: repoId,
      clientSequence: 2,
      timestamp: 3000,
      payload: { resource: 'packages/core/db.ts' },
    };

    controller.handleStreamEvent(resolveEvent);

    expect(controller.conflicts).toHaveLength(0);
    expect(controller.notifications).toContain('✅ Conflict resolved on packages/core/db.ts');
  });

  it('receives handoff notifications and updates current context view', () => {
    const controller = new IdeExtensionController({
      serverUrl: 'http://localhost:3000',
      repositoryId: repoId,
    });

    const handoffEvent: ContextEvent = {
      eventId: 'evt-ho-1',
      protocolVersion: 1,
      workspaceId: 'ws_1',
      userId: 'u1',
      deviceId: 'd1',
      type: 'handoff:created' as any,
      source: 'agent' as any,
      visibility: 'repository' as any,
      repositoryId: repoId,
      clientSequence: 1,
      timestamp: 4000,
      payload: {
        kind: 'handoff',
        summary: 'Authentication module completed',
        next_step: 'Add unit tests for refresh token',
      },
    };

    controller.handleStreamEvent(handoffEvent);

    expect(controller.handoffs).toHaveLength(1);
    expect(controller.handoffs[0]?.summary).toBe('Authentication module completed');
    expect(controller.handoffs[0]?.nextStep).toBe('Add unit tests for refresh token');
    expect(controller.notifications).toContain('📋 New handoff available: Authentication module completed');

    // Context update
    controller.setCurrentContext('=== CONTEXT ===\nTASK: Add unit tests');
    expect(controller.currentContext).toBe('=== CONTEXT ===\nTASK: Add unit tests');
  });
});
