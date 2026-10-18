import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { ClaudeRunner } from '../src/claude.js';
import { CharacterEngine, type IncomingMessage } from '../src/engine.js';

const fixtureCommand = new URL('./fixtures/claude.mjs', import.meta.url).pathname;
const baseMessage: IncomingMessage = { id: '1', guildId: '100', channelId: '200', authorId: '400',
  content: '<@&301> When is dinner?', roleIds: [], bot: false };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mars-characters-'));
  const config = await loadConfig(new URL('../config/example.yaml', import.meta.url).pathname);
  config.claude_command = fixtureCommand;
  config.state_root = directory;
  return { config, directory, engine: new CharacterEngine(config) };
}

test('character ID mentions select isolated context, not names or role spoofing', async () => {
  const f = await fixture();
  try {
    const chiba = await f.engine.handle(baseMessage);
    assert.match(chiba[0]!.content, /Tuesday at 6 PM/);
    assert.doesNotMatch(chiba[0]!.content, /blue shelf/);
    const kitchen = await f.engine.handle({ ...baseMessage, id: '2', content: '<@&302> Where are the plates?' });
    assert.match(kitchen[0]!.content, /blue shelf/);
    assert.doesNotMatch(kitchen[0]!.content, /Tuesday/);
    assert.deepEqual(await f.engine.handle({ ...baseMessage, id: '3', content: '@Chiba When is dinner?' }), []);
    assert.deepEqual(await f.engine.handle({ ...baseMessage, id: '4', bot: true }), []);
    assert.deepEqual(await f.engine.handle({ ...baseMessage, id: '5', webhookId: '999' }), []);
    assert.deepEqual(await f.engine.handle({ ...baseMessage, id: '6', guildId: '666' }), []);
    assert.deepEqual(await f.engine.handle(baseMessage), []);
  } finally { f.engine.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test('restricted character cannot be invoked by a missing member role or remembered reply alone', async () => {
  const f = await fixture();
  f.config.characters[1]!.allowed_member_roles = ['700'];
  try {
    assert.deepEqual(await f.engine.handle({ ...baseMessage, id: '7', content: '<@&302> plates?' }), []);
    assert.deepEqual(await f.engine.handle({ ...baseMessage, id: '8', content: 'plates?', replyCharacterId: 'andy8' }), []);
    const allowed = await f.engine.handle({ ...baseMessage, id: '9', content: '<@&302> plates?', roleIds: ['700'] });
    assert.match(allowed[0]!.content, /blue shelf/);
  } finally { f.engine.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test('context paths cannot escape via traversal or symlink', async () => {
  const f = await fixture();
  const outside = join(f.directory, 'outside.md');
  await writeFile(outside, 'PRIVATE FIXTURE NOT FOR THIS CHARACTER');
  f.config.context_root = join(f.directory, 'inside');
  await mkdir(f.config.context_root);
  await symlink(outside, join(f.config.context_root, 'escape.md'));
  try {
    f.config.characters[0]!.context_files = ['../outside.md'];
    await assert.rejects(f.engine.handle(baseMessage), /context could not be read safely/);
    f.config.characters[0]!.context_files = ['escape.md'];
    await assert.rejects(f.engine.handle({ ...baseMessage, id: '2' }), /context could not be read safely/);
  } finally { f.engine.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test('CLI failures/timeouts/output limits are bounded and never reflect private stderr', async () => {
  const f = await fixture();
  const runner = new ClaudeRunner({ ...f.config, timeout_ms: 700 });
  const run = (question: string) => runner.run({ characterId: 'test', systemPrompt: 'Fixture only',
    input: JSON.stringify({ question, context: [] }) });
  try {
    await assert.rejects(run('[fixture error]'), error => error instanceof Error &&
      /Claude CLI failed/.test(error.message) && !/synthetic-private-error/.test(error.message));
    await assert.rejects(run('[fixture timeout]'), /timed out/);
    await assert.rejects(run('[fixture large]'), /output exceeded/);
    assert.match(await run('hello'), /No relevant fact/);
    runner.close();
    await assert.rejects(run('after close'), /closed/);
  } finally { runner.close(); f.engine.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test('API auth fallback is refused before an inference process starts', async () => {
  const f = await fixture();
  const command = join(f.directory, 'api-cli.mjs');
  const marker = join(f.directory, 'must-not-run');
  await writeFile(command, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nif(process.argv[2]==='auth') console.log(JSON.stringify({loggedIn:true,authMethod:'api_key'})); else writeFileSync(${JSON.stringify(marker)},'unexpected');\n`);
  await chmod(command, 0o700);
  const runner = new ClaudeRunner({ ...f.config, claude_command: command });
  try {
    await assert.rejects(runner.run({ characterId: 'test', systemPrompt: 'Fixture', input: '{}' }), /fallback is disabled/);
    await assert.rejects(access(marker));
  } finally { runner.close(); f.engine.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test('the global inference queue is bounded and shutdown rejects new turns', async () => {
  const f = await fixture();
  f.config.max_queue = 1;
  const entered = Promise.withResolvers<void>();
  const result = Promise.withResolvers<string>();
  const engine = new CharacterEngine(f.config, {
    async run() { entered.resolve(); return result.promise; },
  });
  try {
    const first = engine.handle(baseMessage);
    await entered.promise;
    await assert.rejects(engine.handle({ ...baseMessage, id: 'second' }), /queue is full/);
    result.resolve('Completed bounded fixture turn.');
    await first;
    engine.close();
    await assert.rejects(engine.handle({ ...baseMessage, id: 'third' }), /closed/);
  } finally {
    result.resolve('Fixture cleanup.');
    engine.close(); f.engine.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('bot, MCP and paid API secrets are not inherited by the CLI subprocess', async () => {
  const f = await fixture();
  const names = ['DISCORD_BOT_TOKEN', 'MARS_MCP_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
  const previous = names.map(name => process.env[name]);
  for (const name of names) process.env[name] = 'synthetic-do-not-pass-to-child';
  try {
    const result = await f.engine.handle(baseMessage);
    assert.match(result[0]!.content, /Tuesday at 6 PM/);
    assert.doesNotMatch(result[0]!.content, /synthetic-do-not-pass-to-child/);
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
    f.engine.close(); await rm(f.directory, { recursive: true, force: true });
  }
});
