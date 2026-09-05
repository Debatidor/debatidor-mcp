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

function contextResponse() {
  return {
    hits: [{
      id: 'mem_1',
      sourceId: 'source_1',
      debateId: 'deb_lead',
      kind: 'CONCLUSION',
      content: 'Use the MCP endpoint as the stable integration boundary.',
      score: 2.75,
      semanticSimilarity: null,
      createdAt: '2026-08-30T20:00:00.000Z',
      provenance: { messageId: 'msg_1', sourceRevision: 2, originType: 'message', originId: 'msg_1' },
    }],
    retrieval: { method: 'text', semanticStatus: 'unavailable' },
    partial: false,
  };
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
  let seenUrl = '';
  let seenRequest: RequestInit | undefined;
  const upstream: typeof fetch = async (input, init) => {
    seenUrl = String(input);
    seenRequest = init;
    const response = contextResponse();
    return jsonResponse({ ...response,
      hits: response.hits.map((hit) => ({ ...hit, workspaceId: 'ws_hidden', embedding: [1, 2, 3] })),
    });
  };

  const api = new DebatidorApiClient(
    'https://api.test',
    { type: 'bearer', token: 'oauth_context_test' },
    upstream,
  );

  await withClient(api, async (client) => {
    const tools = await client.listTools();
    const tool = tools.tools.find((candidate) => candidate.name === 'debatidor_search_context');
    assert.ok(tool);
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.idempotentHint, true);
    assert.equal(tool.annotations?.openWorldHint, false);
    assert.deepEqual(tool.inputSchema.required, ['query']);
    assert.doesNotMatch(tool.description ?? '', /BYOK|credits|OpenAI/i);
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
      retrieval: { method: string; semanticStatus: string };
      partial: boolean;
    };
    assert.equal(structured.query, 'integration boundary');
    assert.equal(structured.hitCount, 1);
    assert.deepEqual(structured.hits[0], {
      ...contextResponse().hits[0],
      similarity: 0,
      retrievalMethod: 'text',
    });
    assert.deepEqual(structured.retrieval, { method: 'text', semanticStatus: 'unavailable' });
    assert.equal(structured.partial, false);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    assert.match(text, /text relevance score 2\.750/);
    assert.match(text, /source_1 · revision 2/);
    assert.doesNotMatch(text, /similarity 2\.750|Semantic context matches|ws_hidden/);
  });

  assert.equal(seenUrl, 'https://api.test/context/search');
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

test('omitted and empty memory kinds send the compatible default filter explicitly', async () => {
  const requests: unknown[] = [];
  const api = new DebatidorApiClient('https://api.test', { type: 'bearer', token: 'context_test' },
    async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return jsonResponse(contextResponse());
    });
  await withClient(api, async (client) => {
    for (const arguments_ of [{ query: 'context' }, { query: 'context', kinds: [] }]) {
      const response = await client.callTool({ name: 'debatidor_search_context', arguments: arguments_ });
      assert.equal(response.isError, undefined);
    }
  });
  assert.deepEqual(requests, [
    { query: 'context', kinds: ['MESSAGE', 'CONCLUSION'] },
    { query: 'context', kinds: ['MESSAGE', 'CONCLUSION'] },
  ]);
});

test('explicit memory filters and outputs support all five context kinds through the MCP runtime', async () => {
  const kinds = ['MESSAGE', 'CONCLUSION', 'FACT', 'DECISION', 'SUMMARY'];
  const requests: unknown[] = [];
  const api = new DebatidorApiClient('https://api.test', { type: 'bearer', token: 'context_test' },
    async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string; kinds: string[] };
      requests.push(body);
      return jsonResponse({ ...contextResponse(),
        hits: body.kinds.map((kind) => ({ ...contextResponse().hits[0], id: `item_${kind}`, kind })),
      });
    });
  await withClient(api, async (client) => {
    for (const requested of [['FACT'], kinds]) {
      const response = await client.callTool({
        name: 'debatidor_search_context', arguments: { query: 'context', kinds: requested },
      });
      assert.equal(response.isError, undefined);
      const structured = response.structuredContent as { hits: Array<{ kind: string; similarity: number }> };
      assert.deepEqual(structured.hits.map((hit) => hit.kind), requested);
      assert.ok(structured.hits.every((hit) => hit.similarity === 0));
    }
  });
  assert.deepEqual(requests, [
    { query: 'context', kinds: ['FACT'] },
    { query: 'context', kinds },
  ]);
});

test('unknown memory kinds are rejected by the MCP input schema before any upstream request', async () => {
  let calls = 0;
  const api = new DebatidorApiClient('https://api.test', { type: 'bearer', token: 'context_test' },
    async () => { calls++; return jsonResponse(contextResponse()); });
  await withClient(api, async (client) => {
    const response = await client.callTool({
      name: 'debatidor_search_context', arguments: { query: 'context', kinds: ['UNKNOWN'] },
    });
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent, undefined);
  });
  assert.equal(calls, 0);
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
    assert.equal(tool.annotations?.openWorldHint, false);
    assert.deepEqual(tool.inputSchema.required, ['debateId']);
    assert.match(tool.description ?? '', /maintenance/i);
    assert.match(tool.description ?? '', /does not require this tool/i);
    assert.doesNotMatch(tool.description ?? '', /BYOK|credits|OpenAI|provider usage/i);

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

  assert.equal(seenUrl, 'https://api.test/context/index-debate');
  assert.equal(seenRequest?.method, 'POST');
  assert.equal((seenRequest?.headers as Record<string, string>).authorization, 'Bearer oauth_index_test');
  assert.deepEqual(JSON.parse(String(seenRequest?.body)), {
    debateId: 'deb_lead',
    limit: 10,
  });
});

