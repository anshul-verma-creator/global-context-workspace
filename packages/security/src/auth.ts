import { generateId, nowMs, createLogger } from '@context-workspace/shared';
import crypto from 'node:crypto';

const log = createLogger({ component: 'auth' });

export type UserRole = 'admin' | 'developer' | 'agent' | 'viewer';

export type AuthPermission =
  | 'read_events'
  | 'write_events'
  | 'manage_leases'
  | 'read_context'
  | 'write_context'
  | 'manage_capsules';

const ROLE_PERMISSIONS: Record<UserRole, Set<AuthPermission>> = {
  admin: new Set([
    'read_events',
    'write_events',
    'manage_leases',
    'read_context',
    'write_context',
    'manage_capsules',
  ]),
  developer: new Set([
    'read_events',
    'write_events',
    'manage_leases',
    'read_context',
    'write_context',
    'manage_capsules',
  ]),
  agent: new Set([
    'read_events',
    'write_events',
    'manage_leases',
    'read_context',
    'write_context',
  ]),
  viewer: new Set(['read_events', 'read_context']),
};

export interface DeviceRecord {
  deviceId: string;
  userId: string;
  deviceName: string;
  registeredAt: number;
  revokedAt?: number;
  revocationReason?: string;
}

export interface RuntimeTokenPayload {
  tokenId: string;
  userId: string;
  deviceId: string;
  role: UserRole;
  allowedRepositories: string[]; // Scoped repository isolation
  allowedCapsules?: string[]; // Optional capsule-level isolation
  issuedAt: number;
  expiresAt: number;
}

/**
 * DeviceRegistry — Manages device registration and revocation (Phase 23).
 */
export class DeviceRegistry {
  private readonly devices = new Map<string, DeviceRecord>();

  registerDevice(deviceId: string, userId: string, deviceName: string): DeviceRecord {
    const record: DeviceRecord = {
      deviceId,
      userId,
      deviceName,
      registeredAt: nowMs(),
    };
    this.devices.set(deviceId, record);
    log.info('Device registered', { deviceId, userId });
    return record;
  }

  revokeDevice(deviceId: string, reason = 'Administrative revocation'): boolean {
    const record = this.devices.get(deviceId);
    if (!record) return false;

    record.revokedAt = nowMs();
    record.revocationReason = reason;
    log.warn('Device revoked', { deviceId, reason });
    return true;
  }

  isDeviceRevoked(deviceId: string): boolean {
    const record = this.devices.get(deviceId);
    return record?.revokedAt !== undefined;
  }

  getDevice(deviceId: string): DeviceRecord | undefined {
    return this.devices.get(deviceId);
  }
}

/**
 * TokenManager — Issues and validates short-lived scoped runtime tokens (Phase 23).
 */
export class TokenManager {
  private readonly secretKey: string;
  private readonly deviceRegistry: DeviceRegistry;
  private readonly DEFAULT_TTL_MS = 3600_000; // 1 hour

  constructor(secretKey: string, deviceRegistry: DeviceRegistry) {
    this.secretKey = secretKey;
    this.deviceRegistry = deviceRegistry;
  }

  /**
   * Issue a short-lived scoped runtime token.
   */
  issueToken(params: {
    userId: string;
    deviceId: string;
    role: UserRole;
    allowedRepositories: string[];
    allowedCapsules?: string[];
    ttlMs?: number;
  }): string {
    const now = nowMs();
    const ttl = params.ttlMs ?? this.DEFAULT_TTL_MS;

    const payload: RuntimeTokenPayload = {
      tokenId: generateId(),
      userId: params.userId,
      deviceId: params.deviceId,
      role: params.role,
      allowedRepositories: params.allowedRepositories,
      ...(params.allowedCapsules !== undefined ? { allowedCapsules: params.allowedCapsules } : {}),
      issuedAt: now,
      expiresAt: now + ttl,
    };

    const serialized = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', this.secretKey)
      .update(serialized)
      .digest('base64url');

    return `${serialized}.${signature}`;
  }

