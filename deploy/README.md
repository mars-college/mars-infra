# Mars on one VM

Run Mars MCP, the Discord character gateway, Cuelight and PostgreSQL as one Docker Compose project. Caddy is the only service with published ports. It terminates public HTTPS and verifies Cuelight's private upstream certificate. The gateway shares MCP's network namespace so its API stays on loopback. Cuelight **browser nodes** work behind this proxy; native screens that require client-certificate authentication need a separate mTLS listener or a passthrough deployment.

## Prepare the VM

Use a dedicated Ubuntu 24.04 Linux amd64 VM (2 GiB RAM minimum for this layout), two DNS names pointing to it, and a working SSH key. In an existing root session run `deploy/bootstrap`, then check that a new SSH session works before closing the old one. The script configures key-only SSH, UFW, unattended security updates, a 2 GiB `/swapfile`, and Docker with the Compose plugin. On an existing host, review any previous firewall rules explicitly; the script does not remove rules it did not create. Keep all new Compose port publications restricted to Caddy's TCP 80 and 443; Docker port publishing can bypass UFW's input rules.

Clone this repository and the public `mars-mcp` repository. Check out a reviewed, full MCP commit in detached HEAD mode. Do not build from a dirty MCP checkout. The MCP revision is both the image tag and an OCI label; the operator must check that it matches the checkout being built. Cuelight's image downloads the pinned Linux amd64 release and checks its SHA-256. The gateway installs a pinned native Claude Code CLI.

## Set configuration and start

Create a dedicated private config directory with mode `0700`, and keep its files at `0600`, separate from the source checkouts. These values are for `stack.env` (use absolute paths and a random URL-safe `POSTGRES_PASSWORD`, e.g. 32 random bytes encoded as hex):

```dotenv
MCP_HOST=mcp.example.org
CUELIGHT_HOST=cuelight.example.org
MARS_MCP_REV=FULL_REVIEWED_COMMIT_SHA
MARS_MCP_CHECKOUT=/srv/mars-mcp
MARS_CONFIG_DIR=/etc/mars
MARS_CATALOG_DIR=/srv/mars-private/catalog
MARS_AGENT_CONTEXT_DIR=/srv/mars-private/character-context
POSTGRES_PASSWORD=REPLACE_WITH_RANDOM_HEX
```

Create `$MARS_CONFIG_DIR/mcp.env` and `$MARS_CONFIG_DIR/gateway.env` first (they may start empty). They use Compose's raw env format: `NAME=value`, one per line, without wrapping quotes. In the commands below use the actual private path, and run from `deploy/`:

```sh
compose() { docker compose --env-file /etc/mars/stack.env "$@"; }
compose --parallel 1 up -d --build --wait cuelight-control
```

This starts PostgreSQL, initializes Cuelight's data directory and PKI once, and starts `cuelight-control`. The init job can be rerun; it will not replace existing keys. Only its public upstream CA certificate is copied to Caddy's trust volume. Never trust the proxy network as a Cuelight operator network: operators authenticate with scoped bearers.

Mint the Cuelight token and capture its JSON output to a private, mode-`0600` file. Extract `secret` into `CUELIGHT_TOKEN` in `mcp.env` without logging it.

```sh
(umask 077; compose exec -T cuelight-control /usr/local/bin/run-cuelight admin token create \
  --actor-name mars-mcp --scopes node_read,assignment_read,assignment_write,media_read,media_write \
  > /etc/mars/cuelight-mcp-token.json)
```

