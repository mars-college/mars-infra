import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import { createDiscordRest, provisionPrivateConfig } from '../src/provision.js';

// Usage: node --import tsx scripts/provision.ts /private/path/provision.yaml
// The token comes only from the environment named by bot_token_env in that YAML.
// Never print paths, IDs, webhook URLs, config values, or underlying exceptions.
try {
  if (process.argv.length !== 3) throw new Error();
  const path = process.argv[2]!;
  const input = z.object({ bot_token_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default('DISCORD_BOT_TOKEN') })
    .parse(parse(await readFile(path, 'utf8')));
  const token = process.env[input.bot_token_env];
  if (!token?.trim()) throw new Error();
  const result = await provisionPrivateConfig(path, createDiscordRest(token));
  process.stdout.write(`${result.status}\n`);
  if (result.status === 'not-installed') process.exitCode = 2;
} catch {
  process.stderr.write('Provisioning failed; check private input, token environment, and Discord permissions.\n');
  process.exitCode = 1;
}
