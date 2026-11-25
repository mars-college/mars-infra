import { createServer } from 'node:http';
import { execve } from 'node:process';

const { DISCORD_BOT_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, MARS_CHARACTERS_CONFIG } = process.env;
const pending = [!DISCORD_BOT_TOKEN?.trim() && 'discord', !CLAUDE_CODE_OAUTH_TOKEN?.trim() && 'claude'].filter(Boolean);
if (!pending.length) {
  execve(process.execPath, [process.execPath, '--experimental-sqlite', 'dist/start.js', MARS_CHARACTERS_CONFIG], process.env);
} else {
  console.log(`Mars gateway waiting for ${pending.join(' and ')} credentials`);
  createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/healthz') return res.writeHead(404).end();
    res.end(JSON.stringify({ status: 'waiting', pending }));
  }).listen(4401, '127.0.0.1');
}
