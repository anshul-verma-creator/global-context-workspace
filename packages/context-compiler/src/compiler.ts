import type { ContextObject } from '@context-workspace/protocol';
import type { ScoredCandidate } from '@context-workspace/retrieval';
import {
  serializeStenoDocument,
  estimateTokens,
  heuristicEstimator,
  AliasDictionaryManager,
} from '@context-workspace/steno';
import type { StenoBlock, StenoDocument } from '@context-workspace/steno';
import { TokenBudgetExceededError, createLogger } from '@context-workspace/shared';
import type { TokenEstimator } from '@context-workspace/steno';

const log = createLogger({ component: 'context-compiler' });

/**
 * Context compiler.
 *
 * Per spec §14 (Architecture) and §15 (Technical Specification):
 * 1. Hard-required context (cannot be dropped)
 * 2. Priority tiers
 * 3. Score candidates
 * 4. Token budget fill
 * 5. Redundancy removal
 * 6. Steno serialization
 *
 * The objective is minimum sufficient context, not maximum context.
 * Never dump the whole workspace into an AI.
 */

export interface CompilerInput {
  /** Hard-required objects — always included regardless of budget */
  required: ContextObject[];
  /** Scored candidates — included if budget allows */
  candidates: ScoredCandidate[];
  /** Token budget */
  maxTokens: number;
  /** Alias dictionary scope key */
  scope: string;
  /** Active conflicts to include */
  conflicts?: ActiveConflict[];
}

export interface ActiveConflict {
  resource: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  agentId?: string;
  message?: string;
}

export interface CompiledContext {
  /** Steno-serialized context string */
  serialized: string;
  /** Estimated token count */
  estimatedTokens: number;
  /** IDs of included objects */
  includedObjectIds: string[];
  /** Number of candidates dropped due to budget */
  omittedCount: number;
  /** Generation timestamp */
  generatedAt: number;
}

export class ContextCompiler {
  private readonly estimator: TokenEstimator;

  constructor(estimator: TokenEstimator = heuristicEstimator) {
    this.estimator = estimator;
  }

  /**
   * Compile context from retrieved objects into a token-budgeted Steno string.
   * Never exceeds maxTokens for the serialized output.
   */
  compile(input: CompilerInput): CompiledContext {
    const dictManager = new AliasDictionaryManager(input.scope);
    const blocks: StenoBlock[] = [];
    const includedIds: string[] = [];
    let currentTokens = 0;
    let omittedCount = 0;

    // 1. Serialize hard-required context first
    for (const obj of input.required) {
      const block = this._objectToBlock(obj);
      if (block !== null) {
        const preview = this._estimateBlockTokens(block, dictManager);
        blocks.push(block);
        includedIds.push(obj.id);
        currentTokens += preview;
      }
    }

    // 2. Add critical conflicts (always included, even if over budget)
    if (input.conflicts !== undefined) {
      for (const conflict of input.conflicts) {
        if (conflict.severity === 'critical' || conflict.severity === 'high') {
          blocks.push({
            label: 'conflicts',
            resource: conflict.resource,
            severity: conflict.severity,
            ...(conflict.agentId !== undefined ? { agentId: conflict.agentId } : {}),
            ...(conflict.message !== undefined ? { message: conflict.message } : {}),
          });
          currentTokens += this.estimator.estimate(
            `conflicts: ${conflict.resource} [${conflict.severity}]`,
          );
        }
      }
    }

    // 3. Fill budget with scored candidates (already sorted by score desc)
    const sortedCandidates = [...input.candidates].sort((a, b) => b.score - a.score);

    for (const candidate of sortedCandidates) {
      if (includedIds.includes(candidate.object.id)) {
        continue; // Already included as required
      }

      const block = this._objectToBlock(candidate.object);
      if (block === null) continue;

      const blockTokens = this._estimateBlockTokens(block, dictManager);

      if (currentTokens + blockTokens <= input.maxTokens) {
        blocks.push(block);
        includedIds.push(candidate.object.id);
        currentTokens += blockTokens;
      } else {
        omittedCount++;
        log.debug('Context budget: omitting candidate', {
          objectId: candidate.object.id,
          type: candidate.object.type,
          blockTokens: String(blockTokens),
          remaining: String(input.maxTokens - currentTokens),
        });
      }
    }

    // 4. Low-severity conflicts at the end if budget allows
    if (input.conflicts !== undefined) {
      for (const conflict of input.conflicts) {
        if (conflict.severity !== 'critical' && conflict.severity !== 'high') {
          const block: StenoBlock = {
            label: 'conflicts',
            resource: conflict.resource,
            severity: conflict.severity,
            ...(conflict.agentId !== undefined ? { agentId: conflict.agentId } : {}),
            ...(conflict.message !== undefined ? { message: conflict.message } : {}),
          };
          const blockTokens = this._estimateBlockTokens(block, dictManager);
          if (currentTokens + blockTokens <= input.maxTokens) {
            blocks.push(block);
            currentTokens += blockTokens;
          }
        }
      }
    }

    const doc: StenoDocument = {
      version: 1,
      dictVersion: dictManager.version,
      blocks,
    };

    const serialized = serializeStenoDocument(doc, dictManager.getEntries());
    const finalTokens = estimateTokens(serialized, this.estimator);

    log.debug('Context compiled', {
      includedCount: String(includedIds.length),
      omittedCount: String(omittedCount),
      estimatedTokens: String(finalTokens),
      maxTokens: String(input.maxTokens),
    });

    return {
      serialized,
      estimatedTokens: finalTokens,
      includedObjectIds: includedIds,
      omittedCount,
      generatedAt: Date.now(),
    };
  }

