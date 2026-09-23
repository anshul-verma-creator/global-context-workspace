import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { CloudBackend } from '../src/cloud-backend.js';
import { ContextRuntime } from '@context-workspace/runtime';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TEST_DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://context_admin:context_secure_password@localhost:5432/context_workspace';

describe('CloudBackend PostgreSQL prepared statements and migrations', () => {
  let isPgAvailable = false;
  let rawSql: postgres.Sql | undefined;

  beforeAll(async () => {
    try {
      rawSql = postgres(TEST_DATABASE_URL, { connect_timeout: 3, max: 1 });
      await rawSql`SELECT 1`;
      isPgAvailable = true;
    } catch {
      isPgAvailable = false;
    }
  });

  afterAll(async () => {
    if (rawSql) {
      await rawSql.end();
    }
  });

  it('1. Reproduces: multi-command SQL in a prepared statement throws cannot insert multiple commands into a prepared statement', async () => {
    if (!isPgAvailable || !rawSql) {
      console.warn('PostgreSQL not available; skipping reproduction assertion');
      return;
    }

    let caughtError: any = null;
    try {
      // Prepared statement with multiple SQL commands separated by semicolons
      await rawSql`
        CREATE TABLE IF NOT EXISTS _test_repro (id INT);
        CREATE INDEX IF NOT EXISTS _idx_test_repro ON _test_repro(id);
      `;
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError.name).toBe('PostgresError');
    expect(caughtError.message).toContain('cannot insert multiple commands into a prepared statement');
  });

  it('2. Fix verification: individual prepared statements succeed without error', async () => {
    if (!isPgAvailable || !rawSql) {
      return;
    }

    // Executed as separate statements
    await rawSql`CREATE TABLE IF NOT EXISTS _test_repro_fixed (id INT)`;
    await rawSql`CREATE INDEX IF NOT EXISTS _idx_test_repro_fixed ON _test_repro_fixed(id)`;

    // Clean up
    await rawSql`DROP TABLE IF EXISTS _test_repro_fixed`;
  });

  it('3. CloudBackend.init() succeeds and applies migrations against PostgreSQL without prepared statement errors', async () => {
    if (!isPgAvailable) {
      return;
    }

    const backend = new CloudBackend({
      databaseUrl: TEST_DATABASE_URL,
    });

    // Should not throw PostgresError: cannot insert multiple commands into a prepared statement
    await expect(backend.init()).resolves.toBeUndefined();
    expect(backend.isReady).toBe(true);

    const health = await backend.checkHealth();
    expect(health.database).toBe(true);

    await backend.close();
  });

  it('4. CloudBackend full cycle (persist, sync, lease) against PostgreSQL', async () => {
    if (!isPgAvailable) {
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-cloud-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const runtime = new ContextRuntime({ dbPath });
    runtime.start();

    const repoId = `repo_cloud_${Date.now()}`;
    runtime.repositories.create({
      workspaceId: 'ws_cloud_1',
      rootPath: '/project',
      name: 'test-cloud-project',
      id: repoId,
    });

    const backend = new CloudBackend({
      databaseUrl: TEST_DATABASE_URL,
    });
    await backend.init();

    // 1. Create and persist an object
    const decision = runtime.objects.create({
      repositoryId: repoId,
      type: 'decision',
      scope: 'repository',
      authority: 'agent_explicit',
      status: 'active',
      visibility: 'repository',
      content: {
        statement: 'Use single prepared statements for cloud migrations',
        rationale: 'Avoid PostgresError 42601 on multi-command prepared statements',
      },
    });

    await backend.persistObject(decision);

    // 2. Fresh runtime can sync the object from PostgreSQL
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-cloud-test-2-'));
    const runtime2 = new ContextRuntime({ dbPath: path.join(tmpDir2, 'test.db') });
    runtime2.start();
    runtime2.repositories.create({
      workspaceId: 'ws_cloud_1',
      rootPath: '/project',
      name: 'test-cloud-project',
      id: repoId,
    });

    const syncResult = await backend.syncFromCloud(runtime2, repoId);
    expect(syncResult.objects).toBeGreaterThanOrEqual(1);

    const syncedObj = runtime2.objects.getById(decision.id);
    expect(syncedObj).toBeDefined();
    expect((syncedObj?.content as any).statement).toBe('Use single prepared statements for cloud migrations');

    // 3. Lease coordination
    const lease1 = await backend.acquireLease(repoId, 'src/index.ts', 'agent-1', 10000);
    expect(lease1.conflict).toBe(false);

    // Conflicting lease
    const lease2 = await backend.acquireLease(repoId, 'src/index.ts', 'agent-2', 10000);
    expect(lease2.conflict).toBe(true);

    // Release lease
    await backend.releaseLease(repoId, 'src/index.ts', 'agent-1');

    // Acquire now succeeds
    const lease3 = await backend.acquireLease(repoId, 'src/index.ts', 'agent-2', 10000);
    expect(lease3.conflict).toBe(false);

    // Cleanup
    await backend.close();
    runtime.stop();
    runtime2.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  });
});
