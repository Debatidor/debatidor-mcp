import * as z from 'zod/v4';

export const contextKindSchema = z.enum(['MESSAGE', 'CONCLUSION', 'FACT', 'DECISION', 'SUMMARY']);
export type ContextKind = z.infer<typeof contextKindSchema>;

const retrievalMethodSchema = z.enum(['text', 'hybrid']);
const similaritySchema = z.number().min(-1).max(1);
const chunkSchema = z.object({
  id: z.string().min(1),
  chunkerVersion: z.string().min(1),
  startUtf16: z.number().int().nonnegative(),
  endUtf16: z.number().int().positive(),
}).refine(chunk => chunk.endUtf16 > chunk.startUtf16, 'Chunk end must follow its start.');

export const contextProvenanceSchema = z.object({
  messageId: z.string().min(1).nullable(),
  sourceRevision: z.number().int().positive(),
  originType: z.string().min(1),
  originId: z.string().min(1),
  chunk: chunkSchema.optional(),
});

export const contextRetrievalSchema = z.object({
  method: retrievalMethodSchema,
  semanticStatus: z.enum(['unavailable', 'warming', 'busy', 'ready', 'partial']),
  modelKey: z.string().min(1).optional(),
  reason: z.enum(['disabled', 'model_unavailable', 'query_over_budget', 'index_pending', 'quota', 'timeout', 'inference_failed']).optional(),
});

const hitShape = {
  id: z.string().min(1),
  sourceId: z.string().min(1),
  debateId: z.string().min(1).nullable(),
  kind: contextKindSchema,
  content: z.string().min(1),
  score: z.number().nonnegative(),
  semanticSimilarity: similaritySchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  provenance: contextProvenanceSchema,
};
type CanonicalHit = z.infer<z.ZodObject<typeof hitShape>>;
function validChunkQuote(hit: CanonicalHit): boolean {
  const chunk = hit.provenance.chunk;
  return (hit.semanticSimilarity !== null) === Boolean(chunk) &&
    (!chunk || chunk.endUtf16 - chunk.startUtf16 === hit.content.length);
}
const canonicalContextHitSchema = z.object(hitShape).refine(validChunkQuote, 'Semantic hits require an exact UTF-16 chunk quote.');

function validTextRetrieval(result: { retrieval: { method: string }; hits: CanonicalHit[] }): boolean {
  return result.retrieval.method !== 'text' || result.hits.every(hit => hit.semanticSimilarity === null && !hit.provenance.chunk);
}

/** The first-party Context Service envelope, not the legacy vector-memory array. */
export const canonicalContextSearchSchema = z.object({
  hits: z.array(canonicalContextHitSchema),
  retrieval: contextRetrievalSchema,
  partial: z.boolean(),
}).refine(validTextRetrieval, 'Text retrieval cannot claim semantic matches.');

export const contextHitSchema = z.object({
  ...hitShape,
  // Preserve the required MCP field for old consumers. Zero is the legacy
  // sentinel for textual retrieval; it is never a measured cosine similarity.
  similarity: similaritySchema.describe('Legacy numeric field: cosine similarity for semantic hits, otherwise 0 as a text-only sentinel.'),
  retrievalMethod: retrievalMethodSchema,
}).refine(validChunkQuote, 'Semantic hits require an exact UTF-16 chunk quote.')
  .refine(hit => hit.similarity === (hit.semanticSimilarity ?? 0), 'Legacy similarity must agree with semanticSimilarity.');

export const contextSearchSchema = z.object({
  query: z.string(),
  hitCount: z.number().int().nonnegative(),
  hits: z.array(contextHitSchema),
  retrieval: contextRetrievalSchema,
  partial: z.boolean(),
}).refine(validTextRetrieval, 'Text retrieval cannot claim semantic matches.')
  .refine(result => result.hits.every(hit => hit.retrievalMethod === result.retrieval.method), 'Hit retrieval methods must agree with the envelope.');

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
