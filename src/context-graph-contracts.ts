import * as z from 'zod/v4';

const wellFormed = (value: string) => [...value].every(char =>
  char.length === 2 || char.charCodeAt(0) < 0xd800 || char.charCodeAt(0) > 0xdfff);

export const contextGraphIdSchema = z.string().min(1).max(500)
  .refine(id => id === id.trim() && id !== '.' && id !== '..' && wellFormed(id) &&
    !/[\u0000-\u001f\u007f]/.test(id), 'Use an exact context identifier.');
const view = z.enum(['summary', 'recent', 'transcript']);
const views = z.array(view).min(1).max(3)
  .refine(values => new Set(values).size === values.length, 'Views must be unique.')
  .describe('Explicit allowed views. Access is directed and never transitive.');
const timestamp = z.iso.datetime({ offset: true });
const cursorPayload = z.object({
  readerId: contextGraphIdSchema, after: contextGraphIdSchema,
}).strict();

export function decodeContextEdgeCursor(value: string) {
  if (!/^[A-Za-z0-9_-]{1,2000}$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  if (Buffer.from(decoded).toString('base64url') !== value) return null;
  try {
    const result = cursorPayload.safeParse(JSON.parse(decoded));
    return result.success ? result.data : null;
  } catch { return null; }
}
const cursor = z.string().max(2000)
  .refine(value => decodeContextEdgeCursor(value) !== null, 'Pass an unchanged edge-list nextCursor.')
  .describe('Opaque edge-list cursor; retain the same readerSessionId.');
const readerSessionId = contextGraphIdSchema.describe('Your private reader session, which receives access to the source.');
const sourceSessionId = contextGraphIdSchema.describe('Your distinct private source session, whose selected views the reader may access.');

export const createContextEdgeInputSchema = z.object({
  readerSessionId, sourceSessionId, views,
  clientEdgeId: contextGraphIdSchema.describe('Caller-chosen idempotency identifier. Preserve it and all input on an explicitly requested retry.'),
  ttlSeconds: z.number().int().min(1).max(86400).optional()
    .describe('Edge lifetime in seconds, default 3600, maximum 86400.'),
  maxEvents: z.number().int().min(1).max(50).optional()
    .describe('Maximum records per delegated page and recent window positions, default 50.'),
}).strict().refine(input => input.readerSessionId !== input.sourceSessionId, 'Reader and source sessions must differ.');
export const listContextEdgesInputSchema = z.object({
  readerSessionId,
  cursor: cursor.optional(),
  limit: z.number().int().min(1).max(100).optional().describe('One metadata page, default 50, maximum 100.'),
}).strict().refine(input => input.cursor === undefined ||
  decodeContextEdgeCursor(input.cursor)?.readerId === input.readerSessionId,
  'An edge-list cursor belongs to one reader session.');
export const revokeContextEdgeInputSchema = z.object({
  readerSessionId, edgeId: contextGraphIdSchema.describe('The exact directed edge to revoke for this reader.'),
}).strict();

const edgeShape = {
  id: contextGraphIdSchema.describe('Directed edge identifier.'),
  readerSessionId, sourceSessionId, views,
  maxEvents: z.number().int().min(1).max(50).describe('Persisted record limit for this edge.'),
  createdAt: timestamp.describe('Original edge creation time.'),
  expiresAt: timestamp.describe('Fixed expiry, including for identical creation replays.'),
  revokedAt: z.union([timestamp, z.null()]).describe('Explicit revocation time, or null if never revoked. Expiry is independent.'),
};
function validEdge(edge: z.infer<z.ZodObject<typeof edgeShape>>) {
  const duration = Date.parse(edge.expiresAt) - Date.parse(edge.createdAt);
  return edge.readerSessionId !== edge.sourceSessionId && duration > 0 && duration <= 86400_000 &&
    (edge.revokedAt === null || Date.parse(edge.revokedAt) >= Date.parse(edge.createdAt));
}
export const contextEdgeSchema = z.object(edgeShape)
  .refine(validEdge, 'Invalid directed edge identity or lifetime.');
export const contextEdgeCreatedSchema = z.object({
  ...edgeShape, duplicate: z.boolean().describe('True only when returning the existing grant for identical input.'),
}).refine(validEdge, 'Invalid directed edge identity or lifetime.');
export const contextEdgesSchema = z.object({
  edges: z.array(contextEdgeSchema).max(100).describe('One page of owned edge metadata, including revoked and expired history.'),
  nextCursor: z.union([cursor, z.null()]).describe('Cursor for this reader, or null when the listing is complete.'),
}).refine(page => new Set(page.edges.map(edge => edge.id)).size === page.edges.length &&
  (page.nextCursor === null || page.edges.length > 0), 'Invalid edge page.');
export const contextEdgeRevokedSchema = z.object({
  revoked: z.literal(true).describe('Revocation confirmed; raw history and other edges are preserved.'),
});
export type CreateContextEdgeInput = z.infer<typeof createContextEdgeInputSchema>;
export type ListContextEdgesInput = z.infer<typeof listContextEdgesInputSchema>;
export type RevokeContextEdgeInput = z.infer<typeof revokeContextEdgeInputSchema>;
