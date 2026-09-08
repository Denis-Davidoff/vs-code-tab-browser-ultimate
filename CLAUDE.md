# Tab Browser Ultimate — project context

VS Code extension: a browser tab in the editor (iframe in a webview) whose toolbar can hand the
rendered page to an assistant — a full report of a picked element, or the page's console output.

Forked from the Simple Browser extension that ships with VS Code and renamed throughout to
`tabBrowser.*` so both can be installed side by side. Not a git repository.

## Layout

| Path | Runs in | What it is |
| --- | --- | --- |
| `src/` | extension host (node) | activation, the webview panel, the local proxy, files from disk, clipboard, tab icon, mcp, the sidebar |
| `preview-src/` | webview | toolbar, address bar and its completion, the menus, zoom, hint bar; relays messages |
| `page-src/` | the previewed page | injected agent: picker, context menu, console capture, element report |
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

## A page that names its own server

The proxy serves the page from its own origin, and the page's own idea of where it lives does
not change with it: a build compiles `AUTH_URL`, `NEXTAUTH_URL` or `NEXT_PUBLIC_API_URL` into an
absolute url, and the client then asks for `http://localhost:3000/api/…` from a document served
on `http://127.0.0.1:59147`. Three things go wrong at once:

- it is **cross-origin**, so cors blocks it — a dev server has no reason to allow another origin;
- it is **cross-site**, since `127.0.0.1` and `localhost` are different sites and a port is no
  part of a site at all, so a `SameSite` cookie is not sent with it — and a csrf token is one;
- and the proxy never sees it, so this session's cookie names are not translated back: the
  server would be handed `__tb59147_authjs.csrf-token` even if the cookie did travel.

