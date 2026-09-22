# Global Context Workspace — Workflow Document

## 1. Normal working flow

```text
Developer opens IDE
        ↓
Context Runtime detects repository
        ↓
Runtime identifies/attaches AI session
        ↓
Session attaches to existing/new Capsule
        ↓
AI begins working
        ↓
Runtime captures events locally
        ↓
Events are normalized + filtered
        ↓
SQLite stores event + outbox entry
        ↓
Cloud receives event
        ↓
Live state updates
        ↓
Relevant teammates/agents receive updates
```

## 2. Two-agent simultaneous workflow

Example:

```text
Developer A / Laptop A
Agent A → payment/retry.ts

Developer B / Laptop B
Agent B → payment/retry.ts
```

Runtime A emits resource activity.

Cloud updates live state.

Runtime B receives a relevant update.

If B overlaps the resource:

```text
lease/conflict engine
        ↓
severity
        ↓
allow / warn / confirm / block
```

The purpose is to catch coordination conflicts while agents are working, not only after PR creation.

## 3. Session/capsule workflow

When an AI session starts:

1. Detect repository.
2. Authenticate device/runtime.
3. Identify provider/IDE/chat/session.
4. Find matching active capsule.
5. If no matching capsule exists, create one.
6. Attach session.
7. Establish realtime subscription.
8. Retrieve minimum relevant context.
9. Provide compiled context to the AI.

Capsule naming should use the native chat/working title where available.

## 4. Capture workflow

Capture supported activity:

```text
AI
├── prompts
├── responses
├── tool calls
├── tool results
└── lifecycle

IDE
├── file activity
├── terminal
└── workspace activity

Git
├── branch
├── checkout
├── commit
└── merge/rebase

System
├── commands
├── tests
└── errors
```

Everything is captured locally where possible.

The cloud does not receive all raw content by default.

## 5. Local-first workflow

```text
event
 ↓
normalize
 ↓
secret filter
 ↓
SQLite
 ↓
outbox
 ↓
cloud
```

This guarantees local durability before network synchronization.

## 6. Offline workflow

When disconnected:

```text
capture
 ↓
SQLite
 ↓
outbox
```

When connected:

```text
pending events
 ↓
ordered replay
 ↓
server acknowledgement
 ↓
mark acknowledged
```

Durable events replay.

Ephemeral activity is reconciled to current state rather than replaying every transient update.

## 7. Context promotion workflow

Raw capture is not automatically equivalent to durable shared memory.

```text
Raw Event
 ↓
Candidate extraction
 ↓
Classification by deterministic rules
 ↓
Candidate confidence
 ↓
Promotion
```

Examples:

### Explicit decision

```text
Agent says:
"We will use queue-based retry."

→ DECISION candidate
```

### File modification

```text
file changed
→ live STATE
```

### Test failure

```text
test failed
→ ERROR / TEST_RESULT
```

### TODO/mock

```text
TODO/mock/stub
→ PLACEHOLDER
```

### Uncertainty

```text
"I assume..."
→ ASSUMPTION
```

### Unresolved question

```text
"Should we..."
→ QUESTION
```

Important decisions/constraints may require confirmation before becoming canonical repository context.

## 8. Placeholder workflow

A placeholder must remain visibly a placeholder.

```text
placeholder detected
 ↓
PLACEHOLDER object
 ↓
resource + description + intended replacement
 ↓
visible to relevant agents
```

If another AI retrieves the resource, it receives the placeholder metadata so it does not assume the current value is real.

When replaced:

```text
PLACEHOLDER
 ↓
resolved
 ↓
replacement reference
 ↓
context updated
```

## 9. Handoff workflow

When an agent finishes or becomes idle:

```text
current work
 ↓
handoff object
```

Handoff includes:

```text
completed
remaining
next_step
blockers
placeholders
known_issues
summary
```

A new AI can retrieve the handoff rather than replaying the entire old chat.

## 10. Realtime update workflow

Not every event should interrupt an AI.

### Silent updates

Unrelated changes.

### Compact updates

Relevant but non-critical changes.

### Immediate alerts

Critical conflicts, blocking resource changes, or explicit high-priority events.

If the AI provider has a side channel:

```text
event → side channel
```

Otherwise:

```text
event → live state
       → IDE notification
       → next context opportunity
```

## 11. Retrieval workflow

```text
New AI task
 ↓
Determine scope
 ↓
Exact resource/task filters
 ↓
Relevant context objects
 ↓
Relations
 ↓
BM25 if needed
 ↓
Vector fallback if needed
 ↓
Reranking
 ↓
Context compiler
```

Never dump the whole workspace into an AI.

## 12. Context compiler workflow

```text
Task
 ↓
Hard-required context
 ↓
Critical live conflicts
 ↓
Decisions/constraints
 ↓
Placeholders/handoff
 ↓
Candidate ranking
 ↓
Budget check
 ↓
Redundancy removal
 ↓
Steno serialization
 ↓
AI
```

The objective is minimum sufficient context, not maximum context.

## 13. Conflict workflow

```text
Agent wants resource
 ↓
Check current leases
 ↓
No conflict?
 └─ acquire lease

Conflict?
 ↓
Calculate severity
 ↓
low      → allow
medium   → warn
high     → confirmation
critical → block
```

Lease remains alive through heartbeat and expires through TTL if the agent disappears.

## 14. Realtime synchronization workflow

```text
Local Event
 ↓
eventId
 ↓
clientSequence
 ↓
outbox
 ↓
WebSocket
 ↓
server validation
 ↓
deduplication
 ↓
serverSequence
 ↓
Redis live state
 ↓
PostgreSQL persistence
 ↓
broadcast to relevant clients
```

Server processing must be idempotent.

## 15. Retrieval correctness workflow

Every retrieval strategy is tested.

Metrics:

```text
precision
recall
relevant-context inclusion
irrelevant-context rate
latency
token cost
```

Production strategy is not chosen solely because it is theoretically sophisticated.

## 16. Provider workflow

At startup:

```text
Agent adapter
 ↓
capability discovery
```

Example:

```text
side_channel ✓
pre_edit_hook ✓
context_tool ✓
live_events ✗
```

The runtime adapts to available capabilities.

## 17. Security workflow

```text
Capture
 ↓
Known-secret detection
 ↓
Block/redact
 ↓
Local persistence
 ↓
Cloud sync
```

Private raw data remains local unless explicitly permitted by the sharing model.

## 18. End-to-end example

Agent A:

```text
"Implement payment retry using queue-based retry."
```

Runtime captures prompt.

Agent A edits:

```text
src/payment/retry.ts
```

Runtime creates live resource state.

Agent A declares intent:

```text
Move retry behavior to queue-based retry.
```

System creates/recommends INTENT.

Agent B starts a session in the same repository.

System finds:

```text
Agent A active
resource: src/payment/retry.ts
intent: queue-based retry
```

B receives compact relevant context.

If B attempts the same resource:

```text
conflict engine
→ warning/confirmation/block
```

Later A completes work.

System creates handoff:

```text
completed: queue retry implementation
remaining: integration test
placeholder: retry timeout still uses temporary value
next_step: replace temporary timeout
```

B's next AI session receives the handoff and placeholder instead of guessing from code alone.

## 19. Git workflow

Git remains the source of truth for code history.

The Context Workspace does not replace Git.

Instead:

```text
Git → code history
Context Workspace → reasoning/work coordination/context
```

PRs remain useful for code review, but the Workspace provides the missing reasoning context:

```text
why
intent
decision
constraints
placeholder
handoff
conflict history
```
