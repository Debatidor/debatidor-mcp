import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
  DebatidorApiClient,
  DebatidorApiError,
  type AgentExecutionInput,
  type AgentExecutionResult,
  type RelayTicket,
} from './debatidor-api.js';

/**
 * Media Rail — tools MCP para mover binarios sin pasar por el contexto del LLM.
 *
 * Jerarquia que el modelo debe seguir para ESCRIBIR media en el proyecto:
 *   1. debatidor_agent_put con URL HTTPS publica (el agente descarga directo).
 *   2. debatidor_asset_ticket (upload): URL temporal de un solo uso; los bytes
 *      viajan por HTTP crudo/multipart desde el sandbox, el navegador, curl o
 *      la extension, nunca por tool-calls.
 *   3. debatidor_asset_begin/chunk/commit: base64 por chunks, SOLO si el
 *      entorno no puede hacer HTTP saliente y el archivo es pequeno (< ~1 MiB).
 *
 * Para LEER media del proyecto:
 *   - debatidor_agent_get devuelve la imagen como bloque `image` (el modelo la
 *     ve) o un recurso embebido para otros tipos; metadataOnly para inspeccionar.
 *   - debatidor_asset_ticket (download) para archivos grandes o para entregar
 *     una URL de descarga a un humano/otro sistema.
 */

const SHA_RE = /^[a-f0-9]{64}$/;
const TICKET_RE = /^tkt_[a-f0-9]{24}$/;
const MAX_INLINE_BYTES = 32 * 1024 * 1024;
const MAX_TICKET_BYTES = 512 * 1024 * 1024;
const VIEWABLE_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const agentIdField = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .optional()
  .describe('Optional debatidor-agent id. Omit to use the first connected agent for this user/workspace.');

const pathField = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .describe('Relative path inside the connected agent project root.');

const getInputSchema = z.object({
  path: pathField,
  metadataOnly: z
    .boolean()
    .optional()
    .describe('Return only size, sha256, mimeType and image dimensions, without the bytes. Use it first for unknown or possibly large files.'),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(MAX_INLINE_BYTES)
    .optional()
    .describe('Inline size ceiling in bytes (default 8 MiB, hard max 32 MiB). Larger files must go through a download ticket.'),
  agentId: agentIdField,
});

const getResultSchema = z.object({
  tool: z.literal('fs.get'),
  agentId: z.string().nullable(),
  ok: z.boolean().optional(),
  path: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  sha256: z.string().regex(SHA_RE).optional(),
  mimeType: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  metadataOnly: z.boolean().optional(),
  inline: z.boolean(),
  error: z.string().optional(),
});

const ticketInputSchema = z.object({
  direction: z
    .enum(['upload', 'download'])
    .default('upload')
    .describe('upload: someone will PUT/POST bytes into the project path. download: someone will GET the project file.'),
  path: pathField,
  expectedBytes: z
    .number()
    .int()
    .positive()
    .max(MAX_TICKET_BYTES)
    .optional()
    .describe('Upload only. Exact size of the original file if known; the relay rejects mismatches.'),
  expectedSha256: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SHA_RE)
    .optional()
    .describe('Expected SHA-256 of the complete file for end-to-end integrity verification.'),
  mimeType: z
    .string()
    .trim()
    .min(3)
    .max(200)
    .optional()
    .describe('Optional MIME type recorded with the asset, for example image/png or video/mp4.'),
  ttlSeconds: z
    .number()
    .int()
    .min(60)
    .max(3600)
    .optional()
    .describe('Ticket lifetime in seconds (default 900, max 3600). The URL is single-use and dies after this.'),
  agentId: agentIdField,
});

const ticketResultSchema = z.object({
  ticketId: z.string(),
  direction: z.enum(['upload', 'download']),
  status: z.string(),
  agentId: z.string().nullable(),
  path: z.string(),
  url: z.string().optional(),
  methods: z.array(z.string()).optional(),
  expiresAt: z.string(),
  maxBytes: z.number().int().nonnegative(),
  expectedBytes: z.number().int().nonnegative().optional(),
  expectedSha256: z.string().optional(),
  mimeType: z.string().optional(),
  instructions: z.record(z.string(), z.string()).optional(),
  result: z
    .object({
      path: z.string().optional(),
      bytes: z.number().int().nonnegative().optional(),
      sha256: z.string().optional(),
      mimeType: z.string().optional(),
      sourceType: z.string().optional(),
    })
    .optional(),
  error: z.string().optional(),
});

const ticketStatusInputSchema = z.object({
  ticketId: z.string().trim().regex(TICKET_RE).describe('Ticket id returned by debatidor_asset_ticket (tkt_...).'),
});

type GetInput = z.infer<typeof getInputSchema>;
type TicketInput = z.infer<typeof ticketInputSchema>;

