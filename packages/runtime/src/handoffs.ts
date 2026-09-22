import type { ContextObjectsStore } from '@context-workspace/database';
import type { ContextObject } from '@context-workspace/protocol';
import { generateId, nowMs, createLogger } from '@context-workspace/shared';

const log = createLogger({ component: 'handoffs' });

export interface HandoffLink {
  title: string;
  url: string;
}

export interface StructuredHandoff {
  completed: string[];
  remaining: string[];
  next_step: string;
  blockers: string[];
  placeholders: string[];
  known_issues: string[];
  summary: string;
  links: HandoffLink[];
  authorAgentId?: string;
  sessionId?: string;
  createdAt: number;
}

export interface CreateHandoffParams {
  repositoryId: string;
  capsuleId?: string;
  sessionId?: string;
  authorAgentId?: string;
  completed: string[];
  remaining: string[];
  next_step: string;
  blockers?: string[];
  placeholders?: string[];
  known_issues?: string[];
  summary: string;
  links?: HandoffLink[];
}

/**
 * HandoffManager — Manages structured handoffs between AI agents (Phase 15).
 *
 * Enables Agent A to finish work and Agent B to retrieve a compact,
 * structured handoff to resume immediately without needing the full chat transcript.
 */
export class HandoffManager {
  constructor(private readonly objectsStore: ContextObjectsStore) {}

  /**
   * Create and record a new structured handoff.
   */
  createHandoff(params: CreateHandoffParams): ContextObject {
    const id = generateId();
    const now = nowMs();

    const handoffData: StructuredHandoff = {
      completed: params.completed,
      remaining: params.remaining,
      next_step: params.next_step,
      blockers: params.blockers ?? [],
      placeholders: params.placeholders ?? [],
      known_issues: params.known_issues ?? [],
      summary: params.summary,
      links: params.links ?? [],
      ...(params.authorAgentId !== undefined ? { authorAgentId: params.authorAgentId } : {}),
      ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
      createdAt: now,
    };

    const obj = this.objectsStore.create(
      {
        repositoryId: params.repositoryId,
        ...(params.capsuleId !== undefined ? { capsuleId: params.capsuleId } : {}),
        type: 'HANDOFF',
        scope: params.capsuleId !== undefined ? 'capsule' : 'repository',
        visibility: 'repository',
        status: 'active',
        authority: 'agent_explicit',
        provenance: {
          sourceEventIds: [`gen-${id}`],
          ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
          ...(params.capsuleId !== undefined ? { capsuleId: params.capsuleId } : {}),
        },
        validFrom: now,
        content: {
          kind: 'handoff',
          ...handoffData,
        } as any,
      },
      id,
    );

    log.info('Structured handoff recorded', {
      id: obj.id,
      repositoryId: params.repositoryId,
      next_step: params.next_step,
      author: params.authorAgentId ?? 'unknown',
    });

    return obj;
  }

  /**
   * Retrieve the latest handoff for a repository (or specific capsule).
   */
  getLatestHandoff(repositoryId: string, capsuleId?: string): ContextObject | undefined {
    const objects = this.objectsStore.list({
      repositoryId,
      types: ['HANDOFF'],
      ...(capsuleId !== undefined ? { capsuleId } : {}),
    });

    if (objects.length === 0) return undefined;

    // Sort by created timestamp descending
    return objects.sort((a: ContextObject, b: ContextObject) => b.createdAt - a.createdAt)[0];
  }

  /**
   * Format a compact handoff representation for Agent B consumption.
   * Produces a token-efficient summary.
   */
  formatCompactHandoff(obj: ContextObject): string {
    const content = (obj.content ?? {}) as Partial<StructuredHandoff>;
    const summary = content.summary ?? 'Session handoff';
    const nextStep = content.next_step ?? 'Continue current task';
    const completed = content.completed ?? [];
    const remaining = content.remaining ?? [];
    const blockers = content.blockers ?? [];
    const placeholders = content.placeholders ?? [];
    const knownIssues = content.known_issues ?? [];

    const lines: string[] = [
      `=== HANDOFF [${obj.id}] ===`,
      `SUMMARY: ${summary}`,
      `NEXT_STEP: ${nextStep}`,
    ];

    if (completed.length > 0) {
      lines.push(`COMPLETED: ${completed.join('; ')}`);
    }
    if (remaining.length > 0) {
      lines.push(`REMAINING: ${remaining.join('; ')}`);
    }
    if (blockers.length > 0) {
      lines.push(`BLOCKERS: ${blockers.join('; ')}`);
    }
    if (placeholders.length > 0) {
      lines.push(`PLACEHOLDERS: ${placeholders.join('; ')}`);
    }
    if (knownIssues.length > 0) {
      lines.push(`KNOWN_ISSUES: ${knownIssues.join('; ')}`);
    }

    return lines.join('\n');
  }
}
