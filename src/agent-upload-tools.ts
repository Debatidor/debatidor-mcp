import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
  DebatidorApiClient,
  DebatidorApiError,
  type AgentExecutionInput,
} from './debatidor-api.js';

const UPLOAD_ID_RE = /^upl_[a-f0-9]{32}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_CHUNK_BASE64 = 90_000;
const MAX_CHUNK_HEX = 140_000;
const MIN_CHUNK_BYTES = 4 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024;

const agentIdField = z.string().trim().min(1).max(200).optional();
const uploadIdField = z.string().trim().regex(UPLOAD_ID_RE);

const beginSchema = z.object({
  path: z.string().trim().min(1).max(1000).describe('Relative destination path inside the connected agent root.'),
  bytes: z.number().int().positive().max(MAX_BYTES).describe('Exact original file size in bytes.'),
  sha256: z.string().trim().toLowerCase().regex(SHA_RE).optional().describe('Expected SHA-256 of the complete original file.'),
  mimeType: z.string().trim().min(3).max(200).optional().describe('Optional MIME type, for example image/png or video/mp4.'),
  chunkSize: z
    .number()
    .int()
    .min(MIN_CHUNK_BYTES)
    .max(MAX_CHUNK_BYTES)
    .optional()
    .describe(
      'Transport chunk size in bytes (4096-65536, default 16384). Pick a smaller value when the host I/O channel limits message size so each chunk fits comfortably in one tool call. The agent echoes back the chunkSize you must actually use for every chunk except the last.',
    ),
  agentId: agentIdField,
});

const chunkSchema = z.object({
  uploadId: uploadIdField,
  index: z.number().int().nonnegative().max(1_000_000),
  encoding: z
    .enum(['base64', 'hex'])
    .default('base64')
    .describe('Byte encoding for this chunk. base64 (default) is most compact; hex is available for channels that mangle base64 characters.'),
  base64: z
    .string()
    .max(MAX_CHUNK_BASE64)
    .optional()
    .describe('base64 bytes for exactly this chunk when encoding=base64. At most chunkSize decoded bytes.'),
  hex: z
    .string()
    .max(MAX_CHUNK_HEX)
    .optional()
    .describe('Hex bytes for exactly this chunk when encoding=hex. At most chunkSize decoded bytes.'),
  agentId: agentIdField,
}).refine(
  (value) => (value.encoding === 'hex' ? Boolean(value.hex) : Boolean(value.base64)),
  { message: 'Provide base64 for encoding=base64, or hex for encoding=hex.', path: ['base64'] },
);

const uploadRefSchema = z.object({
  uploadId: uploadIdField,
  agentId: agentIdField,
});

const uploadResultSchema = z.object({
  tool: z.string(),
  agentId: z.string().nullable(),
  ok: z.boolean().optional(),
  uploadId: z.string().optional(),
  path: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  chunkSize: z.number().int().positive().optional(),
  received: z.number().int().nonnegative().optional(),
  totalReceived: z.number().int().nonnegative().optional(),
  nextIndex: z.number().int().nonnegative().optional(),
  sha256: z.string().regex(SHA_RE).optional(),
  mimeType: z.string().optional(),
  sourceType: z.literal('chunked').optional(),
  aborted: z.boolean().optional(),
  error: z.string().optional(),
});

type ApiResult = {
  agentId?: string | null;
  ok?: boolean;
  uploadId?: string;
  path?: string;
  bytes?: number;
  chunkSize?: number;
  received?: number;
  totalReceived?: number;
  nextIndex?: number;
  sha256?: string;
  mimeType?: string;
  sourceType?: 'chunked';
  aborted?: boolean;
  error?: string;
};

