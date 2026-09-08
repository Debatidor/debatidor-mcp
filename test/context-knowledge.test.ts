import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalContextSearchSchema, contextHitSchema, contextDerivationSchema, contextOriginsSchema } from '../src/context-contracts.js';
import { contextEntrySchema, contextItemSchema } from '../src/context-governance-contracts.js';
import { contextStatusSchema } from '../src/context-knowledge-contracts.js';
import { admission, apiWith, date, declaration, declarationInput, derived, event, knowledge, origin, raw, response, search, session, status, withClient } from './context-knowledge-fixture.js';

test('session mutations preserve explicit bytes, roles and caller ids; duplicate status must agree and no request is retried', async () => {
  let payload: unknown = { ...session, duplicate: false, internal: 'hidden' };
  let code = 201;
  const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
  const api = apiWith(async (url, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic_knowledge_token');
    calls.push({ path: new URL(String(url)).pathname, method: init?.method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return response(payload, code);
  });
  assert.deepEqual(await api.createContextSession({ label: ` ${session.label} `, clientSessionId: 'create-1' }), { ...session, duplicate: false });
  payload = { event, duplicate: false, materialization: 'queued' };
  assert.deepEqual(await api.appendContextSession({ sessionId: session.id, clientEventId: event.clientEventId, role: event.role, content: event.content }), payload);
  code = 200; payload = { event, duplicate: true, materialization: 'queued' };
  assert.deepEqual(await api.appendContextSession({ sessionId: session.id, clientEventId: event.clientEventId, role: event.role, content: event.content }), payload);
  payload = { ...session, nextSequence: 2, closedAt: date };
  assert.deepEqual(await api.closeContextSession(session.id), payload);
  assert.deepEqual(calls.map(call => call.path), ['/context/sessions', '/context/sessions/ctxsession%3Aone/events', '/context/sessions/ctxsession%3Aone/events', '/context/sessions/ctxsession%3Aone/close']);
  assert.deepEqual(calls[0].body, { label: session.label, clientSessionId: 'create-1' });
  assert.deepEqual(calls[1].body, { clientEventId: event.clientEventId, role: event.role, content: event.content });
  payload = { ...session, duplicate: false }; code = 200;
  await assert.rejects(() => api.createContextSession({ label: session.label }), /context_response_invalid/);
  assert.equal(calls.length, 5);
});

test('strict session response parsers reject wrong identity, changed raw content, oversized payloads and malformed snapshots', async () => {
  let payload: unknown;
  let code = 201;
  const api = apiWith(async () => response(payload, code));
  for (const bad of [
    { ...session, label: 'wrong', duplicate: false }, { ...session, nextSequence: 2, duplicate: false },
    { ...session, closedAt: date, duplicate: false }, { ...session, duplicate: true },
    { ...session, createdAt: 'bad', duplicate: false },
  ]) { payload = bad; await assert.rejects(() => api.createContextSession({ label: session.label }), /context_response_invalid/); }
  for (const bad of [
    { ...event, sessionId: 'foreign' }, { ...event, role: 'HUMAN' }, { ...event, content: 'changed' },
    { ...event, clientEventId: 'other' }, { ...event, sequence: 0 }, { ...event, content: '🧠'.repeat(9000) },
  ]) {
    payload = { event: bad, duplicate: false, materialization: 'queued' };
    await assert.rejects(() => api.appendContextSession({ sessionId: session.id, clientEventId: event.clientEventId, role: event.role, content: event.content }), /context_response_invalid/);
  }
  code = 200;
  for (const bad of [{ ...session, id: 'other', closedAt: date }, session]) {
    payload = bad; await assert.rejects(() => api.closeContextSession(session.id), /context_response_invalid/);
  }
});

test('session listing and two-read transcripts bind identity, source, page order and revocation without exposing partial data', async () => {
  const calls: string[] = [];
  let transcript: unknown = { events: [event], nextCursor: null, throughSequence: 1 };
  let denied = false;
  const api = apiWith(async url => {
    const path = String(url); calls.push(path);
    if (path.includes('/events')) return response(transcript);
    if (path.includes('ctxsession%3Aone')) return denied ? response({ message: 'context_session_not_found', internal: event.content }, 404) : response({ ...session, nextSequence: 2 });
    return response({ sessions: [session], nextCursor: null });
  });
  assert.deepEqual(await api.listContextSessions({ projectId: 'project:a/b', limit: 1 }), { sessions: [session], nextCursor: null });
  assert.equal(calls[0], 'https://api.test/context/sessions?limit=1&projectId=project%3Aa%2Fb');
  assert.deepEqual(await api.getContextSession({ sessionId: session.id, limit: 1 }), { session: { ...session, nextSequence: 2 }, transcript });
  for (const bad of [
    { events: [event], nextCursor: 'c2FtZQ', throughSequence: 1 },
    { events: [{ ...event, sourceId: 'foreign' }], nextCursor: null, throughSequence: 1 },
    { events: [event, event], nextCursor: null, throughSequence: 1 },
    { events: [event], nextCursor: null, throughSequence: 0 },
    { events: [], nextCursor: 'bmV4dA', throughSequence: 1 },
    { events: [event], nextCursor: null, throughSequence: 2 },
  ]) {
    transcript = bad;
    await assert.rejects(() => api.getContextSession({ sessionId: session.id, limit: 1, cursor: 'c2FtZQ' }), /context_response_invalid/);
  }
  transcript = { events: [event], nextCursor: null, throughSequence: 1 }; denied = true;
  await withClient(api, async client => {
    const result = await client.callTool({ name: 'debatidor_get_context_session', arguments: { sessionId: session.id } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /unavailable/);
    assert.doesNotMatch(JSON.stringify(result), /Evidencia|Private capture|synthetic_knowledge_token/);
    assert.equal(result.structuredContent, undefined);
  });
});

test('declared assertions validate response identity and exact historical raw hashes without manufacturing factual verification', async () => {
  let payload: unknown = admission;
  let code = 201;
  const api = apiWith(async () => response(payload, code));
  assert.deepEqual(await api.createContextDeclaration(declarationInput), admission);
  for (const bad of [{ ...admission, sourceId: 'foreign' }, { ...admission, kind: 'FACT' }, { ...admission, itemId: 'foreign' }, { ...admission, method: 'inferred' }, { ...admission, duplicate: true }]) {
    payload = bad; await assert.rejects(() => api.createContextDeclaration(declarationInput), /context_response_invalid/);
  }
  code = 200; payload = { ...admission, duplicate: true };
  assert.deepEqual(await api.createContextDeclaration(declarationInput), payload);
  payload = declaration;
  assert.deepEqual(await api.getContextDeclaration(admission.id), declaration);
  for (const bad of [{ ...declaration, id: 'other' }, { ...declaration, origins: null }, { ...declaration, origins: [{ ...origin, sourceId: 'foreign' }] }, { ...declaration, origins: [{ ...origin, sourceId: session.sourceId, endUtf16: 0 }] }]) {
    payload = bad; await assert.rejects(() => api.getContextDeclaration(admission.id), /context_response_invalid/);
  }
  payload = raw;
  assert.deepEqual(await api.getContextRawOrigin({ rawType: origin.rawType, rawId: origin.rawId, revision: 1 }), raw);
  for (const bad of [{ ...raw, revision: 2 }, { ...raw, content: 'changed' }, { ...raw, rawId: 'other' }, { ...raw, contentHash: '0'.repeat(64) }]) {
    payload = bad; await assert.rejects(() => api.getContextRawOrigin({ rawType: origin.rawType, rawId: origin.rawId, revision: 1 }), /context_response_invalid/);
  }
});

test('search, item and export parsers retain multi-origin provenance, empty considered spans and derivation while rejecting null or invalid metadata', async () => {
  let payload: unknown = search;
  let body: unknown;
  const api = apiWith(async (_url, init) => { body = init?.body && JSON.parse(String(init.body)); return response(payload); });
  const result = await api.searchContext({ query: ' quote ', sourceIds: [session.sourceId], kinds: ['SUMMARY'] });
  assert.deepEqual(result.hits[0].provenance.origins, derived.provenance.origins);
  assert.deepEqual(result.hits[0].derivation, derived.derivation);
  assert.deepEqual(body, { query: 'quote', sourceIds: [session.sourceId], kinds: ['SUMMARY'] });
  for (const bad of [
    { ...derived, provenance: { ...derived.provenance, origins: null } }, { ...derived, derivation: null },
    { ...derived, provenance: { ...derived.provenance, origins: [] } },
    { ...derived, provenance: { ...derived.provenance, origins: [{ ...origin, sourceId: 'foreign' }] } },
    { ...derived, derivation: { method: 'extractive', pipelineVersion: 2 } },
    { ...derived, derivation: { ...derived.derivation, coverage: { inventedText: 'not a counter' } } },
  ]) {
    payload = { ...search, hits: [{ ...bad, score: 1, semanticSimilarity: null }] };
    await assert.rejects(() => api.searchContext({ query: 'quote' }), /context_response_invalid/);
    payload = { ...bad, canDelete: true };
    await assert.rejects(() => api.getContextItem(derived.id), /context_response_invalid/);
  }
  payload = { ...derived, canDelete: true };
  assert.deepEqual((await api.getContextItem(derived.id)).derivation, derived.derivation);
  payload = { id: 'export:one', schemaVersion: 1, scope: { type: 'user' }, format: 'json', itemCount: 1, pageCount: 1, expiresAt: date, entries: [derived], nextCursor: null, markdown: null };
  assert.deepEqual((await api.readContextExport({ exportId: 'export:one' })).entries[0].provenance.origins, derived.provenance.origins);
  payload = search;
  await assert.rejects(() => api.searchContext({ query: 'quote', sourceIds: ['foreign'] }), /context_response_invalid/);
  assert.equal(contextOriginsSchema.safeParse([{ ...origin, sourceId: session.sourceId, startUtf16: 5, endUtf16: 4 }]).success, false);
  assert.equal(contextOriginsSchema.safeParse(Array.from({ length: 33 }, () => ({ ...origin, sourceId: session.sourceId }))).success, false);
  assert.equal(contextDerivationSchema.safeParse({ method: 'extractive', pipelineVersion: 1, coverage: { n: Number.POSITIVE_INFINITY } }).success, false);
});

test('status preserves operational knowledge counters and legacy absence without passing through raw or secrets', async () => {
  let payload: unknown = { ...status, internal: 'hidden', diagnostics: { queuedQueries: 0, queuedIndex: 0, restartCount: 0, rssBytes: null, memoryLimitBytes: null, availableMemoryBytes: null } };
  const api = apiWith(async () => response(payload));
  assert.deepEqual((await api.getContextStatus()).knowledge, knowledge);
  assert.doesNotMatch(JSON.stringify(await api.getContextStatus()), /hidden/);
  payload = { ...status, queue: { PENDING: 1, DEFERRED_QUOTA: 2, SKIPPED_OVER_BUDGET: 3 } };
  assert.deepEqual((await api.getContextStatus()).queue, { PENDING: 1, DEFERRED_QUOTA: 2, SKIPPED_OVER_BUDGET: 3 });
  payload = { ...status, budget: { usedTokens: 0, storedChunks: 0, dailyTokenLimit: 0, chunkLimit: 0 } };
  assert.deepEqual((await api.getContextStatus()).budget, { usedTokens: 0, storedChunks: 0, dailyTokenLimit: 0, chunkLimit: 0 });
  payload = { semantic: { state: 'disabled' } };
  assert.deepEqual(await api.getContextStatus(), payload);
  for (const bad of [null, { ...knowledge, raw: { ...knowledge.raw, declarations: -1 } }, { ...knowledge, queue: { ...knowledge.queue, pending: '1' } }]) {
    payload = { ...status, knowledge: bad };
    await assert.rejects(() => api.getContextStatus(), /context_response_invalid/);
  }
  assert.equal(contextStatusSchema.safeParse({ ...status, knowledge: { ...knowledge, method: 'generative' } }).success, false);
});

test('every canonical, MCP hit and full-entry schema binds origin sources, distinct citations and derivation kind', () => {
  const valid = (entry: Record<string, unknown>, expected: boolean) => {
    assert.equal(contextEntrySchema.safeParse(entry).success, expected);
    assert.equal(contextItemSchema.safeParse({ ...entry, canDelete: true }).success, expected);
    const hit = { ...entry, score: 1, semanticSimilarity: null };
    assert.equal(canonicalContextSearchSchema.safeParse({ ...search, hits: [hit] }).success, expected);
    assert.equal(contextHitSchema.safeParse({ ...hit, similarity: 0, retrievalMethod: 'text' }).success, expected);
  };
  for (const method of ['verbatim', 'extractive', 'declared']) for (const kind of ['MESSAGE', 'SUMMARY', 'FACT', 'DECISION', 'CONCLUSION']) {
    valid({ ...derived, kind, derivation: { method, pipelineVersion: 1 } },
      method === 'verbatim' ? kind === 'MESSAGE' : method === 'extractive' ? kind === 'SUMMARY' : ['FACT', 'DECISION', 'CONCLUSION'].includes(kind));
  }
  const exact = { ...origin, sourceId: session.sourceId };
  valid({ ...derived, provenance: { ...derived.provenance, origins: [exact, exact] } }, false);
  valid({ ...derived, provenance: { ...derived.provenance, origins: [{ ...exact, sourceId: 'foreign' }] } }, false);
  valid({ ...derived, provenance: { ...derived.provenance, origins: [exact, { ...exact, endUtf16: 0 }] } }, true);
  const { derivation: _derived, ...legacy } = derived;
  for (const kind of ['MESSAGE', 'SUMMARY', 'FACT', 'DECISION', 'CONCLUSION']) valid({ ...legacy, kind }, true);
});

test('SDK schemas reject unsafe, ambiguous or oversized inputs before backend calls and advertise all nine tools accurately', async () => {
  let calls = 0;
  await withClient(apiWith(async () => { calls++; return response({}); }), async client => {
    const invalid: Array<[string, Record<string, unknown>]> = [
      ['search_context', { query: 'test', debateId: 'arena', sourceIds: ['source'] }], ['search_context', { query: 'test', sourceIds: [] }],
      ['create_context_session', { label: '' }], ['create_context_session', { label: 'x', ownerUserId: 'other' }],
      ['append_context_session', { sessionId: session.id, role: 'HUMAN', content: 'x' }],
      ['append_context_session', { sessionId: session.id, clientEventId: 'x', role: 'AUTO', content: 'x' }],
      ['append_context_session', { sessionId: session.id, clientEventId: 'x', role: 'HUMAN', content: '🧠'.repeat(8193) }],
      ['append_context_session', { sessionId: session.id, clientEventId: 'x', role: 'HUMAN', content: '\ud800' }],
      ['create_context_declaration', { ...declarationInput, clientDeclarationId: undefined }],
      ['create_context_declaration', { ...declarationInput, origins: [{ ...origin, endUtf16: 0 }] }],
      ['create_context_declaration', { ...declarationInput, origins: [origin, origin] }],
      ['create_context_declaration', { ...declarationInput, origins: [{ ...origin, sourceId: 'injected' }] }],
      ['get_context_session', { sessionId: session.id, limit: 101 }], ['get_context_raw_origin', { rawType: 'OTHER', rawId: 'x', revision: 1 }],
    ];
    for (const [name, args] of invalid) assert.equal((await client.callTool({ name: `debatidor_${name}`, arguments: args })).isError, true, name);
    assert.equal(calls, 0);
    const { tools } = await client.listTools();
    for (const name of ['list_context_sessions', 'get_context_session', 'get_context_declaration', 'get_context_raw_origin', 'get_context_status']) {
      assert.deepEqual(tools.find(tool => tool.name === `debatidor_${name}`)?.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    }
    for (const name of ['append_context_session', 'create_context_declaration']) assert.equal(tools.find(tool => tool.name === `debatidor_${name}`)?.annotations?.idempotentHint, true);
    assert.equal(tools.find(tool => tool.name === 'debatidor_create_context_session')?.annotations?.idempotentHint, false);
    assert.equal(tools.find(tool => tool.name === 'debatidor_close_context_session')?.annotations?.destructiveHint, true);
  });
});

test('conflicts, inaccessible sources and uncertain mutation failures stay sanitized and never retry automatically', async () => {
  let calls = 0;
  let code = 'context_event_id_conflict';
  let http = 409;
  await withClient(apiWith(async () => { calls++; return response({ message: code, internal: 'SECRET_RAW_TOKEN' }, http); }), async client => {
    const args = { sessionId: session.id, clientEventId: event.clientEventId, role: event.role, content: event.content };
    for (const [upstream, statusCode, pattern] of [
      ['context_event_id_conflict', 409, /different content/], ['context_session_not_found', 404, /unavailable/],
      ['context_origin_stale', 409, /no longer current/], ['unknown', 503, /503/],
    ] as const) {
      code = upstream; http = statusCode;
      const result = await client.callTool({ name: 'debatidor_append_context_session', arguments: args });
      assert.equal(result.isError, true); assert.match(JSON.stringify(result.content), pattern);
      assert.match(JSON.stringify(result.content), /No automatic retry/);
      assert.doesNotMatch(JSON.stringify(result), /SECRET_RAW_TOKEN|synthetic_knowledge_token/);
    }
    assert.equal(calls, 4);
  });
});
