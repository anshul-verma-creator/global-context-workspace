import type { StenoDocument, StenoBlock } from './grammar.js';
import { STENO_VERSION } from './grammar.js';

/**
 * Steno parser — converts a Steno string back to a StenoDocument.
 *
 * Per spec §16 (Technical Specification):
 * - deterministic parsing
 * - no ambiguity
 * - fallback to natural language for unknown labels
 *
 * Design decision: We use a simple line-by-line parser rather than
 * a grammar library to keep the parser auditable and dependency-free.
 */

export interface ParseResult {
  ok: boolean;
  document?: StenoDocument;
  errors: string[];
}

/** Helper: conditionally include a key when value is not undefined */
function opt<K extends string, V>(key: K, value: V | undefined): Record<string, V> {
  return value !== undefined ? { [key]: value } : {};
}

export function parseStenoDocument(text: string): ParseResult {
  const errors: string[] = [];
  const lines = text.split('\n');

  if (lines.length === 0) {
    return { ok: false, errors: ['Empty document'] };
  }

  // Parse header
  const headerLine = lines[0]?.trim() ?? '';
  const headerMatch = /^steno:v(\d+)\s+dict:v(\d+)$/.exec(headerLine);

  if (headerMatch === null) {
    return { ok: false, errors: [`Invalid header: ${headerLine}`] };
  }

  const version = parseInt(headerMatch[1] ?? '0', 10);
  const dictVersion = parseInt(headerMatch[2] ?? '0', 10);

  if (version !== STENO_VERSION) {
    errors.push(`Version mismatch: expected ${STENO_VERSION}, got ${version}`);
    // Still try to parse — forward compatibility
  }

  const blocks: StenoBlock[] = [];
  let i = 1;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Skip blank lines between blocks
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Each block starts with a label at column 0
    const blockResult = parseBlock(lines, i);
    if (blockResult !== null) {
      blocks.push(blockResult.block);
      i = blockResult.nextLine;
    } else {
      // Unknown line — treat as text
      blocks.push({ label: 'text', text: line });
      i++;
    }
  }

  return {
    ok: errors.length === 0,
    document: { version: STENO_VERSION, dictVersion, blocks },
    errors,
  };
}

interface BlockResult {
  block: StenoBlock;
  nextLine: number;
}

