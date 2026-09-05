import * as z from 'zod/v4';

export const contextKindSchema = z.enum(['MESSAGE', 'CONCLUSION', 'FACT', 'DECISION', 'SUMMARY']);
export type ContextKind = z.infer<typeof contextKindSchema>;

export const contextProvenanceSchema = z.object({
  messageId: z.string().min(1).nullable(),
  sourceRevision: z.number().int().positive(),
  originType: z.string().min(1),
  originId: z.string().min(1),
});

export const contextRetrievalSchema = z.object({
  method: z.literal('text'),
  semanticStatus: z.literal('unavailable'),
});

const canonicalContextHitSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  debateId: z.string().min(1).nullable(),
  kind: contextKindSchema,
  content: z.string().min(1),
  score: z.number().nonnegative(),
  semanticSimilarity: z.null(),
  createdAt: z.iso.datetime({ offset: true }),
  provenance: contextProvenanceSchema,
});

/** The first-party Context Service envelope, not the legacy vector-memory array. */
export const canonicalContextSearchSchema = z.object({
  hits: z.array(canonicalContextHitSchema),
  retrieval: contextRetrievalSchema,
  partial: z.boolean(),
});

export const contextHitSchema = canonicalContextHitSchema.extend({
  // Preserve the required MCP field for old consumers. Zero is the legacy
  // sentinel for textual retrieval; it is never a measured cosine similarity.
  similarity: z.literal(0).describe('Legacy numeric field: 0 for textual retrieval; not cosine similarity.'),
  retrievalMethod: z.literal('text'),
});

export const contextSearchSchema = z.object({
  query: z.string(),
  hitCount: z.number().int().nonnegative(),
  hits: z.array(contextHitSchema),
  retrieval: contextRetrievalSchema,
  partial: z.boolean(),
});

export const contextIndexSchema = z.object({
  debateId: z.string().min(1),
  scanned: z.number().int().nonnegative(),
  indexed: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  empty: z.number().int().nonnegative(),
  cappedAt: z.number().int().positive(),
});

export type ContextHit = z.infer<typeof contextHitSchema>;
export type ContextSearchResult = {
  hits: ContextHit[];
  retrieval: z.infer<typeof contextRetrievalSchema>;
  partial: boolean;
};
export type IndexDebateContextResult = z.infer<typeof contextIndexSchema>;
