import {
  canonicalContextSearchSchema,
  contextIndexSchema,
  type ContextKind,
  type ContextSearchResult,
  type IndexDebateContextResult,
} from './context-contracts.js';
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
    options: { method?: 'GET' | 'POST'; body?: unknown } = {},
  ): Promise<T> {
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

    try {
      return (await response.json()) as T;
    } catch {
      throw new DebatidorApiError('debatidor_upstream_response_invalid', 502, 'upstream_response_invalid');
    }
  }
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
