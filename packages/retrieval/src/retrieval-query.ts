import type { ContextObjectType, ContextObjectStatus } from '@context-workspace/protocol';
import type { ContextObject } from '@context-workspace/protocol';

/**
 * Retrieval query — the input to the retrieval engine.
 * Per spec §12 (Technical Specification): ContextQuery type.
 */
export interface RetrievalQuery {
  workspaceId: string;
  repositoryId: string;
  capsuleId?: string;

  /** What the agent is trying to do */
  task?: string;
  /** Specific files/resources the agent is working with */
  resources?: string[];

  /** Maximum tokens to return */
  maxTokens: number;

  /** What types of context objects to include */
  include?: {
    decisions?: boolean;
    constraints?: boolean;
    placeholders?: boolean;
    handoffs?: boolean;
    liveState?: boolean;
    errors?: boolean;
    tasks?: boolean;
    intents?: boolean;
    assumptions?: boolean;
    questions?: boolean;
    testResults?: boolean;
    codeReferences?: boolean;
  };

  /** Explicit type filter — overrides include */
  types?: ContextObjectType[];

  /** Status filter */
  statuses?: ContextObjectStatus[];

  /** Maximum number of candidates to retrieve before scoring */
  candidateLimit?: number;

  /**
   * Whether to assemble category-aware context slots.
   * When true, result.categories is populated with the 10 required categories.
   * Default: true
   */
  includeCategories?: boolean;
}

/**
 * A single retrieval candidate with its score.
 */
export interface RetrievalCandidate {
  objectId: string;
  score: RetrievalScore;
  /** Which retrieval stages contributed */
  stages: RetrievalStage[];
}

export type RetrievalStage = 'exact' | 'graph' | 'bm25' | 'vector' | 'category' | 'rerank';

export interface RetrievalScore {
  total: number;
  scopeMatch: number;
  resourceMatch: number;
  taskMatch: number;
  relationshipStrength: number;
  recency: number;
  authority: number;
  status: number;
  semanticSimilarity: number;
}

/**
 * Scoring weights — configurable per spec §14 (Technical Specification).
 * These are configuration, not hard-coded.
 */
export interface ScoringWeights {
  scopeMatch: number;
  resourceMatch: number;
  taskMatch: number;
  relationshipStrength: number;
  recency: number;
  authority: number;
  status: number;
  semanticSimilarity: number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  scopeMatch: 2.0,
  resourceMatch: 3.0,
  taskMatch: 2.0,
  relationshipStrength: 1.5,
  recency: 1.0,
  authority: 1.5,
  status: 1.0,
  semanticSimilarity: 1.0,
};

/**
 * Decision validity state — resolved from the supersession relation chain.
 *
 * Rules:
 * - ACTIVE:      No incoming 'supersedes' relation (nobody has superseded this decision),
 *                status is not rejected, not expired.
 * - SUPERSEDED:  Another decision has a 'supersedes' relation pointing to this one.
 * - REJECTED:    Object status === 'rejected'.
 * - EXPIRED:     validUntil timestamp is in the past.
 * - UNKNOWN:     No supersession relation data available and none of the above apply.
 *
 * Important: Recency alone is NEVER used to determine whether a decision is current.
 * A newer decision does not supersede an older one unless a 'supersedes' relation exists.
 */
export type DecisionValidity = 'ACTIVE' | 'SUPERSEDED' | 'REJECTED' | 'EXPIRED' | 'UNKNOWN';

/**
 * A decision with its resolved validity state.
 */
export interface ValidatedDecision {
  object: ContextObject;
  validity: DecisionValidity;
  /** ID of the decision that supersedes this one (if SUPERSEDED) */
  supersededBy?: string;
  /** IDs that this decision supersedes (if ACTIVE and part of a chain) */
  supersedes?: string[];
}

/**
 * Category-aware context slots.
 *
 * The 10 required categories assembled after scoring.
 * Each category contains objects that best represent that category
 * for the given query context.
 */
export interface CategoryResult {
  /** Active tasks and intents for the current work context */
  currentActiveWork: ContextObject[];
  /** The single best ACTIVE decision (post-supersession resolution) per topic area */
  latestApplicableDecisions: ValidatedDecision[];
  /** Decisions that have been superseded — historical context */
  supersededDecisions: ValidatedDecision[];
  /** Active constraints */
  constraints: ContextObject[];
  /** Most recent errors (newest first, up to 5) */
  latestErrors: ContextObject[];
  /** Most recent test results (newest first, up to 5) */
  latestTestResults: ContextObject[];
  /** Active conflict STATE objects */
  activeConflicts: ContextObject[];
  /** Placeholders in candidate/active/confirmed status */
  placeholders: ContextObject[];
  /** Handoff objects */
  handoffs: ContextObject[];
  /** Code references and observations tied to query resources */
  relevantCodeResources: ContextObject[];
}

