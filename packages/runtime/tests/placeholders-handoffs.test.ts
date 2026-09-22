import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalDb, RepositoriesStore, CapsulesStore, ContextObjectsStore } from '@context-workspace/database';
import {
  scanContentForPlaceholders,
  extractPlaceholderFromEvent,
  PlaceholderManager,
} from '../src/placeholders.js';
import { HandoffManager } from '../src/handoffs.js';
import type { ContextEvent } from '@context-workspace/protocol';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function makeTmpDb(): { db: LocalDb; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-ph-test-'));
  const db = new LocalDb({ dbPath: path.join(tmpDir, 'test.db') });
  return { db, tmpDir };
}

describe('Phase 14 — Placeholder System', () => {
  let db: LocalDb;
  let tmpDir: string;
  let objectsStore: ContextObjectsStore;
  let manager: PlaceholderManager;
  const repoId = 'repo_placeholder_1';

  beforeEach(() => {
    ({ db, tmpDir } = makeTmpDb());
    const repoStore = new RepositoriesStore(db.db);
    repoStore.create({ workspaceId: 'ws_1', rootPath: '/proj', name: 'proj', id: repoId });

    objectsStore = new ContextObjectsStore(db.db);
    manager = new PlaceholderManager(objectsStore);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('detects explicit markers (TODO, FIXME, STUB, MOCK) in code content', () => {
    const code = `
      function authenticate(user: string) {
        // TODO: replace mock with OAuth2 token validation
        return { user, token: 'mock-123' };
      }
      function fetchMetrics() {
        /* FIXME: database query bottleneck */
        return [];
      }
    `;

    const detected = scanContentForPlaceholders('src/auth.ts', code);
    expect(detected).toHaveLength(2);
    expect(detected[0]?.detectionMethod).toBe('explicit_marker');
    expect(detected[0]?.description).toContain('replace mock with OAuth2 token validation');
    expect(detected[0]?.line).toBe(3);
    expect(detected[1]?.description).toContain('database query bottleneck');
    expect(detected[1]?.line).toBe(7);
  });

  it('detects static / code signals (throw not implemented, dummy return)', () => {
    const code = `
      export function exportReport(): string {
        throw new Error("Not implemented");
      }
      export function getStripeKey(): string | null {
        return null; // temporary
      }
    `;

    const detected = scanContentForPlaceholders('src/reports.ts', code);
    expect(detected).toHaveLength(2);
    expect(detected.every((d) => d.detectionMethod === 'static_signal')).toBe(true);
    expect(detected[0]?.description).toContain('Unimplemented code signal');
    expect(detected[1]?.description).toContain('dummy_return');
  });

  it('detects placeholders declared explicitly by an agent event', () => {
    const event: ContextEvent = {
      eventId: 'evt-ph-1',
      protocolVersion: 1,
      workspaceId: 'ws_1',
      userId: 'u1',
      deviceId: 'd1',
      type: 'placeholder.declared' as any,
      source: 'agent' as any,
      visibility: 'repository' as any,
      repositoryId: repoId,
      clientSequence: 1,
      timestamp: Date.now(),
      payload: {
        resource: 'src/billing/stripe.ts',
        description: 'Mock payment gateway returning hardcoded success',
        intendedReplacement: 'Stripe Webhooks API integration v2024-06',
      },
    };

    const detected = extractPlaceholderFromEvent(event);
    expect(detected).toHaveLength(1);
    expect(detected[0]?.detectionMethod).toBe('agent_declaration');
    expect(detected[0]?.resource).toBe('src/billing/stripe.ts');
    expect(detected[0]?.intendedReplacement).toBe('Stripe Webhooks API integration v2024-06');
  });

  it('manages full lifecycle: candidate → active → confirmed → resolved / rejected', () => {
    // 1. Register candidate
    const placeholder = manager.register({
      repositoryId: repoId,
      resource: 'src/cache.ts',
      description: 'In-memory map mock',
      intendedReplacement: 'Distributed Redis cluster',
      detectionMethod: 'explicit_marker',
      initialStatus: 'candidate',
    });

    expect(placeholder.id).toBeDefined();

    // 2. Transition candidate → active
    const active = manager.transition(placeholder.id, 'active');
    expect((active?.content as any).placeholderStatus).toBe('active');

    // 3. Transition active → confirmed
    const confirmed = manager.transition(placeholder.id, 'confirmed');
    expect((confirmed?.content as any).placeholderStatus).toBe('confirmed');

    // 4. Transition confirmed → resolved
    const resolved = manager.transition(placeholder.id, 'resolved');
    expect((resolved?.content as any).placeholderStatus).toBe('resolved');
  });

  it('guarantees AI retrieving a placeholder receives non-authoritative warning & intended replacement', () => {
    const ph = manager.register({
      repositoryId: repoId,
      resource: 'src/auth/jwt.ts',
      description: 'Static secret "test-secret" for local testing',
      intendedReplacement: 'AWS Secrets Manager KMS token exchange',
      detectionMethod: 'agent_declaration',
      initialStatus: 'active',
    });

    const view = manager.formatForRetrieval(ph);

    // Acceptance requirement:
    // AI must receive placeholder status, intended replacement, and never treat it as authoritative!
    expect(view.authoritative).toBe(false);
    expect(view.status).toBe('active');
    expect(view.intendedReplacement).toBe('AWS Secrets Manager KMS token exchange');
    expect(view.warning).toContain('[NON-AUTHORITATIVE PLACEHOLDER]');
    expect(view.warning).toContain("Do not treat existing mock/stub values as authoritative");
  });
});

describe('Phase 15 — Handoff System', () => {
  let db: LocalDb;
  let tmpDir: string;
  let objectsStore: ContextObjectsStore;
  let capsulesStore: CapsulesStore;
  let handoffManager: HandoffManager;
  const repoId = 'repo_handoff_1';
  let capsuleId: string;

  beforeEach(() => {
    ({ db, tmpDir } = makeTmpDb());
    const repoStore = new RepositoriesStore(db.db);
    repoStore.create({ workspaceId: 'ws_1', rootPath: '/proj', name: 'proj', id: repoId });

    capsulesStore = new CapsulesStore(db.db);
    const capsule = capsulesStore.create({ repositoryId: repoId, name: 'feature-auth' });
    capsuleId = capsule.id;

    objectsStore = new ContextObjectsStore(db.db);
    handoffManager = new HandoffManager(objectsStore);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('Agent A finishes work and Agent B retrieves compact handoff to continue', () => {
    // 1. Agent A records structured handoff at end of session
    const handoffObj = handoffManager.createHandoff({
      repositoryId: repoId,
      capsuleId,
      sessionId: 'sess_agent_a',
      authorAgentId: 'agent-alice',
      summary: 'Completed OAuth schema and endpoints, Stripe webhook remaining',
      completed: [
        'Added OAuth tables in migration 10',
        'Implemented POST /api/v1/auth/login',
        'Wrote 12 unit tests in auth.test.ts',
      ],
      remaining: [
        'Implement Stripe webhook signature verification',
        'Wire webhook event into billing service',
      ],
      next_step: 'Run migration 11 and implement verifyWebhookSignature in src/billing/stripe.ts',
      blockers: ['Awaiting test Stripe API keys from DevOps'],
      placeholders: ['src/billing/stripe.ts (mock webhook secret)'],
      known_issues: ['Concurrent sessions occasionally hit SQLite lock timeout under load'],
      links: [
        { title: 'Stripe Webhook Docs', url: 'https://stripe.com/docs/webhooks' },
      ],
    });

    expect(handoffObj.id).toBeDefined();
    expect(handoffObj.type).toBe('HANDOFF');

    // 2. Agent B starts a new session in the same capsule and retrieves the latest handoff
    const retrieved = handoffManager.getLatestHandoff(repoId, capsuleId);
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(handoffObj.id);

    const content = retrieved?.content as any;
    expect(content.completed).toHaveLength(3);
    expect(content.remaining).toHaveLength(2);
    expect(content.next_step).toBe('Run migration 11 and implement verifyWebhookSignature in src/billing/stripe.ts');
    expect(content.blockers).toEqual(['Awaiting test Stripe API keys from DevOps']);
    expect(content.placeholders).toEqual(['src/billing/stripe.ts (mock webhook secret)']);

    // 3. Compact representation is formatted for agent prompt injection
    const compactText = handoffManager.formatCompactHandoff(retrieved!);
    expect(compactText).toContain('=== HANDOFF [');
    expect(compactText).toContain('SUMMARY: Completed OAuth schema');
    expect(compactText).toContain('NEXT_STEP: Run migration 11');
    expect(compactText).toContain('COMPLETED: Added OAuth tables in migration 10');
    expect(compactText).toContain('BLOCKERS: Awaiting test Stripe API keys from DevOps');
    expect(compactText).toContain('PLACEHOLDERS: src/billing/stripe.ts (mock webhook secret)');
  });
});
