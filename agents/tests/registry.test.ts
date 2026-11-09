import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { loadConfig } from '../src/config.js';
import { CharacterRegistry, CharacterError } from '../src/registry.js';
import { startApi } from '../src/api.js';
import { startDiscord, type DiscordTransport, type WebhookPayload } from '../src/discord.js';
import { CharacterEngine } from '../src/engine.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mars-registry-'));
  const config = await loadConfig(new URL('../config/example.yaml', import.meta.url).pathname);
  config.characters[0]!.owner_discord_id = '600';
  config.characters[1]!.owner_discord_id = '600';
  config.channels.push({ id: '201', webhook_env: 'OTHER_WEBHOOK' });
  config.characters[1]!.channel_ids = ['201'];
  const sent: { character: string; channelId: string; content: string }[] = [];
  const roles: string[] = [];
  const discord = {
    async createRole(name: string) { roles.push(name); return String(700 + roles.length); },
    async editRole(_id: string, name: string) { roles.push(`edit:${name}`); },
    async deleteRole(id: string) { roles.push(`delete:${id}`); },
    async send(character: { name: string }, channelId: string, content: string) { sent.push({ character: character.name, channelId, content }); return { id: String(800 + sent.length) }; },
  };
  const path = join(directory, 'characters.sqlite');
  const registry = new CharacterRegistry(path, config, discord);
  return { directory, config, sent, roles, path, discord, registry, async close() { registry.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('SQLite registry persists owners, rejects non-owner edit/delete/speak, and preserves hosted edits/deletion', async () => {
  const f = await fixture();
  try {
    const character = await f.registry.create({ actorDiscordId: '601', name: 'Orbit', description: 'Synthetic external character' });
    assert.equal(character.ownerDiscordId, '601'); assert.equal(character.mode, 'external');
    for (const operation of [f.registry.edit(character.id, { actorDiscordId: '602', name: 'Stolen' }), f.registry.delete(character.id, { actorDiscordId: '602' }), f.registry.say(character.id, { actorDiscordId: '602', channelId: '200', content: 'spoof' })]) {
      await assert.rejects(operation, error => error instanceof CharacterError && error.status === 403 && error.code === 'not_owner');
    }
    await f.registry.edit('chiba', { actorDiscordId: '600', description: 'Owner changed prompt' });
    await f.registry.delete(f.config.characters[1]!.id, { actorDiscordId: '600' });
    const reopened = new CharacterRegistry(f.path, f.config, f.discord);
    assert.equal(reopened.get(character.id).ownerDiscordId, '601');
    assert.equal(reopened.get('chiba').description, 'Owner changed prompt');
    assert.throws(() => reopened.get(f.config.characters[1]!.id), /not_found/);
    reopened.close();
    await f.registry.say(character.id, { actorDiscordId: '601', channelId: '200', content: 'hello' });
    await assert.rejects(f.registry.say(character.id, { actorDiscordId: '601', channelId: '999', content: 'hello' }), /channel_not_allowed/);
  } finally { await f.close(); }
});

test('loopback HTTP API implements bearer, ownership, CRUD, messages and owner mention inbox contract', async () => {
  const f = await fixture(); const token = 'synthetic-private-bearer-32-characters';
  const server = await startApi(f.registry, token, 0);
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, method = 'GET', body?: object) => fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await fetch(`${base}/v1/characters`)).status, 401);
    assert.equal((await (await request('/v1/characters')).json()).characters.length, 2);
    const created = await request('/v1/characters', 'POST', { actorDiscordId: '601', name: 'Orbit', description: 'Synthetic fixture' });
    assert.equal(created.status, 201); const character = await created.json();
    const denied = await request(`/v1/characters/${character.id}`, 'PATCH', { actorDiscordId: '602', name: 'spoof' });
    assert.equal(denied.status, 403); assert.deepEqual(await denied.json(), { error: 'not_owner' });
    assert.equal((await request(`/v1/characters/${character.id}/messages`, 'POST', { actorDiscordId: '602', channelId: '200', content: 'spoof' })).status, 403);
    const said = await (await request(`/v1/characters/${character.id}/messages`, 'POST', { actorDiscordId: '601', channelId: '200', content: 'in character' })).json();
    assert.equal(said.messageId, '801'); assert.equal(f.sent[0]!.character, 'Orbit');
    f.registry.receive({ id: '900', guildId: '100', channelId: '200', authorId: '603', authorName: 'Synthetic User', content: `<@&${character.roleId}> hello`, roleIds: [], bot: false });
    f.registry.receive({ id: '901', guildId: '100', channelId: '200', authorId: '603', content: 'reply', roleIds: [], bot: false, replyCharacterId: f.registry.replyCharacter('801', '200') });
    const inbox = await (await request(`/v1/characters/${character.id}/mentions?actorDiscordId=601&after=900`)).json();
    assert.deepEqual(inbox.mentions.map((value: { messageId: string }) => value.messageId), ['901']);
    assert.equal((await request(`/v1/characters/${character.id}/mentions?actorDiscordId=602`)).status, 403);
    assert.equal((await request(`/v1/characters/${character.id}`, 'DELETE', { actorDiscordId: '601' })).status, 200);
    assert.equal((await request(`/v1/characters/${character.id}`, 'PATCH', { actorDiscordId: '601', name: 'gone' })).status, 404);
  } finally { server.close(); await once(server, 'close'); await f.close(); }
});

