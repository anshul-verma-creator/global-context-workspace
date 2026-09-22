import type { ContextObject, ContextObjectType } from '@context-workspace/protocol';
import type { ContextObjectsStore } from '@context-workspace/database';
import type { RelationsStore } from '@context-workspace/database';
import { createLogger } from '@context-workspace/shared';
import type {
  RetrievalQuery,
  RetrievalCandidate,
  RetrievalStage,
  ScoringWeights,
  CategoryResult,
} from './retrieval-query.js';
import { DEFAULT_SCORING_WEIGHTS } from './retrieval-query.js';
import { ContextObjectScorer } from './scorer.js';
import type { RetrievalTelemetry } from './telemetry.js';
import { RetrievalTelemetryCollector } from './telemetry.js';
import { DecisionValidityResolver } from './decision-validity.js';
import { CategoryAssembler, annotateCategoryStage } from './category-assembler.js';

const log = createLogger({ component: 'retrieval-engine' });

/**
 * Layered retrieval engine.
 *
 * Pipeline (per updated spec):
 * 1. scope/filter       — SQLite B-tree index scan by repository/capsule/type/status
 * 2. exact resource     — highest-priority candidates matching query.resources exactly
 * 3. graph traversal    — 1-hop expansion via 'related_to' and 'depends_on' relations
 * 4. BM25/FTS           — SQLite FTS5 search for task-query keyword matches
 * 5. vector (noop)      — placeholder for cloud pgvector; no-op in local runtime
 * 6. category assembly  — organise into 10 required context categories;
 *                         resolve decision validity via supersession chain (not recency)
 * 7. rerank             — boost exact resource matches to top
 *
 * Decision validity is resolved from the relation graph before presenting
 * any decision as current. Recency alone is never used to determine currency.
 */

export interface RetrievalResult {
  candidates: ScoredCandidate[];
  telemetry: RetrievalTelemetry;
  /** Populated when query.includeCategories !== false */
  categories?: CategoryResult;
}

export interface ScoredCandidate {
  object: ContextObject;
  score: number;
  stages: RetrievalStage[];
}

export class RetrievalEngine {
  private readonly objStore: ContextObjectsStore;
  private readonly relStore: RelationsStore;
  private readonly scorer: ContextObjectScorer;
  private readonly validityResolver: DecisionValidityResolver;
  private readonly categoryAssembler: CategoryAssembler;

  constructor(
    objStore: ContextObjectsStore,
    relStore: RelationsStore,
    weights?: ScoringWeights,
  ) {
    this.objStore = objStore;
    this.relStore = relStore;
    this.scorer = new ContextObjectScorer(weights ?? DEFAULT_SCORING_WEIGHTS);
    this.validityResolver = new DecisionValidityResolver(relStore);
    this.categoryAssembler = new CategoryAssembler(this.validityResolver);
  }

