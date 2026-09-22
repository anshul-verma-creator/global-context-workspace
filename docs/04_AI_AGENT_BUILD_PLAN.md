# Global Context Workspace — AI Agent Build Plan

## Instructions to the coding AI

You are building the Global Context Workspace described by the accompanying architecture, workflow, and technical specification documents.

Build the entire system through the phases below.

Important rules:

1. Complete phases in order.
2. Do not skip a phase.
3. Do not silently redesign locked architecture decisions.
4. Read all project documents before coding.
5. Keep interfaces modular so later infrastructure can be swapped.
6. Do not add an LLM/AI memory-extraction service.
7. Preserve repository isolation.
8. Preserve local-first raw capture.
9. Do not upload raw data to cloud unless the sharing rules allow it.
10. Run tests after every phase.
11. Do not declare a phase complete until its acceptance criteria pass.
12. Maintain `docs/BUILD_STATUS.md` with:
   - current phase
   - completed work
   - tests run
   - known issues
   - next step
13. If a requirement is genuinely ambiguous, document the ambiguity and choose the least destructive implementation rather than silently changing architecture.
14. Never remove functionality from a previous completed phase without recording the reason.
15. Keep all protocol/schema changes versioned.

---

# Phase 0 — Project foundation

Build:

```text
monorepo
apps/
packages/
infra/
tests/
docs/
```

Set up:

- TypeScript
- Node.js
- pnpm workspace
- linting
- formatting
- unit test framework
- integration test framework
- environment configuration
- Docker development environment

Acceptance:

- clean install works
- all packages compile
- tests execute
- Docker development environment starts

---

# Phase 1 — Protocol package

Implement:

- ContextEvent
- EventType
- visibility
- sources
- large-content references
- API DTOs
- protocol versioning
- validation

Acceptance:

- invalid events rejected
- valid events serialize/deserialize
- protocol tests pass

---

# Phase 2 — Local SQLite runtime

Implement:

- repository discovery
- SQLite database
- migrations
- repositories
- capsules
- sessions
- events
- outbox
- context objects
- relations

Use WAL mode.

Acceptance:

- create repository
- create capsule
- create session
- write event
- retrieve event by ID
- retrieve session events efficiently
- outbox survives process restart

---

# Phase 3 — Raw chunk storage

Implement:

- append-only binary chunks
- length-prefixed records
- chunk rotation
- SHA-256 integrity
- offset/length index
- rawRef lookup

Acceptance:

```text
write raw
→ retrieve raw
→ restart runtime
→ retrieve raw
```

must work without scanning the entire history.

---

# Phase 4 — Event normalization

Implement adapters/interfaces for:

- filesystem
- Git
- terminal
- generic agent events

Normalize all input into ContextEvent.

Acceptance:

Different event sources produce the same canonical event structure.

---

# Phase 5 — Secret filtering

Implement deterministic security filtering.

Default exclusions:

```text
.env
private keys
known credentials
secret/token patterns
```

Support workspace configuration.

Acceptance:

- known test secrets are blocked/redacted
- excluded files are never uploaded
- safe content continues normally

---

# Phase 6 — Cloud Context Server

Implement:

- modular monolith
- REST API
- authentication abstraction
- repository authorization
- PostgreSQL
- migrations
- event ingestion
- event persistence

Acceptance:

Local runtime can send an event and retrieve it from cloud storage.

---

# Phase 7 — Redis realtime system

Implement:

- Redis connection
- event streams
- live state
- subscriptions
- server sequence assignment
- realtime broadcast

Acceptance:

Two runtime clients receive relevant live events without polling.

---

# Phase 8 — Offline synchronization

Implement:

```text
SQLite outbox
→ retry
→ exponential backoff
→ acknowledgement
→ replay
```

Implement:

- idempotency
- duplicate protection
- sequence handling
- reconnect
- latest-state reconciliation

Acceptance:

Disconnect a client, generate events, reconnect, and verify no durable event is lost or duplicated.

---

# Phase 9 — Capsules and session attachment

Implement:

- repository detection
- session discovery
- capsule creation
- capsule matching
- native chat/session naming
- capsule lifecycle
- capsule relationships

