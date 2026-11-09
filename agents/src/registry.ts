import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { GatewayConfig } from './config.js';
import type { IncomingMessage } from './engine.js';

export interface RegisteredCharacter {
  id: string; name: string; description: string; ownerDiscordId: string; roleId: string;
  mode: 'hosted' | 'external'; avatarUrl: string | null; channelIds: string[];
}
export interface Mention { messageId: string; channelId: string; authorId: string; authorName: string; content: string; createdAt: string }
export class CharacterError extends Error {
  constructor(readonly code: 'not_owner' | 'not_found' | 'channel_not_allowed' | 'invalid', readonly status = 400) { super(code); }
}
export interface CharacterDiscord {
  createRole(name: string): Promise<string>;
  editRole(id: string, name: string): Promise<void>;
  deleteRole(id: string): Promise<void>;
  send(character: RegisteredCharacter, channelId: string, content: string, replyToMessageId?: string): Promise<{ id: string; messageIds?: string[] }>;
}
const snowflake = z.string().regex(/^\d{1,22}$/);
const actor = z.object({ actorDiscordId: snowflake });
const fields = z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(8000),
  avatarUrl: z.string().url().refine(value => new URL(value).protocol === 'https:').optional() });
export class CharacterRegistry {
  readonly #db: DatabaseSync;
  constructor(path: string, private readonly config: GatewayConfig, private readonly discord: CharacterDiscord) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS characters (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mentions (seq INTEGER PRIMARY KEY AUTOINCREMENT, character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE, message_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(character_id,message_id));
      CREATE TABLE IF NOT EXISTS deleted_hosted (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS replies (message_id TEXT PRIMARY KEY, character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE, channel_id TEXT NOT NULL);`);
    for (const character of config.characters) {
      if (!character.owner_discord_id) continue;
      if (this.#db.prepare('SELECT id FROM deleted_hosted WHERE id=?').get(character.id)) continue;
      const existing = this.#db.prepare('SELECT data FROM characters WHERE id=?').get(character.id);
      if (existing) {
        this.#save({ ...JSON.parse(existing.data as string), roleId: character.role_id,
          channelIds: character.channel_ids ?? config.channels.map(channel => channel.id) });
        continue;
      }
      this.#save({ id: character.id, name: character.name, description: character.prompt,
        ownerDiscordId: character.owner_discord_id, roleId: character.role_id, mode: 'hosted',
        avatarUrl: character.avatar_url ?? null, channelIds: character.channel_ids ?? config.channels.map(channel => channel.id) });
    }
  }
  close() { this.#db.close(); }
  #parse<T>(schema: z.ZodType<T>, input: unknown): T {
    const result = schema.safeParse(input); if (!result.success) throw new CharacterError('invalid'); return result.data;
  }
  #save(value: RegisteredCharacter) {
    this.#db.prepare('INSERT INTO characters(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id, JSON.stringify(value));
    return value;
  }
  list(): RegisteredCharacter[] {
    return this.#db.prepare('SELECT data FROM characters ORDER BY id').all().map(row => JSON.parse(row.data as string));
  }
  get(id: string): RegisteredCharacter {
    const row = this.#db.prepare('SELECT data FROM characters WHERE id=?').get(id);
    if (!row) throw new CharacterError('not_found', 404);
    return JSON.parse(row.data as string);
  }
  #owned(id: string, actorDiscordId: string) {
    const character = this.get(id);
    if (character.ownerDiscordId !== actorDiscordId) throw new CharacterError('not_owner', 403);
    return character;
  }
  async create(input: unknown) {
    const value = this.#parse(actor.merge(fields).strict(), input);
    const roleId = await this.discord.createRole(value.name);
    return this.#save({ id: `character-${randomUUID()}`, name: value.name, description: value.description,
      ownerDiscordId: value.actorDiscordId, roleId, mode: 'external', avatarUrl: value.avatarUrl ?? null,
      channelIds: this.config.channels.map(channel => channel.id) });
  }
  async edit(id: string, input: unknown) {
    const value = this.#parse(actor.merge(fields.partial()).strict(), input);
    const character = this.#owned(id, value.actorDiscordId);
    if (value.name !== undefined) await this.discord.editRole(character.roleId, value.name);
    return this.#save({ ...character, ...(value.name !== undefined ? { name: value.name } : {}),
      ...(value.description !== undefined ? { description: value.description } : {}),
      ...(value.avatarUrl !== undefined ? { avatarUrl: value.avatarUrl } : {}) });
  }
  async delete(id: string, input: unknown) {
    const value = this.#parse(actor.strict(), input);
    const character = this.#owned(id, value.actorDiscordId);
    await this.discord.deleteRole(character.roleId);
    if (character.mode === 'hosted') this.#db.prepare('INSERT OR IGNORE INTO deleted_hosted VALUES(?)').run(id);
    this.#db.prepare('DELETE FROM characters WHERE id=?').run(id);
    return { deleted: true };
  }
  async say(id: string, input: unknown) {
    const value = this.#parse(actor.extend({ channelId: snowflake, content: z.string().trim().min(1).max(4000), replyToMessageId: snowflake.optional() }).strict(), input);
    const character = this.#owned(id, value.actorDiscordId);
    if (!character.channelIds.includes(value.channelId) || !this.config.channels.some(channel => channel.id === value.channelId)) throw new CharacterError('channel_not_allowed', 403);
    const sent = await this.discord.send(character, value.channelId, value.content, value.replyToMessageId);
    for (const messageId of sent.messageIds ?? [sent.id]) this.recordReply(messageId, character.id, value.channelId);
    return { messageId: sent.id, channelId: value.channelId, characterId: id };
  }
  recordReply(messageId: string, characterId: string, channelId: string) {
    if (!this.list().some(character => character.id === characterId)) return;
    this.#db.prepare('INSERT OR REPLACE INTO replies VALUES(?,?,?)').run(messageId, characterId, channelId);
    this.#db.exec('DELETE FROM replies WHERE rowid NOT IN (SELECT rowid FROM replies ORDER BY rowid DESC LIMIT 1000)');
  }
  replyCharacter(messageId: string, channelId: string): string | undefined {
    return this.#db.prepare('SELECT character_id FROM replies WHERE message_id=? AND channel_id=?').get(messageId, channelId)?.character_id as string | undefined;
  }
  receive(message: IncomingMessage & { authorName?: string; createdAt?: string }) {
    if (message.bot || message.webhookId || message.guildId !== this.config.guild_id || !message.content.trim() || message.content.length > 4000) return;
    for (const character of this.list()) {
      if (character.mode !== 'external' || !character.channelIds.includes(message.channelId)) continue;
      if (!message.content.includes(`<@&${character.roleId}>`) && message.replyCharacterId !== character.id) continue;
      const mention: Mention = { messageId: message.id, channelId: message.channelId, authorId: message.authorId,
        authorName: message.authorName ?? message.authorId, content: message.content, createdAt: message.createdAt ?? new Date().toISOString() };
      this.#db.prepare('INSERT OR IGNORE INTO mentions(character_id,message_id,data) VALUES(?,?,?)').run(character.id, message.id, JSON.stringify(mention));
      this.#db.prepare('DELETE FROM mentions WHERE character_id=? AND seq NOT IN (SELECT seq FROM mentions WHERE character_id=? ORDER BY seq DESC LIMIT 1000)').run(character.id, character.id);
    }
  }
  mentions(id: string, input: unknown) {
    const value = this.#parse(actor.extend({ after: snowflake.optional() }).strict(), input);
    this.#owned(id, value.actorDiscordId);
    const mentions = this.#db.prepare('SELECT data FROM mentions WHERE character_id=? ORDER BY seq').all(id).map(row => JSON.parse(row.data as string) as Mention);
    return { mentions: value.after ? mentions.filter(mention => BigInt(mention.messageId) > BigInt(value.after!)) : mentions };
  }
  async command(command: { guildId: string | null; actorDiscordId: string; subcommand: string; id?: string; name?: string; description?: string; avatarUrl?: string }) {
    if (command.guildId !== this.config.guild_id) throw new CharacterError('invalid');
    const { actorDiscordId, id, name, description, avatarUrl } = command;
    const input = { actorDiscordId, ...(name !== undefined ? { name } : {}), ...(description !== undefined ? { description } : {}), ...(avatarUrl !== undefined ? { avatarUrl } : {}) };
    switch (command.subcommand) {
      case 'list': return { characters: this.list() };
      case 'create': return this.create(input);
      case 'edit': if (!id) throw new CharacterError('invalid'); return this.edit(id, input);
      case 'delete': if (!id) throw new CharacterError('invalid'); return this.delete(id, { actorDiscordId });
      default: throw new CharacterError('invalid');
    }
  }
}
