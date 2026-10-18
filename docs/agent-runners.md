# Claude scheduled work: feasibility, not deployment

**No runner or cron is enabled.** Choose an actual useful scheduled task and
approve its data access and budget before installing one.

## Subscription versus API

The [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
states that, unless previously approved, third-party developers may not offer
Claude.ai login or rate limits for their products, including SDK agents. Use
[documented API/provider authentication](https://code.claude.com/docs/en/agent-sdk/quickstart),
not copied personal subscription OAuth credentials.

The [Claude Code CLI](https://code.claude.com/docs/en/headless) can run
noninteractively. That capability does not authorize making a personal account
available as a shared community SDK service. [Consumer Terms](https://www.anthropic.com/legal/consumer-terms)
prohibit making an account available to others and restrict automated access
except through an API key or where explicitly permitted. The SDK is governed
by [Commercial Terms](https://www.anthropic.com/legal/commercial-terms).

There is a legitimate subsidized lane: current official
[Max/Team API-credit documentation](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)
includes the Agent SDK. Eligible Max 5x/20x or Team owners can link a Console
organization and use its API keys. This is API usage funded by included
credits, **not** subscription OAuth/rate-limit reuse. Check eligibility and
owner consent privately; do not claim/link credits automatically. These
credits do not apply to external provider platforms. Purchased balances,
auto-reload or invoicing can still create charges after included credits run
out; credits alone are not a no-spend cap.

Anthropic's [hosted routines](https://code.claude.com/docs/en/routines) are a
separate individual-account product, not a Mars-operated community SDK runner.

## If a task is approved

- Mars-authorized API workspace/key or supported provider credentials.
- One finite job at a time, hard timeout, per-run turns/cost bounds and provider
  spend limits; no unapproved paid fallback or recurring consumers.
- Explicit least-privilege tools/data, no host sockets or private archive
  mounts by default. Obtain consent before sending private data to a provider.
- Run untrusted submissions without credentials; human approval for consequential
  writes and resource exposure.
- First proof: bounded read-only synthetic one-shot. Record result/cost without
  credentials or private content.

Official guidance checked 2026-10-17. No model invocation, credential transplant,
credit redemption, schedule, or spend is claimed by this assessment.
