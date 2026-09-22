import type { EventType, EventVisibility, EventSource } from './event-types.js';
import type { LargeContentRef } from './large-content.js';

/**
 * The canonical event type per spec §3 (Technical Spec) and §6 (Architecture).
 *
 * IMMUTABLE after creation. Never modify a persisted event.
 */
export interface ContextEvent {
  /** Globally unique event ID (UUID v4) */
  eventId: string;

  /** Protocol version for forward compatibility */
  protocolVersion: number;

  /** Global workspace identifier */
  workspaceId: string;

  /** Repository scope — required, enforces isolation */
  repositoryId: string;

  /** Capsule the event belongs to, if applicable */
  capsuleId?: string;

  /** Session within the capsule */
  sessionId?: string;

  /** User who generated this event */
  userId: string;

  /** Device that generated this event */
  deviceId: string;

  /** AI agent identifier, if event originates from an agent */
  agentId?: string;

  /** Monotonically increasing sequence per session/device */
  clientSequence: number;

  /** Assigned by server after receipt — undefined until acknowledged */
  serverSequence?: number;

  /** Unix milliseconds — when the event occurred on the client */
  timestamp: number;

  /** Event classification */
  type: EventType;

  /** Controls cloud transmission scope */
  visibility: EventVisibility;

  /** Origin of the event */
  source: EventSource;

  /**
   * Event-specific payload.
   * Small payloads embed directly. Large content uses LargeContentRef.
   */
  payload: EventPayload;
}

/**
 * Union payload type.
 * Each event type has a specific payload shape for type safety.
 * The payload field uses a discriminated union keyed on `type`.
 *
 * Design decision: We use a shared EventPayload type rather than per-type
 * generics to keep the wire format simple and validation straightforward.
 * Type-specific payloads are accessed via the event type discriminant.
 */
export type EventPayload =
  | SessionStartedPayload
  | SessionIdlePayload
  | SessionResumedPayload
  | SessionEndedPayload
  | AgentPromptPayload
  | AgentResponsePayload
  | AgentToolPayload
  | FilePayload
  | CommandPayload
  | TestPayload
  | GitPayload
  | IntentDeclaredPayload
  | DecisionDeclaredPayload
  | QuestionDeclaredPayload
  | TaskPayload
  | PlaceholderDeclaredPayload
  | HandoffCreatedPayload
  | AssumptionDeclaredPayload
  | LeasePayload
  | GenericPayload;

export interface SessionStartedPayload {
  kind: 'session.started';
  capsuleName?: string;
  nativeSessionId?: string;
  provider?: string;
}

export interface SessionIdlePayload {
  kind: 'session.idle';
  idleSince: number;
}

export interface SessionResumedPayload {
  kind: 'session.resumed';
  idleDurationMs: number;
}

export interface SessionEndedPayload {
  kind: 'session.ended';
  reason?: string;
}

export interface AgentPromptPayload {
  kind: 'agent.prompt';
  /** Short preview — full content stored in raw chunk */
  preview?: string;
  rawRef?: LargeContentRef;
  turnIndex: number;
}

export interface AgentResponsePayload {
  kind: 'agent.response';
  preview?: string;
  rawRef?: LargeContentRef;
  turnIndex: number;
  model?: string;
}

export interface AgentToolPayload {
  kind: 'agent.tool';
  toolName: string;
  status: 'started' | 'completed' | 'failed';
  errorMessage?: string;
  rawRef?: LargeContentRef;
}

export interface FilePayload {
  kind: 'file';
  path: string;
  operation: 'read' | 'created' | 'modified' | 'deleted';
  /** For small diffs, embed. For large, use rawRef. */
  diffPreview?: string;
  rawRef?: LargeContentRef;
}

export interface CommandPayload {
  kind: 'command';
  command: string;
  status: 'started' | 'completed' | 'failed';
  exitCode?: number;
  preview?: string;
  rawRef?: LargeContentRef;
}

export interface TestPayload {
  kind: 'test';
  testFile?: string;
  testName?: string;
  status: 'started' | 'passed' | 'failed';
  duration?: number;
  errorMessage?: string;
}

export interface GitPayload {
  kind: 'git';
  operation: 'branch_changed' | 'checkout' | 'commit' | 'merge' | 'rebase';
  branch?: string;
  commitSha?: string;
  message?: string;
  fromBranch?: string;
  toBranch?: string;
}

export interface IntentDeclaredPayload {
  kind: 'intent.declared';
  description: string;
  resources?: string[];
  confidence?: number;
}

export interface DecisionDeclaredPayload {
  kind: 'decision.declared';
  description: string;
  rationale?: string;
  alternatives?: string[];
  resources?: string[];
  requiresConfirmation?: boolean;
}

export interface QuestionDeclaredPayload {
  kind: 'question.declared';
  question: string;
  context?: string;
  blocking?: boolean;
}

export interface TaskPayload {
  kind: 'task';
  status: 'started' | 'completed';
  title: string;
  description?: string;
}

export interface PlaceholderDeclaredPayload {
  kind: 'placeholder.declared';
  resource: string;
  description: string;
  intendedReplacement?: string;
  detectionMethod: 'explicit_marker' | 'static_analysis' | 'agent_declaration';
  markers?: string[];
}

export interface HandoffCreatedPayload {
  kind: 'handoff.created';
  summary: string;
  completed?: string[];
  remaining?: string[];
  nextStep?: string;
  blockers?: string[];
  placeholderIds?: string[];
  knownIssues?: string[];
  contextObjectIds?: string[];
}

export interface AssumptionDeclaredPayload {
  kind: 'assumption.declared';
  assumption: string;
  basis?: string;
  confidence?: number;
}

export interface LeasePayload {
  kind: 'lease';
  leaseId: string;
  resource: string;
  scope: string;
  operation: 'acquired' | 'released' | 'expired' | 'conflict';
  conflictingOwnerId?: string;
}

/** Escape hatch for future event types or unknown sources */
export interface GenericPayload {
  kind: 'generic';
  data: Record<string, unknown>;
}
