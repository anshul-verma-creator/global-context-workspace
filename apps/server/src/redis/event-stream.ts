import type { RedisClient } from './connection.js';
import { repoStreamKey, serverSequenceKey } from './connection.js';
import type { ContextEvent } from '@context-workspace/protocol';
import { createLogger } from '@context-workspace/shared';

const log = createLogger({ component: 'event-stream' });

/** Maximum events to keep per repository stream (MAXLEN ~ trim). */
const STREAM_MAX_LEN = 10_000;

/**
 * Publishes events to a Redis Stream for realtime delivery.
 *
 * Each repository has its own stream key:
 *   stream:repo:<repositoryId>
 *
 * The stream uses Redis auto-generated IDs (* = timestamp-seq).
 * Subscribers use XREAD/XREADGROUP to consume events.
 *
 * Server sequence is assigned atomically via INCR on a per-repository counter.
 * This guarantees monotonic ordering for each repository.
 */
export class EventStream {
  constructor(private readonly redis: RedisClient) {}

  /**
   * Publish an event to the repository stream.
   * Returns the assigned server sequence number.
   */
  async publish(event: ContextEvent): Promise<number> {
    const streamKey = repoStreamKey(event.repositoryId);
    const seqKey = serverSequenceKey(event.repositoryId);

    // Atomically increment server sequence
    const serverSeq = await this.redis.incr(seqKey);

    const enriched = { ...event, serverSequence: serverSeq };

    // XADD with MAXLEN ~ to keep stream bounded
    await this.redis.xadd(
      streamKey,
      'MAXLEN', '~', String(STREAM_MAX_LEN),
      '*',
      'event_id', event.eventId,
      'server_seq', String(serverSeq),
      'type', event.type,
      'repository_id', event.repositoryId,
      'capsule_id', event.capsuleId ?? '',
      'agent_id', event.agentId ?? '',
      'timestamp', String(event.timestamp),
      'payload', JSON.stringify(enriched),
    );

    log.debug('Event published to stream', {
      eventId: event.eventId,
      repositoryId: event.repositoryId,
      serverSeq: String(serverSeq),
    });

    return serverSeq;
  }

  /**
   * Read events from a repository stream since a given stream ID.
   * Use '0' to read from the beginning, '$' for new events only.
   */
  async read(
    repositoryId: string,
    since: string = '0',
    count: number = 100,
  ): Promise<{ streamId: string; event: ContextEvent }[]> {
    const streamKey = repoStreamKey(repositoryId);

    const results = await this.redis.xread(
      'COUNT', count,
      'STREAMS', streamKey, since,
    );

    if (results === null) return [];

    const entries: { streamId: string; event: ContextEvent }[] = [];

    for (const [, messages] of results) {
      for (const [streamId, fields] of messages) {
        // Fields are flat key-value pairs: ['event_id', '...', 'payload', '...']
        const fieldMap: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          const key = fields[i];
          const val = fields[i + 1];
          if (key !== undefined && val !== undefined) {
            fieldMap[key] = val;
          }
        }

        const payloadStr = fieldMap['payload'];
        if (payloadStr === undefined) continue;

        try {
          const event = JSON.parse(payloadStr) as ContextEvent;
          entries.push({ streamId, event });
        } catch {
          log.warn('Failed to parse stream event payload', { streamId });
        }
      }
    }

    return entries;
  }

  /**
   * Get the current server sequence for a repository.
   */
  async getCurrentSequence(repositoryId: string): Promise<number> {
    const seqKey = serverSequenceKey(repositoryId);
    const val = await this.redis.get(seqKey);
    return val !== null ? parseInt(val, 10) : 0;
  }

  /**
   * Get stream length for a repository.
   */
  async streamLength(repositoryId: string): Promise<number> {
    return this.redis.xlen(repoStreamKey(repositoryId));
  }
}
