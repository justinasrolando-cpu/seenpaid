# Contributing

Thanks for looking at this. A couple of things worth knowing before you
open an issue or a PR.

## This is maintained, not co-developed

This repo is maintained by its author alongside a separate paid product. It
is not a community-governed project with a core team reviewing PRs on a
schedule — issues and PRs are read, but response time will vary and isn't
promised. If you need something fixed on a timeline, forking is always an
option (that's what the license is for).

## What's in scope

- Platform adapter bugs and new platform adapters (`src/platforms/`) —
  these are the most welcome contributions. One adapter, one file,
  implementing the `PlatformAdapter` interface in `src/platforms/types.ts`.
- Bugs in the publish pipeline (`src/jobs/`), the posts/accounts/media
  domain logic, the REST API, or the MCP server.
- Documentation fixes.

## What's out of scope

- Revenue attribution, analytics, or anything that would require this repo
  to talk to Stripe or track clicks. That's a deliberate, permanent scope
  cut — see the README's "what this is NOT" section. PRs adding it will be
  closed, not because the idea is bad but because it's the entire reason a
  paid hosted product exists alongside this repo.
- Multi-user auth / RBAC / teams. Single-operator is a deliberate design
  choice (see README → "Auth model"), not an oversight. If you have a real
  need for multi-tenant self-hosting (e.g. running this for several
  clients), open an issue to discuss before sending a large PR — it's a
  meaningful architecture change, not a quick patch.

## Before you open a PR

- Run `npm run typecheck`, `npm run build`, and `npm test` locally — there's
  no CI gate yet, so nothing broken gets caught automatically.
- Test coverage is intentionally thin right now (the trickiest logic only:
  OAuth 1.0a signing correctness, tenant-scoped media/post validation, and
  the publish-status rollup race). Adding coverage for a platform adapter
  you're touching is welcome but not required.
- Keep platform adapter PRs to one platform per PR — easier to review, easier
  to revert if a platform's API changes underneath it later.
- If you're adding a new platform adapter, add it to the `PLATFORMS` list in
  `src/domain/features/posts/dto.ts`, `src/entry-points/mcp/build-server.ts`,
  and the schema's `platformEnum` (`src/data-access/schema/index.ts`, then
  `npm run db:generate` for the migration) — all three need to agree.

## Reporting a security issue

See `SECURITY.md`.
