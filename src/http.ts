import { createServer as createHttpServer } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { isAllowedHost, loadConfig } from './config.js';
import { DebatidorApiClient } from './debatidor-api.js';
import { createDebatidorServer, SERVER_VERSION } from './server.js';

const config = loadConfig();
const api =
  config.legacyApiKeyBridgeEnabled && config.apiKey
    ? new DebatidorApiClient(config.apiBaseUrl, config.apiKey)
    : undefined;
const handler = createMcpHandler(() =>
  createDebatidorServer({ api, publicBaseUrl: config.publicBaseUrl }),
);
const mcpHandler = toNodeHandler(handler);

const server = createHttpServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health' || url.pathname === '/healthz') {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        ok: true,
        service: '@debatidor/mcp',
        version: SERVER_VERSION,
        publicBaseUrl: config.publicBaseUrl,
        authenticatedToolsEnabled: Boolean(api),
      }),
    );
    return;
  }

  if (url.pathname === '/') {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        service: '@debatidor/mcp',
        version: SERVER_VERSION,
        mcp: `${config.publicBaseUrl}/mcp`,
        health: `${config.publicBaseUrl}/health`,
      }),
    );
    return;
  }

  if (url.pathname !== '/mcp') {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }

  if (!isAllowedHost(req.headers.host, config.allowedHosts)) {
    res.statusCode = 421;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'misdirected_request' }));
    return;
  }

  void mcpHandler(req, res);
});

server.listen(config.port, config.host, () => {
  console.error(`Debatidor MCP ${SERVER_VERSION} listening on ${config.host}:${config.port}`);
  console.error(`Public MCP endpoint: ${config.publicBaseUrl}/mcp`);
  if (api) {
    console.error('WARNING: legacy API-key bridge enabled; do not expose this mode publicly.');
  }
});

async function shutdown() {
  server.close();
  await handler.close();
}

process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
