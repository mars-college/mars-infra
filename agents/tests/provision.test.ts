import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { loadConfig } from '../src/config.js';
import { CHARACTER_COMMAND, createDiscordRest, provisionFixtures, provisionPrivateConfig, ProvisioningError } from '../src/provision.js';
import type { DiscordRest, ProvisionInput } from '../src/provision.js';

const input: ProvisionInput = {
  guild_id: '100', owner_discord_id: '101', fallback_channel_ids: ['200', '201'],
  config_path: 'runtime/config.yaml', credentials_path: 'runtime/credentials.env',
  gateway: { context_root: 'context', state_root: 'state', mcp: { url: 'http://127.0.0.1:4400/mcp', token_env: 'MARS_MCP_TOKEN' },
    characters: [{ id: 'chiba', resources: ['mars://guide'], mcp_tools: ['read_resource'] }] },
};

class FakeRest implements DiscordRest {
  installed = true;
  forbidChannels = false;
  failure?: ProvisioningError;
  roles = [{ id: '300', name: 'mars-2027', permissions: '8', mentionable: false }];
  channels = [{ id: '200', name: 'general', type: 0 }, { id: '201', name: 'dev', type: 0 }];
  webhooks: Record<string, { id: string; type: number; user: { id: string }; token?: string }[]> = {};
  commands: Record<string, unknown>[] = [];
  writes: { method: string; path: string; body: unknown }[] = [];
  requests: string[] = [];
  next = 400;
  async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
    this.requests.push(`${method} ${path}`);
    if (this.failure) throw this.failure;
    if (path === '/guilds/100' && method === 'GET') {
      if (!this.installed) throw new ProvisioningError(404, 10004);
      return { id: '100' } as T;
    }
    if (path === '/users/@me') return { id: '102' } as T;
    if (path === '/oauth2/applications/@me') return { id: '103' } as T;
    // Internal fake payloads mirror the known request contract.
    const payload = structuredClone(body) as Record<string, unknown>;
    if (path === '/guilds/100/channels' && method === 'POST' && this.forbidChannels) throw new ProvisioningError(403, 50013);
    if (method !== 'GET') this.writes.push({ method, path, body });
    let result: unknown;
    if (path === '/guilds/100/roles') {
      if (method === 'GET') result = this.roles;
      else { const role = { id: String(this.next++), name: String(payload.name), permissions: String(payload.permissions), mentionable: Boolean(payload.mentionable) }; this.roles.push(role); result = role; }
    } else if (path.startsWith('/guilds/100/roles/')) {
      const role = this.roles.find(role => role.id === path.split('/').at(-1))!;
      Object.assign(role, payload); result = role;
    } else if (path === '/guilds/100/channels') {
      if (method === 'GET') result = this.channels;
      else { const channel = { id: String(this.next++), name: String(payload.name), type: 0 }; this.channels.push(channel); result = channel; }
    } else if (/^\/channels\/\d+\/webhooks$/.test(path)) {
      const id = path.split('/')[2]!;
      const hooks = this.webhooks[id] ??= [];
      if (method === 'GET') result = hooks;
      else { const hook = { id: String(this.next++), type: 1, user: { id: '102' }, token: 'synthetic-token' }; hooks.push(hook); result = hook; }
    } else if (path.startsWith('/applications/103/guilds/100/commands')) {
      if (method === 'GET') result = this.commands;
      else if (method === 'POST') { const command = { ...payload, id: String(this.next++) }; this.commands.push(command); result = command; }
      else { const command = this.commands.find(item => item.id === path.split('/').at(-1))!; Object.assign(command, payload); result = command; }
    } else throw new Error(`Unexpected fake request: ${method} ${path}`);
    return structuredClone(result) as T;
  }
}

test('fixture provisioning repairs roles, creates fixtures, and is mutation-free on repeat', async () => {
  const rest = new FakeRest();
  const first = await provisionFixtures(input, rest);
  assert.equal(first.status, 'provisioned');
  if (first.status !== 'provisioned') return;
  assert.deepEqual(rest.roles.map(role => [role.name, role.permissions, role.mentionable]), [
    ['mars-2027', '0', true], ['Chiba', '0', true], ['andy9', '0', true],
  ]);
  assert.deepEqual(rest.channels.slice(2).map(channel => channel.name), ['mars-general', 'mars-kitchen']);
  assert.deepEqual(first.config.characters.map(character => character.name), ['Chiba', 'andy9']);
  for (const character of first.config.characters) {
    assert.equal(character.owner_discord_id, '101');
    assert.deepEqual(character.allowed_member_roles, [first.roleIds['mars-2027']]);
    const channelName = character.id === 'andy9' ? 'mars-kitchen' : 'mars-general';
    assert.deepEqual(character.channel_ids, [rest.channels.find(channel => channel.name === channelName)!.id]);
    assert.equal(character.role_id, first.roleIds[character.name]);
  }
  assert.deepEqual(rest.commands[0], { ...CHARACTER_COMMAND, id: rest.commands[0]!.id });
  const writes = rest.writes.length;
  assert.deepEqual(await provisionFixtures(input, rest), first);
  assert.equal(rest.writes.length, writes);
});

