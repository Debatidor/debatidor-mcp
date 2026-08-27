export type McpRuntimeConfig = {
  apiBaseUrl: string;
  apiKey: string;
  host: string;
  port: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpRuntimeConfig {
  const apiBaseUrl = String(env.DEBATIDOR_API_BASE_URL ?? 'https://api.debatidor.com').replace(/\/$/, '');
  const apiKey = String(env.DEBATIDOR_API_KEY ?? '').trim();
  const host = String(env.DEBATIDOR_MCP_HOST ?? '127.0.0.1').trim();
  const port = Number(env.DEBATIDOR_MCP_PORT ?? 3000);

  if (!apiKey) {
    throw new Error('DEBATIDOR_API_KEY is required for the current dogfood auth bridge');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DEBATIDOR_MCP_PORT must be a valid TCP port');
  }
  if (!isLoopbackHost(host)) {
    throw new Error(
      'Remote/public binding is disabled until MCP OAuth is implemented. Bind to 127.0.0.1 and use a trusted development tunnel instead.',
    );
  }

  return { apiBaseUrl, apiKey, host, port };
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
