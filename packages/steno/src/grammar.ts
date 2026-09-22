/**
 * Steno grammar definitions.
 *
 * Per spec §15 (Architecture): Canonical compact grammar after tokenizer benchmarks.
 *
 * Key rules:
 * - Short lowercase labels for structure (task:, decision:, file:, etc.)
 * - IDs for repeated exact entities
 * - Natural language for content — do NOT replace with invented codes
 * - why: field for rationale
 * - Natural language fallback always valid
 *
 * Grammar example:
 * ```
 * task:t7
 * file:f3
 * decision:
 * use queue-based retry
 * why:
 * duplicate execution after restart
 * ```
 *
 * STENO_VERSION must be incremented when grammar changes break existing serializations.
 */

export const STENO_VERSION = 1 as const;

export const StenoLabels = {
  TASK: 'task',
  INTENT: 'intent',
  DECISION: 'decision',
  CONSTRAINT: 'constraint',
  ASSUMPTION: 'assumption',
  DISCOVERY: 'discovery',
  ERROR: 'error',
  TEST_RESULT: 'test',
  PLACEHOLDER: 'placeholder',
  QUESTION: 'question',
  HANDOFF: 'handoff',
  OBSERVATION: 'obs',
  STATE: 'state',
  CODE_REF: 'code',

  // Sub-fields
  WHY: 'why',
  NEXT: 'next',
  DONE: 'done',
  REMAINING: 'remaining',
  BLOCKERS: 'blockers',
  ISSUES: 'issues',
  RESOURCE: 'file',
  STATUS: 'status',
  CONFLICTS: 'conflicts',
  AGENT: 'agent',
  SESSION: 'session',
  CAPSULE: 'capsule',
} as const;

export type StenoLabel = (typeof StenoLabels)[keyof typeof StenoLabels];

/**
 * A Steno document — the structured form before serialization.
 */
export interface StenoDocument {
  version: typeof STENO_VERSION;
  /** Alias dictionary version (for decoding aliases) */
  dictVersion: number;
  /** Steno blocks in priority order */
  blocks: StenoBlock[];
}

export type StenoBlock =
  | StenoTaskBlock
  | StenoIntentBlock
  | StenoDecisionBlock
  | StenoConstraintBlock
  | StenoAssumptionBlock
  | StenoErrorBlock
  | StenoTestBlock
  | StenoPlaceholderBlock
  | StenoQuestionBlock
  | StenoHandoffBlock
  | StenoObservationBlock
  | StenoStateBlock
  | StenoConflictBlock
  | StenoTextBlock;

export interface StenoTaskBlock {
  label: 'task';
  id?: string;
  text: string;
  status?: string;
  resource?: string;
}

export interface StenoIntentBlock {
  label: 'intent';
  id?: string;
  text: string;
  resources?: string[];
}

export interface StenoDecisionBlock {
  label: 'decision';
  id?: string;
  text: string;
  why?: string;
  resources?: string[];
  status?: string;
}

export interface StenoConstraintBlock {
  label: 'constraint';
  id?: string;
  text: string;
  resources?: string[];
}

export interface StenoAssumptionBlock {
  label: 'assumption';
  id?: string;
  text: string;
  basis?: string;
}

export interface StenoErrorBlock {
  label: 'error';
  id?: string;
  text: string;
  resource?: string;
}

export interface StenoTestBlock {
  label: 'test';
  id?: string;
  testName?: string;
  status: 'passed' | 'failed';
  error?: string;
}

export interface StenoPlaceholderBlock {
  label: 'placeholder';
  id?: string;
  resource: string;
  text: string;
  replacement?: string;
  status?: string;
}

export interface StenoQuestionBlock {
  label: 'question';
  id?: string;
  text: string;
  blocking?: boolean;
}

export interface StenoHandoffBlock {
  label: 'handoff';
  id?: string;
  summary: string;
  done?: string[];
  remaining?: string[];
  next?: string;
  blockers?: string[];
  issues?: string[];
}

export interface StenoObservationBlock {
  label: 'obs';
  id?: string;
  text: string;
  resource?: string;
}

export interface StenoStateBlock {
  label: 'state';
  key: string;
  value: string;
  resource?: string;
}

export interface StenoConflictBlock {
  label: 'conflicts';
  resource: string;
  severity: string;
  agentId?: string;
  message?: string;
}

/** Raw text block — for natural language fallback */
export interface StenoTextBlock {
  label: 'text';
  text: string;
}
