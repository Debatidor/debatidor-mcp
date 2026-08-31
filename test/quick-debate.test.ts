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
  api: DebatidorApiClient,
  run: (client: Client) => Promise<void>,
) {
  const handler = createMcpHandler(() =>
    createDebatidorServer({ api, publicBaseUrl: 'https://mcp.debatidor.test' }),
  );
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'quick-debate-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await client.close();
    await handler.close();
  }
}

test('quick debate is an explicit non-idempotent orchestration write', async () => {
  let seenUrl = '';
  let seenRequest: RequestInit | undefined;
  const upstream: typeof fetch = async (input, init) => {
    seenUrl = String(input);
    seenRequest = init;
    return jsonResponse({
      accepted: true,
      debateId: 'deb_lead',
      mode: 'both',
      apiParticipants: 2,
      browserParticipants: 1,
      connectionId: 'conn_dom_openai',
    });
  };

  const api = new DebatidorApiClient(
    'https://api.test',
    { type: 'bearer', token: 'oauth_quick_test' },
    upstream,
  );

  await withClient(api, async (client) => {
    const tools = await client.listTools();
    const tool = tools.tools.find((candidate) => candidate.name === 'debatidor_quick_debate');
    assert.ok(tool);
    assert.equal(tool.annotations?.readOnlyHint, false);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.annotations?.idempotentHint, false);
    assert.equal(tool.annotations?.openWorldHint, true);

    const result = await client.callTool({
      name: 'debatidor_quick_debate',
      arguments: {
        debateId: 'deb_lead',
        prompt: 'Contrasta estas propuestas y responde con una recomendación.',
        mode: 'both',
        connectionId: 'conn_dom_openai',
      },
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      accepted: true,
      debateId: 'deb_lead',
      mode: 'both',
      apiParticipants: 2,
      browserParticipants: 1,
      connectionId: 'conn_dom_openai',
    });
  });

  assert.equal(seenUrl, 'https://api.test/realtime/debates/deb_lead/quick');
  assert.equal(seenRequest?.method, 'POST');
  assert.equal(
    (seenRequest?.headers as Record<string, string>).authorization,
    'Bearer oauth_quick_test',
  );
  assert.deepEqual(JSON.parse(String(seenRequest?.body)), {
    prompt: 'Contrasta estas propuestas y responde con una recomendación.',
    mode: 'both',
    connectionId: 'conn_dom_openai',
  });
});

test('quick debate surfaces workspace ownership failures safely', async () => {
  const upstream: typeof fetch = async () =>
    jsonResponse({ statusCode: 400, message: 'quick_debate_not_found' }, 400);
  const api = new DebatidorApiClient(
    'https://api.test',
    { type: 'bearer', token: 'oauth_quick_test' },
    upstream,
  );

  await withClient(api, async (client) => {
    const result = await client.callTool({
      name: 'debatidor_quick_debate',
      arguments: { debateId: 'deb_other', prompt: 'hola' },
    });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.match(text, /authenticated Debatidor workspace/i);
    assert.doesNotMatch(text, /oauth_quick_test/);
  });
});
