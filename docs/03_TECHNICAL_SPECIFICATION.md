# Global Context Workspace — Technical Specification

## 1. Technology baseline

Recommended initial implementation:

```text
Language/runtime:
TypeScript + Node.js

Local database:
SQLite

Cloud database:
PostgreSQL

Vector:
pgvector

Realtime:
WebSocket

Event stream/live coordination:
Redis Streams + Redis state

API:
REST

AI interface:
MCP

IDE:
VS Code-compatible extension

Containerization:
Docker
```

Keep infrastructure replaceable behind interfaces.

## 2. Monorepo

```text
context-workspace/
├── apps/
│   ├── runtime/
│   ├── server/
│   ├── ide-extension/
│   └── cli/
├── packages/
│   ├── protocol/
│   ├── database/
│   ├── events/
│   ├── retrieval/
│   ├── context-compiler/
│   ├── steno/
│   ├── adapters/
│   ├── security/
│   └── shared/
├── infra/
│   ├── docker/
│   ├── postgres/
│   └── redis/
├── tests/
└── docs/
```

Use a workspace package manager such as pnpm.

## 3. Event type

```ts
type ContextEvent = {
  eventId: string;

  workspaceId: string;
  repositoryId: string;
  capsuleId?: string;
  sessionId?: string;

  userId: string;
  deviceId: string;
  agentId?: string;

  clientSequence: number;
  serverSequence?: number;

  timestamp: number;

  type: EventType;

  visibility: EventVisibility;

  payload: EventPayload;

  source: EventSource;
};
```

Event types include:

```text
session.started
session.idle
session.resumed
session.ended

agent.prompt_submitted
agent.response_started
agent.response_completed
agent.tool_started
agent.tool_completed
agent.tool_failed

file.read
file.created
file.modified
file.deleted

command.started
command.completed
command.failed

test.started
test.passed
test.failed

git.branch_changed
git.checkout
git.commit

intent.declared
decision.declared
question.declared
task.started
task.completed

lease.acquired
lease.released
```

## 4. Large content

Do not embed large raw content in normal events.

```ts
type LargeContentRef = {
  rawRef: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  preview?: string;
};
```

## 5. Local SQLite schema

### repositories

```sql
CREATE TABLE repositories (
    id TEXT PRIMARY KEY,
    remote_url TEXT,
    root_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
```

### capsules

```sql
CREATE TABLE capsules (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER
);
```

### sessions

```sql
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    capsule_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    agent_id TEXT,
    native_session_id TEXT,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
);
```

### events

```sql
CREATE TABLE events (
    event_id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    capsule_id TEXT,
    session_id TEXT,
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    client_sequence INTEGER NOT NULL,
    server_sequence INTEGER,
    timestamp INTEGER NOT NULL,
    raw_ref TEXT,
    payload_hash TEXT,
    visibility TEXT NOT NULL,
    synced INTEGER NOT NULL DEFAULT 0,
    chunk_id TEXT,
    chunk_offset INTEGER,
    chunk_length INTEGER
);
```

Indexes:

```sql
CREATE INDEX idx_events_session
ON events(session_id, client_sequence);

CREATE INDEX idx_events_capsule
ON events(capsule_id, timestamp);

CREATE INDEX idx_events_type
ON events(type, timestamp);

CREATE INDEX idx_events_raw_ref
ON events(raw_ref);
```

### outbox

```sql
CREATE TABLE outbox (
    event_id TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    next_retry_at INTEGER,
    created_at INTEGER NOT NULL,
    acknowledged_at INTEGER
);
```

### context_objects

```sql
CREATE TABLE context_objects (
    id TEXT PRIMARY KEY,
    capsule_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    authority TEXT NOT NULL,
    visibility TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    valid_from INTEGER,
    valid_until INTEGER
);
```

### relations

```sql
CREATE TABLE relations (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    to_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
```

## 6. Raw chunk format

