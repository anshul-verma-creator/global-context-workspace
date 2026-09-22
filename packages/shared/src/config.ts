/**
 * Configuration utilities.
 * Provides typed access to environment variables with validation.
 */

export class ConfigError extends Error {
  constructor(variable: string) {
    super(`Required environment variable not set: ${variable}`);
    this.name = 'ConfigError';
  }
}

/**
 * Get a required environment variable. Throws ConfigError if absent.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new ConfigError(name);
  }
  return value;
}

/**
 * Get an optional environment variable with a default.
 */
export function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

/**
 * Get an optional numeric environment variable with a default.
 */
export function optionalEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new ConfigError(`${name} must be an integer, got: ${raw}`);
  }
  return parsed;
}

/**
 * Get an optional boolean environment variable.
 */
export function optionalEnvBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  return raw === 'true' || raw === '1' || raw === 'yes';
}
