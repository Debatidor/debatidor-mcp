#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { DebatidorApiClient } from './debatidor-api.js';
import { createDebatidorServerWithAssets } from './agent-asset-tools.js';

const config = loadConfig();
const api =
  config.legacyApiKeyBridgeEnabled && config.apiKey
    ? new DebatidorApiClient(config.apiBaseUrl, {
        type: 'api-key',
        token: config.apiKey,
      })
    : undefined;

void serveStdio(() =>
  createDebatidorServerWithAssets({ api, publicBaseUrl: config.publicBaseUrl }),
);