The proxy rewrites those urls where it can see them, which is in the html it passes through — a
bundle is not html. So they are rewritten in the page instead (`page-src/requests.ts`,
installed before the page's own code runs): `fetch`, `XMLHttpRequest.open` and `sendBeacon` put
a url aimed at **this session's own real origin** back on the origin the page was served from.
Only that one origin: a page asking for somewhere else is asking for somewhere else, and in a
browser that request is cross-origin too.

This is *not* what stops a login — the cookie above is — and it was taken for the cause for a
while on exactly that evidence: the login request in the traffic was cross-site. Both are real,
and each has to be fixed on its own.

Known edges of it: a `WebSocket`, an `EventSource` and a `<form action>` naming the real server
by absolute url still leave the proxy. The first two do not need cookies to work; a form post
does, and there is no way to rewrite one without editing the page's dom.

`tabBrowser.proxy.log` answers the one question the panel cannot otherwise be asked: whether a
request the page made went through the proxy at all. One line per request — method, path,
status, and the cookie **names** forwarded upstream, never the values. A request that is missing
from that log is a request that left.

`tabBrowser.proxy.mode` decides when the proxy is used: `localhost` (default), `always`,
`never`. A copy command forces a reload through the proxy when the current page is not
instrumented yet.

## A page off the disk

An html file is opened by the same route and for the same reason: an `<iframe>` will not load a
`file:` url at all, and nothing could be injected into it if it would. So a file is served by a
session of the proxy's that answers out of a folder instead of forwarding to a server
(`session.file`, `src/fileSession.ts`) — one early branch in `_handleRequest`, so the whole
http half is untouched by it. Which folder: the workspace folder the file belongs to, or its own
folder when it belongs to no project.

- **A port on the loopback interface answers to everything on this machine**, and to any page in
  any browser that guesses it. A file session therefore answers only urls whose first segment is
  an unguessable one of its own (`ServedFolder.secret`); without it the port would be a read of
  the project to whoever asked first. It is not a secret from the page — a page can read its own
  location — and a page that links to a third party leaks it in a `Referer`, which is why the
  folder is a boundary as well and not only the segment.
- **The rule about what a request may reach is one pure function** (`servedPathOf`), because
  what matters is what it *refuses*: segments are split before they are decoded, since `%2f` and
  `%5c` must not become separators, and the resolved path is checked against the folder rather
  than trusted for having no `..` in it. `test/host.test.mjs` covers the hostile spellings —
  going through a browser cannot, since `fetch` normalises half of them away before they are
  sent. That rule is about the *request*; the file it names is checked separately, against the
  folder's own resolved path (`realRoot`), or a link inside the project pointing out of it would
  be a read of whatever it points at. The paths everything else speaks in stay the ones that
  were asked for, since a folder reached through a link — `/tmp` on macOS — resolves to another
  name than the panel is showing.
- **A page built for a static server references its assets from the root** (`/assets/app.js`),
  and such a path carries no segment of the session's — there is nothing in it to say which
  session it belongs to. The `Referer` says it instead: only a document this session served can
  be on this origin, and a page elsewhere cannot claim to be one, so a request from one of our
  own pages is resolved against the folder like that static server would (`fromOwnPage`). It
  buys nothing past the segment — the same traversal rules run on it — and a page that strips
  its referrer simply goes back to 404.

  Such a request is *redirected* onto a url that carries the segment rather than answered as it
  is, and that is the point of it: what a file references is resolved against **its own** url,
  so a module served under a bare `/assets/main.js` makes its `import './dep.js'` arrive with a
  referrer that carries no segment either — one nothing can vouch for. With the redirect every
  url the page ever sees carries the segment, which is the invariant the rest of this design
  assumes. A folder addressed without its trailing slash is redirected too, or the page's own
  relative references resolve against the folder above it.
- **A file url cannot be rebuilt like a proxied one.** The panel shows the file, not the url it
  is served under, so `toRealUrl` maps the path back — and the injected script is told the same
  two things (`realOrigin`, `basePath`): a `URL` cannot be moved between `file:` and a scheme
  with a host, and the segment the session serves under belongs to the session and not to the
  page. Without both, every element report, every icon and every mcp answer names a loopback url
  that will not exist tomorrow.

Hot reload is the whole of what a page with no dev server in front of it can have: the files the
session actually served are watched (one non-recursive watcher per folder, not a recursive one
over a project the page uses three files of), and a change to one of them has the panel navigate
again (`onDidChangeServedFile` → `reloadPage`). A page addressed as a folder is the index inside
it, its referrer included, or its assets would be recorded against a page the panel never shows. What it reports is the **page** and not the
folder — one session serves every page of one folder, and a stylesheet of the page opened an hour
ago is not part of the one on screen — so every file is remembered against the pages it is part
of, read off the same `Referer`. Part *of*, and not "asked for by": a stylesheet that `@import`s
another one is not a page, so what a file inherits is its referrer's pages rather than the
referrer itself, however long the chain. An html file counts as a page of its own as well, since
a page that links to another one is the referrer of that navigation and not what it renders. One
save is often two events, so two reloads inside 150ms are one.
`tabBrowser.files.reloadOnChange` turns it off.
Which is also why nothing a file session serves is cacheable, and why the parameter the webview
varies to make the frame load a page twice (`cacheBustParameter`) is taken back off every url the
page reports: a page reloaded on every save would otherwise grow a `?vscodeBrowserReqId` onto its
own path in every report it appears in.

An assistant cannot point the panel at a file: `browser_navigate` refuses anything that
normalises to a `file:` url, since every other tool then reads whatever it named. Opening one is
the user's decision — the explorer's context menu, the sidebar, the address bar (which takes a
path as readily as a url) — and once a file is open, all the tools read it like any other page.

Two things about that arrangement are easy to get wrong again:

- **A cookie in the panel is a third-party cookie.** The top-level document is the editor's
  webview, so as far as the browser is concerned the page is a frame in somebody else's site —
  and a cookie without `SameSite=None; Secure` is not merely withheld from the next request, it
  is **never stored**. That is a login that cannot be completed however good the proxy is: the
  csrf cookie does not exist by the time the second fetch of the same page load goes out. So
  `shared/cookies.ts` forces `SameSite=None` and adds `Secure` — which costs nothing over
  `http://127.0.0.1`, a trustworthy origin — rather than dropping them as describing an origin
  the browser does not have the page from, which was this file's reasoning for a while and was
  exactly backwards. `test/host.test.mjs` frames a proxied page in a document on another site
  and follows a cookie into the second request of one page load; with `SameSite=Lax` the jar
  comes back empty.
- **Cookies are not separated by port.** Every session publishes on `127.0.0.1`, so without help
  the site on :3000 would read, overwrite and receive the cookies of the site on :5173 — the
  `HttpOnly` ones too, which a page cannot see but the browser still sends. So each session
  prefixes the names of the cookies it hands the browser, drops the ones that are not its own
  from every request it forwards, and restores the real names upstream. The prefix comes from
  the **origin** and not from the port (`cookiePrefixFor`): a port is handed out again on every
  restart, and a name that changes with it is a session the user logs into again every morning.
  It is also what contains `SameSite=None` above — another proxied site can have the browser
  attach these cookies to a request at this port, and the session forwards only its own names.
  `page-src/cookies.ts` hides the prefix from `document.cookie`, so page scripts never see it,
  and puts a write through the same rewriting as a `Set-Cookie` header (both use
  `shared/cookies.ts`, or a cookie a script sets would not survive what the server sets).
  Which is also why a session forwards to its own server and nowhere else (`targetOf`): a
  request target is a path, and one beginning with `//` resolves to a *host*, so
  `//example.com/x` would have handed those cookies to example.com.
- **The webview is not alone in its window.** The framed page can `postMessage` into it, so
  every message from the extension host carries the panel's token (`TabBrowserSettings.token`,
  read from the webview's own dom, which a cross origin page cannot reach) and the webview drops
  anything without it. Without that, a page could start a pick and have its own report written
  into the workspace and mentioned to Claude Code.

  The traffic in the *other* direction — what the agent reports — is trusted just as completely
  and cannot be protected the same way: the shapes are in the script the proxy injects into the
  page, so nothing about them is secret, and there is nowhere to put a secret the page could not
  read. What a page cannot do is lie about the `origin` the browser stamps on a `postMessage`,
  so that is the check (`TabBrowserSettings.agentOrigins`, kept current by
  `didChangeAgentOrigins` from `BrowserProxy.origins()`, plus the host's word that *this*
  navigation went through the proxy at all). Without it a page the proxy does not serve — one the
  framed page linked to — can report itself ready, be taken for instrumented, and hand its own
  idea of the picked element, the console and every mcp answer to an assistant. Which is also why
  a per-document nonce injected by the proxy is not the answer: the document it is injected into
  can read it.

Every patch the injected script makes is to an api of the page's own — `console`,
`document.cookie`, `fetch`, `XMLHttpRequest.open`, `sendBeacon` — and a page is free to have
frozen any of them, which some libraries do. Each is installed on its own (`tryInstall`,
`patch`), because they run *before* everything else: one assignment that throws in a page like
that took the picker, the console, the shortcuts, the element reports and every mcp tool with
it, and the panel simply reported the page as not instrumented. `test/host.test.mjs` walks a
page that freezes all of them.

The injected script sits in front of the page's own code — `console` is patched before any of
it runs — so nothing it does may change how that page behaves. Formatting a logged value is the
sharp edge: `%d` with a symbol, a getter that throws, a revoked proxy. `page-src/consoleCapture.ts`
therefore records inside a `try` and forwards to the real console either way; a page that logs
something unreadable gets `[could not be read]` in the copy, never an exception of ours.

A subresource that fails to load is *not* reported to the panel: a dev server rebuilding answers
404 for the chunk the page is still asking for, and a banner over the page for something that
resolves itself a second later is noise. `consoleCapture` records it either way — where a
browser records it too — so the copy menu and the mcp tools still see it. What does reach the
panel is an uncaught exception, which is what explains a blank page.

The panel's dead ends are a page of the proxy's own (`errorPage`): a server that is not running,
a path outside the folder a local page is served from. It carries its own styling and answers
`prefers-color-scheme`, since there are no editor theme variables inside the frame.

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
writes a second time, and a file with the same table twice does not parse at all. For the same
reason it reads a line in one quote-aware pass (`scanLine`) and records the line each value was
read from: a `[mcp_servers.…]` inside somebody's `instructions = """…"""` is prose, and a writer
that takes it for a table edits the middle of that prose — a config Codex then cannot parse at
all. Which cuts both ways, and the counting version of this got it wrong in both directions: a
triple quote inside a literal string (`note = 'use """ for prose'`) opens nothing, and read as
if it did, the table this extension wrote goes unseen and connecting writes it a second time.

The three sections are **Navigation**, **Tools** (only with a panel open, since it is about the
page in it) and **MCP**. `Open a file…` is `findFiles` plus a dialog rather than a walk of the
folders — the editor's index already knows about the excludes the user has set, and it runs only
when the row is clicked. A tree of the project's folders lived here for a while and was taken
back out: the panel opens one page at a time, and a second file explorer beside the editor's own
is a row nobody was going to use.

Recent pages live in `workspaceState`: a dev url belongs to the project, not to the user. A file
is remembered there too, and shown relative to the project it belongs to.

## The panel's own menu, the zoom and the address bar

Three things the toolbar grew that are about the *panel* rather than about the page.

**More than one panel.** `TabBrowserManager` keeps a list, most recently active first, and
`activeView` — what every command, the sidebar and every mcp tool act on — is the panel that
was last looked at (`onDidBecomeActive`, off the editor's `onDidChangeViewState`). `show` still
reuses that one; `newTab` is the only thing that opens another, blank and with the address bar
focused — and it caps them, because a tab can be asked for by the page: `Cmd`+`T` has to work
while the page has the keyboard, so the script forwards it, and what the script sends is
something a page can send on its own. Every panel holds a live webview. A blank tab loads nothing at all: assigning an empty `src` would load the webview's own
document into the frame.

**Zoom belongs to the frame**, not to the page: a CSS transform scales the iframe while its
width and height are divided by the factor, giving the page a smaller layout viewport.
The frame cannot flex-shrink, and its container clips the unscaled layout overflow. CSS `zoom`
must not be used here: Chromium can resize a cross-site frame's viewport without visually
scaling its contents. `test/host.test.mjs` checks geometry and `innerWidth`, plus a click beyond
the original width of an enlarged button in a separate-site renderer. Two things follow from the page and the
panel counting in different pixels: the level is kept in the webview's own state (per panel,
across restarts), and the point a right-click reports has to be multiplied by it before the menu
is placed — the page reports its own viewport, the frame's box is the scaled one.

**The keys a browser keeps for itself** (`Cmd`/`Ctrl` + `T`, `+`, `-`, `0`) reach the panel
through the injected script (`shortcut`), which is the only thing that hears them while the page
has the keyboard — a key pressed inside a frame reaches no listener above it and no keybinding
of the editor's either. Not through `contributes.keybindings`: see the clipboard section for
what claiming a key of the editor's costs. What the page forwards is checked against the four
of them by name (`isShortcutAction`), since the shapes it sends are in the script the proxy
injected into it: a page that could send `paste` could have the clipboard read for it. A pinch on a trackpad and
`Cmd` + wheel are the same event everywhere (`wheel` carrying `ctrlKey`), so one non-passive
listener answers both and reports the delta upwards (`zoomGesture`); the panel adds those up and
steps when they amount to one, since a gesture is many small deltas and the zoom is a dozen
steps. That listener reads `defaultPrevented` and sits in the bubble phase, unlike the keyboard
one: a browser hands a page `ctrl` + wheel — which is how a map zooms — and a page that takes it
must not have the panel zoom underneath it as well. The keys are the other way round, since a
browser never hands those to a page at all.

**The address bar completes the pages the panel has been on.** Remembered from what a panel
*reports* (`onDidChangeState`) and not from the manager's own change event, which fires for the
focus moving between panels too: coming back to a panel opened an hour ago would otherwise stamp
its page as the newest thing visited. The field is left alone only while it holds something
being typed, since the url a navigation ends on — the one the server redirected to — arrives
later, and a field still holding what was typed is a field lying about where the panel is.
The history is one list (`src/recentPages.ts`, in `workspaceState`) with two readers — the sidebar's "Recent" section and
this — so it holds more than either shows: the address bar *filters* it rather than reading it in
order. What a person types into an address bar is the start of a host or of a path, so those rank
first (`matchRank`), a mere substring after them, and recency only decides between equals. The
list is the webview's own dom, drawn under the field rather than in the page — a `<datalist>`
cannot be styled, ordered or navigated the way this needs to be.

## Undo, cut, copy, paste and select all

They do not work by themselves in the page, and the reason is worth writing down because
nothing about it is visible from here.

The editor takes those keys for itself. On macOS `Cut`/`Copy`/`Paste` are native menu roles, so
the accelerator is handled by the OS and lands on the focused frame; everything else — `Undo`,
`Redo` and `Select All` — is re-dispatched into the renderer as a keystroke
(`vscode:runKeybinding`) and resolved by the keybinding service, which lands on `undo` and
`editor.action.selectAll`. The editor's own webview support
answers those by running `execCommand` **on the frame it created** (`getActiveFrame()` in the
webview's host script), which is this panel's document — and the page is one frame deeper than
that. So the command runs against a document with no selection in it, the page never hears the
key, and nothing happens anywhere.

Hence six commands of ours (`tabBrowser.clipboardCopy` and friends), reached from the panel's
own menu and carried the rest of the way: the webview looks at what has the focus — its own
address bar, or the page — and the page passes the command down to whichever frame holds the
focus, since a command run in every frame would copy from three documents at once.

**They are not bound to those keys, and that is the whole point of this section.** They were,
once, with `when: activeWebviewPanelId == 'tabBrowser.view'` — and copy and paste stopped
working *everywhere in the editor*, not only here. Whatever the exact path (the resolver, or the
accelerator the native Edit menu registers for the editor's own clipboard commands), a `when`
clause is not enough to make claiming `Cmd`+`C` safe, and an extension that takes copy out of
the rest of the editor is worse than one whose panel has no shortcut for it. So the extension
contributes **no keybindings at all**: the keys a browser keeps for itself are forwarded by the
injected script, which is the only thing that hears them while the page has the focus anyway,
and everything else is in the menu. `test/host.test.mjs` fails if a keybinding is contributed
again, and says why.

- **The clipboard is read in the extension host** (`vscode.env.clipboard`) and the text travels
  down with the paste. The page is never given a way to *ask* for the clipboard: a page that
  could ask could read it whenever it liked, and the clipboard is where passwords are.
- **A copy is written by the page where it can be** (`execCommand('copy')`, which keeps the html
  flavour of a rich selection) and handed to the host where it cannot: a document with no user
  activation of its own may be refused the clipboard, and this command arrives as a message
  rather than as a keystroke. One of the two always happens, which is what the test pins down.
- **Only a paste leaves the webview.** Undo, redo, copy, cut and select all are `execCommand`
  in the document that has the keyboard and need nothing from the extension host, so the menu
  runs them where they happen; a paste is the one that has to go out and come back.
- **A paste is `execCommand('insertText')`** and not an assignment to `value`, so `beforeinput`
  and `input` fire, a framework notices, and undo still works.
- The framed page is also given the clipboard permissions the editor gave this document
  (`allow="clipboard-read; clipboard-write"`): a permissions policy is not inherited across a
  cross-origin frame, so without it a page's *own* copy button silently fails.

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
  browser's own. `@import` is the same trap one level up: the rules it brings in hang off the
  rule's own `styleSheet` and not off `cssRules`, so a walk that only recurses into groups leaves
  out everything a page imports — with nothing in `unreadableStyleSheets` to say the report is
  short of it. Walked with the import's own conditions (`media`, `supports()`), since rules
  brought in under a query that matches nothing apply to nothing, and with the sheets already
  seen remembered, since imports can form a cycle.
- `src/tabBrowserView.ts` formats it. The default `context` format is the report in the README;
  `css`, `xpath`, `both` and `json` remain, and "Copy element XPath" always writes an XPath
  regardless of the setting.

Multi-line reports go on the clipboard as a file *and* as text (`src/clipboardFile.ts`), so a
chat attaches a document while a text field still pastes text. There is no editor API for this:
macOS goes through one `NSPasteboardItem` carrying both `public.file-url` and
`public.utf8-plain-text` (JXA via `osascript`), Windows through `Set-Clipboard -Path`. Anywhere
else — and in remote workspaces, where the clipboard belongs to another machine — it falls back
to plain text.

### The menu a right-click opens

`tabBrowser.contextMenu.enabled` (default on) has a right-click in the page answered with the
copy menu's element entries for the element under the cursor, plus **Inspect element** — the
editor's developer tools, which is the only inspector a page in a webview has. Both menus are
built from `_elementMenuGroups`, since two menus offering different sets of the same actions is
the one difference between them nobody would look for. The context menu carries no check mark:
it acts on the element that was clicked, not on the entry a button is about to run.

It is drawn in the **webview**, not in the page: the editor's own colours, out of reach of the
page's css, and a click on it is a click on the panel's own dom. What the page sends up is a
point and a name (`contextMenu`), and the element itself only when an entry is chosen
(`pickContextTarget` → an ordinary `pick`) — describing one is the expensive half of a pick, and
most right-clicks end in no command at all. Which is also why the page holds the element rather
than the webview holding a reference to it: only one document in the frame chain may be holding
one, so a frame relaying a child's right-click drops its own target and tells its other children
to drop theirs.

Three things about it are easy to get wrong:

- **Whether the page wanted the click is not ours to decide.** A site with a menu of its own
  (a canvas app, an editor, a file tree) says so by taking the event, so the agent's listener
  sits on `window` — last of all of them — and reads `defaultPrevented` off it. What it cannot
  do is ask first: suppressing the editor's own menu is a `preventDefault` inside the handler,
  so the page has to know whether the panel wants right-clicks *before* one happens. Hence
  `setContextMenu`, sent at every `ready` and when the setting changes, rather than a question
  asked at the time.
- **A menu drawn above the frame does not see what happens inside it.** A click, a scroll or an
  Escape in the page reaches no listener in the webview, so the page reports those itself
  (`dismissMenu`) for as long as the panel says it has a menu up (`menuOpen`) — which is as true
  of the toolbar's own menus as of this one, so all three are closed by it and all three ask for
  the watch. Nothing else asks: watching starts when the panel says a menu is open and stops
  when it says otherwise, because the panel may decide not to open one at all (it is picking,
  say) and a frame left watching reports clicks nothing is listening for.
- **A pick that arrives with nothing pending is a page reporting elements nobody asked about.**
  The picker's own flag cannot let this one through — nothing is picking — so the webview keeps
  `awaitingContextPick`, and takes it back on a timeout: the element can be gone by the time an
  entry is chosen, and a page with nothing to report says nothing at all.
- **The element is asked for before the menu is closed**, never the other way round: closing is
  what tells the page to forget it, the page answers messages in the order they arrive, and a
  page that has forgotten the element answers nothing at all — a copy that ends in a timeout.
- **The element is named, and every message about it carries that name** (`targetId`). Two
  things need it. A click in the page can land in a frame that is not the one holding the
  element, and only the panel knows there is a menu to close — so `contextMenuOpen` goes to
  *every* frame while one is up, and the frame that answers is whichever one the click reaches.
  And the panel's word that a menu has closed can arrive *after* the right-click that replaced
  it: a frame told to forget "whatever you have" would drop the element of the menu standing
  open, and answer the pick that follows with nothing.

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
in no fixed order, and read as bare flags either order lies: the panel holds a page it can read
while mcp clients are told it cannot, or drives a page that has no agent in it at all.

So the webview does not infer it from their order at all: it *asks*. Every `load` sends an
`alive` command carrying a number, whichever document is holding the frame answers with that
number, and only the current question's answer counts (`probeId` / `answeredProbe` in
`preview-src/index.ts`). No answer within `probeTimeout` (150ms) is a document with no agent —
silence is the only sign of one, since only the proxy puts that script in a document — and an
answer arriving later than that takes the write-off back. A `ready` is an answer of its own
kind, because only a document that has the agent can send one.

Two ways of reading it off the timing were tried first and both were wrong. *By number* — the
n-th report to the n-th document — breaks on any document that never reports: it shifts nothing
to pair with, so an instrumented page loaded after a silent one read as uninstrumented for as
long as the panel stayed on it. *By a window in time* — a report within 150ms of a load belongs
to that load — credits a new page's report to the page before it, and then writes the new page
off with its agent running. Both are in `test/host.test.mjs`, which walks a real frame through
silent and instrumented documents in both orders.

Both connect dialogs also offer the configuration as a *prompt* (`connectPrompt`), on the
clipboard since neither assistant can be handed text from outside. It is two lines and no more,
by request: which server to use and which file it is in, then the command that adds it for a file
that was never written. What it deliberately leaves out is the line about *picking the server up*
— both assistants read their servers when they start and neither rereads them, so an assistant
that adds the server mid-conversation will report the tools missing until it is restarted (Claude
Code) or a new conversation is started (Codex). The dialogs say that where the buttons are; the
prompt does not, and the two numbered buttons are the route that avoids the situation entirely,
since the entry is already in the file before the prompt is pasted.

The fallback command is not always the same server, either: Claude Code's `claude mcp add` writes
`tab-browser`, the name the first line asks for, while Codex's writes the per-project name,
because the file it writes is the one shared between projects. So the Codex prompt names that
entry too — a prompt that did not would have the assistant run the command correctly and then
look for a server that is not there.

Three clients, configured in three different places (`src/mcpSetup.ts`):

- **VS Code's chat** through `lm.registerMcpServerDefinitionProvider` (1.101+, reached through a
  cast so `engines.vscode` can stay at 1.85; the definition constructor is positional).
- **Claude Code** through `.mcp.json` or `claude mcp add` — written or copied by its command,
  and a config that cannot be parsed is left alone rather than overwritten.
- **Codex** through the project's `.codex/config.toml`, which is written here (it belongs to one
  project, as does the panel it points at; Codex reads it in a trusted repository, and only our
  own table is touched). The global `~/.codex/config.toml` is *not* written from here — it is
  `codex mcp add`'s, which owns it and edits around the servers already there — so it is only
  offered as a command to copy, under a name ending in the project's, because one shared name
  would have a second project overwrite the first and, with the token in the url, that
  reconnection would even authenticate. That config can only name an *environment variable* to
  read a bearer token from, and this extension has no say over Codex's environment — hence
  `urlWithToken`, the same endpoint with the token as its last path segment, accepted alongside
  the header.

