import { nowMs } from '@context-workspace/shared';
import type {
  ContextObject,
  ContextAuthority,
  ContextObjectStatus,
} from '@context-workspace/protocol';
import type { RetrievalScore, RetrievalQuery, ScoringWeights } from './retrieval-query.js';
import { DEFAULT_SCORING_WEIGHTS } from './retrieval-query.js';

/**
 * Retrieval scorer — computes relevance scores for context objects.
 *
 * Per spec §14 (Technical Specification):
 * score = scopeMatch + resourceMatch + taskMatch + relationshipStrength +
 *         recency + authority + status + semanticSimilarity
 *
 * Weights are configurable.
 */

export class ContextObjectScorer {
  private readonly weights: ScoringWeights;

  constructor(weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS) {
    this.weights = weights;
  }

  score(
    obj: ContextObject,
    query: RetrievalQuery,
    options: {
      relationshipCount?: number;
      semanticSimilarity?: number;
    } = {},
  ): RetrievalScore {
    const scopeMatch = this._scoreScopeMatch(obj, query);
    const resourceMatch = this._scoreResourceMatch(obj, query);
    const taskMatch = this._scoreTaskMatch(obj, query);
    const relationshipStrength = this._scoreRelationshipStrength(options.relationshipCount ?? 0);
    const recency = this._scoreRecency(obj);
    const authority = this._scoreAuthority(obj.authority);
    const status = this._scoreStatus(obj.status);
    const semanticSimilarity = options.semanticSimilarity ?? 0;

    const total =
      scopeMatch * this.weights.scopeMatch +
      resourceMatch * this.weights.resourceMatch +
      taskMatch * this.weights.taskMatch +
      relationshipStrength * this.weights.relationshipStrength +
      recency * this.weights.recency +
      authority * this.weights.authority +
      status * this.weights.status +
      semanticSimilarity * this.weights.semanticSimilarity;

    return {
      total,
      scopeMatch,
      resourceMatch,
      taskMatch,
      relationshipStrength,
      recency,
      authority,
      status,
      semanticSimilarity,
    };
  }

  private _scoreScopeMatch(obj: ContextObject, query: RetrievalQuery): number {
    if (query.capsuleId !== undefined && obj.capsuleId === query.capsuleId) {
      return 1.0; // Exact capsule match
    }
    if (obj.repositoryId === query.repositoryId) {
      return 0.5; // Same repository
    }
    return 0;
  }

  private _scoreResourceMatch(obj: ContextObject, query: RetrievalQuery): number {
    if (obj.resource === undefined) return 0;
    if (query.resources === undefined || query.resources.length === 0) return 0;

    for (const resource of query.resources) {
      if (obj.resource === resource) return 1.0; // Exact match
      // Partial path match (e.g., directory-level)
      if (resource.startsWith(obj.resource) || obj.resource.startsWith(resource)) {
        return 0.5;
      }
    }
    return 0;
  }

  private _scoreTaskMatch(obj: ContextObject, query: RetrievalQuery): number {
    if (query.task === undefined || query.task.trim() === '') return 0;

    const taskWords = new Set(query.task.toLowerCase().split(/\s+/));
    const contentStr = JSON.stringify(obj.content).toLowerCase();
    let matchCount = 0;

    for (const word of taskWords) {
      if (word.length > 3 && contentStr.includes(word)) {
        matchCount++;
      }
    }

    return Math.min(1.0, matchCount / Math.max(taskWords.size, 1));
  }

  private _scoreRelationshipStrength(relationshipCount: number): number {
    // More relationships = more relevant
    return Math.min(1.0, relationshipCount / 5);
  }

  private _scoreRecency(obj: ContextObject): number {
    const ageMs = nowMs() - obj.updatedAt;
    const ONE_HOUR = 3_600_000;
    const ONE_DAY = 86_400_000;
    const ONE_WEEK = 7 * ONE_DAY;

    if (ageMs < ONE_HOUR) return 1.0;
    if (ageMs < ONE_DAY) return 0.7;
    if (ageMs < ONE_WEEK) return 0.3;
    return 0.1;
  }

  private _scoreAuthority(authority: ContextAuthority): number {
    const authorityScores: Record<ContextAuthority, number> = {
      agent_explicit: 1.0,
      human: 1.0,
      deterministic_rule: 0.8,
      static_analysis: 0.6,
      agent_inferred: 0.5,
    };
    return authorityScores[authority] ?? 0.3;
  }

  private _scoreStatus(status: ContextObjectStatus): number {
    const statusScores: Record<ContextObjectStatus, number> = {
      active: 1.0,
      confirmed: 1.0,
      candidate: 0.6,
      resolved: 0.2,
      superseded: 0.1,
      rejected: 0.0,
      archived: 0.0,
    };
    return statusScores[status] ?? 0.3;
  }
}
