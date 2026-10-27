# Security journal and optional modules

## Public base server

Accounts, workspace connections, chat and browser relay work without plugins.
There are no plan limits on saved workspaces, online computers or traffic.
Authentication, authorization and transport safety limits always apply.

The base includes `/security` (also in the account menu), a persistent security
journal and connection history. Apply `npm run db:migrate` before starting the
updated API. No migrations are applied to the base schema at API startup.

Recorded metadata includes successful authentication-session creation, sign-out,
failed auth requests, rejected socket handshakes, workspace creation/deletion/key
rotation, chat/media connections, browser watch start/stop, IP address, immediate
network peer, user agent, timestamps, connection duration and close code. Auth
requests that fail before identifying an account remain anonymous and are visible
only in the administrator journal. A new-IP event is a signal, not proof of abuse.
Connection duration measures a live transport connection, not continuous human
attention or the lifetime of an account cookie. Chat and media are separate
channels. Browser-view events identify the workspace, not page URLs or contents.

Passwords, keys, cookies, tokens, chat content and screen frames are never written
to the security journal. Users see only their own account's events. Operators
can put account IDs in `SECURITY_ADMIN_IDS` to enable an explicitly selected
server-wide view, including anonymous failures. The alert panel groups five or
more denied requests by IP in a rolling 15-minute window. This is monitoring,
not an intrusion detection or automatic banning system.

`AUDIT_RETENTION_DAYS` defaults to 90 (1–3650). Old events and completed
connections are pruned at startup and hourly. Operators should include the
journal's personal metadata in their retention/privacy policy and backups.
Failed journal writes are reported to stderr without sensitive error details;
monitor those errors. Opening a tracked connection fails if its history cannot
be persisted. HTTP denied-request events are best effort.

Forwarded IP headers are ignored by default. Set `AUDIT_TRUSTED_PROXIES` to exact
socket peer IPs **only when those proxies overwrite `X-Forwarded-For` with a
verified client address**. Do not enable this just because a request came from
loopback: an unsanitized frontend rewrite can carry forged client headers.
The direct peer is preserved alongside the interpreted IP. User-agent strings
are untrusted descriptions, not proof of a device's identity.

The current relay supports one API process per database schema. A database
advisory lock prevents a second process from falsely closing another process's
history. Live connections checkpoint every 30 seconds. After a crash, remaining
open records are marked `server_restart`, with approximate duration ending at
the last checkpoint. Normal disconnect durations are measured by PostgreSQL.

## Private modules

`private-plugins/` is ignored by Git. Keep a separate private backup until these
modules move into their own repositories. The public server must build and run
without this directory. Each module has its own package.json and exports
`apiVersion = 1` and `register(context)` from `index.mjs`.

Enable explicitly with `EXCHANGE_PLUGINS=sessions,commercial` in `.env`. Empty
means no modules. A missing, invalid or incompatible enabled module prevents
startup; it never silently switches the service into an unrestricted mode.
Modules run as trusted server code, not in a sandbox. Restart to change modules.

The versioned context supplies the PostgreSQL pool, security journal, a router
mounted at `/api/plugins`, an authenticated request middleware, and policy hooks
for agent admission, viewer admission and outgoing media accounting. Mutations
inherit the core Origin check. Plugins own their tables and perform idempotent
initialization on registration. Browser UI discovers installed modules through
`/api/security/capabilities`; private business logic is not bundled into the site.

### sessions

Adds active-viewer listing, individual/all-viewer disconnection and authenticated-device
revocation. Each browser tab/workspace shares an opaque viewer ID between chat
and media. Disconnecting a viewer persists a revocation for that sign-in,
workspace and viewer ID and closes both channels. Other tabs stay connected.
Reloading the disconnected workspace offers an explicit reconnect action.
This is a soft disconnect, not a ban on the account; a deliberately opened new
tab is another authorized viewer. Older clients without a viewer ID are grouped
as `legacy` within their sign-in and workspace.

For a lost/untrusted device, revoke its sign-in instead: its authentication
session is deleted and all its viewer connections are closed. The old cookie
cannot reconnect. A fresh sign-in is required. Both kinds of action are logged.
The module's table is removed with the corresponding authentication session.

### commercial (no payments)

Adds manual entitlements and policies. Default trial is 14 days from account
creation, one online computer and 2 GB. Personal: 2 computers / 5 GB; Pro:
5 / 30 GB; Ultra: 25 / 200 GB. Prices are informational configuration only.
No checkout, payment provider, automatic renewal or customer-facing grant API
exists. An operator explicitly assigns or renews a period using the local CLI:

```sh
cd exchange-server
node --env-file=.env private-plugins/commercial/manage.mjs plan USER_ID pro
node --env-file=.env private-plugins/commercial/manage.mjs traffic USER_ID 5
```

A grant starts one calendar month (trial: 14 days). Renewal resets the included
usage and preserves remaining additional traffic; operator grants are logged.
This intentionally requires operator action until a payment system is added.

Updated extensions send a per-server hash of VS Code's machine ID. Workspaces
sharing that identifier consume one device place. Legacy agents count each
workspace separately. This is a client-reported machine identity, not hardware
attestation: it prevents accidental double counting, not deliberate modified-
client evasion. Device admission uses serialized DB transactions and renewable
leases. Places may take up to 70 seconds to free after disconnect; leases refresh
every 15 seconds. There is no separate guaranteed bandwidth or speed tier yet.

Traffic is shared across viewers/workspaces of the account. The server charges
serialized outgoing frame/video payload bytes and all opaque encrypted media-channel messages (including
base64/encryption overhead), not raw codec bytes or TCP/TLS overhead. Chat and plaintext state/control packets are not charged; opaque encrypted media
messages are counted conservatively because the server cannot inspect their contents. Both JPEG and H.264 paths are covered.
Hidden/non-watching viewers do not receive encrypted frames either. Atomic
updates prevent simultaneous viewers overspending the allowance. Included bytes
are consumed first; purchased bytes carry over to a manually renewed period.
If a send fails after accounting, its reserved bytes are not refunded. Quota
exhaustion closes the media viewer without revoking its sign-in or chat. A
periodic expiry check closes active connections after subscription expiry.

## Verification

`npm test`, `npm run typecheck`, and `npm run build` work without private plugins.
Integration tests need an **isolated** PostgreSQL database whose name contains
`test`. They migrate it and create disposable test users; never point them at
production. Full tests require the ignored private module directory:

```sh
TEST_DATABASE_URL=postgresql://USER:PASS@localhost:55432/exchange_test npm run test:integration
TEST_DATABASE_URL=postgresql://USER:PASS@localhost:55432/exchange_test npm run test:full
```

Both configurations use the same compiled core/site; private modules load at
runtime. Full tests exercise real authentication, tenant isolation, viewer
revocation/reconnection, login revocation, device grouping/limits, media-byte
accounting and quota exhaustion while chat stays available.
