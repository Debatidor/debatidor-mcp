import {
  canonicalContextSearchSchema,
  contextIndexSchema,
  type ContextKind,
  type ContextSearchResult,
  type IndexDebateContextResult,
} from './context-contracts.js';
import type * as z from 'zod/v4';
import {
  contextIdSchema, contextItemSchema, contextSourcesSchema,
  contextExportSchema, contextExportPageSchema, contextExportDeletedSchema,
  contextItemDeletedSchema, contextDeletionSchema, contextGovernanceSchema,
  type ContextSourcesInput, type CreateContextExportInput,
  type ReadContextExportInput, type DeleteContextSourcesInput,
} from './context-governance-contracts.js';
export type { ContextKind, ContextHit, ContextSearchResult, IndexDebateContextResult } from './context-contracts.js';

export type DebateSummary = {
  id: string;
  title: string;
  mode: string;
  status: string;
  currentRound?: number;
  roundsLimit?: number;
  updatedAt?: string;
};

export type ParticipantSummary = {
  id?: string;
  connectionId?: string;
  role?: string;
  status?: string;
  providerId?: string;
  modelId?: string;
};

export type LeadStatus = {
  scope: 'workspace' | 'debate';
  activeCount: number;
  debates: DebateSummary[];
  participants?: ParticipantSummary[];
};

export type SearchContextInput = {
  query: string;
  debateId?: string;
  kinds?: ContextKind[];
  limit?: number;
};

export type IndexDebateContextInput = {
  debateId: string;
  limit?: number;
};

export type QuickDebateInput = {
  debateId: string;
  prompt: string;
  mode?: 'web' | 'api' | 'both';
  connectionId?: string;
};

export type QuickDebateResult = {
  accepted: boolean;
  debateId: string;
  mode: 'web' | 'api' | 'both';
  apiParticipants: number;
  browserParticipants: number;
  connectionId: string | null;
};

export type AgentTool = 'fs.list' | 'fs.read' | 'fs.write' | 'shell.run';

export type AgentExecutionInput = {
  agentId?: string;
  tool: AgentTool;
  path?: string;
  content?: string;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
};

export type AgentExecutionResult = {
  tool: AgentTool;
  agentId: string | null;
  ok?: boolean;
  path?: string;
  bytes?: number;
  content?: string;
  entries?: string[];
  error?: string;
  output?: string;
  exitCode?: number | null;
};

export type DebatidorApiAuth =
  | { type: 'api-key'; token: string }
  | { type: 'bearer'; token: string };

export class DebatidorApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'DebatidorApiError';
  }
}

