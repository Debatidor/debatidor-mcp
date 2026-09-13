import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { DebatidorApiClient } from '../src/debatidor-api.js';
import { createDebatidorServerWithAssets } from '../src/agent-asset-tools.js';

// PNG 1x1 real (67 bytes) para validar el bloque image de extremo a extremo.
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SHA = 'd'.repeat(64);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function withClient(api: DebatidorApiClient, run: (client: Client) => Promise<void>) {
  const handler = createMcpHandler(() => createDebatidorServerWithAssets({ api, publicBaseUrl: 'https://mcp.test' }));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'media-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await client.close();
    await handler.close();
  }
}

test('debatidor_agent_get returns an image block for viewable images and hides base64 from structuredContent', async () => {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const upstream: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body });
    if (body?.metadataOnly === true) {
      return json({ tool: 'fs.get', agentId: 'vps', ok: true, path: body.path, bytes: 67, sha256: SHA, mimeType: 'image/png', width: 1, height: 1, metadataOnly: true });
    }
    if (body?.path === 'media/huge.mp4') {
      return json({ tool: 'fs.get', agentId: 'vps', ok: false, path: body.path, error: 'asset_too_large_for_inline:900000000:8388608' });
    }
    if (body?.path === 'docs/manual.pdf') {
      return json({ tool: 'fs.get', agentId: 'vps', ok: true, path: body.path, bytes: 4, sha256: SHA, mimeType: 'application/pdf', base64: 'JVBERi0=' });
    }
    return json({ tool: 'fs.get', agentId: 'vps', ok: true, path: body?.path, bytes: 67, sha256: SHA, mimeType: 'image/png', width: 1, height: 1, base64: PNG_1X1_BASE64 });
  };
  const api = new DebatidorApiClient('https://api.test', { type: 'api-key', token: 'test' }, upstream);

  await withClient(api, async (client) => {
    const tools = await client.listTools();
    for (const name of ['debatidor_agent_get', 'debatidor_asset_ticket', 'debatidor_asset_ticket_status']) {
      assert.ok(tools.tools.some((tool) => tool.name === name), `${name} registered`);
    }

    const image = await client.callTool({ name: 'debatidor_agent_get', arguments: { agentId: 'vps', path: 'media/pixel.png' } });
    const content = image.content as Array<Record<string, unknown>>;
    assert.equal(content[0]?.type, 'image');
    assert.equal(content[0]?.mimeType, 'image/png');
    assert.equal(content[0]?.data, PNG_1X1_BASE64);
    assert.equal(content[1]?.type, 'text');
    const structured = image.structuredContent as Record<string, unknown>;
    assert.equal(structured.inline, true);
    assert.equal(structured.width, 1);
    assert.equal(structured.sha256, SHA);
    assert.equal('base64' in structured, false);
    assert.equal(calls[0]?.body?.tool, 'fs.get');
    assert.equal(calls[0]?.body?.metadataOnly, false);

    const meta = await client.callTool({ name: 'debatidor_agent_get', arguments: { agentId: 'vps', path: 'media/pixel.png', metadataOnly: true } });
    const metaContent = meta.content as Array<Record<string, unknown>>;
    assert.equal(metaContent.length, 1);
    assert.equal(metaContent[0]?.type, 'text');
    assert.equal((meta.structuredContent as Record<string, unknown>).inline, false);
    assert.equal((meta.structuredContent as Record<string, unknown>).metadataOnly, true);

    const pdf = await client.callTool({ name: 'debatidor_agent_get', arguments: { agentId: 'vps', path: 'docs/manual.pdf' } });
    const pdfContent = pdf.content as Array<Record<string, unknown>>;
    assert.equal(pdfContent[0]?.type, 'resource');
    const resource = pdfContent[0]?.resource as Record<string, unknown>;
    assert.equal(resource.mimeType, 'application/pdf');
    assert.equal(resource.blob, 'JVBERi0=');
    assert.ok(String(resource.uri).startsWith('debatidor-agent://vps/'));

    const huge = await client.callTool({ name: 'debatidor_agent_get', arguments: { agentId: 'vps', path: 'media/huge.mp4' } });
    assert.equal(huge.isError, true);
    const hugeText = String((huge.content as Array<{ text?: string }>)[0]?.text);
    assert.match(hugeText, /download ticket/);
  });
});

