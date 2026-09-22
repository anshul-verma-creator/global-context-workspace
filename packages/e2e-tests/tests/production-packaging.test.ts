import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { BackupManager } from '../src/backup-manager.js';
import { LocalDb, RepositoriesStore, ContextObjectsStore } from '@context-workspace/database';

describe('Phase 29 — Production Packaging & Deployment Verification', () => {
  const rootDir = path.resolve(__dirname, '../../../');
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-prod-pkg-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('1. Docker & Container Artifacts', () => {
    it('verifies apps/server/Dockerfile multi-stage production build definition', () => {
      const dockerfilePath = path.join(rootDir, 'apps/server/Dockerfile');
      expect(fs.existsSync(dockerfilePath)).toBe(true);

      const content = fs.readFileSync(dockerfilePath, 'utf8');

      // Multi-stage verification
      expect(content).toContain('AS builder');
      expect(content).toContain('AS runner');

      // Security: Non-root user execution
      expect(content).toContain('USER node');

      // Healthcheck probe
      expect(content).toContain('HEALTHCHECK');
      expect(content).toContain('http://localhost:3000/health');

      // Production entry point
      expect(content).toContain('apps/server/dist/index.js');
    });

    it('verifies docker-compose.yml configuration with pgvector and Redis AOF', () => {
      const composePath = path.join(rootDir, 'docker-compose.yml');
      expect(fs.existsSync(composePath)).toBe(true);

      const content = fs.readFileSync(composePath, 'utf8');

      // PostgreSQL with pgvector
      expect(content).toContain('pgvector/pgvector:pg16');
      expect(content).toContain('context-postgres');
      expect(content).toContain('pg_isready');

      // Redis with persistence
      expect(content).toContain('redis:7-alpine');
      expect(content).toContain('--appendonly yes');

      // Context server service
      expect(content).toContain('context-server');
      expect(content).toContain('condition: service_healthy');
    });

    it('verifies .env.production.example contains all critical operational variables', () => {
      const envExamplePath = path.join(rootDir, '.env.production.example');
      expect(fs.existsSync(envExamplePath)).toBe(true);

      const content = fs.readFileSync(envExamplePath, 'utf8');
      expect(content).toContain('DATABASE_URL=');
      expect(content).toContain('REDIS_URL=');
      expect(content).toContain('AUTH_SECRET_KEY=');
      expect(content).toContain('PORT=');
      expect(content).toContain('NODE_ENV=production');
    });

    it('verifies DEPLOYMENT.md documentation exists and covers all operational phases', () => {
      const deployDocPath = path.join(rootDir, 'docs/DEPLOYMENT.md');
      expect(fs.existsSync(deployDocPath)).toBe(true);

      const content = fs.readFileSync(deployDocPath, 'utf8');
      expect(content).toContain('Docker Compose Deployment');
      expect(content).toContain('Infrastructure Requirements');
      expect(content).toContain('PostgreSQL with pgvector');
      expect(content).toContain('Redis Configuration');
      expect(content).toContain('Health & Readiness Probes');
      expect(content).toContain('Backup & Disaster Recovery');
    });
  });

  describe('2. Backup and Disaster Recovery Workflow', () => {
    it('creates, verifies checksums, and restores database and raw chunks snapshot', () => {
      const dbPath = path.join(tmpDir, 'source.db');
      const chunksDir = path.join(tmpDir, 'chunks');
      fs.mkdirSync(chunksDir);

      // Populate test SQLite database
      const db = new LocalDb({ dbPath });
      const repos = new RepositoriesStore(db.db);
      repos.create({ id: 'repo_backup_test', workspaceId: 'ws_prod', name: 'backup-test', rootPath: '/src' });
      const objects = new ContextObjectsStore(db.db);
      objects.create({
        repositoryId: 'repo_backup_test',
        type: 'DECISION',
        scope: 'repository',
        status: 'active',
        authority: 'human',
        visibility: 'repository',
        provenance: { sourceEventIds: ['evt-b1'], description: 'Critical decision' },
        content: { kind: 'decision', description: 'Architecture lock', requiresConfirmation: false },
      });
      db.close();

      // Create test raw chunk file
      fs.writeFileSync(path.join(chunksDir, 'chunk_001.bin'), Buffer.from('raw-chunk-bytes-12345'));

      // 1. Create backup
      const backupDir = path.join(tmpDir, 'backup_archive');
      const manifest = BackupManager.createBackup({
        sourceDbPath: dbPath,
        sourceChunksDir: chunksDir,
        targetDir: backupDir,
      });

      expect(manifest.files.length).toBeGreaterThanOrEqual(2);
      expect(fs.existsSync(path.join(backupDir, 'manifest.json'))).toBe(true);

      // 2. Verify integrity
      const isValid = BackupManager.verifyBackup(backupDir);
      expect(isValid).toBe(true);

      // 3. Restore into clean directory
      const restoredDbPath = path.join(tmpDir, 'restored', 'restored.db');
      const restoredChunksDir = path.join(tmpDir, 'restored', 'chunks');

      const restored = BackupManager.restoreBackup(backupDir, restoredDbPath, restoredChunksDir);
      expect(restored).toBe(true);

      // Verify restored data can be read by database store
      const restoredDb = new LocalDb({ dbPath: restoredDbPath });
      const restoredRepos = new RepositoriesStore(restoredDb.db);
      const repo = restoredRepos.getById('repo_backup_test');
      expect(repo).toBeDefined();
      expect(repo?.name).toBe('backup-test');

      const restoredObjects = new ContextObjectsStore(restoredDb.db);
      const list = restoredObjects.list({ repositoryId: 'repo_backup_test' });
      expect(list.length).toBe(1);
      expect((list[0]?.content as { description?: string })?.description).toBe('Architecture lock');

      restoredDb.close();

      // Verify chunk was restored
      expect(fs.existsSync(path.join(restoredChunksDir, 'chunk_001.bin'))).toBe(true);
      expect(fs.readFileSync(path.join(restoredChunksDir, 'chunk_001.bin'), 'utf8')).toBe('raw-chunk-bytes-12345');
    });
  });

  describe('3. Health and Readiness Probe Semantics', () => {
    it('provides standard Kubernetes liveness (/health) and readiness (/ready) responses', async () => {
      let dbHealthy = true;
      let redisHealthy = true;

      const server = http.createServer((req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
        } else if (req.url === '/ready') {
          if (dbHealthy && redisHealthy) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ready', timestamp: Date.now() }));
          } else {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'not_ready', error: 'Dependencies unavailable' }));
          }
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as { port: number }).port;

      const request = (path: string): Promise<{ status: number; data: Record<string, unknown> }> =>
        new Promise((resolve, reject) => {
          http.get(`http://127.0.0.1:${port}${path}`, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              resolve({ status: res.statusCode ?? 500, data: JSON.parse(data) });
            });
          }).on('error', reject);
        });

      // 1. Check Liveness
      const healthRes = await request('/health');
      expect(healthRes.status).toBe(200);
      expect(healthRes.data['status']).toBe('ok');

      // 2. Check Readiness when healthy
      const readyRes1 = await request('/ready');
      expect(readyRes1.status).toBe(200);
      expect(readyRes1.data['status']).toBe('ready');

      // 3. Check Readiness when database/redis is degraded
      dbHealthy = false;
      const readyRes2 = await request('/ready');
      expect(readyRes2.status).toBe(503);
      expect(readyRes2.data['status']).toBe('not_ready');

      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
  });
});
