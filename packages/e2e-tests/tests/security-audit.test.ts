import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LocalDb, RepositoriesStore, ContextObjectsStore } from '@context-workspace/database';
import { SecretFilter, isPathExcluded } from '@context-workspace/security';
import { DeviceRegistry, TokenManager, AuthorizationEngine } from '@context-workspace/security';
import { McpServer } from '@context-workspace/mcp';
import { ContextRuntime } from '@context-workspace/runtime';

describe('Phase 28 — Security Audit & Controls Verification', () => {
  let tmpDir: string;
  let db: LocalDb;
  let objectsStore: ContextObjectsStore;
  let deviceRegistry: DeviceRegistry;
  let tokenManager: TokenManager;
  let authEngine: AuthorizationEngine;

  const SECRET_KEY = 'super-secret-hmac-key-for-audit-tests';
  const REPO_ALPHA = 'repo_security_alpha';
  const REPO_BETA = 'repo_security_beta';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-sec-audit-'));
    db = new LocalDb({ dbPath: path.join(tmpDir, 'audit.db') });
    new RepositoriesStore(db.db).create({ id: REPO_ALPHA, workspaceId: 'ws_sec', name: 'alpha', rootPath: '/alpha' });
    new RepositoriesStore(db.db).create({ id: REPO_BETA, workspaceId: 'ws_sec', name: 'beta', rootPath: '/beta' });
    objectsStore = new ContextObjectsStore(db.db);

    deviceRegistry = new DeviceRegistry();
    tokenManager = new TokenManager(SECRET_KEY, deviceRegistry);
    authEngine = new AuthorizationEngine(tokenManager);
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('1. Secret Filtering & Redaction', () => {
    it('blocks high-entropy secrets and sensitive files', () => {
      const filter = new SecretFilter();

      // Test AWS key detection (redacted)
      const awsCheck = filter.filterContent('My AWS key is AKIAIOSFODNN7EXAMPLE');
      expect(awsCheck.redacted).toContain('[REDACTED:AWS_KEY]');
      expect(awsCheck.redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');

      // Test private key detection (blocked)
      const privKeyCheck = filter.filterContent('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\n-----END RSA PRIVATE KEY-----');
      expect(privKeyCheck.blocked).toBe(true);
      expect(privKeyCheck.allowed).toBe(false);

      // Test OpenAI key detection (redacted)
      const openAiKey = 'sk-' + 'A'.repeat(48);
      const openAiCheck = filter.filterContent(`My API key is ${openAiKey}`);
      expect(openAiCheck.redacted).toContain('[REDACTED:OPENAI_KEY]');
      expect(openAiCheck.redacted).not.toContain(openAiKey);

      // Test path exclusion
      expect(isPathExcluded('.env.production').excluded).toBe(true);
      expect(isPathExcluded('.env.local').excluded).toBe(true);
      expect(isPathExcluded('cert.pem').excluded).toBe(true);
      expect(isPathExcluded('id_rsa').excluded).toBe(true);

      // Safe paths are not excluded
      expect(isPathExcluded('packages/core/index.ts').excluded).toBe(false);
    });

    it('redacts secrets in content without dropping non-secret payload metadata', () => {
      const filter = new SecretFilter();
      const openAiKey = 'sk-' + 'B'.repeat(48);
      const rawPayload = `Connecting with ${openAiKey} to service`;
      const filtered = filter.filterContent(rawPayload);

      expect(filtered.redacted).not.toContain(openAiKey);
      expect(filtered.redacted).toContain('[REDACTED:OPENAI_KEY]');
      expect(filtered.redacted).toContain('Connecting with');
      expect(filtered.redacted).toContain('to service');
    });
  });

  describe('2. Authentication & Scoped Token Security', () => {
    it('validates authentic signatures and rejects tampered signatures', () => {
      deviceRegistry.registerDevice('dev_audit_1', 'user_auditor', 'Audit Device');

      const validToken = tokenManager.issueToken({
        userId: 'user_auditor',
        deviceId: 'dev_audit_1',
        role: 'developer',
        allowedRepositories: [REPO_ALPHA],
      });

      const verification = tokenManager.verifyToken(validToken);
      expect(verification.valid).toBe(true);
      expect(verification.payload?.userId).toBe('user_auditor');

      // Tamper with payload (change userId to admin)
      const [payloadB64, sig] = validToken.split('.') as [string, string];
      const decodedPayload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      decodedPayload.role = 'admin';
      const tamperedPayloadB64 = Buffer.from(JSON.stringify(decodedPayload)).toString('base64url');
      const tamperedToken = `${tamperedPayloadB64}.${sig}`;

      const tamperedVerification = tokenManager.verifyToken(tamperedToken);
      expect(tamperedVerification.valid).toBe(false);
      expect(tamperedVerification.error).toMatch(/signature/i);
    });

    it('immediately rejects tokens from revoked devices', () => {
      deviceRegistry.registerDevice('dev_lost_laptop', 'user_victim', 'Compromised Laptop');

      const token = tokenManager.issueToken({
        userId: 'user_victim',
        deviceId: 'dev_lost_laptop',
        role: 'developer',
        allowedRepositories: [REPO_ALPHA],
      });

      // Token is valid initially
      expect(tokenManager.verifyToken(token).valid).toBe(true);

      // Revoke the compromised device
      deviceRegistry.revokeDevice('dev_lost_laptop', 'Stolen at conference');

      // Token is immediately rejected
      const revokedCheck = tokenManager.verifyToken(token);
      expect(revokedCheck.valid).toBe(false);
      expect(revokedCheck.error).toMatch(/revoked/i);
    });

    it('rejects expired tokens', () => {
      deviceRegistry.registerDevice('dev_exp', 'user_exp', 'Exp Device');

      // Issue token with 1ms TTL
      const token = tokenManager.issueToken({
        userId: 'user_exp',
        deviceId: 'dev_exp',
        role: 'developer',
        allowedRepositories: [REPO_ALPHA],
        ttlMs: 1,
      });

      // Wait 15ms
      const start = Date.now();
      while (Date.now() - start < 15) {}

      const verification = tokenManager.verifyToken(token);
      expect(verification.valid).toBe(false);
      expect(verification.error).toMatch(/expired/i);
    });
  });

  describe('3. Strict Repository Isolation & RBAC', () => {
    it('prevents cross-repository data leakage', () => {
      deviceRegistry.registerDevice('dev_team_a', 'user_team_a', 'Team A Laptop');

      const tokenAlphaOnly = tokenManager.issueToken({
        userId: 'user_team_a',
        deviceId: 'dev_team_a',
        role: 'developer',
        allowedRepositories: [REPO_ALPHA], // Strictly ALPHA
      });

      // Access to REPO_ALPHA is allowed
      const authAlpha = authEngine.authorizeRepositoryAccess(tokenAlphaOnly, REPO_ALPHA, 'read_context');
      expect(authAlpha.allowed).toBe(true);

      // Access to REPO_BETA is blocked by repository isolation
      const authBeta = authEngine.authorizeRepositoryAccess(tokenAlphaOnly, REPO_BETA, 'read_context');
      expect(authBeta.allowed).toBe(false);
      expect(authBeta.reason).toMatch(/not authorized for repository/i);
    });

    it('enforces RBAC permissions based on role', () => {
      deviceRegistry.registerDevice('dev_viewer', 'user_viewer', 'Viewer Device');

      const viewerToken = tokenManager.issueToken({
        userId: 'user_viewer',
        deviceId: 'dev_viewer',
        role: 'viewer', // Read-only
        allowedRepositories: [REPO_ALPHA],
      });

      // Read context is allowed for viewer
      const readAuth = authEngine.authorizeRepositoryAccess(viewerToken, REPO_ALPHA, 'read_context');
      expect(readAuth.allowed).toBe(true);

      // Write context is forbidden for viewer
      const writeAuth = authEngine.authorizeRepositoryAccess(viewerToken, REPO_ALPHA, 'write_context');
      expect(writeAuth.allowed).toBe(false);
      expect(writeAuth.reason).toMatch(/lacks permission/i);

      // Manage leases is forbidden for viewer
      const leaseAuth = authEngine.authorizeRepositoryAccess(viewerToken, REPO_ALPHA, 'manage_leases');
      expect(leaseAuth.allowed).toBe(false);
    });
  });

  describe('4. MCP & Local Storage Auditability', () => {
    it('records provenance on all created context objects', () => {
      const obj = objectsStore.create({
        repositoryId: REPO_ALPHA,
        type: 'DECISION',
        scope: 'repository',
        status: 'active',
        authority: 'agent_explicit',
        visibility: 'repository',
        provenance: {
          sourceEventIds: ['evt-audit-prov-1'],
          sessionId: 'sess-audit',
          description: 'Audited decision',
        },
        content: {
          kind: 'decision',
          description: 'Auditable decision',
          requiresConfirmation: false,
        },
      });

      expect(obj.provenance.sourceEventIds).toContain('evt-audit-prov-1');
      expect(obj.createdAt).toBeGreaterThan(0);
      expect(obj.updatedAt).toBeGreaterThan(0);
      expect(obj.version).toBe(1);
    });

    it('MCP server enforces object existence verification', async () => {
      const runtime = new ContextRuntime({ dbPath: path.join(tmpDir, 'mcp-sec.db') });
      await runtime.start();
      runtime.repositories.create({ id: REPO_ALPHA, workspaceId: 'ws_sec', name: 'alpha', rootPath: '/alpha' });

      const mcp = new McpServer(runtime);

      // Querying non-existent context object returns structured isError response
      const res = await mcp.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'context.get',
          arguments: { id: 'non-existent-obj-12345' },
        },
      });

      expect(res.result.isError).toBe(true);
      expect(res.result.content[0]?.text).toContain('Context object not found');

      await runtime.stop();
    });
  });
});