export function registerAgentMediaTools(server: McpServer, api: DebatidorApiClient): void {
  server.registerTool(
    'debatidor_agent_get',
    {
      title: 'Read a binary/media file through debatidor-agent',
      description:
        'Read a binary or media file from the connected agent project and return it as an MCP image block (png/jpeg/gif/webp are shown to the model) or as an embedded resource for other types (pdf, audio, video, archives). Bytes come straight from disk: never re-encoded. Use metadataOnly=true first when the file might be large; it returns bytes, sha256, mimeType and width/height for images without transferring content. Inline reads are capped (8 MiB default, 32 MiB max): for bigger files create a download ticket with debatidor_asset_ticket. For text files prefer debatidor_agent_read.',
      inputSchema: getInputSchema,
      outputSchema: getResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: GetInput) => {
      try {
        const raw = await api.executeAgent({
          agentId: input.agentId,
          tool: 'fs.get',
          path: input.path,
          metadataOnly: input.metadataOnly === true,
          maxBytes: input.maxBytes,
        } as AgentExecutionInput);
        return formatGetResult(raw, input);
      } catch (error) {
        return safeMediaError(error, 'read');
      }
    },
  );

  server.registerTool(
    'debatidor_asset_ticket',
    {
      title: 'Create a single-use asset relay URL (upload or download)',
      description:
        'Create a short-lived, single-use HTTPS URL that moves a binary between the outside world and the connected agent project WITHOUT passing bytes through this conversation. PREFERRED path for any media that has no public URL: generated images or videos in a sandbox, files the user has on their machine, browser blobs. Upload tickets accept a raw PUT body (curl -T, fetch with a Blob, the Debatidor browser extension) or a multipart POST with field `file`; the relay computes SHA-256 in flight and streams into the agent, so files up to hundreds of MB are fine. Download tickets stream a project file to whoever holds the URL. Decision order when storing media: 1) public HTTPS URL exists -> debatidor_agent_put; 2) otherwise -> this tool, then hand the URL to the user or fetch it from the sandbox; 3) only if outbound HTTP is impossible and the file is small (< ~1 MiB) -> debatidor_asset_begin/chunk/commit. The URL contains the secret: share it only with the intended uploader. Check completion with debatidor_asset_ticket_status.',
      inputSchema: ticketInputSchema,
      outputSchema: ticketResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input: TicketInput) => {
      try {
        const ticket = await api.createAssetTicket({
          direction: input.direction ?? 'upload',
          path: input.path,
          agentId: input.agentId,
          expectedBytes: input.expectedBytes,
          expectedSha256: input.expectedSha256,
          mimeType: input.mimeType,
          ttlSeconds: input.ttlSeconds,
        });
        const safe = compactTicket(ticket);
        return {
          content: [{ type: 'text' as const, text: formatTicketCreated(safe) }],
          structuredContent: safe,
        };
      } catch (error) {
        return safeMediaError(error, 'ticket');
      }
    },
  );

  server.registerTool(
    'debatidor_asset_ticket_status',
    {
      title: 'Check an asset relay ticket',
      description:
        'Read the state of a relay ticket created with debatidor_asset_ticket: pending (nobody used the URL yet), active (transfer in progress), completed (with final path, bytes and sha256 written or served by the agent), failed, expired or cancelled. Poll this after handing an upload URL to the user to confirm the file landed in the project.',
      inputSchema: ticketStatusInputSchema,
      outputSchema: ticketResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ ticketId }) => {
      try {
        const ticket = await api.getAssetTicket(ticketId);
        const safe = compactTicket(ticket);
        return {
          content: [{ type: 'text' as const, text: formatTicketStatus(safe) }],
          structuredContent: safe,
          ...(safe.status === 'failed' ? { isError: true } : {}),
        };
      } catch (error) {
        return safeMediaError(error, 'ticket');
      }
    },
  );
}

// ---------------------------------------------------------------- format

