import type { EventsStore, OutboxStore } from '@context-workspace/database';
import { computeNextRetryAt } from '@context-workspace/database';
import { createLogger } from '@context-workspace/shared';

const log = createLogger({ component: 'outbox-processor' });

/**
 * Delivery function — attempts to send one event to the cloud.
 * Returns true on success, false on failure.
 * The runtime wires in a real HTTP client; tests inject a stub.
 */
export type DeliverFn = (eventId: string) => Promise<boolean>;

export interface OutboxProcessorOptions {
  /** Maximum events to process per drain cycle. Default: 50 */
  batchSize?: number;
  /** How long to wait between drain cycles in ms. Default: 5000 */
  intervalMs?: number;
}

/**
 * Outbox processor — drains the outbox queue with exponential backoff.
 *
 * Per spec §8 (Architecture):
 * - Reads pending outbox entries
 * - Attempts delivery via DeliverFn
 * - On success: marks acknowledged
 * - On failure: increments attempts, schedules retry with exponential backoff
 * - After 20 attempts: marks failed (permanent)
 *
 * The processor is deliberately simple: it is a pull-based batch worker, not
 * a push-based real-time streamer. Real-time sync is handled by the cloud
 * Redis layer (Phase 7 in the build plan).
 *
 * Call start() to begin automatic draining.
 * Call stop() to halt it gracefully.
 * Call drain() manually for testing or on-demand sync.
 */
export class OutboxProcessor {
  private readonly eventStore: EventsStore;
  private readonly outboxStore: OutboxStore;
  private readonly deliver: DeliverFn;
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;

  constructor(
    eventStore: EventsStore,
    outboxStore: OutboxStore,
    deliver: DeliverFn,
    options: OutboxProcessorOptions = {},
  ) {
    this.eventStore = eventStore;
    this.outboxStore = outboxStore;
    this.deliver = deliver;
    this.batchSize = options.batchSize ?? 50;
    this.intervalMs = options.intervalMs ?? 5_000;
  }

  /**
   * Start automatic periodic draining.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Recover any in-flight entries from a previous crash
    const recovered = this.outboxStore.resetProcessingEntries();
    if (recovered > 0) {
      log.info('Recovered in-flight outbox entries', { count: String(recovered) });
    }

    this._scheduleNext();
    log.info('Outbox processor started', { intervalMs: String(this.intervalMs) });
  }

  /**
   * Stop the processor. Waits for the current drain to finish naturally.
   */
  stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    log.info('Outbox processor stopped');
  }

  /**
   * Drain one batch of pending outbox entries immediately.
   * Can be called manually regardless of whether the processor is running.
   */
  async drain(): Promise<{ processed: number; succeeded: number; failed: number }> {
    const entries = this.outboxStore.getPendingEntries(this.batchSize);

    let succeeded = 0;
    let failed = 0;

    for (const entry of entries) {
      // Mark as processing to prevent concurrent workers picking the same entry
      this.outboxStore.markProcessing(entry.eventId);

      try {
        const ok = await this.deliver(entry.eventId);

        if (ok) {
          this.outboxStore.acknowledge(entry.eventId);
          succeeded++;
          log.debug('Event delivered', { eventId: entry.eventId, attempts: String(entry.attempts + 1) });
        } else {
          this.outboxStore.recordFailure(entry.eventId);
          failed++;
          log.warn('Event delivery failed, will retry', {
            eventId: entry.eventId,
            attempts: String(entry.attempts + 1),
          });
        }
      } catch (err) {
        // Delivery threw — treat as failure
        this.outboxStore.recordFailure(entry.eventId);
        failed++;
        log.warn('Event delivery threw, will retry', {
          eventId: entry.eventId,
          error: String(err),
        });
      }
    }

    log.debug('Outbox drain complete', {
      processed: String(entries.length),
      succeeded: String(succeeded),
      failed: String(failed),
      pending: String(this.outboxStore.countPending()),
    });

    return { processed: entries.length, succeeded, failed };
  }

  private _scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.drain().finally(() => this._scheduleNext());
    }, this.intervalMs);
  }
}
