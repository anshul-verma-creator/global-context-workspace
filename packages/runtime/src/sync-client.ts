import type { EventsStore, OutboxStore, StoredEvent } from '@context-workspace/database';
import type { ContextEvent } from '@context-workspace/protocol';
import { createLogger } from '@context-workspace/shared';

const log = createLogger({ component: 'sync-client' });

export function storedEventToContextEvent(stored: StoredEvent): ContextEvent {
  return {
    eventId: stored.eventId,
    protocolVersion: 1,
    workspaceId: 'ws_default',
    userId: 'user_default',
    deviceId: 'device_default',
    type: stored.type as any,
    source: stored.source as any,
    visibility: stored.visibility as any,
    repositoryId: stored.repositoryId,
    ...(stored.capsuleId !== undefined ? { capsuleId: stored.capsuleId } : {}),
    ...(stored.sessionId !== undefined ? { sessionId: stored.sessionId } : {}),
    clientSequence: stored.clientSequence,
    ...(stored.serverSequence !== undefined ? { serverSequence: stored.serverSequence } : {}),
    timestamp: stored.timestamp,
    payload: stored.payload as any,
  };
}

export interface SyncResultItem {
  eventId: string;
  status: 'stored' | 'duplicate' | 'blocked';
}

export interface SyncBatchResult {
  results: SyncResultItem[];
}

export interface SyncClientConfig {
  serverUrl: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * SyncClient — Handles network communication between local runtime and Cloud Context Server.
 */
export class SyncClient {
  private readonly serverUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private _online = true;

