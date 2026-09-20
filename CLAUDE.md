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

This was worked out the long way. **Do not re-derive these ruled-out approaches:**

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
| `aiBrowser.mcp.port` | `43110` | first port to try; unset, each window derives its own from the folder URI within the 20 ports from here — see [The port moves](#the-port-moves-and-the-config-remembers-the-old-one) |
| `aiBrowser.searchEngine` | `google` | engine for the panel's address bar; `none` disables search |
| `aiBrowser.focusLockIndicator.enabled` | `true` | the panel's focus indicator |
| `aiBrowser.updateCheck.enabled` | `true` | watch the repository for a newer release |

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
- [src/proposedApi.ts](src/proposedApi.ts) — the one-click `browser` grant, and host detection
- [src/argvJson.ts](src/argvJson.ts) — surgical JSONC edits to `argv.json` (leaf, under test)
- [src/statusBar.ts](src/statusBar.ts) — the two status bar items and their menu
- [src/notify.ts](src/notify.ts) — confirmations, kept out of the notification area
- [src/notifyText.ts](src/notifyText.ts) — neutralising a page-supplied string for a notification (leaf, under test)
- [src/elementPicker.ts](src/elementPicker.ts) — the four element commands
- [src/elementContext.ts](src/elementContext.ts) — pulls element data out of the page over CDP
- [src/elementMarkdown.ts](src/elementMarkdown.ts) — renders that data as Markdown
- [src/cssHelpers.ts](src/cssHelpers.ts) — copied verbatim from vscode, builds the CSS section
- [src/reportFormat.ts](src/reportFormat.ts) — report text and file names (leaf, under test)
- [src/webUrl.ts](src/webUrl.ts) — turning typed input into an address (leaf, under test)
- [src/assistants.ts](src/assistants.ts) — handing reports to Claude Code and Codex
- [src/lastAction.ts](src/lastAction.ts) — which element command the toolbar button repeats
- [src/browserController.ts](src/browserController.ts) — what the browser can do, for MCP
- [src/shareRegistry.ts](src/shareRegistry.ts) — who works on which tab (leaf, under test)
- [src/shareIndicator.ts](src/shareIndicator.ts) — the share glyphs, and reading a marker an older build wrote (leaf, under test)
- [src/mcpProtocol.ts](src/mcpProtocol.ts) — JSON-RPC dispatch and the auth decision (leaf, under test)
- [src/mcpPort.ts](src/mcpPort.ts) — which port a window tries first (leaf, under test)
- [src/mcpRepair.ts](src/mcpRepair.ts) — correcting a stale entry in a client config (leaf, under test)
- [src/fileLock.ts](src/fileLock.ts) — the cross-process lock on the global Codex config
- [src/mcpServer.ts](src/mcpServer.ts) — HTTP transport, tools, client attribution
- [src/mcpSetup.ts](src/mcpSetup.ts) — client config writing and the connect dialogs
- [src/mcpCheck.ts](src/mcpCheck.ts) — the Check Connection report
- [src/mcpClientState.ts](src/mcpClientState.ts) — config states (leaf, under test)
- [src/codexToml.ts](src/codexToml.ts) — the mini TOML table parser (leaf, under test)
- [src/mcpLifecycle.ts](src/mcpLifecycle.ts) — server lifetime and context keys
- [src/updateVersion.ts](src/updateVersion.ts) — comparing two versions (leaf, under test)
- [src/updateCheck.ts](src/updateCheck.ts) — the release watch and its one notification

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

**Unused code:** the webview handles a `{ type: 'focus' }` message that the extension never
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
publish:ovsx             package && ovsx publish …                ← Open VSX, needs OVSX_PAT
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
`isBrowserApiGranted()` before touching the API. The same is true of
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
- **A hand-installed VSIX needs the same flag, and F5 does not cover it.** `launch.json` only
  grants the proposals inside the Extension Development Host. In a normal window the extension
  is just an installed extension, so VS Code clears its proposal list and logs
  `Extension 'DenysDavydov.tab-browser-ultimate' CANNOT use API proposal: browser. Its
  package.json#enabledApiProposals-property declares:  but NOT browser.` — the empty "declares"
  is the fingerprint: the manifest is fine, the *grant* is missing. The persistent fix is
  `"enable-proposed-api": ["DenysDavydov.tab-browser-ultimate"]` in `argv.json`
  (`~/.vscode/argv.json`, Preferences: Configure Runtime Arguments), followed by a **full quit**
  — Reload Window is not enough, the flag is read at process start.
- An extension using proposed API **cannot be published to the Marketplace** — it can only be
  distributed as a VSIX, or the code has to move to stable API.

### Forks of VS Code — measured, 2026-09-09

`enabledApiProposals` plus `argv.json` is **not** enough on a fork, and the two failure modes
look identical from the outside (no toolbar icons, nothing on the clipboard) while having
nothing in common. Audited by reading the shipped bundles, not by guessing:

Seven measured, and only three work. Theia is audited separately, below the table — it has none
of these paths.

| | VS Code 1.137 | VSCodium 1.135 | Devin 1.126 | Cursor 3.19.19 | Antigravity 1.107 | Kiro 1.0.437 |
|---|---|---|---|---|---|---|
| `browser` in `allApiProposals` | yes | yes | yes | **no** | no | **no** |
| `browserTabs` in extHost | yes | yes | yes | **no** | no | **no** |
| upstream `browserView` contrib | yes | yes | yes | **no** | no | **yes** |
| editor id (our `when` clause) | `workbench.editor.browser` | same | same | `…browserEditor` | — | **same** |
| open command | `workbench.action.browser.open` | same | same | `…openBrowserEditor` | — | **same** |
| `dataFolderName` (`argv.json`) | `.vscode` | `.vscode-oss` | `.devin` | `.cursor` | `.antigravity-ide` | `.kiro` |

Two more measured and unsupported, both cleanly: **Trae 1.107.1** (base 1.107, so it predates
the proposal — 169 proposals, nothing browser-related at all, `dataFolderName` `.trae`) and
Antigravity IDE, the same shape.

**Theia IDE 1.75 is not a VS Code build**, and it is the one host that has to be audited
differently: no `product.json` at `appRoot`, no `out/vs/...` tree, everything inside a 91 MB
`app.asar` (grep it with `grep -a`). Markers: zero `browserTabs`, zero `startCDPSession`, zero
`workbench.action.browser.open`, zero `vscode.proposed.browser` — while `enabledApiProposals`
appears 44 times, so it implements the *mechanism* for plugin proposals without carrying this
one. Being a re-implementation rather than a fork, there is no version it could rebase onto.

It is classified correctly, and by the **fallback**: with no `out/vs/...` bundle to read,
`hostShipsBrowserApi` returns `undefined` and the command proxy decides — no browser command,
so `unsupported`. That is the fallback earning its place rather than a lucky guess.

Theia also exposed a real defect in `hostInfo`. With no `product.json` the `dataFolderName`
guess is `.vscode`, which on that machine is the **real VS Code's** directory — so the
"unsupported" dialog read a foreign `argv.json` and was about to advise removing an entry from
another editor's configuration. Hence `HostInfo.resolved`: the note is only shown when the path
came from a `product.json` we actually read. Nothing was ever written there, since an
unsupported host is never written to; the leak was the sentence.

**Kiro is the interesting row**: the only host measured that has the browser UI and the commands
but not the API. It is why detection reads the extension host bundle rather than probing for a
command — see
[Enabling the grant in one click](#enabling-the-grant-in-one-click).

**Devin works** — confirmed on 1.126.0. It is Windsurf-derived (`windsurf.browserFeatureEnabled`
context keys are still in the bundle) but carries the upstream browser whole: the proposal, the
full extHost API, the same editor id, the same open command. Its proposal list differs from VS
Code's by five names, none of them ours. The version tested there first was **0.3.17**, the
pre-rewrite proxy build with none of these features — the log gave it away, activating on
`onWebviewPanel:tabBrowser.view`, an old viewType.

Devin still needs the grant, exactly as VS Code does, and **from its own
`~/.devin/argv.json`** — it is not in the host's `product.json`
`extensionEnabledApiProposals`, so `argv.json` is the only route. That per-fork path is the
reason [src/proposedApi.ts](src/proposedApi.ts) reads `dataFolderName` instead of hard-coding
`.vscode`.

**VSCodium works, but not by itself** — measured on 1.135.06055: the proposal, the extHost API,
the upstream editor id and the open command are all present, which is what the OSS rebuild of
the same source should look like. It still needs the grant like every other host; its log repeats
`CANNOT USE these API proposals 'externalUriOpener, browser'` until it has one. **No measured
editor grants the proposal on its own**, so there is no "works out of the box" tier — the only
grant-free path is extension development mode.

Worth knowing because it misleads: VSCodium ships a working browser of its own, so a page opens
and its own element selection works while ours refuses. That looks like "the extension works
here" when nothing of ours is running, and our refusal *toast* then pauses that browser (see
[A notification pauses the built-in browser](#a-notification-pauses-the-built-in-browser)) —
which reads as a bug in our picker.

Two caveats on that row. Its `dataFolderName` is **`.vscode-oss`**, so the grant goes
in `~/.vscode-oss/argv.json` — a hard-coded `.vscode` would have written a file it never reads.
And its minifier inlines command ids, which is the reason the prefix grep below exists in two
spellings.

**Cursor cannot work, and no setting changes that.** `--enable-proposed-api` only grants
proposals the host *has*, and Cursor's `allApiProposals` is a divergent snapshot — 150 entries
against VS Code's 179, missing 45 of them, plus 17 of its own (`cursor`, `cursorAgentHost`,
`control`, …) — with no `browser` among them, despite `product.json` claiming
`vscodeVersion: 1.128.0`. The renderer log says so directly:
`wants API proposal 'browser' but that proposal DOES NOT EXIST`. Activation still succeeds and
`externalUriOpener` still works; only that one proposal is dropped.

Cursor ships its **own, unrelated** browser: input `workbench.input.browserEditor`, editor
`workbench.editor.browserEditor`, commands `workbench.action.openBrowserEditor` /
`newBrowserTab` / `reloadBrowserTab` / `focusBrowserLocationBar`, and its patched built-in
`simple-browser` delegates to that instead of the upstream command. None of it reaches
extensions — there is no `browserTabs`, no `activeBrowserTab`, no CDP of any kind in
`extensionHostProcess.js`, and `cursor-browser-automation` contributes zero commands while
using internal-only proposals. So both symptoms follow: `activeEditor ==
'workbench.editor.browser'` never matches, hence no icons, and every element or screenshot
command stops at the `isBrowserApiGranted()` guard, hence an empty clipboard.

**Do not "fix" Cursor by adding `workbench.editor.browserEditor` to the `when` clauses.** The
icons would appear and every one of them would fail on the guard — a worse result than no
button. Cursor is a webview-panel host (`aiBrowser.useIntegratedBrowser: false`), and that is
the whole story until Cursor adopts the proposal.

**Grep for the open command in *two* spellings, or it lies in both directions.** Command ids are
built from a template literal — ``Qm="workbench.action.browser", Ec=(re=>(re.Open=`${Qm}.open`, …))``
— and whether the literal survives depends on the fork's minifier:

| | `"workbench.action.browser.open"` | `"workbench.action.browser"` |
|---|---|---|
| VS Code, Devin | absent | **present** (prefix kept) |
| VSCodium | **present** (inlined) | absent |
| Cursor, Antigravity | absent | absent |

So a zero count on either alone proves nothing; VSCodium looked like it had no browser at all on
the prefix check, having in fact inlined every id. Test both. The literal also appears in
`extensions/simple-browser/dist/extension.js` everywhere, which only *calls* it — upstream
simple-browser probes for it with `getCommands(true)` exactly as we do.

None of this touches the extension: `browserApiState()` asks `getCommands(true)` at runtime, so
the minifier's choice is invisible to it. It was only ever a hazard for auditing a fork from the
outside.

How to audit a fork without launching it:

```sh
R="/Applications/<Fork>.app/Contents/Resources/app"
python3 -c "import json;d=json.load(open('$R/product.json'));print(d.get('vscodeVersion'),d.get('version'),d.get('dataFolderName'))"
F="$R/out/vs/workbench/workbench.desktop.main.js"
grep -c 'vscode.proposed.browser.d.ts' "$F"      # proposal registered at all
grep -c '"workbench.editor.browser"' "$F"        # upstream editor id, our `when`
grep -cE '"workbench\.action\.browser(\.open)?"' "$F"  # open command, either spelling
grep -coE 'browserTabs|startCDPSession' "$R/out/vs/workbench/api/node/extensionHostProcess.js"
```

`argv.json` lives under the fork's own `dataFolderName` — `~/.cursor/argv.json`,
`~/.devin/argv.json` — and the renderer log under
`~/Library/Application Support/<nameShort>/logs/<stamp>/window*/renderer.log` is where the
proposal verdict is printed. Read that log first; it separates "proposal does not exist" (the
fork, unfixable) from "CANNOT use API proposal" (the grant, fixable) in one line.

### Enabling the grant in one click

`aiBrowser.enableBrowserApi` ("AI Browser: Enable Integrated Browser API") writes the grant
itself, because the manual instructions were the single most common reason the headline
features looked broken. [src/proposedApi.ts](src/proposedApi.ts) decides and drives it,
[src/argvJson.ts](src/argvJson.ts) does the editing (leaf module, under test).

**Three states, and only the middle one is fixable** — `browserApiState()`:

| State | How it is detected | What happens |
|---|---|---|
| `granted` | `isBrowserApiGranted()` — a *read*, not an `in` | says so, does nothing |
| `grantMissing` | no `browserTabs`, but `workbench.action.browser.open` is registered | writes `argv.json`, offers to quit |
| `unsupported` | no `browserTabs`, no such command | explains, offers the webview panel |

**The `grantMissing` / `unsupported` split reads the host's own build, and it has to.** The
question is whether the host *implements* the API or is merely withholding the grant, and the
witness is its extension host bundle:
`${vscode.env.appRoot}/out/vs/workbench/api/node/extensionHostProcess.js` searched for
`browserTabs`. Two megabytes, read once per session and cached, searched as **bytes** — turning
it into a JS string to call `includes` costs far more than the answer is worth.

**This replaced a proxy that was wrong, and the counterexample is Kiro.** The proxy was
`getCommands(true).includes('workbench.action.browser.open')` — reasoning that a host shipping
the upstream browser registers that command, which is true, and that a host carrying the
proposal never lacks it, which is also true. The direction that matters is the other one: **Kiro
1.0.437 ships the browser as an editor feature — the command and the `workbench.editor.browser`
pane are both present — while shipping none of the extension-facing half.** 171 proposals, no
`browser` among them, zero `browserTabs` in its extension host.

The failure was not subtle, and it is exactly why the split is worth getting right: the proxy
said "the grant is missing", so the button offered a fix, wrote `~/.kiro/argv.json`, told the
user to quit and reopen — and on the next start the API was still absent, so the item read
`Restart to finish` **forever**. Reported as "the button didn't disappear after restarting". A
wrong `unsupported` merely hides a working button; a wrong `grantMissing` edits the user's
launch configuration and asks them to restart for nothing.

Measured separation, exact on all six editors here: `browserTabs` is present once in VS Code,
VSCodium and Devin, and not at all in Cursor, Antigravity IDE and Kiro. The command proxy is
kept only as the fallback for when the file cannot be read at all — an unknown layout, or a
remote or web host where that bundle is not ours.

**`argv.json` lives under the host's own `dataFolderName`** — `.vscode`, `.cursor`, `.devin` —
and nothing in the extension API exposes it. It is read from the `product.json` sitting next to
`vscode.env.appRoot`, verified present on all three. Every field falls back, since a fork may
omit any of it, and the dialog always names the full path so a wrong guess is visible rather
than silent.

**`argv.json` is JSONC, so `JSON.parse` + `JSON.stringify` is not an option.** The shipped file
is mostly comments: a header ending in "PLEASE DO NOT CHANGE WITHOUT UNDERSTANDING THE IMPACT",
then a commented-out example of every supported switch. A round-trip through `JSON` hands the
user back a file with all of it gone. So `argvJson.ts` splices text and leaves the rest
byte-for-byte alone, and a test asserts each of those comments survives.

**`maskJsonc` is the core, and the reason is a real failure mode.** The shipped file already
contains `// "enable-proposed-api": [...]` as an example, so deciding "is the key there?" with
`indexOf` finds the *comment*, appends a second real key below it, and the file then has two —
which is exactly the shape that made our Codex table invisible once (see
[The mini TOML parser](#the-mini-toml-parser); same distinction, same reason). The mask blanks
comments and string *contents* while preserving every offset, so structural questions are asked
of the mask and values are read from the original text at the offsets it found. It keeps the
quotes, so a one-character key reads as `" "` in the mask — assertions comparing against `"k"`
are testing the wrong thing.

A value that is present but not an array is **refused, never overwritten**: it may be somebody
else's grant in a shape we do not model, and losing it would break their extension to fix ours.

**Quit, not Reload Window.** `argv.json` is read at process start, so the dialog's button runs
`workbench.action.quit` (present on VS Code, Cursor and Devin). Reload Window silently changes
nothing, which reads as "the fix did not work".

Also worth knowing:

- **The old file is copied to `argv.json.bak` before writing.** This file decides how the editor
  launches and the user did not ask for it to be edited byte by byte.
- **`workbench.action.configureRuntimeArguments` is preferred over opening the path.** It creates
  the file from the editor's own template when it does not exist yet, and it exists on all three
  hosts. Opening the URI is the fallback.
- **There is no startup notification.** There was one, and it had to go: a toast at activation
  can pause a browser tab restored with the window — see
  [A notification pauses the built-in browser](#a-notification-pauses-the-built-in-browser).
  The pulsing item carries the same message without ever painting over the page.
- **`browserController.ts`'s messages name the command rather than carrying a button.** They are
  read by a model over MCP as well as shown to the user, and a model cannot click.

### Presence is not permission: `in` lies about the grant

**Never ask whether a proposed-API member exists. Read it.** `isBrowserApiGranted()` in
[src/proposedApi.ts](src/proposedApi.ts) is the only correct test, and every guard goes through
it.

VS Code builds the `window` namespace per extension and defines proposal-gated members
**unconditionally**, putting the check inside the getter. From `extensionHostProcess.js`:

```js
get browserTabs() { return checkProposedApiEnabled(extension, 'browser'), extHostBrowsers.browserTabs; }
```

So `'browserTabs' in vscode.window` is **true on every host that carries the proposal at all**,
granted or not — the *read* is what throws. The old guard therefore reported `granted` on
exactly the hosts where the grant was missing, which is the worst possible direction:

- the status bar item that fixes it stayed hidden, and the command answered "already enabled";
- `requireBrowserTab()` passed its guard and then threw on `activeBrowserTab`, so an element
  command surfaced a raw error instead of the refusal written for it — and that error toast
  paused the browser, which is how it was first noticed.

This is why VSCodium looked like "everything works except the picker": the proposal is in its
registry, so `in` said yes, while its log repeated `CANNOT USE these API proposals`. Kiro and
Cursor never showed the bug — they do not implement the API at all, so the property is genuinely
absent and `in` happened to be right.

The read settles both questions at once:

```ts
try { return vscode.window.browserTabs !== undefined; } catch { return false; }
```

A throw means the proposal exists but is not ours; `undefined` means the host does not implement
it. Anything else the `browser` proposal adds later — `activeBrowserTab`, `openBrowserTab` — is
gated the same way, so the same rule applies.

### `argv.json` is not always under the home directory

`argvUri` copies the editor's own rule out of `main.js`, and each branch is a real install:

```js
if (process.env.VSCODE_PORTABLE) return join(process.env.VSCODE_PORTABLE, 'argv.json');
let folder = product.dataFolderName;
if (process.env.VSCODE_DEV) folder = `${folder}-dev`;
return join(os.homedir(), folder, 'argv.json');
```

Assuming `~/<dataFolderName>` alone writes a portable install's grant into a file the editor
never reads, and then asks for a restart that changes nothing — the same ruled-out path as the Kiro
bug, from a different direction. The variables belong to the main process and the extension host
inherits them, which only holds when the two are on one machine.

**Which is why a remote or web window is refused outright** (`canWriteArgv`). There the
extension host is not on the machine that launched the editor: `os.homedir()` is the *remote*
home. It is not even self-correcting, because `hostShipsBrowserApi` reads the **server's**
extension host bundle, which does contain `browserTabs` — so the state comes out `grantMissing`
and everything downstream looks fine. The command explains and offers
`workbench.action.configureRuntimeArguments`, which runs in the renderer and so opens the
*local* file, plus the line on the clipboard.

Verified against a stubbed `vscode` for all five: normal, `VSCODE_PORTABLE`, `VSCODE_DEV`,
remote and web.

### Editing `enable-proposed-api` — two ways it went wrong

Both were found by review, both reproduced, and both matter more than they look.

**The value has to be located by the key, not by the next `[`.** `mask.indexOf('[', keyAt)` is
not "this key's array": given

```jsonc
{ "enable-proposed-api": true, "js-flags": ["--harmony"] }
```

it finds the **neighbour's** array, appends our id into `js-flags`, and reports success. The
"not an array" guard never fires, someone else's setting is silently rewritten, and the grant is
still missing. `valueArrayRange` now starts at the key's colon and tracks nesting.

**The array contents are JSONC, so `JSON.parse` on the raw text is wrong.** `["other.ext",]` and
`["other.ext" // ours\n]` are both legal and both make `JSON.parse` throw — and the fallout is
worse than a refusal, because the state check treats an unreadable value as "grant missing", so
an editor that was **already configured** pulses `Enable Browser API` forever. `arrayEntries`
walks the array itself, skipping comments and commas.

**It also decides where an append goes**, which the same shapes break: inserting before the
closing bracket lands after a trailing comma (making a second one) or *inside* a line comment
(covering the id). So the insert point is the end offset of the last element, which is always
before both. Non-string contents are refused rather than rewritten, for the same reason a
non-array value is.

Every case above is in [src/argvJson.test.ts](src/argvJson.test.ts).

### The status bar: one permanent button, one that hides itself

[src/statusBar.ts](src/statusBar.ts) puts two items on the left, and they have different jobs.

**`$(globe) AI Browser` is permanent and opens a QuickPick.** It is not decoration: the dropdown
on the browser tab is gated on `activeEditor == 'workbench.editor.browser'`, so before this the
MCP commands had no home outside the command palette — the limitation recorded under
[The dropdown on the browser tab](#the-dropdown-on-the-browser-tab). The menu holds Open URL /
Open File, the three assistant commands, Settings, and the enable entry while it is relevant.

It deliberately **does not mirror the tab's dropdown.** The element and screenshot commands are
already one click away whenever a tab is focused, and a second copy here would be a longer menu
saying the same thing.

**`$(alert) Enable Browser API` appears only while it has something to do.** Three of the four
grant states hide it:

| State | Item |
|---|---|
| `granted` | hidden — a permanent badge for a solved problem is noise |
| `grantMissing` | `$(alert) Enable Browser API`, warning background |
| `awaitingRestart` | `$(debug-restart) Restart to finish`, warning background |
| `unsupported` | hidden |

**A scheme-less address gets one, and it is not always `https`.**
`normalizeAddress` in [src/webUrl.ts](src/webUrl.ts) (leaf module, under test) supplies
`https://` for an ordinary host and **`http://` for localhost-like ones**. Always-https was the
request and it is the wrong default for this extension specifically: a dev server on
`localhost:3000` does not speak https, the external URI opener only ever fires for those hosts,
and `https://localhost:3000` is a valid-looking string that cannot connect — the opposite of
what "always a valid url" is asking for. `preview-src/index.ts` already chose the same way for
the panel's address bar — but only that choice; the panel still prefixes an unknown
`scheme://`, so the two are no longer interchangeable. One line in `addDefaultScheme` makes the
scheme strict if that is ever wanted.

Several things about it are load-bearing:

- **Deciding "has a scheme already" with a pattern gets `localhost:3000` wrong.** It matches
  `^[a-z][a-z0-9+.-]*:` exactly as a real scheme does, so a syntactic check reads `localhost` as
  the scheme, leaves the input untouched, and hands the browser something it cannot open — the
  one case the whole module exists for. `hasKnownScheme` compares against a *list*, mirroring
  `ALL_KNOWN_SCHEMES` in `preview-src/browserSearch.ts`.
- **The host set holds the bracketed IPv6 spellings**, because `URL.hostname` returns an IPv6
  authority with its brackets — `::1` would never match. **It is exported and `extension.ts`
  imports it** rather than keeping its own: `enabledHosts` (which URIs the external opener claims)
  and this (which addresses get `http`) are one predicate — "is this a local dev server" — and two
  copies let the opener claim a host whose typed form then gets `https` and cannot connect. The
  leaf-module rule constrains what `webUrl.ts` may *import*, not who may import it. The third
  copy, `localhostHosts` in `preview-src/index.ts`, is the only unavoidable one: the webview is a
  separate bundle with its own tsconfig and runtime. An earlier version of this note claimed no
  shared import was possible at all, which was false and would have entrenched the duplication.
- **The result is parsed before it is returned** — and parsing alone is not enough, which took a
  second pass to get right. `new URL()` *invents* a host rather than failing, so
  `/Users/m5/x.html` came back as `https:///Users/m5/x.html` (host `users`), `./rel.html` as
  `https://./rel.html` (host `.`) and `C:\dev\index.html` as `https://c/dev/index.html` (host
  `c`) — every one a valid URL pointing somewhere nobody asked for. So the scheme-less branch also
  refuses input that cannot be an authority at all (`looksLikeAuthority`) and requires a non-empty
  `hostname`, since `https://?q=1` is a URL with no host. `normalizeAddress` returns `undefined`,
  which is what the prompt's `validateInput` refuses on.
- **`//example.com` is not one of those, and grouping it with them cost a working address.** The
  second pass refused it alongside the paths above on the stated grounds that it "parses into a
  host nobody named" — but `https:////example.com` collapses its slashes and resolves to
  `https://example.com/`, which is exactly the page meant. A protocol-relative address is a real
  one missing only its scheme, and it is what a copy out of HTML or Markdown looks like, so the
  leading `//` is stripped and the rest goes through the normal rules. The lesson generalises: a
  refusal needs its *own* evidence, not membership of a list that mostly deserves it.
- **Input that already declares a scheme is handed on untouched, known to us or not**
  (`declaresScheme`). `ws://localhost:8080` is not in `knownSchemes`, and prefixing produced
  `https://ws://localhost:8080` — which parses, hostname `ws`, so nothing downstream refused it
  and the browser silently opened nonsense. The `://` is what separates this from the
  `localhost:3000` trap: that has no authority separator and must still be prefixed. Mangling an
  address is strictly worse than relaying one the browser will reject.
- **An opaque scheme is relayed too, and telling one from `host:port` is the whole trick.**
  `tel:+361234567` and `localhost:3000` have the identical shape `word:rest`; only the *rest*
  separates them, and a port is digits followed by nothing or a path. Reading these as a host
  mangled `magnet:?xt=…` into `https://magnet:?xt=…` and refused `tel:`, `sms:`, `webcal:` and
  `bitcoin:` outright — while the README promised pass-through for any scheme. The Windows-drive
  test runs *first*, or `C:\dev` reads as the opaque scheme `c:` and is relayed to a browser that
  cannot open it instead of being refused.
- **A `Uri` argument must survive.** `aiBrowser.show` is typed `url?: string`, but
  `executeCommand` is untyped at runtime and `AIBrowserManager.show` has always accepted
  `string | vscode.Uri` — so a caller passing one used to work, and `input.trim()` inside
  `normalizeAddress` turned it into a `TypeError` that lost the open entirely. `asAddress` in
  `extension.ts` **converts** it with `toString(true)`, and relays a string it could not normalise
  unchanged rather than dropping it: the prompt is where an unusable address is refused, not the
  programmatic command. Converting rather than relaying is the load-bearing half —
  `workbench.action.browser.open` reads its argument as
  `typeof e == "string" ? { url: e } : e ?? {}`, so a `Uri` becomes its undocumented *options*
  object, which carries no `url`, and the editor opens a **blank tab in silence**. Relaying the
  object traded a loud `TypeError` for a quiet wrong result on the default path, which is worse;
  `api.open` and the external URI opener already stringify for exactly this reason.

It is applied in `aiBrowser.show` as well as at the prompt, since that command takes a URL from
other callers too, and it is idempotent so the second pass changes nothing. `undefined` stays
`undefined` on the integrated path: that is how the command asks the browser to open with no
address at all.

**Both prompts set `ignoreFocusOut` and refuse an empty value**, and each half fixes a separate
route to the same report — "Open URL, press Enter, nothing happens". See breaks-silently #79 and
#80; the short version is that `showInputBox` answers `undefined` for a box that lost focus and
`''` for a box nobody typed in, and the caller could not tell either from a deliberate cancel.
The focus half bites hardest here precisely because this box is opened from a status bar menu,
which is also the surface that re-renders itself under `pulse` and on every share change.

**`Open File` is in the menu only when the built-in browser will take it.** It is gated on
`shouldUseIntegratedBrowser()`, which is why that helper lives in
[src/proposedApi.ts](src/proposedApi.ts) rather than in `extension.ts` — three callers need the
same answer, and the second copy drifted: Open File reached for
`workbench.action.browser.openFile` whenever the command was registered, ignoring both the
setting and the grant, so on a host where the user had just chosen the webview panel it still
opened a native tab nothing could attach to. There is deliberately **no panel fallback** either:
a `file:` URI in the panel is blocked by `localResourceRoots` and renders blank with no error,
which is worse than the entry not being there.

**`unsupported` hides the warning item, but the menu must still explain itself.** A permanent
apology in every window is nagging, so the item stays hidden — but hiding it and saying nothing
else leaves "nothing works and nothing says why", which is exactly how Trae was reported. So the
menu carries `$(circle-slash) Why are the browser tools unavailable?` under *Setup* whenever the
state is not `granted`. The menu is opened deliberately, so an explanation there costs nothing
and no screen space.

**`awaitingRestart` exists because the fix is two steps.** After the write, the file names us but
the process does not, and both facts are true at once. Without this state the button would still
read "Enable" after a successful click, which reads as the fix having failed. It is derived
rather than remembered — the state check asks whether `argv.json` already lists us — so it
survives a window reload, which a session flag would not. `onDidChangeGrantState` fires after
the write so the item flips immediately rather than at the next activation.

**`backgroundColor` accepts exactly two colours, and silently ignores everything else.** Per the
`.d.ts`: `statusBarItem.errorBackground` and `statusBarItem.warningBackground`, nothing more.
There is no theme colour of our own to reach for and no point defining one. Warning is the right
one here — red reads as "something broke", and nothing has.

**There is no animation API, and `~spin` is the wrong word.** The only animation primitive
anywhere near a status bar item is the `~spin` codicon modifier, which universally means "work
in progress" — a spinning alert triangle reads as a hung extension, not an invitation. So the
animation is the background going on and off, in `pulse`: three blinks at 700ms a phase (about
0.7Hz), once per window, then steady. Slow on purpose, because a status bar is peripheral vision
and anything faster is a flashing-content problem rather than a hint; bounded on purpose,
because a permanently blinking button is the kind of thing people disable an extension over. The
final tick sets the background on in **one** assignment rather than off-then-on, which the
renderer is free to show as a flicker.

**The permanent item also carries the share, and since the tab itself is no longer marked it is
half of where that state lives.** `$(globe) AI Browser` becomes `… 🔗` while a tab is shared,
`… 🤖` once an assistant has driven it, and `… $(debug-pause)` with a warning background when the
shared tab was closed and the tools are paused — the one share state that is waiting on the user.
The other half is the **Shared tabs** section at the foot of this item's menu, which is the only
place the "given out but never picked up, so restart it" diagnosis is written down. See
[Where a share is visible](#where-a-share-is-visible).

**No setting to hide these.** VS Code already lets a user right-click the status bar and hide any
individual item, and it remembers that per item id — which is why both are created with explicit
ids (`aiBrowser.status`, `aiBrowser.enableApi`) and a `name`, since the name is what that
context menu lists.

**Verified with a fake `vscode`.** `statusBar.ts` imports `proposedApi.ts`, which imports
`vscode`, so it can never be an `npm test` file (see the leaf-module rule under
[Recipe for the next feature](#recipe-for-the-next-feature)). It was checked instead by loading
the compiled `out/statusBar.js` against a stubbed `vscode` module and printing what each grant
state renders — all four states, plus the menu contents, plus the pulse settling on. Worth
redoing that way after changing this file; a typecheck says nothing about which item is visible.

### A notification pauses the built-in browser

The single worst bug this extension has shipped, and the mechanism is worth knowing before
adding any UI: **the browser editor is a native view laid over the workbench, so anything that
has to paint on top of it takes the live page away.**

`_refreshOverlayObscured` in the browser editor:

```js
const overlapping = this._overlayManager.getOverlappingOverlays(this._container);
const anyOverlay = overlapping.length > 0;
const isNotification = overlapping.some(o => o.type === OverlayType.Notification);
this._overlayPauseEl.classList.toggle('show-message', isNotification);
if (anyOverlay !== this._overlayObscured) { this._overlayObscured = anyOverlay; this._refresh(); }
```

`_refresh()` then swaps the running page for a screenshot, and when one of the overlapping
overlays is a notification toast the user additionally gets an overlay reading **"Paused due to
Notification — Dismiss the notification to continue using the browser."** (`nls` messages 8112
and 8113; they are indexed, so grepping the workbench bundle for the text finds nothing — search
`out/nls.messages.json` instead).

**What we were doing wrong:** element picking ran inside
`withProgress({ location: ProgressLocation.Notification, cancellable: true })`. That toast is up
for the *entire* pick — which is the one moment the user is looking at the page and clicking in
it. So every pick froze the page behind a "Paused" overlay that had to be dismissed before the
click could land. It read as a broken picker; it was our own progress notification.

**The rule now: a notification is for a refusal or a decision, never a confirmation.** Successes
go through `confirm()` in [src/notify.ts](src/notify.ts), which is
`window.setStatusBarMessage`. The status bar is part of the workbench layout rather than an
overlay, so none of the above applies to it.

- **Progress belongs in `ProgressLocation.Window`** — the status bar. It renders `$(icon)`
  syntax, which `Notification` does not, so the pick label carries `$(inspect)`.
- **`Window` has no cancel button** (`cancellable` is honoured for `Notification` only, per the
  `.d.ts`), and cancelling a pick is load-bearing. So the cancel affordance is a status bar
  button, `$(stop-circle) Cancel pick`, shown only while a pick runs. It drives `pendingPick`,
  the same token a superseding pick cancels — one cancellation path, already proven, rather than
  a second one to keep in step.
- **`aiBrowser.cancelElementPick` is deliberately not in `contributes.commands`.** It exists for
  that button; contributing it would put a palette entry there that is inert whenever no pick is
  running.
- **The pick has to be cancelled when its tab closes, and nothing does that for us.** A pick is a
  wait for `Overlay.inspectNodeRequested` on that tab's CDP session, and closing a browser editor
  does not close the session: `MainThreadBrowsers` disposes the editor input, which fires
  `$onDidCloseBrowserTab` and leaves `_cdpSessions` alone — the session group is only destroyed by
  `$closeCDPSession` or by the group service, so `BrowserCDPSession.onDidClose` never fires on this
  path. Read from the outside that is a `Cancel pick` button that stays in the status bar for the
  rest of the session with nothing behind it, and the `withProgress` title beside it. So
  `watchTabClose` in [src/elementPicker.ts](src/elementPicker.ts) cancels the token on
  `onDidCloseBrowserTab`, and on `onDidChangeActiveBrowserTab` re-checks membership of
  `browserTabs` — the same lazy detector `browserController` keeps for a host that does not fire
  the close event, and the picked tab is by construction the active one, so closing it changes
  which tab is active. The catch in `pickAndDeliver` tests `cts.token.isCancellationRequested` as
  well as `CancellationError`, or a pick cancelled part-way through its setup reports whatever the
  step it was in threw, as an error toast, about a page the user has just closed.
- **The startup nudge is gone.** A warning toast at activation could pause a browser tab that was
  restored with the window, and the pulsing status bar item says the same thing without ever
  painting over the page. Do not bring the notification back.

**What is still allowed to be a notification, and why.** Three paths keep theirs, knowingly:
the pick failing with an error, and the two assistant fall-backs ("Claude Code is not available,
so the report went to the clipboard"). Each reports that the thing the user asked for did **not**
happen, and each is rare; a paused page is an acceptable price for not losing that. The modal in
`enableBrowserApi` is the same call — it asks a question, and blocking is the point.

**"Browser API not enabled" is not among them.** It was, and it kept the bug alive after the
progress notification was fixed: press an element command in an editor without the grant and the
refusal toast paused the very tab you were looking at. It now goes through `refuse()` to the
status bar, because in exactly that state the `Enable Browser API` button is already sitting
there — the toast added nothing but the pause. The lesson generalises: a refusal that the status
bar already offers a fix for does not need a notification at all.

**And whatever does reach a notification body must not have been written by a page.** A body is
rendered as *linked text* and its links are opened with `allowCommands: true` — the mechanism
recorded under item 124 — so `[label](command:…)` anywhere in it is a button that runs a command
on one click. `versionShape` guards that sink for a value with a *shape*; a page title has none,
because the page chooses it outright, so `plainInNotification`
([src/notifyText.ts](src/notifyText.ts), leaf module, under test) neutralises it instead. It
drops `[` and `]` — without a label there is no link, whatever follows, so the rule does not
depend on which target schemes the renderer happens to accept — and caps the length, which is not
security but the fact that a notification is one line and a title can be thousands of characters.
It is applied in `scopeNote`, which names the shared page in four refusals; the label beside it is
ours (`targetName`) and is left alone, so the boundary stays visible. **`stripMarker` is not a
sanitiser** — it removes a 🔗/🤖 suffix an older build of this extension wrote into the page title
and nothing else, and reading it as one is how the page's title reached the toast in the first
place.

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
does**. It is two levels: what acts on the page stays at the top, and everything belonging to
one assistant is folded into that assistant's own submenu.

```
Copy Element / CSS Path / CSS Path + Location / Element XPath   1_copy@1..4
─────
Copy Screenshot (Visible Area) / (Full Page)                    2_shot@1..2
─────
Claude Code ▸                                                   3_assistant@1
    Add Element / CSS Path / CSS Path + Location / XPath        1_add@1..4   when <a>Installed
    ─────
    Connect Claude Code                                         2_mcp@1
    Share Tab with Claude Code                                  2_mcp@2
Codex ▸                                                         3_assistant@2
Check Connection                                                3_assistant@3
─────
Share Tab with All Assistants                                   4_share@1
Stop Sharing Tab                                                4_share@2   when tabShared
```

That is eleven rows. The menu had eighteen before this change, and a flat one would have
had twenty-one once the fourth element kind was added. The `group` prefixes put the
separators in; ordering comes from the `@n` suffix, not from the position in the
`contributes.menus` array —
the array is kept in the same order anyway, because a file that reads in a different order than
the menu renders is a trap for the next edit. `Stop Sharing Tab` is gated on the
`aiBrowser.tabShared` context key, republished from `extension.ts` on every share change, so it
is only there while there is something to stop.

**Nesting is possible, and the rule that permits it is worth knowing before adding a third
level.** `menusExtensionPoint` looks the target menu up in the built-in table first and falls
back to the extension's own declared submenus, synthesizing `{ key, id, description }` for
them — with **no `supportsSubmenus` property at all**. The guard below it reads
`if (n.supportsSubmenus === false)`, a strict comparison, so `undefined` sails past: a submenu
an extension declares always accepts submenus. Rendering recurses through
`new MenuInfo(item.submenu, …).createActionGroups()`, so depth is unbounded — and **nothing
detects a cycle**, in the validator or the renderer, so a submenu that reaches itself hangs the
menu on open.

Two behaviours fall out of that code and are relied on here:

- **An empty submenu is not rendered at all** — the join of its groups is checked with
  `m.length > 0` before the `SubmenuItemAction` is pushed. So a submenu whose every item is
  hidden by a `when` clause disappears rather than showing a missing row with an empty flyout.
- **The same submenu cannot be added twice to one parent** (a warning, and the second is
  dropped).

**Only the Add entries are gated on `aiBrowser.<assistant>Installed`; the submenu itself is
not.** That key means "the assistant's *VS Code extension* is installed", and Connect / Share
are exactly what the terminal-driven setup needs — gating the container on it would hide the
feature from the setup it targets, which is breaks-silently #71 one level up. It also has a
mechanical consequence worth stating: because Connect and Share are never gated, neither
submenu can ever be empty, so the disappearing-submenu rule above never fires on them.

**A command's title is one string for every surface, so the entries inside the submenus repeat
their assistant's name** — "Add Element to Claude Code" under a heading that already says
"Claude Code". A menu item cannot override a title (`menusExtensionPoint` builds it as
`{ command, alt, group, order, when }`, taking the title from the command), and shortening the
command title itself would break the command palette, where the bare "Add Element" says
nothing. Same rule as breaks-silently #74.

**The assignments sit at the end of every menu, and that was asked for rather than derived.**
Connecting is done once per project; an assignment is what changes from page to page, and it
reads better at the foot of a list than at the head of one. The status bar menu is ordered in
code (`showMenu`) and the dropdown by that group prefix, so moving one means moving both — they
are the same list to a user.

There is no activity bar panel any more. It was a `TreeDataProvider` in `src/toolsView.ts`, and
it went away when the same commands landed in this dropdown; `media/activity-icon.svg` went
with it. One consequence worth knowing: the dropdown is gated on
`activeEditor == 'workbench.editor.browser'`, so from here **Connect Claude Code / Connect Codex
/ Check Connection are only reachable from a browser tab**. They are also in the command
palette, where every command still appears, and in the status bar menu — which is the surface
that exists because of this gap, see
[The status bar](#the-status-bar-one-permanent-button-one-that-hides-itself).

It is a `contributes.submenus` entry (`aiBrowser.elementMenu`) placed into `editor/title`, with
`aiBrowser.claudeMenu` and `aiBrowser.codexMenu` nested inside it;
`editor/title` allows submenus because `menusExtensionPoint.ts` leaves `supportsSubmenus` at
its default of `true`. **The `icon` on the submenu declaration is what makes it a toolbar
button** — without one it collapses into the tab's overflow menu. The two nested submenus
therefore carry **no** icon: there is no toolbar slot for them, and inside a dropdown the field
does nothing.

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

**Each element icon encodes two things at once**, so the grid is 4 × 3 —
`media/icons/crosshair-<dot>[-<destination>]-<theme>.svg`, twenty-four files:

| kind → dot | destination → ring |
|---|---|
| element: red `#E03131` | Copy: theme grey |
| CSS path: blue `#1971C2` | Claude Code: yellow — `#FFD43B` dark, `#A16207` light |
| CSS path + location: grape `#AE3EC9` | Codex: blue-white — `#C5F6FA` dark, `#0E7490` light |
| XPath: green `#2F9E44` | |

The same kind keeps its dot across destinations; the same destination keeps its ring across
kinds; and **no two kinds share a dot**, which `check-manifest` now asserts separately. The
within-a-kind rule was there from the start and the across-kinds one was not, so a fourth kind
could have been given blue and produced two toolbar buttons that say the same thing — the icon
is the only label a primary button has. As with the globe, the light variant of each ring is that hue taken down to something
readable — a pale yellow or a blue-white is invisible on a white background.

**`npm run check-manifest` guards all of this**, because none of it produces a compile error:
a menu item pointing at a missing command, a command with no activation event, an icon path
with a typo, an icon file nobody references, two primary buttons sharing a `lastElementAction`,
two kinds sharing a centre dot, and this grid losing its shape. Run it after touching `package.json` or `media/icons`.

**The primary button is a faked split button.** VS Code has the real thing —
`isSplitButton: { togglePrimaryAction: true }` on a submenu item, rendered by
`DropdownWithDefaultActionViewItem`, which even persists the last action under
`${submenu.id}_lastActionId` — and the built-in browser uses it for its own "Add to Chat"
button. Extensions cannot: `menusExtensionPoint.ts` builds an extension's submenu item as
`{ submenu, icon, title, group, order, when }` and never sets that flag, and the manifest
schema accepts only `submenu` / `when` / `group`.

So instead: **twelve** primary buttons in `navigation@2` — the four copies plus the same four
for each assistant — each with a `when` on the `aiBrowser.lastElementAction` context key, so
exactly one is ever visible. The dropdown sits *before* them in `navigation@1`. The Add buttons
carry the extra condition `aiBrowser.claudeInstalled` / `codexInstalled`, or a remembered action
would leave the toolbar with no primary button at all once the assistant is uninstalled.

The twelve action ids (`element`, `cssPath`, `cssLocation`, `xpath` and `<assistant>:<kind>`)
are compared
verbatim in `when` clauses, which makes them **part of the manifest's contract** — renaming one
in `lastAction.ts` alone silently removes a button. Add commands reuse the crosshair colour of
the matching Copy command, so the button looks the same whichever destination it repeats. [src/lastAction.ts](src/lastAction.ts)
keeps the context key and a memento in step — the memento because a context key does not
survive a restart. Each command records itself before running, in `extension.ts`.

`onStartupFinished` is in `activationEvents` **for this to work at all**: `when` clauses are
evaluated before activation, so without it the context key is unset on a fresh window and the
toolbar shows a lone chevron with no primary button. Two visually adjacent buttons is as close
as an extension gets — they are not fused into one control the way Run/Debug is.

**One chord drives whichever tool is active:** `Ctrl+Alt+C` / `Cmd+Alt+C`. Since the twelve
`when` conditions are mutually exclusive, exactly one binding can match, so the key always runs
what the right-hand icon shows.

**The chord sits on twelve `repeat.*` delegate commands, not on the commands in the
dropdown**, and that split is not decorative. VS Code prints a command's keybinding beside
**every** menu item that invokes it, with no way to opt out — so binding the dropdown commands
directly put `Cmd+Alt+C` on twelve rows of the menu. Each delegate shares its twin's icon and
title, is the one contributed to `editor/title`, and is hidden from the command palette with
`commandPalette` + `when: false` so the same twelve actions do not appear twice there.

`check-manifest` holds this together: one chord across the twelve, conditions matching the
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

### The four element commands

All in [src/elementPicker.ts](src/elementPicker.ts), all sharing `withPickedElement`:

| Command | Output |
|---|---|
| `aiBrowser.copyElement` | the full Markdown context, matching the built-in browser's "Add Element to Chat" |
| `aiBrowser.copyElementCssPath` | `#main > div > li:nth-of-type(2)` |
| `aiBrowser.copyElementCssLocation` | the page in front of the same selector, wrapped as inline code: `http://localhost:3000/a/b → #main > div > li:nth-of-type(2)` |
| `aiBrowser.copyElementXPath` | `//*[@id="main"]/span` or `/html/body/ul/li[2]` |

The CSS path deliberately leaves classes out. Utility-class frameworks produce long, unstable
class lists, and a selector built from them reads worse and breaks sooner than a positional
one; the full class list is in "Copy Element" for anyone who wants it.

**Both path builders anchor on a unique `id`** — `cssPathFunctionDeclaration` short-circuits its
walk exactly as `xpathFunctionDeclaration` does, and has since it was written. Worth stating
because the *documentation* did not, and a reader planning this feature concluded from the
`#main > …` examples and the paragraph above that only XPath anchored, and nearly rebuilt
something that was already there. A page with no id anywhere above the element is what produces
the long `html > body > div:nth-of-type(2) > …` chain, and that is the page's doing, not the
builder's.

**Copy Element goes to the clipboard as text, and stays that way.** An attach-as-file route
was built and removed on request: it wrote the Markdown to `globalStorageUri` and passed the URI
to `workbench.action.chat.attachFile`. Do not rebuild it without being asked. Worth keeping from
that detour: **`vscode.env.clipboard` is text-only** — there is no API for putting a *file* on
the system clipboard, so "paste attaches a file" is unreachable without shelling out to the OS,
and `attachFile` accepts only `file` / `vscode-remote` / `untitled` URIs.

### `CSS Path + Location`, and why the separator is ` → `

The problem it solves is that a selector alone is ambiguous the moment more than one page is in
play: an assistant handed `#main > li:nth-of-type(2)` cannot tell which route it belongs to,
and guesses. The joined form answers both questions in one line that is still short enough to
paste into a sentence.

**The page comes first**, because that is the order the pair is *used* in — navigate, then find
— and because the two halves are not interchangeable, so the string has to say which way it
reads. Everything before the separator is an argument for `browser_navigate`, everything after
it an argument for `document.querySelector`.

**The separator went through three forms, and each was eliminated by a different rule**
(`locationSeparator` in [src/reportFormat.ts](src/reportFormat.ts)):

- It must not be legal inside either half, or the string cannot be split back apart. That stopped
  the bracketed suffix this started as — `… > input [page: http://localhost/a/b]` is *valid CSS
  attribute-selector syntax* at that position, so the tail reads as part of the chain to a
  person, to a model, and to anything that pastes the whole string into `querySelector`. It also
  stopped `>>` (Playwright's own chaining operator) and `page=… css=…`, where the key order
  becomes part of the contract because the selector contains spaces and so has to come last.
- It must carry **direction**. ` @ ` was the form before this one and it only works with the
  selector first — "input @ that page" — so putting the page first while keeping `@` would have
  said the opposite of what is meant. An arrow reads the same way the pair is consumed.
- **The spaces are part of the separator, and that is not cosmetic.** `CSS.escape` emits code
  points at or above U+0080 unchanged, so an id containing an arrow survives into the selector
  half *unescaped* — but it escapes every non-alphanumeric ASCII character, the space included,
  so ` → ` with its spaces cannot occur there. A bare `→` is not a separator; the padded one is.
  Tested with both shapes of hostile id.

The cost, stated plainly: `→` is not ASCII, so it is not typeable on a plain keyboard and a
shell splitting on it needs the literal. That was judged acceptable because the consumer is a
chat message read by a model, not a pipeline — but ` -> ` is the same design in ASCII if that
ever stops being true.

Four consequences in the code:

- **The report is fenced as `text`, never as `css`** (`fenceLanguage`). The body is a selector
  *and* a URL, so calling it CSS invites a highlighter or a model to parse it as a rule and
  fail on the tail.
- **The report spells the format out** — a `Format:` line naming `<page url> → <css selector>`.
  Its reader is usually a model, and without the line the combined string invites a paste of
  the whole thing — separator and address included — into `querySelector`.
- **The clipboard copy is wrapped as Markdown inline code, and the report's is not.** This one
  is pasted into a chat message, where both the separator and the `>` of the selector are
  significant and an unwrapped string gets reflowed; the report's copy already sits inside a
  fenced block, so wrapping it again would only add noise. `inlineCode` grows its delimiter past
  any backtick run in the value and pads a value that begins or ends with one, for the reason
  `fenced` next door exists — a backtick is legal in a URL query string, and a single-backtick
  wrapper around one closes early, leaving the tail of the address as prose.
- **`tab.url` is read when the element is delivered, not when the pick starts.** A page can
  navigate while the user is choosing, and the address that belongs with the selector is the one
  the element was actually picked on.

**The address comes from the element's own document, not from `tab.url`, and that is a
correctness fix rather than a refinement.** Both path builders walk `parentElement` and stop at
the `<html>` of the node's *own* document — they even test id uniqueness with
`el.ownerDocument` — so an element inside an iframe yields a selector rooted in the **frame's**
document. One `querySelector` call cannot cross a document boundary, so pairing that selector
with the tab's URL produced a locator that reads as precise and is wrong: navigate there, run
the selector, get `null` or a different element. `documentLocationFunctionDeclaration` reads
`ownerDocument.defaultView.location.href` in the page, so the two halves always describe one
document.

This follows the rule already written down for `browser_snapshot` — never hand out a selector
that does not resolve with the call its consumer will make. It applies to the plain CSS path and
XPath reports too, which embed a URL in their prose and had the same mismatch.

Three details: comparing `win === win.top` is legal across origins because it reads no property
of the other document; a document we cannot read at all leaves `known` false and falls back to
`tab.url`, which is the best available; and the *frame* case adds a line to the report naming
the top page, while the one-liner stays a pair — it has no room, and the pair resolves on its
own.

**The `Format:` line is emitted from the body, not from the kind.** `withLocation` yields the
bare selector when the tab has no URL to give, and a `Format:` line promising
`<url> → <selector>` above a fenced block holding only a selector misdescribes the one thing the
report exists to carry.

**Every page-side source in `elementPicker.ts` is a template literal, so it may not contain a
backtick** — including inside its comments, where one silently closes the string and the
compiler then reports a cascade of syntax errors several lines away. `xpathFunctionDeclaration`
escapes its backticks; `documentLocationFunctionDeclaration` simply has none.

**A locator it cannot promise is refused, not emitted.** Two shapes break the "navigate, then
find" contract silently, and both read as precise:

- **An element inside a shadow root.** The builder walks `parentElement`, which is `null` at the
  boundary, so it returns a path rooted *inside* the shadow tree with nothing marking that — and
  `document.querySelector` cannot cross into one. The page-side function reports
  `getRootNode() !== ownerDocument` for this.
- **A frame with no address of its own.** A `srcdoc` frame reports `about:srcdoc` and a frame a
  script filled in reports `about:blank`; both name a document that exists only inside the page
  that built it (`isNavigable`).

`locatorRefusal` turns either into a refusal through `refuse()` — the status bar, never a toast,
since a notification would pause the very tab being picked in. Only `cssLocation` refuses: `css`
and `xpath` travel with prose that does not claim their URL is a navigation target. This is the
rule already written down for `browser_snapshot` — never hand out a selector that does not
resolve with the call its consumer will make.

The kind is `cssLocation` in `PathKind` and in `ElementActionId`, camelCase because it is
compared verbatim in `when` clauses. File names go through `fileToken`, which hyphenates it to
`css-location` — otherwise it would be the one mixed-case name in `.ai-browser/`.


**The pick slot is claimed before the cancel button appears, and that order is the fix.**
`beginPick()` / `endPick()` own `pendingPick`, and `pickAndDeliver` calls them around the button
rather than letting `withPickedElement` assign the slot on its way past
`await tab.startCDPSession()`. It used to: for as long as that await took, `Cancel pick` was on
screen calling `cancel()` on `undefined` — or on the *previous* pick's token — so the button did
nothing on exactly the slow sessions where someone would reach for it. The same move fixed a
leak: a rejection from `startCDPSession` escaped past the cleanup, leaving the slot pointing at a
retired token until the next pick reclaimed it. The client is now constructed inside the `try`.

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
3. Guard twice, with different messages: `isBrowserApiGranted()` from
   [src/proposedApi.ts](src/proposedApi.ts) (proposal missing, or launched without the flag)
   and `vscode.window.activeBrowserTab` (nothing open). The fixes are unrelated, so one message
   would send people the wrong way. **Never test the API with `in`** —
   [presence is not permission](#presence-is-not-permission-in-lies-about-the-grant).
4. `new CDPClient(await tab.startCDPSession())` → `attachToPage()` → `client.send(method,
   params, sessionId)`. Enable the domains you use (`DOM.enable`, `Overlay.enable`, …) first.
5. Undo anything that changes page state before any step that can throw, and
   `client.dispose()` in a `finally`.
6. Long interactions get `withProgress({ location: ProgressLocation.Window })` — **never
   `Notification`**, which pauses the browser
   ([why](#a-notification-pauses-the-built-in-browser)). `Window` has no cancel button, so
   anything cancellable needs its own affordance; the element pick uses a status bar button
   driving `pendingPick`. Pass the token to `client.once(...)` so cancelling actually unblocks.

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
   A config can end up addressing the window that has another project open, so a
   workspace-scoped token makes that an honest 401 instead of an agent quietly editing the
   wrong project. The token is also the **identity** the startup repair matches on — see
   [The port moves and the config remembers](#the-port-moves-and-the-config-remembers-the-old-one)
   — so it must never be regenerated for an existing workspace: every config naming that
   window would stop being recognisable at once.
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
- **There is no per-tool timeout, and `Tool.slowMs` was removed rather than kept as decoration.**
  It was declared and set on the three slow tools, and read by nothing at all, so the comments
  claiming a bigger budget for them were simply false — the client's own timeout is the only one
  in play. Do not reintroduce the field without a consumer.
- `browser_navigate` refuses anything but http/https. Otherwise an agent points the browser at
  a local file and reads it back with `browser_text` — a browser tool turned into a file reader.

### Three clients, three places to configure

| Client | Where | How |
|---|---|---|
| VS Code chat | nowhere | `lm.registerMcpServerDefinitionProvider`, reached through a cast so `engines.vscode` need not move; **the `McpHttpServerDefinition` constructor is positional** — an options object does not work |
| Claude Code | `.mcp.json` in the project | `{ type, url, headers.Authorization }` |
| Codex | `.codex/config.toml` in the project, or `~/.codex/config.toml` | `[mcp_servers.<name>]` with inline `http_headers` |

**Connect Codex writes the global `~/.codex/config.toml`, and Connect is one click with no
dialog.** Both halves changed together and the second forced the first.

There used to be a modal with two or three buttons on it, asking questions whose answer never
varied — of course the file should be written, of course the prompt should be copied. Now the
click writes the file, copies the prompt and says what it did. Dropping the dialog meant
choosing a Codex file rather than offering both, and the global one wins: **a project config is
only loaded for projects Codex trusts**, and the desktop surface has been reported to ignore it
outright ([openai/codex#13025](https://github.com/openai/codex/issues/13025)), whereas
`~/.codex/config.toml` is read on every surface, always. That is the usual reason Codex "cannot
see the server", and a one-click action must not land on the option that sometimes silently
does nothing. Writing *both* is not an option: the two entries have different names, so Codex
would load both and list every tool twice.

**The confirmation goes through `confirm()`, not a notification** — connecting is very often
done with a browser tab open, and a success toast would pause exactly the page the user is
about to hand to an assistant. Failures keep their notification: they are rare and they need
attention. The `Copy CLI command` button is gone from the happy path; the CLI command is what
lands on the clipboard when writing the file *fails*.

The global entry is named per project (`ai-browser-<slug>-<sha1[0:6]>`); the project entry uses
the bare `ai-browser`, since a project file has only one project.

**Codex does take a static `Authorization` header** — `http_headers`, alongside
`env_http_headers` and `bearer_token_env_var`
([docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)). An earlier note here claimed
it could only *name* a token, which is why the token used to ride in the URL; that was wrong.
We now write `http_headers = { Authorization = "Bearer …" }` as an **inline** table — a
`[mcp_servers.<name>.http_headers]` sub-table would be a second table, and replacing ours by
line range would leave it behind. The token-in-URL form is still *accepted* when reading, since
existing configs have it, and a stale sub-table of ours is removed on write.

**The `codex mcp add` fallback carries the token.** It is handed over on exactly the path where
writing the config failed, so it has to stand on its own — and without credentials the entry it
creates answers 401 on every call, which reads as a broken server rather than as a command
missing an argument. The token rides in the URL path there: the server accepts that form (rule 4
of the security model, kept for clients like this), it needs no `codex mcp add` option this
project has verified, and the startup repair still recognises the entry, because it matches on
the token wherever the token sits.

**A Codex entry's credentials are *checked*, not assumed from their shape.** The presence of any
`http_headers` used to count as authentication, which made the check blind to the accident it
exists for: a config copied from another project has the right URL and another workspace's
token, and `Check Connection` reported it as correctly configured — suppressing the reconnect
advice while every call 401'd. `judgeAuthorization` reads the `Authorization` value and compares
it to the token; a value it cannot read (a multi-line string, a form not modelled) is
`unverifiable` and trusted, deliberately, because a false "reconnect" sends the user to fix a
file that is already right. `bearer_token_env_var` stays trusted for the same reason — the value
is in Codex's environment.

**Neither assistant re-reads its config.** Both load MCP servers at startup: Claude Code needs
a restart, Codex a brand-new conversation. So reading the config can never *make* the tools
appear, and the prompt must not send the model off to fix anything there — its last line still
forbids adding or editing any MCP configuration.

**But it does open by naming the config file, and the earlier rule against that was too broad.**
The line used to say the prompt "names the *tools* and never tells the model to go and read
`config.toml`", on the grounds that a model sent to read the file confirms the server is
configured and still has no tools. True, and it is why the file is named as *evidence of the
entry's name* rather than as somewhere to go and act. What the read actually supplies is the
exact `[mcp_servers.<name>]` header, which is the one thing a model needs in order to rebuild
the prefix its own client mangled — see
[Nothing is named `browser_`](#nothing-is-named-browser_-and-the-prompt-said-it-was).

**The path must be the file that connect actually wrote.** `connectCodex` writes the *global*
`~/.codex/config.toml`; the VS Code Codex extension does not load a project `.codex/config.toml`
at all (measured: `mcp_server_count` excluded one sitting right there in the folder), so naming
the project file points the model at something absent, or at a leftover from the release that
did write it. Hence `configPath`, passed by each connect path — `.mcp.json` for Claude Code,
the global fsPath for Codex — rather than guessed inside `connectionPrompt`.

**And it asks for a check, not for work.** The line used to end "to inspect the page in the
integrated browser", which both assistants took as the task: they opened the browser tools on
whatever page was open and started reporting on it, before the user had asked for anything. The
paste exists to find out whether the tools arrived, so it asks exactly that — one
`browser_state` call and nothing else.

### Nothing is named `browser_`, and the prompt said it was

The single most confusing report this feature has had after the port drift, and the whole of it
was one clause in our own text. Codex answered **"the `ai-browser-picto-2a3f1f` tools beginning
with `browser_` were not loaded — please restart the session"**, restarting never helped, and
every layer underneath was healthy.

Measured on the failing session, against a window that was serving:

| | |
|---|---|
| derived port for `file:///Users/m5/dev/picto` | 43117, and 43117 was listening |
| token in the entry vs `globalState` | identical |
| `initialize` + `tools/list` over loopback | HTTP 200, 14 tools |
| Codex's own log at the moment of the paste | `built MCP tool list available_server_count=4 tool_count=199` |
| that turn's `resolve_for_step` | omitted two *other* servers, never ours |

So the tools were in that turn's tool list. **Neither assistant exposes an MCP tool under its
bare name**, and the two spell the namespace differently: Claude Code keeps the server name as
written (`mcp__ai-browser__browser_state`), Codex replaces the hyphens
(`mcp__ai_browser_picto_2a3f1f__browser_state`) and declares the lot inside its `exec` sandbox
rather than as separate tools — a successful call from four minutes earlier reads
`await tools.mcp__ai_browser_picto_2a3f1f__browser_state({})`. Nothing starts with `browser_`,
so a model told to look for that prefix among ~200 tools correctly reported finding none.

Two fixes, and the second is the one that makes it self-correcting:

- **Name the suffix, not a prefix.** `browser_state`, `browser_snapshot`, `browser_click` are
  ours and stable; the prefix belongs to the client and would go stale the moment either changed
  its mangling. The prompt says outright that a prefix is expected.
- **Ask for one real call.** "Just check — do not use them yet" left the model nothing to check
  *with* — the tool list was the only other evidence, and that is precisely the evidence the
  naming had made unreadable. `browser_state` is the right one to spend: the server's own
  instructions open with it, it reads extension-side state only, and — unlike every tool that
  resolves a tab through `_requireTab` — it does **not** run `_noteTabUse`, so the check cannot
  flip a shared tab's marker from 🔗 to 🤖 and claim work that has not happened.

**A `.mcp.json` that cannot be read or parsed is never overwritten.** `readClaudeConfig` returns
`{}` for absent, the object for parsed, and `undefined` for **either** unparsable **or
unreadable** — and on `undefined` the write is abandoned, because rewriting it would delete every
other MCP server the project has. The unreadable half was missing and the statement above was
simply false for it: a read error answered `{}`, so a transient failure on a committed,
team-shared file replaced it with our single entry and said it had succeeded. Both connect
writers go through `readConfig` for that reason; `writeCodexConfig` throws instead, which
`connectCodex` already reports with the `codex mcp add` fallback.

One shared global name would let the second project overwrite the first, hence the hash.
`codex mcp add` is still offered as a command for anyone who would rather not have a file
edited. **The global write is locked**, like every other writer of that file — see
[The port moves](#the-port-moves-and-the-config-remembers-the-old-one). It used to be
unlocked, on the reasoning that a button press cannot race itself; that stopped being true the
moment every window began repairing the same file at startup, and an earlier draft of this
paragraph still said "not locked" long after `writeCodexGlobalConfig` had taken the lock. Two
statements about one file is how breaks-silently #16 and #106 get reintroduced by somebody
tidying up.

### The mini TOML parser

[src/codexToml.ts](src/codexToml.ts) is not a TOML parser — it is exactly as much of one as the
two readers (checking, and replacing our table) need, and **they must agree on where a table
starts and ends**. `endLine` stops after the last key rather than at the next header, so a
comment above the neighbouring table is not covered into ours.

`scanLine` is the core, and every case it handles was a real failure: an escaped quote inside a
triple-quoted **basic** string is content and not the closing delimiter — two of those on one line
rebalance a scanner that ignores the backslash, so the document reads as well-formed while a
`[mcp_servers.x]` sitting inside somebody's prose is reported as a real table, and the repair
rewrites the inside of a string (item 115; the triple-apostrophe form is literal, where a
backslash is just a character); `#` inside a string is
not a comment; `[` inside a string does not open an array; `enabled_tools = [` left open means
following lines are continuation; triple quotes inside a *literal* string open nothing; four or
five closing quotes still close once. A naive quote count got this wrong in both directions —
our table became invisible and connecting wrote it a second time, which is TOML that does not
parse at all.

**`[` and `{` are counted apart, and one shared counter was a data-loss bug.** An unclosed
inline table cancelled by a stray `]` — two ordinary typos in opposite directions, several lines
apart — made the whole document balance, so `codexUnterminated` called it well-formed and every
guard resting on it passed, including the one deciding whether a deletion range covers another
server's table. `ScanResult` therefore carries `depth` and `braces` separately and every consumer
requires both to be zero (item 120).

**`codexRangeDeletable` is the range guard, and it is deliberately part textual.** A range may be
deleted only if it closes *and* holds no **credible** table header after its first line — a dotted
path of bare or quoted keys, matched against the raw line without consulting the scanner. Both
halves are needed and each covers the other's blind spot: asking the scanner alone misses a header
hidden behind an unclosed `[` (item 119), while a loose textual test fires on `  [3, 4]`, a nested
array's last element, and refuses a legitimate config for good (item 114). A credible header
inside a triple-quoted string is refused too — a known false refusal, and the cheap direction.

**A quoted key is the same key.** TOML says `"url" = …` and `url = …` are one key, and reading
the quoted form as *absent* is the worst kind of miss for a writer: the repair took its "no url,
insert both lines" branch and wrote a second definition beside the first, which is TOML that
does not parse — so an unattended startup repair took every MCP server in the user's file with
it. The same family as the rename collision below. `keyValue` now accepts a quoted key and
`unquote` normalises it before it is recorded, so every reader asks for the bare name and both
spellings answer. The local variable in `codexEntries` that holds `scan.text` is named `text`
for the same reason the distinction exists — it used to be called `code`, shadowing the very
rule the comment above it draws.

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

### The port moves, and the config remembers the old one

The single most confusing failure this feature has had, and it took three separate mistakes
stacked on each other. Measured on a machine with two windows up, 43110 and 43111, where Codex
could click a button and Claude Code insisted it had no tools at all.

**What was actually wrong, in order of importance:**

1. **The connection prompt told the model to create a shadowing duplicate.** Its second line
   handed over `claude mcp add --transport http --scope local …`, guarded by "if you have no
   such tools" — a condition that is **always true** at the moment the prompt is pasted,
   because neither assistant re-reads its config and the file was written seconds ago. So the
   fallback fired every single time. Local scope lives in `~/.claude.json` under
   `projects[cwd].mcpServers` and **overrides `.mcp.json`**, so from then on every press of
   Connect rewrote a file nothing read. This is why the bug looked unfixable: reconnecting
   genuinely did nothing.
2. **The port was assigned in window-open order.** First window took 43110, next 43111, and a
   window's port therefore changed whenever the windows were opened in a different order —
   while the port had been baked into the config once, at connect time.
3. **Nothing ever identified an entry as ours.** `Check Connection` compared the whole URL, so
   our own entry on a moved port was reported as `otherServer` — "there is a different server
   there" — which advises deleting a perfectly good entry of the user's own.

The asymmetry that made it baffling was luck: Codex still had an old entry from a previous
release, carrying the token in the URL path, and that one happened to land on a live window. So
Codex had tools — and was silently clicking buttons in **another project's** window, which is
the worse half of the same bug and produced no error anywhere.

**The fixes, in the same order.**

**`claudeCliCommand` writes `--scope project`, never `--scope local`**, so the CLI and this
extension edit the same `.mcp.json` and cannot disagree. And the prompt no longer carries a CLI
command at all on the success path: it ends with *do not add or edit any MCP configuration
yourself*. The command is still offered, but only where writing the file actually failed.

**A window's first-choice port is derived from the folder URI** ([src/mcpPort.ts](src/mcpPort.ts)),
so it is the same after every restart. `McpServer.start` now takes the whole list of ports to
try rather than a starting number, because the interesting decision is which one comes first.
It is a preference and not a reservation — two folders can hash to the same offset — so the
walk still falls through, wrapping inside the span so every window tries the same 20 ports. An
**explicitly configured** `aiBrowser.mcp.port` is exempt and starts exactly where it says:
someone who names a port means that port.

**`repairConfigs` corrects what has already gone stale**, on every start, right after the port
is known. Everything about it follows from one rule:

> **An entry is identified by its token, never by its name or its URL.**

The token is the only part of an entry that is stable and provably ours. Names have changed
between releases (`tab-browser` before `ai-browser`, plus the per-project names in the global
Codex file) and the URL is precisely the part that goes stale, so matching on either would miss
our own entries or rewrite somebody else's. From that follow the three properties that make an
unattended rewrite safe:

- it only touches entries carrying **our** token;
- it **never creates** a file or an entry — repairing is not connecting, and an absent config
  stays absent;
- it is silent unless something changed, and reports through `confirm()` when it did.

**The Codex repair is line surgery, not table replacement**, and that distinction is
load-bearing. The connect path replaces our table wholesale, which is right — the user just
asked for it to be made correct. Repair runs unattended, so it edits only the lines that are
wrong (the header if the name is from an older release, `url`, and `http_headers`), leaving
anything the user added to the table — `startup_timeout_sec`, `enabled_tools`, a comment —
where it is. Whole-table removal is still used for *duplicates* of ours, which are not tables
to fix.

Two smaller things fall out of it. **The global `~/.codex/config.toml` write is now locked**
([src/fileLock.ts](src/fileLock.ts)) — it used to be unlocked on the reasoning that a button
press cannot race itself, which stopped being true the moment every window started repairing
the same file on startup; a machine restoring a session opens them all at once. Losing the race
is not an error, since the next start repairs it. And **`spliceCodexTables` lives in
`mcpRepair.ts`** so the connect path and the repair path share one implementation: two copies
would be two chances to write TOML that does not parse.

**What is reported and deliberately not repaired.** Two things, for the same reason in both
cases — the file is not ours and a wrong guess breaks something that works:

- **Local-scope entries in `~/.claude.json`.** `Check Connection` now reads that file and names
  them, with `claude mcp remove <name> --scope local`. It is Claude Code's own config, holding
  its credentials and history; a lost update from us would cost far more than the stale entry.
  Without this the check was blind to the one entry that Connect cannot fix.
- **Codex entries that look like ours by name but carry another token** (`codexStrangers`).
  One of those may be another window's *live* entry.

### Pruning the entries of projects that no longer exist

The global `~/.codex/config.toml` only ever grew. Its entries are named per project
(`ai-browser-<slug>-<sha1[0:6]>`) and nothing removed one, so every project that was deleted or
moved left one behind for good — and `Check Connection` could do no better than list them and
ask the user to run `codex mcp remove` by hand, because "looks like ours by name" is all
`codexStrangers` can prove.

**The missing piece was in `globalState` the whole time.** It is shared across every window of
this extension, and `_workspaceToken` stores each token under `mcp.token:<folderUri>` — so
`Memento.keys()` yields every folder this extension has ever served on this machine, with its
token. That turns "looks like ours" into two provable facts at once: *this entry carries a token
we minted* and *the folder it was minted for is gone*. Only then is a deletion safe, and
`missingWorkspaceTokens` in [src/mcpSetup.ts](src/mcpSetup.ts) is where the proof is assembled.

**When it runs, precisely** — and this paragraph has now been wrong twice, in opposite
directions, so read it against the code rather than trusting it. The verdict has **two halves
that run in different places, and that split is the whole point**:

- `missingWorkspaceTokens` — the *survey* — stats the filesystem, so it runs **outside every lock**.
  It is handed to `repairConfigs` as a function rather than a result, and never called while a
  lock is held. (It does run after the two project configs have been repaired, each under and
  then out of its own lock — the invariant is "not while holding one", not "first".)
- `stillMissing` — the *confirmation* — re-reads `mcp.seen:` / `mcp.pruned:` from `globalState` and
  touches no file, so it runs **inside the config lock**, immediately before the rewrite.

Neither may move. Passing a resolved set instead of the pair is item 99: a verdict that travels
across the lock deletes the entry of a workspace that came back in the meantime. Running the
*survey* under the lock is the mirror mistake, item 104: it can cost `2 * statTimeoutMs` for one
stalled mount while `withLock` gives up after `attempts * retryMs` — one second — so every other
window skips `~/.codex/config.toml` entirely and reports `complete: false`. No port repair and no
completion markers, for all of them, on exactly the session restore the lock exists for.

`_apply` runs at activation *and* again on every `aiBrowser.mcp.enabled` / `aiBrowser.mcp.port`
change ([extension.ts](src/extension.ts)), so an unattended deletion runs more often than "once
at startup" suggests.

It is the one thing in the repair that deletes rather than corrects, and everything about it
follows from that:

- **A missing folder does not prove its token is unused, and that gap would have deleted a live
  server's entry.** The MCP server authorizes by token alone; it holds its token and port in
  memory, and nothing subscribes to `onDidChangeWorkspaceFolders` — so a window whose folder is
  deleted, or merely **renamed**, keeps listening and keeps answering. Another window starting in
  that moment saw only "folder gone". So each window stamps `mcp.seen:<folderUri>` at activation
  and on an hourly tick (`markWorkspaceAlive`), and a token is prunable only once nobody has
  stamped it for `seenGraceMs` — **seven days**, chosen long on purpose: these entries accumulate
  over months, so waiting costs nothing, while a few hours would be betting against an extension
  host that was merely suspended. A workspace with **no** stamp at all — one from before the
  heartbeat existed, which is exactly where a live window running an older build hides — is not
  evidence of removal: its grace period is seeded on first sight and it is left alone that round.
  **One consequence to expect on upgrade:** the first window to run this build seeds every
  historical workspace on the machine, so nothing at all is pruned for the first seven days. That
  is the seeding rule working rather than a failure, but the section's opening — "only ever grew"
  — does not lead a reader to expect it.
  The stamp is dropped when the marker is recorded, but **the token is not** — see the completion marker
  bullet below, and item 97. An earlier draft of this sentence said the two were forgotten
  together; that was the pre-completion marker design, and left standing it reads as a rule to uphold,
  pointing a maintainer straight back at the failure item 97 exists to prevent.
- **The project's own `.codex/config.toml` is repaired but never pruned**, and the asymmetry with
  the global file is deliberate. Pruning exists for `~/.codex/config.toml`, which is named per
  project and only ever grew. A project config has one entry, lives inside the folder, is
  routinely committed — and *travels with the folder*, so after a move or a re-clone its entry
  still carries the token minted for the old path. Pruning there deleted a line from a
  version-controlled file of a live project and announced that the project no longer existed. An
  entry that can no longer be placed is what `staleToken` in `Check Connection` is for. The
  sibling `.mcp.json` is left alone in the same situation, and the two now agree.

- **The file surgery and the filesystem question are separate, deliberately.**
  `codexRetiredTables` / `removeCodexTables` in [src/mcpRepair.ts](src/mcpRepair.ts) only ask which
  tables carry which token, through `codexOurTables` — the *same* predicate the repair uses, so
  a table can never be pruned by one ownership rule and rewritten by another. That keeps them in
  the leaf module `npm test` loads directly, which is why the surgery is tested and the stat
  calls are not.
- **Prune first, repair second, in one locked read-modify-write.** Both are expressed as line
  ranges over the same text, so a repair that ran on the pre-prune text would edit lines that
  have moved. Doing them in one `apply` also keeps it to a single locked pass per file; two
  passes would be two chances to interleave with the window next door.
- **A file rewritten only to drop a stale entry is not reported as a port fix.** `Rewrite.repaired`
  is separate from `Rewrite.changed` for exactly that — otherwise the window announces it
  updated a port it never touched.
- **Nothing counts as missing but a proof, and there are two of them.** `presence()` answers
  `present` / `missing` / `unknown`, and only a clean `FileNotFound` is `missing`. Collapsing
  that to a boolean — a bare `catch { return false }` — is how a live project gets deleted:
  `NoPermissions` (macOS gates `~/Documents` and `~/Desktop` behind TCC), a transient I/O error,
  a provider that cannot reach its store and a stalled mount all fail the same way, and every one
  of them happens to a folder that is very much there. The second proof is **the parent directory
  reading `present`**, which is what an unmounted volume or an unreachable share fails — the whole
  branch is absent, not the project — and without it the first window opened with an external
  drive detached would delete the config of every project on it. The two are independent: the
  parent guard says nothing about an error landing on the folder itself while its parent reads
  fine, which is exactly the shape of a permission failure. **Stated precisely, because it is one
  directory level more optimistic than it sounds:** it catches an unmounted volume only where the
  mount point itself disappears (macOS removes `/Volumes/X` on eject) or the project sits below
  the first level. A Linux mount point that survives unmounting as an empty directory leaves a
  project *directly* inside it reading `missing` with a `present` parent. The heartbeat grace
  period **defers** that case rather than covering it: a drive plugged in monthly, or a share
  mounted for one project a quarter, is unstamped for far longer than a week, which is the normal
  lifetime of removable storage rather than an edge case. What bounds it is the completion marker — the
  token survives, so the cost is one `Connect Codex` — and the honest statement is that a
  long-unmounted project can lose its entry and be told it "no longer exists". A laptop suspended
  for longer than a week has the same open tail: the heartbeat cannot tick while it is asleep, so
  a window whose folder was deleted before the suspend can be pruned by whichever window wakes
  first. Both are bounded the same way and neither is closed.
- **Every other state keeps the entry**, and that asymmetry is deliberate: a missed entry is
  tidied on a later start, a wrongly deleted one costs somebody a reconnect. A dangling symlink is
  safe from both sides — VS Code's disk provider resolves one to `SymbolicLink | Unknown` and
  returns it rather than throwing, so it reads as `present`, and a provider that throws instead
  lands on `unknown`. The other exclusions are a folder that is still there (this window's
  included), the `no-folder` token, which never named a folder, and a non-`file` URI, where the
  extension host answering is on a different machine from the folder.
- **Each `stat` is bounded** (`statTimeoutMs`), and the scan runs them in parallel. The list is
  every folder ever opened, and `workspace.fs.stat` has no timeout of its own, so one mount that
  has stopped answering would otherwise hold the whole repair behind it — the same failure shape
  as an unbounded CDP call inside a transition. A timeout answers `unknown`, so it keeps the entry.
- **"Absent" and "could not be read" are different answers here too** (`readConfig`). `readText`
  maps every failure to `undefined`, which is right for a caller that only wants the contents and
  wrong for this one: `apply` read it as "no such file", so a run that never looked inside an
  existing `~/.codex/config.toml` reported itself **complete**, the retired token was forgotten, and
  the entry it identified stayed in a file nothing could ever recognise it in again — the exact
  harm `complete` exists to prevent, entered from the one direction it did not cover. Same rule
  as `presence()`: only a clean `FileNotFound` is absence.
- **A pruned workspace is *marked as handled*, never forgotten** (`handledKeyPrefix`), and the difference
  is the sharpest thing here. Deleting `mcp.token:<folderUri>` looked like the obvious way to stop
  the scan growing without bound — and it removes the workspace's identity, which the comment on
  `_workspaceToken` forbids in as many words: *never regenerate it for an existing workspace*. A
  folder can come back at the same URI — `git worktree remove` then `add`, a restore from the
  Trash, a re-clone into the same directory — and **`.mcp.json` is designed to be committed**, so
  the re-clone brings it back carrying the old token. Regenerate, and `repairClaudeJson` matches
  by token and can no longer see that entry to correct it: every call 401s, the assistant reports
  no tools, and nothing in the extension can repair it. The blast radius was wider than the
  feature, too — the key went for every missing candidate whether or not a Codex table was ever
  found, so somebody who only uses Claude Code and has no `~/.codex/config.toml` at all lost their
  token. So the token stays, a marker records the folder, the scan skips it, and
  `markWorkspaceAlive` clears the marker the moment a window serves that folder again. **The marker
  bounds only what it marks**, which an earlier draft of this bullet overstated as solving the
  unbounded scan outright: a folder that still exists and has simply not been opened for a while
  never gets one, so it is stat'd again on every run for the life of the machine. That is a few
  hundred parallel, individually capped `stat` calls on a long project history — cheap rather
  than free, and not the bound the sentence used to promise.
- **The marker is laid only after a *complete* repair.** The ordering is the load-bearing half — a
  run that lost a lock, could not read a config that exists, or **declined to rewrite one**, may
  not have reached the entry the token identifies, and recording a completion marker first takes it out of the scan
  while it is still there. `RepairReport.complete` exists for this; it replaced `lockBusy`, which
  was written and never read. That last clause was missing for a revision: the refusals of item
  105 were added without extending `complete`, so a run that deliberately left the entries in
  place still called itself complete, the marker was recorded — and since only `markWorkspaceAlive`
  clears a marker, and that needs a window *serving* the folder, the entries could never be looked
  at again even after the user repaired their TOML. A refusal now reports itself, `Prune.refused`
  → `Rewrite.refused` → `complete`.

  **And those flags are scoped to `~/.codex/config.toml` alone**, which is the second half and was
  missing for a revision. `complete` gates nothing but this marker, and only the global file can
  hold a pruned entry — so sharing one set of flags across all three configs meant the *project*
  `.codex/config.toml`, rewritten with an empty prune set, could block the marker for ever with an
  unterminated value of its own. That file is committed and travels with the project, so it stays
  broken, and the folders the global prune really had cleaned were re-stat'd on every activation
  for the life of the machine. See item 112.
- **`codexRetiredTables` refuses our own token as well**, although `missingWorkspaceTokens` already
  does. It is the function that deletes, the parameter is **required** so it cannot be omitted by
  accident, and a caller assembling the set some other way — a future window registry, a test —
  would otherwise wipe the config of the window it is running in.
- **The cost of a deletion, stated plainly:** `repairConfigs` never *creates* an entry, so a
  pruned project does not get one back by being reopened — the user presses `Connect Codex`
  there once. That is the whole price, and it is why the bar for "provably gone" is set where it
  is rather than at "the port does not answer", which is also true of every window that is simply
  closed.
- **What `codexStrangers` still reports is several groups, and the message must not collapse
  them.** It compares against *this window's* token only, so the list holds entries of other
  **live** projects and windows (tokens this machine did mint, folders still there); entries
  carrying a token it never minted, from a config synced off another machine or one predating a
  `globalState` reset; and stale entries the prune deliberately did not touch — a folder deleted
  together with its parent, a document it refused to rewrite, a window still inside its grace
  period. Two wordings have over-claimed here in opposite directions: "cannot be matched to a
  project on this machine" is false for the first group and invites removing a working
  neighbour's server, and "cleaned up on its own after a week" is false for the second and third
  and sends the user off to wait instead of running the one command that works. All of them are
  left alone, and the text says only what is known — the token is not this window's.

**Four ways the repair itself corrupted a config, all found by review and all now tested.**
Each one is the kind that only fires on somebody else's config, which is exactly why they are
worth writing down:

- **The rename can collide.** Our token in a `tab-browser` table while an `ai-browser` table
  belongs to someone else: renaming ours produces two `[mcp_servers.ai-browser]` headers, which
  is TOML that does not parse — every MCP server the user has, gone, unattended, at window
  start. The `.mcp.json` version of the same mistake silently *overwrote* the stranger. When
  the target name is taken by something that is not ours, the entry keeps the name it has.
- **A value can span lines.** A triple-quoted `url` and an `enabled_tools = [` both continue
  onto the next line, and replacing only the key's first line strands the continuation and its
  closing delimiter as garbage. `CodexEntry` gained `valueEndLines` for this, and every value
  edit replaces the whole range.
- **Not every sub-table of ours is ours to delete.** Dropping `<name>.http_headers` is right —
  we replace it with the inline form — but the same condition was eating
  `<name>.env_http_headers`, which is the user's.
- **Two lock names for one file is the same as no lock.** The connect path and the repair path
  write the same `~/.codex/config.toml`; they now derive the lock name from the URI
  (`configLockName`) so they take the same one. Every repaired file is locked, not just the
  global one — two windows on the *same folder* share a token and hold different ports, so both
  recognise the same entry as theirs. The lock does not decide which wins (the last start does,
  and either port authenticates, since the token is the same) but it keeps the two
  read-modify-writes from interleaving.

**The ownership rule is deliberately written twice**, in `codexOurTables` and in
`codexEntryCarriesToken`. Both are leaf modules that `npm test` loads directly, so neither may
take a relative value import of the other — the constraint under
[Recipe for the next feature](#recipe-for-the-next-feature). Duplication here is a real hazard:
the two versions had drifted, so the same entry could be silently rewritten by the repair and
reported by the check as a stranger to delete. A test in
[src/mcpRepair.test.ts](src/mcpRepair.test.ts) asserts the two agree on a table of cases; add
to it rather than trusting that they still match.

**`server.url` must be captured before the first await.** It is a getter over the live port, so
it goes `undefined` the moment the server is disposed — a setting toggled, a window closing —
and a repair can be sitting on a lock when that happens. Reading it afterwards wrote an empty
`url` into the user's config.

**The repair may only ever *narrow* what it changes, and three more ways it did not.** Found by
review after the first round, and each is the same mistake seen from a different angle — a
rewrite that was broader than the thing being corrected:

- **A sub-table has to follow its parent across a rename.** Migrating `tab-browser` to
  `ai-browser` left `[mcp_servers.tab-browser.env_http_headers]` behind, and TOML then
  *recreates* `mcp_servers.tab-browser` from it — so the settings are lost to the real server
  and a second, urlless one appears in their place. Every sub-table of ours is renamed with the
  table it belongs to.
- **`http_headers` is merged, not replaced.** Writing
  `{ Authorization = "Bearer …" }` over the whole inline table deleted an `X-Org` the user had
  added, on every start, even when the URL was already right. Only the authorization is ours to
  set. `parseInlineTable` / `mergeAuthorization` do exactly as much inline-table handling as
  that needs — the same reasoning as the mini TOML parser next door.
- **A header *sub-table* is now kept and edited, not flattened into the inline form.** The
  conversion was lossy for the same reason. The one case where it still goes is a sub-table
  sitting *beside* an inline `http_headers` — two sets of headers on one server is ambiguous,
  so its keys are folded into the inline table and it is removed.

A scenario deliberately out of scope: an entry whose *token* is stale is not ours to recognise
at all, so repair cannot touch it. That is what `staleToken` in the check is for.

**And `Check Connection` gained a state it was missing.** `wrongPort` — our token, a moved port
— used to be reported as `otherServer`. The old test suite even encoded the mistake: its "a
different port is another server" fixture used `…:49999/mcp/abc123`, which carries the token
under test, so it was asserting the wrong answer for our own entry. It is now two tests.

### The server is per window; the tools act on one tab, chosen per call

The token and port belong to the **workspace**, so "connecting" attaches an assistant to this
VS Code window rather than to a browser tab. Which tab a tool then drives is decided per call by
`BrowserController._resolveTab()`: **the tab selected by id, else the active browser tab, else
the one last used, else the most recently opened.**

**`browser_tabs` and `browser_select_tab` are what make more than one tab workable**, and the
first thing to know is that **the ids are ours.** `BrowserTab` in the proposal carries `url`,
`title`, `icon`, `startCDPSession()` and `close()` — no identity at all, and the extension host
keeps its own id private. So `_tabIds` mints `tab-1`, `tab-2`, … keyed on the tab *object*,
which works only because that object is stable for the life of the tab (the host builds `value`
once and `update()` mutates fields in place). They are per window and per session, hence the
tool description telling a model to list before it selects: an id from an earlier conversation
means nothing.

A selection **outranks the focused editor**, which is the whole point — "work on this one" has
to survive the user reading a different page — and that is exactly why the user's own commands
do not go through `_resolveTab()`. `copyScreenshot` passes `browser.focusedTab`, so a toolbar
button always captures the tab in front of the person who pressed it, whatever an agent has
selected. `capture()` takes the tab as an argument for that reason, and returns the URL it
captured so the file name comes from the page in the image rather than from a second lookup that
could resolve differently. Keep any future user-facing command on the same side of that line.

A selection is dropped when its tab closes — falling back beats refusing every call until
something selects again — and `selection` in `browser_state` / `browser_tabs` is what reports
which of the two is in force.

`navigate` with `newTab` **selects** the tab it just opened, whether or not anything was
selected before, or the next tool would go back to the page the caller chose to leave. It has
to be explicit: the tab is opened with `preserveFocus`, so the *old* tab stays active and wins
the focused-tab branch, which sits above `_lastTab`. This was once guarded on a selection
already existing, and the symptom of that is worth recognising — the call reports `tab-2` and
every following tool acts on `tab-1`. The other way into the same branch, "no tab was open at
all", deliberately does *not* select: nothing was chosen, so the user's focus should still lead.

**`browser_snapshot` only ever hands out a selector that resolves back to the element it
describes**, checked in the page with the same `document.querySelector` call that `click` and
`fill` will make. Without that check the builder fell back to the bare tag name, so two
buttons with no `id` and no `name` were both reported as `button` — and since `querySelector`
returns the first match, an agent told to press Delete pressed Save, successfully and
silently. The order is unique `id`, then `tag[name=…]`, then a positional `:nth-of-type` path;
an element that cannot be addressed from `document` at all, such as one inside a shadow root,
is listed with no selector rather than with a wrong one.

**`vscode.window.activeBrowserTab` alone is not usable for this, and that was a real bug.** The
extension host sets it from `activeEditorPane?.input instanceof BrowserEditorInput` and nothing
else, so it is `undefined` the moment any other editor is focused — a file, a diff, a chat.
That is the normal thing for a user to do while an agent works, and until the fallback existed
every tool answered "No browser tab is open" for as long as a document had focus, while the
page sat there in plain sight. The memory is a plain field, revalidated against
`vscode.window.browserTabs` (tab objects are identity-stable, which `_sessionFor` already
relied on), so a closed tab is never handed out.

Pinning the controller to one tab **at connect time** was the other design, and it is now moot:
the selection is explicit, driven by the model when it needs it, rather than implied by which
tab happened to be focused when a config file was written. Describe the behaviour as "attached
to a VS Code window, acting on the selected browser tab, or on the one in front of the user".

**`browser_navigate` reuses that tab instead of opening one**, which is the whole reason the
resolution above matters. `openBrowserTab` is the only thing the `browser` proposal offers and
it always mints a new editor — `$openBrowserTab` generates a fresh id per call, so VS Code
cannot even collapse the results into one preview slot — and an agent navigating ten times left
ten tabs behind. So `navigate` drives the resolved tab with `Page.navigate` over the session it
already holds, and only calls `openBrowserTab` when there is no tab at all or the caller passes
`newTab: true`. Two things fall out of it, both wanted: the console stays attached across the
load, so the new page is captured from its first line, and the result reports `openedNewTab` so
the model knows which happened.

Three details in that path are load-bearing. The `Page.loadEventFired` listener is registered
**before** `Page.navigate` is sent, or a fast load fires it before anything is listening and the
wait runs to its full 15s for a page that is already there. A rejection carrying
`CDP session closed` is retried exactly once with a fresh session, because the host can drop a
session between two calls — narrow on purpose, so a genuine navigation failure still reports
itself rather than being attempted twice.

And **the wait only happens when `Page.navigate` reports a `loaderId`.** A same-document
navigation — `/docs` to `/docs#intro` — loads nothing and fires no load event, and CDP signals
it by omitting that field ("the previously committed loaderId would not change"). Waiting
unconditionally made every anchor change take the full 15s timeout and then answer correctly,
which is the worst shape a bug can have: right answer, absurd latency, nothing in the logs.
Measured against a stubbed CDP channel: 12 ms for the anchor, ~350 ms for a real load.

**Two other tab sources are not ours and cannot be fixed from here.** `aiBrowser.show` /
`api.open` / the external URI opener go through `workbench.action.browser.open`, which also
opens a new tab per call; it does accept an undocumented `{ url, reuseUrlFilter, openToSide }`
options object (glob-matched on authority and path, scheme compared only when the filter starts
with `scheme:`) that navigates a matching existing tab instead, but it is in no `.d.ts` and no
built-in extension uses it. And a page's own `window.open` / `target="_blank"` becomes a new
editor tab in the main process (`setWindowOpenHandler` → child view with `pinned: true`), which
`browser_click` reaches through `el.click()` like any other click.

### Giving a tab to an assistant

The user hands **one tab to one assistant**, and several assistants can be on the same tab.
`src/shareRegistry.ts` owns the rules — a leaf with tests, no `vscode`, no CDP — and the
controller above it only resolves CDP sessions and drives the browser.

**The map runs assistant → tab, and the direction is the design.** Keyed the other way it would
be a set per tab, and "which tab does *this* call act on" — the only question a tool ever asks —
would need a scan. This way several assistants pointing at one page falls out for free, while
one assistant is never in two places at once.

Three levels of intent, resolved most specific first:

| level | who sets it | can the model release it |
|---|---|---|
| one conversation (`Mcp-Session-Id`) | the user | **no** |
| one assistant (`claude` / `codex` / `other`) | the user | **no** |
| every assistant with no tab of its own | the user | **no** |
| `_pins` — one per caller | the model, `browser_select_tab` | yes |
| automatic | focused → last used → most recently opened | n/a |

**A conversation is addressable but not identifiable**, which is why the UI assigns by
*assistant* today: `Mcp-Session-Id` is minted per `initialize`, so it changes on every restart,
and MCP carries no name or cwd to tell two Claude conversations apart — only "called 5s ago",
which `Check Connection` already reports. The registry takes session-scoped targets, so the day
that is worth exposing the rules are already in place.

**Who is calling is passed, not parked.** `Tool.run(args, caller)` and `dispatch(request, ctx,
caller)` carry it, and the field it replaced (`beginCall` / `endCall` around a single `_caller`)
could be cleared by a second overlapping call while the first was still running. That was
tolerable while it only decided a *label*; it decides which tab a call acts on now, and a tab is
not a label.

**Everything that was per window had to become per caller, and four things were missed** —
all found by review, all reproduced against a stubbed channel:

- **The model's own selection** (`browser_select_tab`) was a single field. Codex selecting a tab
  redirected *Claude's* next call to it, `browser_state` reported `selection: "selected"` to a
  caller that had selected nothing, and giving a tab to one assistant cleared the field for
  everybody — so an unrelated assistant silently changed page. It is `_pins`, keyed by
  `callerKey`.

  **Which pins an assignment clears is a rule, not a key.** An assignment outranks a selection,
  so a shadowed pin has to go — otherwise it resurrects a stale choice the moment the assignment
  is released. Deriving one key from the target was not the same thing: a Codex *conversation*
  keeps its pin under `session:<id>`, so giving Codex a tab deleted `kind:codex` and left the
  conversation's own pin behind, which it went straight back to as soon as the assignment was
  released — and "share with all assistants" cleared only `kind:other`. So each pin is asked
  where it resolves *now*, and the ones landing on the assignment just written are cleared: one
  rule for a conversation, an assistant and everybody, while a caller with a narrower assignment
  of its own keeps its selection. A pin therefore records the caller it belongs to, not just the
  tab.

  **And the fallback below it had to move with it.** `_lastTab` was written by `selectTab`, by
  `shareTab` and by `navigate`'s new-tab branch — one caller's choice recorded in a field every
  caller reads — so with no browser tab focused, which is the normal thing to do while an agent
  works, an unassigned caller fell through to it and got the page somebody else had chosen. The
  per-caller pin had fixed the level above and left this one window-wide. It now means only
  "the tab the user was last looking at", written where the user's own focus was seen and
  nowhere else. Reproduced both ways.
- **`Mcp-Session-Id` → assistant lived on the server instance** and was cleared on dispose, so
  anything that restarts the server (`aiBrowser.mcp.port`, the enabled setting) made every live
  conversation anonymous: `initialize` had happened against the old instance, the new one saw
  `other`, and an assistant that had been given a tab went back to following the user. The map
  belongs to the window, so `McpLifecycle` owns it and hands it in.
- **A closed tab was only cleaned up if it held an assignment.** Closing an ordinary tab — the
  common case — left its `TabSession` undisposed and still counting against the session limit,
  and kept the element picked on it keyed to a tab that no longer existed.
- **Usage was reported per tab, not per assignment.** Let Claude use a tab, then give the same
  tab to Codex, and Codex was immediately shown as "working" — suppressing the one hint that
  matters, that it has not picked the tab up and may need restarting. `usedByTarget` filters to
  the assignment's own assistant; the everyone assignment still reports everyone.

**Isolation has to hold on every path, and three of them missed it at first** — all found by
review, all reproduced:

- **`browser_screenshot` was calling `capture` with no caller.** With the caller now optional —
  that is how a command the *user* pressed is recognised — a missing argument read as "the user
  pressed this", so an assistant assigned one tab got a picture of whichever tab the person was
  focused on, and a paused one got a picture at all. Reproduced against an unrelated tab.
- **A paused caller was handed the whole tab list.** `browser_tabs` computed its visible set from
  "has an assignment", and a paused caller has none in that sense, so it fell through to every
  open tab — addresses, one-time links, query-string tokens — next to `selection: "paused"`.
  Paused now returns an empty list and withholds the count as well.
- **The picked element was one field for the window.** `browser_selected_element` handed whoever
  asked the context picked on the *other* assistant's page. It is a map keyed by tab now, read
  through the caller's own assignment, which also retires an invalidation that had to be
  remembered on every path that changed tabs.

**An assistant with a tab of its own sees no other.** `browser_tabs` returns that one tab and a
count of the rest, `browser_state` the same, and `browser_select_tab` refuses. Listing every
other tab was defensible while nothing could be selected — "they are context" — but a user who
gives one page to an assistant is bounding what it can see, and every other address in the
window (one-time links, tokens in a query string) is not part of that. An assistant with *no*
assignment still sees everything and follows the user: nothing has been bounded.

`browser_select_tab` was the only way to fix the tools on a tab, and it is called by the *model*
— so the user had no way to state the same thing, and without a selection every call followed
`activeBrowserTab`. Click into another page while an agent works and the agent went with you;
`browser_navigate` then drove the page you had just opened. A share sits above the focused
editor for that reason, and above the model's pin so it cannot be handed back.

**Connecting from a browser tab now shares that tab**, and this was a real report rather than a
refinement: "the agents go into the active tab, not the one I connected them to" — from someone
who had never pressed `Share Tab with Assistants`, because nothing led them to it. The wording is
what did it. "Connect Claude Code" reads as *connect it to what I am looking at*, while the
server has always belonged to the **window**, so without a share the tools followed whichever
tab was active — behaving exactly as designed and looking broken. Two changes, both in
`extension.ts` / `mcpSetup.ts`:

- a connect made while a browser tab is focused shares it, names the page in the confirmation,
  and tells the model in the pasted prompt (stated, not asked for — the paste stays a *check*,
  so it says "for when you do use them" rather than sending the model off to the page);
- a connect made from anywhere else — the setup case, where the config is written long before
  there is a page — shares nothing and says what the alternative is, naming the command.

The share entry in the status bar menu is also offered when it *cannot* act, for the same
reason: it used to be hidden whenever a browser tab was not focused, which is exactly when
somebody goes looking for it. Picking it runs the command, which explains what it needs.

**"Nothing is focused" and "no tab exists" are two different facts, and the menu used only
one.** Everything about giving a tab away was gated on `focusedTab`, so with **no browser tab
open at all** the menu still offered "Give a tab to an assistant" — and the connect rows still
read "Connect Claude Code *and share this tab*", naming a tab that did not exist. Reported as a
plain error, and it is one: a menu that offers to hand over something the window does not have.
So `hasOpenTabs` gates the section, and the connect labels carry the "and share this tab" half
only while something is focused — the command itself already shared whatever was focused and
nothing otherwise, so only the promise was wrong. The same conditional wording is in the
`Check Connection` report, whose buttons run those same commands, and it asks the controller
rather than re-deriving the focus rule: a second copy of `focusedTab` would drift, and drifting
reproduces exactly this mislabelling. The dropdown on the browser tab needs none of this: it
only renders while a browser tab is the active editor.

**A palette title cannot be conditional, so it has to be true in every state** — which is why
`command.connectClaudeCode.title` is plain `Connect Claude Code` again rather than
"… and Share This Tab". The manifest string is one string for every surface, including a window
with no browser tab in it, and a title that promises a share the command will not make is the
same defect one surface along. The sharing is said where it can be conditional: the status bar
label, the report's buttons, and the confirmation the command itself prints.

The trade-off is worth stating: someone who connects with a tab open now has a share they did
not ask for, and if that tab is closed the tools pause. That is visible — 🔗 in the status bar,
the row naming the page in that item's menu, and the confirmation naming `Stop Sharing Tab` — and
the alternative was a feature nobody found.

**A closed tab pauses the assistants that were on it, and nobody else.** A pin reverting to
automatic is right for a choice the model made; doing the same to the user's choice resumes work
on whatever happens to be focused, which is the failure this exists to prevent. So the
assignment moves to `lost` rather than being deleted — "the page you were given is gone" and
"you were never given one" are different answers, and deleting the entry would silently turn the
first into the second. The paused assistant answers `shareLostMessage`, which names *it*, while
every other assignment in the window carries on. **A paused caller does not fall through to a
broader assignment either**: resuming Claude on the page everybody else follows is undoing the
instruction just as thoroughly as resuming it on the focused tab.

**A command the user pressed carries no caller, and that is now the whole of the distinction.**
It used to be a `user` flag threaded through `_resolveTab` and `capture`, and forgetting it in
one branch was enough to answer a toolbar screenshot with "No browser tab is open" while another
tab sat in plain sight. With the rules in the registry there is nothing to forget: a paused
assignment belongs to one assistant, so it cannot spill onto a person who never had one.

**Two refusals, because the alternative is a silent no-op.** Under a share,
`browser_select_tab` cannot take effect and `navigate(newTab: true)` would open a tab that the
next tool ignores — the "reports `tab-2`, acts on `tab-1`" shape recorded above. Both throw and
say who can change it. Navigating *inside* the shared tab stays allowed: the share is on the
tab, not on the URL.

**Use is recorded at the point a tab is handed out, not per request.** `_noteTabUse` runs when
`_requireTab` gives a caller its tab. Deliberately not "an assistant made a call":
`browser_tabs` and `browser_state` answer without touching a page, and a marker lighting up on
those would claim work on a tab nothing had opened.

**Every `tools/call` is attributed, `other` when the client cannot be named.** The transport
passes `kind ?? 'other'`, and the fallback is the point: only `initialize` carries
`clientInfo.name`, so a client that does not echo the `Mcp-Session-Id` header back is anonymous
on every call after it. Gating attribution on a *recognised* client left the marker reading 🔗 —
"nobody has picked this up" — while that very client was driving the page, which is the one
thing the marker exists to tell apart.

**Moving a share is a transaction, and tool calls wait for it.** Sharing is several async steps
over the fields the tools read — the marker comes off one page, the session moves, the marker
goes on another — and a call landing in the middle interfered with it in two ways at once, both
reproduced with a concurrent `browser_snapshot`:

- the call resolved the **new** tab, so `_sessionFor` dropped the session the cleanup was still
  using. The marker stayed on the old tab, and *nothing could ever remove it*, because
  `stopSharing` only knows the current one;
- the call itself failed with `The browser session was replaced while it was opening` — an
  internal sentence handed to a model.

Three things fix it, and each covers a different part:

- **`_transact` / `_settle`.** Transitions run in call order (two clicks on "Share this tab
  instead" cannot interleave), and every path that resolves a tab — `_withSession`, `navigate`,
  `capture`, `inspectElement`, `state`, `tabs`, `selectTab` — awaits `_settle()` first. Measured
  against a stubbed CDP channel: a snapshot fired during a switch now opens **no** extra session
  (one per tab) and answers on the new tab.
- **`_clearIndicator` has a second route to the page.** The gate orders calls that *arrive*
  during a transition; one already past it can still be holding the session the transition
  drops. So the cleanup tries the cached session first — it holds the registration identifier,
  and removing that is what stops the marker coming back on the next navigation — and falls back
  to a session of its own, which nobody else can drop. This is why `ShareIndicator.clear()`
  **returns a boolean instead of covering its failure**: "the marker is off" and "the channel
  died before it could be taken off" must not look the same to the caller that has another way
  in.
- **Eviction passes over a tab somebody is *using*, not only an assigned one.** "Least recently
  used" is really "least recently acquired" — `_touch` runs when a session is handed out, not
  while it works — so the longest-running call sat at the front of the queue: a
  `browser_wait_for` on a pinned tab was evicted by another assistant opening tabs and answered
  the model with the internal `CDP client disposed`. A pinned tab is claimed as well as an
  assigned one, and the tab whose session has *just arrived* is never the target: it is both the
  most recent and unassigned, so the spare search chose it and handed the opener a session that
  had already been disposed.
- **A session that arrives unwanted closes itself.** With one session per tab the only reasons
  are that the controller was disposed or the tab closed, both of which `_sessionFor` checks
  when the open lands — the retry, the token and the `_stillWanted` predicate that a single
  cached session needed are gone with the shape that needed them.

**The lazy loss of an assignment must refuse, not act.** Resolution is what *discovers* an
assigned tab that has gone — the only detector on a host that does not fire
`onDidCloseBrowserTab` — so a gate read before it can still be looking at an assignment this
very call is about to end. `navigate` is the one tool that *acts* rather than refusing, and in
that window it opened a brand-new tab at a model-chosen URL and reported `openedNewTab: true`
while every later call refused. It re-checks after resolving, and so does `_requireTab`, which
had been answering the worse refusal of the two: "No browser tab is open … call
`browser_navigate` with a URL first", an instruction to take the one action that bypassed the
pause.

**An assignment is written *before* the tab it moves off is cleaned**, and that order is
load-bearing: while the registry still named the old tab, a concurrent tool resolving it could
send `_sessionFor` down the arm-on-open path and re-mark the very tab being cleaned.

### Where a share is visible

An assistant driving a page in the background looks exactly like an assistant doing nothing, so
a share has to be visible somewhere. Two facts have to come across, and only the second one
means work is happening:

| | |
|---|---|
| 🔗 | given out, nobody has driven it yet |
| 🤖 | an assistant has driven it at least once |

Both live in the **workbench**, in two places that read as one indicator because they use the
same two glyphs:

- `$(globe) AI Browser 🔗` / `… 🤖` on the status bar item, or `… $(debug-pause)` with a warning
  background when a shared tab was closed and the tools are paused — the one share state that is
  waiting on the user. With more than one assignment the item counts them rather than listing
  them: a status bar is peripheral vision.
- the **Shared tabs** section at the foot of that item's menu, which names each assignment, the
  page it holds, and which of the two states it is in. The unused state is the one that needs
  words, and it gets them: *"Has this tab but has not called yet. It does not re-read its MCP
  config, so if it reports no browser tools, restart its session — the config is already
  correct."* That sentence is the entire diagnosis for the most common failure this feature has,
  and since the tab itself no longer says anything, this row is the only place it is stated.

**The tab itself is not marked, and writing into the page must not come back.** The marker used
to be a suffix on `document.title`, installed over CDP with
`Page.addScriptToEvaluateOnNewDocument` plus a `MutationObserver` to re-apply it — the editor
tab of a browser view is labelled from the page title, and nothing in the `browser` proposal
lets an extension decorate that tab. It was removed on request, and the reasons are worth
keeping because they are what a reader would otherwise rediscover as "the obvious place to show
this":

- **It was an edit to somebody else's live document to say something about our own state.** Two
  whole functions existed to undo it on the way out — `stripMarker` for every title the
  extension reports and `stripMarkerFromHtml` for `browser_html`, the one tool a model uses to
  *verify* a page — and every new call site was a fresh chance to miss one. Breaks-silently #30
  was filed twice for exactly that.
- **And the undo could not be made correct**, which is what ended it. `BrowserTab.title` is not
  `document.title`: VS Code composes it as `<title> (<url>)`. Measured on a shared tab, the API
  returned
  `'Picto ERP\u2009🔗🟦 (http://localhost:3000/en/auth/login)'` — our suffix in the **middle** of
  the string, where `stripMarker`, which takes a suffix off the end, cannot see it. So the marker
  reached the connect prompt, the tool results and the status bar tooltip with nothing able to
  remove it. Every fix for that is a second guess at a format the host is free to change.

A floating badge injected into the page was the *other* candidate and was rejected earlier, for
a related reason: it lands in every screenshot the agent takes and shows up in `browser_html` /
`browser_text` as page content that is not the page's. Both rejections are the same rule — the
page is not ours to annotate.

What is left in [src/shareIndicator.ts](src/shareIndicator.ts) is the reading half, and each
piece has its own reason to stay:

- `sharedMarker` / `inUseMarker`, because the status bar and the menu still show them;
- `stripMarker` / `stripMarkerFromHtml`, because a page an earlier build reached can still be
  open with its observer re-applying a suffix on every title change;
- `legacyMarkerRemoval`, a one-line expression sent on every `TabSession.open`, which calls the
  old installer's `remove()` and disarms that observer. It is a **migration**: without it the
  last marker this extension ever wrote would be permanent, the code able to reach it being the
  code that was deleted. It needs no `Page.removeScriptToEvaluateOnNewDocument` — the old
  registration belonged to a CDP session that has since closed, and such a registration dies
  with its session. Delete both once no build that installed a marker is plausibly still
  running.

**`ShareRegistry.stateOf` became `isShared`** in the same change. It used to answer a
`TabShareState` — `used`, the assistant-specific owners, whether it was given to everyone —
because the title suffix was composed from exactly those facts. With the suffix gone every
caller asked only whether the result was `undefined`, and the status bar builds its own richer
view from `targetsFor` / `usedByTarget`. Returning a struct nobody destructures is the
`Tool.slowMs` mistake: a field with no consumer reads as a contract and is not one.

**`_transact` / `_settle` stay.** The gate was introduced because a tool call landing in the
middle of a share transition dropped the CDP session the marker cleanup was using, and that half
is gone — but the transition still rewrites the registry, `_pins` and `_sessions`, all of which
every tool reads, so ordering the transitions is still doing work. `bounded` and
`indicatorTimeoutMs` went with the marker: they existed only to keep an unresponsive page from
hanging the gate, and nothing inside a transition talks to a page any more.

**Re-sharing the tab that is already shared is still a no-op.** The toolbar entry sits in the
shared tab's own menu, so it is one click away, and clearing `_usedBy` there took the status bar
from 🤖 back to 🔗 and the menu row back to "has not picked it up yet" — advice for a broken
setup — while the assistants carried on working. The context key cannot express "this tab is the
shared one", so the menu keeps the entry (it is also how a share is *moved* from the toolbar)
and the transaction absorbs the repeat.

**`_shareTab` refuses a tab that has closed.** Its body can run after the click that queued it,
so the tab can be gone by its turn — and adopting it left the UI advertising a share on a tab
that no longer existed, with `tab-0` for an id, until some tool happened to resolve a tab. The
command reports the refusal through `refuse()`, never a toast.

**One CDP session per tab, not one per window** — `_sessions`. A single slot was tenable only
while the tools acted on one tab: with Claude on one page and Codex on another it would be
dropped and re-opened on every alternating call, which costs a handshake each time and, worse,
loses the **console** — capture only happens while something is attached, so a buffer thrown
away every other call reports an empty log for everything that mattered. That is the entire
reason a session is cached rather than opened per call, and the harness checks it: two
assistants, two tabs, each reading its own log.

The map also retires machinery rather than adding it. With a session per tab an arriving open is
only ever unwanted because the controller was disposed or the tab closed — never because
somebody asked for a different tab — so `_openToken`, `_stillWanted` and the bounded retry that
guarded "superseded while opening" are **gone**, along with the class of bug they existed for.

It is bounded at four, because a session is a live channel into a page and an agent can open tabs
all day. Eviction passes over a tab somebody is assigned to while any unassigned one remains:
throwing away the page an assistant is working on — and the console buffer that is the whole
reason the session is cached — to make room for a page nobody asked about is the wrong trade
every time.

**Eviction passes over a session that is *being used*, and that is counted rather than
inferred.** "Least recently used" is really "least recently **acquired**" — `_touch` runs when a
session is handed out, not while it works — so the longest-running call sat at the *front* of the
queue and was the first thing dropped when a fourth tab opened a session. The caller was then
answered with the internal `CDP client disposed`, the one error the code singles out as reading
to a model as a broken browser rather than as something to retry. An earlier round added pins to
`claimed` and fixed only the pinned instance: an assistant with **no** share and no selection is
the default state, not an edge case, and it was still evicted mid-call.

So every route to a session takes a hold for the length of the work (`_hold`, counted in
`_inFlight`), and `_withSession` became a **scope** rather than a hand-out —
`_withSession(caller, session => …)` — precisely so a new call site cannot opt out of the rule by
forgetting to release. It is released in a `finally`, so a page-side throw cannot leave a tab
claimed for the life of the window, and the release is idempotent, or a double `finally` would
drive the count negative and pin a tab out of the queue for good. The routes that do not go
through `_withSession` take their own: `_navigateInTab` (the longest hold there is — a load event
is waited for up to 15s), the direct `capture` path, and `_borrowSession`.

**The hold is taken before the open, not after it**, and the difference is a real race rather
than a nicety. `_sessionFor` resolves into a microtask, so another tab's open can run its own
`_evict` between the session being put in `_sessions` and the caller recording that it is using
it — at which point the tab reads as a spare and is dropped under the caller that just asked for
it. Holding first covers the open as well as the work, and a tab with no session yet is simply
never a candidate, so the early claim costs nothing.

**Being used is a hard constraint; being assigned is only a preference**, and collapsing the two
into one predicate was the same bug one step along. With one `claimed` test and a
`?? candidates[0]` fallback, four calls in flight left no spare — so the fallback dropped the
session of the *first* of them and the guard above it did nothing at all. The two differ in what
eviction costs: an assigned but idle tab loses its console buffer and reopens on its next call,
while a tab with work in flight loses the call itself. So the search is ordered — unassigned and
idle, then assigned and idle — and **never** returns a tab that is working.

**When every candidate is working, a new open queues for a slot rather than taking one.**
`_evict` cannot help there — it will not drop a session in use — so without this the count simply
drifted up with concurrency. `_awaitSlot` holds the open until `_hold`'s release frees a session
(`_notifySlots`, run after the sweep so a waiter sees the slot it freed) — and from
`_dropSession`, **whoever** freed it. Waking only from `_hold` and from an open settling missed
every other way capacity comes back: a tab closing, `navigate`'s `CDP session closed` retry, the
stale-cache branch. A queued open then sat there for its whole timeout with a usable slot in
front of it. The one exception is a drop `_tryReserve` itself causes, which is making the slot it
is about to take — `_reserving` suppresses that, or the reserver hands its own slot away and
drops a second session to replace it.

**The slot is *reserved*, not merely checked for, and that distinction is the whole mechanism.**
Asking "is there room?" and then opening was wrong in two ways at once, both reproduced against
the stubbed channel:

- `_notifySlots` wakes every waiter, and resolving a promise does not run its continuations
  before the next waiter is called — so all of them saw the *same* freed session and all of them
  went on to open. One release has to admit exactly one waiter.
- a check against `_sessions` alone is blind to opens already under way, so callers arriving
  together at a cold start all passed while the map was still empty: **six simultaneous calls
  opened six channels against a limit of four.**

`_tryReserve` closes both by counting `_reserved` alongside `_sessions` and taking the permit
synchronously, before anything awaits, so the second caller in the same turn already sees it.
**The permit is given back in the same turn the session lands**, beside `_sessions.set`, never on
a trailing `.finally` — that runs a microtask later, and for that tick the session is counted
twice, once as a reservation and once as itself, so a `_tryReserve` landing in the gap reads the
sum as one over and evicts a session that did not need to go. The `finally` remains only for the
paths that never got that far: the open failed, the tab closed under it, the controller was
disposed. `releaseSlot` is idempotent so the two cannot both fire. It also *makes* the room
rather than promising it — dropping a session the sweep would have given up — so what a caller is
handed is capacity that exists. `_evict` and `_tryReserve` share one `_evictableTab`, or capacity
could be taken under a rule the sweep would not have agreed with.

**The wait is bounded, and that is the half that matters.** A plain queue starves:
`browser_wait_for` takes its timeout from the caller and may hold a session for a minute, so four
of those would block every new tab for as long as they ran — and a tool call that hangs reads to
a model as a dead browser while its client's own timeout fires regardless. So `_slotWaitMs` (5s)
gives up waiting and opens anyway — but only as far as `_sessionOverflow`, one channel, which the
next release reclaims. **Granting unconditionally there was the bound removed exactly where it is
needed**: every waiter owns its own timer, so four busy sessions and N waiting calls opened
`4 + N` channels, and since each new tab is immediately in `_inFlight` nothing could evict them
until their work ended. Past the ceiling a call is refused instead, with something a model can
act on — the calls already running will finish, and a retry then finds a slot. An honest refusal
beats a limit that only holds while nothing is happening. The pathological case degrades to the
previous behaviour rather than to a hang — the same shape as `repairQueueWaitMs` and for the same
reason (item 122). Ordinary calls finish well inside it, so in practice the bound holds exactly.

`dispose` releases the queue (`_notifySlots` under `_disposed`), or a pending waiter's timer
holds the host's event loop for `_slotWaitMs` after the window is done with the controller.

**A one-off read still must not take a session that is in use** — `_borrowSession`. `capture`
with a tab named by the caller (the toolbar passes the one in front of the user) reuses that
tab's session if there is one and otherwise opens a throwaway, the same shape the element picker
uses; `capture` with no named tab is acting on the tools' own subject, so that one is cached —
routing every capture through the throwaway path quietly cost the console its priming.


### Lifecycle

[src/mcpLifecycle.ts](src/mcpLifecycle.ts) keeps the server's disposables **apart from
`context.subscriptions`**: switching the setting off must give the port back without tearing
down the extension. Restarts are serialised through a promise chain, or two setting changes in
a row race for the same port. Commands are registered unconditionally and go through
`withServer`, which explains why there is nothing to connect — better than "command not found".

**The repair has a chain of its own** (`_repairs`), separate from `_chain`. Activation must not
wait on a filesystem survey, so `_apply` does not await the repair — which allowed two repairs to
be in flight at once, with the file lock alone deciding which landed last. The generation check
under the lock is the last word before a write and is still not enough on its own: an older repair
can take the lock before the generation moves, pass its check, and be inside `writeText` when the
newer run arrives to find the lock held and give up after its one second. Chaining the repairs
makes the newest always write last. See item 117.

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
(`1_copy`, `2_shot`, `3_assistant`, `4_share` at the top level, `1_add` and `2_mcp` inside each
assistant's submenu) are the running order of the menu — see
[the dropdown](#the-dropdown-on-the-browser-tab) for the whole tree.

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

**Not part of the repeat button.** The twelve `navigation@2` candidates are element actions; a
screenshot picks nothing, so folding it in would mean a button with no crosshair and a hole in
the icon grid `check-manifest` enforces.

### Not built yet

**A window registry and cross-window routing.** Repair fixes a config at the next window start;
routing would make a wrong port not matter at all — a window receiving a valid token that is
not its own would look the owner up in a registry (`~/.ai-browser/windows.json`: token, port,
folder, pid) and proxy the call there. It also upholds rule 3 of the security model better than
the 401 does, since project A's config would then always reach project A's window rather than
merely failing to reach anyone else's. Not built because repair covers the same ground without
a new HTTP hop, a shared registry file to keep pruned, or a story for a window closing
mid-call.

**Assigning a tab to one conversation rather than to an assistant.** The registry takes
session-scoped targets and resolves them above the assistant, so the mechanism is in place and
tested; nothing in the UI writes one. What is missing is not code but *identity*: an
`Mcp-Session-Id` changes on every restart, and MCP carries no name or working directory, so two
Claude conversations can only be told apart by "called 5s ago" — a row a user would have to
correlate by timing. Worth building when someone actually runs two conversations of the same
assistant on two pages; a rule for inheriting a left-over session assignment (the newest
session of that kind takes it over) would have to come with it, or every restart would strand
one.

**A stdio bridge, which would remove the token from the repository.** `.mcp.json` is designed
to be committed and shared with a team, and we write a bearer token into it. The harm is
bounded — loopback only, and worthless on another machine — but so is the entry: a colleague
who clones the repository gets an MCP server that can never work for them and fails on every
Claude Code start. The real fix is to put a *command* in the config instead of a URL and have
the bridge resolve port and token from the registry at session start. That removes port drift
and the token from git in one move, and it is a bigger change than everything above put
together, so it is recorded rather than done.

**Plain-text hand-over** — `claude-vscode.editor.open(undefined, prompt)` opens a new Claude Code
conversation with a prompt, but Codex has no equivalent, so reports go as files for both.

## Things that break silently

No compile error for any of these — they only surface at runtime.

**Items 32–36, 38, 40, 48, 65, 69 and 70 describe the page-side title marker, which no longer
exists** — see [Where a share is visible](#where-a-share-is-visible). They are kept because each
one is a rule about writing into somebody else's document, and that is exactly what a future
"just put a badge on the tab" would do again; read them as reasons the mechanism went rather than
as invariants to uphold. Item 30 still applies to the *reading* side: a marker an older build
wrote can still be on a page that is open.

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
9. **A `StatusBarItem.backgroundColor` other than `statusBarItem.errorBackground` or
   `statusBarItem.warningBackground`** → ignored, and the item renders with no background at
   all. Those two are the whole supported set; a `ThemeColor` of our own typechecks fine and
   does nothing.
10. **Any notification, dialog or `ProgressLocation.Notification` shown while a browser tab is
    visible** → the page is replaced by a screenshot and a "Paused due to Notification" overlay,
    and clicks do not reach the page until it is dismissed. See
    [A notification pauses the built-in browser](#a-notification-pauses-the-built-in-browser).
    Confirmations must go through `confirm()` in [src/notify.ts](src/notify.ts).
11. **Testing a proposed API with `in`** (`'browserTabs' in vscode.window`) → true whether or
    not the proposal is granted, because the getter is always defined and throws only when read.
    Reports the API as available on exactly the hosts where it is not. Use
    `isBrowserApiGranted()`; see
    [Presence is not permission](#presence-is-not-permission-in-lies-about-the-grant).
12. **Assuming `argv.json` is under the home directory** → a portable install
    (`VSCODE_PORTABLE`) or a build run from source (`VSCODE_DEV`) reads a different file, so the
    grant is written where nothing looks for it.
13. **`claude mcp add --scope local`** (or telling a model to run it) → the entry lands in
    `~/.claude.json` and **overrides** the project's `.mcp.json`, so every later Connect
    rewrites a file nothing reads. Symptom: the assistant reports no tools and reconnecting
    never helps. Use `--scope project`; see
    [The port moves](#the-port-moves-and-the-config-remembers-the-old-one).
14. **Identifying our own config entry by name or URL rather than by token** → the name has
    changed between releases and the URL is exactly what goes stale, so a repair matching on
    either silently skips our own entries, or rewrites another window's live one.
15. **Replacing a whole Codex table during the unattended repair** → anything the user added to
    it (`startup_timeout_sec`, `enabled_tools`, comments) disappears with no error. Repair edits
    lines; only the connect path may replace a table.
16. **Writing `~/.codex/config.toml` without the lock, or under a different lock name than the
    other writer uses** → several windows repair the same global file on startup, and two
    interleaved read-modify-writes lose an entry or corrupt every MCP server the user has.
17. **Renaming a config entry onto a name that is already taken** → two tables with the same
    header is TOML that does not parse; the JSON equivalent silently overwrites somebody else's
    server. Check the target name is free or already ours first.
18. **Replacing only the first line of a TOML value** → a multi-line value (a triple-quoted
    string, an array left open) leaves its continuation and closing delimiter behind. Use
    `valueEndLines` and replace the whole range.
19. **Reading `server.url` after an await on an unattended path** → the getter is backed by the
    live port and goes `undefined` on dispose, so a config gets an empty `url`. Capture it
    first.
21. **A snapshot selector that only *describes* an element rather than resolving to it** →
    `click` and `fill` use `document.querySelector`, which returns the first match, so two
    buttons with no `id` and no `name` shared the selector `button` and "press Delete" pressed
    Save. Every selector is now checked with the same call its consumer will make; an element
    that cannot be addressed is listed without one.
22. **Disposing a `CDPClient` without settling its outstanding work** → `dispose` tears down the
    `onDidClose` subscription before it can fire, so commands in `_pending` and waits in
    `_waiters` are never rejected and their callers hang. Both go through `_failPending`.
23. **Leaving `&` unescaped in an HTML attribute** → the browser decodes entities when reading
    the attribute, so a value containing the text `&quot;` comes back as a bare quote. In the
    settings JSON that means `JSON.parse` throws and the panel stays blank. Escape `&` first.
24. **Writing to a child process's `stdin` with no `error` listener** → a stream error with no
    listener is thrown, so an `EPIPE` from a clipboard helper that exited early becomes an
    unhandled exception in the extension host instead of the file fallback.
26. **Leaving a sub-table behind when renaming its parent table** → TOML implicitly recreates
    the old parent from `[mcp_servers.<old>.<sub>]`, so the settings are lost to the renamed
    server and a second, urlless one appears.
27. **Replacing a whole `http_headers` inline table** → any header the user added is deleted,
    silently, on every window start. Merge, and set only `Authorization`.
28. **Stripping a comment from a TOML value that `scanLine` already handled** → `unquote` ran
    `/\s*#.*$/` over text whose comments were gone, so `url = "http://h/mcp#frag"` came back as
    an unbalanced `"http://h/mcp`. Only the scanner can tell a real comment from a `#` inside a
    string.
29. **Opening a cached async resource without guarding the in-flight open** → two calls
    arriving together both see no cache and both open; the second overwrites the first, which
    is then never disposed. `BrowserController._sessionFor` shares the pending promise and
    keeps a token so a session arriving after a `dispose` closes itself.
30. **Reporting a page title without `stripMarker`** → the marker this extension appends to a
    shared tab's title (🔗 / 🤖) travels into tool results and screenshot file names, and an
    agent reads it as part of the page.
31. **Short-circuiting `_resolveTab` for a paused share on *every* caller** → a lost share is
    meant to pause the assistants, and pausing the user too makes a toolbar screenshot answer
    "No browser tab is open" with another tab open in front of them. User paths pass
    `user: true`.
32. **Installing a page-side marker without `Page.addScriptToEvaluateOnNewDocument`, or
    without keeping its identifier** → the marker disappears on the first navigation, or comes
    back after un-sharing on the next page load.
33. **Removing a page-side marker without also disarming what will re-install it** → tearing
    down a CDP session takes the *registration* away and nothing else, so the title suffix and
    the `MutationObserver` keeping it there live on in the document; and a `DOMContentLoaded`
    listener left armed re-installs both after the removal, into a page whose
    `window.__aiBrowserShareMarker` has been deleted, so nothing can ever reach them again.
34. **Letting `set` and `clear` on the same page-side installer overlap** → the clear finds
    nothing installed yet and is a no-op on both halves, then the install completes behind it and
    the thing just removed is back, with its identifier no longer held by anyone. Serialise them.
35. **Recording page-side state before the call that establishes it succeeds** → the failed
    install is remembered as done, and the "already in that state" short-circuit then suppresses
    every retry for the life of the session.
36. **Moving the single cached CDP session for a one-off read of another tab** → the session
    that is dropped takes its page-side registrations with it, so a screenshot of one tab
    disarms the share marker on another (visible only on that tab's next reload) and discards
    the console buffer an assistant was collecting. Borrow a throwaway session instead —
    `_borrowSession`.
37. **Changing which tab is shared without serialising against tool calls** → a call arriving
    mid-transition drops the session the cleanup is using, leaving the marker on a tab nobody
    is sharing and no later `stopSharing` able to reach it, and the call itself fails with an
    internal sentence about a replaced session. Transitions go through `_transact`; tool paths
    await `_settle()`.
38. **Covering a failure inside a best-effort cleanup that has a second route** → the caller
    cannot tell "done" from "the channel died", so the fallback never runs.
    `ShareIndicator.clear()` reports instead.
39. **Attributing a `tools/call` only when the client is recognised** → only `initialize` names
    a client, so an assistant that does not echo `Mcp-Session-Id` drives the shared tab while
    its marker still says nobody has picked it up.
40. **Resuming a superseded async open without re-checking what it was for** → the retry comes
    back for a tab that is no longer the subject and drops the session of the one that is (a
    share moving is the common case, and the marker's registration goes with the session), or
    runs after `dispose` and leaves a session with nothing left to close it. Set `_disposed`
    before tearing anything down, and have the arriving session check what it was for. (The
    guard this once named, `_stillWanted`, went with the single cached session — see item 66.)
41. **Reading a quoted TOML key as absent** → `"url" = …` is the same key as `url = …`, so a
    writer that misses it adds a second definition, and two definitions of one key is TOML that
    does not parse — taking every MCP server in the file with it, unattended, at window start.
42. **Handing over a CLI command with no credentials** → the entry it creates answers 401 on
    every call, and the fallback is offered precisely when the config could not be written, so
    there is nothing else to fall back to.
43. **Treating the presence of a header as authentication** → a config copied from another
    project keeps the right URL and the wrong token, and the check reports it as correct while
    every call 401s. Compare the value; trust only what cannot be read.
44. **JSON-escaping a value into an XPath literal** → XPath 1.0 has no escape mechanism inside
    string literals, so an id containing a quote produces an expression that no engine accepts.
    Quote with the other delimiter, or `concat()`. Verified with `xmllint`.
45. **Creating a webview panel with `preserveFocus` and then revealing it without the options**
    → the reveal takes focus anyway and the flag on `createWebviewPanel` buys nothing.
46. **A cancelled element pick that still delivers** → cancellation stops the *wait* for the
    click, not the extraction after it, so a superseded pick overwrote the newer one's
    clipboard. Check the token again before delivering.
47. **An unbounded best-effort CDP call inside a serialised transition** → `CDPClient.send` has
    no timeout, so a page that has stopped answering never settles the transition, and
    everything queued behind the gate — every tool, every user command, the recovery command
    included — hangs with no error. Bound it (`bounded`).
48. **Ignoring `exceptionDetails` on `Runtime.evaluate`** → CDP answers a page-side throw with a
    *successful* reply, so a failed install is recorded as done (suppressing every retry) and a
    failed cleanup reports success (skipping the caller's second route).
49. **A parameter property in a module `npm test` loads** → Node strips types rather than
    compiling them, so `constructor(private readonly x)` fails at load with
    `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, exactly like `enum`. A type-only import is erased at
    runtime but **not** at typecheck time, so it still drags the imported file into the test
    project — declare the structural slice instead. `shareIndicator.ts` did exactly that with a
    `PageChannel` interface; it no longer needs one, having stopped talking to pages, but the
    rule is unchanged and the next leaf module to need a channel should do the same.
50. **Parking the caller in a field instead of passing it** → two overlapping `tools/call`s and
    the second one's cleanup clears the field under the first, so a call acts on another
    assistant's tab. Tolerable while it only decided a label; not once it decides the tab.
    `Tool.run(args, caller)`.
51. **Letting a paused assignment fall through to a broader one** → the assistant resumes on the
    page everybody else follows, which undoes the user's instruction exactly as thoroughly as
    resuming on the focused tab. The first key with anything to say decides.
52. **Listing every tab to an assistant that was given one** → the user bounded what it can see,
    and the list hands back every other address in the window, one-time links and query-string
    tokens included.
53. **A tool that forgets to pass the caller** → the caller is optional, because that is how a
    command the user pressed is told apart from an assistant's call, so a missing argument does
    not fail — it silently acts on the *user's* tab. `browser_screenshot` did exactly that.
54. **Computing "what may this caller see" from "does it have an assignment"** → a *paused*
    caller has none, so it fell through to the full tab list at the very moment its assignment
    was meant to be protecting it.
55. **Reading a command argument from an `editor/title` menu as your own parameter** → VS Code
    hands that command the editor's resource, so the first argument is a `Uri`; the share
    commands resolved a key from it and threw, which stopped the entry that matters most. Guard
    with a shape check (`isShareTarget`).
56. **Leaving one field window-wide while its neighbours became per caller** → the model's own
    tab selection redirected another assistant's calls and reported `selection: "selected"` to a
    caller that had selected nothing. Anything a caller can set belongs in a map keyed by
    `callerKey`.
57. **Clearing a per-caller map wholesale when one entry was meant** → giving a tab to Claude
    took Codex's chosen tab away with it, and its next call silently followed Claude's page.
    The mirror image is just as real: deriving *one* key from the assignment misses the pins of
    the callers it also shadows — a conversation's pin lives under `session:<id>`, so it
    survived an assignment made to its assistant and came back the moment that was released.
    Ask each entry where it resolves now.
58. **State that identifies a caller living on the server instance** → a restart from a setting
    change makes every live conversation anonymous, and an assistant that had been given a tab
    goes back to following the user. `McpLifecycle` owns `Mcp-Session-Id` → assistant.
59. **Cleaning up a closed tab only when it was assigned** → the ordinary case leaks its CDP
    session (still counting against the limit) and keeps whatever was picked on it, keyed to a
    tab that no longer exists.
60. **Clearing a picked element only on the assigned path** → an unassigned caller reads the
    previous document's element after a same-tab navigation, with `hasSelectedElement` still
    saying yes. It belongs to the tab being navigated, whoever asked.
61. **Reporting a tab's whole usage history against one assignment** → a fresh assignment looks
    like work in progress, which hides the "not picked up yet, restart it" hint that the two
    marker states exist for.
62. **A gesture that shares before it can fail** → the connect paths that return early never
    mentioned the assignment made a moment earlier, so closing that tab later paused an
    assistant with advice about a share the user did not remember making. Every failure path
    carries `scopeNote`.
63. **`_dropSession()` with no argument now closes every tab's session** → it used to be the
    only session there was. Two paths in `navigate` still called it that way, taking another
    assistant's console buffer and marker registration with them.
64. **A method reference where a call was meant** (`selection: this._selectionKind`) →
    `JSON.stringify` drops function properties, so the field simply vanished from the result
    with no error anywhere.
65. **Scanning for the marker separator only once** → a thin space is a real typographic
    character, so a page whose own title reads `1 000 Orders` defeated the scan and leaked our
    glyph into `browser_html`.
66. **One cached CDP session while assistants are on different tabs** → it is dropped and
    re-opened on every alternating call, and the console buffer — the only reason it is cached —
    is lost each time. One session per tab, bounded, and eviction passes over the tabs somebody
    is assigned to.
67. **Fixing a redirect one level up and leaving the fallback window-wide** → the per-caller pin
    stopped one caller's selection from redirecting another, while `_lastTab` — written by
    `selectTab` and by `shareTab` — kept doing it in the focus state that is most common.
68. **Evicting by "least recently acquired" while calls are in flight** → the longest-running
    call is at the front of the queue, so an unrelated assistant's activity stops it with the
    internal `CDP client disposed`. Pass over what is claimed, and never evict the session that
    has just arrived.
69. **Caching what a page is supposed to be showing** → the page owns the handle and can take
    the marker off, so a cached "already applied" makes every later attempt send nothing.
70. **Searching a whole document for something that only exists in one element** → a decoy
    matches first, the page's own content is edited and the real thing is left behind.
71. **A menu entry gated on a context key that means something else** → `claudeInstalled` is
    "the Claude Code *extension* is installed", and gating the share entry on it hid it from the
    exact setup the feature targets (Claude Code driven from a terminal through `.mcp.json`).
72. **Naming a command title in a message while renaming that command** → the sentence points at
    a palette entry nobody can find. Renames have to sweep `l10n.t` strings and the README table.
73. **Gating a "give this tab away" entry on focus rather than on existence** → with no browser
    tab open at all the menu still offered to hand one over, and the connect rows still promised
    "and share this tab". Two different facts: nothing focused is ordinary, nothing open is not.
74. **A static title that describes a conditional action** → a palette entry is one string for
    every state, so "Connect … and Share This Tab" promised a share in a window with no browser
    tab. Conditional wording belongs where it can be conditional — a menu label built in code.
75. **Packaging whatever the working tree happens to contain** → `.vscodeignore` is an allowlist
    by omission, so a file this extension's *own* command writes into the project root
    (`.mcp.json`, carrying the workspace token) rode into the VSIX. Check `unzip -l` after
    adding any tool that writes at the repository root. **It happened a second time** with
    `.ai-browser/`, the report directory `assistants.ts` creates when handing an element to
    Claude Code — and git hid it, because that directory gets its own `.gitignore` of `*` on
    creation, so `git status` is clean while `vsce` packs it anyway. A clean working tree is not
    evidence that the package is clean; only `unzip -l` is.
76. **Two element kinds sharing a centre dot** → the icon is the only label a primary button
    has, so the toolbar shows the same picture for two different actions and the `Cmd+Alt+C`
    chord looks like it fires at random. The old grid check only compared dots *within* a kind;
    `check-manifest` now also asserts they differ across kinds.
77. **A manifest guard that names one menu by hand** → moving entries into a nested submenu
    took eight of the twelve commands out of the guard's reach, and a check that inspects
    nothing still reports success. `check-manifest` now sweeps every declared submenu rather
    than `aiBrowser.elementMenu` alone.
78. **Pairing a selector with `tab.url`** → both path builders are rooted in the node's *own*
    document, so an element inside an iframe gets a selector the top page will never resolve,
    advertised against the top page's address. Read the URL from
    `ownerDocument.defaultView.location.href` instead, so both halves describe one document.
79. **`showInputBox` without `ignoreFocusOut`** → it closes the moment it loses focus and
    resolves `undefined`, which every caller here reads as "cancelled" and answers with
    silence, so the report is "Enter does nothing". Worst on a box opened from the status bar
    menu: the quick pick hides first and restores focus to `previousFocusElement`, and when that
    element has no `offsetParent` — what happens to a status bar entry VS Code has re-rendered,
    and ours re-renders on every share change and every `pulse` tick — the controller falls back
    to `returnFocus()` into the editor group, which can land after the box is already up.
80. **An empty value that is falsy and therefore silent** → `showInputBox` resolves `''` when
    Enter is pressed on an untouched box, and a placeholder that looks like a value invites
    exactly that. `if (url)` then returns without a word, which is the same symptom as the item
    above from a completely different cause. Refuse it in `validateInput` instead.
81. **Deciding "does this already have a scheme" with a pattern** → `^[a-z][a-z0-9+.-]*:`
    matches `localhost:3000`, so the check reads `localhost` as the scheme and leaves the input
    alone; the browser is then handed an address it cannot open. Compare against the list of
    schemes actually recognised — `hasKnownScheme`.
82. **Prefixing a scheme without parsing the result** → anything at all becomes a
    URL-shaped string (`https://hello world`), and the browser opens a broken tab instead of the
    caller reporting that it could not be understood. **Parsing is not sufficient either**:
    `new URL()` invents a host rather than failing, so a filesystem path, a relative path, a
    protocol-relative URL and a Windows drive letter all came back as valid URLs pointing at
    hosts nobody named. Require an authority shape and a non-empty `hostname` as well.
83. **Prefixing a scheme onto input that already declares an unknown one** → `ws://host` became
    `https://ws://host`, which parses with hostname `ws`, so the mangled form was opened
    silently. Test for `scheme://` separately from the known-scheme list, and relay rather than
    rewrite.
84. **Normalising an argument whose type is wider at runtime than in its signature** →
    `aiBrowser.show` is typed `string` and is reachable through `executeCommand`, which is
    untyped; `input.trim()` on the `vscode.Uri` that used to work became a `TypeError` and the
    open was lost.
85. **Guarding only the parse when the call before it can also throw** → a page-side throw comes
    back as a *successful* CDP reply carrying `exceptionDetails`, which `evaluateOnNode` turns
    into a rejection, so a fallback wrapping only `JSON.parse` never ran and the whole element
    pick died with an error toast instead of falling back.
86. **Reading an unknown `scheme:` as `host:port`** → `tel:+361234567` and `localhost:3000` are
    the same shape, so a check that only knew `scheme://` mangled `magnet:?xt=…` into
    `https://magnet:?xt=…` and refused the rest outright. Only what follows the colon separates
    them: a port is digits. Test the Windows-drive form first, or `C:\dev` reads as scheme `c:`.
87. **Passing a `vscode.Uri` to `workbench.action.browser.open`** → it reads a non-string
    argument as its undocumented options object (`typeof e == "string" ? { url: e } : e ?? {}`),
    which has no `url`, so the editor opens a blank tab and says nothing. Convert with
    `toString(true)` first, as `api.open` and the external URI opener do.
88. **Promising a locator that cannot be reconstructed** → the CSS builder walks `parentElement`,
    which is `null` at a shadow boundary, so an element inside a shadow root yielded a path
    rooted in the shadow tree that `document.querySelector` can never reach; and a `srcdoc` or
    script-filled frame reports `about:srcdoc` / `about:blank`, an address nobody can navigate
    back to. Both read as precise and resolve to nothing.
89. **Refusing an input because it resembles ones that deserved it** → `//example.com` was
    grouped with `/Users/…`, `./rel` and `C:\dev` as "parses into a host nobody named", but its
    slashes collapse and it resolves to exactly the page meant, so a working address stopped
    working. A refusal needs its own evidence.
90. **`Open File` on a host without the built-in browser** → a `file:` URI in the webview panel
    is blocked by `localResourceRoots`, so the panel renders blank with no error. The menu entry
    is therefore gated on `shouldUseIntegratedBrowser()` rather than falling back.
91. **Treating every `stat` failure as absence** → `NoPermissions` (macOS TCC on `~/Documents`),
    a transient I/O error and a stalled mount all fail the same way as a deleted folder, so a
    bare `catch { return false }` prunes the Codex entry of a live project, silently, at startup.
    Only a clean `FileNotFound` proves absence; everything else must keep the entry. Separately,
    require the folder's *parent* to read as present, or an unmounted volume takes every project
    on it — the two guards cover different failures and neither implies the other.
92. **Pruning a config entry on "looks like ours by name"** → the per-project names in
    `~/.codex/config.toml` are shared by every window and every machine this extension has run
    on, so one of them may be another window's live entry. Only a token this machine minted
    (`mcp.token:<folderUri>` in `globalState`) identifies an entry well enough to delete it.
93. **Catching a chain's failure with the second argument of `.then`** → `p.then(f, r)` routes
    only *p*'s rejection into `r`, never one thrown by `f` itself. Moving awaited work inside the
    fulfillment callback turns that handler into unreachable code with no compile error, and the
    rejection escapes as an unhandled promise rejection — on the fire-and-forget path that was
    written to be silent. Put the guard on the tail: `.then(f).catch(…)`.
94. **Treating "I could not read it" as "it is not there"** → a `catch` that returns `undefined`
    for every read failure makes a run that never opened an existing config report itself
    complete, so the folder is marked as handled and the scan never looks at that file again, leaving
    the entry there for good. Only a clean `FileNotFound` is absence — the same rule the folder
    check already follows.
95. **Inferring that a token is unused from its folder being gone** → the MCP server authorizes
    by token and holds it in memory, and nothing watches the workspace folders, so a window whose
    folder was deleted or renamed keeps answering. Another window pruned the entry of a server
    that was serving. Liveness needs its own evidence — a heartbeat plus a grace period.
96. **Unattended deletion inside the project folder** → `.codex/config.toml` is committed and
    travels with the folder, so after a move or re-clone its entry names the old path; deleting
    it edits a version-controlled file and reports that a live project no longer exists. Prune
    the global config only.
97. **Deleting a workspace's token to keep a scan bounded** → `mcp.token:<folderUri>` is the
    workspace's *identity*, not a cache entry: remove it and the next open mints a new token,
    while the committed `.mcp.json` a re-clone restores still carries the old one. The repair
    matches by token, so it cannot see that entry to fix it — every call 401s with nothing able
    to recover it. Mark the folder as handled and keep the token.
98. **A heartbeat that follows `workspaceFolders[0]` instead of the identity being served** →
    removing or reordering the first folder of a multi-root window does not restart the MCP
    server, so it keeps accepting the token minted for the old folder while the stamp moves to
    the new one. The old folder then ages past the grace period and another window deletes the
    entry of a server that is still answering. Stamp the folder the running server was built for.
99. **Deciding what to delete outside the lock that performs the deletion** → the verdict travels
    across every await in between, so a workspace restored — or merely reopened elsewhere, which
    lifts its completion marker — in that window still has its live entry removed, and is then marked as handled
    so nothing looks again. Resolve the decision inside the lock it authorises.
100. **`void`-ing a `Memento.update`** → it persists the whole memento through the main process
    and can reject, so a discarded promise is an unhandled rejection — item 93 one layer down, in
    the helper written to fix it. It also hides partial persistence: two independent unawaited
    writes can leave a heartbeat and a completion marker disagreeing. Return the promise, order the two
    so the half that lands is the safe half, and await it inside a guarded chain.
101. **Giving the destructive reader the weaker read** → a path that *rebuilds* a config from
    what it reads must distinguish "no such file" from "I could not read it", or one transient
    error replaces a global `~/.codex/config.toml`, or a committed team `.mcp.json`, with a
    single entry of ours — and reports success. The distinction existed (`readConfig`) and was
    applied only to the repair, where the same failure merely skips a run. Check which caller
    actually removes data before deciding which one needs the careful read.
102. **An unawaited repair from a superseded `_apply`** → `_chain` serialises `_apply` but not
    the fire-and-forget repair, so two runs can be in flight and the file lock decides the order;
    the older one can land last and write the port the newer run replaced. That is the stale-port
    symptom the whole feature exists to remove, and it survives until the next window start.
    **Checking the generation after the repair resolves does not fix it** — by then every write
    has happened, and all the guard suppresses is the report and the completion markers. Ask under the
    lock, with the bytes ready, immediately before the write (`stillWanted`), and bump the
    generation *before* the disabled early return, or turning MCP off leaves the older repair
    authoritative.
103. **A `dispose()` that sets no flag** → an `_apply` suspended at `await server.start(...)`
    pushes into a `_parts` array nobody will dispose again, leaving a loopback HTTP server
    listening after the window is done with it; and the repair chain can still write the user's
    config and lay completion markers after deactivation. Set `_disposed` first, check it after each
    await, and — for the write itself — through the same `stillWanted` hook as item 102.
104. **Doing slow work under a lock whose acquisition budget is shorter than that work** → the
    prune's filesystem survey can spend `2 * statTimeoutMs` on one stalled mount, while
    `withLock` waits `attempts * retryMs` — one second — before giving up. Held across the
    survey, the config lock made every sibling window skip the file it was queuing for, which
    on session restore is all of them. Split the slow half out: survey outside, confirm inside.
105. **Deleting a parser's line range without checking what is inside it** → `codexEntries` keeps
    a table open across continuation lines, which is right for *identifying* one and unsafe as a
    *deletion* range: an unclosed `[` never closes, so that table runs to end of file — and once
    a value is left open the parser stops recognising headers at all, so the tables about to be
    removed are not even in `entries` to be compared against. One stale entry emptied the
    user's whole global Codex config, every other MCP server and the deleting window's own live
    entry with it, and the confirmation named the single entry it meant to remove. Ask
    `codexRangeDeletable` of every range, and refuse to rewrite a document that ends inside an
    unclosed value at all (`codexUnterminated`). That guard has been wrong in both directions
    since — too textual (item 114), then too structural (item 119) — and now needs both halves.
106. **One locked writer and one unlocked writer of the same file** → that is the same as no
    lock (item 16 from the other direction). `.mcp.json` was rewritten by the repair under
    `configLockName` and by Connect with nothing, so a press during any window's startup repair
    lost whichever edit landed first — on a file teams commit.
107. **Stamping liveness from a window that serves nothing** → the heartbeat wrote a
    `mcp.seen:<folderUri>` row unconditionally, so a window with `aiBrowser.mcp.enabled: false`
    — which never mints a token — left a row with no `mcp.token:` to belong to. Nothing reads it
    and nothing removes it, so it accumulates for ever in a memento that is rewritten whole on
    every update. Keep alive only what is actually being served.
108. **A refusal that looks like "nothing to do"** → both leave the file byte-identical, and only
    one means the entries are still there. A guard added without a way to report itself let a run
    that declined to rewrite a config still answer `complete`, so the caller marked as handled folders
    whose tables it had just refused to touch — and a marker is only lifted by a window serving
    that folder, which a deleted folder never has again. Give every refusal a flag and fold it
    into the same disjunction as the other incomplete states.
109. **Refusing per call where the unit of work is per entry** → one odd table stood off the
    prune of every other stale table in the file, and because a refusal left no trace in the
    report it read as the feature quietly doing nothing. Drop the entry, keep the rest, and
    report only what was actually removed.
110. **Folding a new failure into an existing refusal's *message*** → reusing the outcome was
    safe for the file and wrong for the user: a lost lock was reported as "`.mcp.json` could not
    be read or parsed — fix or delete it", about a healthy, committed file that had not even been
    opened, on a path where an unwritable `os.tmpdir()` makes the advice permanent. Reuse the
    refusal, not the sentence.

111. **A prose sweep that edits string literals** → renaming vocabulary across comments and docs
    with a script rewrote `'orphans'` inside `inheritableCSSProperties`, a set of **real CSS
    property names**, to `'leftovers'`. It typechecks, every test passes, and the only symptom is
    that `orphans` silently stops being reported as inherited in Copy Element output — in a file
    whose whole contract is being a verbatim copy of upstream. Split each line on backticks and
    transform only the prose, and afterwards diff the sweep commit and read every changed line
    that is not a comment.
112. **One refusal flag shared by several files** → `complete` gates exactly one thing, the prune's
    completion marker, and only `~/.codex/config.toml` can hold a pruned entry. Folding the
    *project* `.codex/config.toml`'s refusal into the same flag let an unterminated value there —
    in a file that is committed, travels with the project and therefore stays broken — force
    `complete: false` for ever, suppressing the markers for folders the global prune really had
    cleaned. The scan then re-stats those folders on every activation and never heals. Scope a
    failure flag to the file whose outcome the decision actually depends on.
113. **A guard whose refusal is indistinguishable from success** → `spliceCodexTables` returned the
    input unchanged when it declined, which is byte-for-byte what a splice with nothing to do
    returns. `writeCodexConfig` wrote the identical file back and `connectCodex` reported "Wrote
    ~/.codex/config.toml" while the stale url and token sat there. Return `undefined`, or a flag —
    the one thing a refusal must not look like is success. Item 108 is the same rule for the
    unattended path; this is the interactive one, and it was missed because the comment asserted
    the guard "cannot fire today".
114. **A textual approximation of a structural question** → "does any line in this range look like
    `[table]`" is wrong in *both* directions, and the two failures hide each other. It fires on
    `  [3, 4]`, the last element of a nested array written without a trailing comma, which is
    well-formed TOML — so a legitimate config could never be pruned, and under item 112 that
    refusal suppressed the completion marker permanently. And it goes blind exactly when it
    matters: once a value is left open every later line reads as continuation, so the real
    `[mcp_servers.someone-else]` header inside the range is invisible. `codexRangeDeletable` asks
    both halves, because neither alone is safe. **The first attempt at it got the header half
    wrong in the opposite direction** — it asked the scanner, which is blind in precisely the case
    above — so read item 119 for the rule as it actually stands: a *credible* header tested
    against the raw line whatever the scanner believes, plus the range closing.
115. **Ignoring escapes inside a multi-line basic string** → the scanner closed on every `"""`,
    including one preceded by a backslash, where the quote is content rather than the delimiter.
    Two such sequences on a line rebalance the scan, so `codexUnterminated` answers "well-formed"
    while a `[mcp_servers.x]` written inside somebody's prose is reported as a real table — which
    the repair would then rewrite, inside a string. The single-line branch had always honoured
    `\"`; the multi-line one had not. The literal form (`'''`) is not affected, because a
    backslash there is just a character.
116. **Stamping liveness before the thing being stamped exists** → `markWorkspaceAlive` ran before
    `server.start()`, so a start that failed or was superseded still wrote a fresh `mcp.seen`
    stamp *and lifted the folder's completion marker*, putting it back into the scan and holding
    off its pruning for the whole grace period on the strength of a server that never came up.
    Item 107 from a different direction: stamp only what is actually being served, which means
    after the start succeeded, next to `_servedFolder`.
117. **Fire-and-forget work that can starve its own successor of a lock** → `_chain` orders
    `_apply` but deliberately does not await the repair, so two repairs could run at once. The
    generation check under the lock is the last word before a write and still not enough: an older
    repair can take the lock *before* the generation moves, pass its check, and still be inside
    `writeText` when the newer run arrives — and `withLock` gives up after one second, so on slow
    storage the newer run is starved out and the obsolete endpoint is what remains on disk. Give
    such work its own chain (`_repairs`) so the newest always writes last.
118. **Comparing timestamps with `>` across processes** → two events in the same millisecond are
    not ordered by a millisecond clock, so `seen > decidedAt` treats a stamp that may be newer as
    older and marks a live workspace as handled. Use `>=`: the conservative reading costs a
    deferred prune, the other costs somebody a reconnect.

119. **A structural check where a textual one was load-bearing** → the guard on a deletion range
    was rewritten to ask the scanner whether a line is a table header, which is exactly the
    question the scanner cannot answer once it has lost track. An unclosed `[` *before* a
    `[mcp_servers.someone-else]`, with a later `]` rebalancing the range, hid that header
    completely: the range ended at depth zero, both halves of the rule passed, and the user's
    server was deleted while the confirmation named only the entry meant to go. The replaced
    textual rule had caught this and was traded away for precision on a different case. The rule
    now needs *both* — a **credible** header (a dotted path of bare or quoted keys, so `  [3, 4]`
    is content and `[mcp_servers.x]` is not) tested against the raw line regardless of parser
    state, **and** the range closing.
120. **One counter for two kinds of bracket** → `scanLine` incremented the same `depth` for `[`
    and `{`, so an unclosed inline table was cancelled by a stray `]` — two ordinary hand-edit
    typos, in opposite directions, several lines apart. The document then balanced,
    `codexUnterminated` reported it well-formed, every guard that rests on it passed, and a
    deletion range covering another server's table was approved. Count them apart and require
    both to be zero.
121. **Making a check required on two of three deleters** → `deletable` was made a required
    parameter on `removeCodexTables` and `spliceCodexTables` explicitly so a caller could not opt
    out, while `repairCodexToml` in the same file went on deleting whole line ranges — a
    duplicate of ours, a header sub-table being folded inline — with no check at all, on the
    strength of the caller's document-wide `codexUnterminated`. Item 120 shows that guard is not
    sufficient. When a rule gets an enforcement mechanism, sweep every site that performs the
    operation, not the ones being edited at the time.
122. **A serialising gate in front of unbounded I/O** → chaining the repairs so the newest writes
    last (item 117) put `vscode.workspace.fs.readFile` / `createDirectory` / `writeFile` behind a
    gate, none of which carries a timeout, and `withLock` bounds only *acquiring* a lock rather
    than the work under it. One stalled network home then stopped every later repair in that
    window for its whole lifetime, silently. Item 47 one layer up, created by the fix for item
    117. Bound the **wait**, not the work: a queued run waits `repairQueueWaitMs` and then
    proceeds, so the pathological case degrades to the old concurrent behaviour — where the lock
    and `stillWanted` still protect the write — instead of to no repairs at all.
123. **Waiting on a CDP event without watching the tab it belongs to** → closing a browser tab
    does not close its CDP session, so a pick in flight is never settled by anything: the
    `once` promise, the `withProgress` it runs under and the `$(stop-circle) Cancel pick` button
    all outlive the page for the rest of the session. `onDidCloseBrowserTab` is the only signal
    there is, and `BrowserCDPSession.onDidClose` is not a substitute for it.
124. **Interpolating a value from the network into a notification message** → VS Code renders a
    notification body as *linked text* and opens its links with `allowCommands: true`, so a
    Markdown link in that value is a button that runs a command on one click. A version
    comparison is no filter: it stops at the first differing field, so a leading `99` answers
    "newer" and the payload behind it is never looked at. Validate the shape at the boundary the
    value arrives at, not at the point it is used.
125. **Guarding "do not paint over the browser" on focus instead of visibility** → the editor
    decides the pause geometrically (`getOverlappingOverlays` intersects rectangles and never
    consults focus), so a browser tab in a split beside a file is paused while
    `activeBrowserTab` is `undefined`. There is no direct signal — `window.tabGroups` has no
    `TabInputBrowser` — so a browser editor has to be recognised by its *absent* input.
126. **Handing a `void`-ed async call the work that can fail** → `_deliver` cannot await
    `_announce`, and the two actions behind its buttons (`openExternal`, and a settings write
    VS Code refuses outright while `settings.json` has a syntax error) were unguarded, so
    `Don't show again` silently did not apply and the rejection escaped. The `void` is correct;
    the missing `.catch` was not. Item 93 one layer along.
127. **A button pointing at a page a process never populates** → `Download from GitHub` opened
    the repository's releases page, which has zero releases and zero tags because
    `PUBLISHING.md` never cuts one. It typechecks, it opens, and it is empty. A link is only as
    good as the step that fills it.
128. **Subscribing to `onDidChangeTabGroups` for something that is a *tab* change** →
    `$acceptTabOperation` fires `_onDidChangeTabs` when a tab opens, closes or is updated, and
    switching which tab is visible inside a group is an update; `_onDidChangeTabGroups` fires
    only when a group opens or closes or its own DTO changes (`isActive`, `viewColumn`). So a
    browser tab that stops being visible in a group that is *not* focused fires neither that
    event nor `onDidChangeActiveBrowserTab`, which was already `undefined`. Subscribe to both.
129. **Checking only for a throw from `openExternal`** → it resolves to *whether* the URI was
    opened, so a refusal reported that way reads as success and the fallback that exists to make
    the failure visible never runs. The click does nothing and says nothing.
130. **A validated boundary in one of two builds that read the same source** → this repository
    ships two extensions that cannot share code, so a rule written for one leaves the other
    open on the identical input. The convention already recorded for `codexOurTables` applies to
    security rules too: write it twice, and say in both places that it is written twice.
131. **Writing a key while also keeping the one already there** → `repairCodexToml`'s
    "no `url`" branch emitted `http_headers` unconditionally and left any existing one exactly
    where it was, neither removed nor replaced, so the table defined the key twice — TOML that
    does not parse, written unattended at window start, taking every other MCP server in
    `~/.codex/config.toml` with it while reporting the port as updated. Neither
    `codexUnterminated` nor `codexRangeDeletable` can catch this: the input is well-formed and
    balanced and nothing is *deleted*, so every guard in the file is looking the other way. The
    reachable shape is an ordinary hand edit — commenting a `url` line out to disable an
    endpoint — and the connect path heals it, which is why it never showed up interactively. A
    branch that *adds* a line has to ask the same question the branch that replaces one does.
132. **Interpolating a page-supplied string into a notification body** → same sink as item 124
    and a much easier one to reach: a notification body is linked text opened with
    `allowCommands: true`, so `[label](command:…)` in a `document.title` is a one-click command.
    A version has a *shape* and is validated; a title has none — the page chooses it outright —
    so it is neutralised instead (`plainInNotification`). `stripMarker` is not a sanitiser: it
    removes our own suffix and nothing else.
133. **Handling only the outcomes a function is declared to return** → `writeClaudeConfig`
    answers `'written' | 'unparsable' | 'busy'`, and `connectClaudeCode` handled all three — but
    `writeText` calls `createDirectory`/`writeFile` unguarded and `withLock` is `try`/`finally`
    with no `catch`, so `NoPermissions` or `ENOSPC` propagated straight out of the command.
    VS Code's generic "command failed" toast, no `claude mcp add` fallback, and no `scopeNote`,
    so a tab shared a moment earlier was left assigned and unannounced (item 62). An enumerated
    result type is not a promise that nothing throws.
134. **An eviction guard that asks who *acquired* a resource rather than who is using it** →
    `_touch` runs when a session is handed out, not while it works, so "least recently used" put
    the longest-running call at the *front* of the queue and answered it with the internal
    `CDP client disposed`. Adding pins to `claimed` fixed the pinned instance and left the
    ordinary one — an assistant with no share and no selection is the default state, not an edge
    case. Counting holds around the work is what makes it structural: `_withSession` is a scope
    rather than a hand-out, so a new call site cannot silently opt out of the rule.
135. **A guard whose result a fallback then discards** → the fix for item 134 added the in-flight
    test to `claimed` and left `const target = spare ?? candidates[0]` underneath it. With four
    calls in flight there is no spare, so the fallback dropped the first of them and the new
    guard did nothing whatever — it read as a fix, it typechecked, and the original harness still
    passed because it only ever had *one* call in flight. A predicate is only as strong as the
    branch that has to honour it when the predicate excludes everything; if exhausting it has to
    mean something, say what, rather than falling through to the unfiltered list. Here the answer
    is to queue the new open for a slot (`_awaitSlot`), bounded so it cannot hang, and to sweep
    again on release.
136. **Recording a claim on the far side of an `await`** → `_sessionFor` resolves into a
    microtask, so a hold taken *after* it leaves a window in which the session is in `_sessions`
    with nothing saying anybody wants it, and a concurrent open's `_evict` drops it under the
    caller that just asked for it. "Nothing runs between the `await` and the next line" is true
    of the caller's own statements and false of the event loop. Claim before the acquisition,
    which also makes the claim cover the acquisition.
137. **A queue with no bound on the wait** → the fix for item 135 makes a new session wait for a
    slot, and a slot is freed by another call finishing. `browser_wait_for` takes its timeout
    from the model, so four of them can hold every slot for a minute — and a tool call that
    hangs reads as a dead browser while the client's own timeout fires anyway. Bound the
    **wait**, not the work: after `_slotWaitMs` the open goes ahead one channel over the bound,
    which the next release reclaims, so the pathological case degrades to the previous behaviour
    rather than to a hang. Item 122 is the same rule for the config repair. `dispose` must
    release the queue too, or a pending timer holds the event loop after the window is done.
138. **Checking for capacity instead of reserving it** → a check answers for the instant it runs,
    and both ways that gap opens were reached here. Waking every waiter on one release admits all
    of them, because resolving a promise does not run its continuations before the next waiter is
    called — one release must admit exactly one. And counting only what has *landed* is blind to
    what is on its way: `_sessions` is still empty while four opens are in flight, so callers
    arriving together at a cold start all passed and six simultaneous calls opened six channels
    against a limit of four. Count the in-flight commitments alongside the settled ones, take the
    permit synchronously before anything awaits, and release it where the thing it stood for is
    counted instead.
139. **A guard that widens what it inspects without narrowing what it judges** → the readme image
    check was extended to reference definitions, which are shared by links *and* images, so an
    ordinary `[guide]: ./guide.md` was reported as `readme image … is not an absolute https URL`
    and, because `prepare` gates `package` and `publish`, a good readme edit blocked the release.
    Widening a check is only safe together with the question of which of the new matches the rule
    actually applies to — here, the ids an `![alt][id]` / `![id][]` / `![id]` actually refers to.
140. **Releasing a reservation on a trailing `.finally`** → it runs a microtask after the thing it
    stood for was recorded, so for that tick the same session is counted twice and a concurrent
    reserver reads the total as one over: it evicts a session that did not need to go, taking a
    console buffer and a marker registration with it, or refuses a slot that genuinely exists and
    stalls for the whole wait. Hand a reservation back in the same turn the thing it reserved
    becomes real; keep the `finally` only for the paths that never got there, and make the
    release idempotent so the two cannot both fire.
141. **Waking a queue from only the routes you were thinking about** → capacity came back four
    ways and `_notifySlots` ran from two of them, so a tab closing, `navigate`'s retry and the
    stale-cache branch all freed a slot in silence and a queued open waited out its full timeout
    in front of it. Notify where the resource is actually released — `_dropSession` — and
    suppress only the case that is making the slot for itself.
142. **A bounded give-up that each waiter evaluates on its own** → the timeout existed so a queue
    could not hang, and every waiter had its own timer, so N waiting calls each granted
    themselves a permit: `4 + N` channels, which is the limit removed at exactly the moment it is
    load-bearing. The escape hatch needs its own bound (`_sessionOverflow`), and past it the
    honest answer is a retryable error rather than a quiet overrun.
143. **A safety guard that switches itself off on the hosts it was written for** →
    `browserTabVisible` answered "no page to pause" whenever the `browser` proposal was not
    granted, so the toast it exists to hold back landed on exactly the editors that pause a page
    without giving us the API to see it: Kiro, VSCodium, and every VS Code install before the
    grant is written. When a guard cannot read its precise signal, ask what *weaker* signal is
    still available — here the open command, which tracks the browser UI rather than the API —
    rather than treating the missing read as an all-clear.
144. **Describing somebody else's tool names in our own prompt** → the names belong to the
    client, which namespaces every MCP tool under the server and mangles that name as it likes:
    Claude Code keeps `ai-browser`, Codex turns it into `ai_browser_picto_2a3f1f` and hides the
    lot inside an `exec` sandbox. Our prompt promised they "start with `browser_`", nothing did,
    and the model answered "not loaded — restart your session" about a server whose 14 tools
    were in that very turn's tool list. Every layer below reads healthy, so the report is
    "Codex stopped connecting" and no amount of restarting or reconnecting touches it. Name the
    half that is ours — the suffix — and say a prefix is expected.
145. **Asking for a check while forbidding the only thing that could check** → "Just check — do
    not use them yet" left the tool list as the sole evidence, which is exactly the evidence the
    item above had made unreadable, so the model answered from a glance and was wrong. A check
    needs something to spend; here it is one `browser_state`, chosen because it reads
    extension-side state only and does not run `_noteTabUse`, so it cannot flip a shared tab's
    marker to 🤖 and claim work nobody did.
146. **Naming a config file the connect path did not write** → `connectCodex` writes the global
    `~/.codex/config.toml`, and the VS Code Codex extension never loads a project
    `.codex/config.toml` at all. Pointing the prompt at the project file sends the model to
    something absent — or, worse, to a leftover from the release that did write it, whose entry
    is a duplicate of ours under a different name and would make the CLI list every tool twice.
147. **Assuming an editor's tab label is the page's own title** → the share marker was appended
    to `document.title` and taken off again with a suffix match, which held only while
    `BrowserTab.title` *was* `document.title`. VS Code composes it as `<title> (<url>)`, so the
    suffix sat in the middle — measured:
    `'Picto ERP\u2009🔗🟦 (http://localhost:3000/en/auth/login)'` — and `stripMarker` could not
    see it. The marker then leaked into the connect prompt, every tool result and the status bar
    tooltip, with nothing able to remove it. A value composed by the host is not the value you
    put in; if a round trip has to be exact, do not route it through one.

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
  It also requires `isBrowserApiGranted()`. The open command can exist on a host that
  never ships the `browser` proposal (Cursor logs `proposal DOES NOT EXIST` and still activates).
  Delegating in that case opens a tab the extension cannot attach to.

- **`registerExternalUriOpener` aborts `activate` if the proposal is not granted.** Unlike
  `browser`, which is dropped with a log line, calling `registerExternalUriOpener` without
  `--enable-proposed-api` throws `CANNOT use API proposal: externalUriOpener` and the whole
  extension fails to load. The call is wrapped in try/catch so the panel and commands still
  register. The opener is then simply absent.

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

- **The share marker written into the page title.** 🔗/🤖 appended to `document.title` over CDP,
  kept there by a `MutationObserver` and re-registered with
  `Page.addScriptToEvaluateOnNewDocument` so it survived navigation. Removed on request, and it
  should stay removed: it was an edit to somebody else's live document to describe *our* state,
  it needed `stripMarker` / `stripMarkerFromHtml` on every path out of the extension to undo,
  and the undo could not be made correct because `BrowserTab.title` is `<title> (<url>)` rather
  than the title (breaks-silently #147). The same two facts are in the status bar item and the
  `Shared tabs` section of its menu, where they cost the page nothing — see
  [Where a share is visible](#where-a-share-is-visible). A floating badge injected into the page
  is the same idea and was rejected earlier still: it lands in every screenshot and reads as
  page content in `browser_html`.

- **A custom cursor while an element is being picked.** Two attempts, both ruled out, and the
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

**Verify the package by extracting it, never by trusting that the build ran.** The committed
`.vsix` went out of date once in this repository's history and nothing caught it: a commit
changed shipped source without repackaging, so the artifact and the source both claimed the same
version while the artifact was missing an entire module. Two checks settle it, and they are
cheap:

```sh
rm -rf /tmp/vsix && unzip -q tab-browser-ultimate.vsix -d /tmp/vsix
diff -rq /tmp/vsix/extension/out out          # must be silent
unzip -l tab-browser-ultimate.vsix | grep -E '\.ai-browser/|\.mcp\.json'   # must be empty
```

The first catches a stale package, the second the allowlist-by-omission hazard in
breaks-silently #75. Run both after `npm run package`, before committing.

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

**There is one publish script at the root, `publish:ovsx`, and that is deliberate.** The
Marketplace does not get the real build at all — it gets the stub in [vscode-marketplace/](vscode-marketplace/),
published from that folder, see
[The Marketplace build](#the-marketplace-build-is-a-second-stubbed-extension-in-vscode-marketplace).
The Open VSX listing (`DenysDavydov.tab-browser-ultimate`, 0.3.17) predates this rewrite and is
updated in place. The Marketplace listing under that same id also predates it, is stuck on the
0.3.x proxy build, and is being removed by hand — the stub publishes under a **new** id rather
than replacing it.

**Removed on purpose: `publish:vsce` and `publish:all`.** They pushed the real build to the
Marketplace with `--allow-all-proposed-apis` — `vsce publish` refuses a proposal-declaring
extension, but that refusal is client-side and the flag lifts it. It never worked anyway: two
attempts died on `Request timeout: /_apis/gallery` with everything else in place — flag passed,
PAT found, signing binary present, host answering a GET in 250 ms. The stub replaced the whole
idea, so do not put the scripts back.

- **The publish script packages first**, so an upload can never be built from stale source; the
  chain is `publish:ovsx` → `package` → `vscode:prepublish` → `compile`. Commit the rebuilt
  `.vsix` afterwards and the bytes in the registry and in the repository stay the same. `ovsx`
  resolves its token as
  `-p` → `OVSX_PAT` → **the OS keychain** (an earlier `ovsx login` put one there, which is why
  nothing needs exporting on this machine and CI still does); the namespace has to be created
  once with `ovsx create-namespace`, and the registry refuses a version it already has, so
  `version` must move every time.
- **VS Code installs the committed file** with "Extensions: Install from VSIX…". This is why the
  `.vsix` is tracked at all — see above.

Publishing does not grant the proposals: the editor still has to be new enough for the `browser`
proposal, and some builds only hand proposed APIs to an extension named with
`--enable-proposed-api DenysDavydov.tab-browser-ultimate`.

### The Marketplace build is a second, stubbed extension in `vscode-marketplace/`

[vscode-marketplace/](vscode-marketplace/) is a whole second extension with its own manifest, packaged and
published on its own. It exists because the Marketplace is where people look and the real build
cannot live there, so what goes up is the **listing** — readme, screenshots, the video slot —
plus the update watch below. [vscode-marketplace/extension.js](vscode-marketplace/extension.js)
is the entire implementation.

**Its id is its own**, `DenysDavydov.tab-browser-ultimate-promo`, and the whole design follows
from that. The two are unrelated extensions to VS Code: nothing updates across them, and the
normal end state is *both installed* — someone finds the listing, installs the real build, and
this one stays behind. So the stub checks `getExtension('DenysDavydov.tab-browser-ultimate')`
and stops advertising when the real build is there: no welcome, no footer button once the
installed version is current, and a `aiBrowser.fullBuildInstalled` context key that hides the
three listing commands from the palette through `contributes.menus.commandPalette`. The key is republished on
`extensions.onDidChange`, so installing the real build takes effect without a reload.

**Once the real build is installed the stub is the update notifier, and that is now its point.**
The real build is hand-installed from a VSIX, so **nothing** updates it and nothing announces a
release: the Marketplace gallery only tracks the promo id, and an Open VSX install exists on
some hosts but not on VS Code itself. So the stub asks
`https://open-vsx.org/api/DenysDavydov/tab-browser-ultimate` for the current version and offers
the `.vsix` link that comes back with it — pinned to that version, unlike the `main` VSIX in the
repository, which is whatever was committed last. That repository manifest is the fallback when
the registry cannot be reached, and being offline is treated as nothing to say rather than as an
error. `AI Browser: Check for Updates` is the manual route and is deliberately the one palette
entry with no `when`, since it is the half that stays useful.

**Before that, though, it has to survive its own first impression**, and this is the one complaint
the listing reliably gets: someone installs it, nothing happens, and they conclude the extension
is broken. A toast at startup is not an answer — it can be missed once and is then gone forever.
So the state is carried by a **status bar item**, `$(cloud-download) Install AI Browser`, which is
also the one attention-getting surface that cannot pause a browser tab. It has exactly three
states, and the third is the point:

| | Item |
|---|---|
| real build absent | `$(cloud-download) Install AI Browser`, warning background — nothing the listing advertises works yet |
| installed, a newer release known | `$(cloud-download) Update AI Browser <version>`, no background |
| installed and current, *or* the registry unreachable | hidden |

The unreachable case is folded into "current" deliberately: with the real build installed and no
*known* newer release there is nothing to act on, and a button offering to install what is already
installed is precisely the noise this build must not add.

Its dialog is **modal**, and that is the one modal here. It is user-invoked, and the answer — three
version numbers side by side: this listing, the latest full build on Open VSX, the one installed
locally — is the whole reason the button was pressed. Versions are refreshed first under
`ProgressLocation.Window`; `Notification` would pause the browser tab behind it.

Decisions worth keeping:

- **Everything that can put a notification on screen is delayed 10s after activation** — the
  update check and the welcome notice both — because a notification pauses the built-in browser
  ([why](#a-notification-pauses-the-built-in-browser)) and a window that restores a browser tab
  is exactly the window that must not be greeted with a toast as it opens. The status bar item is
  exempt and appears immediately: it is part of the workbench layout and overlays nothing.
- **The welcome notice is once per released listing version** (`aiBrowser.promo.noticeVersion`),
  not once per machine. It was a bare "shown" flag, whose failure mode is the wrong one: install,
  dismiss, and no later release of the listing can ever introduce itself again — including on a
  machine where the flag was set by a version that predates every feature being announced.
- **The last answer from the registry is cached** (`aiBrowser.promo.latestRelease`). The six-hour
  throttle exists to stop repeated *requests*, but the button and its dialog need a version to
  name in every window, including the nine that open inside those six hours.
- **A toast is only for an available update.** "You are up to date" and "could not reach the
  registry" go to `setStatusBarMessage`, the same rule the real build follows through
  [src/notify.ts](src/notify.ts).
- **Once per version, not once per window** (`aiBrowser.promo.offeredVersion`), plus a six-hour
  throttle on the request itself (`aiBrowser.promo.lastCheck`). A manual check ignores both.
- **The throttle is stamped only by a request that reached a registry.** Stamping before the
  fetch means a laptop whose first window of the day opens offline buys six hours of silence for
  every window after it.
- **A timer, not a single `setTimeout`.** The startup look is one-shot, so on its own it left a
  window that stays open for days checking exactly once ever, while the readme promised "every
  six hours". An hourly tick drives it now; the tick only has to be finer than the throttle,
  which is what actually paces the requests.
- **It stops announcing updates once the installed real build announces its own**
  (`SELF_UPDATING_FROM`). Both installed is the normal end state, so from 0.5.24 on a single
  release produced **two** toasts — different wording, two extensions, two `offeredVersion` keys
  in two globalStates, neither able to see the other. The real build's is the one kept: it holds
  the notice back while a browser page is visible, which this build cannot do, having no access
  to the `browser` proposal. It is a version rather than a flag because an older real build has
  no watch at all, and for those installs this listing is still the only thing that will ever
  mention a release — and a *manual* check still answers, because the user asked and the footer
  button is what asked them to.
- **The watch runs whether or not the real build is installed**, because its answer is also what
  the footer button and its dialog are built out of; what changes is what is done with it — with
  no real build there is nothing to *update*, so the check refreshes the button and says nothing.
  It used to be armed only when the real build was present, and from two places (activation and
  `extensions.onDidChange`) because the flow this build exists for installs the real extension
  *after* activation. Arming unconditionally makes that moot; `onDidChange` is still subscribed,
  now to refresh the button and the context key the moment the install lands.
- **Versions are compared field by field as numbers.** `'0.5.10' > '0.5.9'` is false as strings,
  which would have hidden every release between .9 and .20; anything non-numeric (`-rc.1`)
  answers "not newer", because failing to offer an update is recoverable and offering a
  downgrade is not.

It has no test project of its own — plain JavaScript, no build step. It was verified the way
[the status bar](#the-status-bar-one-permanent-button-one-that-hides-itself) was: by loading
`extension.js` against a stubbed `vscode`, a stubbed `fetch` and fake timers, and printing what
each state does — for every one of them, both what the footer button reads and what reaches the
screen: welcome with no real build, the modal and its three versions, the same modal with the
registry unreachable, silence for a listing version already introduced, hidden button with the
real build current, `Update AI Browser` with it behind, and hidden again when the registry cannot
be reached. Worth redoing that way after touching this file.

**The earlier design used the same id for both**, so that the VSIX would install over the
listing with nothing to uninstall. It was dropped, and it should stay dropped: VS Code keeps
checking the gallery for an id even after a hand-installed VSIX, so the moment the listing's
version rose above the VSIX's, auto-update would have silently replaced the working extension
with a stub. Separate ids remove the hazard rather than manage it — the version guard that used
to enforce the ordering is gone with it, and `prepare.mjs` now only *notes* when the two numbers
differ, because keeping them equal is a convention about which release the listing describes.

`prepare.mjs` checks the three things that are silent until the listing is live:

- **No `enabledApiProposals`** in the stub manifest, which is the whole reason it can be published
  at all.
- **Readme images must be absolute `https://` URLs.** vsce rewrites a relative path against the
  package root — here `vscode-marketplace/` — so `![](demo.png)` would point at the repository root and
  render broken. Everything in the listing links to `raw.githubusercontent.com`.
- **No `<iframe>` and no `<video>`.** The Marketplace strips both, so an embed renders as nothing.
  A video is a still image linking out, or a GIF, which is why the readme carries a commented-out
  slot with both snippets ready rather than an embed. Html comments are stripped before these two
  checks run, or the template would report itself as a mistake.

Mechanics worth knowing:

- **Plain JavaScript, no build, no dependencies, no tsconfig.** The stub is one file; a compile
  step for it would be more machinery than extension. Its scripts reach the root's binaries
  (`../node_modules/.bin/vsce`), so the folder needs no `npm install` of its own.
- **The icon is copied from the real extension at package time** and gitignored, so there is one
  source of truth for it. `vscode-marketplace/media/` and `vscode-marketplace/*.vsix` are both build output.
- **`vscode-marketplace/**` is in the root [.vscodeignore](.vscodeignore)**, or the folder would ride
  along inside the real VSIX.
- The stub's `.vsix` is **not** committed, unlike the real one — nobody installs it by hand, it
  only ever gets uploaded.
- **Its command ids are `aiBrowser.promo.*`**, not `aiBrowser.*`. Both extensions can be
  installed at once, and two extensions cannot register the same command id.

Publishing it: `cd vscode-marketplace && npm run publish` — like the root script, it packages
first.

### The real build watches for releases too

A hand-installed VSIX neither arrives on its own nor ever updates itself, and the promo listing's
watch only reaches the people who found the extension *through* the listing. Someone who
downloaded the VSIX from the repository has had no signal at all — which is why the real build
now carries its own watch, in [src/updateCheck.ts](src/updateCheck.ts), with the version
comparison split into the leaf [src/updateVersion.ts](src/updateVersion.ts) so `npm test` can
load it.

**It asks the repository's root `package.json` on `main`**, not Open VSX, because that is the one
file every release necessarily touches — the registry can lag a release, or be skipped for one.
The promo build asks Open VSX first and falls back to the same manifest, so **the two do not
always agree on what "latest" is** — an earlier draft of this paragraph claimed they did, which
is exactly backwards: they agree only while the registry is *un*reachable, and diverge in the
window the sentence above describes, with the manifest ahead. Two consequences follow, and both
are handled rather than tolerated: the promo stands down once the installed full build carries
its own watch (see below), and the version on `main` must not be pushed ahead of the artifact it
names (see [Packaging a VSIX](#packaging-a-vsix)).

**The `version` that comes back is validated, and that is a security boundary rather than
tidiness.** It is interpolated into a notification body, and VS Code renders a notification body
as *linked text* whose links are opened with `allowCommands: true` — `renderMessage` in the
notification renderer is
`render(e.message, { callback: n => openerService.open(parse(n), { allowCommands: true }) })`.
So a `version` of `99.0.0 [Update now](command:workbench.action.terminal.sendSequence?…)` renders
as a button that runs a command on one click, and `isNewerVersion` is no defence at all: it stops
at the first field that *differs*, answers "newer" on the leading `99`, and never looks at the
payload. The trust boundary here is a **GitHub name, not a signature** — a repository that is
renamed or deleted frees that name for anybody to re-register, and every installed copy goes on
polling it every six hours with no user action — so `readManifestVersion` refuses anything that
is not a plain version (`versionShape`). **The promo build applies the same rule**
(`readVersion` / `VERSION_SHAPE` in [vscode-marketplace/extension.js](vscode-marketplace/extension.js)),
because it reads that same manifest as its fallback and renders the answer into a toast of its
own — a boundary enforced in one of two builds that share a source is not a boundary. It also
checks `files.download` from the registry's reply (`readDownload`: https, and only
`open-vsx.org`) before handing it to `openExternal`, and re-checks its cached row on the way out,
since that row may have been written by a build that predates the check. Unlike shipping a bad VSIX this needs no publish, no
signature and no install step, which is why the check is at the boundary rather than at the use.

**The two builds must not disagree about which of two versions is newer**, so `isNewerVersion`
is deliberately the same rule as the promo's `isNewer`: field by field as numbers, because
`'0.5.10' > '0.5.9'` is false as strings and would hide every release between .9 and .20; a field
that cannot be read as a number ends it with "not newer", since failing to announce a release is
recoverable and telling someone to downgrade is not. They cannot share code — the promo is plain
JavaScript in a folder with no build step — so the rule is written twice, like `codexOurTables`
and `codexEntryCarriesToken` next door, and for the same reason it is stated here.

**This is a notification, and it is the one kind of toast this rule allows.** A release is a
decision for the user, with two routes and a way to stop being asked, and a toast body is not
clickable — so the routes are buttons: `Open VSX` (the registry, which can install in place on
the hosts that have it), `Download from GitHub`, and `Don't show again`.

**That second button opens the committed VSIX on `main`, and pointing it at the repository's
releases page was a dead end.** It was written that way and looked right; `gh release list` and
`git tag` are both **empty**, and `PUBLISHING.md`'s six release steps never cut a release — so
the primary action of the one toast this whole feature exists to show opened a page with nothing
on it. The raw `main` URL is what the README already documents as *the* download and what the
promo build falls back to, so all three now name one artifact. Check that before changing it: a
link is only as good as the process that populates it. (Precisely: the promo's *update* toast
opens the pinned Open VSX file when the registry answered, and this URL only when it did not —
both are real artifacts, so the divergence is in which copy, never in which release.)

Four precautions keep it from becoming the failure recorded under
[A notification pauses the built-in browser](#a-notification-pauses-the-built-in-browser):

- **Nothing is said unless there is a newer release.** Up to date, offline, a body that is not a
  manifest — all answer the same way, which is silence. There is no "you are up to date" toast
  and no error.
- **The first look is 10s after activation**, the same delay and the same reason as the promo
  build: a window that restores a browser tab must not be greeted with a toast as it opens.
- **A notice is held back while a browser page is *visible*, not merely while one is focused**,
  and delivered from `onDidChangeActiveBrowserTab`, `onDidCloseBrowserTab`,
  `tabGroups.onDidChangeTabGroups` or `tabGroups.onDidChangeTabs` the moment that stops being
  true — so it never takes away the
  page being read, and it does not wait an hour either. The first version of this guard asked
  `activeBrowserTab` alone and was wrong for the normal way this extension is used: the editor
  decides the pause **geometrically** — `_refreshOverlayObscured` asks the overlay manager for
  anything *overlapping* the browser container and never consults focus — so a browser tab in a
  split beside a file is paused by a toast while `activeBrowserTab` is `undefined`. That is the
  wording of breaks-silently #10, "while a browser tab is **visible**". There is no direct
  signal: the proposal exposes only the active tab, and `window.tabGroups` has **no
  `TabInputBrowser`** (the extension host models eleven input types and a browser editor is not
  among them), so a browser tab arrives as `input: undefined`. `browserTabVisible` therefore
  treats a group whose *visible* tab has no input as a browser, but only while `browserTabs` is
  non-empty. The false positive is deliberate and cheap: another unmodelled editor merely defers
  the notice to the next delivery attempt, while a missed browser pauses somebody's page.
- **And the guard holds without the grant, where it is needed most.** It used to return `false`
  the moment `isBrowserApiGranted()` was false, on the reasoning that a host with no API has no
  page to pause. That is wrong for three classes at once, and the third is the common one: Kiro
  ships the browser editor and none of the API, VSCodium ships both and withholds the grant, and
  **stock VS Code before `argv.json` is written is the default state of every fresh install** —
  which is exactly when a user is most likely to be reading a page and least likely to forgive a
  toast that freezes it. So the `tabGroups` heuristic runs there too. It cannot be bounded by
  `browserTabs` (that read is what throws), so it is bounded by the *host* instead: only where
  `workbench.action.browser.open` is registered. **`browserApiState()` is the wrong question**,
  because it answers `unsupported` for Kiro, which has the editor; the open command is what
  actually tracks the browser UI and is present on every measured host that has one. It is probed
  once with `getCommands(true)` and cached, since the answer cannot change while the window runs
  and `_deliver` is called from event handlers. Until the probe lands the flag is `false`, which
  is the safe direction — the first check is ten seconds away regardless.
- **Once per release, not once per window** (`aiBrowser.update.offeredVersion`), and the version
  is recorded **before** the message goes up rather than after the user answers. A notice that
  was dismissed has still been seen; repeating it in every window until a button is pressed is
  how a helpful notice becomes something people disable the extension over.

**Every action behind a button is guarded, and the opt-out especially.** `_deliver` hands
`_announce` off without awaiting it — it is called from event handlers — so the call carries a
`.catch`, or a failure there is an unhandled rejection on the one path written to be silent
(breaks-silently #93). Two of the three actions can genuinely fail: `openExternal`, and the
settings write, which VS Code refuses outright while `settings.json` has a syntax error. That
second one is the sharp case, because the button whose entire meaning is "stop asking me"
silently did not apply while the release had already been recorded as announced — so the only
visible consequence was the *next* release appearing regardless. Both now report through
`refuse()` (the status bar, never a second toast), and a link that could not be opened is put on
the clipboard.

**`Don't show again` writes the setting, globally, and that is what makes it a checkbox.** There
is no checkbox in a VS Code notification — the API is buttons — so the durable form of the choice
is `aiBrowser.updateCheck.enabled`, which the button sets to `false` at
`ConfigurationTarget.Global`. That is also the only way back: a button that can only ever be
pressed once, with nothing in Settings to undo it, is a trap. The tick re-reads the setting every
time rather than caching it, and `onDidChangeConfiguration` runs a check as soon as it is turned
back on, so re-enabling does not mean waiting an hour.

**The throttle is stamped only by a request that reached GitHub** — six hours between requests
(`aiBrowser.update.lastCheck`) — because a laptop whose first window of the day opens offline
must not buy six hours of silence for every window after it. The same rule, and the same
reasoning, as the promo build's. And the watch is driven by an hourly **tick** rather than one
`setTimeout`, or a window left open for days would check exactly once ever.

**It bounds successful checks and nothing else, and the two gaps are stated rather than rounded
off** — an earlier draft of this paragraph and the setting's own description both said "ten
windows in a morning are one request", which is not true in either direction that matters. A
request that reached nobody does not stamp anything, so an offline machine retries on every
tick; and windows that start together all read the stamp before any of them writes it, so a
restored session of ten windows is ten requests. Both are accepted, and the settings description
now says "once it has reached GitHub" instead of promising a rate.

**Verified with a fake `vscode`**, the way [the status bar](#the-status-bar-one-permanent-button-one-that-hides-itself)
and the promo build were: `out/updateCheck.js` loaded against a stubbed `vscode`, a stubbed
`fetch` and a stubbed `globalState`, printing what each state does — newer release, same version,
a repository that is *behind*, offline, already announced, inside the throttle, past it, the
setting off, each of the three buttons, a browser page in front and then the user looking away, a
browser tab visible in a *split* while a file is focused, a `version` carrying a Markdown command
link, a settings write that fails, an `openExternal` that fails, and a host with no browser
proposal. The promo build was re-checked the same way for the stand-down: it speaks for an
installed 0.5.23 and is silent for 0.5.24 and later. Worth redoing that way after touching this file; a typecheck
says nothing about which of those states puts a toast on screen.

### `.mcp.json` is gitignored **in this repository**, and that is not a contradiction

Upstream's design is that a project commits `.mcp.json` and shares it with a team, and the
[Not built yet](#not-built-yet) entry on a stdio bridge is about exactly that trade-off. It
holds for a *consumer's* project. It does not hold here: this repository is public, and pressing
`Connect Claude Code` while working **on the extension itself** writes the workspace's bearer
token into the repository root — the only thing guarding a loopback server that can drive the
developer's browser. So `.mcp.json` is in `.gitignore` and in `.vscodeignore`, the second
because it was otherwise packaged into the VSIX as `extension/.mcp.json` and would have shipped
the token to everyone who installed it. Found by review while the file was staged and not yet
committed, so nothing leaked; if it ever does reach a commit, rotating the token is not enough
on its own — the token is the identity `repairConfigs` matches on, so every config naming this
window stops being recognisable at the same moment (see
[The port moves](#the-port-moves-and-the-config-remembers-the-old-one)).

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
