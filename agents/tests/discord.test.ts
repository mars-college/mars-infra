import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import type { GatewayConfig } from "../src/config.js";
import { CharacterEngine } from "../src/engine.js";
import type { CharacterReply, IncomingMessage } from "../src/engine.js";
import { discordChunks, DiscordGatewayError, startDiscord } from "../src/discord.js";
import type { DiscordOptions, DiscordTransport, GatewayMessage, WebhookPayload } from "../src/discord.js";

const config: GatewayConfig = {
  guild_id: "100",
  bot_token_env: "FIXTURE_BOT_TOKEN",
  channels: [{ id: "200", webhook_env: "FIXTURE_CHANNEL_WEBHOOK" }, { id: "201", webhook_env: "FIXTURE_OTHER_WEBHOOK" }],
  characters: [
    { id: "nara", name: "Nara", role_id: "300", prompt: "Synthetic fixture character", context_files: [], resources: [], allowed_member_roles: ["400"] },
    { id: "echo", name: "Echo", role_id: "301", prompt: "Synthetic second character", context_files: [], resources: [], allowed_member_roles: ["400"] },
  ],
  context_root: tmpdir(),
  state_root: "/unused-fixture-state",
  claude_command: "unused-fixture-command",
  timeout_ms: 1000,
  max_queue: 10,
};
const env = {
  FIXTURE_BOT_TOKEN: "synthetic-bot-not-a-credential",
  FIXTURE_CHANNEL_WEBHOOK: "https://discord.com/api/webhooks/900/synthetic-webhook-not-a-credential",
  FIXTURE_OTHER_WEBHOOK: "https://discord.com/api/webhooks/901/synthetic-other-not-a-credential",
};
const reply: CharacterReply = { characterId: "nara", name: "Nara", avatarUrl: "https://example.invalid/nara.png", content: "Synthetic reply" };
const message = (overrides: Partial<GatewayMessage> = {}): GatewayMessage => ({
  id: "500", guildId: "100", channelId: "200", authorId: "600", content: "<@&300> hello", bot: false, ...overrides,
});

class FixtureTransport implements DiscordTransport {
  messageHandler?: (message: GatewayMessage) => void;
  errorHandler?: () => void;
  loginCalls = 0;
  closeCalls = 0;
  roleCalls: { guildId: string; authorId: string }[] = [];
  roles = ["100", "400"];
  sent: { channelId: string; payload: WebhookPayload }[] = [];
  failLogin = false;
  failRoles = false;
  failSend = false;
  failClose = false;
  onMessage(handler: (message: GatewayMessage) => void) {
    this.messageHandler = handler;
    return () => { this.messageHandler = undefined; };
  }
  onError(handler: () => void) {
    this.errorHandler = handler;
    return () => { this.errorHandler = undefined; };
  }
  async login(_token: string) {
    this.loginCalls++;
    if (this.failLogin) throw new Error(`private login error ${env.FIXTURE_BOT_TOKEN}`);
  }
  async fetchRoleIds(guildId: string, authorId: string) {
    this.roleCalls.push({ guildId, authorId });
    if (this.failRoles) throw new Error(`private member content ${env.FIXTURE_BOT_TOKEN}`);
    return [...this.roles];
  }
  async send(channelId: string, payload: WebhookPayload) {
    if (this.failSend) throw new Error(`private message body ${env.FIXTURE_CHANNEL_WEBHOOK}`);
    this.sent.push({ channelId, payload });
    return { id: `sent-${this.sent.length}` };
  }
  async close() {
    this.closeCalls++;
    if (this.failClose) throw new Error(`private close ${env.FIXTURE_BOT_TOKEN}`);
  }
}

async function fixture(options: DiscordOptions = {}, generate?: (incoming: IncomingMessage) => Promise<CharacterReply[]>) {
  const transport = new FixtureTransport();
  const incoming: IncomingMessage[] = [];
  const errors: DiscordGatewayError[] = [];
  const gateway = await startDiscord(config, {
    async handle(value) {
      incoming.push(value);
      return generate ? generate(value) : [{ ...reply }];
    },
  }, { env, transportFactory: () => transport, onError: error => { errors.push(error); }, ...options });
  return { gateway, transport, incoming, errors };
}

