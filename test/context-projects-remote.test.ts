import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { DebatidorApiClient } from '../src/debatidor-api.js';
import { createDebatidorServer } from '../src/server.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

test('project tools traverse real HTTP MCP and API transports, forwarding project scope and explicit grouping changes', async () => {
  const date = '2026-09-08T06:00:00.000Z';
  const scope = { type: 'project', projectId: 'ctxproj:remote' };
  const project = { id: scope.projectId, name: 'Remote project', createdAt: date, sourceIds: [] as string[] };
  const summary = { id: project.id, name: project.name, createdAt: date, sourceCount: 0 };
  const metadata = { id: 'ctxexp:remote', schemaVersion: 1, scope, format: 'markdown', itemCount: 0, pageCount: 1, expiresAt: date };
  const sources = [
    { id: 'src:private', type: 'USER', label: 'Private', visibility: 'PRIVATE', canDelete: true },
    { id: 'src:shared', type: 'DEBATE', label: 'Shared', visibility: 'WORKSPACE', canDelete: false },
  ];
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const errors: unknown[] = [];
  let deleted = false;
  const backend = createServer((request, response) => {
    void (async () => {
      assert.equal(request.headers.authorization, 'Bearer synthetic_remote_projects');
      assert.equal(request.headers['x-api-key'], undefined);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      const body: unknown = text ? JSON.parse(text) : undefined;
      const url = new URL(request.url ?? '/', 'http://test.local');
      requests.push({ method: request.method ?? '', path: url.pathname + url.search, ...(body === undefined ? {} : { body }) });
      let payload: unknown;
      if (url.pathname === '/context/projects' && request.method === 'POST') {
        assert.deepEqual(body, { name: project.name });
        response.statusCode = 201; payload = project;
      } else if (url.pathname === '/context/projects') {
        assert.equal(url.searchParams.get('limit'), '1');
        payload = url.searchParams.has('cursor')
          ? { projects: [{ ...summary, id: 'ctxproj:second' }], nextCursor: null }
          : { projects: [summary], nextCursor: 'cGFnZTI' };
      } else if (url.pathname === '/context/projects/ctxproj%3Aremote/sources') {
        assert.equal(request.method, 'PUT');
        assert.deepEqual(body, { sourceIds: ['src:private', 'src:shared'] });
        project.sourceIds = ['src:private', 'src:shared']; payload = project;
      } else if (url.pathname === '/context/projects/ctxproj%3Aremote') {
        if (request.method === 'DELETE') { deleted = true; payload = { deleted: true }; }
        else payload = project;
      } else if (url.pathname === '/context/sources') {
        assert.equal(url.searchParams.get('scope'), 'project');
        assert.equal(url.searchParams.get('projectId'), project.id);
        payload = { sources, nextCursor: null };
      } else if (url.pathname === '/context/exports' && request.method === 'POST') {
        assert.deepEqual(body, { scope, format: 'markdown', sourceIds: ['src:private'] });
        response.statusCode = 201; payload = metadata;
      } else if (url.pathname === '/context/exports/ctxexp%3Aremote') {
        if (deleted) { response.statusCode = 410; payload = { message: 'context_export_unavailable' }; }
        else payload = { ...metadata, entries: [], nextCursor: null, markdown: '# Project memory\n\n' };
      } else if (url.pathname === '/context/deletions') {
        assert.deepEqual(body, { mode: 'derived', scope, sourceIds: ['src:private'] });
        response.statusCode = 201;
        payload = { id: 'ctxdel:remote', mode: 'derived', scope, sourceIds: ['src:private'],
          status: 'PENDING', requestedAt: date, completedAt: null, itemCount: 0 };
      } else if (url.pathname === '/context/projects/ctxproj%3Aforeign') {
        response.statusCode = 404; payload = { message: 'context_project_not_found', internal: 'do-not-echo' };
      } else throw new Error(`Unexpected synthetic backend request: ${request.method} ${url.pathname}`);
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(payload));
    })().catch(error => { errors.push(error); response.statusCode = 500; response.end('{}'); });
  });
  let handler: ReturnType<typeof createMcpHandler> | undefined;
  let mcpServer: Server | undefined;
  const client = new Client({ name: 'projects-real-http-test', version: '1' });
  try {
    const api = new DebatidorApiClient(await listen(backend), { type: 'bearer', token: 'synthetic_remote_projects' });
    handler = createMcpHandler(() => createDebatidorServer({ api, publicBaseUrl: 'http://127.0.0.1' }));
    const nodeHandler = toNodeHandler(handler);
    mcpServer = createServer((request, response) => { void nodeHandler(request, response).catch(error => { errors.push(error); response.statusCode = 500; response.end(); }); });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${await listen(mcpServer)}/mcp`)));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      return result.structuredContent as Record<string, unknown>;
    };
    assert.deepEqual(await call('debatidor_create_context_project', { name: project.name }), project);
    const first = await call('debatidor_list_context_projects', { limit: 1 });
    assert.deepEqual(first.projects, [summary]);
    const second = await call('debatidor_list_context_projects', { limit: 1, cursor: first.nextCursor });
    assert.equal(second.nextCursor, null);
    assert.deepEqual(second.projects, [{ ...summary, id: 'ctxproj:second' }]);
    const selected = ['src:private', 'src:shared'];
    assert.deepEqual((await call('debatidor_update_context_project_sources', { projectId: project.id, sourceIds: selected })).sourceIds, selected);
    assert.deepEqual(await call('debatidor_get_context_project', { projectId: project.id }), project);
    assert.deepEqual((await call('debatidor_list_context_sources', { scope: 'project', projectId: project.id })).sources, sources);
    assert.deepEqual(await call('debatidor_export_context', { scope, format: 'markdown', sourceIds: ['src:private'] }), metadata);
    assert.deepEqual((await call('debatidor_read_context_export', { exportId: metadata.id })).scope, scope);
    assert.deepEqual((await call('debatidor_delete_context_sources', { mode: 'derived', scope, sourceIds: ['src:private'] })).scope, scope);
    assert.deepEqual(await call('debatidor_delete_context_project', { projectId: project.id }), { deleted: true });
    const gone = await client.callTool({ name: 'debatidor_read_context_export', arguments: { exportId: metadata.id } });
    assert.equal(gone.isError, true); assert.match(JSON.stringify(gone.content), /no longer available/);
    const foreign = await client.callTool({ name: 'debatidor_get_context_project', arguments: { projectId: 'ctxproj:foreign' } });
    assert.equal(foreign.isError, true); assert.match(JSON.stringify(foreign.content), /unavailable/);
    assert.doesNotMatch(JSON.stringify(foreign), /do-not-echo|synthetic_remote_projects/);
    assert.equal(requests.filter(r => r.method === 'POST').length, 3);
    assert.equal(requests.filter(r => r.method === 'PUT').length, 1);
    assert.equal(requests.filter(r => r.method === 'DELETE').length, 1);
    assert.equal(requests.length, 12);
    assert.deepEqual(errors, []);
  } finally {
    await client.close().catch(() => undefined);
    await handler?.close();
    if (mcpServer) await close(mcpServer);
    await close(backend);
  }
});
