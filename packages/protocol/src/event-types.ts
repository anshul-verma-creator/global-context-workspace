/**
 * All event types supported by the Global Context Workspace.
 * From spec §3 (Technical Specification).
 * Any new event type MUST be added here and documented.
 */

export const EventTypes = {
  // Session lifecycle
  SESSION_STARTED: 'session.started',
  SESSION_IDLE: 'session.idle',
  SESSION_RESUMED: 'session.resumed',
  SESSION_ENDED: 'session.ended',

  // Agent activity
  AGENT_PROMPT_SUBMITTED: 'agent.prompt_submitted',
  AGENT_RESPONSE_STARTED: 'agent.response_started',
  AGENT_RESPONSE_COMPLETED: 'agent.response_completed',
  AGENT_TOOL_STARTED: 'agent.tool_started',
  AGENT_TOOL_COMPLETED: 'agent.tool_completed',
  AGENT_TOOL_FAILED: 'agent.tool_failed',

  // File operations
  FILE_READ: 'file.read',
  FILE_CREATED: 'file.created',
  FILE_MODIFIED: 'file.modified',
  FILE_DELETED: 'file.deleted',

  // Commands
  COMMAND_STARTED: 'command.started',
  COMMAND_COMPLETED: 'command.completed',
  COMMAND_FAILED: 'command.failed',

  // Tests
  TEST_STARTED: 'test.started',
  TEST_PASSED: 'test.passed',
  TEST_FAILED: 'test.failed',

  // Git
  GIT_BRANCH_CHANGED: 'git.branch_changed',
  GIT_CHECKOUT: 'git.checkout',
  GIT_COMMIT: 'git.commit',
  GIT_MERGE: 'git.merge',
  GIT_REBASE: 'git.rebase',

  // Context declarations (explicit agent actions)
  INTENT_DECLARED: 'intent.declared',
  DECISION_DECLARED: 'decision.declared',
  QUESTION_DECLARED: 'question.declared',
  TASK_STARTED: 'task.started',
  TASK_COMPLETED: 'task.completed',
  PLACEHOLDER_DECLARED: 'placeholder.declared',
  HANDOFF_CREATED: 'handoff.created',
  ASSUMPTION_DECLARED: 'assumption.declared',

  // Lease management
  LEASE_ACQUIRED: 'lease.acquired',
  LEASE_RELEASED: 'lease.released',
  LEASE_EXPIRED: 'lease.expired',
  LEASE_CONFLICT: 'lease.conflict',
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];

/**
 * Event visibility controls what goes to the cloud and what stays local.
 */
export const EventVisibility = {
  /** Raw local capture only — never sent to cloud */
  LOCAL: 'local',
  /** Shared within repository — sent to cloud */
  REPOSITORY: 'repository',
  /** Shared workspace-wide */
  WORKSPACE: 'workspace',
  /** Ephemeral — sent but not durably stored on server */
  EPHEMERAL: 'ephemeral',
} as const;

export type EventVisibility = (typeof EventVisibility)[keyof typeof EventVisibility];

/**
 * Event sources — where did this event originate?
 */
export const EventSources = {
  AGENT: 'agent',
  IDE: 'ide',
  GIT: 'git',
  FILESYSTEM: 'filesystem',
  TERMINAL: 'terminal',
  SYSTEM: 'system',
  MCP: 'mcp',
  CLI: 'cli',
  RUNTIME: 'runtime',
} as const;

export type EventSource = (typeof EventSources)[keyof typeof EventSources];

/**
 * Whether an event is durable (replayed on reconnect) or ephemeral (latest-state only).
 */
export const DurabilityClass = {
  /** Must be delivered, replayed after disconnect */
  DURABLE: 'durable',
  /** Latest-state reconciliation on reconnect, no replay */
  EPHEMERAL: 'ephemeral',
} as const;

export type DurabilityClass = (typeof DurabilityClass)[keyof typeof DurabilityClass];

/**
 * Map from event type to its durability class.
 * Durable events are replayed after reconnect.
 * Ephemeral events are reconciled to latest state.
 */
export const EVENT_DURABILITY: Record<EventType, DurabilityClass> = {
  'session.started': 'durable',
  'session.idle': 'ephemeral',
  'session.resumed': 'durable',
  'session.ended': 'durable',

  'agent.prompt_submitted': 'durable',
  'agent.response_started': 'ephemeral',
  'agent.response_completed': 'durable',
  'agent.tool_started': 'ephemeral',
  'agent.tool_completed': 'durable',
  'agent.tool_failed': 'durable',

  'file.read': 'ephemeral',
  'file.created': 'durable',
  'file.modified': 'durable',
  'file.deleted': 'durable',

  'command.started': 'ephemeral',
  'command.completed': 'durable',
  'command.failed': 'durable',

  'test.started': 'ephemeral',
  'test.passed': 'durable',
  'test.failed': 'durable',

  'git.branch_changed': 'durable',
  'git.checkout': 'durable',
  'git.commit': 'durable',
  'git.merge': 'durable',
  'git.rebase': 'durable',

  'intent.declared': 'durable',
  'decision.declared': 'durable',
  'question.declared': 'durable',
  'task.started': 'durable',
  'task.completed': 'durable',
  'placeholder.declared': 'durable',
  'handoff.created': 'durable',
  'assumption.declared': 'durable',

  'lease.acquired': 'durable',
  'lease.released': 'durable',
  'lease.expired': 'durable',
  'lease.conflict': 'durable',
};