test('debatidor_asset_ticket forwards the request and returns the single-use URL; status reads it back', async () => {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const upstream: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body });
    if (url.endsWith('/asset-relay/tickets') && init?.method === 'POST') {
      return json(
        {
          ticketId: 'tkt_0123456789abcdef01234567',
          direction: body?.direction,
          status: 'pending',
          agentId: body?.agentId ?? null,
          path: body?.path,
          expectedSha256: body?.expectedSha256,
          mimeType: body?.mimeType,
          maxBytes: 268435456,
          createdAt: '2026-09-13T00:00:00.000Z',
          expiresAt: '2026-09-13T00:15:00.000Z',
          uploadUrl: 'https://api.test/asset-relay/upload/art_' + 'a'.repeat(48),
          methods: ['PUT', 'POST'],
          instructions: { rawPut: 'curl ...' },
        },
        201,
      );
    }
    if (url.endsWith('/asset-relay/tickets/tkt_0123456789abcdef01234567')) {
      return json({
        ticketId: 'tkt_0123456789abcdef01234567',
        direction: 'upload',
        status: 'completed',
        agentId: 'vps',
        path: 'media/render.png',
        maxBytes: 268435456,
        createdAt: '2026-09-13T00:00:00.000Z',
        expiresAt: '2026-09-13T00:15:00.000Z',
        result: { path: 'media/render.png', bytes: 123456, sha256: SHA, mimeType: 'image/png', sourceType: 'chunked' },
      });
    }
    return json({ message: 'asset_relay_ticket_not_found' }, 404);
  };
  const api = new DebatidorApiClient('https://api.test', { type: 'api-key', token: 'test' }, upstream);

  await withClient(api, async (client) => {
    const created = await client.callTool({
      name: 'debatidor_asset_ticket',
      arguments: { agentId: 'vps', path: 'media/render.png', expectedSha256: SHA, mimeType: 'image/png', ttlSeconds: 900 },
    });
    const structured = created.structuredContent as Record<string, unknown>;
    assert.equal(structured.direction, 'upload');
    assert.equal(structured.status, 'pending');
    assert.equal(structured.url, 'https://api.test/asset-relay/upload/art_' + 'a'.repeat(48));
    assert.deepEqual(structured.methods, ['PUT', 'POST']);
    const text = String((created.content as Array<{ text?: string }>)[0]?.text);
    assert.match(text, /art_a{48}/);
    assert.match(text, /debatidor_asset_ticket_status/);
    assert.equal(calls[0]?.method, 'POST');
    assert.equal(calls[0]?.body?.direction, 'upload');
    assert.equal(calls[0]?.body?.expectedSha256, SHA);

    const status = await client.callTool({ name: 'debatidor_asset_ticket_status', arguments: { ticketId: 'tkt_0123456789abcdef01234567' } });
    const statusStructured = status.structuredContent as Record<string, unknown>;
    assert.equal(statusStructured.status, 'completed');
    assert.equal((statusStructured.result as Record<string, unknown>).sha256, SHA);
    assert.equal(calls[1]?.method, 'GET');
    assert.ok(calls[1]?.url.endsWith('/asset-relay/tickets/tkt_0123456789abcdef01234567'));

    const missing = await client.callTool({ name: 'debatidor_asset_ticket_status', arguments: { ticketId: 'tkt_ffffffffffffffffffffffff' } });
    assert.equal(missing.isError, true);
    assert.match(String((missing.content as Array<{ text?: string }>)[0]?.text), /not found/);
  });
});

test('media tool descriptions encode the URL -> ticket -> chunk hierarchy', async () => {
  const api = new DebatidorApiClient('https://api.test', { type: 'api-key', token: 'test' }, async () => json({}));
  await withClient(api, async (client) => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool.description ?? '']));
    assert.match(byName.get('debatidor_agent_put') ?? '', /STEP 1/);
    assert.match(byName.get('debatidor_asset_ticket') ?? '', /1\) public HTTPS URL exists -> debatidor_agent_put/);
    assert.match(byName.get('debatidor_asset_begin') ?? '', /LAST RESORT/);
  });
});