test('absent guild returns not-installed before all other requests', async () => {
  const rest = new FakeRest(); rest.installed = false;
  assert.deepEqual(await provisionFixtures(input, rest), { status: 'not-installed' });
  assert.deepEqual(rest.requests, ['GET /guilds/100']);
  assert.deepEqual(rest.writes, []);
});

test('authentication failures are not classified as missing membership', async () => {
  const rest = new FakeRest(); rest.failure = new ProvisioningError(401);
  await assert.rejects(provisionFixtures(input, rest), error => error instanceof ProvisioningError && error.status === 401);
  assert.deepEqual(rest.writes, []);
});

test('forbidden channel creation falls back to configured existing channels and reuses bot-owned hooks', async () => {
  const rest = new FakeRest(); rest.forbidChannels = true;
  rest.webhooks['200'] = [
    { id: '800', type: 1, user: { id: '999' }, token: 'other-bot-token' },
    { id: '801', type: 1, user: { id: '102' }, token: 'synthetic-existing-token' },
  ];
  const result = await provisionFixtures(input, rest);
  assert.equal(result.status, 'provisioned');
  if (result.status !== 'provisioned') return;
  assert.deepEqual(result.config.channels.map(channel => channel.id), ['200', '201']);
  assert.deepEqual(result.config.characters.map(character => character.channel_ids), [['200'], ['201']]);
  assert.equal(result.credentials.MARS_WEBHOOK_200, 'https://discord.com/api/webhooks/801/synthetic-existing-token');
  assert.equal(rest.webhooks['200'].length, 2);
  await assert.rejects(provisionFixtures({ ...input, fallback_channel_ids: ['999'] }, rest), ProvisioningError);
  const single = await provisionFixtures({ ...input, fallback_channel_ids: ['200'] }, rest);
  assert.equal(single.status, 'provisioned');
  if (single.status === 'provisioned') {
    assert.deepEqual(single.config.characters.map(character => character.channel_ids), [['200'], ['200']]);
    assert.deepEqual(single.config.channels.map(channel => channel.id), ['200']);
  }
});

test('slash command update preserves unrelated guild commands and normalizes Discord defaults', async () => {
  const rest = new FakeRest();
  rest.commands = [{ id: '700', name: 'unrelated', type: 1, description: 'Keep me' }, { id: '701', name: 'character', type: 1, description: 'Old command' }];
  await provisionFixtures(input, rest);
  assert.equal(rest.commands.length, 2);
  assert.equal(rest.commands[0]!.name, 'unrelated');
  assert.ok(rest.writes.some(write => write.method === 'PATCH' && write.path.endsWith('/commands/701')));
  const options = rest.commands[1]!.options as Record<string, unknown>[];
  for (const option of options) { option.required = false; }
  const before = rest.writes.length;
  await provisionFixtures(input, rest);
  assert.equal(rest.writes.length, before);
});

test('private outputs are loadable, restrictive, preserve credentials, and absent guild changes nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mars-provision-'));
  try {
    const path = join(root, 'provision.yaml');
    await writeFile(path, stringify(input));
    const rest = new FakeRest(); rest.installed = false;
    const original = await readFile(path, 'utf8');
    await provisionPrivateConfig(path, rest);
    assert.equal(await readFile(path, 'utf8'), original);
    assert.deepEqual(await readdir(root), ['provision.yaml']);
    rest.installed = true;
    await provisionPrivateConfig(path, rest);
    const config = await loadConfig(join(root, 'runtime/config.yaml'));
    assert.equal(config.characters[0]!.owner_discord_id, '101');
    assert.equal(config.context_root, join(root, 'context'));
    assert.ok(parse(await readFile(path, 'utf8')).role_ids['mars-2027']);
    await writeFile(join(root, 'runtime/credentials.env'), `MARS_MCP_TOKEN=synthetic-private-token\n${await readFile(join(root, 'runtime/credentials.env'), 'utf8')}`);
    await provisionPrivateConfig(path, rest);
    const credentials = await readFile(join(root, 'runtime/credentials.env'), 'utf8');
    assert.ok(credentials.includes('MARS_MCP_TOKEN=synthetic-private-token'));
    assert.equal((credentials.match(/MARS_WEBHOOK_\d+=/g) ?? []).length, 2);
    for (const file of ['provision.yaml', 'runtime/config.yaml', 'runtime/credentials.env']) assert.equal((await stat(join(root, file))).mode & 0o777, 0o600);
    for (const directory of ['runtime', 'context', 'state']) assert.equal((await stat(join(root, directory))).mode & 0o777, 0o700);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('REST errors redact response bodies and fetch errors', async () => {
  const token = 'synthetic-private-bot-token';
  const failingFetch: typeof fetch = async () => new Response(JSON.stringify({ code: 50013, message: token }), { status: 403 });
  await assert.rejects(createDiscordRest(token, failingFetch).request('GET', '/guilds/100'), error => {
    assert.ok(error instanceof ProvisioningError);
    assert.equal(error.status, 403);
    assert.equal(error.code, 50013);
    assert.ok(!JSON.stringify(error).includes(token));
    assert.ok(!error.message.includes(token));
    return true;
  });
});