function formatGetResult(raw: AgentExecutionResult, input: GetInput) {
  const agentId = raw.agentId ?? null;
  const mimeType = raw.mimeType ?? 'application/octet-stream';
  const base64 = typeof raw.base64 === 'string' && raw.base64.length > 0 ? raw.base64 : undefined;
  const safe = {
    tool: 'fs.get' as const,
    agentId,
    ok: raw.ok,
    path: raw.path ?? input.path,
    bytes: raw.bytes,
    sha256: raw.sha256,
    mimeType: raw.mimeType,
    width: raw.width,
    height: raw.height,
    metadataOnly: raw.metadataOnly === true,
    inline: Boolean(base64),
    error: raw.error,
  };

  if (raw.ok === false) {
    const error = raw.error ?? 'operation_failed';
    const hint = error.startsWith('asset_too_large_for_inline')
      ? ' The file exceeds the inline ceiling: use debatidor_agent_get with metadataOnly=true to inspect it, or create a download ticket with debatidor_asset_ticket (direction=download).'
      : '';
    return {
      content: [{ type: 'text' as const, text: `debatidor-agent fs.get failed: ${error}.${hint}` }],
      structuredContent: safe,
      isError: true,
    };
  }

  const dims = raw.width && raw.height ? ` ${raw.width}x${raw.height}` : '';
  const summary = `${safe.path} · ${mimeType}${dims} · ${raw.bytes ?? 0} bytes${raw.sha256 ? ` · sha256 ${raw.sha256}` : ''}`;

  if (!base64) {
    return {
      content: [{ type: 'text' as const, text: `Metadata for ${summary}.` }],
      structuredContent: safe,
    };
  }

  if (VIEWABLE_IMAGE_MIME.has(mimeType)) {
    return {
      content: [
        { type: 'image' as const, data: base64, mimeType },
        { type: 'text' as const, text: `Image loaded from debatidor-agent: ${summary}.` },
      ],
      structuredContent: safe,
    };
  }

  return {
    content: [
      {
        type: 'resource' as const,
        resource: {
          uri: `debatidor-agent://${agentId ?? 'default'}/${encodeURI(safe.path)}`,
          mimeType,
          blob: base64,
        },
      },
      { type: 'text' as const, text: `Binary loaded from debatidor-agent: ${summary}.` },
    ],
    structuredContent: safe,
  };
}

type CompactTicket = z.infer<typeof ticketResultSchema>;

function compactTicket(ticket: RelayTicket): CompactTicket {
  return {
    ticketId: ticket.ticketId,
    direction: ticket.direction,
    status: ticket.status,
    agentId: ticket.agentId ?? null,
    path: ticket.path,
    url: ticket.uploadUrl ?? ticket.downloadUrl,
    methods: ticket.methods,
    expiresAt: ticket.expiresAt,
    maxBytes: ticket.maxBytes,
    expectedBytes: ticket.expectedBytes,
    expectedSha256: ticket.expectedSha256,
    mimeType: ticket.mimeType,
    instructions: ticket.instructions,
    result: ticket.result,
    error: ticket.error,
  };
}

function formatTicketCreated(ticket: CompactTicket): string {
  const lines = [
    `Relay ticket ${ticket.ticketId} (${ticket.direction}) for ${ticket.path}, valid until ${ticket.expiresAt}, max ${ticket.maxBytes} bytes.`,
  ];
  if (ticket.url) lines.push(`URL (single-use, keep it private): ${ticket.url}`);
  if (ticket.direction === 'upload') {
    lines.push(
      'Send the ORIGINAL bytes without re-encoding: `PUT` the file as the raw body (curl -T file URL, or fetch(URL, {method:"PUT", body: blob})) or `POST` multipart with field `file`.',
    );
  } else {
    lines.push('Anyone holding the URL can GET the file once; the response streams straight from the agent.');
  }
  lines.push(`Then call debatidor_asset_ticket_status with ticketId ${ticket.ticketId} to confirm completion and the final sha256.`);
  return lines.join('\n');
}

function formatTicketStatus(ticket: CompactTicket): string {
  const base = `Ticket ${ticket.ticketId} (${ticket.direction} ${ticket.path}) is ${ticket.status}.`;
  if (ticket.status === 'completed' && ticket.result) {
    return `${base} ${ticket.result.bytes ?? 0} bytes${ticket.result.sha256 ? ` · sha256 ${ticket.result.sha256}` : ''}${ticket.result.mimeType ? ` · ${ticket.result.mimeType}` : ''}.`;
  }
  if (ticket.status === 'failed' && ticket.error) return `${base} Error: ${ticket.error}.`;
  if (ticket.status === 'pending') return `${base} Nobody has used the URL yet; it expires at ${ticket.expiresAt}.`;
  return base;
}

function safeMediaError(error: unknown, kind: 'read' | 'ticket') {
  if (error instanceof DebatidorApiError) {
    if (error.status === 401 || error.status === 403) {
      return {
        content: [{ type: 'text' as const, text: 'The Debatidor account link is no longer authorized. Reconnect the MCP app.' }],
        isError: true,
      };
    }
    if (error.status === 404 && kind === 'ticket') {
      return {
        content: [{ type: 'text' as const, text: 'Relay ticket not found for this account (wrong id, expired long ago, or created by someone else).' }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text' as const, text: `Debatidor ${kind === 'read' ? 'media read' : 'asset relay'} request failed (${error.code ?? error.status}).` }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text' as const, text: `Debatidor MCP could not complete the ${kind === 'read' ? 'media read' : 'asset relay'} request.` }],
    isError: true,
  };
}
