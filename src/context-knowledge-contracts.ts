import * as z from 'zod/v4';
import { contextKindSchema, contextOriginsSchema, contextRawTypeSchema } from './context-contracts.js';

const wellFormed = (value: string) => [...value].every(char => char.length === 2 || char.charCodeAt(0) < 0xd800 || char.charCodeAt(0) > 0xdfff);
const identifier = z.string().min(1).max(500).refine(id => id === id.trim() && id !== '.' && id !== '..' && wellFormed(id) && !/[\u0000-\u001f\u007f]/.test(id), 'Identifiers must be exact valid Unicode without whitespace padding or control characters.');
const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();
const positive = z.number().int().positive();
const cursor = z.string().regex(/^[A-Za-z0-9_-]{1,2000}$/);
const pageInput = { cursor: cursor.optional(), limit: z.number().int().min(1).max(100).optional() };
const label = z.string().trim().min(1).max(120).refine(value => wellFormed(value) && !/[\u0000-\u001f\u007f]/.test(value), 'Invalid session label.');
const capturedText = (bytes: number) => z.string().min(1).max(65536)
  .refine(value => Boolean(value.trim()) && wellFormed(value) && !value.includes('\u0000') && Buffer.byteLength(value, 'utf8') <= bytes,
    `Content must be valid nonempty Unicode and at most ${bytes} UTF-8 bytes; preserve it exactly.`);
const role = z.enum(['HUMAN', 'ASSISTANT', 'TOOL', 'SYSTEM']);
const sessionShape = { id: identifier, sourceId: identifier, label, createdAt: timestamp, closedAt: timestamp.nullable(), nextSequence: positive };
export const contextSessionSchema = z.object(sessionShape);
export const contextSessionCreatedSchema = z.object({ ...sessionShape, duplicate: z.boolean() });
export const createContextSessionInputSchema = z.object({ label, projectId: identifier.optional(), clientSessionId: identifier.optional() }).strict();
export const contextSessionsInputSchema = z.object({ ...pageInput, projectId: identifier.optional() }).strict();
export const contextSessionIdInputSchema = z.object({ sessionId: identifier }).strict();
export const getContextSessionInputSchema = z.object({ sessionId: identifier, ...pageInput }).strict();
export const contextSessionsSchema = z.object({ sessions: z.array(contextSessionSchema).max(100), nextCursor: cursor.nullable() })
  .refine(page => new Set(page.sessions.map(session => session.id)).size === page.sessions.length && (page.nextCursor === null || page.sessions.length > 0), 'Invalid session page.');
export const contextEventSchema = z.object({
  id: identifier, sessionId: identifier, sourceId: identifier, sequence: positive,
  clientEventId: identifier, role, content: capturedText(32768), createdAt: timestamp,
});
export const contextEventsSchema = z.object({ events: z.array(contextEventSchema).max(100), nextCursor: cursor.nullable(), throughSequence: count })
  .refine(page => page.events.every((event, index) => event.sequence <= page.throughSequence && (!index || event.sequence > page.events[index - 1].sequence)) &&
    new Set(page.events.map(event => event.id)).size === page.events.length && (page.nextCursor === null || page.events.length > 0), 'Invalid event order or page.');
export const contextSessionPageSchema = z.object({ session: contextSessionSchema, transcript: contextEventsSchema });
export const appendContextSessionInputSchema = z.object({ sessionId: identifier, clientEventId: identifier, role, content: capturedText(32768) }).strict();
export const contextEventAdmissionSchema = z.object({ event: contextEventSchema, duplicate: z.boolean(), materialization: z.literal('queued') });
const declaredKind = z.enum(['FACT', 'DECISION', 'CONCLUSION']);
export const declarationOriginInputSchema = z.object({ rawType: contextRawTypeSchema, rawId: identifier, revision: positive, startUtf16: count, endUtf16: positive }).strict()
  .refine(origin => origin.endUtf16 > origin.startUtf16, 'Declared citations must be nonempty exact UTF-16 spans.');
