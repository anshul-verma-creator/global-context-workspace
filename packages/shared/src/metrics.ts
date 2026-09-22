import { nowMs, createLogger } from './index.js';

const log = createLogger({ component: 'metrics' });

export interface MetricSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, { count: number; sum: number; min: number; max: number; avg: number }>;
}

/**
 * MetricsRegistry — Collects operational metrics per spec §24 (Observability).
 *
 * Tracks:
 * - event_latency_ms
 * - sync_failures_total
 * - outbox_backlog
 * - websocket_connections
 * - conflicts_total
 * - retrieval_latency_ms
 * - context_tokens
 * - precision / recall
 */
export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, number[]>();

  incrementCounter(name: string, by = 1): void {
    const current = this.counters.get(name) ?? 0;
    this.counters.set(name, current + by);
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  recordValue(name: string, value: number): void {
    let list = this.histograms.get(name);
    if (!list) {
      list = [];
      this.histograms.set(name, list);
    }
    list.push(value);
    // Keep bounded history (last 1000 measurements)
    if (list.length > 1000) {
      list.shift();
    }
  }

  getSnapshot(): MetricSnapshot {
    const histSummary: MetricSnapshot['histograms'] = {};
    for (const [key, values] of this.histograms.entries()) {
      if (values.length === 0) continue;
      const count = values.length;
      const sum = values.reduce((a, b) => a + b, 0);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const avg = sum / count;
      histSummary[key] = { count, sum, min, max, avg };
    }

    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms: histSummary,
    };
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

export const globalMetrics = new MetricsRegistry();

export type TraceStage =
  | 'local_capture'
  | 'local_persistence'
  | 'outbox_enqueued'
  | 'cloud_ingestion'
  | 'cloud_persistence'
  | 'stream_published'
  | 'client_delivered';

export interface TraceSpan {
  stage: TraceStage;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface EventTrace {
  eventId: string;
  workspaceId?: string;
  repositoryId?: string;
  capsuleId?: string;
  sessionId?: string;
  spans: TraceSpan[];
  completed: boolean;
  totalDurationMs?: number;
}

/**
 * EventTracer — Traces events from local capture through cloud persistence and client delivery (Phase 24).
 *
 * Acceptance invariant:
 *   A complete event can be traced from local capture to cloud persistence and client delivery.
 */
export class EventTracer {
  private readonly traces = new Map<string, EventTrace>();

  startTrace(
    eventId: string,
    correlation?: {
      workspaceId?: string;
      repositoryId?: string;
      capsuleId?: string;
      sessionId?: string;
    },
  ): EventTrace {
    const trace: EventTrace = {
      eventId,
      ...(correlation?.workspaceId ? { workspaceId: correlation.workspaceId } : {}),
      ...(correlation?.repositoryId ? { repositoryId: correlation.repositoryId } : {}),
      ...(correlation?.capsuleId ? { capsuleId: correlation.capsuleId } : {}),
      ...(correlation?.sessionId ? { sessionId: correlation.sessionId } : {}),
      spans: [
        {
          stage: 'local_capture',
          timestamp: nowMs(),
        },
      ],
      completed: false,
    };
    this.traces.set(eventId, trace);
    log.debug('Event trace started', { eventId });
    return trace;
  }

  recordStage(
    eventId: string,
    stage: TraceStage,
    metadata?: Record<string, unknown>,
  ): void {
    const trace = this.traces.get(eventId);
    if (!trace) {
      log.debug('Trace not found for stage record, initializing', { eventId, stage });
      const newTrace = this.startTrace(eventId);
      newTrace.spans.push({ stage, timestamp: nowMs(), ...(metadata ? { metadata } : {}) });
      return;
    }

    trace.spans.push({
      stage,
      timestamp: nowMs(),
      ...(metadata ? { metadata } : {}),
    });

    if (stage === 'client_delivered') {
      trace.completed = true;
      const first = trace.spans[0]?.timestamp ?? nowMs();
      trace.totalDurationMs = nowMs() - first;
      log.info('Event lifecycle trace completed', {
        eventId,
        durationMs: String(trace.totalDurationMs),
        spansCount: String(trace.spans.length),
      });
    }
  }

  getTrace(eventId: string): EventTrace | undefined {
    return this.traces.get(eventId);
  }

  hasCompletedTrace(eventId: string): boolean {
    const trace = this.traces.get(eventId);
    return trace?.completed === true;
  }
}

export const globalTracer = new EventTracer();
