/**
 * Context object types — the structured knowledge objects that form
 * the shared memory of the workspace.
 *
 * Per spec §8 (Architecture): These are derived, not canonical storage.
 * Context objects are materialized views over events.
 */

export const ContextObjectTypes = {
  TASK: 'TASK',
  INTENT: 'INTENT',
  DECISION: 'DECISION',
  CONSTRAINT: 'CONSTRAINT',
  ASSUMPTION: 'ASSUMPTION',
  DISCOVERY: 'DISCOVERY',
  ERROR: 'ERROR',
  TEST_RESULT: 'TEST_RESULT',
  PLACEHOLDER: 'PLACEHOLDER',
  QUESTION: 'QUESTION',
  HANDOFF: 'HANDOFF',
  OBSERVATION: 'OBSERVATION',
  STATE: 'STATE',
  CODE_REFERENCE: 'CODE_REFERENCE',
} as const;

export type ContextObjectType = (typeof ContextObjectTypes)[keyof typeof ContextObjectTypes];

export const ContextObjectStatuses = {
  ACTIVE: 'active',
  RESOLVED: 'resolved',
  SUPERSEDED: 'superseded',
  REJECTED: 'rejected',
  CANDIDATE: 'candidate',
  CONFIRMED: 'confirmed',
  ARCHIVED: 'archived',
} as const;

export type ContextObjectStatus =
  (typeof ContextObjectStatuses)[keyof typeof ContextObjectStatuses];

/**
 * Placeholder-specific lifecycle statuses (more granular than generic status).
 */
export const PlaceholderStatuses = {
  CANDIDATE: 'candidate',
  ACTIVE: 'active',
  CONFIRMED: 'confirmed',
  RESOLVED: 'resolved',
  REJECTED: 'rejected',
} as const;

export type PlaceholderStatus =
  (typeof PlaceholderStatuses)[keyof typeof PlaceholderStatuses];

/**
 * Scope controls what resources/sessions this context object applies to.
 */
export const ContextObjectScopes = {
  REPOSITORY: 'repository',
  CAPSULE: 'capsule',
  SESSION: 'session',
  RESOURCE: 'resource',
} as const;

export type ContextObjectScope =
  (typeof ContextObjectScopes)[keyof typeof ContextObjectScopes];

/**
 * Authority indicates the confidence/source of the context object.
 */
export const ContextAuthority = {
  AGENT_EXPLICIT: 'agent_explicit',
  AGENT_INFERRED: 'agent_inferred',
  DETERMINISTIC_RULE: 'deterministic_rule',
  STATIC_ANALYSIS: 'static_analysis',
  HUMAN: 'human',
} as const;

export type ContextAuthority = (typeof ContextAuthority)[keyof typeof ContextAuthority];

/**
 * Visibility controls who can see this context object.
 */
export const ContextObjectVisibility = {
  LOCAL: 'local',
  CAPSULE: 'capsule',
  REPOSITORY: 'repository',
  WORKSPACE: 'workspace',
} as const;

export type ContextObjectVisibility =
  (typeof ContextObjectVisibility)[keyof typeof ContextObjectVisibility];

/**
 * Relationship types between context objects.
 * Per spec §8 (Architecture).
 */
export const RelationTypes = {
  CONTINUES: 'continues',
  DEPENDS_ON: 'depends_on',
  SPAWNED_FROM: 'spawned_from',
  CONFLICTS_WITH: 'conflicts_with',
  RELATED_TO: 'related_to',
  SUPERSEDES: 'supersedes',
  DERIVED_FROM: 'derived_from',
} as const;

export type RelationType = (typeof RelationTypes)[keyof typeof RelationTypes];

/**
 * Source provenance for a context object — traces back to the originating event.
 */
export interface ContextObjectProvenance {
  /** Source event ID(s) that created/triggered this object */
  sourceEventIds: string[];
  /** Session where this was created */
  sessionId?: string;
  /** Capsule where this was created */
  capsuleId?: string;
  /** Human-readable origin description */
  description?: string;
}

/**
 * A context object — the structured knowledge unit.
 * All fields except content are queryable for retrieval.
 */