test('fake gateway proves mention-first hosted response, kitchen channel denial, slash ownership, external mention and reply queue', async () => {
  const f = await fixture(); const delivered: WebhookPayload[] = [];
  const engine = new CharacterEngine(f.config, { async run(input) { return `In character ${input.characterId}`; } });
  let slash: Parameters<NonNullable<DiscordTransport['onCharacterCommand']>>[0] | undefined;
  const gateway = await startDiscord(f.config, engine, {
    registry: f.registry,
    env: { DISCORD_BOT_TOKEN: 'synthetic-bot', DISCORD_CHANNEL_WEBHOOK: 'https://discord.com/api/webhooks/1/synthetic', OTHER_WEBHOOK: 'https://discord.com/api/webhooks/2/synthetic' },
    transportFactory: () => ({ onMessage: () => () => {}, onError: () => () => {}, onCharacterCommand(handler) { slash = handler; return () => {}; }, login: async () => {}, fetchRoleIds: async () => [], close: async () => {},
      async send(_channel, payload) { delivered.push(payload); return { id: String(1000 + delivered.length) }; } }),
  });
  const base = { id: '1', guildId: '100', channelId: '200', authorId: '601', bot: false };
  try {
    await gateway.handle({ ...base, content: '<@&301> hi' }); assert.equal(delivered[0]!.username, 'Chiba');
    await gateway.handle({ ...base, id: '2', content: '<@&302> kitchen outside kitchen' }); assert.equal(delivered.length, 1);
    await gateway.handle({ ...base, id: '3', channelId: '201', content: '<@&302> kitchen inside kitchen' }); assert.equal(delivered.length, 2);
    assert.ok(slash);
    const external = await slash({ guildId: '100', actorDiscordId: '601', subcommand: 'create', name: 'Orbit', description: 'Synthetic external' }) as { id: string; roleId: string; ownerDiscordId: string };
    assert.equal(external.ownerDiscordId, '601');
    await assert.rejects(slash({ guildId: '100', actorDiscordId: '602', subcommand: 'edit', id: external.id, name: 'stolen' }), /not_owner/);
    await slash({ guildId: '100', actorDiscordId: '601', subcommand: 'edit', id: external.id, name: 'Orbit Updated' });
    assert.equal((await slash({ guildId: '100', actorDiscordId: '601', subcommand: 'list' }) as { characters: unknown[] }).characters.length, 3);
    await gateway.handle({ ...base, id: '10', content: `<@&${external.roleId}> question` });
    await f.registry.say(external.id, { actorDiscordId: '601', channelId: '200', content: 'Owner speaks' });
    await gateway.handle({ ...base, id: '11', content: 'follow up', replyMessageId: '801' });
    assert.equal(f.registry.mentions(external.id, { actorDiscordId: '601' }).mentions.length, 2);
    assert.deepEqual(delivered[0]!.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
    await slash({ guildId: '100', actorDiscordId: '601', subcommand: 'delete', id: external.id });
    console.log('FAKE DISCORD PROOF: Chiba replies; kitchen channel denied/allowed; slash owner recorded; owner API speak; external mention/reply inbox; no outgoing pings');
  } finally { engine.close(); await gateway.close(); await f.close(); }
});