  /**
   * Execute layered retrieval for a query.
   */
  async retrieve(query: RetrievalQuery): Promise<RetrievalResult> {
    const telemetry = new RetrievalTelemetryCollector(query);
    const startTime = Date.now();

    // --- Stage 1: Scope filter + type filter ---
    const types = this._resolveTypeFilter(query);
    const scopeCandidates = this.objStore.list({
      repositoryId: query.repositoryId,
      ...(query.capsuleId !== undefined ? { capsuleId: query.capsuleId } : {}),
      ...(types !== undefined ? { types } : {}),
      statuses: query.statuses ?? ['active', 'confirmed', 'candidate'],
      limit: query.candidateLimit ?? 200,
    });

    telemetry.recordStage('exact', scopeCandidates.length);

    // --- Stage 2: Exact resource match ---
    const exactMatches = new Set<string>();
    if (query.resources !== undefined && query.resources.length > 0) {
      for (const resource of query.resources) {
        const resourceObjs = this.objStore.list({
          repositoryId: query.repositoryId,
          resource,
          limit: 50,
        });
        for (const obj of resourceObjs) {
          exactMatches.add(obj.id);
        }
      }
    }

    // --- Stage 3: Relationship graph traversal (1-hop) ---
    const graphExpanded = new Set<string>(scopeCandidates.map((o) => o.id));
    const graphAdditions: string[] = [];

    for (const candidate of scopeCandidates.slice(0, 20)) {
      for (const relType of ['related_to', 'depends_on'] as const) {
        const neighbors = this.relStore.getNeighbors(candidate.id, relType);
        for (const neighborId of neighbors) {
          if (!graphExpanded.has(neighborId)) {
            graphExpanded.add(neighborId);
            graphAdditions.push(neighborId);
          }
        }
      }
    }

    telemetry.recordStage('graph', graphAdditions.length);

    const graphObjects: ContextObject[] = [];
    for (const id of graphAdditions) {
      const obj = this.objStore.getById(id);
      if (obj !== undefined) graphObjects.push(obj);
    }

    // --- Stage 4: BM25/FTS search ---
    const ftsResults: ContextObject[] = [];
    if (query.task !== undefined && query.task.trim().length > 0) {
      const ftsObjects = this.objStore.searchFts(query.repositoryId, query.task, 30);
      for (const obj of ftsObjects) {
        if (!graphExpanded.has(obj.id)) {
          ftsResults.push(obj);
        }
      }
      telemetry.recordStage('bm25', ftsResults.length);
    }

    // --- Stage 5: Vector search (no-op in local runtime) ---
    // Placeholder — cloud server implements pgvector here.
    // Interface is unchanged; candidates array extended with vector results.

    // --- Combine all candidates ---
    const allCandidates = new Map<string, { object: ContextObject; stages: Set<RetrievalStage> }>();

    for (const obj of scopeCandidates) {
      const stages: Set<RetrievalStage> = new Set(['exact']);
      if (exactMatches.has(obj.id)) stages.add('exact');
      allCandidates.set(obj.id, { object: obj, stages });
    }

    for (const obj of graphObjects) {
      const existing = allCandidates.get(obj.id);
      if (existing !== undefined) {
        existing.stages.add('graph');
      } else {
        allCandidates.set(obj.id, { object: obj, stages: new Set(['graph']) });
      }
    }

    for (const obj of ftsResults) {
      const existing = allCandidates.get(obj.id);
      if (existing !== undefined) {
        existing.stages.add('bm25');
      } else {
        allCandidates.set(obj.id, { object: obj, stages: new Set(['bm25']) });
      }
    }

    // --- Score all candidates ---
    const scored: ScoredCandidate[] = [];
    for (const [, { object, stages }] of allCandidates) {
      const relationCount = this.relStore.listAll(object.id).length;
      const scoreResult = this.scorer.score(object, query, {
        relationshipCount: relationCount,
      });

      scored.push({
        object,
        score: scoreResult.total,
        stages: [...stages],
      });
    }

    scored.sort((a, b) => b.score - a.score);

    // --- Stage 6: Category-aware assembly ---
    // Resolve decision validity and classify into the 10 required categories.
    // This must happen AFTER scoring but BEFORE final rerank.
    let categories: CategoryResult | undefined;
    if (query.includeCategories !== false) {
      categories = this.categoryAssembler.assemble(scored, query);

      // Annotate candidates that appeared in category slots with 'category' stage
      const categoryObjectIds = new Set<string>([
        ...categories.currentActiveWork.map((o) => o.id),
        ...categories.latestApplicableDecisions.map((d) => d.object.id),
        ...categories.supersededDecisions.map((d) => d.object.id),
        ...categories.constraints.map((o) => o.id),
        ...categories.latestErrors.map((o) => o.id),
        ...categories.latestTestResults.map((o) => o.id),
        ...categories.activeConflicts.map((o) => o.id),
        ...categories.placeholders.map((o) => o.id),
        ...categories.handoffs.map((o) => o.id),
        ...categories.relevantCodeResources.map((o) => o.id),
      ]);

      const annotated = annotateCategoryStage(scored, categoryObjectIds);
      scored.length = 0;
      scored.push(...annotated);
    }

    // --- Stage 7: Rerank (boost exact resource matches) ---
    const reranked = this._rerank(scored, query);

    const latencyMs = Date.now() - startTime;
    telemetry.recordCompletion(reranked.length, latencyMs);

    log.debug('Retrieval complete', {
      repositoryId: query.repositoryId,
      candidates: reranked.length,
      latencyMs: String(latencyMs),
      categoriesEnabled: String(query.includeCategories !== false),
    });

    return {
      candidates: reranked,
      telemetry: telemetry.build(),
      ...(categories !== undefined ? { categories } : {}),
    };
  }

  private _rerank(candidates: ScoredCandidate[], query: RetrievalQuery): ScoredCandidate[] {
    if (query.resources === undefined || query.resources.length === 0) {
      return candidates;
    }

    const resourceSet = new Set(query.resources);

    return candidates
      .map((c) => {
        if (c.object.resource !== undefined && resourceSet.has(c.object.resource)) {
          return {
            ...c,
            score: c.score * 1.5,
            stages: c.stages.includes('rerank') ? c.stages : [...c.stages, 'rerank' as RetrievalStage],
          };
        }
        return c;
      })
      .sort((a, b) => b.score - a.score);
  }

  private _resolveTypeFilter(query: RetrievalQuery): ContextObjectType[] | undefined {
    if (query.types !== undefined && query.types.length > 0) {
      return query.types;
    }

    const include = query.include;
    if (include === undefined) return undefined;

    const types: ContextObjectType[] = [];
    if (include.decisions !== false) types.push('DECISION');
    if (include.constraints !== false) types.push('CONSTRAINT');
    if (include.placeholders !== false) types.push('PLACEHOLDER');
    if (include.handoffs !== false) types.push('HANDOFF');
    if (include.errors !== false) types.push('ERROR');
    if (include.tasks !== false) types.push('TASK');
    if (include.intents !== false) types.push('INTENT');
    if (include.assumptions !== false) types.push('ASSUMPTION');
    if (include.questions !== false) types.push('QUESTION');
    if (include.liveState !== false) types.push('STATE');
    if (include.testResults !== false) types.push('TEST_RESULT');
    if (include.codeReferences !== false) types.push('CODE_REFERENCE');

    return types.length > 0 ? types : undefined;
  }
}
