import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsRegistry, EventTracer } from '../src/metrics.js';

describe('MetricsRegistry', () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    registry = new MetricsRegistry();
  });

  it('records counters, gauges, and histograms', () => {
    registry.incrementCounter('conflicts_total', 1);
    registry.incrementCounter('conflicts_total', 2);
    registry.setGauge('outbox_backlog', 42);

    registry.recordValue('event_latency_ms', 10);
    registry.recordValue('event_latency_ms', 20);
    registry.recordValue('event_latency_ms', 30);

    const snapshot = registry.getSnapshot();

    expect(snapshot.counters['conflicts_total']).toBe(3);
    expect(snapshot.gauges['outbox_backlog']).toBe(42);
    expect(snapshot.histograms['event_latency_ms']).toBeDefined();
    expect(snapshot.histograms['event_latency_ms']?.count).toBe(3);
    expect(snapshot.histograms['event_latency_ms']?.sum).toBe(60);
    expect(snapshot.histograms['event_latency_ms']?.min).toBe(10);
    expect(snapshot.histograms['event_latency_ms']?.max).toBe(30);
    expect(snapshot.histograms['event_latency_ms']?.avg).toBe(20);
  });

  it('resets metrics accurately', () => {
    registry.incrementCounter('sync_failures_total', 5);
    registry.reset();
    const snapshot = registry.getSnapshot();
    expect(Object.keys(snapshot.counters).length).toBe(0);
    expect(Object.keys(snapshot.gauges).length).toBe(0);
    expect(Object.keys(snapshot.histograms).length).toBe(0);
  });
});

describe('EventTracer', () => {
  let tracer: EventTracer;

  beforeEach(() => {
    tracer = new EventTracer();
  });

  it('traces full event lifecycle from capture to delivery', () => {
    const eventId = 'evt-trace-101';
    tracer.startTrace(eventId, {
      workspaceId: 'ws-1',
      repositoryId: 'repo-alpha',
      sessionId: 'sess-abc',
    });

    tracer.recordStage(eventId, 'local_persistence');
    tracer.recordStage(eventId, 'outbox_enqueued');
    tracer.recordStage(eventId, 'cloud_ingestion');
    tracer.recordStage(eventId, 'cloud_persistence');
    tracer.recordStage(eventId, 'stream_published');

    expect(tracer.hasCompletedTrace(eventId)).toBe(false);

    tracer.recordStage(eventId, 'client_delivered', { recipientAgentId: 'agent-2' });

    expect(tracer.hasCompletedTrace(eventId)).toBe(true);

    const trace = tracer.getTrace(eventId);
    expect(trace).toBeDefined();
    expect(trace?.completed).toBe(true);
    expect(trace?.spans.length).toBe(7);
    expect(trace?.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(trace?.repositoryId).toBe('repo-alpha');
    expect(trace?.spans[6]?.metadata).toEqual({ recipientAgentId: 'agent-2' });
  });

  it('handles ad-hoc stages if startTrace was not explicitly invoked', () => {
    const eventId = 'evt-trace-adhoc';
    tracer.recordStage(eventId, 'cloud_persistence');
    const trace = tracer.getTrace(eventId);
    expect(trace).toBeDefined();
    expect(trace?.spans.some((s) => s.stage === 'cloud_persistence')).toBe(true);
  });
});
