import type { ContextObjectsStore } from '@context-workspace/database';
import type { ContextEvent, ContextObject, ContextObjectStatus } from '@context-workspace/protocol';
import { generateId, nowMs, createLogger } from '@context-workspace/shared';

const log = createLogger({ component: 'placeholders' });

export type PlaceholderLifecycleStatus = 'candidate' | 'active' | 'confirmed' | 'resolved' | 'rejected';

export type DetectionMethod = 'explicit_marker' | 'static_signal' | 'agent_declaration';

export interface DetectedPlaceholder {
  resource: string;
  line?: number;
  description: string;
  intendedReplacement?: string;
  detectionMethod: DetectionMethod;
  rawMarker?: string;
}

export interface PlaceholderContextView {
  id: string;
  resource: string;
  description: string;
  status: PlaceholderLifecycleStatus;
  detectionMethod: DetectionMethod;
  intendedReplacement?: string;
  authoritative: false;
  warning: string;
}

// Regex patterns for explicit markers
const EXPLICIT_PATTERNS: { regex: RegExp; marker: string }[] = [
  { regex: /(?:\/\/|\/\*|#|<!--)\s*(?:TODO|FIXME|STUB|MOCK|PLACEHOLDER|HACK):\s*([^\n\r*]+)/i, marker: 'TODO' },
  { regex: /(?:\/\/|\/\*|#)\s*(?:TEMP|TEMPORARY|UNIMPLEMENTED):\s*([^\n\r*]+)/i, marker: 'TEMP' },
];

// Regex patterns for static/code signals
const STATIC_SIGNAL_PATTERNS: { regex: RegExp; signal: string }[] = [
  { regex: /throw new (?:Error|NotImplementedError|UnsupportedOperationException)\(['"`](?:Not implemented|TODO|stub)['"`]\)/i, signal: 'throw_not_implemented' },
  { regex: /unimplemented!\(\)/, signal: 'rust_unimplemented' },
  { regex: /raise NotImplementedError/i, signal: 'python_not_implemented' },
  { regex: /return\s+null;\s*\/\/\s*(?:stub|placeholder|temporary|mock)/i, signal: 'dummy_return' },
];

/**
 * Scan source code content for explicit markers and static signals.
 */
export function scanContentForPlaceholders(filePath: string, content: string): DetectedPlaceholder[] {
  const lines = content.split(/\r?\n/);
  const detected: DetectedPlaceholder[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i]!;

    // 1. Explicit markers
    for (const { regex, marker } of EXPLICIT_PATTERNS) {
      const match = line.match(regex);
      if (match && match[1]) {
        const desc = match[1].trim();
        detected.push({
          resource: filePath,
          line: lineNum,
          description: desc,
          detectionMethod: 'explicit_marker',
          rawMarker: marker,
        });
      }
    }

    // 2. Static signals
    for (const { regex, signal } of STATIC_SIGNAL_PATTERNS) {
      if (regex.test(line)) {
        detected.push({
          resource: filePath,
          line: lineNum,
          description: `Unimplemented code signal (${signal}) detected at line ${lineNum}`,
          detectionMethod: 'static_signal',
          rawMarker: signal,
        });
      }
    }
  }

  return detected;
}

/**
 * Extract placeholder from an incoming event (e.g. agent declaration or file change).
 */
export function extractPlaceholderFromEvent(event: ContextEvent): DetectedPlaceholder[] {
  const payload = (event.payload ?? {}) as Record<string, any>;
  const eventType = event.type as string;

  // Direct agent declaration: placeholder.declared or report_placeholder
  if (
    eventType === 'placeholder.declared' ||
    eventType === 'placeholder:created' ||
    payload['kind'] === 'placeholder.declared' ||
    payload['kind'] === 'placeholder'
  ) {
    const resource = payload['resource'] ?? payload['filePath'] ?? 'unknown';
    const description = payload['description'] ?? payload['note'] ?? 'Declared placeholder';
    const intendedReplacement = payload['intendedReplacement'] ?? payload['replacement'];

    return [
      {
        resource,
        description,
        intendedReplacement,
        detectionMethod: 'agent_declaration',
      },
    ];
  }

  // File change with text content: run hybrid detection
  if (
    (eventType === 'file:change' || eventType === 'file:create' || eventType === 'file.modified') &&
    typeof payload['content'] === 'string' &&
    typeof payload['path'] === 'string'
  ) {
    return scanContentForPlaceholders(payload['path'], payload['content']);
  }

  return [];
}

/**
 * PlaceholderManager — Manages the full placeholder lifecycle and retrieval views.
 *
 * Lifecycle:
 *   candidate → active → confirmed → resolved | rejected
 *
 * Acceptance invariant:
 *   An AI retrieving a placeholder receives its placeholder status and intended replacement
 *   rather than treating placeholder data as authoritative.
 */
export class PlaceholderManager {
  constructor(private readonly objectsStore: ContextObjectsStore) {}

  /**
   * Register a new placeholder.
   */
  register(params: {
    repositoryId: string;
    capsuleId?: string;
    resource: string;
    description: string;
    intendedReplacement?: string;
    detectionMethod: DetectionMethod;
    initialStatus?: PlaceholderLifecycleStatus;
  }): ContextObject {
    const status: PlaceholderLifecycleStatus = params.initialStatus ?? 'active';
    const now = nowMs();
    const id = generateId();

    const obj = this.objectsStore.create(
      {
        repositoryId: params.repositoryId,
        ...(params.capsuleId !== undefined ? { capsuleId: params.capsuleId } : {}),
        type: 'PLACEHOLDER',
        scope: 'resource',
        visibility: 'repository',
        status: status === 'candidate' ? 'candidate' : status === 'confirmed' ? 'confirmed' : 'active',
        authority: params.detectionMethod === 'agent_declaration' ? 'agent_explicit' : 'static_analysis',
        resource: params.resource,
        provenance: { sourceEventIds: [`gen-${id}`] },
        validFrom: now,
        content: {
          kind: 'placeholder',
          resource: params.resource,
          description: params.description,
          ...(params.intendedReplacement !== undefined ? { intendedReplacement: params.intendedReplacement } : {}),
          detectionMethod: params.detectionMethod,
          placeholderStatus: status,
        } as any,
      },
      id,
    );

    log.info('Placeholder registered', {
      id: obj.id,
      resource: params.resource,
      status,
      method: params.detectionMethod,
    });

    return obj;
  }

  /**
   * Transition placeholder to a new lifecycle status.
   */
  transition(id: string, newStatus: PlaceholderLifecycleStatus): ContextObject | undefined {
    const existing = this.objectsStore.getById(id);
    if (existing === undefined || existing.type !== 'PLACEHOLDER') {
      return undefined;
    }

    const content = existing.content as Record<string, any>;
    content['placeholderStatus'] = newStatus;

    // Update the record's generic status as well
    const genericStatus: ContextObjectStatus =
      newStatus === 'candidate'
        ? 'candidate'
        : newStatus === 'confirmed'
        ? 'confirmed'
        : newStatus === 'resolved'
        ? 'resolved'
        : newStatus === 'rejected'
        ? 'rejected'
        : 'active';

    this.objectsStore.update(id, {
      status: genericStatus,
      content: content as any,
    });

    log.info('Placeholder status transitioned', { id, newStatus });
    return this.objectsStore.getById(id);
  }

  /**
   * Produce the AI retrieval view for a placeholder.
   * Explicitly presents placeholder status and intended replacement,
   * guaranteeing that the AI is warned NOT to treat placeholder data as authoritative.
   */
  formatForRetrieval(obj: ContextObject): PlaceholderContextView {
    const content = (obj.content ?? {}) as Record<string, any>;
    const status: PlaceholderLifecycleStatus = content['placeholderStatus'] ?? (obj.status as any) ?? 'active';
    const resource: string = content['resource'] ?? obj.resource ?? 'unknown';
    const description: string = content['description'] ?? 'Placeholder implementation';
    const intendedReplacement: string | undefined = content['intendedReplacement'];
    const detectionMethod: DetectionMethod = content['detectionMethod'] ?? 'agent_declaration';

    return {
      id: obj.id,
      resource,
      description,
      status,
      detectionMethod,
      ...(intendedReplacement !== undefined ? { intendedReplacement } : {}),
      authoritative: false,
      warning: `[NON-AUTHORITATIVE PLACEHOLDER] Resource '${resource}' is currently a ${status.toUpperCase()} placeholder. Intended replacement: ${intendedReplacement ?? 'Not specified'}. Do not treat existing mock/stub values as authoritative.`,
    };
  }

  /**
   * List all active / confirmed placeholders for a repository.
   */
  listActive(repositoryId: string): PlaceholderContextView[] {
    const objects = this.objectsStore.list({
      repositoryId,
      types: ['PLACEHOLDER'],
    });

    const active = objects.filter((o: ContextObject) => {
      const content = (o.content ?? {}) as Record<string, any>;
      const status = content['placeholderStatus'] ?? o.status;
      return status === 'active' || status === 'confirmed' || status === 'candidate';
    });

    return active.map((o: ContextObject) => this.formatForRetrieval(o));
  }
}
