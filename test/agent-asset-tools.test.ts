import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { DebatidorApiClient } from '../src/debatidor-api.js';
import { createDebatidorServerWithAssets } from '../src/agent-asset-tools.js';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function withClient(api: DebatidorApiClient, run: (client: Client) => Promise<void>) {
  const handler = createMcpHandler(() =>
    createDebatidorServerWithAssets({ api, publicBaseUrl: 'https://mcp.debatidor.test' }),
  );
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'asset-tools-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await client.close();
    await handler.close();
  }
}

test('agent asset tool forwards URL metadata without proxying asset bytes', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const upstream: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return jsonResponse({
      tool: 'fs.put',
      agentId: 'vps-media',
      ok: true,
      path: 'public/media/hero.webp',
      bytes: 123456,
      sha256: 'a'.repeat(64),
      mimeType: 'image/webp',
      sourceType: 'url',
    });
  };
  const api = new DebatidorApiClient(
    'https://api.test',
    { type: 'bearer', token: 'oauth_asset_test' },
    upstream,
  );

  await withClient(api, async (client) => {
    const tools = await client.listTools();
    const tool = tools.tools.find((candidate) => candidate.name === 'debatidor_agent_put');
    assert.ok(tool);
    assert.equal(tool.annotations?.destructiveHint, true);
    assert.equal(tool.annotations?.openWorldHint, true);

    const result = await client.callTool({
      name: 'debatidor_agent_put',
      arguments: {
        agentId: 'vps-media',
        path: 'public/media/hero.webp',
        url: 'https://cdn.example.com/generated/hero.webp',
        mimeType: 'image/*',
        sha256: 'a'.repeat(64),
        timeoutMs: 120000,
      },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      tool: 'fs.put',
      agentId: 'vps-media',
      ok: true,
      path: 'public/media/hero.webp',
      bytes: 123456,
      sha256: 'a'.repeat(64),
      mimeType: 'image/webp',
      sourceType: 'url',
    });
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://api.test/agent-execution/execute');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    agentId: 'vps-media',
    tool: 'fs.put',
    path: 'public/media/hero.webp',
    url: 'https://cdn.example.com/generated/hero.webp',
    sha256: 'a'.repeat(64),
    mimeType: 'image/*',
    timeoutMs: 120000,
  });
});

test('agent asset tool requires exactly one source', async () => {
  const upstream: typeof fetch = async () => {
    throw new Error('should_not_call_upstream');
  };
  const api = new DebatidorApiClient(
    'https://api.test',
    { type: 'bearer', token: 'oauth_asset_test' },
    upstream,
  );

  await withClient(api, async (client) => {
    const result = await client.callTool({
      name: 'debatidor_agent_put',
      arguments: {
        path: 'public/media/bad.webp',
        url: 'https://cdn.example.com/a.webp',
        base64: 'AA==',
      },
    });
    assert.equal(result.isError, true);
  });
});
