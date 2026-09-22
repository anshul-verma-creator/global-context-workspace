import type { RetrievalQuery, RetrievalStage } from './retrieval-query.js';

/**
 * Retrieval telemetry — records metrics for evaluation.
 * Per spec §15 (Workflow): every retrieval strategy is tested.
 * Per spec §13 (Technical Specification): record retrieval telemetry.
 */
export interface RetrievalTelemetry {
  query: {
    repositoryId: string;
    hasTask: boolean;
    hasResources: boolean;
    maxTokens: number;
  };
  stages: Record<RetrievalStage, number>;
  totalCandidates: number;
  latencyMs: number;
  timestamp: number;
}

/**
 * Collects telemetry during a retrieval operation.
 */
export class RetrievalTelemetryCollector {
  private readonly query: RetrievalQuery;
  private readonly stages: Partial<Record<RetrievalStage, number>> = {};
  private totalCandidates = 0;
  private latencyMs = 0;
  private readonly timestamp: number;

  constructor(query: RetrievalQuery) {
    this.query = query;
    this.timestamp = Date.now();
  }

  recordStage(stage: RetrievalStage, count: number): void {
    this.stages[stage] = (this.stages[stage] ?? 0) + count;
  }

  recordCompletion(totalCandidates: number, latencyMs: number): void {
    this.totalCandidates = totalCandidates;
    this.latencyMs = latencyMs;
  }

  build(): RetrievalTelemetry {
    return {
      query: {
        repositoryId: this.query.repositoryId,
        hasTask: this.query.task !== undefined && this.query.task.length > 0,
        hasResources: (this.query.resources?.length ?? 0) > 0,
        maxTokens: this.query.maxTokens,
      },
      stages: {
        exact: this.stages.exact ?? 0,
        graph: this.stages.graph ?? 0,
        bm25: this.stages.bm25 ?? 0,
        vector: this.stages.vector ?? 0,
        category: this.stages.category ?? 0,
        rerank: this.stages.rerank ?? 0,
      },
      totalCandidates: this.totalCandidates,
      latencyMs: this.latencyMs,
      timestamp: this.timestamp,
    };
  }
}
