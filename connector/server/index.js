#!/usr/bin/env node
// StudyBridge for Claude (MCP over stdio). Settings come from Claude Desktop's extension config.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createStudyBridgeServer } from './tools.js';

const server = createStudyBridgeServer({
  url: process.env.STUDYBRIDGE_URL,
  key: process.env.STUDYBRIDGE_ANON_KEY,
  email: process.env.STUDYBRIDGE_EMAIL,
  password: process.env.STUDYBRIDGE_PASSWORD,
});
await server.connect(new StdioServerTransport());
