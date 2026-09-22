import type { StenoDocument, StenoBlock } from './grammar.js';
import { STENO_VERSION } from './grammar.js';
import type { AliasEntry } from './alias-dictionary.js';

/**
 * Steno serializer — converts a StenoDocument to a compact string.
 *
 * Per spec §15 (Architecture): Optimize tokens, not characters.
 * We use natural language with structural labels.
 * Aliases are applied where they save tokens.
 */

export interface SerializerOptions {
  /** Maximum output length in characters (soft limit — will not truncate mid-block) */
  maxChars?: number;
  /** Whether to include block IDs */
  includeIds?: boolean;
}

/**
 * Serialize a StenoDocument to a compact string.
 */
export function serializeStenoDocument(
  doc: StenoDocument,
  aliases: Map<string, AliasEntry>,
  options: SerializerOptions = {},
): string {
  const lines: string[] = [];

  // Header line
  lines.push(`steno:v${STENO_VERSION} dict:v${doc.dictVersion}`);

  for (const block of doc.blocks) {
    const blockLines = serializeBlock(block, aliases, options);
    lines.push(...blockLines);
    lines.push(''); // blank line between blocks
  }

  return lines.join('\n').trimEnd();
}

function serializeBlock(
  block: StenoBlock,
  aliases: Map<string, AliasEntry>,
  options: SerializerOptions,
): string[] {
  const id = options.includeIds !== false && 'id' in block && block.id !== undefined
    ? ` [${block.id}]`
    : '';

  function applyAliases(text: string): string {
    let result = text;
    for (const [alias, entry] of aliases) {
      // Only alias if the canonical value is long enough to benefit
      if (entry.canonicalValue.length > alias.length + 2) {
        result = result.replaceAll(entry.canonicalValue, alias);
      }
    }
    return result;
  }

  switch (block.label) {
    case 'task': {
      const lines = [`task${id}: ${applyAliases(block.text)}`];
      if (block.status !== undefined) lines.push(`  status: ${block.status}`);
      if (block.resource !== undefined) lines.push(`  file: ${applyAliases(block.resource)}`);
      return lines;
    }

    case 'intent': {
      const lines = [`intent${id}: ${applyAliases(block.text)}`];
      if (block.resources !== undefined && block.resources.length > 0) {
        lines.push(`  files: ${block.resources.map(applyAliases).join(', ')}`);
      }
      return lines;
    }

    case 'decision': {
      const lines = [`decision${id}:`];
      lines.push(`  ${applyAliases(block.text)}`);
      if (block.why !== undefined) lines.push(`  why: ${applyAliases(block.why)}`);
      if (block.resources !== undefined && block.resources.length > 0) {
        lines.push(`  files: ${block.resources.map(applyAliases).join(', ')}`);
      }
      if (block.status !== undefined) lines.push(`  status: ${block.status}`);
      return lines;
    }

    case 'constraint': {
      const lines = [`constraint${id}: ${applyAliases(block.text)}`];
      if (block.resources !== undefined && block.resources.length > 0) {
        lines.push(`  files: ${block.resources.map(applyAliases).join(', ')}`);
      }
      return lines;
    }

    case 'assumption': {
      const lines = [`assumption${id}: ${applyAliases(block.text)}`];
      if (block.basis !== undefined) lines.push(`  basis: ${applyAliases(block.basis)}`);
      return lines;
    }

    case 'error': {
      const lines = [`error${id}: ${applyAliases(block.text)}`];
      if (block.resource !== undefined) lines.push(`  file: ${applyAliases(block.resource)}`);
      return lines;
    }

    case 'test': {
      const lines = [`test${id}: ${block.status}`];
      if (block.testName !== undefined) lines.push(`  name: ${block.testName}`);
      if (block.error !== undefined) lines.push(`  error: ${block.error}`);
      return lines;
    }

    case 'placeholder': {
      const lines = [`placeholder${id}: ${applyAliases(block.resource)}`];
      lines.push(`  desc: ${applyAliases(block.text)}`);
      if (block.replacement !== undefined) {
        lines.push(`  intended: ${applyAliases(block.replacement)}`);
      }
      if (block.status !== undefined) lines.push(`  status: ${block.status}`);
      return lines;
    }

    case 'question': {
      const lines = [`question${id}: ${applyAliases(block.text)}`];
      if (block.blocking === true) lines.push(`  blocking: true`);
      return lines;
    }

    case 'handoff': {
      const lines = [`handoff${id}:`];
      lines.push(`  summary: ${applyAliases(block.summary)}`);
      if (block.done !== undefined && block.done.length > 0) {
        lines.push(`  done:`);
        for (const item of block.done) lines.push(`    - ${applyAliases(item)}`);
      }
      if (block.remaining !== undefined && block.remaining.length > 0) {
        lines.push(`  remaining:`);
        for (const item of block.remaining) lines.push(`    - ${applyAliases(item)}`);
      }
      if (block.next !== undefined) lines.push(`  next: ${applyAliases(block.next)}`);
      if (block.blockers !== undefined && block.blockers.length > 0) {
        lines.push(`  blockers:`);
        for (const b of block.blockers) lines.push(`    - ${applyAliases(b)}`);
      }
      if (block.issues !== undefined && block.issues.length > 0) {
        lines.push(`  issues:`);
        for (const issue of block.issues) lines.push(`    - ${applyAliases(issue)}`);
      }
      return lines;
    }

    case 'obs': {
      const lines = [`obs${id}: ${applyAliases(block.text)}`];
      if (block.resource !== undefined) lines.push(`  file: ${applyAliases(block.resource)}`);
      return lines;
    }

    case 'state': {
      return [`state: ${block.key}=${applyAliases(block.value)}`];
    }

    case 'conflicts': {
      const lines = [`conflicts: ${applyAliases(block.resource)} [${block.severity}]`];
      if (block.agentId !== undefined) lines.push(`  agent: ${block.agentId}`);
      if (block.message !== undefined) lines.push(`  msg: ${applyAliases(block.message)}`);
      return lines;
    }

    case 'text': {
      return [block.text];
    }
  }
}
