export type McpRuntimeConfig = {
  apiBaseUrl: string;
  apiKey?: string;
  host: string;
  port: number;
  publicBaseUrl: string;
  allowedHosts: string[];
  legacyApiKeyBridgeEnabled: boolean;
  oauthEnabled: boolean;
  authorizationServer: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpRuntimeConfig {
  const host = String(env.DEBATIDOR_MCP_HOST ?? '0.0.0.0').trim();
  const port = Number(env.DEBATIDOR_MCP_PORT ?? 3002);
  const publicBaseUrl = String(
    env.DEBATIDOR_MCP_PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`,
  ).replace(/\/$/, '');
  const apiBaseUrl = String(env.DEBATIDOR_API_BASE_URL ?? 'https://api.debatidor.com').replace(/\/$/, '');
  const apiKey = String(env.DEBATIDOR_API_KEY ?? '').trim() || undefined;
  const legacyApiKeyBridgeEnabled = parseBoolean(env.DEBATIDOR_MCP_ENABLE_LEGACY_API_KEY_BRIDGE);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DEBATIDOR_MCP_PORT must be a valid TCP port');
  }

  let publicUrl: URL;
  try {
    publicUrl = new URL(publicBaseUrl);
  } catch {
    throw new Error('DEBATIDOR_MCP_PUBLIC_BASE_URL must be an absolute http(s) URL');
  }
  if (publicUrl.protocol !== 'http:' && publicUrl.protocol !== 'https:') {
    throw new Error('DEBATIDOR_MCP_PUBLIC_BASE_URL must use http or https');
  }

  const oauthEnabled = parseBooleanWithDefault(
    env.DEBATIDOR_MCP_OAUTH_ENABLED,
    publicUrl.protocol === 'https:',
  );
  const authorizationServer = String(
    env.DEBATIDOR_MCP_AUTHORIZATION_SERVER ?? apiBaseUrl,
  ).replace(/\/$/, '');

  if (legacyApiKeyBridgeEnabled && !apiKey) {
    throw new Error(
      'DEBATIDOR_API_KEY is required when DEBATIDOR_MCP_ENABLE_LEGACY_API_KEY_BRIDGE=true',
    );
  }
  if (legacyApiKeyBridgeEnabled && oauthEnabled) {
    throw new Error('OAuth and the legacy API-key bridge cannot be enabled together');
  }

  const configuredHosts = String(env.DEBATIDOR_MCP_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const allowedHosts = Array.from(
    new Set([
      publicUrl.hostname.toLowerCase(),
      ...configuredHosts,
      ...(isLoopbackUrl(publicUrl) ? ['127.0.0.1', 'localhost', '::1'] : []),
    ]),
  );

  return {
    apiBaseUrl,
    apiKey,
    host,
    port,
    publicBaseUrl,
    allowedHosts,
    legacyApiKeyBridgeEnabled,
    oauthEnabled,
    authorizationServer,
  };
}

export function isAllowedHost(hostHeader: string | undefined, allowedHosts: string[]): boolean {
  if (!hostHeader) return false;
  const normalized = normalizeHost(hostHeader);
  return allowedHosts.includes(normalized);
}

function normalizeHost(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end >= 0 ? trimmed.slice(1, end) : trimmed;
  }
  return trimmed.split(':')[0] ?? trimmed;
}

function isLoopbackUrl(url: URL): boolean {
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '::1';
}

function parseBoolean(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function parseBooleanWithDefault(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return parseBoolean(value);
}
