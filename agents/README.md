# Local character gateway

One Discord bot receives role mentions. Characters answer through channel
webhooks with their own names/avatars. Inference runs through the operator's
unmodified `claude -p`; no Eden service dependency, deployment or credentials
are included.

```text
@character role → shared bot → configured character + context → claude -p
                                                               ↓
                                          character webhook reply
```

## Try it without accounts

```sh
npm ci
npm run build
npm test
npm run smoke
```

The smoke sends synthetic gateway messages through the actual router, reads a
resource over real local MCP HTTP, launches a **synthetic CLI subprocess**, and
posts persona replies to a local HTTP webhook sink. It proves routing/context/
delivery plumbing, not Claude intelligence or real Discord login. It costs
nothing and needs no credentials.

Verified locally: Chiba reads an MCP-only fixture while Andy8 reads separate
kitchen context; the member-role gate denies unauthorized invocation, replies
retain persona attribution, and bot/webhook output cannot feed back into the
runner. Starting the compiled gateway without credentials exits with the
missing environment-variable names before any Discord login.

## Connect Discord later

1. Install Claude Code and complete the operator's own native `/login` outside
   the repo. The runner accepts `authMethod: claude.ai` and refuses silent
   API-key/provider/token fallback. Native client limits and terms still apply;
   this is an operator-owned character workload, not a model-credential broker.
2. Copy `config/example.yaml` to a private external config. Replace synthetic
   guild/channel/character role IDs. Set absolute `context_root` and
   `state_root` paths suitable for that private copy.
3. Use one bot with Guild Messages and Message Content access. Enable Message
   Content Intent. Give each character a **mentionable role with no permissions**.
   These roles select characters; they do not grant member access. No role or
   webhook is created automatically and Administrator is not needed.
4. An operator creates a webhook in each allowed channel. Put the bot token and
   webhook URLs in a private environment file, using the variable names in
   `.env.example`. The example contains names only, no usable credentials.
5. Start in the foreground:

```sh
node --env-file=/path/to/private/discord.env dist/start.js /path/to/private/characters.yaml
```

Mention the actual character role, not plain text `@Chiba`. Both roles can use
one shared bot and the same channel webhook. Replies to this process's sent
messages select that character too; after restart or mapping eviction, mention
it again. Threads use their configured parent-channel webhook. Bot/webhook
messages never trigger inference, and outgoing replies cannot ping people or
roles.

## Context and access

- `context_files` selects only that character's files below `context_root`.
  Paths/symlinks cannot escape it; context is reread for every turn.
- Optional `mcp.url` plus per-character `resources` retrieves context using the
  standard MCP client. `mcp.token_env` or a character's `mcp_token_env` names an
  existing approved credential in the host environment; it never reaches the
  CLI. Server authorization still applies. The current Mars OAuth tokens expire
  within 15 minutes; this package does not invent service tokens or renewal.
- `allowed_member_roles: []` permits members of the configured guild/channel;
  a nonempty list requires a current matching member role. Character mention
  roles are not member entitlements.
- **Channel visibility is the output audience.** Do not attach private context
  to a character in a channel whose participants may not receive it. An
  invocation role gate does not hide posted replies from other channel viewers.
- Turns are stateless. No transcript memory or private-data ingestion is enabled.
  Reply attribution is routing, not conversation memory.

The runner has one global bounded queue, a hard per-call timeout, capped output,
private per-character work directories, no tools/MCP in the model subprocess,
no inherited bot/webhook/MCP/API credentials, no session persistence, and native
safe mode. Shutdown cancels the active CLI process group. It is not an OS
sandbox; run it under an appropriate operator account.

## Public versus private

Public source contains synthetic IDs/context and environment **names**. Keep
real manifests, identities, webhook URLs, MCP credentials, private context and
state outside the repository. Local `.local`, `private`, env and build paths
are excluded as a secondary safeguard. Do not put private resources in a
public catalog and assume content access alone hides their existence.

Anyone may propose public context/character changes by PR; a maintainer reviews
exposure and accepts them. PR authors do not automatically acquire write access,
credentials, deployment rights, or permission to execute contributed code.

## Pattern source

Eve's current public source calls this shared-bot design **V3**, alongside its
older V2 gateway:
[role routing](https://github.com/edenartlab/eve/blob/main/eve/agent/deployments/gateway_v3.py#L1073-L1134),
[webhook delivery](https://github.com/edenartlab/eve/blob/main/eve/agent/deployments/discord_v3.py#L794-L826).
This implementation has no Mongo/Ably/Modal dependencies, no name-based identity
fallback, no raw-message logging, and no automatic Discord administration.
Gene's running Eden configuration was not inspected or changed.
