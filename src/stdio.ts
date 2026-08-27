#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { DebatidorApiClient } from './debatidor-api.js';
import { createDebatidorServer } from './server.js';

const config = loadConfig();
const api = new DebatidorApiClient(config.apiBaseUrl, config.apiKey);

void serveStdio(() => createDebatidorServer(api));