export interface ContextObject {
  id: string;
  type: ContextObjectType;
  scope: ContextObjectScope;
  visibility: ContextObjectVisibility;
  authority: ContextAuthority;
  status: ContextObjectStatus;
  version: number;

  /** Which repository this belongs to */
  repositoryId: string;
  /** Which capsule, if capsule-scoped */
  capsuleId?: string;
  /** Specific resource path if resource-scoped */
  resource?: string;

  provenance: ContextObjectProvenance;

  createdAt: number;
  updatedAt: number;
  validFrom?: number;
  validUntil?: number;

  /** The actual content — structured, not raw chat */
  content: ContextObjectContent;
}

/**
 * Type-specific content for context objects.
 */
export type ContextObjectContent =
  | TaskContent
  | IntentContent
  | DecisionContent
  | ConstraintContent
  | AssumptionContent
  | DiscoveryContent
  | ErrorContent
  | TestResultContent
  | PlaceholderContent
  | QuestionContent
  | HandoffContent
  | ObservationContent
  | StateContent
  | CodeReferenceContent;

export interface TaskContent {
  kind: 'task';
  title: string;
  description?: string;
  status: 'active' | 'completed' | 'blocked';
}

export interface IntentContent {
  kind: 'intent';
  description: string;
  resources?: string[];
  confidence?: number;
}

export interface DecisionContent {
  kind: 'decision';
  description: string;
  rationale?: string;
  alternatives?: string[];
  resources?: string[];
  requiresConfirmation: boolean;
  confirmed?: boolean;
}

export interface ConstraintContent {
  kind: 'constraint';
  description: string;
  rationale?: string;
  resources?: string[];
}

export interface AssumptionContent {
  kind: 'assumption';
  assumption: string;
  basis?: string;
  confidence?: number;
  verified?: boolean;
}

export interface DiscoveryContent {
  kind: 'discovery';
  description: string;
  resources?: string[];
}

export interface ErrorContent {
  kind: 'error';
  message: string;
  stack?: string;
  resource?: string;
  errorType?: string;
}

export interface TestResultContent {
  kind: 'test_result';
  testFile?: string;
  testName?: string;
  status: 'passed' | 'failed';
  duration?: number;
  errorMessage?: string;
}

export interface PlaceholderContent {
  kind: 'placeholder';
  resource: string;
  description: string;
  intendedReplacement?: string;
  detectionMethod: 'explicit_marker' | 'static_analysis' | 'agent_declaration';
  markers?: string[];
  placeholderStatus: PlaceholderStatus;
}

export interface QuestionContent {
  kind: 'question';
  question: string;
  context?: string;
  blocking: boolean;
  answer?: string;
}

export interface HandoffContent {
  kind: 'handoff';
  summary: string;
  completed?: string[];
  remaining?: string[];
  nextStep?: string;
  blockers?: string[];
  placeholderIds?: string[];
  knownIssues?: string[];
  contextObjectIds?: string[];
}

export interface ObservationContent {
  kind: 'observation';
  description: string;
  resource?: string;
}

export interface StateContent {
  kind: 'state';
  key: string;
  value: unknown;
  resource?: string;
}

export interface CodeReferenceContent {
  kind: 'code_reference';
  resource: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  description?: string;
}

/**
 * A relation between two context objects.
 */
export interface ContextRelation {
  id: string;
  fromId: string;
  relationType: RelationType;
  toId: string;
  repositoryId: string;
  createdAt: number;
  metadata?: Record<string, string>;
}

/**
 * Agent capabilities — declared by each provider adapter at initialization.
 * Per spec §19 (Technical Specification): universal agent adapter interface.
 */
export interface AgentCapabilities {
  /** Provider name (e.g. 'claude', 'cursor', 'gemini', 'copilot') */
  provider: string;
  /** Whether this adapter can detect existing sessions */
  canDetectSessions: boolean;
  /** Whether this adapter can inject context into the agent side channel */
  canInjectContext: boolean;
  /** Whether this adapter supports live event streaming */
  canStreamEvents: boolean;
  /** Whether this adapter can capture prompt/response content */
  canCaptureContent: boolean;
  /** Provider-declared model name(s), if known */
  models?: string[];
}
