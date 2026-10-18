import { Client, Events, GatewayIntentBits, WebhookClient } from "discord.js";
import type { Message } from "discord.js";
import type { GatewayConfig } from "./config.js";
import type { CharacterReply, IncomingMessage } from "./engine.js";

export interface GatewayMessage {
  id: string;
  guildId: string | null;
  channelId: string;
  parentChannelId?: string | null;
  authorId: string;
  content: string;
  bot: boolean;
  webhookId?: string | null;
  replyMessageId?: string | null;
}

export interface WebhookPayload {
  content: string;
  username: string;
  avatarURL?: string;
  threadId?: string;
  allowedMentions: { parse: []; users: []; roles: []; repliedUser: false };
}

/** The only injectable boundary: gateway events, current membership, and webhook I/O. */
export interface DiscordTransport {
  onMessage(handler: (message: GatewayMessage) => void): () => void;
  onError(handler: () => void): () => void;
  login(token: string): Promise<void>;
  fetchRoleIds(guildId: string, authorId: string): Promise<string[]>;
  send(channelId: string, payload: WebhookPayload): Promise<{ id: string }>;
  close(): Promise<void>;
}

export interface DiscordCredentials {
  token: string;
  webhooks: ReadonlyMap<string, string>;
}

type ErrorCode = "credentials" | "configuration" | "startup" | "member" | "engine" | "delivery" | "gateway" | "shutdown";

/** Never retain raw SDK exceptions: they can include URLs, tokens, or message bodies. */
export class DiscordGatewayError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "DiscordGatewayError";
  }
}

export function discordCredentials(config: GatewayConfig, env: NodeJS.ProcessEnv = process.env): DiscordCredentials {
  const names = [config.bot_token_env, ...config.channels.map((channel) => channel.webhook_env)];
  if (names.some((name) => !/^[A-Z_][A-Z0-9_]*$/.test(name))) {
    throw new DiscordGatewayError("configuration", "Invalid credential environment variable name");
  }
  const missing = [...new Set(names.filter((name) => !env[name]?.trim()))];
  if (missing.length) {
    throw new DiscordGatewayError("credentials", `Missing environment variables: ${missing.join(", ")}`);
  }
  const webhooks = new Map<string, string>();
  for (const channel of config.channels) {
    const value = env[channel.webhook_env]!.trim();
    let valid = false;
    try {
      const url = new URL(value);
      valid = url.protocol === "https:" && ["discord.com", "discordapp.com"].includes(url.hostname)
        && !url.port && !url.username && !url.password && !url.search && !url.hash
        && /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
    } catch { /* Report only the environment variable name below. */ }
    if (!valid) {
      throw new DiscordGatewayError("configuration", `Invalid Discord webhook environment variable: ${channel.webhook_env}`);
    }
    webhooks.set(channel.id, value);
  }
  return { token: env[config.bot_token_env]!.trim(), webhooks };
}

/** No provisioning, per-character bots, databases, or cloud coordination. */
export function createDiscordTransport(credentials: DiscordCredentials): DiscordTransport {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  const webhooks = new Map<string, WebhookClient>();
  try {
    for (const [channelId, url] of credentials.webhooks) {
      webhooks.set(channelId, new WebhookClient({ url }, { allowedMentions: { parse: [] } }));
    }
  } catch {
    for (const webhook of webhooks.values()) webhook.destroy();
    void client.destroy();
    throw new DiscordGatewayError("configuration", "Unable to configure Discord transport");
  }
  return {
    onMessage(handler) {
      const listener = (message: Message) => {
        handler({
          id: message.id,
          guildId: message.guildId,
          channelId: message.channelId,
          parentChannelId: message.channel.isThread() ? message.channel.parentId : undefined,
          authorId: message.author.id,
          content: message.content,
          bot: message.author.bot,
          webhookId: message.webhookId,
          replyMessageId: message.reference?.messageId,
        });
      };
      client.on(Events.MessageCreate, listener);
      return () => { client.off(Events.MessageCreate, listener); };
    },
    onError(handler) {
      const listener = () => { handler(); };
      client.on(Events.Error, listener);
      client.on(Events.ShardError, listener);
      return () => {
        client.off(Events.Error, listener);
        client.off(Events.ShardError, listener);
      };
    },
    async login(token) { await client.login(token); },
    async fetchRoleIds(guildId, authorId) {
      const guild = await client.guilds.fetch(guildId);
      // force bypasses the member cache; a role removed since the event must not authorize a turn.
      const member = await guild.members.fetch({ user: authorId, force: true });
      return [...member.roles.cache.keys()];
    },
    async send(channelId, payload) {
      const webhook = webhooks.get(channelId);
      if (!webhook) throw new DiscordGatewayError("delivery", "Discord webhook unavailable");
      const message = await webhook.send(payload);
      return { id: message.id };
    },
    async close() {
      for (const webhook of webhooks.values()) webhook.destroy();
      await client.destroy();
    },
  };
}

