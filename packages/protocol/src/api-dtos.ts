import type { ContextEvent } from './context-event.js';
import type { ContextObject, ContextRelation } from './context-object.js';

/**
 * REST API request/response DTOs.
 * Per spec §9 (Technical Specification): Minimum REST API.
 */

// ─── Event ingestion ───────────────────────────────────────────────────────

export interface PostEventRequest {
  event: ContextEvent;
}

export interface PostEventResponse {
  eventId: string;
  serverSequence: number;
  receivedAt: number;
}

export interface PostEventBatchRequest {
  events: ContextEvent[];
}

export interface PostEventBatchResponse {
  results: Array<{
    eventId: string;
    serverSequence?: number;
    error?: string;
  }>;
}

// ─── Workspace / Repository ────────────────────────────────────────────────

export interface WorkspaceDto {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface RepositoryDto {
  id: string;
  workspaceId: string;
  remoteUrl?: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

// ─── Capsule / Session ─────────────────────────────────────────────────────

export interface CapsuleDto {
  id: string;
  repositoryId: string;
  name: string;
  status: 'active' | 'idle' | 'archived';
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

export interface SessionDto {
  id: string;
  capsuleId: string;
  userId: string;
  deviceId: string;
  agentId?: string;
  nativeSessionId?: string;
  status: 'active' | 'idle' | 'ended';
  startedAt: number;
  endedAt?: number;
}

export interface CreateSessionRequest {
  capsuleId?: string;
  capsuleName?: string;
  repositoryId: string;
  deviceId: string;
  agentId?: string;
  nativeSessionId?: string;
}

export interface CreateSessionResponse {
  session: SessionDto;
  capsule: CapsuleDto;
}

// ─── Context query ─────────────────────────────────────────────────────────

export interface ContextQueryRequest {
  workspaceId: string;
  repositoryId: string;
  capsuleId?: string;
  task?: string;
  resources?: string[];
  maxTokens: number;
  include?: {
    decisions?: boolean;
    constraints?: boolean;
    placeholders?: boolean;
    handoffs?: boolean;
    liveState?: boolean;
    errors?: boolean;
    tasks?: boolean;
    intents?: boolean;
  };
}

export interface ContextObjectRef {
  id: string;
  type: string;
  status: string;
  score: number;
  resource?: string;
}

export interface CompiledContextResponse {
  objects: ContextObjectRef[];
  /** Steno-serialized context string */
  serialized: string;
  estimatedTokens: number;
  /** Number of candidates dropped due to budget */
  omittedCount: number;
  generatedAt: number;
}

// ─── Context objects CRUD ──────────────────────────────────────────────────

export interface CreateContextObjectRequest {
  repositoryId: string;
  capsuleId?: string;
  object: Omit<ContextObject, 'id' | 'createdAt' | 'updatedAt' | 'version'>;
}

export interface UpdateContextObjectRequest {
  status?: string;
  content?: ContextObject['content'];
  validUntil?: number;
}

// ─── Leases ────────────────────────────────────────────────────────────────

export interface LeaseDto {
  id: string;
  repositoryId: string;
  resource: string;
  scope: string;
  ownerId: string;
  reason?: string;
  createdAt: number;
  expiresAt: number;
  lastHeartbeatAt: number;
}

export interface AcquireLeaseRequest {
  repositoryId: string;
  resource: string;
  scope: string;
  reason?: string;
  /** Requested TTL in milliseconds */
  ttlMs?: number;
}

export interface AcquireLeaseResponse {
  lease: LeaseDto;
  /** If a conflict occurred, details are included */
  conflict?: {
    severity: 'low' | 'medium' | 'high' | 'critical';
    existingLease: LeaseDto;
    message: string;
  };
}

// ─── Health ────────────────────────────────────────────────────────────────

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'down';
  version: string;
  uptime: number;
  checks: {
    postgres: 'ok' | 'error';
    redis: 'ok' | 'error';
  };
}

// ─── Repository context objects ────────────────────────────────────────────

export interface ListContextObjectsRequest {
  repositoryId: string;
  capsuleId?: string;
  types?: string[];
  status?: string[];
  resource?: string;
  limit?: number;
  offset?: number;
}

export interface ListContextObjectsResponse {
  objects: ContextObject[];
  total: number;
  limit: number;
  offset: number;
}

export interface ListRelationsRequest {
  repositoryId: string;
  objectId: string;
  direction?: 'from' | 'to' | 'both';
  types?: string[];
}

export interface ListRelationsResponse {
  relations: ContextRelation[];
}
