import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, chmod } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { CharacterEngine } from './engine.js';
import { DiscordGatewayError, startDiscord } from './discord.js';
import { CharacterRegistry } from './registry.js';
import { characterDiscord } from './character-discord.js';
import { startApi } from './api.js';

export async function startCli(args: string[] = process.argv.slice(2)): Promise<void> {
  const configPath = args[0] ?? process.env.MARS_CHARACTERS_CONFIG;
  if (args.length > 1 || !configPath) throw new Error('Usage: mars-characters <config.yaml>');
  const config = await loadConfig(configPath);
  const token = process.env[config.bot_token_env];
  if (!token) throw new DiscordGatewayError('credentials', `Missing environment variables: ${config.bot_token_env}`);
  await mkdir(config.state_root, { recursive: true, mode: 0o700 });
  await chmod(config.state_root, 0o700);
  const discord = characterDiscord(config, token);
  const databasePath = join(config.state_root, 'characters.sqlite');
  const registry = new CharacterRegistry(databasePath, config, discord);
  await chmod(databasePath, 0o600);
  const installed = await discord.installed();
  const engine = new CharacterEngine(config);
  const hosted = [...config.characters];
  const gateway = installed ? await startDiscord(config, { async handle(message) {
    const registered = registry.list();
    config.characters = hosted.flatMap(character => {
      const current = registered.find(value => value.id === character.id && value.mode === 'hosted');
      if (!character.owner_discord_id) return [character];
      return current ? [{ ...character, name: current.name, prompt: current.description, avatar_url: current.avatarUrl ?? undefined,
        role_id: current.roleId, channel_ids: current.channelIds }] : [];
    });
    return engine.handle(message);
  } }, { registry, onError: error => { console.error(`${error.code}: ${error.message}`); } }) : undefined;
  const api = config.api_port ? await startApi(registry, process.env[config.gateway_token_env ?? 'MARS_GATEWAY_TOKEN'] ?? '', config.api_port,
    () => ({ status: 'ok', discord: installed ? 'connected' : 'waiting_for_guild_install', hostedCharacters: registry.list().filter(value => value.mode === 'hosted').map(value => value.name) })) : undefined;
  console.log(installed ? 'Mars gateway connected' : 'Mars gateway waiting for guild installation; run private provisioning and restart after installation');
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true; engine.close();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    void (async () => {
      await new Promise<void>(resolve => { if (api) api.close(() => resolve()); else resolve(); });
      await gateway?.close(); registry.close(); discord.close();
    })().catch(() => { console.error('Discord shutdown failed'); process.exitCode = 1; });
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void startCli().catch((error: unknown) => {
    console.error(error instanceof DiscordGatewayError ? error.message : 'Character gateway startup failed; check local configuration');
    process.exitCode = 1;
  });
}
