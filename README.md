# Mars infrastructure

Local-first infrastructure examples for [mars-mcp](https://github.com/mars-college/mars-mcp): character agents, read-only checks and an example service unit. Public source describes interfaces and synthetic examples—not an operator's computers or private resource inventory.

## Local-first character agents

[`agents/`](agents/README.md) contains the shared Discord-bot/character-webhook
gateway and bounded `claude -p` runner. Its credential-free smoke exercises
local MCP/context/routing/delivery with an explicitly synthetic CLI. Real
Discord credentials and private resource/character manifests stay external;
no hosting or network changes are needed to run the local proof.

## Public directory and governance

[`inventory.yaml`](inventory.yaml) lists public repositories and service
interfaces only. Jonathan ([jmilldotdev](https://github.com/jmilldotdev)) and
Gene ([genekogan](https://github.com/genekogan)) maintain the repositories.
Anyone may propose changes by PR; maintainers approve resource exposure and
permissions. Repository access does not grant access to community data.

## Read-only checks

Requires Python 3.11+:

```sh
./bin/check-http http://localhost:4400
python3 -m unittest discover -s tests -v
```

`check-http [URL]` checks anonymous health, OAuth discovery and unauthenticated
MCP denial without following redirects or printing response bodies. A pass
does not prove real Discord login, resource authorization or a deployed revision.

`check-host --user EXPECTED_ACCOUNT` is an optional **local** check of an
operator-owned example deployment. It refuses root and mismatched accounts.
`--env-file` and `--state-dir` can select private operator paths; defaults match
the example unit. It checks metadata/status only, prints fixed labels, and
never reads credentials, fetches logs, connects remotely or changes services.

Tests use local HTTP fixtures and synthetic OS identities; they do not exercise
host credentials or deploy services.

## Hosting later

[`systemd/mars-mcp.service`](systemd/mars-mcp.service) is a generic rootless
Podman example, **not a record of an existing deployment**. It uses conventional
per-user configuration/state paths, loopback publication and no resource mounts.
The container env file must set `PORT=4400`, `BIND_HOST=0.0.0.0`, an approved
HTTPS `PUBLIC_URL`, and the application's Discord settings; host publication
remains loopback-only. Create the dedicated private state directory before use.
Do not install it over a running service without reviewing the private
deployment configuration, auth-state migration, audience policy and rollback.

Keep actual hosts/IPs, OS accounts, SSH routes/keys, mounts, resource inventory,
credentials and deployment runbooks in private operator storage outside these
repositories. Public resource metadata must be deliberately approved for
publication; protecting content does not hide an entry's existence.

Hosting/network changes and real Discord setup require separate owner approval.
The local smokes use synthetic context and do not access private resources.

## Agent operation

[`agents/`](agents/README.md) documents the native CLI runner and credential-free
local demonstration. [Provider assessment](docs/agent-runners.md) distinguishes
personal scheduled CLI use from a shared third-party service; authentication
support alone is not approval for every operating model.

Contributed code must not run with credentials or private context merely because
someone opened a PR. Review permission changes and consequential writes before
execution; no privileged auto-deployer is included.
