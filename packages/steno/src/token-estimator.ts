/**
 * Token estimator for Steno output.
 *
 * Per spec §15 (Architecture): token estimation must be provider-aware.
 * Per spec §15 (Context Compiler): hard maximum context budget.
 *
 * Design decision: We provide a heuristic estimator as the default
 * (approximately 4 chars per token for English text).
 * Provider-specific tokenizers can override the estimator when available.
 *
 * The earlier tokenizer experiments showed that character compression
 * does NOT guarantee token compression. We estimate tokens, not chars.
 */

export interface TokenEstimator {
  estimate(text: string): number;
  provider: string;
}

/**
 * Heuristic estimator — approximately 4 chars per token for English.
 * This is an approximation. For production, use a real tokenizer API.
 */
export const heuristicEstimator: TokenEstimator = {
  provider: 'heuristic',
  estimate(text: string): number {
    // Simple approximation: ~4 chars per token, minimum 1
    return Math.max(1, Math.ceil(text.length / 4));
  },
};

/**
 * Estimate token count for a Steno document string.
 */
export function estimateTokens(
  text: string,
  estimator: TokenEstimator = heuristicEstimator,
): number {
  return estimator.estimate(text);
}

/**
 * Provider serializer interface — allows providers to define their own
 * optimal format from the canonical Steno representation.
 *
 * Per spec §15 (Architecture): provider-specific serializer interface.
 */
export interface ProviderSerializer {
  providerName: string;
  /** Convert Steno string to provider-optimized format */
  serialize(stenoText: string): string;
  /** Convert provider format back to Steno */
  deserialize(providerText: string): string;
}

/**
 * Identity serializer — passes through Steno as-is.
 * Used when no provider-specific optimization is available.
 */
export const identitySerializer: ProviderSerializer = {
  providerName: 'generic',
  serialize(text: string): string {
    return text;
  },
  deserialize(text: string): string {
    return text;
  },
};
