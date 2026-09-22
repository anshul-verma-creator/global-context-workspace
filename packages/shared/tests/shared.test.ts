import { describe, it, expect } from 'vitest';
import { generateId, prefixedId } from '../src/id.js';
import { ok, err, isOk, isErr, mapResult } from '../src/result.js';
import { sha256, contentHash } from '../src/hash.js';
import { nowMs, Duration } from '../src/time.js';
import {
  ValidationError,
  NotFoundError,
  AuthorizationError,
  RepositoryIsolationError,
} from '../src/errors.js';
import { optionalEnv, optionalEnvInt, optionalEnvBool } from '../src/config.js';

describe('id', () => {
  it('generates valid UUID v4', () => {
    const id = generateId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 1000 }, generateId));
    expect(ids.size).toBe(1000);
  });

  it('prefixes IDs correctly', () => {
    const id = prefixedId('evt');
    expect(id).toMatch(/^evt_[0-9a-f-]{36}$/);
  });
});

describe('result', () => {
  it('ok() creates success result', () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    expect(isOk(r)).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it('err() creates failure result', () => {
    const r = err(new Error('fail'));
    expect(r.ok).toBe(false);
    expect(isErr(r)).toBe(true);
    if (!r.ok) expect(r.error.message).toBe('fail');
  });

  it('mapResult transforms ok values', () => {
    const r = mapResult(ok(5), (x) => x * 2);
    expect(isOk(r)).toBe(true);
    if (r.ok) expect(r.value).toBe(10);
  });

  it('mapResult passes through errors', () => {
    const r = mapResult(err(new Error('oops')), (x: number) => x * 2);
    expect(isErr(r)).toBe(true);
  });
});

describe('hash', () => {
  it('sha256 produces 64-char hex string', () => {
    const h = sha256('hello world');
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it('sha256 is deterministic', () => {
    expect(sha256('test')).toBe(sha256('test'));
  });

  it('sha256 differs for different inputs', () => {
    expect(sha256('a')).not.toBe(sha256('b'));
  });

  it('contentHash produces 16-char string', () => {
    expect(contentHash('data')).toHaveLength(16);
  });
});

describe('time', () => {
  it('nowMs returns reasonable unix timestamp', () => {
    const t = nowMs();
    expect(t).toBeGreaterThan(1_700_000_000_000);
    expect(t).toBeLessThan(2_000_000_000_000);
  });

  it('Duration helpers compute correctly', () => {
    expect(Duration.seconds(1)).toBe(1000);
    expect(Duration.minutes(1)).toBe(60_000);
    expect(Duration.hours(1)).toBe(3_600_000);
    expect(Duration.days(1)).toBe(86_400_000);
  });
});

describe('errors', () => {
  it('ValidationError has correct code and status', () => {
    const e = new ValidationError('bad input', 'fieldName');
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(e.statusCode).toBe(400);
    expect(e.field).toBe('fieldName');
    expect(e).toBeInstanceOf(Error);
  });

  it('NotFoundError has correct code and status', () => {
    const e = new NotFoundError('Capsule', 'cap_123');
    expect(e.code).toBe('NOT_FOUND');
    expect(e.statusCode).toBe(404);
    expect(e.message).toContain('cap_123');
  });

  it('AuthorizationError has correct code and status', () => {
    const e = new AuthorizationError();
    expect(e.code).toBe('AUTHORIZATION_ERROR');
    expect(e.statusCode).toBe(403);
  });

  it('RepositoryIsolationError correctly reports repository', () => {
    const e = new RepositoryIsolationError('repo_999');
    expect(e.code).toBe('REPOSITORY_ISOLATION_VIOLATION');
    expect(e.message).toContain('repo_999');
  });
});

describe('config', () => {
  it('optionalEnv returns env value when set', () => {
    process.env['TEST_VAR'] = 'hello';
    expect(optionalEnv('TEST_VAR', 'default')).toBe('hello');
    delete process.env['TEST_VAR'];
  });

  it('optionalEnv returns default when not set', () => {
    expect(optionalEnv('DEFINITELY_NOT_SET_XYZ', 'fallback')).toBe('fallback');
  });

  it('optionalEnvInt parses integers', () => {
    process.env['INT_VAR'] = '42';
    expect(optionalEnvInt('INT_VAR', 0)).toBe(42);
    delete process.env['INT_VAR'];
  });

  it('optionalEnvBool parses booleans', () => {
    process.env['BOOL_VAR'] = 'true';
    expect(optionalEnvBool('BOOL_VAR', false)).toBe(true);
    delete process.env['BOOL_VAR'];
  });
});
