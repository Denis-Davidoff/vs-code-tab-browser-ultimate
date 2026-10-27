# Exchange Server

A separate application that connects a website to the AI Browser chat in VS Code over an outgoing WebSocket. Next.js serves the dashboard and the workspace screen; NestJS handles authentication, PostgreSQL and command routing. The extension opens no inbound ports.

## License

[Elastic License 2.0](LICENSE) (ELv2). You may run and modify the server for
personal use or internal company use for free. Offering its substantial
functionality to third parties as a hosted or managed service is prohibited
without separate permission, whether access is paid or free, including for
modified versions. Source redistribution remains permitted under ELv2.
See [LICENSING.md](LICENSING.md) for scope, third-party exceptions and existing
MIT grants.

## Security and modules

The public base includes a persistent [security journal and connection history](PLUGINS.md),
accessible through **Account → Access activity**. Optional local modules add viewer/session
management and commercial quotas without payments. The public base has no tariff limits.
See [PLUGINS.md](PLUGINS.md) for migrations, trusted proxy setup, retention, module activation
and verification of the base and full configurations.

## What is built

- Sign-up and sign-in with email and password through Better Auth; Google OAuth once credentials are configured.
- Connection points: created with a key shown once, rotated, and revoked by deleting the point.
- PostgreSQL stores the SHA-256 hash of a random 256-bit key; the key itself lives in VS Code SecretStorage.
- Checks on the point's owner, website session and client key; bounded chat and browser commands.
- Shared VS Code chat renderer, styles and theme, conversation dropdown, tools, model selection and approval cards. Desktop panels resize and expand to full width; mobile screens switch with a horizontal swipe.
- Connection status and reconnection for both the website and the extension. Commands sent while VS Code is offline are refused, never retried automatically.

The browser panel streams an explicitly selected VS Code or connected Chrome tab. It supports clicks, wheel scrolling, mobile vertical swipe scrolling, keyboard input, paste, a text entry field for mobile/IME, navigation, back/forward and reload. It shows the computer's existing page and login session, including localhost pages. It does not expose the local dev server as a separate public site; a localhost HTTP/WebSocket tunnel remains a separate future feature.

Touch scrolling streams during the gesture. Wheel and trackpad events are merged with one scroll command outstanding, preventing an event burst from filling the remote command queue. Browser errors overlay the preview without resizing it.

The extension opens a second outgoing socket (`/ws/stream-agent`); the website uses `/ws/stream-browser` with its existing owner session. CDP screencast JPEG frames are limited to roughly 10 fps and 1440×1000; periodic screenshots are the fallback when screencast is unavailable or idle. Frames use bounded JSON/base64 messages on the separate media socket. Slow consumers drop frames, images are not retained by the relay, and capture pauses when no visible browser viewers remain. Returning to the browser screen resumes the selected tab. Multiple viewers of the same connection share the selected tab. No audio, file upload/download forwarding, pointer dragging or clipboard synchronization is implemented.

Browser actions in the web chat (page, screenshot, element and annotations) target the tab explicitly selected in the website Browser panel. They never fall back to the currently focused VS Code tab. Annotation changes go to the originating web conversation; screenshot attachments carry the image itself. Opening a normal HTTP/HTTPS reply link navigates the selected remote tab, while an explicitly external link opens on the viewing device. Local editor selection and unsupported host-only attachments are refused rather than attached from the wrong window.

Install/reload the updated extension, reconnect its server connection, open a browser tab on the computer, and select it in the website's Browser dropdown. No tab is streamed before selection. Closed tabs are cleared rather than replaced automatically.

**A message sent from the website runs exactly as one typed in the editor.** Every category the chat's approval menu has on Auto (Terminal, files, the browser) is answered yes without a card, so a website session can run commands in the workspace. Connect only a chat whose approval settings you are comfortable having driven remotely.

## Running locally

Requires Node.js 24+, npm, and Docker Compose or a PostgreSQL of your own. Run `npm ci` at the repository root as well: the website bundles the shared chat renderer and codicon assets from the extension.

