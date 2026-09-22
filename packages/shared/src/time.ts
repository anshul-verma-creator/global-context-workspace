/**
 * Time utilities.
 * All timestamps in this system are Unix milliseconds (number).
 */

/**
 * Current time in Unix milliseconds.
 */
export function nowMs(): number {
  return Date.now();
}

/**
 * Convert Unix milliseconds to ISO string for display/logging.
 */
export function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Duration helpers in milliseconds.
 */
export const Duration = {
  seconds: (n: number) => n * 1_000,
  minutes: (n: number) => n * 60_000,
  hours: (n: number) => n * 3_600_000,
  days: (n: number) => n * 86_400_000,
} as const;
