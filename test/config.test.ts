import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedHost, loadConfig } from '../src/config.js';

test('production HTTPS config enables OAuth without a Debatidor API key', () => {
  const config = loadConfig({
    DEBATIDOR_MCP_HOST: '0.0.0.0',
    DEBATIDOR_MCP_PORT: '3002',
    DEBATIDOR_MCP_PUBLIC_BASE_URL: 'https://mcp.debatidor.com',
    DEBATIDOR_MCP_ALLOWED_HOSTS: 'mcp.debatidor.com,localhost',
    DEBATIDOR_API_BASE_URL: 'https://api.debatidor.com',
  });

  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 3002);
  assert.equal(config.oauthEnabled, true);
  assert.equal(config.authorizationServer, 'https://api.debatidor.com');
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

test('OAuth and legacy bridge cannot be enabled together', () => {
  assert.throws(
    () =>
      loadConfig({
        DEBATIDOR_MCP_PUBLIC_BASE_URL: 'https://mcp.debatidor.com',
        DEBATIDOR_MCP_ENABLE_LEGACY_API_KEY_BRIDGE: 'true',
        DEBATIDOR_API_KEY: 'deb_live_test',
      }),
    /cannot be enabled together/,
  );
});
