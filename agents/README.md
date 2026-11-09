# Mars character gateway

One shared Discord bot receives role mentions and replies. Hosted characters run
through the operator's `claude -p`; external characters queue mentions for their
owner's agent. Every character speaks through a channel webhook with its own
name/avatar. Chiba is the community knowledge character; andy9 is the kitchen
character. All committed IDs, context, credentials and fixtures are synthetic.

## Local proof

```sh
npm ci
npm run build
npm test
npm run smoke
npm run smoke:real
# Also exercise actual Claude tool use against the local fake Mars MCP:
MARS_TEST_REAL_CLAUDE=1 npm test
```

`smoke` uses synthetic Discord ingress, a synthetic CLI subprocess, real local
MCP HTTP and a local webhook sink. `smoke:real` substitutes the operator's real
Claude login and prints persona replies and latency; Discord remains synthetic.
The opt-in test proves the actual model subprocess can call a scoped MCP tool.
Tests cover registry ownership, the loopback contract, slash-command handlers,
channel isolation and idempotent provisioning against fake REST.
None of these fixtures claims a real Discord message was delivered.

## Private configuration

Copy `config/example.yaml` outside the checkout and replace synthetic IDs. Keep
real YAML, context, webhook URLs, tokens, SQLite state and environment files in
private operator storage. Start with:

```sh
node --env-file=/private/gateway.env dist/start.js /private/characters.yaml
# Or set MARS_CHARACTERS_CONFIG in the managed service environment.
```

Each hosted character can set:

- `owner_discord_id`: registry owner; edits/deletion/speaking require that user.
- `channel_ids`: allowlisted channels, a subset of the gateway's channels. The
  private deployment sets andy9 to the kitchen channel only.
- `context_files`: files strictly confined to `context_root` (symlink escape is
  denied); reread each turn.
- `resources`: exact Mars resource URI allowlist.
- `mcp_tools`: any subset of `list_resources`, `read_resource`, `cuelight_nodes`,
  `cuelight_play`. Empty/omitted means no model tools.
- `allowed_member_roles`: optional current-member role gate, checked on every
  incoming message. Character roles are selectors, not access entitlements.

`mcp.url` configures the Mars MCP URL; `MARS_MCP_URL` overrides it when set
and is validated identically. `mcp.token_env: MARS_MCP_TOKEN` identifies the service principal
bearer. The gateway preloads only listed resource context. For model tool access,
a per-run loopback MCP proxy forwards only the four named Mars tools and only the
character's allowed resource URIs. Resource enumeration is filtered too. Upstream
service credentials remain in the proxy, never in CLI arguments/environment.

The CLI uses `--tools ''`, an exact `mcp__mars__...` allowlist and
`--strict-mcp-config` with only that scoped Mars server. No Bash/file tools or
other MCP servers are available. Tool runs use restricted mode, no setting
sources, hooks or slash commands; native safe mode disables MCP, so it is used
only for the no-tool lane. Both lanes disable session persistence. The global
queue, subprocess wall-clock timeout, output cap and shutdown cancellation remain
bounded. State directories are private. This is not an OS sandbox.

## Discord safety and provisioning

Install the bot with Guild Messages and Message Content intent. It needs Manage
Roles, Manage Webhooks, View Channel and Send Messages; Manage Channels is useful
but optional. Its role must sit above the character roles. Administrator is not
required. Real channel visibility defines the output audience: an invocation
role gate does not hide a posted reply from other channel viewers.

Mention the character's **role**, not plain text `@Chiba`, or reply to a tracked
character message. Plain ambient messages do not invoke a model. Bot/webhook
input is ignored. Output disables user/role/everyone pings. Delivery/reply maps,
owner inboxes and the inference queue are bounded. Threads use their configured
parent webhook while reply attribution remains channel/thread scoped.

Provision fixtures from a private YAML:

```yaml
guild_id: "100"
owner_discord_id: "400"
bot_token_env: DISCORD_BOT_TOKEN
fallback_channel_ids: ["200", "201"]
config_path: characters.yaml
credentials_path: gateway.env
gateway:
  context_root: context
  state_root: state
  api_port: 4401
  gateway_token_env: MARS_GATEWAY_TOKEN
  mcp:
    url: http://127.0.0.1:4400/mcp
    token_env: MARS_MCP_TOKEN
  characters:
    - id: chiba
      resources: ["mars://demo/guide", "mars://demo/kitchen"]
      mcp_tools: [list_resources, read_resource, cuelight_nodes, cuelight_play]
    - id: andy9
      resources: ["mars://demo/kitchen"]
      mcp_tools: [list_resources, read_resource]
```

```sh
node --env-file=/private/bot.env --import tsx scripts/provision.ts /private/provision.yaml
```

Provisioning first checks guild membership; absence returns `not-installed`
(exit 2) without writes. Otherwise it reconciles permissionless mentionable
`mars-2027`, `Chiba`, `andy9` roles, `mars-general` and `mars-kitchen`, a bot-owned
webhook per allowed channel, and guild `/character` commands. If channel creation
is forbidden, the first fallback channel is general and the second kitchen (one
fallback may serve both). Chiba is scoped to general, andy9 to kitchen. Repeated
runs reuse existing objects. Files are private (`0600`, directories `0700`). It
does not assign the community role to members: grant that role to intended users
before invoking the hosted characters. After provisioning, restart the managed
service. While the bot is absent the service serves health/registry on loopback
and reports `waiting_for_guild_install`; it does not attempt Discord delivery.

## Puppetmaster registry and API

SQLite `characters.sqlite` lives in `state_root`, with owner identities, external
mention inboxes and reply attribution. Hosted config entries are seeded as
operator-owned; owner edits survive restart, and deleted hosted entries do not
silently resurrect. External creation makes a mentionable permissionless role.
Only its owner may edit/delete/speak or read its inbox. Guild slash commands
`/character create|edit|delete|list` use the same registry and invoking Discord
user as actor. Slash responses are private and suppress pings.

Set `api_port` and a generated `MARS_GATEWAY_TOKEN` (at least 32 characters) to
serve **127.0.0.1 only**. Mars MCP is the trusted bearer holder and supplies the
Discord subject as `actorDiscordId`; never expose this API without the bearer.

| Request | JSON / result |
| --- | --- |
| `GET /healthz` | service/Discord readiness (no bearer required) |
| `GET /v1/characters` | `{characters:[{id,name,description,ownerDiscordId,roleId,mode,avatarUrl,channelIds}]}` |
| `POST /v1/characters` | `{actorDiscordId,name,description,avatarUrl?}` → 201 external character |
| `PATCH /v1/characters/:id` | `{actorDiscordId,name?,description?,avatarUrl?}` |
| `DELETE /v1/characters/:id` | `{actorDiscordId}` → `{deleted:true}`; removes role |
| `POST /v1/characters/:id/messages` | `{actorDiscordId,channelId,content,replyToMessageId?}` → `{messageId,channelId,characterId}` |
| `GET /v1/characters/:id/mentions?actorDiscordId=…&after=…` | `{mentions:[{messageId,channelId,authorId,authorName,content,createdAt}]}` |

All `/v1` requests require `Authorization: Bearer …`. Contract errors are
`{error:"not_owner"|"not_found"|"channel_not_allowed"|"invalid"}` with
403/404/400. Discord delivery failure returns 500, without raw SDK diagnostics.
Webhook API messages use the character's name/avatar and disable mentions;
`replyToMessageId` adds a Discord message link because webhook execution cannot
create a native Discord reply. External role mentions and replies are queued,
not sent through the hosted model. Inbox storage retains the latest 1,000 per
character; `after` compares Discord snowflake IDs and does not consume messages.

## Boundaries

No Eden, Mongo, Ably, Modal, cloud controller or additional per-character bot is
required. Public PRs do not grant credentials, deployment rights, arbitrary
execution or access to private manifests. Gene's live Eden deployment is not
inspected or changed. The pattern follows Eve's shared-bot V3 architecture;
this local gateway keeps its own ownership and capability checks.
