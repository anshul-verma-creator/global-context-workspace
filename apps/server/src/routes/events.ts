import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { PgEventsStore } from '../db/pg-events-store.js';
import type { EventStream } from '../redis/event-stream.js';
import { processEventThroughPipeline } from '@context-workspace/events';
import { createLogger } from '@context-workspace/shared';

const log = createLogger({ component: 'events-route' });

const IngestBodySchema = z.object({
  events: z.array(z.record(z.unknown())).min(1).max(100),
});

interface EventsRouteOptions {
  eventsStore: PgEventsStore;
  eventStream: EventStream;
}

/**
 * POST /api/v1/events
 *
 * Ingest a batch of events from a local runtime.
 *
 * Pipeline:
 * 1. Validate body
 * 2. Secret filter each event
 * 3. Insert idempotently into PostgreSQL
 * 4. Publish to Redis stream (assigns server sequence)
 * 5. Return results array
 */
export const eventsRoute: FastifyPluginAsync<EventsRouteOptions> = async (fastify, opts) => {
  fastify.post('/api/v1/events', async (request, reply) => {
    const body = IngestBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: body.error.flatten() });
    }

    const results: { eventId: string; status: 'stored' | 'duplicate' | 'blocked' }[] = [];

    for (const rawEvent of body.data.events) {
      const eventId = rawEvent['eventId'] as string | undefined;
      if (typeof eventId !== 'string') {
        results.push({ eventId: '?', status: 'blocked' });
        continue;
      }

      // Secret filter
      const filterResult = processEventThroughPipeline(rawEvent as any, {});
      if (filterResult.action === 'block') {
        log.warn('Event blocked at server', { eventId, reason: filterResult.reason });
        results.push({ eventId, status: 'blocked' });
        continue;
      }

      const event = filterResult.event;

      try {
        const inserted = await opts.eventsStore.insertIdempotent(event);

        if (!inserted) {
          results.push({ eventId, status: 'duplicate' });
          continue;
        }

        // Publish to Redis for realtime delivery
        await opts.eventStream.publish(event);
        results.push({ eventId, status: 'stored' });
      } catch (err) {
        log.error('Failed to store event', { eventId, error: String(err) });
        return reply.status(500).send({ error: 'Storage error', eventId });
      }
    }

    return reply.status(207).send({ results });
  });

  /**
   * GET /api/v1/events?repositoryId=&since=&limit=
   *
   * List events for a repository since a timestamp.
   */
  fastify.get('/api/v1/events', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const repositoryId = query['repositoryId'];
    const since = query['since'] !== undefined ? parseInt(query['since'], 10) : 0;
    const limit = query['limit'] !== undefined ? parseInt(query['limit'], 10) : 100;

    if (typeof repositoryId !== 'string') {
      return reply.status(400).send({ error: 'repositoryId required' });
    }

    const events = await opts.eventsStore.listByRepository(repositoryId, { since, limit });
    return reply.send({ events, count: events.length });
  });
};
