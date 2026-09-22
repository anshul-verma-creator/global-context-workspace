import type { ContextEvent } from '@context-workspace/protocol';
import type { LiveStateManager } from './live-state.js';
import { createLogger } from '@context-workspace/shared';

const log = createLogger({ component: 'state-rebuilder' });

export interface MaterializedRepositoryState {
  active_agents: string[];
  active_sessions: string[];
  current_resources: string[];
  current_tasks: { id: string; title: string; status: string; agentId?: string }[];
  conflicts: Array<Record<string, unknown>>;
  presence: Record<string, number>;
}

/**
 * Pure reducer function: reduces an array of durable ContextEvents into
 * materialized repository state.
 */
export function reduceEventsToLiveState(
  events: ContextEvent[],
): MaterializedRepositoryState {
  const activeAgents = new Set<string>();
  const activeSessions = new Set<string>();
  const currentResources = new Set<string>();
  const tasksMap = new Map<string, { id: string; title: string; status: string; agentId?: string }>();
  const conflictsMap = new Map<string, Record<string, unknown>>();
  const presence: Record<string, number> = {};

  // Sort events chronologically to guarantee correct replay order
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);

  for (const ev of sorted) {
    const type = ev.type as string;
    const payload = (ev.payload ?? {}) as Record<string, any>;
    const agentId = ev.agentId ?? payload['agentId'] as string | undefined;
    const sessionId = ev.sessionId ?? payload['sessionId'] as string | undefined;

    // Track presence
    if (agentId !== undefined) {
      presence[agentId] = Math.max(presence[agentId] ?? 0, ev.timestamp);
    }

    switch (type) {
      // Agent lifecycle
      case 'agent:started':
      case 'agent:session:started':
      case 'agent.session.started':
        if (agentId !== undefined) activeAgents.add(agentId);
        if (sessionId !== undefined) activeSessions.add(sessionId);
        break;

      case 'agent:stopped':
      case 'session:closed':
      case 'agent.session.closed':
        if (sessionId !== undefined) activeSessions.delete(sessionId);
        if (agentId !== undefined) {
          // If agent has no other active sessions, deactivate
          activeAgents.delete(agentId);
        }
        break;

      // Tasks
      case 'task:created':
      case 'task:started': {
        const taskId = payload['taskId'] ?? payload['id'] ?? ev.eventId;
        const title = payload['title'] ?? payload['name'] ?? 'Task';
        tasksMap.set(String(taskId), {
          id: String(taskId),
          title: String(title),
          status: 'in_progress',
          ...(agentId !== undefined ? { agentId } : {}),
        });
        break;
      }

      case 'task:completed':
      case 'task:cancelled': {
        const taskId = payload['taskId'] ?? payload['id'] ?? ev.eventId;
        tasksMap.delete(String(taskId));
        break;
      }

      // Resources
      case 'file:change':
      case 'resource:opened':
      case 'lease:acquired': {
        const path = payload['path'] ?? payload['filePath'] ?? payload['resource'];
        if (typeof path === 'string' && path.length > 0) {
          currentResources.add(path);
        }
        break;
      }

      case 'resource:closed':
      case 'lease:released': {
        const path = payload['path'] ?? payload['filePath'] ?? payload['resource'];
        if (typeof path === 'string') {
          currentResources.delete(path);
        }
        break;
      }

      // Conflicts
      case 'conflict:detected': {
        const conflictId = payload['conflictId'] ?? payload['resource'] ?? ev.eventId;
        conflictsMap.set(String(conflictId), { ...payload, detectedAt: ev.timestamp });
        break;
      }

      case 'conflict:resolved': {
        const conflictId = payload['conflictId'] ?? payload['resource'] ?? ev.eventId;
        conflictsMap.delete(String(conflictId));
        break;
      }

      default:
        // Other events may have agentId/sessionId attached
        if (agentId !== undefined && !activeAgents.has(agentId)) {
          activeAgents.add(agentId);
        }
        if (sessionId !== undefined && !activeSessions.has(sessionId)) {
          activeSessions.add(sessionId);
        }
        break;
    }
  }

  return {
    active_agents: Array.from(activeAgents),
    active_sessions: Array.from(activeSessions),
    current_resources: Array.from(currentResources),
    current_tasks: Array.from(tasksMap.values()),
    conflicts: Array.from(conflictsMap.values()),
    presence,
  };
}

/**
 * StateRebuilder — Materializes and restores live state from durable events.
 */
export class StateRebuilder {
  constructor(private readonly liveState: LiveStateManager) {}

  /**
   * Rebuild repository live state from durable event log.
   * Clears existing state and materializes state from events.
   */
  async rebuild(repositoryId: string, events: ContextEvent[]): Promise<MaterializedRepositoryState> {
    log.info('Starting live state rebuild', {
      repositoryId,
      eventCount: String(events.length),
    });

    // 1. Clear existing volatile/materialized state
    await this.liveState.clear(repositoryId);

    // 2. Reduce events
    const materialized = reduceEventsToLiveState(events);

    // 3. Populate live state store
    await this.liveState.set(repositoryId, 'active_agents', materialized.active_agents);
    await this.liveState.set(repositoryId, 'active_sessions', materialized.active_sessions);
    await this.liveState.set(repositoryId, 'current_resources', materialized.current_resources);
    await this.liveState.set(repositoryId, 'current_tasks', materialized.current_tasks);
    await this.liveState.set(repositoryId, 'conflicts', materialized.conflicts);
    await this.liveState.set(repositoryId, 'presence', materialized.presence);

    log.info('Live state rebuild completed', {
      repositoryId,
      activeAgents: String(materialized.active_agents.length),
      activeSessions: String(materialized.active_sessions.length),
      currentResources: String(materialized.current_resources.length),
      currentTasks: String(materialized.current_tasks.length),
    });

    return materialized;
  }
}
