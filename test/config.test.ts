import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedHost, loadConfig } from '../src/config.js';

test('production HTTP config can bind publicly without a Debatidor API key', () => {
  const config = loadConfig({
    DEBATIDOR_MCP_HOST: '0.0.0.0',
    DEBATIDOR_MCP_PORT: '3002',
    DEBATIDOR_MCP_PUBLIC_BASE_URL: 'https://mcp.debatidor.com',
    DEBATIDOR_MCP_ALLOWED_HOSTS: 'mcp.debatidor.com,localhost',
  });

  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 3002);
  assert.equal(config.legacyApiKeyBridgeEnabled, false);
  assert.equal(config.apiKey, undefined);
  assert.equal(isAllowedHost('mcp.debatidor.com', config.allowedHosts), true);
  assert.equal(isAllowedHost('evil.example', config.allowedHosts), false);
});

test('legacy API-key bridge requires a key explicitly', () => {
  assert.throws(
    () =>
      loadConfig({
        DEBATIDOR_MCP_ENABLE_LEGACY_API_KEY_BRIDGE: 'true',
      }),
    /DEBATIDOR_API_KEY is required/,
  );
});