test('a stale memory backend does not instruct the user to fund an external provider', async () => {
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
    assert.match(text, /memory backend is not ready/i);
    assert.match(text, /does not require an external provider key/i);
    assert.doesNotMatch(text, /OpenAI|Integrations|credits/i);
    assert.doesNotMatch(text, /oauth_context_test/);
  });
});

test('empty and partial text retrieval stay distinguishable from a failed request', async () => {
  const upstream: typeof fetch = async () => jsonResponse({
    ...contextResponse(), hits: [], partial: true,
  });
  const api = new DebatidorApiClient('https://api.test', { type: 'api-key', token: 'deb_live_test' }, upstream);
  await withClient(api, async (client) => {
    const result = await client.callTool({ name: 'debatidor_search_context', arguments: { query: 'no match' } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      query: 'no match', hitCount: 0, hits: [],
      retrieval: { method: 'text', semanticStatus: 'unavailable' }, partial: true,
    });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    assert.match(text, /Results are partial/);
    assert.match(text, /Semantic retrieval: unavailable/);
  });
});

const malformedContextResponses: Array<[string, () => unknown]> = [
  ['legacy array on the canonical endpoint', () => []],
  ['missing envelope', () => null],
  ['non-array hits', () => ({ ...contextResponse(), hits: {} })],
  ['missing partial status', () => ({ hits: [], retrieval: contextResponse().retrieval })],
  ['invented semantic status', () => ({ ...contextResponse(), retrieval: { method: 'semantic', semanticStatus: 'available' } })],
  ['null hit', () => ({ ...contextResponse(), hits: [null] })],
  ['string score', () => ({ ...contextResponse(), hits: [{ ...contextResponse().hits[0], score: '2.75' }] })],
  ['missing provenance', () => ({ ...contextResponse(), hits: [{ ...contextResponse().hits[0], provenance: undefined }] })],
  ['fake cosine for text', () => ({ ...contextResponse(), hits: [{ ...contextResponse().hits[0], semanticSimilarity: 0.8 }] })],
  ['invalid kind', () => ({ ...contextResponse(), hits: [{ ...contextResponse().hits[0], kind: 'UNKNOWN' }] })],
  ['invalid timestamp', () => ({ ...contextResponse(), hits: [{ ...contextResponse().hits[0], createdAt: 'yesterday' }] })],
  ['different debate than requested', () => ({ ...contextResponse(), hits: [{ ...contextResponse().hits[0], debateId: 'other' }] })],
];

for (const [label, response] of malformedContextResponses) {
  test(`context search rejects ${label} visibly through the MCP runtime`, async () => {
    let calls = 0;
    const upstream: typeof fetch = async () => { calls += 1; return jsonResponse(response()); };
    const api = new DebatidorApiClient('https://api.test', { type: 'bearer', token: 'private_test_token' }, upstream);
    await withClient(api, async (client) => {
      const result = await client.callTool({
        name: 'debatidor_search_context', arguments: { query: 'context', debateId: 'deb_lead' },
      });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
      assert.match(text, /invalid response/i);
      assert.doesNotMatch(text, /private_test_token|No Debatidor context matched|source_1/);
    });
    assert.equal(calls, 1, 'No silent legacy fallback, indexing, or retry');
  });
}

test('invalid JSON is a visible sanitized error rather than empty memory', async () => {
  const upstream: typeof fetch = async () => new Response('<html>private_upstream_debug</html>', { status: 200 });
  const api = new DebatidorApiClient('https://api.test', { type: 'bearer', token: 'private_test_token' }, upstream);
  await withClient(api, async (client) => {
    const result = await client.callTool({ name: 'debatidor_search_context', arguments: { query: 'context' } });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    assert.match(text, /invalid response/i);
    assert.doesNotMatch(text, /private_upstream_debug|private_test_token/);
  });
});

for (const payload of [null, [], { debateId: 'deb_lead', scanned: '3' },
  { debateId: 'other', scanned: 0, indexed: 0, unchanged: 0, empty: 0, cappedAt: 50 }]) {
  test(`context indexing rejects malformed response ${JSON.stringify(payload)}`, async () => {
    const api = new DebatidorApiClient('https://api.test', { type: 'api-key', token: 'deb_live_test' },
      async () => jsonResponse(payload));
    await withClient(api, async (client) => {
      const result = await client.callTool({ name: 'debatidor_index_context', arguments: { debateId: 'deb_lead' } });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.match((result.content as Array<{ text?: string }>)[0]?.text ?? '', /invalid response/i);
    });
  });
}
