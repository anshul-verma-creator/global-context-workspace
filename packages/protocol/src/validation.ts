import type { ContextEvent } from './context-event.js';
import { EventTypes, EventVisibility, EventSources } from './event-types.js';
import { PROTOCOL_VERSION } from './index.js';
import { ValidationError } from '@context-workspace/shared';

/**
 * Validation module for protocol types.
 *
 * Design decision: We use hand-written validators rather than a schema library
 * (zod, joi, etc.) to keep the protocol package dependency-free and the
 * validation deterministic and auditable. This also prevents bundle size growth
 * in environments where protocol is used on the edge.
 */

const VALID_EVENT_TYPES: Set<string> = new Set(Object.values(EventTypes));
const VALID_VISIBILITIES: Set<string> = new Set(Object.values(EventVisibility));
const VALID_SOURCES: Set<string> = new Set(Object.values(EventSources));
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a ContextEvent.
 * Returns all validation errors, not just the first.
 */
export function validateContextEvent(event: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof event !== 'object' || event === null) {
    return { valid: false, errors: ['Event must be a non-null object'] };
  }

  const e = event as Record<string, unknown>;

  // Required string fields
  const requiredStrings = [
    'eventId',
    'workspaceId',
    'repositoryId',
    'userId',
    'deviceId',
  ] as const;

  for (const field of requiredStrings) {
    if (typeof e[field] !== 'string' || (e[field] as string).length === 0) {
      errors.push(`${field} must be a non-empty string`);
    }
  }

  // eventId must be UUID v4
  if (typeof e['eventId'] === 'string' && !UUID_RE.test(e['eventId'])) {
    errors.push('eventId must be a valid UUID v4');
  }

  // Protocol version
  if (e['protocolVersion'] !== PROTOCOL_VERSION) {
    errors.push(
      `protocolVersion must be ${PROTOCOL_VERSION}, got ${String(e['protocolVersion'])}`,
    );
  }

  // Event type
  if (!VALID_EVENT_TYPES.has(e['type'] as string)) {
    errors.push(`type '${String(e['type'])}' is not a valid EventType`);
  }

  // Visibility
  if (!VALID_VISIBILITIES.has(e['visibility'] as string)) {
    errors.push(`visibility '${String(e['visibility'])}' is not valid`);
  }

  // Source
  if (!VALID_SOURCES.has(e['source'] as string)) {
    errors.push(`source '${String(e['source'])}' is not valid`);
  }

  // clientSequence
  if (typeof e['clientSequence'] !== 'number' || e['clientSequence'] < 0) {
    errors.push('clientSequence must be a non-negative number');
  }

  // timestamp
  if (typeof e['timestamp'] !== 'number' || e['timestamp'] <= 0) {
    errors.push('timestamp must be a positive Unix millisecond timestamp');
  } else {
    // Sanity check: must be in reasonable range (after 2020, before 2100)
    const MIN_TS = 1_577_836_800_000;
    const MAX_TS = 4_102_444_800_000;
    if (e['timestamp'] < MIN_TS || e['timestamp'] > MAX_TS) {
      errors.push('timestamp is outside reasonable range (2020–2100)');
    }
  }

  // payload must exist
  if (typeof e['payload'] !== 'object' || e['payload'] === null) {
    errors.push('payload must be a non-null object');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate and throw if invalid.
 */
export function assertValidEvent(event: unknown): asserts event is ContextEvent {
  const result = validateContextEvent(event);
  if (!result.valid) {
    throw new ValidationError(
      `Invalid ContextEvent: ${result.errors.join('; ')}`,
    );
  }
}

/**
 * Check if a value is a non-empty string.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Check if a value is a valid UUID v4.
 */
export function isUUIDv4(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
