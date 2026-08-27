import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { DebatidorApiClient, DebatidorApiError, type LeadStatus } from './debatidor-api.js';

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

export function createDebatidorServer(api: DebatidorApiClient): McpServer {
  const server = new McpServer({
    name: 'debatidor',
    version: '0.1.0',
  });

  server.registerTool(
    'debatidor_get_lead_status',
    {
      title: 'Get Debatidor Lead status',
      description:
        'Read the current status of Debatidor LEAD-mode arenas in the authenticated workspace. Optionally inspect one LEAD debate by id. Use this before asking the Lead to continue or when the user asks what Debatidor is doing.',
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

  return server;
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
      return 'Debatidor rejected the configured credentials. Reconnect or replace the API key used by the MCP bridge.';
    }
    if (error.code === 'lead_debate_not_found') {
      return 'That LEAD debate is not available in the authenticated Debatidor workspace.';
    }
    return `Debatidor API request failed (${error.status}).`;
  }
  return 'Debatidor MCP could not read Lead status.';
}
