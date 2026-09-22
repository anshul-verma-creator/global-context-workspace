import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalDb } from '@context-workspace/database';
import { ContextObjectsStore } from '@context-workspace/database';
import { RelationsStore } from '@context-workspace/database';
import { RepositoriesStore } from '@context-workspace/database';
import { RetrievalEngine } from '../src/retrieval-engine.js';
import { ContextObjectScorer } from '../src/scorer.js';
import { DecisionValidityResolver } from '../src/decision-validity.js';
import { DEFAULT_SCORING_WEIGHTS } from '../src/retrieval-query.js';
import type { ContextObject } from '@context-workspace/protocol';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function makeTmpDb(): { db: LocalDb; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-retrieval-test-'));
  const db = new LocalDb({ dbPath: path.join(tmpDir, 'test.db') });
  return { db, tmpDir };
}

const baseObj = {
  scope: 'repository' as const,
  status: 'active' as const,
  authority: 'agent_explicit' as const,
  visibility: 'repository' as const,
  provenance: { sourceEventIds: [] },
  repositoryId: 'repo_1',
};

const baseQuery = {
  workspaceId: 'ws_1',
  repositoryId: 'repo_1',
  maxTokens: 8000,
};

// ─── Helper factories ────────────────────────────────────────────────────────

function makeDecision(
  store: ContextObjectsStore,
  description: string,
  extra: Partial<ContextObject> = {},
): ContextObject {
  return store.create({
    ...baseObj,
    type: 'DECISION',
    content: { kind: 'decision', description, requiresConfirmation: false },
    ...extra,
  });
}

function makeSupersedes(
  relStore: RelationsStore,
  superseder: ContextObject,
  superseded: ContextObject,
  repositoryId = 'repo_1',
) {
  relStore.create({
    repositoryId,
    fromId: superseder.id,
    relationType: 'supersedes',
    toId: superseded.id,
  });
}

// ─── ContextObjectScorer ─────────────────────────────────────────────────────

describe('ContextObjectScorer', () => {
  const scorer = new ContextObjectScorer(DEFAULT_SCORING_WEIGHTS);

  it('gives higher score for exact resource match', () => {
    const obj = {
      ...baseObj,
      id: '1',
      type: 'DECISION' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
      content: { kind: 'decision' as const, description: 'test', requiresConfirmation: false },
      resource: 'src/payment/retry.ts',
    };

    const scoreWithResource = scorer.score(obj, {
      ...baseQuery,
      resources: ['src/payment/retry.ts'],
    });

    const scoreWithoutResource = scorer.score(obj, baseQuery);

    expect(scoreWithResource.total).toBeGreaterThan(scoreWithoutResource.total);
  });

  it('gives lower score for rejected objects', () => {
    const obj = {
      ...baseObj,
      id: '1',
      type: 'DECISION' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
      content: { kind: 'decision' as const, description: 'test', requiresConfirmation: false },
    };

    const active = { ...obj, status: 'active' as const };
    const rejected = { ...obj, status: 'rejected' as const };

    expect(scorer.score(active, baseQuery).total).toBeGreaterThan(
      scorer.score(rejected, baseQuery).total,
    );
  });

  it('gives higher score for agent_explicit authority', () => {
    const obj = {
      ...baseObj,
      id: '1',
      type: 'DECISION' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
      content: { kind: 'decision' as const, description: 'test', requiresConfirmation: false },
    };

    const explicit = scorer.score({ ...obj, authority: 'agent_explicit' as const }, baseQuery);
    const inferred = scorer.score({ ...obj, authority: 'agent_inferred' as const }, baseQuery);
    expect(explicit.total).toBeGreaterThan(inferred.total);
  });
});

// ─── Decision validity resolution ────────────────────────────────────────────

