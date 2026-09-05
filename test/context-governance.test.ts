import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { DebatidorApiClient } from '../src/debatidor-api.js';
import { createDebatidorServer } from '../src/server.js';

const date = '2026-09-05T15:00:00.000Z';
const entry = (id = 'ctx:manual:one') => ({
  id, sourceId: 'ctxsrc:user:one', debateId: null, kind: 'FACT', content: 'Full memory 🧠\n'.repeat(600),
  createdAt: date, provenance: { messageId: null, sourceRevision: 1, originType: 'MANUAL', originId: 'one' },
});
const metadata = (count = 0, format = 'json') => ({
  id: 'ctxexp:one', schemaVersion: 1, scope: { type: 'user' }, format,
  itemCount: count, pageCount: Math.max(1, Math.ceil(count / 100)), expiresAt: date,
});
const operation = () => ({
  id: 'ctxdel:one', status: 'PENDING', mode: 'derived', scope: { type: 'user' },
  sourceIds: ['ctxsrc:user:one'], requestedAt: date, completedAt: null, itemCount: 1,
});
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const apiWith = (fetcher: typeof fetch) => new DebatidorApiClient('https://api.test', { type: 'bearer', token: 'synthetic_governance_token' }, fetcher);

async function withClient(api: DebatidorApiClient, run: (client: Client) => Promise<void>) {
  const handler = createMcpHandler(() => createDebatidorServer({ api, publicBaseUrl: 'https://mcp.test' }));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'context-governance-test', version: '1' });
  try { await client.connect(transport); await run(client); }
  finally { await client.close(); await handler.close(); }
}

test('full memory detail preserves long content and encodes ids without returning unknown upstream fields', async () => {
  const id = 'ctx:manual:a/b?filter=all#x';
  let url = '';
  const api = apiWith(async (input, init) => {
    url = String(input);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.body, undefined);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic_governance_token');
    return response({ ...entry(id), canDelete: true, embedding: [1], internalJob: 'hidden',
      provenance: { ...entry().provenance, chunk: { id: 'search-only' } } });
  });
  const result = await api.getContextItem(id);
  assert.equal(url, `https://api.test/context/items/${encodeURIComponent(id)}`);
  assert.equal(result.content, entry().content);
  assert.ok(result.content.length > 6000);
  assert.equal('embedding' in result, false);
  assert.equal('internalJob' in result, false);
  assert.equal('chunk' in result.provenance, false);
  await assert.rejects(() => api.getContextItem('..'));
});

test('source listing forwards safe keyset parameters and rejects wrong scope, oversized and duplicate pages', async () => {
  const source = { id: 'src:one', type: 'USER', label: 'User memory', visibility: 'PRIVATE', canDelete: true };
  let payload: unknown = { sources: [source], nextCursor: 'c3JjOm9uZQ' };
  let seen = '';
  const api = apiWith(async input => { seen = String(input); return response(payload); });
  assert.equal((await api.listContextSources({ limit: 1 })).sources.length, 1);
  assert.equal(seen, 'https://api.test/context/sources?scope=user&limit=1');
  for (const invalid of [
    { sources: [{ ...source, visibility: 'WORKSPACE' }], nextCursor: null },
    { sources: [source, { ...source, id: 'src:two' }], nextCursor: null },
    { sources: [source, source], nextCursor: null },
    { sources: [], nextCursor: 'c3JjOm9uZQ' },
  ]) {
    payload = invalid;
    await assert.rejects(() => api.listContextSources({ limit: 1 }), /context_response_invalid/);
  }
});

test('export creation returns only validated metadata, forwards explicit filters, and requires HTTP 201', async () => {
  let sent: RequestInit | undefined;
  let status = 201;
  let payload: unknown = { ...metadata(), downloadUrl: 'https://not-a-contract.test', entries: [entry()] };
  const api = apiWith(async (_url, init) => { sent = init; return response(payload, status); });
  const input = { scope: { type: 'user' as const }, format: 'json' as const, kinds: ['FACT' as const], sourceIds: ['src:one'] };
  assert.deepEqual(await api.createContextExport(input), metadata());
  assert.equal(sent?.method, 'POST');
  assert.deepEqual(JSON.parse(String(sent?.body)), input);
  for (const invalid of [{ ...metadata(), format: 'markdown' }, { ...metadata(), scope: { type: 'workspace' } }, { ...metadata(101), pageCount: 1 }]) {
    payload = invalid;
    await assert.rejects(() => api.createContextExport(input), /context_response_invalid/);
  }
  payload = metadata(); status = 202;
  await assert.rejects(() => api.createContextExport(input), /context_response_invalid/);
});

