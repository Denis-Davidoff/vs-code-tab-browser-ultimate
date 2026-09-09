# AI Browser — baseline working version

**Status: this version works. It builds from scratch with zero errors and is a good starting
point.** New functionality gets built on top of it. When changing anything, preserve the
invariants listed under [Things that break silently](#things-that-break-silently) — those are
the ones that produce no compile error and only show up at runtime as a blank panel or missing
icons.

The extension is a fork of `simple-browser` from the microsoft/vscode monorepo, extracted into
a standalone project and renamed. Every tie to the monorepo (gulp, shared esbuild helpers,
`../../node_modules`) has been removed.

Published as `DenysDavydov.tab-browser-ultimate` — the package `name` (and so the extension
id and the marketplace slug) is `tab-browser-ultimate`, while everything user-visible says
"AI Browser": `displayName`, the command `category`, and the `aiBrowser.*` identifiers. Open
VSX carries it; the VS Code Marketplace cannot, because of the API proposals.

## How we build features — the main approach

**New browser functionality is built against VS Code's built-in browser, through the `browser`
API proposal and CDP. This is the default and it is settled** — the recipe is in
[The `browser` proposed API](#the-browser-proposed-api--the-main-way-to-add-features). It is
proven, not theoretical: the element picker ([src/elementPicker.ts](src/elementPicker.ts))
works this way end to end.

**Do not add features to the webview panel.** It remains available
(`aiBrowser.useIntegratedBrowser: false`) and bug fixes there are fine, but new work does not
go there. The panel is a webview hosting a cross-origin iframe, and that costs it — by
construction, with no workaround — clipboard and undo shortcuts inside the page, every
keyboard shortcut while the page has focus, find in page, site permissions, storage control,
real per-page DevTools, page zoom, and any history beyond what was typed in the address bar.
Each of those is a CDP call away in the built-in browser.

This was worked out the long way. **Do not re-derive these dead ends:**

- Extensions cannot contribute to the built-in browser's toolbar or its "..." overflow menu.
  The `contributes.menus` allowlist has 96 keys and not one maps to a `Browser*` `MenuId`, and
  no API proposal covers it. `editor/title` does work — that is where the element picker's
  button lives.
- Nothing can forward keyboard input out of a cross-origin iframe. VS Code's own answer is a
  preload script plus main-process IPC; extensions have neither.
- A page can hand its keys back by including a snippet we provide, and that does work, but it
  only ever applies to pages you control, so it is not a general answer.

## Conventions

**All documentation, code comments, README, and commit messages are written in English.**

**Every quirk, special case, unusual decision, and piece of "this is how it has to be done for
it to work" knowledge must be written down in this file, in the
[Special cases and non-obvious decisions](#special-cases-and-non-obvious-decisions) section.**
That applies to anything that cost time to figure out, anything that looks wrong but is
deliberate, and anything a reasonable change would break. If it was surprising once, it will be
surprising again — record it instead of rediscovering it. Runtime failure modes with no compile
error go under [Things that break silently](#things-that-break-silently) instead; deliberate
removals go under [Removed on purpose](#removed-on-purpose--do-not-reintroduce).

## What it does

Displays a web page in an iframe inside a VS Code webview panel, with its own address bar and
navigation controls.

There are three entry points. All three first check whether the `workbench.action.browser.open`
command exists (VS Code's built-in browser) and delegate to it instead of opening our own panel
— see `shouldUseIntegratedBrowser` in [src/extension.ts](src/extension.ts):

| Entry point | Purpose |
|---|---|
| `aiBrowser.show` | Command palette entry — "AI Browser: Show"; prompts for a URL if none is passed |
| `aiBrowser.api.open` | Programmatic API for **other extensions** — the fork's primary purpose |
| External URI opener `aiBrowser.open` | Intercepts `http`/`https`, but only for localhost-like hosts |

The external URI opener does not fire for arbitrary URLs — only for the hosts listed in
`enabledHosts` (`localhost`, `127.0.0.1`, `0.0.0.0` and the IPv6 equivalents). For anything
else it returns `ExternalUriOpenerPriority.None`, so VS Code opens the system browser.

Settings:

| Setting | Default | |
|---|---|---|
| `aiBrowser.useIntegratedBrowser` | `true` | delegate to VS Code's built-in browser; `false` brings back the webview panel |
| `aiBrowser.mcp.enabled` | `true` | run the local MCP server for assistants |
| `aiBrowser.mcp.port` | `43110` | preferred port; each window takes the next free one |
| `aiBrowser.searchEngine` | `google` | engine for the panel's address bar; `none` disables search |
| `aiBrowser.focusLockIndicator.enabled` | `true` | the panel's focus indicator |

## Architecture: two independent halves

This is the key thing to understand about the build. The code lives in two isolated runtimes,
each with its own compilation step.

### 1. Extension host (Node.js) — `src/` → `out/`

Compiled with `tsc`, **no bundling**. `main: ./out/extension`.

- [src/extension.ts](src/extension.ts) — `activate`, command and opener registration
- [src/aiBrowserManager.ts](src/aiBrowserManager.ts) — singleton holder for the active panel
- [src/aiBrowserView.ts](src/aiBrowserView.ts) — the panel: HTML generation, message bridge
- [src/dispose.ts](src/dispose.ts) — base `Disposable` with `_register`
- [src/uuid.ts](src/uuid.ts) — nonce generator, copied from `vs/base/common/uuid`
- [src/cdp.ts](src/cdp.ts) — CDP client for the built-in browser (not used by the panel)
- [src/elementPicker.ts](src/elementPicker.ts) — the three element commands
- [src/elementContext.ts](src/elementContext.ts) — pulls element data out of the page over CDP
- [src/elementMarkdown.ts](src/elementMarkdown.ts) — renders that data as Markdown
- [src/cssHelpers.ts](src/cssHelpers.ts) — copied verbatim from vscode, builds the CSS section
- [src/reportFormat.ts](src/reportFormat.ts) — report text and file names (leaf, under test)
- [src/assistants.ts](src/assistants.ts) — handing reports to Claude Code and Codex
- [src/lastAction.ts](src/lastAction.ts) — which element command the toolbar button repeats
- [src/browserController.ts](src/browserController.ts) — what the browser can do, for MCP
- [src/mcpProtocol.ts](src/mcpProtocol.ts) — JSON-RPC dispatch and the auth decision (leaf, under test)
- [src/mcpServer.ts](src/mcpServer.ts) — HTTP transport, tools, client attribution
- [src/mcpSetup.ts](src/mcpSetup.ts) — client config writing and the connect dialogs
- [src/mcpCheck.ts](src/mcpCheck.ts) — the Check Connection report
- [src/mcpClientState.ts](src/mcpClientState.ts) — config states (leaf, under test)
- [src/codexToml.ts](src/codexToml.ts) — the mini TOML table parser (leaf, under test)
- [src/mcpLifecycle.ts](src/mcpLifecycle.ts) — server lifetime and context keys

**There is only ever one panel.** `AIBrowserManager._activeView` is a single slot: a repeat
`show()` reuses the existing panel rather than creating a second one. If multiple tabs are ever
needed, that is the place to change.

The panel is created with `retainContextWhenHidden: true` (the iframe is not reloaded when
switching tabs) and `localResourceRoots: [<ext>/media]` — **`media/` only**; the webview cannot
load resources from any other directory.

### 2. Webview (browser sandbox) — `preview-src/` → `media/`

Bundled with `esbuild`. This is the script running **inside** the panel: address bar,
back/forward/reload, "open externally" button, focus lock indicator.

- [preview-src/index.ts](preview-src/index.ts) → `media/index.js`
- [preview-src/events.ts](preview-src/events.ts) — `onceDocumentLoaded`
- `@vscode/codicons/dist/codicon.css` → `media/codicon.css`

`media/main.css` and `media/icon.png` are checked-in static assets and are not built.
`media/index.js`, `media/codicon.css` and their `.map` files are **build artifacts and are
gitignored**. After a fresh clone the panel stays blank until `npm run compile` has run.

CSS classes the webview script depends on: `.header`, `.controls`, `.url-input`,
`.back-button`, `.forward-button`, `.reload-button`, `.open-external-button`, `.content`,
`.iframe-focused-alert`, plus these toggled on `body`: `iframe-focused`,
`enable-focus-lock-indicator`.

### The bridge between the halves

Initial state is handed over **through the DOM, not through a message**: the extension writes
JSON into `<meta id="ai-browser-settings" data-settings="...">` and the webview reads it in
`getSettings()`. The `ai-browser-settings` identifier is hard-coded in two files — rename it in
both, or the webview throws `Could not load settings` and the panel stays blank.

Messages:

| Direction | Message |
|---|---|
| webview → extension | `{ type: 'openExternal', url }` → `vscode.env.openExternal` |
| extension → webview | `{ type: 'didChangeFocusLockIndicatorEnabled', focusLockEnabled }` |

Panel state for restoring across restarts: the webview calls `vscode.setState({ url })` and the
extension registers a `WebviewPanelSerializer` for `viewType = 'aiBrowser.view'`.

**Dead code:** the webview handles a `{ type: 'focus' }` message that the extension never
sends — a leftover from the monorepo. Either wire it up or delete it.

## Panel CSP — the main constraint when extending

The HTML is generated in `AIBrowserView.getHtml()`. Its Content-Security-Policy is strict:

```
default-src 'none';
font-src data:;
style-src ${webview.cspSource};
script-src 'nonce-${nonce}';
frame-src *;
```

What that implies for new functionality:

- **Every `<script>` must carry `nonce="${nonce}"`.** The nonce is regenerated on each
  `getHtml()` call. A script without it is silently blocked.
- **Fonts may only be `data:` URIs.** A separate font file next to the CSS will not load. This
  is exactly why `codicon.ttf` is inlined into `codicon.css` (see below).
- **`img-src` is not allowed at all** (`default-src 'none'`). Displaying images in the panel
  requires adding the directive.
- **No `fetch`/XHR from the panel** — `connect-src` is not allowed. Data has to travel through
  `postMessage` to the extension host.
- The iframe is created with `sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"`.

`navigateTo()` in the webview appends `id` and `vscodeBrowserReqId` query parameters to the
URL. That is a cache-busting hack — it was the only reliable way found to force the iframe to
reload.

## Build

There are **no production dependencies at all**, only devDependencies. All seven are in use —
verified by removing each one from `node_modules` and watching what broke.

```
compile                  build-ext && build-webview            ← full build
watch                    run-p -l watch-ext watch-webview watch-typecheck-webview
build-ext                tsc --project ./tsconfig.json         ← src/ → out/
build-webview            node ./esbuild.webview.mts            ← preview-src/ → media/
watch-ext                tsc ... --watch
watch-webview            node ./esbuild.webview.mts --watch
watch-typecheck-webview  tsc --project ./preview-src/tsconfig.json --noEmit --watch
typecheck                run-p -l typecheck-ext typecheck-webview typecheck-tests
typecheck-ext            tsc --project ./tsconfig.json --noEmit
typecheck-webview        tsc --project ./preview-src/tsconfig.json --noEmit
typecheck-tests          tsc --project ./tsconfig.test.json    ← test files, no emit
test                     node --test preview-src/*.test.ts src/*.test.ts
check-manifest           node ./scripts/check-manifest.mjs      ← menus, icons, activation
package                  vsce package … --out tab-browser-ultimate.vsix  ← see Packaging a VSIX
publish:ovsx             ovsx publish tab-browser-ultimate.vsix ← Open VSX, needs OVSX_PAT
verify-pat               ovsx verify-pat DenysDavydov          ← is the token good?
download-api             dts dev                               ← refresh the proposed-API d.ts
vscode:prepublish        npm run compile
```

To verify a change:

```sh
rm -rf out media/index.js media/index.js.map media/codicon.css media/codicon.css.map
npm run compile && npm run typecheck
```

### TypeScript configuration

- [tsconfig.base.json](tsconfig.base.json) — shared base (commonjs, ES2022, strict,
  `noUnusedLocals`, sourceMap). Created locally to replace the monorepo's missing
  `../tsconfig.base.json`.
- [tsconfig.json](tsconfig.json) — extension host. `types: ["node"]` **restricts** automatic
  type discovery, which is why `@types/vscode` is pulled in explicitly via `include` rather
  than through `typeRoots`. `vscode.proposed.externalUriOpener.d.ts` is included the same way.
- [preview-src/tsconfig.json](preview-src/tsconfig.json) — webview, `DOM` lib. **esbuild picks
  this tsconfig up automatically** based on the entry point's location; it does not need to be
  passed as a flag.

### esbuild

[esbuild.webview.mts](esbuild.webview.mts) is self-contained and runs directly (Node executes
`.mts` natively, no transpile step). Two of its options are mandatory and both are
non-obvious:

- `format: 'iife'` — the script is loaded by a plain `<script src>` **without**
  `type="module"`. An ESM bundle simply will not execute in the panel.
- `loader: { '.ttf': 'dataurl' }` — otherwise the icons do not render, because the CSP only
  allows `font-src data:`.

`minify` is on for production builds and off in watch mode; sourcemaps are always emitted.

### Why `engines.vscode` is 1.85

The floor is deliberately lower than what the features need, and the gap is the point.

- **`externalUriOpener`** has been a proposal since VS Code 1.53 and its `.d.ts` is byte-for-byte
  the same at 1.85 as it is today (modulo three `export` keywords). Nothing here constrains the
  floor.
- **`browser` is far newer.** `vscode.proposed.browser.d.ts` was added to microsoft/vscode on
  2026-03-13 and first shipped in **1.112.0** — the tag 1.111.0 has no such file. So everything
  built on the built-in browser (element commands, screenshots, the MCP browser tools) needs
  **1.112.0 or later**, whatever `engines` says.

Below 1.112 the extension still loads and still works, as the webview panel. VS Code logs
`Extension … wants API proposal 'browser' but that proposal DOES NOT EXIST` and drops it from
the list — an error in the log, not a failed activation — and every entry point guards with
`'browserTabs' in vscode.window` before touching the API. The same is true of
`contributes.mcpServerDefinitionProviders` (a contribution point since 1.101) and of
`lm.registerMcpServerDefinitionProvider`, which is reached through an optional call precisely so
an older host just gets nothing.

What actually holds the floor at 1.85 rather than lower: `vscode.l10n` (1.73), `window.tabGroups`
(1.67), implicit command activation (1.74). 1.85 is a round number comfortably above all three,
and `@types/vscode@1.85.0` typechecks the whole tree with zero errors — verified by installing it
and running `npm run typecheck`.

The trade-off is honest to state: a 1.85 floor means someone on an old VS Code can install this
and find the headline feature missing. Raising `engines` to `^1.112.0` is the alternative, and
the only reason not to is reach.

### Proposed API

The manifest declares `enabledApiProposals: ["externalUriOpener", "browser"]` — the first for
`vscode.window.registerExternalUriOpener`, the second for the built-in browser and CDP (see
[the main approach](#how-we-build-features--the-main-approach)). Consequences:

- Both [vscode.proposed.externalUriOpener.d.ts](vscode.proposed.externalUriOpener.d.ts) and
  [vscode.proposed.browser.d.ts](vscode.proposed.browser.d.ts) are **checked into the repo** so
  the build works offline, and both are listed in `tsconfig.json`'s `include`. Refresh them
  with `npm run download-api`.
- Launching requires the `--enable-proposed-api=DenysDavydov.tab-browser-ultimate` flag (the
  extension id is `publisher`.`name`, so it follows the slug, not the display name), which is set in
  [.vscode/launch.json](.vscode/launch.json). Without it, activation fails on
  `registerExternalUriOpener`.
- An extension using proposed API **cannot be published to the Marketplace** — it can only be
  distributed as a VSIX, or the code has to move to stable API.

### Debugging (F5)

[.vscode/launch.json](.vscode/launch.json) holds an `extensionHost` configuration. Its
`preLaunchTask` is the one-shot `npm: compile`, **deliberately not `watch`**: watch runs through
`run-p`, which prefixes output (`[watch-ext    ] ...`), so the standard `$tsc-watch` problem
matcher never recognises the tsc lines and the task hangs forever on "waiting for the build to
finish".

The working setup: `npm run watch` in a terminal for incremental rebuilds, plus F5 to
launch/relaunch the Extension Development Host.

## The `browser` proposed API — the main way to add features

`aiBrowser.useIntegratedBrowser` defaults to **true**: URLs open in VS Code's built-in browser,
and the webview panel is the opt-in path. The built-in browser is reachable from an extension
through the `browser` API proposal
([vscode.proposed.browser.d.ts](vscode.proposed.browser.d.ts), microsoft/vscode#300319):

- `window.browserTabs`, `window.activeBrowserTab`, `window.openBrowserTab(url)`, plus open /
  close / active-change / state-change events;
- `BrowserTab.startCDPSession()` — a full Chrome DevTools Protocol channel.

CDP is the important half. Reading the DOM, finding text, screenshots, evaluating script in
the page, element inspection — all of it is a CDP call, because that is exactly how the
built-in browser implements its own features.

Two things to know before writing against it, both handled by
[src/cdp.ts](src/cdp.ts):

- **The channel is browser-level**, the same shape as attaching to Chrome's browser websocket.
  Commands aimed at the page do nothing until you `Target.attachToTarget` (`flatten: true`)
  and pass the resulting `sessionId` on every message — `CDPClient.attachToPage()`.
- **`sendMessage` is fire-and-forget**, and every reply for every in-flight command arrives on
  one `onDidReceiveMessage`, so correlating by `id` is on us.

We declare two proposals now (`externalUriOpener`, `browser`). That does not change the
distribution story, which was already VSIX-only, but proposed APIs break without notice: if
the extension stops activating after a VS Code update, run `npm run download-api` and check
both `.d.ts` files.

### The dropdown on the browser tab

One toolbar button on the browser tab opens a dropdown holding **everything the extension
does** — the three element commands, then the three MCP ones. Two `group` prefixes
(`1_copy@n`, `2_mcp@n`) put a separator between them; ordering comes from the `@n` suffix, not
from the position in the `contributes.menus` array.

There is no activity bar panel any more. It was a `TreeDataProvider` in `src/toolsView.ts`, and
it went away when the same commands landed in this dropdown; `media/activity-icon.svg` went
with it. One consequence worth knowing: the dropdown is gated on
`activeEditor == 'workbench.editor.browser'`, so **Connect Claude Code / Connect Codex / Check
Connection are only reachable from a browser tab** — or from the command palette, where every
command still appears.

It is a `contributes.submenus` entry (`aiBrowser.elementMenu`) placed into `editor/title`;
`editor/title` allows submenus because `menusExtensionPoint.ts` leaves `supportsSubmenus` at
its default of `true`. **The `icon` on the submenu declaration is what makes it a toolbar
button** — without one it collapses into the tab's overflow menu.

That icon is a plain globe, `media/icons/globe-{light,dark}.svg`, filling the box (`r=6.9` in a
16×16 viewport). It is "white" in the sense that matters: literally `#FFFFFF` on dark themes and
near-black on light ones, since a literal white in both would be invisible on a light theme.

**Removed on request:** per-assistant dots in the corners (orange for Claude Code, teal for
Codex). Do not reintroduce them without being asked. They needed one submenu declaration per
combination — a submenu's icon is static in `contributes`, so nothing can be recoloured at
runtime — which meant the twelve-item list appeared four times in `contributes.menus`, all
copies obliged to stay identical.

What survived from that work, because it is useful on its own: the server attributes calls to an
assistant. Only `initialize` carries `clientInfo.name` (`classifyClient` matches it) and every
later `tools/call` is anonymous, so the server mints an `Mcp-Session-Id` at initialize, returns
it in the response header, and maps it to the client kind; clients echo the header. `Check
Connection` reports who has called in the last 10 minutes, which answers "is anything actually
using this?" — a question the config states cannot. Freshness is computed on read, so there is
no timer.

**The element icons are custom SVGs, not codicons, and they have to be.** A codicon is a font
glyph that VS Code recolours, so any colour baked into one is lost. A custom SVG is drawn as a
`background-image` and keeps its own fills — but by the same token it cannot inherit
`currentColor`, which is why everything here ships as a light/dark pair.

**Each element icon encodes two things at once**, so the grid is 3 × 3 —
`media/icons/crosshair-<dot>[-<destination>]-<theme>.svg`, eighteen files:

| kind → dot | destination → ring |
|---|---|
| element: red `#E03131` | Copy: theme grey |
| CSS path: blue `#1971C2` | Claude Code: yellow — `#FFD43B` dark, `#A16207` light |
| XPath: green `#2F9E44` | Codex: blue-white — `#C5F6FA` dark, `#0E7490` light |

The same kind keeps its dot across destinations; the same destination keeps its ring across
kinds. As with the globe, the light variant of each ring is that hue taken down to something
readable — a pale yellow or a blue-white is invisible on a white background.

**`npm run check-manifest` guards all of this**, because none of it produces a compile error:
a menu item pointing at a missing command, a command with no activation event, an icon path
with a typo, an icon file nobody references, two primary buttons sharing a `lastElementAction`,
and this grid losing its shape. Run it after touching `package.json` or `media/icons`.

**The primary button is a faked split button.** VS Code has the real thing —
`isSplitButton: { togglePrimaryAction: true }` on a submenu item, rendered by
`DropdownWithDefaultActionViewItem`, which even persists the last action under
`${submenu.id}_lastActionId` — and the built-in browser uses it for its own "Add to Chat"
button. Extensions cannot: `menusExtensionPoint.ts` builds an extension's submenu item as
`{ submenu, icon, title, group, order, when }` and never sets that flag, and the manifest
schema accepts only `submenu` / `when` / `group`.

So instead: **nine** primary buttons in `navigation@2` — the three copies plus the same three
for each assistant — each with a `when` on the `aiBrowser.lastElementAction` context key, so
exactly one is ever visible. The dropdown sits *before* them in `navigation@1`. The Add buttons
carry the extra condition `aiBrowser.claudeInstalled` / `codexInstalled`, or a remembered action
would leave the toolbar with no primary button at all once the assistant is uninstalled.

The nine action ids (`element`, `cssPath`, `xpath` and `<assistant>:<kind>`) are compared
verbatim in `when` clauses, which makes them **part of the manifest's contract** — renaming one
in `lastAction.ts` alone silently removes a button. Add commands reuse the crosshair colour of
the matching Copy command, so the button looks the same whichever destination it repeats. [src/lastAction.ts](src/lastAction.ts)
keeps the context key and a memento in step — the memento because a context key does not
survive a restart. Each command records itself before running, in `extension.ts`.

`onStartupFinished` is in `activationEvents` **for this to work at all**: `when` clauses are
evaluated before activation, so without it the context key is unset on a fresh window and the
toolbar shows a lone chevron with no primary button. Two visually adjacent buttons is as close
as an extension gets — they are not fused into one control the way Run/Debug is.

**One chord drives whichever tool is active:** `Ctrl+Alt+C` / `Cmd+Alt+C`. Since the nine
`when` conditions are mutually exclusive, exactly one binding can match, so the key always runs
what the right-hand icon shows.

**The chord sits on nine `repeat.*` delegate commands, not on the commands in the dropdown**,
and that split is not decorative. VS Code prints a command's keybinding beside **every** menu
item that invokes it, with no way to opt out — so binding the dropdown commands directly put
`Cmd+Alt+C` on nine rows of the menu. Each delegate shares its twin's icon and title, is the
one contributed to `editor/title`, and is hidden from the command palette with
`commandPalette` + `when: false` so the same nine actions do not appear twice there.

`check-manifest` holds this together: one chord across the nine, conditions matching the
buttons exactly, no dropdown command carrying a keybinding, and every delegate mirroring its
twin's icon. A drifted `when` would otherwise leave the key firing nothing, or two tools at
once — verified by temporarily adding a bad binding and watching it fail.

Why this chord, after checking the VS Code sources for what is actually taken: `Cmd+Shift+C` is
out because one of its holders is scoped `TerminalContextKeys.notFocus`, which is true in a
browser tab, so it would collide with "Open New External Terminal" exactly where we need it.
`Cmd+Alt+X` is the only mnemonic-adjacent chord with *zero* occurrences in the whole repository,
but X means nothing here. `Cmd+Alt+C` is mnemonic (the whole feature copies things), and its
existing holders are scoped to comments, chat, search and editor focus — none of which apply in
a browser editor. Every binding is also scoped to `activeEditor == 'workbench.editor.browser'`,
so it is inert everywhere else.

**The `when` clause is the easy thing to get wrong.** It must be
`activeEditor == 'workbench.editor.browser'`. The `activeEditor` context key holds the *editor
(pane)* id — `BrowserEditorInput.EDITOR_ID`, i.e. `BrowserViewEditorId` from
`browserView.ts` — and **not** `workbench.editorinputs.browser`, which is
`BrowserEditorInput.ID`, the *input type* id. They sit two lines apart in
`browserEditorInput.ts`, and picking the wrong one produces a button that simply never appears,
with no error anywhere.

### The three element commands

All in [src/elementPicker.ts](src/elementPicker.ts), all sharing `withPickedElement`:

| Command | Output |
|---|---|
| `aiBrowser.copyElement` | the full Markdown context, matching the built-in browser's "Add Element to Chat" |
| `aiBrowser.copyElementCssPath` | `#main > div > li:nth-of-type(2)` |
| `aiBrowser.copyElementXPath` | `//*[@id="main"]/span` or `/html/body/ul/li[2]` |

The CSS path deliberately leaves classes out. Utility-class frameworks produce long, unstable
class lists, and a selector built from them reads worse and breaks sooner than a positional
one; the full class list is in "Copy Element" for anyone who wants it.

**Copy Element goes to the clipboard as text, and stays that way.** An attach-as-file route
was built and removed on request: it wrote the Markdown to `globalStorageUri` and passed the URI
to `workbench.action.chat.attachFile`. Do not rebuild it without being asked. Worth keeping from
that detour: **`vscode.env.clipboard` is text-only** — there is no API for putting a *file* on
the system clipboard, so "paste attaches a file" is unreachable without shelling out to the OS,
and `attachFile` accepts only `file` / `vscode-remote` / `untitled` URIs.

**Element picking is single-flight, and has to be.** Each pick opens its own CDP session and
turns on inspect mode. Two at once means a single click delivers
`Overlay.inspectNodeRequested` to *both* sessions, both commands run to completion, and the
later one overwrites the clipboard — which the user sees as "sometimes it copies an action I did
not choose". `pendingPick` in [src/elementPicker.ts](src/elementPicker.ts) cancels any pick
already in flight, so the latest choice wins. Related: clearing inspect mode belongs in
`finally`, because on cancellation the `await` throws and a statement placed after it never
runs — leaving the page stranded in picking state.

**The Markdown format is a port, not an invention.** `renderElementMarkdown` follows
`createElementContextValue` / `formatElementPath` from `browserEditorChatFeatures.ts`, and
`extractElementData` follows `extractNodeData` from `browserViewFrameInspector.ts`. The CSS
section — matched rules, `/* Inherited */`, `/* Resolved values */`, `/* CSS variables */`, the
`/*UA*/` marker — is produced by [src/cssHelpers.ts](src/cssHelpers.ts), which is upstream code
copied **verbatim** (616 lines, zero imports). That is what keeps our output identical to the
built-in browser's. Its upstream test suite came along as `src/cssHelpers.test.ts` and is its
specification; re-sync the two together rather than editing either in place.

The element itself is the **last** entry of `ancestors`, which is why `Element:` and the tail of
`HTML Path:` are always the same string.

### Element picker

`aiBrowser.copyElementXPath` ([src/elementPicker.ts](src/elementPicker.ts)) turns on
`Overlay.setInspectMode` — the same mechanism behind the built-in "Add Element to Chat", so
hover highlighting comes free — waits for `Overlay.inspectNodeRequested`, resolves the backend
node, and runs an XPath builder through `Runtime.callFunctionOn`. Inspect mode is switched off
before anything that can throw, or the page is left stuck in picking state.

The XPath builder prefers a **unique** `id` as its anchor and walks up only that far, and adds
a positional predicate only when a tag actually repeats among its siblings. Duplicate ids are
detected and rejected as anchors — anchoring on one would produce a path pointing at the wrong
element.

### Recipe for the next feature

1. Add the command to `contributes.commands` **and a matching `onCommand:` to
   `activationEvents`** — see the entry in
   [Things that break silently](#things-that-break-silently).
2. For a button on the browser tab, put it in the `aiBrowser.elementMenu` submenu (see
   [The dropdown on the browser tab](#the-dropdown-on-the-browser-tab)) rather than adding
   another `editor/title` entry — one dropdown beats a row of icons.
3. Guard twice, with different messages: `'browserTabs' in vscode.window` (proposal missing,
   or launched without the flag) and `vscode.window.activeBrowserTab` (nothing open). The
   fixes are unrelated, so one message would send people the wrong way.
4. `new CDPClient(await tab.startCDPSession())` → `attachToPage()` → `client.send(method,
   params, sessionId)`. Enable the domains you use (`DOM.enable`, `Overlay.enable`, …) first.
5. Undo anything that changes page state before any step that can throw, and
   `client.dispose()` in a `finally`.
6. Long interactions get `withProgress({ cancellable: true })`, with the token passed to
   `client.once(...)` so cancelling actually unblocks it.

Pure logic is worth testing outside VS Code — `npm test` needs no VS Code instance — but that
imposes a real constraint, learned the hard way:

**A module that `npm test` loads directly must have no relative *value* imports.** Node's type
stripping resolves neither an extensionless specifier nor a `.js` one to a `.ts` file, and the
`.ts` specifier that Node *does* accept is rejected by an emitting tsconfig. So test files use
explicit `.ts` imports and live in their own no-emit project
([tsconfig.test.json](tsconfig.test.json)); `tsconfig.json` excludes `**/*.test.ts` so they
never reach `out/` and never ship in the VSIX. This is why `elementMarkdown.ts` was split out
of `elementContext.ts` — the renderer is testable precisely because it imports nothing.
`import type` is fine anywhere; it is erased.

## MCP: the browser exposed to Claude Code, Codex and VS Code chat

The dropdown's three assistant entries (Connect Claude Code, Connect Codex, Check Connection)
sit on top of a local MCP server. Server name, everywhere: **`ai-browser`**
([src/mcpClientState.ts](src/mcpClientState.ts) owns the constant).

### Layers

```
MCP client (Claude Code / Codex / VS Code chat)
   │  HTTP POST, JSON-RPC 2.0, Bearer
   ▼
McpServer          src/mcpServer.ts       transport, auth, tool registry
   │  ▲ src/mcpProtocol.ts — dispatch and the auth decision, no vscode, under test
   ▼
BrowserController  src/browserController.ts   what the browser can do
   ▼
CDPClient → the integrated browser
```

`BrowserController` is the **only** place where "no tab is open" becomes a sentence a model can
act on. It throws `Error`; `dispatch` reports the message as `isError: true`. The transport
knows nothing about tabs, and the controller knows nothing about JSON-RPC.

### Why there is no SDK

The MCP SDK is deliberately unused: this is a handful of methods over one POST, and the SDK
would be more surface area than the feature.

### The security model — four rules, and none works alone

1. **Loopback only** — `listen(port, '127.0.0.1')`.
2. **Any request carrying `Origin` is refused with 403, before its credentials are looked at.**
   A page cannot *read* a cross-origin response, but issuing the request is already enough to
   drive the browser.
3. **The token is per workspace, not per user** — `mcp.token:<folderUri>` in `globalState`.
   Ports are handed out in the order windows open, so project A's config can address the window
   holding project B; a workspace-scoped token makes that an honest 401 instead of an agent
   quietly editing the wrong project.
4. **POST on one endpoint.** There is no SSE stream, so GET is 405. The token is accepted as
   `Authorization: Bearer …` **or** as the last path segment. The path form is no longer written
   by anything here — Codex turned out to accept a static header after all — but it stays
   accepted, because configs written before that discovery still use it.

All four live in `authorizeRequest` in [src/mcpProtocol.ts](src/mcpProtocol.ts), away from
`http`, so they are covered by tests rather than by inspection.

Other transport details that are load-bearing: the body is capped at 1 MB; the handler is
wrapped so nothing escapes (a client that never gets a response waits forever); `server.on
('error', () => {})` is attached *after* a successful `listen`, or a late socket error becomes
an uncaught exception in the extension host; live sockets are tracked so `dispose()` can
destroy them, because a keep-alive connection otherwise keeps the port when the setting is
switched off. `start()` walks 20 ports from the preferred one, treating **only** `EADDRINUSE`
as "try the next".

### Protocol details that bite

- **Notifications get 202 with an empty body.** Answering `notifications/initialized` breaks
  the handshake.
- **`initialize` echoes the client's `protocolVersion`**; strict clients abandon a handshake
  that answers with a different one.
- **A tool's failure is a result, not a protocol error.** `{ isError: true }` is something the
  model reads and can recover from; a `-32603` never reaches it.
- Batches and bare arrays are refused rather than half-supported.
- `browser_navigate` refuses anything but http/https. Otherwise an agent points the browser at
  a local file and reads it back with `browser_text` — a browser tool turned into a file reader.

### Three clients, three places to configure

| Client | Where | How |
|---|---|---|
| VS Code chat | nowhere | `lm.registerMcpServerDefinitionProvider`, reached through a cast so `engines.vscode` need not move; **the `McpHttpServerDefinition` constructor is positional** — an options object does not work |
| Claude Code | `.mcp.json` in the project | `{ type, url, headers.Authorization }` |
| Codex | `.codex/config.toml` in the project, or `~/.codex/config.toml` | `[mcp_servers.<name>]` with inline `http_headers` |

**Codex offers both files, project first.** The primary button writes the project's
`.codex/config.toml`; the global `~/.codex/config.toml` is the second button. That order is a
deliberate choice — the project file keeps the server with the project — but the trade-off is
real and belongs in the dialog text: **a project config is only loaded for projects Codex
trusts**, and the desktop surface has been reported to ignore it outright
([openai/codex#13025](https://github.com/openai/codex/issues/13025)), whereas
`~/.codex/config.toml` is read on every surface, always. That is the usual reason Codex "cannot
see the server", so the global button exists as the fix and the messages point at it.

The global entry is named per project (`ai-browser-<slug>-<sha1[0:6]>`); the project entry uses
the bare `ai-browser`, since a project file has only one project.

**Codex does take a static `Authorization` header** — `http_headers`, alongside
`env_http_headers` and `bearer_token_env_var`
([docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)). An earlier note here claimed
it could only *name* a token, which is why the token used to ride in the URL; that was wrong.
We now write `http_headers = { Authorization = "Bearer …" }` as an **inline** table — a
`[mcp_servers.<name>.http_headers]` sub-table would be a second table, and replacing ours by
line range would orphan it. The token-in-URL form is still *accepted* when reading, since
existing configs have it, and a stale sub-table of ours is removed on write.

**Neither assistant re-reads its config.** Both load MCP servers at startup: Claude Code needs
a restart, Codex a brand-new conversation. This is why the connection prompt names the *tools*
and never tells the model to go and read `config.toml` — a model sent to read the file will
confirm the server is configured and still have no tools, which is precisely what made Codex
look stupid.

**A broken `.mcp.json` is never overwritten.** `readClaudeConfig` returns `{}` for absent,
the object for parsed, and `undefined` for unparsable — and on `undefined` the write is
abandoned, because rewriting it would delete every other MCP server the project has.

One shared global name would let the second project overwrite the first, hence the hash.
`codex mcp add` is still offered as a command for anyone who would rather not have a file
edited. The global write is **not** locked — unlike a repair on startup it happens on a button
press, so two windows would have to be clicked at the same moment.

### The mini TOML parser

[src/codexToml.ts](src/codexToml.ts) is not a TOML parser — it is exactly as much of one as the
two readers (checking, and replacing our table) need, and **they must agree on where a table
starts and ends**. `endLine` stops after the last key rather than at the next header, so a
comment above the neighbouring table is not swallowed into ours.

`scanLine` is the core, and every case it handles was a real failure: `#` inside a string is
not a comment; `[` inside a string does not open an array; `enabled_tools = [` left open means
following lines are continuation; triple quotes inside a *literal* string open nothing; four or
five closing quotes still close once. A naive quote count got this wrong in both directions —
our table became invisible and connecting wrote it a second time, which is TOML that does not
parse at all.

**`code` versus `text`.** `scanLine` returns both, and the distinction is not cosmetic: `code`
has string contents removed and answers structural questions; `text` is the line minus a real
comment and is what values and quoted table names are parsed from. Using `code` for values
reads every setting as empty.

### Checking

[src/mcpCheck.ts](src/mcpCheck.ts) does both halves, because a listening server proves nothing:
a real `tools/list` over loopback with the token, plus each client's config state. States are
ordered worst-last — `thisServer`, `staleToken`, `otherServer`, `disabled`, `none` — and a file
with several entries is judged by its best one. `staleToken` earns its own state because it is
the common accident: `.mcp.json` copied from another project, right URL, wrong token, and the
symptom is a bare 401 that reads like a broken server.

Duplicate Codex entries are **reported, never repaired**: the global file is not ours, and
removing the wrong one of a pair turns working tools into a 401.

### The server is per window; the tools follow the active tab

Deliberate, and asked about — leave it alone unless someone asks for the other behaviour.

The token and port belong to the **workspace**, so "connecting" attaches an assistant to this
VS Code window. But `BrowserController._requireTab()` resolves
`vscode.window.activeBrowserTab` on **every call**, so a tool acts on whichever browser tab is
focused at that moment, not on the tab whose dropdown was used to connect. With two tabs open,
switching between calls sends the next `browser_click` to the other page; `browser_navigate`
always opens a new tab.

Pinning the controller to one tab at connect time is the obvious alternative (with
`browser_state` reporting which tab it is bound to, and a clear error once that tab is closed).
It was considered and postponed. Until then, describe the behaviour as "attached to a VS Code
window, acting on the active browser tab" rather than "connected to a browser tab".

### Lifecycle

[src/mcpLifecycle.ts](src/mcpLifecycle.ts) keeps the server's disposables **apart from
`context.subscriptions`**: switching the setting off must give the port back without tearing
down the extension. Restarts are serialised through a promise chain, or two setting changes in
a row race for the same port. Commands are registered unconditionally and go through
`withServer`, which explains why there is nothing to connect — better than "command not found".

## Handing reports to Claude Code and Codex

Six dropdown entries — element / CSS path / XPath, to each assistant — write a Markdown report
and hand it over. [src/assistants.ts](src/assistants.ts) owns the mechanics,
[src/reportFormat.ts](src/reportFormat.ts) the text (leaf module, under test).

**Neither extension has an API.** Both are driven through commands they register, and the two
are shaped differently enough that there is no shared path:

| | Claude Code | Codex |
|---|---|---|
| command | `claude-vscode.insertAtMention` | `chatgpt.addFileToThread` |
| arguments | **none** — it builds `@<path relative to the workspace>` from the *active editor* | the URI, directly |
| reports live in | `<folder>/.ai-browser/` | the temp directory |
| needs a folder | yes, with a `file` scheme | no |

Because Claude Code's command takes no arguments, the sequence is: write the file → open it →
`showTextDocument({ preview: true, preserveFocus: false })` → run the command → **close the tab
by URI**. By URI and not `closeActiveEditor`, because inserting the mention reveals the chat, so
the active tab at that moment is quite likely the chat itself.

A file in both cases, never text: `addFileToThread` discards anything whose scheme is not
`file`, and the agent reads the path from disk later, so a virtual document is no use. Even a
one-line selector travels as a file.

Every command id above is an implementation detail of somebody else's extension, not a
contract, so availability is checked as `getExtension(id)` **and**
`getCommands(true).includes(command)` — an older version may not register it — and every
refusal falls back to the clipboard with a message saying why. The same facts are published as
`aiBrowser.claudeInstalled` / `aiBrowser.codexInstalled` context keys, so the menu hides
entries that could not work; they are re-published on `vscode.extensions.onDidChange`.

`.ai-browser/` gets a `.gitignore` of `*` on first creation — these are drafts for one
conversation. Reports are swept after 5 hours, at most hourly from the write path plus once on
activation.

**Page content is always fenced with a fence longer than the longest backtick run inside it**
(`fenced` in `reportFormat.ts`). A page routinely contains backticks — a template literal in an
inline script, Markdown in a CMS preview — and a plain three-backtick fence closes early, after
which the rest of the report is read as Markdown.

### Copy Screenshot

Two dropdown entries — visible area and full page — in a group of their own (`2_shot`), which
is what puts a separator around them. Group names sort alphabetically, so the numeric prefixes
(`1_copy`, `2_shot`, `3_claude`, `4_codex`, `5_mcp`) are the running order of the whole menu.

Capturing is one CDP call, but two arguments matter:

- **`captureBeyondViewport`** is stated, never left to the default, which has moved between
  Chromium versions. `false` is the visible area.
- For a full page an explicit **`clip`** is passed, sized from `Page.getLayoutMetrics`
  (`cssContentSize`). `captureBeyondViewport: true` on its own is what produces the familiar
  half-captured screenshot — the capture stays bounded by the viewport unless the region is
  spelled out.

The clip height is capped at **16384 px**: past roughly that Chromium cannot allocate the
texture and returns a *blank* image rather than an error, so the capture is truthfully clipped
and the notification says so.

**The clipboard is the hard half.** `vscode.env.clipboard` is text only; there is no image
clipboard in the extension API. [src/clipboardImage.ts](src/clipboardImage.ts) shells out, and
the PNG is written to a temp file first — every platform tool wants a path, and the file is what
remains when the clipboard cannot be reached:

| Platform | Tool |
|---|---|
| macOS | `osascript -e 'set the clipboard to (read (POSIX file "…") as «class PNGf»)'` |
| Windows | PowerShell `-STA`, `[System.Windows.Forms.Clipboard]::SetImage` |
| Linux | `xclip -t image/png -i <file>`, then `wl-copy` from **stdin** on Wayland |

The macOS `«class PNGf»` coercion is not optional: without it the bytes land as generic data and
nothing pastes them as a picture. Verified on this machine — afterwards `clipboard info` lists
`«class PNGf»`, with TIFF/JPEG/GIF conversions offered for free.

`execFile` with an argument array, never `exec`, so the path never reaches a shell. In a remote
or web window the attempt is skipped: the extension host's clipboard belongs to another machine.
Screenshots are swept after 24 hours.

The same capture is the `browser_screenshot` MCP tool, with a `fullPage` flag — one tool rather
than two, since the only difference is that argument.

**Not part of the repeat button.** The nine `navigation@2` candidates are element actions; a
screenshot picks nothing, so folding it in would mean a button with no crosshair and a hole in
the icon grid `check-manifest` enforces.

### Not built yet

**Port repair** for configs written by an earlier session (`mcpRefresh`, with a filesystem lock,
since every window would repair its own entry in the one global file), and **plain-text
hand-over** — `claude-vscode.editor.open(undefined, prompt)` opens a new Claude Code
conversation with a prompt, but Codex has no equivalent, so reports go as files for both.

## Things that break silently

No compile error for any of these — they only surface at runtime.

1. **`format` other than `iife`** in esbuild → the panel script never runs, panel has no
   working controls.
2. **`.ttf` not loaded as `dataurl`** → CSP blocks the font, icons render as empty boxes.
3. **A `<script>` without a `nonce`** → blocked by CSP.
4. **`ai-browser-settings` id out of sync** between `aiBrowserView.ts` and
   `preview-src/index.ts` → `Could not load settings`, blank panel.
5. **`out/**` listed in [.vscodeignore](.vscodeignore)** → the VSIX builds but contains no
   extension code (`main` points into `out/`). The inherited `.vscodeignore` did exactly that,
   because the monorepo bundled into `dist/`. Fixed — do not reintroduce.
6. **A resource outside `media/`** → will not load; `localResourceRoots` only permits that
   directory.
7. **A command with no `onCommand:` activation event.** A `contributes.menus` button renders
   before the extension activates, so clicking it silently does nothing until the extension
   happens to be activated by something else — which makes it look like it works while you are
   developing. Implicit activation from `contributes.commands` needs `engines.vscode` at
   1.74 or later; every command here also gets an explicit `onCommand:` entry.
8. **Forgetting `npm run compile` after a clone** → `media/index.js` is not in git, panel is
   blank.

## Special cases and non-obvious decisions

The running log of quirks. **Append to this section whenever something turns out to be
non-obvious** — see [Conventions](#conventions). One entry per item: what it is, and why it is
that way, so nobody "cleans it up" and breaks it.

Several such decisions already have a natural home elsewhere in this file and are not repeated
here: the mandatory `iife` format and `.ttf → dataurl` loader are under
[esbuild](#esbuild), the CSP consequences under [Panel CSP](#panel-csp--the-main-constraint-when-extending),
the `preLaunchTask` choice under [Debugging (F5)](#debugging-f5), and the tsconfig `types`/`include`
interaction under [TypeScript configuration](#typescript-configuration).

- **`extension.ts` declares its own minimal `URL` class.** [src/extension.ts](src/extension.ts)
  has a local `declare class URL { … hostname: string }` instead of using a global. The base
  config's `lib` is `ES2022` only, with no `DOM`, so there is no ambient DOM `URL`. It is only
  used for `.hostname`, hence the two-member declaration. Removing it will not obviously fail
  in an editor that happens to resolve `URL` from `@types/node`, but it is load-bearing for the
  configured `lib`.

- **The IPv6 comment in `canOpenExternalUri` does not match the code.** The comment says "We
  have to replace the IPv6 hosts with IPv4 because URL can't handle IPv6", but nothing is
  replaced. What actually happens: `enabledHosts` contains the *bracketed* IPv6 forms
  (`[::1]`, `[::]`, …) because that is what `URL.hostname` returns for an IPv6 authority. The
  comment is stale; the bracket forms in the set are the real mechanism. Do not "simplify" them
  to bare `::1`.

- **`restore()` falls back to an empty URL.** `AIBrowserManager.restore()` does
  `state?.url ?? ''`, so a panel restored without serialized state navigates the iframe to an
  empty string. It is not a crash, but it looks like a blank browser rather than an error.

- **Text-grepping for a dependency name gives false negatives.**
  `@vscode/codicons` is referenced as `path.join(rootDir, 'node_modules', '@vscode', 'codicons', …)`
  in [esbuild.webview.mts](esbuild.webview.mts), so a `grep '@vscode/codicons'` finds nothing
  and the package looks unused. To audit dependencies, temporarily move the package out of
  `node_modules` and run `npm run compile && npm run typecheck` instead of trusting grep.

- **Node executes the build script directly.** `npm run build-webview` is plain
  `node ./esbuild.webview.mts` — Node 24 strips the types natively, so there is no transpile
  step and no build tooling for the build tooling. The consequence is that only erasable
  TypeScript syntax is allowed in that file: no `enum`, no `namespace`, and type-only imports
  must be written as `import type`.

- **`shouldUseIntegratedBrowser` defaults to the built-in browser.** All three entry points call
  `shouldUseIntegratedBrowser`, which originally returned `true` whenever the command
  `workbench.action.browser.open` existed. That command exists in every recent VS Code, so our
  own panel never opened at all and every change to it was invisible. It is now gated on
  `aiBrowser.useIntegratedBrowser`, which now defaults to **`true`** — the built-in browser is
  where features get built (see [the main approach](#how-we-build-features--the-main-approach)),
  and it is what the element picker attaches to. Setting it to `false` brings the panel back.

- **`preview-src/browserSearch.ts` is copied from microsoft/vscode** (MIT), from
  `src/vs/workbench/contrib/browserView/common/browserSearch.ts` at `1.134.0-1325-gaa7291eba7d`.
  It classifies address bar input as `url`/`query`/`unknown`/`empty` and builds search URLs.
  Three deliberate deviations from upstream, all recorded in the file header: `localize()` calls
  inlined as plain strings (no `vscode.l10n` inside the webview), `enum BrowserSearchEngineId`
  turned into a const object plus type alias, and an added exported `hasKnownScheme`.
  `preview-src/browserSearch.test.ts` is the upstream suite and, per upstream's own instruction
  in the header, *is the specification* — do not "fix" the parser to match Chromium more
  closely without updating it.

- **The copied enum had to go, because Node runs the tests.** `npm test` is
  `node --test preview-src/*.test.ts`, relying on Node 24's native type stripping — the same
  mechanism as `esbuild.webview.mts`. It only accepts erasable TypeScript, so an `enum` fails at
  runtime with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Anything reachable from a `*.test.ts` is
  under the same restriction as the build script: no `enum`, no `namespace`, `import type` for
  type-only imports.

- **The test spells out `./browserSearch.ts` in its import.** Node's type stripping resolves
  neither a `.js` specifier nor an extensionless one to a `.ts` file. Hence
  `allowImportingTsExtensions` in `preview-src/tsconfig.json`: without it `tsc --noEmit` rejects
  the exact import Node requires. Same reason the test uses
  `import * as assert from 'node:assert'` — a default import would need `esModuleInterop`,
  which the base config does not enable.

- **A scheme-less address gets `http` for localhost and `https` for everything else.**
  `addDefaultScheme` in `preview-src/index.ts` mirrors browser behaviour: a dev server on
  `localhost:3000` does not speak https, and localhost is what this extension mostly opens.
  Related trap — deciding "does this already have a scheme?" with a `^[a-z][a-z0-9+.-]*:`
  regex is wrong, because it also matches the host in `localhost:3000`. Use `hasKnownScheme`,
  which checks the prefix against the schemes the parser actually recognizes.

## Removed on purpose — do not reintroduce

- **A custom cursor while an element is being picked.** Two attempts, both dead ends, and the
  second one explains the first.

  The idea was `* { cursor: … !important }` injected into the page, which is exactly what VS
  Code's own browser does (`ElementPicker` in
  `vs/platform/browserView/electron-browser/preload-browserView.ts`). It never took. The
  reason is in `browserViewFrameInspector.startInspection`:

  ```ts
  const mode = this._isPaused && options.mode !== BrowserElementSelectionMode.Comment
      ? 'cdp' : 'preload';
  ```

  VS Code uses `Overlay.setInspectMode` **only when the debugger is paused**; the normal path is
  its own in-page picker, and the cursor style belongs to that picker.

  **The symptom, which is the fingerprint of this problem:** the crosshair *does* appear the
  moment the command starts, and then the instant you move over an element you get that
  element's cursor back — a hand over links, an I-beam over text. So the injected rule is
  applied and working; what happens is that the CDP inspect overlay starts tracking the pointer
  and takes the cursor over. That overlay is a separate document rendered by the browser
  process, so nothing injected into the page reaches it. Our element picking is built entirely
  on `Overlay.setInspectMode`, so there is no page-level rule that can win.

  Changing the cursor would therefore mean replacing the picker with our own in-page one:
  hover tracking, our own highlight, `Runtime.addBinding` to report the click. That trades
  DevTools-quality highlighting for a cursor, and was judged not worth it.

  Also learned on the way, and still true: **Chromium does not accept SVG as a cursor image**,
  and an unusable `url()` invalidates the whole declaration instead of falling through to the
  keyword after it — so `cursor: url(data:image/svg+xml…), crosshair` changes nothing at all.

- **The web/browser target** (`esbuild.browser.mts`, `tsconfig.browser.json`, the `browser`
  manifest field, the `*-web` scripts) — this extension is desktop-only. The `isWeb()` helper
  in `extension.ts` remains but always returns `false` on desktop.
- **gulp** — replaced by plain `tsc`. The old scripts referenced the monorepo's
  `../../build/gulpfile.extensions.mjs`.
- **`@vscode/extension-telemetry`** — was declared in `dependencies` but never imported
  anywhere in the code. No telemetry is sent.
- **`@types/vscode-webview`** — unused; `preview-src` declares its own `acquireVsCodeApi` with
  concrete types.
- **`contributes.menus.commandPalette` with `when: "isWeb"`** — once web support was dropped,
  this hid the command from the palette permanently. An entry without a `when` clause is
  redundant: commands from `contributes.commands` appear in the palette by default.

## Naming conventions

The `Simple Browser` → `AI Browser` rename follows these cases:

| Case | Used for |
|---|---|
| `AIBrowser` | Classes and types (`AIBrowserView`, `AIBrowserManager`, `AIBrowserSettings`) |
| `aiBrowser` | Command ids, settings section, `viewType`, activation events |
| `ai-browser` | Package `name`, DOM element id |
| `AI Browser` | User-visible strings (`displayName`, `category`, panel title) |

## Packaging a VSIX

`npm run package` → `tab-browser-ultimate.vsix`, which is **committed on purpose** — it is how
VS Code users install, the Marketplace being closed to an extension that declares API proposals,
so `*.vsix` is deliberately absent from `.gitignore`. Rebuild and commit it with any change that
ships. `vscode:prepublish` runs the full `compile` first, so the webview assets are always fresh
in the package. `--no-dependencies` is safe here precisely because there are no runtime
dependencies.

The release steps live in [PUBLISHING.md](PUBLISHING.md); what is non-obvious about them is
below.

Three things vsce insists on, each of which stopped the first attempt:

- **`@types/vscode` may not be newer than `engines.vscode`.** `engines.vscode` is `^1.85.0`,
  so `@types/vscode` is pinned to the exact `1.85.0` — a caret there would let a fresh install
  pull the latest typings and fail packaging. See
  [Why `engines.vscode` is 1.85](#why-enginesvscode-is-185) for what that floor does and does
  not promise.
- **A `repository` field is required** as soon as the README has relative links (ours points
  at this file). Without it packaging fails outright; the alternative is passing
  `--baseContentUrl`, which is worse because it has to be repeated on every invocation.
- **`@vscode/vsce` pulls in two packages with blocked install scripts** (`@vscode/vsce-sign`,
  `keytar`) under the npm 11 `allowScripts` policy. Leave them blocked — they are only needed
  for `vsce publish`, and `package` works without them.

The root [LICENSE](LICENSE) is MIT and carries **both** copyright lines — Microsoft's, for the
forked and copied code, and the project's own. That is the honest form for this repository.
It does not replace the per-file `Copyright (c) Microsoft Corporation … Licensed under the MIT
License` headers, which are still there on everything copied from vscode (`cssHelpers.ts`,
`browserSearch.ts`, the forked simple-browser sources). MIT requires that notice to travel with
the code, so **do not strip those headers** — the root LICENSE complements them rather than
standing in for them.

### Open VSX is the only registry, and that is the whole distribution story

`vsce publish` refuses an extension that declares `enabledApiProposals` — **but the refusal is
client-side and `--allow-all-proposed-apis` lifts it**, which is what `publish:vsce` passes. So
both registries are in play, and the listing on each
(`DenysDavydov.tab-browser-ultimate`, 0.3.17 on both) predates this rewrite. Two things to know:

- **Both publish scripts upload the committed `.vsix`** rather than repackaging, so the bytes in
  a registry and the bytes in the repository are the same. `ovsx` resolves its token as
  `-p` → `OVSX_PAT` → **the OS keychain** (an earlier `ovsx login` put one there, which is why
  nothing needs exporting on this machine and CI still does); the namespace has to be created
  once with `ovsx create-namespace`, and each registry refuses a version it already has, so
  `version` must move every time.
- **`publish:vsce` has never got through.** Two attempts died on
  `Request timeout: /_apis/gallery` with everything else in place — flag passed, PAT found,
  signing binary present, host answering a GET in 250 ms. It is the upload that stalls, so treat
  it as environmental until it succeeds from a plain terminal; do not "fix" it by editing the
  script.
- **VS Code installs the committed file** with "Extensions: Install from VSIX…". This is why the
  `.vsix` is tracked at all — see above.

Publishing does not grant the proposals: the editor still has to be new enough for the `browser`
proposal, and some builds only hand proposed APIs to an extension named with
`--enable-proposed-api DenysDavydov.tab-browser-ultimate`.

## Known issues, not yet fixed

- **No linter.** It was covered by shared infrastructure in the monorepo. There are tests:
  `npm test` runs Node's own runner over `preview-src/*.test.ts`, no VS Code needed.
- **Zero production dependencies, and it is worth keeping it that way.** `build-ext` is `tsc`
  without bundling, so `out/` contains no dependencies. `vsce` will pack `dependencies` into
  the VSIX automatically, but once heavy runtime dependencies appear, the right move is to
  bundle the extension host with esbuild.
- **npm 11 blocks postinstall scripts.** `esbuild` has one, hence the `allowScripts` block in
  `package.json`. After an esbuild version bump the approval has to be granted again
  (`npm install-scripts approve esbuild`), otherwise the binary is not installed.