Both connect commands lead with two numbered buttons — write the entry, then copy the prompt —
because they are one way of connecting in an order that matters: the prompt has the assistant
read an entry that the first button is what writes.

### Keeping a configuration that was written once

`src/mcpRefresh.ts` runs at every start of the server, because what goes stale in a client's
config is not the token — that belongs to the workspace and outlives the window — but the
**port**: ports are handed out in the order windows open, so the entry written for this project
last week names whichever window opened first today. Without repair, connecting is something the
user does again every morning.

So the entries this extension writes are pointed back here: same file, same name, and a url that
is still one of ours (loopback, our path, at most a token segment — which is also what leaves a
`${...}` a client expands itself alone). An entry that is *not* there is never created: adding a
server to a project is a decision, and the connect command is where it is made.

What counts as ours differs per file, and getting that wrong hands one project's panel to
another. In the workspace's own `.mcp.json` and `.codex/config.toml` the location is the proof.
The global `~/.codex/config.toml` is shared by every project on the machine, so an entry there
has to say it is ours — the per-project name (which carries a hash of the folder) or this
workspace's token in the url — or a window with no folder open would take over the entry of
whichever project happens to be configured under the bare name. Both names are looked for, since
an entry under the bare one is exactly the case the token is there to judge; naming only the
first would put it beyond repair and never reach that check at all.