  constructor(config: SyncClientConfig) {
    this.serverUrl = config.serverUrl.replace(/\/$/, '');
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  get isOnline(): boolean {
    return this._online;
  }

  setOnline(online: boolean): void {
    this._online = online;
    log.info('SyncClient online status changed', { online: String(online) });
  }

  /**
   * Send a batch of events to the cloud server.
   */
  async sendBatch(events: ContextEvent[]): Promise<SyncBatchResult> {
    if (!this._online) {
      throw new Error('SyncClient is offline: network unavailable');
    }

    if (events.length === 0) {
      return { results: [] };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await this.fetchFn(`${this.serverUrl}/api/v1/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
        signal: controller.signal,
      });

      if (!resp.ok && resp.status !== 207) {
        throw new Error(`Sync server responded with HTTP ${resp.status}: ${await resp.text()}`);
      }

      const data = (await resp.json()) as SyncBatchResult;
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch events from the server since a given timestamp.
   */
  async fetchRemoteEvents(
    repositoryId: string,
    options: { since?: number; limit?: number } = {},
  ): Promise<ContextEvent[]> {
    if (!this._online) {
      throw new Error('SyncClient is offline: network unavailable');
    }

    const since = options.since ?? 0;
    const limit = options.limit ?? 100;
    const url = `${this.serverUrl}/api/v1/events?repositoryId=${encodeURIComponent(repositoryId)}&since=${since}&limit=${limit}`;

    const resp = await this.fetchFn(url);
    if (!resp.ok) {
      throw new Error(`Failed to fetch remote events: HTTP ${resp.status}`);
    }

    const data = (await resp.json()) as { events: ContextEvent[]; count: number };
    return data.events;
  }

  /**
   * Fetch current live state from the server.
   */
  async fetchLiveState(repositoryId: string): Promise<Record<string, unknown>> {
    if (!this._online) {
      throw new Error('SyncClient is offline: network unavailable');
    }

    const resp = await this.fetchFn(`${this.serverUrl}/api/v1/live/${encodeURIComponent(repositoryId)}/state`);
    if (!resp.ok) {
      throw new Error(`Failed to fetch live state: HTTP ${resp.status}`);
    }

    const data = (await resp.json()) as { repositoryId: string; state: Record<string, unknown> };
    return data.state;
  }
}

export interface SyncSummary {
  processed: number;
  stored: number;
  duplicate: number;
  blocked: number;
  failed: number;
}

/**
 * OfflineSynchronizer — Implements Phase 8 Offline Synchronization:
 * - Drains SQLite outbox
 * - Retries with exponential backoff on network failure
 * - Deduplicates / idempotently acknowledges events
 * - Reconciles latest state upon reconnect without event loss or duplication
 */
export class OfflineSynchronizer {
  private readonly eventsStore: EventsStore;
  private readonly outboxStore: OutboxStore;
  private readonly client: SyncClient;

  constructor(eventsStore: EventsStore, outboxStore: OutboxStore, client: SyncClient) {
    this.eventsStore = eventsStore;
    this.outboxStore = outboxStore;
    this.client = client;
  }

  /**
   * Drain pending outbox entries and sync to cloud server.
   * Handles idempotency, duplicate protection, network drop & exponential backoff.
   */
  async sync(batchSize = 50): Promise<SyncSummary> {
    const entries = this.outboxStore.getPendingEntries(batchSize);
    if (entries.length === 0) {
      return { processed: 0, stored: 0, duplicate: 0, blocked: 0, failed: 0 };
    }

    // Mark all as processing
    for (const entry of entries) {
      this.outboxStore.markProcessing(entry.eventId);
    }

    // Collect corresponding events
    const eventsToSend: ContextEvent[] = [];
    const missingIds: string[] = [];

    for (const entry of entries) {
      const stored = this.eventsStore.getById(entry.eventId);
      if (stored !== undefined) {
        eventsToSend.push(storedEventToContextEvent(stored));
      } else {
        missingIds.push(entry.eventId);
      }
    }

    // Acknowledge any missing local events to avoid deadlocks
    for (const id of missingIds) {
      this.outboxStore.acknowledge(id);
    }

    let batchResult: SyncBatchResult;
    try {
      batchResult = await this.client.sendBatch(eventsToSend);
    } catch (err) {
      // Network failed / offline: record failure for each entry (schedules exponential backoff)
      log.warn('Outbox sync failed, recording failures for retry', {
        error: String(err),
        count: String(eventsToSend.length),
      });

      for (const ev of eventsToSend) {
        this.outboxStore.recordFailure(ev.eventId);
      }

      return {
        processed: entries.length,
        stored: 0,
        duplicate: 0,
        blocked: 0,
        failed: eventsToSend.length,
      };
    }

    let storedCount = 0;
    let dupCount = 0;
    let blockedCount = 0;

    for (const item of batchResult.results) {
      if (item.status === 'stored') {
        this.outboxStore.acknowledge(item.eventId);
        storedCount++;
      } else if (item.status === 'duplicate') {
        // Server already has it durably: acknowledge locally (idempotent fulfillment)
        this.outboxStore.acknowledge(item.eventId);
        dupCount++;
      } else if (item.status === 'blocked') {
        // Event was blocked by server security filter: mark acknowledged to avoid infinite loop
        this.outboxStore.acknowledge(item.eventId);
        blockedCount++;
      }
    }

    return {
      processed: entries.length,
      stored: storedCount,
      duplicate: dupCount,
      blocked: blockedCount,
      failed: 0,
    };
  }

  /**
   * Reset retry timers and sync immediately (e.g. upon client reconnect).
   */
  async reconnectAndSync(batchSize = 50): Promise<SyncSummary> {
    this.outboxStore.resetPendingRetries();
    return this.sync(batchSize);
  }

  /**
   * Reconcile latest state on reconnect:
   * Fetches missing remote events from server and idempotently stores them locally.
   */
  async reconcile(
    repositoryId: string,
    sinceTimestamp = 0,
  ): Promise<{ fetched: number; newlyInserted: number }> {
    const remoteEvents = await this.client.fetchRemoteEvents(repositoryId, { since: sinceTimestamp });

    let newlyInserted = 0;
    for (const event of remoteEvents) {
      const inserted = this.eventsStore.insertIdempotent(event);
      if (inserted) {
        newlyInserted++;
      }
    }

    log.info('Reconciliation complete', {
      repositoryId,
      fetched: String(remoteEvents.length),
      newlyInserted: String(newlyInserted),
    });

    return { fetched: remoteEvents.length, newlyInserted };
  }
}
