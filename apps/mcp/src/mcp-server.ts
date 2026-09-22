import type { ContextRuntime } from '@context-workspace/runtime';
import { PlaceholderManager } from '@context-workspace/runtime';
import { HandoffManager } from '@context-workspace/runtime';
import { serializeStenoDocument } from '@context-workspace/steno';
import { generateId, nowMs, createLogger } from '@context-workspace/shared';

const log = createLogger({ component: 'mcp-server' });

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export interface McpResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export const MCP_RESOURCES: McpResourceDefinition[] = [
  {
    uri: 'context://current',
    name: 'Active Workspace Context',
    description: 'Current compiled active workspace context, tasks, and constraints',
    mimeType: 'text/markdown',
  },
  {
    uri: 'context://decisions',
    name: 'Architectural Decisions',
    description: 'Active and superseding architectural decisions',
    mimeType: 'application/json',
  },
  {
    uri: 'context://handoff',
    name: 'Agent Handoff',
    description: 'Latest structured handoff state between agents',
    mimeType: 'application/json',
  },
  {
    uri: 'context://placeholders',
    name: 'Placeholders & Stubs',
    description: 'Active placeholders, stubs, and mocks awaiting completion',
    mimeType: 'application/json',
  },
];

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'context.search',
    description: 'Search repository context objects by keyword, types, and scope. Returns compact relevant context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term or keywords' },
        repositoryId: { type: 'string', description: 'Repository ID to search within' },
        types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by object types: DECISION, TASK, CONSTRAINT, ERROR, PLACEHOLDER, etc.',
        },
        limit: { type: 'number', description: 'Maximum results to return (default: 10)' },
      },
      required: ['query', 'repositoryId'],
    },
  },
  {
    name: 'context.get',
    description: 'Retrieve a specific context object by unique identifier.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Context object ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'context.current',
    description: 'Compile active minimum context for the current task/resource within token budget.',
    inputSchema: {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository ID' },
        task: { type: 'string', description: 'Current active task title or description' },
        resource: { type: 'string', description: 'File path currently being worked on' },
        tokenBudget: { type: 'number', description: 'Maximum token budget (default: 2000)' },
      },
      required: ['repositoryId'],
    },
  },
  {
    name: 'context.handoff',
    description: 'Get latest structured handoff or record a new handoff between agents.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'create'], description: 'Action to perform' },
        repositoryId: { type: 'string', description: 'Repository ID' },
        capsuleId: { type: 'string', description: 'Optional capsule ID' },
        completed: { type: 'array', items: { type: 'string' }, description: 'Completed milestones (for create)' },
        remaining: { type: 'array', items: { type: 'string' }, description: 'Remaining tasks (for create)' },
        next_step: { type: 'string', description: 'Immediate next step (for create)' },
        blockers: { type: 'array', items: { type: 'string' }, description: 'Active blockers (for create)' },
        placeholders: { type: 'array', items: { type: 'string' }, description: 'Placeholders left behind (for create)' },
        known_issues: { type: 'array', items: { type: 'string' }, description: 'Known issues (for create)' },
        summary: { type: 'string', description: 'Handoff summary (for create)' },
      },
      required: ['action', 'repositoryId'],
    },
  },
  {
    name: 'context.report_decision',
    description: 'Record an architectural or implementation decision.',
    inputSchema: {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository ID' },
        capsuleId: { type: 'string', description: 'Optional capsule ID' },
        decision: { type: 'string', description: 'The decision statement' },
        rationale: { type: 'string', description: 'Why this decision was made' },
        supersedesId: { type: 'string', description: 'ID of an earlier decision this supersedes' },
      },
      required: ['repositoryId', 'decision'],
    },
  },
  {
    name: 'context.report_intent',
    description: 'Declare upcoming intent before modifying files to avoid conflicts with other agents.',
    inputSchema: {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository ID' },
        capsuleId: { type: 'string', description: 'Optional capsule ID' },
        intent: { type: 'string', description: 'Planned action description' },
        targetResources: { type: 'array', items: { type: 'string' }, description: 'Files planned to touch' },
      },
      required: ['repositoryId', 'intent'],
    },
  },
  {
    name: 'context.report_placeholder',
    description: 'Report a placeholder, mock, or stub with its intended replacement so other agents do not treat it as authoritative.',
    inputSchema: {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository ID' },
        capsuleId: { type: 'string', description: 'Optional capsule ID' },
        resource: { type: 'string', description: 'File path containing the placeholder' },
        description: { type: 'string', description: 'Description of the mock/stub' },
        intendedReplacement: { type: 'string', description: 'What this should be replaced with' },
      },
      required: ['repositoryId', 'resource', 'description'],
    },
  },
  {
    name: 'context.report_question',
    description: 'Record an open question or clarification blocker.',
    inputSchema: {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository ID' },
        capsuleId: { type: 'string', description: 'Optional capsule ID' },
        question: { type: 'string', description: 'The question or blocker' },
        context: { type: 'string', description: 'Background context for the question' },
      },
      required: ['repositoryId', 'question'],
    },
  },
  {
    name: 'context.conflicts',
    description: 'Check for active conflicts or concurrent resource leases in the repository.',
    inputSchema: {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository ID' },
        resource: { type: 'string', description: 'Optional specific file path to check' },
      },
      required: ['repositoryId'],
    },
  },
  {
    name: 'context.lease',
    description: 'Acquire, check, or release a resource lease to prevent edit collisions.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['acquire', 'release', 'check'], description: 'Lease action' },
        repositoryId: { type: 'string', description: 'Repository ID' },
        resource: { type: 'string', description: 'Resource file path' },
        holderId: { type: 'string', description: 'Agent ID or Session ID holding the lease' },
        ttlMs: { type: 'number', description: 'Lease TTL in ms (default: 60000)' },
      },
      required: ['action', 'repositoryId', 'resource', 'holderId'],
    },
  },
];

