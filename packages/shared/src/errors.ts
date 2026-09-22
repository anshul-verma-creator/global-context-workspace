/**
 * Domain error hierarchy for the Global Context Workspace.
 * All errors are typed for structured handling.
 */

export class ContextWorkspaceError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code: string, statusCode: number = 500, cause?: Error) {
    super(message, { cause });
    this.name = 'ContextWorkspaceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class ValidationError extends ContextWorkspaceError {
  public readonly field?: string;

  constructor(message: string, field?: string) {
    super(message, 'VALIDATION_ERROR', 400);
    this.name = 'ValidationError';
    if (field !== undefined) {
      this.field = field;
    }
  }
}


export class NotFoundError extends ContextWorkspaceError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}

export class AuthorizationError extends ContextWorkspaceError {
  constructor(message: string = 'Unauthorized') {
    super(message, 'AUTHORIZATION_ERROR', 403);
    this.name = 'AuthorizationError';
  }
}

export class AuthenticationError extends ContextWorkspaceError {
  constructor(message: string = 'Authentication required') {
    super(message, 'AUTHENTICATION_ERROR', 401);
    this.name = 'AuthenticationError';
  }
}

export class ConflictError extends ContextWorkspaceError {
  constructor(message: string) {
    super(message, 'CONFLICT', 409);
    this.name = 'ConflictError';
  }
}

export class RepositoryIsolationError extends ContextWorkspaceError {
  constructor(requestedRepo: string) {
    super(
      `Cross-repository access denied for repository: ${requestedRepo}`,
      'REPOSITORY_ISOLATION_VIOLATION',
      403,
    );
    this.name = 'RepositoryIsolationError';
  }
}

export class StorageError extends ContextWorkspaceError {
  constructor(message: string, cause?: Error) {
    super(message, 'STORAGE_ERROR', 500, cause);
    this.name = 'StorageError';
  }
}

export class ChunkIntegrityError extends ContextWorkspaceError {
  public readonly chunkId: string;

  constructor(chunkId: string, message: string) {
    super(`Chunk integrity failure [${chunkId}]: ${message}`, 'CHUNK_INTEGRITY_ERROR', 500);
    this.name = 'ChunkIntegrityError';
    this.chunkId = chunkId;
  }
}

export class SecretDetectedError extends ContextWorkspaceError {
  constructor(description: string) {
    super(`Secret detected and blocked: ${description}`, 'SECRET_DETECTED', 400);
    this.name = 'SecretDetectedError';
  }
}

export class OutboxError extends ContextWorkspaceError {
  constructor(message: string, cause?: Error) {
    super(message, 'OUTBOX_ERROR', 500, cause);
    this.name = 'OutboxError';
  }
}

export class DuplicateEventError extends ContextWorkspaceError {
  public readonly eventId: string;

  constructor(eventId: string) {
    super(`Duplicate event: ${eventId}`, 'DUPLICATE_EVENT', 409);
    this.name = 'DuplicateEventError';
    this.eventId = eventId;
  }
}

export class LeaseConflictError extends ContextWorkspaceError {
  public readonly resource: string;
  public readonly existingOwner: string;

  constructor(resource: string, existingOwner: string) {
    super(
      `Resource lease conflict: ${resource} is held by ${existingOwner}`,
      'LEASE_CONFLICT',
      409,
    );
    this.name = 'LeaseConflictError';
    this.resource = resource;
    this.existingOwner = existingOwner;
  }
}

export class TokenBudgetExceededError extends ContextWorkspaceError {
  public readonly budget: number;
  public readonly required: number;

  constructor(budget: number, required: number) {
    super(
      `Token budget exceeded: required ${required}, budget ${budget}`,
      'TOKEN_BUDGET_EXCEEDED',
      400,
    );
    this.name = 'TokenBudgetExceededError';
    this.budget = budget;
    this.required = required;
  }
}

/**
 * Guard for safely narrowing unknown caught values to Error.
 */
export function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value));
}
