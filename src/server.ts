import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
  DebatidorApiClient,
  DebatidorApiError,
  type AgentExecutionResult,
  type ContextHit,
  type IndexDebateContextResult,
  type LeadStatus,
  type QuickDebateResult,
} from './debatidor-api.js';

export const SERVER_VERSION = '0.7.2';
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
        return safeToolError(error);
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
        return safeToolError(error);
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
    if (error.code === 'vector_memory_debate_not_found') {
      return 'That debate is not available in the authenticated Debatidor workspace.';
    }
    if (error.code === 'provider_key_not_configured' || error.code === 'embeddings_key_required') {
      return 'Semantic memory needs an OpenAI provider key configured in Debatidor Integrations so the backend can generate embeddings.';
    }
    if (error.code === 'vector_memory_query_required') {
      return 'A non-empty semantic search query is required.';
    }
    if (error.code?.startsWith('agent_')) {
      return `Debatidor agent request was rejected: ${error.code}.`;
    }
    return `Debatidor API request failed (${error.status}).`;
  }
  return 'Debatidor MCP could not complete the request.';
}
