import type { ContextEvent } from '@context-workspace/protocol';
import { createLogger } from '@context-workspace/shared';

const log = createLogger({ component: 'vscode-extension' });

export interface AgentViewItem {
  agentId: string;
  status: 'active' | 'idle' | 'stopped';
  lastSeen: number;
}

export interface CapsuleViewItem {
  capsuleId: string;
  name: string;
  sessionCount: number;
}

export interface ConflictViewItem {
  resource: string;
  existingHolder: string;
  challenger?: string;
  severity: 'critical' | 'high' | 'low';
  detectedAt: number;
}

export interface HandoffViewItem {
  id: string;
  summary: string;
  nextStep: string;
  createdAt: number;
}

export interface IdeExtensionConfig {
  serverUrl: string;
  repositoryId: string;
  fetchFn?: typeof fetch;
}

/**
 * IdeExtensionController — Manages the IDE extension state and server connection (Phase 22).
 *
 * Implements:
 * - agents (active agents & presence)
 * - capsules (active capsules & sessions)
 * - conflicts (active edit collisions)
 * - handoffs (compact task handoffs)
 * - context (current compiled context)
 * - notifications/status
 */
export class IdeExtensionController {
  private readonly serverUrl: string;
  private readonly repositoryId: string;
  private readonly fetchFn: typeof fetch;

  private _agents: AgentViewItem[] = [];
  private _capsules: CapsuleViewItem[] = [];
  private _conflicts: ConflictViewItem[] = [];
  private _handoffs: HandoffViewItem[] = [];
  private _currentContext = '';
  private _notifications: string[] = [];

  private _listeners: Set<() => void> = new Set();
  private _connected = false;

  constructor(config: IdeExtensionConfig) {
    this.serverUrl = config.serverUrl.replace(/\/$/, '');
    this.repositoryId = config.repositoryId;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
  }

  get isConnected(): boolean {
    return this._connected;
  }

  get agents(): AgentViewItem[] {
    return [...this._agents];
  }

  get capsules(): CapsuleViewItem[] {
    return [...this._capsules];
  }

  get conflicts(): ConflictViewItem[] {
    return [...this._conflicts];
  }

  get handoffs(): HandoffViewItem[] {
    return [...this._handoffs];
  }

  get currentContext(): string {
    return this._currentContext;
  }

  get notifications(): string[] {
    return [...this._notifications];
  }

  onStateChange(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private _notify(): void {
    for (const listener of this._listeners) {
      try {
        listener();
      } catch (err) {
        log.error('Listener notification error', { error: String(err) });
      }
    }
  }

  /**
   * Fetch latest state from the server.
   */
  async refresh(): Promise<void> {
    try {
      const resp = await this.fetchFn(`${this.serverUrl}/api/v1/live/${encodeURIComponent(this.repositoryId)}/state`);
      if (!resp.ok) {
        throw new Error(`Server returned HTTP ${resp.status}`);
      }

      const data = (await resp.json()) as { state: Record<string, any> };
      const state = data.state;

      // Update agents
      const activeAgentIds = (state['active_agents'] as string[]) ?? [];
      const presence = (state['presence'] as Record<string, number>) ?? {};
      this._agents = activeAgentIds.map((id) => ({
        agentId: id,
        status: 'active',
        lastSeen: presence[id] ?? Date.now(),
      }));

      // Update conflicts
      const rawConflicts = (state['conflicts'] as any[]) ?? [];
      this._conflicts = rawConflicts.map((c) => ({
        resource: c.resource ?? 'unknown',
        existingHolder: c.existingHolder?.holderId ?? c.holderId ?? 'unknown',
        challenger: c.challenger?.holderId,
        severity: c.severity ?? 'high',
        detectedAt: c.detectedAt ?? Date.now(),
      }));

      this._connected = true;
      this._notify();
    } catch (err) {
      this._connected = false;
      log.warn('Failed to refresh live state', { error: String(err) });
    }
  }

  /**
   * Handle an incoming real-time event (from stream poll or WebSocket).
   */
  handleStreamEvent(event: ContextEvent): void {
    const type = event.type as string;
    const payload = (event.payload ?? {}) as Record<string, any>;
    const agentId = event.agentId ?? payload['agentId'];

    if (agentId && !this._agents.some((a) => a.agentId === agentId)) {
      this._agents.push({
        agentId,
        status: 'active',
        lastSeen: event.timestamp,
      });
    }

    if (type === 'conflict:detected') {
      const resource = payload['resource'] ?? 'unknown';
      this._conflicts.push({
        resource,
        existingHolder: payload['existingHolder'] ?? 'unknown',
        challenger: payload['challenger'],
        severity: payload['severity'] ?? 'high',
        detectedAt: event.timestamp,
      });
      this._notifications.push(`⚠️ Conflict detected on ${resource}`);
    }

    if (type === 'conflict:resolved') {
      const resource = payload['resource'];
      this._conflicts = this._conflicts.filter((c) => c.resource !== resource);
      this._notifications.push(`✅ Conflict resolved on ${resource}`);
    }

    if (type === 'handoff:created' || payload['kind'] === 'handoff.created' || payload['kind'] === 'handoff') {
      this._handoffs.unshift({
        id: event.eventId,
        summary: payload['summary'] ?? 'Session handoff',
        nextStep: payload['nextStep'] ?? payload['next_step'] ?? 'Next step',
        createdAt: event.timestamp,
      });
      this._notifications.push(`📋 New handoff available: ${payload['summary'] ?? ''}`);
    }

    this._notify();
  }

  setCurrentContext(context: string): void {
    this._currentContext = context;
    this._notify();
  }
}