That file is also the one the *other windows* are in: each repairs a different entry in it, so
two starting at once would both write the text they read and the later one would undo the
earlier one's repair, leaving a correctly configured client on somebody else's port. So its
read-and-write uses a bakery queue in `config.toml.tab-browser-locks`. Each contender creates a
unique directory and atomically publishes its numbered ticket; ties are ordered by claim name.
A live process's claim is never taken over based on age — a claim can be arbitrarily old and
still belong to a window that was suspended mid-write, which is what `test/config-lock.test.mjs`
holds the line on. Only a claim its owner cannot still be holding is removed, by its unique name,
so cleanup can never delete a successor's lock.

Which leaves what "cannot still be holding" means, and a pid alone does not say it: a claim left
behind by a kill survives a reboot, and the kernel hands that pid out again — to a daemon, or to
another user's process, which `kill(pid, 0)` reports as alive all the same (`EPERM`). Read as a
live contender for ever, that one claim has every window from then on wait out the deadline and
skip the repair, with nothing left that could ever reclaim it. So a claim also records the
machine's boot time as its own window derived it (`Date.now() - os.uptime()`, compared with a few
seconds' tolerance, since two windows derive it milliseconds apart), and one from before this
boot is dead whatever its pid says.

Unreadable queues skip repair instead of writing without exclusion. Waiting is bounded to two
seconds, and the empty queue directory stays on disk to avoid deletion/recreation races — which
is also why there is a `stat` before the first `mkdir`: the repair never creates a config, so a
machine with no Codex on it must not be given a `~/.codex` with a queue directory in it that
nothing will ever remove.