function assertPrivate(errors: unknown[]) {
  const text = JSON.stringify(errors.map(error => error instanceof Error ? { name: error.name, message: error.message, ...error } : error));
  assert.ok(!text.includes(env.FIXTURE_BOT_TOKEN));
  assert.ok(!text.includes(env.FIXTURE_CHANNEL_WEBHOOK));
  assert.ok(!text.includes("private message body"));
  assert.ok(!text.includes("private member content"));
}

test("all missing credential names fail before transport construction even with injected transport", async () => {
  let constructed = 0;
  await assert.rejects(startDiscord(config, { handle: async () => [] }, {
    env: {}, transportFactory: () => { constructed++; return new FixtureTransport(); },
  }), error => {
    assert.ok(error instanceof DiscordGatewayError);
    assert.equal(error.code, "credentials");
    assert.equal(error.message, "Missing environment variables: FIXTURE_BOT_TOKEN, FIXTURE_CHANNEL_WEBHOOK, FIXTURE_OTHER_WEBHOOK");
    return true;
  });
  assert.equal(constructed, 0);
  await assert.rejects(startDiscord(config, { handle: async () => [] }, {
    env: { ...env, FIXTURE_OTHER_WEBHOOK: " " },
    transportFactory: () => { constructed++; return new FixtureTransport(); },
  }), /Missing environment variables: FIXTURE_OTHER_WEBHOOK/);
  assert.equal(constructed, 0);
});

test("malformed or non-Discord webhook values expose only their env names and never reach network", async () => {
  for (const url of ["private malformed URL", "http://discord.com/api/webhooks/900/secret", "https://attacker.invalid/api/webhooks/900/secret", "https://discord.com/api/webhooks/900/secret?private=secret", "https://user:secret@discord.com/api/webhooks/900/secret"]) {
    let constructed = false;
    await assert.rejects(startDiscord(config, { handle: async () => [] }, {
      env: { ...env, FIXTURE_CHANNEL_WEBHOOK: url },
      transportFactory: () => { constructed = true; return new FixtureTransport(); },
    }), error => {
      assert.ok(error instanceof DiscordGatewayError);
      assert.equal(error.message, "Invalid Discord webhook environment variable: FIXTURE_CHANNEL_WEBHOOK");
      assert.ok(!error.message.includes(url));
      return true;
    });
    assert.equal(constructed, false);
  }
});

test("factory and login errors are sanitized and failed login releases the single client", async () => {
  await assert.rejects(startDiscord(config, { handle: async () => [] }, {
    env, transportFactory: () => { throw new Error(env.FIXTURE_CHANNEL_WEBHOOK); },
  }), /Discord transport initialization failed/);
  const transport = new FixtureTransport();
  transport.failLogin = true;
  await assert.rejects(startDiscord(config, { handle: async () => [] }, { env, transportFactory: () => transport }), error => {
    assertPrivate([error]);
    assert.ok(error instanceof DiscordGatewayError);
    assert.equal(error.message, "Discord gateway startup failed");
    return true;
  });
  assert.equal(transport.closeCalls, 1);
  assert.equal(transport.messageHandler, undefined);
  assert.equal(transport.errorHandler, undefined);
});

test("guild/channel allowlists reject DMs, outsiders, bots, webhooks and unapproved thread parents before member lookup", async t => {
  const f = await fixture();
  t.after(() => f.gateway.close());
  for (const overrides of [
    { guildId: null }, { guildId: "101" }, { channelId: "999" }, { bot: true },
    { webhookId: "900" }, { bot: true, webhookId: "900" },
    { channelId: "200", parentChannelId: "999" },
  ]) await f.gateway.handle(message(overrides));
  assert.equal(f.transport.roleCalls.length, 0);
  assert.equal(f.incoming.length, 0);
  assert.equal(f.transport.sent.length, 0);
});

test("identity and exact role-mention identifiers reach the engine with freshly resolved roles", async t => {
  const f = await fixture();
  t.after(() => f.gateway.close());
  await f.gateway.handle(message({ content: "@Nara <@&300> <@&301>", id: "502" }));
  assert.deepEqual(f.transport.roleCalls, [{ guildId: "100", authorId: "600" }]);
  assert.deepEqual(f.incoming[0], {
    id: "502", guildId: "100", channelId: "200", authorId: "600", content: "@Nara <@&300> <@&301>",
    roleIds: ["100", "400"], bot: false, webhookId: undefined, replyCharacterId: undefined, threadId: undefined,
  });
  f.transport.roles = ["100"];
  await f.gateway.handle(message());
  assert.deepEqual(f.incoming[1]!.roleIds, ["100"]);
});

