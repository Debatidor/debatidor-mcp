import { createServer as createHttpServer } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { loadConfig } from './config.js';
import { DebatidorApiClient } from './debatidor-api.js';
import { createDebatidorServer } from './server.js';

const config = loadConfig();
const api = new DebatidorApiClient(config.apiBaseUrl, config.apiKey);
const handler = createMcpHandler(() => createDebatidorServer(api));
const mcpHandler = toNodeHandler(handler);
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const server = createHttpServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/healthz') {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, service: '@debatidor/mcp', version: '0.1.0' }));
    return;
  }

  if (url.pathname !== '/mcp') {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }

  if (!validateHost(req, res) || !validateOrigin(req, res)) return;
  void mcpHandler(req, res);
});

server.listen(config.port, config.host, () => {
  console.error(`Debatidor MCP listening on http://${config.host}:${config.port}/mcp`);
  console.error('Remote/public bind is intentionally disabled until OAuth is added.');
});

async function shutdown() {
  server.close();
  await handler.close();
}

process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
