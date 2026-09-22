import { createHash } from 'node:crypto';

/**
 * Compute SHA-256 hash of a Buffer or string.
 * Returns hex-encoded string.
 */
export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Compute SHA-256 of multiple pieces of data concatenated.
 */
export function sha256Multi(...parts: (Buffer | string)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest('hex');
}

/**
 * Compute a short content-based hash suitable for deduplication keys.
 * Uses the first 16 hex characters of SHA-256 (64 bits).
 */
export function contentHash(data: Buffer | string): string {
  return sha256(data).substring(0, 16);
}
