import type { AdapterEvent } from '../normalizer.js';
import { EventTypes, EventSources, EventVisibility } from '@context-workspace/protocol';
import type { AgentCapabilities } from '@context-workspace/protocol';

/**
 * Agent adapter interface — per spec §19 (Technical Specification).
 *
 * The universal adapter interface that all AI provider integrations must implement.
 * Capabilities are discovered at startup and the runtime adapts accordingly.
 */
export interface AgentAdapter {
  /** Unique identifier for this adapter */
  readonly adapterId: string;
  /** Human-readable name */
  readonly adapterName: string;

  initialize(): Promise<void>;
  detectSessions(): Promise<DetectedAgentSession[]>;
  captureEvent(event: unknown): Promise<AdapterEvent[]>;
  getCapabilities(): AgentCapabilities;

  /** Optional — only if provider supports side channel context injection */
  sendContext?(sessionId: string, context: string): Promise<void>;
  /** Optional — only if provider supports live event streaming */
  subscribeLiveUpdates?(
    sessionId: string,
    handler: (event: AdapterEvent) => void,
  ): Promise<() => void>;
}

export interface DetectedAgentSession {
  nativeSessionId: string;
  capsuleName?: string;
  provider: string;
  startedAt: number;
}

/**
 * Generic agent event input — for agents that use the explicit declaration API.
 */
export type AgentEventInput =
  | { op: 'session_started'; capsuleName?: string; nativeSessionId?: string; provider?: string }
  | { op: 'session_ended'; reason?: string }
  | { op: 'prompt'; preview?: string; turnIndex: number }
  | { op: 'response'; preview?: string; turnIndex: number; model?: string }
  | { op: 'tool_started'; toolName: string }
  | { op: 'tool_completed'; toolName: string }
  | { op: 'tool_failed'; toolName: string; errorMessage: string }
  | { op: 'intent_declared'; description: string; resources?: string[] }
  | { op: 'decision_declared'; description: string; rationale?: string; resources?: string[]; requiresConfirmation?: boolean }
  | { op: 'question_declared'; question: string; blocking?: boolean }
  | { op: 'task_started'; title: string; description?: string }
  | { op: 'task_completed'; title: string }
  | { op: 'placeholder_declared'; resource: string; description: string; intendedReplacement?: string }
  | { op: 'handoff_created'; summary: string; completed?: string[]; remaining?: string[]; nextStep?: string; blockers?: string[]; knownIssues?: string[] }
  | { op: 'assumption_declared'; assumption: string; basis?: string };

