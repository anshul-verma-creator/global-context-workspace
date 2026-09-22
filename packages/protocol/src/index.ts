/**
 * Protocol package — all wire types, event definitions, and validation.
 * This is the single source of truth for the data contract between
 * the local runtime and the cloud server.
 *
 * Protocol version: 1 (incremented on breaking schema changes)
 */

export * from './event-types.js';
export * from './context-event.js';
export * from './context-object.js';
export * from './api-dtos.js';
export * from './websocket.js';
export * from './validation.js';
export * from './large-content.js';

export const PROTOCOL_VERSION = 1 as const;
