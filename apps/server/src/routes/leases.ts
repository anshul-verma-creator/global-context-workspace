import type { FastifyPluginAsync } from 'fastify';
import type { LeaseEngine } from '../leases/lease-engine.js';
import { z } from 'zod';

const AcquireSchema = z.object({
  repositoryId: z.string(),
  resource: z.string().min(1),
  holderId: z.string(),
  holderType: z.enum(['agent', 'session', 'user']),
  sessionId: z.string().optional(),
  ttlMs: z.number().int().min(1000).max(300_000).optional(),
});

interface LeasesRouteOptions {
  leaseEngine: LeaseEngine;
}

/**
 * Lease management routes.
 *
 * POST   /api/v1/leases          — acquire a lease (may return conflict)
 * POST   /api/v1/leases/:id/renew — renew a lease
 * DELETE /api/v1/leases/:id      — release a lease
 * GET    /api/v1/leases?repositoryId=  — list active leases
 */
export const leasesRoute: FastifyPluginAsync<LeasesRouteOptions> = async (fastify, opts) => {
  // Acquire
  fastify.post('/api/v1/leases', async (request, reply) => {
    const body = AcquireSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'Invalid body', details: body.error.flatten() });
    }

    const parsed = body.data;
    const result = await opts.leaseEngine.acquire({
      repositoryId: parsed.repositoryId,
      resource: parsed.resource,
      holderId: parsed.holderId,
      holderType: parsed.holderType,
      ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
      ...(parsed.ttlMs !== undefined ? { ttlMs: parsed.ttlMs } : {}),
    });

    // Lease granted
    if ('id' in result) {
      return reply.status(201).send({ lease: result });
    }

    // Conflict
    return reply.status(409).send({ conflict: result });
  });

  // Renew
  fastify.post('/api/v1/leases/:id/renew', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { ttlMs?: number } | null;

    const lease = await opts.leaseEngine.renew(id, body?.ttlMs);
    if (lease === undefined) {
      return reply.status(404).send({ error: 'Lease not found or already expired' });
    }
    return reply.send({ lease });
  });

  // Release
  fastify.delete('/api/v1/leases/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { holderId?: string };
    const holderId = query['holderId'];

    if (typeof holderId !== 'string') {
      return reply.status(400).send({ error: 'holderId query param required' });
    }

    const released = await opts.leaseEngine.release(id, holderId);
    if (!released) {
      return reply.status(404).send({ error: 'Lease not found, not active, or wrong holder' });
    }
    return reply.status(204).send();
  });

  // List active
  fastify.get('/api/v1/leases', async (request, reply) => {
    const query = request.query as { repositoryId?: string };
    const repositoryId = query['repositoryId'];

    if (typeof repositoryId !== 'string') {
      return reply.status(400).send({ error: 'repositoryId required' });
    }

    const leases = await opts.leaseEngine.listActive(repositoryId);
    return reply.send({ leases, count: leases.length });
  });

  // Get active lease for a resource
  fastify.get('/api/v1/leases/resource', async (request, reply) => {
    const query = request.query as { repositoryId?: string; resource?: string };
    const { repositoryId, resource } = query;

    if (typeof repositoryId !== 'string' || typeof resource !== 'string') {
      return reply.status(400).send({ error: 'repositoryId and resource required' });
    }

    const lease = await opts.leaseEngine.getActiveLease(repositoryId, resource);
    if (lease === undefined) {
      return reply.status(404).send({ error: 'No active lease for this resource' });
    }
    return reply.send({ lease });
  });
};
