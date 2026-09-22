import type { ContextEvent } from '@context-workspace/protocol';
import { SecretDetectedError, createLogger } from '@context-workspace/shared';
import type { FilterConfig } from './filter-config.js';
import { DEFAULT_FILTER_CONFIG } from './filter-config.js';
import { isPathExcluded, extractEventPaths } from './path-filter.js';

const log = createLogger({ component: 'secret-filter' });

/**
 * Result of filtering an event.
 */
export type FilterResult =
  | { action: 'allow'; event: ContextEvent }
  | { action: 'block'; reason: string }
  | { action: 'redact'; event: ContextEvent; redactions: string[] };

/**
 * The secret filter runs before any event is transmitted to the cloud.
 *
 * Per spec §17 (Workflow): Capture → Known-secret detection → Block/redact → Local persistence → Cloud sync
 * Per spec §18 (Architecture): secret scanning before cloud transmission.
 *
 * Design decisions:
 * - We operate on the serialized payload string to catch secrets in any nested field.
 * - Blocked events (private keys) are never transmitted.
 * - Redacted events have secret values replaced but metadata transmitted.
 * - Path exclusions block the event entirely if blockExcludedPaths is true.
 */
export class SecretFilter {
  private readonly config: FilterConfig;

  constructor(config: FilterConfig = DEFAULT_FILTER_CONFIG) {
    this.config = config;
  }

  /**
   * Filter an event before cloud transmission.
   * Returns the action to take and potentially a modified event.
   */
  filter(event: ContextEvent): FilterResult {
    // 1. Check path exclusions first
    const pathResult = this._checkPathExclusions(event);
    if (pathResult !== null) {
      return pathResult;
    }

    // 2. Scan payload for secrets
    return this._scanForSecrets(event);
  }

  /**
   * Filter raw content string (for chunk-level filtering).
   * Returns the redacted string or null if should be blocked.
   */
  filterContent(content: string): { allowed: boolean; redacted: string; blocked: boolean } {
    let result = content;
    let blocked = false;

    for (const pattern of this.config.secretPatterns) {
      if (pattern.blockEvent === true && pattern.pattern.test(result)) {
        blocked = true;
        log.warn('Content blocked due to secret detection', { secretName: pattern.name });
        break;
      }
      // Reset regex lastIndex for global patterns
      pattern.pattern.lastIndex = 0;
      result = result.replace(pattern.pattern, pattern.redactWith);
      pattern.pattern.lastIndex = 0;
    }

    return { allowed: !blocked, redacted: result, blocked };
  }

  private _checkPathExclusions(event: ContextEvent): FilterResult | null {
    const payload = ((event.payload ?? {}) as unknown) as Record<string, unknown>;
    const paths = extractEventPaths(payload);

    for (const filePath of paths) {
      const pathResult = isPathExcluded(filePath, this.config);
      if (pathResult.excluded) {
        if (this.config.blockExcludedPaths) {
          log.info('Event blocked: excluded path', {
            eventId: event.eventId,
            path: filePath,
            reason: pathResult.reason,
          });
          return { action: 'block', reason: pathResult.reason ?? 'Excluded path' };
        }
      }
    }

    return null;
  }

  private _scanForSecrets(event: ContextEvent): FilterResult {
    const payloadStr = JSON.stringify(event.payload ?? {});
    let redactedPayloadStr = payloadStr;
    const redactions: string[] = [];
    let blocked = false;

    for (const secretPattern of this.config.secretPatterns) {
      // Reset lastIndex for global patterns
      secretPattern.pattern.lastIndex = 0;

      if (secretPattern.blockEvent === true) {
        if (secretPattern.pattern.test(redactedPayloadStr)) {
          log.warn('Event blocked: private key detected', {
            eventId: event.eventId,
            secretType: secretPattern.name,
          });
          blocked = true;
          break;
        }
      } else {
        secretPattern.pattern.lastIndex = 0;
        const before = redactedPayloadStr;
        redactedPayloadStr = redactedPayloadStr.replace(
          secretPattern.pattern,
          secretPattern.redactWith,
        );
        secretPattern.pattern.lastIndex = 0;
        if (redactedPayloadStr !== before) {
          redactions.push(secretPattern.name);
          log.info('Secret redacted from event', {
            eventId: event.eventId,
            secretType: secretPattern.name,
          });
        }
      }
    }

    if (blocked) {
      return { action: 'block', reason: 'Event contains private key or blocked secret' };
    }

    if (redactions.length > 0) {
      // Parse the redacted payload back — if it fails (corrupt JSON after redact), block
      try {
        const redactedPayload = JSON.parse(redactedPayloadStr) as ContextEvent['payload'];
        return {
          action: 'redact',
          event: { ...event, payload: redactedPayload },
          redactions,
        };
      } catch {
        return { action: 'block', reason: 'Payload corrupted during secret redaction' };
      }
    }

    return { action: 'allow', event };
  }
}

/**
 * Synchronously assert that an event passes the secret filter.
 * Throws SecretDetectedError if the event is blocked.
 */
export function assertEventSafe(
  event: ContextEvent,
  filter: SecretFilter,
): ContextEvent {
  const result = filter.filter(event);
  if (result.action === 'block') {
    throw new SecretDetectedError(result.reason);
  }
  if (result.action === 'redact') {
    return result.event;
  }
  return result.event;
}
