# Tab Browser Ultimate — project context

VS Code extension: a browser tab in the editor (iframe in a webview) whose toolbar can hand the
rendered page to an assistant — a full report of a picked element, or the page's console output.

Forked from the Simple Browser extension that ships with VS Code and renamed throughout to
`tabBrowser.*` so both can be installed side by side. Not a git repository.

## Layout

| Path | Runs in | What it is |
| --- | --- | --- |
| `src/` | extension host (node) | activation, the webview panel, the local proxy, clipboard, tab icon, mcp, the sidebar |
| `preview-src/` | webview | toolbar, address bar, copy menu, hint bar; relays messages |
| `page-src/` | the previewed page | injected agent: picker, console capture, element report |
| `shared/` | all three | message contracts and the shapes they carry |
| `media/` | webview | `main.css`, `codicon.css`, and **generated** `index.js` / `agent.js` |
| `test/` | node | proxy tests, and chromium-driven tests of the page agent and the webview |

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
  `page-src/cookies.ts` hides the prefix from `document.cookie`, so page scripts never see it —
  and puts a write through the same attribute rewriting as a `Set-Cookie` header
  (`shared/cookies.ts`, used by both), since a page setting `Domain=localhost` or `Secure` is
  describing the server it thinks it is talking to, not the origin the browser has it from, and
  a browser told that stores nothing at all.
  Which is also why a session forwards to its own server and nowhere else (`targetOf`): a
  request target is a path, and one beginning with `//` resolves to a *host*, so
  `//example.com/x` would have handed those cookies to example.com.
- **The webview is not alone in its window.** The framed page can `postMessage` into it, so
  every message from the extension host carries the panel's token (`TabBrowserSettings.token`,
  read from the webview's own dom, which a cross origin page cannot reach) and the webview drops
  anything without it. Without that, a page could start a pick and have its own report written
  into the workspace and mentioned to Claude Code.

The injected script sits in front of the page's own code — `console` is patched before any of
it runs — so nothing it does may change how that page behaves. Formatting a logged value is the
sharp edge: `%d` with a symbol, a getter that throws, a revoked proxy. `page-src/consoleCapture.ts`
therefore records inside a `try` and forwards to the real console either way; a page that logs
something unreadable gets `[could not be read]` in the copy, never an exception of ours.

Reports built from page content — markup, css, console output — are fenced with a fence longer
than the longest run of backticks inside them (`fenced()` in `src/tabBrowserView.ts`), or the
page could end the block and have the rest read as markdown.

## The sidebar

`src/sidebar.ts` is the view in the activity bar (`tabBrowser.actions`, in its own view
container, under `media/sidebar.svg` — the app icon's globe and letters in one colour, since
the editor paints a container icon through a *mask* and only its alpha is kept; that is also
why the letters have a gap knocked out of the globe behind them instead of merely sitting on
top of it). A tree and not a webview, and every row carries the id of a command the extension
already registers — the view is a second way to reach them, never a second implementation, so
the only thing written twice is the command id. `test/host.test.mjs` walks the rows after
activation and fails on one naming a command that does not exist, since clicking is the only
other way to find that out.

The tree is rebuilt whole on every change: it is a couple of dozen rows, and the things it
reports on — the panel (`TabBrowserManager.onDidChange`, which now also forwards the panel's
own `didChangeState`), the configuration, the installed assistants — change rarely. What it
cannot watch are the client configuration files, hence the refresh button.

The mcp server starts asynchronously and may not start at all, so `activate` keeps an `McpState`
(`starting` / `running` / `disabled` / `failed`, in `src/mcpCheck.ts`) and hands the view a
getter plus a `refresh()` — the same state the connect commands use to explain themselves.

**Check connection** (`checkMcp`) exists because a running server proves nothing about the
clients: each of the three is configured elsewhere, and any of them can name another window's
port. So it does both halves — one real `tools/list` over the loopback interface with the token,
and a read of `.mcp.json`, `.codex/config.toml` and `~/.codex/config.toml` — and reports them in
one dialog, with the connect command for whichever client is not pointing here.

