/**
 * Retrieval package — layered context retrieval engine.
 *
 * Pipeline: scope/filter → exact indexes → graph relations →
 *           BM25/FTS → vector (noop local) → category assembly → reranking
 *
 * Decision validity is resolved from the supersession relation chain.
 * Recency alone is never used to determine whether a decision is current.
 */

export * from './retrieval-engine.js';
export * from './scorer.js';
export * from './retrieval-query.js';
export * from './telemetry.js';
export * from './decision-validity.js';
export * from './category-assembler.js';
