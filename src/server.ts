import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
  DebatidorApiClient,
  DebatidorApiError,
  type ContextHit,
  type IndexDebateContextResult,
  type LeadStatus,
} from './debatidor-api.js';

export const SERVER_VERSION = '0.5.0';
export const PROTOCOL_VERSION = '2026-07-28';

export type DebatidorServerOptions = {
  api?: DebatidorApiClient;
  publicBaseUrl: string;
};

const participantSchema = z.object({
  id: z.string().optional(),
  connectionId: z.string().optional(),
  role: z.string().optional(),
  status: z.string().optional(),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
});

const debateSchema = z.object({
  id: z.string(),
  title: z.string(),
  mode: z.string(),
  status: z.string(),
  currentRound: z.number().optional(),
  roundsLimit: z.number().optional(),
  updatedAt: z.string().optional(),
});

const leadStatusSchema = z.object({
  scope: z.enum(['workspace', 'debate']),
  activeCount: z.number().int().nonnegative(),
  debates: z.array(debateSchema),
  participants: z.array(participantSchema).optional(),
});

const contextHitSchema = z.object({
  id: z.string(),
  debateId: z.string().nullable(),
  kind: z.enum(['MESSAGE', 'CONCLUSION']),
  content: z.string(),
  similarity: z.number(),
  createdAt: z.string().optional(),
});

const contextSearchSchema = z.object({
  query: z.string(),
  hitCount: z.number().int().nonnegative(),
  hits: z.array(contextHitSchema),
});

const contextIndexSchema = z.object({
  debateId: z.string(),
  scanned: z.number().int().nonnegative(),
  indexed: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  empty: z.number().int().nonnegative(),
  cappedAt: z.number().int().positive(),
});

const pingSchema = z.object({
  ok: z.literal(true),
  service: z.literal('debatidor-mcp'),
  version: z.string(),
  protocol: z.string(),
  endpoint: z.string(),
  authenticatedToolsEnabled: z.boolean(),
});

export function createDebatidorServer(options: DebatidorServerOptions): McpServer {
  const server = new McpServer({
    name: 'debatidor',
    version: SERVER_VERSION,
  });

  server.registerTool(
    'debatidor_ping',
    {
      title: 'Check Debatidor MCP',
      description:
        'Check that the official Debatidor MCP server is reachable and report its protocol/version.',
      inputSchema: z.object({}),
      outputSchema: pingSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const status = {
        ok: true as const,
        service: 'debatidor-mcp' as const,
        version: SERVER_VERSION,
        protocol: PROTOCOL_VERSION,
        endpoint: `${options.publicBaseUrl}/mcp`,
        authenticatedToolsEnabled: Boolean(options.api),
      };
      return {
        content: [
          {
            type: 'text',
            text: `Debatidor MCP ${SERVER_VERSION} is online (${PROTOCOL_VERSION}). Authenticated tools: ${status.authenticatedToolsEnabled ? 'enabled' : 'not enabled'}.`,
          },
        ],
        structuredContent: status,
      };
    },
  );

  if (options.api) {
    registerLeadStatusTool(server, options.api);
    registerSearchContextTool(server, options.api);
    registerIndexContextTool(server, options.api);
  }

  return server;
}

function registerLeadStatusTool(server: McpServer, api: DebatidorApiClient) {
  server.registerTool(
    'debatidor_get_lead_status',
    {
      title: 'Get Debatidor Lead status',
      description:
        'Read the current status of Debatidor LEAD-mode arenas in the authenticated workspace. Optionally inspect one LEAD debate by id.',
      inputSchema: z.object({
        debateId: z
          .string()
          .min(1)
          .optional()
          .describe('Optional Debatidor debate id. Omit it to summarize all LEAD-mode arenas in the workspace.'),
      }),
      outputSchema: leadStatusSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ debateId }) => {
      try {
        const status = await api.getLeadStatus(debateId);
        return {
          content: [{ type: 'text', text: formatLeadStatus(status) }],
          structuredContent: status,
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: formatSafeError(error) }],
          isError: true,
        };
      }
    },
  );
}

