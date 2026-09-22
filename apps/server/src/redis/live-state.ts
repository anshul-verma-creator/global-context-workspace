import type { RedisClient } from './connection.js';
import { repoStateKey } from './connection.js';
import { createLogger } from '@context-workspace/shared';

const log = createLogger({ component: 'live-state' });

/**
 * Live repository state backed by Redis Hashes.
 *
 * Each repository has one Redis hash:
 *   state:repo:<repositoryId>
 *
 * Keys within the hash represent individual state dimensions:
 *   active_agents      → JSON array of agent IDs
 *   active_sessions    → JSON array of session IDs
 *   current_resources  → JSON array of file paths being worked on
 *   conflicts          → JSON array of active conflict descriptors
 *   presence           → JSON map of agentId → last seen timestamp
 *
 * State is materialized from events. On server restart, Redis is repopulated
 * by replaying events from PostgreSQL (see StateRebuilder).
 */
export class LiveStateManager {
  constructor(private readonly redis: RedisClient) {}

  /**
   * Set a state key for a repository.
   */
  async set(repositoryId: string, key: string, value: unknown): Promise<void> {
    const hashKey = repoStateKey(repositoryId);
    await this.redis.hset(hashKey, key, JSON.stringify(value));
    log.debug('Live state updated', { repositoryId, key });
  }

  /**
   * Get a state key for a repository.
   */
  async get<T = unknown>(repositoryId: string, key: string): Promise<T | undefined> {
    const hashKey = repoStateKey(repositoryId);
    const val = await this.redis.hget(hashKey, key);
    if (val === null) return undefined;
    return JSON.parse(val) as T;
  }

  /**
   * Get all state for a repository as a plain object.
   */
  async getAll(repositoryId: string): Promise<Record<string, unknown>> {
    const hashKey = repoStateKey(repositoryId);
    const all = await this.redis.hgetall(hashKey);
    const parsed: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(all)) {
      try {
        parsed[key] = JSON.parse(String(val));
      } catch {
        parsed[key] = val;
      }
    }
    return parsed;
  }

  /**
   * Delete a state key.
   */
  async delete(repositoryId: string, key: string): Promise<void> {
    const hashKey = repoStateKey(repositoryId);
    await this.redis.hdel(hashKey, key);
  }

  /**
   * Clear all state for a repository (used during state rebuild).
   */
  async clear(repositoryId: string): Promise<void> {
    const hashKey = repoStateKey(repositoryId);
    await this.redis.del(hashKey);
    log.info('Live state cleared', { repositoryId });
  }

  /**
   * Add an agent to the active_agents set for a repository.
   */
  async registerAgent(repositoryId: string, agentId: string): Promise<void> {
    const current = (await this.get<string[]>(repositoryId, 'active_agents')) ?? [];
    if (!current.includes(agentId)) {
      current.push(agentId);
      await this.set(repositoryId, 'active_agents', current);
    }
    await this.set(repositoryId, `presence:${agentId}`, Date.now());
  }

  /**
   * Remove an agent from the active_agents set.
   */
  async deregisterAgent(repositoryId: string, agentId: string): Promise<void> {
    const current = (await this.get<string[]>(repositoryId, 'active_agents')) ?? [];
    const updated = current.filter((id) => id !== agentId);
    await this.set(repositoryId, 'active_agents', updated);
    await this.delete(repositoryId, `presence:${agentId}`);
  }

  /**
   * Record a resource as being actively worked on.
   */
  async addActiveResource(repositoryId: string, resource: string): Promise<void> {
    const current = (await this.get<string[]>(repositoryId, 'current_resources')) ?? [];
    if (!current.includes(resource)) {
      current.push(resource);
      await this.set(repositoryId, 'current_resources', current);
    }
  }

  /**
   * Remove a resource from active resources.
   */
  async removeActiveResource(repositoryId: string, resource: string): Promise<void> {
    const current = (await this.get<string[]>(repositoryId, 'current_resources')) ?? [];
    await this.set(repositoryId, 'current_resources', current.filter((r) => r !== resource));
  }
}
