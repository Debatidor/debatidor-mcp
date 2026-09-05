import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
  DebatidorApiClient,
  DebatidorApiError,
  type AgentExecutionResult,
  type ContextSearchResult,
  type IndexDebateContextResult,
  type LeadStatus,
  type QuickDebateResult,
} from './debatidor-api.js';
import { contextSearchSchema, contextIndexSchema, contextKindSchema } from './context-contracts.js';
import { registerContextGovernanceTools } from './context-governance-tools.js';

export const SERVER_VERSION = '0.7.5';
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

const quickDebateSchema = z.object({
  accepted: z.boolean(),
  debateId: z.string(),
  mode: z.enum(['web', 'api', 'both']),
  apiParticipants: z.number().int().nonnegative(),
  browserParticipants: z.number().int().nonnegative(),
  connectionId: z.string().nullable(),
});

const agentResultSchema = z.object({
  tool: z.enum(['fs.list', 'fs.read', 'fs.write', 'shell.run']),
  agentId: z.string().nullable(),
  ok: z.boolean().optional(),
  path: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  content: z.string().optional(),
  entries: z.array(z.string()).optional(),
  error: z.string().optional(),
  output: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  truncated: z.boolean().optional(),
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
    registerContextGovernanceTools(server, options.api, safeContextError);
    registerQuickDebateTool(server, options.api);
    registerAgentTools(server, options.api);
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
        return safeToolError(error);
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
        'Search context stored by Debatidor in the authenticated workspace. Defaults to MESSAGE and CONCLUSION for compatibility; explicitly request FACT, DECISION or SUMMARY to include those kinds. Optionally scope results to one debate. Results identify text or hybrid retrieval, relevance score, semantic availability and source provenance. Semantic matches include an exact source excerpt with UTF-16 chunk positions. Text search remains available when semantic retrieval is warming, busy or unavailable. This is read-only; indexing is not a prerequisite.',
      inputSchema: z.object({
        query: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .describe('Query to search context stored by Debatidor.'),
        debateId: z
          .string()
          .min(1)
          .optional()
          .describe('Optional debate id to restrict results to one arena.'),
        kinds: z
          .array(contextKindSchema)
          .max(5)
          .optional()
          .describe('Optional memory kinds: MESSAGE, CONCLUSION, FACT, DECISION, SUMMARY. Omitted or empty uses MESSAGE and CONCLUSION; request newer kinds explicitly.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('Maximum number of context matches. Defaults to the backend limit.'),
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
        const context = await api.searchContext({ query, debateId, kinds, limit });
        const result = { query, hitCount: context.hits.length, ...context };
        return {
          content: [{ type: 'text', text: formatContextSearch(query, context) }],
          structuredContent: result,
        };
      } catch (error) {
        return safeContextError(error);
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
        'Explicit maintenance: materialize or refresh context from persisted messages in one authenticated Debatidor arena. Normal context search does not require this tool. This writes Debatidor-managed derived memory; unchanged sources are skipped idempotently.',
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
        openWorldHint: false,
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
        return safeContextError(error);
      }
    },
  );
}

function registerQuickDebateTool(server: McpServer, api: DebatidorApiClient) {
  server.registerTool(
    'debatidor_quick_debate',
    {
      title: 'Run a quick Debatidor turn',
      description:
        'Send one explicit intervention to an existing Debatidor arena. Browser replies are saved in its transcript; this tool does not enable filesystem or shell tools in browser chats. The arena and participants must already exist. Set connectionId to target one web participant; otherwise every configured web participant must be ready. Depending on mode this can invoke provider APIs and/or connected browser participants, so it may incur provider usage and is not idempotent.',
      inputSchema: z.object({
        debateId: z
          .string()
          .trim()
          .min(1)
          .describe('Existing Debatidor arena id in the authenticated workspace.'),
        prompt: z
          .string()
          .trim()
          .min(1)
          .max(12000)
          .describe('Intervention to persist and dispatch through the Arena runtime.'),
        mode: z
          .enum(['web', 'api', 'both'])
          .optional()
          .describe('Dispatch target. Defaults to both existing browser and API participants.'),
        connectionId: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Optional BROWSER_DOM connectionId to target one connected web participant.'),
      }),
      outputSchema: quickDebateSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ debateId, prompt, mode, connectionId }) => {
      try {
        const result = await api.quickDebate({ debateId, prompt, mode, connectionId });
        return {
          content: [{ type: 'text', text: formatQuickDebate(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return safeToolError(error);
      }
    },
  );
}

function registerAgentTools(server: McpServer, api: DebatidorApiClient) {
  const agentIdInput = z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Optional debatidor-agent id. Omit to use the first connected agent for this user/workspace.');

  server.registerTool(
    'debatidor_agent_list',
    {
      title: 'List files through debatidor-agent',
      description:
        'List a project directory through the authenticated user’s connected debatidor-agent. Paths are relative to the agent project root; no browser extension is involved.',
      inputSchema: z.object({
        path: z.string().max(1000).optional().describe('Relative directory path. Omit for project root.'),
        agentId: agentIdInput,
      }),
      outputSchema: agentResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, agentId }) => runAgentTool(api, {
      agentId,
      tool: 'fs.list',
      path: path ?? '',
    }),
  );

  server.registerTool(
    'debatidor_agent_read',
    {
      title: 'Read a file through debatidor-agent',
      description:
        'Read a project file through the authenticated user’s connected debatidor-agent. The path must stay inside the configured project root.',
      inputSchema: z.object({
        path: z.string().trim().min(1).max(1000),
        agentId: agentIdInput,
      }),
      outputSchema: agentResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, agentId }) => runAgentTool(api, {
      agentId,
      tool: 'fs.read',
      path,
    }),
  );

  server.registerTool(
    'debatidor_agent_write',
    {
      title: 'Write a file through debatidor-agent',
      description:
        'Create or replace a project file through the authenticated user’s connected debatidor-agent. This changes the user’s local/remote project and should only be used when the requested edit is intended.',
      inputSchema: z.object({
        path: z.string().trim().min(1).max(1000),
        content: z.string().max(500000),
        agentId: agentIdInput,
      }),
      outputSchema: agentResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ path, content, agentId }) => runAgentTool(api, {
      agentId,
      tool: 'fs.write',
      path,
      content,
    }),
  );

  server.registerTool(
    'debatidor_agent_shell',
    {
      title: 'Run a shell command through debatidor-agent',
      description:
        'Run one non-interactive shell command in the connected debatidor-agent project. The runner denies shell execution unless the user explicitly started it with --shell-auto. Commands may modify the project or external systems.',
      inputSchema: z.object({
        command: z.string().trim().min(1).max(20000),
        cwd: z.string().max(1000).optional().describe('Optional relative working directory inside the project root.'),
        timeoutMs: z.number().int().min(1000).max(600000).optional(),
        agentId: agentIdInput,
      }),
      outputSchema: agentResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ command, cwd, timeoutMs, agentId }) => runAgentTool(api, {
      agentId,
      tool: 'shell.run',
      command,
      cwd: cwd ?? '',
      timeoutMs,
    }),
  );
}

