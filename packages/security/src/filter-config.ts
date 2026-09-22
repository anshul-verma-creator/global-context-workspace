/**
 * Filter configuration — what paths and patterns are excluded from cloud sync.
 * Per spec §18 (Architecture): defaults + workspace-configurable.
 */

export interface FilterConfig {
  /**
   * File path patterns excluded from cloud synchronization.
   * These files are never uploaded even if an event references them.
   */
  excludedPathPatterns: RegExp[];

  /**
   * Secret patterns to detect and redact in content.
   * Applied before any event payload is transmitted to cloud.
   */
  secretPatterns: SecretPattern[];

  /**
   * Whether to block events from excluded paths entirely,
   * or just redact the content and allow metadata.
   */
  blockExcludedPaths: boolean;
}

export interface SecretPattern {
  name: string;
  pattern: RegExp;
  redactWith: string;
  /** If true, the entire event is blocked, not just the matched value */
  blockEvent?: boolean;
}

/**
 * Default filter configuration per spec §18:
 * .env excluded, private keys excluded, known secrets blocked/redacted.
 */
export const DEFAULT_FILTER_CONFIG: FilterConfig = {
  blockExcludedPaths: true,
  excludedPathPatterns: [
    /^\.env$/,
    /^\.env\.[a-zA-Z]+$/,
    /^\.env\..+$/,
    /\/\.env$/,
    /\/\.env\.[a-zA-Z]+$/,
    // Private key files
    /\.pem$/i,
    /\.key$/i,
    /\.p12$/i,
    /\.pfx$/i,
    /id_rsa$/,
    /id_ed25519$/,
    /id_ecdsa$/,
    /id_dsa$/,
    // Secret configuration
    /secrets?\.(json|yaml|yml|toml)$/i,
    /credentials?\.(json|yaml|yml|toml)$/i,
    // SSH
    /\.ssh\//,
    // AWS credentials
    /\.aws\/credentials$/,
  ],
  secretPatterns: [
    {
      name: 'AWS Access Key',
      pattern: /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/g,
      redactWith: '[REDACTED:AWS_KEY]',
    },
    {
      name: 'AWS Secret Key',
      pattern: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g,
      redactWith: '[REDACTED:AWS_SECRET]',
    },
    {
      name: 'Generic API Key',
      pattern: /(?:api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*["']?([A-Za-z0-9_\-]{20,})["']?/gi,
      redactWith: '[REDACTED:API_KEY]',
    },
    {
      name: 'Generic Token',
      pattern: /(?:token|secret|password|passwd|pwd)\s*[:=]\s*["']?([A-Za-z0-9_\-./+]{8,})["']?/gi,
      redactWith: '[REDACTED:SECRET]',
    },
    {
      name: 'Private Key PEM',
      pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      redactWith: '[REDACTED:PRIVATE_KEY]',
      blockEvent: true,
    },
    {
      name: 'GitHub Token',
      pattern: /ghp_[A-Za-z0-9]{36}/g,
      redactWith: '[REDACTED:GITHUB_TOKEN]',
    },
    {
      name: 'GitHub OAuth Token',
      pattern: /gho_[A-Za-z0-9]{36}/g,
      redactWith: '[REDACTED:GITHUB_TOKEN]',
    },
    {
      name: 'Slack Token',
      pattern: /xox[baprs]-[A-Za-z0-9\-]+/g,
      redactWith: '[REDACTED:SLACK_TOKEN]',
    },
    {
      name: 'OpenAI Key',
      pattern: /sk-[A-Za-z0-9]{48}/g,
      redactWith: '[REDACTED:OPENAI_KEY]',
    },
    {
      name: 'Anthropic Key',
      pattern: /sk-ant-[A-Za-z0-9\-_]{90,}/g,
      redactWith: '[REDACTED:ANTHROPIC_KEY]',
    },
    {
      name: 'JWT',
      pattern: /eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g,
      redactWith: '[REDACTED:JWT]',
    },
    {
      name: 'Database URL with credentials',
      pattern: /(?:postgres|postgresql|mysql|mongodb):\/\/[^:]+:[^@]+@/gi,
      redactWith: '[REDACTED:DB_URL]',
    },
  ],
};

/**
 * Merge user workspace config with defaults.
 */
export function mergeFilterConfig(
  defaults: FilterConfig,
  overrides: Partial<FilterConfig>,
): FilterConfig {
  return {
    excludedPathPatterns: [
      ...defaults.excludedPathPatterns,
      ...(overrides.excludedPathPatterns ?? []),
    ],
    secretPatterns: [
      ...defaults.secretPatterns,
      ...(overrides.secretPatterns ?? []),
    ],
    blockExcludedPaths: overrides.blockExcludedPaths ?? defaults.blockExcludedPaths,
  };
}
