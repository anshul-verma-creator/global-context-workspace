import { generateId, nowMs, ValidationError } from '@context-workspace/shared';
import type { ContextEvent } from '@context-workspace/protocol';
import { PROTOCOL_VERSION, EventVisibility } from '@context-workspace/protocol';
import { assertValidEvent } from '@context-workspace/protocol';

/**
 * Context for normalizing events.
 * Provides the common fields all events need.
 */
export interface NormalizationContext {
  workspaceId: string;
  repositoryId: string;
  userId: string;
  deviceId: string;
  capsuleId?: string;
  sessionId?: string;
  agentId?: string;
  /** Monotonic sequence counter per session */
  getNextSequence: () => number;
}

/**
 * Partial event from an adapter — only source-specific fields.
 * The normalizer fills in all required common fields.
 */
export type AdapterEvent = Omit<
  ContextEvent,
  | 'eventId'
  | 'protocolVersion'
  | 'workspaceId'
  | 'repositoryId'
  | 'userId'
  | 'deviceId'
  | 'clientSequence'
  | 'timestamp'
> & {
  /** Optional override for timestamp (defaults to nowMs()) */
  timestamp?: number;
  /** Optional override for eventId (defaults to generateId()) */
  eventId?: string;
};

/**
 * Normalize an adapter event into a canonical ContextEvent.
 *
 * Every event type goes through this normalizer so all events
 * have the same required structure regardless of source.
 */
export function normalizeEvent(
  partial: AdapterEvent,
  ctx: NormalizationContext,
): ContextEvent {
  const capsuleId = partial.capsuleId ?? ctx.capsuleId;
  const sessionId = partial.sessionId ?? ctx.sessionId;
  const agentId = partial.agentId ?? ctx.agentId;

  const event: ContextEvent = {
    eventId: partial.eventId ?? generateId(),
    protocolVersion: PROTOCOL_VERSION,
    workspaceId: ctx.workspaceId,
    repositoryId: ctx.repositoryId,
    userId: ctx.userId,
    deviceId: ctx.deviceId,
    ...(capsuleId !== undefined ? { capsuleId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    clientSequence: ctx.getNextSequence(),
    timestamp: partial.timestamp ?? nowMs(),
    type: partial.type,
    visibility: partial.visibility ?? EventVisibility.REPOSITORY,
    source: partial.source,
    payload: partial.payload,
  };

  // Validate the normalized event
  assertValidEvent(event);

  return event;
}


/**
 * Sequence counter for a session.
 * Thread-safe (Node.js is single-threaded) counter.
 */
export class SequenceCounter {
  private counter: number;

  constructor(initialValue: number = 0) {
    this.counter = initialValue;
  }

  next(): number {
    return ++this.counter;
  }

  current(): number {
    return this.counter;
  }
}
