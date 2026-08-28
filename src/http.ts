import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { isAllowedHost, loadConfig } from './config.js';
import { DebatidorApiClient } from './debatidor-api.js';
import { createDebatidorServer, SERVER_VERSION } from './server.js';

const config = loadConfig();
const legacyApi =
  config.legacyApiKeyBridgeEnabled && config.apiKey
    ? new DebatidorApiClient(config.apiBaseUrl, {
        type: 'api-key',
        token: config.apiKey,
      })
    : undefined;

const server = createHttpServer((req, res) => {
  void handleRequest(req, res).catch((error) => {
    console.error('MCP HTTP request failed', safeError(error));
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
    }
    if (!res.writableEnded) res.end(JSON.stringify({ error: 'internal_server_error' }));
  });
});

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health' || url.pathname === '/healthz') {
    return json(res, 200, {
      ok: true,
      service: '@debatidor/mcp',
      version: SERVER_VERSION,
      publicBaseUrl: config.publicBaseUrl,
      oauthEnabled: config.oauthEnabled,
      authenticatedToolsEnabled: config.oauthEnabled || Boolean(legacyApi),
    });
  }

  if (url.pathname === '/.well-known/oauth-protected-resource') {
    return json(res, 200, {
      resource: config.publicBaseUrl,
      authorization_servers: [config.authorizationServer],
      scopes_supported: ['debatidor:read'],
      resource_documentation: 'https://github.com/Debatidor/debatidor-mcp',
    });
  }

  if (url.pathname === '/') {
    return json(res, 200, {
      service: '@debatidor/mcp',
      version: SERVER_VERSION,
      mcp: `${config.publicBaseUrl}/mcp`,
      health: `${config.publicBaseUrl}/health`,
      oauthProtectedResource: `${config.publicBaseUrl}/.well-known/oauth-protected-resource`,
    });
  }

  if (url.pathname !== '/mcp') {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }

  if (!isAllowedHost(req.headers.host, config.allowedHosts)) {
    return json(res, 421, { error: 'misdirected_request' });
  }

  let api = legacyApi;
  if (config.oauthEnabled) {
    const token = bearerToken(req.headers.authorization);
    if (!token) return oauthChallenge(res, 'invalid_token');
    api = new DebatidorApiClient(config.apiBaseUrl, { type: 'bearer', token });
    try {
      await api.validateAccessToken();
    } catch {
      return oauthChallenge(res, 'invalid_token');
    }
  }

  const handler = createMcpHandler(() =>
    createDebatidorServer({ api, publicBaseUrl: config.publicBaseUrl }),
  );
  const nodeHandler = toNodeHandler(handler);
  try {
    await nodeHandler(req, res);
  } finally {
    await handler.close();
  }
}

function oauthChallenge(res: ServerResponse, error: string) {
  const metadata = `${config.publicBaseUrl}/.well-known/oauth-protected-resource`;
  res.statusCode = 401;
  res.setHeader(
    'www-authenticate',
    `Bearer resource_metadata="${metadata}", scope="debatidor:read", error="${error}"`,
  );
  return json(res, 401, { error });
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice(7).trim() || undefined;
}

function json(res: ServerResponse, status: number, body: unknown) {
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
  }
  if (!res.writableEnded) res.end(JSON.stringify(body));
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : 'unknown_error';
}

server.listen(config.port, config.host, () => {
  console.error(`Debatidor MCP ${SERVER_VERSION} listening on ${config.host}:${config.port}`);
  console.error(`Public MCP endpoint: ${config.publicBaseUrl}/mcp`);
  console.error(`OAuth resource server: ${config.oauthEnabled ? 'enabled' : 'disabled'}`);
  if (legacyApi) {
    console.error('WARNING: legacy API-key bridge enabled; do not expose this mode publicly.');
  }
});

function shutdown() {
  server.close();
}

process.once('SIGINT', () => shutdown());
process.once('SIGTERM', () => shutdown());
