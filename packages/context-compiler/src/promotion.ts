import type { ContextObject, ContextObjectStatus } from '@context-workspace/protocol';

/**
 * Promotion engine — automatically promotes candidate context objects to active/confirmed status.
 *
 * Per spec §14 (Architecture): "implicit from events (agent_inferred/static_analysis)"
 * objects are promoted when evidence accumulates.
 */

export interface PromotionRule {
  /** Authority levels eligible for promotion */
  fromAuthority: string[];
  fromStatus: ContextObjectStatus;
  toStatus: ContextObjectStatus;
  /** Minimum evidence events to trigger promotion */
  minEvidenceEvents: number;
  /** Human confirmation required? */
  requiresHumanConfirmation: boolean;
}

/** Default promotion rules per spec §14. */
export const DEFAULT_PROMOTION_RULES: PromotionRule[] = [
  {
    fromAuthority: ['agent_inferred', 'static_analysis'],
    fromStatus: 'candidate',
    toStatus: 'active',
    minEvidenceEvents: 3,
    requiresHumanConfirmation: false,
  },
  {
    fromAuthority: ['agent_inferred'],
    fromStatus: 'active',
    toStatus: 'confirmed',
    minEvidenceEvents: 5,
    requiresHumanConfirmation: true, // Human must confirm inferred decisions
  },
  {
    fromAuthority: ['agent_explicit', 'human'],
    fromStatus: 'candidate',
    toStatus: 'active',
    minEvidenceEvents: 1,
    requiresHumanConfirmation: false,
  },
];

/**
 * Check if a context object is eligible for promotion given its evidence count.
 */
export function checkPromotion(
  obj: ContextObject,
  evidenceCount: number,
  rules: PromotionRule[] = DEFAULT_PROMOTION_RULES,
): { eligible: boolean; toStatus?: ContextObjectStatus; requiresConfirmation?: boolean } {
  for (const rule of rules) {
    if (
      rule.fromStatus === obj.status &&
      rule.fromAuthority.includes(obj.authority) &&
      evidenceCount >= rule.minEvidenceEvents
    ) {
      return {
        eligible: true,
        toStatus: rule.toStatus,
        requiresConfirmation: rule.requiresHumanConfirmation,
      };
    }
  }
  return { eligible: false };
}
