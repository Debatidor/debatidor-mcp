import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { DebatidorApiClient } from '../src/debatidor-api.js';
import { createDebatidorServer } from '../src/server.js';

export const date = '2026-09-08T10:00:00.000Z';
export const session = { id: 'ctxsession:one', sourceId: 'ctxsrc:session:one', label: 'Private capture', createdAt: date, closedAt: null, nextSequence: 1 };
export const event = { id: 'ctxevent:one', sessionId: session.id, sourceId: session.sourceId, sequence: 1, clientEventId: 'event-1', role: 'ASSISTANT' as const, content: 'Evidencia 🧠 exacta.', createdAt: date };
export const origin = { rawType: 'SESSION_EVENT' as const, rawId: event.id, revision: 1, startUtf16: 0, endUtf16: event.content.length };
export const declarationInput = { clientDeclarationId: 'declaration-1', sourceId: session.sourceId, kind: 'DECISION' as const, content: 'Decisión declarada.', origins: [origin] };
export const admission = { id: 'ctxdecl:one', itemId: 'ctx:declaration:ctxdecl:one', sourceId: session.sourceId, kind: 'DECISION', method: 'declared', createdAt: date, materialization: 'queued', duplicate: false };
export const declaration = { id: admission.id, itemId: admission.itemId, sourceId: session.sourceId, kind: 'DECISION', method: 'declared', createdAt: date, content: declarationInput.content, createdByUserId: 'owner', origins: [{ ...origin, sourceId: session.sourceId }], state: 'current' };
export const raw = { rawType: origin.rawType, rawId: origin.rawId, sourceId: session.sourceId, revision: 1, sequence: 1, content: event.content, contentHash: createHash('sha256').update(event.content).digest('hex'), createdAt: date };
export const knowledge = { pipelineVersion: 1, method: 'first_party_extractive', raw: { sessionEvents: 1, sessionEventBytes: 21, messageRevisions: 0, messageRevisionBytes: 0, pendingMessageHydration: 0, declarations: 1, declarationBytes: 22 }, summaries: { current: 1, stale: 0, forgotten: 0 }, queue: { pending: 0, running: 0, failed: 0, completed: 3, suppressed: 0, oldestPendingAgeMs: 0, completionP95Ms: 120, completedHistoryRetentionDays: 7 } };
export const status = { semantic: { state: 'disabled', modelKey: 'model-fixture', dimensions: 384 }, queue: {}, index: { items: 0, chunks: 0 }, knowledge };
export const derived = { id: 'summary:one', sourceId: session.sourceId, debateId: null, kind: 'SUMMARY', content: 'Exact source quote.', createdAt: date,
  provenance: { messageId: null, sourceRevision: 1, originType: 'SUMMARY_WINDOW', originId: 'summary:one', origins: [{ ...origin, sourceId: session.sourceId }, { ...origin, rawId: 'ctxevent:unquoted', sourceId: session.sourceId, startUtf16: 0, endUtf16: 0 }] },
  derivation: { method: 'extractive', pipelineVersion: 1, coverage: { inputRecordCount: 2, quotedRecordCount: 1, inputTruncated: true } } };
export const search = { hits: [{ ...derived, score: 0.5, semanticSimilarity: null }], retrieval: { method: 'text', semanticStatus: 'unavailable' }, partial: false };
export const response = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { 'content-type': 'application/json' } });
export const apiWith = (fetcher: typeof fetch) => new DebatidorApiClient('https://api.test', { type: 'bearer', token: 'synthetic_knowledge_token' }, fetcher);
export async function withClient(api: DebatidorApiClient, run: (client: Client) => Promise<void>) {
  const handler = createMcpHandler(() => createDebatidorServer({ api, publicBaseUrl: 'https://mcp.test' }));
  const client = new Client({ name: 'context-knowledge-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) }));
    await run(client);
  } finally { await client.close(); await handler.close(); }
}
