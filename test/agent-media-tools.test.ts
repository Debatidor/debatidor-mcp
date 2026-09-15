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
const TOKEN = 'art_' + 'a'.repeat(48);

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
          uploader: 'any',
          status: 'pending',
          agentId: body?.agentId ?? null,
          path: body?.path,
          expectedSha256: body?.expectedSha256,
          mimeType: body?.mimeType,
          maxBytes: 268435456,
          createdAt: '2026-09-13T00:00:00.000Z',
          expiresAt: '2026-09-13T00:15:00.000Z',
          uploadUrl: 'https://api.test/asset-relay/upload/' + TOKEN,
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
        uploader: 'any',
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
    assert.equal(structured.uploader, 'any');
    assert.equal(structured.status, 'pending');
    assert.equal(structured.url, 'https://api.test/asset-relay/upload/' + TOKEN);
    assert.deepEqual(structured.methods, ['PUT', 'POST']);
    assert.equal(structured.fileName, 'render.png');
    const text = String((created.content as Array<{ text?: string }>)[0]?.text);
    assert.match(text, /art_a{48}/);
    assert.match(text, /debatidor_asset_ticket_status/);
    assert.equal(calls[0]?.method, 'POST');
    assert.equal(calls[0]?.body?.direction, 'upload');
    assert.equal(calls[0]?.body?.expectedSha256, SHA);
    // uploader='any' no viaja al backend (default del servidor) ni arrastra routing ids.
    assert.equal('uploader' in (calls[0]?.body ?? {}), false);
    assert.equal('connectionId' in (calls[0]?.body ?? {}), false);

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

