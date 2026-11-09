import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import type { GatewayConfig } from './config.js';

export interface DiscordRest {
  request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T>;
}

/** Only status/code are retained; Discord bodies can contain private values. */
export class ProvisioningError extends Error {
  constructor(readonly status = 0, readonly code = 0) {
    super('Fixture provisioning failed; inspect private configuration and Discord permissions');
    this.name = 'ProvisioningError';
  }
}

export function createDiscordRest(token: string, fetcher: typeof fetch = fetch): DiscordRest {
  if (!token.trim()) throw new ProvisioningError();
  return {
    async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
      let response: Response;
      try {
        response = await fetcher(`https://discord.com/api/v10${path}`, {
          method, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch { throw new ProvisioningError(); }
      let data: unknown;
      try { data = await response.json(); } catch { throw new ProvisioningError(response.status); }
      if (!response.ok) {
        const code = data && typeof data === 'object' && 'code' in data && typeof data.code === 'number' ? data.code : 0;
        throw new ProvisioningError(response.status, code);
      }
      return data as T;
    },
  };
}

const snowflake = z.string().regex(/^\d{1,22}$/);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const characterOverride = z.object({
  id: z.enum(['chiba', 'andy9']), prompt: z.string().min(1).max(8000).optional(),
  context_files: z.array(z.string().min(1)).max(10).optional(),
  resources: z.array(z.string().url()).max(10).optional(),
  avatar_url: z.string().url().refine(value => new URL(value).protocol === 'https:').optional(),
  mcp_token_env: envName.optional(),
  mcp_tools: z.array(z.enum(['list_resources', 'read_resource', 'cuelight_nodes', 'cuelight_play'])).optional(),
}).strict();
const inputSchema = z.object({
  guild_id: snowflake, owner_discord_id: snowflake,
  bot_token_env: envName.default('DISCORD_BOT_TOKEN'),
  fallback_channel_ids: z.array(snowflake).default([]),
  config_path: z.string().min(1), credentials_path: z.string().min(1),
  gateway: z.object({
    context_root: z.string().min(1), state_root: z.string().min(1),
    claude_command: z.string().min(1).default('claude'),
    timeout_ms: z.number().int().min(100).max(300000).default(90000),
    max_queue: z.number().int().min(1).max(100).default(10),
    api_port: z.number().int().min(1).max(65535).optional(),
    gateway_token_env: envName.optional(),
    mcp: z.object({ url: z.string().url().refine(value => {
      const url = new URL(value);
      return !url.username && !url.password && !url.search && !url.hash &&
        (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
    }), token_env: envName.optional() }).strict().optional(),
    characters: z.array(characterOverride).max(2).default([]),
  }).strict(),
  // Generated inventory lives only in the private input, not the runtime schema.
  role_ids: z.record(snowflake).optional(),
}).strict().superRefine((input, context) => {
  if (new Set(input.gateway.characters.map(character => character.id)).size !== input.gateway.characters.length ||
      (!input.gateway.mcp && input.gateway.characters.some(character => character.resources?.length))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid character configuration' });
  }
});
export type ProvisionInput = z.input<typeof inputSchema>;
type ParsedInput = z.output<typeof inputSchema>;
interface Role { id: string; name: string; permissions: string; mentionable: boolean }
interface Channel { id: string; name: string; type: number }
interface Webhook { id: string; type: number; token?: string; user?: { id: string } }
interface Command { id: string; name: string; type?: number; description: string; options?: unknown[] }

export const CHARACTER_COMMAND = {
  name: 'character', description: 'Manage your Mars characters', type: 1,
  options: [
    { type: 1, name: 'create', description: 'Create a character', options: [
      { type: 3, name: 'name', description: 'Character name', required: true },
      { type: 3, name: 'description', description: 'Character description', required: true },
      { type: 3, name: 'avatar_url', description: 'HTTPS avatar URL' },
    ] },
    { type: 1, name: 'edit', description: 'Edit a character you own', options: [
      { type: 3, name: 'id', description: 'Character ID', required: true },
      { type: 3, name: 'name', description: 'Character name' },
      { type: 3, name: 'description', description: 'Character description' },
      { type: 3, name: 'avatar_url', description: 'HTTPS avatar URL' },
    ] },
    { type: 1, name: 'delete', description: 'Delete a character you own', options: [
      { type: 3, name: 'id', description: 'Character ID', required: true },
    ] },
    { type: 1, name: 'list', description: 'List Mars characters' },
  ],
};

// Discord supplies default option fields absent from registration payloads.
function commandShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(commandShape);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(['type', 'name', 'description', 'required', 'options'].sort()
    .filter(key => source[key] !== undefined && source[key] !== false && !(Array.isArray(source[key]) && !source[key].length))
    .map(key => [key, commandShape(source[key])]));
}

export type ProvisionResult = { status: 'not-installed' } | {
  status: 'provisioned'; config: GatewayConfig; credentials: Record<string, string>; roleIds: Record<string, string>;
};

function parseInput(value: unknown): ParsedInput {
  try { return inputSchema.parse(value); } catch { throw new ProvisioningError(); }
}

/** No filesystem or environment access. All Discord I/O goes through rest. */
export async function provisionFixtures(value: ProvisionInput, rest: DiscordRest): Promise<ProvisionResult> {
  const input = parseInput(value);
  const guild = `/guilds/${input.guild_id}`;
  // Test membership before any mutating operation; 403 and unknown guild mean not installed.
  try { await rest.request('GET', guild); }
  catch (error) {
    if (error instanceof ProvisioningError && (error.status === 403 || error.status === 404)) return { status: 'not-installed' };
    throw error;
  }
  const bot = await rest.request<{ id: string }>('GET', '/users/@me');
  const application = await rest.request<{ id: string }>('GET', '/oauth2/applications/@me');
  const roles = await rest.request<Role[]>('GET', `${guild}/roles`);
  const roleIds: Record<string, string> = {};
  for (const name of ['mars-2027', 'Chiba', 'andy9']) {
    let role = roles.find(item => item.name === name);
    if (!role) role = await rest.request<Role>('POST', `${guild}/roles`, { name, permissions: '0', mentionable: true });
    else if (role.permissions !== '0' || !role.mentionable) {
      role = await rest.request<Role>('PATCH', `${guild}/roles/${role.id}`, { permissions: '0', mentionable: true });
    }
    roleIds[name] = role.id;
  }
  const existing = await rest.request<Channel[]>('GET', `${guild}/channels`);
  const allowed: Channel[] = [];
  const channelByPurpose: Record<string, string> = {};
  for (const [index, name] of ['mars-general', 'mars-kitchen'].entries()) {
    let channel = existing.find(item => item.name === name && item.type === 0);
    if (!channel) {
      try { channel = await rest.request<Channel>('POST', `${guild}/channels`, { name, type: 0 }); }
      catch (error) {
        if (!(error instanceof ProvisioningError) || error.status !== 403) throw error;
        const fallbackId = input.fallback_channel_ids[index] ?? input.fallback_channel_ids[0];
        channel = existing.find(item => item.id === fallbackId && item.type === 0);
        if (!channel) throw new ProvisioningError(403);
      }
    }
    allowed.push(channel);
    channelByPurpose[name] = channel.id;
  }
  const channelIds = [...new Set(allowed.map(channel => channel.id))];
  const credentials: Record<string, string> = {};
  const channels: GatewayConfig['channels'] = [];
  for (const id of channelIds) {
    const webhooks = await rest.request<Webhook[]>('GET', `/channels/${id}/webhooks`);
    let webhook = webhooks.find(item => item.type === 1 && item.user?.id === bot.id && item.token);
    if (!webhook) webhook = await rest.request<Webhook>('POST', `/channels/${id}/webhooks`, { name: 'Mars characters' });
    if (!webhook.token || !/^[A-Za-z0-9_-]+$/.test(webhook.token)) throw new ProvisioningError();
    const webhook_env = `MARS_WEBHOOK_${id}`;
    credentials[webhook_env] = `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`;
    channels.push({ id, webhook_env });
  }
  const commandsPath = `/applications/${application.id}${guild}/commands`;
  const commands = await rest.request<Command[]>('GET', commandsPath);
  const command = commands.find(item => item.name === 'character' && (item.type ?? 1) === 1);
  if (!command) await rest.request('POST', commandsPath, CHARACTER_COMMAND);
  else if (JSON.stringify(commandShape(command)) !== JSON.stringify(commandShape(CHARACTER_COMMAND))) {
    await rest.request('PATCH', `${commandsPath}/${command.id}`, CHARACTER_COMMAND);
  }
  const { characters: overrides, ...runtime } = input.gateway;
  const characters: GatewayConfig['characters'] = [
    { id: 'chiba', name: 'Chiba', prompt: 'You are Chiba, a concise Mars community and MIT knowledge assistant. Use the supplied context and resources; do not invent community facts.' },
    { id: 'andy9', name: 'andy9', prompt: 'You are andy9, a practical Mars community kitchen assistant. Use the supplied context and resources; do not invent kitchen facts.' },
  ].map(character => ({
    context_files: [], resources: [], ...character, ...overrides.find(item => item.id === character.id),
    role_id: roleIds[character.name]!, owner_discord_id: input.owner_discord_id,
    channel_ids: [channelByPurpose[character.id === 'andy9' ? 'mars-kitchen' : 'mars-general']!],
    allowed_member_roles: [roleIds['mars-2027']!],
  }));
  return { status: 'provisioned', roleIds, credentials, config: {
    ...runtime, guild_id: input.guild_id, bot_token_env: input.bot_token_env, channels, characters,
  } };
}

async function privateWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

/** Input/output paths resolve relative to the private YAML, never to the repository. */
export async function provisionPrivateConfig(path: string, rest: DiscordRest): Promise<ProvisionResult> {
  const absolute = resolve(path);
  let input: ParsedInput;
  try { input = parseInput(parse(await readFile(absolute, 'utf8'))); }
  catch { throw new ProvisioningError(); }
  const base = dirname(absolute);
  const configPath = resolve(base, input.config_path);
  const credentialsPath = resolve(base, input.credentials_path);
  if (new Set([absolute, configPath, credentialsPath]).size !== 3) throw new ProvisioningError();
  // Resolve runtime roots against the input rather than a possibly different output directory.
  input.gateway.context_root = resolve(base, input.gateway.context_root);
  input.gateway.state_root = resolve(base, input.gateway.state_root);
  const result = await provisionFixtures(input, rest);
  if (result.status === 'not-installed') return result;
  await privateWrite(configPath, stringify(result.config));
  // Merge existing private credentials, so MCP/Claude/shared tokens are never discarded.
  let previous = '';
  try { previous = await readFile(credentialsPath, 'utf8'); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw new ProvisioningError();
  }
  const generated = new Set(Object.keys(result.credentials));
  const retained = previous.split('\n').filter(line => !generated.has(line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)=/)?.[1] ?? ''));
  await privateWrite(credentialsPath, `${retained.join('\n').trimEnd()}\n${Object.entries(result.credentials).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
  await privateWrite(absolute, stringify({ ...input, role_ids: result.roleIds }));
  // Runtime-owned private directories must also start private, including when already present.
  for (const directory of [result.config.state_root, result.config.context_root]) {
    if (!isAbsolute(directory)) throw new ProvisioningError();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  return result;
}