Use append-only binary length-prefixed records.

Conceptual record:

```text
[length][eventId][timestamp][payload bytes]
```

SQLite stores:

```text
chunk_id
chunk_offset
chunk_length
```

This gives direct lookup without scanning all raw history.

Chunk rules:

- Configurable maximum size, initially 16–64 MB.
- Rotate on size or event-count threshold.
- Closed chunks are immutable.
- Chunk integrity is verified using SHA-256.

## 7. Cloud PostgreSQL schema

Required logical tables:

```text
workspaces
users
devices
repositories
capsules
sessions
events
context_objects
relations
leases
materialized_repository_state
materialized_session_state
```

Events are partitioned by repository/time.

PostgreSQL is canonical durable storage.

## 8. Redis model

Redis stores:

```text
live agent state
live session state
active leases
presence
subscription state
realtime stream coordination
```

Redis state is disposable/rebuildable.

Do not make Redis the only source of truth.

## 9. API

Minimum REST API:

```text
POST   /v1/events
POST   /v1/events/batch

GET    /v1/workspaces/:id
GET    /v1/repos/:id
GET    /v1/repos/:id/capsules
GET    /v1/capsules/:id
GET    /v1/capsules/:id/context

POST   /v1/context/query
POST   /v1/context/objects
PATCH  /v1/context/objects/:id

POST   /v1/leases/acquire
POST   /v1/leases/:id/heartbeat
POST   /v1/leases/:id/release

POST   /v1/sessions
PATCH  /v1/sessions/:id

GET    /v1/health
```

Exact OpenAPI definitions should be generated and versioned.

## 10. WebSocket protocol

Client connects:

```text
CONNECT
AUTH
SUBSCRIBE
EVENT
ACK
STATE_UPDATE
CONFLICT
ERROR
PING
PONG
```

Example event acknowledgement:

```json
{
  "type": "ACK",
  "eventId": "evt_123",
  "serverSequence": 83921
}
```

Client must persist acknowledged state before deleting/reusing the outbox record.

## 11. Repository isolation

Every cloud query must include repository/workspace authorization.

Never trust client-supplied repository access.

Server derives permitted repository scope from authenticated identity.

Cross-repository retrieval is disabled by default.

## 12. Context query API

Conceptual request:

```ts
type ContextQuery = {
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
  };
};
```

Response:

```ts
type CompiledContext = {
  objects: ContextObjectRef[];
  serialized: string;
  estimatedTokens: number;
  omittedCount: number;
  generatedAt: number;
};
```

## 13. Retrieval implementation

Stage 1:

```text
scope filter
→ PostgreSQL B-tree
```

Stage 2:

```text
exact identifiers/resources
```

Stage 3:

```text
PostgreSQL relations
```

Stage 4:

```text
FTS/BM25
```

Stage 5:

```text
pgvector
```

Stage 6:

```text
reranking
```

The implementation must record retrieval telemetry so evaluation can compare methods.

## 14. Retrieval scoring

Start with configurable weighted scoring:

```text
score =
  scopeMatch
+ resourceMatch
+ taskMatch
+ relationshipStrength
+ recency
+ authority
+ status
+ semanticSimilarity
```

Weights must be configuration, not hard-coded permanently.

Use evaluation datasets to tune them.

## 15. Context compiler

Pipeline:

```text
query
 ↓
hard-required objects
 ↓
priority tiers
 ↓
candidate score
 ↓
token estimation
 ↓
budget fill
 ↓
redundancy removal
 ↓
Steno serialization
```

Hard-required context cannot be dropped merely because lower-ranked content exists.

Token estimation must be provider-aware where tokenizer APIs are available.

## 16. Steno

Define a canonical compact grammar after tokenizer benchmarks.

Requirements:

- deterministic parsing
- deterministic serialization
- version number
- alias dictionary version
- no ambiguity
- fallback to natural language
- provider serializer interface

Example conceptual form:

```text
task:t7
file:f3
decision:
use queue-based retry
why:
duplicate execution after restart
```

Do not optimize purely for character count.

## 17. Alias system

```text
alias dictionary
├── alias
├── canonical value
├── scope
├── createdAt
├── version
└── usage count
```

Alias only after a configurable repetition threshold.

Do not alias short/common strings.

Dictionary changes must be versioned so old context remains decodable.

## 18. Conflict/lease API

```ts
type Lease = {
  id: string;
  repositoryId: string;
  resource: string;
  scope: string;
  ownerId: string;
  reason?: string;
  createdAt: number;
  expiresAt: number;
  lastHeartbeatAt: number;
};
```

Acquire:

```text
POST /v1/leases/acquire
```

Heartbeat:

```text
POST /v1/leases/:id/heartbeat
```

Release:

```text
POST /v1/leases/:id/release
```

## 19. Agent adapter interface

```ts
interface AgentAdapter {
  initialize(): Promise<void>;

  detectSessions(): Promise<AgentSession[]>;

  captureEvent(event: unknown): Promise<ContextEvent[]>;

  getCapabilities(): AgentCapabilities;

  sendContext?(
    sessionId: string,
    context: CompiledContext
  ): Promise<void>;

  subscribeLiveUpdates?(
    sessionId: string,
    handler: LiveUpdateHandler
  ): Promise<void>;
}
```

Capabilities:

```ts
type AgentCapabilities = {
  sideChannel: boolean;
  preEditHook: boolean;
  contextTool: boolean;
  liveEvents: boolean;
};
```

## 20. MCP tools

Initial MCP surface:

```text
context.search
context.get
context.current
context.handoff
context.report_decision
context.report_intent
context.report_placeholder
context.report_question
context.conflicts
context.lease
```

MCP should return compact relevant context, not entire histories.

## 21. Security

Secret scanning happens before cloud transmission.

Security layers:

```text
authentication
authorization
secret filtering
repository isolation
capsule visibility
transport encryption
encrypted persistence
audit events
```

## 22. Authentication

```text
OAuth/session
+
device registration
+
short-lived runtime token
+
scoped service credentials
```

Device revocation must invalidate future runtime access.

## 23. Observability

Metrics:

```text
runtime_events_captured_total
runtime_outbox_pending
runtime_sync_failures
websocket_connections
event_processing_latency
event_duplicate_rate
lease_conflicts_total
context_query_latency
context_tokens_returned
retrieval_precision
retrieval_recall
vector_fallback_rate
```

Use structured logs with correlation IDs:

```text
workspaceId
repositoryId
capsuleId
sessionId
eventId
requestId
```

## 24. Testing

Required tests:

### Unit

- event validation
- event normalization
- deduplication
- secret filtering
- chunk read/write
- SQLite indexing
- alias dictionary
- Steno encode/decode
- ranking
- context budget
- lease expiration

### Integration

- runtime → server
- offline → reconnect
- duplicate replay
- two devices
- two capsules
- repository isolation
- conflict detection
- context retrieval
- MCP

### End-to-end

Two laptops/processes:

```text
Agent A
→ edit resource
→ declare intent
→ Agent B receives live state
→ B attempts overlapping work
→ conflict generated
→ B retrieves relevant decision/handoff
```

## 25. Non-functional targets

Initial targets should be measurable rather than blindly fixed.

Track:

```text
local event write latency
cloud event acknowledgement latency
live-update latency
retrieval latency
context compilation latency
token budget compliance
event loss rate
duplicate processing rate
```

The implementation should establish baseline benchmarks before choosing aggressive production targets.

## 26. Important non-goals

V1 does not:

- replace Git
- replace PRs/code review
- require an LLM for memory extraction
- upload every raw chat to cloud by default
- merge code automatically
- assume every AI provider supports live injection
- treat vector search as the primary retrieval mechanism
- treat Steno as canonical storage
