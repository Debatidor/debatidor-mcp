import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { DebatidorApiClient } from '../src/debatidor-api.js';
import { createDebatidorServer } from '../src/server.js';

const date = '2026-09-08T06:00:00.000Z';
const project = (sourceIds: string[] = []) => ({ id: 'ctxproj:one', name: 'Contexto seleccionado', createdAt: date, sourceIds });
const scope = { type: 'project' as const, projectId: 'ctxproj:one' };
const metadata = () => ({ id: 'ctxexp:one', schemaVersion: 1, scope, format: 'markdown', itemCount: 0, pageCount: 1, expiresAt: date });
const operation = () => ({ id: 'ctxdel:one', status: 'PENDING', mode: 'derived', scope, sourceIds: ['src:one'], requestedAt: date, completedAt: null, itemCount: 1 });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const apiWith = (fetcher: typeof fetch) => new DebatidorApiClient('https://api.test', { type: 'bearer', token: 'synthetic_project_token' }, fetcher);

async function withClient(api: DebatidorApiClient, run: (client: Client) => Promise<void>) {
  const handler = createMcpHandler(() => createDebatidorServer({ api, publicBaseUrl: 'https://mcp.test' }));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'context-projects-test', version: '1' });
  try { await client.connect(transport); await run(client); }
  finally { await client.close(); await handler.close(); }
}