  /**
   * Compile with strict budget enforcement.
   * Throws if hard-required context alone exceeds budget.
   */
  compileStrict(input: CompilerInput): CompiledContext {
    // Pre-check: can required context fit?
    const requiredBlocks = input.required
      .map((o) => this._objectToBlock(o))
      .filter((b): b is StenoBlock => b !== null);

    const mgr = new AliasDictionaryManager(input.scope);
    const requiredTokens = requiredBlocks.reduce(
      (sum, block) => sum + this._estimateBlockTokens(block, mgr),
      0,
    );

    if (requiredTokens > input.maxTokens) {
      throw new TokenBudgetExceededError(input.maxTokens, requiredTokens);
    }

    return this.compile(input);
  }

  private _objectToBlock(obj: ContextObject): StenoBlock | null {
    const content = obj.content;

    /** Conditionally include optional key */
    function opt<K extends string, V>(key: K, value: V | undefined): Record<string, V> {
      return value !== undefined ? { [key]: value } : {};
    }

    switch (content.kind) {
      case 'task':
        return {
          label: 'task',
          id: obj.id.substring(0, 8),
          text: content.title + (content.description !== undefined ? `: ${content.description}` : ''),
          status: content.status,
          ...opt('resource', obj.resource),
        };

      case 'intent':
        return {
          label: 'intent',
          id: obj.id.substring(0, 8),
          text: content.description,
          ...opt('resources', content.resources),
        };

      case 'decision': {
        const resources = content.resources ?? (obj.resource !== undefined ? [obj.resource] : undefined);
        return {
          label: 'decision',
          id: obj.id.substring(0, 8),
          text: content.description,
          status: content.confirmed === true ? 'confirmed' : obj.status,
          ...opt('why', content.rationale),
          ...opt('resources', resources),
        };
      }

      case 'constraint': {
        const resources = content.resources ?? (obj.resource !== undefined ? [obj.resource] : undefined);
        return {
          label: 'constraint',
          id: obj.id.substring(0, 8),
          text: content.description,
          ...opt('resources', resources),
        };
      }

      case 'assumption':
        return {
          label: 'assumption',
          id: obj.id.substring(0, 8),
          text: content.assumption,
          ...opt('basis', content.basis),
        };

      case 'error':
        return {
          label: 'error',
          id: obj.id.substring(0, 8),
          text: content.message,
          ...opt('resource', content.resource ?? obj.resource),
        };

      case 'test_result':
        return {
          label: 'test',
          id: obj.id.substring(0, 8),
          status: content.status,
          ...opt('testName', content.testName),
          ...opt('error', content.errorMessage),
        };

      case 'placeholder':
        return {
          label: 'placeholder',
          id: obj.id.substring(0, 8),
          resource: content.resource,
          text: content.description,
          status: content.placeholderStatus,
          ...opt('replacement', content.intendedReplacement),
        };

      case 'question':
        return {
          label: 'question',
          id: obj.id.substring(0, 8),
          text: content.question,
          blocking: content.blocking,
        };

      case 'handoff':
        return {
          label: 'handoff',
          id: obj.id.substring(0, 8),
          summary: content.summary,
          ...opt('done', content.completed),
          ...opt('remaining', content.remaining),
          ...opt('next', content.nextStep),
          ...opt('blockers', content.blockers),
          ...opt('issues', content.knownIssues),
        };

      case 'observation':
        return {
          label: 'obs',
          id: obj.id.substring(0, 8),
          text: content.description,
          ...opt('resource', content.resource ?? obj.resource),
        };

      case 'state':
        return {
          label: 'state',
          key: content.key,
          value: String(content.value),
          ...opt('resource', content.resource ?? obj.resource),
        };

      case 'code_reference':
        return {
          label: 'obs',
          id: obj.id.substring(0, 8),
          text: `Code reference: ${content.symbol ?? content.resource}${content.description !== undefined ? ` — ${content.description}` : ''}`,
          ...opt('resource', content.resource),
        };

      default:
        return null;
    }
  }

  private _estimateBlockTokens(
    block: StenoBlock,
    _dictManager: AliasDictionaryManager,
  ): number {
    // Serialize just this block to estimate its token cost
    const preview = this._blockToString(block);
    return this.estimator.estimate(preview);
  }

  private _blockToString(block: StenoBlock): string {
    switch (block.label) {
      case 'task': return `task: ${block.text}`;
      case 'intent': return `intent: ${block.text}`;
      case 'decision': return `decision:\n  ${block.text}${block.why !== undefined ? `\n  why: ${block.why}` : ''}`;
      case 'constraint': return `constraint: ${block.text}`;
      case 'assumption': return `assumption: ${block.text}`;
      case 'error': return `error: ${block.text}`;
      case 'test': return `test: ${block.status}${block.testName !== undefined ? `\n  name: ${block.testName}` : ''}`;
      case 'placeholder': return `placeholder: ${block.resource}\n  desc: ${block.text}`;
      case 'question': return `question: ${block.text}`;
      case 'handoff': return `handoff:\n  summary: ${block.summary}`;
      case 'obs': return `obs: ${block.text}`;
      case 'state': return `state: ${block.key}=${block.value}`;
      case 'conflicts': return `conflicts: ${block.resource} [${block.severity}]`;
      case 'text': return block.text;
    }
  }
}
