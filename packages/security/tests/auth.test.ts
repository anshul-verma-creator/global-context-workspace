import { describe, it, expect, beforeEach } from 'vitest';
import { DeviceRegistry, TokenManager, AuthorizationEngine } from '../src/auth.js';

describe('Phase 23 — Authentication and Authorization', () => {
  let deviceRegistry: DeviceRegistry;
  let tokenManager: TokenManager;
  let authEngine: AuthorizationEngine;
  const secretKey = 'super-secret-hmac-key-for-tests';

  beforeEach(() => {
    deviceRegistry = new DeviceRegistry();
    tokenManager = new TokenManager(secretKey, deviceRegistry);
    authEngine = new AuthorizationEngine(tokenManager);
  });

  it('registers devices and verifies active status', () => {
    const dev = deviceRegistry.registerDevice('dev_laptop_1', 'user_alice', "Alice's MacBook Pro");
    expect(dev.deviceId).toBe('dev_laptop_1');
    expect(dev.userId).toBe('user_alice');
    expect(deviceRegistry.isDeviceRevoked('dev_laptop_1')).toBe(false);
  });

  it('issues signed short-lived runtime tokens and verifies them', () => {
    deviceRegistry.registerDevice('dev_1', 'user_1', 'Laptop');
    const token = tokenManager.issueToken({
      userId: 'user_1',
      deviceId: 'dev_1',
      role: 'developer',
      allowedRepositories: ['repo_payments'],
      ttlMs: 3600_000,
    });

    const verification = tokenManager.verifyToken(token);
    expect(verification.valid).toBe(true);
    expect(verification.payload?.userId).toBe('user_1');
    expect(verification.payload?.allowedRepositories).toEqual(['repo_payments']);
  });

  it('rejects expired tokens', () => {
    deviceRegistry.registerDevice('dev_1', 'user_1', 'Laptop');
    const expiredToken = tokenManager.issueToken({
      userId: 'user_1',
      deviceId: 'dev_1',
      role: 'developer',
      allowedRepositories: ['repo_payments'],
      ttlMs: -1000, // Expired in past
    });

    const verification = tokenManager.verifyToken(expiredToken);
    expect(verification.valid).toBe(false);
    expect(verification.error).toBe('Token expired');
  });

  it('rejects tokens from revoked devices immediately', () => {
    deviceRegistry.registerDevice('dev_lost', 'user_bob', 'Lost Laptop');
    const token = tokenManager.issueToken({
      userId: 'user_bob',
      deviceId: 'dev_lost',
      role: 'developer',
      allowedRepositories: ['repo_payments'],
    });

    // Device is active
    expect(tokenManager.verifyToken(token).valid).toBe(true);

    // Revoke device
    deviceRegistry.revokeDevice('dev_lost', 'Device lost in transit');
    expect(deviceRegistry.isDeviceRevoked('dev_lost')).toBe(true);

    // Verification must now fail!
    const res = tokenManager.verifyToken(token);
    expect(res.valid).toBe(false);
    expect(res.error).toBe('Device has been revoked');
  });

  it('strictly enforces repository isolation — unauthorized clients cannot read another repository', () => {
    deviceRegistry.registerDevice('dev_alice', 'user_alice', 'Work Laptop');

    // Alice is ONLY allowed access to repo_alpha
    const aliceToken = tokenManager.issueToken({
      userId: 'user_alice',
      deviceId: 'dev_alice',
      role: 'developer',
      allowedRepositories: ['repo_alpha'],
    });

    // 1. Access to repo_alpha: ALLOWED
    const accessOwn = authEngine.authorizeRepositoryAccess(aliceToken, 'repo_alpha', 'read_events');
    expect(accessOwn.allowed).toBe(true);

    // 2. Acceptance check: Attempting to read another repository (repo_secret_beta): BLOCKED!
    const accessOther = authEngine.authorizeRepositoryAccess(aliceToken, 'repo_secret_beta', 'read_events');
    expect(accessOther.allowed).toBe(false);
    expect(accessOther.reason).toContain("client is not authorized for repository 'repo_secret_beta'");
  });

  it('enforces RBAC permissions based on user role', () => {
    deviceRegistry.registerDevice('dev_viewer', 'user_viewer', 'Auditor Laptop');

    const viewerToken = tokenManager.issueToken({
      userId: 'user_viewer',
      deviceId: 'dev_viewer',
      role: 'viewer',
      allowedRepositories: ['repo_alpha'],
    });

    // Viewer CAN read
    const readAuth = authEngine.authorizeRepositoryAccess(viewerToken, 'repo_alpha', 'read_events');
    expect(readAuth.allowed).toBe(true);

    // Viewer CANNOT write events
    const writeAuth = authEngine.authorizeRepositoryAccess(viewerToken, 'repo_alpha', 'write_events');
    expect(writeAuth.allowed).toBe(false);
    expect(writeAuth.reason).toContain("Role 'viewer' lacks permission 'write_events'");
  });

  it('enforces scoped capsule visibility', () => {
    deviceRegistry.registerDevice('dev_charlie', 'user_charlie', 'Dev Laptop');

    // Scoped only to capsule_feature_1
    const scopedToken = tokenManager.issueToken({
      userId: 'user_charlie',
      deviceId: 'dev_charlie',
      role: 'developer',
      allowedRepositories: ['repo_alpha'],
      allowedCapsules: ['capsule_feature_1'],
    });

    const allowedCapsule = authEngine.authorizeCapsuleAccess(
      scopedToken,
      'repo_alpha',
      'capsule_feature_1',
      'read_events',
    );
    expect(allowedCapsule.allowed).toBe(true);

    const restrictedCapsule = authEngine.authorizeCapsuleAccess(
      scopedToken,
      'repo_alpha',
      'capsule_internal_admin',
      'read_events',
    );
    expect(restrictedCapsule.allowed).toBe(false);
    expect(restrictedCapsule.reason).toContain("client is restricted from capsule 'capsule_internal_admin'");
  });
});