describe('Decision validity resolution', () => {
  let db: LocalDb;
  let tmpDir: string;
  let objStore: ContextObjectsStore;
  let relStore: RelationsStore;
  let resolver: DecisionValidityResolver;

  beforeEach(() => {
    ({ db, tmpDir } = makeTmpDb());
    const repoStore = new RepositoriesStore(db.db);
    repoStore.create({ workspaceId: 'ws_1', rootPath: '/proj', name: 'proj', id: 'repo_1' });
    objStore = new ContextObjectsStore(db.db);
    relStore = new RelationsStore(db.db);
    resolver = new DecisionValidityResolver(relStore);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('1. A → B supersession: A is SUPERSEDED, B is ACTIVE', () => {
    const decA = makeDecision(objStore, 'Use Redis for caching');
    const decB = makeDecision(objStore, 'Use in-memory LRU cache instead');

    // B supersedes A
    makeSupersedes(relStore, decB, decA);

    const validityA = resolver.resolve(decA);
    const validityB = resolver.resolve(decB);

    expect(validityA.validity).toBe('SUPERSEDED');
    expect(validityA.supersededBy).toBe(decB.id);
    expect(validityB.validity).toBe('ACTIVE');
    expect(validityB.supersedes).toContain(decA.id);
  });

  it('2. A → B → C chain: A=SUPERSEDED, B=SUPERSEDED, C=ACTIVE', () => {
    const decA = makeDecision(objStore, 'Original: use synchronous processing');
    const decB = makeDecision(objStore, 'Updated: use async queue');
    const decC = makeDecision(objStore, 'Final: use distributed queue with Kafka');

    // B supersedes A, C supersedes B
    makeSupersedes(relStore, decB, decA);
    makeSupersedes(relStore, decC, decB);

    const results = resolver.resolveBatch([decA, decB, decC]);
    const byId = Object.fromEntries(results.map((r) => [r.object.id, r]));

    expect(byId[decA.id]?.validity).toBe('SUPERSEDED');
    expect(byId[decA.id]?.supersededBy).toBe(decB.id);

    expect(byId[decB.id]?.validity).toBe('SUPERSEDED');
    expect(byId[decB.id]?.supersededBy).toBe(decC.id);

    expect(byId[decC.id]?.validity).toBe('ACTIVE');
    expect(byId[decC.id]?.supersedes).toContain(decB.id);
  });

  it('3. Same decision names across repositories are resolved independently', () => {
    // Create a second repo
    const repoStore = new RepositoriesStore(db.db);
    repoStore.create({ workspaceId: 'ws_1', rootPath: '/proj2', name: 'proj2', id: 'repo_2' });

    const decRepo1 = makeDecision(objStore, 'Use TypeScript strict mode');
    const decRepo2 = objStore.create({
      ...baseObj,
      repositoryId: 'repo_2',
      type: 'DECISION',
      content: { kind: 'decision', description: 'Use TypeScript strict mode', requiresConfirmation: false },
    });

    // Only supersede within repo_1 — the repo_2 decision stays untouched
    const decRepo1B = makeDecision(objStore, 'Use TypeScript strict mode + no-any');
    makeSupersedes(relStore, decRepo1B, decRepo1, 'repo_1');

    const validityRepo1 = resolver.resolve(decRepo1);
    const validityRepo2 = resolver.resolve(decRepo2);

    // repo_1's original decision is superseded
    expect(validityRepo1.validity).toBe('SUPERSEDED');
    // repo_2's same-named decision is unaffected
    expect(validityRepo2.validity).toBe('ACTIVE');
  });

  it('4. Same decision names across tasks/capsules resolve independently', () => {
    const decCapsule1 = objStore.create({
      ...baseObj,
      capsuleId: 'capsule_1',
      type: 'DECISION',
      content: { kind: 'decision', description: 'Use PostgreSQL', requiresConfirmation: false },
    });
    const decCapsule2 = objStore.create({
      ...baseObj,
      capsuleId: 'capsule_2',
      type: 'DECISION',
      content: { kind: 'decision', description: 'Use PostgreSQL', requiresConfirmation: false },
    });
    const decCapsule1B = objStore.create({
      ...baseObj,
      capsuleId: 'capsule_1',
      type: 'DECISION',
      content: { kind: 'decision', description: 'Use SQLite instead', requiresConfirmation: false },
    });

    // Only the capsule_1 decision is superseded
    makeSupersedes(relStore, decCapsule1B, decCapsule1);

    const v1 = resolver.resolve(decCapsule1);
    const v2 = resolver.resolve(decCapsule2);
    const v1b = resolver.resolve(decCapsule1B);

    expect(v1.validity).toBe('SUPERSEDED');
    expect(v2.validity).toBe('ACTIVE');
    expect(v1b.validity).toBe('ACTIVE');
  });

  it('5. Delayed/out-of-order events: validity resolves correctly after relation added later', () => {
    const decA = makeDecision(objStore, 'Use REST API');
    const decB = makeDecision(objStore, 'Use GraphQL instead');

    // Initially — no supersession relation exists yet
    const beforeRelation = resolver.resolve(decA);
    expect(beforeRelation.validity).toBe('ACTIVE'); // Still ACTIVE before the relation

    // Now add the supersession relation (simulating a delayed event arrival)
    makeSupersedes(relStore, decB, decA);

    // Re-resolve — now A must be SUPERSEDED
    const afterRelation = resolver.resolve(decA);
    expect(afterRelation.validity).toBe('SUPERSEDED');
    expect(afterRelation.supersededBy).toBe(decB.id);
  });

  it('6. Unknown supersession state: decision with no relations is UNKNOWN when status is candidate', () => {
    const decUnknown = objStore.create({
      ...baseObj,
      status: 'candidate',
      type: 'DECISION',
      content: { kind: 'decision', description: 'Maybe use microservices', requiresConfirmation: false },
    });

    // No relations at all, status is 'candidate' (not active/confirmed/rejected)
    const validity = resolver.resolve(decUnknown);
    expect(validity.validity).toBe('UNKNOWN');
  });

  it('7. Superseded decision with validUntil <= now resolves as SUPERSEDED, not EXPIRED', () => {
    const decA = objStore.create({
      ...baseObj,
      type: 'DECISION',
      status: 'superseded',
      validUntil: Date.now() - 1000, // already expired in time
      content: { kind: 'decision', description: 'Old decision with past validUntil', requiresConfirmation: false },
    });
    const decB = objStore.create({
      ...baseObj,
      type: 'DECISION',
      status: 'active',
      content: { kind: 'decision', description: 'New decision', requiresConfirmation: false },
    });

    makeSupersedes(relStore, decB, decA);

    // Single resolve
    const resA = resolver.resolve(decA);
    expect(resA.validity).toBe('SUPERSEDED');
    expect(resA.supersededBy).toBe(decB.id);

    // Batch resolve
    const batchRes = resolver.resolveBatch([decA, decB]);
    expect(batchRes[0]?.validity).toBe('SUPERSEDED');
    expect(batchRes[0]?.supersededBy).toBe(decB.id);
    expect(batchRes[1]?.validity).toBe('ACTIVE');

    // Unsuperseded expired decision must still resolve as EXPIRED
    const decExpiredOnly = objStore.create({
      ...baseObj,
      type: 'DECISION',
      status: 'active',
      validUntil: Date.now() - 1000,
      content: { kind: 'decision', description: 'Expired decision without superseder', requiresConfirmation: false },
    });
    const resExpired = resolver.resolve(decExpiredOnly);
    expect(resExpired.validity).toBe('EXPIRED');
  });
});

// ─── RetrievalEngine ─────────────────────────────────────────────────────────

describe('RetrievalEngine', () => {
  let db: LocalDb;
  let tmpDir: string;
  let objStore: ContextObjectsStore;
  let relStore: RelationsStore;
  let engine: RetrievalEngine;

  // Alias so test helpers can use the store before engine is built
  let store: ContextObjectsStore;

  beforeEach(() => {
    ({ db, tmpDir } = makeTmpDb());
    const repoStore = new RepositoriesStore(db.db);
    repoStore.create({ workspaceId: 'ws_1', rootPath: '/proj', name: 'proj', id: 'repo_1' });
    objStore = new ContextObjectsStore(db.db);
    store = objStore;
    relStore = new RelationsStore(db.db);
    engine = new RetrievalEngine(objStore, relStore);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('retrieves objects from repository', async () => {
    objStore.create({
      ...baseObj,
      type: 'DECISION',
      content: { kind: 'decision', description: 'Use queue retry', requiresConfirmation: false },
    });

    const result = await engine.retrieve(baseQuery);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('scores resource-matched objects higher', async () => {
    objStore.create({
      ...baseObj,
      type: 'DECISION',
      resource: 'src/payment/retry.ts',
      content: { kind: 'decision', description: 'Use queue retry', requiresConfirmation: false },
    });
    objStore.create({
      ...baseObj,
      type: 'DECISION',
      content: { kind: 'decision', description: 'Unrelated decision', requiresConfirmation: false },
    });

    const result = await engine.retrieve({
      ...baseQuery,
      resources: ['src/payment/retry.ts'],
    });

    expect(result.candidates.length).toBe(2);
    expect(result.candidates[0]?.object.resource).toBe('src/payment/retry.ts');
  });

  it('expands via graph relations', async () => {
    const decision = objStore.create({
      ...baseObj,
      type: 'DECISION',
      resource: 'src/payment/retry.ts',
      content: { kind: 'decision', description: 'Use queue retry', requiresConfirmation: false },
    });

    const handoff = objStore.create({
      ...baseObj,
      type: 'HANDOFF',
      content: {
        kind: 'handoff',
        summary: 'Queue retry done',
        contextObjectIds: [decision.id],
      },
    });

    relStore.create({
      repositoryId: 'repo_1',
      fromId: handoff.id,
      relationType: 'related_to',
      toId: decision.id,
    });

    const result = await engine.retrieve({
      ...baseQuery,
      resources: ['src/payment/retry.ts'],
    });

    const ids = result.candidates.map((c) => c.object.id);
    expect(ids).toContain(handoff.id);
  });

  it('finds objects via FTS task match', async () => {
    objStore.create({
      ...baseObj,
      type: 'DECISION',
      content: {
        kind: 'decision',
        description: 'payment retry queue implementation strategy',
        requiresConfirmation: false,
      },
    });

    const result = await engine.retrieve({ ...baseQuery, task: 'payment retry' });
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('records telemetry with stage counts', async () => {
    const result = await engine.retrieve(baseQuery);
    expect(result.telemetry.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.telemetry.query.repositoryId).toBe('repo_1');
  });
});

// ─── Category-aware retrieval ─────────────────────────────────────────────────

describe('Category-aware retrieval', () => {
  let db: LocalDb;
  let tmpDir: string;
  let objStore: ContextObjectsStore;
  let relStore: RelationsStore;
  let engine: RetrievalEngine;
  let store: ContextObjectsStore;

  beforeEach(() => {
    ({ db, tmpDir } = makeTmpDb());
    const repoStore = new RepositoriesStore(db.db);
    repoStore.create({ workspaceId: 'ws_1', rootPath: '/proj', name: 'proj', id: 'repo_1' });
    objStore = new ContextObjectsStore(db.db);
    store = objStore;
    relStore = new RelationsStore(db.db);
    engine = new RetrievalEngine(objStore, relStore);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('populates all 10 category slots', async () => {
    // Seed one object per category type
    // 1. current_active_work
    store.create({ ...baseObj, type: 'TASK', content: { kind: 'task', title: 'Implement auth', status: 'active' } });
    // 2 & 3. decisions (one active, one superseded)
    const decOld = makeDecision(objStore, 'Old approach: use JWT with long expiry');
    const decNew = makeDecision(objStore, 'New approach: use short-lived JWT + refresh tokens');
    makeSupersedes(relStore, decNew, decOld);
    // 4. constraints
    store.create({ ...baseObj, type: 'CONSTRAINT', content: { kind: 'constraint', description: 'Must not store passwords in plaintext' } });
    // 5. errors
    store.create({ ...baseObj, type: 'ERROR', content: { kind: 'error', message: 'TypeError in auth handler' } });
    // 6. test results
    store.create({ ...baseObj, type: 'TEST_RESULT', content: { kind: 'test_result', testName: 'auth.test.ts', status: 'failed' } });
    // 7. active conflicts (STATE with conflict: key)
    store.create({ ...baseObj, type: 'STATE', content: { kind: 'state', key: 'conflict:src/auth.ts', value: 'agent_a,agent_b' } });
    // 8. placeholders
    store.create({ ...baseObj, type: 'PLACEHOLDER', status: 'candidate', content: { kind: 'placeholder', resource: 'src/auth.ts', description: 'TODO: implement refresh token logic', detectionMethod: 'agent_declaration', placeholderStatus: 'active' } });
    // 9. handoffs
    store.create({ ...baseObj, type: 'HANDOFF', content: { kind: 'handoff', summary: 'Auth module ready for review', contextObjectIds: [] } });
    // 10. code references
    store.create({ ...baseObj, type: 'CODE_REFERENCE', resource: 'src/auth.ts', content: { kind: 'code_reference', resource: 'src/auth.ts', symbol: 'AuthService' } });

    const result = await engine.retrieve({ ...baseQuery, includeCategories: true });

    expect(result.categories).toBeDefined();
    const cats = result.categories!;

    expect(cats.currentActiveWork.length).toBeGreaterThan(0);
    expect(cats.latestApplicableDecisions.length).toBeGreaterThan(0);
    expect(cats.supersededDecisions.length).toBeGreaterThan(0);
    expect(cats.constraints.length).toBeGreaterThan(0);
    expect(cats.latestErrors.length).toBeGreaterThan(0);
    expect(cats.latestTestResults.length).toBeGreaterThan(0);
    expect(cats.activeConflicts.length).toBeGreaterThan(0);
    expect(cats.placeholders.length).toBeGreaterThan(0);
    expect(cats.handoffs.length).toBeGreaterThan(0);
    expect(cats.relevantCodeResources.length).toBeGreaterThan(0);
  });

  it('latest_applicable_decisions excludes SUPERSEDED decisions', async () => {
    const decOld = makeDecision(objStore, 'Old: use monolith');
    const decNew = makeDecision(objStore, 'New: use microservices');
    makeSupersedes(relStore, decNew, decOld);

    const result = await engine.retrieve({ ...baseQuery, includeCategories: true });
    const cats = result.categories!;

    const applicableIds = cats.latestApplicableDecisions.map((d) => d.object.id);
    const supersededIds = cats.supersededDecisions.map((d) => d.object.id);

    expect(applicableIds).toContain(decNew.id);
    expect(applicableIds).not.toContain(decOld.id);
    expect(supersededIds).toContain(decOld.id);
  });

  it('SUPERSEDED decisions do not appear as ACTIVE regardless of recency', async () => {
    // decB is newer but was superseded by decC
    const decA = makeDecision(objStore, 'First approach');
    const decB = makeDecision(objStore, 'Second approach — newer but will be superseded');
    const decC = makeDecision(objStore, 'Third approach — the current one');

    makeSupersedes(relStore, decB, decA);
    makeSupersedes(relStore, decC, decB);

    const result = await engine.retrieve({ ...baseQuery, includeCategories: true });
    const cats = result.categories!;

    const applicableIds = cats.latestApplicableDecisions.map((d) => d.object.id);

    // Only decC should be in applicable; decA and decB are both superseded
    expect(applicableIds).toContain(decC.id);
    expect(applicableIds).not.toContain(decA.id);
    expect(applicableIds).not.toContain(decB.id);
  });

  it('categories are absent when includeCategories is false', async () => {
    makeDecision(objStore, 'Some decision');
    const result = await engine.retrieve({ ...baseQuery, includeCategories: false });
    expect(result.categories).toBeUndefined();
  });
});
