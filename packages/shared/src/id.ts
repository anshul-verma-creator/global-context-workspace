import { randomUUID } from 'node:crypto';

/**
 * Generate a UUID v4 string.
 * All IDs in this system are UUIDs unless specified otherwise.
 */
export function generateId(): string {
  return randomUUID();
}

/**
 * Generate a prefixed ID for easier debugging.
 * e.g. prefixedId('evt') → 'evt_<uuid>'
 */
export function prefixedId(prefix: string): string {
  return `${prefix}_${generateId()}`;
}

/**
 * Type-safe branded ID types for preventing accidental cross-domain ID usage.
 */
export type WorkspaceId = string & { readonly __brand: 'WorkspaceId' };
export type RepositoryId = string & { readonly __brand: 'RepositoryId' };
export type CapsuleId = string & { readonly __brand: 'CapsuleId' };
export type SessionId = string & { readonly __brand: 'SessionId' };
export type EventId = string & { readonly __brand: 'EventId' };
export type UserId = string & { readonly __brand: 'UserId' };
export type DeviceId = string & { readonly __brand: 'DeviceId' };
export type AgentId = string & { readonly __brand: 'AgentId' };
export type ContextObjectId = string & { readonly __brand: 'ContextObjectId' };
export type RelationId = string & { readonly __brand: 'RelationId' };
export type LeaseId = string & { readonly __brand: 'LeaseId' };
export type ChunkId = string & { readonly __brand: 'ChunkId' };

export function asWorkspaceId(id: string): WorkspaceId {
  return id as WorkspaceId;
}

export function asRepositoryId(id: string): RepositoryId {
  return id as RepositoryId;
}

export function asCapsuleId(id: string): CapsuleId {
  return id as CapsuleId;
}

export function asSessionId(id: string): SessionId {
  return id as SessionId;
}

export function asEventId(id: string): EventId {
  return id as EventId;
}

export function asUserId(id: string): UserId {
  return id as UserId;
}

export function asDeviceId(id: string): DeviceId {
  return id as DeviceId;
}

export function asAgentId(id: string): AgentId {
  return id as AgentId;
}

export function asContextObjectId(id: string): ContextObjectId {
  return id as ContextObjectId;
}

export function asLeaseId(id: string): LeaseId {
  return id as LeaseId;
}

export function asChunkId(id: string): ChunkId {
  return id as ChunkId;
}