Create a private catalog with `resources.json` and `documents/`. For example, use a manifest containing `{"resources":[{"uri":"mars://demo/orientation","name":"Example orientation","description":"Synthetic guide","file":"orientation.md","allowRoles":["mars-2027"]}]}` and a synthetic `documents/orientation.md`. Give container UID `1000` read and traverse access to the catalog and character context and the private gateway config under `/etc/mars/discord`, but not to the env files on the host. For the service principal, generate a random bearer (e.g. 32 random bytes encoded as hex), set `MARS_MCP_TOKEN` in `gateway.env` and set `MARS_SERVICE_PRINCIPALS` in `mcp.env` to a JSON array such as `[{"name":"mars-agents","tokenSha256":"DIGEST_OF_RAW_BEARER","roles":["mars-2027"]}]`. Use the lowercase SHA-256 of the bearer with **no trailing newline**. The raw bearer does not belong in `mcp.env`. Set the same separate random `MARS_GATEWAY_TOKEN` in both files for the private gateway API. Set `DISCORD_ROLE_MAP={}` until provisioning returns a real group role ID.

The MCP HTTP, metadata and service-principal paths work before Discord sign-in is configured. To enable sign-in set `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_GUILD_ID`, and `DISCORD_ROLE_MAP` in `mcp.env`, and register `https://mcp.example.org/auth/discord/callback` on the Discord app. The gateway waits on its loopback health endpoint until `DISCORD_BOT_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` have been supplied in `gateway.env`. See [gateway provisioning](../agents/README.md#discord-safety-and-provisioning). Put the private runtime configuration at `$MARS_CONFIG_DIR/discord/characters.yaml` (use `context_root: /context`, `state_root: /state`, and `api_port: 4401`) and provisioned webhook credentials in `$MARS_CONFIG_DIR/discord/webhooks.env` (0600). Never put secrets or real guild/channel IDs in this checkout.

```sh
compose --parallel 1 up -d --build --wait
compose ps -a
../bin/check-http https://mcp.example.org
curl -fsS https://cuelight.example.org/health
```

Changing the hostnames in `stack.env` changes Caddy sites, the MCP issuer, and Cuelight's public URLs. Ensure live DNS and the new Discord callback before switching, then run `compose up -d --wait`. Changing an origin requires fresh MCP authorization and re-pairing browser nodes at the new origin; the old browser storage is origin-specific. Keep stable hostnames when moving between hosts.

## Move to another VM

1. Bootstrap the destination and prepare the same Compose revision, pinned MCP checkout, external configuration (including credentials), catalog and character context. Preserve ownership and modes. Use the same project name (`mars`) and hostnames. Lower DNS TTL ahead of time. Build without starting user-facing services if desired.
2. Schedule downtime. At the source, stop writers with `compose stop caddy mars-agents mars-mcp cuelight-control`. Dump PostgreSQL using `umask 077; compose exec -T postgres pg_dump -U cuelight -d cuelight --format=custom > postgres.dump`. Keep PostgreSQL running until the dump completes.
3. Copy the **whole** `mars_cuelight` volume, not just `cas/`: the browser and release configuration needs its PKI and publisher/seal keys too. Copy `mars_mcp_state`, `mars_gateway_state`, and optionally `mars_caddy_data` and `mars_caddy_config`. Example for a stopped volume: `umask 077; docker run --rm -v mars_cuelight:/state:ro alpine tar -C /state -cpf - . > cuelight.tar`. Transfer backups securely; they contain credentials and participant data. Never archive a live SQLite database this way.
4. On the destination, restore each archive into its matching empty named volume (`docker volume create mars_cuelight`, then `docker run --rm -i -v mars_cuelight:/state alpine tar -C /state -xpf - < cuelight.tar`). Start only PostgreSQL: `compose up -d --wait postgres`. Restore into the empty `cuelight` database: `compose exec -T postgres pg_restore -U cuelight -d cuelight --exit-on-error < postgres.dump`. Then start the entire stack; the init job derives the trust volume from the restored CA. Do not use `down -v` as part of a rollback.
5. Point DNS A/AAAA to the destination, verify HTTPS, OAuth discovery and an assigned screen, and keep the source offline but intact until the cutover is accepted. If moving without keeping the hostnames, also change the Discord callback as above. Restore tests and TLS expiry/renewal checks belong in operator maintenance, not the application containers.
