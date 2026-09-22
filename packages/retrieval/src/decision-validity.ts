import type { ContextObject } from '@context-workspace/protocol';
import type { RelationsStore } from '@context-workspace/database';
import type { DecisionValidity, ValidatedDecision } from './retrieval-query.js';
import { nowMs } from '@context-workspace/shared';

/**
 * Decision validity resolver.
 *
 * Resolves the validity state of DECISION context objects by walking the
 * supersession relation chain in the relations graph.
 *
 * Critical design rule (per user requirement):
 *   Recency alone is NEVER sufficient to determine whether a decision is current.
 *   A newer decision does not supersede an older one unless a 'supersedes'
 *   relation exists in the relation graph.
 *
 * Resolution algorithm (evaluated in order):
 * 1. REJECTED   — object.status === 'rejected'
 * 2. SUPERSEDED — another decision has a 'supersedes' relation where toId === this.id
 *                 (explicit supersession takes precedence over expiration)
 * 3. EXPIRED    — object.validUntil is set and < now (for decisions not superseded)
 * 4. ACTIVE     — no incoming supersession; either has outgoing supersessions,
 *                 or status is 'active' / 'confirmed'
 * 5. UNKNOWN    — no relation data and none of the above apply
 *
 * Chains (A supersedes B, C supersedes A):
 *   B = SUPERSEDED(by A), A = SUPERSEDED(by C), C = ACTIVE
 */
export class DecisionValidityResolver {
  private readonly relStore: RelationsStore;

  constructor(relStore: RelationsStore) {
    this.relStore = relStore;
  }

  /**
   * Resolve validity for a single decision object.
   * Uses individual DB queries — use resolveBatch() for multiple decisions.
   */
  resolve(decision: ContextObject): ValidatedDecision {
    if (decision.type !== 'DECISION') {
      return { object: decision, validity: 'UNKNOWN' };
    }

    // Rule 1: Explicitly rejected
    if (decision.status === 'rejected') {
      return { object: decision, validity: 'REJECTED' };
    }

    // Rule 2: Check for incoming 'supersedes' relations (explicit supersession takes precedence over expiration)
    // listTo(id, 'supersedes') returns all relations where toId === decision.id
    const incomingSupersessions = this.relStore.listTo(decision.id, 'supersedes');

    if (incomingSupersessions.length > 0) {
      const supersederId = incomingSupersessions[0]?.fromId;
      return {
        object: decision,
        validity: 'SUPERSEDED',
        ...(supersederId !== undefined ? { supersededBy: supersederId } : {}),
      };
    }

    // Rule 3: Expired by validity window (for decisions that were NOT superseded)
    if (decision.validUntil !== undefined && decision.validUntil < nowMs()) {
      return { object: decision, validity: 'EXPIRED' };
    }

    // Rule 4: Check for outgoing 'supersedes' relations (this supersedes others)
    // listFrom(id, 'supersedes') returns all relations where fromId === decision.id
    const outgoingSupersessions = this.relStore.listFrom(decision.id, 'supersedes');

    if (outgoingSupersessions.length > 0 || decision.status === 'active' || decision.status === 'confirmed') {
      const result: ValidatedDecision = {
        object: decision,
        validity: 'ACTIVE',
        ...(outgoingSupersessions.length > 0
          ? { supersedes: outgoingSupersessions.map((r) => r.toId) }
          : {}),
      };
      return result;
    }

    // Rule 5: Unknown — no relation data, not clearly active
    return { object: decision, validity: 'UNKNOWN' };
  }

  /**
   * Resolve validity for a batch of decisions efficiently.
   *
   * Builds a complete supersession map by querying outgoing 'supersedes'
   * relations for each decision, then derives incoming supersession from that.
   * Also catches the case where an external decision (not in the batch) supersedes
   * one in the batch, by issuing listTo() for any that weren't covered.
   */
  resolveBatch(decisions: ContextObject[]): ValidatedDecision[] {
    if (decisions.length === 0) return [];

    // Step 1: For every decision in batch, query outgoing supersessions
    // supersedes[fromId] = [toId, ...]
    const outgoingMap = new Map<string, string[]>();
    // incomingMap[toId] = [fromId, ...]
    const incomingMap = new Map<string, string[]>();

    for (const decision of decisions) {
      const outgoing = this.relStore.listFrom(decision.id, 'supersedes');
      if (outgoing.length > 0) {
        const targets = outgoing.map((r) => r.toId);
        outgoingMap.set(decision.id, targets);
        for (const rel of outgoing) {
          const existing = incomingMap.get(rel.toId) ?? [];
          existing.push(decision.id);
          incomingMap.set(rel.toId, existing);
        }
      }
    }

    // Step 2: For any decision not covered by outgoing map as a target,
    // check if an external decision (outside the batch) supersedes it
    for (const decision of decisions) {
      if (!incomingMap.has(decision.id)) {
        const incoming = this.relStore.listTo(decision.id, 'supersedes');
        if (incoming.length > 0) {
          incomingMap.set(decision.id, incoming.map((r) => r.fromId));
        }
      }
    }

    // Step 3: Resolve each decision
    return decisions.map((decision): ValidatedDecision => {
      if (decision.type !== 'DECISION') return { object: decision, validity: 'UNKNOWN' };

      // Rule 1: Rejected
      if (decision.status === 'rejected') {
        return { object: decision, validity: 'REJECTED' };
      }

      // Rule 2: Superseded (explicit supersession takes precedence over expiration)
      const incomingSuperseders = incomingMap.get(decision.id);
      if (incomingSuperseders !== undefined && incomingSuperseders.length > 0) {
        const supersederId = incomingSuperseders[0];
        return {
          object: decision,
          validity: 'SUPERSEDED',
          ...(supersederId !== undefined ? { supersededBy: supersederId } : {}),
        };
      }

      // Rule 3: Expired (for decisions that were NOT superseded)
      if (decision.validUntil !== undefined && decision.validUntil < nowMs()) {
        return { object: decision, validity: 'EXPIRED' };
      }

      // Rule 4: Active
      const outgoingTargets = outgoingMap.get(decision.id);
      if (
        (outgoingTargets !== undefined && outgoingTargets.length > 0) ||
        decision.status === 'active' ||
        decision.status === 'confirmed'
      ) {
        return {
          object: decision,
          validity: 'ACTIVE',
          ...(outgoingTargets !== undefined && outgoingTargets.length > 0
            ? { supersedes: outgoingTargets }
            : {}),
        };
      }

      // Rule 5: Unknown
      return { object: decision, validity: 'UNKNOWN' };
    });
  }
}
