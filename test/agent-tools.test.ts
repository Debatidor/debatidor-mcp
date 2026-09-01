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

async function withClient(api: DebatidorApiClient, run: (client: Client) => Promise<void>) {
  const handler = createMcpHandler(() =>
    createDebatidorServer({ api, publicBaseUrl: 'https://mcp.debatidor.test' }),
  );
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'agent-tools-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await client.close();
    await handler.close();
  }
}

test('agent tools expose safety annotations and delegate to the authenticated backend', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const upstream: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const body = JSON.parse(String(init?.body ?? '{}')) as { tool?: string };
    if (body.tool === 'fs.list') {
      return jsonResponse({ tool: 'fs.list', agentId: null, ok: true, path: '', entries: ['src/', 'package.json'] });
    }
    if (body.tool === 'fs.read') {
      return jsonResponse({ tool: 'fs.read', agentId: 'agent-1', ok: true, path: 'src/app.ts', bytes: 17, content: 'export const x=1;' });
    }
    if (body.tool === 'fs.write') {
      return jsonResponse({ tool: 'fs.write', agentId: 'agent-1', ok: true, path: 'src/app.ts', bytes: 18 });
    }
    return jsonResponse({ tool: 'shell.run', agentId: 'agent-1', ok: true, output: 'clean\n', exitCode: 0 });
  };

  const api = new DebatidorApiClient(
    'https://api.test',
    { type: 'bearer', token: 'oauth_agent_test' },
    upstream,
  );

  await withClient(api, async (client) => {
    const tools = await client.listTools();
    const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));

    assert.equal(byName.get('debatidor_agent_list')?.annotations?.readOnlyHint, true);
    assert.equal(byName.get('debatidor_agent_read')?.annotations?.readOnlyHint, true);
    assert.equal(byName.get('debatidor_agent_write')?.annotations?.destructiveHint, true);
    assert.equal(byName.get('debatidor_agent_write')?.annotations?.idempotentHint, true);
    assert.equal(byName.get('debatidor_agent_shell')?.annotations?.destructiveHint, true);
    assert.equal(byName.get('debatidor_agent_shell')?.annotations?.idempotentHint, false);

    const list = await client.callTool({
      name: 'debatidor_agent_list',
      arguments: {},
    });
    assert.equal(list.isError, undefined);
    assert.deepEqual((list.structuredContent as { entries: string[] }).entries, ['src/', 'package.json']);

    const read = await client.callTool({
      name: 'debatidor_agent_read',
      arguments: { path: 'src/app.ts', agentId: 'agent-1' },
    });
    assert.equal(read.isError, undefined);
    assert.equal((read.structuredContent as { content: string }).content, 'export const x=1;');

    const write = await client.callTool({
      name: 'debatidor_agent_write',
      arguments: { path: 'src/app.ts', content: 'export const x = 2;', agentId: 'agent-1' },
    });
    assert.equal(write.isError, undefined);

    const shell = await client.callTool({
      name: 'debatidor_agent_shell',
      arguments: { command: 'git status', agentId: 'agent-1', timeoutMs: 120000 },
    });
    assert.equal(shell.isError, undefined);
    assert.equal((shell.structuredContent as { exitCode: number }).exitCode, 0);
  });

  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.url, 'https://api.test/agent-execution/execute');
    assert.equal(call.init?.method, 'POST');
    assert.equal(
      (call.init?.headers as Record<string, string>).authorization,
      'Bearer oauth_agent_test',
    );
  }
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), {
    agentId: 'agent-1',
    tool: 'fs.write',
    path: 'src/app.ts',
    content: 'export const x = 2;',
  });
  assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), {
    agentId: 'agent-1',
    tool: 'shell.run',
    command: 'git status',
    cwd: '',
    timeoutMs: 120000,
  });
});

test('agent failures are returned safely without leaking bearer credentials', async () => {
  const upstream: typeof fetch = async () =>
    jsonResponse({ tool: 'shell.run', agentId: null, ok: false, error: 'denied_headless_shell_disabled' });
  const api = new DebatidorApiClient(
    'https://api.test',
    { type: 'bearer', token: 'oauth_secret_agent' },
    upstream,
  );

  await withClient(api, async (client) => {
    const result = await client.callTool({
      name: 'debatidor_agent_shell',
      arguments: { command: 'git status' },
    });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.match(text, /denied_headless_shell_disabled/);
    assert.doesNotMatch(text, /oauth_secret_agent/);
  });
});