```sh
cd exchange-server
npm ci
npm run setup
docker compose up -d --wait
npm run db:migrate
npm run dev
```

`setup` writes `.env` with a fresh random secret and never changes an existing file. Website: <http://localhost:3000>, API: `127.0.0.1:3001`. Next proxies `/api/*` and `/ws/*` to Nest, including the media channel. Open the website through `localhost` so its origin matches `WEB_ORIGIN`.

For your own PostgreSQL, set `DATABASE_URL` in `.env` and skip Docker. The password in `compose.yaml` is for local development only, and the database port is bound to loopback. Compose starts only the database.

## Connecting VS Code

1. Create an account and a point on the website. Save the key shown, open «Параметры подключения» (connection parameters) and copy the ID.
2. Build the updated extension from the repository root with `npm run compile`, then run it in the Extension Development Host or install the built version. An older installed extension does not have the new commands.
3. Open the AI Browser chat and pick an available agent and model. The workspace must be trusted.
4. Run **AI Browser: Connect Chat to Exchange**. Choose the chat, enter the server address shown on the website (normally `http://localhost:3000`), the point ID and the key.
5. On the website, press «Открыть рабочее пространство» (open workspace).

To disconnect, run **AI Browser: Disconnect Chat from Exchange** or click Exchange in the status bar. To revoke a client's access, rotate the key or delete the point on the website.

Plaintext is allowed for loopback only; a remote server requires HTTPS/WSS. The address and ID are kept in workspaceState, the key in SecretStorage. After a window reload the saved connection is restored automatically when its original chat panel opens; network drops reconnect automatically as well. Disconnect preserves the saved address, ID and key and disables automatic restoration until Save & connect is pressed again. Settings display HTTP/HTTPS addresses; WS/WSS conversion is internal. Existing saved WS/WSS addresses remain compatible. A rotated key has to be entered again.

The chat is fixed when connecting. If it is closed, the source may move to another open chat of the same window. Arbitrary editor commands cannot be sent from the website.

## Google OAuth and email

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env` and restart the API. Register this redirect URI in Google Cloud Console:

```text
http://localhost:3000/api/auth/callback/google
```

In production use the public HTTPS domain. Without credentials email and password still work; the Google button returns a configuration error. Email verification and password recovery need a mail provider and are not connected yet.

## Protocol v1

The extension client opens `/ws/agent` and sends first:

```json
{ "type": "auth", "version": 1, "pointId": "UUID", "key": "exch_..." }
```

The website opens `/ws/browser` with its session cookie and an allowed Origin. The first message carries `type`, `version` and `pointId`, with no key. The server answers `ready`. No other message may be sent before authentication succeeds.

The agent publishes `chat.snapshot` with `chatId`, `running` and `messages` (`id`, `role`, `text`). The website sends `chat.send` (`id`: a UUID, `chatId`, `text`) or `chat.stop` (`id`, `chatId`). The agent answers `command.result` with the same `id`, `ok` and an optional `error`.

`ok: true` means the extension accepted the command, not that the AI has finished replying. The server waits 30 seconds for the acknowledgement. A timeout means the outcome is unknown; check the chat before retrying. The extension remembers the last 256 IDs in memory, so a redelivered command does not run twice. There is no exactly-once guarantee across a process restart.

Close codes on `/ws/agent`: **4001** — the key was refused, the point revoked or deleted, or another client took the connection; the extension stops and asks to connect again. **4400** — a message the relay could not accept; **1013** — too many queued messages; **1011** — authentication could not be checked (the database or session store failed); all three are transient and the extension reconnects. `/ws/browser` uses 1008 for every refusal. The chat relay accepts frames up to 12 MiB, including encrypted envelopes. The media channel accepts frames up to 3 MB. Application commands retain their own bounded schemas.

The current snapshot is kept in the relay's memory and dropped when the agent disconnects. A long history is sent from its end, bounded in size. VS Code remains the source of the history. Without a workspace password, TLS protects the connection and the relay can read content. With a workspace password, chat, commands, attachments, tab URLs and browser frames are encrypted before they reach the relay; encrypted snapshots are not cached by the relay.

A demo client answers with fixed text and runs no AI:

```sh
EXCHANGE_POINT_ID='<id>' EXCHANGE_KEY='<key>' node scripts/demo-agent.mjs
```

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run format:check
# Needs the web app and API running, and a separate test database:
npm run test:smoke
```