/** Split UTF-16 lengths conservatively without bisecting surrogate pairs. */
export function discordChunks(content: string): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < content.length) {
    let end = Math.min(offset + 2000, content.length);
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]!)) end--;
    const chunk = content.slice(offset, end);
    if (chunk.trim()) chunks.push(chunk);
    offset = end;
  }
  return chunks;
}

interface ReplyAttribution { characterId: string; channelId: string; threadId?: string }

export interface DiscordGateway {
  /** Also used by deterministic local fixtures; it applies all production authorization boundaries. */
  handle(message: GatewayMessage): Promise<void>;
  close(): Promise<void>;
}

export interface DiscordOptions {
  env?: NodeJS.ProcessEnv;
  transportFactory?: (credentials: DiscordCredentials) => DiscordTransport;
  onError?: (error: DiscordGatewayError) => void;
  maxReplyMappings?: number;
}

export async function startDiscord(
  config: GatewayConfig,
  engine: { handle(message: IncomingMessage): Promise<CharacterReply[]> },
  options: DiscordOptions = {},
): Promise<DiscordGateway> {
  // Always preflight before constructing a transport, including when a fixture supplies the factory.
  const credentials = discordCredentials(config, options.env);
  const maxMappings = options.maxReplyMappings ?? 1000;
  if (!Number.isSafeInteger(maxMappings) || maxMappings < 1) {
    throw new DiscordGatewayError("configuration", "Invalid Discord reply mapping capacity");
  }
  const report = (code: ErrorCode, message: string) => {
    try { options.onError?.(new DiscordGatewayError(code, message)); } catch { /* A logger cannot fail a turn. */ }
  };
  let transport: DiscordTransport;
  try { transport = (options.transportFactory ?? createDiscordTransport)(credentials); }
  catch { throw new DiscordGatewayError("startup", "Discord transport initialization failed"); }
  const channels = new Set(config.channels.map((channel) => channel.id));
  const characters = new Set(config.characters.map((character) => character.id));
  const replies = new Map<string, ReplyAttribution>();
  const pending = new Set<Promise<void>>();
  let closing = false;
  let closePromise: Promise<void> | undefined;

  const processMessage = async (message: GatewayMessage) => {
    if (closing || message.bot || message.webhookId || message.guildId !== config.guild_id) return;
    const threadId = message.parentChannelId ? message.channelId : undefined;
    const channelId = message.parentChannelId ?? message.channelId;
    if (!channels.has(channelId)) return;
    let roleIds: string[];
    try { roleIds = await transport.fetchRoleIds(message.guildId, message.authorId); }
    catch { report("member", "Discord current membership unavailable"); return; }
    const attribution = message.replyMessageId ? replies.get(message.replyMessageId) : undefined;
    const replyCharacterId = attribution?.channelId === channelId && attribution.threadId === threadId
      ? attribution.characterId : undefined;
    let generated: CharacterReply[];
    try {
      generated = await engine.handle({
        id: message.id,
        guildId: message.guildId,
        channelId,
        authorId: message.authorId,
        content: message.content,
        roleIds,
        bot: false,
        webhookId: message.webhookId,
        replyCharacterId,
        threadId,
      });
    } catch { report("engine", "Character turn failed"); return; }
    for (const reply of generated) {
      if (!characters.has(reply.characterId)) {
        report("delivery", "Unknown character reply rejected");
        continue;
      }
      for (const content of discordChunks(reply.content)) {
        try {
          const sent = await transport.send(channelId, {
            content,
            username: reply.name,
            avatarURL: reply.avatarUrl,
            threadId,
            allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
          });
          replies.set(sent.id, { characterId: reply.characterId, channelId, threadId });
          if (replies.size > maxMappings) replies.delete(replies.keys().next().value!);
        } catch { report("delivery", "Discord character delivery failed"); return; }
      }
    }
  };
  const handle = (message: GatewayMessage): Promise<void> => {
    const turn = processMessage(message).catch(() => { report("gateway", "Discord message handling failed"); });
    pending.add(turn);
    void turn.finally(() => { pending.delete(turn); });
    return turn;
  };
  let removeMessage = () => {};
  let removeError = () => {};
  const close = (): Promise<void> => {
    if (!closePromise) {
      closing = true;
      removeMessage();
      closePromise = (async () => {
        await Promise.all([...pending]);
        try { await transport.close(); } catch { report("shutdown", "Discord shutdown failed"); }
        removeError();
        replies.clear();
      })();
    }
    return closePromise;
  };
  try {
    removeError = transport.onError(() => { report("gateway", "Discord gateway error"); });
    removeMessage = transport.onMessage((message) => { void handle(message); });
    await transport.login(credentials.token);
  } catch {
    await close();
    throw new DiscordGatewayError("startup", "Discord gateway startup failed");
  }
  return { handle, close };
}
