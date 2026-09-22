import path from 'node:path';
import { DEFAULT_FILTER_CONFIG, type FilterConfig } from './filter-config.js';

/**
 * File path filtering.
 * Determines if a file path should be excluded from cloud synchronization.
 *
 * Per spec §18 (Architecture): .env excluded, private keys excluded.
 */
export interface PathFilterResult {
  excluded: boolean;
  reason?: string;
}

/**
 * Check if a file path should be excluded from cloud sync.
 */
export function isPathExcluded(
  filePath: string,
  config: FilterConfig = DEFAULT_FILTER_CONFIG,
): PathFilterResult {
  const cfg = config ?? DEFAULT_FILTER_CONFIG;
  // Normalize to forward slashes for consistent matching
  const normalized = filePath.replace(/\\/g, '/');
  const basename = path.basename(normalized);

  for (const pattern of cfg.excludedPathPatterns) {
    // Test against both full path and basename
    if (pattern.test(normalized) || pattern.test(basename)) {
      return { excluded: true, reason: `Path matches exclusion pattern: ${pattern.toString()}` };
    }
  }

  return { excluded: false };
}

/**
 * Extract file paths from an event payload and check if any are excluded.
 */
export function extractEventPaths(payload: Record<string, unknown>): string[] {
  const paths: string[] = [];

  if (typeof payload['path'] === 'string') {
    paths.push(payload['path']);
  }
  if (typeof payload['resource'] === 'string') {
    paths.push(payload['resource']);
  }
  if (typeof payload['filePath'] === 'string') {
    paths.push(payload['filePath']);
  }

  return paths;
}
