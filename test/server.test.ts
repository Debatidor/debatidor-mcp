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

test('debatidor_get_lead_status lists only LEAD arenas', async () => {
  const upstream: typeof fetch = async () =>
    jsonResponse([
      { id: 'deb_lead', title: 'Lead room', mode: 'LEAD', status: 'RUNNING', currentRound: 2, roundsLimit: 5 },
      { id: 'deb_rr', title: 'Round robin', mode: 'ROUND_ROBIN', status: 'RUNNING' },
    ]);

  const api = new DebatidorApiClient('https://api.test', 'deb_live_test', upstream);
  const handler = createMcpHandler(() => createDebatidorServer(api));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'debatidor-mcp-test', version: '1.0.0' });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'debatidor_get_lead_status'));

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
  } finally {
    await client.close();
    await handler.close();
  }
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

  const api = new DebatidorApiClient('https://api.test', 'deb_live_test', upstream);
  await assert.rejects(() => api.getLeadStatus('other'), /lead_debate_not_found/);
  assert.equal(calls.length, 1);
});
