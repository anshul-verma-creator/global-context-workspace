/**
 * Events package — normalization, adapters, chunk storage.
 */

export * from './normalizer.js';
export * from './chunk-store.js';
export * from './adapters/filesystem-adapter.js';
export * from './adapters/git-adapter.js';
export * from './adapters/terminal-adapter.js';
export * from './adapters/agent-adapter.js';
export * from './event-pipeline.js';
