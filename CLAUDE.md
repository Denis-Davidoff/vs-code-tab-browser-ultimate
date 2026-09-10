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
- [src/proposedApi.ts](src/proposedApi.ts) — the one-click `browser` grant, and host detection
- [src/argvJson.ts](src/argvJson.ts) — surgical JSONC edits to `argv.json` (leaf, under test)
- [src/statusBar.ts](src/statusBar.ts) — the two status bar items and their menu
- [src/notify.ts](src/notify.ts) — confirmations, kept out of the notification area
- [src/elementPicker.ts](src/elementPicker.ts) — the three element commands
- [src/elementContext.ts](src/elementContext.ts) — pulls element data out of the page over CDP
- [src/elementMarkdown.ts](src/elementMarkdown.ts) — renders that data as Markdown
- [src/cssHelpers.ts](src/cssHelpers.ts) — copied verbatim from vscode, builds the CSS section
- [src/reportFormat.ts](src/reportFormat.ts) — report text and file names (leaf, under test)
- [src/assistants.ts](src/assistants.ts) — handing reports to Claude Code and Codex
- [src/lastAction.ts](src/lastAction.ts) — which element command the toolbar button repeats
- [src/browserController.ts](src/browserController.ts) — what the browser can do, for MCP
- [src/shareIndicator.ts](src/shareIndicator.ts) — the marker on a shared tab, page-side
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
never reads, and then asks for a restart that changes nothing — the same dead end as the Kiro
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
(swallowing the id). So the insert point is the end offset of the last element, which is always
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

