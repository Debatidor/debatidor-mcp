import * as z from 'zod/v4';

const wellFormed = (value: string) => [...value].every(char => char.length === 2 || char.charCodeAt(0) < 0xd800 || char.charCodeAt(0) > 0xdfff);
export const contextGraphIdSchema = z.string().min(1).max(500)
  .refine(id => id === id.trim() && id !== '.' && id !== '..' && wellFormed(id) && !/[\u0000-\u001f\u007f]/.test(id), 'Use an exact context identifier.');
const view = z.enum(['summary', 'recent', 'transcript']);
const views = z.array(view).min(1).max(3)
  .refine(values => new Set(values).size === values.length, 'Views must be unique.');
const timestamp = z.iso.datetime({ offset: true });
const cursorPayload = z.object({ readerId: contextGraphIdSchema, after: contextGraphIdSchema }).strict();
export function decodeContextEdgeCursor(value: string) {
  if (!/^[A-Za-z0-9_-]{1,2000}$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  if (Buffer.from(decoded).toString('base64url') !== value) return null;
  try {
    const result = cursorPayload.safeParse(JSON.parse(decoded));
    return result.success ? result.data : null;
  } catch { return null; }
}
const cursor = z.string().max(2000).refine(value => decodeContextEdgeCursor(value) !== null, 'Pass an unchanged edge-list nextCursor.');
export const createContextEdgeInputSchema = z.object({
  readerSessionId: contextGraphIdSchema,
  sourceSessionId: contextGraphIdSchema,
  views,
  clientEdgeId: contextGraphIdSchema,
  ttlSeconds: z.number().int().min(1).max(86400).optional(),
  maxEvents: z.number().int().min(1).max(50).optional(),
}).strict().refine(input => input.readerSessionId !== input.sourceSessionId, 'Reader and source sessions must differ.');
export const listContextEdgesInputSchema = z.object({
  readerSessionId: contextGraphIdSchema,
  cursor: cursor.optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict().refine(input => input.cursor === undefined || decodeContextEdgeCursor(input.cursor)?.readerId === input.readerSessionId,
  'An edge-list cursor belongs to one reader session.');
export const revokeContextEdgeInputSchema = z.object({ readerSessionId: contextGraphIdSchema, edgeId: contextGraphIdSchema }).strict();
const edgeShape = {
  id: contextGraphIdSchema, readerSessionId: contextGraphIdSchema, sourceSessionId: contextGraphIdSchema,
  views, maxEvents: z.number().int().min(1).max(50), createdAt: timestamp, expiresAt: timestamp, revokedAt: timestamp.nullable(),
};
function validEdge(edge: z.infer<z.ZodObject<typeof edgeShape>>) {
  const duration = Date.parse(edge.expiresAt) - Date.parse(edge.createdAt);
  return edge.readerSessionId !== edge.sourceSessionId && duration > 0 && duration <= 86400_000 &&
    (edge.revokedAt === null || Date.parse(edge.revokedAt) >= Date.parse(edge.createdAt));
}
export const contextEdgeSchema = z.object(edgeShape).refine(validEdge, 'Invalid directed edge identity or lifetime.');
export const contextEdgeCreatedSchema = z.object({ ...edgeShape, duplicate: z.boolean() }).refine(validEdge, 'Invalid directed edge identity or lifetime.');
export const contextEdgesSchema = z.object({ edges: z.array(contextEdgeSchema).max(100), nextCursor: cursor.nullable() })
  .refine(page => new Set(page.edges.map(edge => edge.id)).size === page.edges.length && (page.nextCursor === null || page.edges.length > 0), 'Invalid edge page.');
export const contextEdgeRevokedSchema = z.object({ revoked: z.literal(true) });
export type CreateContextEdgeInput = z.infer<typeof createContextEdgeInputSchema>;
export type ListContextEdgesInput = z.infer<typeof listContextEdgesInputSchema>;
export type RevokeContextEdgeInput = z.infer<typeof revokeContextEdgeInputSchema>;
