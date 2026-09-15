import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { DebatidorApiClient } from '../src/debatidor-api.js';
import { createDebatidorServer } from '../src/server.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

test('graph tools cross real HTTP MCP and API transports with explicit grants, one-page lists, conflict and revocation', async () => {
  const date = '2026-09-15T10:00:00.000Z';
  const reader = 'ctxsession:reader/a';
  const source = 'ctxsession:source';
  const created = {
    id: 'ctxedge:001', readerSessionId: reader, sourceSessionId: source,
    views: ['recent', 'transcript'], maxEvents: 2, createdAt: date,
    expiresAt: '2026-09-15T10:01:00.000Z', revokedAt: null as string | null,
  };
  const historical = {
    ...created, id: 'ctxedge:002', sourceSessionId: 'ctxsession:earlier',
    views: ['summary'], revokedAt: '2026-09-15T10:00:30.000Z',
  };
  const nextCursor = Buffer.from(JSON.stringify({ readerId: reader, after: created.id })).toString('base64url');
  const grant = {
    readerSessionId: reader, sourceSessionId: source, views: created.views,
    maxEvents: 2, ttlSeconds: 60, clientEdgeId: 'remote-explicit-grant',
  };
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const errors: unknown[] = [];
  let creationSeen = false;
  let denyReader = false;
  const backend = createServer((request, response) => {
    void (async () => {
      assert.equal(request.headers.authorization, 'Bearer synthetic_remote_graph');
      assert.equal(request.headers['x-api-key'], undefined);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      const body: unknown = text ? JSON.parse(text) : undefined;
      const url = new URL(request.url ?? '/', 'http://synthetic.local');
      requests.push({ method: request.method ?? '', path: url.pathname + url.search, ...(body === undefined ? {} : { body }) });
      let payload: unknown;
      if (denyReader || url.pathname.includes('ctxsession%3Aforeign')) {
        response.statusCode = 404;
        payload = { message: 'context_graph_session_not_found', detail: 'private-owner-data', token: 'dctx1_private' };
      } else if (url.pathname === '/context/sessions/ctxsession%3Areader%2Fa/edges' && request.method === 'POST') {
        const expected = { sourceSessionId: source, views: created.views, maxEvents: 2, ttlSeconds: 60, clientEdgeId: grant.clientEdgeId };
        if (!isDeepStrictEqual(body, expected)) {
          response.statusCode = 409;
          payload = { message: 'context_graph_edge_id_conflict', detail: 'private-owner-data' };
        } else {
          response.statusCode = creationSeen ? 200 : 201;
          payload = { ...created, duplicate: creationSeen, credential: 'dctx1_private', secretHash: 'private-owner-data' };
          creationSeen = true;
        }
      } else if (url.pathname === '/context/sessions/ctxsession%3Areader%2Fa/edges' && request.method === 'GET') {
        assert.equal(url.searchParams.get('limit'), '1');
        if (url.searchParams.has('cursor')) {
          assert.equal(url.searchParams.get('cursor'), nextCursor);
          payload = { edges: [historical], nextCursor: null };
        } else payload = { edges: [created], nextCursor };
      } else if (url.pathname === '/context/sessions/ctxsession%3Areader%2Fa/edges/ctxedge%3A001' && request.method === 'DELETE') {
        assert.equal(body, undefined);
        created.revokedAt = '2026-09-15T10:00:31.000Z';
        payload = { revoked: true, credential: 'dctx1_private' };
      } else throw new Error(`Unexpected synthetic backend request: ${request.method} ${url.pathname}`);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(payload));
    })().catch(error => { errors.push(error); response.statusCode = 500; response.end('{}'); });
  });
  let handler: ReturnType<typeof createMcpHandler> | undefined;
  let mcpServer: Server | undefined;
  const client = new Client({ name: 'graph-http-contract-test', version: '1' });
  try {
    const api = new DebatidorApiClient(await listen(backend), { type: 'bearer', token: 'synthetic_remote_graph' });
    handler = createMcpHandler(() => createDebatidorServer({ api, publicBaseUrl: 'http://127.0.0.1' }));
    const nodeHandler = toNodeHandler(handler);
    mcpServer = createServer((request, response) => {
      void nodeHandler(request, response).catch(error => {
        errors.push(error); response.statusCode = 500; response.end();
      });
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${await listen(mcpServer)}/mcp`)));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      assert.doesNotMatch(JSON.stringify(result), /dctx1_private|private-owner-data|synthetic_remote_graph/);
      return result.structuredContent as Record<string, unknown>;
    };
    assert.deepEqual(await call('debatidor_create_context_edge', grant), { ...created, duplicate: false });
    assert.equal(requests.length, 1);
    assert.deepEqual(await call('debatidor_create_context_edge', grant), { ...created, duplicate: true });
    assert.equal(requests.length, 2);
    const conflict = await client.callTool({
      name: 'debatidor_create_context_edge', arguments: { ...grant, views: ['summary'] },
    });
    assert.equal(conflict.isError, true);
    assert.match(JSON.stringify(conflict.content), /clientEdgeId.*No automatic retry was attempted/);
    assert.equal(conflict.structuredContent, undefined);
    assert.equal(requests.length, 3);
    const first = await call('debatidor_list_context_edges', { readerSessionId: reader, limit: 1 });
    assert.deepEqual(first, { edges: [created], nextCursor });
    assert.equal(requests.length, 4);
    const second = await call('debatidor_list_context_edges', { readerSessionId: reader, limit: 1, cursor: first.nextCursor });
    assert.deepEqual(second, { edges: [historical], nextCursor: null });
    assert.equal(requests.length, 5);
    const foreign = await client.callTool({
      name: 'debatidor_list_context_edges', arguments: { readerSessionId: 'ctxsession:foreign' },
    });
    assert.equal(foreign.isError, true);
    assert.match(JSON.stringify(foreign.content), /unavailable/);
    assert.doesNotMatch(JSON.stringify(foreign), /private-owner-data|dctx1_private/);
    assert.deepEqual(await call('debatidor_revoke_context_edge', { readerSessionId: reader, edgeId: created.id }), { revoked: true });
    assert.deepEqual(await call('debatidor_revoke_context_edge', { readerSessionId: reader, edgeId: created.id }), { revoked: true });
    assert.deepEqual((await call('debatidor_list_context_edges', { readerSessionId: reader, limit: 1 })).edges, [created]);
    denyReader = true;
    const revokedScope = await client.callTool({
      name: 'debatidor_list_context_edges', arguments: { readerSessionId: reader, limit: 1, cursor: nextCursor },
    });
    assert.equal(revokedScope.isError, true);
    assert.equal(revokedScope.structuredContent, undefined);
    assert.match(JSON.stringify(revokedScope.content), /unavailable/);
    assert.equal(requests.length, 10);
    assert.equal(requests.filter(request => request.method === 'POST').length, 3);
    assert.equal(requests.filter(request => request.method === 'DELETE').length, 2);
    assert.ok(requests.every(request => /\/edges(?:\/|\?|$)/.test(request.path)));
    assert.deepEqual(errors, []);
  } finally {
    await client.close().catch(() => undefined);
    await handler?.close();
    if (mcpServer) await close(mcpServer);
    await close(backend);
  }
});
