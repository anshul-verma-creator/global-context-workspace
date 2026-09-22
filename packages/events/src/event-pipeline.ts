import type { ContextEvent } from '@context-workspace/protocol';
import { SecretFilter } from '@context-workspace/security';
import { DEFAULT_FILTER_CONFIG } from '@context-workspace/security';
import { createLogger } from '@context-workspace/shared';

const log = createLogger({ component: 'event-pipeline' });

/**
 * Event pipeline — processes events from adapters through security and normalization.
 *
 * Pipeline stages per spec §5 (Workflow):
 * event → normalize → secret filter → deduplicate → SQLite → outbox
 *
 * This module handles stages 1-3. SQLite and outbox are in the runtime app.
 */

export interface PipelineResult {
  event: ContextEvent;
  action: 'allow' | 'block' | 'redact';
  reason?: string;
}

export interface EventPipelineOptions {
  secretFilter?: SecretFilter;
  /** Called when an event is blocked (for metrics/logging) */
  onBlocked?: (eventId: string, reason: string) => void;
  /** Called when an event is redacted */
  onRedacted?: (eventId: string, redactions: string[]) => void;
}

/**
 * Process an event through the security pipeline.
 * Returns the processed event and action taken.
 */
export function processEventThroughPipeline(
  event: ContextEvent,
  options: EventPipelineOptions = {},
): PipelineResult {
  const filter = options.secretFilter ?? new SecretFilter(DEFAULT_FILTER_CONFIG);

  const result = filter.filter(event);

  if (result.action === 'block') {
    log.warn('Event blocked by secret filter', {
      eventId: event.eventId,
      repositoryId: event.repositoryId,
      reason: result.reason,
    });
    options.onBlocked?.(event.eventId, result.reason);
    return { event, action: 'block', reason: result.reason };
  }

  if (result.action === 'redact') {
    log.info('Event redacted by secret filter', {
      eventId: event.eventId,
      repositoryId: event.repositoryId,
      redactions: result.redactions.join(', '),
    });
    options.onRedacted?.(event.eventId, result.redactions);
    return { event: result.event, action: 'redact' };
  }

  return { event: result.event, action: 'allow' };
}

/**
 * Deduplication check — verify if an event has already been processed.
 * Uses eventId for primary deduplication, content hash for secondary.
 *
 * Returns true if the event is a duplicate and should be skipped.
 */
export function isDuplicateEvent(
  eventId: string,
  payloadHash: string,
  existingIds: Set<string>,
  existingHashes: Set<string>,
): boolean {
  if (existingIds.has(eventId)) {
    log.debug('Duplicate event detected by eventId', { eventId });
    return true;
  }
  if (existingHashes.has(payloadHash)) {
    log.debug('Potential duplicate event detected by content hash', { eventId });
    return true;
  }
  return false;
}