Acceptance:

Multiple AI sessions in the same repository can exist simultaneously without mixing their session identity.

---

# Phase 10 — Live repository state

Implement:

- active agents
- active sessions
- current resources
- current tasks
- presence
- materialized state
- state rebuild from events

Acceptance:

Delete/rebuild materialized state and reproduce correct state from durable events.

---

# Phase 11 — Lease/conflict engine

Implement:

- resource normalization
- leases
- heartbeat
- TTL
- release
- conflict severity
- conflict events

Acceptance:

Two simulated agents attempting the same resource generate the expected conflict behavior.

---

# Phase 12 — Context objects

Implement all required types:

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

Implement:

- provenance
- authority
- status
- validity periods
- versioning
- relations
- supersession

Acceptance:

A decision can be created, retrieved, related to resources, superseded, and traced to its source event.

---

# Phase 13 — Deterministic context promotion

Implement candidate extraction without an LLM.

Rules for:

- decisions
- intents
- errors
- tests
- placeholders
- assumptions
- questions
- handoffs

Important decisions/constraints must support confirmation.

Acceptance:

Synthetic test events produce correct candidates.

---

# Phase 14 — Placeholder system

Implement hybrid detection:

```text
explicit markers
+
static/code signals
+
agent declaration
```

Implement placeholder lifecycle:

```text
candidate
active
confirmed
resolved
rejected
```

Acceptance:

An AI retrieving a placeholder receives its placeholder status and intended replacement rather than treating placeholder data as authoritative.

---

# Phase 15 — Handoff system

Implement structured handoffs:

```text
completed
remaining
next_step
blockers
placeholders
known_issues
summary
links
```

Acceptance:

Agent A can finish work and Agent B can retrieve a compact handoff.

---

# Phase 16 — Retrieval engine

Implement in order:

```text
scope/filter
→ exact indexes
→ graph relations
→ PostgreSQL FTS/BM25
→ pgvector
→ reranking
```

Implement retrieval telemetry.

Acceptance:

A test dataset has known relevant context and retrieval metrics can be measured.

---

# Phase 17 — Retrieval evaluation

Create benchmark datasets covering:

- file-specific questions
- task-specific questions
- decision retrieval
- historical reasoning
- placeholders
- handoffs
- cross-session context
- irrelevant context

Measure:

```text
precision
recall
relevant-context inclusion
irrelevant-context rate
latency
token cost
```

Do not promote a retrieval method to production solely because it is theoretically useful.

Acceptance:

Benchmark results are reproducible.

---

# Phase 18 — Context compiler

Implement:

```text
hard-required context
→ priority tiers
→ scoring
→ token budget
→ redundancy removal
```

Implement:

- hard maximum
- dynamic budget
- provider-aware token estimation where possible
- omission reporting

Acceptance:

Compiler never exceeds its configured maximum and prioritizes critical context.

---

# Phase 19 — Context Steno

Implement:

- canonical Steno grammar
- parser
- serializer
- dictionary
- alias lifecycle
- versioning
- provider serializer interface

Rules:

- optimize tokens, not characters
- avoid invented rare codes
- natural language remains valid fallback
- alias only repeated useful entities

Acceptance:

Round-trip tests:

```text
structured context
→ Steno
→ structured context
```

must preserve meaning/fields.

Also run tokenizer benchmarks on representative production tokenizer(s) where available.

---

# Phase 20 — MCP server

Implement:

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

Acceptance:

A supported AI client can query relevant context through MCP.

---

# Phase 21 — Agent adapter framework

Implement:

- universal AgentAdapter
- capability discovery
- session discovery
- event capture
- optional context injection
- optional live updates

Start with the easiest reliable provider/IDE integration available in the development environment.

Do not pretend unsupported provider capabilities exist.

Acceptance:

One real agent/IDE integration produces events and can retrieve context.

---

# Phase 22 — IDE extension

Implement:

```text
agents
capsules
conflicts
handoffs
context
notifications/status
```

Implement local HTTP/WebSocket connection.

Acceptance:

Developer can see live agent activity and conflicts from the IDE.

---

# Phase 23 — Authentication and authorization