test('project API client preserves explicit create, read, replace and clear requests, stripping internal response fields', async () => {
  let payload: unknown = { ...project(), ownerUserId: 'hidden', jobs: ['hidden'] };
  let status = 201;
  const requests: Array<{ path: string; method?: string; body?: unknown }> = [];
  const api = apiWith(async (url, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic_project_token');
    requests.push({ path: new URL(String(url)).pathname, method: init?.method,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return response(payload, status);
  });
  assert.deepEqual(await api.createContextProject({ name: ' Contexto seleccionado ' }), project());
  status = 200;
  assert.deepEqual(await api.getContextProject('ctxproj:one'), project());
  payload = project(['src:shared', 'src:private']);
  assert.deepEqual((await api.replaceContextProjectSources({ projectId: 'ctxproj:one', sourceIds: ['src:private', 'src:shared'] })).sourceIds, ['src:shared', 'src:private']);
  payload = project();
  assert.deepEqual((await api.replaceContextProjectSources({ projectId: 'ctxproj:one', sourceIds: [] })).sourceIds, []);
  payload = { deleted: true, sourceIds: ['not-returned'] };
  assert.deepEqual(await api.deleteContextProject('ctxproj:one'), { deleted: true });
  assert.deepEqual(requests, [
    { path: '/context/projects', method: 'POST', body: { name: 'Contexto seleccionado' } },
    { path: '/context/projects/ctxproj%3Aone', method: 'GET', body: undefined },
    { path: '/context/projects/ctxproj%3Aone/sources', method: 'PUT', body: { sourceIds: ['src:private', 'src:shared'] } },
    { path: '/context/projects/ctxproj%3Aone/sources', method: 'PUT', body: { sourceIds: [] } },
    { path: '/context/projects/ctxproj%3Aone', method: 'DELETE', body: undefined },
  ]);
});

test('project response parser rejects wrong identity, partial replacement, duplicate sources and unexpected status', async () => {
  let payload: unknown = project();
  let status = 200;
  const api = apiWith(async () => response(payload, status));
  for (const invalid of [
    { ...project(), id: 'ctxproj:other' }, { ...project(), name: '' }, { ...project(), createdAt: 'yesterday' },
    { ...project(), sourceIds: ['src:one', 'src:one'] }, { ...project(), sourceIds: Array.from({ length: 101 }, (_, i) => `src:${i}`) },
  ]) {
    payload = invalid;
    await assert.rejects(() => api.getContextProject('ctxproj:one'), /context_response_invalid/);
  }
  for (const invalid of [project([]), project(['src:other']), project(['src:one', 'src:other'])]) {
    payload = invalid;
    await assert.rejects(() => api.replaceContextProjectSources({ projectId: 'ctxproj:one', sourceIds: ['src:one'] }), /context_response_invalid/);
  }
  payload = project(); status = 200;
  await assert.rejects(() => api.createContextProject({ name: project().name }), /context_response_invalid/);
  status = 201; payload = project(['src:one']);
  await assert.rejects(() => api.createContextProject({ name: project().name }), /context_response_invalid/);
  payload = { ...project(), name: 'Other name' };
  await assert.rejects(() => api.createContextProject({ name: project().name }), /context_response_invalid/);
  payload = { deleted: false }; status = 200;
  await assert.rejects(() => api.deleteContextProject('ctxproj:one'), /context_response_invalid/);
});

test('project list enforces declared keyset page bounds and catalog queries support mixed visibility only in project scope', async () => {
  const summary = { id: 'ctxproj:one', name: project().name, createdAt: date, sourceCount: 2 };
  let payload: unknown = { projects: [summary], nextCursor: 'cGFnZTI' };
  let seen = '';
  const api = apiWith(async url => { seen = String(url); return response(payload); });
  assert.equal((await api.listContextProjects({ cursor: 'cGFnZTE', limit: 1 })).projects.length, 1);
  assert.equal(seen, 'https://api.test/context/projects?cursor=cGFnZTE&limit=1');
  for (const invalid of [
    { projects: [summary], nextCursor: 'cGFnZTE' }, { projects: [], nextCursor: 'cGFnZTI' },
    { projects: [summary, summary], nextCursor: null }, { projects: [{ ...summary, sourceCount: 101 }], nextCursor: null },
    { projects: [summary, { ...summary, id: 'ctxproj:two' }], nextCursor: null },
  ]) {
    payload = invalid;
    await assert.rejects(() => api.listContextProjects({ cursor: 'cGFnZTE', limit: 1 }), /context_response_invalid/);
  }
  const sources = [
    { id: 'src:private', type: 'USER', label: 'Private', visibility: 'PRIVATE', canDelete: true },
    { id: 'src:shared', type: 'DEBATE', label: 'Shared', visibility: 'WORKSPACE', canDelete: false },
  ];
  payload = { sources, nextCursor: null };
  assert.deepEqual((await api.listContextSources({ scope: 'project', projectId: 'ctxproj:a/b', limit: 2 })).sources, sources);
  assert.equal(seen, 'https://api.test/context/sources?scope=project&projectId=ctxproj%3Aa%2Fb&limit=2');
  for (const selected of ['user', 'workspace'] as const) {
    await assert.rejects(() => api.listContextSources({ scope: selected, limit: 2 }), /context_response_invalid/);
  }
});

test('project export and derived deletion require matching returned project identity without weakening user/workspace scopes', async () => {
  let payload: unknown = metadata();
  let sent: unknown;
  const api = apiWith(async (_url, init) => { sent = JSON.parse(String(init?.body)); return response(payload, 201); });
  const exportInput = { scope, format: 'markdown' as const, sourceIds: ['src:one'] };
  assert.deepEqual(await api.createContextExport(exportInput), metadata());
  assert.deepEqual(sent, exportInput);
  for (const invalid of [
    { ...metadata(), scope: { type: 'project' } },
    { ...metadata(), scope: { type: 'project', projectId: 'ctxproj:other' } },
    { ...metadata(), scope: { type: 'user' } },
    { ...metadata(), scope: { type: 'user', projectId: 'ctxproj:one' } },
  ]) {
    payload = invalid;
    await assert.rejects(() => api.createContextExport(exportInput), /context_response_invalid/);
  }
  payload = operation();
  const deleteInput = { mode: 'derived' as const, scope, sourceIds: ['src:one'] };
  assert.deepEqual(await api.deleteContextSources(deleteInput), operation());
  assert.deepEqual(sent, deleteInput);
  payload = { ...operation(), scope: { type: 'project', projectId: 'ctxproj:other' } };
  await assert.rejects(() => api.deleteContextSources(deleteInput), /context_response_invalid/);
});

test('SDK rejects missing or contradictory project scopes and unsafe collection inputs before contacting backend', async () => {
  let calls = 0;
  await withClient(apiWith(async () => { calls++; return response({}); }), async client => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['debatidor_list_context_sources', { scope: 'project' }],
      ['debatidor_list_context_sources', { scope: 'user', projectId: 'ctxproj:one' }],
      ['debatidor_list_context_sources', { projectId: 'ctxproj:one' }],
      ['debatidor_export_context', { scope: { type: 'project' }, format: 'markdown' }],
      ['debatidor_export_context', { scope: { type: 'user', projectId: 'ctxproj:one' }, format: 'markdown' }],
      ['debatidor_delete_context_sources', { mode: 'derived', scope, sourceIds: [] }],
      ['debatidor_create_context_project', { name: ' '.repeat(20) }],
      ['debatidor_create_context_project', { name: 'x'.repeat(121) }],
      ['debatidor_create_context_project', { name: 'name\u0000suffix' }],
      ['debatidor_get_context_project', { projectId: '..' }],
      ['debatidor_delete_context_project', { projectId: '' }],
      ['debatidor_list_context_projects', { limit: 101 }],
      ['debatidor_list_context_projects', { cursor: 'bad&param=all' }],
      ['debatidor_update_context_project_sources', { projectId: 'ctxproj:one' }],
      ['debatidor_update_context_project_sources', { projectId: 'ctxproj:one', sourceIds: ['src:one', 'src:one'] }],
      ['debatidor_update_context_project_sources', { projectId: 'ctxproj:one', sourceIds: Array.from({ length: 101 }, (_, i) => `src:${i}`) }],
    ];
    for (const [name, args] of cases) assert.equal((await client.callTool({ name, arguments: args })).isError, true, name);
    assert.equal(calls, 0);
  });
});

