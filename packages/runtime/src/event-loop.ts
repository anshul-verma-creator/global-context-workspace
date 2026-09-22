import type { ContextEvent } from '@context-workspace/protocol';
import type { EventsStore, OutboxStore } from '@context-workspace/database';
import { processEventThroughPipeline } from '@context-workspace/events';
import type { EventPipelineOptions } from '@context-workspace/events';
import { createLogger } from '@context-workspace/shared';

const log = createLogger({ component: 'event-loop' });

/**
 * Result of processing one event through the event loop.
 */
export interface EventLoopResult {
  eventId: string;
  stored: boolean;
  enqueued: boolean;
  action: 'allow' | 'block' | 'redact' | 'duplicate';
  reason?: string;
}

export interface EventLoopOptions {
  pipeline?: EventPipelineOptions;
}

/**
 * Local event loop — processes adapter events into persistent storage.
 *
 * Pipeline per spec §5 (Workflow):
 *   adapter event → secret filter → deduplicate → SQLite store → outbox
 *
 * Deduplication uses EventsStore.insertIdempotent() which does INSERT OR IGNORE,
 * so duplicate detection is handled atomically in SQLite — no separate cache needed.
 * Blocked events (secrets / excluded paths) are logged but never stored.
 * Redacted events are stored with redactions applied.
 */
export class EventLoop {
  private readonly eventStore: EventsStore;
  private readonly outboxStore: OutboxStore;
  private readonly pipelineOptions: EventPipelineOptions;

  constructor(
    eventStore: EventsStore,
    outboxStore: OutboxStore,
    options: EventLoopOptions = {},
  ) {
    this.eventStore = eventStore;
    this.outboxStore = outboxStore;
    this.pipelineOptions = options.pipeline ?? {};
  }

  /**
   * Process a single adapter event through the full pipeline.
   */
  processEvent(event: ContextEvent): EventLoopResult {
    // Stage 1: Secret filter
    const pipelineResult = processEventThroughPipeline(event, this.pipelineOptions);

    if (pipelineResult.action === 'block') {
      log.warn('Event blocked', { eventId: event.eventId, reason: pipelineResult.reason });
      return {
        eventId: event.eventId,
        stored: false,
        enqueued: false,
        action: 'block',
        ...(pipelineResult.reason !== undefined ? { reason: pipelineResult.reason } : {}),
      };
    }

    const processedEvent = pipelineResult.event;

    // Stage 2+3: Atomic deduplicated insert (INSERT OR IGNORE) + outbox enqueue
    try {
      const inserted = this.eventStore.insertIdempotent(processedEvent);

      if (!inserted) {
        log.debug('Duplicate event ignored', { eventId: processedEvent.eventId });
        return {
          eventId: processedEvent.eventId,
          stored: false,
          enqueued: false,
          action: 'duplicate',
          reason: 'event ID already exists',
        };
      }

      // Enqueue for cloud sync only after successful insert
      this.outboxStore.enqueue(processedEvent.eventId);

      log.debug('Event stored', {
        eventId: processedEvent.eventId,
        type: processedEvent.type,
        action: pipelineResult.action,
      });

      return {
        eventId: processedEvent.eventId,
        stored: true,
        enqueued: true,
        action: pipelineResult.action,
      };
    } catch (err) {
      log.error('Event storage failed', { eventId: processedEvent.eventId, error: String(err) });
      throw err;
    }
  }

  /**
   * Process a batch of events, continuing on individual failures.
   */
  processBatch(events: ContextEvent[]): EventLoopResult[] {
    return events.map((event) => {
      try {
        return this.processEvent(event);
      } catch (err) {
        return {
          eventId: event.eventId,
          stored: false,
          enqueued: false,
          action: 'block' as const,
          reason: `Storage error: ${String(err)}`,
        };
      }
    });
  }
}
