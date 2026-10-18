import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const snowflake = z.string().regex(/^\d{1,22}$/);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const characterSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  name: z.string().min(1).max(80),
  role_id: snowflake,
  prompt: z.string().min(1).max(8000),
  context_files: z.array(z.string().min(1)).max(10).default([]),
  resources: z.array(z.string().url()).max(10).default([]),
  allowed_member_roles: z.array(snowflake).default([]),
  avatar_url: z.string().url().refine(value => new URL(value).protocol === 'https:').optional(),
  mcp_token_env: envName.optional(),
}).strict();
const configSchema = z.object({
  guild_id: snowflake,
  bot_token_env: envName.default('DISCORD_BOT_TOKEN'),
  channels: z.array(z.object({ id: snowflake, webhook_env: envName }).strict()).min(1),
  characters: z.array(characterSchema).min(1).max(20),
  context_root: z.string().min(1),
  state_root: z.string().min(1),
  claude_command: z.string().min(1).default('claude'),
  timeout_ms: z.number().int().min(100).max(300_000).default(90_000),
  max_queue: z.number().int().min(1).max(100).default(10),
  mcp: z.object({
    url: z.string().url().refine(value => {
      const url = new URL(value);
      return !url.username && !url.password && !url.search && !url.hash &&
        (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
    }, 'MCP requires HTTPS or loopback HTTP without credentials/query/fragment'),
    token_env: envName.optional(),
  }).strict().optional(),
}).strict();

export type Character = z.infer<typeof characterSchema>;
export type Channel = z.infer<typeof configSchema>['channels'][number];
export type GatewayConfig = z.infer<typeof configSchema>;

export async function loadConfig(path: string): Promise<GatewayConfig> {
  // Do not reflect YAML or validator values: external config may name private resources.
  let config: GatewayConfig;
  try {
    config = configSchema.parse(parse(await readFile(path, 'utf8')));
  } catch {
    throw new Error('Invalid character configuration; check the local file privately');
  }
  for (const field of ['id', 'role_id'] as const) {
    if (new Set(config.characters.map(character => character[field])).size !== config.characters.length) {
      throw new Error(`Character ${field} values must be unique`);
    }
  }
  if (new Set(config.channels.map(channel => channel.id)).size !== config.channels.length) {
    throw new Error('Channel IDs must be unique');
  }
  if (!config.mcp && config.characters.some(character => character.resources.length > 0)) {
    throw new Error('Characters with resource URIs require an MCP endpoint');
  }
  const base = dirname(resolve(path));
  config.context_root = resolve(base, config.context_root);
  config.state_root = resolve(base, config.state_root);
  return config;
}
