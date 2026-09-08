# AI Browser — baseline working version

**Status: this version works. It builds from scratch with zero errors and is a good starting
point.** New functionality gets built on top of it. When changing anything, preserve the
invariants listed under [Things that break silently](#things-that-break-silently) — those are
the ones that produce no compile error and only show up at runtime as a blank panel or missing
icons.

The extension is a fork of `simple-browser` from the microsoft/vscode monorepo, extracted into
a standalone project and renamed. Every tie to the monorepo (gulp, shared esbuild helpers,
`../../node_modules`) has been removed.

Published as `DenysDavydov.ai-browser`.

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

Settings: `aiBrowser.focusLockIndicator.enabled`, `aiBrowser.useIntegratedBrowser`
(delegate to VS Code's built-in browser instead of our panel — **off by default**, see
[Special cases](#special-cases-and-non-obvious-decisions)) and `aiBrowser.searchEngine`.

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
typecheck                run-p -l typecheck-ext typecheck-webview
typecheck-ext            tsc --project ./tsconfig.json --noEmit
typecheck-webview        tsc --project ./preview-src/tsconfig.json --noEmit
test                     node --test preview-src/*.test.ts   ← Node's runner, no deps
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

### Proposed API

The manifest declares `enabledApiProposals: ["externalUriOpener"]`, required by
`vscode.window.registerExternalUriOpener`. Consequences:

- [vscode.proposed.externalUriOpener.d.ts](vscode.proposed.externalUriOpener.d.ts) is
  **checked into the repo** so the build works offline. Refresh it with `npm run download-api`.
- Launching requires the `--enable-proposed-api=DenysDavydov.ai-browser` flag, which is set in
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
7. **Forgetting `npm run compile` after a clone** → `media/index.js` is not in git, panel is
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

- **Delegation to the built-in browser is opt-in, not automatic.** All three entry points call
  `shouldUseIntegratedBrowser`, which originally returned `true` whenever the command
  `workbench.action.browser.open` existed. That command exists in every recent VS Code, so our
  own panel never opened at all and every change to it was invisible. It is now gated on
  `aiBrowser.useIntegratedBrowser` (default `false`). Do not "restore" the plain command probe
  — it silently disables this extension's entire UI.

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

## Known issues, not yet fixed

- **`engines.vscode: ^1.70.0` vs `vscode.l10n`.** The code calls `vscode.l10n.t()`, an API
  finalized in **1.73**. On 1.70–1.72 the extension installs and then fails on activation.
  Raising `engines` to `^1.74.0` makes sense (at which point the explicit
  `onCommand:aiBrowser.show` also becomes optional — implicit activation events arrived in
  1.74).
- **`media/preview-dark.svg` and `media/preview-light.svg`** — 16×16 icons referenced by
  nothing: not the code, not the manifest, not the README. Monorepo leftovers.
- **No tests and no linter.** Both were covered by shared infrastructure in the monorepo.
- **Zero production dependencies, and it is worth keeping it that way.** `build-ext` is `tsc`
  without bundling, so `out/` contains no dependencies. `vsce` will pack `dependencies` into
  the VSIX automatically, but once heavy runtime dependencies appear, the right move is to
  bundle the extension host with esbuild.
- **npm 11 blocks postinstall scripts.** `esbuild` has one, hence the `allowScripts` block in
  `package.json`. After an esbuild version bump the approval has to be granted again
  (`npm install-scripts approve esbuild`), otherwise the binary is not installed.
