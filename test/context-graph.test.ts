import assert from 'node:assert/strict';
import test from 'node:test';
import { DebatidorApiClient } from '../src/debatidor-api.js';
import {
  createContextEdgeInputSchema, listContextEdgesInputSchema, revokeContextEdgeInputSchema,
  decodeContextEdgeCursor,
} from '../src/context-graph-contracts.js';
import { apiWith, response, withClient } from './context-knowledge-fixture.js';

const date = '2026-09-15T10:00:00.000Z';
const expiresAt = '2026-09-15T11:00:00.000Z';
const edge = {
  id: 'ctxedge:001', readerSessionId: 'ctxsession:reader/a', sourceSessionId: 'ctxsession:source',
  views: ['summary', 'recent'] as const, maxEvents: 50, createdAt: date, expiresAt, revokedAt: null,
};
const input = {
  readerSessionId: edge.readerSessionId, sourceSessionId: edge.sourceSessionId,
  views: ['recent', 'summary'] as Array<'recent' | 'summary'>, clientEdgeId: 'edge-1',
};
const cursor = (after: string, readerId = edge.readerSessionId) =>
  Buffer.from(JSON.stringify({ readerId, after })).toString('base64url');

test('graph grants preserve exact identities, explicit views, defaults and idempotent HTTP status without retries', async () => {
  let body: unknown = { ...edge, duplicate: false, credential: 'dctx1_hidden', ownerUserId: 'hidden' };
  let status = 201;
  const requests: Array<{ url: string; method?: string; body: unknown }> = [];
  const api = apiWith(async (url, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic_knowledge_token');
    assert.equal(new Headers(init?.headers).get('x-api-key'), null);
    requests.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return response(body, status);
  });
  assert.deepEqual(await api.createContextEdge(input), { ...edge, duplicate: false });
  assert.deepEqual(requests[0], {
    url: 'https://api.test/context/sessions/ctxsession%3Areader%2Fa/edges', method: 'POST',
    body: { sourceSessionId: input.sourceSessionId, views: input.views, clientEdgeId: input.clientEdgeId },
  });
  body = { ...edge, duplicate: true }; status = 200;
  assert.deepEqual(await api.createContextEdge(input), body);
  body = { ...edge, duplicate: true, revokedAt: expiresAt };
  assert.deepEqual(await api.createContextEdge(input), body);
  body = { ...edge, duplicate: false, maxEvents: 1, expiresAt: '2026-09-15T10:00:01.000Z' }; status = 201;
  assert.deepEqual(await api.createContextEdge({ ...input, maxEvents: 1, ttlSeconds: 1 }), body);
  assert.equal(requests.length, 4);
});