test("uploader='extension' never returns the URL, surfaces the dispatch result and long-polls status (ADR-0013)", async () => {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  let delivered = true;
  const upstream: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body });
    if (url.endsWith('/asset-relay/tickets') && init?.method === 'POST') {
      return json(
        {
          ticketId: 'tkt_0123456789abcdef01234567',
          direction: 'upload',
          uploader: body?.uploader,
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
          debateId: body?.debateId,
          dispatch: delivered
            ? { delivered: true, at: '2026-09-13T00:00:01.000Z' }
            : { delivered: false, reason: 'no_extension_connected', at: '2026-09-13T00:00:01.000Z' },
          // Un backend mal configurado que devolviera la URL tampoco debe filtrarla al chat.
          uploadUrl: 'https://api.test/asset-relay/upload/' + TOKEN,
          methods: ['PUT', 'POST'],
          instructions: { rawPut: 'curl ' + TOKEN },
        },
        201,
      );
    }
    if (url.includes('/asset-relay/tickets/tkt_0123456789abcdef01234567')) {
      return json({
        ticketId: 'tkt_0123456789abcdef01234567',
        direction: 'upload',
        uploader: 'extension',
        status: 'completed',
        agentId: 'vps',
        path: 'media/render.png',
        maxBytes: 268435456,
        createdAt: '2026-09-13T00:00:00.000Z',
        expiresAt: '2026-09-13T00:15:00.000Z',
        dispatch: { delivered: true, at: '2026-09-13T00:00:01.000Z' },
        result: { path: 'media/render.png', bytes: 4096, sha256: SHA, mimeType: 'image/png', sourceType: 'chunked' },
      });
    }
    return json({ message: 'asset_relay_ticket_not_found' }, 404);
  };
  const api = new DebatidorApiClient('https://api.test', { type: 'api-key', token: 'test' }, upstream);

  await withClient(api, async (client) => {
    const created = await client.callTool({
      name: 'debatidor_asset_ticket',
      arguments: {
        agentId: 'vps',
        path: 'media/render.png',
        uploader: 'extension',
        connectionId: 'conn_dom_claude',
        debateId: 'dbt_1',
        expectedBytes: 4096,
        expectedSha256: SHA,
        mimeType: 'image/png',
      },
    });
    assert.notEqual(created.isError, true);
    const structured = created.structuredContent as Record<string, unknown>;
    assert.equal(structured.uploader, 'extension');
    assert.equal(structured.fileName, 'render.png');
    assert.equal(structured.connectionId, 'conn_dom_claude');
    assert.deepEqual(structured.dispatch, { delivered: true, at: '2026-09-13T00:00:01.000Z' });
    assert.equal('url' in structured, false);
    assert.equal('instructions' in structured, false);
    assert.equal('methods' in structured, false);
    // Ni el texto ni el JSON completo del resultado contienen el token.
    assert.equal(JSON.stringify(created).includes(TOKEN), false);
    const text = String((created.content as Array<{ text?: string }>)[0]?.text);
    assert.match(text, /via browser extension/);
    assert.match(text, /"render\.png"/);
    assert.match(text, /waitSeconds 60/);
    assert.equal(calls[0]?.body?.uploader, 'extension');
    assert.equal(calls[0]?.body?.connectionId, 'conn_dom_claude');
    assert.equal(calls[0]?.body?.debateId, 'dbt_1');
    assert.equal(calls[0]?.body?.expectedBytes, 4096);

    const status = await client.callTool({
      name: 'debatidor_asset_ticket_status',
      arguments: { ticketId: 'tkt_0123456789abcdef01234567', waitSeconds: 60 },
    });
    const statusStructured = status.structuredContent as Record<string, unknown>;
    assert.equal(statusStructured.status, 'completed');
    assert.equal(statusStructured.uploader, 'extension');
    assert.equal((statusStructured.result as Record<string, unknown>).bytes, 4096);
    assert.ok(calls[1]?.url.endsWith('/asset-relay/tickets/tkt_0123456789abcdef01234567?wait=60'), calls[1]?.url);

    // Sin waitSeconds no se añade query.
    await client.callTool({ name: 'debatidor_asset_ticket_status', arguments: { ticketId: 'tkt_0123456789abcdef01234567' } });
    assert.ok(calls[2]?.url.endsWith('/asset-relay/tickets/tkt_0123456789abcdef01234567'), calls[2]?.url);

    // Sin extensión conectada: mensaje accionable, sin URL y sin recomendar chunked para archivos grandes.
    delivered = false;
    const undelivered = await client.callTool({
      name: 'debatidor_asset_ticket',
      arguments: { path: 'media/render.png', uploader: 'extension' },
    });
    const undeliveredText = String((undelivered.content as Array<{ text?: string }>)[0]?.text);
    assert.match(undeliveredText, /NOT delivered \(no_extension_connected\)/);
    assert.equal(JSON.stringify(undelivered).includes(TOKEN), false);
    assert.equal((undelivered.structuredContent as Record<string, unknown>).status, 'pending');

    // extension + download es un error de uso, sin llamar al backend.
    const before = calls.length;
    const wrong = await client.callTool({
      name: 'debatidor_asset_ticket',
      arguments: { path: 'media/render.png', direction: 'download', uploader: 'extension' },
    });
    assert.equal(wrong.isError, true);
    assert.equal(calls.length, before);
  });
});

test('media tool descriptions encode the URL -> ticket -> extension -> chunk hierarchy', async () => {
  const api = new DebatidorApiClient('https://api.test', { type: 'api-key', token: 'test' }, async () => json({}));
  await withClient(api, async (client) => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool.description ?? '']));
    assert.match(byName.get('debatidor_agent_put') ?? '', /STEP 1/);
    assert.match(byName.get('debatidor_asset_ticket') ?? '', /1\) public HTTPS URL exists -> debatidor_agent_put/);
    assert.match(byName.get('debatidor_asset_ticket') ?? '', /uploader='extension'/);
    assert.match(byName.get('debatidor_asset_ticket_status') ?? '', /waitSeconds/);
    assert.match(byName.get('debatidor_asset_begin') ?? '', /LAST RESORT/);
  });
});