export class DebatidorApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly auth: DebatidorApiAuth,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async validateAccessToken(): Promise<void> {
    await this.request('/auth/me');
  }

  async getLeadStatus(debateId?: string): Promise<LeadStatus> {
    const debates = await this.listDebates();
    const leadDebates = debates.filter((debate) => debate.mode === 'LEAD');

    if (!debateId) {
      return {
        scope: 'workspace',
        activeCount: leadDebates.filter((debate) => isActive(debate.status)).length,
        debates: leadDebates.map(compactDebate),
      };
    }

    const selected = leadDebates.find((debate) => debate.id === debateId);
    if (!selected) {
      throw new DebatidorApiError('lead_debate_not_found', 404, 'lead_debate_not_found');
    }

    const snapshot = await this.request<{
      found?: boolean;
      debate?: DebateSummary;
      participants?: ParticipantSummary[];
    }>(`/realtime/debates/${encodeURIComponent(debateId)}/snapshot`);

    if (!snapshot.found || !snapshot.debate) {
      throw new DebatidorApiError('lead_debate_not_found', 404, 'lead_debate_not_found');
    }

    return {
      scope: 'debate',
      activeCount: isActive(snapshot.debate.status) ? 1 : 0,
      debates: [compactDebate(snapshot.debate)],
      participants: (snapshot.participants ?? []).map(compactParticipant),
    };
  }

  async searchContext(input: SearchContextInput): Promise<ContextSearchResult> {
    const result = await this.request<unknown>('/context/search', {
      method: 'POST',
      body: {
        query: input.query,
        debateId: input.debateId,
        // Preserve the original MCP scope even though Context Service supports
        // more kinds by default. New kinds must be requested explicitly.
        kinds: input.kinds?.length ? input.kinds : ['MESSAGE', 'CONCLUSION'],
        limit: input.limit,
      },
    });
    const parsed = canonicalContextSearchSchema.safeParse(result);
    if (!parsed.success || (input.debateId && parsed.data.hits.some((hit) => hit.debateId !== input.debateId))) {
      throw new DebatidorApiError('debatidor_context_response_invalid', 502, 'context_response_invalid');
    }
    return {
      hits: parsed.data.hits.map((hit) => ({ ...hit, similarity: hit.semanticSimilarity ?? 0, retrievalMethod: parsed.data.retrieval.method })),
      retrieval: parsed.data.retrieval,
      partial: parsed.data.partial,
    };
  }

  async indexDebateContext(
    input: IndexDebateContextInput,
  ): Promise<IndexDebateContextResult> {
    const result = await this.request<unknown>('/context/index-debate', {
      method: 'POST',
      body: {
        debateId: input.debateId,
        limit: input.limit,
      },
    });
    const parsed = contextIndexSchema.safeParse(result);
    if (!parsed.success || parsed.data.debateId !== input.debateId) {
      throw new DebatidorApiError('debatidor_context_response_invalid', 502, 'context_response_invalid');
    }
    return parsed.data;
  }

  async quickDebate(input: QuickDebateInput): Promise<QuickDebateResult> {
    return this.request<QuickDebateResult>(
      `/realtime/debates/${encodeURIComponent(input.debateId)}/quick`,
      {
        method: 'POST',
        body: {
          prompt: input.prompt,
          mode: input.mode,
          connectionId: input.connectionId,
        },
      },
    );
  }

  async getContextItem(itemId: string) {
    const id = contextIdSchema.parse(itemId);
    const result = parseContext(contextItemSchema, await this.request(`/context/items/${encodeURIComponent(id)}`, { expectedStatus: 200 }));
    if (result.id !== id) throw invalidContextResponse();
    return result;
  }

  async listContextSources(input: ContextSourcesInput = {}) {
    const query = new URLSearchParams({ scope: input.scope ?? 'user' });
    if (input.cursor !== undefined) query.set('cursor', input.cursor);
    if (input.limit !== undefined) query.set('limit', String(input.limit));
    const result = parseContext(contextSourcesSchema, await this.request(`/context/sources?${query}`, { expectedStatus: 200 }));
    const visibility = (input.scope ?? 'user') === 'user' ? 'PRIVATE' : 'WORKSPACE';
    if (result.sources.length > (input.limit ?? 50) || result.sources.some(source => source.visibility !== visibility) ||
        (result.nextCursor !== null && result.nextCursor === input.cursor)) throw invalidContextResponse();
    return result;
  }

  async createContextExport(input: CreateContextExportInput) {
    const result = parseContext(contextExportSchema, await this.request('/context/exports', { method: 'POST', body: input, expectedStatus: 201 }));
    if (result.scope.type !== input.scope.type || result.format !== input.format) throw invalidContextResponse();
    return result;
  }

  async readContextExport(input: ReadContextExportInput) {
    const id = contextIdSchema.parse(input.exportId);
    const query = input.cursor === undefined ? '' : `?${new URLSearchParams({ cursor: input.cursor })}`;
    const result = parseContext(contextExportPageSchema, await this.request(`/context/exports/${encodeURIComponent(id)}${query}`, { expectedStatus: 200 }));
    const offset = input.cursor === undefined ? 0 : Number(input.cursor);
    const expectedLength = Math.min(100, result.itemCount - offset);
    const expectedNext = offset + result.entries.length < result.itemCount ? String(offset + result.entries.length) : null;
    if (result.id !== id || !Number.isSafeInteger(offset) || offset < 0 || offset % 100 !== 0 ||
        offset >= Math.max(1, result.itemCount) || result.entries.length !== expectedLength || result.nextCursor !== expectedNext) {
      throw invalidContextResponse();
    }
    return result;
  }

  async deleteContextExport(exportId: string) {
    const id = contextIdSchema.parse(exportId);
    return parseContext(contextExportDeletedSchema, await this.request(`/context/exports/${encodeURIComponent(id)}`, { method: 'DELETE', expectedStatus: 200 }));
  }

  async deleteContextItem(itemId: string) {
    const id = contextIdSchema.parse(itemId);
    const response = await this.requestWithStatus(`/context/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const result = parseContext(contextItemDeletedSchema, response.data);
    if ((result.deleted && response.status !== 200) || (!result.deleted && response.status !== 202)) throw invalidContextResponse();
    return result;
  }

  async getContextDeletion(operationId: string) {
    const id = contextIdSchema.parse(operationId);
    const result = parseContext(contextDeletionSchema, await this.request(`/context/deletions/${encodeURIComponent(id)}`, { expectedStatus: 200 }));
    if (result.id !== id) throw invalidContextResponse();
    return result;
  }

  async deleteContextSources(input: DeleteContextSourcesInput) {
    const result = parseContext(contextDeletionSchema, await this.request('/context/deletions', { method: 'POST', body: input, expectedStatus: 201 }));
    if (result.scope.type !== input.scope.type || result.sourceIds.length !== new Set(input.sourceIds).size ||
        result.sourceIds.some(id => !input.sourceIds.includes(id))) throw invalidContextResponse();
    return result;
  }

  async getContextGovernance() {
    return parseContext(contextGovernanceSchema, await this.request('/context/governance', { expectedStatus: 200 }));
  }

  async executeAgent(input: AgentExecutionInput): Promise<AgentExecutionResult> {
    return this.request<AgentExecutionResult>('/agent-execution/execute', {
      method: 'POST',
      body: input,
    });
  }

  async listDebates(): Promise<DebateSummary[]> {
    const result = await this.request<unknown>('/realtime/debates');
    return Array.isArray(result) ? (result as DebateSummary[]) : [];
  }

  private async request<T = unknown>(
    path: string,
    options: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; expectedStatus?: number } = {},
  ): Promise<T> {
    return (await this.requestWithStatus<T>(path, options)).data;
  }

  private async requestWithStatus<T = unknown>(
    path: string,
    options: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; expectedStatus?: number } = {},
  ): Promise<{ data: T; status: number }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.auth.type === 'api-key') headers['x-api-key'] = this.auth.token;
    else headers.authorization = `Bearer ${this.auth.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (!response.ok) {
      let code: string | undefined;
      try {
        const body = (await response.json()) as {
          code?: unknown;
          message?: unknown;
        };
        if (typeof body.code === 'string') code = body.code;
        else if (typeof body.message === 'string') code = body.message;
        else if (
          body.message &&
          typeof body.message === 'object' &&
          'code' in body.message &&
          typeof (body.message as { code?: unknown }).code === 'string'
        ) {
          code = (body.message as { code: string }).code;
        }
      } catch {
        // Keep upstream error bodies out of MCP output by default.
      }
      throw new DebatidorApiError(
        response.status === 401 || response.status === 403
          ? 'debatidor_authentication_failed'
          : 'debatidor_upstream_error',
        response.status,
        code,
      );
    }

    if (options.expectedStatus !== undefined && response.status !== options.expectedStatus) throw invalidContextResponse();

    try {
      return { data: (await response.json()) as T, status: response.status };
    } catch {
      throw new DebatidorApiError('debatidor_upstream_response_invalid', 502, 'upstream_response_invalid');
    }
  }
}

function invalidContextResponse() {
  return new DebatidorApiError('debatidor_context_response_invalid', 502, 'context_response_invalid');
}

function parseContext<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw invalidContextResponse();
  return result.data;
}

function compactDebate(debate: DebateSummary): DebateSummary {
  return {
    id: String(debate.id),
    title: String(debate.title ?? ''),
    mode: String(debate.mode ?? ''),
    status: String(debate.status ?? ''),
    currentRound: Number.isFinite(Number(debate.currentRound)) ? Number(debate.currentRound) : undefined,
    roundsLimit: Number.isFinite(Number(debate.roundsLimit)) ? Number(debate.roundsLimit) : undefined,
    updatedAt: debate.updatedAt ? String(debate.updatedAt) : undefined,
  };
}

function compactParticipant(participant: ParticipantSummary): ParticipantSummary {
  return {
    id: participant.id ? String(participant.id) : undefined,
    connectionId: participant.connectionId ? String(participant.connectionId) : undefined,
    role: participant.role ? String(participant.role) : undefined,
    status: participant.status ? String(participant.status) : undefined,
    providerId: participant.providerId ? String(participant.providerId) : undefined,
    modelId: participant.modelId ? String(participant.modelId) : undefined,
  };
}

function isActive(status: string): boolean {
  return status === 'READY' || status === 'RUNNING' || status === 'PAUSED' || status === 'BLOCKED';
}
