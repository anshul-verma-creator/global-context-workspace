# Global Context Workspace — Architecture Document

## 1. Purpose

A cloud-based shared context workspace for multi-user, multi-agent software development.

The system solves the problem where multiple vibe coders work on the same repository from different laptops, IDEs, AI agents, and independent chats. Each agent normally has isolated context, so agents can make conflicting changes or fail to understand why existing code/decisions exist.

The system provides one Global Workspace, isolated repositories, and capsules representing individual AI working sessions.

Core principle:

> Capture everything locally, synchronize only relevant/live shared context to the cloud, and provide each AI with the minimum useful context.

## 2. Hierarchy

```text
Global Workspace
├── Repository A
│   ├── Capsule A
│   │   ├── Session(s)
│   │   └── context
│   ├── Capsule B
│   └── Capsule C
├── Repository B
└── Repository C
```

Global Workspace is the overall shared context space.

Repositories are isolated. Work in one repository must not accidentally affect another repository.

Capsules belong to a repository. A capsule represents one AI working context/chat/session. A new AI session working in the same repository attaches to a capsule based on the session/chat identity; the capsule can be named using the native AI agent/IDE chat name.

Sessions are executions inside capsules.

## 3. Core architectural principles

- Capture everything locally.
- Keep complete raw history locally.
- Upload only relevant/shared/live information.
- Do not use an AI/LLM inside the Context Runtime to decide what to store.
- Use deterministic rules, indexes, relationships, event metadata, and explicit agent declarations.
- Raw events are immutable.
- Context objects are derived, structured knowledge.
- Events are canonical history.
- Current state is a rebuildable materialized view.
- Repository isolation is enforced at every layer.
- Retrieval is layered: cheap/deterministic retrieval before semantic/vector retrieval.
- Context budget is a hard constraint.
- Context Steno is a derived transport representation, not canonical storage.
- Uncertainty is explicit: assumptions, questions, placeholders, and known issues are separate from facts/decisions.

## 4. Major components

### Local Context Runtime

Runs on each developer machine.

```text
Context Runtime
├── Agent adapters
├── IDE adapter
├── Git adapter
├── Filesystem watcher
├── Terminal watcher
├── Event normalizer
├── Secret filter
├── Local SQLite
├── Raw chunk storage
├── SQLite outbox
└── Cloud sync client
```

### Cloud Context Server

Modular monolith.

```text
Context Server
├── API
├── WebSocket gateway
├── Event processor
├── Workers
├── Retrieval
├── Context compiler
├── Conflict/lease engine
└── Auth/authorization
```

Infrastructure:

```text
Redis        → realtime/live state
PostgreSQL   → durable truth/events/context
Object/file storage → optional large durable artifacts
```

## 5. Realtime architecture

```text
AI / IDE / Git / Filesystem
        ↓
Adapter
        ↓
Normalized Event
        ↓
Validate
        ↓
Secret Filter
        ↓
Deduplicate
        ↓
SQLite
        ↓
Outbox
        ↓
WebSocket
        ↓
Cloud Server
        ↓
Redis Streams / live state
        ↓
PostgreSQL persistence
        ↓
Relevant clients
```

Events are persisted locally before network transmission so network failure does not lose events.

Realtime subscriptions use a hybrid model:

- Repository-level important events go to relevant clients.
- Resource-specific events go to subscribers.
- Critical conflicts receive direct push/notification.

Offline behavior:

- Durable/important events are replayed.
- Ephemeral activity synchronizes as latest state.
- Transient noise is not replayed unnecessarily.

## 6. Event architecture

Every event contains:

```text
eventId
workspaceId
repositoryId
capsuleId?
sessionId?
userId
deviceId
agentId?
clientSequence
serverSequence?
timestamp
type
visibility
payload
source
```

Events are immutable and idempotently processed.

Ordering combines:

```text
client sequence
+
server sequence
+
timestamp
+
causal/session information
```

Duplicate protection uses:

```text
eventId
+
content/hash
+
source metadata
```

## 7. Storage architecture

Local:

```text
~/.context-runtime/
└── repos/
    └── <repoId>/
        ├── repo.meta
        ├── local.db
        └── capsules/
            └── <capsuleId>/
                ├── capsule.meta
                ├── context/
                └── sessions/
                    └── <sessionId>/
                        ├── chunks/
                        └── session.meta
```

SQLite contains metadata, indexes, context objects, relationships, and outbox state.

Raw conversation/tool content is stored in append-only binary length-prefixed chunks. Chunks are rotated by configurable size/event limits and become immutable after rotation. SQLite records chunk ID, offset, and length for direct lookup.

Cloud:

```text
PostgreSQL
├── repositories
├── capsules
├── sessions
├── events
├── context_objects
├── relations
├── leases
├── users
├── devices
└── materialized state
```

PostgreSQL event storage is partitioned by repository/time.

Redis holds live state and realtime coordination. PostgreSQL remains durable truth.

## 8. Context objects

Core types:

```text
TASK
INTENT
DECISION
CONSTRAINT
ASSUMPTION
DISCOVERY
ERROR
TEST_RESULT
PLACEHOLDER
QUESTION
HANDOFF
OBSERVATION
STATE
CODE_REFERENCE
```

A context object contains:

```text
id
type
scope
visibility
authority
status
version
source/provenance
createdAt
updatedAt
validFrom
validUntil
content
```

Relationships:

```text
continues
depends_on
spawned_from
conflicts_with
related_to
supersedes
```

Context objects use a hybrid storage model: common metadata plus JSONB payload, with specialized columns/indexes for frequently queried fields.

## 9. Promotion model

