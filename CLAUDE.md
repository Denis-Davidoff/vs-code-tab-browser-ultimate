# Tab Browser Ultimate — project context

VS Code extension: a browser tab in the editor (iframe in a webview) whose toolbar can hand the
rendered page to an assistant — a full report of a picked element, or the page's console output.

Forked from the Simple Browser extension that ships with VS Code and renamed throughout to
`tabBrowser.*` so both can be installed side by side. Not a git repository.

## Layout

| Path | Runs in | What it is |
| --- | --- | --- |
| `src/` | extension host (node) | activation, the webview panel, the local proxy, clipboard, tab icon, mcp |
| `preview-src/` | webview | toolbar, address bar, copy menu, hint bar; relays messages |
| `page-src/` | the previewed page | injected agent: picker, console capture, element report |
| `shared/` | all three | message contracts and the shapes they carry |
| `media/` | webview | `main.css`, `codicon.css`, and **generated** `index.js` / `agent.js` |
| `test/` | node | proxy tests, and a chromium-driven test of the element report |

`media/index.js` and `media/agent.js` are esbuild output — edit `preview-src/` and `page-src/`,
never the bundles.

## The three processes and why the proxy exists

A cross-origin `<iframe>` cannot be read or scripted, so nothing about the page would be
reachable from the webview. `src/browserProxy.ts` therefore serves the target page from the
webview's own origin and injects `media/agent.js` into every html document it passes through,
nested frames included. It also strips what would stop the page from rendering in a frame
(CSP, `X-Frame-Options`), rewrites `Referer`/`Origin` to the real server, and proxies
websocket upgrades.

Messages flow `page-src` → parent frames → `preview-src` → extension host. Nested frames
prefix their own `<iframe>` selector onto every event, so the webview always sees a full frame
path. Contracts live in `shared/protocol.ts` (page ↔ webview) and `shared/webviewProtocol.ts`
(webview ↔ host); both sides are typed off the same file, so a change there is a change to all
three bundles.

`tabBrowser.proxy.mode` decides when the proxy is used: `localhost` (default), `always`,
`never`. A copy command forces a reload through the proxy when the current page is not
instrumented yet.

Two things about that arrangement are easy to get wrong again:

- **Cookies are not separated by port.** Every session publishes on `127.0.0.1`, so without help
  the site on :3000 would read, overwrite and receive the cookies of the site on :5173 — the
  `HttpOnly` ones too, which a page cannot see but the browser still sends. So each session
  prefixes the names of the cookies it hands the browser (`__tb<port>_`), drops the ones that
  are not its own from every request it forwards, and restores the real names upstream.
  `page-src/cookies.ts` hides the prefix from `document.cookie`, so page scripts never see it.
- **The webview is not alone in its window.** The framed page can `postMessage` into it, so
  every message from the extension host carries the panel's token (`TabBrowserSettings.token`,
  read from the webview's own dom, which a cross origin page cannot reach) and the webview drops
  anything without it. Without that, a page could start a pick and have its own report written
  into the workspace and mentioned to Claude Code.

Reports built from page content — markup, css, console output — are fenced with a fence longer
than the longest run of backticks inside them (`fenced()` in `src/tabBrowserView.ts`), or the
page could end the block and have the rest read as markdown.

## The copy menu

A split button: its main half runs the entry used last (remembered in the webview state), the
chevron opens the menu. `CopyCommand` names the entries: six element ones — the report, the
XPath and the selector, each either to the clipboard or to Claude Code — and `console` /
`consoleClaude`. What the element entries do is a table (`elementActions` in
`src/tabBrowserView.ts`), not a switch; every entry is also a command, `tabBrowser.copyElement`
and friends. A console request carries the entry it came from, because the answer arrives
asynchronously from the page and has to know where to go.

Picking an element produces a `PickedElement`:

- selector/xpath — `page-src/selectors.ts`, built to survive a rebuild (framework-generated
  class names and ids are filtered out, `preferAttributes` win over structure).
- descriptor, html path, outer html, box, css — `page-src/elementContext.ts`, read out of the
  page's own CSSOM. Cross-origin stylesheets are unreadable by design and only counted.
- `src/tabBrowserView.ts` formats it. The default `context` format is the report in the README;
  `css`, `xpath`, `both` and `json` remain, and "Copy element XPath" always writes an XPath
  regardless of the setting.

Multi-line reports go on the clipboard as a file *and* as text (`src/clipboardFile.ts`), so a
chat attaches a document while a text field still pastes text. There is no editor API for this:
macOS goes through one `NSPasteboardItem` carrying both `public.file-url` and
`public.utf8-plain-text` (JXA via `osascript`), Windows through `Set-Clipboard -Path`. Anywhere
else — and in remote workspaces, where the clipboard belongs to another machine — it falls back
to plain text.

### Handing a report to an assistant

`src/assistants.ts` covers both, and they are not alike:

- **Claude Code** (`Anthropic.claude-code`) exports no api. The one command that does the job,
  `claude-vscode.insertAtMention`, takes no arguments and builds the mention from the **active
  editor**, so the report is written into the workspace, opened, mentioned, and its tab closed
  again — by uri, not `closeActiveEditor`, because inserting reveals the chat, which may by then
  hold the active tab. The path is relative to the workspace, hence `needsWorkspace`.