Reading those files loosely is worse than not reading them at all: it reports a broken client as
working and hides the button that would fix it. So an entry counts only if it would actually
reach this window — the url *and* the credentials (the token is per workspace, so another
window's `.mcp.json` names the right endpoint and answers 401) *and* being switched on. For
Codex that means the `[mcp_servers.*]` tables are parsed rather than searched: a url in a
comment and an `enabled = false` entry both used to read as a working configuration. Where a
name appears in both files the project's wins, being the more specific.

`claudeClientState` and `codexClientState` are pure for that reason — they take the file's text,
so `test/host.test.mjs` covers the cases that only happen to someone else's config. The Codex
half of it lives in `src/codexToml.ts`, because the check and the setup have to agree on what a
table is: a header the setup fails to recognise (`[mcp_servers.tab-browser] # ours`) is one it
writes a second time, and a file with the same table twice does not parse at all.

Recent pages live in `workspaceState`: a dev url belongs to the project, not to the user.

## The copy menu

A split button: its main half runs the entry used last (remembered in the webview state), the
chevron opens the menu. `CopyCommand` names the entries: six element ones — the report, the
XPath and the selector, each either to the clipboard or to Claude Code — and `console` /
`consoleClaude` / `consoleCodex`. What the element entries do is a table (`elementActions` in
`src/tabBrowserView.ts`), not a switch; every entry is also a command, `tabBrowser.copyElement`
and friends. A console request carries the entry it came from, because the answer arrives
asynchronously from the page and has to know where to go.

Which of the two kinds an entry is, is `isConsoleCommand` in `shared/webviewProtocol.ts` and
nowhere else: a console entry left out of such a list does not merely stop working, it reads as
an element entry and opens the picker instead.

Picking an element produces a `PickedElement`:

- selector/xpath — `page-src/selectors.ts`, built to survive a rebuild (framework-generated
  class names and ids are filtered out, `preferAttributes` win over structure).
- descriptor, html path, outer html, box, css — `page-src/elementContext.ts`, read out of the
  page's own CSSOM. Cross-origin stylesheets are unreadable by design and only counted. Css
  nesting is walked like any other group, except that a nested rule's `selectorText` (`& > a`)
  is true of nothing on its own: `walkRules` carries the parent selector down and resolves it
  (`&` → `:is(parent)`, and a selector that never says `&` is a descendant of it), or the rules
  a page written this year actually uses would all read as unmatched. Two details of nesting
  that are easy to miss: a `&` inside a string is part of a value and not a nesting selector,
  and everything written *after* a nested rule becomes a rule of its own
  (`CSSNestedDeclarations`, no selector, no children) that belongs to the rule it sits in —
  dropped, those declarations are missing from the report and the value they set reads as the
  browser's own.
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
and `tabBrowser.claude.pathDelivery` lets the path entries choose between the two.

Codex has no equivalent, and that was looked for properly: `chatgpt.newCodexPanel` takes nothing
but a telemetry source, its uri handler only navigates its webview to a route and no route reads
a prompt, the composer's prefill is a shared object written from inside that webview, and
`chatgpt.addFileToThread` posts to whichever view Codex considers focused — it focuses its own
sidebar on the way, so a file meant for a freshly opened tab lands in the sidebar's conversation
instead, and an attachment leaves the composer empty anyway. The one channel that always
arrives is the clipboard, which is not a hand-over at all — so nothing here pretends to one.

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

`tabBrowser.mcp.enabled` and `mcp.port` are watched rather than read once: the sidebar reports
the setting immediately, so a server still answering after it was switched off is one an
assistant can drive while the editor says it cannot. What the running server owns is kept in a
list of its own (`mcpParts` in `activate`), because switching it off has to take back the port
and the chat's server definition without disposing the rest of the extension.

Security, all of which matter together: loopback only, a crypto-random bearer token kept in
`globalState` **per workspace** — ports are handed out in the order windows open, so a token
shared between them would let a configuration written for project A drive project B; bound to
the workspace, that misconnection is a 401 — and a refusal of any request carrying an `Origin`
header, since a page cannot read a cross-origin answer but the request's side effect alone would
drive the panel. The token is never handed to the page.

The panel's url and whether it can be inspected are known only in the webview — in-page
navigation never reaches the host — so the webview reports `didChangeState` and the view keeps
it. `browser_navigate` waits on `whenReady()` rather than answering into a loading page, and
says so when that wait runs out on a page it served through the proxy: "the panel is open" for
a page that never arrived has the caller clicking into whatever was standing there before. What
decides is `expectsAgent`, the panel's *intent* — `inspectable` cannot answer it, because a dev
server that is down leaves the panel showing the proxy's own error page, which carries no agent
either. A page deliberately opened outside the proxy never reports in and that is not a failure;
`inspectable: false` already says why. "Ready" itself is `DOMContentLoaded` in the page, not the moment the agent
runs: it is injected at the top of `<head>`, so reporting from there would answer a client into
a document with no body.

Which makes `ready` and the frame's own `load` event a race — two signals from two processes,
in no fixed order. They are therefore *paired by count*: the n-th report belongs to the n-th
document, both counts start over at every navigation the host resolves, and neither event is
read on its own. A load with no report yet writes the document off (only the proxy injects the
script, so nothing else can report in); a report arriving late takes that back; and a report
whose number is behind the loads belongs to a document the frame has already left, so it is
ignored. Read as bare flags, either order lies: the panel holds a page it can read while mcp
clients are told it cannot, or drives a page that has no agent in it at all.

Both connect dialogs also offer the configuration as a *prompt* (`connectPrompt`): the one
command that adds it, how it is picked up, and a check to run afterwards — short, because the
assistant only needs the command and a reason to try it. It goes on the clipboard, since neither
assistant can be handed text from outside. The line about picking the server up differs per
client and is not decoration — both read their servers at startup but
start at different moments, so a prompt without it has the assistant report the tools missing
right after adding them correctly.

Three clients, configured in three different places (`src/mcpSetup.ts`):

- **VS Code's chat** through `lm.registerMcpServerDefinitionProvider` (1.101+, reached through a
  cast so `engines.vscode` can stay at 1.85; the definition constructor is positional).