function registerSearchContextTool(server: McpServer, api: DebatidorApiClient) {
  server.registerTool(
    'debatidor_search_context',
    {
      title: 'Search Debatidor context',
      description:
        'Semantically search long-term MESSAGE and CONCLUSION memories in the authenticated Debatidor workspace. Optionally scope the search to one debate. This is read-only and never searches another workspace.',
      inputSchema: z.object({
        query: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .describe('Natural-language semantic query to search in Debatidor long-term memory.'),
        debateId: z
          .string()
          .min(1)
          .optional()
          .describe('Optional debate id to restrict results to one arena.'),
        kinds: z
          .array(z.enum(['MESSAGE', 'CONCLUSION']))
          .max(2)
          .optional()
          .describe('Optional memory kinds. Omit to search both messages and conclusions.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('Maximum number of semantic matches. Defaults to the backend limit.'),
      }),
      outputSchema: contextSearchSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, debateId, kinds, limit }) => {
      try {
        const hits = await api.searchContext({ query, debateId, kinds, limit });
        const result = { query, hitCount: hits.length, hits };
        return {
          content: [{ type: 'text', text: formatContextSearch(query, hits) }],
          structuredContent: result,
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: formatSafeError(error) }],
          isError: true,
        };
      }
    },
  );
}

function registerIndexContextTool(server: McpServer, api: DebatidorApiClient) {
  server.registerTool(
    'debatidor_index_context',
    {
      title: 'Index Debatidor debate context',
      description:
        'Materialize persisted messages from one authenticated Debatidor arena into semantic long-term memory. This writes derived memory rows and uses the user OpenAI BYOK for embeddings, so it can incur provider usage. Re-running unchanged messages is idempotent and does not re-embed them.',
      inputSchema: z.object({
        debateId: z
          .string()
          .trim()
          .min(1)
          .describe('Debatidor debate id to index. The debate must belong to the authenticated workspace.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Maximum persisted messages to scan in this indexing pass. Defaults to 50.'),
      }),
      outputSchema: contextIndexSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ debateId, limit }) => {
      try {
        const result = await api.indexDebateContext({ debateId, limit });
        return {
          content: [{ type: 'text', text: formatContextIndex(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: formatSafeError(error) }],
          isError: true,
        };
      }
    },
  );
}

function formatLeadStatus(status: LeadStatus): string {
  if (status.debates.length === 0) {
    return 'No LEAD-mode arenas are currently visible in this Debatidor workspace.';
  }

  const lines = status.debates.map((debate) => {
    const round =
      debate.currentRound !== undefined && debate.roundsLimit !== undefined
        ? ` · round ${debate.currentRound}/${debate.roundsLimit}`
        : '';
    return `- ${debate.title} (${debate.id}): ${debate.status}${round}`;
  });

  if (status.scope === 'debate' && status.participants) {
    lines.push('', `Participants: ${status.participants.length}`);
    for (const participant of status.participants) {
      const label = participant.role || participant.modelId || participant.connectionId || participant.id || 'participant';
      lines.push(`- ${label}: ${participant.status ?? 'unknown'}`);
    }
  }

  return [`Active LEAD arenas: ${status.activeCount}`, ...lines].join('\n');
}

function formatContextSearch(query: string, hits: ContextHit[]): string {
  if (hits.length === 0) {
    return `No long-term Debatidor context matched: ${query}`;
  }

  const lines = hits.map((hit) => {
    const debate = hit.debateId ? ` · debate ${hit.debateId}` : '';
    return `- [${hit.kind}] similarity ${hit.similarity.toFixed(3)}${debate}\n  ${hit.content}`;
  });
  return [`Semantic context matches: ${hits.length}`, ...lines].join('\n');
}

function formatContextIndex(result: IndexDebateContextResult): string {
  return [
    `Debatidor context indexing completed for ${result.debateId}.`,
    `Scanned: ${result.scanned}`,
    `New or changed memories indexed: ${result.indexed}`,
    `Unchanged memories skipped: ${result.unchanged}`,
    `Empty messages skipped: ${result.empty}`,
  ].join('\n');
}

function formatSafeError(error: unknown): string {
  if (error instanceof DebatidorApiError) {
    if (error.status === 401 || error.status === 403) {
      return 'The Debatidor account link is no longer authorized. Reconnect the MCP app.';
    }
    if (error.code === 'lead_debate_not_found') {
      return 'That LEAD debate is not available in the authenticated Debatidor workspace.';
    }
    if (error.code === 'vector_memory_debate_not_found') {
      return 'That debate is not available in the authenticated Debatidor workspace.';
    }
    if (error.code === 'provider_key_not_configured' || error.code === 'embeddings_key_required') {
      return 'Semantic memory needs an OpenAI provider key configured in Debatidor Integrations so the backend can generate embeddings.';
    }
    if (error.code === 'vector_memory_query_required') {
      return 'A non-empty semantic search query is required.';
    }
    return `Debatidor API request failed (${error.status}).`;
  }
  return 'Debatidor MCP could not complete the request.';
}