test('SDK project annotations describe reads, explicit creation, replacement and collection deletion accurately', async () => {
  await withClient(apiWith(async () => response({})), async client => {
    const { tools } = await client.listTools();
    for (const [name, readOnlyHint, destructiveHint, idempotentHint] of [
      ['list_context_projects', true, false, true], ['get_context_project', true, false, true],
      ['create_context_project', false, false, false], ['update_context_project_sources', false, true, true],
      ['delete_context_project', false, true, false],
    ] as const) {
      assert.deepEqual(tools.find(tool => tool.name === `debatidor_${name}`)?.annotations,
        { readOnlyHint, destructiveHint, idempotentHint, openWorldHint: false });
    }
  });
});

test('SDK project foreign access and owner-only deletion errors remain explicit, redact internals and never retry', async () => {
  let calls = 0;
  let status = 404;
  let code = 'context_project_not_found';
  await withClient(apiWith(async () => { calls++; return response({ message: code, token: 'do-not-echo' }, status); }), async client => {
    for (const name of ['debatidor_get_context_project', 'debatidor_delete_context_project']) {
      const before = calls;
      const result = await client.callTool({ name, arguments: { projectId: 'ctxproj:foreign' } });
      assert.equal(result.isError, true); assert.match(JSON.stringify(result.content), /unavailable/);
      assert.doesNotMatch(JSON.stringify(result), /do-not-echo|synthetic_project_token/);
      assert.equal(calls - before, 1);
    }
    status = 403; code = 'context_workspace_owner_required';
    const forbidden = await client.callTool({ name: 'debatidor_delete_context_sources', arguments: { mode: 'derived', scope, sourceIds: ['src:shared'] } });
    assert.equal(forbidden.isError, true); assert.match(JSON.stringify(forbidden.content), /workspace owner/);
    assert.doesNotMatch(JSON.stringify(forbidden.content), /Reconnect/);
    assert.match(JSON.stringify(forbidden.content), /No automatic retry/);
    assert.equal(calls, 3);
    status = 429; code = 'context_project_quota';
    const quota = await client.callTool({ name: 'debatidor_create_context_project', arguments: { name: 'One more' } });
    assert.equal(quota.isError, true); assert.match(JSON.stringify(quota.content), /project limit/);
    assert.match(JSON.stringify(quota.content), /No automatic retry/);
    assert.equal(calls, 4);
  });
});

test('a project mutation with malformed success or transport failure is surfaced once without inferred completion', async () => {
  let calls = 0;
  let transportFailure = false;
  await withClient(apiWith(async () => {
    calls++;
    if (transportFailure) throw new Error('synthetic_project_token do-not-echo');
    return response({ ...project(), id: 'ctxproj:wrong' });
  }), async client => {
    const malformed = await client.callTool({ name: 'debatidor_update_context_project_sources', arguments: { projectId: 'ctxproj:one', sourceIds: [] } });
    assert.equal(malformed.isError, true); assert.match(JSON.stringify(malformed.content), /invalid response/);
    assert.equal(malformed.structuredContent, undefined);
    transportFailure = true;
    const failed = await client.callTool({ name: 'debatidor_delete_context_project', arguments: { projectId: 'ctxproj:one' } });
    assert.equal(failed.isError, true); assert.match(JSON.stringify(failed.content), /do not infer completion/);
    assert.doesNotMatch(JSON.stringify(failed), /synthetic_project_token|do-not-echo/);
    assert.equal(calls, 2);
  });
});