Implement:

- OAuth/session abstraction
- device registration
- short-lived runtime tokens
- scoped API credentials
- RBAC
- repository isolation
- capsule visibility
- device revocation

Acceptance:

Unauthorized clients cannot read another repository.

---

# Phase 24 — Observability

Implement:

- structured logs
- request IDs
- event IDs
- workspace/repo/capsule/session correlation
- metrics
- tracing where useful

Track:

```text
event latency
sync failures
outbox backlog
WebSocket connections
conflicts
retrieval latency
context tokens
precision/recall
```

Acceptance:

A complete event can be traced from local capture to cloud persistence and client delivery.

---

# Phase 25 — End-to-end multi-agent test

Simulate:

```text
Laptop A
Agent A
        ↓
same repository

Laptop B
Agent B
        ↓
same repository
```

Scenario:

1. Agent A starts a task.
2. Agent A modifies a file.
3. Agent A declares an intent.
4. Agent B starts another session.
5. B receives relevant live context.
6. B attempts overlapping work.
7. Conflict is detected.
8. A creates a decision.
9. A creates a handoff.
10. B retrieves the decision/handoff.
11. Placeholder is visible.
12. B continues without needing the original chat.

Acceptance:

The entire workflow works without manual copying of context between agents.

---

# Phase 26 — Failure/recovery tests

Test:

- network loss
- server restart
- Redis restart
- PostgreSQL restart
- runtime crash
- duplicate events
- out-of-order events
- expired leases
- stale sessions
- corrupted raw chunk
- invalid event
- unauthorized repository access

Acceptance:

No durable context loss and no cross-repository leakage.

---

# Phase 27 — Performance benchmarks

Benchmark:

```text
local event write
raw lookup
outbox throughput
cloud ingestion
realtime latency
retrieval latency
context compilation
Steno serialization
```

Run with realistic multi-agent event volumes.

Record baseline results.

---

# Phase 28 — Security audit

Review:

- auth
- authorization
- repository isolation
- secret filtering
- local storage permissions
- cloud encryption
- token expiration
- device revocation
- WebSocket authorization
- MCP authorization
- auditability

Fix critical findings before release.

---

# Phase 29 — Production packaging

Implement:

- Docker images
- production configuration
- database migrations
- Redis configuration
- health endpoints
- readiness/liveness
- backup strategy
- logging
- deployment documentation

Acceptance:

A clean environment can deploy the system from documented instructions.

---

# Phase 30 — Final acceptance

Verify:

```text
Global Workspace
    ↓
isolated repositories
    ↓
capsules
    ↓
sessions
    ↓
local capture
    ↓
realtime sync
    ↓
live shared state
    ↓
conflict detection
    ↓
context objects
    ↓
retrieval
    ↓
minimum-context compiler
    ↓
Steno
    ↓
AI/IDE
```

Final acceptance requires:

- multi-user support
- multi-agent support
- repository isolation
- realtime updates
- offline recovery
- conflict detection
- placeholder awareness
- handoffs
- deterministic capture/promotion
- retrieval evaluation
- context budget enforcement
- MCP
- IDE integration
- authentication/authorization
- observability
- end-to-end tests
- documented deployment

---

# Agent Completion Rule

Do not respond with "done" after merely writing files.

For each phase:

```text
IMPLEMENT
↓
TEST
↓
FIX
↓
RUN ACCEPTANCE CHECK
↓
UPDATE docs/BUILD_STATUS.md
↓
COMMIT/record changes
↓
MOVE TO NEXT PHASE
```

At the end of every phase report:

```text
Phase:
Status:
Implemented:
Tests:
Failures:
Known limitations:
Next phase:
```

If a test fails, fix it before proceeding unless the failure is explicitly documented as an external/environment limitation.

## Final principle

The system is not a shared chat history.

It is:

```text
Global Workspace
+
isolated repository state
+
real-time agent coordination
+
durable reasoning/context
+
minimum-context retrieval
```

The goal is that a new AI joining an active repository can understand **what is happening, why it is happening, what is already decided, what is temporary, what is blocked, and what it should do next — without receiving the entire historical context.**
