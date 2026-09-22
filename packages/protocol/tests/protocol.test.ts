import { describe, it, expect } from 'vitest';
import {
  validateContextEvent,
  assertValidEvent,
  PROTOCOL_VERSION,
  EventTypes,
  EventVisibility,
  EventSources,
} from '../src/index.js';
import type { ContextEvent } from '../src/index.js';

function validEvent(overrides: Partial<ContextEvent> = {}): ContextEvent {
  return {
    eventId: '123e4567-e89b-4456-a456-426614174000',
    protocolVersion: PROTOCOL_VERSION,
    workspaceId: 'ws_1',
    repositoryId: 'repo_1',
    userId: 'user_1',
    deviceId: 'device_1',
    clientSequence: 1,
    timestamp: Date.now(),
    type: EventTypes.FILE_MODIFIED,
    visibility: EventVisibility.REPOSITORY,
    source: EventSources.FILESYSTEM,
    payload: { kind: 'file', path: 'src/index.ts', operation: 'modified' },
    ...overrides,
  };
}

describe('validateContextEvent', () => {
  it('accepts a valid event', () => {
    const result = validateContextEvent(validEvent());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects null', () => {
    const result = validateContextEvent(null);
    expect(result.valid).toBe(false);
  });

  it('rejects non-object', () => {
    const result = validateContextEvent('string');
    expect(result.valid).toBe(false);
  });

  it('rejects missing eventId', () => {
    const result = validateContextEvent(validEvent({ eventId: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('eventId'))).toBe(true);
  });

  it('rejects non-UUID eventId', () => {
    const result = validateContextEvent(validEvent({ eventId: 'not-a-uuid' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('UUID'))).toBe(true);
  });

  it('rejects wrong protocol version', () => {
    const result = validateContextEvent(
      validEvent({ protocolVersion: 999 }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('protocolVersion'))).toBe(true);
  });

  it('rejects invalid event type', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = validateContextEvent(validEvent({ type: 'invalid.type' as any }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('type'))).toBe(true);
  });

  it('rejects invalid visibility', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = validateContextEvent(validEvent({ visibility: 'INVALID' as any }));
    expect(result.valid).toBe(false);
  });

  it('rejects invalid source', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = validateContextEvent(validEvent({ source: 'INVALID' as any }));
    expect(result.valid).toBe(false);
  });

  it('rejects negative clientSequence', () => {
    const result = validateContextEvent(validEvent({ clientSequence: -1 }));
    expect(result.valid).toBe(false);
  });

  it('rejects timestamp outside reasonable range', () => {
    const result = validateContextEvent(validEvent({ timestamp: 100 }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('timestamp'))).toBe(true);
  });

  it('rejects null payload', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = validateContextEvent(validEvent({ payload: null as any }));
    expect(result.valid).toBe(false);
  });

  it('collects multiple errors', () => {
    const result = validateContextEvent({
      eventId: '',
      protocolVersion: 999,
      workspaceId: '',
      repositoryId: '',
      userId: '',
      deviceId: '',
      clientSequence: -1,
      timestamp: -1,
      type: 'invalid',
      visibility: 'invalid',
      source: 'invalid',
      payload: null,
    });
    expect(result.errors.length).toBeGreaterThan(3);
  });
});

describe('assertValidEvent', () => {
  it('does not throw for valid event', () => {
    expect(() => assertValidEvent(validEvent())).not.toThrow();
  });

  it('throws ValidationError for invalid event', () => {
    expect(() => assertValidEvent(null)).toThrow();
  });
});

describe('event type coverage', () => {
  it('all event types are valid for validation', () => {
    for (const type of Object.values(EventTypes)) {
      const result = validateContextEvent(
        validEvent({ type, payload: { kind: 'generic', data: {} } }),
      );
      // All EventType values should be accepted
      expect(result.errors.filter((e) => e.includes('type'))).toHaveLength(0);
    }
  });
});

describe('serialization', () => {
  it('valid event survives JSON round-trip', () => {
    const event = validEvent();
    const json = JSON.stringify(event);
    const parsed = JSON.parse(json) as unknown;
    const result = validateContextEvent(parsed);
    expect(result.valid).toBe(true);
  });
});
