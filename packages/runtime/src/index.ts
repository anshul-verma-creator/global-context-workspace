/**
 * @context-workspace/runtime
 *
 * Local runtime — session lifecycle, event loop, outbox processor,
 * and context assembly for the Global Context Workspace.
 *
 * Pipeline (per spec §5, §9, §16-18):
 *   adapter event
 *     → EventLoop (secret filter → dedup → SQLite → outbox)
 *     → OutboxProcessor (retry + exponential backoff → cloud sync)
 *     → RuntimeContextAssembler (retrieval → compile → Steno)
 *     → agent injection
 */

export * from './runtime.js';
export * from './session-manager.js';
export * from './event-loop.js';
export * from './outbox-processor.js';
export * from './runtime-context.js';
export * from './sync-client.js';
export * from './placeholders.js';
export * from './handoffs.js';
