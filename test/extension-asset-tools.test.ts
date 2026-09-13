import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { DebatidorApiClient } from '../src/debatidor-api.js';
import { createDebatidorServerWithAssets } from '../src/agent-asset-tools.js';

const SHA = 'a6b6e62588e786c15e4e1c49b0edb289f7aa186a911de91d9cb86298a4a5228f';
const SECRET_URL = 'https://api.test/asset-relay/upload/art_' + 'a'.repeat(48);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function withClient(api: DebatidorApiClient, run: (client: Client) => Promise<void>) {
  const handler = createMcpHandler(() =>
    createDebatidorServerWithAssets({ api, publicBaseUrl: 'https://mcp.test' }),
  );
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'extension-asset-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await client.close();
    await handler.close();
  }
}

test('debatidor_extension_save_asset is narrow, metadata-only and never exposes relay URL', async () => {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const upstream: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body });
    if (url.endsWith('/asset-relay/tickets') && init?.method === 'POST') {
      return json(
        {
          ticketId: 'tkt_0123456789abcdef01234567',
          direction: 'upload',
          uploader: 'extension',
          status: 'pending',
          agentId: body?.agentId ?? null,
          path: body?.path,
          expectedBytes: body?.expectedBytes,
          expectedSha256: body?.expectedSha256,
          mimeType: body?.mimeType,
          maxBytes: 268435456,
          createdAt: '2026-09-13T00:00:00.000Z',
          expiresAt: '2026-09-13T00:15:00.000Z',
          connectionId: body?.connectionId,
          dispatch: { delivered: true, at: '2026-09-13T00:00:01.000Z' },
          // Defense-in-depth: even if upstream accidentally includes the URL,
          // the dedicated tool must never expose it to the model/client.
          uploadUrl: SECRET_URL,
          methods: ['PUT', 'POST'],
          instructions: { rawPut: `curl ${SECRET_URL}` },
        },
        201,
      );
    }
    return json({ message: 'not_found' }, 404);
  };
  const api = new DebatidorApiClient(
    'https://api.test',
    { type: 'api-key', token: 'test' },
    upstream,
  );

  await withClient(api, async (client) => {
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === 'debatidor_extension_save_asset');
    assert.ok(tool, 'dedicated extension save tool is registered');
    assert.equal(tool.annotations?.openWorldHint, false);
    assert.equal(tool.annotations?.readOnlyHint, false);
    assert.equal(tool.annotations?.destructiveHint, true);

    const result = await client.callTool({
      name: 'debatidor_extension_save_asset',
      arguments: {
        path: 'imagen_original.png',
        agentId: 'vps-workspace',
        connectionId: 'conn_dom_openai',
        expectedBytes: 2070019,
        expectedSha256: SHA,
        mimeType: 'image/png',
      },
    });
    assert.notEqual(result.isError, true);
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured.ticketId, 'tkt_0123456789abcdef01234567');
    assert.equal(structured.fileName, 'imagen_original.png');
    assert.equal(structured.path, 'imagen_original.png');
    assert.equal((structured.dispatch as Record<string, unknown>).delivered, true);
    assert.equal('url' in structured, false);
    assert.equal('uploadUrl' in structured, false);
    assert.equal('instructions' in structured, false);
    assert.equal(JSON.stringify(result).includes(SECRET_URL), false);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.body?.direction, 'upload');
    assert.equal(calls[0]?.body?.uploader, 'extension');
    assert.equal(calls[0]?.body?.path, 'imagen_original.png');
    assert.equal(calls[0]?.body?.agentId, 'vps-workspace');
    assert.equal(calls[0]?.body?.connectionId, 'conn_dom_openai');
    assert.equal(calls[0]?.body?.expectedBytes, 2070019);
    assert.equal(calls[0]?.body?.expectedSha256, SHA);
  });
});
