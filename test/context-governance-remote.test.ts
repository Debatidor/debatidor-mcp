import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { DebatidorApiClient } from '../src/debatidor-api.js';
import { createDebatidorServer } from '../src/server.js';

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

test('governance tools traverse real HTTP MCP and backend transports with full paginated content and explicit mutations', async () => {
  const date = '2026-09-05T15:00:00.000Z';
  const entries = Array.from({ length: 101 }, (_, index) => ({
    id: `ctx:manual:${index}`, sourceId: 'ctxsrc:user:one', debateId: null, kind: 'FACT',
    content: index === 0 ? 'Complete 🧠 entry\n'.repeat(500) : `Entry ${index}\n`, createdAt: date,
    provenance: { messageId: null, sourceRevision: 1, originType: 'MANUAL', originId: String(index) },
  }));
  const metadata = { id: 'ctxexp:remote', schemaVersion: 1, scope: { type: 'user' }, format: 'markdown', itemCount: 101, pageCount: 2, expiresAt: date };
  const markdownPages = ['# Memory\n\n' + entries.slice(0, 100).map(e => e.content).join('\n'), entries[100].content];
  const policy = {
    schemaVersion: 1, retention: { mode: 'manual', rawHistory: 'preserved', derivedExpiration: 'purged' },
    exports: { maxActive: 3, ttlSeconds: 3600, maxItems: 10000, maxBytes: 33554432, pageSize: 100 },
    quotas: { policy: 'operational', maxChunksPerItem: 64, maxChunksPerWorkspace: 10000, dailyTokens: 250000 },
    deletion: { mode: 'derived', downloadedCopies: 'outside_service_control' },
  };
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const errors: unknown[] = [];
  let exportDeleted = false;
  const backend = createServer((request, response) => {
    void (async () => {
      assert.equal(request.headers.authorization, 'Bearer synthetic_remote_governance');
      assert.equal(request.headers['x-api-key'], undefined);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      const body: unknown = text ? JSON.parse(text) : undefined;
      const url = new URL(request.url ?? '/', 'http://test.local');
      requests.push({ method: request.method ?? '', path: url.pathname + url.search, ...(body === undefined ? {} : { body }) });
      let payload: unknown;
      if (url.pathname === '/context/items/ctx%3Amanual%3A0') {
        payload = request.method === 'DELETE' ? { deleted: true } : { ...entries[0], canDelete: true };
      } else if (url.pathname === '/context/sources') {
        assert.equal(url.searchParams.get('scope'), 'user');
        payload = { sources: [{ id: 'ctxsrc:user:one', type: 'USER', label: 'User memory', visibility: 'PRIVATE', canDelete: true }], nextCursor: null };
      } else if (url.pathname === '/context/exports' && request.method === 'POST') {
        assert.deepEqual(body, { scope: { type: 'user' }, format: 'markdown', sourceIds: ['ctxsrc:user:one'], kinds: ['FACT'] });
        response.statusCode = 201; payload = metadata;
      } else if (url.pathname === '/context/exports/ctxexp%3Aremote') {
        if (request.method === 'DELETE') { exportDeleted = true; payload = { deleted: true }; }
        else if (exportDeleted) { response.statusCode = 410; payload = { message: 'context_export_unavailable' }; }
        else {
          const second = url.searchParams.get('cursor') === '100';
          payload = { ...metadata, entries: second ? entries.slice(100) : entries.slice(0, 100), nextCursor: second ? null : '100', markdown: markdownPages[second ? 1 : 0] };
        }
      } else if (url.pathname === '/context/governance') payload = { ...policy, futurePolicy: 'accepted-but-not-forwarded' };
      else if (url.pathname === '/context/deletions' || url.pathname === '/context/deletions/ctxdel%3Aremote') {
        const created = request.method === 'POST';
        if (created) {
          response.statusCode = 201;
          assert.deepEqual(body, { mode: 'derived', scope: { type: 'user' }, sourceIds: ['ctxsrc:user:one'] });
        }
        payload = { id: 'ctxdel:remote', mode: 'derived', scope: { type: 'user' }, sourceIds: ['ctxsrc:user:one'],
          status: created ? 'PENDING' : 'COMPLETED', requestedAt: date, completedAt: created ? null : date, itemCount: 101 };
      } else throw new Error(`Unexpected synthetic backend request: ${request.method} ${url.pathname}`);
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(payload));
    })().catch(error => { errors.push(error); response.statusCode = 500; response.end('{}'); });
  });
  let handler: ReturnType<typeof createMcpHandler> | undefined;
  let mcpServer: Server | undefined;
  const client = new Client({ name: 'governance-real-http-test', version: '0.7.5' });
  try {
    const api = new DebatidorApiClient(await listen(backend), { type: 'bearer', token: 'synthetic_remote_governance' });
    handler = createMcpHandler(() => createDebatidorServer({ api, publicBaseUrl: 'http://127.0.0.1' }));
    const nodeHandler = toNodeHandler(handler);
    mcpServer = createServer((request, response) => { void nodeHandler(request, response).catch(error => { errors.push(error); response.statusCode = 500; response.end(); }); });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${await listen(mcpServer)}/mcp`)));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      return result.structuredContent as Record<string, unknown>;
    };
    const detail = await call('debatidor_get_context_item', { itemId: entries[0].id });
    assert.equal(detail.content, entries[0].content);
    assert.ok(entries[0].content.length > 6000);
    const sources = await call('debatidor_list_context_sources', { scope: 'user', limit: 100 });
    assert.equal((sources.sources as unknown[]).length, 1);
    assert.deepEqual(await call('debatidor_export_context', { scope: { type: 'user' }, format: 'markdown', sourceIds: ['ctxsrc:user:one'], kinds: ['FACT'] }), metadata);
    const first = await call('debatidor_read_context_export', { exportId: metadata.id });
    const second = await call('debatidor_read_context_export', { exportId: metadata.id, cursor: first.nextCursor });
    assert.equal((first.entries as unknown[]).length, 100);
    assert.equal((second.entries as unknown[]).length, 1);
    assert.equal(second.nextCursor, null);
    assert.deepEqual([...(first.entries as unknown[]), ...(second.entries as unknown[])], entries);
    assert.equal(String(first.markdown) + String(second.markdown), markdownPages.join(''));
    assert.deepEqual(await call('debatidor_get_context_governance', {}), policy);
    assert.deepEqual(await call('debatidor_delete_context_item', { itemId: entries[0].id }), { deleted: true });
    assert.equal((await call('debatidor_delete_context_sources', { mode: 'derived', scope: { type: 'user' }, sourceIds: ['ctxsrc:user:one'] })).status, 'PENDING');
    assert.equal((await call('debatidor_get_context_deletion', { operationId: 'ctxdel:remote' })).status, 'COMPLETED');
    assert.deepEqual(await call('debatidor_delete_context_export', { exportId: metadata.id }), { deleted: true });
    const gone = await client.callTool({ name: 'debatidor_read_context_export', arguments: { exportId: metadata.id } });
    assert.equal(gone.isError, true);
    assert.match(JSON.stringify(gone.content), /no longer available/);
    assert.equal(requests.filter(r => r.method === 'POST').length, 2, 'No automatic mutation retries');
    assert.equal(requests.filter(r => r.method === 'DELETE').length, 2);
    assert.equal(requests.length, 11);
    assert.deepEqual(errors, []);
  } finally {
    await client.close().catch(() => undefined);
    await handler?.close();
    if (mcpServer) await close(mcpServer);
    await close(backend);
  }
});
