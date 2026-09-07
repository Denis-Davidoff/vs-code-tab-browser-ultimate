# Tab Browser Ultimate — project context

VS Code extension: a browser tab in the editor (iframe in a webview) whose toolbar can hand the
rendered page to an assistant — a full report of a picked element, or the page's console output.

Forked from the Simple Browser extension that ships with VS Code and renamed throughout to
`tabBrowser.*` so both can be installed side by side. Not a git repository.

## Layout

| Path | Runs in | What it is |
| --- | --- | --- |
| `src/` | extension host (node) | activation, the webview panel, the local proxy, clipboard, tab icon |
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

## The copy menu

A split button: its main half runs the entry used last (remembered in the webview state), the
chevron opens the menu. Entries are `element`, `elementXPath` and `console` (`CopyCommand`),
also exposed as commands: `tabBrowser.copyElement`, `.copyElementXPath`, `.copyConsole`.

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