test('graph rejects malformed requests and identity or credential injection before any HTTP request', async () => {
  let calls = 0;
  const api = apiWith(async () => { calls++; return response({}); });
  const bad = [
    { ...input, readerSessionId: input.sourceSessionId }, { ...input, views: [] },
    { ...input, views: ['recent', 'recent'] }, { ...input, views: ['all'] },
    { ...input, maxEvents: 51 }, { ...input, maxEvents: 0 }, { ...input, maxEvents: 1.5 },
    { ...input, ttlSeconds: 86401 }, { ...input, ttlSeconds: 0 }, { ...input, ttlSeconds: '60' },
    { ...input, clientEdgeId: '' }, { ...input, readerSessionId: '..' },
    { ...input, sourceSessionId: ' trailing ' }, { ...input, sourceSessionId: '\ud800' },
    { ...input, clientEdgeId: 'newline\n' }, { ...input, readerSessionId: 'x'.repeat(501) },
    { ...input, ownerUserId: 'someone' }, { ...input, workspaceId: 'foreign' },
    { ...input, token: 'dctx1_secret' }, { ...input, delegateId: 'someone' },
    { ...input, scope: 'workspace' },
  ];
  for (const value of bad) {
    assert.equal(createContextEdgeInputSchema.safeParse(value).success, false);
    await assert.rejects(() => api.createContextEdge(value as typeof input));
  }
  assert.equal(listContextEdgesInputSchema.safeParse({ readerSessionId: input.readerSessionId, limit: 101 }).success, false);
  assert.equal(revokeContextEdgeInputSchema.safeParse({ readerSessionId: input.readerSessionId, edgeId: edge.id, sourceSessionId: edge.sourceSessionId }).success, false);
  await withClient(api, async client => {
    const result = await client.callTool({ name: 'debatidor_create_context_edge', arguments: { ...input, ownerUserId: 'someone' } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
  });
  assert.equal(calls, 0);
});

test('graph refuses upstream identity swaps, broader grants, lifetime changes and contradictory completion status', async () => {
  let payload: unknown;
  let status = 201;
  let calls = 0;
  const api = apiWith(async () => { calls++; return response(payload, status); });
  const invalid = [
    { ...edge, readerSessionId: 'other-reader' }, { ...edge, sourceSessionId: 'other-source' },
    { ...edge, sourceSessionId: edge.readerSessionId }, { ...edge, views: ['transcript'] },
    { ...edge, views: ['summary', 'recent', 'transcript'] }, { ...edge, views: ['summary', 'summary'] },
    { ...edge, maxEvents: 49 }, { ...edge, maxEvents: 51 },
    { ...edge, expiresAt: '2026-09-15T12:00:00.000Z' }, { ...edge, expiresAt: date },
    { ...edge, expiresAt: '2026-09-17T10:00:00.000Z' },
    { ...edge, createdAt: 'invalid-date' }, { ...edge, revokedAt: expiresAt },
  ];
  for (const value of invalid) {
    payload = { ...value, duplicate: false };
    await assert.rejects(() => api.createContextEdge(input), /context_response_invalid/);
  }
  for (const [code, duplicate] of [[200, false], [201, true], [202, false]] as const) {
    status = code; payload = { ...edge, duplicate };
    await assert.rejects(() => api.createContextEdge(input), /context_response_invalid/);
  }
  assert.equal(calls, invalid.length + 3);
});

test('graph list uses exactly one bounded page and binds both input and output cursors to the requested reader', async () => {
  const nextCursor = cursor(edge.id);
  let payload: unknown = { edges: [{ ...edge, secretHash: 'hidden' }], nextCursor, credential: 'dctx1_hidden' };
  const paths: string[] = [];
  const api = apiWith(async url => { paths.push(String(url)); return response(payload); });
  assert.deepEqual(await api.listContextEdges({ readerSessionId: edge.readerSessionId, limit: 1 }), { edges: [edge], nextCursor });
  assert.equal(paths.length, 1);
  assert.equal(paths[0], 'https://api.test/context/sessions/ctxsession%3Areader%2Fa/edges?limit=1');
  const nextEdge = { ...edge, id: 'ctxedge:002', sourceSessionId: 'source:2', revokedAt: expiresAt };
  payload = { edges: [nextEdge], nextCursor: null };
  assert.deepEqual(await api.listContextEdges({ readerSessionId: edge.readerSessionId, cursor: nextCursor, limit: 1 }), payload);
  assert.equal(new URL(paths[1]).searchParams.get('cursor'), nextCursor);
  await assert.rejects(() => api.listContextEdges({ readerSessionId: 'foreign-reader', cursor: nextCursor }));
  assert.equal(paths.length, 2);
});

test('graph cursor parser rejects noncanonical encoding, hidden fields and malformed scope', () => {
  assert.deepEqual(decodeContextEdgeCursor(cursor(edge.id)), { readerId: edge.readerSessionId, after: edge.id });
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const value of [
    '', cursor(edge.id) + '=', 'a'.repeat(2001), '%%', encode(null), encode([]),
    encode({ readerId: edge.readerSessionId }), encode({ readerId: edge.readerSessionId, after: edge.id, ownerUserId: 'other' }),
    encode({ readerId: edge.readerSessionId, after: '..' }), Buffer.from([0xff]).toString('base64url'),
  ]) assert.equal(decodeContextEdgeCursor(value), null);
});

test('graph rejects repeated, oversized, foreign and malformed list pages without leaking partial metadata', async () => {
  let payload: unknown;
  const api = apiWith(async () => response(payload));
  const bad = [
    { edges: [{ ...edge, readerSessionId: 'foreign' }], nextCursor: null },
    { edges: [edge, edge], nextCursor: null },
    { edges: [edge, { ...edge, id: 'ctxedge:002' }], nextCursor: null },
    { edges: [], nextCursor: cursor(edge.id) },
    { edges: [edge], nextCursor: cursor('other-edge') },
    { edges: [edge], nextCursor: cursor(edge.id, 'foreign') },
    { edges: [{ ...edge, views: ['invalid'] }], nextCursor: null },
    { edges: [{ ...edge, revokedAt: '2020-01-01T00:00:00.000Z' }], nextCursor: null },
  ];
  for (const value of bad) {
    payload = value;
    await assert.rejects(() => api.listContextEdges({ readerSessionId: edge.readerSessionId, limit: 1 }), /context_response_invalid/);
  }
  payload = { edges: [edge], nextCursor: cursor(edge.id) };
  await assert.rejects(() => api.listContextEdges({ readerSessionId: edge.readerSessionId, cursor: cursor(edge.id) }), /context_response_invalid/);
  payload = { edges: [{ ...edge, readerSessionId: 'foreign', secret: 'dctx1_hidden' }], nextCursor: null };
  await withClient(api, async client => {
    const result = await client.callTool({ name: 'debatidor_list_context_edges', arguments: { readerSessionId: edge.readerSessionId } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.doesNotMatch(JSON.stringify(result), /foreign|dctx1_hidden/);
  });
});

test('graph revoke targets one encoded reader and edge, strips extra fields and accepts only confirmed HTTP 200', async () => {
  let payload: unknown = { revoked: true, credential: 'dctx1_hidden', rawContent: 'private' };
  let status = 200;
  const requests: Array<{ path: string; method?: string; body?: BodyInit | null }> = [];
  const api = apiWith(async (url, init) => {
    requests.push({ path: String(url), method: init?.method, body: init?.body });
    return response(payload, status);
  });
  const revoke = { readerSessionId: edge.readerSessionId, edgeId: 'ctxedge:one/two' };
  assert.deepEqual(await api.revokeContextEdge(revoke), { revoked: true });
  assert.deepEqual(requests[0], { path: 'https://api.test/context/sessions/ctxsession%3Areader%2Fa/edges/ctxedge%3Aone%2Ftwo', method: 'DELETE', body: undefined });
  payload = { revoked: false };
  await assert.rejects(() => api.revokeContextEdge(revoke), /context_response_invalid/);
  payload = { revoked: true }; status = 202;
  await assert.rejects(() => api.revokeContextEdge(revoke), /context_response_invalid/);
  assert.equal(requests.length, 3);
});

test('graph tool discovery documents direction, limits and revocation, and exposes no capability or delegated-read tool', async () => {
  const api = apiWith(async () => { throw new Error('discovery must not contact the backend'); });
  await withClient(api, async client => {
    const listed = (await client.listTools()).tools;
    const graph = listed.filter(tool => /context_edges?$/.test(tool.name));
    assert.deepEqual(graph.map(tool => tool.name).sort(), [
      'debatidor_create_context_edge', 'debatidor_list_context_edges', 'debatidor_revoke_context_edge',
    ]);
    assert.equal(listed.some(tool => /delegate|capability/.test(tool.name)), false);
    for (const tool of graph) {
      assert.ok(tool.outputSchema);
      assert.ok(tool.description);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.annotations?.openWorldHint, false);
      assert.equal(tool.annotations?.idempotentHint, true);
      const properties = tool.inputSchema.properties as Record<string, { description?: string }>;
      for (const value of Object.values(properties)) assert.ok(value.description);
      for (const field of ['userId', 'workspaceId', 'ownerUserId', 'token', 'capability']) assert.equal(field in properties, false);
    }
    const create = graph.find(tool => tool.name === 'debatidor_create_context_edge')!;
    assert.equal(create.annotations?.readOnlyHint, false);
    assert.match(create.description!, /one-way.*never reverse or transitive/);
    assert.match(create.description!, /86400/);
    assert.match(create.description!, /Never retry automatically/);
    const list = graph.find(tool => tool.name === 'debatidor_list_context_edges')!;
    assert.equal(list.annotations?.readOnlyHint, true);
    assert.match(list.description!, /one metadata page/i);
    const revoke = graph.find(tool => tool.name === 'debatidor_revoke_context_edge')!;
    assert.equal(revoke.annotations?.destructiveHint, true);
    assert.match(revoke.description!, /already received context cannot be removed/);
  });
});

test('graph errors disclose neither backend details nor credentials and never retry uncertain mutations', async () => {
  let status = 409;
  let code = 'context_graph_edge_id_conflict';
  let calls = 0;
  let failTransport = false;
  const api = apiWith(async () => {
    calls++;
    if (failTransport) throw new Error('network dctx1_hidden private-stack');
    return response({ message: code, detail: 'private-stack', token: 'dctx1_hidden' }, status);
  });
  await withClient(api, async client => {
    for (const [errorStatus, errorCode, pattern] of [
      [409, 'context_graph_edge_id_conflict', /clientEdgeId/],
      [409, 'context_graph_edge_exists', /even when it has expired/],
      [404, 'context_graph_session_not_found', /unavailable/],
      [429, 'context_graph_edge_quota', /100/],
      [403, 'context_principal_unavailable', /unavailable/],
      [500, 'unknown_upstream_failure', /failed/],
    ] as const) {
      status = errorStatus; code = errorCode;
      const before = calls;
      const result = await client.callTool({ name: 'debatidor_create_context_edge', arguments: input });
      assert.equal(calls, before + 1);
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.match(JSON.stringify(result.content), pattern);
      assert.match(JSON.stringify(result.content), /No automatic retry was attempted/);
      assert.doesNotMatch(JSON.stringify(result), /private-stack|dctx1_hidden|synthetic_knowledge_token/);
    }
    failTransport = true;
    const before = calls;
    const result = await client.callTool({ name: 'debatidor_revoke_context_edge', arguments: { readerSessionId: edge.readerSessionId, edgeId: edge.id } });
    assert.equal(calls, before + 1);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /do not infer completion/);
    assert.doesNotMatch(JSON.stringify(result), /private-stack|dctx1_hidden/);
  });
});

test('legacy private API-key bridge uses its configured credential without accepting identity fields from graph inputs', async () => {
  let calls = 0;
  const api = new DebatidorApiClient('https://api.test', { type: 'api-key', token: 'deb_live_synthetic_graph' }, async (_url, init) => {
    calls++;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-api-key'), 'deb_live_synthetic_graph');
    assert.equal(headers.get('authorization'), null);
    return response({ edges: [], nextCursor: null });
  });
  assert.deepEqual(await api.listContextEdges({ readerSessionId: edge.readerSessionId }), { edges: [], nextCursor: null });
  assert.equal(calls, 1);
});
