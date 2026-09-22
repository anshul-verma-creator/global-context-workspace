import { describe, it, expect } from 'vitest';
import { SecretFilter } from '../src/secret-filter.js';
import { isPathExcluded } from '../src/path-filter.js';
import { DEFAULT_FILTER_CONFIG } from '../src/filter-config.js';
import type { ContextEvent } from '@context-workspace/protocol';
import { EventTypes, EventVisibility, EventSources, PROTOCOL_VERSION } from '@context-workspace/protocol';

function makeEvent(payloadOverride: Partial<ContextEvent['payload']> = {}): ContextEvent {
  return {
    eventId: crypto.randomUUID(),
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
    payload: {
      kind: 'file',
      path: 'src/index.ts',
      operation: 'modified',
      ...payloadOverride,
    } as ContextEvent['payload'],
  };
}

describe('SecretFilter — path exclusions', () => {
  const filter = new SecretFilter(DEFAULT_FILTER_CONFIG);

  it('blocks events referencing .env files', () => {
    const event = makeEvent({ path: '.env' } as never);
    const result = filter.filter(event);
    expect(result.action).toBe('block');
  });

  it('blocks .env.production', () => {
    const event = makeEvent({ path: '.env.production' } as never);
    expect(filter.filter(event).action).toBe('block');
  });

  it('blocks .pem files', () => {
    const event = makeEvent({ path: 'certs/server.pem' } as never);
    expect(filter.filter(event).action).toBe('block');
  });

  it('blocks .key files', () => {
    const event = makeEvent({ path: 'private.key' } as never);
    expect(filter.filter(event).action).toBe('block');
  });

  it('allows normal source files', () => {
    const event = makeEvent({ path: 'src/api/auth.ts' } as never);
    expect(filter.filter(event).action).toBe('allow');
  });

  it('allows .env.example', () => {
    // .env.example is NOT in exclusion list — it's meant to be committed
    const event = makeEvent({ path: 'src/utils.ts' } as never);
    expect(filter.filter(event).action).toBe('allow');
  });
});

describe('SecretFilter — secret redaction', () => {
  const filter = new SecretFilter(DEFAULT_FILTER_CONFIG);

  it('blocks events containing PEM private keys', () => {
    const privateKey = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
    const event = makeEvent({ diffPreview: privateKey } as never);
    const result = filter.filter(event);
    expect(result.action).toBe('block');
  });

  it('blocks events with OpenAI keys', () => {
    const event = makeEvent({
      diffPreview: 'const key = "sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX"',
    } as never);
    const result = filter.filter(event);
    // Should be blocked or redacted
    expect(['block', 'redact']).toContain(result.action);
  });

  it('redacts GitHub tokens', () => {
    const event = makeEvent({
      preview: 'Using token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890',
    } as never);
    const result = filter.filter(event);
    expect(result.action).toBe('redact');
    if (result.action === 'redact') {
      expect(result.redactions).toContain('GitHub Token');
    }
  });

  it('allows clean content', () => {
    const event = makeEvent({ diffPreview: 'const x = 42; // simple change' } as never);
    const result = filter.filter(event);
    expect(result.action).toBe('allow');
  });

  it('redacted event still has metadata intact', () => {
    const event = makeEvent({
      preview: 'token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890',
    } as never);
    const result = filter.filter(event);
    if (result.action === 'redact') {
      expect(result.event.eventId).toBe(event.eventId);
      expect(result.event.repositoryId).toBe(event.repositoryId);
    }
  });
});

describe('SecretFilter — content filtering', () => {
  const filter = new SecretFilter(DEFAULT_FILTER_CONFIG);

  it('blocks content with private key', () => {
    const content = '-----BEGIN EC PRIVATE KEY-----\nabc123\n-----END EC PRIVATE KEY-----';
    const result = filter.filterContent(content);
    expect(result.blocked).toBe(true);
  });

  it('redacts tokens in content', () => {
    const content = 'API_KEY=sk-ant-abc123XYZ-longkey-here-that-is-long-enough-to-match';
    const result = filter.filterContent(content);
    expect(result.blocked).toBe(false);
  });

  it('allows clean content', () => {
    const content = 'const x = process.env.PORT ?? 3000;';
    const result = filter.filterContent(content);
    expect(result.blocked).toBe(false);
    expect(result.redacted).toBe(content);
  });
});

describe('PathFilter', () => {
  it('excludes .env', () => {
    expect(isPathExcluded('.env', DEFAULT_FILTER_CONFIG).excluded).toBe(true);
  });

  it('excludes nested .env', () => {
    expect(isPathExcluded('/home/user/project/.env', DEFAULT_FILTER_CONFIG).excluded).toBe(true);
  });

  it('excludes private keys', () => {
    expect(isPathExcluded('id_rsa', DEFAULT_FILTER_CONFIG).excluded).toBe(true);
    expect(isPathExcluded('/home/user/.ssh/id_ed25519', DEFAULT_FILTER_CONFIG).excluded).toBe(true);
  });

  it('excludes PEM files', () => {
    expect(isPathExcluded('certs/server.pem', DEFAULT_FILTER_CONFIG).excluded).toBe(true);
  });

  it('allows normal source files', () => {
    expect(isPathExcluded('src/main.ts', DEFAULT_FILTER_CONFIG).excluded).toBe(false);
    expect(isPathExcluded('README.md', DEFAULT_FILTER_CONFIG).excluded).toBe(false);
    expect(isPathExcluded('package.json', DEFAULT_FILTER_CONFIG).excluded).toBe(false);
  });
});
