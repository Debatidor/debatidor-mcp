import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
  DebatidorApiClient,
  DebatidorApiError,
  type AgentExecutionInput,
  type AgentExecutionResult,
} from './debatidor-api.js';
import {
  createDebatidorServer,
  type DebatidorServerOptions,
} from './server.js';

const assetResultSchema = z.object({
  tool: z.literal('fs.put'),
  agentId: z.string().nullable(),
  ok: z.boolean().optional(),
  path: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  mimeType: z.string().optional(),
  sourceType: z.enum(['url', 'base64']).optional(),
  error: z.string().optional(),
});

const assetInputSchema = z
  .object({
    path: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .describe('Relative destination path inside the connected agent project root.'),
    url: z
      .string()
      .trim()
      .url()
      .max(8000)
      .optional()
      .describe('Public HTTPS URL of the asset. Preferred for images, audio, video, PDFs and other large files.'),
    base64: z
      .string()
      .max(90000)
      .optional()
      .describe('Inline base64 for a small binary asset only. Large media should use url instead.'),
    sha256: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
      .describe('Optional expected SHA-256 digest for integrity verification.'),
    mimeType: z
      .string()
      .trim()
      .min(3)
      .max(200)
      .optional()
      .describe('Optional expected MIME type, for example image/png, image/* or video/mp4.'),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(600000)
      .optional()
      .describe('Optional transfer timeout in milliseconds, up to 10 minutes.'),
    agentId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Optional debatidor-agent id. Omit to use the first connected agent for this user/workspace.'),
  })
  .refine((value) => Boolean(value.url) !== Boolean(value.base64), {
    message: 'Provide exactly one asset source: url or base64.',
    path: ['url'],
  });

type AssetInput = z.infer<typeof assetInputSchema>;

type AssetExecutionResult = Omit<AgentExecutionResult, 'tool'> & {
  tool: 'fs.put';
  sha256?: string;
  mimeType?: string;
  sourceType?: 'url' | 'base64';
};

/**
 * Production/server entrypoint with the generic asset transfer tool enabled.
 * Keeping this as a wrapper lets the existing server tool bundle remain
 * backwards-compatible while both HTTP and stdio get the new capability.
 */
export function createDebatidorServerWithAssets(
  options: DebatidorServerOptions,
): McpServer {
  const server = createDebatidorServer(options);
  if (options.api) registerAgentAssetTool(server, options.api);
  return server;
}

export function registerAgentAssetTool(
  server: McpServer,
  api: DebatidorApiClient,
): void {
  server.registerTool(
    'debatidor_agent_put',
    {
      title: 'Put a binary or media asset through debatidor-agent',
      description:
        'Create or replace a binary/media file inside the connected agent project. Prefer a public HTTPS asset URL for images, audio, video, PDFs, ZIPs and other large files: the agent downloads it directly so media bytes do not transit the MCP server or model context. Small inline base64 is supported for tiny assets. The agent enforces project-root/protected-file guards and rejects unsafe/private download targets.',
      inputSchema: assetInputSchema,
      outputSchema: assetResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input: AssetInput) => {
      try {
        const request = {
          agentId: input.agentId,
          tool: 'fs.put',
          path: input.path,
          url: input.url,
          base64: input.base64,
          sha256: input.sha256,
          mimeType: input.mimeType,
          timeoutMs: input.timeoutMs,
        };
        // DebatidorApiClient forwards agent execution payloads verbatim. The
        // public AgentExecutionInput union remains backwards-compatible for
        // existing consumers while this additive tool is introduced.
        const raw = await api.executeAgent(
          request as unknown as AgentExecutionInput,
        );
        const result = raw as unknown as AssetExecutionResult;
        const safe = {
          tool: 'fs.put' as const,
          agentId: result.agentId ?? null,
          ok: result.ok,
          path: result.path,
          bytes: result.bytes,
          sha256: result.sha256,
          mimeType: result.mimeType,
          sourceType: result.sourceType,
          error: result.error,
        };
        return {
          content: [
            {
              type: 'text' as const,
              text:
                safe.ok === false
                  ? `debatidor-agent fs.put failed: ${safe.error ?? 'operation_failed'}`
                  : `Stored ${safe.path ?? input.path} (${safe.bytes ?? 0} bytes) through debatidor-agent${safe.sha256 ? ` · sha256 ${safe.sha256}` : ''}.`,
            },
          ],
          structuredContent: safe,
          ...(safe.ok === false ? { isError: true } : {}),
        };
      } catch (error) {
        return safeAssetError(error);
      }
    },
  );
}

function safeAssetError(error: unknown) {
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
    if (error.code?.startsWith('agent_')) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Debatidor agent asset request was rejected: ${error.code}.`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: `Debatidor API request failed (${error.status}).`,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: 'Debatidor MCP could not complete the asset request.',
      },
    ],
    isError: true,
  };
}
