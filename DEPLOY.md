# Deploying Planfully to Cloudflare

Production: Worker `planfully` on the Workers free plan, serving the built web app as static assets (SPA fallback) at https://planfully.us, plus D1 (`planfully`), R2 (`planfully-blobs`) and Email Routing on `planfully.us`.

Prerequisites: `pnpm install`, `wrangler login` (OAuth; `wrangler whoami` should work), and the domain's DNS on Cloudflare with Email Routing enabled (MX `route1-3.mx.cloudflare.net`).

## One-time setup

Run wrangler from `packages/worker`.

1. Create D1: `wrangler d1 create planfully`. Put the printed `database_id` in `packages/worker/wrangler.jsonc` (`d1_databases[0].database_id`).
2. Create R2: `wrangler r2 bucket create planfully-blobs`.
3. In `wrangler.jsonc` set `vars.TRIP_DOMAIN` (`planfully.us`) and `routes` (`[{ "pattern": "planfully.us", "custom_domain": true }]`). The custom domain creates the DNS record and certificate on the first deploy. The Google browser key's referrer list must include `https://planfully.us/*`.
4. Create `packages/web/.env.local` containing `VITE_GOOGLE_MAPS_KEY=...` (gitignored; baked into the web bundle at build time).
5. First deploy (the Worker must exist before secrets can be set): `pnpm run deploy` from the repo root.
6. Set secrets (values come in on stdin so they never reach shell history or logs):
   ```bash
   cd packages/worker
   printf %s "$VALUE" | wrangler secret put ANTHROPIC_API_KEY
   printf %s "$VALUE" | wrangler secret put GOOGLE_MAPS_SERVER_KEY
   S=$(openssl rand -base64 32)
   security add-generic-password -U -a planfully -s planfully-admin-secret -w "$S"   # macOS keychain
   printf %s "$S" | wrangler secret put ADMIN_SECRET; unset S
   ```
   Read the admin secret later with `security find-generic-password -s planfully-admin-secret -w`.
7. Email Routing catch-all to the Worker. Done through the API using wrangler's OAuth token (it has the `email_routing` scope):
   ```bash
   T=$(wrangler auth token | tail -1)
   Z=$(curl -s -H "Authorization: Bearer $T" "https://api.cloudflare.com/client/v4/zones?name=planfully.us" | jq -r '.result[0].id')
   curl -s -X PUT -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
     "https://api.cloudflare.com/client/v4/zones/$Z/email/routing/rules/catch_all" \
     -d '{"name":"planfully catch-all","enabled":true,"matchers":[{"type":"all"}],"actions":[{"type":"worker","value":["planfully"]}]}'
   ```
   Dashboard alternative: Email -> Email Routing -> Routing rules -> Catch-all address -> Send to a Worker -> `planfully`, then enable it.

## Every deploy

```bash
pnpm run deploy
```

Note: `pnpm deploy` (without `run`) is a built-in pnpm command and does not run the script; always use `pnpm run deploy`. The script builds the web app, applies D1 migrations with `--remote`, then runs `wrangler deploy`.

## Verify

- `curl https://planfully.us/api/health` returns `{"ok":true}`; `curl https://planfully.us/` returns the app shell; deep links such as `/t/anything` also return it.
- Tables: `wrangler d1 execute DB --remote --command "select name from sqlite_master where type='table'"` lists `trips`, `records`, `d1_migrations`.
- Secrets: `wrangler secret list` shows `ADMIN_SECRET`, `ANTHROPIC_API_KEY`, `GOOGLE_MAPS_SERVER_KEY`.
- Email: run `wrangler tail` in `packages/worker`, then send a mail to any `anything@planfully.us` (a real trip address to see it ingested). The tail shows an `email` event for the Worker. Unknown recipients are dropped by the handler.

## Notes

- Free plan only: no paid features are used. The Worker never logs email or event content.
- Local dev is unaffected (`pnpm dev` uses local D1/R2 and `.dev.vars`). Worker tests override `TRIP_DOMAIN` in `packages/worker/vitest.config.ts`.