test('export pages preserve full content and accept empty JSON and Markdown snapshots', async () => {
  let payload: unknown = { ...metadata(), entries: [], nextCursor: null, markdown: null };
  const api = apiWith(async () => response(payload));
  assert.deepEqual((await api.readContextExport({ exportId: 'ctxexp:one' })).entries, []);
  payload = { ...metadata(0, 'markdown'), entries: [], nextCursor: null, markdown: '# Debatidor memory export\n\nSchema: 1\n\n' };
  assert.match((await api.readContextExport({ exportId: 'ctxexp:one' })).markdown ?? '', /Schema: 1/);
  payload = { ...metadata(1), entries: [entry()], nextCursor: null, markdown: null };
  assert.equal((await api.readContextExport({ exportId: 'ctxexp:one' })).entries[0].content, entry().content);
  payload = { ...metadata(1), entries: [{ ...entry(), content: '' }], nextCursor: null, markdown: null };
  assert.equal((await api.readContextExport({ exportId: 'ctxexp:one' })).entries[0].content, '');
});

test('export response rejects truncated success, malformed counts, format mismatch and inconsistent cursor', async () => {
  const valid = { ...metadata(1), entries: [entry()], nextCursor: null, markdown: null };
  const invalidPages = [
    { ...valid, entries: [] }, { ...valid, pageCount: 2 }, { ...valid, id: 'ctxexp:other' },
    { ...valid, nextCursor: '100' }, { ...valid, markdown: 'unexpected json markup' },
    { ...valid, format: 'markdown', markdown: null },
    { ...valid, itemCount: 101, pageCount: 2 },
    { ...valid, itemCount: 2, entries: [entry(), entry()] },
    { ...valid, itemCount: 101, pageCount: 2, entries: Array.from({ length: 101 }, (_, i) => entry(`id:${i}`)) },
  ];
  for (const page of invalidPages) {
    const api = apiWith(async () => response(page));
    await assert.rejects(() => api.readContextExport({ exportId: 'ctxexp:one' }), /context_response_invalid/);
  }
});

test('item deletion distinguishes HTTP 200 completion from HTTP 202 pending without retry', async () => {
  let calls = 0;
  let body: unknown = { deleted: false, operationId: 'ctxdel:one', status: 'PENDING' };
  let status = 202;
  const api = apiWith(async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://api.test/context/items/ctx%3Amanual%3Aone');
    assert.equal(init?.method, 'DELETE'); assert.equal(init?.body, undefined);
    return response(body, status);
  });
  assert.deepEqual(await api.deleteContextItem('ctx:manual:one'), body);
  body = { deleted: true }; status = 200;
  assert.deepEqual(await api.deleteContextItem('ctx:manual:one'), { deleted: true });
  for (const invalid of [
    { body: { deleted: true }, status: 202 },
    { body: { deleted: false, operationId: 'ctxdel:one', status: 'PENDING' }, status: 200 },
    { body: { deleted: false }, status: 202 },
    { body: { deleted: true, status: 'PENDING' }, status: 200 },
  ]) {
    body = invalid.body; status = invalid.status;
    await assert.rejects(() => api.deleteContextItem('ctx:manual:one'), /context_response_invalid/);
  }
  assert.equal(calls, 6);
});

test('deletion status validates timestamp and identity while permitting more than 100 admitted sources', async () => {
  let payload: unknown = { ...operation(), sourceIds: Array.from({ length: 101 }, (_, i) => `src:${i}`) };
  const api = apiWith(async () => response(payload));
  assert.equal((await api.getContextDeletion('ctxdel:one')).sourceIds.length, 101);
  for (const invalid of [{ ...operation(), id: 'other' }, { ...operation(), status: 'COMPLETED' }, { ...operation(), completedAt: date }]) {
    payload = invalid;
    await assert.rejects(() => api.getContextDeletion('ctxdel:one'), /context_response_invalid/);
  }
});

