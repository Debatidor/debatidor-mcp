import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { DebatidorApiClient } from './debatidor-api.js';
import {
  contextIdSchema, contextSourceCursorSchema, contextExportCursorSchema,
  contextItemSchema, contextSourcesSchema, createContextExportSchema,
  contextExportSchema, contextExportPageSchema, contextExportDeletedSchema,
  contextItemDeletedSchema, contextDeletionSchema, contextGovernanceSchema,
  deleteContextSourcesSchema,
} from './context-governance-contracts.js';

type ToolError = { content: Array<{ type: 'text'; text: string }>; isError: boolean };
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const deleteAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

export function registerContextGovernanceTools(
  server: McpServer, api: DebatidorApiClient, onError: (error: unknown) => ToolError,
) {
  server.registerTool('debatidor_get_context_item', {
    title: 'Read a complete memory entry',
    description: 'Read the full current content and provenance of one authorized memory item, including unmaterialized raw fallback. Use the item id returned by search; this returns complete content, not a search excerpt. canDelete reports the current permission. Missing, deleted, expired or inaccessible items are unavailable.',
    inputSchema: z.object({ itemId: contextIdSchema }),
    outputSchema: contextItemSchema, annotations: readAnnotations,
  }, async ({ itemId }) => {
    try {
      const result = await api.getContextItem(itemId);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) { return onError(error); }
  });

  server.registerTool('debatidor_list_context_sources', {
    title: 'List memory sources',
    description: 'List one page of authorized memory sources. user (default) selects your private sources; workspace selects shared sources and never grants another user’s private memory. Pass nextCursor unchanged to read the next page. Listing does not export or delete content.',
    inputSchema: z.object({
      scope: z.enum(['user', 'workspace']).optional(),
      cursor: contextSourceCursorSchema.optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    outputSchema: contextSourcesSchema, annotations: readAnnotations,
  }, async (input) => {
    try {
      const result = await api.listContextSources(input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) { return onError(error); }
  });

  server.registerTool('debatidor_export_context', {
    title: 'Create a private memory export snapshot',
    description: 'Create a private snapshot of full authorized memory entries in explicit user or workspace scope. Optional sourceIds selects at most 100 sources; omitted selects the scope. Kinds default to all five. Returns metadata only, without a download host; read pages with debatidor_read_context_export. Maximum 10,000 entries/32 MiB, 100 entries/page, one-hour expiry and three active snapshots per principal. Content is not automatically redacted. Creates a new snapshot on every call: never retry automatically.',
    inputSchema: createContextExportSchema,
    outputSchema: contextExportSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    try {
      const result = await api.createContextExport(input);
      return { content: [{ type: 'text', text: `Created export ${result.id}: ${result.itemCount} entries in ${result.pageCount} pages; expires ${result.expiresAt}. Read pages explicitly with debatidor_read_context_export.` }], structuredContent: result };
    } catch (error) { return mutationError(onError(error)); }
  });

  server.registerTool('debatidor_read_context_export', {
    title: 'Read one memory export page',
    description: 'Read one complete page from your private export snapshot. Omit cursor for the first page; pass nextCursor unchanged thereafter until null. Each page has at most 100 full entries. For Markdown, concatenate the returned markdown strings literally in page order; JSON exports return markdown:null. Every page rechecks all referenced access and deletions; expiry or revoked/deleted sources invalidate the whole export. An empty export has one empty page. Downloaded copies are outside service control.',
    inputSchema: z.object({ exportId: contextIdSchema, cursor: contextExportCursorSchema.optional() }),
    outputSchema: contextExportPageSchema, annotations: readAnnotations,
  }, async (input) => {
    try {
      const result = await api.readContextExport(input);
      // Keep full content and exact Markdown; never truncate a successful page.
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) { return onError(error); }
  });

  server.registerTool('debatidor_delete_context_export', {
    title: 'Delete a memory export snapshot',
    description: 'Physically delete the bytes of one export snapshot you own. Does not delete canonical memory, conversation history or downloaded copies. Repeating an explicit deletion is safe, but this tool never retries automatically.',
    inputSchema: z.object({ exportId: contextIdSchema }),
    outputSchema: contextExportDeletedSchema, annotations: deleteAnnotations,
  }, async ({ exportId }) => {
    try {
      const result = await api.deleteContextExport(exportId);
      return { content: [{ type: 'text', text: 'Deleted the export snapshot from Debatidor. Canonical memory and downloaded copies are unchanged.' }], structuredContent: result };
    } catch (error) { return mutationError(onError(error)); }
  });

  server.registerTool('debatidor_delete_context_item', {
    title: 'Delete one derived memory item',
    description: 'Delete one authorized derived memory item and its derived copies. Original messages and turns are preserved. The item disappears from retrieval immediately; deleted:true confirms physical cleanup. deleted:false with status:PENDING requires checking operationId with debatidor_get_context_deletion. Never treat pending cleanup as completed or retry automatically.',
    inputSchema: z.object({ itemId: contextIdSchema }),
    outputSchema: contextItemDeletedSchema, annotations: deleteAnnotations,
  }, async ({ itemId }) => {
    try {
      const result = await api.deleteContextItem(itemId);
      const text = result.deleted
        ? 'Deleted the derived memory item and completed cleanup. Original conversation history is preserved.'
        : `The item is hidden from retrieval; physical cleanup is PENDING. Check operation ${result.operationId} with debatidor_get_context_deletion. Original history is preserved.`;
      return { content: [{ type: 'text', text }], structuredContent: result };
    } catch (error) { return mutationError(onError(error)); }
  });

  server.registerTool('debatidor_get_context_deletion', {
    title: 'Check derived memory deletion status',
    description: 'Read a deletion operation you own. PENDING means cleanup is incomplete; COMPLETED confirms derived content, vectors, verified legacy copies, materialization jobs and affected private snapshots have been purged. Contentless tombstones remain to prevent resurrection. Original messages/turns and downloaded copies are preserved. Does not repeat the deletion.',
    inputSchema: z.object({ operationId: contextIdSchema }),
    outputSchema: contextDeletionSchema, annotations: readAnnotations,
  }, async ({ operationId }) => {
    try {
      const result = await api.getContextDeletion(operationId);
      return { content: [{ type: 'text', text: `Deletion ${result.id}: ${result.status}; ${result.itemCount} targeted items. Original conversation history is preserved.` }], structuredContent: result };
    } catch (error) { return onError(error); }
  });

  server.registerTool('debatidor_get_context_governance', {
    title: 'Read memory governance policy',
    description: 'Read current retention, export limits, operational quotas and derived deletion policy for the authenticated account. This reports backend policy, not billing plans. No content is exported or deleted.',
    inputSchema: z.object({}),
    outputSchema: contextGovernanceSchema, annotations: readAnnotations,
  }, async () => {
    try {
      const result = await api.getContextGovernance();
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) { return onError(error); }
  });

  server.registerTool('debatidor_delete_context_sources', {
    title: 'Delete derived memory from selected sources',
    description: 'Destructively forget all existing derived memory in explicitly selected sourceIds (1–100), with mode:derived and an explicit user or workspace scope. user covers only your private sources; workspace requires OWNER. Original messages and turns remain. New content created after admission remains allowed. Returns a deletion operation; check PENDING with debatidor_get_context_deletion. A new call creates a new operation and may cover newer content: never retry automatically. This tool requires a source selection and never implicitly selects every workspace source.',
    inputSchema: deleteContextSourcesSchema,
    outputSchema: contextDeletionSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    try {
      const result = await api.deleteContextSources(input);
      return { content: [{ type: 'text', text: `Deletion ${result.id}: ${result.status}; ${result.itemCount} existing items targeted. Original history and later new content are preserved. Use debatidor_get_context_deletion to check pending cleanup.` }], structuredContent: result };
    } catch (error) { return mutationError(onError(error)); }
  });
}

function mutationError(result: ToolError): ToolError {
  return { ...result, content: result.content.map(block => ({ ...block,
    text: `${block.text} No automatic retry was attempted; do not infer completion or automatically repeat this mutation.` })) };
}
