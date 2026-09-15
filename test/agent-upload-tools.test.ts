import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { DebatidorApiClient } from '../src/debatidor-api.js';
import { createDebatidorServerWithAssets } from '../src/agent-asset-tools.js';

async function withClient(api: DebatidorApiClient, run: (client: Client) => Promise<void>) {
  const handler = createMcpHandler(() => createDebatidorServerWithAssets({ api, publicBaseUrl: 'https://mcp.test' }));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'upload-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await client.close();
    await handler.close();
  }
}

test('registers and forwards chunked upload tools', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const uploadId = `upl_${'a'.repeat(32)}`;
  const upstream: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push(body);
    const tool = String(body.tool);
    if (tool === 'asset.begin') {
      return new Response(JSON.stringify({ tool, agentId: 'vps', ok: true, uploadId, path: body.path, bytes: body.bytes, chunkSize: 65536 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (tool === 'asset.chunk') {
      return new Response(JSON.stringify({ tool, agentId: 'vps', ok: true, uploadId, received: 4, totalReceived: 4, nextIndex: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ tool, agentId: 'vps', ok: true, uploadId, path: 'public/original.png', bytes: 4, sha256: 'b'.repeat(64), sourceType: 'chunked' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const api = new DebatidorApiClient('https://api.test', { type: 'api-key', token: 'test' }, upstream);

  await withClient(api, async (client) => {
    const tools = await client.listTools();
    for (const name of ['debatidor_asset_begin', 'debatidor_asset_chunk', 'debatidor_asset_commit', 'debatidor_asset_abort']) {
      assert.ok(tools.tools.some((tool) => tool.name === name));
    }

    const begin = await client.callTool({ name: 'debatidor_asset_begin', arguments: { agentId: 'vps', path: 'public/original.png', bytes: 4, sha256: 'b'.repeat(64), mimeType: 'image/png' } });
    assert.equal((begin.structuredContent as Record<string, unknown>).chunkSize, 65536);

    const chunk = await client.callTool({ name: 'debatidor_asset_chunk', arguments: { agentId: 'vps', uploadId, index: 0, base64: 'AAECAw==' } });
    assert.equal((chunk.structuredContent as Record<string, unknown>).nextIndex, 1);

    const commit = await client.callTool({ name: 'debatidor_asset_commit', arguments: { agentId: 'vps', uploadId } });
    assert.equal((commit.structuredContent as Record<string, unknown>).sourceType, 'chunked');
  });

  assert.deepEqual(calls.map((call) => call.tool), ['asset.begin', 'asset.chunk', 'asset.commit']);
  assert.equal(calls[1]?.base64, 'AAECAw==');
});
