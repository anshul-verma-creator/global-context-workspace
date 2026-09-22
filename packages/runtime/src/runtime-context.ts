import type {
  ContextObjectsStore,
  RelationsStore,
  EventsStore,
} from '@context-workspace/database';
import type { LocalSession } from '@context-workspace/database';
import {
  RetrievalEngine,
  type RetrievalResult,
  type RetrievalQuery,
} from '@context-workspace/retrieval';
import {
  ContextCompiler,
  type CompiledContext,
  type CompilerInput,
} from '@context-workspace/context-compiler';
import { createLogger } from '@context-workspace/shared';

const log = createLogger({ component: 'runtime-context' });

/**
 * Per-session assembled runtime context.
 *
 * This is what gets injected into an AI agent at context-window fill time.
 * It is not cached — it is assembled fresh on each call so it always
 * reflects the current state of the SQLite database.
 */
export interface RuntimeContext {
  session: LocalSession;
  /** Steno-serialized context string ready for AI injection */
  serialized: string;
  /** Estimated token count of the serialized context */
  estimatedTokens: number;
  /** IDs of context objects included */
  includedObjectIds: string[];
  /** Number of candidates dropped due to token budget */
  omittedCount: number;
  /** Retrieval result — available for telemetry / evaluation */
  retrieval: RetrievalResult;
  /** Milliseconds spent assembling this context */
  assemblyMs: number;
}

export interface RuntimeContextOptions {
  /** Maximum tokens for the compiled context. Default: 8000 */
  maxTokens?: number;
  /** Alias dictionary scope key. Default: session.id */
  scope?: string;
}

/**
 * Runtime context assembler.
 *
 * Ties together retrieval + context compilation per spec §16-18 (Build Plan):
 *   1. Retrieve candidates from SQLite (exact → graph → BM25 → category → rerank)
 *   2. Identify hard-required objects (active conflicts, etc.)
 *   3. Compile to token-budgeted Steno string
 *
 * This is the object handed to the agent adapter when it requests context injection.
 */
export class RuntimeContextAssembler {
  private readonly engine: RetrievalEngine;
  private readonly compiler: ContextCompiler;

  constructor(objStore: ContextObjectsStore, relStore: RelationsStore) {
    this.engine = new RetrievalEngine(objStore, relStore);
    this.compiler = new ContextCompiler();
  }

  /**
   * Assemble runtime context for a session.
   *
   * @param session - The session to assemble context for
   * @param query   - Retrieval query (task, resources, etc.)
   * @param options - Token budget and scope
   */
  async assemble(
    session: LocalSession,
    query: Omit<RetrievalQuery, 'workspaceId' | 'repositoryId'> & {
      workspaceId?: string;
      repositoryId?: string;
    },
    options: RuntimeContextOptions = {},
  ): Promise<RuntimeContext> {
    const start = Date.now();
    const maxTokens = options.maxTokens ?? 8_000;
    const scope = options.scope ?? session.id;

    // Resolve workspaceId and repositoryId from the session's capsule
    const resolvedQuery: RetrievalQuery = {
      workspaceId: query.workspaceId ?? 'default',
      repositoryId: query.repositoryId ?? session.capsuleId,
      capsuleId: session.capsuleId,
      includeCategories: true,
      ...query,
      maxTokens,
    };

    log.debug('Assembling runtime context', {
      sessionId: session.id,
      capsuleId: session.capsuleId,
      maxTokens: String(maxTokens),
    });

    // Stage 1: Retrieve candidates
    const retrieval = await this.engine.retrieve(resolvedQuery);

    // Stage 2: Compile — all candidates are optional; hard-required is empty
    // (specific hard-required objects can be added by the caller via query.types)
    const compilerInput: CompilerInput = {
      required: [],
      candidates: retrieval.candidates,
      maxTokens,
      scope,
    };

    const compiled: CompiledContext = this.compiler.compile(compilerInput);

    const assemblyMs = Date.now() - start;

    log.info('Runtime context assembled', {
      sessionId: session.id,
      estimatedTokens: String(compiled.estimatedTokens),
      included: String(compiled.includedObjectIds.length),
      omitted: String(compiled.omittedCount),
      assemblyMs: String(assemblyMs),
    });

    return {
      session,
      serialized: compiled.serialized,
      estimatedTokens: compiled.estimatedTokens,
      includedObjectIds: compiled.includedObjectIds,
      omittedCount: compiled.omittedCount,
      retrieval,
      assemblyMs,
    };
  }
}