test("real engine selects only role IDs, requires live member authorization, and supports several characters", async t => {
  const transport = new FixtureTransport();
  const runs: string[] = [];
  const engine = new CharacterEngine(config, { async run(input) { runs.push(input.characterId); return `Hello from ${input.characterId}`; } });
  const gateway = await startDiscord(config, engine, { env, transportFactory: () => transport });
  t.after(() => gateway.close());
  await gateway.handle(message({ content: "@Nara and @Echo" }));
  assert.deepEqual(runs, []);
  await gateway.handle(message({ id: "501", content: "<@&300> <@&301> hello" }));
  assert.deepEqual(runs, ["nara", "echo"]);
  assert.deepEqual(transport.sent.map(sent => sent.payload.username), ["Nara", "Echo"]);
  transport.roles = ["100"];
  await gateway.handle(message({ id: "502" }));
  assert.deepEqual(runs, ["nara", "echo"]);
});

test("webhook character names/avatars, all no-mention settings and lossless Unicode chunks are delivered", async t => {
  const content = "a".repeat(1999) + "🚀" + "<@600> <@&400> @everyone @here " + "b".repeat(2100);
  const f = await fixture({}, async () => [{ ...reply, content }, { ...reply, characterId: "echo", name: "Echo", avatarUrl: undefined, content: "Second" }]);
  t.after(() => f.gateway.close());
  await f.gateway.handle(message());
  const first = f.transport.sent.slice(0, -1);
  assert.equal(first.map(sent => sent.payload.content).join(""), content);
  assert.equal(f.transport.sent.at(-1)!.payload.username, "Echo");
  for (const sent of first) {
    assert.equal(sent.channelId, "200");
    assert.equal(sent.payload.username, "Nara");
    assert.equal(sent.payload.avatarURL, reply.avatarUrl);
    assert.ok(sent.payload.content.length <= 2000);
    assert.ok(!/[\uD800-\uDBFF]$/.test(sent.payload.content));
    assert.deepEqual(sent.payload.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
  }
  assert.deepEqual(discordChunks(" \n\t"), []);
});

test("thread ingress uses allowlisted parent webhook, keeps exact thread identity and replies in that thread", async t => {
  const f = await fixture();
  t.after(() => f.gateway.close());
  await f.gateway.handle(message({ channelId: "700", parentChannelId: "200" }));
  assert.equal(f.incoming[0]!.channelId, "200");
  assert.equal(f.incoming[0]!.threadId, "700");
  assert.equal(f.transport.sent[0]!.channelId, "200");
  assert.equal(f.transport.sent[0]!.payload.threadId, "700");
  await f.gateway.handle(message({ id: "501", channelId: "700", parentChannelId: "200", content: "continue", replyMessageId: "sent-1" }));
  assert.equal(f.incoming[1]!.replyCharacterId, "nara");
});

test("reply attribution is bounded, tied to channel/thread, not names, and cleared by restart", async t => {
  const f = await fixture({ maxReplyMappings: 2 });
  t.after(() => f.gateway.close());
  await f.gateway.handle(message());
  await f.gateway.handle(message({ id: "501" }));
  await f.gateway.handle(message({ id: "502" }));
  await f.gateway.handle(message({ content: "continue", replyMessageId: "sent-1" }));
  assert.equal(f.incoming.at(-1)!.replyCharacterId, undefined);
  // sent-4 is now retained; another channel must not inherit its character.
  await f.gateway.handle(message({ channelId: "201", content: "continue", replyMessageId: "sent-4" }));
  assert.equal(f.incoming.at(-1)!.replyCharacterId, undefined);
  await f.gateway.handle(message({ content: "continue", replyMessageId: "sent-4" }));
  assert.equal(f.incoming.at(-1)!.replyCharacterId, "nara");
  await f.gateway.handle(message({ channelId: "700", parentChannelId: "200", replyMessageId: "sent-6" }));
  assert.equal(f.incoming.at(-1)!.replyCharacterId, undefined);
  await f.gateway.handle(message({ channelId: "701", parentChannelId: "200", replyMessageId: "sent-7" }));
  assert.equal(f.incoming.at(-1)!.replyCharacterId, undefined);
  await f.gateway.handle(message({ replyMessageId: "unattributed-webhook-with-same-name" }));
  assert.equal(f.incoming.at(-1)!.replyCharacterId, undefined);
  await f.gateway.close();
  const fresh = await fixture();
  t.after(() => fresh.gateway.close());
  await fresh.gateway.handle(message({ content: "continue", replyMessageId: "sent-9" }));
  assert.equal(fresh.incoming[0]!.replyCharacterId, undefined);
});

test("real engine reply routing rechecks membership instead of trusting prior delivery", async t => {
  const transport = new FixtureTransport();
  const engine = new CharacterEngine(config, { async run() { return "Synthetic reply"; } });
  const gateway = await startDiscord(config, engine, { env, transportFactory: () => transport });
  t.after(() => gateway.close());
  await gateway.handle(message());
  await gateway.handle(message({ id: "501", content: "continue", replyMessageId: "sent-1" }));
  assert.equal(transport.sent.length, 2);
  transport.roles = [];
  await gateway.handle(message({ id: "502", content: "continue", replyMessageId: "sent-1" }));
  assert.equal(transport.sent.length, 2);
});

test("failed live member lookup is fail-closed and reports no private error", async t => {
  const f = await fixture();
  t.after(() => f.gateway.close());
  f.transport.failRoles = true;
  await f.gateway.handle(message());
  assert.equal(f.incoming.length, 0);
  assert.equal(f.transport.sent.length, 0);
  assert.equal(f.errors[0]!.code, "member");
  assertPrivate(f.errors);
});

test("engine/delivery/gateway/shutdown errors never expose SDK data or create false attribution", async t => {
  const f = await fixture({}, async () => { throw new Error(`private message body ${env.FIXTURE_BOT_TOKEN}`); });
  t.after(() => f.gateway.close());
  await f.gateway.handle(message());
  assert.equal(f.errors[0]!.code, "engine");
  assert.equal(f.transport.sent.length, 0);
  f.transport.errorHandler?.();
  f.transport.failClose = true;
  await f.gateway.close();
  assert.deepEqual(f.errors.map(error => error.code), ["engine", "gateway", "shutdown"]);
  assertPrivate(f.errors);
  const delivery = await fixture();
  t.after(() => delivery.gateway.close());
  delivery.transport.failSend = true;
  await delivery.gateway.handle(message());
  assert.equal(delivery.errors[0]!.code, "delivery");
  delivery.transport.failSend = false;
  await delivery.gateway.handle(message({ replyMessageId: "sent-1" }));
  assert.equal(delivery.incoming.at(-1)!.replyCharacterId, undefined);
  assertPrivate(delivery.errors);
});

test("unconfigured character replies and empty responses are not delivered", async t => {
  const f = await fixture({}, async () => [{ ...reply, characterId: "outsider" }, { ...reply, content: " \n " }]);
  t.after(() => f.gateway.close());
  await f.gateway.handle(message());
  assert.equal(f.transport.sent.length, 0);
  assert.equal(f.errors[0]!.code, "delivery");
});

test("close removes ingress, drains the existing turn, destroys once and rejects no secrets", async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({}, async () => { await waiting; return [{ ...reply }]; });
  const turn = f.gateway.handle(message());
  const closing = f.gateway.close();
  assert.equal(f.transport.messageHandler, undefined);
  assert.equal(f.transport.closeCalls, 0);
  await f.gateway.handle(message({ id: "later" }));
  release();
  await turn;
  await closing;
  await f.gateway.close();
  assert.equal(f.incoming.length, 1);
  assert.equal(f.transport.sent.length, 1);
  assert.equal(f.transport.closeCalls, 1);
  assert.equal(f.transport.errorHandler, undefined);
  assert.equal(f.transport.loginCalls, 1);
});

test("gateway event ingress uses the same routing and bounded lifecycle as direct local fixtures", async () => {
  const f = await fixture({ onError: () => { throw new Error("logger failure must not escape"); } });
  assert.ok(f.transport.messageHandler);
  f.transport.messageHandler(message());
  f.transport.errorHandler?.();
  await f.gateway.close();
  assert.equal(f.incoming.length, 1);
  assert.equal(f.transport.sent.length, 1);
  assert.equal(f.transport.closeCalls, 1);
});

test("invalid mapping bounds cannot initialize a transport", async () => {
  for (const capacity of [0, -1, 1.5, Number.NaN]) {
    let constructed = false;
    await assert.rejects(startDiscord(config, { handle: async () => [] }, {
      env, maxReplyMappings: capacity,
      transportFactory: () => { constructed = true; return new FixtureTransport(); },
    }), /Invalid Discord reply mapping capacity/);
    assert.equal(constructed, false);
  }
});