export function registerAgentUploadTools(server: McpServer, api: DebatidorApiClient): void {
  server.registerTool(
    'debatidor_asset_begin',
    {
      title: 'Begin an exact binary asset upload',
      description:
        'LAST RESORT (STEP 3 of the media hierarchy). Begin a chunked upload ONLY when the asset exists solely in this sandbox and outbound HTTP is unavailable (e.g. a network-isolated code interpreter). Prefer debatidor_agent_put when a public HTTPS URL exists (STEP 1) and debatidor_asset_ticket when bytes can be sent over HTTP from anywhere (STEP 2). This path moves the file as a sequence of tool calls, so it is slow for large files; use the smallest chunkSize that your host I/O channel accepts (default 16 KiB). Returns uploadId and the chunkSize to use. Do not resize, recompress or re-encode the original asset. See the README "Air-gapped chunked upload" section for a ready-to-run buffered-read script.',
      inputSchema: beginSchema,
      outputSchema: uploadResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input) => executeUpload(api, 'asset.begin', input),
  );

  server.registerTool(
    'debatidor_asset_chunk',
    {
      title: 'Upload one binary asset chunk',
      description:
        'Send the next chunk of an upload in increasing index order. Each chunk carries at most the chunkSize (decoded bytes) returned by debatidor_asset_begin, encoded as base64 (default) or hex. Read the source file with a fixed buffer size equal to chunkSize and send one chunk per read; do not hand-assemble payloads.',
      inputSchema: chunkSchema,
      outputSchema: uploadResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input) => executeUpload(api, 'asset.chunk', input),
  );

  server.registerTool(
    'debatidor_asset_commit',
    {
      title: 'Commit an exact binary asset upload',
      description:
        'Finish a chunked upload. The agent verifies exact byte count and optional SHA-256, then atomically replaces the destination file.',
      inputSchema: uploadRefSchema,
      outputSchema: uploadResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input) => executeUpload(api, 'asset.commit', input),
  );

  server.registerTool(
    'debatidor_asset_abort',
    {
      title: 'Abort a binary asset upload',
      description: 'Abort a chunked upload and remove its temporary staging file.',
      inputSchema: uploadRefSchema,
      outputSchema: uploadResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => executeUpload(api, 'asset.abort', input),
  );
}

async function executeUpload(
  api: DebatidorApiClient,
  tool: 'asset.begin' | 'asset.chunk' | 'asset.commit' | 'asset.abort',
  input: Record<string, unknown>,
) {
  try {
    const raw = await api.executeAgent({
      ...input,
      tool,
    } as unknown as AgentExecutionInput);
    const result = raw as unknown as ApiResult;
    const safe = {
      tool,
      agentId: result.agentId ?? null,
      ok: result.ok,
      uploadId: result.uploadId,
      path: result.path,
      bytes: result.bytes,
      chunkSize: result.chunkSize,
      received: result.received,
      totalReceived: result.totalReceived,
      nextIndex: result.nextIndex,
      sha256: result.sha256,
      mimeType: result.mimeType,
      sourceType: result.sourceType,
      aborted: result.aborted,
      error: result.error,
    };
    return {
      content: [{ type: 'text' as const, text: formatResult(tool, safe) }],
      structuredContent: safe,
      ...(safe.ok === false ? { isError: true } : {}),
    };
  } catch (error) {
    return safeUploadError(error);
  }
}

function formatResult(tool: string, result: ApiResult): string {
  if (result.ok === false) return `${tool} failed: ${result.error ?? 'operation_failed'}`;
  if (tool === 'asset.begin') {
    return `Upload ${result.uploadId} ready; send each chunk as exactly ${result.chunkSize ?? 0} bytes (base64 or hex) in order, then commit.`;
  }
  if (tool === 'asset.chunk') return `Upload ${result.uploadId}: received ${result.received ?? 0} bytes; nextIndex=${result.nextIndex ?? 0}.`;
  if (tool === 'asset.commit') return `Stored ${result.path ?? 'asset'} (${result.bytes ?? 0} bytes)${result.sha256 ? ` · sha256 ${result.sha256}` : ''}.`;
  return `Upload ${result.uploadId ?? ''} aborted.`;
}

function safeUploadError(error: unknown) {
  if (error instanceof DebatidorApiError) {
    if (error.status === 401 || error.status === 403) {
      return {
        content: [{ type: 'text' as const, text: 'The Debatidor account link is no longer authorized. Reconnect the MCP app.' }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text' as const, text: `Debatidor asset upload request failed (${error.code ?? error.status}).` }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text' as const, text: 'Debatidor MCP could not complete the chunked asset upload.' }],
    isError: true,
  };
}