function parseBlock(lines: string[], startLine: number): BlockResult | null {
  const line = lines[startLine];
  if (line === undefined) return null;
  const trimmed = line.trim();
  if (trimmed === '') return null;

  // Match: label[optional-id]: optional-text
  const labelMatch = /^(\w+)(?:\s+\[([^\]]+)\])?:\s*(.*)$/.exec(trimmed);
  if (labelMatch === null) return null;

  const label = labelMatch[1] ?? '';
  const id: string | undefined = labelMatch[2];
  const firstText = (labelMatch[3] ?? '').trim();

  // Collect indented sub-lines
  const subLines: Record<string, string> = {};
  const listLines: Record<string, string[]> = {};
  const bodyTextLines: string[] = [];
  let currentListKey: string | null = null;
  let nextLine = startLine + 1;

  while (nextLine < lines.length) {
    const subLine = lines[nextLine];
    if (subLine === undefined) break;
    if (!subLine.startsWith('  ')) break;

    const subTrimmed = subLine.trim();
    if (subTrimmed.startsWith('- ')) {
      // List item
      if (currentListKey !== null) {
        const existing = listLines[currentListKey] ?? [];
        existing.push(subTrimmed.substring(2).trim());
        listLines[currentListKey] = existing;
      }
      nextLine++;
      continue;
    }

    const subMatch = /^(\w+):\s*(.*)$/.exec(subTrimmed);
    if (subMatch !== null) {
      const subKey = subMatch[1] ?? '';
      const subValue = (subMatch[2] ?? '').trim();

      if (subValue === '') {
        // Next lines will be list items
        currentListKey = subKey;
      } else {
        subLines[subKey] = subValue;
        currentListKey = null;
      }
    } else if (subTrimmed.length > 0) {
      // Plain indented text (e.g., decision body)
      bodyTextLines.push(subTrimmed);
      currentListKey = null;
    }
    nextLine++;
  }

  const bodyText = bodyTextLines.join(' ');



  function sub(key: string): string | undefined {
    return subLines[key];
  }

  function list(key: string): string[] | undefined {
    return listLines[key];
  }

  switch (label) {
    case 'task':
      return {
        block: {
          label: 'task',
          text: firstText,
          ...opt('id', id),
          ...opt('status', sub('status')),
          ...opt('resource', sub('file')),
        },
        nextLine,
      };

    case 'intent':
      return {
        block: {
          label: 'intent',
          text: firstText,
          ...opt('id', id),
          ...opt('resources', sub('files')?.split(', ')),
        },
        nextLine,
      };

    case 'decision': {
      const decisionText = bodyText || firstText || (sub('text') ?? '');

      return {
        block: {
          label: 'decision',
          text: decisionText,
          ...opt('id', id),
          ...opt('why', sub('why')),
          ...opt('resources', sub('files')?.split(', ')),
          ...opt('status', sub('status')),
        },
        nextLine,
      };
    }


    case 'constraint':
      return {
        block: {
          label: 'constraint',
          text: firstText,
          ...opt('id', id),
          ...opt('resources', sub('files')?.split(', ')),
        },
        nextLine,
      };

    case 'assumption':
      return {
        block: {
          label: 'assumption',
          text: firstText,
          ...opt('id', id),
          ...opt('basis', sub('basis')),
        },
        nextLine,
      };

    case 'error':
      return {
        block: {
          label: 'error',
          text: firstText,
          ...opt('id', id),
          ...opt('resource', sub('file')),
        },
        nextLine,
      };

    case 'test':
      return {
        block: {
          label: 'test',
          status: (firstText as 'passed' | 'failed') ?? 'failed',
          ...opt('id', id),
          ...opt('testName', sub('name')),
          ...opt('error', sub('error')),
        },
        nextLine,
      };

    case 'placeholder':
      return {
        block: {
          label: 'placeholder',
          resource: firstText,
          text: sub('desc') ?? '',
          ...opt('id', id),
          ...opt('replacement', sub('intended')),
          ...opt('status', sub('status')),
        },
        nextLine,
      };

    case 'question':
      return {
        block: {
          label: 'question',
          text: firstText,
          blocking: sub('blocking') === 'true',
          ...opt('id', id),
        },
        nextLine,
      };

    case 'handoff':
      return {
        block: {
          label: 'handoff',
          summary: sub('summary') ?? firstText,
          ...opt('id', id),
          ...opt('done', list('done')),
          ...opt('remaining', list('remaining')),
          ...opt('next', sub('next')),
          ...opt('blockers', list('blockers')),
          ...opt('issues', list('issues')),
        },
        nextLine,
      };

    case 'obs':
      return {
        block: {
          label: 'obs',
          text: firstText,
          ...opt('id', id),
          ...opt('resource', sub('file')),
        },
        nextLine,
      };

    case 'state': {
      const eqIdx = firstText.indexOf('=');
      return {
        block: {
          label: 'state',
          key: eqIdx >= 0 ? firstText.substring(0, eqIdx) : firstText,
          value: eqIdx >= 0 ? firstText.substring(eqIdx + 1) : '',
        },
        nextLine,
      };
    }

    case 'conflicts':
      return {
        block: {
          label: 'conflicts',
          resource: firstText.replace(/\s*\[.*\]$/, '').trim(),
          severity: /\[([^\]]+)\]/.exec(firstText)?.[1] ?? 'medium',
          ...opt('agentId', sub('agent')),
          ...opt('message', sub('msg')),
        },
        nextLine,
      };

    case 'text':
      return { block: { label: 'text', text: firstText }, nextLine };

    default:
      // Unknown label — treat as text block
      return { block: { label: 'text', text: trimmed }, nextLine };
  }
}
