#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { DebatidorApiClient } from './debatidor-api.js';
import { createDebatidorServer } from './server.js';

const config = loadConfig();
const api =
  config.legacyApiKeyBridgeEnabled && config.apiKey
    ? new DebatidorApiClient(config.apiBaseUrl, config.apiKey)
    : undefined;

void serveStdio(() => createDebatidorServer({ api, publicBaseUrl: config.publicBaseUrl }));
