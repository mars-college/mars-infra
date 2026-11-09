import { REST, Routes, WebhookClient } from 'discord.js';
import type { GatewayConfig } from './config.js';
import type { CharacterDiscord } from './registry.js';
import { discordChunks } from './discord.js';

export function characterDiscord(config: GatewayConfig, token: string): CharacterDiscord & { close(): void; installed(): Promise<boolean> } {
  const rest = new REST({ version: '10' }).setToken(token);
  const hooks = new Map<string, WebhookClient>();
  return {
    async installed() {
      const guilds = await rest.get(Routes.userGuilds()) as { id: string }[];
      return guilds.some(guild => guild.id === config.guild_id);
    },
    async createRole(name) {
      const role = await rest.post(Routes.guildRoles(config.guild_id), { body: { name, permissions: '0', mentionable: true } }) as { id: string };
      return role.id;
    },
    async editRole(id, name) { await rest.patch(Routes.guildRole(config.guild_id, id), { body: { name, permissions: '0', mentionable: true } }); },
    async deleteRole(id) { await rest.delete(Routes.guildRole(config.guild_id, id)); },
    async send(character, channelId, content, replyToMessageId) {
      let webhook = hooks.get(channelId);
      if (!webhook) {
        const channel = config.channels.find(value => value.id === channelId);
        const url = channel && process.env[channel.webhook_env];
        if (!url) throw new Error('Channel webhook unavailable');
        webhook = new WebhookClient({ url }); hooks.set(channelId, webhook);
      }
      const text = replyToMessageId ? `${content}\n\n↪ https://discord.com/channels/${config.guild_id}/${channelId}/${replyToMessageId}` : content;
      let sent: { id: string } | undefined;
      for (const chunk of discordChunks(text)) {
        sent = await webhook.send({ content: chunk, username: character.name, avatarURL: character.avatarUrl ?? undefined,
          allowedMentions: { parse: [], users: [], roles: [], repliedUser: false } });
      }
      return { id: sent!.id };
    },
    close() { for (const webhook of hooks.values()) webhook.destroy(); },
  };
}
