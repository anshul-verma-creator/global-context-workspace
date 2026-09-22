import type { FastifyPluginAsync } from 'fastify';
import type { EventStream } from '../redis/event-stream.js';
import type { LiveStateManager } from '../redis/live-state.js';
import { createLogger } from '@context-workspace/shared';

const log = createLogger({ component: 'realtime-route' });

interface RealtimeRouteOptions {
  eventStream: EventStream;
  liveState: LiveStateManager;
}

/**
 * GET /api/v1/live/:repositoryId/state
 *
 * Return the current live state for a repository (agents, sessions, resources, conflicts).
 */
export const realtimeRoute: FastifyPluginAsync<RealtimeRouteOptions> = async (fastify, opts) => {
  // Live state endpoint
  fastify.get('/api/v1/live/:repositoryId/state', async (request, reply) => {
    const { repositoryId } = request.params as { repositoryId: string };
    const state = await opts.liveState.getAll(repositoryId);
    return reply.send({ repositoryId, state });
  });

  /**
   * GET /api/v1/live/:repositoryId/stream?since=<streamId>
   *
   * Poll events from the Redis stream since a given stream cursor.
   * Use '0' for all, '$' for new only.
   *
   * This is the fallback for clients that cannot maintain a WebSocket.
   */
  fastify.get('/api/v1/live/:repositoryId/stream', async (request, reply) => {
    const { repositoryId } = request.params as { repositoryId: string };
    const query = request.query as Record<string, string>;
    const since = query['since'] ?? '0';
    const count = query['count'] !== undefined ? parseInt(query['count'], 10) : 50;

    const entries = await opts.eventStream.read(repositoryId, since, count);

    return reply.send({
      repositoryId,
      events: entries.map((e) => ({ streamId: e.streamId, event: e.event })),
      count: entries.length,
      lastStreamId: entries.length > 0 ? entries[entries.length - 1]!.streamId : since,
    });
  });

  /**
   * WebSocket /api/v1/live/:repositoryId/ws
   *
   * Real-time event subscription via WebSocket.
   * Client sends { repositoryId, since? } on connect.
   * Server pushes events from the Redis stream as they arrive.
   *
   * Protocol:
   * - On connect: start polling stream from 'since' (default: current position)
   * - Every 500ms: check for new events, send each as JSON message
   * - On disconnect: stop polling
   */
  fastify.get('/api/v1/live/:repositoryId/ws', { websocket: true }, (socket, request) => {
    const { repositoryId } = request.params as { repositoryId: string };
    let lastStreamId = '$';
    let polling = true;

    log.info('WebSocket client connected', { repositoryId });

    // Handle client messages (client can send { since: '<streamId>' } to set cursor)
    socket.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as { since?: string };
        if (msg.since !== undefined) {
          lastStreamId = msg.since;
        }
      } catch {
        // Ignore non-JSON
      }
    });

    // Poll the stream and push to client
    const poll = async (): Promise<void> => {
      while (polling) {
        try {
          const entries = await opts.eventStream.read(repositoryId, lastStreamId, 50);
          for (const entry of entries) {
            socket.send(JSON.stringify({ streamId: entry.streamId, event: entry.event }));
            lastStreamId = entry.streamId;
          }
        } catch (err) {
          log.warn('Stream poll error', { repositoryId, error: String(err) });
        }

        // 500ms between polls
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    };

    socket.on('close', () => {
      polling = false;
      log.info('WebSocket client disconnected', { repositoryId });
    });

    void poll();
  });
};
