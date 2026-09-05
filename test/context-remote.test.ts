import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { DebatidorApiClient } from '../src/debatidor-api.js';
import { createDebatidorServer } from '../src/server.js';

// The required search result contract published by MCP 0.7.2. Additive P11
// metadata must remain consumable by an existing client using that contract.
const previousSearchContract = z.object({
  query: z.string(),
  hitCount: z.number().int().nonnegative(),
  hits: z.array(z.object({
    id: z.string(),
    debateId: z.string().nullable(),
    kind: z.enum(['MESSAGE', 'CONCLUSION']),
    content: z.string(),
    similarity: z.number(),
    createdAt: z.string().optional(),
  })),
});

test('memory tools retain the previous required contract over real HTTP MCP transport', async () => {
  const upstreamPaths: string[] = [];
  const searchBodies: unknown[] = [];
  const api = new DebatidorApiClient('https://mock-backend.test',
    { type: 'bearer', token: 'remote_memory_test_token' }, async (input, init) => {
      upstreamPaths.push(new URL(String(input)).pathname);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer remote_memory_test_token');
      assert.equal(new Headers(init?.headers).get('x-api-key'), null);
      const requestBody = JSON.parse(String(init?.body)) as { query?: string; kinds?: string[] };
      if (new URL(String(input)).pathname === '/context/search') searchBodies.push(requestBody);
      const hybrid = requestBody.query === 'idea nueva';
      const content = 'El despliegue conserva el historial del workspace.';
      const body = new URL(String(input)).pathname === '/context/search'
        ? {
          hits: [{ id: 'memory-1', sourceId: 'source-1', debateId: 'deb-1',
            kind: requestBody.kinds?.includes('FACT') ? 'FACT' : 'MESSAGE',
            content, score: hybrid ? 0.03 : 1.25,
            semanticSimilarity: hybrid ? 0.76 : null, createdAt: '2026-09-05T12:00:00.000Z',
            provenance: { messageId: 'message-1', sourceRevision: 1, originType: 'message', originId: 'message-1',
              ...(hybrid ? { chunk: { id: 'chunk-1', chunkerVersion: 'utf16-v1', startUtf16: 5, endUtf16: 5 + content.length } } : {}),
            } }],
          retrieval: { method: hybrid ? 'hybrid' : 'text', semanticStatus: hybrid ? 'ready' : 'unavailable' }, partial: false,
        }
        : { debateId: 'deb-1', scanned: 1, indexed: 0, unchanged: 1, empty: 0, cappedAt: 50 };
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    });
  const handler = createMcpHandler(() => createDebatidorServer({ api, publicBaseUrl: 'http://127.0.0.1' }));
  const nodeHandler = toNodeHandler(handler);
  const server = createServer((request, response) => {
    void nodeHandler(request, response).catch(() => { response.statusCode = 500; response.end(); });
  });
  const client = new Client({ name: 'context-remote-compat-test', version: '0.7.2' });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.find(tool => tool.name === 'debatidor_search_context')?.inputSchema.required, ['query']);
    assert.deepEqual(tools.tools.find(tool => tool.name === 'debatidor_index_context')?.inputSchema.required, ['debateId']);
    const search = await client.callTool({ name: 'debatidor_search_context', arguments: { query: 'historial', debateId: 'deb-1' } });
    assert.equal(search.isError, undefined);
    const previous = previousSearchContract.parse(search.structuredContent);
    assert.equal(previous.hitCount, 1);
    assert.equal(previous.hits[0].similarity, 0);
    assert.deepEqual(upstreamPaths, ['/context/search'], 'Normal search does not trigger maintenance');
    assert.deepEqual(searchBodies, [{ query: 'historial', debateId: 'deb-1', kinds: ['MESSAGE', 'CONCLUSION'] }]);
    const facts = await client.callTool({ name: 'debatidor_search_context', arguments: { query: 'historial', debateId: 'deb-1', kinds: ['FACT'] } });
    assert.equal(facts.isError, undefined);
    const factHits = (facts.structuredContent as { hits: Array<{ kind: string; similarity: number }> }).hits;
    assert.equal(factHits[0].kind, 'FACT');
    assert.equal(factHits[0].similarity, 0);
    assert.deepEqual(searchBodies[1], { query: 'historial', debateId: 'deb-1', kinds: ['FACT'] });
    const hybrid = await client.callTool({ name: 'debatidor_search_context', arguments: { query: 'idea nueva', debateId: 'deb-1' } });
    assert.equal(hybrid.isError, undefined);
    const hybridPrevious = previousSearchContract.parse(hybrid.structuredContent);
    assert.equal(hybridPrevious.hits[0].similarity, 0.76);
    assert.equal(hybridPrevious.hits[0].kind, 'MESSAGE');
    assert.deepEqual(searchBodies[2], { query: 'idea nueva', debateId: 'deb-1', kinds: ['MESSAGE', 'CONCLUSION'] });
    const index = await client.callTool({ name: 'debatidor_index_context', arguments: { debateId: 'deb-1' } });
    assert.equal(index.isError, undefined);
    assert.deepEqual(index.structuredContent, { debateId: 'deb-1', scanned: 1, indexed: 0, unchanged: 1, empty: 0, cappedAt: 50 });
    assert.deepEqual(upstreamPaths, ['/context/search', '/context/search', '/context/search', '/context/index-debate']);
  } finally {
    await client.close().catch(() => undefined);
    await handler.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