No AI is required to decide what enters memory.

```text
Raw Event
   ↓
Deterministic candidate
   ↓
Shared context candidate
   ↓
Automatic promotion for clear/live state
OR confirmation for important decisions/constraints
   ↓
Canonical Context Object
```

Routine events use deterministic rules.

Important decisions/constraints can require confirmation.

Live state is automatically represented.

## 10. Placeholder system

Placeholders are first-class context objects.

Detect through hybrid deterministic signals:

- Explicit markers: TODO, FIXME, MOCK, STUB, PLACEHOLDER, REPLACE_ME.
- Static/code signals: hardcoded values, mock data, stub functions, NotImplemented, disabled/skipped tests, temporary flags, sample credentials.
- Explicit agent declaration.

Explicit/high-confidence signals can be promoted automatically. Static-analysis candidates can be marked as candidates and confirmed/rejected.

A placeholder records resource, description, intended replacement, creator, status, and provenance.

This prevents one AI from seeing placeholder data as if it were canonical/real.

## 11. Handoff system

Handoff is structured plus human-readable:

```text
completed
remaining
next_step
blockers
placeholders
known_issues
summary
links to relevant context objects
```

## 12. Conflict architecture

Resources are hierarchical:

```text
symbol
 ↓
file
 ↓
directory
 ↓
schema/global resource
```

Agents acquire leases for active resources.

Lease:

```text
resource
scope
owner
reason
createdAt
expiresAt
heartbeat
```

Expiration uses heartbeat + maximum TTL + explicit release.

Conflict severity:

```text
low      → allow
medium   → warning
high     → confirmation
critical → block
```

A key requirement is realtime awareness: if two agents begin work on overlapping resources, the system should expose the conflict while they are working, rather than discovering it only during Git PR/merge.

## 13. Retrieval architecture

Layered retrieval:

```text
1. scope/filter
2. exact indexes
3. relationship graph
4. BM25
5. vector fallback
6. rerank
```

Ranking incorporates:

```text
scope
resource
task
relationships
recency
authority
status
semantic similarity
```

Graph is initially implemented with PostgreSQL relations. A dedicated graph database can be introduced only if required.

Search starts with PostgreSQL indexes/FTS and pgvector. The architecture keeps the search provider replaceable.

Retrieval strategies must pass precision/recall evaluation before production use.

## 14. Context compiler

Initial AI context:

```text
1. current task
2. critical live state/conflicts
3. relevant decisions/constraints
4. placeholders/handoff
5. additional context if budget remains
```

Compilation:

```text
Hard-required context
        ↓
Priority tiers
        ↓
Score candidates
        ↓
Fill dynamic token budget
        ↓
Remove redundancy
        ↓
Serialize
```

There is a hard maximum context budget. Lowest-ranked context is removed first.

## 15. Context Steno

Canonical storage is structured context, not Steno.

```text
Raw events
   ↓
Context objects
   ↓
Context compiler
   ↓
Common Steno
   ↓
Provider-specific serializer when useful
```

Rules:

- IDs are used for repeated exact entities.
- Short lowercase labels are used for structure.
- Natural language is retained for semantic meaning.
- Invented codes are avoided when tokenizer cost is unknown.
- Alias creation is lazy and based on repetition thresholds.
- Dictionaries are stable within capsule/session scope and versioned.
- Short/common strings should not be aliased unnecessarily.

The earlier tokenizer experiments showed that character compression does not guarantee token compression. Invented SCREAMING_SNAKE_CASE codes can tokenize worse than natural lowercase words. Therefore Steno must be validated against real production tokenizers rather than optimizing character count alone.

## 16. Interfaces

Primary AI interface:

```text
MCP
```

Additional interfaces:

```text
REST → API/dashboard
CLI  → manual/debug/fallback
Native adapters → provider-specific capabilities
```

Adapter model is hybrid:

```text
Universal interface
+
provider-specific capabilities
+
capability discovery
```

Capabilities can include:

```text
side_channel
pre_edit_hook
context_tool
live_events
```

## 17. IDE architecture

Initial IDE integration can target a VS Code-compatible extension.

```text
IDE Extension
├── agents
├── capsules
├── conflicts
├── handoffs
├── context
└── notifications/status
```

Local communication:

```text
HTTP → queries/commands
WebSocket → realtime
```

This solves a key limitation of CLI-only mechanisms: IDE-hosted agents do not necessarily support custom slash commands such as `/btw`.

## 18. Security

Before cloud synchronization:

```text
capture
 ↓
secret scanner
 ↓
redaction/block
 ↓
normalize
 ↓
sync
```

Defaults:

- `.env` excluded.
- Private keys excluded.
- Known secrets blocked/redacted.
- Workspace exclusions configurable.
- Sensitive upload can be made user-visible.

Authentication:

```text
User login → OAuth/session
Device      → registered credential
Runtime     → short-lived access token
API         → scoped credentials
```

Authorization:

```text
Users       → RBAC
Agents      → separate permissions
Devices     → registered/revocable
Repositories → isolated
Capsules    → visibility-controlled
```

## 19. Deployment

Modular monolith:

```text
Context Server
├── API
├── WebSocket
├── Workers
└── Retrieval
```

Infrastructure:

```text
Redis
PostgreSQL
Storage
```

The application remains one codebase initially, while infrastructure can scale independently.

## 20. Observability

Hybrid:

- Structured logs.
- Core metrics.
- Useful distributed traces.
- Product-specific metrics.

Track:

```text
event latency
sync failures
outbox backlog
WebSocket connections
conflicts
retrieval latency
context size/tokens
retrieval precision/recall
```