test('governance MCP annotations distinguish read, snapshot creation and destructive mutations', async () => {
  await withClient(apiWith(async () => response({})), async client => {
    const { tools } = await client.listTools();
    const read = ['get_context_item', 'list_context_sources', 'read_context_export', 'get_context_deletion', 'get_context_governance'];
    for (const name of read) assert.deepEqual(tools.find(t => t.name === `debatidor_${name}`)?.annotations,
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    for (const name of ['delete_context_item', 'delete_context_export']) assert.deepEqual(tools.find(t => t.name === `debatidor_${name}`)?.annotations,
      { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    assert.deepEqual(tools.find(t => t.name === 'debatidor_export_context')?.annotations,
      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    const deletion = tools.find(t => t.name === 'debatidor_delete_context_sources');
    assert.deepEqual(deletion?.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
    assert.deepEqual(deletion?.inputSchema.required, ['mode', 'scope', 'sourceIds']);
  });
});

test('SDK rejects unsafe or unbounded governance input before any upstream request', async () => {
  let calls = 0;
  await withClient(apiWith(async () => { calls++; return response({}); }), async client => {
    const cases = [
      ['debatidor_get_context_item', { itemId: '..' }],
      ['debatidor_list_context_sources', { limit: 101 }],
      ['debatidor_read_context_export', { exportId: 'ctxexp:one', cursor: '1' }],
      ['debatidor_export_context', { scope: { type: 'user' }, format: 'zip' }],
      ['debatidor_export_context', { scope: { type: 'user' }, format: 'json', kinds: [] }],
      ['debatidor_export_context', { scope: { type: 'user' }, format: 'json', sourceIds: Array(101).fill('src') }],
      ['debatidor_delete_context_sources', { mode: 'derived', scope: { type: 'workspace' } }],
      ['debatidor_delete_context_sources', { mode: 'raw', scope: { type: 'user' }, sourceIds: ['src'] }],
      ['debatidor_delete_context_sources', { mode: 'derived', scope: { type: 'user' }, sourceIds: [] }],
    ] as const;
    for (const [name, args] of cases) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, name);
    }
    assert.equal(calls, 0);
  });
});

test('SDK reports safe 401/403/404/410/413/429/500 errors and never automatically repeats a mutation', async () => {
  let calls = 0;
  let upstream = { status: 401, code: 'not-authorized' };
  const api = apiWith(async () => { calls++; return response({ message: upstream.code, secret: 'do-not-echo' }, upstream.status); });
  await withClient(api, async client => {
    const cases = [
      { status: 401, code: 'not-authorized', expected: /Reconnect/ },
      { status: 403, code: 'context_workspace_owner_required', expected: /workspace owner/ },
      { status: 404, code: 'context_source_not_found', expected: /unavailable/ },
      { status: 410, code: 'context_export_unavailable', expected: /no longer available/ },
      { status: 413, code: 'context_export_too_large', expected: /exceeds/ },
      { status: 429, code: 'context_export_quota', expected: /limit was reached/ },
      { status: 500, code: 'private-upstream-stack-do-not-echo', expected: /500/ },
    ];
    for (const item of cases) {
      upstream = item;
      const before = calls;
      const result = await client.callTool({ name: 'debatidor_export_context', arguments: { scope: { type: 'user' }, format: 'json' } });
      assert.equal(result.isError, true);
      const text = JSON.stringify(result.content);
      assert.match(text, item.expected); assert.match(text, /No automatic retry/);
      assert.doesNotMatch(text, /do-not-echo|synthetic_governance_token/);
      assert.equal(calls - before, 1);
    }
  });
});

test('SDK exposes PENDING item cleanup as pending and reports explicit deletion status without a retry', async () => {
  const paths: string[] = [];
  const api = apiWith(async (url, init) => {
    paths.push(`${init?.method} ${new URL(String(url)).pathname}`);
    return init?.method === 'DELETE'
      ? response({ deleted: false, operationId: 'ctxdel:one', status: 'PENDING' }, 202)
      : response({ ...operation(), status: 'COMPLETED', completedAt: date });
  });
  await withClient(api, async client => {
    const deleted = await client.callTool({ name: 'debatidor_delete_context_item', arguments: { itemId: 'ctx:manual:one' } });
    assert.equal(deleted.isError, undefined);
    assert.equal((deleted.structuredContent as { deleted: boolean }).deleted, false);
    assert.match(JSON.stringify(deleted.content), /physical cleanup is PENDING/);
    const status = await client.callTool({ name: 'debatidor_get_context_deletion', arguments: { operationId: 'ctxdel:one' } });
    assert.equal(status.isError, undefined);
    assert.equal((status.structuredContent as { status: string }).status, 'COMPLETED');
    assert.deepEqual(paths, ['DELETE /context/items/ctx%3Amanual%3Aone', 'GET /context/deletions/ctxdel%3Aone']);
  });
});

test('SDK creates and reads an empty JSON export without changing omitted source or kind filters', async () => {
  const calls: Array<{ method?: string; body?: unknown }> = [];
  await withClient(apiWith(async (_url, init) => {
    calls.push({ method: init?.method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return init?.method === 'POST' ? response(metadata(), 201)
      : response({ ...metadata(), entries: [], nextCursor: null, markdown: null });
  }), async client => {
    const created = await client.callTool({ name: 'debatidor_export_context', arguments: { scope: { type: 'user' }, format: 'json' } });
    assert.equal(created.isError, undefined);
    assert.deepEqual(created.structuredContent, metadata());
    const page = await client.callTool({ name: 'debatidor_read_context_export', arguments: { exportId: 'ctxexp:one' } });
    assert.equal(page.isError, undefined);
    assert.deepEqual(page.structuredContent, { ...metadata(), entries: [], nextCursor: null, markdown: null });
    assert.deepEqual(calls, [
      { method: 'POST', body: { scope: { type: 'user' }, format: 'json' } }, { method: 'GET', body: undefined },
    ]);
  });
});

test('a mutation transport failure is reported once without exposing credentials or claiming completion', async () => {
  let calls = 0;
  await withClient(apiWith(async () => { calls++; throw new Error('synthetic_governance_token must not leak'); }), async client => {
    const result = await client.callTool({ name: 'debatidor_delete_context_export', arguments: { exportId: 'ctxexp:one' } });
    assert.equal(result.isError, true);
    assert.equal(calls, 1);
    assert.match(JSON.stringify(result.content), /do not infer completion/);
    assert.doesNotMatch(JSON.stringify(result), /synthetic_governance_token|must not leak/);
  });
});
