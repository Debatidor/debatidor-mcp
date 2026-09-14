import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
  DebatidorApiClient,
  DebatidorApiError,
  type RelayTicket,
} from './debatidor-api.js';

const SHA_RE = /^[a-f0-9]{64}$/;
const MAX_TICKET_BYTES = 512 * 1024 * 1024;

const destinationPathField = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .describe(
    'Relative DESTINATION path inside the connected debatidor-agent project root. This names the saved VPS file and is never used to identify the source image in the browser DOM.',
  );

const sourceStrategyField = z
  .enum(['previous-turn-image', 'wait-for-new-image'])
  .describe(
    'How the linked extension identifies the SOURCE image. previous-turn-image means the native ImageGen image in the assistant turn immediately before the user save request; wait-for-new-image means wait for the next native ImageGen image produced after the request.',
  );

const optionalId = z.string().trim().min(1).max(200).optional();

const inputSchema = z.object({
  destinationPath: destinationPathField,
  sourceStrategy: sourceStrategyField,
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
    .describe('Expected SHA-256 of the source asset when known, for end-to-end integrity verification.'),
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
  destinationPath: z.string(),
  sourceStrategy: sourceStrategyField,
  // Compatibility aliases retained for ticket-status clients during rollout.
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
 * Source identity and destination identity are deliberately separate. The
 * source is selected by sourceStrategy in the linked browser DOM; the path is
 * only the final agent-side filename. No browser URL or file bytes enter MCP.
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
        'Coordinate saving a native web-chat generated image without sending its bytes or browser URL through MCP. Set sourceStrategy=previous-turn-image when the user says to save THIS/already-generated image from the immediately previous assistant turn. Set sourceStrategy=wait-for-new-image when the same request asks ChatGPT to generate an image and then save it. destinationPath is only the final relative path in the connected agent project; it is never matched against the DOM. The extension resolves the native image, fetches its same-origin bytes, and uploads them over the Media Rail. Include expectedBytes/expectedSha256 only when reliably known.',
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input: ExtensionSaveInput) => {
      try {
        // `path` remains a rollout alias for older backends. New backends also
        // receive the explicit destinationPath/sourceStrategy pair. Because the
        // object is assigned first, TypeScript permits the additive fields while
        // DebatidorApiClient continues to transport the object verbatim.
        const ticketInput = {
          direction: 'upload' as const,
          uploader: 'extension' as const,
          path: input.destinationPath,
          destinationPath: input.destinationPath,
          sourceStrategy: input.sourceStrategy,
          agentId: input.agentId,
          connectionId: input.connectionId,
          debateId: input.debateId,
          expectedBytes: input.expectedBytes,
          expectedSha256: input.expectedSha256,
          mimeType: input.mimeType,
          ttlSeconds: input.ttlSeconds,
        };
        const ticket = await api.createAssetTicket(ticketInput);
        const safe = compact(ticket, input);
        const delivered = safe.dispatch?.delivered === true;
        const text = delivered
          ? `Save request ${safe.ticketId} was delivered to the linked Debatidor extension for ${safe.destinationPath} using ${safe.sourceStrategy}. Call debatidor_asset_ticket_status with this ticketId and waitSeconds=60 to verify completion.`
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

function compact(ticket: RelayTicket, input: ExtensionSaveInput): ExtensionSaveOutput {
  const destinationPath = input.destinationPath;
  return {
    ticketId: ticket.ticketId,
    status: ticket.status,
    agentId: ticket.agentId ?? null,
    destinationPath,
    sourceStrategy: input.sourceStrategy,
    path: ticket.path || destinationPath,
    fileName: basename(destinationPath),
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
