import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from '../src/config.js';
import { CharacterEngine } from '../src/engine.js';
import { startDiscord, type WebhookPayload } from '../src/discord.js';

const realClaude = process.env.SMOKE_REAL_CLAUDE === '1';
const turnLatencies: Array<{ character: string; latencyMs: number }> = [];
const directory = await mkdtemp(join(tmpdir(), 'mars-gateway-smoke-'));
const delivered: Array<{ channelId: string; payload: WebhookPayload }> = [];
const errors: string[] = [];
const server = createServer((request, response) => {
  void (async () => {
    if (request.url === '/mcp') {
      const mcp = new McpServer({ name: 'synthetic-mcp-fixture', version: '1' });
      mcp.registerResource('synthetic-note', 'mars://demo/role-gated', { mimeType: 'text/plain' }, async uri => ({
        contents: [{ uri: uri.href, text: 'Copper Finch telescope is stored in the fictional demo shed.' }],
      }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.on('close', () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    } else if (request.url === '/webhook' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      delivered.push(JSON.parse(body));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: String(500 + delivered.length) }));
    } else {
      response.writeHead(404).end();
    }
  })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Expected fixture TCP address');
const origin = `http://127.0.0.1:${address.port}`;
const config = await loadConfig(new URL('../config/example.yaml', import.meta.url).pathname);
if (!realClaude) config.claude_command = new URL('../tests/fixtures/claude.mjs', import.meta.url).pathname;
config.state_root = directory;
config.mcp = { url: `${origin}/mcp` };
if (!realClaude) config.characters[0]!.context_files = [];
config.characters[0]!.resources = ['mars://demo/role-gated'];
config.characters[1]!.allowed_member_roles = ['777'];
const engine = new CharacterEngine(config);
let memberRoles: string[] = [];
const gateway = await startDiscord(config, engine, {
  env: { DISCORD_BOT_TOKEN: 'synthetic-no-network',
    DISCORD_CHANNEL_WEBHOOK: 'https://discord.com/api/webhooks/999/synthetic-no-network' },
  onError: error => errors.push(error.code),
  transportFactory: () => ({
    onMessage: () => () => {},
    onError: () => () => {},
    login: async () => {}, // Fixture only: no Discord gateway login occurs.
    fetchRoleIds: async () => memberRoles,
    send: async (channelId, payload) => {
      const response = await fetch(`${origin}/webhook`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channelId, payload }) });
      return response.json() as Promise<{ id: string }>;
    },
    close: async () => {},
  }),
});
try {
  const base = { id: '1', guildId: '100', channelId: '200', authorId: '400', bot: false };
  let started = performance.now();
  await gateway.handle({ ...base, content: realClaude
    ? '<@&301> Introduce yourself by name, then briefly say when weekly dinner is and where Copper Finch is. Cite both sources. Keep it to two short sentences.'
    : '<@&301> Where is Copper Finch?' });
  turnLatencies.push({ character: 'Chiba', latencyMs: Math.round(performance.now() - started) });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]!.payload.username, 'Chiba');
  assert.match(delivered[0]!.payload.content, /fictional demo shed/);
  assert.match(delivered[0]!.payload.content, /mars:\/\/demo\/role-gated/);
  if (realClaude) {
    assert.match(delivered[0]!.payload.content, /Chiba/);
    assert.match(delivered[0]!.payload.content, /Tuesday.*6\s*(?:PM|p\.?m\.?)/i);
    assert.match(delivered[0]!.payload.content, /guide\.md/);
  }
  await gateway.handle({ ...base, id: '2', content: '<@&302> Where do plates go?' });
  assert.equal(delivered.length, 1);
  memberRoles = ['777'];
  started = performance.now();
  await gateway.handle({ ...base, id: '3', content: realClaude
    ? '<@&302> Introduce yourself by name and tell me where clean plates go. Cite your source. Keep it to two short sentences.'
    : '<@&302> Where do plates go?' });
  turnLatencies.push({ character: 'andy9', latencyMs: Math.round(performance.now() - started) });
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1]!.payload.username, 'andy9');
  assert.match(delivered[1]!.payload.content, /blue shelf/);
  assert.doesNotMatch(delivered[1]!.payload.content, /Copper Finch/);
  if (realClaude) {
    assert.match(delivered[1]!.payload.content, /andy9/i);
    assert.match(delivered[1]!.payload.content, /kitchen\.md/);
  }
  started = performance.now();
  await gateway.handle({ ...base, id: '4', content: 'Thanks, where was that? Answer briefly.', replyMessageId: '501' });
  turnLatencies.push({ character: 'Chiba (reply routing)', latencyMs: Math.round(performance.now() - started) });
  assert.equal(delivered.length, 3);
  assert.equal(delivered[2]!.payload.username, 'Chiba');
  await gateway.handle({ ...base, id: '5', content: '<@&301> loop', bot: true, webhookId: '999' });
  assert.equal(delivered.length, 3);
  assert.deepEqual(errors, []);
  assert.ok(delivered.every(delivery => delivery.payload.allowedMentions.parse.length === 0));
  console.log(JSON.stringify({
    mode: realClaude
      ? 'REAL CLAUDE: synthetic Discord ingress; real claude -p, local MCP HTTP and webhook sink'
      : 'LOCAL FIXTURES: synthetic Discord ingress/CLI; real MCP HTTP and webhook sink',
    proofs: ['role mention → character', 'character-scoped MCP context', 'member role gate',
      'separate kitchen context', 'webhook persona delivery', 'reply routing', 'no bot/webhook feedback loop'],
    deliveries: delivered.map(({ payload }) => ({ character: payload.username, response: payload.content })),
    turnLatencies,
    actualDiscordLogin: false,
    actualClaudeInference: realClaude,
  }, null, 2));
} finally {
  engine.close();
  await gateway.close();
  server.closeAllConnections();
  const closed = once(server, 'close');
  server.close();
  await closed;
  await rm(directory, { recursive: true, force: true });
}