- **Claude Code** through `.mcp.json` or `claude mcp add` — written or copied by its command,
  and a config that cannot be parsed is left alone rather than overwritten.
- **Codex** in one of two places. The project's `.codex/config.toml` is written here (it belongs
  to one project, as does the panel it points at; Codex reads it in a trusted repository, and
  only our own table is touched). The global `~/.codex/config.toml` is left to `codex mcp add`,
  which owns it and edits around the servers already there — and the entry is named after the
  project, because one shared name would have a second project overwrite the first and, with the
  token in the url, that reconnection would even authenticate. That config can only name an
  *environment variable* to read a bearer token from, and this extension has no say over Codex's
  environment — hence `urlWithToken`, the same endpoint with the token as its last path segment,
  accepted alongside the header.

Known edges: selectors, not snapshot-scoped element refs, so a selector can go stale between
calls; clicks are synthetic dom events, which some things (file pickers, drag) will not accept;
one window wins the preferred port, so a `.mcp.json` written from another window points
elsewhere — the per-workspace token turns that into a 401 rather than a wrong-project session.

## Terminal links

`src/terminalLinks.ts` registers a `TerminalLinkProvider`, which is the stable way to take over
`Cmd`/`Ctrl` + click on a url: extension providers are asked before the terminal's own url
detection. The proposed `registerExternalUriOpener` — what the built-in Simple Browser uses —
is not granted to extensions outside the editor's own bundle. `tabBrowser.terminalLinks.mode`
decides which urls are claimed, with the same `localhost` / `always` / `never` shape as
`proxy.mode`.

## The tab icon and title

`WebviewPanel.iconPath` only takes a local file, so `src/favicon.ts` downloads the icon, sniffs
its magic bytes (a dev server answers `/favicon.ico` with its index page often enough that the
content type cannot be trusted) and writes it to `tmpdir/tab-browser-ultimate/icons/<sha1>.<ext>`.
Naming by content is what makes the editor repaint the tab when the icon changes.

Where the icon url comes from: an instrumented page reports it itself (`page-src/pageIcon.ts`,
sent as the `icon` agent event and re-sent when the head changes), a page loaded directly has
its html read once by `discoverPage`. Every navigation bumps `_iconToken` in
`src/tabBrowserView.ts` so a slow download cannot land on the wrong page.

The tab's *name* travels the same way and for the same reason — only the page knows it. The
panel opens as "AI Browser", `_resetTab` names it after the host as soon as a url resolves, and
the page's own `document.title` replaces that: reported as the `title` agent event (the head
observer watches `characterData` too, since `document.title = '…'` only rewrites a text node),
or read out of the html by `discoverPage` for a page no script reaches. A title is page content,
so it is collapsed to one line and cut to 60 characters before it goes on a tab.

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
