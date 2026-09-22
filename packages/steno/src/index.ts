/**
 * Context Steno — compact serialization for AI context.
 *
 * Per spec §15/16 (Architecture and Technical Specification):
 * - Canonical storage is structured context, NOT Steno.
 * - Steno is a derived transport representation.
 * - Optimize tokens, not characters.
 * - Natural language is retained for semantic meaning.
 * - Alias only repeated useful entities.
 * - Avoid invented rare codes.
 * - Version the dictionary.
 */

export * from './grammar.js';
export * from './serializer.js';
export * from './parser.js';
export * from './alias-dictionary.js';
export * from './token-estimator.js';