Known edges: a file session answers no `Range` requests, so seeking in a `<video>` a local page
plays does not work, and an asset reached through a symlink that leaves the served folder is
refused rather than followed (a pnpm store outside the workspace, say); selectors, not snapshot-scoped element refs, so a selector can go stale between
calls; clicks are synthetic dom events, which some things (file pickers, drag) will not accept;
one window wins the preferred port, so an entry written from another window points elsewhere
until that window's own server starts and repairs it — the per-workspace token turns the window
in between into a 401 rather than a wrong-project session. And a project that was connected
globally by a version that had the "Add to Codex globally" button, then connected again since,
has two entries in `~/.codex/config.toml` — the bare name and the per-project one — both of which
this repairs, so Codex lists every browser tool twice.

That one is *reported* rather than fixed, which is the only honest option available:
`~/.codex/config.toml` belongs to `codex mcp add` (and the code that took entries back went with
the button), so writing an `enabled = false` into it decides for the user; and not repairing the
duplicate would leave it enabled on an old port, turning tools that work into tools that answer
401. So `codexOurEntries` counts the entries Codex would actually start and **Check connection**
names them with the `codex mcp remove` that drops one — which also catches the entry under the
naming an even earlier version used (`tab-browser-<slug>`, no hash), which nothing repairs and
which is therefore already a dead duplicate.

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
content type cannot be trusted) and writes it to `context.globalStorageUri/icons/<sha1>.<ext>`.
This storage root is passed through the manager and view: VS Code refuses `.ico` resources in
the system temporary directory, although PNG and SVG there are allowed.
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
