import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
  DebatidorApiClient,
  DebatidorApiError,
  type AgentExecutionInput,
  type AgentExecutionResult,
} from './debatidor-api.js';

const UPLOAD_ID_RE = /^upl_[a-f0-9]{32}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_CHUNK_BASE64 = 90_000;

const agentIdField = z.string().trim().min(1).max(200).optional();
const uploadIdField = z.string().trim().regex(UPLOAD_ID_RE);

const beginSchema = z.object({
  path: z.string().trim().min(1).max(1000).describe('Relative destination path inside the connected agent root.'),
  bytes: z.number().int().positive().max(MAX_BYTES).describe('Exact original file size in bytes.'),
  sha256: z.string().trim().toLowerCase().regex(SHA_RE).optional().describe('Expected SHA-256 of the complete original file.'),
  mimeType: z.string().trim().min(3).max(200).optional().describe('Optional MIME type, for example image/png or video/mp4.'),
  agentId: agentIdField,
});

const chunkSchema = z.object({
  uploadId: uploadIdField,
  index: z.number().int().nonnegative().max(1_000_000),
  base64: z.string().min(1).max(MAX_CHUNK_BASE64).describe('Base64 bytes for exactly this chunk. Use the chunkSize returned by begin.'),
  agentId: agentIdField,
});

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

type ApiResult = AgentExecutionResult & {
  uploadId?: string;
  chunkSize?: number;
  received?: number;
  totalReceived?: number;
  nextIndex?: number;
  sha256?: string;
  mimeType?: string;
  sourceType?: 'chunked';
  aborted?: boolean;
};

export function registerAgentUploadTools(server: McpServer, api: DebatidorApiClient): void {
  server.registerTool(
    'debatidor_asset_begin',
    {
      title: 'Begin an exact binary asset upload',
      description:
        'Begin a chunked upload when the original asset exists only in the current model/browser sandbox and no usable public HTTPS URL is available. Prefer debatidor_agent_put when a provider/CDN URL exists. Returns uploadId and chunkSize. Do not resize, recompress or re-encode the original asset.',
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
        'Send the next chunk of an upload as base64. Chunks must be sent in increasing index order and must not exceed the chunkSize returned by debatidor_asset_begin.',
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
    const result = raw as ApiResult;
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

function formatResult(tool: string, result: ApiResult & { agentId?: string | null }): string {
  if (result.ok === false) return `${tool} failed: ${result.error ?? 'operation_failed'}`;
  if (tool === 'asset.begin') return `Upload ${result.uploadId} ready; chunkSize=${result.chunkSize ?? 0}.`;
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