export function normalizeAgentEvent(input: AgentEventInput): AdapterEvent {
  switch (input.op) {
    case 'session_started':
      return {
        type: EventTypes.SESSION_STARTED,
        source: EventSources.AGENT,
        visibility: EventVisibility.REPOSITORY,
        payload: {
          kind: 'session.started',
          ...(input.capsuleName !== undefined ? { capsuleName: input.capsuleName } : {}),
          ...(input.nativeSessionId !== undefined ? { nativeSessionId: input.nativeSessionId } : {}),
          ...(input.provider !== undefined ? { provider: input.provider } : {}),
        },
      };

    case 'session_ended':
      return {
        type: EventTypes.SESSION_ENDED,
        source: EventSources.AGENT,
        visibility: EventVisibility.REPOSITORY,
        payload: {
          kind: 'session.ended',
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        },
      };

    case 'prompt':
      return {
        type: EventTypes.AGENT_PROMPT_SUBMITTED,
        source: EventSources.AGENT,
        visibility: EventVisibility.LOCAL,
        payload: {
          kind: 'agent.prompt',
          turnIndex: input.turnIndex,
          ...(input.preview !== undefined ? { preview: input.preview } : {}),
        },
      };

    case 'response':
      return {
        type: EventTypes.AGENT_RESPONSE_COMPLETED,
        source: EventSources.AGENT,
        visibility: EventVisibility.LOCAL,
        payload: {
          kind: 'agent.response',
          turnIndex: input.turnIndex,
          ...(input.preview !== undefined ? { preview: input.preview } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
        },
      };

    case 'tool_started':
      return {
        type: EventTypes.AGENT_TOOL_STARTED,
        source: EventSources.AGENT,
        visibility: EventVisibility.LOCAL,
        payload: { kind: 'agent.tool', toolName: input.toolName, status: 'started' },
      };

    case 'tool_completed':
      return {
        type: EventTypes.AGENT_TOOL_COMPLETED,
        source: EventSources.AGENT,
        visibility: EventVisibility.REPOSITORY,
        payload: { kind: 'agent.tool', toolName: input.toolName, status: 'completed' },
      };

    case 'tool_failed':
      return {
        type: EventTypes.AGENT_TOOL_FAILED,
        source: EventSources.AGENT,
        visibility: EventVisibility.REPOSITORY,
        payload: {
          kind: 'agent.tool',
          toolName: input.toolName,
          status: 'failed',
          errorMessage: input.errorMessage,
        },
      };

    case 'intent_declared':
      return {
        type: EventTypes.INTENT_DECLARED,
        source: EventSources.AGENT,
        visibility: EventVisibility.REPOSITORY,
        payload: {
          kind: 'intent.declared',
          description: input.description,
          ...(input.resources !== undefined ? { resources: input.resources } : {}),
        },
      };

    case 'decision_declared':
      return {
        type: EventTypes.DECISION_DECLARED,
        source: EventSources.AGENT,
        visibility: EventVisibility.REPOSITORY,
        payload: {
          kind: 'decision.declared',
          description: input.description,
          requiresConfirmation: input.requiresConfirmation ?? false,
          ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
          ...(input.resources !== undefined ? { resources: input.resources } : {}),
        },
      };

    case 'question_declared':
      return {
        type: EventTypes.QUESTION_DECLARED,
        source: EventSources.AGENT,
        visibility: EventVisibility.REPOSITORY,
        payload: {
          kind: 'question.declared',
          question: input.question,
          blocking: input.blocking ?? false,
        },
      };

    case 'task_started':
      return {
        type: EventTypes.TASK_STARTED,
        source: EventSources.AGENT,
        visibility: EventVisibility.REPOSITORY,
        payload: {
          kind: 'task',
          status: 'started',
          title: input.title,
          ...(input.description !== undefined ? { description: input.description } : {}),
        },
      };

    case 'task_completed':
      return {
        type: EventTypes.TASK_COMPLETED,
        source: EventSources.AGENT,
        visibility: EventVisibility.REPOSITORY,
        payload: { kind: 'task', status: 'completed', title: input.title },
      };

    case 'placeholder_declared':
      return {
        type: EventTypes.PLACEHOLDER_DECLARED,
        source: EventSources.AGENT,
        visibility: EventVisibility.REPOSITORY,
        payload: {
          kind: 'placeholder.declared',
          resource: input.resource,
          description: input.description,
          detectionMethod: 'agent_declaration',
          ...(input.intendedReplacement !== undefined ? { intendedReplacement: input.intendedReplacement } : {}),
        },
      };

    case 'handoff_created':
      return {
        type: EventTypes.HANDOFF_CREATED,
        source: EventSources.AGENT,
        visibility: EventVisibility.REPOSITORY,
        payload: {
          kind: 'handoff.created',
          summary: input.summary,
          ...(input.completed !== undefined ? { completed: input.completed } : {}),
          ...(input.remaining !== undefined ? { remaining: input.remaining } : {}),
          ...(input.nextStep !== undefined ? { nextStep: input.nextStep } : {}),
          ...(input.blockers !== undefined ? { blockers: input.blockers } : {}),
          ...(input.knownIssues !== undefined ? { knownIssues: input.knownIssues } : {}),
        },
      };

    case 'assumption_declared':
      return {
        type: EventTypes.ASSUMPTION_DECLARED,
        source: EventSources.AGENT,
        visibility: EventVisibility.REPOSITORY,
        payload: {
          kind: 'assumption.declared',
          assumption: input.assumption,
          ...(input.basis !== undefined ? { basis: input.basis } : {}),
        },
      };
  }
}

export interface UniversalAgentAdapterOptions {
  adapterId?: string;
  adapterName?: string;
  provider?: string;
  capabilities?: Partial<AgentCapabilities>;
}

/**
 * UniversalAgentAdapter — Concrete implementation of AgentAdapter for Phase 21.
 *
 * Implements:
 * - Capability discovery (getCapabilities)
 * - Session discovery (detectSessions)
 * - Event capture (captureEvent)
 * - Side-channel context injection (sendContext, getContext)
 * - Live update subscriptions (subscribeLiveUpdates)
 */
export class UniversalAgentAdapter implements AgentAdapter {
  readonly adapterId: string;
  readonly adapterName: string;
  private readonly capabilities: AgentCapabilities;
  private sessions: DetectedAgentSession[] = [];
  private readonly contextInjections = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(event: AdapterEvent) => void>>();

  constructor(options: UniversalAgentAdapterOptions = {}) {
    this.adapterId = options.adapterId ?? 'universal-agent-adapter';
    this.adapterName = options.adapterName ?? 'Universal Agent Adapter';
    this.capabilities = {
      provider: options.provider ?? 'universal',
      canDetectSessions: true,
      canInjectContext: true,
      canStreamEvents: true,
      canCaptureContent: true,
      ...options.capabilities,
    };
  }

  async initialize(): Promise<void> {
    // Initialized
  }

  getCapabilities(): AgentCapabilities {
    return { ...this.capabilities };
  }

  registerSession(session: DetectedAgentSession): void {
    this.sessions.push(session);
  }

  async detectSessions(): Promise<DetectedAgentSession[]> {
    return [...this.sessions];
  }

  async captureEvent(event: unknown): Promise<AdapterEvent[]> {
    if (typeof event === 'object' && event !== null && 'op' in event) {
      const normalized = normalizeAgentEvent(event as AgentEventInput);
      for (const set of this.listeners.values()) {
        for (const listener of set) {
          try {
            listener(normalized);
          } catch {
            // Ignore subscriber errors
          }
        }
      }
      return [normalized];
    }
    return [];
  }

  async sendContext(sessionId: string, context: string): Promise<void> {
    if (!this.capabilities.canInjectContext) {
      throw new Error(`Adapter ${this.adapterId} does not support context injection`);
    }
    this.contextInjections.set(sessionId, context);
  }

  getContext(sessionId: string): string | undefined {
    return this.contextInjections.get(sessionId);
  }

  async subscribeLiveUpdates(
    sessionId: string,
    handler: (event: AdapterEvent) => void,
  ): Promise<() => void> {
    if (!this.capabilities.canStreamEvents) {
      throw new Error(`Adapter ${this.adapterId} does not support live event streaming`);
    }
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(handler);

    return () => {
      set?.delete(handler);
      if (set?.size === 0) {
        this.listeners.delete(sessionId);
      }
    };
  }
}
