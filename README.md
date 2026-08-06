# seenpaid

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

**Ask your AI agent which of your posts made money.**

That question is answered by [seenpaid.com](https://seenpaid.com) — the
hosted cloud product, which matches your Stripe sales back to the exact post
that drove them. This repository is **not** that. This repository is the
open posting layer underneath it: a self-hosted scheduler that connects to
25 social and publishing platforms, queues and retries deliveries, and
exposes itself to an AI agent over MCP (Model Context Protocol) so an agent
can schedule posts on your behalf. Point an agent at your own instance, or
point it at seenpaid.com if you also want the revenue answer — same MCP
shape, different depth.

## What this is

- A BullMQ-backed publish pipeline: schedule a post once, it fans out to
  every connected platform as an independent, retried job.
- 25 platform adapters behind one interface — OAuth, webhook, API-key, and
  paste-your-own-credentials flows, whichever each platform actually uses.
- A REST API and a 3-tool MCP server, so both a script and an AI agent can
  drive it the same way.
- Single-operator by design: one API key, no login screen, no multi-tenant
  concept. Deploy it, set a key, use it.

## What this is NOT

- **No revenue attribution.** This repo does not track clicks, match sales,
  or tell you which post earned anything. That's the hard, hosted part —
  seenpaid.com — and it's deliberately not in here.
- **No multi-user accounts, teams, or roles.** One instance, one operator.
  If you need that, you're looking for the cloud product.
- **No billing, plans, or usage limits.** There's nothing to meter — this
  is software you run, not a subscription.

If what you actually want is "which post made money," this repo alone
can't answer that — connect your instance's data to seenpaid.com, or read
`SELF_HOST.md` for the honest tradeoffs before you invest time self-hosting
for that reason.

## Quickstart

```bash
git clone <this-repo>
cd seenpaid
cp .env.example .env
# fill in API_KEY and TOKEN_ENCRYPTION_KEY (openssl rand -hex 32 for each)
docker compose up -d
docker compose exec api npm run db:migrate
```

The API is now listening on `http://localhost:3001`. Full walkthrough,
including connecting a platform and your agent, in `SELF_HOST.md`.

## The 3 MCP tools

Point an MCP-capable agent at `POST /mcp` (Bearer `API_KEY`) and it gets:

| Tool | What it does |
|---|---|
| `list_accounts` | Lists connected platform accounts — id, platform, handle, status |
| `list_posts` | Lists recent posts with status, schedule time, and target platforms |
| `schedule_post` | Schedules or immediately publishes a post to one, several, or all connected accounts |

That's the whole surface. There's no `get_analytics` or `get_top_posts`
here — those exist only on the hosted seenpaid.com MCP server, because
answering them requires the closed-source attribution engine this repo
doesn't include.

See `mcp-connector/README.md` for a copy-pasteable client config.

## Supported platforms

| Platform | Connect method |
|---|---|
| X (Twitter) | Bring-your-own OAuth 1.0a app keys |
| Bluesky | App password |
| LinkedIn | OAuth |
| Instagram | OAuth (Meta) |
| Facebook | OAuth (Meta) |
| TikTok | OAuth |
| Discord | Webhook URL |
| Telegram | Bot token + channel |
| Mastodon | OAuth |
| Nostr | Private key (nsec/hex) |
| Dev.to | API key |
| Hashnode | Personal access token |
| Medium | Integration token |
| Reddit | OAuth |
| Threads | OAuth |
| Tumblr | OAuth |
| Pinterest | OAuth |
| VK | OAuth |
| Slack | Incoming webhook URL |
| WordPress | Application password |
| Ghost | Admin API key |
| Lemmy | Instance login |
| Generic webhook | URL + optional signing secret |
| Micro.blog | App token |
| Matrix | Homeserver + access token + room |

Each adapter lives in `src/platforms/`. Only platforms you configure
credentials for are usable — everything else fails cleanly with a clear
error rather than blocking the rest of the app. Full env var list per
platform in `SELF_HOST.md`.

## Architecture

```
src/
  platforms/        25 adapters + registry — one publish()/OAuth interface
  domain/features/
    posts/          Create/list/cancel a post; fans out to per-platform jobs
    accounts/        Connect/list/disconnect a platform account
    media/           Presigned upload + optional free AI image generation
  jobs/              BullMQ queue + worker: the actual publish pipeline
  entry-points/
    api/             REST API (Express)
    mcp/             The 3-tool MCP server
  auth/              Single-operator API-key auth (see below)
  data-access/       Drizzle ORM schema, repositories, migrations
```

## Auth model

This is intentionally **not** the multi-tenant JWT/RBAC system a SaaS
product needs. Self-hosting means you're the only user, so auth here is one
shared secret: set `API_KEY` in `.env`, send it as `Authorization: Bearer
<key>` (or `X-Api-Key: <key>`) on every request. No signup, no login UI, no
sessions, no password hashing. This mirrors how most single-operator
self-hosted tools handle auth — one secret, checked on every request,
nothing more to reason about.

If you need multiple users or role-based access on one instance (e.g. an
agency running this for several clients), that's a deliberate scope cut —
see `CONTRIBUTING.md` for how to propose it.

## License

The scheduler core (everything except `mcp-connector/`) is licensed
**AGPL-3.0** — see `LICENSE`. The short version: you can self-host, modify,
and redistribute freely, but if you run a modified version as a network
service for others, you must offer them the modified source too. This
exists to keep the project from being cloned into a closed-source competing
service without the changes flowing back.

`mcp-connector/` (just client-side config for connecting an agent) is
**MIT** — see `mcp-connector/LICENSE` — so it's freely copyable into agent
directories and other tooling without license friction.

## Contributing

See `CONTRIBUTING.md` before opening a PR — it sets expectations on scope
and response time.
