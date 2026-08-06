# Self-hosting guide

Step-by-step: get seenpaid running, connect a platform, schedule a
post, and connect an AI agent over MCP.

## 1. Prerequisites

- Docker + Docker Compose (the one-command path), **or** Node.js 20+,
  Postgres 16+, and Redis 7+ if you'd rather run it bare-metal.
- An S3-compatible object store for media uploads. `docker-compose.yml`
  ships a local [MinIO](https://min.io/) container as the zero-config
  default — nothing to sign up for. Swap in Cloudflare R2, AWS S3, or
  Backblaze B2 for a real deployment (see `.env.example`).

## 2. Configure

```bash
cp .env.example .env
```

Generate the two required secrets:

```bash
openssl rand -hex 32   # → API_KEY
openssl rand -hex 32   # → TOKEN_ENCRYPTION_KEY
```

Set both in `.env`. `API_KEY` is the one credential that authenticates
every request to this instance — the REST API and the MCP endpoint both
check it, there's no separate login. `TOKEN_ENCRYPTION_KEY` encrypts every
connected account's OAuth token at rest; losing it means reconnecting every
account, so keep a copy somewhere safe (a password manager, not just the
`.env` file on one disk).

Leave every platform's `*_CLIENT_ID`/`*_CLIENT_SECRET` blank for now — you
only need them for the specific platforms you actually connect (step 4).

## 3. Run it

```bash
docker compose up -d
docker compose exec api npm run db:migrate
```

That starts Postgres, Redis, MinIO, and the API (which also runs the
publish worker in-process by default). The migration step only needs to run
once, and again any time you pull an update that changes the schema —
**Postgres does not migrate itself.**

Confirm it's up:

```bash
curl http://localhost:3001/health/deep
```

You should see `"status":"ok"` with `db`, `redis`, and `worker` all
healthy. `worker.status` will read `"unknown"` until the worker's first
30-second heartbeat lands — that's normal on a fresh boot.

### Running without Docker

```bash
npm install
npm run build
npm run db:migrate:prod
npm start        # API + in-process worker
# or, in a second process:
RUN_INLINE_WORKER=false npm start   # API only
npm run worker:prod                 # separate worker process
```

## 4. Connect a platform

Every platform connects one of three ways:

**Paste a credential (no app registration needed)** — Bluesky (app
password), Discord/Slack (webhook URL), Telegram (bot token), Nostr
(private key), Dev.to/Medium/Micro.blog (token), Hashnode (personal access
token), WordPress (application password), Ghost (admin key), Lemmy
(instance login), generic Webhook (any HTTPS URL). No env vars required —
call the matching `/api/accounts/<platform>/connect` endpoint with the
credential in the body.

**X (bring your own app)** — X requires OAuth 1.0a app keys per account
rather than a shared app. Create a developer app at
[developer.x.com](https://developer.x.com), then `POST
/api/accounts/x/byok` with your app's consumer key/secret and access
token/secret.

**OAuth (needs a developer app registered once, shared across accounts)** —
LinkedIn, Instagram, Facebook, TikTok, Mastodon, Reddit, Threads, Tumblr,
Pinterest, VK. Register a developer app on the platform, set its client
id/secret in `.env`, restart, then:

```
GET /api/accounts/:platform/authorize-url?redirectUri=<your-callback-url>
```

redirect the user (you) through the returned `url`, and complete with:

```
POST /api/accounts/callback
{ "platform": "...", "code": "...", "redirectUri": "...", "state": "..." }
```

Developer console links: [LinkedIn](https://www.linkedin.com/developers/apps),
[Meta](https://developers.facebook.com/apps) (covers Facebook + Instagram),
[TikTok](https://developers.tiktok.com/apps),
[Mastodon](https://docs.joinmastodon.org/client/token/) (register on your
instance directly — also set `MASTODON_INSTANCE_URL`),
[Reddit](https://www.reddit.com/prefs/apps),
[Threads](https://developers.facebook.com/docs/threads),
[Tumblr](https://www.tumblr.com/oauth/apps),
[Pinterest](https://developers.pinterest.com/apps),
[VK](https://vk.com/apps?act=manage).

Every env var these need is listed with its exact name in `.env.example`.

## 5. Schedule a post

```bash
curl -X POST http://localhost:3001/api/posts \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "caption": "First post from seenpaid",
    "socialAccountIds": ["<account-id-from-step-4>"]
  }'
```

Omit `scheduledFor` to publish immediately, or set it to a future ISO-8601
timestamp to queue it. `GET /api/posts` lists everything with per-platform
status; a failed target carries an `errorMessage` explaining why.

## 6. Connect your AI agent

Point any MCP-capable client at:

```
POST http://localhost:3001/mcp
Authorization: Bearer <API_KEY>
```

See `mcp-connector/README.md` for a ready-to-paste client config. Once
connected, the agent has `list_accounts`, `list_posts`, and `schedule_post`
— it can check what's connected, review recent posts, and schedule new ones
in the same conversation.

## Media uploads

Posts can carry images/video. The flow is: `POST /api/media/presign` (get a
short-lived upload URL), `PUT` your file bytes directly to that URL, then
`POST /api/media` with the returned key to register it — then pass its id
in a post's `mediaIds`. There's also `POST /api/media/generate` for free
AI image generation from a text prompt (no API key needed, uses a public
keyless image endpoint) if you'd rather not source an image yourself.

## Production notes

- Set `NODE_ENV=production` — this activates the boot-time check that
  refuses to start without `API_KEY` and `TOKEN_ENCRYPTION_KEY` set, instead
  of silently falling back to insecure dev defaults.
- Put this behind HTTPS (a reverse proxy like Caddy or nginx, or your
  platform's built-in TLS termination) — the API key travels in a bearer
  header and deserves an encrypted transport.
- Set `ALLOWED_ORIGINS` if you're calling the API from a browser-based
  client; leave it unset if you only call it server-to-server or over MCP.
- Back up `TOKEN_ENCRYPTION_KEY` and your Postgres data — losing the key
  means reconnecting every platform account, losing the DB means losing
  post history and connections both.
