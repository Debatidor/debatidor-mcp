import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
  DebatidorApiClient,
  DebatidorApiError,
  type RelayTicket,
} from './debatidor-api.js';

const SHA_RE = /^[a-f0-9]{64}$/;
const MAX_TICKET_BYTES = 512 * 1024 * 1024;

const pathField = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .describe('Relative destination path inside the connected debatidor-agent project root.');

const optionalId = z.string().trim().min(1).max(200).optional();

const inputSchema = z.object({
  path: pathField,
  agentId: optionalId.describe(
    'Optional debatidor-agent id. Omit to use the first connected agent for this user/workspace.',
  ),
  connectionId: optionalId.describe(
    'Optional linked browser host id, for example conn_dom_openai or conn_dom_claude. Omit to let any linked Debatidor tab for this account act.',
  ),
  debateId: optionalId.describe(
    'Optional Debatidor arena id. When present, only an extension socket bound to the same arena can receive the request.',
  ),
  expectedBytes: z
    .number()
    .int()
    .positive()
    .max(MAX_TICKET_BYTES)
    .optional()
    .describe('Exact size of the source asset when known. The relay rejects a different byte count.'),
  expectedSha256: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SHA_RE)
    .optional()
    .describe('Expected SHA-256 of the source asset when known, for end-to-end integrity matching.'),
  mimeType: z
    .string()
    .trim()
    .min(3)
    .max(200)
    .optional()
    .describe('Optional MIME type such as image/png or video/mp4.'),
  ttlSeconds: z
    .number()
    .int()
    .min(60)
    .max(3600)
    .optional()
    .describe('Lifetime of the internal save request in seconds (default 900, max 3600).'),
});

const dispatchSchema = z.object({
  delivered: z.boolean(),
  reason: z.string().optional(),
  at: z.string().optional(),
});

const outputSchema = z.object({
  ticketId: z.string(),
  status: z.string(),
  agentId: z.string().nullable(),
  path: z.string(),
  fileName: z.string(),
  expiresAt: z.string(),
  maxBytes: z.number().int().nonnegative(),
  expectedBytes: z.number().int().nonnegative().optional(),
  expectedSha256: z.string().optional(),
  mimeType: z.string().optional(),
  connectionId: z.string().optional(),
  debateId: z.string().optional(),
  dispatch: dispatchSchema.optional(),
});

type ExtensionSaveInput = z.infer<typeof inputSchema>;
type ExtensionSaveOutput = z.infer<typeof outputSchema>;

/**
 * Narrow browser-extension rail for web chats.
 *
 * Unlike debatidor_asset_ticket, this tool cannot expose a relay URL, cannot
 * create download tickets and cannot target arbitrary external services. The
 * MCP call carries metadata only; the same-account Debatidor extension receives
 * the one-time upload URL over its authenticated WebSocket and performs the
 * browser-side transfer.
 */
export function registerExtensionAssetTools(
  server: McpServer,
  api: DebatidorApiClient,
): void {
  server.registerTool(
    'debatidor_extension_save_asset',
    {
      title: 'Save a web-chat asset through the linked Debatidor extension',
      description:
        'Use when the user explicitly asks to persist an image, video or file that is already generated or attached in the current web chat. This is a metadata-only coordination call: it does NOT send file bytes, browser URLs, cookies or chat content through MCP, and it never returns a relay URL. Debatidor sends a same-account internal save request to the already-linked browser extension, which reads the visible asset in that tab and stores it in the user\'s connected agent project. Include expectedBytes and expectedSha256 when known so the extension/relay can match and verify the exact original. The destination path may be created or replaced.',
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        // This action is confined to the user's linked Debatidor extension +
        // connected agent. It does not expose or contact arbitrary third-party
        // endpoints from the MCP call itself.
        openWorldHint: false,
      },
    },
    async (input: ExtensionSaveInput) => {
      try {
        const ticket = await api.createAssetTicket({
          direction: 'upload',
          uploader: 'extension',
          path: input.path,
          agentId: input.agentId,
          connectionId: input.connectionId,
          debateId: input.debateId,
          expectedBytes: input.expectedBytes,
          expectedSha256: input.expectedSha256,
          mimeType: input.mimeType,
          ttlSeconds: input.ttlSeconds,
        });
        const safe = compact(ticket);
        const delivered = safe.dispatch?.delivered === true;
        const text = delivered
          ? `Save request ${safe.ticketId} was delivered to the linked Debatidor extension for ${safe.fileName}. Call debatidor_asset_ticket_status with this ticketId and waitSeconds=60 to verify completion.`
          : `Save request ${safe.ticketId} was created but not delivered to a linked extension${safe.dispatch?.reason ? ` (${safe.dispatch.reason})` : ''}. Keep the target web-chat tab open, enable Debatidor for that tab, then create a new save request.`;
        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: safe,
          ...(!delivered ? { isError: true } : {}),
        };
      } catch (error) {
        return safeError(error);
      }
    },
  );
}

function compact(ticket: RelayTicket): ExtensionSaveOutput {
  return {
    ticketId: ticket.ticketId,
    status: ticket.status,
    agentId: ticket.agentId ?? null,
    path: ticket.path,
    fileName: basename(ticket.path),
    expiresAt: ticket.expiresAt,
    maxBytes: ticket.maxBytes,
    expectedBytes: ticket.expectedBytes,
    expectedSha256: ticket.expectedSha256,
    mimeType: ticket.mimeType,
    connectionId: ticket.connectionId,
    debateId: ticket.debateId,
    dispatch: ticket.dispatch,
  };
}

function basename(value: string): string {
  const normalized = String(value ?? '').replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || 'asset.bin';
}

function safeError(error: unknown) {
  if (error instanceof DebatidorApiError) {
    if (error.status === 401 || error.status === 403) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'The Debatidor account link is no longer authorized. Reconnect the MCP app.',
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: `Debatidor could not create the extension save request (${error.code ?? error.status}).`,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: 'Debatidor could not create the extension save request.',
      },
    ],
    isError: true,
  };
}
