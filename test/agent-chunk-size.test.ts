import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { DebatidorApiClient } from '../src/debatidor-api.js';
import { createDebatidorServerWithAssets } from '../src/agent-asset-tools.js';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function withClient(api: DebatidorApiClient, run: (client: Client) => Promise<void>) {
  const handler = createMcpHandler(() => createDebatidorServerWithAssets({ api, publicBaseUrl: 'https://mcp.test' }));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'chunk-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await client.close();
    await handler.close();
  }
}

// El SDK reporta la validación de entrada como un resultado con isError, no como
// una excepción de transporte; comprobamos esa forma sin depender de un throw.
async function expectInvalid(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} should report an input error for ${JSON.stringify(args)}`);
}

test('begin forwards a smaller chunkSize and chunk forwards base64 and hex encodings', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const uploadId = `upl_${'a'.repeat(32)}`;
  const upstream: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push(body);
    const tool = String(body.tool);
    if (tool === 'asset.begin') {
      const requested = Number(body.chunkSize ?? 16384);
      const chunkSize = Math.min(Math.max(requested, 4096), 65536);
      return json({ tool, agentId: 'vps', ok: true, uploadId, path: body.path, bytes: body.bytes, chunkSize });
    }
    if (tool === 'asset.chunk') {
      return json({ tool, agentId: 'vps', ok: true, uploadId, received: 4, totalReceived: 4, nextIndex: Number(body.index) + 1 });
    }
    return json({ tool, agentId: 'vps', ok: true, uploadId, path: 'media/original.png', bytes: 4, sha256: 'b'.repeat(64), sourceType: 'chunked' });
  };
  const api = new DebatidorApiClient('https://api.test', { type: 'api-key', token: 'test' }, upstream);

  await withClient(api, async (client) => {
    const begin = await client.callTool({
      name: 'debatidor_asset_begin',
      arguments: { agentId: 'vps', path: 'media/original.png', bytes: 40000, sha256: 'b'.repeat(64), mimeType: 'image/png', chunkSize: 8192 },
    });
    assert.equal((begin.structuredContent as Record<string, unknown>).chunkSize, 8192);
    assert.equal(calls[0]?.chunkSize, 8192);

    const b64 = await client.callTool({
      name: 'debatidor_asset_chunk',
      arguments: { agentId: 'vps', uploadId, index: 0, base64: 'AAECAw==' },
    });
    assert.equal((b64.structuredContent as Record<string, unknown>).nextIndex, 1);
    assert.equal(calls[1]?.encoding, 'base64');
    assert.equal(calls[1]?.base64, 'AAECAw==');

    const hex = await client.callTool({
      name: 'debatidor_asset_chunk',
      arguments: { agentId: 'vps', uploadId, index: 1, encoding: 'hex', hex: '00010203' },
    });
    assert.equal((hex.structuredContent as Record<string, unknown>).nextIndex, 2);
    assert.equal(calls[2]?.encoding, 'hex');
    assert.equal(calls[2]?.hex, '00010203');

    const commit = await client.callTool({ name: 'debatidor_asset_commit', arguments: { agentId: 'vps', uploadId } });
    assert.equal((commit.structuredContent as Record<string, unknown>).sourceType, 'chunked');
  });

  assert.deepEqual(calls.map((c) => c.tool), ['asset.begin', 'asset.chunk', 'asset.chunk', 'asset.commit']);
});

test('begin rejects a chunkSize outside the allowed transport range before any request', async () => {
  let hits = 0;
  const upstream: typeof fetch = async () => {
    hits += 1;
    return json({ tool: 'asset.begin', agentId: 'vps', ok: true, uploadId: `upl_${'a'.repeat(32)}`, chunkSize: 16384 });
  };
  const api = new DebatidorApiClient('https://api.test', { type: 'api-key', token: 'test' }, upstream);
  await withClient(api, async (client) => {
    await expectInvalid(client, 'debatidor_asset_begin', { path: 'a.bin', bytes: 10, chunkSize: 1024 });
    await expectInvalid(client, 'debatidor_asset_begin', { path: 'a.bin', bytes: 10, chunkSize: 200000 });
  });
  assert.equal(hits, 0, 'schema rejects before contacting the backend');
});

test('chunk requires the payload that matches the declared encoding', async () => {
  let hits = 0;
  const upstream: typeof fetch = async () => {
    hits += 1;
    return json({ tool: 'asset.chunk', agentId: 'vps', ok: true });
  };
  const api = new DebatidorApiClient('https://api.test', { type: 'api-key', token: 'test' }, upstream);
  await withClient(api, async (client) => {
    await expectInvalid(client, 'debatidor_asset_chunk', { uploadId: `upl_${'a'.repeat(32)}`, index: 0, encoding: 'hex' });
    await expectInvalid(client, 'debatidor_asset_chunk', { uploadId: `upl_${'a'.repeat(32)}`, index: 0 });
  });
  assert.equal(hits, 0);
});