- **Codex** (`openai.chatgpt`) has `chatgpt.addFileToThread(uri)`, which attaches the file to
  the current thread and opens the sidebar itself. It stores an absolute path, so its reports go
  to the temp directory and never land in the project, and no folder has to be open.

There is no way around the file for either of them: `addFileToThread` drops anything whose
scheme is not `file` and the agent reads the path from disk later, so a virtual document buys
nothing — Codex writes its own attachments to disk the same way. Reports are swept five hours
after they were written, at activation and at most hourly from the write path (`prune()`).

Text is a different matter. An open Claude Code conversation takes only that mention, and a
prompt handed to `claude-vscode.editor.open(sessionId, prompt)` is applied only while the panel
is being created — for a session that already has one the extension answers "Session is already
open. Your prompt was not applied". So `openClaudeWithPrompt` always starts a new conversation,
and `tabBrowser.claude.pathDelivery` lets the path entries choose between the two. Codex has no
equivalent.

Both command ids are implementation details of those extensions, not contracts: `isAvailable()`
checks the extension *and* the command, and every failure falls back to the clipboard with a
notification. The copy menu is built per panel from `isInstalled()`, so entries for an assistant
that is not there never appear — and the webview drops a remembered entry that no longer exists.

## The mcp server

`src/mcpServer.ts` speaks Streamable HTTP directly — the protocol needed is a handful of
JSON-RPC methods over one POST endpoint, and an sdk with its own http stack would be more bundle
than this file. Stateless: no session id, no server push, `GET` answers 405.

It talks to `src/browserController.ts`, never to the panel, so the transport stays free of
webview details and "no panel open" / "page not instrumented" are answered in one place. A tool
call becomes a `PageRequest` (`shared/protocol.ts`) that travels host → webview → page and comes
back by `requestId` (`runPageRequest` in `src/tabBrowserView.ts`, which times out rather than
hanging and rejects everything pending when the panel closes). `page-src/pageRequests.ts` runs
it in the page's own world, so a snapshot sees the dom the framework actually rendered.

Security, all three of which matter together: loopback only, a bearer token kept in
`globalState` (never handed to the page, which is why the token can also survive restarts), and
a refusal of any request carrying an `Origin` header — a page cannot read a cross-origin answer,
but the side effect of the request alone would drive the panel.

Two clients, configured in different places: VS Code's chat through
`lm.registerMcpServerDefinitionProvider` (1.101+, reached through a cast in `src/mcpSetup.ts` so
`engines.vscode` can stay at 1.85), and Claude Code through `.mcp.json` or `claude mcp add`,
which the **Connect Claude Code to This Browser** command writes or copies.

Known edges: selectors, not snapshot-scoped element refs, so a selector can go stale between
calls; clicks are synthetic dom events, which some things (file pickers, drag) will not accept;
one window wins the preferred port, and a `.mcp.json` written from another window points
elsewhere.

## Terminal links

`src/terminalLinks.ts` registers a `TerminalLinkProvider`, which is the stable way to take over
`Cmd`/`Ctrl` + click on a url: extension providers are asked before the terminal's own url
detection. The proposed `registerExternalUriOpener` — what the built-in Simple Browser uses —
is not granted to extensions outside the editor's own bundle. `tabBrowser.terminalLinks.mode`
decides which urls are claimed, with the same `localhost` / `always` / `never` shape as
`proxy.mode`.

## The tab icon

`WebviewPanel.iconPath` only takes a local file, so `src/favicon.ts` downloads the icon, sniffs
its magic bytes (a dev server answers `/favicon.ico` with its index page often enough that the
content type cannot be trusted) and writes it to `tmpdir/tab-browser-ultimate/icons/<sha1>.<ext>`.
Naming by content is what makes the editor repaint the tab when the icon changes.

Where the icon url comes from: an instrumented page reports it itself (`page-src/pageIcon.ts`,
sent as the `icon` agent event and re-sent when the head changes), a page loaded directly has
its html read once by `discoverIconUrl`. Every navigation bumps `_iconToken` in
`src/tabBrowserView.ts` so a slow download cannot land on the wrong page.

## Conventions

- Tabs for indentation, single quotes, semicolons.
- Every file opens with a banner comment saying what it is and, where it matters, why it works
  that way. The code is MIT licensed under this project's own name; no upstream headers remain.
- User-visible strings go through `vscode.l10n.t`; manifest strings through `package.nls.json`.
- Comments explain *why* something is done, not what the line does. Keep them rare and load-bearing.
- Everything the user can see or configure is prefixed `tabBrowser`.
- The webview CSP allows scripts only by nonce and fonts only as `data:` — hence the inlined
  codicon font. No network access from the webview document itself.

## Commands

```sh
npm run build      # esbuild: extension, webview, page agent, codicon css
npm run watch
npm run typecheck  # tsc --noEmit
npm test           # pretest builds the test bundles first
npm run package    # vsce package --no-dependencies
```

`test/host.test.mjs` needs a chromium build (playwright's or a system Chrome) and skips itself
when there is none. It stubs `vscode` through `test/vscode-stub-entry.mjs`, so anything it
imports must not touch the real API at module load time.