async function runAgentTool(
  api: DebatidorApiClient,
  input: Parameters<DebatidorApiClient['executeAgent']>[0],
) {
  try {
    const raw = await api.executeAgent(input);
    const result = compactAgentResult(raw);
    return {
      content: [{ type: 'text' as const, text: formatAgentResult(result) }],
      structuredContent: result,
      ...(result.ok === false ? { isError: true } : {}),
    };
  } catch (error) {
    return safeToolError(error);
  }
}

function compactAgentResult(result: AgentExecutionResult): AgentExecutionResult & { truncated?: boolean } {
  const maxChars = 40_000;
  const maxEntries = 500;
  let truncated = false;
  let content = result.content;
  let output = result.output;
  let entries = result.entries;

  if (typeof content === 'string' && content.length > maxChars) {
    content = `${content.slice(0, maxChars)}\n…(truncated)`;
    truncated = true;
  }
  if (typeof output === 'string' && output.length > maxChars) {
    output = `${output.slice(0, maxChars)}\n…(truncated)`;
    truncated = true;
  }
  if (Array.isArray(entries) && entries.length > maxEntries) {
    entries = entries.slice(0, maxEntries);
    truncated = true;
  }

  return {
    tool: result.tool,
    agentId: result.agentId ?? null,
    ok: result.ok,
    path: result.path,
    bytes: result.bytes,
    content,
    entries,
    error: result.error,
    output,
    exitCode: result.exitCode,
    ...(truncated ? { truncated: true } : {}),
  };
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

function formatContextSearch(query: string, result: ContextSearchResult): string {
  const status = `Retrieval: ${result.retrieval.method}. Semantic retrieval: ${result.retrieval.semanticStatus}.`;
  const partial = result.partial ? 'Results are partial.' : '';
  if (result.hits.length === 0) {
    return [status, partial, `No Debatidor context matched: ${query}`].filter(Boolean).join('\n');
  }

  const lines = result.hits.map((hit) => {
    const debate = hit.debateId ? ` · debate ${hit.debateId}` : '';
    const chunk = hit.provenance.chunk;
    const citation = chunk ? `\n  Chunk: ${chunk.id} · ${chunk.chunkerVersion} · UTF-16 [${chunk.startUtf16}, ${chunk.endUtf16})` : '';
    const cosine = hit.semanticSimilarity !== null ? ` · cosine similarity ${hit.semanticSimilarity.toFixed(3)}` : '';
    return `- [${hit.kind}] ${result.retrieval.method} relevance score ${hit.score.toFixed(3)}${cosine}${debate}\n  Source: ${hit.sourceId} · revision ${hit.provenance.sourceRevision}${citation}\n  ${hit.content}`;
  });
  return [status, partial, `Context matches: ${result.hits.length}`, ...lines].filter(Boolean).join('\n');
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

function formatQuickDebate(result: QuickDebateResult): string {
  const target = result.connectionId ? ` · web target ${result.connectionId}` : '';
  return [
    `Quick debate accepted for ${result.debateId}.`,
    `Mode: ${result.mode}${target}`,
    `Configured participants: ${result.apiParticipants} API · ${result.browserParticipants} browser.`,
    'The Arena runtime is handling participant completions asynchronously.',
  ].join('\n');
}

function formatAgentResult(result: AgentExecutionResult & { truncated?: boolean }): string {
  if (result.ok === false) {
    const suffix = result.exitCode != null ? ` (exit ${result.exitCode})` : '';
    const output = result.output ? `\n${result.output}` : '';
    return `debatidor-agent ${result.tool} failed${suffix}: ${result.error ?? 'operation_failed'}${output}`;
  }
  if (result.tool === 'fs.list') {
    return [`Listed ${result.path || '.'} through debatidor-agent.`, ...(result.entries ?? [])].join('\n');
  }
  if (result.tool === 'fs.read') {
    return result.content ?? '';
  }
  if (result.tool === 'fs.write') {
    return `Wrote ${result.path ?? 'file'} (${result.bytes ?? 0} bytes) through debatidor-agent.`;
  }
  return `Shell completed${result.exitCode != null ? ` (exit ${result.exitCode})` : ''}.\n${result.output ?? ''}`;
}

function safeToolError(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: formatSafeError(error) }],
    isError: true,
  };
}

