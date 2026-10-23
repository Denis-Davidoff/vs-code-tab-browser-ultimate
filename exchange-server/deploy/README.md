# aibrowser.tools on Hetzner

Target: `deploy@178.104.192.91`, ARM64, existing PostgreSQL 17 and Caddy.
Cloudflare proxies the apex and `www` over IPv4 and IPv6. TLS mode is Full
(strict), with global Authenticated Origin Pulls enabled. The origin certificate
covers `aibrowser.tools` and `*.aibrowser.tools`; its private key stays on the server.

## Install

Review `install-hetzner.sh`. Place the source archive (`source.tgz`), origin
certificate (`origin.pem`), private key (`origin.key`) and installer under
`/home/deploy/exchange-staging`. The archive contains the repository's root
package files, `tsconfig.base.json`, `src`, `preview-src`, `media`,
`chrome-extension/sidepanel.css` and `exchange-server`, excluding secrets,
dependencies and generated output. Optionally supply `images.tar.gz`, made with
`docker save exchange-server-api:local exchange-server-web:local | gzip`, to
avoid building on the production server.

From the administrator's SSH terminal:

```sh
sudo bash /home/deploy/exchange-staging/install-hetzner.sh
```

The installer creates two login roles and schema `exchange` in the **existing
database `ovla`**. `exchange_owner` owns only the Exchange schema and performs
migrations; `exchange_app` has data access to that schema. Their database-local
`search_path` is `exchange`, without `public`. They have no CREATE privilege on
the database. The API's unqualified Drizzle tables resolve using this search
path. `DATABASE_SCHEMA=exchange` makes the migration command rewrite historical
foreign keys into that schema and keep its journal there. It runs migrations in
a transaction with an advisory lock. Leaving this variable unset retains the
existing local `public`/`drizzle` behavior. Do not use `db:push` on this deployment.

Credentials are generated on the server and stored with mode 600 in
`/etc/komodo/stacks/exchange-server/.env`. Containers use the PostgreSQL Unix
socket; no new PostgreSQL TCP exposure is needed. New pg_hba rules apply only to
the two new roles in database `ovla`, followed by a configuration reload.

The Compose project is `exchange-server`. API and web listen on host loopback
ports **3101** and **3100**. The migration service must succeed before the API
starts. Containers run as the image's unprivileged `node` user with capabilities
removed. The web image has the internal API proxy destination built in.

The installer validates a candidate Caddy configuration, backs up the original,
and reloads Caddy after the app health checks pass. `www` redirects to the apex;
`/api/*` and `/ws/*` go directly to NestJS. Existing OVLA routes are preserved.
If the Caddy reload fails, the old configuration is restored.

## Operations

```sh
sudo docker compose --project-directory /etc/komodo/stacks/exchange-server ps
sudo docker compose --project-directory /etc/komodo/stacks/exchange-server logs --tail 100 api web migrate
curl --fail https://aibrowser.tools/api/health
```

The Compose files are placed under Komodo's stack directory, but **placing files
there does not register a stack in the Komodo UI**. Add/import a stack named
`exchange-server` on `hetzner-main`, using the existing server files in
`/etc/komodo/stacks/exchange-server`, file `compose.yaml`. Ignore the completed
`migrate` service for health reporting. Preserve the generated `.env`; do not
overwrite it with an empty Komodo environment. The source build context is
`/opt/exchange-server`.

Exchange data is part of the existing database `ovla`, so full database dumps
include it. Check that backup jobs do not filter to schema `public`.
Google OAuth is optional and not configured by this installer. Email delivery,
verification and password recovery remain application-level follow-up work.
