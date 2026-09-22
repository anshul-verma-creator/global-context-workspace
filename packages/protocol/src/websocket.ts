import type { ContextEvent } from './context-event.js';

/**
 * WebSocket protocol messages.
 * Per spec §10 (Technical Specification).
 *
 * Message flow:
 * Client → Server: CONNECT, AUTH, SUBSCRIBE, EVENT, ACK, PING
 * Server → Client: AUTH_OK, AUTH_ERROR, STATE_UPDATE, CONFLICT, ERROR, PONG, EVENT_ACK
 */

export const WsMessageTypes = {
  // Client → Server
  CONNECT: 'CONNECT',
  AUTH: 'AUTH',
  SUBSCRIBE: 'SUBSCRIBE',
  UNSUBSCRIBE: 'UNSUBSCRIBE',
  EVENT: 'EVENT',
  ACK: 'ACK',
  PING: 'PING',

  // Server → Client
  AUTH_OK: 'AUTH_OK',
  AUTH_ERROR: 'AUTH_ERROR',
  SUBSCRIBED: 'SUBSCRIBED',
  EVENT_ACK: 'EVENT_ACK',
  STATE_UPDATE: 'STATE_UPDATE',
  CONFLICT: 'CONFLICT',
  ERROR: 'ERROR',
  PONG: 'PONG',
  BROADCAST: 'BROADCAST',
} as const;

export type WsMessageType = (typeof WsMessageTypes)[keyof typeof WsMessageTypes];

// ─── Client → Server ───────────────────────────────────────────────────────

export interface WsConnectMessage {
  type: 'CONNECT';
  protocolVersion: number;
  clientId: string;
}

export interface WsAuthMessage {
  type: 'AUTH';
  token: string;
  deviceId: string;
}

export interface WsSubscribeMessage {
  type: 'SUBSCRIBE';
  repositoryId: string;
  capsuleId?: string;
  /** Subscribe to specific resource events */
  resources?: string[];
}

export interface WsUnsubscribeMessage {
  type: 'UNSUBSCRIBE';
  repositoryId: string;
}

export interface WsEventMessage {
  type: 'EVENT';
  event: ContextEvent;
}

/** Client acknowledges receiving a server-pushed event */
export interface WsAckMessage {
  type: 'ACK';
  eventId: string;
}

export interface WsPingMessage {
  type: 'PING';
  timestamp: number;
}

// ─── Server → Client ───────────────────────────────────────────────────────

export interface WsAuthOkMessage {
  type: 'AUTH_OK';
  userId: string;
  workspaceId: string;
  permittedRepositories: string[];
}

export interface WsAuthErrorMessage {
  type: 'AUTH_ERROR';
  message: string;
}

export interface WsSubscribedMessage {
  type: 'SUBSCRIBED';
  repositoryId: string;
}

/** Server acknowledges a client-submitted event */
export interface WsEventAckMessage {
  type: 'EVENT_ACK';
  eventId: string;
  serverSequence: number;
  receivedAt: number;
}

export interface WsStateUpdateMessage {
  type: 'STATE_UPDATE';
  repositoryId: string;
  updateType: 'agent_presence' | 'resource_activity' | 'session_update' | 'context_object';
  data: Record<string, unknown>;
}

export interface WsConflictMessage {
  type: 'CONFLICT';
  repositoryId: string;
  resource: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  conflictingAgentId: string;
  conflictingSessionId?: string;
  message: string;
  leaseId?: string;
}

export interface WsErrorMessage {
  type: 'ERROR';
  code: string;
  message: string;
  eventId?: string;
}

export interface WsPongMessage {
  type: 'PONG';
  timestamp: number;
}

export interface WsBroadcastMessage {
  type: 'BROADCAST';
  repositoryId: string;
  event: ContextEvent;
}

export type WsClientMessage =
  | WsConnectMessage
  | WsAuthMessage
  | WsSubscribeMessage
  | WsUnsubscribeMessage
  | WsEventMessage
  | WsAckMessage
  | WsPingMessage;

export type WsServerMessage =
  | WsAuthOkMessage
  | WsAuthErrorMessage
  | WsSubscribedMessage
  | WsEventAckMessage
  | WsStateUpdateMessage
  | WsConflictMessage
  | WsErrorMessage
  | WsPongMessage
  | WsBroadcastMessage;

export type WsMessage = WsClientMessage | WsServerMessage;