function safeContextError(error: unknown) {
  if (error instanceof DebatidorApiError) {
    const messages: Record<string, string> = {
      context_item_not_found: 'That memory item is unavailable in your authorized scope (missing, deleted, expired or inaccessible).',
      context_source_not_found: 'That memory source is unavailable in your authorized scope.',
      context_export_not_found: 'That export is unavailable to the authenticated account.',
      context_deletion_not_found: 'That deletion operation is unavailable to the authenticated account.',
      context_export_unavailable: 'The export is no longer available because it expired or its source access/content was removed. Do not combine earlier pages into a purported complete export.',
      context_export_quota: 'The active export snapshot limit was reached. Delete an existing export or wait for expiry before explicitly creating another.',
      context_export_too_large: 'The selected export exceeds the item or byte limit. Explicitly select fewer sources or kinds; no truncated export was returned.',
      context_workspace_owner_required: 'Only the current workspace owner can delete shared derived memory. Your account link may still be valid.',
      context_scope_invalid: 'Select an explicit user or workspace scope.',
      context_cursor_invalid: 'Use the nextCursor returned by the same source listing or export.',
      context_sources_invalid: 'Select between 1 and 100 valid memory source ids.',
      context_kind_invalid: 'Select valid memory kinds: MESSAGE, CONCLUSION, FACT, DECISION or SUMMARY.',
      context_export_format_invalid: 'Select json or markdown export format.',
      context_deletion_mode_invalid: 'Only explicit derived memory deletion is supported; original history is preserved.',
    };
    const text = error.code ? messages[error.code] : undefined;
    if (text) return { content: [{ type: 'text' as const, text }], isError: true };
  }
  if (error instanceof DebatidorApiError &&
      (error.code === 'provider_key_not_configured' || error.code === 'embeddings_key_required')) {
    return {
      content: [{ type: 'text' as const,
        text: 'The Debatidor memory backend is not ready. Memory is managed by Debatidor and does not require an external provider key.' }],
      isError: true,
    };
  }
  return safeToolError(error);
}

function formatSafeError(error: unknown): string {
  if (error instanceof DebatidorApiError) {
    if (error.status === 401 || error.status === 403) {
      return 'The Debatidor account link is no longer authorized. Reconnect the MCP app.';
    }
    if (error.code === 'lead_debate_not_found') {
      return 'That LEAD debate is not available in the authenticated Debatidor workspace.';
    }
    if (error.code === 'quick_debate_not_found') {
      return 'That arena is not available in the authenticated Debatidor workspace.';
    }
    if (error.code === 'quick_debate_prompt_required') {
      return 'A non-empty prompt is required to run a quick debate.';
    }
    if (error.code === 'quick_debate_browser_not_configured') {
      return 'Add the selected web participant to this Arena before running a web turn.';
    }
    if (error.code === 'quick_debate_browser_not_ready') {
      return 'The web participant is not ready. Set this Arena id in the Debatidor extension, enable injection for its tab, and wait until the participant is available.';
    }
    if (error.code === 'quick_debate_dispatch_failed') {
      return 'The turn could not be dispatched. Inspect the Arena and extension before trying again; do not automatically repeat the request.';
    }
    if (error.code === 'vector_memory_debate_not_found' || error.code === 'context_debate_not_found') {
      return 'That debate is not available in the authenticated Debatidor workspace.';
    }
    if (error.code === 'context_response_invalid' || error.code === 'upstream_response_invalid') {
      return 'Debatidor returned an invalid response. The request could not be completed; no result was inferred.';
    }
    if (error.code === 'vector_memory_query_required' || error.code === 'context_query_required') {
      return 'A non-empty context search query is required.';
    }
    if (error.code?.startsWith('agent_')) {
      return `Debatidor agent request was rejected: ${error.code}.`;
    }
    return `Debatidor API request failed (${error.status}).`;
  }
  return 'Debatidor MCP could not complete the request.';
}