  /**
   * Verify token signature, expiration, and device revocation status.
   */
  verifyToken(token: string): { valid: boolean; payload?: RuntimeTokenPayload; error?: string } {
    const parts = token.split('.');
    if (parts.length !== 2) {
      return { valid: false, error: 'Invalid token format' };
    }

    const [serialized, signature] = parts as [string, string];
    const expectedSig = crypto
      .createHmac('sha256', this.secretKey)
      .update(serialized)
      .digest('base64url');

    if (signature !== expectedSig) {
      return { valid: false, error: 'Invalid token signature' };
    }

    try {
      const payload = JSON.parse(
        Buffer.from(serialized, 'base64url').toString('utf8'),
      ) as RuntimeTokenPayload;

      // Check expiration
      if (nowMs() > payload.expiresAt) {
        return { valid: false, error: 'Token expired' };
      }

      // Check device revocation
      if (this.deviceRegistry.isDeviceRevoked(payload.deviceId)) {
        return { valid: false, error: 'Device has been revoked' };
      }

      return { valid: true, payload };
    } catch {
      return { valid: false, error: 'Corrupt token payload' };
    }
  }
}

export interface AuthorizationResult {
  allowed: boolean;
  reason?: string;
}

/**
 * AuthorizationEngine — Enforces Repository Isolation, Capsule Visibility, and RBAC (Phase 23).
 *
 * Acceptance invariant:
 *   Unauthorized clients cannot read another repository.
 */
export class AuthorizationEngine {
  constructor(private readonly tokenManager: TokenManager) {}

  /**
   * Verify whether a client token is authorized to access a repository.
   * Strictly enforces repository isolation.
   */
  authorizeRepositoryAccess(
    tokenString: string,
    targetRepositoryId: string,
    permission: AuthPermission,
  ): AuthorizationResult {
    const verified = this.tokenManager.verifyToken(tokenString);
    if (!verified.valid || !verified.payload) {
      return { allowed: false, reason: verified.error ?? 'Authentication required' };
    }

    const payload = verified.payload;

    // 1. Enforce Repository Isolation: client MUST have target repository in allowedRepositories
    if (!payload.allowedRepositories.includes(targetRepositoryId)) {
      log.warn('Cross-repository access violation blocked', {
        userId: payload.userId,
        targetRepo: targetRepositoryId,
        allowedRepos: payload.allowedRepositories.join(', '),
      });
      return {
        allowed: false,
        reason: `Access denied: client is not authorized for repository '${targetRepositoryId}'`,
      };
    }

    // 2. Enforce RBAC permission check
    const rolePerms = ROLE_PERMISSIONS[payload.role];
    if (!rolePerms || !rolePerms.has(permission)) {
      return {
        allowed: false,
        reason: `Role '${payload.role}' lacks permission '${permission}'`,
      };
    }

    return { allowed: true };
  }

  /**
   * Verify capsule-level access.
   */
  authorizeCapsuleAccess(
    tokenString: string,
    targetRepositoryId: string,
    targetCapsuleId: string,
    permission: AuthPermission,
  ): AuthorizationResult {
    // First repository isolation must pass
    const repoAuth = this.authorizeRepositoryAccess(tokenString, targetRepositoryId, permission);
    if (!repoAuth.allowed) return repoAuth;

    const verified = this.tokenManager.verifyToken(tokenString);
    const payload = verified.payload!;

    // If token has scoped capsule restrictions, check them
    if (payload.allowedCapsules && payload.allowedCapsules.length > 0) {
      if (!payload.allowedCapsules.includes(targetCapsuleId)) {
        return {
          allowed: false,
          reason: `Access denied: client is restricted from capsule '${targetCapsuleId}'`,
        };
      }
    }

    return { allowed: true };
  }
}