The smoke test checks sign-up, sessions, user isolation, Origin, key secrecy, a wrong key, offline commands, snapshot and command relay, and key rotation. It creates two accounts that stay in the database, so use a test database. The point is deleted. Addresses are set with `EXCHANGE_TEST_URL` and `EXCHANGE_TEST_WS_URL`.

From the repository root: `node --test src/chat/exchangeProtocol.test.ts`, `npm run typecheck-ext`, `npm run typecheck-tests`, `npm run check-manifest`.

## Layout

```text
apps/api/              NestJS (Express adapter), Better Auth, Drizzle, ws
apps/api/drizzle/      SQL migration and migration journal
apps/web/              Next.js App Router, React
packages/protocol/     Protocol version and network message schemas
scripts/               Environment setup, smoke test and demo agent
../src/chat/exchange*  The extension client and the chat state projection
```

## Deployment

After `npm run build`, two Node processes run:

```sh
npm run start -w @exchange/api
npm run start -w @exchange/web
```

An HTTPS reverse proxy sends `/ws/*` to Nest with WebSocket Upgrade, `/api/*` to Nest, and the rest to Next. `BETTER_AUTH_URL` and `WEB_ORIGIN` must equal the site's public origin. `API_INTERNAL_URL` is Nest's internal address for Next. For a separate WebSocket domain, set `NEXT_PUBLIC_EXCHANGE_WS_URL` when building the frontend. In a container the API needs `HOST=0.0.0.0`; by default it listens on loopback.

The relay is designed for one process. Several replicas would need shared presence/pub-sub and connection routing. Before a public launch it still needs mail integration, limits on sign-ups and connections, an audit log, operational logging and deployment configuration.

## Account and workspace security

The account menu contains profile settings and optional TOTP two-factor authentication for email/password sign-in. Scan the locally generated QR code with an authenticator app, save the one-time recovery codes, and verify a code to finish enrollment. Google sign-in follows Google account security. Apply `npm run db:migrate` before starting this version.

In the VS Code chat, open Settings → Server connection and set an optional **Workspace password** (at least 12 characters), then Save & connect. Leave the field blank to retain an existing password; use Remove workspace password to disable it. The password is kept in VS Code SecretStorage. Website users are prompted before loading the chat and browser; the derived key stays in memory for that tab and is discarded on reload. Keep the password separately: it cannot be recovered from the server.

Content uses AES-256-GCM with a password-derived key (PBKDF2-SHA-256, 600,000 iterations, random salt). Authenticated data binds packets to the workspace, channel, direction, connection epoch and sequence. A challenge/response confirms a live agent before rendering protected content; repeated sequences are ignored. The relay sees session/key authentication, connection presence and stream visibility metadata, and transports ciphertext. HTTPS/WSS is still required for deployment; browser cryptography is available on HTTPS or localhost. This does not encrypt unrelated traffic from VS Code to model providers or websites.

A plugin restart or password change establishes a new encryption epoch; reload and unlock any open website workspace. Use an HTTPS address when accessing a protected workspace from a phone or another computer.

With the API, web app and local database running, `npm run test:security` checks enrollment, login challenges, recovery-code reuse rejection, disabling 2FA, encrypted chat/commands/media, and plaintext downgrade rejection. It creates a temporary account and removes it in cleanup. Root `src/core/exchangeCrypto.test.ts` also checks wrong passwords, ciphertext tampering, reflection and replay rejection.