export const createContextDeclarationInputSchema = z.object({
  clientDeclarationId: identifier, sourceId: identifier, kind: declaredKind,
  content: capturedText(24000), origins: z.array(declarationOriginInputSchema).min(1).max(32),
}).strict().refine(input => new Set(input.origins.map(origin => JSON.stringify(origin))).size === input.origins.length, 'Duplicate origins are not allowed.');
export const contextDeclarationIdInputSchema = z.object({ declarationId: identifier }).strict();
const declarationShape = { id: identifier, itemId: identifier, sourceId: identifier, kind: declaredKind, method: z.literal('declared'), createdAt: timestamp };
export const contextDeclarationAdmissionSchema = z.object({ ...declarationShape, materialization: z.literal('queued'), duplicate: z.boolean() });
export const contextDeclarationSchema = z.object({ ...declarationShape, content: capturedText(24000), createdByUserId: identifier, origins: contextOriginsSchema, state: z.enum(['current', 'stale', 'forgotten']) });
export const contextRawOriginInputSchema = z.object({ rawType: contextRawTypeSchema, rawId: identifier, revision: positive.max(999999999) }).strict();
export const contextRawOriginSchema = z.object({
  rawType: contextRawTypeSchema, rawId: identifier, sourceId: identifier, revision: positive,
  sequence: count, content: z.string().refine(value => wellFormed(value) && Buffer.byteLength(value, 'utf8') <= 1048576),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: timestamp,
});
export const contextKnowledgeStatusSchema = z.object({
  pipelineVersion: z.literal(1), method: z.literal('first_party_extractive'),
  raw: z.object({ sessionEvents: count, sessionEventBytes: count, messageRevisions: count, messageRevisionBytes: count, pendingMessageHydration: count, declarations: count, declarationBytes: count }),
  summaries: z.object({ current: count, stale: count, forgotten: count }),
  queue: z.object({ pending: count, running: count, failed: count, completed: count, suppressed: count,
    oldestPendingAgeMs: count, completionP95Ms: count, completedHistoryRetentionDays: z.literal(7) }),
});
export const contextStatusSchema = z.object({
  semantic: z.object({ state: z.enum(['disabled', 'warming', 'ready', 'degraded', 'stopped']),
    reason: z.string().min(1).optional(), modelKey: z.string().min(1).optional(), dimensions: positive.optional() }),
  queue: z.partialRecord(z.enum(['PENDING', 'RUNNING', 'DONE', 'SUPERSEDED', 'FAILED', 'DEFERRED_QUOTA', 'SKIPPED_OVER_BUDGET']), count).optional(),
  index: z.object({ items: count, chunks: count }).optional(),
  budget: z.object({ usedTokens: count, storedChunks: count, dailyTokenLimit: count, chunkLimit: count }).optional(),
  metrics: z.record(z.string(), count).optional(),
  diagnostics: z.object({ queuedQueries: count, queuedIndex: count, restartCount: count, rssBytes: count.nullable(),
    memoryLimitBytes: positive.nullable(), availableMemoryBytes: count.nullable() }).optional(),
  knowledge: contextKnowledgeStatusSchema.optional(),
});
export const contextSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(2000), debateId: identifier.optional(),
  sourceIds: z.array(identifier).min(1).max(100).refine(ids => new Set(ids).size === ids.length).optional(),
  kinds: z.array(contextKindSchema).max(5).optional(), limit: z.number().int().min(1).max(10).optional(),
}).strict().refine(input => input.debateId === undefined || input.sourceIds === undefined, 'Choose debateId or sourceIds, never both.');

export type CreateContextSessionInput = z.infer<typeof createContextSessionInputSchema>;
export type ContextSessionsInput = z.infer<typeof contextSessionsInputSchema>;
export type GetContextSessionInput = z.infer<typeof getContextSessionInputSchema>;
export type AppendContextSessionInput = z.infer<typeof appendContextSessionInputSchema>;
export type CreateContextDeclarationInput = z.infer<typeof createContextDeclarationInputSchema>;
export type ContextRawOriginInput = z.infer<typeof contextRawOriginInputSchema>;
