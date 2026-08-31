import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { DebatidorApiClient } from '../src/debatidor-api.js';
import { createDebatidorServer } from '../src/server.js';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function withClient(
  api: DebatidorApiClient | undefined,
  run: (client: Client) => Promise<void>,
) {
  const handler = createMcpHandler(() =>
    createDebatidorServer({ api, publicBaseUrl: 'https://mcp.debatidor.test' }),
  );
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'debatidor-mcp-test', version: '1.0.0' });

  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await client.close();
    await handler.close();
  }
}

test('public bootstrap exposes ping but not user-data tools', async () => {
  await withClient(undefined, async (client) => {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ['debatidor_ping']);

    const result = await client.callTool({ name: 'debatidor_ping', arguments: {} });
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      ok: boolean;
      authenticatedToolsEnabled: boolean;
      endpoint: string;
    };
    assert.equal(structured.ok, true);
    assert.equal(structured.authenticatedToolsEnabled, false);
    assert.equal(structured.endpoint, 'https://mcp.debatidor.test/mcp');
  });
});

test('authenticated bridge exposes Lead and memory tools', async () => {
  const upstream: typeof fetch = async () =>
    jsonResponse([
      { id: 'deb_lead', title: 'Lead room', mode: 'LEAD', status: 'RUNNING', currentRound: 2, roundsLimit: 5 },
      { id: 'deb_rr', title: 'Round robin', mode: 'ROUND_ROBIN', status: 'RUNNING' },
    ]);

  const api = new DebatidorApiClient(
    'https://api.test',
    { type: 'api-key', token: 'deb_live_test' },
    upstream,
  );
  await withClient(api, async (client) => {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'debatidor_ping'));
    assert.ok(tools.tools.some((tool) => tool.name === 'debatidor_get_lead_status'));
    assert.ok(tools.tools.some((tool) => tool.name === 'debatidor_search_context'));
    assert.ok(tools.tools.some((tool) => tool.name === 'debatidor_index_context'));

    const result = await client.callTool({
      name: 'debatidor_get_lead_status',
      arguments: {},
    });

    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      activeCount: number;
      debates: Array<{ id: string }>;
    };
    assert.equal(structured.activeCount, 1);
    assert.deepEqual(structured.debates.map((debate) => debate.id), ['deb_lead']);
  });
});

test('specific Lead status validates workspace ownership before snapshot lookup', async () => {
  const calls: string[] = [];
  const upstream: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/realtime/debates')) {
      return jsonResponse([{ id: 'mine', title: 'Mine', mode: 'LEAD', status: 'READY' }]);
    }
    return jsonResponse({ found: true, debate: { id: 'other', mode: 'LEAD', status: 'RUNNING' } });
  };

  const api = new DebatidorApiClient(
    'https://api.test',
    { type: 'bearer', token: 'oauth_test' },
    upstream,
  );
  await assert.rejects(() => api.getLeadStatus('other'), /lead_debate_not_found/);
  assert.equal(calls.length, 1);
});

test('authenticated context search is read-only, bearer-scoped and bounded', async () => {
  let seenRequest: RequestInit | undefined;
  const upstream: typeof fetch = async (_input, init) => {
    seenRequest = init;
    return jsonResponse([
      {
        id: 'mem_1',
        workspaceId: 'ws_hidden',
        debateId: 'deb_lead',
        kind: 'CONCLUSION',
        content: 'Use the MCP endpoint as the stable integration boundary.',
        embeddingModel: 'text-embedding-3-small',
        dimensions: 1536,
        createdAt: '2026-08-30T20:00:00.000Z',
        similarity: '0.9123',
      },
    ]);
  };

  const api = new DebatidorApiClient(
    'https://api.test',
    { type: 'bearer', token: 'oauth_context_test' },
    upstream,
  );

  await withClient(api, async (client) => {
    const result = await client.callTool({
      name: 'debatidor_search_context',
      arguments: {
        query: 'integration boundary',
        debateId: 'deb_lead',
        kinds: ['CONCLUSION'],
        limit: 3,
      },
    });

    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as {
      query: string;
      hitCount: number;
      hits: Array<{ id: string; similarity: number; kind: string }>;
    };
    assert.equal(structured.query, 'integration boundary');
    assert.equal(structured.hitCount, 1);
    assert.deepEqual(structured.hits[0], {
      id: 'mem_1',
      debateId: 'deb_lead',
      kind: 'CONCLUSION',
      content: 'Use the MCP endpoint as the stable integration boundary.',
      similarity: 0.9123,
      createdAt: '2026-08-30T20:00:00.000Z',
    });
  });

  assert.equal(seenRequest?.method, 'POST');
  assert.equal((seenRequest?.headers as Record<string, string>).authorization, 'Bearer oauth_context_test');
  assert.equal((seenRequest?.headers as Record<string, string>)['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(String(seenRequest?.body)), {
    query: 'integration boundary',
    debateId: 'deb_lead',
    kinds: ['CONCLUSION'],
    limit: 3,
  });
});

test('context indexing is explicit, bearer-scoped and annotated as a non-destructive write', async () => {
  let seenUrl = '';
  let seenRequest: RequestInit | undefined;
  const upstream: typeof fetch = async (input, init) => {
    seenUrl = String(input);
    seenRequest = init;
    return jsonResponse({
      debateId: 'deb_lead',
      scanned: 3,
      indexed: 2,
      unchanged: 1,
      empty: 0,
      cappedAt: 50,
    });
  };

  const api = new DebatidorApiClient(
    'https://api.test',
    { type: 'bearer', token: 'oauth_index_test' },
    upstream,
  );

  await withClient(api, async (client) => {
    const tools = await client.listTools();
    const tool = tools.tools.find((candidate) => candidate.name === 'debatidor_index_context');
    assert.ok(tool);
    assert.equal(tool.annotations?.readOnlyHint, false);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.annotations?.idempotentHint, true);

    const result = await client.callTool({
      name: 'debatidor_index_context',
      arguments: { debateId: 'deb_lead', limit: 10 },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      debateId: 'deb_lead',
      scanned: 3,
      indexed: 2,
      unchanged: 1,
      empty: 0,
      cappedAt: 50,
    });
  });

  assert.equal(seenUrl, 'https://api.test/vector-memory/index-debate');
  assert.equal(seenRequest?.method, 'POST');
  assert.equal((seenRequest?.headers as Record<string, string>).authorization, 'Bearer oauth_index_test');
  assert.deepEqual(JSON.parse(String(seenRequest?.body)), {
    debateId: 'deb_lead',
    limit: 10,
  });
});

test('context search reports missing embeddings key without leaking upstream bodies', async () => {
  const upstream: typeof fetch = async () =>
    jsonResponse({ statusCode: 400, message: 'provider_key_not_configured' }, 400);

  const api = new DebatidorApiClient(
    'https://api.test',
    { type: 'bearer', token: 'oauth_context_test' },
    upstream,
  );

  await withClient(api, async (client) => {
    const result = await client.callTool({
      name: 'debatidor_search_context',
      arguments: { query: 'where is the conclusion?' },
    });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.match(text, /OpenAI provider key configured/i);
    assert.doesNotMatch(text, /oauth_context_test/);
  });
});