/**
 * McpServer — Standard Model Context Protocol Server (Phase 20).
 *
 * Implements all 10 MCP tools:
 *   context.search
 *   context.get
 *   context.current
 *   context.handoff
 *   context.report_decision
 *   context.report_intent
 *   context.report_placeholder
 *   context.report_question
 *   context.conflicts
 *   context.lease
 */
export class McpServer {
  private readonly runtime: ContextRuntime;
  private readonly placeholders: PlaceholderManager;
  private readonly handoffs: HandoffManager;

  // In-memory leases map for local runtime (server uses PostgreSQL unique index)
  private readonly leases = new Map<string, { resource: string; holderId: string; expiresAt: number }>();

  constructor(runtime: ContextRuntime) {
    this.runtime = runtime;
    this.placeholders = new PlaceholderManager(runtime.objects);
    this.handoffs = new HandoffManager(runtime.objects);
  }

  /**
   * Handle an incoming JSON-RPC 2.0 request or notification.
   * Per JSON-RPC 2.0 spec (section 4.1), notifications MUST NOT receive a response;
   * this method returns null for notifications.
   */
  async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const isNotification = req.id === undefined || (typeof req.method === 'string' && req.method.startsWith('notifications/'));
    const id = req.id ?? null;

    // Validate JSON-RPC 2.0 structure
    if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      if (isNotification) return null;
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32600, message: 'Invalid Request: "jsonrpc" must be "2.0" and "method" must be a string' },
      };
    }

    try {
      switch (req.method) {
        case 'initialize': {
          const requestedVersion = req.params?.['protocolVersion'];
          const protocolVersion = typeof requestedVersion === 'string' && requestedVersion ? requestedVersion : '2024-11-05';
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion,
              capabilities: {
                tools: {},
                resources: {},
              },
              serverInfo: {
                name: 'global-context-workspace-mcp',
                version: '0.1.0',
              },
            },
          };
        }

        case 'notifications/initialized':
          // Standard MCP client notification after initialize — MUST NOT return a response
          return null;

        case 'ping':
          return isNotification ? null : { jsonrpc: '2.0', id, result: {} };

        case 'tools/list':
          return isNotification ? null : {
            jsonrpc: '2.0',
            id,
            result: { tools: MCP_TOOLS },
          };

        case 'tools/call': {
          if (isNotification) return null;
          const toolName = req.params?.['name'];
          if (typeof toolName !== 'string' || !toolName) {
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: 'Invalid params: tool "name" is required' },
            };
          }
          const toolArgs = (req.params?.['arguments'] && typeof req.params['arguments'] === 'object' && !Array.isArray(req.params['arguments']))
            ? req.params['arguments']
            : {};
          return await this._handleToolCall(id, toolName, toolArgs);
        }

        case 'resources/list':
          return isNotification ? null : {
            jsonrpc: '2.0',
            id,
            result: { resources: MCP_RESOURCES },
          };

        case 'resources/read': {
          if (isNotification) return null;
          const uri = req.params?.['uri'];
          if (typeof uri !== 'string' || !uri) {
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: 'Invalid params: resource "uri" is required' },
            };
          }
          return await this._handleResourceRead(id, uri);
        }

        case 'prompts/list':
          return isNotification ? null : {
            jsonrpc: '2.0',
            id,
            result: { prompts: [] },
          };

        case 'logging/setLevel':
          return isNotification ? null : { jsonrpc: '2.0', id, result: {} };

        default:
          if (isNotification) return null;
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${req.method}` },
          };
      }
    } catch (err) {
      log.error('MCP request error', { method: req.method, error: String(err) });
      if (isNotification) return null;
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: `Internal error: ${String(err)}` },
      };
    }
  }

  /**
   * Handle JSON-RPC message string (stdio transport helper).
   * Returns a JSON-RPC response string, or null if no response should be sent (notifications).
   */
  async handleMessage(rawMessage: string): Promise<string | null> {
    const trimmed = rawMessage.trim();
    if (!trimmed) return null;

    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Invalid Request: expected JSON object' },
        });
      }
      const resp = await this.handleRequest(parsed as JsonRpcRequest);
      if (resp === null) return null;
      return JSON.stringify(resp);
    } catch (err) {
      return JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON' },
      });
    }
  }

  private async _handleResourceRead(
    id: string | number | null,
    uri: string,
  ): Promise<JsonRpcResponse> {
    try {
      const parsedUri = new URL(uri);
      const host = parsedUri.hostname;
      let text = '';
      let mimeType = 'application/json';

      switch (host) {
        case 'current': {
          mimeType = 'text/markdown';
          const repos = this.runtime.repositories.list();
          const repo = repos[0];
          if (repo) {
            const session = {
              id: `mcp-${generateId()}`,
              capsuleId: repo.id,
              userId: 'mcp-agent',
              deviceId: 'local',
              status: 'active' as const,
              createdAt: nowMs(),
              updatedAt: nowMs(),
              startedAt: nowMs(),
            };
            const compiled = await this.runtime.context.assemble(
              session,
              { repositoryId: repo.id, maxTokens: 2000 },
              { maxTokens: 2000 },
            );
            text = compiled.serialized;
          } else {
            text = '# No active repository';
          }
          break;
        }
        case 'decisions': {
          // Query distinct repository IDs from the objects table directly.
          // This works even when repos were created via sync (not explicitly registered).
          const repoIds = this._activeRepositoryIds();
          const decisions = repoIds.flatMap((repoId) =>
            this.runtime.objects.list({ repositoryId: repoId, types: ['DECISION'] }),
          );
          text = JSON.stringify(decisions, null, 2);
          break;
        }
        case 'handoff': {
          const repoIds = this._activeRepositoryIds();
          const repoId = repoIds[0];
          const latest = repoId ? this.handoffs.getLatestHandoff(repoId) : null;
          text = JSON.stringify(latest ?? {}, null, 2);
          break;
        }
        case 'placeholders': {
          const repoIds = this._activeRepositoryIds();
          const repoId = repoIds[0];
          const phs = repoId ? this.placeholders.listActive(repoId) : [];
          text = JSON.stringify(phs, null, 2);
          break;
        }
        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: `Resource not found: ${uri}` },
          };
      }

      return {
        jsonrpc: '2.0',
        id,
        result: {
          contents: [
            {
              uri,
              mimeType,
              text,
            },
          ],
        },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: `Failed to read resource: ${String(err)}` },
      };
    }
  }

  /**
   * Returns distinct repository IDs that have at least one context object.
   * Falls back gracefully when the repositories table is not populated
   * (e.g. when Agent B joins via cloud sync without explicit repo registration).
   */
  private _activeRepositoryIds(): string[] {
    // Prefer the repositories table first (preserves rootPath / name metadata)
    const registered = this.runtime.repositories.list().map((r) => r.id);
    if (registered.length > 0) return registered;
    // Fallback: query distinct repository_id values from context_objects
    // This handles the sync case where objects exist but the repo wasn't registered.
    return this.runtime.objects.listDistinctRepositoryIds();
  }

  /**
   * Ensure a repository record exists in the repositories table.
   * Called by write tools that reference a repositoryId.
   * Safe to call repeatedly — uses INSERT OR IGNORE semantics.
   */
  private _ensureRepository(repositoryId: string): void {
    if (!this.runtime.repositories.getById(repositoryId)) {
      this.runtime.repositories.create({
        id: repositoryId,
        workspaceId: 'mcp-default',
        rootPath: repositoryId,
        name: repositoryId,
      });
    }
  }

  private async _handleToolCall(
    id: string | number | null,
    toolName: string,
    args: Record<string, any>,
  ): Promise<JsonRpcResponse> {
    let resultText = '';

    switch (toolName) {
      case 'context.search': {
        const query = args['query'] as string;
        const repositoryId = args['repositoryId'] as string;
        const types = args['types'] as string[] | undefined;
        const limit = (args['limit'] as number | undefined) ?? 10;

        const objects = this.runtime.objects.searchFts(repositoryId, query, limit);
        const filtered = types && types.length > 0
          ? objects.filter((o) => types.includes(o.type))
          : objects;

        resultText = JSON.stringify(
          {
            count: filtered.length,
            results: filtered.map((o) => {
              const relations = this.runtime.relations.listAll(o.id);
              return {
                id: o.id,
                type: o.type,
                status: o.status,
                resource: o.resource,
                content: o.content,
                relations,
              };
            }),
          },
          null,
          2,
        );
        break;
      }

      case 'context.get': {
        const objId = args['id'] as string;
        const obj = this.runtime.objects.getById(objId);
        if (!obj) {
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: `Context object not found: ${objId}` }], isError: true },
          };
        }
        const relations = this.runtime.relations.listAll(objId);
        resultText = JSON.stringify({ ...obj, relations }, null, 2);
        break;
      }

      case 'context.current': {
        const repositoryId = args['repositoryId'] as string;
        const capsuleId = args['capsuleId'] as string | undefined;
        const task = args['task'] as string | undefined;
        const resource = args['resource'] as string | undefined;
        const tokenBudget = (args['tokenBudget'] as number | undefined) ?? 2000;

        const session = {
          id: `mcp-${generateId()}`,
          capsuleId: capsuleId ?? repositoryId,
          userId: 'mcp-agent',
          deviceId: 'local',
          status: 'active' as const,
          createdAt: nowMs(),
          updatedAt: nowMs(),
          startedAt: nowMs(),
        };

        const compiled = await this.runtime.context.assemble(
          session,
          {
            repositoryId,
            ...(capsuleId !== undefined ? { capsuleId } : {}),
            maxTokens: tokenBudget,
            ...(task !== undefined ? { task } : {}),
            ...(resource !== undefined ? { resource } : {}),
          },
          { maxTokens: tokenBudget },
        );

        resultText = compiled.serialized;
        break;
      }

      case 'context.handoff': {
        const action = args['action'] as 'get' | 'create';
        const repositoryId = args['repositoryId'] as string;
        const capsuleId = args['capsuleId'] as string | undefined;

        if (action === 'get') {
          const latest = this.handoffs.getLatestHandoff(repositoryId, capsuleId);
          if (!latest) {
            resultText = 'No active handoff found for this repository/capsule.';
          } else {
            resultText = this.handoffs.formatCompactHandoff(latest);
          }
        } else {
          const created = this.handoffs.createHandoff({
            repositoryId,
            ...(capsuleId !== undefined ? { capsuleId } : {}),
            completed: args['completed'] ?? [],
            remaining: args['remaining'] ?? [],
            next_step: args['next_step'] ?? 'Continue task',
            blockers: args['blockers'] ?? [],
            placeholders: args['placeholders'] ?? [],
            known_issues: args['known_issues'] ?? [],
            summary: args['summary'] ?? 'Agent session handoff',
          });
          resultText = `Handoff created [${created.id}]\n` + this.handoffs.formatCompactHandoff(created);
        }
        break;
      }

      case 'context.report_decision': {
        const repositoryId = args['repositoryId'] as string;
        const capsuleId = args['capsuleId'] as string | undefined;
        const decision = args['decision'] as string;
        const rationale = args['rationale'] as string | undefined;
        const supersedesId = args['supersedesId'] as string | undefined;
        this._ensureRepository(repositoryId);
        const now = nowMs();
        const objId = generateId();

        const created = this.runtime.objects.create(
          {
            repositoryId,
            ...(capsuleId !== undefined ? { capsuleId } : {}),
            type: 'DECISION',
            scope: 'repository',
            visibility: 'repository',
            status: 'active',
            authority: 'agent_explicit',
            provenance: { sourceEventIds: [`gen-${objId}`] },
            validFrom: now,
            content: {
              kind: 'decision',
              title: decision,
              statement: decision,
              ...(rationale !== undefined ? { rationale } : {}),
              status: 'decided',
            } as any,
          },
          objId,
        );

        if (supersedesId) {
          this.runtime.relations.create({
            repositoryId,
            fromId: created.id,
            toId: supersedesId,
            relationType: 'supersedes',
          });
          const existing = this.runtime.objects.getById(supersedesId);
          if (existing) {
            this.runtime.objects.update(supersedesId, {
              status: 'superseded',
              validUntil: now,
            });
          }
        }

        resultText = `Decision recorded [${created.id}]: "${decision}"`;
        break;
      }

      case 'context.report_intent': {
        const repositoryId = args['repositoryId'] as string;
        const capsuleId = args['capsuleId'] as string | undefined;
        const intent = args['intent'] as string;
        const targetResources = args['targetResources'] as string[] | undefined;
        this._ensureRepository(repositoryId);
        const now = nowMs();
        const objId = generateId();

        const created = this.runtime.objects.create({
          repositoryId,
          ...(capsuleId !== undefined ? { capsuleId } : {}),
          type: 'INTENT',
          scope: 'capsule',
          visibility: 'repository',
          status: 'active',
          authority: 'agent_explicit',
          provenance: { sourceEventIds: [`gen-${objId}`] },
          validFrom: now,
          content: {
            kind: 'intent',
            description: intent,
            ...(targetResources !== undefined ? { targetResources } : {}),
          } as any,
        }, objId);

        resultText = `Intent recorded [${created.id}]: "${intent}"`;
        break;
      }

      case 'context.report_placeholder': {
        const repositoryId = args['repositoryId'] as string;
        const capsuleId = args['capsuleId'] as string | undefined;
        const resource = args['resource'] as string;
        const description = args['description'] as string;
        const intendedReplacement = args['intendedReplacement'] as string | undefined;

        const created = this.placeholders.register({
          repositoryId,
          ...(capsuleId !== undefined ? { capsuleId } : {}),
          resource,
          description,
          ...(intendedReplacement !== undefined ? { intendedReplacement } : {}),
          detectionMethod: 'agent_declaration',
          initialStatus: 'active',
        });

        const view = this.placeholders.formatForRetrieval(created);
        resultText = `${view.warning}\nRegistered ID: ${created.id}`;
        break;
      }

      case 'context.report_question': {
        const repositoryId = args['repositoryId'] as string;
        const capsuleId = args['capsuleId'] as string | undefined;
        const question = args['question'] as string;
        const contextStr = args['context'] as string | undefined;
        const now = nowMs();
        const objId = generateId();

        const created = this.runtime.objects.create({
          repositoryId,
          ...(capsuleId !== undefined ? { capsuleId } : {}),
          type: 'QUESTION',
          scope: 'capsule',
          visibility: 'repository',
          status: 'active',
          authority: 'agent_explicit',
          provenance: { sourceEventIds: [`gen-${objId}`] },
          validFrom: now,
          content: {
            kind: 'question',
            question,
            ...(contextStr !== undefined ? { context: contextStr } : {}),
          } as any,
        }, objId);

        resultText = `Question recorded [${created.id}]: "${question}"`;
        break;
      }

      case 'context.conflicts': {
        const repositoryId = args['repositoryId'] as string;
        const resource = args['resource'] as string | undefined;
        const now = nowMs();

        // Expire stale leases
        for (const [key, lease] of this.leases.entries()) {
          if (lease.expiresAt < now) {
            this.leases.delete(key);
          }
        }

        const activeLeases = Array.from(this.leases.values()).filter(
          (l) => resource === undefined || l.resource === resource,
        );

        resultText = JSON.stringify({
          repositoryId,
          activeConflicts: [],
          activeLeases,
        }, null, 2);
        break;
      }

      case 'context.lease': {
        const action = args['action'] as 'acquire' | 'release' | 'check';
        const repositoryId = args['repositoryId'] as string;
        const resource = args['resource'] as string;
        const holderId = args['holderId'] as string;
        const ttlMs = (args['ttlMs'] as number | undefined) ?? 60_000;
        const leaseKey = `${repositoryId}:${resource}`;
        const now = nowMs();

        const existing = this.leases.get(leaseKey);
        if (existing && existing.expiresAt < now) {
          this.leases.delete(leaseKey);
        }

        if (action === 'acquire') {
          const current = this.leases.get(leaseKey);
          if (current && current.holderId !== holderId) {
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: `CONFLICT: Resource '${resource}' is already leased to '${current.holderId}' until ${new Date(current.expiresAt).toISOString()}`,
                  },
                ],
                isError: true,
              },
            };
          }

          const expiresAt = now + ttlMs;
          this.leases.set(leaseKey, { resource, holderId, expiresAt });
          resultText = `Lease acquired on '${resource}' by '${holderId}' (expires in ${ttlMs / 1000}s)`;
        } else if (action === 'release') {
          const current = this.leases.get(leaseKey);
          if (current && current.holderId === holderId) {
            this.leases.delete(leaseKey);
            resultText = `Lease on '${resource}' released by '${holderId}'`;
          } else {
            resultText = `No active lease held on '${resource}' by '${holderId}'`;
          }
        } else {
          // check
          const current = this.leases.get(leaseKey);
          resultText = current
            ? `Active lease on '${resource}' held by '${current.holderId}' (expires in ${(current.expiresAt - now) / 1000}s)`
            : `Resource '${resource}' is currently free`;
        }
        break;
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Tool not found: ${toolName}` },
        };
    }

    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text: resultText,
          },
        ],
      },
    };
  }
}
