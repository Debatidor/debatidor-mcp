import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { DebatidorApiClient, DebatidorApiError, type LeadStatus } from './debatidor-api.js';

export const SERVER_VERSION = '0.3.0';
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

function formatSafeError(error: unknown): string {
  if (error instanceof DebatidorApiError) {
    if (error.status === 401 || error.status === 403) {
      return 'The Debatidor account link is no longer authorized. Reconnect the MCP app.';
    }
    if (error.code === 'lead_debate_not_found') {
      return 'That LEAD debate is not available in the authenticated Debatidor workspace.';
    }
    return `Debatidor API request failed (${error.status}).`;
  }
  return 'Debatidor MCP could not read Lead status.';
}
