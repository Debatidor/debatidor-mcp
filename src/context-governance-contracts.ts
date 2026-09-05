import * as z from 'zod/v4';
import { contextKindSchema } from './context-contracts.js';

// Accept additional upstream fields for forward compatibility, but only return
// the declared projection. Unknown fields (vectors, jobs, etc.) are stripped.
export const contextIdSchema = z.string().trim().min(1).max(500)
  .refine(id => id !== '.' && id !== '..' && !/[\u0000-\u001f\u007f]/.test(id), 'Invalid context id.');
export const contextScopeSchema = z.object({ type: z.enum(['user', 'workspace']) });
export const contextSourceIdsSchema = z.array(contextIdSchema).min(1).max(100);
export const contextSourceCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,1000}$/);
export const contextExportCursorSchema = z.string().regex(/^(0|[1-9][0-9]{0,8})$/)
  .refine(cursor => Number(cursor) % 100 === 0, 'Use the nextCursor returned by the export.');

const provenanceSchema = z.object({
  messageId: z.string().min(1).nullable(),
  sourceRevision: z.number().int().positive(),
  originType: z.string().min(1),
  originId: z.string().min(1),
});
export const contextEntrySchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  debateId: z.string().min(1).nullable(),
  kind: contextKindSchema,
  // Full canonical content may be empty. Do not apply search snippet limits.
  content: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  provenance: provenanceSchema,
});
export const contextItemSchema = contextEntrySchema.extend({ canDelete: z.boolean() });
export const contextSourcesSchema = z.object({
  sources: z.array(z.object({
    id: z.string().min(1),
    type: z.enum(['DEBATE', 'USER', 'SESSION', 'LEGACY']),
    label: z.string(),
    visibility: z.enum(['PRIVATE', 'WORKSPACE']),
    canDelete: z.boolean(),
  })).max(100),
  nextCursor: contextSourceCursorSchema.nullable(),
}).refine(page => new Set(page.sources.map(source => source.id)).size === page.sources.length,
  'A sources page must not duplicate sources.')
  .refine(page => page.nextCursor === null || page.sources.length > 0, 'An empty page cannot continue.');

export const createContextExportSchema = z.object({
  scope: contextScopeSchema,
  sourceIds: contextSourceIdsSchema.optional(),
  kinds: z.array(contextKindSchema).min(1).max(5).optional(),
  format: z.enum(['json', 'markdown']),
});
const exportShape = {
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  scope: contextScopeSchema,
  format: z.enum(['json', 'markdown']),
  itemCount: z.number().int().min(0).max(10_000),
  pageCount: z.number().int().min(1).max(100),
  expiresAt: z.iso.datetime({ offset: true }),
};
function validPageCount(metadata: { itemCount: number; pageCount: number }): boolean {
  return metadata.pageCount === Math.max(1, Math.ceil(metadata.itemCount / 100));
}
export const contextExportSchema = z.object(exportShape)
  .refine(validPageCount, 'Export pageCount must cover the full itemCount.');
export const contextExportPageSchema = z.object({
  ...exportShape,
  entries: z.array(contextEntrySchema).max(100),
  nextCursor: contextExportCursorSchema.nullable(),
  markdown: z.string().nullable(),
}).refine(validPageCount, 'Export pageCount must cover the full itemCount.')
  .refine(page => (page.format === 'json') === (page.markdown === null), 'Export format and Markdown must agree.')
  .refine(page => new Set(page.entries.map(entry => entry.id)).size === page.entries.length,
    'An export page must not duplicate entries.');

export const contextExportDeletedSchema = z.object({ deleted: z.literal(true) });
export const contextItemDeletedSchema = z.object({
  deleted: z.boolean(),
  operationId: z.string().min(1).optional(),
  status: z.literal('PENDING').optional(),
}).refine(result => result.deleted
  ? result.operationId === undefined && result.status === undefined
  : Boolean(result.operationId) && result.status === 'PENDING', 'Deletion must be completed or identify its pending operation.');
export const deleteContextSourcesSchema = z.object({
  mode: z.literal('derived'),
  scope: contextScopeSchema,
  // Deliberately require an explicit selection in this destructive MCP tool.
  sourceIds: contextSourceIdsSchema,
});
export const contextDeletionSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['PENDING', 'COMPLETED']),
  mode: z.literal('derived'),
  scope: contextScopeSchema,
  // A backend operation admitted without sourceIds can cover more than 100.
  sourceIds: z.array(z.string().min(1)),
  requestedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  itemCount: z.number().int().nonnegative(),
}).refine(operation => (operation.status === 'PENDING') === (operation.completedAt === null),
  'Completed status requires a completion timestamp.')
  .refine(operation => new Set(operation.sourceIds).size === operation.sourceIds.length,
    'Deletion sources must not contain duplicates.');
export const contextGovernanceSchema = z.object({
  schemaVersion: z.literal(1),
  retention: z.object({ mode: z.literal('manual'), rawHistory: z.literal('preserved'), derivedExpiration: z.literal('purged') }),
  exports: z.object({
    maxActive: z.number().int().positive(),
    ttlSeconds: z.number().int().positive(),
    maxItems: z.number().int().positive(),
    maxBytes: z.number().int().positive(),
    pageSize: z.literal(100),
  }),
  quotas: z.object({
    policy: z.literal('operational'),
    maxChunksPerItem: z.number().int().positive(),
    maxChunksPerWorkspace: z.number().int().positive(),
    dailyTokens: z.number().int().positive(),
  }),
  deletion: z.object({ mode: z.literal('derived'), downloadedCopies: z.literal('outside_service_control') }),
});

export type ContextSourcesInput = { scope?: 'user' | 'workspace'; cursor?: string; limit?: number };
export type CreateContextExportInput = z.infer<typeof createContextExportSchema>;
export type ReadContextExportInput = { exportId: string; cursor?: string };
export type DeleteContextSourcesInput = z.infer<typeof deleteContextSourcesSchema>;