**The permanent item also carries the share.** `$(globe) AI Browser` becomes
`… 🔗` while a tab is shared, `… 🤖` once an assistant has driven it, and
`… $(debug-pause)` with a warning background when the shared tab was closed and the tools are
paused — the one share state that is waiting on the user. See
[The marker on the shared tab](#the-marker-on-the-shared-tab).

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
does** — sharing this tab, the three element commands, then the three MCP ones. `Stop Sharing
Tab` is gated on the `aiBrowser.tabShared` context key, republished from `extension.ts` on every
share change, so it is only there while there is something to stop. Two `group` prefixes
(`1_copy@n`, `2_mcp@n`) put a separator between them; ordering comes from the `@n` suffix, not
from the position in the `contributes.menus` array.

There is no activity bar panel any more. It was a `TreeDataProvider` in `src/toolsView.ts`, and
it went away when the same commands landed in this dropdown; `media/activity-icon.svg` went
with it. One consequence worth knowing: the dropdown is gated on
`activeEditor == 'workbench.editor.browser'`, so from here **Connect Claude Code / Connect Codex
/ Check Connection are only reachable from a browser tab**. They are also in the command
palette, where every command still appears, and in the status bar menu — which is the surface
that exists because of this gap, see
[The status bar](#the-status-bar-one-permanent-button-one-that-hides-itself).

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

**The pick slot is claimed before the cancel button appears, and that order is the fix.**
`beginPick()` / `endPick()` own `pendingPick`, and `pickAndDeliver` calls them around the button
rather than letting `withPickedElement` assign the slot on its way past
`await tab.startCDPSession()`. It used to: for as long as that await took, `Cancel pick` was on
screen calling `cancel()` on `undefined` — or on the *previous* pick's token — so the button did
nothing on exactly the slow sessions where someone would reach for it. The same move fixed a
leak: a rejection from `startCDPSession` escaped past the cleanup, leaving the slot pointing at a
dead token until the next pick reclaimed it. The client is now constructed inside the `try`.

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
line range would orphan it. The token-in-URL form is still *accepted* when reading, since
existing configs have it, and a stale sub-table of ours is removed on write.

**Neither assistant re-reads its config.** Both load MCP servers at startup: Claude Code needs
a restart, Codex a brand-new conversation. This is why the connection prompt names the *tools*
and never tells the model to go and read `config.toml` — a model sent to read the file will
confirm the server is configured and still have no tools, which is precisely what made Codex
look stupid.

**And it asks for a check, not for work.** The line used to end "to inspect the page in the
integrated browser", which both assistants took as the task: they opened the browser tools on
whatever page was open and started reporting on it, before the user had asked for anything. The
paste exists to find out whether the tools arrived, so it now asks exactly that and says not to
use them yet.

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

### Sharing one tab: the user's half of "work on this page"

`aiBrowser.shareTab` / `aiBrowser.stopSharingTab` add a **third level of tab intent**, above
both existing ones, and the reason it had to exist is that the other two are not
interchangeable:

| level | who sets it | can the model release it |
|---|---|---|
| `_sharedTab` | the user, by command | **no** |
| `_pinnedTab` | the model, `browser_select_tab` | yes |
| automatic | focused → last used → most recently opened | n/a |

`browser_select_tab` was the only way to fix the tools on a tab, and it is called by the *model*
— so the user had no way to state the same thing, and without a selection every call followed
`activeBrowserTab`. Click into another page while an agent works and the agent went with you;
`browser_navigate` then drove the page you had just opened. A share sits above the focused
editor for that reason, and above the model's pin so it cannot be handed back.

**Sharing does not fall back when its tab closes, and that is the one place it deliberately
differs from a pin.** A pin reverting to automatic is right for a choice the model made; doing
the same to the user's choice resumes work on whatever happens to be focused, which is exactly
the failure the share exists to prevent. So the state goes to `lost`, every tool answers
`shareLostMessage`, and `browser_state` reports `selection: 'paused'` with `sharedTabClosed`.
Only the user can leave that state (share again, or stop sharing) — which is why the message
names the command instead of suggesting the model do something.

**`_resolveTab` takes a `user` flag, and forgetting it breaks the toolbar.** A lost share pauses
the *assistants*; a button the user pressed has nothing to do with them. The first version
short-circuited in `_resolveTab` for everyone, so after the shared tab closed a screenshot
answered "No browser tab is open" with another tab open in plain sight. `capture` therefore
takes `user` too, and `screenshot.ts` passes it — the same line already drawn by
`focusedTab`.

**Two refusals, because the alternative is a silent no-op.** Under a share,
`browser_select_tab` cannot take effect and `navigate(newTab: true)` would open a tab that the
next tool ignores — the "reports `tab-2`, acts on `tab-1`" shape recorded above. Both throw and
say who can change it. Navigating *inside* the shared tab stays allowed: the share is on the
tab, not on the URL.

**Other tabs are still listed.** `browser_tabs` marks the shared one (`sharedByUser`) and leaves
the rest visible as context — hiding them would only make the ids in that list confusing, and
what they are not is *selectable*, which the refusal already says.

**Who touched it is tracked at the point a tab is handed out, not per request.** `beginCall` /
`endCall` in the controller are set by the transport around `tools/call` only, and `_noteTabUse`
records the caller when `_requireTab` hands out the shared tab. Deliberately not "an assistant
made a call": `browser_tabs` and `browser_state` answer without touching a page, and a marker
lighting up on those would claim work on a tab nothing had opened. With two assistants calling
at once the *label* can name the wrong one; the fact being guarded — the tab was used at all —
is unaffected, and that is not worth a caller argument on every tool.

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
  **returns a boolean instead of swallowing its failure**: "the marker is off" and "the channel
  died before it could be taken off" must not look the same to the caller that has another way
  in.
- **A superseded open retries once, and only while its tab is still the subject.**
  `_sessionFor(tab, retries = 1)`: a session that arrives unwanted because the cache moved is a
  stale attempt rather than a failure — *if the caller still wants that tab*. The first version
  retried unconditionally and that was worse than the error it removed, measured both ways
  against a stubbed channel with the handshake held open:

  | | unconditional retry | `_stillWanted` |
  |---|---|---|
  | open X in flight, user shares Y | Y left with **no live session** while sharing Y is in force — its marker registration gone with it — and X holding the cache | Y keeps its session and registration; the stale call is refused |
  | open in flight, then `dispose()` | a second session opened and **left running**, with nothing left to close it | one session, opened and closed |

  So `_stillWanted` answers no to anything that has taken over — the controller disposed, the
  tab closed, a share moved or paused, a newer open for a different tab, a pin elsewhere — and
  it is side-effect free on purpose, since `_resolveTab` moves `_lastTab` and can end a share,
  neither of which a stale request may do. `_disposed` is set *first* in `dispose`, so an open
  landing after it sees it; `_sessionFor` refuses outright once it is set. The retry also clears
  its own `_opening` entry before recursing — otherwise it matches on the tab and awaits the
  very promise it is running inside. A request that loses its subject is told to ask again,
  which is right: serving it from under the new owner is how a call comes to report one tab and
  act on another.

**`_sharedTab` still moves *before* the old tab is cleaned**, and that order is load-bearing for
a different reason: while it still named the old tab, a concurrent tool resolving it could send
`_sessionFor` down the arm-on-open path and re-mark the very tab being cleaned.

### The marker on the shared tab

The share is also visible **on the tab itself**, because an assistant driving a page in the
background looks exactly like an assistant doing nothing.

Nothing in the `browser` proposal decorates a browser tab — there is no badge, no description,
no colour, and `contributes.menus` cannot reach that toolbar either (see
[the dropdown](#the-dropdown-on-the-browser-tab)). What an extension *can* reach is the page,
over CDP, and the editor tab is labelled with `document.title`. So the marker is a suffix on the
title, installed by [src/shareIndicator.ts](src/shareIndicator.ts):

| | |
|---|---|
| 🔗 | shared, no assistant has driven it yet |
| 🤖 | an assistant has driven it at least once |

The two states are the point. A share nobody picked up is the common failure — neither
assistant re-reads its config, so one that was never restarted has no `browser_` tools at all —
and 🔗 that never becomes 🤖 is what that looks like from outside.

Everything about the implementation follows from the page being someone else's:

- **The suffix is re-applied, not set once.** A page rewrites its own title constantly: an SPA
  on every route change, a chat on every unread count. Setting it once meant the marker survived
  until the first such write. A `MutationObserver` on `document.head` catches both the text
  changing and the `<title>` element being replaced, at a fraction of the cost of observing
  `document`. It cannot loop: `apply` writes only when the suffix is missing, so our own write
  wakes the observer, finds it already there and stops.
- **It is registered with `Page.addScriptToEvaluateOnNewDocument` as well as evaluated**, or it
  would be gone after the first navigation. The identifier is kept so `clear()` can remove it —
  without that, un-sharing left the marker to come back on the next page load.
- **The indicator hangs off the `TabSession`, not off the controller.** A registered script
  identifier belongs to the session it was registered on. Held on the controller it outlived a
  dropped session, so "stop sharing" removed an id that no longer existed. `_sessionFor` arms it
  whenever a session for the shared tab opens, which is also what re-marks the page after the
  host drops a session.
- **`stripMarker` is applied to every title that leaves the extension** — tool results, the
  status bar, the share state. Otherwise an agent reads the page title as `Orders 🤖` and files
  a screenshot under it. There are **two sources** of a title and both need it: `BrowserTab.title`
  (`state`, `tabs`, the share state, the menu) and `document.title` read in the page
  (`navigate`, `snapshot`). `snapshot` was missed on the first pass precisely because it comes
  from the second one. It also only trims when it actually cut something: a trailing space in
  someone else's page title is theirs, not ours.
- **`set()` and `clear()` are serialised on one queue, not merely deduplicated** (`_enqueue`).
  They race by construction: the marker is armed from two places — a session opening, and the
  share being set — while `clear` comes from a button that can be pressed at any moment.
  Overlapped, a `clear` arriving mid-install did *nothing twice* — `_scriptId` was not assigned
  yet, so there was no registration to remove, and `window.__aiBrowserShareMarker` did not exist
  yet, so `remove()` was a no-op — and the install then completed **after** it, putting the
  marker back on a tab nobody was sharing and re-registering the script that returns it on every
  later navigation, with nobody holding the identifier any more. The chain itself never rejects
  (a rejected link is inherited by everything queued behind it) while the caller of `set` still
  gets the real error.
- **`_marker` records what is on the page, and is written after the install, never before it.**
  Written up front it recorded the *request*: one rejected install left the indicator believing
  the marker was there, and since the same session keeps the same indicator, the
  `_marker === marker` short-circuit then suppressed every retry — a shared tab with no marker
  for the rest of the session.
- **`clear()` never short-circuits on having no marker recorded.** A fresh indicator on a newly
  opened session knows nothing, while the page may still carry a marker installed by the session
  before it — which is precisely what `stopSharing` and a re-share have to clean up.
- **Moving a share un-marks the tab it moves off** (`_clearIndicator` in `shareTab`). Dropping
  the old session takes the registration with it, so the marker does not return on that tab's
  next navigation — but the live document keeps the suffix *and* the observer re-applying it. So
  "Share this tab instead" left both tabs looking shared, permanently: `stopSharing` only knows
  about the current `_sharedTab`. It runs before `_dropSession` (so the session holding the
  script identifier is still there) and after `_sharedTab` has moved (or `_sessionFor` re-arms
  the marker on the tab being cleaned), and it skips a tab that has closed, since
  `startCDPSession` on one only throws.
- **Page-side, `remove()` disarms the deferred start, not just the observer.** The script runs at
  document start on a navigation, so on a page still loading the real work is queued on
  `DOMContentLoaded`. Un-sharing before that fires used to leave the listener armed: `start` ran
  off its closure, re-applied the suffix and built a *second* observer — and `window[key]` was
  already deleted, so no later `clear()` could reach it. Hence `state.removed`, checked by
  `start`, `apply` and `set`, plus an explicit `removeEventListener`.
- **Everything about it is best effort.** A session the host dropped, a tab mid-close, a page
  that has not committed — each is a reason the marker does not matter, and none of them may
  turn sharing into an error.
- **The page-side `remove` runs in someone else's page, so its order is deliberate**: the
  `removed` flag first (a queued observer or `DOMContentLoaded` callback then finds the marker
  gone rather than putting it back), then the title, then `delete window[key]`, and only then
  the two disarms, each in its own `try`. A page is free to have replaced or broken
  `removeEventListener` or `MutationObserver.prototype.disconnect`, and with the old order that
  left our suffix on its tab permanently; deleting the global late was the same trap from the
  other side, because a surviving `removed` state makes every later `set` refuse, so the marker
  could never come back on that page. The flag is what makes the disarms a tidiness measure
  rather than correctness. Verified against stub pages that throw from each.

**A one-off read of another tab must not move the cached session** — `_borrowSession`. The
cache is single (`_session` / `_sessionTab`) and `_sessionFor` *drops* whatever it holds, which
is right for the tools, whose subject really has moved, and wrong for a screenshot: a
`addScriptToEvaluateOnNewDocument` registration is per-session state, so disposing the shared
tab's session disarms the marker on it. Share A, screenshot B, reload A and the marker is gone
while sharing is still in force — the symptom arriving long after the action that caused it, and
the console buffer the assistant was collecting goes with it. So `capture` reuses the cached
session only when it already belongs to that tab, and otherwise opens a throwaway one and
disposes it, the same shape the element picker uses.

A floating badge injected into the page was the alternative and was rejected: it lands in every
screenshot the agent takes, and shows up in `browser_html` / `browser_text` as page content that
is not the page's. A title suffix is visible in exactly one place — the tab.

The status bar carries the same two emoji, deliberately the same ones, so the item and the tab
read as one indicator rather than two that happen to agree; `lost` is the only share state that
takes a background there, since it is the only one waiting on the user.

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
(`0_share`, `1_copy`, `2_shot`, `3_claude`, `4_codex`, `5_mcp`) are the running order of the
whole menu.

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

**A window registry and cross-window routing.** Repair fixes a config at the next window start;
routing would make a wrong port not matter at all — a window receiving a valid token that is
not its own would look the owner up in a registry (`~/.ai-browser/windows.json`: token, port,
folder, pid) and proxy the call there. It also upholds rule 3 of the security model better than
the 401 does, since project A's config would then always reach project A's window rather than
merely failing to reach anyone else's. Not built because repair covers the same ground without
a new HTTP hop, a shared registry file to keep pruned, or a story for a window closing
mid-call.

**A share per assistant.** One tab is shared with everything at once, because that is the shape
the feature was asked for and it costs nothing beyond the precedence rule. Claude on one page
and Codex on another would need two things: the caller threaded into `Tool.run` and `dispatch`
(both under test) rather than the in-flight `beginCall` field, and — the real cost — a *map* of
CDP sessions instead of the single `_session`. The session is cached precisely because console
capture only happens while something is attached, so two clients alternating between two tabs
would drop the buffer on every other call. Not built until someone actually drives two
assistants on two pages at once.

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
38. **Swallowing a failure inside a best-effort cleanup that has a second route** → the caller
    cannot tell "done" from "the channel died", so the fallback never runs.
    `ShareIndicator.clear()` reports instead.
39. **Attributing a `tools/call` only when the client is recognised** → only `initialize` names
    a client, so an assistant that does not echo `Mcp-Session-Id` drives the shared tab while
    its marker still says nobody has picked it up.
40. **Resuming a superseded async open without re-checking what it was for** → the retry comes
    back for a tab that is no longer the subject and drops the session of the one that is (a
    share moving is the common case, and the marker's registration goes with the session), or
    runs after `dispose` and leaves a session with nothing left to close it. Guard with
    `_stillWanted`, and set `_disposed` before tearing anything down.
41. **`Open File` on a host without the built-in browser** → a `file:` URI in the webview panel
    is blocked by `localResourceRoots`, so the panel renders blank with no error. The menu entry
    is therefore gated on `shouldUseIntegratedBrowser()` rather than falling back.

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
