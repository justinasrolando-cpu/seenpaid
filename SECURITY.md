# Security Policy

## Reporting a vulnerability

Please don't open a public issue for a security vulnerability. Reach out
privately first — check the repo's profile/README for a current contact —
so it can be fixed before it's public knowledge.

## Scope notes for self-hosters

- This is single-operator software: one API key, no login system, no
  multi-user isolation. Treat `API_KEY` and `TOKEN_ENCRYPTION_KEY` (in your
  `.env`) like passwords — anyone with `API_KEY` has full control of your
  instance, and anyone with `TOKEN_ENCRYPTION_KEY` can decrypt every
  connected platform's stored credentials.
- This repo does not include the hosted cloud product's revenue attribution
  or Stripe integration — there's nothing payment-related in this codebase
  to report a vulnerability against.
- Platform OAuth credentials (client IDs/secrets) you configure are yours —
  losing your `.env` means rotating those with each platform, not just
  seenpaid.
