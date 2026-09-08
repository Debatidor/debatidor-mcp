import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { DebatidorApiClient } from '../src/debatidor-api.js';
import { createDebatidorServer } from '../src/server.js';
import { admission, date, declaration, declarationInput, derived, event, origin, raw, search, session, status } from './context-knowledge-fixture.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

test('all nine knowledge tools traverse HTTP MCP and a simulated HTTP Context API, preserving caller ids, citations, pages and denial', async () => {
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const errors: unknown[] = [];
  let captured = false;
  let closed = false;
  let malformed = false;
  const backend = createServer((request, response) => {
    void (async () => {
      assert.equal(request.headers.authorization, 'Bearer synthetic_knowledge_remote');
      assert.equal(request.headers['x-api-key'], undefined);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      const body: unknown = text ? JSON.parse(text) : undefined;
      const url = new URL(request.url ?? '/', 'http://test.local');
      requests.push({ method: request.method ?? '', path: url.pathname + url.search, ...(body === undefined ? {} : { body }) });
      let payload: unknown;
      if (url.pathname === '/context/sessions' && request.method === 'POST') {
        assert.deepEqual(body, { label: session.label, clientSessionId: 'remote-create', projectId: 'project:one' });
        response.statusCode = 201; payload = { ...session, duplicate: false };
      } else if (url.pathname === '/context/sessions') {
        assert.equal(url.searchParams.get('projectId'), 'project:one');
        assert.equal(url.searchParams.get('limit'), '1');
        payload = { sessions: [session], nextCursor: null };
      } else if (url.pathname === '/context/sessions/ctxsession%3Aone/events' && request.method === 'POST') {
        assert.deepEqual(body, { clientEventId: event.clientEventId, role: event.role, content: event.content });
        response.statusCode = captured ? 200 : 201;
        payload = { event, duplicate: captured, materialization: 'queued' }; captured = true;
      } else if (url.pathname === '/context/sessions/ctxsession%3Aone/events') {
        const second = url.searchParams.has('cursor');
        assert.equal(url.searchParams.get('limit'), '1');
        if (second) assert.equal(url.searchParams.get('cursor'), 'cGFnZTI');
        payload = { events: [second ? { ...event, id: 'ctxevent:two', sequence: 2, clientEventId: 'event-2' } : event], throughSequence: 2, nextCursor: second ? null : 'cGFnZTI' };
      } else if (url.pathname === '/context/sessions/ctxsession%3Aone/close') {
        assert.equal(request.method, 'POST'); closed = true;
        payload = { ...session, nextSequence: 3, closedAt: date };
      } else if (url.pathname === '/context/sessions/ctxsession%3Aone') {
        payload = { ...session, nextSequence: 3, closedAt: closed ? date : null };
      } else if (url.pathname === '/context/declarations' && request.method === 'POST') {
        assert.deepEqual(body, declarationInput); response.statusCode = 201; payload = admission;
      } else if (url.pathname === '/context/declarations/ctxdecl%3Aone') {
        payload = malformed ? { ...declaration, origins: null } : declaration;
      } else if (url.pathname === '/context/origins/SESSION_EVENT/ctxevent%3Aone/revisions/1') {
        payload = raw;
      } else if (url.pathname === '/context/status') {
        payload = status;
      } else if (url.pathname === '/context/search') {
        assert.deepEqual(body, { query: 'quote', sourceIds: [session.sourceId], kinds: ['SUMMARY'] });
        payload = search;
      } else if (url.pathname === '/context/sessions/ctxsession%3Aforeign/events') {
        response.statusCode = 404; payload = { message: 'context_session_not_found', details: 'PRIVATE_DENIED_PAYLOAD' };
      } else throw new Error(`Unexpected simulated API request ${request.method} ${url.pathname}`);
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(payload));
    })().catch(error => { errors.push(error); response.statusCode = 500; response.end('{}'); });
  });
  let handler: ReturnType<typeof createMcpHandler> | undefined;
  let mcpServer: Server | undefined;
  const client = new Client({ name: 'knowledge-http-integration', version: '1' });
  try {
    const api = new DebatidorApiClient(await listen(backend), { type: 'bearer', token: 'synthetic_knowledge_remote' });
    handler = createMcpHandler(() => createDebatidorServer({ api, publicBaseUrl: 'http://127.0.0.1' }));
    const nodeHandler = toNodeHandler(handler);
    mcpServer = createServer((request, response) => { void nodeHandler(request, response).catch(error => { errors.push(error); response.statusCode = 500; response.end(); }); });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${await listen(mcpServer)}/mcp`)));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name: `debatidor_${name}`, arguments: args });
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      return result.structuredContent as Record<string, unknown>;
    };
    assert.deepEqual(await call('create_context_session', { label: session.label, clientSessionId: 'remote-create', projectId: 'project:one' }), { ...session, duplicate: false });
    assert.deepEqual(await call('list_context_sessions', { projectId: 'project:one', limit: 1 }), { sessions: [session], nextCursor: null });
    const append = { sessionId: session.id, clientEventId: event.clientEventId, role: event.role, content: event.content };
    assert.deepEqual(await call('append_context_session', append), { event, duplicate: false, materialization: 'queued' });
    assert.deepEqual(await call('append_context_session', append), { event, duplicate: true, materialization: 'queued' });
    const first = await call('get_context_session', { sessionId: session.id, limit: 1 });
    const transcript = first.transcript as { nextCursor: string; events: unknown[] };
    assert.deepEqual(transcript.events, [event]);
    const second = await call('get_context_session', { sessionId: session.id, limit: 1, cursor: transcript.nextCursor });
    assert.equal((second.transcript as { nextCursor: unknown }).nextCursor, null);
    assert.deepEqual(await call('get_context_raw_origin', { rawType: origin.rawType, rawId: origin.rawId, revision: 1 }), raw);
    assert.deepEqual(await call('create_context_declaration', declarationInput), admission);
    assert.deepEqual(await call('get_context_declaration', { declarationId: declaration.id }), declaration);
    assert.deepEqual(await call('get_context_status', {}), status);
    const hits = (await call('search_context', { query: 'quote', sourceIds: [session.sourceId], kinds: ['SUMMARY'] })).hits as Array<Record<string, unknown>>;
    assert.deepEqual(hits[0].provenance, derived.provenance);
    assert.deepEqual(hits[0].derivation, derived.derivation);
    assert.equal((await call('close_context_session', { sessionId: session.id })).closedAt, date);
    const denied = await client.callTool({ name: 'debatidor_get_context_session', arguments: { sessionId: 'ctxsession:foreign' } });
    assert.equal(denied.isError, true); assert.match(JSON.stringify(denied.content), /unavailable/);
    assert.doesNotMatch(JSON.stringify(denied), /PRIVATE_DENIED_PAYLOAD|synthetic_knowledge_remote/);
    assert.equal(requests.some(request => request.path === '/context/sessions/ctxsession%3Aforeign'), false);
    malformed = true;
    const invalid = await client.callTool({ name: 'debatidor_get_context_declaration', arguments: { declarationId: declaration.id } });
    assert.equal(invalid.isError, true); assert.match(JSON.stringify(invalid.content), /invalid response/);
    assert.equal(requests.filter(request => request.method === 'POST').length, 6);
    assert.equal(requests.length, 16);
    assert.deepEqual(errors, []);
  } finally {
    await client.close().catch(() => undefined);
    await handler?.close();
    if (mcpServer) await close(mcpServer);
    await close(backend);
  }
});
