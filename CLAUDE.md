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

**What differs from upstream `simple-browser`**, in one list, because the README used to carry it
and nothing else here states the delta as a whole:

- **Identifiers renamed** so this installs beside the built-in one — `simpleBrowser.*` →
  `aiBrowser.*` for commands, the webview view type and the settings. See
  [Naming conventions](#naming-conventions).
- **Built around the editor's own browser** rather than the panel: all three entry points
  delegate to `workbench.action.browser.open` unless `aiBrowser.useIntegratedBrowser` is off, and
  the element picker, the screenshots and the MCP tools drive it over CDP.
- **Build replaced** — `tsc` for the extension host, a self-contained `esbuild.webview.mts` for
  the webview. See [Build](#build).
- **Removed:** `aiKey`, `@vscode/extension-telemetry`, the web-worker entry point and the
  `isWeb`-only palette gate — see
  [Removed on purpose](#removed-on-purpose--do-not-reintroduce). There are no runtime
  dependencies at all: `node-pty` and xterm are build-time inputs, bundled or staged into the
  package — see [Build](#build).
- **Added on top:** the element picker and its reports, the screenshots, the hand-over to Claude
  Code and Codex, the MCP server, saved logins and passkeys, and the toolbar menu they live in —
  and, from 0.7, [a chat of our own](#the-ai-browser-chat) driving the Claude Code and Codex CLIs
  — which also holds [terminal tabs](#terminal-tabs-a-real-shell-in-the-chat) (a real shell, or an
  agent's own CLI, drawn with xterm.js).

**The README is deliberately short and this file is the reference.** It was cut back to the
pitch, the editor-support table and the toolbar, plus `api.open`, installing and the licence;
everything it used to duplicate — what each command writes, the MCP server and its tools,
sharing a tab, the settings and command reference, the `argv.json` grant, the build — lives here
and only here. That is on purpose: the two drifted, and a README section that restates a rule is
a second place for that rule to go stale. **Do not grow the README back**; add to this file and
link to it. Note that the README *is* packaged into the VSIX as `extension/readme.md`, so it is
the extension's page inside VS Code — keep it accurate, just not exhaustive.

## How we build features — the main approach

**New browser functionality is built against VS Code's built-in browser, through the `browser`
API proposal and CDP. This is the default and it is settled** — the recipe is in
[The `browser` proposed API](#the-browser-proposed-api--the-main-way-to-add-features). It is
proven, not theoretical: the element picker ([src/elements/elementPicker.ts](src/elements/elementPicker.ts))
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
| `aiBrowser.logins.enabled` | `true` | saved logins and passkeys in pages; off, nothing is injected — the vault stays manageable |
| `aiBrowser.logins.offerToSave` | `true` | offer to save or update after a sign-in that worked |
| `aiBrowser.logins.showSuggestions` | `true` | the `$(key) Fill login` status bar item on a sign-in form |
| `aiBrowser.logins.autofillOnPageLoad` | `false` | fill on load when exactly one login is saved for that exact origin |
| `aiBrowser.passkeys.enabled` | `true` | the gated virtual authenticator — see [Passkeys](#passkeys-a-virtual-authenticator-that-holds-nothing) |

The five `logins`/`passkeys` settings are `application`-scoped: a workspace cannot set them, or a
cloned repository could switch autofill on for its own dev server (breaks-silently #248).

| Chat setting | Default | |
|---|---|---|
| `aiBrowser.chat.tabLimit` | `10` | how many conversations stay open as tabs, 1 to 30 — see [Tabs](#tabs-several-conversations-at-once) |
| `aiBrowser.chat.terminalLimit` | `8` | how many terminal tabs stay open, 1 to 20, `application`-scoped; counted apart from the conversations — see [Terminal tabs](#terminal-tabs-a-real-shell-in-the-chat) |
| `aiBrowser.chat.remoteTerminal` | `false` | let the Chrome side panel and the Exchange website open, watch, and with a lease type into, terminal tabs marked "Allow remote access"; `application`-scoped, the website on encrypted connections only — see [Remote terminals](#remote-terminals-on-the-exchange-website-and-in-chrome) |
| `aiBrowser.chat.remoteTerminalShell` | `false` | with `remoteTerminal` on, let Chrome and the website open a plain shell terminal; `application`-scoped — see [Remote terminals](#remote-terminals-on-the-exchange-website-and-in-chrome) |
| `aiBrowser.chat.remoteTerminalAgent` | `false` | the same for an agent's own CLI in a terminal; `application`-scoped |
| `aiBrowser.chat.claudePath` | `""` | the `claude` executable; empty searches — see [Finding the CLIs](#finding-the-clis) |
| `aiBrowser.chat.codexPath` | `""` | the `codex` executable, the same way |
| `aiBrowser.chat.geminiPath` | `""` | the `gemini` executable, the same way — see [Gemini CLI over ACP](#gemini-cli-over-acp) |
| `aiBrowser.chat.opencodePath` | `""` | the `opencode` executable, the same way; `application`-scoped — see [OpenCode over ACP](#opencode-over-acp) |
| `aiBrowser.chat.piPath` | `""` | the `pi` executable, the same way; `application`-scoped — see [Pi over its RPC mode](#pi-over-its-rpc-mode) |
| `aiBrowser.chat.openrouterEndpoint` | `""` | the OpenRouter API address (empty: `https://openrouter.ai/api/v1`); `application`-scoped, https or loopback http only, since the API key is sent to it — see [OpenRouter](#openrouter-an-http-api-and-our-own-agent-loop) |
| `aiBrowser.chat.sound.enabled` / `.name` / `.volume` / `.repeat` | `true` / `chime` / `60` / `1` | the sound when an agent finishes — see [Finish sounds](#finish-sounds) |
| `aiBrowser.chat.viewMode` | `compact` | how much of the agents' work the chat shows: `minimal`, `compact` (tool calls folded) or `standard` (unfolded) — see [View modes](#view-modes-minimal-compact-standard); also the View Mode row of the chat's approval menu |
| `aiBrowser.chat.collapseToolCalls` | `true` | deprecated by `viewMode`, and read only while that is unset: `false` is Standard, anything else Compact |

The two paths are `application`-scoped for a sharper reason than the logins ones: each names a program
to run, so a workspace that could set it would be code execution from a cloned repository the
moment the chat view opens.

## Architecture: two independent halves

This is the key thing to understand about the build. The code lives in two isolated runtimes,
each with its own compilation step.

### 1. Extension host (Node.js) — `src/` → `out/`

Compiled with `tsc`, **no bundling**. `main: ./out/extension`.

**`src/` is split into feature folders, and `out/` mirrors it.** `extension.ts` stays at the
root, which is what keeps `main` unchanged. The folders follow the features this file documents,
not kinds of code:

| Folder | Holds |
|---|---|
| `core/` | shared plumbing: `dispose`, `uuid`, `notify`, `notifyText`, `safeFiles`, `fileLock`, `webUrl`, `cdp`, `gitBinary` |
| `setup/` | the `browser` grant, the status bar, the release watch: `proposedApi`, `argvJson`, `statusBar`, `updateCheck`, `updateVersion` |
| `panel/` | the old webview panel: `aiBrowserManager`, `aiBrowserView` |
| `browser/` | the built-in browser for the tools: `browserController`, sharing, screenshots and their encoders, `clipboardImage` |
| `elements/` | the element picker and its reports, and the hand-over to the assistants |
| `mcp/` | the MCP server, client configs, the repair, `codexToml`, `gitignoreRule` |
| `logins/` | saved logins and passkeys, including the MPL-2.0 `loginFormScript.ts` |
| `translate/` | Translate Page |
| `chat/` | the AI Browser chat and the agents behind it |
| `power/` | keeping the computer awake from the chat: the window's vote, the shared daemon, the OS lock |
| `terminal/` | the PTY half of the chat's terminal tabs: `terminalHost` (node-pty, flow control, shell and environment). Its chat-side modules, `terminalTab` and `terminalLogic`, live in `chat/` |
| `editor/` | the code editor for the MCP tools: `editorTools` (`editor_context`, `editor_reveal`, the language features), `editorText` |

Rules that come with it:

- **Tests sit beside their module** (`mcp/mcpRepair.test.ts`), so their explicit `./x.ts`
  imports stay short and a leaf module's tests never reach across folders by accident. `npm test`
  passes `"src/**/*.test.ts"` quoted, so Node expands it rather than the shell: an unquoted `**`
  without globstar is a single `*`, which happens to match today's one level of folders and would
  miss a test at the root or two levels down. **A pattern that matches nothing passes**:
  `node --test` reports `tests 0` and exits 0, so a mistyped glob, or the old `src/*.test.ts`
  against this layout, is green with nothing run. After touching the script, check the count —
  632 tests at the move.
- **No barrel files** (`index.ts` re-exporting a folder). A re-export is a relative value import,
  which a module `npm test` loads may not have, and barrels are how import cycles start.
- **`build-ext` empties `out/` first** (`clean-ext`). `tsc` never deletes outputs, so after any
  move or rename the old `.js` stays in `out/` — and `out/**` is packaged, so a VSIX would carry
  both layouts, and nothing would fail.
- A new module goes in the folder of the feature it serves; something two features share goes in
  `core/` only when it holds no feature's logic.

The move itself (2026-10-16) was mechanical and checked that way: every module's compiled
JavaScript was compared with the build before it, equal apart from import paths — the one
difference, in `browserController.js`, was a doc comment whose link had been updated.

- [src/extension.ts](src/extension.ts) — `activate`, command and opener registration
- [src/panel/aiBrowserManager.ts](src/panel/aiBrowserManager.ts) — singleton holder for the active panel
- [src/panel/aiBrowserView.ts](src/panel/aiBrowserView.ts) — the panel: HTML generation, message bridge
- [src/core/dispose.ts](src/core/dispose.ts) — base `Disposable` with `_register`
- [src/core/uuid.ts](src/core/uuid.ts) — nonce generator, copied from `vs/base/common/uuid`
- [src/core/cdp.ts](src/core/cdp.ts) — CDP client for the built-in browser (not used by the panel)
- [src/setup/proposedApi.ts](src/setup/proposedApi.ts) — the one-click `browser` grant, and host detection
- [src/setup/argvJson.ts](src/setup/argvJson.ts) — surgical JSONC edits to `argv.json` (leaf, under test)
- [src/setup/statusBar.ts](src/setup/statusBar.ts) — the two status bar items and their menu
- [src/core/notify.ts](src/core/notify.ts) — confirmations, kept out of the notification area
- [src/core/notifyText.ts](src/core/notifyText.ts) — neutralising a page-supplied string for a notification, a prompt or a tooltip (leaf, under test)
- [src/elements/elementPicker.ts](src/elements/elementPicker.ts) — the four element commands
- [src/elements/elementContext.ts](src/elements/elementContext.ts) — pulls element data out of the page over CDP
- [src/elements/elementMarkdown.ts](src/elements/elementMarkdown.ts) — renders that data as Markdown
- [src/elements/cssHelpers.ts](src/elements/cssHelpers.ts) — copied verbatim from vscode, builds the CSS section
- [src/elements/reportFormat.ts](src/elements/reportFormat.ts) — report text and file names (leaf, under test)
- [src/core/webUrl.ts](src/core/webUrl.ts) — turning typed input into an address (leaf, under test)
- [src/elements/assistants.ts](src/elements/assistants.ts) — handing reports to Claude Code and Codex
- [src/elements/lastAction.ts](src/elements/lastAction.ts) — which element command the toolbar button repeats
- [src/browser/browserController.ts](src/browser/browserController.ts) — what the browser can do, for MCP
- [src/browser/tabSource.ts](src/browser/tabSource.ts) — every tab the tools can act on: the built-in browser's and Chrome's, shaped like the `vscode.window` members
- [src/browser/chromeBrowser.ts](src/browser/chromeBrowser.ts) — Google Chrome over its own DevTools WebSocket, each tab a `vscode.BrowserTab`
- [src/browser/shareRegistry.ts](src/browser/shareRegistry.ts) — who works on which tab (leaf, under test)
- [src/browser/shareIndicator.ts](src/browser/shareIndicator.ts) — the share glyphs, and reading a marker an older build wrote (leaf, under test)
- [src/mcp/mcpProtocol.ts](src/mcp/mcpProtocol.ts) — JSON-RPC dispatch and the auth decision (leaf, under test)
- [src/mcp/mcpPort.ts](src/mcp/mcpPort.ts) — which port a window tries first (leaf, under test)
- [src/mcp/mcpRepair.ts](src/mcp/mcpRepair.ts) — correcting a stale entry in a client config (leaf, under test)
- [src/core/fileLock.ts](src/core/fileLock.ts) — the cross-process lock on the shared config files (leaf, under test)
- [src/core/safeFiles.ts](src/core/safeFiles.ts) — the private temp directory, exclusive creates and atomic config writes (leaf, under test)
- [src/mcp/gitignoreRule.ts](src/mcp/gitignoreRule.ts) — whether `.codex/.gitignore` keeps the token file out of git (leaf, under test)
- [src/mcp/mcpServer.ts](src/mcp/mcpServer.ts) — HTTP transport, tools, client attribution
- [src/mcp/chatTools.ts](src/mcp/chatTools.ts) — the `chat_*` tools: the AI Browser chat's tabs, agents and limits, and controls for its own agents
- [src/core/chatCapability.ts](src/core/chatCapability.ts) — the in-memory `X-AI-Browser-Chat` value that stands for a conversation (leaf)
- [src/editor/editorTools.ts](src/editor/editorTools.ts) — the `editor_*` MCP tools: what the user has open, showing a place, definitions, references, symbols
- [src/editor/editorText.ts](src/editor/editorText.ts) — their paths, columns and cut lines (leaf, under test)
- [src/browser/screenshot.ts](src/browser/screenshot.ts) — Copy Screenshot (Visible Area / Full Page), the toolbar's capture
- [src/browser/clipboardImage.ts](src/browser/clipboardImage.ts) — a PNG onto the system clipboard, per platform
- [src/browser/screenshotFrames.ts](src/browser/screenshotFrames.ts) — how `browser_screenshot` is cut into frames for a model (leaf, under test)
- [src/browser/pngDecode.ts](src/browser/pngDecode.ts) — the screenshot PNG into raw rows (leaf, under test)
- [src/browser/jpegEncode.ts](src/browser/jpegEncode.ts) — a baseline JPEG encoder for those frames (leaf, under test)
- [src/mcp/mcpSetup.ts](src/mcp/mcpSetup.ts) — client config writing and the connect dialogs
- [src/mcp/mcpCheck.ts](src/mcp/mcpCheck.ts) — the Check Connection report
- [src/mcp/mcpClientState.ts](src/mcp/mcpClientState.ts) — config states (leaf, under test)
- [src/mcp/codexToml.ts](src/mcp/codexToml.ts) — the mini TOML table parser (leaf, under test)
- [src/mcp/mcpLifecycle.ts](src/mcp/mcpLifecycle.ts) — server lifetime and context keys
- [src/setup/updateVersion.ts](src/setup/updateVersion.ts) — comparing two versions (leaf, under test)
- [src/setup/updateCheck.ts](src/setup/updateCheck.ts) — the release watch and its one notification
- [src/logins/logins.ts](src/logins/logins.ts) — saved logins and passkeys: commands, the status bar item, the pickers, export and import
- [src/logins/loginWatcher.ts](src/logins/loginWatcher.ts) — the CDP half: one session per recent tab, sign-in outcomes, the passkey ceremony
- [src/logins/loginVault.ts](src/logins/loginVault.ts) — the vault in SecretStorage, written under a cross-process lock
- [src/logins/loginFormScript.ts](src/logins/loginFormScript.ts) — the page-side script, ported from Firefox — **MPL-2.0, the one non-MIT file**
- [src/logins/passkeyGate.ts](src/logins/passkeyGate.ts) — the page-side wrapper that asks before a WebAuthn ceremony
- [src/logins/loginMessages.ts](src/logins/loginMessages.ts) — what the page script reports, validated (leaf, under test)
- [src/logins/secretGuards.ts](src/logins/secretGuards.ts) — password values kept from the MCP tools: redaction, value-probing selectors (leaf, under test)
- [src/logins/vaultData.ts](src/logins/vaultData.ts) — the vault's shape, origin matching, save-or-update, merging (leaf, under test)
- [src/logins/vaultSeal.ts](src/logins/vaultSeal.ts) — the encrypted export: scrypt and AES-256-GCM (leaf, under test)
- [src/logins/loginCsv.ts](src/logins/loginCsv.ts) — CSV from and to Chrome, Firefox, Safari, Bitwarden, 1Password (leaf, under test)
- [src/translate/translate.ts](src/translate/translate.ts) — Translate Page: the tab, the language picker, the prompt on the clipboard
- [src/translate/translateText.ts](src/translate/translateText.ts) — languages, the prompt, checks on what the assistant writes back (leaf, under test)
- [src/translate/translateScript.ts](src/translate/translateScript.ts) — the page-side translator behind `browser_text_segments` / `browser_replace_text`
- [src/chat/chatView.ts](src/chat/chatView.ts) — the AI Browser chat: the webview view, its tabs, history, attachments, usage, switching agents
- [src/chat/chatTab.ts](src/chat/chatTab.ts) — one conversation of the chat: its session, its turns, its agents
- [src/chat/toolbarText.ts](src/chat/toolbarText.ts) — toolbar skills as text: what may be stored, parameters filled in, the agent's own sigils, the clipboard result markers (leaf, under test)
- [src/chat/toolbarRun.ts](src/chat/toolbarRun.ts) — a toolbar skill run in the background, its approvals, its clipboard result
- [src/chat/transcript.ts](src/chat/transcript.ts) — a conversation as Markdown, for handing it to the other agent (leaf, under test)
- [src/chat/diffSides.ts](src/chat/diffSides.ts) — a diff card's text as the before and after VS Code's diff editor compares (leaf, under test)
- [src/chat/news.ts](src/chat/news.ts) — NEWS.md into the empty chat's introduction and "What's new" (leaf, under test)
- [src/chat/fileIconTable.ts](src/chat/fileIconTable.ts) — the file icon theme as a lookup table, and which tokens of a message name a file (leaf, under test, read by both builds)
- [src/chat/workdir.ts](src/chat/workdir.ts) — the working folder's files for the folder button: a walk that reads `.gitignore` (leaf, under test)
- [preview-src/fileRank.ts](preview-src/fileRank.ts) — searching those files in the view (leaf, under test)
- [src/chat/githubRepo.ts](src/chat/githubRepo.ts) — a GitHub repository as typed: owner and name, branch names, addresses (leaf, under test)
- [src/chat/gitExtension.ts](src/chat/gitExtension.ts) — VS Code's Git extension for publish, push and fetch: its askpass signs in to a remote
- [src/chat/repoWork.ts](src/chat/repoWork.ts) — the git work behind it: the clone in storage, separate copies, read-only checkouts, push
- [src/core/gitBinary.ts](src/core/gitBinary.ts) — a `git` that can be run without the macOS install dialog, for Connect Codex and the chat
- [src/chat/exchangeChat.ts](src/chat/exchangeChat.ts) — one chat shared with a hosted Exchange server over an outgoing WebSocket
- [src/chat/exchangeProtocol.ts](src/chat/exchangeProtocol.ts) — the two remote commands, the server address rule, the text-only snapshot (leaf, under test)
- [src/chat/chatProtocol.ts](src/chat/chatProtocol.ts) — the messages between the chat's webview and the host (types only, read by both builds)
- [src/chat/agents.ts](src/chat/agents.ts) — the agent interface, and detecting which agents are installed
- [src/chat/agentBinary.ts](src/chat/agentBinary.ts) — where `claude` and `codex` are, and which copy to use
- [src/chat/agentProcess.ts](src/chat/agentProcess.ts) — a CLI speaking one JSON object per line
- [src/chat/agentProtocol.ts](src/chat/agentProtocol.ts) — reading what the two CLIs say: models, efforts, usage, skills and commands, turn events (leaf, under test)
- [src/chat/usageAlert.ts](src/chat/usageAlert.ts) — the plan-limit line above the chat: which limit, when it shows, what closing it means, when the plan is asked for (leaf, under test)
- [src/chat/claudeAgent.ts](src/chat/claudeAgent.ts) — Claude Code over `stream-json` and its control channel
- [src/chat/codexAgent.ts](src/chat/codexAgent.ts) — Codex over `codex app-server` JSON-RPC
- [src/chat/geminiAgent.ts](src/chat/geminiAgent.ts) — Gemini CLI over ACP (`gemini --acp`), one process per conversation
- [src/chat/opencodeAgent.ts](src/chat/opencodeAgent.ts) — OpenCode over ACP (`opencode acp`), one process per conversation; its leaf [opencodeProtocol.ts](src/chat/opencodeProtocol.ts) (readers, permission config; under test)
- [src/chat/piAgent.ts](src/chat/piAgent.ts) — Pi over its RPC mode, one process per conversation, with a gate extension for approvals; its leaf [piProtocol.ts](src/chat/piProtocol.ts) (events, gate rules, path normalisation; under test)
- [src/chat/voiceText.ts](src/chat/voiceText.ts) — voice messages as text: the helper's stdout read, the chip and the prompt line a transcript becomes (leaf, under test)
- [src/chat/voiceRecorder.ts](src/chat/voiceRecorder.ts) — one voice message: the helper process, its events, its file removed
- [native/voice/voice.swift](native/voice/voice.swift) — the voice helper: records from the microphone, transcribes on the device (macOS 26+); built into `bin/ai-browser-voice`
- [src/terminal/terminalHost.ts](src/terminal/terminalHost.ts) — the PTY layer of the terminal tabs: loading the staged node-pty, shell and environment, batched and flow-controlled output, the tail for a reloaded view (leaf, no `vscode`, under test)
- [src/chat/terminalTab.ts](src/chat/terminalTab.ts) — one terminal tab and the set of them: the process's lifetime, what was posted and not yet acknowledged, which one is in front (leaf, under test)
- [src/chat/terminalLogic.ts](src/chat/terminalLogic.ts) — limit, names, start folder, the editor's `terminal.integrated.*` settings, the safe font rule, paste sanitising, the terminal's text as chat context (leaf, under test)
- [scripts/stage-terminal.mjs](scripts/stage-terminal.mjs) — copies the part of node-pty that runs into `out/terminal/vendor/node-pty` (the last step of `build-ext`)
- [scripts/test-terminal.mjs](scripts/test-terminal.mjs) — a manual smoke test of the compiled host against the real staged node-pty
- [src/power/sleepProtocol.ts](src/power/sleepProtocol.ts) — the keep-awake choices and state (types and lists, read by both builds)
- [src/power/sleepControl.ts](src/power/sleepControl.ts) — one window's keep-awake choice (a timer, or until one tab's or every tab's agents finish), and its vote to the daemon
- [src/power/sleepDaemon.ts](src/power/sleepDaemon.ts) — the shared daemon holding the OS lock while any window votes for it

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
- [preview-src/chat.ts](preview-src/chat.ts) → `media/chat.js` — the chat view's script, a second webview with its own CSP (see [The AI Browser chat](#the-ai-browser-chat))
- [preview-src/terminalView.ts](preview-src/terminalView.ts) — the terminal tabs' xterm views, loaded by `chat.ts` with a dynamic `import()` behind `__TERMINAL__` (every build: editor, Chrome side panel, website); its pure parts are leaves under test: [terminalKeys.ts](preview-src/terminalKeys.ts) (which keys are the shell's), [terminalTheme.ts](preview-src/terminalTheme.ts) (colours, options, the safe font rule), [terminalFlow.ts](preview-src/terminalFlow.ts) (acknowledgements, replay ordering, early output), [terminalTabs.ts](preview-src/terminalTabs.ts) (the strip's terminal tabs and menu rules), [terminalPaste.ts](preview-src/terminalPaste.ts) (paste sanitising, input slices), [terminalCsp.ts](preview-src/terminalCsp.ts) (what xterm needs from the CSP)
- `@vscode/codicons/dist/codicon.css` → `media/codicon.css`
- `@xterm/xterm/css/xterm.css` → `media/xterm.css`, an entry of its own (see [esbuild](#esbuild))

`media/main.css`, `media/chat.css`, `media/chat-activity.svg` and `media/icon.png` are
checked-in static assets and are not built.
`media/index.js`, `media/chat.js`, `media/codicon.css`, `media/xterm.css` and their `.map` files are **build
artifacts and are gitignored**. After a fresh clone the panel stays blank until `npm run compile` has run.

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

`navigateTo()` in the webview appends a `vscodeBrowserReqId` query parameter to the URL. That
is a cache-busting hack — it was the only reliable way found to force the iframe to reload.
Upstream also appended the webview's own `id`, and that one is gone on purpose: it collides with
the page's parameter of the same name, so `/product?id=42` reached a last-value-wins server as
`id=<webview uuid>` (breaks-silently #198). Only a name of our own is safe to add.

## Build

There are **no production dependencies at all**, only devDependencies, and every one of them is a
build-time input. That includes the two things the terminal tabs run on, which is why they are
devDependencies and not `dependencies`:

- **`@xterm/xterm` and `@xterm/addon-fit`** are bundled into `media/chat.js` by esbuild (the editor
  build only — see [esbuild](#esbuild)).
- **`node-pty`** is native code and cannot be bundled. `scripts/stage-terminal.mjs`, the last step of
  `build-ext`, copies the part of it that runs (`lib/` and the four darwin and win32 prebuilds, 5.1 MB
  of the 62 MB it installs as) into `out/terminal/vendor/node-pty`, which is what ships, and
  `terminalHost` loads it from there. The VSIX has no `node_modules`: `vsce package
  --no-dependencies`. Under `dependencies` a bare `vsce ls` or `vsce package` would pack 305 raw
  `node_modules/node-pty` files — tests, sources, debug symbols, `spawn-helper` without its execute
  bit — beside the staged copy. `allowScripts` keeps the entry for `node-pty@1.1.0`, so `npm install`
  still builds it where there is no prebuild.

```
compile                  build-ext && build-webview            ← full build
watch                    run-p -l watch-ext watch-webview watch-typecheck-webview
build-ext                clean-ext && tsc --project ./tsconfig.json && node scripts/stage-terminal.mjs  ← src/ → out/, node-pty staged
clean-ext                removes out/: tsc never deletes stale outputs — which is why the stage step comes last
build-webview            node ./esbuild.webview.mts            ← preview-src/ → media/ (chat.js carries xterm, xterm.css beside it)
build-chrome             node ./scripts/build-chrome.mjs       ← the Chrome side panel; defines __TERMINAL__ true, ships xterm.css
watch-ext                tsc ... --watch
watch-webview            node ./esbuild.webview.mts --watch
watch-typecheck-webview  tsc --project ./preview-src/tsconfig.json --noEmit --watch
typecheck                run-p -l typecheck-ext typecheck-webview typecheck-tests
typecheck-ext            tsc --project ./tsconfig.json --noEmit
typecheck-webview        tsc --project ./preview-src/tsconfig.json --noEmit
typecheck-tests          tsc --project ./tsconfig.test.json    ← test files, no emit
test                     node --test "preview-src/**/*.test.ts" "src/**/*.test.ts"
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
  passed as a flag. Its `rootDir` is `..`, not `.`, because `chat.ts` reads the chat's message
  types from `../src/chat/chatProtocol.ts` with `import type` — the one file both runtimes share, and
  only as types, so esbuild erases it. Nothing is emitted from this project, so the wider root
  changes no output; with `.` the typecheck fails on the import.

### esbuild

[esbuild.webview.mts](esbuild.webview.mts) is self-contained and runs directly (Node executes
`.mts` natively, no transpile step). Its options are mostly mandatory and each is
non-obvious:

- `loader: { '.csv': 'text' }` — the chat imports `@vscode/codicons/dist/codicon.csv` as a string
  for its icon picker (declared in `preview-src/assets.d.ts`), so the picker lists exactly the
  icons the bundled font can draw. Not mandatory like the two below; without it the build fails
  loudly rather than silently.
- `format: 'iife'` — the script is loaded by a plain `<script src>` **without**
  `type="module"`. An ESM bundle simply will not execute in the panel.
- `loader: { '.ttf': 'dataurl' }` — otherwise the icons do not render, because the CSP only
  allows `font-src data:`.
- `define: { __TERMINAL__: 'true' }` — mandatory in every builder of `chat.ts`:
  all three builders define it `'true'` today — `scripts/build-chrome.mjs` (changed from `'false'`
  on 2026-10-27 at the user's request, so the side panel shows the editor's shared terminals) and
  `exchange-server/scripts/build-chat.mjs` each also ship `xterm.css` as an entry of its own, for the
  [remote terminals](#remote-terminals-on-the-exchange-website-and-in-chrome). The define is kept so
  a build can still leave terminals out: `chat.ts` uses it in one shape only, a bare positive
  `if (__TERMINAL__) { … }`, and that shape is the point: esbuild drops the branch when the constant
  is `false`, which keeps xterm (about 345 KB) out of such a bundle, but it does **not** fold a
  `typeof __TERMINAL__ !== 'undefined' &&` guard or an early return when not minifying — measured,
  xterm stayed in the unminified Chrome bundle back when it was `false`. A build with no define at all throws a `ReferenceError` as the script
  starts, and the chat is blank. `preview-src/terminalBuild.test.ts` checks that all three builders
  define it, that the terminal code is reached only through the guarded dynamic `import()` (no
  static value import), that `chat.ts` imports no CSS, and that Chrome's build and
  `sidepanel.html` carry `xterm.css` before `chat.css`. The side panel's CSP already allows
  `style-src 'unsafe-inline'`, so `terminalCsp.ts` runs there with no nonce and nothing else changes.
- **An entry of its own for xterm's stylesheet** (`xterm` → `media/xterm.css`, loaded by the
  view's `<link>` before `chat.css`). **Never `import '…/xterm.css'` from `chat.ts`:** esbuild then
  writes a `media/chat.css` for the `chat` entry, over the checked-in stylesheet that is not a build
  artifact. The two `.css` files are gitignored like `codicon.css`.

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
reason [src/setup/proposedApi.ts](src/setup/proposedApi.ts) reads `dataFolderName` instead of hard-coding
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
features looked broken. [src/setup/proposedApi.ts](src/setup/proposedApi.ts) decides and drives it,
[src/setup/argvJson.ts](src/setup/argvJson.ts) does the editing (leaf module, under test).

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
- **Only a clean `FileNotFound` is "no file yet".** `readArgv` answers `''` for that and
  `undefined` for any other failure, and on `undefined` the command refuses rather than writes.
  It used to answer `''` for everything, so one `EBUSY` from a virus scanner replaced the user's
  whole `argv.json` with our one key — and skipped the `.bak` too, since the backup is only taken
  of a non-empty source. Breaks-silently #156.
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
[src/setup/proposedApi.ts](src/setup/proposedApi.ts) is the only correct test, and every guard goes through
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

Every case above is in [src/setup/argvJson.test.ts](src/setup/argvJson.test.ts).

### The status bar: one permanent button, one that hides itself

[src/setup/statusBar.ts](src/setup/statusBar.ts) puts two items on the left, and they have different jobs.

**`$(globe) AI Browser` is permanent and opens a QuickPick.** It is not decoration: the dropdown
on the browser tab is gated on `activeEditor == 'workbench.editor.browser'`, so before this the
MCP commands had no home outside the command palette — the limitation recorded under
[The dropdown on the browser tab](#the-dropdown-on-the-browser-tab). The menu holds, in order:
*Open* (Open URL / Open File), *AI Browser Chat* (New chat / Chat in a new tab / Chat in a new window — the
three places the chat's own New Chat offers, through `aiBrowser.chat.newChat` with a location
argument; "here" reveals the side bar chat first, since a new tab in a hidden view reads as
nothing happening; left out below VS Code 1.106), *Page* (Translate page…, only while any browser tab is open — not
gated on focus: the row names the tab the command will take, and the command asks only when none
can be told apart), *Setup* (the enable entry
while it is relevant), *External agents — our MCP tools for their extensions and terminal CLIs* (Connect your
agent, Open Google Chrome for your agent, Check Connection: the two groups were asked for, so the
chat's own entries and the ones for outside agents read apart), *Logins and passkeys*, *Shared tabs*, then Settings. The
dropdown carries the same Translate entry as `2_translate`; the two are one list to a user, so a
change to one is a change to both.

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
`normalizeAddress` in [src/core/webUrl.ts](src/core/webUrl.ts) (leaf module, under test) supplies
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
[src/setup/proposedApi.ts](src/setup/proposedApi.ts) rather than in `extension.ts` — three callers need the
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
the compiled `out/setup/statusBar.js` against a stubbed `vscode` module and printing what each grant
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
go through `confirm()` in [src/core/notify.ts](src/core/notify.ts), which is
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
  `watchTabClose` in [src/elements/elementPicker.ts](src/elements/elementPicker.ts) cancels the token on
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
happen, and each is rare; a paused page is an acceptable price for not losing that. The refusal
in a **remote** window is not among them: there it is every press, so it goes through `refuse()`,
and the Add entries are hidden in the first place (`canHandOver`). The modal in
`enableBrowserApi` is the same call — it asks a question, and blocking is the point. **And a
toolbar skill's own notifications**, its result shown "In a notification" or its "Notify when it
ends": asked for, per skill, and the editor says beside both choices that a notification pauses a
browser tab on screen — see [The toolbar of skills](#the-toolbar-of-skills).

**The paste modal after Connect is a success that interrupts, and it is modal on purpose.** Translate
Page's "the prompt is on your clipboard" is the other, for the same reason, and "Copy Recording
Prompt for Claude Code / Codex" the third — it was a toast, which paused the tab it was pressed on.
Asked for explicitly: once the file is written and the prompt copied, the paste is the one step
left, and a status bar line was too easy to miss — the setup looked finished with nothing
checked. `askToPaste` in [src/mcp/mcpSetup.ts](src/mcp/mcpSetup.ts) shows "Paste into the Claude Code /
Codex chat to finish connecting to the browser." as `{ modal: true }`. A toast would stay up,
and keep the page behind it paused, until someone found and dismissed it; the modal goes with
the one click the user is making anyway. Keep it short: the details (the share, a leftover
duplicate, the Codex trust clause) stay in the status bar confirmation that goes up beside it.

**"Browser API not enabled" is not among them.** It was, and it kept the bug alive after the
progress notification was fixed: press an element command in an editor without the grant and the
refusal toast paused the very tab you were looking at. It now goes through `refuse()` to the
status bar, because in exactly that state the `Enable Browser API` button is already sitting
there — the toast added nothing but the pause. The lesson generalises: a refusal that the status
bar already offers a fix for does not need a notification at all.

**Nor are "No integrated browser tab is active" and the screenshot fall-backs.** The first is
reached with a browser tab visible in a split beside a focused file — `activeBrowserTab` is
`undefined` there, and the pause is geometric — so the toast paused the very page it told the
user to focus. The screenshot's "saved, but could not reach the clipboard" is not rare at all:
every press on a Linux box without `xclip`/`wl-copy` lands on it. Both go through `refuse()`, and
the screenshot's lost "Open" button is replaced by putting the file's path on the (text)
clipboard and in the message, since the text clipboard works when the image one does not.

**Except in a remote or web window, where the path is worse than nothing.** The file is on the
remote host and the text clipboard is the user's local one, so the path overwrote whatever they
had copied with something no local program can open — and that is the case that *always* falls
back. There the image is opened beside the page (`ViewColumn.Beside`, `preserveFocus`) through
the remote file system, which is what the old button did, and the clipboard is left alone.
Breaks-silently #169.

**And whatever does reach a notification body must not have been written by a page.** A body is
rendered as *linked text* and its links are opened with `allowCommands: true` — the mechanism
recorded under item 124 — so `[label](command:…)` anywhere in it is a button that runs a command
on one click. `versionShape` guards that sink for a value with a *shape*; a page title has none,
because the page chooses it outright, so `plainInNotification`
([src/core/notifyText.ts](src/core/notifyText.ts), leaf module, under test) neutralises it instead. It
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
[src/core/cdp.ts](src/core/cdp.ts):

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
Open New Browser Tab                                            0_start@1
Connect Claude Code                                             0_start@2
Connect Codex                                                   0_start@3
─────
Copy Element / CSS Path / CSS Path + Location / Element XPath   1_copy@1..4
─────
Record Video ▸                                                  2_recording@1   when !recordingActive
    Balanced · 1080p / High · 1440p / Maximum · 4K (* default)  1_quality@1..3
─────
Copy Screenshot (Visible Area) / (Full Page)                    2_shot@1..2
─────
Translate Page…                                                 2_translate@1
─────
Add Annotation Marker                                           2_annotations@1
Remove All Annotation Markers                                   2_annotations@2  when pageHasAnnotations
Copy Annotation Prompt                                          2_annotations@3  when pageHasAnnotations
─────
Claude Code ▸                                                   3_assistant@1
    Add Element / CSS Path / CSS Path + Location / XPath        1_add@1..4   when <a>Installed
    ─────
    Connect Claude Code                                         2_mcp@1
    Share Tab with Claude Code                                  2_mcp@2
    ─────
    Copy Recording Prompt for Claude Code                       2_recording
Codex ▸                                                         3_assistant@2
Gemini CLI ▸                                                    3_assistant@2.5
    Connect Gemini CLI / Share Tab with Gemini CLI              2_mcp@1..2
AI Browser Chat ▸                                               3_assistant@3   when !chatUnsupported && !chatBlocked
    Add Element / CSS Path / CSS Path + Location / XPath        1_add@1..4
    ─────
    Add Screenshot / Add Page Address                           2_page@1..2
    ─────
    Record Page to AI Browser Chat                              2_recording     when !recordingActive
Check Connection                                                3_assistant@4
─────
Logins and Passkeys ▸                                           3_logins@1
    Fill Saved Login (Cmd+Shift+L) / Save Login from Page        1_page@1..2
    ─────
    Manage Saved Logins and Passkeys / Import / Export          2_vault@1..3
─────
Share Tab with All Assistants                                   4_share@1
Stop Sharing Tab                                                4_share@2   when tabShared
```

That is twenty-one rows — eighteen before the annotation group. Beside the dropdown there is
exactly **one** more button, the repeat button of the last action — an element copy or Add
Annotation Marker. A standalone marker button (`navigation@3`) stood beside it for a while and
was removed on request: with a copy action remembered, the toolbar showed two extra buttons. While a recording runs, Pause / Resume
(`navigation@0`) and Stop (`navigation@0.1`) stand before the dropdown (`navigation@1`); see
[Browser video recording](#browser-video-recording). The menu had eighteen before the submenus, and a flat one would have
had twenty-one once the fourth element kind was added. The `group` prefixes put the
separators in; ordering comes from the `@n` suffix, not from the position in the
`contributes.menus` array —
the array is kept in the same order anyway, because a file that reads in a different order than
the menu renders is a trap for the next edit. `Stop Sharing Tab` is gated on the
`aiBrowser.tabShared` context key, republished from `extension.ts` on every share change, so it
is only there while there is something to stop.

**The `0_start` group duplicates the two Connect entries on purpose** — asked for, so that
connecting is one click from the tab rather than two levels deep. A command may sit in several
menus; the submenu copies stay because each submenu is the complete list for its assistant.
The dropdown only renders on a browser tab, so with the grant in place Connect from here always
shares that tab with the assistant being connected; without it `focusedTab` is `undefined`, the
connect goes ahead sharing nothing, and its confirmation says so — see
[Giving a tab to an assistant](#giving-a-tab-to-an-assistant).

**`Open New Browser Tab` is its own command (`aiBrowser.newTab`), not `aiBrowser.show` in the
menu.** An `editor/title` entry is handed the editor's resource as its first argument, so `show`
would receive the current page's Uri and open a second copy of it. `newTab` drops the argument
and runs `workbench.action.browser.open` with no URL — an empty tab with the browser's own address bar, the same thing its built-in
`workbench.action.browser.newTab` does.

**It asks for the open command and the setting, not for the grant**, and that is the one
deliberate departure from `shouldUseIntegratedBrowser()`. The entry is only reachable from a
built-in browser tab, so the browser is there by construction, and an empty tab needs no API.
Going through `aiBrowser.show` — which does require the grant — sent every fresh install, the
ungranted default, to a URL prompt and the webview panel from a row that says "New Browser Tab".
`aiBrowser.useIntegratedBrowser: false` is still honoured: whoever chose the panel gets the
panel. For the same reason the command is **hidden from the palette** (`commandPalette`,
`when: false`): on a panel host such as Cursor a palette title promising a new browser tab would
load the address into the one existing panel instead (breaks-silently #74). The status bar
menu's `Open URL…` is the palette-independent route to a page.

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

**"AI Browser Chat ▸" adds to our own chat** what the two assistant submenus hand to theirs —
asked for: the element, its CSS path, CSS path + location or XPath (the same report text the Add
entries write, `pickForChat` / `pathReportOf` in `elementPicker.ts`, shared with them), plus a
screenshot and the page address, as the chat's "+" menu attaches them. The pick runs on the tab
whose menu it was, **then** the chat is revealed and the chip lands in the chat tab in front, so
the page stays where the click is wanted. The submenu, its repeat buttons and the chord are gated
on `!aiBrowser.chatUnsupported && !aiBrowser.chatBlocked` — the second set wherever `chatBlocked()`
refuses (Restricted Mode, a remote window), cleared when the folder is trusted — and the button
falls back to its Copy twin there: a remembered chat action otherwise refused on every press
(#372, #223's shape). A path pick from the palette refuses a page that is not on screen, as the
element and screenshot entries do. **Its four
element entries are repeat-button actions like the assistants' Add entries**, a fourth
destination (asked for, after they first shipped without), drawn with the kind's crosshair: each records itself,
and `aiBrowser.repeat.chat.*` twins carry the primary button and the chord. Wherever the chat
cannot run the context key falls back to the Copy twin, as it does for an assistant that is not
installed. Screenshot and page address are not
repeat actions (see "Not part of the repeat button").

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
are the same list to a user. **Anything added later goes above them**, which is why the logins
submenu is `3_logins` and its status bar section sits before *Shared tabs*: it first went in
after them, as `5_logins`, in both menus at once — consistent with each other and against this
rule (breaks-silently #273).

The activity bar container that held these commands is gone. It was a `TreeDataProvider` in
`src/toolsView.ts`, and it went away when the same commands landed in this dropdown;
`media/activity-icon.svg` went with it. (The chat's container, `aiBrowserChat`, is in the *secondary* side bar and holds the chat
and nothing else — see [The AI Browser chat](#the-ai-browser-chat). Do not move these commands
into it.) One consequence worth knowing: the dropdown is gated on
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

**One crosshair per element kind, whatever the destination** —
`media/icons/crosshair-<dot>-<theme>.svg`, eight files:

| kind → dot |
|---|
| element: red `#E03131` |
| CSS path: blue `#1971C2` |
| CSS path + location: grape `#AE3EC9` |
| XPath: green `#2F9E44` |

Copy, Claude Code, Codex and the AI Browser chat share the kind's icon (asked for: the grid of
sixteen, with a ring colour per destination, was more variety than it was worth). The dot is
what tells the four kinds apart, so **no two kinds share a dot**, which `check-manifest`
asserts, together with every destination using its kind's icon. The trade-off, accepted: the
repeat button no longer shows *where* it sends — its tooltip, the command's title, does.

**`npm run check-manifest` guards all of this**, because none of it produces a compile error:
a menu item pointing at a missing command, a command with no activation event, an icon path
with a typo, an icon file nobody references, two primary buttons sharing a `lastElementAction`,
two kinds sharing a centre dot, a destination with an icon of its own, and a command with no `category` — a
command that only makes sense in a menu is hidden with `commandPalette` / `when: false` instead,
or the palette lists bare rows such as "Balanced · 1080p *". Run it after touching `package.json`
or `media/icons`.

**The primary button is a faked split button.** VS Code has the real thing —
`isSplitButton: { togglePrimaryAction: true }` on a submenu item, rendered by
`DropdownWithDefaultActionViewItem`, which even persists the last action under
`${submenu.id}_lastActionId` — and the built-in browser uses it for its own "Add to Chat"
button. Extensions cannot: `menusExtensionPoint.ts` builds an extension's submenu item as
`{ submenu, icon, title, group, order, when }` and never sets that flag, and the manifest
schema accepts only `submenu` / `when` / `group`.

So instead: **seventeen** primary buttons in `navigation@2` — the four copies plus the same four
for each assistant and for the AI Browser chat, and Add Annotation Marker ([Page annotations](#page-annotations)) — each with a `when` on the `aiBrowser.lastElementAction` context key, so
exactly one is ever visible. The dropdown sits *before* them in `navigation@1`. The Add buttons
carry the extra condition `aiBrowser.claudeInstalled` / `codexInstalled`, so a button never runs
into an assistant that is not there — **and the context key falls back to the Copy twin** while
the remembered action's assistant is absent (`claude:xpath` → `xpath`). The condition alone was
half of it: a remembered Add action with its assistant uninstalled, disabled, or simply not on
this machine (the memento is global) matched no button at all, so the toolbar showed a lone
chevron and the chord did nothing. The memento keeps the real choice, so reinstalling brings the
Add button back; `LastElementAction.refresh` runs on `extensions.onDidChange` (breaks-silently
#223).

The seventeen action ids (`element`, `cssPath`, `cssLocation`, `xpath`, `<destination>:<kind>` with the destination `claude`, `codex` or `chat`, and `annotate`)
are compared
verbatim in `when` clauses, which makes them **part of the manifest's contract** — renaming one
in `lastAction.ts` alone silently removes a button. Add commands use the crosshair of the
matching Copy command, so the button looks the same whichever destination it repeats. [src/elements/lastAction.ts](src/elements/lastAction.ts)
keeps the context key and a memento in step — the memento because a context key does not
survive a restart. Each command records itself before running, in `extension.ts`.

`onStartupFinished` is in `activationEvents` **for this to work at all**: `when` clauses are
evaluated before activation, so without it the context key is unset on a fresh window and the
toolbar shows a lone chevron with no primary button. Two visually adjacent buttons is as close
as an extension gets — they are not fused into one control the way Run/Debug is.

**One chord drives whichever tool is active:** `Ctrl+Alt+C` / `Cmd+Alt+C`. Since the seventeen
`when` conditions are mutually exclusive, exactly one binding can match, so the key always runs
what the right-hand icon shows.

**The chord sits on seventeen `repeat.*` delegate commands, not on the commands in the
dropdown**, and that split is not decorative. VS Code prints a command's keybinding beside
**every** menu item that invokes it, with no way to opt out — so binding the dropdown commands
directly put `Cmd+Alt+C` on every row of the menu. Each delegate shares its twin's icon and
title, is the one contributed to `editor/title`, and is hidden from the command palette with
`commandPalette` + `when: false` so the same seventeen actions do not appear twice there.

`check-manifest` holds this together: one chord across the seventeen, conditions matching the
buttons exactly, no dropdown command carrying *that* chord, no other command taking it on any
platform (compared per platform, not as a `key|mac` pair — #257), and every delegate mirroring its
twin's icon. The chord rules are scoped to the `repeat.*` bindings —
`Fill Saved Login` has a chord of its own (`Cmd+Shift+L`), and *wants* it printed beside its menu
row, since that is where people learn it. A drifted `when` would otherwise leave the key firing nothing, or two tools at
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

All in [src/elements/elementPicker.ts](src/elements/elementPicker.ts), all sharing `withPickedElement`:

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
(`locationSeparator` in [src/elements/reportFormat.ts](src/elements/reportFormat.ts)):

- It must not be legal inside either half, or the string cannot be split back apart. That stopped
  the bracketed suffix this started as — `… > input [page: http://localhost/a/b]` is *valid CSS
  attribute-selector syntax* at that position, so the tail reads as part of the chain to a
  person, to a model, and to anything that pastes the whole string into `querySelector`. It also
  stopped `>>` (Playwright's own chaining operator) and `page=… css=…`, where the key order
  becomes part of the contract because the selector contains spaces and so has to come last.
- It must carry **direction**. ` @ ` was the form before this one and it only works with the
  selector first — "input @ that page" — so putting the page first while keeping `@` would have
  said the opposite of what is meant. An arrow reads the same way the pair is consumed.
- **The spaces are part of the separator, and they keep it out of the *page* half only.** A URL
  carries no raw space, so the first ` → ` always falls between the two halves. They do **not**
  keep it out of the selector half, which this note claimed until review measured otherwise:
  `CSS.escape` writes a hex escape followed by a literal space — `\31 ` for a leading digit,
  `\a ` for a line break — and emits code points at or above U+0080 unchanged, so an id `1→`
  yields `#\31 →`, an arrow with a space on each side. The pair is split at the **first**
  separator, and the report's `Format:` line now says so; a split at the last one, or into more
  than two parts, is wrong. Tested in `reportFormat.test.ts`.

The cost, stated plainly: `→` is not ASCII, so it is not typeable on a plain keyboard and a
shell splitting on it needs the literal. That was judged acceptable because the consumer is a
chat message read by a model, not a pipeline — but ` -> ` is the same design in ASCII if that
ever stops being true.

Five consequences in the code:

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
- **The selector half carries its line-breaking characters as CSS escapes** (`withLocation`).
  `CSS.escape` leaves U+0080–U+009F, U+2028 and U+2029 as they are, and `inlineCode`'s `oneLine`
  then wrote them as the text `\uXXXX`, which CSS reads as a plain `u` — the copied pair stopped
  resolving. `\2028 ` is the same character to `querySelector` and leaves `oneLine` nothing to
  change (breaks-silently #316).
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
since a notification would pause the very tab being picked in. Only `cssLocation` refuses an
address-less frame: `css` and `xpath` travel with prose that does not claim their URL is a
navigation target. This is the rule already written down for `browser_snapshot` — never hand out
a selector that does not resolve with the call its consumer will make.

**The heading of a path report is labelled from `DOM.describeNode` alone** (`elementDescriptor`).
It came from `extractElementData`, which also asks for the box model and throws for an element
without one, such as an image-map `<area>` — so an Add whose path was already built and checked
failed with an error toast over the page, while its Copy twin worked. A failed read falls back
to `element`: a label is never worth losing the path over.

**And all three kinds refuse a path that does not resolve back to the element**, because the
builders now check it in the page — `querySelector` for CSS, `document.evaluate` for XPath — and
answer empty when neither the short path nor a strict positional one comes back to the picked
element; `buildPath` turns the empty answer into a refusal. The check is what caught three shapes
that went out wrong while reading as precise (breaks-silently #218):

- **Inline SVG and MathML.** An unprefixed XPath name test matches HTML elements only in an HTML
  document, so a step written `svg` or `path` matched nothing — every icon inside a button. Steps
  outside the XHTML namespace are written `*[local-name()=… and namespace-uri()=…]`; the CSS
  builder emits `CSS.escape(localName)`, which keeps the case a type selector compares against
  outside HTML (`foreignObject`) and escapes a dot in a custom element name (`my-el.v2`).
- **Shadow DOM with a colliding id.** Uniqueness was tested against the document, which a shadow
  tree is not part of, so a shadow `<input id="input">` got `#input` — and that selected the
  *light-DOM* input of the same id. "Resolves to nothing" was the accepted trade-off; "resolves to
  something else" is #21. A shadow element now gets no path at all, for every kind.
- **Quirks mode.** `#foo` is case-insensitive there and `[id="foo"]` is not, so the uniqueness
  test passed for an id that `#foo` shared with an earlier `id="Foo"`. Uniqueness is tested with
  the selector that is emitted.

**The page-side sources run in the page's own JavaScript world**, so a page that replaces
`JSON.stringify` chooses what they return. The document URL is therefore accepted only when it
serialises to itself and holds no control character (`isPlainAddress`); anything else falls back
to `tab.url`. An isolated world (`Page.createIsolatedWorld`) would close the forgery itself and
is not built: a page forging its own locator only misleads about itself.

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
not choose". `pendingPick` in [src/elements/elementPicker.ts](src/elements/elementPicker.ts) cancels any pick
already in flight, so the latest choice wins. Related: clearing inspect mode belongs in
`finally`, because on cancellation the `await` throws and a statement placed after it never
runs — leaving the page stranded in picking state.

**The Markdown format is a port, not an invention.** `renderElementMarkdown` follows
`createElementContextValue` / `formatElementPath` from `browserEditorChatFeatures.ts`, and
`extractElementData` follows `extractNodeData` from `browserViewFrameInspector.ts`. The CSS
section — matched rules, `/* Inherited */`, `/* Resolved values */`, `/* CSS variables */`, the
`/*UA*/` marker — is produced by [src/elements/cssHelpers.ts](src/elements/cssHelpers.ts), which is upstream code
copied **verbatim** (616 lines, zero imports). That is what keeps our output identical to the
built-in browser's. Its upstream test suite came along as `src/elements/cssHelpers.test.ts` and is its
specification; re-sync the two together rather than editing either in place.

The element itself is the **last** entry of `ancestors`, which is why `Element:` and the tail of
`HTML Path:` are always the same string.

### Element picker

`aiBrowser.copyElementXPath` ([src/elements/elementPicker.ts](src/elements/elementPicker.ts)) turns on
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
   [src/setup/proposedApi.ts](src/setup/proposedApi.ts) (proposal missing, or launched without the flag)
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
([src/mcp/mcpClientState.ts](src/mcp/mcpClientState.ts) owns the constant).

### Layers

```
MCP client (Claude Code / Codex / VS Code chat)
   │  HTTP POST, JSON-RPC 2.0, Bearer
   ▼
McpServer          src/mcp/mcpServer.ts       transport, auth, tool registry
   │  ▲ src/mcp/mcpProtocol.ts — dispatch and the auth decision, no vscode, under test
   ▼
BrowserController  src/browser/browserController.ts   what the browser can do
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

All four live in `authorizeRequest` in [src/mcp/mcpProtocol.ts](src/mcp/mcpProtocol.ts), away from
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
- **An `Mcp-Session-Id` the server never issued is 404**, per the spec, so a client carrying an
  id from before a window reload starts a new session instead of being silently treated as
  `other` (breaks-silently #178). The map survives a server restart from a setting change,
  because `McpLifecycle` owns it, so only a new extension host triggers this.
- **There is no per-tool timeout, and `Tool.slowMs` was removed rather than kept as decoration.**
  It was declared and set on the three slow tools, and read by nothing at all, so the comments
  claiming a bigger budget for them were simply false — the client's own timeout is the only one
  in play. Do not reintroduce the field without a consumer.
- **A cancelled call is cancelled here too.** `notifications/cancelled` names a request by its
  JSON-RPC id, and it used to be acknowledged with 202 and dropped — so after Esc in the
  assistant `browser_inspect_element` left the page in picking mode until its timeout, and the
  user's next click became a pick nobody was waiting for. `McpServer._calls` maps
  session and id to an `AbortController`, aborted by the notification or by the connection
  closing before the answer, and `Tool.run` gets the signal as its third argument. Only the two
  tools that wait on something outside the server take it: `inspectElement` and `waitFor`
  (breaks-silently #212).
- **`browser_wait_for` is polled from the host, one synchronous check per round, and survives the
  navigation it is usually waiting for.** It used to be one `Runtime.evaluate` running a loop in
  the page, and each problem that design had has its own number. A click that navigates destroyed
  the loop's document, and CDP's `Inspected target navigated or closed` went to the model (#311).
  A cancelled or timed-out call left the loop reading `innerText` every 100 ms, which needed a
  token to stop it (#311 again). Its deadline lived on the page's clock, which fake timers stop
  (#212). And it **slept on the page's own `setTimeout`**, which a document that runs no timers
  never fires. A frame sandboxed without `allow-scripts`, such as an HTML mail or document
  preview its parent writes into, answers an evaluate and resolves promises, yet ran the check
  once and never again: a false timeout over text on screen, and an evaluate left pending for
  the life of the frame (measured, Chrome 153; breaks-silently #331). Now each round is a short
  check, the pause between rounds is the host's `waitForPollMs`, and a round that meets a
  replaced document (`documentReplaced`: a navigation, a frame between documents or whose
  session ended) counts as "not yet". There, `document.body` can still be `null`, which also
  counts as "not yet" (#322). The deadline and the client's cancellation end the call even while
  a round is unanswered, so a page busy in a long task cannot keep the session hold. Nothing runs
  in the page between rounds, so there is nothing left to stop.
- **A model's text argument of the wrong type is refused, not read as absent** — `textArgument`.
  `stringOrUndefined` is right for an optional filter and was wrong for `browser_fill`'s `value`:
  `5` reached the page as `''`, cleared the field and answered "filled input". A finite number is
  converted, since that is what the model meant (breaks-silently #210). `numberArgument` is the
  same rule for a number whose absence *acts*: `browser_scroll`'s `by`. `numberOrUndefined` stays
  right only where absence means a harmless default, such as a timeout.
- `browser_navigate` refuses anything but http/https. Otherwise an agent points the browser at
  a local file and reads it back with `browser_text` — a browser tool turned into a file reader.

### Three clients, three places to configure

| Client | Where | How |
|---|---|---|
| VS Code chat | nowhere | `lm.registerMcpServerDefinitionProvider`, reached through a cast so `engines.vscode` need not move; **the `McpHttpServerDefinition` constructor is positional** — an options object does not work |
| Claude Code | `.mcp.json` in the project | `{ type, url, headers.Authorization }` |
| Codex | `.codex/config.toml` in the project, or `~/.codex/config.toml` | `[mcp_servers.<name>]` with inline `http_headers` |

**Connect Codex writes the project `.codex/config.toml`, and Connect is one click with no
dialog. This is settled — confirmed working end to end, and it is the approach.** Do not move
the write back to the global file; the reasoning that once sent it there is disproved below, and
the global file is now only ever read, repaired or pruned.

Both halves changed together and the second forced the first.

There used to be a modal with two or three buttons on it, asking questions whose answer never
varied — of course the file should be written, of course the prompt should be copied. Now the
click writes the file, copies the prompt and says what it did.

Dropping the dialog meant choosing *one* Codex file, and the choice went to the global
`~/.codex/config.toml` for a while on a claim that turned out to be false: that **a project
config is only loaded for projects Codex trusts** and that the desktop surface ignores it
outright ([openai/codex#13025](https://github.com/openai/codex/issues/13025)). The trust half is
real. The conclusion was not, and it was drawn from a single `mcp_server_count` reading.
Measured properly against the Codex VS Code extension: a project `.codex/config.toml` **is**
loaded — its bare `ai-browser` entry appears in Codex's own start log ten times in one day, from
sessions whose `cwd` is that project, right up to the minute the file was deleted. Confirmed
independently by the user.

What the global file cost, measured on the same machine: its entries are named per project and
only ever accumulate, so three had built up, two of them dead — one of those pointing at a port
another window had since taken, so it answered 401 on every Codex start. The project file has
one entry, lives with the project, and goes away with it.

Writing *both* is not an option, and it is now an active concern rather than a hypothetical:
Codex reads both files, and the two entries have different names, so Codex
would load both and list every tool twice. That is what `removeCodexGlobalEntry` exists for, and
it is why the connect path is a write *and* a deletion rather than a write alone.

**The confirmation goes through `confirm()`, not a notification** — connecting is very often
done with a browser tab open, and a success toast would pause exactly the page the user is
about to hand to an assistant. After it comes one short modal asking the user to paste
(`askToPaste`, see
[A notification pauses the built-in browser](#a-notification-pauses-the-built-in-browser)),
never a toast. Failures keep their notification: they are rare and they need attention. The `Copy CLI command` button is gone from the happy path; the CLI command is what
lands on the clipboard when writing the file *fails*.

The project entry uses the bare `ai-browser`, since a project file has only one project. The
per-project global name (`ai-browser-<slug>-<sha1[0:6]>`) still exists, because entries written
by earlier releases are still out there and the startup repair has to keep recognising them —
and because `removeCodexGlobalEntry` needs it to find the one it is taking out. Connect writes
the project file and then removes this workspace's global entry, so Codex is never left loading
both.

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

**It names the config file and forbids opening it, and an intermediate version got that
backwards.** For one revision the prompt opened with "read `~/.codex/config.toml` and find the
`<name>` entry", on the reasoning that the exact `[mcp_servers.<name>]` header is what a model
needs in order to rebuild the prefix its client mangled — see
[Nothing is named `browser_`](#nothing-is-named-browser_-and-the-prompt-said-it-was). That
reasoning is sound and the instruction still had to go, for something it never considered:
**those files hold credentials.** Every entry this extension writes carries
`Authorization = "Bearer <token>"`; the global Codex file accumulates one per project — three on
the machine where this was caught, two of them for *other* workspaces — and it is not only ours,
holding the user's whole personal configuration and any third-party MCP server's secrets beside
it. "Read this file" puts all of that into a model's context, a provider's logs and a
conversation history, to learn one string.

And it is a string we already hold: `entryName` is a parameter. Naming it outright gives the
model exactly what the read gave it with nothing else attached, so the prompt says
*"The MCP server is named `<name>` (it is already configured, in `<path>` — do not open or edit
that file)."* The path is there to locate the entry in a sentence, never as an instruction.

**And that path must be the file connect actually wrote.** Both are now inside the project —
`.mcp.json` for Claude Code, `.codex/config.toml` for Codex — so `configPath` is a relative name
the model can place in its own working directory, and neither points at a file full of other
projects' credentials. It is still passed by each connect path rather than guessed inside
`connectionPrompt`: the two writers are the only places that know which file was actually
written, and naming a file that was not is its own defect (item 146).

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
  instructions open with it, it touches no page, and it **is** counted as the caller picking the
  tab up — `state()` runs `_noteTabUse` on purpose, so a successful check turns the status bar
  from 🔗 to 🤖 and stops the menu advising a restart. It was first chosen for the opposite
  reason, that it did *not* count; that reading of 🤖 belonged to the title marker and went with
  it (breaks-silently #149).

**A `.mcp.json` that cannot be read or parsed is never overwritten.** `readClaudeConfig` returns
`{}` for absent, the object for parsed, and `undefined` for **either** unparsable **or
unreadable** — and on `undefined` the write is abandoned, because rewriting it would delete every
other MCP server the project has. The unreadable half was missing and the statement above was
simply false for it: a read error answered `{}`, so a transient failure on a committed,
team-shared file replaced it with our single entry and said it had succeeded. Both connect
writers go through `readConfig` for that reason; `writeCodexConfig` throws instead, which
`connectCodex` already reports with the `codex mcp add` fallback.

**Parsed is not enough: it has to be a config** (`parseClaudeConfig` in `mcpRepair.ts`, the one
check both writers use). A top-level array, or an `mcpServers` that is not an object, is refused
like a parse error. Connect took any parsed non-null value, so an array came back with
`mcpServers` set as a property `JSON.stringify` does not write, `[]` went to disk, and the command
said "Wrote .mcp.json" (#113); a string `mcpServers` was spread into index keys. The repair
refused the array at the top level and accepted one under `mcpServers`, where deleting our entry
left a `null` in its place.

One shared global name would let the second project overwrite the first, hence the hash — the
name is still minted, because entries written by earlier releases are still out there.
`codex mcp add` is still offered as a command for anyone who would rather not have a file
edited.

**Nothing writes the global file any more**, so the sentence that used to stand here — "the
global write is locked" — describes a path that is gone with `writeCodexGlobalConfig`. What
touches it now is `removeCodexGlobalEntry` and the startup repair, and **both take the same
lock**, derived from the URI so the two cannot diverge — see
[The port moves](#the-port-moves-and-the-config-remembers-the-old-one). The rule the old
sentence existed for is unchanged and still load-bearing: two lock names for one file is the
same as no lock (breaks-silently #16 and #106).

### The mini TOML parser

[src/mcp/codexToml.ts](src/mcp/codexToml.ts) is not a TOML parser — it is exactly as much of one as the
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

**And a dotted key may quote any segment or space its dots** — `http_headers."X-Trace.Id"`,
`"http_headers".Authorization`, `http_headers . Authorization` — which is how TOML spells a header
whose name is not a bare key. The pattern knew only the wholly quoted and the bare dotted forms,
so such a line was not a key of its table at all; a table *ending* in one had its range stop a
line early, and deleting or replacing the table left the line behind, attached to whatever table
came before it. Beside an inline `http_headers` that is TOML that does not parse, and the prune
runs unattended at window start against `~/.codex/config.toml`. `keyValue` and `tableHeader` now
take the full key-path grammar, and `canonicalPath` records one spelling: segments unquoted,
re-quoted only where a bare key cannot hold them (breaks-silently #207).

**`[[mcp_servers.<server>.x]]` belongs to its server too.** An array of tables under a server was
skipped as "some other table", so no deleter and no rename saw it; pruning the server left it,
and TOML *recreates* the parent from it — a urlless server, the shape items 26 and 152 removed
for ordinary sub-tables. Such blocks are entries with `arrayTable: true`, and a rename keeps
their double brackets. A fuzz of 11 304 valid configs through all three writers, checked with
Python's `tomllib`, found no output that fails to parse and no foreign server changed, where the
parser before this found 2 624 unparsable outputs.

**A backslash escapes only inside a basic string**, in `parseInlineTable` and `splitPair` as in
`scanLine`. `X-Path = 'C:\'` is a complete literal string; read as an escaped quote, the rest of
the inline table became one value, no `Authorization` was found, and the unattended repair added
a second one — TOML that does not parse, at every window start (breaks-silently #314).

**A single-segment table name keeps the quotes it needs** (`canonicalPath(raw, true)`), and
`rootTable` splits at the first dot *outside* quotes. Unquoted, `[mcp_servers."ai-browser.bak"]` —
a backup kept by hand — read as `ai-browser.bak`, a sub-table of our server: the repair renamed it
along with ours and Connect and the global prune deleted it. A single-segment *key* is still
unquoted, because every reader asks for the bare name (`"url"` is `url`). Rerun after this: the
fuzz harness from the review, 20 000 generated configs through repair, Connect and removal, still
found no output that fails to parse and no foreign server changed (breaks-silently #315). **The
check asks the same question** — `isSubTable` in `mcpClientState.ts`, `rootTable(name) !== name` —
or `Check Connection` skipped `"ai-browser.bak"` as a sub-table while the repair treated it as a
server: a duplicate Codex really loads went unreported, and an entry the repair claims as ours read
`none`.

**`code` versus `text`.** `scanLine` returns both, and the distinction is not cosmetic: `code`
has string contents removed and answers structural questions; `text` is the line minus a real
comment and is what values and quoted table names are parsed from. Using `code` for values
reads every setting as empty.

### Checking

[src/mcp/mcpCheck.ts](src/mcp/mcpCheck.ts) does both halves, because a listening server proves nothing:
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

**A window's first-choice port is derived from the folder URI** ([src/mcp/mcpPort.ts](src/mcp/mcpPort.ts)),
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

**And a line that is already right is not written out again, even in our own spelling.** The
repair used to replace the header, `http_headers` and every sub-table header on each run, so
`[mcp_servers.ai-browser] # managed`, `http_headers = {…} # rotated` and
`[mcp_servers.x.env_http_headers] # from 1Password` lost their comments, and the inline table its
spacing, on every port move — which changes none of those lines. A header is now rewritten only
when the name changes, `url` only when it is not ours, and `http_headers` only when the merge
would change what it means (`inlineHeadersStale`: the first authorization is not our token, or a
carried key is missing). A rewritten line keeps its indentation; a renamed header and a one-line
value keep their comment. No edit at all is `changed: false`, whatever the file's newlines.
Fuzzed (about 32 000 configs) against the previous build: identical TOML, identical `changed`,
and no comment lost on a table of ours.

Two smaller things fall out of it. **Every writer of `~/.codex/config.toml` is locked**
([src/core/fileLock.ts](src/core/fileLock.ts)) — the connect path's write used to be unlocked on the
reasoning that a button press cannot race itself, which stopped being true the moment every
window started repairing the same file on startup; a machine restoring a session opens them all
at once. That write is gone now (connect writes the project file), so the two that remain are
the repair and `removeCodexGlobalEntry`, and both take `codexGlobalLock()`. Losing the race is
not an error for the repair, since the next start repairs it — but it **is** something the
connect path has to report, because nothing runs it again on its own: see `GlobalEntryOutcome`.
And **`spliceCodexTables` lives in `mcpRepair.ts`** so the connect path and the repair path
share one implementation: two copies would be two chances to write TOML that does not parse.

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
`missingWorkspaceTokens` in [src/mcp/mcpSetup.ts](src/mcp/mcpSetup.ts) is where the proof is assembled.

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
  `codexRetiredTables` / `removeCodexTables` in [src/mcp/mcpRepair.ts](src/mcp/mcpRepair.ts) only ask which
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
[src/mcp/mcpRepair.test.ts](src/mcp/mcpRepair.test.ts) asserts the two agree on a table of cases; add
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
keeps its own id private. So `_tabIds` mints `tab-<rnd>-1`, `tab-<rnd>-2`, … (a few random
characters per window, see #298; examples below drop them) keyed on the tab *object*,
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

**`browser_fill` goes through the prototype's `value` setter, and a plain assignment is not
equivalent.** React replaces `value` on each controlled input with a setter that also updates its
own tracker of the last value; `el.value = x` goes through that, so the `input` event that
follows compares equal, `onChange` never runs, the next render restores the old value — and the
tool answered `filled input`. `HTMLInputElement.prototype`'s setter (and the `textarea` /
`select` ones) is the browser's own and leaves the tracker behind. Measured against React 19.2 in
the integrated browser: the old script left the state `[]` while reporting success, the new one
set it. The same change made the other shapes honest: a `select` with no such option and a
checkbox or radio (whose `value` is not whether it is ticked — `browser_click` is) are refused,
a contenteditable is filled with `insertText` so editors built on `beforeinput` see it, and a
value the field did not keep (`maxlength`, a `number` input) is reported rather than claimed.

**"Did not keep" means *unchanged*, not *different*.** The first version of that read-back
compared strictly and threw on any difference — after the events had fired — so a field that
*reshapes* its input (a phone mask turning `5551234` into `(555) 123-4`, an email input trimming
spaces, a colour input lowercasing) was reported as a failure on a form that was already filled,
and a model retrying it fired the handlers twice. It now fails only when the value is still what
it was before; a reshaped value is a success that says what the field now reads. And a
form-associated **custom element** (`sl-input`, `ion-input`, `md-outlined-text-field`) goes
through its own `value` setter, which is its contract: refusing anything that was not a native
field made those forms unfillable, since their inner input sits in a shadow root no selector can
reach. Both measured in the integrated browser, including a React-controlled masked input.
Breaks-silently #170.

**A field that emptied itself did not reshape anything.** A `number` input given `abc`, or a
`date` input given `12/31/2024`, sanitises its value to `''` — and when it had held something,
`''` was not "unchanged", so the tool answered "the field reformatted it and now reads "" over a
value the user had lost. A non-empty value that leaves the field empty is now a refusal that
names the format the input takes, and what the field held before is put back through the same
setter, with `input` and `change`. **Only for the types the browser sanitises to `''`** —
`number`, `date`, `datetime-local`, `month`, `week`, `time`. A text box that empties itself has
usually *taken* the value (a tag input turning `tag1,` into a chip), and refusing there put the
old text back over a fill the page had accepted. Measured in Chrome 153 (breaks-silently #312).

**Only a custom element takes the custom-element branch** — a tag with a hyphen. The branch
used to admit anything with a `value` property, and `<button>`, `<li>`, `<option>`, `<meter>`,
`<progress>`, `<data>` and `<output>` all have one, so a selector that missed the field by one
element answered "filled button" with nothing changed on screen. Measured in Chromium
(breaks-silently #210). And a **password** is never read back in the result or the refusal: the
field's value is the user's, not the page's.

One trap when testing it by hand: once anything has assigned through React's setter, its tracker
holds that value, so a correct fill of the *same* value afterwards reads as no change. Test on a
fresh page.

**`browser_snapshot` only ever hands out a selector that resolves back to the element it
describes**, checked in the page with the same `document.querySelector` call that `click` and
`fill` will make. Without that check the builder fell back to the bare tag name, so two
buttons with no `id` and no `name` were both reported as `button` — and since `querySelector`
returns the first match, an agent told to press Delete pressed Save, successfully and
silently. The order is unique `id`, then `tag[name=…]`, then a positional `:nth-of-type` path;
an element that cannot be addressed from `document` at all, such as one inside a shadow root,
is listed with no selector rather than with a wrong one.

**A field's value is never its label.** An input has no `innerText`, so the label chain used to
fall through to `el.value` and hand the model whatever the user had typed — a password included,
right beside `type: "password"`, measured in Chromium. Only a button-like input (`submit`,
`button`, `reset`) shows its value as its caption; any other field is listed with `filled: true`
and nothing of what it holds (breaks-silently #211).

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

### A chat owns the tabs its agent opens

Asked for: a tab an AI Browser chat's agent opens (`browser_navigate` with a new tab, or the
first page when none was open, from a caller with `chatId`) belongs to that chat
(`BrowserController._chatOwners`). Every other caller — another chat, Claude Code or Codex in a
terminal — does not see it in `browser_tabs`, is never resolved onto it (focused, last-used and
last-resort branches skip it), and is refused by `browser_select_tab` and by a `tabId` naming it
(`_ownedRefusal`). A tab the user opened has no owner and is free for everyone. The owning chat
works on its own tab before the one in front (`_resolveTab`), unless it pinned another. A user's
share outranks ownership, and the user's own commands carry no caller and are never refused.
The chat's **Access** composer tab lists every tab with Take / Make free (`tabAccess`, editor
only), who watches the conversation from Chrome or the website (`ChatStateSurfaces.watchers`,
the website's `viewerCount`), and its pinned terminals. Closing a chat tab frees its tabs
(`releaseChatTabs`); ownership is in memory and does not survive a reload. Not run inside VS Code
yet. The website's viewer count reaches the editor's Access tab only with the next state post.

### Giving a tab to an assistant

The user hands **one tab to one assistant**, and several assistants can be on the same tab.
`src/browser/shareRegistry.ts` owns the rules — a leaf with tests, no `vscode`, no CDP — and the
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

**The pause ends when the last browser tab closes.** It exists so an assistant does not drift
onto *another* page nobody chose for it, and with no page open there is nothing to drift onto —
so `_loseTab` calls `releasePaused()` once no tab is left, and the assistant follows whatever
tab is opened next. Without that, closing the only tab after a Connect (which shares it) left
`AI Browser $(debug-pause)` yellow in a window with no browser at all, until somebody found
Stop Sharing Tab. The closing tab is filtered out of `browserTabs` explicitly rather than
trusting the host to have dropped it before the event fires, and the lazy detector in
`_resolveForCaller` asks the registry again after `_loseTab` rather than assuming "paused".
Breaks-silently #173.

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

**Use means "this assistant has called something while holding the tab".** `_noteTabUse` runs
from `_requireTab`, and also from `state` and `tabs`, which resolve a tab without handing out a
session.

Those two used to be excluded, on the grounds that they answer without touching a page and a
marker lighting up on them would claim work on a tab nothing had opened. That was right while
the marker was a suffix in the page title, where 🤖 sat beside the site's own name and read as
"something is happening here". It is wrong now that the two states live in the status bar and
its menu ([Where a share is visible](#where-a-share-is-visible)), where the question they answer
is *"has this assistant picked the tools up, or does it need restarting?"* — and a
`browser_state` call settles that as conclusively as a click does. The connect prompt prescribes
exactly that call as the check, so with the old rule a check that **succeeded** still left 🔗 and
a menu row telling the user to restart a session that had just proved it works.

**Every `tools/call` is attributed, `other` when the client cannot be named.** The transport
passes `kind ?? 'other'`, and the fallback is the point: only `initialize` carries
`clientInfo.name`, so a client that does not echo the `Mcp-Session-Id` header back is anonymous
on every call after it. Gating attribution on a *recognised* client left the marker reading 🔗 —
"nobody has picked this up" — while that very client was driving the page, which is the one
thing the marker exists to tell apart.

**Moving a share is a transaction, and tool calls wait for it.** Sharing is several async steps
over the fields the tools read, and a call landing in the middle interfered with it in two ways
at once, both reproduced with a concurrent `browser_snapshot`:

- the call resolved the **new** tab, so `_sessionFor` dropped the session the transition was
  still using. While the marker existed this was the worse half — it stayed on the old tab with
  nothing able to remove it, since `stopSharing` only knows the current one. That half is gone
  with the marker ([Where a share is visible](#where-a-share-is-visible)); the dropped session
  still costs a console buffer;
- the call itself failed with `The browser session was replaced while it was opening` — an
  internal sentence handed to a model.

Three things fix it, and each covers a different part. (A fourth, `_clearIndicator`'s second route
to the page, went with the marker: it existed because a transition had page-side work to undo,
and `ShareIndicator.clear()` returned a boolean rather than covering its failure so that route
could be tried. Both symbols are deleted — do not go looking for them.)

- **`_transact` / `_settle`.** Transitions run in call order (two clicks on "Share this tab
  instead" cannot interleave), and every path that resolves a tab — `_withSession`, `navigate`,
  `capture`, `inspectElement`, `state`, `tabs`, `selectTab` — awaits `_settle()` first. Measured
  against a stubbed CDP channel: a snapshot fired during a switch now opens **no** extra session
  (one per tab) and answers on the new tab.
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

What is left in [src/browser/shareIndicator.ts](src/browser/shareIndicator.ts) is the reading half, and each
piece has its own reason to stay:

- `sharedMarker` / `inUseMarker`, because the status bar and the menu still show them;
- `stripMarkerFromHtml`, because `browser_html` serialises the page's own `<title>`, where such
  a suffix really does appear;
- `stripMarker` — but only usefully at the two sites that read `document.title` **in the page**.
  It matches a suffix, and the whole point of #147 is that `BrowserTab.title` carries ` (<url>)`
  *after* our glyphs, so on the nine sites fed that value it is a no-op wherever the host
  composes the string. Do not read its presence as protection for the legacy case;
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

**Usage belongs to the assignment, not to the tab.** It was a per-tab `_usedBy` cleared only
when the tab closed, so `stop` followed by a new `share` of the same tab to the same assistant —
typically done *because* its session lost the tools — read 🤖 "working" at once and hid the
restart hint. Each assignment now carries its own set, started empty by `share` and kept only
when the target is re-shared the tab it already holds (the no-op below). `noteUse` takes the
target the call resolved through, so only that assignment is marked. Breaks-silently #159.

**Re-sharing the tab that is already shared is still a no-op.** The toolbar entry sits in the
shared tab's own menu, so it is one click away, and clearing its usage there took the status bar
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


### Frames: reading inside an iframe

Every page tool used to read **the page document and nothing else**, and the document stops at
each `<iframe>`. The report that led here was Claude Code on a SharePoint page holding a OneNote
notebook: `browser_text` and `browser_snapshot` returned SharePoint's scripts and no interface,
`browser_text_segments` found only the notebook's title, and the assistant concluded — correctly,
for the tools it had — that the content was out of reach. OneNote renders inside a frame from
`*.officeapps.live.com`, loaded by a form POST, so the frame has no address that could be opened
on its own either.

`browser_frames` lists the frames, and `browser_text`, `browser_html`, `browser_snapshot`,
`browser_click`, `browser_fill`, `browser_wait_for` and the new `browser_scroll` take a `frameId`.
**Absent means the page itself**, and a call without it reads exactly what it read before. Two
results do change shape on a page that has frames: `browser_text` (whole page) and
`browser_snapshot` add `frames` and `framesNote`, see below.

**A frame from another site is a target of its own, and the editor serves it.** Site isolation
puts such a frame in its own renderer. Nothing sent to the page's session reaches it, and the
page's `Page.getFrameTree` does not even list it. It shows up in `Target.getTargets` as type
`iframe`, with `parentFrameId` naming its parent. The editor's CDP proxy registers every target
it discovers for a view and answers `Target.getTargets` and `Target.attachToTarget` for them; its
own element picker attaches to `iframe` targets the same way (read in the shipped `mainImpl.js`,
VS Code 1.141). So `TabSession._attachFrame` attaches on the tab's existing channel and enables
Runtime there, and that session's own frame tree supplies the frame and anything nested in it.

**A frame is addressed as a session plus a context, never as a context id alone.** Context ids
are numbered per session: the page and a frame in another process both start at 1 (measured,
Chrome 153). `_frameContexts` maps a frame id to `{ sessionId, contextId }` from
`Runtime.executionContextCreated` (default world only) on every session of the tab. It is
subscribed before `Runtime.enable` for the reason the console is: the enable replays the
contexts that already exist.

**The frame id is CDP's**, and it is the right id to hand out. It stays the same across a frame's
navigations, including a move between processes. Measured: a cross-site frame navigated to the
page's own site kept its id, its target went away, and the next call found it in the page's
tree. A stale context (`Cannot find context with specified id`) is looked up once more before a
call fails. A dead frame session is dropped as well, or `_attachFrame` would keep handing it
back.

**What happens while a frame moves on is where every defect in the first version was.** A
review found five, and four of them sat in this window:

- **Forget the record that failed, never whatever is there now** (`forgetFrame(frameId, stale)`).
  A call sent just before a navigation fails with the old context id. By the time the failure
  arrives, the new document's context has usually been recorded in its place. Deleting by frame
  id threw that one away, and nothing reports an existing context twice. Measured: a click on a
  link inside a frame followed by `browser_wait_for` timed out on a page that had finished
  loading long before.
- **A frame in the tree with no context is between documents, not gone.** `frameScope` waits up
  to `frameContextWaitMs` for the context. Failing that, it says "still loading" in words
  `documentReplaced` recognises, so the wait's retry keeps going. "No frame has the id" is
  reserved for a frame no longer listed at all.
- **An ended frame session settles what was sent to it** (`CDPClient.failSession`, from
  `Target.detachedFromTarget`). The browser drops commands bound for a session that detaches,
  and only the channel closing settled them. Measured: a frame from another site navigating back
  to the page's own site (a 3-D Secure redirect, an OAuth return) left `browser_wait_for`
  waiting out its whole timeout over text that was already there. Every other frame-scoped tool
  has no host-side deadline, so it would have hung with its session hold kept. The editor's
  proxy forwards to Electron's debugger and rejects nothing on detach either.
- **An attach that does not complete is detached** (`_detachFrame`). That covers an enable that
  times out and an attach reply that lands after its own timeout. A busy frame answers the attach
  and not the enable, so each listing attached again: three `browser_frames` calls left three
  live sessions on the frame, each carrying its console.

The editor's proxy answers a send to a frame session it has already dropped with `Session not
found: <id>`, so `frameContextGone` matches that too.

Smaller decisions:

- **The console stays the page's.** An attached frame has Runtime enabled and its messages
  arrive on the same channel, so `TabSession` compares the event's session id (`_fromPage`). An
  embedded widget's chatter would otherwise fill the 200-line buffer. Frames in the page's own
  process were already captured before this change and still are. `CDPClient.on` passes the
  session id for exactly this.
- **Discoverability is half the fix.** `browser_text` (whole page, no selector) and
  `browser_snapshot` without a `frameId` add `frames` and `framesNote` when the page has any.
  `frameHint` makes two calls and attaches to nothing. With no frames the result keeps its old
  shape, a plain string for `browser_text`. The server instructions carry one sentence too.
- **Attaching is bounded:** a listing connects at most `maxFrameSessions` (24) frames from other
  processes per tab, and each CDP step gets `frameAttachTimeoutMs`. A frame that could not be
  reached is still listed, with `readable: false`, and the note names the three reasons: still
  loading, not answering, or past the limit. **A frame named by id is connected even past the
  limit** (`frames(wanted)`). Otherwise the 25th frame of an ad-heavy page was reported as
  removed while `browser_frames` was listing it. So the limit bounds what one *listing* connects
  to, not what a tab holds: a frame named by id stays attached until its target goes. **Every
  listing walks the tree of every attached frame**, not only the ones it reached itself, or a
  frame nested inside a named frame past the limit was readable by an id no listing handed out
  (#332). `readable` is read from the recorded contexts, never assumed.
- **`browser_scroll`'s `by` and `to` are refused when malformed, and so is both at once.**
  Absent means "scroll by the default", so reading `"by": "-500"` or `"to": "end"` as absent
  scrolled *down* and answered success: #210 in a new tool. `numberArgument` (a leaf, tested) does
  for numbers what `textArgument` does for text: a plainly numeric string is converted, anything
  else refused. `scrollEdge` takes only an edge.
- **`browser_scroll` exists because a frame's first screen is all a screenshot shows.** With no
  selector it scrolls the document if the document scrolls, and otherwise the largest scrolling
  element: an application shell keeps its body fixed and scrolls a panel. It runs on
  `_onScrollGate`, or a full-page capture's scroll-to-top-and-back would undo it.
- **Every guard applies inside a frame unchanged:** `refuseValueProbe` on every selector,
  `redactSecretValues` on the markup, the secret-field rules in `browser_fill`. A frame is part
  of the tab the user shared. The rule already written for screenshots holds: sharing a tab is
  sharing what that tab can show.

Verified by loading the compiled controller against a stubbed `vscode` whose tab bridges to
headless Chrome 153, with `Target.getTargets` narrowed to that tab the way the proxy narrows it.
Tested this way: a same-origin `srcdoc` frame, a cross-site frame and a frame nested inside it;
`snapshot`, `click`, `fill` and redacted `html` in the cross-site frame; the value-probe refusal;
`scroll` finding an inner panel and reporting `atBottom`; `waitFor` for text inserted later; the
console without the frame's messages; a frame navigating within its site; and one moving into
the page's process. After the review, also: a click on a link in the frame followed at once by
`browser_wait_for`, which resolved when the slow next page arrived (about 800 ms, three runs); a
wait surviving the frame's move back to the page's site (469 ms, previously the full timeout); a
busy frame listed three times, leaving one live session instead of three; and 26 frames from
another site, 24 connected by the listing and the 25th read by its id. After the second review: a wait in a frame sandboxed without
`allow-scripts` found text its parent wrote in (about 1 s, previously a timeout); the deadline
held at deadline plus grace in a frame whose main thread was blocked; a cancellation ended a
wait in 402 ms; and a frame nested inside the 26th was listed and read once its parent had been
named. **Not measured inside VS Code itself.** The proxy reading above is from the
bundle, so check on a real OneNote or payment-form page after changing this.

**Not built:** `browser_inspect_element` and the Copy/Add Element commands still pick in the
page's own process only (`Overlay.setInspectMode` is per target). The translation tools do not
reach frames either, as their known limits say. There is no way to navigate a frame, on
purpose: `browser_navigate` refuses anything but http/https for the top page, and a frame
navigation would be a second door around that rule.

### The editor tools: `editor_*`

The server's agents work on code as much as on pages, and the editor is right beside the
browser. Five tools in [src/editor/editorTools.ts](src/editor/editorTools.ts), one `EditorTools`
per server instance:

| Tool | What it answers |
|---|---|
| `editor_context` | the active text editor — or, while a browser tab or the chat has focus, the one the user had last (`_last`, from `onDidChangeActiveTextEditor`), marked `focused: false` — with its cursor, the line it is on, the selection's text (cut at 20 000 characters), its errors and warnings, and the open files (the browser editor by its label, `tabGroups` having no input for it) |
| `editor_reveal` | opens a workspace file at a line or a range, selected, `preserveFocus` and as a preview |
| `editor_definition` | `vscode.executeDefinitionProvider` — what "Go to Definition" answers |
| `editor_references` | `vscode.executeReferenceProvider`, at most 100, with the total |
| `editor_symbols` | `vscode.executeWorkspaceSymbolProvider`, workspace files only, at most 100 |

Decisions, each with its reason:

- **A symbol is named by its text and its line, not by a column** (`symbolColumn`): a model
  counts columns badly and names reliably. A whole identifier wins over a substring
  (`userTab` in `userTabs`), and `occurrence` picks among repeats on one line. A symbol not on
  the line is refused with the line's text, so the model can correct itself.
- **Language features beat grep where it matters**: imports and re-exports, overloads, methods
  through an interface, two unrelated symbols of one name. `editor_symbols` exists because the
  other two need a starting position, and the model often has only a name.
- **A language that has never answered is asked again while it answers nothing**
  (`warmUpRetryMs`, up to ~25 s, the first call per language only). Measured in a fresh window:
  the TypeScript server answered its first definition request about 15 s after the file opened,
  and before that every provider returns an empty list — which read as "no definition". After a
  language has answered once, an empty answer is taken as it is.
- **Only workspace files**, resolved against each folder's own URI (so a remote window keeps
  its scheme) and, for local files, on real paths — a symlink leading out is refused. An agent's
  arguments can come from a page it read, and putting `~/.ssh/id_rsa` on screen during a screen
  share is a leak even with nothing written. Measured: `/etc/hosts` and `../../../../etc/hosts`
  refused. A definition or reference the language server finds *outside* (a library's `.d.ts`)
  is still reported by path, line and text — that text is public — marked `outsideWorkspace`.
  `editor_context` names an active file outside the workspace and reads nothing of it.
- **`editor_reveal` never covers the page being read.** When the active group shows a browser
  tab (`input === undefined`, the heuristic `browserTabVisible` uses), the file opens in another
  group showing a text editor, else beside. `preserveFocus`, so the user's typing is not taken.
- Every provider call is bounded (`providerTimeoutMs`, 20 s) with a sentence the model can act
  on. In the approval menu these tools are AI Browser's, as `mcp__ai-browser__*` always is.

Verified inside VS Code itself — an isolated instance (`--user-data-dir`, `--extensionTestsPath`
running the compiled module against this repository): the context with a selection, a definition
across files, three references (declaration, import, call), two symbols, a reveal, and the two
refusals above. Redo it that way after touching the module; `npm test` covers only `editorText`.

**Not built:** call hierarchy, hover/type information, rename, code actions. Hover would be the
next one worth having (a type without reading the file); rename and code actions change code,
which the agents already do through their own edit tools with the approval menu in front.

### The chat tools: `chat_*`

Asked for: the chat's state over MCP, and a few controls for its own agents — then, after
review, cut down to what is safe without machinery (asked for: "remove methods or limit what they
pass"). Seven tools in [src/mcp/chatTools.ts](src/mcp/chatTools.ts), answered by
`ChatViewProvider.mcpControl()` across every chat surface of the extension host:

| Tool | Who | What |
|---|---|---|
| `chat_state` | anyone with the token | every tab's status, agent, counts (agents, background skills, queued), whether its queue is paused, the keep-awake state; **title and last reply only for the caller's own tab** (`own: true`) |
| `chat_usage` | anyone | plan limits last reported per agent, credits; the caller's own context fill |
| `chat_agents` | the chat's own agents | their own tab's agents, newest first, at most 30, each with the **last paragraph it said, 600 characters at most** — never whole reports |
| `chat_keep_awake` | the chat's own agents | a timer (rounded up to the popup's choices), until the agents finish (`tab` = their own, or `window`), or off — **off for every surface** |
| `chat_pause` / `chat_resume` | the chat's own agents | hold or release **their own** tab's queue |
| `chat_stop_agent` | the chat's own agents | one running agent or background skill run **of their own tab** |

Decisions, each with its reason:

- **No tab id goes in or out.** An agent sees and acts on its own conversation only: stopping
  or pausing the one beside it is not something a card showing an opaque id lets the user
  judge, and other conversations' titles and replies are not the agent's to read.
- **"The chat's own agents" is a value minted in memory** (`src/core/chatCapability.ts`): the
  CLIs send it as `X-AI-Browser-Chat`, the server maps it back to a chat id. It used to be the
  chat id itself, which is in `workspaceState` and outlives the window, so any program could
  write the header. The value reaches a running Claude Code's `--mcp-config` file (0600), so it
  keeps out a caller with a token and no shell and a stale value from an earlier window — **not
  the user's own code with a shell**, which can `kill` a CLI anyway. Recording destinations
  (`caller.chatId`) go through the same mapping.
- **The four that act are their own approval category, "Chat control"** (`chatControlTools` in
  `agentProtocol.ts`, written twice, a test reading `chatTools.ts` holds the copies together),
  Ask unless set. Gemini's fallback recognises `chat_` names by the call id, and a Codex
  question whose tool name cannot be read is filed here too. **Claude Code is started with
  `--settings` holding `ask` rules for them**: its own rules run before it asks us, and a user's
  `allow` for `mcp__ai-browser` would otherwise run them with no card. An `ask` outranks an
  `allow` — measured on 2.1.301 with `--allowedTools`, and with `--setting-sources=user`.
- **Pause holds the queue; it stops nothing** (`ChatTab.pause`, `readyForQueued`). A CLI has no
  pause, only Stop, and Stop plus "continue" would cut a turn mid-work. The turn running goes to
  its end; nothing queued — messages, a skill's next prompts, a skill queued for after the turn
  — goes out, and ⌘Enter on an idle paused tab queues rather than sends. The hold is said above
  the queue with a **Resume** button (`queuePaused`, `resumeQueue`); a new conversation in the tab
  clears it. **A paused queue does not hold "until the agents finish"** awake, or it would hold
  the computer for good. Background runs already going are not held.
- **Keep-awake uses the `SleepControl` of the caller's surface**, since `working(tabId)` looks at
  its own tabs; `chat_state` names any other surface holding the computer (`alsoHeldBy`).
- **Text is cut by code point** (`capAt`): a lone surrogate is refused by Codex's JSON reader.

Verified: the category and the Gemini fallback under `npm test`; the compiled tools through
`dispatch` with a stubbed chat (reads and refusals for an outside caller, own-tab arguments, a
stray `tabId` ignored, the capability round trip). **Not run inside VS Code yet**: `mcpControl`
against live tabs, and the Resume row.

### Lifecycle

[src/mcp/mcpLifecycle.ts](src/mcp/mcpLifecycle.ts) keeps the server's disposables **apart from
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
and hand it over. [src/elements/assistants.ts](src/elements/assistants.ts) owns the mechanics,
[src/elements/reportFormat.ts](src/elements/reportFormat.ts) the text (leaf module, under test).

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

**In a remote window the hand-over is refused before anything is written** (`'remote'`, through
`workspaceIsRemoteFromHost()`), and the report goes to the clipboard with a message saying why.
This extension runs on the local machine there and both assistants on the remote (see
[Special cases](#special-cases-and-non-obvious-decisions)), so a report file is on the wrong
machine either way. The availability check cannot see that — `getExtension` and `getCommands`
answer for every host — and Codex's `chatgpt.addFileToThread` resolves without a word for a URI
that does not arrive as `file:`, so the user read "Sent to Codex" while nothing arrived and the
clipboard fallback never ran (breaks-silently #313). **The Add entries are hidden there too**:
`aiBrowser.<id>Installed` is published from `canHandOver`, which is false in such a window, so the
menu drops them and the repeat button falls back to its Copy twin (#223). The refusal itself goes
to the status bar — it would otherwise be a toast after every pick (#323). **Claude Code's are
hidden with no local folder open as well** (`canHandOver`, re-published on
`onDidChangeWorkspaceFolders`): its reports live in `<folder>/.ai-browser/`, so without one every
pick ended in the clipboard fallback (#458). **A press of the Copy twin standing in for such an
action records nothing** (`LastElementAction.record`'s `repeat`): the memento is global, and
recording `xpath` over `claude:xpath` from a folderless window took the Add button away from every
project window (#468).

`.ai-browser/` gets a `.gitignore` of `*` on first creation — these are drafts for one
conversation. Reports are swept after 5 hours, at most hourly **per directory** from the write
path plus once on activation — one shared timestamp let a Codex report's sweep of the temp
directory skip the next Claude report's sweep of `.ai-browser/`, so alternating left page content
there well past five hours (breaks-silently #220). **The sweep only touches a real directory and only our own file names**
(`element-*.md` and `chat-*.md`, regular files, `lstat`): the directory is inside somebody else's repository,
which can commit it as a symlink, and following one deleted files outside the workspace
(breaks-silently #174).

**Reports and screenshots are written exclusively, into a directory only this user can enter**
([src/core/safeFiles.ts](src/core/safeFiles.ts)). Two things were wrong with a plain `writeFile` into
`os.tmpdir()/ai-browser/…`, and both were reproduced:

- **`/tmp` is shared on Linux.** Another local user could create that predictable tree first and
  plant a symlink under an expected name, so the write followed it and overwrote any file the
  victim could write; and under `umask 022` each capture of a logged-in page was `0644`, readable
  by everybody. The private root is now **`~/.ai-browser`** (`privateRoot` in `safeFiles.ts`),
  created `0700` and accepted only as a real directory owned by this user with no group or other
  bits — otherwise a `mkdtemp` directory in the OS temp directory is used rather than a directory
  somebody else may own, **made once per process**: a fresh one per call put every file in a
  directory of its own, so the sweep never found anything to retire. The activation sweep looks
  the directory up with `existingPrivateTempDirectory`, which creates nothing and cannot reject —
  `cleanUpReports` is not awaited, and a throw from it was an unhandled rejection (#93).
- **Inside the root, files are grouped by project** (`projectTempDirectory`):
  `projects/<hash of the folder's full path>/{captures,reports,files}`, and `shared/…` for no
  project — screenshots, videos and voice captures in `captures`, reports in `reports`, pasted
  files in `files`, the Claude `--mcp-config` files in `shared/runtime/chat`, the isolated title,
  branch-name and commit-message requests in `shared/runtime`, and the cleanup panel's ownership
  records in `inventory`. The full table, and what is protected from cleanup, is in
  [docs/temporary-files.md](docs/temporary-files.md). The previous root, `ai-browser-<uid>` in
  the OS temp directory, is still read (`legacyPrivateTempDirectory`) so its old files can be
  swept and cleaned; nothing new is written there, and nothing is moved, so links already handed
  out stay valid.
- **Names carry `HHMMSS` and nothing finer**, so two reports on one element in the same second
  shared a path and the second replaced the file an assistant had already been handed.
  `writeExclusive` keeps the readable name and adds `-2`, `-3`, … on a collision; its `wx` open
  also refuses to follow a symlink at the name, and the file is `0600`.

The workspace `.ai-browser/` keeps its location — it is the user's own folder — but gets the
exclusive create for the collision half.

**Page content is always fenced with a fence longer than the longest backtick run inside it**
(`fenced` in `reportFormat.ts`). A page routinely contains backticks — a template literal in an
inline script, Markdown in a CMS preview — and a plain three-backtick fence closes early, after
which the rest of the report is read as Markdown.

### Copy Screenshot

Two dropdown entries — visible area and full page — in a group of their own (`2_shot`), which
is what puts a separator around them. Group names sort alphabetically, so the numeric prefixes
(`0_start`, `1_copy`, `2_annotations`, `2_recording`, `2_shot`, `2_translate`, `3_assistant`, `3_logins`, `4_share` at the
top level, `1_add`, `2_mcp` and `2_recording` inside each assistant's submenu, `1_add`, `2_page` and
`2_recording` inside the AI Browser Chat one) are the running order of the menu — see
[the dropdown](#the-dropdown-on-the-browser-tab) for the whole tree.

Capturing is one CDP call, but two arguments matter:

- **`captureBeyondViewport`** is stated, never left to the default, which has moved between
  Chromium versions. `false` is the visible area.
- For a full page an explicit **`clip`** is passed, sized from `Page.getLayoutMetrics`
  (`cssContentSize`). `captureBeyondViewport: true` on its own is what produces the familiar
  half-captured screenshot — the capture stays bounded by the viewport unless the region is
  spelled out.

The clip is capped at **16384 device pixels** a side: past roughly that Chromium cannot allocate
the texture and returns a wrong image rather than an error, so the capture is truthfully clipped
and the confirmation says so. **Device pixels, not DIP** — the output is the clip times the
device scale factor, since `scale` is 1. The cap was applied in DIP, so on a retina screen every
page taller than 8192 CSS px came back with each row past 16384 repeating the *top of the page*,
`clipped: false`, and "copied" in the status bar; measured in Chrome 153 with GPU compositing.
Width is capped the same way (breaks-silently #215).

**The clipboard is the hard half.** `vscode.env.clipboard` is text only; there is no image
clipboard in the extension API. [src/browser/clipboardImage.ts](src/browser/clipboardImage.ts) shells out, and
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

`execFile` with an argument array, never `exec`, so no shell is involved — **and the path is
never spliced into script text either**, because `osascript` and `powershell` are interpreters
of their own. It used to be pasted into a string literal of each, so a temp directory under a
Windows user called `O'Brien` made every copy a PowerShell parse error. AppleScript now receives
it as `argv` through `on run`, PowerShell as `$env:AI_BROWSER_PNG`; escaping is not a fix for
PowerShell, which also treats `‘` `’` as string delimiters. Verified on macOS with a path holding
both `'` and `"`. Breaks-silently #158. In a remote
or web window the attempt is skipped: the extension host's clipboard belongs to another machine.
Screenshots are swept after 24 hours. Where they are written, and why it is not the shared
`/tmp/ai-browser/`, is under [Handing reports to Claude Code and Codex](#handing-reports-to-claude-code-and-codex).

**`browser_screenshot` is *not* the same capture, and returning it as one was a real bug.** The
MCP tool used to hand over this PNG as `{ mimeType, base64 }` inside a **text** block, because
`dispatch` serialised every result that way. Claude Code counts a text result as tokens and
refuses anything past 25 000 (`MAX_MCP_OUTPUT_TOKENS`), so every full page and most retina
viewports failed with `result (2,454,717 characters across 4 lines) exceeds maximum allowed
tokens` — the four lines being our own pretty-printed JSON. And when one did fit, the model read
a string of base64, not a picture. So for the model it is three changes:

- **An `image` content block.** A tool returns `toolContent([...])` from
  [src/mcp/mcpProtocol.ts](src/mcp/mcpProtocol.ts) and `dispatch` hands the blocks over as they are;
  everything else still becomes one text block. Images are counted by the client in pixels,
  not by the length of their base64.
- **JPEG at quality 100, sized to what the model takes in unchanged**: about 1568 px on the long
  edge and 1.15 megapixels ([src/browser/screenshotFrames.ts](src/browser/screenshotFrames.ts), leaf module,
  under test). Tokens follow pixels (≈ w×h/750), so the quality only decides bytes and the
  5 MB per-image ceiling — measured at 1440×798 on 14 px text, 100 is about 750 KB a frame
  against 480 KB at 90. **100 was chosen knowingly, and the cost is the conversation, not the
  call:** every image stays in the history and the Messages API refuses a request over 32 MB, so
  at about 4.5 MB of base64 per full page, roughly seven full-page captures in one conversation
  stop it sending (about ten at 90). Lower `modelJpegQuality` or `maxFrames` if that bites.
- **Two coordinate conversions, both measured in Chrome, and both silent when wrong.** The clip
  is in **DIP**, not CSS pixels (`Page.Viewport` in the protocol), and DIP is CSS ×
  `cssVisualViewport.zoom` — so at 200% browser zoom a CSS rectangle passed as it is covered half
  the area at half the offset, and a scrolled viewport came back as the wrong part of the page.
  And `clip.scale` **multiplies with the device scale factor**: a 1280×800 clip at scale 1 is
  2560×1600 on a retina screen, and a capture with no `clip` at all comes back at device
  resolution. Output is CSS × scale × (DSF × zoom), so the scale is the wanted factor divided by
  that product.
- **That product is read from `Page.getLayoutMetrics`, never from `window.devicePixelRatio`**
  (`pixelRatios`). The page owns that property: a getter answering 0.001 asked for frames a
  thousand times too large, and one returning a promise that never settles held the capture —
  and its session hold — for good. The deprecated `visualViewport` is in device pixels and
  `cssVisualViewport` in CSS pixels, so their widths give it with no page script involved;
  without the deprecated half the DSF is taken as 1, which on a HiDPI screen makes a frame
  *larger* than planned — not smaller, as this note used to say — so it is a fallback to watch,
  unreached while Chrome reports both halves.
- **A full page is cut into frames from the top**, at most six (about 9 000 tokens), each as
  tall as the pixel budget allows at the page's width — 798 px for a 1440 px page. One image of
  the whole page would arrive as a strip the API scaled down too far to read, and past 8000 px a
  side the API refuses it outright. A trailing text block gives each frame's `y` and height in
  CSS pixels and `clipped: true` when the page goes on past the last frame.
- **It is captured once and cut here, not captured frame by frame**, and the first version did
  the latter. Every `captureBeyondViewport` capture makes the page lay itself out again —
  measured as one `resize` event per frame, seven for six frames — so a page that moves between
  captures came back as frames from different moments: reported as a slideshow whose canvas
  (drawn on `requestAnimationFrame`, which the editor all but stops while its window is in the
  background) still showed the previous slide under the next slide's text. One capture is one
  `resize` and one moment. The capture is PNG because PNG is the only format that can be
  decoded without a dependency — `zlib` is in Node — so [src/browser/pngDecode.ts](src/browser/pngDecode.ts)
  decodes it, each band is a slice of its rows (`rowsOf`, no copy), and
  [src/browser/jpegEncode.ts](src/browser/jpegEncode.ts) encodes each one. Both are leaf modules under test.
- **The JPEG encoder is written out, and matches Chromium's on purpose.** Handed on as PNG the
  frames were tiny for an interface and enormous for photographs (about 3.2 MB a frame on noise,
  25 MB of base64 for one full page), so they have to be JPEG. A first encoder with 4:4:4 and the
  Annex K example Huffman tables came out 1.4–2.7 times the size of Chromium's own JPEG at the
  same quality; the one that stayed does what libjpeg-turbo does — **4:2:0 chroma** and
  **Huffman tables built for each image** in a second pass (`jpeg_gen_optimal_table`). Measured
  against Chromium's JPEG 100 of the same frame: 494 vs 496 KB on text, 720 vs 733 KB on a
  photograph, 1353 vs 1355 KB on noise. Its pixels were checked by having Chrome decode every
  frame and comparing with the source PNG (PSNR 38–52 dB, 20 on noise, where 4:2:0 costs the
  same as it does in Chrome's own encoder). There is no decoder under `npm test`, so the unit
  tests pin the container — markers, byte stuffing, determinism — and the pixels are an end-to-end
  check: redo it after touching the encoder. Encoding is synchronous, tens of milliseconds a
  frame, so the controller yields between frames.
- **The page is scrolled to the top for the capture and back afterwards** (`_atTopOfPage`), for
  this tool and for the toolbar's Copy Screenshot (Full Page) alike. `captureBeyondViewport`
  renders the document from where it is scrolled to: measured on a page scrolled to 2500 px, a
  `position: sticky` header came back 2500 px down the image and a `position: fixed` badge at the
  bottom of that view — over the footer, in the case that was reported. From the top both sit
  where the page puts them when it opens. Each part of how it does that was a review finding:
  - **Serialised per tab** (`_scrollGates`). Two overlapping captures — an assistant's and a
    toolbar press — each read the scroll, and whichever restored first moved the page under the
    other's capture, or the second took the top for "where the user was" and left them there.
    Sessions and holds order nothing here. The wait for a previous capture is bounded
    (`scrollGateWaitMs`), so a page that stopped answering cannot queue every later capture.
    **A visible-area capture takes the gate too** (`_onScrollGate`): run during a full-page one
    it read the metrics with the page at the top, and returned the top of the page as "what the
    user sees" (breaks-silently #214).
  - **The scroll is read in the coordinates `scrollTo` takes** (`scrollPosition`).
    `cssLayoutViewport.pageX` counts from the document's left edge, while `scrollTo` counts from
    the scroll origin — the *right* edge on a right-to-left page, negative going left. So an RTL
    page wider than the window read as scrolled when it was at its start, every full-page capture
    carried a false "could not be scrolled to the top" note, and a user at `scrollX -1000` was put
    back at 0. `cssVisualViewport.pageX` minus its pinch-zoom `offsetX` is in scroll-origin
    coordinates; measured in Chrome 153 for both directions (breaks-silently #214).
  - **The scroll is checked, not assumed.** It goes through `evaluate`, which reads
    `exceptionDetails` (breaks-silently #48), and is bounded, since `send` has no timeout. A
    replaced `window.scrollTo` falls back to `Element.prototype.scrollTo` on the document
    scroller; whether the page is at the top is then read from the layout metrics, and if it is
    not the capture goes ahead with a `note` saying sticky elements may be misplaced.
  - **`behavior: 'instant'`**, or a page with `scroll-behavior: smooth` animates and the
    capture lands mid-scroll.
  - **Put back as soon as the PNG is in hand**, before decoding and encoding, which take longer
    than the capture: measured, the restore lands about 140 ms before the tool answers.
  - **Put back only on the same document** — the main frame's `loaderId`, read before and
    after. A navigation that raced the capture should open at its own top. **Known and not
    handled:** a page that loads content *above* when scrolled to the top (a chat history) is
    restored to the same offset, which is then a different place.
  - A page already at the top is not touched, and the metrics read to find that out are the ones
    the capture uses.
  Verified against the compiled controller driving a real Chrome over CDP, with a stubbed
  `vscode`: concurrent agent and toolbar captures both had the header at the top and the page
  ended at 2500; a page whose `window.scrollTo` throws was captured from the top too.
- **The visible area's clip starts where the document says, not where `scrollTo` would**
  (`visibleOrigin`). The clip is in document coordinates; `cssVisualViewport.pageX` is in
  scroll-origin coordinates, which is right for `scrollTo` and wrong here. On a right-to-left page
  wider than the window, opened at its start, visual `pageX` reads 0 and layout `pageX` 2720
  (Chrome 153, 4000 px page), and a clip at 0 came back white — handed to the model as the visible
  area. Layout `pageX` plus the pinch-zoom `offsetX` is the document position in both directions,
  and equals visual `pageX` left to right; checked with striped pages in both. Breaks-silently
  #310.
- **The bands are laid onto the image Chromium returned, not onto the plan** (`fitBands`).
  Under a fractional zoom or device ratio its output can round a pixel the other way, which made
  a band drift, report a width the JPEG did not have, or ask for rows past the end. **A band
  that rounds to no rows is folded into the one before**: a 1920 × 898 page scales into frames of
  897 CSS px and the 898th rounds to nothing, which failed the whole screenshot.
- **Decoding yields.** `inflate` runs on the threadpool and unfiltering hands the extension host
  back every 4 MB, so a capture tens of megabytes deep does not stall every other tool call and
  extension in that host. Encoding yields between frames.
- **No page size, no full page**: where the metrics carry no `cssContentSize` the tool returns
  the visible area with a `note`, rather than failing; the toolbar capture keeps its old
  `contentSize` fallback.
- **The single capture is not bound by the 16 384 px texture ceiling** the toolbar capture
  below is clipped at: a 9 408 px tall capture at DSF 3 — 28 000 device pixels — came back with
  the right content in every band, checked by colour bands that encode the offset. The output is
  at most six frames tall, and its scale is already the model's, not the device's.
- **The page is measured again after the capture**, because scrolling to the top can make a
  lazily built page load more. A change is reported as a `note`, and `clipped` is judged against
  the larger height.

Measured end to end on a 1440 × 14 060 page at DSF 2: the old full-page PNG was 10 million
base64 characters; now one capture of ~290 ms and six frames encoded in ~200 ms, text at about
500 KB a frame. The toolbar's Copy Screenshot keeps the full-resolution PNG in one piece —
`capture` for the user, `captureFrames` for the model, which goes through `_withSession` like
every other tool. The toolbar capture's clip had the zoom bug too (#202) and now multiplies by
`cssVisualViewport.zoom` as well.

**Not decided here: what the page shows in the background.** A canvas animated on
`requestAnimationFrame` paints next to nothing while the editor window is behind another one, so
the capture shows whatever it painted last; text driven by timers moves on regardless. One
capture keeps the frames consistent with *each other*, not with a page that is not drawing.
Bringing the tab to the front (`Page.bringToFront`) would take focus from the user, so it is not
done.

**Not part of the repeat button.** The seventeen `navigation@2` candidates are element actions and Add Annotation Marker; a
screenshot picks nothing, so folding it in would mean a button with no crosshair and a hole in
the icon grid `check-manifest` enforces.

### Google Chrome, with no extension

Asked for as "the simplest way": the same `browser_*` tools drive Google Chrome, for every
assistant on the MCP server (the chat's, Claude Code's, Codex's, Gemini's). No Chrome extension,
no native messaging — Chrome's own DevTools WebSocket, which is the browser-level channel
`CDPClient` was written for. The chat's globe button asks where to open: VS Code browser or
Google Chrome; `aiBrowser.openInChrome` (palette, optional URL) does the second.

- **Which Chrome** (`ChromeBrowser._connect`): the user's own when remote debugging is on at
  `chrome://inspect/#remote-debugging` — Chrome then writes `DevToolsActivePort` into its profile
  folder, read for the port and the browser path — else a Chrome started by us with
  `--remote-debugging-port=0 --user-data-dir=~/.ai-browser/chrome-profile`. Chrome 136+ refuses
  the port flag on the default profile, so ours has its own logins. Refused in a remote window.
- **Each tab is a `vscode.BrowserTab`** (`ChromeTab`) and each CDP session a WebSocket of its own
  to the browser endpoint, scoped to the tab (`ChromeCDPSession`): `Target.getTargets` lists that
  tab's page and **only the frame targets inside it** — an `iframe` whose `parentFrameId` is a
  frame of the page's tree or of a frame already admitted, grown until nothing changes — and
  `Target.attachToTarget` refuses anything else; `setDiscoverTargets` / `setAutoAttach` on the
  browser channel are refused outright. The first version listed every `iframe` in the browser,
  so an assistant given one tab could list and read the payment and sign-in frames of the user's
  other tabs (review finding; measured after the fix with two tabs, each with a cross-site frame:
  each lists its own, attaching the other's is refused). The trees are read with questions of the
  session's own (ids from 2 000 000 000, never passed on), so `attachToPage`, the frames and
  everything above them run unchanged.
- **`tabSource` replaces `vscode.window.browserTabs` / `activeBrowserTab` / `openBrowserTab` and
  the four events in `BrowserController` and the chat**, and `tabSource.available()` replaces
  `isBrowserApiGranted()` there: the grant, or a connected Chrome. **"Active" is the focused
  built-in tab only**: CDP reports no focus, and a Chrome tab standing in as active outranked the
  built-in tab the user last had in front for every later call (review finding). A Chrome tab
  opened through us fires `onDidChangeActive`, and the controller records it as `_lastTab`, the
  tab the user last turned to. `navigate(newTab)` opens in the browser the caller was already in.
  A Chrome tab counts as on screen (`onScreen`), being a window of its own.
- **The status bar menu has "Open Google Chrome for your agent"**, beside "Connect your agent" —
  one row each, the agent (Claude Code, Codex, Gemini CLI) picked in a second QuickPick (asked for:
  three rows apiece made the Assistants section the longest in the menu). Asked for first,
  under *Assistants*): `aiBrowser.openChromeForAssistant` (not in `contributes.commands`; only the
  menu runs it) opens a Chrome tab and puts a prompt on the clipboard naming it by our tab id, with
  a `browser_select_tab` call to fix the tools on it, behind the paste modal.
- **No Chrome installed** (`ChromeNotInstalledError`) is a warning with **Install Google Chrome**,
  which opens `https://www.google.com/chrome/` — asked for. A notification, because it is a
  decision (see [A notification pauses the built-in browser](#a-notification-pauses-the-built-in-browser)).
- **The last-resort tab is a built-in one** (`_resolveTab`): with nothing shared, selected or
  focused, a Chrome tab is never picked by being listed last — an attached Chrome lists the user's
  own pages, and the tools would land on their mail. A Chrome tab is reached by selection, share,
  or being opened through us (`_lastTab`).
- **A Chrome of ours that does not answer is not launched over** (`profileInUse`, its
  `SingletonLock` naming a live pid): a second launch hands its arguments to the first and exits,
  and the deleted port file never came back. The socket is retried once with a longer wait first.
  `closeTab` with Chrome gone drops the tab instead of starting Chrome to close it.
- **Not converted yet**: the element and screenshot commands of the editor toolbar, logins,
  translate's tab picker and the login status bar still read `vscode.window` directly,
  so they see the built-in browser only. The MCP tools see both.
- Verified: the compiled module against headless Chrome 153 with a stubbed `vscode` — a tab
  opened, read through `CDPClient.attachToPage`, captured, closed and dropped from the list.
  **Not run inside VS Code yet.**

### Browser video recording

A silent video of a browser tab's viewport, with no OS screen capture: CDP `Page.startScreencast`
supplies frames, and the chat view's webview encodes them with `MediaRecorder`
(`ChatViewProvider.createRecordingEncoder`; MP4 where the editor has it, else WebM). The encoder
sends the video back in chunks of about a second, each acknowledged by the host, and
[src/browser/recording.ts](src/browser/recording.ts) writes them to the file. One recording per
window, on the tab it started on: focus moving elsewhere or a tool pin does not move it, and a
share that takes the tab away from the assistant stops it. **The encoder lives in the chat view**,
so nothing can be recorded where the chat cannot run.

- **Where it is.** While a recording runs, the browser tab's toolbar shows Pause / Resume at
  `navigation@0` and Stop at `navigation@0.1`, gated on `aiBrowser.recordingState` (`idle`,
  `starting`, `recording`, `paused`, `stopping`). The dropdown has "Record Video ▸"
  (`aiBrowser.recordingMenu`, `2_recording@1`, hidden while `aiBrowser.recordingActive`) listing
  the three quality presets. The Claude Code and Codex submenus have "Copy Recording Prompt for …"
  (`2_recording`): a prompt on the clipboard telling the assistant how to use the
  `browser_recording_*` tools, behind a modal like Connect's paste prompt. The AI Browser Chat
  submenu has "Record Page to AI Browser Chat".
- **Quality** ([src/browser/recordingQuality.ts](src/browser/recordingQuality.ts)): Balanced
  1080p / 6 Mbps, High 1440p / 12 Mbps (the default), Maximum 4K / 24 Mbps. The default is
  `globalState` `aiBrowser.recording.quality`, set in the chat's settings and published as
  `aiBrowser.recordingQuality`. **Each preset is two commands** (`…` and `…Default`, the latter's
  title marked `*`), swapped by that key, since a menu title is static. A preset picked from the
  menu applies to that recording only. The six are hidden from the palette.
- **MCP:** `browser_recording_start` (`destination` `chat` or `clipboard`; `chat` by default for
  the chat's own agents, `clipboard` for others), then `browser_recording_pause` / `_resume` /
  `_stop` / `_status` with the id the start returned, scoped to the MCP session that started it.
  No video bytes are returned, only metadata and the file path.
- **Limits, and both keep the video:** a maximum length set in Chat Settings → Video recording
  (`aiBrowser.recording.maxSeconds` in `globalState`, read through `readRecordingSeconds`: 5 min by
  default, 10 s to 1 h, active time only — pauses do not count), and a size limit that follows
  from it (`recordingByteLimit`: the preset's bitrate for that long, half again for a busy page,
  never below 256 MB — a fixed 256 MB stopped a High recording at under three minutes whatever
  the length said). Both are taken at start, like the quality, and `maxSeconds` is in the result
  the MCP tools return. The view refuses a length out of range (not saved, the reason shown);
  the host clamps what it is sent anyway. Either limit goes through `_limit`, which stops the
  recording as Stop does and sets `limitReached`
  (`'duration'` or `'size'`). **The size limit used to throw in the chunk handler into `_fail`,
  which deletes the file** — everything recorded was lost at about 170 s of a busy page at the
  default 12 Mbps. The stop is now asked for at least 16 MB, or four chunks, before the limit, so
  the encoder's final flush still fits; a chunk that would still cross 256 MB is acknowledged and
  dropped with every chunk after it (a file that ends early plays, one with a gap does not), and
  `durationSeconds` is clamped to where the cut fell.
- **The last 30 seconds are announced, never with a toast** (`recordingWarningSeconds`, `_warn`
  on the second's tick): the Stop button on the browser tab blinks red — a toolbar icon is static,
  so it is two commands, `aiBrowser.recording.stop` and `aiBrowser.recording.stopEnding` (a red
  square, `media/icons/stop-ending-*.svg`, hidden from the palette), swapped by the
  `aiBrowser.recordingEnding` context key every second — and the status bar counts down
  "Recording stops in N s". Paused, the clock stands still and so does the warning; a stop, a
  limit or a failure clears both (`_quiet`, from `_release`).
- **Delivery** is decided at start, never at stop: `chat` adds a video chip to the draft of the
  chat tab chosen at start; `clipboard` copies the file path. **The confirmation is the status
  bar** (`confirm()`) — it used to be a toast over the page just recorded, which paused it (#10).
  A toast with "Open video" / "Save as…" comes only when neither delivery worked, since then
  nothing else leads to the file.
- **Files** go in `~/.ai-browser/projects/<id>/captures/<uuid>.mp4|webm`, or `shared/` with no
  project, `0600`, recorded for the cleanup panel; kept until cleaned there. A failed recording
  removes its file.
- **Failures** (encoder lost, an acknowledgement error, an encoder error) are an error
  notification. A tab closed, or its CDP session closed, while the recording is still `starting`
  is a quiet cancel — it used to read "Browser recording failed: Recording is still starting.".
  The user commands go through `userRecording` in `extension.ts`: an error the recording already
  reported (`recordingErrorReported`) is not reported again — VS Code otherwise adds its generic
  "command failed" toast (#194) — and a refusal made before any recording existed goes to the
  status bar.

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

## Page annotations

**Add Annotation Marker** (`aiBrowser.annotatePage`, in the extension dropdown, and the toolbar's
repeat button once it is the last action) starts a one-element picker in the user's browser tab; Escape cancels. There is no
toolbar inside the page. Notes collapse to numbered circles. Their compact header contains
number, tag, copy (the whole annotation: note, element, selector and page —
`annotationClipboardText`; it copied the bare selector, which read as doing nothing), delete and add-marker ("+", starts picking another element; the note
collapses) icons, followed only by a text area. There is no collapse button: Escape and focus
leaving the note collapse it. Clicking the
number opens a ten-color palette; the stored color applies to the marker and card border.
Deletion from the icon requires a native VS Code confirmation; cancellation leaves host and page
unchanged. A note that is empty once trimmed is deleted without the question (asked for). MCP removal is a separate explicit tool action and does not open this user dialog.
Copy goes through the host clipboard; renderer requests must identify a stored annotation, not arbitrary
clipboard text. Creation requires trusted input events; no page text is used as HTML.

`PageAnnotations` owns a dedicated CDP channel per annotated tab. It uses a named isolated world
and filters binding events by session and execution context. `annotationScript.ts` draws a closed
Shadow DOM overlay, tracks scroll/layout, and excludes editable/form/script text from element
snippets. `annotationData.ts` bounds and validates renderer data (50 notes per URL, 2000 characters
per note). Host records are keyed by exact URL within a tab and restored after reload/SPA return;
they last until the tab or extension window closes, without disk persistence in this first version.
Numbers increase per tab and never shift when another note is removed. A live element reference
is retained while connected; only unique strong locators with matching tag/text may reattach.
After a reload a strong locator reattaches when it finds one element of the recorded tag; a
positional path also needs the same text (#509). What still does not resolve stays explicitly
unresolved (amber markers, stacked at the top right).

MCP tools `browser_annotations_add` (a CSS selector, a note, a colour name; checked by
`refuseValueProbe` like every selector tool), `browser_annotations_list` (offset/limit, maximum 10 notes per page),
`browser_annotations_get` (stable IDs, any URL of the tab), `browser_annotations_remove` (stable IDs), and `browser_annotations_clear` operate on the current
URL, through the existing named-tab/caller-sharing restrictions. Saved element context is marked
as untrusted page data and kept separate from note text. Inner iframe/shadow-root element picking
is not supported in this version. Reload initialization, closing during setup, invalid bindings,
clipboard isolation, editing, numbering, and removal have focused tests.

**A new annotation is attached to the AI Browser chat tab in front and bound to it** (asked for).
`PageAnnotations.onDidChange` reports each store change with the ids `created` and `removed`
(plain listeners, not an `EventEmitter`, so `pageAnnotations.test.ts` needs no vscode runtime);
`ChatViewProvider._onAnnotations` attaches a `kind: 'annotation'` chip (`comment` icon) to
`_active` for every created id and records the binding in `_annotationLinks`. Details:

- **The chip follows the note**: the page sends `change` on every keystroke, and the chip's label
  and text are rebuilt in place, keeping its `@N` (`preserveAttachmentReference`), as live page
  chips are. A click opens the whole text — note, element, ID — as a plain-text tab (#371).
- **Closing the chat tab deletes its annotations** (`_dropAnnotationsOf`, run from `_removeTab`:
  the × on the tab and deleting a chat from the history). The binding outlives the chip:
  removing it with × does not unbind it.
- **Sending a message deletes the annotations attached to it** (asked for:
  `_removeSentAnnotations`, after `ChatTab.send` reports the agent took it). `AgentSession.send`
  resolves whether the message reached the agent: both backends give a message up *without
  throwing* when the session is disposed or stopped before any turn begins — a Stop, Clear or
  the view closing during a cold Codex start — and reading only "did it throw" deleted the notes
  of a message no agent ever saw, the chat keeping just their 120-character labels (review
  finding). A failed or abandoned send keeps the markers. `browser_annotations_get`'s description
  says the same, rather than telling an agent to fetch a chat-attached annotation by its ID. The message carries the
  note and the element, so the marker has done its job; the store's `removed` then takes the
  chips other chat tabs hold and drops the links. The chip's prompt text says so and no longer
  points at `browser_annotations_get`, which would find nothing for an annotation already gone. `removeEverywhere` takes them off
  the overlay when on the page in front and out of the store for pages the tab has left.
- **An annotation deleted on the page, by MCP, or with its browser tab removes the chip**
  (`removed`; `close(tab)` reports every stored record as removed).
- Only ids *new to the store* are attached — a hydrate after navigation sends no `change`, and a
  `change` that merely edits never re-attaches. Nothing is attached while the chat is blocked.
- **The chat's "+" has *Add annotation…*** (`kind: 'annotation'` in `_makeAttachment`): it
  refuses a page not on screen, attaches every note already stored for the page in front to the
  chat tab it was pressed in (`annotationsOf` → `_attachAnnotation`, one chip per tab, skipped
  where that tab has one), then starts the picker; the new note arrives through `_onAnnotations`.
  An annotation can therefore have chips in several chat tabs (`chipIds`); only the first tab to
  take it binds it, and only closing that tab deletes it — or sending any message that carries one
  of its chips, from whichever tab (see the sending bullet above).
- **Add Annotation Marker is a repeatable action of the toolbar's primary button**: `annotate` in
  `ElementActionId`, the seventeenth `navigation@2` candidate, with an `aiBrowser.repeat.annotate`
  twin carrying the `Cmd+Alt+C` chord. Both carry `media/icons/marker-{light,dark}.svg` — a
  map pin in the theme grey holding the overlay's blue marker — a light/dark pair like the
  crosshairs, so it reads as a toolbar action of the same family (asked for). It has no button of its own: the toolbar carries one repeat button beside the
  dropdown, never two (asked for — a standalone `navigation@3` marker button was removed). It is no element pick, so it is outside the crosshair grid; `check-manifest`
  checks only its twin, chord and condition.
- **Review fixes, each a rule:** an assistant's marker is skipped by "+" too (`agentMade` is
  checked in `_attachAnnotation`, not only in `_fire`), so no chat tab binds or deletes it;
  `list` / `get` carry `author: "user" | "assistant"` and say an assistant's note is not the
  user's instruction, as does Copy Annotation Prompt — a page-misled agent could otherwise plant
  instructions for the next one; closing the owning chat tab takes the annotation's chips out of
  every other tab before its link goes (`_dropAnnotationsOf`), since the store's later "removed"
  finds no link; Add Annotation Marker refuses a page that is not on screen
  (`BrowserController.onScreen`, #355) and names the page in its confirmation; Remove All names
  the page and address in its modal (#259); Copy Annotation Prompt runs inside
  `McpLifecycle.withServer` and refuses a remote window, like Translate Page (#225).
- **An assistant's marker is not the user's note** (`browser_annotations_add`): its id is minted
  host-side and put in `agentMade` before the page reports the change, so `_fire` leaves it out of
  `created` and the chat attaches nothing and binds nothing — closing a chat tab never deletes it.
  The page script answers `{ error }` rather than throwing, since `_evaluate` would replace a
  thrown message with a generic one.
- **The dropdown's annotation group** (`2_annotations`): Add Annotation Marker, then — only while
  `aiBrowser.pageHasAnnotations` — Remove All Annotation Markers (a modal asks first; the page in
  front only) and Copy Annotation Prompt (the notes handed to an assistant by tab id, like
  Translate Page's prompt, behind the paste modal). The key is republished on every store change
  and on `onDidChangeActiveBrowserTab`; `PageAnnotations` fires a change with nothing created or
  removed when the tab moves to another URL (`_fireUrl`), or the key would describe the page
  before.
- **A note collapses when focus leaves it** — to the page, to VS Code, or the window losing focus
  (`focusout`, then `shadow.activeElement` and `document.hasFocus()` a tick later, since focus
  moving between the note's own controls also fires it). The number button keeps its colour on
  hover (`.head .number:hover`); the header's grey hover is for the icon buttons.
- `browser_annotations_get` (ids, optional `tabId`) returns records by ID from **any** URL the
  tab has shown, with each one's `url` and the IDs it did not find.

## Translating a page through an assistant

`Translate Page…` sits in the browser tab's dropdown (`2_translate`) and in the status bar menu
under *Page* while any browser tab is open. It asks for a language, puts a prompt on the
clipboard, and says so in a modal; the user pastes the prompt into whichever assistant has the
MCP server, and the assistant translates through three tools — `browser_text_segments`,
`browser_replace_text`, `browser_restore_text`. The assistant *is* the translator: there is no
translation service and nothing to configure. The same three tools serve any other bulk rewrite
an assistant is asked for — new copy, long labels for a layout check, masked data before a
screenshot — and the README says so; only translation has a ready-made prompt.

**It runs inside `McpLifecycle.withServer` and refuses a remote window**, the same two gates as
Connect: with the server off, failed or starting, and in a window whose folder is remote from this
extension host (#225), the prompt could only produce "I have no ai-browser tools".

**Why a prompt on the clipboard, and not a button that just translates.** An MCP server cannot
start work in a client: tools are called by the model. The one server-to-client request that asks
a model for text, `sampling/createMessage`, needs a stream back to the client, and this server is
POST-only with no SSE (see [Why there is no SDK](#why-there-is-no-sdk)); nor does every assistant
answer it. The paste is the step a user takes anyway to talk to an assistant. Electron also ships
no browser translator of its own to fall back on.

**The confirmation is a modal, like `askToPaste` after Connect, and asked for the same way** — a
toast would stay up over the page and pause it
([A notification pauses the built-in browser](#a-notification-pauses-the-built-in-browser)),
while a modal goes with the one click the user makes anyway. It names the page and the language.

**Which tab.** `BrowserController.userTab`: the focused tab, else the one the user last had in
front of them while it is still open, else the only one; only with several open and none ever
focused does a picker ask. "Last had in front" is `_userFocus`, kept by
`onDidChangeActiveBrowserTab` — **not `_lastTab`**, which is written only when a tool resolves a tab
and so can name a page the user left long ago, or one its last-resort branch picked with nobody
looking. The same rule as `LoginWatcher.userTab` (#259), and on the same condition that made it
acceptable there: **the choice is named before anything happens** — in the status bar row, in the
language picker's title and in the modal — so it is never a silent guess.

**The prompt names the tab by our id, and the tools take it per call** (`tabId` on all three).
By the time the prompt is pasted focus is in the assistant's chat, so "whichever tab is in front
of the user" may be another page. The first version told the model to `browser_select_tab` it,
and that pin outlives the request: the assistant stopped following the user for the rest of its
session because of one translation. `_withNamedTab` acts on the named tab for that call only. A
share still outranks it — an assistant given one tab is refused another, in words that say so —
and the prompt says to report a tab refusal and stop rather than carry on with whatever tab the
tools would otherwise use. **Tab ids carry a few random characters per window** (`tab-k3f-2`):
counted from 1 alone, `tab-1` meant another page after a reload and in every other window, so a
prompt pasted late or into another window's assistant translated some other open tab, and the
"closed or reloaded" refusal could not fire. `tabId` and `language` are read with
`textArgument`, so a wrong type is refused rather than read as absent (#210) — absent means "the
usual tab", which is exactly the wrong page.

**Which language.** A QuickPick ordered by `orderLanguages`: the last three choices
(`aiBrowser.translate.recentLanguages` in `globalState`), then VS Code's own display language, then
two dozen common ones, then *Other language…*. **The last choice comes before the editor
language on purpose** — many people run VS Code in English whatever they read in, so the editor
language first proposes translating an English page into English. *Other* is free text, since the
model understands any spelling of a language name; it has `ignoreFocusOut` and refuses an empty
value (breaks-silently #79, #80), and refuses line breaks, backticks and brackets, because the
name is written into the prompt. A listed language carries its BCP 47 code into the prompt; a
typed one asks the model for the code. **`language` is required on every
`browser_text_segments` call**, and a different one from the page's current translation puts the
page back first — otherwise the old dictionary answers for every string and a second language
finds nothing to do. It was optional once, and a run made without it could never notice the
language changing.

**The prompt** (`translationPrompt`) is one short paragraph of setup and three numbered steps,
and every clause answers a failure recorded elsewhere: tools named by suffix with a prefix
expected (#144); the page title through `plainInPrompt` (#154) and `pageTitle`, which drops the
` (<url>)` the host appends to `BrowserTab.title` (#147) — without it the address was printed
twice; `segments: []` for a batch with nothing to translate (see below); page text declared data,
not instructions; "do not add or edit any MCP configuration" (#13); and a one-line reply, so the
chat is not filled with the translation the page already shows.

### The page side

[src/translate/translateScript.ts](src/translate/translateScript.ts) is an expression that installs the translator on
`window[Symbol.for('aiBrowser.translate.v4')]` on first use and returns it; every tool call is
one `Runtime.evaluate` of `<source>.segments(…)` / `.replace(…)` / `.restore()`. The version in
the key moves whenever the page API changes shape, so a page still holding an older build's
translator gets a fresh one rather than a call it does not understand. It runs in the page's own
world, like every other tool: the page can see and break it — spoil its own translation, or, like
any page against any tool here, stall the evaluation.

- **A segment is a distinct string, not a node.** Twenty "Cancel" buttons are one segment,
  translated once and written into all twenty, and into the twenty-first a list renders later.
  Whitespace inside is collapsed for the key and the node's own leading and trailing whitespace
  is kept around the translation — **except where the page lays text out with `white-space: pre`,
  `pre-wrap`, `pre-line` or `break-spaces`**, where line breaks stay in the key, so the model sees
  them and the page keeps them.
- **Only `Text.data` and attribute values are written, never the DOM's shape.** Google Translate
  wraps text in `<font>` elements, and React apps then fail with `Failed to execute
  'removeChild'`, because React holds references to its own text nodes. Writing `data` leaves
  every node where React put it (#290).
- **The observer re-applies the dictionary, and gives up on a node the page keeps reverting.** A
  page with its own MutationObserver that undoes outside edits — tamper protection, a typography
  fixer — and ours rewrote each other in microtasks for ever, freezing the tab and every later
  tool call to it (#300). A node rewritten more than three times in a second is left as the page
  wants it (`givenUp`). And a change equal to our text once whitespace is collapsed — a page that
  turns spaces into nbsp after us — is adopted as ours rather than read as a revert.
- **Every write re-checks that the node may be written, at the moment of writing, and every
  control of that is observed.** What was eligible when a batch was handed out can stop being so
  before its answer arrives (#296). The observer watches `contenteditable`, `translate`, a
  `notranslate` class (by its old value, so ordinary class churn costs nothing) and an option's
  `value`: a subtree that stops being writable is **put back on the spot** — a heading made
  editable must not hand our translation to the editor's save — and one that becomes writable
  gets the existing dictionary at once and its new strings in the next batch (#301). Watching
  only the four translated attributes left both directions unnoticed.
- **The index is rebuilt, never appended to.** The first batch walks the page and indexes every
  string with the nodes carrying it (`WeakRef`s); later batches read it, and a write touches only
  the nodes of the strings it accepted. For a string with no translation the observer only raises
  a flag, and the next batch walks again (#297). Exclusion facts (`verbatim`, `refused`, `editor`,
  line-keeping) are cached for every element on the way up, for one operation at a time.
  **`observedRoots` is a `WeakSet`**: as a `Set` it held every shadow root a component page ever
  discarded, 12 009 DOM nodes against 9 after five rounds of 400 rows (#302).
- **A batch is settled by the write that answers it, not by being handed out.** The loop is "ask,
  translate, write, ask again". A batch nobody answered is offered again; once a write answers any
  id of the batch, the ids it left out count as deliberately untranslated (`skipped`) (#292).
  **An empty `segments` answers a batch too** — a page already in the target language, a batch of
  brand names (#295). The default budget is 8 000 characters — Claude Code refuses a tool result
  past 25 000 tokens, and a CJK character is a token or more.
- **Text that keeps changing is not offered.** An element the observer has seen show a third
  untranslated string — "Updated 4 seconds ago", a ticker, a chat — is live text, counted as
  `changing` and left alone. Offering each new value made the prompt's "until nothing is left"
  loop endless on any page with a clock on it, and grew every map by one entry a round (#303).
- **One string longer than `maxSingleSegment` (12 000) is not offered** and is counted as
  `tooLong`; `maxReplacementLength` is 30 000, room for its translation to grow.
- **A correction is applied.** Sending a new translation for a segment already translated walks
  the page, so every node showing the old translation takes the new one.
- **A translation is recognised wherever it turns up** (`reverse`, translation → source): a
  carousel's clone of a translated slide carries our text without our record, and is ours rather
  than new source text. **Unless that text is itself a source string of the page** (`isSource`:
  handed out, translated or indexed). Masking "Alice Smith" as "Bob Jones" on a page that also
  shows "Bob Jones" left the real one recognised as ours: answered, never written, never offered
  again, and `restore` turned it into "Alice Smith" (#304). A copy of our text that equals a
  source string is read as that source — the cheap direction.
- **Each start-over is a new document id.** A different target language, or `restore`, puts the
  page back and bumps the generation in `documentId`, so an answer still on its way for the
  previous run is refused (#299); an answer naming a different language from the current run is
  refused too. A reload or navigation makes a new translator altogether.
- **What is never translated**: `script`/`style`/`template`/iframes/canvas/math subtrees; text in
  `code`, `pre`, `kbd`, `samp`, `var` and `textarea`; **anything inside an editing host, text and
  attributes alike** — found by walking up for `contenteditable` other than `false`, so the
  `contenteditable="false"` islands editors use for mentions and embeds are inside it too
  (`isContentEditable` is false there, and checking it alone translated a mention chip into the
  HTML the editor saves, #305), and everything while `document.designMode` is on; anything under
  `translate="no"` or `.notranslate`, the keyword compared without case (the nearest `translate`
  attribute wins, so `yes` inside `no` is translated); strings with no letter in them; comments.
  **Tags are compared by `localName`, upper-cased** (#293). **And nothing a form submits**: input
  values are never read, and text anywhere inside an `<option>` with no `value` is skipped (#291).
  Attributes translated are `placeholder`, `title`, `alt` and `aria-label`.
- **`<html lang>` is set to the target language** and put back by `restore`; `pageLanguage` in
  the segments result reports the page's own, not ours.
- **`restore` puts back every node carrying our record, whatever it is now** — an option that lost
  its value, an element made editable or put under `designMode` without a mutation to tell us —
  since the record proves we wrote it. Checking eligibility first skipped exactly those, and the
  translation stayed in what the form or editor submits (#306). Copies of our text with no record
  are recognised only where we may write. It walks the page rather than keeping a list of what it
  wrote.

Measured against Chrome 153 headless over CDP with fixture pages: every inclusion and exclusion
above (mention chips in an editor among them); an unanswered batch offered again; a left-out
segment and an empty answer both settling; a delayed write refused for an option that lost its
value and a heading made editable; those two put back on the spot, and translated again when the
attribute goes; `translate="no"` removed bringing existing translations and new segments; a
correction; a pre-wrap block keeping its break; a cloned slide; a reinserted node; no index growth
over 5 000 page updates; discarded shadow roots collected; a page reverting our edits settling
after 4 reverts with the tab responsive, an nbsp normaliser after 1; a live clock ending the loop;
masking with a translation equal to another source string; a second language putting the page
back; late and wrong-language answers refused; `restore` after `designMode` putting every node and
`lang` back. Worth redoing that way after touching the script; there is no DOM under `npm test`.

**Known limits, not handled:** inline markup splits a sentence into segments
(`Sign in to your <b>account</b> now.` is three), so the model translates fragments in document
order rather than whole sentences — placeholders for inline tags, as CAT tools do, would fix it
and need the translation split back across nodes. A node detached while `restore` runs and put
back afterwards keeps its translation, since the observer is gone by then. A shadow root a custom
element attaches after the first walk is not seen until something under it changes. A node the
page legitimately rewrites more than three times a second with strings we have translations for
is given up on too. Same-origin iframes, cross-origin iframes (another CDP target) and closed
shadow roots are not reached. Text in images and canvas is not text.

## Saved logins and passkeys

The browser saves usernames and passwords, fills them back, and holds passkeys. Everything is in
VS Code's SecretStorage; nothing is drawn into a page; no MCP tool returns a password value — see
[Keeping password values from the assistants](#keeping-password-values-from-the-assistants) for
exactly what that covers and what it cannot.

**An independent review of the first version found sixteen defects, one of them the failure this
feature exists to prevent** (a wrong password offered as an update). The rules below are the
corrected ones; breaks-silently #237–#258 record each mistake.

**A second round — five review passes and an outside review — found about thirty more, and that
same failure came back through four new doors:** a link clicked after typing a password, a
sign-in POST that ended on the browser's network error page, a sign-up form the server rejected
and drew again, and an offer the extension had already withdrawn whose open picker still wrote.
#259–#289 record that round. Read the outcome table below as a list of things that *also happen
on failure*; every row was once taken for success.

```
page (isolated world)            loginFormScript.ts — finds fields, captures submissions, fills
page (main world)                passkeyGate.ts — asks before navigator.credentials runs
   │  Runtime.bindingCalled          ▲ Runtime.callFunctionOn
   ▼                                 │
LoginWatcher / WatchedTab        loginWatcher.ts — one CDP session per recent tab, a virtual authenticator
   ▼
LoginsFeature                    logins.ts — status bar item, pickers, offers, export/import
   ▼
LoginVault → SecretStorage       loginVault.ts, rules in vaultData.ts
```

### Where the code came from, and the one MPL file

Asked for: "find a Chrome extension that does this, read its source, use it". The obvious ones
cannot be used, because **this project is MIT and they are GPL** — Bitwarden (GPL-3.0),
KeePassXC-Browser and Proton Pass (GPL-3.0), Kee and Passbolt (AGPL). Copying any of their code
would relicense the extension. So two sources were split by what their licence allows:

- **Bitwarden was studied for behaviour only**, at `bitwarden/clients@a6ffbe65`: when it offers to
  save, when to update, how it fills, how it gates passkeys. Its rules are reimplemented in
  prose-to-code, and none of its code is here. What was taken: compare usernames
  case-insensitively, skip a field that already holds the value, fill only `current-password` on a
  form that also has new-password fields, never fill a frame of another origin, "Never for this
  site" by exact origin, autofill on load off by default, save/update offers on by default.
- **Firefox's password manager was ported**, at `mozilla-firefox/firefox@4b5e436b`: field selection
  (`_getFormFields`), the username-only first step, the three-password-field change-form
  classification, the user-input guard (`userInputRequiredToCapture`), and de-duplication of a
  submission seen twice. MPL-2.0 is **file-level** copyleft, so it is fine inside an MIT
  extension *as its own file with its notice* — [src/logins/loginFormScript.ts](src/logins/loginFormScript.ts),
  listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Anything added to that file is MPL
  too, which is why the extension-side logic lives in MIT files. **The source file itself ships in
  the VSIX** (`!src/logins/loginFormScript.ts` in `.vscodeignore`), so the MPL §3.2(a) source form travels
  with the compiled one rather than behind a link to a moving branch; `package.json` says
  `MIT AND MPL-2.0`. One upstream rule was dropped on purpose — see the capture paragraph below.
- **Browserpass (ISC) was read and not copied.** Its fill does `setAttribute("value", password)`,
  which puts the password into `outerHTML` — where `browser_html` hands it to a model. Our fill
  never touches the attribute.

### Measured facts the design rests on

All measured in Chrome 153 with a CDP harness, then the compiled watcher run against Chrome
through a stubbed `vscode`. Electron 43 (Chromium 150, VS Code 1.140) carries every method and
event below — checked in the framework binary — and the VS Code CDP proxy forwards page-session
commands to Electron's debugger unfiltered (only browser-level `Target.*` / `Browser.*` go through
its allowlist).

- **`Runtime.bindingCalled` needs `Runtime.enable` on the session**, and calls made before it are
  lost, not queued. So `WatchedTab._install` enables first, injects second.
- **A binding added with `executionContextName` exists only in that isolated world**; the page's
  own scripts cannot see or call it. The context's `origin` (from `executionContextCreated`) is
  the browser's word for which site a frame is, and is the only thing an origin is judged by.
- **An empty virtual authenticator refuses `get()` at once — but only with presence simulation
  on** (~35 ms, `NotAllowedError`). With presence off, which is how the watcher keeps it, a
  request it cannot answer waits out its timeout instead. Either way it fails; only the latency
  differs.
- **A credential added after a request started is not picked up**, and switching presence
  simulation on mid-request does not release it. So the credential has to be in place *before*
  the page's call reaches the authenticator — which is what the gate is for.
- **`WebAuthn.credentialAdded` carries the PKCS#8 private key**, plus `userName` and
  `userDisplayName`; `credentialAsserted` carries the new signature counter.
- **`WebAuthn.clearCredentials` fires `credentialDeleted`** for our own removal — never read that
  event as "the site deleted its passkey".
- **React mirrors a controlled input's value into its `value` attribute**, passwords included
  (React 19.2) — so `outerHTML` holds what the user typed. See `browser_html` below.
- **An isolated world is shared by every CDP session that names it.** A second session's
  `addScriptToEvaluateOnNewDocument` with the same `worldName` runs in the *same* world as the
  first — same globals, same context id — so whatever an earlier install left there is what the
  next one finds. See [Installing into the page](#installing-into-the-page).
- **`self.origin` and `location.origin` disagree, in both directions.** In a `srcdoc` frame
  `location.origin` is `"null"` while `self.origin` and CDP both give the page's origin; in a frame
  sandboxed without `allow-same-origin` it is the reverse — the site's address, and an opaque
  `self.origin`. Chrome runs that sandboxed frame out of process, as a target of its own whose
  CDP origin is `://`.
- **A network error page reports nothing.** A form POST that fails commits
  `chrome-error://chromewebdata/`, whose contexts have the origin `://`; the watcher ignores
  those, so that document never sends a single report.

### Capturing a sign-in, and deciding it worked

The page script reports a submission on `submit`, on a trusted click on a sign-in-looking button,
on Enter in a login field, and when a password field is removed from a form the user *acted on* —
submitted, clicked a button in, pressed Enter in — has not typed into since, **and a request went
out after that action**. The last is Firefox's "form removal" capture
without its fetch-success precondition, which is how a single-page app's login is seen at all;
the acted-on condition is ours, because without it a form that merely went away — a route change,
a closed dialog — counted as sent. Firefox's guards then decide it is real: a trusted gesture
since the last capture, and the same values never reported twice.

**There is no capture on navigation**, which Firefox has (`pagehide`, the `navigate` event) and
this port had. Typing a password and then clicking any ordinary link — Home, "Reset your
password", Back — fired `pagehide`, the click passed the gesture guard, and the next document,
having no sign-in form, read as a successful sign-in: the typo became "Update password?".
Firefox turns that capture into a dismissible prompt; here it went through a decision that reads
"left the page" as "signed in". A sign-in that navigates still submits a form or is clicked, and
both of those are captured.

**And a click on a link that goes somewhere is not one of those clicks**, which the paragraph above
claimed and the click handler did not deliver: it let a link through whenever its text "said so",
matched as a substring — `reset` in "Reset your password", `sign ?in` in "Trouble signing in?" — so
the same typo reached "Update password?" through the click capture instead of `pagehide`. What
holds now, and each rule has a failure behind it:

- **A link with an `href` that navigates is never a submit**, whatever it says — a hash route
  (`#/reset`, `#!/…`) included. One whose `href` is empty, a plain `#` or `javascript:` is handled
  in place by a script and may still be one.
- **The submit words are whole words**, bounded by Unicode letters and digits (`\b` is ASCII-only
  and never matches beside Cyrillic), with identifiers split first so `loginButton`, `btn-sign-in`
  and `log_in` still read. `reset` and `change` are not among them: they label the way *to* a form
  far more often than they submit one, and such forms submit through their own submit button. A
  `type=reset` button is never a submit.
- **Any other button still arms the removal capture**, unless its label leads elsewhere
  (`leadsAway`: forgot, reset, help, sign up, back, show, hide, in a few languages). Arming only on
  the submit words was tried and cost every single-page app whose "Log in" is a `type=button` —
  the default in MUI, Ant Design and Vuetify — labelled in another language or with an arrow icon.
- **The removal capture needs a request after the arming click** — Firefox's fetch-success
  precondition, approximated. The isolated world cannot see the page's `fetch`, but a
  `PerformanceObserver` there is told of its fetch, XHR and beacon resource entries, even with the
  resource timing buffer full (measured, Chrome 153). That is what tells a sign-in from a "show
  password" toggle or a route change: both remove the form, only one sent anything. The decision
  waits a second, since an entry is recorded once its response has fully arrived, which can be
  after the page removed the form. A route change that fetches data can still pass; the arming
  rules above are what keep that rare.
- **Moving on while a watched submission's form is still showing ends the watch** as `remained`:
  a trusted keystroke into that form, or a click on anything but a submit. A submit the page
  rejected — form kept, error shown — otherwise read the form going away under the next route
  ("Forgot password?") as its own success, and offered the rejected guess as an update.

Measured end to end — the compiled script in its isolated world, headless Chrome 153, trusted input
events, pages that POST before they swap the form out — against HEAD before this change: ten
sign-in shapes (`type=button` labelled in seven languages, an arrow icon, `div role=button`,
`a href=#`) are captured by both; a hash link "Reset password", a routing button "Reset password",
a toggle then "Forgot password?", and a rejected submit followed by "Forgot password?" with or
without retyping each gave `outcome: gone` — an update offer — on HEAD in at least one form, and
give no submission or `remained` now. **One shape is lost**: an `<a href="/login">` that a script
intercepts with `preventDefault` is a navigating link here, so it is not captured. Breaks-silently
#307, #308, #320.

**A button submits by its explicit type or by its words — not by `.type` alone** (#451). A
`<button>` with no `type` attribute reports `submit` even where there is no form, and an app's
"Forgot password?" is one. So a click captures only on an explicit `type=submit` (or an image
input) or on the submit words with no `leadsAway` word beside them; any other button only arms the
removal capture. **But the watched form's own submit button never ends its watch**, whatever its
words (`resubmits`): Enter submits a form by sending a *trusted* click to its default button
(implicit submission, `detail: 0`), and a typeless default button labelled with an arrow or in
another language was read as "moving on" — every Enter sign-in on such a form ended `remained` two
milliseconds after it started (#466). The same rule keeps a double-click alive. Two shapes are lost
to the narrowing, knowingly: a **formless** typeless button whose label holds no submit word,
followed by a full navigation (the removal capture never fires across one), and a sign-in whose
label carries a `leadsAway` substring next to its submit word (an id `backoffice-login` holds
`back`). Counting every typeless button again would bring back the false success #451 removed, and
a miss costs an offer where a false success costs a password.

**An attempt the page answered and kept its form for is over, and moving on ends it.** A button
with no submit word — an arrow icon, `ログイン`, `Accedi` — only arms the removal capture and
starts no watch, so a rejected guess stayed armed with its own request already sent; a later
route change found "a request after the user acted" (the rejected one) and offered the guess as
an update — #233's outcome, reached past #308. Now an armed attempt (`arm`) ends while its form
still shows once the page has answered (fetch/XHR, not beacons) and gone quiet for 4 s, and in
any case 12 s after it started, the watch's own limit. A click that does not submit ends every
attempt whose form still shows if it leaves, leads away, is in another root, or comes after the
answer — unless it presses again what sent it (`retries`: the arming button or the form's
default button). Measured in Chrome 153, compiled script in its isolated world, trusted input:
rejected icon, Japanese, Italian and formless attempts followed by Forgot, Sign up, a menu, a
logo, an eye then a menu, or a route change 6 s later now capture nothing (all were `gone`
before); Log in, an icon, ログイン, Enter on a typeless icon default button, a 2.5 s chained
profile fetch, an eye during a 2 s request, retyping and pressing again are still captured.
**Lost, knowingly:** a success the page takes more than 4 s after its last answer to show (a
"redirecting in 5 s" page), and a slow sign-in begun after an unrelated fetch was answered.

**Every captured value must be one the user's own input left in its field** — provenance per
value, not per form. `trustedValues` keeps, for each field, the value it held after its last
*trusted* `input` event. A password whose value has changed since — `browser_fill`, the page's
own script, our fill — is not captured at all; a username that fails the same test goes out as no
username, never as the page's choice. Firefox tracks modification per form root, and every
formless field shares the document's root, so one trusted keystroke anywhere — the username, a
search box — made a script-set password look typed. Reproduced: a typed username followed by a
script-filled password was offered for saving.

**Firefox's `value !== defaultValue` fallback is dropped**, the one deliberate departure from the
port. It counts a field as the user's when its value differs from its default — and `browser_fill`
(or the page's own script) sets `.value` without any trusted input, so one click anywhere in the
page made an assistant's values look typed. Reproduced: an assistant's fill and click, after one
earlier user click, produced an offer to save the assistant's password. The username of a
two-step sign-in is remembered under the same rule — only if typed — on one document as well as
across two: the single-document path set Firefox's `mockUsernameOnlyField` before asking.

**An offer is made only once the sign-in visibly worked**, and this is the most important rule
in the feature. Offering on submit means a mistyped password produces "Update saved password?",
and one click on it replaces the right password with the wrong one. Bitwarden avoids that with
the request's HTTP status; an extension has no `webRequest` here, so the evidence is the page:

| What happened after the submit | Read as |
|---|---|
| the field left the page (removed, `display:none`, invisible) and no password field appeared in its place for 1.5 s | worked |
| the field left, and a password field — new-password ones included — came back within 1.5 s | failed — the form re-rendered itself with an error |
| the field was **disabled** while the request ran | nothing yet — a busy form is not a gone one |
| the field was emptied or changed, on any kind of form | nothing — a page empties the box after a failure as readily as after a success |
| the frame navigated, and the new document's **settled** report (load + 1.5 s) shows no password field | worked |
| the frame navigated, and the settled report shows **any** password field, on any origin | failed |
| the frame navigated, and the new document reported but never settled (10 s) | its last report decides, by the same rule |
| the frame navigated, and the new document **never reported at all** | failed — a network error page, a PDF, a download |
| nothing of the above within 12 s (page) / 15 s (watcher) | failed |
| judged a success, and a password field shows again on that site within 15 s | **withdrawn** — see below |

Every row was a review finding first, and the shape is the same each time: something that looked
like success also happens on failure. A form disables its inputs while it waits, and the old
`isVisible` test read that as "gone" — so every wrong password typed into such a form was a
success. A navigation was judged by the new document's *first* report, sent 300 ms in, before a
parser-blocking script or an app shell had drawn the error form. "Cleared" was success for a
change form, and a server rejecting the current password clears it too. A miss costs an offer —
the next sign-in offers again, with the password that worked. The opposite error costs a password.

The second round added three rows of the same kind. **"Any password field", not "a sign-in
field"**: a sign-up or reset form the server rejected and drew again is all new-password fields,
so it never looked like the form coming back — in the page's own check as well as after a
navigation, the first of which the reviews missed and was found while documenting the second.
**"On any origin"**: a failed sign-in sent back to its form on another host (`localhost` to
`127.0.0.1`) was a success. And **silence is not evidence**: a POST that fails on the network lands
on the error page, which never reports (see the measured facts above), and "no report, so no
sign-in form" offered a password no server had seen. A success that happens to land on a page
with a password field loses its offer; Save Login from Page is one click.

**A withdrawal reaches everything the offer started.** The offer goes from the status bar, an
answer given to its still-open picker or its username box afterwards is refused
(`_stillValid`), and a save or update already written from it within 20 s (`revertWindowMs`) is
put back as it was. Taking down only the status bar item was the first version: the picker the
user had already opened stayed live, and choosing Update wrote the rejected password — the
feature's one forbidden outcome, reached through its own safeguard. An offer the user answered
within the 15 s window, before the site redrew its form, was written and never revisited.

**A two-step sign-in carries its username across.** The username-only first step is reported on
its own (`kind: 'username'`) and remembered per origin for ten minutes, so a password-only second
page — usually a different document, where Firefox's own memory (`mockUsernameOnlyField`) is gone —
still saves the right account. Bitwarden's own code flags this case as lost. **Every first step
replaces the remembered username, and a sign-in that worked uses it up.** Remembering only typed
usernames and never forgetting kept alice through a switch to bob — filled by Fill Saved Login or
chosen in an account chooser, so not typed — and bob's new password went out as alice's. A first
step with no typed username now clears the page's memory and sends an empty `kind:'username'`
report, which the watcher reads as "forget" (`UsernameSteps` in `vaultData.ts`); an outcome of
`gone` in the page and a success in the watcher forget it too, which covers a chooser with no
username step. **And a first step of unknown account blocks the single-login update**: the empty
step is kept as `''` (`UsernameSteps.unknownAccount`), the submission carries `accountUnknown`,
and `decideSave` then answers `unknownAccount` rather than "update the single login saved for
the origin" — with only alice saved, bob's password chosen through a fill was otherwise offered
as alice's update. **Still open:** a chooser with *no* username step at all cannot be told from
alice signing in again on a password-only page, so there the single-login rule still applies;
the offer names the account.

**Save or update** (`decideSave` in `vaultData.ts`, under test): the never list says nothing; the
same username with the same password only bumps `lastUsed`; the same username with another
password is an update; a change form whose old password matches exactly one saved login updates
that one; a password-only submission updates the single login saved for the origin; anything
else saves anew.

**Assistant-driven sign-ins are not offered**, because every captured value has to be the user's
own input — `browser_fill` produces none. An earlier version of this sentence said "by
construction" while the `defaultValue` fallback quietly let them through, and a later one while
provenance was still per form; the per-value guard is what makes it true, not the untrusted click
(a form submission from `el.click()` fires a trusted `submit` event).

### Filling

**Matching is exact origin, then the same host on another port or scheme — nothing wider.** The
matching rule *is* the phishing protection: subdomain matching would need the Public Suffix List
to be safe (`a.github.io` and `b.github.io` are different parties), and approximating it is how
it goes wrong. An https login is never offered on an http page except on a local host. A login of
another site can still be used deliberately ("Use a login saved for another site…"), behind a
modal that names both addresses side by side.

**The fill is written into the frames of the page's origin and of the login's own, never a
third.** Frames with an opaque origin (sandboxed, `about:blank`, `data:`) have no origin to match
and are never filled. Cross-origin iframes are separate targets (OOPIFs) and are out of reach.

**The values travel as `Runtime.callFunctionOn` arguments, never in source text** — an evaluated
expression containing the password is a script DevTools lists among the page's sources.

**And the page checks where it is before it uses them.** A context id is renumbered after a
cross-site navigation — the new document's worlds start from 1 again — so an id listed a moment
before the call can already name the *next* site's world. The watcher re-checks each context
before calling, and the fill compares `self.origin` in its isolated world with the origins it was
given. **`self.origin`, not `location.origin`** — the URL's origin is the wrong one in both
directions (see the measured facts): it refused every fill in a `srcdoc` frame, whose URL origin
is `"null"`, and would hand a site's password to a sandboxed frame at the site's own address. The
isolated world's globals are its own, so the page can redefine neither.

**How a value is written:** focus, `keydown`, this world's native `value` setter, an `input` event
(`insertReplacementText`), `keyup`, `change`. The native setter from the isolated world is what
React needs: its tracker is an own property on the *page* world's wrapper, so the event that
follows counts as a change. Measured with React 19.2: the component state updated. The `value`
attribute is never set.

**Autofill on load is off by default**, and when on it fills only an exact-origin match, only when
exactly one login is saved, only empty fields, and only a masked password field.

**Fill acts on the tab the user is looking at, which is not always `activeBrowserTab`** — the
first bug report this feature had. The extension host sets that property from the globally active
editor pane and nothing else, so it is `undefined` whenever the last click went to a file, a diff
or the terminal, with the browser on screen in a split beside it, and also when Fill is picked
from the dropdown of a browser tab in a group that is not the active one. "Fill Saved Login" then
answered "no browser tab is active" about a page in plain sight. Two questions, two answers in
`LoginWatcher`:

- `userTab()` — what a command the user ran is about: the active tab, else the one last seen
  active while it is still open, else the only tab. Fill and Save Login from Page use it; the
  picker that follows names the site, so the choice is never a silent guess.
- `tabInFront()` — what is on screen: the active tab, or the last active one while some editor
  group's visible tab has no `input` — the browser-editor heuristic of
  [the update check](#the-real-build-watches-for-releases-too). The suggestion item, the passkey
  prompt ("only the page in front of the user may ask") and the loss warning's placement use it,
  since each is about a page being looked at rather than merely the last one touched.

The MCP side met the same property earlier and answered it the same way (`_lastTab`, in
[The server is per window](#the-server-is-per-window-the-tools-act-on-one-tab-chosen-per-call)).

### Installing into the page

Both page scripts are installed per CDP session, and **a session that goes takes its
registrations with it but not the scripts already running** — so each install has to find, and
retire, whatever an earlier one left.

**The form script's world is shared with every earlier install.** It lives in the isolated world
`aiBrowserLogins`, and Chrome hands a second session the same world (measured: the same context id
from both). The first version guarded against double installs with a global set once and frozen,
and a graceful `close()` stopped the old script while leaving that global behind — so after any
re-attach (a settings change restarting the watcher, a fourth browser tab evicting the oldest)
the new install saw the global, returned at once, and the document reported nothing until it
navigated. No suggestion, no capture; on a single-page app, for hours. Now every install has an
**owner** (a UUID per `WatchedTab`): it uninstalls whatever the shared registry
(`__aiBrowserLoginsRegistry`) lists, publishes its API under `__aiBrowserLogins_<owner>`, and
`uninstall(owner)` only acts for that owner, so a late goodbye from a retired session cannot
switch off its successor. The pre-owner global of an older build is uninstalled too.

**The passkey gate lives in the page's main world**, where a session-scoped name is impossible —
the page owns that world — so the gate is one object (`Symbol.for(...)`) that a new install takes
over with `handOver(notify, owner)`, and the same owner rule applies to `uninstall`.

**Both scripts are `String.raw` template literals returned by a function of the owner**, which
makes three rules load-bearing: no backtick anywhere inside, comments included (it closes the
literal, and the compiler reports a cascade elsewhere); no `${` other than the intended
interpolations; and regular expressions written as they would be in a `.js` file.

### Passkeys: a virtual authenticator that holds nothing

VS Code's browser has no usable platform authenticator, and VS Code itself has no biometric API —
the OS keychain behind SecretStorage does not prompt. So "biometric sign-in" here means
**passkeys**: a CDP virtual authenticator, whose credentials live in the vault, with **a VS Code
confirmation standing in for user verification**.

**An extension *can* reach Touch ID, though, and an earlier version of this paragraph said it
could not.** `osascript -l JavaScript` with `ObjC.import('LocalAuthentication')` reports
`canEvaluatePolicy` true and `biometryType` 1 (Touch ID) on a Mac that has it — the same
child-process route `clipboardImage.ts` already takes — and Windows Hello is reachable through
PowerShell's `UserConsentVerifier` (not run). Neither is built; see [Not built](#not-built). It
matters for honesty as much as for the feature: the authenticator is created with
`isUserVerified: true`, so every assertion tells the relying party that user verification
happened, when it was a click in a QuickPick.

The lock and the doorbell are separate, and only the lock is a security boundary:

- **The lock is the authenticator.** It holds no credential and has presence simulation off,
  except during a ceremony the user approved. Presence off is what stops a page from *creating* a
  credential silently — creating needs no stored key, only a presence check. Measured: a page
  calling the browser's own `create`/`get` around the wrapper gets `NotAllowedError`.
- **The doorbell is `passkeyGate.ts`**, a wrapper around `navigator.credentials` in the page's
  own world, since there is no CDP event for "a WebAuthn request started". It reports, waits for
  a verdict, and only then calls the browser's function. A page can bypass it — and then meets
  the empty authenticator.

A `get` with nothing saved for that RP goes to the browser's own authenticators without asking
(`WebAuthn.disable` for that one request); one with saved passkeys shows a picker of accounts
plus "Use a security key or another device". A `create` asks. Conditional mediation (passkey
autofill on load) passes straight through and simply never resolves. A page aborting closes the
picker. **Only the page in front of the user may ask, and a refusal silences that tab for 5 s** —
without it a page calling `get()` in a loop would put the picker back the instant it closes, and
the picker takes the keyboard. **A page that aborts its own request while the picker is up counts
as a refusal too**: the cool-down was started only by a refusal, so a loop of `create()` aborted
after 100 ms reopened the picker for ever. While the virtual environment is on, the tab's real authenticators are only
reachable through that "security key" choice; `aiBrowser.passkeys.enabled: false` gives them back.

**A `create` naming a passkey already saved is refused like any other refusal**, never with
`InvalidStateError` — and **only after the user has chosen Save in the picker**. Answered without
asking anyone, "already registered" let a site test which of its credential ids this browser
holds and recognise a signed-out user; the spec reveals it only after a user gesture. Changing the
error to `NotAllowedError` was not enough on its own: answered at once, it still told the page
apart from the picker it gets otherwise, by timing — `create({ excludeCredentials, signal })`
aborted after a moment answered `NotAllowedError` for a held id and `AbortError` for any other.
The user is told in the status bar; the page learns nothing it could not learn from a refusal.

**The ceremony's end is ours, not the page's.** It ends on the first `credentialAsserted` or
approved `credentialAdded` — one approval, one signature — on the page's `abort` or `done`, and
when the requesting document's context is destroyed. After the user decides, it has 60 s, not 5
minutes. Reproduced before the fix: a page that withheld `done`, or simply navigated while the
picker was open, kept the approved key loaded with presence on, and any page of that RP signed
silently until a five-minute timer ran out, while every legitimate request was refused. And a
ceremony that ends *while* `addCredential` is in flight gets the authenticator emptied again
after it lands.

**A created passkey is disarmed before it is saved.** `credentialAdded` ends the ceremony, removes
the credential from the authenticator, and only then awaits the vault write. In the other order
the new key sat loaded with presence on for as long as the write took — a lock, a 3 s catch-up —
and a reproduction got a second signature out of it in that time, with no second approval.

**A session that goes uninstalls what it put in the page** (`WatchedTab.close`): a setting
switched off, the tab dropped from the watched set, the extension restarting. The registrations
die with the session; the running scripts do not, and a gate whose session was gone parked every
passkey request for ever. The gate's `uninstall` gives back the browser's own `get`/`create` and
hands a waiting request to them; the form script's disconnects its observer and listeners. As a
backstop for a session lost without a goodbye (a crashed extension host), every wait in the gate
also ends at the page's own WebAuthn timeout, floored at Chromium's 10 s, or 5 minutes.

**The authenticator is created before the gate is installed.** The other order, with
`WebAuthn.enable` failing, left a gate that refused every request on a tab whose own
authenticators would have worked. And a half-success is undone: when `WebAuthn.enable` succeeds
and `addVirtualAuthenticator` throws, `WebAuthn.disable` follows, or the virtual environment stays
on with no authenticator in it and hides the tab's real ones just the same.

**A cross-site frame's ceremony fails while passkeys are on, and nothing here fixes it.** The
virtual authenticator belongs to the page target and answers requests from out-of-process frames
too (measured: 39 ms, with a credential in it); the gate is installed through the page session's
`addScriptToEvaluateOnNewDocument`, which does not reach those frames. So an embedded payment
confirmation or identity-provider widget calls the browser directly, meets the empty
authenticator with presence off, and fails after its own timeout — no picker, no "security key"
choice. The setting's description says so, and turning passkeys off hands such frames back to the
browser. Fixing it means attaching to each OOPIF (`Target.setAutoAttach`) and running the gate
there, with the ceremony routed by session — see [Not built](#not-built).

### Storage, export, import

**SecretStorage is the encryption.** On desktop it is Electron's `safeStorage`, keyed by the OS
(Keychain, DPAPI, Secret Service), so a copied profile is ciphertext. Nothing adds a second layer:
a key the extension held would have to be stored somewhere weaker. One key holds the whole vault
as JSON, because SecretStorage cannot list keys on the 1.85 floor.

**On Linux without a keyring there is no persistence at all.** VS Code 1.140 logs "Encryption is
not available, falling back to in-memory storage" and keeps secrets in memory, **per window**,
until the user opts into its weaker encryption. Nothing in the API says so, so the extension
cannot tell: the vault lasts as long as the window, and the next window — or the next start —
finds the count saying something was saved and nothing there, which reads exactly like a vault
VS Code could not decrypt. The loss warning names both causes on Linux, and the `logins.enabled`
description says it up front.

**A lock does not make a read fresh, and a revision does.** Writes are read-modify-write under
`withLock`, but each window reads SecretStorage through its own renderer's cache, and a write
reaches the others only after a 100 ms flush and an IPC hop. The lock was released when `store`
resolved, so the next window could read a stale vault inside the lock and write it back without
the first window's entry. Every write now stamps a `revision` — its time, then a UUID — recorded
in a file beside the lock, and the next writer waits until its own read is at least that new: the
same revision, or one stamped no earlier. A harness with a 300 ms lag between two windows lost the
first entry on the old code and keeps both now.

**When freshness cannot be had, the write is refused.** The first version waited 3 s and then
went ahead with the read it had — the stale vault the wait existed to avoid, written back over
the other window's entry. Now the update throws "another window has just changed the saved
logins… try again", and the stored vault is untouched (measured: a reader lagging 5 s is refused
after 3 s and the other window's login survives). The one exception is a recorded write more
than 30 s old that has still not arrived: its window stored it and went away before the change
was flushed to anyone, and waiting for it would lock the vault for good.

**Once `store` resolves, the update has succeeded.** The revision file and the count are
bookkeeping written after it, and a failure there — a rename an antivirus holds on Windows — used
to throw out of an update that had worked: "Saved logins were not changed" about a change that
was saved, and, after a passkey was created, advice to delete at the site a key that was in fact
stored. They are best-effort now; the worst a lost revision file costs is the next writer's wait.

**A read that a change notice overtook is returned, not cached.** `onDidChange` clears the cache,
and a `read()` already waiting on `get` could then cache the answer computed before the change —
holding a deleted login in the picker until the next change. A generation counter, bumped by the
notice, decides whether the answer may be kept.

**The lock and the revision file live in the extension's global storage**, per user — not in
`os.tmpdir()` like the MCP config locks, where on a shared Linux machine another user could hold
the lock and stop every save.

**VS Code deletes a secret it cannot decrypt** (a reset keychain, a changed keyring) and then
answers `undefined`. A non-secret count in `globalState` tells that apart from "never saved"; an
absent vault with a non-zero count is given a second look a second later (another window's first
write may not have arrived), and is then reported once. **The vault fires `onDidLose` and says
nothing itself** — it used to show the warning from inside `read()`, which runs when the active
browser tab changes, so the toast landed on a visible page and paused it (#10). `logins.ts`
decides: the status bar while a browser page is in front, the warning once it is not. The count
is per profile while the vault is not, so in a second profile the check is merely weaker.

**An unreadable vault is an error, never an empty one** (#101's rule, higher stakes). A newer
format is unreadable too, and so is a vault whose `logins`, `passkeys` or `neverSave` is present
but not an array — reading that as an empty list meant the next write replaced it with one. A
single malformed entry is set aside and **written back untouched**, so a write never drops it,
and **counts as content for export**: a vault holding only entries this build cannot read used to
answer "nothing to export", which is precisely the vault that needs carrying to a build that can.

**The export is scrypt (N = 2^17, r = 8) + AES-256-GCM**, with every parameter in the
authenticated data, so an edited cost or salt fails as a wrong passphrase rather than decrypting
under parameters nobody chose. An imported file's cost is bounded (≤ 256 MiB) *before* any work,
since it is read before anything is authenticated. Passphrases are NFC-normalised. Written `0600`
and atomically — `0600` **even over an existing file**: `writeFileAtomic` keeps an existing file's
mode for configs, and an export written over an old `0644` file in the save dialog kept it, every
password readable by every local user (`keepExistingMode: false`). The export carries the
entries this build could not read, so they reach a build that can. **Nothing from the file is ever
echoed into a message**: a crafted `version` of `1 [Update](command:…)` reached an error
notification, whose body runs command links (#124).

**CSV** reads Chrome, Firefox (with timestamps), Safari, Bitwarden (logins only) and 1Password;
columns are matched by name, alias order before position. **Bitwarden joins a login's URIs with
commas** in one cell; read whole, `https://a.com,https://b.com` became the origin
`https://a.com,https` — valid to every check, matching no page. The cell is split on commas and
line breaks, and the first web address wins, so an app URI listed first is skipped. Export writes
Chrome's layout, unescaped — a formula guard would change the password — behind a modal that
says the file is readable, that passkeys are not in it, **and that a cell starting with `=`,
`+`, `-` or `@` can run as a formula in a spreadsheet** (usernames and titles come from pages; the code comment
promised that sentence long before the modal had it). It refuses when there are no logins, and
refuses a target that is not a local file, whose mode `0600` cannot be set — a remote window's
save dialog would otherwise leave every password readable on that host.

A conflict on import (same origin and username, **compared without case** as everywhere else,
other password) asks once which side wins, counted on the same de-duplicated rows the merge
applies. **Duplicate rows keep the newest** (`updated`), not the first, and are counted in the
summary: Chrome stores a login per URL path, so an old and a new row for one account are an
ordinary export, and the first-wins version installed the stale password while the counters no
longer summed to the file. **But only where the file says when.** Chrome, Safari, Bitwarden and
1Password CSVs carry no dates, and each row was stamped with the import's time, so comparing equal
stamps kept the first row while the summary said "(the newest used)". Undated rows are passed to
the merge as `undated`; a pair that cannot be ordered (either undated, or equal dates) keeps the
**first** row — Chrome sorts its export by site, so position says nothing about age, and "first"
is a rule the user can check — and when the passwords differ the account is reported in
`MergeReport.undecided`, counted in the summary, and named (up to five) in a modal asking the
user to check those passwords. Logins are indexed by origin and username in a `Map`; the linear
searches they replaced took 18 s for 60 000 rows, inside the lock, blocking every extension in the
host (now under 50 ms, conflict count included). Passkeys merge by RP and credential id, keeping the higher counter — going
backwards reads to a relying party as a cloned authenticator.

**Saving never replaces a saved password without asking.** A login is one origin and one
username, so "Save as a separate login…" with the prefilled name, or "Save Login from Page" on a
saved account, could only mean "replace" — and did it silently, the first one right after the
user had declined to update. A replacement is now a modal question; the same password is "already
saved". **The question is asked again under the lock**: two windows can both see no entry, and the
second write then replaced the first window's password without a word — so `_saveNew` re-checks
inside the update and, finding a conflict that was not there when it asked, comes back out to ask
(three rounds at most). A rename in Manage checks the same rule, since renaming onto a saved
username made two logins with one key. An edit to a login another window deleted meanwhile says
so rather than doing nothing. An offer answered after a newer one replaced it, or after it
expired, still acts on the answer given — expiry is not evidence the password is wrong; a
withdrawal is, and refuses it. Turning `offerToSave` off takes a pending offer down.

**The five settings are `application`-scoped.** A workspace's `.vscode/settings.json` could
otherwise switch `autofillOnPageLoad` on — and a cloned repository's dev server on
`localhost:3000` would receive a login saved for that origin by another project, without a click.

### Keeping password values from the assistants

React mirrors a controlled input's value into its `value` attribute — after our fill as well as
after typing (measured, React 19.2) — so a filled password sits in the markup, and markup reaches
models by three routes. Each is closed separately ([src/logins/secretGuards.ts](src/logins/secretGuards.ts),
leaf, under test):

- **`browser_html`** takes the element's `outerHTML` and redacts it **in the extension**, with
  `redactSecretValues`. It used to redact a `cloneNode(true)` in the page, which ran code: a deep
  clone upgrades custom elements, so their constructors ran in the page's world on a read-only
  tool (measured: the count went from 1 to 2).
- **`browser_inspect_element`, `browser_selected_element` and the Copy/Add Element reports** take
  their markup from CDP (`DOM.getOuterHTML`), and the same function strips it there.
- **`redactSecretValues` reads the markup as HTML**, not as text with tags in it. Looking for
  `<input` anywhere, the first version let a script containing `const x = '<input data-x="';`
  open a quote that swallowed the next real input — whose password then went out unredacted.
  Comments, CDATA and raw-text elements (`script`, `style`, `xmp`, `iframe`, `noembed`,
  `noframes`, `noscript`, `plaintext`) are copied through unscanned, and a tag is read with its
  quotes honoured rather than cut at the first `>`. **The end of a raw-text element is found by a
  case-insensitive search for ASCII `</name`** (`rawTextClose`), not `html.toLowerCase().indexOf`:
  lowering the document once per element was quadratic (20 000 `<style>` tags held the host
  4.8 s, now 9 ms), and lowering is not length-preserving (`İ` becomes two code units), so the
  index it found landed past the end tag and copied the next input's value through. **And a quote
  opens a value only where the tokenizer would read one** (`tagEnd`, the attribute states cut
  down): `<div a'="x">` is a legal attribute name, and `<div ='>` is the attribute `='` — an `=`
  before any name character starts a name — and reading either quote as a value swallowed the
  following password input.
- **Every tool that takes a selector refuses one that compares `value`** (`comparesFieldValue`):
  `input[type=password][value^="a"]` matching or not is a one-character oracle, and an exact
  `[value="…"]` a dictionary attack. The selector is **tokenised first**: comments removed — CSS
  drops a comment between tokens, so `[value/**/^="a"]` is the same selector, and it walked past
  the first version — but only outside strings, or `[title="/*"][value^=a][title="*/"]` would
  hide the comparison inside a "comment"; escapes undone (`[val\75 e^=a]`); case folded.
  `[value]` alone, which reveals nothing, still works, and so does a comparison on an element that
  never holds a typed secret — `option[value="us"]`, `input[type=radio][value=pro]`,
  `button[value=delete]`, which is how models pick choices, and which the first version refused.
  What decides is the compound the comparison sits in: a custom element (`sl-input`) and an
  `input` of no stated or of a text-like type are refused, so `form:has(input[value^="a"])` is
  still caught. **Only the compound's own top level pins it**: whatever sits inside `:not(…)`,
  `:is(…)`, `:where(…)` or `:has(…)` is dropped before the tag and `[type=…]` are read, since
  `input:not([type=radio])[value^="a"]` is the opposite of pinning a radio and matched a password
  field (breaks-silently #309). **And an escaped character is part of a name, never syntax**:
  `normalizeSelector` decodes escapes, and a decoded `\)` closed the `:not(` early, so
  `input:not(.a\)[type=radio])[value^="h"]` read as a radio again. Escaped punctuation decodes to
  an inert `_`; escaped letters still decode, so `[val\75 e^=a]` is still caught (#321).
- **`browser_fill` never reads back a secret field's value**, by the same rule rather than by
  `type === 'password'` alone: a toggled field that rejected the new value had its contents echoed
  in the refusal. The page returns the field's attributes and the extension decides.

A field is secret by type, by `autocomplete` token, **or by name** (`password`, `pwd`, `passcode`,
`pin`, …) — a "show password" button turns the field into `type=text`, and it still holds the
password. **The name is matched as a word**, camelCase split first: unanchored, `pass` caught
`passenger_count`, `passport_number`, `compass_heading` and `bypass_cache`, and `browser_html`
reported those filled fields as empty. The rule now exists once, in `secretGuards.ts`, since no
page script applies it any more.

**What this cannot cover, stated plainly:** an assistant that clicks a page's own "show password"
button and takes a `browser_screenshot` sees the password on screen. Sharing a tab with an
assistant is sharing what that tab can show.

### Not built

- **No MCP tool fills a saved login.** An assistant signing in to a dev app without seeing the
  password is a real use; it needs a tool that names a login without revealing it, and a decision
  about which logins an assistant may use. Recorded rather than done.
- **Shadow-DOM and OOPIF login forms are not seen.** Firefox's form lists do not descend into
  shadow roots, and a cross-origin iframe is another CDP target.
- **Passkeys in cross-site frames.** Attaching to each out-of-process frame
  (`Target.setAutoAttach` on the page session), installing the gate there and routing its
  ceremony by session would serve them; until then they fail while passkeys are on — see
  [Passkeys](#passkeys-a-virtual-authenticator-that-holds-nothing).
- **Touch ID and Windows Hello as the confirmation.** Reachable — `osascript -l JavaScript` with
  `LocalAuthentication` on macOS, PowerShell's `UserConsentVerifier` on Windows — and not built:
  the QuickPick is the confirmation everywhere, and `isUserVerified: true` overstates it. Built,
  it would make that flag honest on the two platforms that have a sensor and leave Linux on the
  picker. Waiting on the user's decision.
- **No password generator**, and no TOTP.

## The AI Browser chat

The 0.7 headline: a chat of our own, beside Claude Code's and Codex's, **in the secondary (right)
side bar and only there** — container `aiBrowserChat` under `viewsContainers.secondarySidebar`,
view `aiBrowser.chat`.

**That contribution point exists only from VS Code 1.106**, and below it there is no chat at
all — but not because the host ignores the contribution. **A view whose container the host does
not know is moved into Explorer** ("View container '…' does not exist and all views registered
to it will be added to 'Explorer'"), so without a guard an older VS Code showed the chat on the
left after all. The view therefore carries `when: !aiBrowser.chatUnsupported`, set at activation
below 1.106 (`supportsSecondarySidebar` in `chatView.ts`), and the same key hides the chat's nine
commands from the palette (New Chat, Chat History, Refresh Agents and the six "Add … to AI
Browser Chat") and Chat Settings and Record Page to AI Browser Chat as well, since `aiBrowser.chat.focus` does not exist there. A key is set at
activation and the view can resolve first, so `_blocked()` refuses below 1.106 as well — no CLI
starts there whichever lands first. Both assistants'
own extensions add a left activity bar copy for those versions, gated on a context key of the
same kind (`claude-code:doesNotSupportSecondarySidebar`, `chatgpt.doesNotSupportSecondarySidebar`,
both set below 1.106). That fallback was built here and **removed on request — the chat is
right-hand only.** The first version had the opposite
mistake, an activity bar container only, reported as "the chat did not appear in the right
panel": that is where people look, because that is where the other two are. It does **not** reimplement an agent — it
drives the user's own installed Claude Code and Codex CLIs, the way their VS Code extensions do,
so it runs on the user's existing subscription and sign-in, and the model list, the efforts and
the usage are whatever that CLI reports.

What is built, and what is not yet:

- **Built:** agent detection; agent / model / effort selectors from the CLIs themselves; a
  streaming conversation with stop; messages sent during a turn; the `+` menu (screenshot of the
  page, element from the page, page address, file); the `U` usage popup (plan limits per agent,
  plus this chat's tokens and cost), the button coloured by the nearest limit and a line above
  the chat from 90 %; history with resume; new chat; refresh; several
  conversations at once, as tabs; the agents an agent starts, listed, each stoppable on its own;
  approvals asked in the chat, with an Auto / Ask / Deny menu by category; questions with choices
  answered in a form while the turn waits; messages added to a
  running turn or queued for after it; the browser tools, handed to both agents
  at every start whether or not Connect was ever pressed — see
  [Approvals and the browser tools](#approvals-and-the-browser-tools).
- **Not built yet:** browser tools given to the agent *in process*, with no MCP server, port or
  token — Codex's `dynamicTools` (see below) and the equivalent for Claude. Today the chat hands
  each CLI this window's own MCP server instead, which needs the server running.

### The layout, as asked for

Bottom to top: a toolbar row — `+`, the browser button, the agent pill, the model pill, the effort
slider (fixed width, no visible effort text; an immediate hover/focus tooltip names the current
level and a soft silver-grey/sky-blue/pale-violet thumb indicates increasing effort, with yellow for Max and
peach-orange for Ultra/Super/Extreme), the approval button ([approvals](#approvals-and-the-browser-tools)) and, pushed right, the agents button (only while the chat has agents — see
[Agents the agent starts](#agents-the-agent-starts)), the context pie ([below](#the-context-pie-and-compacting)), `U` (coloured by how much of the plan is used, [below](#the-plan-limit-line-and-the-colour-of-u)) — then the message box with, in a column at its right, Send / Stop, the microphone under it ([voice messages](#voice-messages)) and the queue button while a turn runs, then the conversation, and above it, under the tabs, the plan-limit line while a limit is 90 % used or credits are spent. The
browser button (icon only, a globe — `codicon-globe`, the same mark as the extension's own
status bar item and toolbar dropdown; `codicon-browser` reads as a window) opens a new browser
tab and does nothing else: it runs
`aiBrowser.newTab`, the dropdown's own "Open New Browser Tab", so the integrated browser or the
panel is chosen by the same rule as everywhere else.

**The "/" button**, right of the globe — a square with a slash, both drawn in CSS, 15 px with its
border (17 px before; made smaller on request, so it no longer matches the `U` and the pie): the slash is a
line from the box's centre (`.slash-mark::before`), since a font's "/" has side bearings and sits
on the baseline, and so was never in the middle of the square — opens **the palette**: a search
box at the top, focused at once so typing filters straight away (asked for, after Claude Code's
own "/"), over the chat's own commands and the agent's skills. See
[Skills and commands](#skills-and-commands-the--palette).

The chat's own two are first, under *Chat*: **Clear conversation** starts the tab over with the
same agent, the old conversation staying in the history (what Claude Code's `/clear` does), asking
first in the same place when the tab is working; **Export conversation** asks where to — the
clipboard, or **Save to file…**, which opens the transcript (`chatTranscript`, the one handed to
the other agent) as a new editor tab named `chat-<title>-<time>.md` and runs Save As, so the user
picks the place. **That editor is plain text** although the name ends in `.md`: a reply or a
page's words in a Markdown editor make `[x](command:…)` a link that runs a command on Cmd+click
(#371).

**The folder button**, right of "/" (`codicon-folder`), sets where the tab's agent works and
lists that folder's files to attach — see [The working folder](#the-working-folder).

**Every visible button of the bottom bar has a tooltip** saying what it does, and its key where it
has one — asked for: Attach, the browser, "/", the agent and model pills, effort, approvals,
usage, queue (⌘/Ctrl+Enter) and Send / Stop (Enter, Shift+Enter for a new line). The Agents panel
also has a **Close** button centred at its foot (`panelFooter`), asked for: the X at the top is
far once the list is scrolled.

**↑ / ↓ in the message box walk through the messages sent before**, as in a terminal: ↑ older,
↓ newer, and past the newest the text typed before walking comes back. **↑ starts a walk only
from an empty box or with the caret at the very start**; once a recalled message is on show, ↑
goes on from its first line and ↓ from its last. "No line break before the caret" was the first
rule and it was wrong in the narrow side bar: a long paragraph wraps onto several lines there, ↑
means the line above, and it swapped the draft for the last message — and typing into that then
lost the draft for good (#364). The draft from before a walk is kept while an edited recalled
message is walked away from. A recalled message is entered at its end. Kept per workspace in
`workspaceState` (`aiBrowser.chat.inputHistory`, the last 100, a repeat of the newest not stored
twice, nothing over 20 000 characters — a pasted log is not worth recalling, and the list is
rewritten and posted on every send) — per
workspace like the chat history, since a prompt is usually about its project. A message is
remembered before the agent check, so one refused for want of an agent is the first thing ↑
brings back.

**An empty chat shows NEWS.md.** The root `NEWS.md` holds an introduction — the paragraph before
the first entry — and entries, each a `## <version> — <date>` heading over a bullet list, newest
first. The welcome shows the introduction under the title, centred in the panel, then **the
features worth trying** (asked for) — bullets placed between the introduction and the first entry,
each written exactly `- $(codicon) **Name** — one line`, drawn as icon, bold name, dash and text
above "Show changelog"; a bullet of any other shape there is skipped, and an icon name that is not
a plain codicon id draws `star` — and the newest six entries in small print as "What's new". The file is read once from the installed
extension (`extensionUri`), not from a workspace, so it always describes the build that is
running; it ships in the VSIX like README.md, and a change reaches users with the next release.
[src/chat/news.ts](src/chat/news.ts) reads it (leaf, under test, including a test that the shipped
file parses), forgivingly: comments are skipped, entries without items are dropped, and a file
that cannot be read leaves the welcome its own one-line text. **Add an entry with every release
that ships something a user would notice**; the authoring notes are in the file's own comment.
**And the README's *Changelog* with it**, one short paragraph per version: it fell four releases
behind (0.7.0–0.7.3) while NEWS.md kept up, and the README is the extension's page in VS Code
and on Open VSX.

**"Hide changelog" folds "What's new" away, and "Show changelog" brings it back** — links in the
small print, asked for. The choice is kept in `globalState` (`aiBrowser.chat.newsHiddenAt`), so it
holds in every window, and it is stored as **the newest entry's title at the moment of hiding**:
when a release adds an entry, the list shows itself again. Hiding the changelog once must not mean
never hearing of a new feature, which a plain boolean would have made permanent. The title bar carries
icon buttons: New Chat, Chat History (`view/title`, `navigation@1..2`); Refresh Agents was removed from it on request and stays in the palette. The agents
button, `U` and Send are one group with `margin-left: auto`, so a narrow side bar wraps them
*together* onto the next line at the right. Where it wraps depends on the font: measured at
420 px / 380 px in VS Code before the agents button existed, and at 440 px in headless Chrome
with and without it — the button did not move the wrap point there.

### The design, and where each part came from

Asked for as "look at the Claude Code and Codex panels and do something similar". Both were read
from their shipped webviews — Claude Code 2.1.301 (`webview/index.css`, CSS modules), Codex
26.1007 (`webview/assets/*.css`, Tailwind v4) — and the parts were taken, not the code:

| Part | From | What it is here |
|---|---|---|
| tokens | Codex | borders and soft surfaces are `--vscode-foreground` at 5–14 % (`color-mix`), so every theme works with no light/dark branches |
| bottom anchoring | Codex (`flex-col-reverse`) | a `flex: 1 0 0` spacer above the first turn — a short chat sits by the composer |
| sticky prompt | Claude Code (`.message.stickyHeader`) | each turn's prompt is `position: sticky; top: 0` **inside its turn**, so the prompt being answered stays on top and the next one pushes it away; a gradient lets rows fade under it |
| timeline | Claude Code (`.timelineMessage`) | a dot per row and a 1 px line between rows; green done, red failed, warning-coloured stopped, blinking accent running |
| activity rows | Codex | "Ran `cmd`", "Read a.txt", "Edited app.ts +3 −1", chevron on hover |
| terminal card | Codex shell block | `$ command`, its first three lines, then the output's last three, no scroll down (asked for); footer "✓ Success" / "Exit code N" / "Running…", copy buttons on hover |
| diff card | Codex | file header with +N −N, then the first three removed and the first three added lines on `diffEditor.inserted/removedLineBackground` and how many more — no context, no hunks, no scroll down (asked for); a click opens the whole change in the diff editor |
| thinking | both | "Thinking" with a shimmer while it streams, "Thought for 4s" after; collapsed, body at most 140 px |
| working line | Claude Code's spinner row, Codex's shimmer | a star changing shape every 120 ms (`· ✢ ✳ ✶ ✻ ✽` and back, in the accent colour, still under reduced motion), then "Browsing… 12s"; when the turn ends a small square takes the star's slot, so the line does not shift, before "Browsed for 42s" and, right-aligned, the turn's tokens "↑ 35k ↓ 812" — all asked for |
| composer | Codex surface, Claude Code focus ring | 12 px radius, soft shadow, accent ring on focus, round send button in the foreground colour |
| pills and menus | both | agent and model are ghost pills opening in-view menus (label, description, check), not native `<select>`s |
| code blocks | both | header with the language — in the chart yellow, bold (asked for) — and a copy button; the code a little brighter than the prose, mixed towards white on a dark theme and towards black on a light one (`body.vscode-dark` / `vscode-light`; high contrast keeps its own) |
| quotes | asked for | `6px 14px` inside, a 3 px left border in the chart yellow, text at 88 % of the foreground; consecutive `>` lines are **one** blockquote, a bare `>` a paragraph break — each line used to be a blockquote of its own, which padding turned into a stack of boxes; a quote with no text (a lone `>` while a reply streams) draws nothing |
| running a shell block | asked for | a code block fenced as `bash`, `sh`, `zsh`, `shell`, `console`, `fish`, `powershell`, `cmd` … gets a terminal button left of Copy on hover (`runInTerminalButton`, `shellLangs`); a menu asks where — VS Code's active terminal (a new one in the conversation's folder if none), a running chat terminal tab, or a new one — and `_runInTerminal` types the block with Enter (lines as `\r` in a tab, `sendText` in VS Code's). The click is the consent, no card; refused where `_blocked()` is; `runInTerminal` is editor-only in `commands.ts` |
| copying a message | asked for | a copy button at the bottom right of every prompt and reply, on hover (`.message-copy`); a reply copies as its Markdown; the prompt's copy does not fold the prompt |
| spacing | asked for | rows `--row-pad` (10px) apart above and below — 6px at first, widened on request twice; the timeline's dot and line are placed from the same variable, so change only it — and 20px between turns — none after a turn that holds only its prompt, so messages added during a turn sit 22px apart rather than 42 (asked for); in a reply, paragraphs, lists, quotes, code blocks and tables 0.9em apart |
| lists | asked for | a bullet is an em dash (`list-style-type: "— "`) in the theme's chart yellow, items 0.4em apart; numbered items 0.7em apart, their number bold in the same yellow; headings (`#`…`######`, h5 and h6 sized as h4) bold (700), a little larger by level — 1.3, 1.2, 1.12 and 1.05em — and coloured from that yellow at h6 to white at h1, a fifth more white each level up (`level-N`, `--heading-yellow`); on a light theme the top is the foreground, since white would not read |
| sending | asked for | the message's text lifts out of the box and flies to its prompt in the thread (`launchFlight` / `landFlight`): the prompt's text is hidden until the flight lands, so the words are on screen once; the target is the first new prompt **with this text** (two sends inside one post round trip put both prompts in at once, and "the last prompt" was the wrong one), hidden again if it is rebuilt in flight; a chat switch stops the flight; a send with no prompt appearing within 1.5 s (still waiting for detection, refused) fades in place; nothing flies under reduced motion |

**The Markdown reader** handles what replies use: fenced code, headings, quotes, rules, tables
(outer pipes optional, one column allowed, a `|` inside inline code or escaped `\|` kept as text),
bullet and numbered lists — **an indented item is a list of its own inside the item above**, and a
list starts at the number the model wrote — and inline code, bold, italics and links, formatted
recursively so `` **`npm test`** `` shows no backticks. A line over 4 000 characters is shown as
plain text: the inline pattern backtracks on long runs of backticks or `[` (0.5–0.9 s for 40 000
of them), and a streaming reply is re-rendered every 40 ms.

**Links open, and a click chooses where** (asked for): a click opens the address in the built-in
browser through `aiBrowser.show` — so `useIntegratedBrowser` and the grant decide as everywhere
else, the panel included — and ⌘-click (Ctrl-click elsewhere) in the system browser through
`env.openExternal`. A right-click opens a menu in the view (`linkMenu`): both browsers, with the
gesture shown at the right of each row (`MenuItem.shortcut`), Copy Link and Copy Link Text. Both
`[text](https://…)` and a bare `https://…` are links; sentence punctuation after a bare address
is not part of it. Details that matter:

- **Never an `<a href>`**: a click in a webview navigates the view itself. The node is a span the
  host is asked to open (`openLink`).
- **The host takes only `http` and `https`** (`_openLink`), whatever the view sends: the address
  is the model's, and `command:`, `file:` or `vscode:` would make a click run something.
- **On a Mac only ⌘ means "system browser"**: Ctrl-click there is the right click, which opens the
  menu.
- **A click that ends a selection opens nothing**, and the link's click does not reach the row
  around it, which may fold on a click.
- **The menu opens below a link with no room above it**: `#app` clips what overflows, and a link
  near the top of the thread lost the menu's upper rows. `openAbove` resets `top` for that reason.
- **A ⌘-click on a localhost address can still land in this extension**: `openExternal` goes
  through the external URI openers, and ours claims localhost-like hosts.
- **A link inside a panel keeps the panel open under its menu** — an agent's report in the Agents
  panel holds links too. `openMenu`'s `keep` leaves that panel open, the menu is drawn above it
  (`.over-panel`, z-index 45 over the panel's 40), and choosing a row, a press elsewhere or the
  first Escape closes only the menu (`closeMenuOverPanel`). Closing the panel, as every other menu
  does, hid the link and put the menu in the view's top-left corner (#428).

**The file a Read or an edit row names opens on a click** (asked for): `fileLink` marks the name,
and the host's `openFile` opens it with `vscode.open` as a preview tab of the active group — so
text gets the text editor, an image the image preview, anything else whatever VS Code picks; a
folder is revealed in the Explorer. The path is the agent's: absolute as both CLIs give it, `~/…`
expanded as Claude Code itself does, a relative one taken from the agents' working directory. A
file that is gone is refused in the status bar. Two details:

- **The row's head is a button, and a disabled button passes no clicks to what is inside it.** A
  Read row has nothing to unfold and used to be disabled, so its head is now enabled while it
  names a file (`no-body` keeps the plain cursor), and the click is sorted in `toolNode`: on the
  name it opens the file, elsewhere it folds the row if there is anything to fold.
- **A click that ends a selection of the name opens nothing** — and only a selection touching
  the name counts (`containsNode`). A press on a button does not collapse a selection elsewhere,
  so testing for any selection left the name dead while some text in a reply was selected (#429).

Codex reads through commands (`cat`, `sed`), whose rows are commands; only its `View image` is a
Read row.

**File names in the conversation carry the Explorer's icon** — asked for, for the agents'
replies, the user's messages and the composer's chips (not the folder list): the file of a Read or
an edit row, a local file link in a reply, inline code that names a file (`chat.ts` — any name
with an extension the theme or a language knows), in a sent prompt its file chips
(`UserEntry.attachmentFiles`, from `AttachmentChip.iconName`, set only where the chip is one file:
a file, a folder, a pasted file, a selection) and path-like words in its text, and the same chips
and the suggestions in the composer (`chipIcon`, falling back to the kind's codicon; a screenshot
keeps its thumbnail). How it holds together:

- **The webview cannot reach the workbench's icons**, so the host reads the theme
  `workbench.iconTheme` selects (`loadFileIconTable` in `fileIconTheme.ts`, the same loader as the
  Git list's), merges its `light` / `highContrast` section for the colour theme's kind, resolves
  every definition to a webview resource, adds the languages by name and extension from the
  extensions' contributions and the plain-name and `*.ext` entries of `files.associations`, and
  posts the table (`fileIcons`). The view looks names up itself (`resolveFileIcon`): a reply can
  name any file, so they cannot be resolved one path at a time as the Git list's are. VS Code's
  order: file name, extensions longest first, language, the theme's default. No theme, or none for
  the name (a folder in Seti), draws nothing.
- **Sent on `ready` and on every change of the icon theme, `files.associations`, the colour
  theme or the installed extensions**, only to a live view, the newest request winning. A table
  that differs from the one shown bumps `fileIconsSignature`, which is in every row's signature,
  so the rows on screen are drawn again with it — the whole conversation, so an equal table
  changes nothing (most of those events change nothing about icons). The host keeps the last
  table and posts it before the first state on `ready`, so an opened chat is drawn once with its
  icons rather than drawn and then drawn again.
- **The table carries only what the colour theme's kind reaches, and each font once**
  (`fonts`, an icon naming it by index): measured on Seti, 96 KB with every definition and the
  font address repeated per icon, 29 KB this way. A lookup is ~0.25 µs; reading the theme ~1 ms.
- **The icon is one line tall and centred on it** (`height: 1lh`, `vertical-align: top`, the
  glyph's 150% on `::before` only, through `--icon-size`), as the Explorer centres icons in its
  rows. A box 1em tall with the size on the box left the glyph riding above the text.
- **In a chip the glyph's box is 12px, not 16px, with no margin**: Seti's glyph at 19.5px has
  about 3.7px of empty bearing on each side, so a 16px box plus the chip's own 5px `gap` left the
  icon far from "@1 image.png". An SVG icon keeps 16px — it has no bearings.
- **The view is created with the theme's folder among its resource roots** (`chatResourceRoots`,
  used by `resolveWebviewView` and every theme read). A change of `localResourceRoots` makes VS
  Code send the page again (`contentOptions` → `doUpdateContent`, read in the 1.137 bundle): the
  script starts over and every message posted until its next `ready` is lost. Created with
  `media/` alone, the first theme read on `ready` reloaded the chat on every opening — in any
  window, once the table was read regardless of Git. Switching to a theme from another extension
  still reloads it once; nothing else can add that folder.
- **In prose a word needs a `/` to count** (`namesFile`): an icon before "Node.js" would be wrong;
  a name the theme knows on its own (`package.json`) is the exception. In inline code a known
  extension is enough. Prompt words are found greedily and their trailing `.` / `:` taken off in a
  loop (`withFileIcons`): a lazy token with a lookahead for that punctuation was quadratic on a
  long run of dots (200 ms for 20 000, measured), and so is `/[.:]+$/` on the same input.
- **The glyph is `::before { content: attr(data-char) }`**, not text: copying a reply or a prompt
  takes no private-use character. The font is loaded with the `FontFace` API (`font-src` allows
  `cspSource`), an SVG icon is a background image set through the CSSOM — no `<style>`, which the
  CSP refuses.

Verified: the leaf under `npm test`; the compiled loader against the real Seti theme of the installed VS Code
with a stubbed `vscode` (dark and light colours, `package.json`, `Dockerfile`, a language-only
match, a folder with no icon); the glyphs in headless Chrome. **Not run inside VS Code yet.**

**The phrase is one of fifty pairs** ("Browsing…" / "Browsed for"). While a turn runs a random
one is shown and replaced every 8 s; the past form is picked from the turn's start time, so it
does not change on a re-render or after a reload. **The working line, "N agents running" under a
finished turn and the "Worked for …" line a turn leaves behind are all the chat text's own size**
(asked for) — the body's font size set outright rather than in `em`, so no parent scales them; the
star is 17px and the square 10px, and the token counts stay in the small print (`.worked-tokens`,
0.92em). **All three have the same space above them, 8px** (`margin-top`, asked for: twice the 4px
it was, and one value for the three), and the working line 2px inside, as "agents running" has.

**A turn's tokens are the difference in the chat's totals across the turn**, shown only when the
agent reported any. That one rule is right for both agents although they report differently —
Claude Code's `result.usage` is per turn and is added up, Codex's `tokenUsage.total` is the
thread's running total and replaces the figure — measured: two short Codex turns read 17 811 and
17 828, not 17 811 and 35 639. "Sent" includes cached input, which the tooltip breaks out.

- **Turns waiting are a queue (`_pending`), not one baseline**, and a Claude message sent
  mid-turn is not in it. Measured on 2.1.301, Claude Code does one of two things with such a
  message: **taken into the running turn** at the next tool boundary when it arrives while a tool
  runs — the final reply answers both, and there is one `result`; or **answered by a turn of its
  own** when it arrives during the final text — a second `result`, announced by `status:
  requesting` milliseconds after the first. Only the CLI knows which, and it says so only by
  starting that turn. So a mid-turn message waits in `ChatTab._waiting`, `ClaudeSession` counts
  only an idle send as a turn, and an `autoTurn` within two seconds of a turn's end takes the
  waiting prompt as its own (with its baseline and start time); a later one is an agent's.
  Counting every message as a turn was the first design, from a measurement of the second case
  only: after a merged message the count stayed at one, and the tab read as working for good —
  Stop up, the close asking for confirmation (#384). A Codex message sent mid-turn steers the
  running turn and is not queued.
- **Codex's running total survives a restart.** Measured: a thread resumed in a new app-server
  reported 39 496 after its second turn, the first having ended at 19 740. A total that ever
  comes back *lower* than what is counted is a counter that started again, and is added on top
  (`_tokenOffset`) instead of taking the chat's totals backwards. An *equal* total is a repeat,
  not a reset, or one duplicated event would double the count.

**Every tool call starts folded** — View Mode Compact, the default (asked for); in Standard a call with something to show — a
command, an edit, an MCP tool's IN / OUT — opens by default. Reads never have a body. **A folded
row still says what the call does** (asked for): a line under its title (`toolSummary`) — a
command's own description (Claude Code's Bash `description`, Codex's parsed actions), an MCP
tool's arguments as `key: value · …` (read line by line from the pretty-printed JSON when the
input was cut and no longer parses — a long argument, or a body cut for the history) — cut to one
line with an ellipsis, the whole in its tooltip,
and a click on it unfolds the row. Nothing is added where the title already says it: a read, an
edit, a search, a fetch, an agent, a tool whose detail is in its title, an MCP call with no
arguments. **A click on an IN or OUT block, or on a command or its output, opens that text in an
editor tab** (`openText`): read-only, plain text under the `ai-browser-attachment:` scheme, as a
chip's text is (#371 — a command's output or a page's markup can hold `[x](command:…)`), a
preview so the next one reuses the tab, cut at 2 000 000 characters with a line saying so. **A
diff card shows the change's counts and its first three removed and first three added lines,
nothing more** (`diffCard`, `ioLines`, asked for): no context lines, no hunk headers, each line cut
at 1 000 characters, and "5 more removed · 9 more added" under them, outside the part that scrolls
sideways. The card is as tall as those lines — **no scroll down inside it**, only sideways for a
long line of code (`.diff .card-body`). **A click on it opens the whole change in VS Code's diff
editor** (`openDiff` → `vscode.diff`, asked for):
the two sides are built from the card's own text by `diffSides` (leaf, under test) — `-` lines
before, `+` lines after, context in both, a `⋯` line in both where one hunk ends and the next
begins — and opened like `openText`'s, read-only plain text. Not the file on disk: it may have
changed since, and the card is what the agent did. `---` / `+++` count as a file header only as a
pair outside a hunk: Claude Code's Edit has no hunk, and a removed SQL comment `-- x` arrives as
`--- x`. **Neither opens on a click that ends a selection, on the copy button, or on the first
click of a double or triple click** (`onPlainClick`): that click arrives before the word or line
is selected, so testing the selection then opened a tab — taking focus — under someone selecting
a word to copy (#408). The open waits 300 ms and is dropped if another click or a selection comes.
Those blocks are darker than a
code block, the IN / OUT label in a column of its own, after Claude Code's panel. What the user opened or closed is remembered
per row until the chat changes (#346). Clicking a prompt folds or unfolds it — but not a click
that ends a text selection, and the prompt is not rebuilt for it, or the next post (every 40 ms
while a reply streams) took the selection away.

**Rendering is keyed.** Each entry's DOM is rebuilt only when its JSON (or its open state)
changes; a streaming reply rewrites one row many times a second, and rebuilding the thread each
time lost the reader's selection and scroll position. Rows belong to turns, a turn being a user
entry and what follows it; entries before the first prompt (a notice) form a turn of their own.
**A row a pointer is pressed in is not rebuilt until the press ends** (`pressedRow`): a running
command's row changes with every chunk of output, and a rebuild between press and release lost
the click — 0 of 10 landed at a post every 40 ms (#410). It keeps its old signature, so it is
rebuilt right after the click (`pressEnded`). **The signature carries "Fold Tool Calls" too**, or
the rows already on screen kept the old setting until another chat was shown (#411).

**An MCP call's IN and OUT show three lines and nothing more** (asked for — "if they need it they
click and look in the file"): `ioLines` in `chat.ts` and `--io-lines` in `chat.css`, which must
say the same. Only those lines are put in the page, each cut at 1 000 characters (`capLine`) —
a tool's output can run to megabytes — and the block is that tall with no scroll; a cut block
fades at its foot and says "N more lines" (`cutHint`, `.io-more`), and a click opens the whole
text in a tab, as copying copies it. Two details cost a measurement: the `pre` is `content-box`,
so the height is three lines *without* the padding (with it, almost a fourth line showed), and it
is cut with `overflow: clip` at the content box, or the next wrapped line peeked into the bottom
padding. **A command card shows three lines of each half too** (asked for, after it went on
showing the whole of both): the command's first three, cut and faded the same way, with "N more
lines"; the output's **last** three — its newest, where a run's result is — one line each,
scrolled sideways rather than wrapped, since a wrapped last line would be the part cut off, with
"N earlier lines" at its top right and a fade at its top (`.cut-above`). A click opens either
whole in a tab, as before.

**Copy goes through the host** (`{ type: 'copy' }` → `env.clipboard`): `navigator.clipboard` in
a webview depends on the host granting it.

**Testing the look in headless Chrome has two traps**, both of which look exactly like real bugs:
it will not make a window narrower than 500 px (`--window-size` silently crops the screenshot, so
set `html { width: 340px }` instead), and **`--virtual-time-budget` freezes CSS transitions and
animations** at their first frame — the Stop button rendered as a blank light disc and the model
menu at half opacity until `* { transition: none !important; animation: none !important }` was
added to the harness. Measure with `getComputedStyle` before believing a colour.

**History, usage and the menus are drawn inside the view**, never as a QuickPick or a modal:
anything that overlays the workbench can pause a browser tab
([A notification pauses the built-in browser](#a-notification-pauses-the-built-in-browser)).
The file picker is the one exception — a native OS dialog, which the overlay manager does not
see. Popups are positioned relative to `#app`, not the window. A panel drawn over the chat (History, Agents, Agent
apps) has a back arrow before its title and a close button at the right, both closing it
(`panelHead`) — asked for, since a back arrow at the top left is where a side bar is expected to
have one. An agent's card keeps its own arrow, which goes back to the list.

**Nothing from a model or a page is parsed as HTML.** `preview-src/chat.ts` has its own small
Markdown reader (fences, headings, lists, quotes, tables, rules, paragraphs, inline code, bold,
italics, links) that builds nodes and sets `textContent`. Links are spans the host is asked to
open, never `<a href>` — a click in a webview would navigate the view itself; see the Markdown
reader above. The CSP is the panel's
minus `frame-src`, plus `img-src data:` for screenshot thumbnails, and `'nonce-…'` in `style-src`
for xterm's own `<style>` elements (see [Terminal tabs](#the-webview-xterm-under-the-chats-csp)).

**The host owns the state; the webview renders it.** Every change posts a whole
`ChatViewState`, coalesced to one post per 40 ms while text streams. **A post sent before the
webview's script says `ready` is lost**, not queued by VS Code, so `_postMessage` holds
non-state messages until then — a title-bar command reveals a view that was never opened and
posts in the same breath.

### View modes: Minimal, Compact, Standard

Asked for, replacing the Compact switch: **View Mode** in the approval menu's foot, the setting
`aiBrowser.chat.viewMode` (`ChatViewMode` in the protocol). **Standard** is what Compact off was —
every tool call unfolded; **Compact** what Compact on was — every call folded, the default;
**Minimal** shows only the prompts and the replies.

- **Minimal folds a turn's work under one line below its prompt** (`renderSummary`): "2 tool
  calls · 1 agent · 3 thoughts · 1 approval · ↑ 35k ↓ 812", a chevron before it. A click opens
  that turn as Compact shows it and another folds it back (`turn:<prompt index>` in `toggled`, so
  per chat, as a row's own choice is). The work is tool calls, agents, thinking and **answered**
  approvals (`isBackground`); replies, notices, errors and a question still waiting stay in view —
  a pending card must be answerable. A turn with no work has no line.
- **While the turn runs, a second line names the latest piece of work** — the way its own row
  would title it ("Running `npm run lint`", "Thinking", "Read README.md") — and the next replaces
  it; it goes when the turn ends or the turn is opened. **Plain colour, never the shimmer**:
  `background-clip: text` drew nothing inside the line's ellipsis-clipping parent, so only the
  icon showed (#360's trap, met again in harness). File names there are labels, not links.
- **The rows are still rendered and hidden by class** (`.turn.minimal-folded .row.background`),
  so opening a turn is instant and keyed rendering is untouched; the timeline's connecting line
  is switched off in a folded turn, where hidden rows left it running to nothing. The summary's
  button is built once and its text set in place (#365).
- **The setting is read with `inspect`** (`readViewMode`): `get` answers the declared default and
  would hide the older `aiBrowser.chat.collapseToolCalls`, which is still read while View Mode is
  unset — `false` as Standard, anything else Compact — so nobody's choice changed. A value outside
  the three is not a choice. The menu writes `viewMode` (`setViewMode` → `_setViewMode`) where it
  is in force: the workspace when a workspace value of either setting would shadow a user one.

### The two protocols — measured, not documented

Neither protocol is public. Everything below was read from live CLIs — Claude Code 2.1.301 and
codex-cli 0.145.0, on 2026-10-16 — and everything that interprets their output is in
[src/chat/agentProtocol.ts](src/chat/agentProtocol.ts), a leaf module under test. **The tests run on recorded
samples of those answers, so they guard the readers against our own edits, not against a CLI
release** — a field a new CLI renames still passes `npm test` and shows up as an empty dropdown.
After an update of either CLI, re-measure (the probes under "Verified how" are the recipe) and
refresh the samples.

| | Claude Code | Codex |
|---|---|---|
| launch | `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` | `codex app-server` |
| shape | one process per conversation; a turn is `{type:'user', message}` on stdin | one process per window, a `thread` per conversation, JSON-RPC 2.0 |
| side channel | `control_request` / `control_response`, correlated by `request_id` | ordinary requests |
| models | `initialize` → `models[]`: `value`, `displayName`, `supportsEffort`, `supportedEffortLevels` | `model/list` → `supportedReasoningEfforts[]`, `defaultReasoningEffort`, `isDefault`, `hidden` |
| plan usage | `get_usage` → `rate_limits.limits[]` (`percent` 0–100, `resets_at` ISO), `subscription_type` | `account/rateLimits/read` → `primary` / `secondary` (`usedPercent`, `windowDurationMins`, `resetsAt` in seconds) |
| live usage | a `rate_limit_event` after a turn's first model request — not before it, and not on every turn | `account/rateLimits/updated`, a sparse update |
| text | `stream_event` / `content_block_delta` / `text_delta` | `item/agentMessage/delta` |
| tokens | `result.usage`, **per turn** | `thread/tokenUsage/updated.total`, **for the thread** |
| model / effort | launch flags `--model`, `--effort` | parameters of each `turn/start` |
| more input mid-turn | another user line — taken into the turn, or answered by a turn of its own; see the queue below | `turn/steer` with `expectedTurnId` |
| stop | `control_request` `interrupt` | `turn/interrupt` |
| resume | `--resume <session_id>` | `thread/resume` |
| context in use | the main agent's `assistant` message `usage`: input + both cache halves + output | `thread/tokenUsage/updated.last.totalTokens` |
| context window | `result.modelUsage[<model>].contextWindow` | `thread/tokenUsage/updated.modelContextWindow` |
| compacting | the message `/compact`; `system` `compact_boundary` reports it | `thread/compact/start`, run as a turn with a `contextCompaction` item |

Each of these cost a measurement and each would be wrong if guessed:

- **`result.total_cost_usd` is for the whole process, the tokens are for the turn.** Two equal
  turns in one process reported cost 0.0018 then 0.0037, and the same token counts each time.
  `ClaudeSession` turns the cost into a per-turn difference. **A process started with
  `--resume` does not count from zero**: it restores the session's cost ledger from the
  transcript (measured: its first turn reported 0.0039 where the turn cost about 0.0018, even
  after the previous process was ended with SIGTERM). So a resumed process's baseline is the
  session's cost so far — passed in as `priorCostUsd` for a chat reopened from the history — and a
  figure below the baseline, a ledger that was not restored, is taken as the turn's own.
- **`rate_limit_event` reports `utilization` as a fraction, `get_usage` as a percentage** — 0.06
  against 6 for the same window. Read with one scale for both and every bar is 0% or 600%.
- **Text comes from the deltas only.** With `--include-partial-messages` the complete
  `assistant` message repeats the same text; it is read only for its `tool_use` blocks.
  A sub-agent's stream carries `parent_tool_use_id` and is not the reply.
- **`initialize` is not needed before a turn**, but it is how the model list is had without
  spending one, so detection runs a short-lived process that sends `initialize` and exits.
- **A model or effort change restarts Claude with `--resume`, and the conversation survives.**
  Measured: a session told to remember a word on Haiku answered it after a switch to Sonnet 5,
  under the same session id. The restart waits for the turn to end; a change made mid-turn takes
  effect at the next message.
- **A thread another Codex holds cannot be resumed**: `thread/resume` fails with "thread … already has an active writer" while, say, `codex resume` in a terminal has it open. `CodexSession._thread` then calls `thread/fork` (same settings), switches the chat to the copy's id (a `session` event) and says so in a notice. **Not measured end to end**: the error text is from a user report; the fork's shape is from the 0.162 schema.
- **Codex's `turn/start` answers before the turn ends**; the end is `turn/completed` with
  `status` `completed` / `failed` / `interrupted`. Stop took about 15 ms on both agents.
- **Codex's own schema can be generated from the installed binary:**
  `codex app-server generate-json-schema --out <dir>`. Read it before guessing a field — it is
  how the shapes above were found, including `item/tool/call` and `dynamicTools`, which are how
  our browser tools will reach Codex without MCP.
- **Tool calls and their results are separate messages, matched by id.** Claude: a `tool_use`
  block in an `assistant` message, then a `tool_result` block with the same `tool_use_id` in a
  `user` message (`is_error` for a failure). A failed Bash result's text starts with Claude
  Code's own `Exit code N` line, which is taken off into the exit code. Codex: `item/started`,
  then `item/commandExecution/outputDelta` while it runs, then `item/completed` with
  `aggregatedOutput`, `exitCode` and `status` (`completed` / `failed` / `declined`).
- **A Codex `fileChange` of kind `add` or `delete` may carry the file's content, not a patch.**
  Codex's own session log keeps an added file as `content`; read as a diff, unmarked lines are
  context, so the card showed a new file as unchanged (`+0`) and its diff tab as two equal sides.
  `changeDiff` marks every line `+` (add) or `-` (delete) — but only when the text does not
  already read as a unified diff (`@@`, `diff --git`, `---`), so a patch is left alone. **Not
  measured against the app-server's own `add` yet**; re-measure with a turn that creates a file.
- **Codex reports a command wrapped in its shell** — `/bin/zsh -lc 'echo hi && cat a.txt'` — and
  `unwrapShell` takes the wrapper off. It also sends `commandActions` (`read` with a name,
  `listFiles`, `search`), which become the row's summary ("Listed files, Read a.txt").
- **Each Codex `agentMessage` item is its own block.** A turn sends a short commentary ("I'll run
  both commands…") and then the final answer as two items; run together they read as one
  sentence. `item/started` for an agent message is a `textBreak`; for Claude a new `text`
  content block is.
- **Reasoning is off unless asked for, on both.** Claude streams no `thinking` block at all
  without `--thinking-display summarized` (measured on Sonnet 5.5, and on Haiku 4.5, which has
  no adaptive thinking and still takes the flag); then it arrives as `thinking_delta`. Codex sends
  an empty `reasoning` item unless `turn/start` carries `summary: 'auto'`; then it streams
  `item/reasoning/summaryTextDelta`, a new `summaryPartAdded` index being a new paragraph.
- **Claude's usage method is marked as unstable by Claude Code itself** — its SDK names it
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`. `claudeUsage` reads two shapes and
  reports an error rather than throwing on a third.

### Gemini CLI over ACP

The third agent. **Driven over ACP, the Agent Client Protocol: `gemini --acp`**, JSON-RPC 2.0
one object per line — the protocol Zed and the other ACP clients use. The readers are the
*gemini* section of `agentProtocol.ts` (under test, on samples recorded from gemini-cli 0.64.0
on 2026-10-20), the process and the session [src/chat/geminiAgent.ts](src/chat/geminiAgent.ts).
Verified end to end against the real CLI through the compiled backend and a stubbed `vscode`:
detection (~450 ms), a turn calling an injected MCP server and a shell command, a message queued
behind a turn, Stop mid-reply, Stop during the start, a conversation reopened with
`session/load`, a denied command — and no `gemini` process left after any of them.

**Not the "Gemini CLI Companion" extension.** `Google.gemini-cli-vscode-ide-companion` is no
chat and carries no CLI: it runs a loopback MCP server through which a `gemini` started in a
terminal sees the open files and shows diffs. It registers no command another extension could
hand a file to, so there is no "Add Element to Gemini" — the chat is the only way in. It is
also why `extensionIds.gemini` in `agentBinary.ts` is `undefined`.

| | Gemini CLI |
|---|---|
| launch | `gemini --acp [--skip-trust]`, env `GEMINI_CLI_NO_RELAUNCH=true`, the binary's folder first on `PATH` |
| shape | one process per conversation; `initialize`, then `session/new { cwd, mcpServers }` or `session/load { sessionId, cwd, mcpServers }`, then `session/prompt` per turn |
| models | `session/new` → `models.availableModels[{ modelId, name, description }]`, `currentModelId` (`auto`); **no efforts** over ACP |
| model change | `session/set_model` on the live session, no restart |
| text / thinking | `session/update`: `agent_message_chunk`, `agent_thought_chunk` (a whole thought, `**Subject**\nbody`) |
| tools | `tool_call` (`kind` read / edit / execute / search / fetch / other, `title`, `locations`, `content` with `{ type: 'diff', path, oldText, newText }`), then `tool_call_update` |
| approval | request `session/request_permission { toolCall, options }`, answered `{ outcome: { outcome: 'selected', optionId } }` |
| tokens | `session/prompt`'s answer: `usage { inputTokens, cachedReadTokens, outputTokens, thoughtTokens }`, **per turn** |
| context | `usage_update { used, size }` after each request |
| commands | `available_commands_update`, right after `session/new`: six built-ins |
| stop | notification `session/cancel`; the prompt answers `stopReason: 'cancelled'` |
| plan usage | none over ACP — the `U` popup says so |

Each of these cost a measurement:

- **`gemini` relaunches itself, and both processes ignore SIGTERM.** The npm binary starts a
  child `node --max-old-space-size=…`, and a SIGTERM to the one spawned left both running
  (measured). `GEMINI_CLI_NO_RELAUNCH=true` keeps it to one process, which SIGTERM ends;
  closing stdin ends it too (`JsonLineProcess.endInput`), which is what `dispose` does first.
- **The npm install is a `#!/usr/bin/env node` script**, and VS Code started from the Dock has
  no nvm `node` on its `PATH`. The binary's folder goes first on `PATH` for the chat's process
  and for `--version` (in `agentBinary.ts`, for every agent — harmless for native binaries), and
  the search looks in each `~/.nvm/versions/node/*/bin` and `~/.npm-global/bin`. Checked with
  `PATH=/usr/bin:/bin`: found, version read.
- **A second `session/prompt` during a turn aborts the first** (read in its source:
  `pendingPrompt?.abort()`), so there is no steering. A message sent while Gemini works waits in
  `GeminiSession._queue` and goes as a turn of its own the moment the running one ends,
  announced with `autoTurn` — the shape `ChatTab` already has for Claude Code's messages
  answered by a turn of their own, so a Gemini mid-turn message takes the `_waiting` path. It
  never takes the *tool-boundary* flush, which is Claude Code's alone: Gemini never folds a
  message into a running turn. Stop ends the running turn only; the queue still goes, as for
  Claude Code.
- **In a folder Gemini does not trust, the MCP servers handed to `session/new` are never
  connected** — measured: no request reached the server, and the model answered that the tool
  did not exist. Its project settings, commands and hooks are not loaded there either.
  So trust is decided per process, and there are three answers (`Trust` in `geminiAgent.ts`):
  - **a folder the user picked** — `--skip-trust`, trusted for that process only. Picking it is
    the consent, as it is for Claude Code; every feature works at once, nothing is asked, and
    Gemini's own registry is not written.
  - **a repository fetched from GitHub and not trusted yet** — trust **forbidden** with
    `GEMINI_CLI_TRUST_WORKSPACE=false`, which Gemini reads before its registry. Leaving the flag
    out was not enough, and that was a hole: the clone sits under the home directory, and a home
    trusted in Gemini covers it, so its hooks loaded. Measured after the fix: a held-back session
    in a folder Gemini trusts connected no MCP server. The tab says so once (`_warnedUntrusted`);
    the folder button's "Trust this repository's settings…" restarts the session
    (`restartSession` covers Gemini — trust is decided at the process's start).
  - **Gemini's own verdict** — only for `geminiTrustsFolder` (below).
- **Detection's probe forbids trust** too, so listing models loads nothing of the folder's own
  configuration. `session/new` answers the models without a prompt, so detection costs nothing.
- **Whether Gemini trusts a folder is asked of Gemini** (`geminiTrustsFolder`): ACP has no such
  question, but `session/set_mode` to `autoEdit` is refused in an untrusted folder with
  "Cannot enable privileged approval modes in an untrusted folder" (`error.data.details`), and
  accepted in a trusted one — measured both ways, ~450 ms, no prompt, the mode put back to
  `default`. Its rules — a parent's entry, VS Code's workspace trust when the companion is
  connected, the environment — are Gemini's to apply, so nothing of them is re-implemented.
- **Signed out is `session/new` refused with JSON-RPC -32000** ("Gemini API key is missing or
  not configured", measured with an empty `HOME`). The CLI keeps an API key it was given in the
  OS keychain, so a missing `GEMINI_API_KEY` in the environment does not mean signed out.
- **A shell command's output is never sent**: `run_shell_command` completes with empty
  `content`, and the `content` it starts with is `[current working directory …] (description)`,
  which becomes the row's summary, not its output. A failed command's text is the reason
  ("… was canceled by the user"), and is shown.
- **A read's `title` is a path relative to the extension host's directory**
  (`../../private/tmp/…`), so the row names `locations[0].path` instead.
- **An edit carries whole files** (`oldText` / `newText`, `null` for a new file); `geminiDiff`
  turns each into one unified hunk — shared lines at both ends left out — for the card's counts
  and for `diffSides`.
- **An MCP call is told by its kind and its call id, never by its title alone**
  (`geminiMcpCall`). The title is what the model can write: a shell command is titled by the
  command and an MCP tool with a `command` argument by that, so `rm -rf ~ # (ai-browser MCP
  Server)` once read as the browser and skipped Terminal's rule (breaks-silently #511). An MCP
  tool is `kind: 'other'` and its id is `<registered name>__call_<n>` (or `<name>-<ms>-<n>`)
  with the name `mcp_<server>_<tool>`, which only Gemini writes. The title then splits that
  name, and only when it agrees with it: `<tool> (<server> MCP Server)` with no arguments,
  `<tool>(<args>)` with them, the server being what the id leaves; our own tools are
  recognised by their `browser_` / `editor_` names. A name that cannot be split is asked under
  Other tools. `ai-browser` is the AI Browser category, as for the other two.
- **There is no "deny and go on"**: Reject (`cancel`) and the request's `cancelled` outcome both
  reach the model as the tool cancelled by the user, and the turn carries on (measured). Allow
  is always `proceed_once`, never an "always" option: the approval menu keeps that choice.
- **Stop answers the open questions itself.** ACP leaves it to the client to answer pending
  permission requests as `cancelled` after `session/cancel`; without it the turn waited on them
  (measured: a Stop with a question open never ended).
- **`session/load` replays the conversation as updates**, which the chat already has, so they
  are dropped while it runs (`_replaying`). A session Gemini no longer has starts a new one with
  a notice rather than refusing the message.
- **Commands**: over ACP, Gemini 0.64 handles only its built-ins; custom `.toml` commands and
  skills are not (read in its source), so the palette lists the top-level built-ins and leaves
  out `/restore`, which resets the conversation under a chat that does not know.
- **Gemini is an MCP client kind of its own** (`ClientKind` `gemini`): it introduces itself
  as `gemini-cli-mcp-client` (measured on a real session; `gemini mcp list` says
  `mcp-test-client`, which stays `other`). So "Share Tab with Gemini CLI" binds both a `gemini`
  in a terminal and the chat's own Gemini, and a tab given to Claude Code or Codex binds neither.
  Its share glyph is never written into a page, so it is kept out of `stripMarker`'s set.
- **Not built for Gemini**: commit messages, branch names and titles (`generateCommitMessage`,
  `generateTitle` — Chat Settings does not offer it, and **Auto** on a Gemini tab runs them on
  Claude Code or Codex instead: `featureAgent` in `featureAi.ts`, shared by host and view, so the
  button names the agent that will run — breaks-silently #513), compacting (`/compress` is not handled
  over ACP, so the pie is not clickable), `--add-dir` references (`readDirs` is ignored), the
  element hand-over (no command to take one, see above) and "Copy Recording Prompt" for it.

#### When Gemini fails, the chat says what to do

Every failure reaches the user as a sentence with a next step, and each one was produced
against the real CLI (gemini-cli 0.64) through the compiled backend:

| Failure | How it arrives | What the chat says |
|---|---|---|
| not signed in | `session/new` → -32000 "Gemini API key is missing…" (empty `HOME`) | not signed in; sign in with **Open Gemini CLI in Terminal**, then Refresh Agents / send again |
| unknown or unavailable model | `session/set_model` accepts anything; the prompt fails with **500** "models/… is not found" | this model is not available to your account; pick another |
| rate limit or quota | the prompt fails with **429**, always as "Rate limit exceeded. Try again later." — `acpSession.ts` rewrites every 429, the day's quota (`TerminalQuotaError`) included | wait and send again; if it keeps failing the day's quota may be spent, pick another model |
| model quota used up | *read in 0.64, not produced*: a 499 / 503 whose text matches Gemini's own `TerminalQuotaError` test (`exhausted your capacity`, `capacity exceeded`, `MODEL_CAPACITY_EXHAUSTED`), often with "Your quota will reset after …" | the quota for this model is used up (until it resets after …); pick another model |
| context full | *read, not produced*: `stopReason: "max_tokens"`, which 0.64 sends for `ContextWindowWillOverflow` — **not** the output limit, as this table's code once said | the conversation no longer fits the context window; start a new chat |
| turn limit or loop | *read, not produced*: `stopReason: "max_turn_requests"`, for `MaxSessionTurns` and `LoopDetected` alike | limit reached or the model repeating itself; send again, rephrase, or another model |
| fatal exit 41 / 52 / 55 | *read, not produced*: `FatalAuthenticationError`, `FatalConfigError`, `FatalUntrustedWorkspaceError` in 0.64's core | not signed in / its settings cannot be read / the folder is not trusted — each with where to fix it |
| 401 / 403, 400, 5xx | the prompt fails with the HTTP status | refused (access) / invalid / service failed — with the next step |
| Gemini's own refusal | -32603 "Internal error", the real text in `data.details` | the details, never "Internal error" |
| no `node` for the npm script | exit 127 "env: node: No such file or directory" (`PATH=/usr/bin:/bin`) | needs Node.js 20+; install it or set `aiBrowser.chat.geminiPath` |
| process ended mid-turn | the exit, from `JsonLineProcess` (SIGKILL in the test) | Gemini CLI stopped; the next message starts it again and resumes |
| messages waiting behind that turn | `GeminiSession` queue | each refused: "Not sent: … Send it again." — shown with the message, never as sent |
| empty or blocked response | Gemini ends it as an ordinary `end_turn` (read in its source) | ended the turn without a reply; send again, rephrase, or another model |
| a model that does not answer | nothing at all: Gemini retries the request itself, up to 10 times at ~60 s each (`fetch failed sending request`, visible only with `--debug`); measured 2026-10-20 with `gemini-3.8-flash`, which Auto picks, while `gemini-3-flash-preview` answered in 8 s | after 45 s with no update (`silenceNoticeMs`): it may be retrying silently; wait, or Stop and pick a model by name |

The silent case is also said up front: **the Gemini model menu carries a note in the chart
orange** (`openMenu`'s `note`, `.menu-note`) that not every listed model may work for the
account, for reasons outside AI Browser, and to pick another if no reply comes (asked for).

`geminiErrorText` / `geminiExitText` in `agentProtocol.ts` hold the wording (tested); `userError`
in `geminiAgent.ts` routes every `RpcError` through them. **A queued message that never went
out is refused, not resolved `false`**, and `ChatTab.send` moves its waiting entry into the
conversation before the error: left in `_waiting`, the flush after the turn put it in later,
below the error, reading as sent. Connect's trust probe tells **signed out** apart too
(`GeminiFolderState`), and its modal then says to sign in in the terminal it opens; a probe that
gets no answer at all (`unknown`) still offers the terminal, where Gemini shows its own reason.

#### What Gemini Code Assist does, and what was taken from it

Google's own extension (`Google.geminicodeassist` 2.104.0, read 2026-10-21, nothing run) was
studied for ways of driving Gemini we lack. **It has no private channel**: its agent mode is
gemini-cli's **A2A server** (`@google/gemini-cli-a2a-server`, core 0.53 inside it), started with
VS Code's own node (`ELECTRON_RUN_AS_NODE=1`) and spoken to over loopback HTTP by its Go language
server `cloudcode_cli`. Its A2A commands are the same four built-ins ACP lists (`init`,
`memory`, `restore`, `extensions`); custom `.toml` commands and skills are absent on both. Its
environment variables (`GEMINI_FOLDER_TRUST`, `CHECKPOINTING`, `CUSTOM_IGNORE_FILE_PATHS` for
`.aiexclude`, `GEMINI_YOLO_MODE`, `USE_CCPA`) are read by the A2A server only — **none of them
appears in the 0.64 CLI bundle**, so setting them for `gemini --acp` does nothing. Our
`GEMINI_CLI_TRUST_WORKSPACE` stays the way. (Its `GEMINI_IPC_SECRET` is generated and never
checked by the server.)

Taken: the quota and exit-code wording, the corrected stop reasons above, and the model Auto
chose (below).

**`SURFACE` was taken and then removed** — Gemini Code Assist sets it to `vscode`, and it
looked like a telemetry label. In 0.64 it is also the User-Agent of every model request
(`createContentGenerator` → `determineSurface2`): unset, a `gemini` started from the extension
host sees `VSCODE_PID` (present in every VS Code process, checked with `ps eww`) and sends
`CloudCodeVSCode/… (aidev_client; …; proxy_client=geminicli)`; set to anything else it sends
`GeminiCLI/<version>/<model> (…; <surface>)`. The model list was the same both ways, but what
the service does differently per client is unmeasured, so the chat leaves it unset and keeps
the identity it always had. Do not add it back without measuring quotas and model access on a
real account.

**Deliberately not taken**, each for a reason found in 0.64's source:

- **Gemini's own "always" options** (`proceed_always` "Allow for this session",
  `proceed_always_tool` / `_server` for MCP). Answering one makes Gemini stop asking for that
  tool for the rest of the process, so a later change of the approval menu back to Ask or Deny
  would not reach it. The menu is the one authority; `geminiApprovalAnswer` keeps answering
  `proceed_once`.
- **Plan mode** (`session/set_mode` `plan`, offered by `session/new`). It is not "read-only":
  `plan.toml` denies every tool by default and asks about MCP tools only with a
  `readOnlyHint`, so the browser tools stop working, and it brings its own
  `enter_plan_mode` / `exit_plan_mode` workflow. Our Deny already refuses writes per category.
- **The A2A server itself**: a second package to pin, a port and a secret, an older core, and
  nothing ACP lacks but MCP server status, the tool list and `userTier`.
- **Deleting `~/.gemini/oauth_creds.json` on exit 41**, which Gemini Code Assist does: they are
  the user's own credentials.
- **Progress heartbeats on long MCP tools** (their `openFileDiff` sends `notifications/message`
  every second): our MCP server answers on one POST with no stream, so there is nothing to send
  them on.

**Worth measuring next: the IDE companion protocol.** `GEMINI_CLI_IDE_SERVER_PORT` /
`GEMINI_CLI_IDE_AUTH_TOKEN` give Gemini the open files, cursor and selection
(`ide/contextUpdate`) and an editable diff in VS Code (`openDiff` → `ide/diffAccepted` with the
user's edits) — something none of the three agents has here. In 0.64 `ideMode` comes from the
`ide.enabled` setting and is not forced off under `--acp`, but whether it works there is
unmeasured.

**What Auto chose is shown.** `session/prompt`'s answer carries `_meta.quota.model_usage`, the
model each request of the turn ran on (measured on 0.64:
`[{ model: "gemini-3-flash-preview", token_count: { input_tokens, output_tokens } }]`), and it is
the only place Auto's choice is reported. `geminiTurnEnd(result, chosen)` passes the names on
the `tokens` event only when they are not the model picked in the chat, `ChatTab` puts them on
the prompt (`UserEntry.models`) at the turn's end, and the view writes them beside "Worked for
…" (`.worked-model`). A turn on a named model shows nothing extra. The Auto case itself is not
measured: on this account Auto's pick did not answer (the silent-retry row above).

#### Connect Gemini CLI

For a `gemini` the user runs in a terminal; the chat's own Gemini is handed the server at every
start and needs none of it. `aiBrowser.connectGemini` writes the project
**`.gemini/settings.json`**: `mcpServers.ai-browser = { httpUrl, headers: { Authorization } }` —
`httpUrl` is Gemini's streamable HTTP, `url` there is SSE. Checked with `gemini mcp list`, which
reports the entry `Connected` with our header. It is in the status bar menu, the palette, and a
"Gemini CLI ▸" submenu of the dropdown (`aiBrowser.geminiMenu`, `3_assistant@2.5`: Connect,
Share Tab); not in `0_start`, which stays the two assistants most people have.

- **The Codex project writer's rules, because it is the same token in the repository**:
  refused in Restricted Mode (the checks run git), through a symlink in the workspace
  (`.gemini`, `.gemini/settings.json`, `.gemini/.gitignore`), and for a file git tracks — a team
  committing `.gemini/settings.json` would commit the token. A `.gemini/.gitignore` naming
  `settings.json` goes in first (`keepTokenOutOfGit(folder, '.gemini', 'settings.json')`,
  `ignoresFile` / `withFileRule` in `gitignoreRule.ts`, generalised from the `config.toml` ones),
  and `git check-ignore` has the last word.
- **Refused when the workspace is the home directory** (`geminiProjectIsGlobal`): there
  `.gemini/settings.json` is Gemini's *user* settings, loaded in every project, so the entry would
  hand this window's token to every `gemini` on the machine (breaks-silently #512). No `gemini mcp
  add` fallback either — at `~` its project scope is the same file — and the repair passes it over.
- **The rest of the file is kept**, every setting and every other server; it is the user's whole
  Gemini configuration for the project, not an MCP file. **A file with comments is refused**:
  Gemini reads settings with comments allowed, `JSON.parse` does not, and rebuilding such a file
  would drop them with everything around. The `gemini mcp add --scope project --transport http
  … --header "Authorization: Bearer …"` command goes on the clipboard instead (checked against
  `gemini mcp add --help`, 0.64).
- **The startup repair covers it** (`repairGeminiJson`, the `.mcp.json` repair with `httpUrl` for
  `url`): our entry is found by its token, moved to the new port, never created. `url` and
  `type` are dropped from our own entry, since a server has one address. A file with comments is
  left alone. `claudeEntryIsOurs` and `claudeEntryCarriesToken` read `httpUrl` too, and still
  agree.
- **Check Connection reports it** (`geminiClientState`) and lists Gemini among recent callers; it
  offers "Connect Gemini CLI" only for an entry that is there and wrong, not for none.
- **The step after the write is semi-automatic** (`finishGeminiConnect`). Gemini reads a
  project's settings — and connects its MCP servers — only in a folder it trusts, and only when
  it starts, so the file just written can be ignored in silence. Gemini is asked
  (`geminiTrustsFolder`, under `ProgressLocation.Window`), and the modal says what is left:
  untrusted — "Gemini CLI does not trust this folder yet…", a terminal will open, choose
  "Trust folder" there, then paste; trusted or unknown — paste, after starting `gemini` here.
  Either way one button, **Open Gemini CLI Here**, opens it.
- **The decision is made in Gemini's own trust question, never by writing its registry.** That
  question lists what the folder brings (commands, MCP servers, hooks, skills), records the
  answer in `~/.gemini/trustedFolders.json`, and restarts Gemini with them loaded (read in its
  `FolderTrustDialog`). Writing that file ourselves was the alternative and was rejected: it is
  Gemini's format (keys are normalised — the live file holds `/users/m5` lower-cased), a
  malformed one stops `gemini` starting anywhere (`FatalConfigError`), and the consent would be
  in our words instead of Gemini's.
- **The terminal runs the binary itself** (`openGeminiTerminal`: `createTerminal` with
  `shellPath` = the `gemini` found by `chooseAgentBinary`, its folder first on `PATH`), so
  nothing is typed into a shell and no path is quoted; it closes when `gemini` exits. The
  companion extension's terminal variables reach it like any terminal's. **Open Gemini CLI in
  Terminal** (`aiBrowser.openGeminiCli`, palette and the Gemini submenu) does the same on its
  own, in the window's folder; refused in a remote window, where the binary is on this machine.

### OpenRouter: an HTTP API and our own agent loop

The fifth agent (`openrouter`) is **not a CLI**: OpenRouter is an OpenAI-compatible HTTP API (`/chat/completions`
with SSE and tool calling), so the conversation loop is ours, in-process:
[src/chat/openrouterAgent.ts](src/chat/openrouterAgent.ts) (the backend and session, `vscode` allowed) and the leaf
[src/chat/openrouterProtocol.ts](src/chat/openrouterProtocol.ts) (SSE parser, chunk assembly, errors, retries, tool
mapping, message building, the model and endpoint rules; under test), with `openrouterApproval` in `agentProtocol.ts`.
The key and the models are set in **Chat Settings → OpenRouter** ([below](#openrouter-settings-the-key-the-models-the-catalogue)).
**Nothing was measured against the live service** (no key was available): the shapes follow OpenAI's format and
OpenRouter's documented differences, and the agent was run against a fake OpenAI-compatible server and a fake MCP
server on loopback — `node scripts/test-openrouter.mjs` after `npm run build-ext` (12 scenarios; it stubs `vscode`).

**What it is not: it has no shell, no file reading and no file editing.** Its tools are this window's own MCP server's —
browser, editor, chat (and terminals pinned to its conversation) — and nothing else. A task that needs the files or a
command belongs to Claude Code, Codex or Gemini. Do not add built-in shell or file tools here without a decision
about their approvals.

- **Where things live.** The key: SecretStorage `aiBrowser.openrouter.apiKey`, read through an injected accessor for each
  request and kept in no field — never in a setting, an argument, a log line, an event, a state post or the webview; the
  only place it goes is the `Authorization` header to the endpoint. The models: `globalState` `aiBrowser.openrouter.models`,
  an array of `{ id, name?, maxTokens?, temperature?, reasoning?: 'low'|'medium'|'high', tools?, images? }`, **validated on
  every read** (`readOpenRouterModels`: at most 100, a bad or repeated entry dropped, never repaired). A model with
  `reasoning` offers low/medium/high in the effort slider and sends `reasoning: { effort }`. `tools: false` sends no tools
  for that model; `images: true` is required before an image goes out as an `image_url` data URL (otherwise the text says
  an image was attached and not shown).
- **Detection** (`AgentRegistry._detectOpenRouter`) has no binary: no key is "not signed in" (the sentence the chat's
  credential-error rule recognises, with the next step), no models and a refused endpoint each say so. The backend is kept
  across detections so a Refresh does not end running conversations. The agent's pill says so; "Sign in" cannot run a CLI
  and says to store the key.
- **The endpoint** `aiBrowser.chat.openrouterEndpoint` is `application`-scoped and accepted only as https, or http on
  `localhost` / `127.x` / `::1`, with no credentials, query or fragment (`openrouterEndpoint`): the key is sent there.
- **The turn** (`OpenRouterSession._turn`): stream one completion (text and `reasoning` deltas as events, tool-call
  fragments assembled by `index`), and when the model calls tools run them and call again, **at most 25 model calls**,
  then a notice. Usage is summed over the turn into one `tokens` event (OpenRouter's `usage.cost` as `costUsd`, cached
  tokens from `prompt_tokens_details`); no context window is reported (the config does not carry one).
- **Retries are for 429 and 5xx only**, three times with 1, 2, 4 s (`Retry-After` honoured up to 30 s), and only before
  any of the stream was read. A 401 (bad key), 402 (credits), 404 (model), 403 and 400 each say what happened and the next
  step; a mid-stream `error` object is read the same way. No bytes for 90 s ends the request.
- **Stop** aborts the HTTP request (and a running tool call) through an `AbortController`. **A stop never leaves a
  `tool_call` without its answer**: the unanswered calls of that assistant message get a "Stopped by the user." result, or
  the API refuses the next request of the conversation. Messages sent mid-turn wait and go as a turn of their own,
  announced with `autoTurn`, as Gemini's do.
- **History is in memory** (`_messages`). A resumed conversation has no server session: the first send rebuilds it from the
  saved chat's prompts and replies (`entriesToMessages`, newest 400 000 characters, from a prompt on), through the injected
  `entries(ref)` — an open tab's chat first, then the history. **Tool calls are not replayed** (stored rows hold a cut copy
  of the output and a call without its result is refused by the API), so a resumed chat remembers what was said, not what
  the tools returned. The prompt being sent is already the saved chat's last entry; the unanswered trailing prompt is dropped
  from the rebuild so it is not sent twice. The `ref` is `or-<uuid>`.
- **The MCP client.** The session POSTs JSON-RPC to the window's own server (`BrowserServer` url, `Authorization: Bearer`,
  `X-AI-Browser-Chat: chatCapability(chatId)`, `Mcp-Session-Id` once issued — no `Origin`, which the server refuses):
  `initialize` (client name `ai-browser-openrouter`, classified `openrouter` by `classifyClient`, so a share to the
  OpenRouter assistant binds it), `notifications/initialized`, `tools/list`, then `tools/call`. A 404 on a known session
  starts the handshake once more (#178). With the server off the turn goes on without tools and says so.
- **Tool names are mapped, never trusted** (`mcpToolsToOpenAi`): the model gets sanitised, unique names (`[A-Za-z0-9_-]`,
  56 characters) and only those map back to the server's; a name the model invents is answered "Unknown tool" with no card
  and no server call. At most 128 tools, descriptions cut at 1 500.
- **Every tool call goes through the approval pipeline.** The session emits the same `approval` event the CLIs' requests
  become — classified by `ourToolClass`, which fails closed (`browser_*` / `editor_*` and the chat reads by name,
  `chat_*` actions as Chat control, `terminal_send` / `terminal_key` as Terminal with their one-shot grant, anything
  unlisted as Other tools) — and waits for `answer()`. Auto, Ask, Deny, the terminal grants and Always are the chat's,
  unchanged; a stop or a dispose withdraws a waiting card (`approvalDone`), a user's no is left as the chat recorded it.
- **Tool results are capped** at 20 000 code points (never inside a surrogate pair — a strict JSON reader refuses a lone
  half), with the cut said. Images in a result are not put in the tool message (text only); for a model with
  `images: true` the first four go in a user message after the results.
- **Not built:** a context window for the pie (the catalogue states `context_length`, but a configured model does not store
  it yet — the pie stays empty); titles, commit messages and compacting; the Chrome / Exchange surfaces' forms for it beyond
  the widened agent lists (the settings section is editor-only, below); a terminal tab or "continue in terminal" (no CLI).

#### Local models: Ollama, LM Studio, llama.cpp

The same agent and loop serve a server on this computer, because all three speak the OpenAI chat-completions format
(Ollama `http://localhost:11434/v1`, LM Studio `http://localhost:1234/v1`). **It is one more field on a model, not an
agent of its own**: `OpenRouterModel.endpoint` (`localEndpoint` in `openrouterProtocol.ts`, under test). Decisions:

- **Loopback only**, over http or https, no credentials, query or fragment — `localhost`, `127.x`, `::1`. A server on another
  machine is refused: the conversation would leave this computer for an address a stored model chose, and the rule that the
  key goes only to a checked endpoint is simplest to keep by never sending it to these at all.
- **The OpenRouter key is never sent to a model's own server** (`_complete`: `local ? undefined : apiKey()`). A model with no
  `endpoint` uses the `aiBrowser.chat.openrouterEndpoint` setting and the key as before.
- **A bad endpoint *setting* does not hide local models** (`models()` throws only when no model is local; `_start` checks the
  setting only for a model that uses it).
- **Chat Settings → OpenRouter**: the catalogue has a source select beside the search box — OpenRouter, Ollama, LM Studio, or
  another local address — and a model's form has a *Local server* field. The host's `catalog` action takes an optional
  `endpoint`, validated by `localEndpoint`. The reply echoes the typed `requestedEndpoint` even on validation errors, so the
  view matches it against the input without losing errors or results for a URL that normalizes (such as uppercase `LOCALHOST`).
  The separate `endpoint` is canonical and used when adding a model; it is also part of the catalogue render signature so Add
  buttons keep the correct server when two servers list the same ids. A local server's
  `/models` lists ids and nothing else, so adding from it (`modelFromCatalogItem(item, endpoint)`) assumes tools **on** and images
  **off**; the form's *Supports tools* switches it off for a model that calls tools badly. Small local models often do.
- **Unmeasured against a live Ollama or LM Studio**: `node scripts/test-openrouter.mjs` (scenario 13) uses a fake server. Check
  tool calling, `/models`' shape and the reasoning field on a real install before relying on it.

#### OpenRouter settings: the key, the models, the catalogue

A section of the chat's Chat Settings panel (tab **OpenRouter**, after Appearance), the way the user stores the key and
chooses the models. Files: the view in `preview-src/chat.ts` (`createOpenRouterSettings`, styles `.openrouter-*` in
`media/chat.css`), the host in `chatView.ts` (`_openrouterAction`, `_openrouterEntries`), the leaf
[src/chat/openrouterView.ts](src/chat/openrouterView.ts) (formatting and parsing for the view, read by the webview build
and `npm test`), the checks and the catalogue request in `openrouterProtocol.ts` (`validateOpenRouterKey`,
`validateOpenRouterModel(s)`, `readOpenRouterCatalog`, `searchOpenRouterCatalog`, `fetchOpenRouterCatalog`), tests in
`openrouterSettings.test.ts`.

- **Chat Settings has no Save button on any tab** (asked for): AI features and Video recording save themselves — a select at once, typed text (a system prompt, the maximum length) 700 ms after the last key (`scheduleFeatureSave`). A change made while a save is on its way goes in the next one (`featureSettingsAgain`); nothing is disabled while saving, and the answer never rewrites a field, or typing would be overwritten.
- **Every action is its own message and applies at once; there is no Save button** (the panel's own Save and status are
  hidden on this tab). One `ViewToHost` type, `openrouter`, with an `action` — `load`, `setKey`, `removeKey`,
  `saveModels` (the whole list), `catalog` — and one `HostToView` type, `openrouter`, that is always the *canonical*
  state: whether a key is stored, the models as saved, a `notice` or an `error`, and for a search the page of results.
  The view draws what is stored, never what it sent.
- **Editor-only.** `openrouter: editor(…)` in `commands.ts`: the key and the model list decide where prompts and the key
  go, so neither the Chrome side panel nor the Exchange website can send them (the readers do not produce the type, the
  table refuses it, and the view's `post` gate hides the tab where the control is not `on`). `commands.test.ts`'s golden
  forwarded lists are unchanged.
- **The key is write-only.** `setKey` carries it once, from a password field that is emptied before the message is posted;
  the host checks it (`validateOpenRouterKey`: one token of printable ASCII, 10–512 characters — **a refusal never contains
  the key**, a test asserts it), stores it in SecretStorage and posts only `keySet: boolean`. Replace stores over it, Remove
  deletes it. No state field, no log line and no error text carries it. **Unmeasured:** the real key format is only assumed
  to be ASCII without spaces (OpenRouter's are `sk-or-v1-…`).
- **The model list is replaced whole and validated in the host.** `validateOpenRouterModel`: an id of letters, digits and
  `. _ : / ~ + @ -`, up to 200 characters, starting with a letter, digit or `~` (so `vendor/model:free`, `~vendor/latest`);
  `maxTokens` a whole number 1–2 000 000; `temperature` 0–2; `reasoning` low/medium/high; `tools` / `images` booleans;
  absent or null means "not set". **A bad value is refused with a reason naming the model and the field, never clamped or
  trimmed away**, and a duplicate id (any case) or more than 100 models refuses the whole list. The view parses its number
  fields too (`parseOptionalNumber`: plain decimal, no hex or exponent) only to say what is wrong before sending.
- **Rename is the Display name field** of the edit form; the id is editable there as well (the edit replaces the row it
  was opened from). The form lives in its own container apart from the lists, so a rebuild of a list never takes typed text
  away (#365), and the panel is a form holding input, so a blur does not close it (#491; verified in headless Chrome). The
  lists are rebuilt only when their JSON signature changes.
- **A model change re-reads the agent** (`registry.redetect('openrouter')`, which keeps the backend and its running
  sessions), so the OpenRouter model pill lists the configured models without a Refresh Agents; the agent's "no key" /
  "no models" problems now point at this page instead of at `globalState`.
- **The catalogue** (`GET <endpoint>/models`) goes through the host: `fetchOpenRouterCatalog` with a 15 s total timeout, the
  body read as a stream and refused past 12 MB, at most 2 000 entries kept, **no `Authorization` header** (the catalogue is
  public; a key sent where it is not needed is one a mistyped endpoint receives for nothing — a test asserts it). The
  endpoint is the same `aiBrowser.chat.openrouterEndpoint` rule as the agent's. Results are cached 10 minutes in memory,
  shared by every chat surface, and one request is in flight at a time (a second search while it runs waits for it); the
  refresh button forces a new fetch. Search is the host's (every word in the id or name, an id prefix first) and the view
  gets at most 30 entries plus the total, with a 300 ms debounce; a reply for an older query than the box holds is not drawn.
- **A catalogue entry shows** name, id, context length (`200K`), price in dollars per million tokens (`$3 in · $15 out`, or
  `free`; the API's `"-1"` variable price and junk are "no price"), tools, images and reasoning. **One click on Add** saves
  `modelFromCatalogItem`: the id, the name when it differs, `tools` and `images` as the catalogue declares them, and
  `reasoning: 'medium'` only when it lists the `reasoning` parameter — nothing guessed, no max tokens or temperature. Added
  entries show "Added" and are disabled; they are redrawn from the last page after a save, which carries no catalogue.
- **Nothing from the API is parsed as HTML**: names and ids go through `textContent`, and names are cut to 100 code points
  with control characters removed (`readOpenRouterCatalog`); a test holds an `<b>` in a name as plain text.
- **The selects of this section carry `data-appearance`**, which the panel's Save sweeps (`featureSettingsSave`'s disable and
  `featureAiSaved`'s re-enable) skip: without it `featureAiSaved` read the select as an AI-feature one and threw on
  `featureSettingsDraft[undefined]` (breaks-silently #556). `featureSettings.test.ts` stubs `createOpenRouterSettings`
  like the other sections.
- **Verified:** the leaves and the request (a fake `fetch`) under `npm test`; the whole section in headless Chrome 153
  against the built `media/chat.js` with a stub host — key stored and replaced and removed with the field emptied and no
  later post carrying it, a catalogue page, Add, the "Added" mark, search, edit with a client-side and a host-side error
  with the typed value kept, a blur leaving the panel open, rename, remove. **Not measured:** the live `GET /models` (the
  response shape is from OpenRouter's documentation: `data[].id / name / context_length / pricing.prompt|completion` as
  strings of dollars per token, `architecture.input_modalities`, `supported_parameters`, `top_provider.max_completion_tokens`),
  the section inside a real VS Code window and theme (the harness has no theme variables), and a real key.

### OpenCode over ACP

`opencode acp`, JSON-RPC one object per line, one process per conversation (`opencodeAgent.ts`; readers in
`opencodeProtocol.ts`, tested on samples recorded from OpenCode 2.1.1). Measured through the compiled backend against the
real CLI with `node scripts/test-opencode.mjs` (after `npm run build-ext`; it stubs `vscode`).

| Fact | Measured value, and why it matters |
|---|---|
| version / binary | `opencode --version` prints `v2.1.1`; a native executable in `~/.opencode/bin`, so it needs no Node on `PATH` |
| models | `session/new` lists them with effort variants (`beam-free[low..max]`); detection costs no prompt and leaves no process |
| commands | `available_commands_update`: `init`, `review` — the palette lists these |
| second prompt in a turn | refused with -32603, so the session queues it and announces `autoTurn` (Gemini's branch of `ChatTab.send`) |
| permissions | `OPENCODE_CONFIG_CONTENT` replaces OpenCode's rules with ours: ask for everything, reads inside the project allowed — `read` as an **object** (`*.env` asked), never a bare `allow` (a bare allow read `.env` with no question) |
| held-back folder | `OPENCODE_DISABLE_PROJECT_CONFIG=true` hides a project's `opencode.json` (verified with a project command) |
| client name | `clientInfo.name` is `opencode`; the share glyph is never written into a page |
| plan limits | none over ACP; the usage popup says so |

**OPEN: code-mode `execute` runs with no approval when its script calls no tool.** Its runtime documents `fetch`;
`return (await fetch("http://127.0.0.1:<port>/x")).status` ran with every question answered No and the request arrived.
`'*': 'ask'`, `permission.execute`, `webfetch` and `code_mode` as `ask` did not gate it. The Internet category's Ask/Deny
therefore does not hold for OpenCode. Candidates to measure: `codemode: false` on the MCP server (does not remove `fetch`
from `execute`), or disabling `execute`.

**Not measured:** a live paid-model turn after the permission fix (the free models ran out of quota on 2026-10-27 — the
turn scenarios of `test-opencode.mjs` then fail at "shell asked as Terminal" with `Free usage limit reached`, which is the
quota and not a defect; `opencode run -m opencode/big-pickle "hi"` shows it); browser tools inside an OpenCode terminal tab
(no MCP config is injected); the Chrome and Exchange surfaces. **To re-measure** after an update: run
`scripts/test-opencode.mjs` with `OC_MODEL=<a model with quota>`, then repeat the `.env` and `fetch` probes above.

### Pi over its RPC mode

`pi --mode rpc`, one process per conversation (`piAgent.ts`, `piProtocol.ts`; samples from Pi 1.4.0, package
`@earendil-works/pi-coding-agent`). Pi has **no permission system**, so a small extension of ours (the gate, written to a
`0600` file and loaded with `-e`) asks the host before each tool runs. `node scripts/test-pi.mjs` exercises it against
the real CLI (15 scenarios, all passed on 2026-10-27).

| Fact | Measured value, and why it matters |
|---|---|
| launcher | a `#!/bin/sh` script needing `node` on `PATH`; `piPath` puts the binary's folder and a found `node` first, for the chat, terminals and the sign-in terminal alike |
| steering | a message sent mid-turn is steered into the running turn (like Codex); the prompt enters the conversation at once |
| model / thinking change | applied on the live process with `set_model` / thinking level, no restart; the next message after a Stop works on the same process |
| held-back folder | `--no-approve` (Pi's own project trust); the gate still loads with `-na` |
| paths | Pi strips one leading `@` and normalises Unicode spaces before resolving (`dist/utils/paths.js`): `piGateTool` does the same before the card and the inside-the-project test |
| MCP | the gate registers our server; a browser tool call is the AI Browser category (the real server's GET/DELETE `/mcp` 405 is tolerated by Pi, not run against it) |
| stop | `abort` ends a running command fast; the turn ends "Stopped."; dispose and `backend.dispose` leave no `pi` process |
| session | resume by `ref` in a new process remembers the conversation; sign-in is `/login` inside plain `pi` |
| plan limits | none |

**Lifecycle rules found by review:** a Stop landing while the process starts must end the turn (`turnEnd` "Stopped.",
as Codex does), or the tab reads as working for good; an exit during startup is reported by the `send()` rejection only —
`_processEnded` ends a turn only for an established process, or the failure shows twice (#514); `dispose()` also ends the
process still in its handshake.

**Not measured:** a Stop pressed after the process is ready and before the prompt is sent (the abort is a no-op; only the
5 s kill timer ends it, as "Stopped."); steering while the final answer streams; browser tools inside a Pi terminal tab;
Pi receives `AIB_MCP_TOKEN` in its environment, which an approved `bash env` would show to the model (the Codex terminal
hand-over has the same exposure). **To re-measure** after an update: `scripts/test-pi.mjs`, and re-read `dist/utils/paths.js`.

### Wiring of OpenCode and Pi

Two more agents (`'opencode'`, `'pi'`), wired in beside Gemini. Their backends are
[src/chat/opencodeAgent.ts](src/chat/opencodeAgent.ts) / `opencodeProtocol.ts` and
[src/chat/piAgent.ts](src/chat/piAgent.ts) / `piProtocol.ts` (the protocol files are leaves under test, on samples
recorded from OpenCode 2.1.1 and Pi 1.4.0). **Where they are wired**, so the next agent can follow the list: `AgentId`
and `agentIds`/`agentNames` (`agents.ts`, with the detection branch and the install advice), `agentBinary.ts` (search
folders, `extensionIds`), `agentAuthentication.ts` (sign-in command, no status probe), `chatView.ts`
(`_agentBinaries`, "Continue in terminal", terminal tab start), `chatTab.ts` (the mid-turn send branch),
`extension.ts` (`aiBrowser.chat.newTerminal`), `mcpProtocol.ts`/`mcpServer.ts`/`mcpCheck.ts`/`shareRegistry.ts`/
`shareIndicator.ts` (`ClientKind`), `toolbarText.ts`, `usageAlert.ts`, the Chrome and Exchange readers, the webview
icons and the toolbar editor's agent filter, and the two `application`-scoped settings `aiBrowser.chat.opencodePath`
and `aiBrowser.chat.piPath`. `featureAgent` needed nothing: it already lists only Claude Code and Codex, so a title or
commit message on either of these runs on one of those instead.

**Facts that decide the wiring** (measured where the authors say so; the rest is marked):

- **Client names**: OpenCode sends `clientInfo.name` `opencode` (2.1.1), Pi `pi` (1.4.0). `classifyClient` matches
  Pi **whole** — a substring of two letters would claim other clients. Their share glyphs (🟡, 🟤) are never written into
  a page, so `stripMarker` does not know them (the marker was removed anyway).
- **Binaries**: `opencode` installs a native executable under `~/.opencode/bin` (needs no Node); `opencode --version`
  prints `v2.1.1`, which `parseCliVersion` reads. `pi` is an npm package (`@earendil-works/pi-coding-agent`) whose launcher
  (`~/.pi/agent/bin/pi`, linked from `~/.local/bin`) is a sh script needing `node` on `PATH`: the chat and the terminal
  put the binary's folder and a found `node` in front (`piPath`), the same trick as `geminiPath`.
- **Mid-turn messages**: OpenCode refuses a second prompt during a turn (-32603), so its session queues and announces
  `autoTurn` — the Gemini branch of `ChatTab.send` (`_waiting`). Pi steers like Codex: the message goes into the running
  turn and its prompt enters the conversation at once; `autoTurn` only appears when Pi re-sends a steered message that
  missed its turn (not measured).
- **Sign-in**: no status command is run for either — detection itself (`session/new`, `get_state`) says signed out.
  The sign-in terminal runs `opencode auth login`, and plain `pi` (the user types `/login`).
- **Folders held back** (a repository fetched from GitHub, not trusted): OpenCode gets `OPENCODE_DISABLE_PROJECT_CONFIG=true`
  (verified with a project model override), Pi `--no-approve` (its own project trust). Both in the chat's process and in
  terminals.
- **No plan limits**: both say so in the usage popup. OpenCode's permission model is replaced by our own
  (`OPENCODE_CONFIG_CONTENT` asks for everything but reads), and Pi has no permission system, so Pi's gate extension is its
  only approval — see the two backends' own headers for the details.
- **OpenCode's `read` rule is an object, never a bare `allow`.** OpenCode's own defaults ask before reading a `.env`
  file (`*.env`, `*.env.*`; `*.env.example` allowed). Measured on 2.1.1 with a fake OpenAI-compatible provider calling
  `read` on `.env`: `permission.read: "allow"` read it with no question, the object form
  `{ "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" }` asked. Pi's sign-in terminal gets
  `piPath` (a `node` on `PATH`) like its chat process.
- **Terminal tabs and "Continue in VS Code terminal"**: both agents' own TUI starts in the folder (`opencode`, `pi`);
  resume is `opencode -s <id>` (the session ref is OpenCode's own id) and `pi --session <id>` (from the same folder, or Pi
  asks to fork). **Browser tools are not injected into either terminal** — Pi's would need the gate loaded in the TUI and
  OpenCode's an MCP config, neither measured; the terminal-tab menu row says "no browser tools in a terminal".
- **Pi's path normalisation is part of the approval** (review, measured on Pi 1.4.0): Pi strips one leading `@` and turns
  Unicode spaces into spaces before it resolves a path, so `read` of `@/etc/hosts` reads `/etc/hosts`. `outsideProject` took
  `@/etc/hosts` for a project-relative name and the gate auto-allowed the read with no card (and an `edit` of
  `@~/.ssh/x` was filed as inside the project). `piGateTool` now normalises the path the way Pi does before the card and
  the inside-the-project test. Re-check `dist/utils/paths.js` of Pi when it is updated.
- **OPEN, measured on OpenCode 2.1.1: its code-mode `execute` runs with no approval when the script calls no tool.** The
  runtime documents `fetch` as available ("script tool calls and HTTP requests"), and a script
  `return (await fetch("http://127.0.0.1:<port>/x")).status` ran with every question answered No, no card, and the
  request arrived. `OPENCODE_CONFIG_CONTENT`'s `'*': 'ask'` does not cover it, and `permission.execute`, `webfetch` and
  `code_mode` set to `ask` did not either (one request each). So the Internet category's Deny/Ask does not hold for
  OpenCode scripts: a prompt-injected model can send what it read (reads inside the project are not asked) to any host.
  Not fixed: no free model quota was left to measure a candidate (an MCP server's `codemode: false` in the config, which
  makes its tools ordinary asked tools, would not remove `fetch` from `execute` itself). `tools.opencode.worktree_remove`
  etc. are asked as `edit` by OpenCode and reach us as "Other tools".
- **Not measured end to end inside VS Code**: the wiring above was checked by typecheck, the build and `npm test`
  only; `scripts/test-opencode.mjs`, `test-pi.mjs` exercise the backends against the real CLIs. The server answers GET
  and DELETE on `/mcp` with 405, which Pi tolerates (the real server was not run against Pi).

### The context pie and compacting

Asked for: a small pie beside `U` that fills as the conversation's context window does, and a
click that runs the agent's own compaction where it has one. `renderContext` in `chat.ts` draws it
(the share set as `--fill` through the CSSOM, which the CSP allows);
`ChatStats.contextTokens` / `contextWindow` hold the figures, so a chat reopened from the history
shows its last known fill. Warning colour from 80 %, error colour from 95 %. It appears once the
agent has reported a size.

**The pie and `U` are one mark, the ring meter** (asked for): `ringMeter(mark?)` / `setRingFill`
in `chat.ts`, `.ring-meter` in `chat.css` — a hollow circle whose arc fills clockwise from the
top, 0 to 360°, over a faint track, with an optional mark in its middle (the usage button's `U`,
the context's `C`; both the same size, asked for). The arc is a `conic-gradient` on `::before`, cut to a ring by a
`radial-gradient` mask (`--ring-width`), so the middle stays transparent for the mark. Its colour
is `--ring-color` and the track `--ring-track`, both separate from `color`, so the track and the
mark stay neutral while the arc takes the level's colour — setting `color` instead tinted the
track. On `U` the arc is the nearest plan limit's share in `usageColor`; reached or spending
credits, the whole mark is the red disc. The plan-limit line keeps the plain `.u-mark`.

- **The tooltip says how much is used and how much is left** — tokens and share of the window,
  asked for — and is drawn by the view (`hoverTip`, from `data-tip`), as the toolbar skills' are,
  since a native `title` did not show on those buttons in VS Code. **The button is never
  `disabled`**: a disabled button gets no pointer events, so the tooltip — the one place that says
  why compacting is not on offer right now — would never appear. It is marked `unavailable`
  (`aria-disabled`) while the tab works or the agent has no compacting, and a click then does
  nothing.
- **A click asks first** (asked for): "Compact the conversation?" in the view's own popover —
  never a modal, which would pause a browser tab beside the chat — with the sizes and what
  compacting does, and **No as the default** (focused, Enter answers it, as do Escape and a click
  elsewhere), the shape of the "run it again?" question. Only Yes posts `compact`. The question
  closes if the tab starts working or the pie goes while it is open.

**The figure is the latest request, never a sum** — a sum counts the conversation once per tool
round. Measured on Claude Code 2.1.301 and codex-cli 0.162.0-alpha.17.2:

- **Claude Code**: each `assistant` message of the main agent carries that one request's `usage`;
  input + `cache_creation_input_tokens` + `cache_read_input_tokens` + output is what the next
  request carries (21 278 after "say hi" here, mostly the system prompt and the tools). A
  sub-agent's message (`parent_tool_use_id`) is not the conversation's. The **window** comes only
  with `result`, as `modelUsage[<model>].contextWindow` (1 000 000 for Haiku 5.5) — and that map
  lists every model the turn used, sub-agents' included, so `claudeEvents` keeps the
  conversation's model from `init` and the main agent's replies (`ClaudeSession._context`) and
  reads that entry; with the model unknown only a map of one entry answers.
- **Codex**: `thread/tokenUsage/updated` carries `last` (the latest request) beside `total` (the
  thread) and `modelContextWindow` (475 000 for GPT-6.1-Sol). `last.totalTokens` is the one to
  read: after a compaction `last` has `inputTokens: 0` and `totalTokens` the new size.

**Compacting is the agents' own, and both run it as a turn.** The click sends `{ type: 'compact' }`
and the provider sends `/compact` into the tab (`_compact`, with no attachments — the chips in the
box are the next message's), so it shows as that prompt, as both agents' own UIs show it.

- **Claude Code** runs `/compact` from a stream-json message: `system` `status: compacting`, then
  `compact_boundary` with `compact_metadata` (`trigger`, `pre_tokens`, `post_tokens`), a replayed
  summary as a `user` message with string content (not read), and a `result` with `num_turns: 0`.
  It is offered only while the CLI lists `compact` among its commands ("if it has one").
  **`post_tokens` is the summary alone, not the new context**: a compaction from 21 279 reported
  2 220, and the next request carried 25 726 — the system prompt and the tools are added back. So
  the pie does not take it; the size is marked `contextCompacted` (the pie empty, the tooltip
  saying the new size comes with the next reply) until a reply reports one. Claude Code compacting
  on its own (`trigger: auto`) arrives the same way.
- **A Codex compaction's turn takes no more input** (`_compactTurn`, from the request to the
  turn's end). The app-server refuses a steer into one — `cannot steer a compact turn` is in the
  0.162 binary, beside `cannot steer a review turn` — and before its `turn/started` there is not
  even an id to steer by, so a message sent then took the start branch: a second turn beside the
  compaction, and `_stopRequested` cleared under a Stop. A message sent during a compaction now
  waits for it to end and starts its own turn, as one sent after Stop does; measured on the real
  CLI. **A compaction that is answered and never starts a turn** ends after `compactStartWaitMs`
  (30 s) with a line saying so, or the session read as running for good.
- **Codex** has no `/compact` in the app-server; `CodexSession._send` turns the message `/compact`
  (alone, no images) into `thread/compact/start`, typed or clicked. The answer is `{}`; the turn
  arrives as `turn/started`, a `contextCompaction` item, a `thread/tokenUsage/updated` with the new
  size (16 067 → 11 043, which *is* the next request's base, unlike Claude's figure), and
  `turn/completed`. The turn id comes only with `turn/started`, so a Stop pressed before it
  (`_stopRequested`) is honoured there (`_compacting`). One typed during a turn waits for the turn
  to end rather than being steered in as text.
- Both end with a notice, "Conversation compacted…" — Claude's naming the size before and the
  summary's.

Verified with the compiled backends against both real CLIs (a turn, `/compact`, a turn) and the
pie in headless Chrome at 42 %, 87 %, just compacted and with no window or no compaction; the
tooltip, the question, No (nothing posted), Yes (one `compact`), a second press closing it, and a
busy tab (tooltip shown, no question).

### The plan-limit line, and the colour of `U`

Asked for: a line above the chat when the nearest limit of the agent's plan is 90 % used or
more, shown again at every further percent and at 100 % even after it was closed, and when the
agent starts spending credits; the `U` button coloured by how much is used. The rules are
[src/chat/usageAlert.ts](src/chat/usageAlert.ts) (leaf, under test); the host's half is the
*usage* section of `chatView.ts`, the view's `renderUsageLevel` / `renderUsageAlert`.

- **Which limit: the one closest to running out, whatever its length** (`closestLimit`). "The
  nearest period" was read as the limit that stops the agent first — a weekly limit at 95 %
  stops it as surely as a 5-hour one at 95 %. Switching to the shortest window is one line in
  `closestLimit` if that is ever what is meant.
- **For the agent of the tab in front** (`_selection().agent`): the line and the colour are about
  the plan the next message spends. A Codex limit is not shown over a Claude conversation.
- **Closing means "seen at this percentage, in this period"** (`closeAlert`,
  `aiBrowser.chat.usageAlertsClosed` in `globalState` — one plan, so closed in one window is
  closed in all; read through `readClosedAlerts`, which drops what it cannot read). Closed at
  91 %, the line stays away at 91 % and comes back at 92 %; closed at 99 %, it comes back at
  100 %. The percentage compared is the whole one the line names (`wholePercent`, floored), so
  91.8 does not count as "higher" than a close at 91. Closing records every limit at 90 % or
  more with its reset time, not only the one named — or closing "now spending credits" would
  put "limit reached" up in its place for the same moment — and **as it was shown**: the view
  sends the alert it showed, so a figure that arrived while the click was on its way is not
  closed above what was on screen, and credits are closed only when the line was about them.
- **Within one period a limit's use only grows, and a lower figure is not a reset.** Claude
  Code's two reports disagree by a point in the same second — measured on 2.1.301, `get_usage`
  85 and 24 against `rate_limit_event` 0.84 and 0.23, three times over — and the first version
  read the event's lower figure as the limit resetting: it forgot the close, and the line closed
  at 92 % came back at 91 % on the next message (breaks-silently #472). So a period is told by
  its reset time (`laterPeriod`, ten minutes of tolerance, since `get_usage` names the same
  reset with a second's jitter: 13:39:59.6 and 13:40:00.2): `mergeLimits` keeps a limit's higher
  figure within one period, from either source, and `settleClosed` forgets a close only once the
  reset time has moved on to a later period — or, with no reset time known, once the figure has
  fallen by `resetDrop` (10 points; a real reset falls to near zero). A new period at the same
  percentage shows the line again, before anything is settled (`closedFor`). Credits closed
  stay closed until the limit they were spent past resets.
- **Only the limits the latest report names are judged** (`settleClosed`'s `named`). The closes
  are shared by every window, and a figure this window kept from an earlier report — a model's
  own weekly limit, which a turn's report leaves out — may be older than the close another
  window made.
- **A limit whose reset time has passed is left out** (`currentLimits`, at every post), and
  credits spent past it with it, unless another limit is still at 100 %. `_watchReset` posts
  when the next reset of the agent in front passes (at most an hour ahead, then looked at
  again), and the view refills the line's "resets in …" every half minute. Without both, the
  line said "reached, resets in 1 h 40 min" three hours later and `U` stayed red until the next
  message brought new figures (breaks-silently #475).
- **The view hides a closed line at once and keeps it hidden** while a post still carries the same
  alert (`closedUsageAlert`), so it does not flash back in the moment before the host has the
  close. The line is built once and refilled, never rebuilt (#365): its close button must not be
  replaced between a press and its release, and the reset time in its words moves on by itself.
  Closed from the keyboard, the focus goes to the message box rather than to the body.
- **The line's height is taken from the thread**, so a thread that was following its end is put
  back at the end whenever the line comes, goes or wraps (`renderUsageAlert`). It appears while a
  reply is on its way — Claude Code reports its limits once the turn's first model request has
  answered — and at 61 px (a narrow side bar, or the credits wording) it put the thread past
  `renderThread`'s 60 px "at the end", so the reply streamed out of sight for the rest of the turn
  (breaks-silently #474).
- **The look, as asked for**: a fixed yellow (`#ffd43b`) with black text, the same in every
  theme so the black stays readable; the `U` of the usage button on the left (`.u-mark`, shared
  with the button), filled black once the limit is reached or credits are spent; a close button
  on the right. Its words name the agent, the limit, the percentage or "reached", and when it
  resets; a click on them opens the usage popup, but not a click that ends a selection of them,
  nor any click of a double or triple one (#353's rule — opening the popup asks every agent, and
  starts a probe for Claude Code with no conversation running). The first click of a double click
  arrives before the word is selected, so the open waits `multiClickMs` and is dropped if another
  click or a selection comes, as #408's `onPlainClick` does; opening at once asked every agent
  under someone double-clicking a word to copy it. The half-minute refill of "resets in …" skips
  a selection in the words, which a refill would take away. `usageAlertText` is in the document
  `mousedown` handler's list of places that do not close popups: that handler runs before the
  click, so without it a press on the words with the popup open closed it, and the click opened
  it again with every agent asked once more.
- **`U`'s colour** (`usageColor`, set as `--usage-color` through the CSSOM, as the pie's fill is):
  the foreground below 25 %, then mixed towards `charts.green` by 50 %, `charts.yellow` by 75 %,
  `charts.orange` by 90 % and `charts.red` by 100 % (`color-mix`, so every theme has it); a limit
  reached, or credits being spent, is a saturated red disc (`#e5141f`, `.limit-full`). Its
  tooltip names the limit and the percentage, and so does its `aria-label`: a screen reader
  otherwise kept the button's fixed name, and the colour says nothing there.

**Where the figures come from, and how often the plan is asked.** Not often, as asked:

| Source | Cost | Read as |
|---|---|---|
| detection | nothing extra: Claude Code's `get_usage` goes on the probe process detection already starts, Codex's `account/rateLimits/read` on the app-server detection already holds | whole |
| a turn | nothing: Claude Code's `rate_limit_event`, Codex's `account/rateLimits/updated` | the limits it names |
| after a turn, when `usageCheckDue` says so | one request on the process the conversation already runs (`usage(liveOnly)`), never a new one | whole |
| the `U` popup | as before — a probe process for Claude Code when no conversation runs | whole |

`usageCheckDue`: never twice inside a minute; after a big request (40 000 tokens not read from the
cache, or three minutes); every three minutes from 80 %; otherwise every fifteen. The check runs
two seconds after the turn ends (`usageCheckDelayMs`), since the provider counts a turn a moment
after answering it, and at most one per agent at a time. Every whole read reaches the view
through `AgentRegistry.onDidReadUsage`, whoever asked for it.

- **Detection is not delayed by its usage read.** Claude Code: `initialize` is sent first and
  answers in ~200 ms; `get_usage` follows on the same process and answers in ~1 s (measured on
  2.1.301), and the probe is kept for it at most `usageProbeWaitMs` (8 s), then ended. Codex: the
  read is started without being waited for, inside the app-server's hold.
- **Credits** (`usingCredits` on `AgentUsage` and on the `limits` event):
  - *Claude Code*, measured on 2.1.301: `rate_limit_event`'s `rate_limit_info` carries
    `isUsingOverage` beside `overageStatus` and `overageEnabled` — the turn's own word, read by
    `claudeRateLimit`. `get_usage` says only whether extra usage is on (`extra_usage.is_enabled`,
    `spend_limit_reached`, `used_credits`), so the read guesses: on, its cap not reached, and a
    limit **of the whole plan** at 100 % — `scope` null; a model's own weekly limit
    (`weekly_scoped`, `scope.model`) used up leaves the other models on the plan, and counting it
    called a user on Sonnet "spending usage credits" because Fable's limit was spent
    (breaks-silently #473). The guess is a point high at worst (100 there can be 99 in the event),
    so **the turn's word outranks it** (`LimitState.turnSaid`): a full read's `true` does not
    overrule a turn that said `false`, and can still clear one that said `true` (a reset). Claude
    Code renamed `/extra-usage` to `/usage-credits` (seen in the CLI's own answer), so the line
    says "usage credits".
  - *Codex*, read from the 0.162 schema, **not measured in a session that spends credits**:
    past a limit — `ordinaryUsageAllowed: false` (the read only), `rateLimitReachedType`, or a
    window at 100 % — with credits to spend (`hasCredits` or `unlimited`) and `spendControlReached`
    not true. `account/rateLimits/updated` is a sparse update — the schema says a field it leaves
    null does not clear what was read — and never carries `ordinaryUsageAllowed`, so it may only
    *set* credits, never clear them; the next full read does — **or the limit they were spent
    past resetting**: a report that shows a limit at 100 % reset, or its reset time passing
    (`currentLimits`, applied to the stored figures before each merge too), ends them unless
    another limit is still at 100 %. Without that, the update of a new period kept the old
    `true`, and the line said "Codex is now spending credits" over a limit at 2 % — with its
    close forgotten in the same report, the limit having reset (breaks-silently #476). Check all
    of it against a real account when one gets there.
  - *Claude Code*'s event comes **after a turn's first model request**, not before it, and not on
    every turn — measured on 2.1.301: after the first request's `message_stop`, once in a turn
    that ran a tool, and once across two turns of one process. So the figures a turn brings are a
    moment behind its start, and the after-turn check is what keeps a long session current.
- **Codex names its windows after their limit only when the read lists several**
  (`rateLimitsByLimitId`), and `account/rateLimits/updated` carries one limit at a time. Read on
  its own, the notification named its windows as the only limit's — a second "5-hour limit"
  beside "Codex · 5-hour limit", which a close keyed by the other label would not recognise, so a
  closed line would come back on the next turn (found by reading the schema, before it
  shipped). `CodexBackend._namedLimits` remembers the read's shape and `codexUsage(…, named)`
  names the notification's windows the same way (breaks-silently #471). A limit with no
  `limitName` is named by its `limitId` — measured on 0.162: the main limit is `limitId:
  "codex"`, `limitName: null`, so two unnamed limits would otherwise share one label. An update
  that names neither while the read listed several (the schema allows both null) gives no
  windows at all: they could only be named as the one limit's, which no close matches.
- **A check after a turn that read nothing does not count** — no process running any more (a
  turn ended by closing its tab), a request that failed: `_usageAsked` is put back, so the next
  turn may ask. And detection's Claude Code probe, kept for its usage answer, is ended with the
  backend (`ClaudeBackend._lent`).

Verified: the rules under `npm test`; the compiled `ClaudeBackend` and `CodexBackend` against the
real CLIs (detection answered in 234 ms and 447 ms, the usage read arrived after it, no probe
process left behind, `usage(true)` refused with no process and answered with one); the host's
half with a stubbed `vscode` (closed at 91.2, hidden at 91.8, shown at 92; closed at 92 from a
full read and still closed after the turn's 0.91 and the next read's 92; a close made in one
window kept when another window's turn report leaves the limit out; a reset forgetting the close;
a reached limit's line and red disc gone once its reset time passed; credits; the check after a
turn, once per minute, nothing after dispose; the turn's weight from `ChatTab`); the view in
headless Chrome (the colour at nine levels, the red disc, the line's words for all three kinds and
both agents, the close posted and held, focus to the message box, the text opening the popup and
a selection of it not, the thread kept at its end while a 61 px line appears and the reply
streams on, a 260 px side bar).

### Skills and commands: the "/" palette

Asked for: every skill Claude Code and Codex have — the project's and the global ones — in the
"/" menu, grouped, each agent its own, with autocomplete. **Both lists come from the CLI itself,
never from reading folders**: the CLIs know where they look (plugins, synced skills, `~/.agents`,
the managed ones), and a folder walk of ours would drift from that. Measured on Claude Code
2.1.301 and codex-cli 0.162.0-alpha.17.2:

| | Claude Code | Codex |
|---|---|---|
| list | the `commands` of the `initialize` answer — the probe detection already runs | `skills/list` with `cwds: [<project>]`, `forceReload: true` |
| shape | `{ name, description, argumentHint, builtin? }` | `{ name, description, path, scope, enabled, pluginId, interface: { displayName, shortDescription } }` |
| source | the description's last parentheses: `(user)`, `(project)`, `(claude.ai sync)`; any other tag or a `plugin:` name is a plugin; no tag is Personal; `builtin: true` | `scope`: `repo`, `user` (a plugin's when `pluginId` is set), `system`, `admin` |
| typed as | `/name args` at the very start of the message | `$name` anywhere in it |
| sent as | plain text — skills, `.claude/commands` and built-ins like `/cost` all run from stream-json | the text **plus** `{ type: 'skill', name, path }` per skill named, as Codex's own composer sends it |
| answered as | a model turn — or, for a command the CLI answers itself (`/usage`, `/agents`, `/context`, `/mcp`, `/config`), **one complete assistant message from the model `<synthetic>` and no stream events at all** | a turn |

`claudeCommands`, `codexSkills` and `codexSkillItems` in `agentProtocol.ts` read them (tests on
recorded samples). The palette groups by `CommandGroup`: Project, Personal, Plugin · *name*,
Synced from claude.ai, Built into Codex, Built into Claude Code — and, with a search typed, one
ranked list instead (name starting with the query, then holding it, then every word in the
description), each row naming its group.

**A command the CLI answers itself has no deltas, so its answer used to vanish.** The chat reads a
reply's text from the stream deltas only, because the complete `assistant` message repeats them;
`/usage` and `/agents` send no deltas, only that complete message, with `model: "<synthetic>"` and
`num_turns: 0`, so they ended with nothing on screen (reported as "these commands do nothing").
`claudeEvents` now takes the text of a `<synthetic>` message (measured on 2.1.301 for `/usage`,
`/agents`, `/context`, `/mcp`, `/config`, `/extra-usage`, `/reload-skills`). A model's complete
message is still read for its tool calls only, or every reply would show twice.

**An API error comes the same way, and is not read there.** A request over the context ("Prompt is
too long") arrives as a `<synthetic>` message flagged `is_api_error_message: true`, then a
`result` with `is_error` and the same text (measured on 2.1.301), so taking the message's text
said it twice, once as a reply and once as the error (#415). The result alone reports it, and
with `terminal_reason: 'prompt_too_long'` it adds what to do: send `/compact`, which the CLI
lists in stream-json mode too, or start a new chat. It is reached by a long conversation resumed
in a tab — a toolbar skill sent into the chat goes to the tab it was pressed in, whatever that
tab holds — and not by a fresh one: a new session in this repository starts at about 229k
tokens, CLAUDE.md being most of it, and every model the CLI offers here has a 1M window.

**A prompt refused as too long goes again on its own** (asked for): Claude Code compacts the
conversation right after that error, so the same prompt usually fits a few seconds later. The
result carries `tooLong` (`claudeEvents`) — from `terminal_reason: 'prompt_too_long'`, or from
the text alone (`promptTooLong`): a turn ended while Claude Code auto-compacts carried only
"Prompt is too long", and no retry ran, and `ChatTab._scheduleRetry` sends what was sent —
`Pending.resend`, the prompt with its attachments, model and effort — after 5, 15 and 30 s
(`tooLongRetryMs`), a notice saying so in place of the error; past the third try the error and
its advice stand. The prompt is shown once. While it waits the tab reads as running, so Stop is
up and a queued message waits behind it; Stop, a new message, another chat in the tab or closing
it ends the wait. A compaction still running when the time comes uses the next wait. A step of a
toolbar skill is judged only on its last try. **A session let go of during the wait ends it with the
prompt's own error** (`_abandonRetry`, from `_onBackendReplaced` and `_dropSession`): left to fire,
the timer found no session and returned in silence, the prompt lost after "sending it again" and
the tab reading as working until then (#510). A Claude message sent mid-turn and answered by a
turn of its own keeps what was sent too (`_waiting[].pending`), so it is retried like any other.

**Temporary Claude/Codex service failures continue the same conversation automatically.**
Only a terminal `turnEnd` with a capacity/overload, temporary throttling, or service/network
error schedules this recovery; streamed notices and the CLI's own retries do not. Thinking is
settled first. There are at most three additional attempts, after 5, 15 and 60 seconds
(`transientRetryMs`). Each sends a continuation instruction in the existing session, retaining
the chosen model and effort, and asks the agent to account for completed actions before
repeating them. No duplicate user bubble or attachments are added. A notice shows the error,
delay and attempt; the final error stands after exhaustion. Stop, a new message, switching the
conversation in the tab, closing it, or losing its backend cancels the wait. Waiting keeps Stop
available and holds the queue; a running turn is never steered by an automatic continuation.
Authentication, billing/quota failures and user interruption are not retried. An explicitly
paused queue stays paused. Context-too-long recovery above still resends the original input.

**It opens two ways.** From the button it has its own search box. **Typed in the message box** —
`/` or `$` at the start of the box or after white space, anywhere in the text and for either
agent (asked for) — the box is the search, the palette follows the query, and ↑ / ↓, Enter and
Tab move and choose (they are the palette's before they are the composer's, so Enter does not
send `/rev`). Escape closes it and it stays closed until the text changes. **A query nothing
matches hides the palette and hands every key back to the box** (`no-match`): typed mid-text, a
`/usr/bin` or a `$5` is far more often not a command, and a popup saying "Nothing matches" over
it — or swallowing ↑ and Enter — was in the way. `a/b` never opens it: the sigil has to follow a
space. Choosing a skill writes it into the box, never sends it, so arguments can follow. Typed, it
takes the place of what was typed and is written in the agent's own form whichever sigil was used
(`$one` in a Claude chat becomes `/one-more-review`). From the button, Claude's goes at the start of
the message, over a `/command` already there, since Claude Code reads a command only there — one
typed mid-text reaches the model as text, which can still use the skill; Codex's goes at the caret.
Typing `/clear` and choosing Clear conversation takes the `/clear` out of the box again. From the
button, a Claude command replaces only a `/command` the message starts with — a bare `/` or one the
agent lists — never a path (`/etc/hosts …` keeps its text, #399).

**Clear and Export are listed from the button always, disabled while there is nothing to act on**
("Nothing to clear yet"), and the keys pass over them — marked `aria-disabled`, not `disabled`, or
a click on one took focus out of the box (a disabled button gets no `mousedown`). Hidden in that
state, as they first were, they read as gone: a new tab is the first place the palette is opened.
**Typed, they come after the skills, and only once something follows the `/`** (`/cl`); after `$`
never. **And no chat command is ever the row chosen by default without a query**: with `/` alone
in the box, Enter took the first row — Clear conversation — and cleared the tab without a question
(#397). With nothing else to offer, no row is chosen until an arrow picks one, and Enter, typed,
goes back to the box. Where the skills would be, a line says why there are none: still being
looked for, none listed, or a listing that failed. **A row whose name is exactly what was typed is
chosen over the one kept** from earlier keystrokes: `/review` typed letter by letter kept
`/review-pr`, chosen at `/r`, and Enter inserted that while the toolbar's own `/review` — listed
first, since it takes precedence — sat above it (#412). A row picked with an arrow stays while it
is exact too. **Typed, a chat command matches by its name alone and is never the row chosen by
default.** Its description was searched too, so "Our API has POST /start" or "do it all /over"
matched Clear conversation, it became the first row, and Enter cleared an idle tab without a
question instead of sending the message. It is chosen only when its name is exactly what was
typed or an arrow key picked it (`paletteArrowPick`). The palette opened from the button still
searches descriptions.

**The inline palette closes whenever the box is rewritten under it** — a send, another chat, a
recalled message, queued messages given back — and `renderPalette` checks that the typed `/…` is
still where it was. Left open (hidden for want of a match, after `check /usr/bin`), the next state
post read an empty query, which matches everything, and the palette came back over the empty box
and took ↑ and Enter (#398). **Another popup opening resets the palette's mode** too, or the next
"/" read as the second press of a toggle and closed what was already closed.

**Commands are marked in the text, in the box and in the chat** — asked for. Only a command the
agent lists, in its own form (`/name` for Claude Code, `$name` for Codex), at the start or after
white space; trailing punctuation is not part of it (`markCommands`). In a sent prompt it is a
`span.cmd-token` among text nodes, so `textContent` — what the copy button and the send's flight
read — is the text unchanged, and the prompt is rebuilt when the agent's list changes
(`commandsSignature` in its signature). **The box is a textarea, which cannot style part of its
text**, so the text the user sees is a mirror behind it (`.input-mirror`): the same text in the
same font, padding, line height, wrapping and scrollbar gutter, its scroll kept in step, and the
textarea above it draws only its caret (`caret-color`) and selection, its own glyphs transparent.
**The mark is a colour and nothing else** — asked for, after a first version with a background
that read as a button — and a command keeps the plain arrow rather than the prompt's pointer, since
it is not clickable. Anything that changes the mirror's layout (padding, a bold weight) moves its
text off the textarea's caret.

Details that matter:

- **The list is per backend** (`AgentBackend.knownCommands`), published as `state.commands` by
  agent, and asked for again each time the palette opens (`listCommands`), at most every 10 s per
  agent — for Claude Code each listing is a short-lived CLI process in the project folder, never
  a second `initialize` on a live conversation. Detection fills it: Claude Code's from the
  answer it already reads for the models, Codex's with one more call on every detection, so a
  Refresh finds a skill added since; the throttle starts only from a listing that ran. **An agent
  detection found unusable is not listed** — for a signed-out Codex the listing would start its
  app-server for a list the state then drops — and a throttle stamp in the future is due (#224).
  **A Codex listing holds the app-server** like detection does, and starts it again if it had
  shut down.
- **A command's text is the project's own and arrives uncut**, so it is read with nothing that
  backtracks: the source tag is matched against the description's last 200 characters with an
  anchored pattern — `/\s*\(([^()]+)\)\s*$/` took 7 s on 100 000 spaces in a trusted project's
  command file, on the extension host (#400) — and descriptions, hints and titles are cut to 500
  characters, names over 200 skipped. The list goes out with every state post.
- **Codex's skill items need the paths**, which is why the list lives on the backend rather than
  only in the view: `CodexSession._send` matches `$name` as a whole word against the backend's
  list. Measured: `$echo-test` alone usually works too — the model is told the skills exist and
  opens the file — and the item is what makes it certain. Disabled skills are left out.
- **Some Claude Code built-ins are not offered** (`hiddenClaudeCommands`): `/model`, `/effort`,
  `/fast` would leave the pills naming a model the next message does not use, `/clear` empties the
  CLI's context while the thread stays on screen, `/rename` and `/resume` act on a session the
  chat owns, `/login`, `/logout`, `/exit`, `/quit` on the process it runs, and `/color`, `/focus`,
  `/heapdump`, `/output-style` are terminal features. They still run when typed. Names starting with `__` and commands "… sessions only" are internal.
- **No scroll sideways, and a tooltip only where a row is cut** (asked for): the palette is 440 px
  (it was 380), kept inside the view by `.popup`'s own `max-width`, and its list hides
  horizontal overflow — a long skill name or argument hint pushed it sideways. The argument hint
  takes only the room the name and the group tag leave (`flex: 1 1 0`), so it gives way first;
  the name is cut only when it and the tag do not fit together. A first version kept the name
  whole up to the row's width, and in a search a long name pushed the group tag out of the row,
  where the hidden overflow took it (#417). Whatever is cut ends in an ellipsis, and that row's
  tooltip (`fullRowTip`, measured on hover) carries the name, the hint and the description
  whole. A row that fits gets no tooltip.
- **A row is chosen on click with its `mousedown` prevented**: in the inline mode a press would
  otherwise move focus out of the box, and the caret — and with it the query — would go.
- **The list is rebuilt only when what it shows changes** (`paletteShape`), #365's rule: state
  posts arrive every 40 ms while a reply streams, and a rebuild between a press and its release
  loses the click.

Verified with the compiled registry against both real CLIs in a project with test skills (55 and
57 listed, a skill added afterwards found on the next refresh, a Codex `$echo-test` turn carrying
its `skill` item and answering from it), and the palette in headless Chrome: focus on the search
box, grouping, ranking, ↓ Enter, the inline query for both agents, Escape, `/clear`.

### The working folder

Asked for: a button right of "/" with a folder on it — a search box at the top, focused at once
as in the "/" palette, then the folder the agent works in, then the files and folders of that
folder to add to the message. `workdirPopup` in `chat.ts`; the host's half is the *working
folder* section of `chatView.ts`.

- **Git footer**: beside the working path, the branch dropdown searches local and known remote
  branches, switches or creates a branch, and deletes local branches with `git branch -d`.
  **Enter in the branch search switches only to the branch named exactly**; anything else typed
  creates that branch, and an empty box does nothing. It used to check out the first branch whose
  name *contained* the text: any branch on an empty box, and `experiment-old` for "exp" while the
  row offered to create "exp". A row picked with ↓ has the focus, and Enter there is that row's
  own button.
  Switching is handled by `gitBranchSwitch.ts`: fetch/prune the selected remote or upstream,
  reuse a matching tracking branch (ask for another local name on an upstream collision), then
  switch and update with `merge --ff-only`. A failed fetch offers an explicit offline switch;
  divergent histories leave the branch selected with a notice, without merge/rebase. Before
  a local checkout, a deleted upstream disables remote updates but does not prevent switching;
  a deleted remote selection still refuses and asks to refresh. Untracked symlink snapshots use
  `lstat`/`readlink` (including dangling links), so confirmation checks detect link retargeting.
  Before
  switching a dirty worktree, offer **Stash & Switch**, **Commit All & Switch**, or confirmed
  **Discard Changes & Switch**; Escape cancels. Commit previews staged/unstaged diffs and asks
  for a message; stash includes untracked files and preserves its entry; discard removes only
  confirmed untracked paths and retains ignored files. Dialogs revalidate HEAD, index and file
  contents before mutation. Pending merge/rebase/conflicts and dirty submodules refuse the flow.
  Unsaved editors must be saved first. Saved stashes are recorded in workspace state and the
  branch popup offers **Return & Apply Stash**, restoring on the original branch with `--index`
  only when the worktree is clean; the stash is kept even after successful application.
  The combined **Commit** trigger with numeric staged/unstaged counters stays accessible and opens the changes panel on hover
  or click. It shows Staged and Unstaged groups, changed/deleted totals, and per-file and group
  Stage (+) / Unstage (undo) actions. Unstage changes only the index, including renames and an
  unborn HEAD. Staging does not require a model; unavailable commit actions explain why.
  Clicking a file opens `vscode.diff` through the built-in Git extension's public `toGitUri`
  API: Staged compares HEAD with index, Unstaged compares index with the working file. Added
  and deleted files use an empty side; renames use their original path on the left (`gitDiff.ts`).
  Mixed changes offer **Commit staged** or **Commit all changes**. Under **Commit all changes** is a **Commit all changes & Push** twin (Commit staged has none — removed on request)
  (`gitCommit` with `push: true`): after a successful commit, and once the Git lock is released, `_pushAfterCommit`
  runs the Branches window's own `push` — or `publish` when the branch has no upstream — through `_gitRemoteAction`,
  with every question and check of that path; a question or an error opens the Branches window (`pushAfterCommit`). An empty index first offers
  **Stage all files**; the host defaults to staged-only and never implicitly stages on that path.
  Commit generates a message using the chat's selected agent, model and effort, then runs
  `git commit`. The text request runs separately without tools or conversation history. The default
  prompt asks for a subject `type(TASK-ID): summary` — a conventional type, the ticket key only when
  the branch name or recent subjects carry one (never invented), else `type: summary` — and the
  context names the branch for that (`commitContext`'s `Branch:` line). The prompt is written twice,
  `defaultFeaturePrompts` and `instructions` in `commitMessage.ts`; change both. A changed
  index or HEAD during generation cancels the commit. Managed-copy ownership is checked before
  Git discovery and every footer Git command. Mutations reserve the canonical per-worktree Git
  directory before checking busy agents: root folders, subdirectories and symlink aliases share
  a lock, while separate worktrees do not. Composer sends and background skills consult that
  same lock immediately before starting; queued work waits for its release. The copy's selected
  branch is separate from its original owned branch; cleanup only deletes a generated branch
  whose name matches the copy directory, preserving preexisting branches after checkout.
  Successful commits use a native VS Code notification that closes after ten seconds; no success
  banner or extra success entry is added to the chat. Failures remain visible with an explicit
  action to send their diagnostics to the current chat for repair; no repair turn starts automatically. See `gitAccess.ts`, `gitIndex.ts`,
  `gitCommit.ts`, `commitMessage.ts`, and `_commitWorkdir` in `chatView.ts`.
- **Publish, Push and Pull live in the Branches window**, a row under its search for the current
  branch (`renderBranchSync`, `_gitRemoteAction`). Its state comes from the same `for-each-ref`
  the list reads (`branchRefFormat`: upstream, its remote, `[ahead N, behind M]`, `[gone]`) and
  `git config --get-regexp '^remote\..*\.url$'`, so it costs no network and may lag the remote
  until the next fetch. Rules, each deliberate:
  - **The network goes through VS Code's Git extension** (`gitExtension.ts`, the `vscode.git`
    API's `push` / `fetch`), asked for: its `GIT_ASKPASS` answers an https remote through the
    editor's GitHub sign-in, where our own git (`GIT_TERMINAL_PROMPT=0`) can only fail. Its
    progress goes to the Source Control view, and an API call raises no toast — the error is
    thrown to us (`gitExtensionErrorText`). There is no fallback to our git: a disabled extension
    (`git.enabled: false`) is refused with that setting named. A working folder the extension
    has not opened is opened (`openRepository`), which adds it to the Source Control view. **The
    repository is matched by real path** (`gitRepositoryFor(root, folder)`): `rev-parse
    --show-toplevel` resolves a symlink (`/tmp` is `/private/tmp`) while the extension keeps the
    path it was given, and a plain comparison failed every action in such a folder.
  - **A push that resolved is not a push that landed.** The extension hands a failure to the push
    error handlers first, and the GitHub extension's takes PermissionDenied and a secret-scanning
    refusal (GH009) — its own dialog, then "handled", so `push()` resolves. After every push and
    publish the remote-tracking ref is compared with the SHA pushed (`_pushLanded`; for a publish
    `<branch>@{upstream}` — git refuses the `refs/heads/<branch>@{upstream}` spelling).
  - **Errors carry git's words.** The extension marks every "failed to push some refs" as
    `PushRejected` — a pre-push hook, a protected branch, a size limit — so "pull first" is said
    only for `(fetch first)` / `non-fast-forward`, with git's lines under it; an error the
    extension could not classify is shown by its stderr, never as "Failed to execute git".
  - **The refspec is spelled out**, `refs/heads/<b>:refs/heads/<upstream>`, and a full ref cannot
    read as an option. The upstream's name is `%(upstream:remoteref)`, not the tracking ref's
    tail, which a custom fetch refspec maps elsewhere. **A branch tracking another name is
    asked about** (`git switch -c feat origin/develop` tracks `develop`): plain `git push` with
    `push.default=simple` refuses that, so the window never assumes it. Publish is `-u <remote>` with the same name; the remote is the one picked, else
    `origin`, else the only one (`publishRemote`), a select appearing only with several.
  - **Never forced; a pull is fetch plus our own `merge --ff-only`** with hooks off, as on a
    switch — the extension's `pull` would merge or rebase as the user's config says. Diverged is
    shown and left to the user. A pull that moved nothing says "already up to date", not "Updated".
  - **Asked first, inside the window**: a push to the remote's default branch (`HEAD` of the
    remote, else `main`/`master`), to a branch of another name, and while agents work in the
    folder. The host answers `confirm` with a `confirmKey` naming the push and the question
    (`pushKey`), nothing done; the view resends it as `confirmed`, and the host asks again unless
    the push it would make now has the same key — a yes given about `feat` is no yes for `main`
    after an agent switched branches. Cancel is the default.
  - **A push does not wait for agents** (it reads HEAD and changes no file) but holds the Git
    lock with no busy list; a pull waits like a switch. **Refused in a folder whose settings are
    held back** (`_untrusted`): the extension runs the repository's `pre-push` hook (#443), and in
    Restricted Mode with every other footer Git path (#208).
  - **The pull request button** is GitHub's compare page (`pullRequestUrl`, `pull/new` without
    a known default branch), only for a published, non-default branch whose remote `parseRepo`
    accepts — another host gets none — and each path segment of a branch name is encoded on its
    own (`branchPath`): `encodeURI` left `#`, so `fix#12` opened `pull/new/fix`. **Credentials are
    taken out of a remote url before the state leaves the host** (`parseRemoteUrls`), since the
    branch state goes to the webview, which needs only host and path.
  - **↑ / ↓ walk the whole window in one order** (`branchNavItems`): the sync row's buttons,
    Return & Apply Stash, Create, then each branch's switch button; ← / → stay within a row
    (a branch's delete and Cancel). Hidden or disabled buttons are skipped, the remote select is
    left to Tab — arrows on a select change its value. The popup's own handler reads the key's
    `target`, never `document.activeElement`: ↓ in the search box focuses the first item and
    the event then bubbles to it, which moved focus a second step. The rows are full width and
    the window's text is 12px, as is the Commit window's (`.git-changes-popup`).
  Verified: parsing against a real repository under `npm test`, the build and typecheck. **Not
  run inside VS Code yet**, nor against a real remote.
- **The footer's Git state is read only for a view on screen, never in a blocked window, and one
  read at a time.** `git status` runs the repository's own `filter.<driver>.clean` commands from
  `.git/config`, which `core.fsmonitor=false` does not stop, and it used to run on every document
  opened or closed, theme or extension change — in Restricted Mode too, the chat never opened.
  `_readWorkdirGit` refuses where `_blocked()` does (#208) and still answers the view, whose
  refresh button waits for a reply. `_gitEventRefresh` starts nothing while the view is hidden or
  absent — it marks the read owed (`_gitStale`) and runs it when the view is shown — and turns a
  burst of events into one read after 300 ms. `_refreshWorkdirGit` keeps one read per folder in
  flight, with one rerun for calls that arrive meanwhile; the view gets a fresh read on `ready`,
  and `workdirGit` is never queued for a view that is not ready, or the replies piled up in
  `_queued` for the life of a window whose chat was never opened. The footer's actions — index,
  branch — ask `_blocked()` **before** taking the Git lock as well, since taking it runs
  `git rev-parse` in the folder.
- **The folder belongs to the conversation** (`StoredChat.folder`), absent meaning the window's
  own — its first local folder, else the home directory with no project, as before. Each tab can
  work in another project. `ChatTab.cwd` / `projectRoot` hand it to the session, so the approval
  menu's "inside the project", Codex's `workspace-write` sandbox and Claude Code's working
  directory all follow it; a toolbar skill's background run takes the folder of the tab it was
  pressed in.
- **The home directory picked as the folder is no project** (`ChatTab.projectRoot`, `isHome` by
  real path): the agents work there as with no folder at all — Codex read-only, every file
  "outside" to the approval menu — and the folder button says so (#447). As a project, `~`
  gave Codex's sandbox all of it, `~/.ssh` included. A workspace opened at `~` is left as it was.
- **Fixed once the conversation has started**: Claude Code keeps its sessions per folder
  (`~/.claude/projects/<folder>`), and `--resume` from another folder does not find the one it
  is given. So another folder picked for a started conversation **opens a new tab** in it, and
  the rows say so ("opens a new tab"). A new tab — New Chat, the switch card's options, Clear —
  starts in the folder of the tab it came from; "Continue in …" writes the transcript into that
  folder's `.ai-browser/`, where the next agent can read it without asking.
- **The rows**: the folder in use (a check), the window's own folders, those picked lately
  (`globalState` `aiBrowser.chat.recentFolders`, eight, every window), "No folder" when a folder
  was picked in a window that has none, and **Choose folder…** — the system's folder dialog,
  which pauses no browser tab. Picking the window's first folder stores nothing: the
  conversation then follows the window. A folder that is gone is refused and dropped from the
  recent list; a conversation from the history whose folder is gone refuses to send and says so,
  rather than letting the CLI fail to start with a message about its own executable.
- **Picking a local folder is consent for its configuration; a repository fetched from GitHub is
  not.** Both CLIs load the folder's own settings, Claude Code's hooks included — shell commands
  — and `claude -p` skips Claude Code's own trust dialog (its `--help` says so). A folder the
  user chose on their own disk is theirs; the chat still refuses as a whole in Restricted Mode
  and in a remote window. **A copy or a clone the extension fetched is held back**
  (`aiBrowser.chat.untrustedFolders` in `globalState`): Claude Code is started there with
  `--setting-sources=user --strict-mcp-config` — the session, the skills listing and a toolbar
  skill's background run alike — so the repository's `.claude/settings*.json` and `.mcp.json`
  are not loaded. Measured on 2.1.301: a `SessionStart` hook ran on an `initialize` alone, before
  any message, and with those flags did not (#443). The folder button names the files it holds
  back and offers *Trust this repository's settings…*, asked first; trusting restarts each Claude
  session there once it is quiet. Its own skills and commands are not loaded either — measured on
  2.1.301, `initialize` with those flags lists neither a `.claude/commands/*.md` nor a
  `.claude/skills/*/SKILL.md` of the folder, where without them it lists both. **Marking a folder
  held back lets go of every Claude session already working there** (`_markUntrusted`,
  `restartSession(true)`): whether a session loads a folder's settings is decided when it opens,
  and a clone into the folder a conversation is in — the default for an empty one — otherwise
  left that session, and every process it started after a model change, loading the clone's
  hooks (#450). A session in the middle of a turn is let go once the tab is quiet. Codex
  loads a project's own configuration only for a project it trusts already.
- **The files are a walk of our own** (`listWorkdir`, leaf, under test), not `git ls-files` —
  reading the index runs the repository's `core.fsmonitor` (#208), and nothing says the folder
  is trusted — nor the editor's own ripgrep, whose path differs between VS Code
  (`@vscode/ripgrep-universal`), forks and releases. Breadth first, so a cut listing keeps the
  shallow entries; `.git`, `node_modules` and what the root `.gitignore` names are skipped (a
  subset of git's rules — negations are not modelled, which can only leave a file out); symbolic
  links are listed and never entered; at most 20 000 entries, 16 levels and 3 s — the deadline
  checked per entry and raced against each `readdir`, so a stalled mount cannot hold it. Measured:
  this repository in 12 ms, a folder of 70 projects cut at 20 000 in 165 ms.
- **The `.gitignore` is matched without regular expressions** (#433): it is the repository's
  text, and `*a*a*…*b` turned into a backtracking pattern against a long name froze the
  extension host. A two-pointer wildcard walk per segment and a table for `**`, both polynomial;
  at most 2 000 rules of 500 characters.
- **Detection, the skills listing and Codex's one app-server start in the tab in front's folder
  — unless it is gone**, when they start in the window's (#434). A chat from the history or a
  removed copy in front made every agent read as not installed.
- **Sent once per opening, not with the state** (`workdirFiles`): twenty thousand paths in every
  40 ms post would be the whole message. The host keeps a folder's listing 15 s, since the
  button is opened again and again while a message is written. A folder moved to while the list
  is open is listed then.
- **The search is the view's** (`searchPaths`): the name starting with the query, holding it,
  the path holding it, every word somewhere in the path, its letters in order in the name
  (`cv` finds `chatView.ts`); a query with a `/` is about the path. Ties go to the shallower,
  then the shorter. Without a query the folder's own entries are shown, folders first; with one,
  the best 100, before the folder rows. **No row is chosen without a query**, so Enter on a
  fresh list cannot move the conversation to another folder — #397's rule. With one, the top row
  is chosen if it is a file; **a row is kept across rebuilds only when picked with an arrow key,
  in the same search** (#445) — chosen by the first letters, or under a pointer passing by, it
  outlived the typing.
- **A file or folder chosen is attached as its path**, as the "+" menu's File is: both agents
  read files themselves. The host resolves it against the folder in use and refuses anything
  that leads out of it — the path comes from the view. A folder's chip opens its text, not the
  folder: `vscode.open` on a folder opens a window.
- The list is rebuilt only when what it shows changes (#365); the button's icon is in the accent
  colour while the conversation has a folder of its own, and its tooltip names the folder.

#### A GitHub repository, three ways

The folder button's *GitHub* group: **Open a GitHub repository…** and the ones opened lately
(`globalState` `aiBrowser.chat.recentRepos`) open a form — repository, branch (empty: the
default one), and **how to use it**, asked for as a choice rather than one fixed behaviour:

| Way (`RepoMode`) | What happens | The user's files |
|---|---|---|
| `copy` — *Work in a separate copy* (the default) | a worktree of the repository in the extension's storage, on a new branch `ai-browser/<date>-<id>`; the tab works there (`StoredChat.copy`) | not touched |
| `clone` — *Clone into a folder* (the default when the folder in use is empty) | `git clone` into the folder in use when it is empty, else into a folder picked in the system dialog (itself if empty, else a new `<name>` in it); the clone is then an ordinary working folder | a new folder |
| `reference` — *Read it beside this project* | a read-only checkout in storage, handed to the agent beside its project (`StoredChat.references`) | not touched |

[src/chat/repoWork.ts](src/chat/repoWork.ts) does the git work, and its shape is the point:

- **One clone per repository** in `globalStorage/github/<owner>/<name>/base`, blobless
  (`--filter=blob:none`) and with no checkout of its own, fetched again each time it is used.
  Copies (`copies/<branch>-<hash>`) and read-only checkouts (`refs/<branch>-<hash>`, detached,
  forced and cleaned to the remote's latest on each use) are **worktrees** of it — two copies on
  one repository share its history and never each other's files. The hash is the branch's:
  `feat/x` and `feat-x` flatten to the same name and once shared a checkout (#436). Operations on
  one repository run one at a time.
- **Git runs only in folders this extension made**, whose `.git/config` is git's own default —
  never in one a repository chose, where reading the index runs `core.fsmonitor` (#208). The
  clone into a user's folder is made by `git clone` itself. **And every call sets
  `core.fsmonitor=false`**, and the copy's actions first check it is still our worktree
  (`isOurWorktree`, its `.git` file read without git, pointing into `base/.git/worktrees/`): the
  agent working in a copy can rewrite that file, and a removed copy made again as a plain folder
  sent git searching upwards — to the home directory's repository, perhaps (#435). And
  `gitBinary` answers an absolute path on every platform, found only in absolute `PATH`
  entries: a bare `git` is looked up when it runs, and an empty or `.` entry — or, on Windows,
  the working directory itself, searched first — ran a `git` committed in the repository
  (#448).
- **Only a clean "not found" is absence** in `repoWork.ts` (`exists`), the rule `presence()`
  follows for the MCP repair: any other `stat` failure read as absent sent `prepare` off to
  delete the clone and make it again under the copies' unpushed work. A clone that fails
  removes only itself, and the repository's folder only when that leaves it empty (#449).
- **Only github.com, and only an address of our own making** (`parseRepo` / `cloneUrl`, leaf,
  under test): what is typed is read for an owner and a name, and the clone address is built
  from them — a typed URL could name another host, or `ext::`, git's transport that runs a
  program. Branch names are checked too (`validBranch`), above all never starting with `-`.
- **No prompt ever waits** (`GIT_TERMINAL_PROMPT=0`): https, so the user's credential helper
  answers for a private repository; one it cannot answer for fails with git's own message,
  shown in the chat. A clone that fails leaves nothing behind. Ten minutes at most for network
  work.
- **Progress is the status bar** (`ProgressLocation.Window`) **and notices in the tab** — the
  form closes as soon as what was typed is checked (`githubAnswer`). One GitHub operation per tab
  at a time (`_repoBusy`), shown as a row in the group.
- **A copy goes to a tab that has not started** — a new one when the tab in front has, or when
  something was sent from it while the copy was being made — since a conversation's folder is
  fixed. A new tab, Clear and "Close this chat, start …" keep the copy and the references, as
  they keep the folder — so **several tabs can work in one copy**, and Push and Remove wait for
  all of them, their background skills included (#437). A removed copy is forgotten in every tab
  that had it (`_forgetCopy`). A clone lands in the tab it was asked from, not whichever is in
  front when it finishes.
- **On a copy the group has its actions** (`repoAction`): *Changes in the copy* (status, new
  files and the diff from where the copy and its branch last met — `merge-base`, since
  `origin/<base>` moves with every fetch of the repository and upstream's new files read as the
  copy's deletions, #444 — in a read-only tab); *Push and open a pull
  request…* — asked first in the view; uncommitted changes are committed with the chat's title,
  the branch is pushed with `--set-upstream`, and GitHub's compare page opens (no `gh` needed,
  and the user writes the pull request there); *Open the copy in a new window*; *Remove the
  copy…* — asked first, refused while the tab works; a conversation that worked there cannot go
  on and says so. A copy left by picking another folder before anything was sent stays in
  storage.
- **A reference is given to Claude Code with `--add-dir=<path>`** (`readDirs` of
  `openSession`), with `=` since the option is variadic and would take the arguments after it.
  Measured on 2.1.301: the CLI takes it and reads the folder. It goes in at the process's
  start, so adding one drops an idle Claude session, resumed by its `ref` at the next message. It
  is refused while the tab works; one that started working while the checkout was being made
  has its session let go once the work ends (`restartSession`), and says so (#438). **Once the
  tab is quiet, and 2.5 s later still quiet** — no turn, nothing pending, no prompt waiting to be
  taken in: Claude Code answers a late message or a background agent's end with a turn of its
  own a moment after the last one, which `busy` does not cover, and a session let go in that
  gap took the prompt as answered and ended the CLI before it replied (#446). Codex reads anywhere in its sandbox already. The agent is
  told in a chip on the next message; an edit there is "outside the project" to the approval
  menu, so it is asked about — read-only by the approval menu, not by the file system.
- Measured against `octocat/Hello-World`: a copy in 2.1 s, a read-only checkout in 1.1 s, a
  second branch, a missing branch and a missing repository refused with their reasons, a clone,
  the changes text, a removal. Push was checked only to the point git refused (no rights there).
  **Not run inside VS Code yet** — the form and the rows were checked in headless Chrome.

#### The GitHub tab: pull requests and Actions runs

A composer tab (**GitHub**, ⌥G) beside History, asked for: the open pull requests and the
latest Actions runs of the repository **the conversation's working folder** belongs to. The
leaf is [src/chat/githubStatus.ts](src/chat/githubStatus.ts) (under test), the host
`_githubStatus` in `chatView.ts`, the view `renderComposerGithub`. Editor-only (`githubStatus`
in `commands.ts`). Decisions:

- **The repository comes from the folder's remotes, never from the view**: the current branch's
  upstream remote, then `upstream` (a fork's parent, where its pull requests live), then
  `origin`, then any github.com remote (`pickGithubRemote`, `parseRepo` — github.com only).
  Read with the footer's own guarded git (`_runWorkdirGit`), refused where `_blocked()` is.
- **Three sources, in order**: the `gh` CLI (`gh pr list` / `gh run list --json`, measured on
  2.98); VS Code's own GitHub sign-in (`authentication.getSession('github', ['repo'], { silent })`,
  never a prompt unless the user presses *Sign in to GitHub*) with the REST API; the public API
  with no token (public repositories, 60 requests an hour). Each answer names its source.
- **`gh` runs in the home directory with `--repo owner/name`**, so it reads none of the
  repository's own Git configuration (#208); found by absolute path (#448), prompts and the
  update notifier off.
- Per-pull-request checks and review state come only from `gh`; the API list has neither.
- Answers are cached 30 s per repository in the host and in the view; a row opens the page
  in the system browser, always (asked for). Items on the folder's branch are marked.
- **Not built:** other hosts (GitLab, Bitbucket), merging or re-running from the tab, live
  updates while it is open. Not run inside VS Code yet.

- **"Continue in …" in a picked folder writes there**, and the view sweeps the `.ai-browser/` of
  the recent folders and the open tabs' folders at start (`cleanUpReportsIn`), which the
  activation sweep — the workspace's only — does not reach.
- **Known and left:** `_emptyFolder` and `isDirectory` are synchronous (`opendirSync`,
  `statSync`), cached or one call each; on a stalled mount they block the host for that call.

**Not built:** an issue or a pull request as the input (an issue's text attached, a PR checked
out into a copy for review).

### The toolbar of skills

Asked for: skills of the chat's own, as buttons above the message box (`.skill-bar`). A toolbar
skill is a **name** (one word, lower case, no spaces, as the CLIs' skills are — asked for; the
editor lowers capitals as they are typed, and a stored name with capitals is read back lowered,
not refused), a **prompt** that may name the
agents' skills (the editor's prompt has the same `/` / `$` palette as the box) and take
parameters as `{{name}}`, **where it is offered** (every agent, Claude Code or Codex), **what
becomes of the result** — in the chat, to the clipboard, silently, or in a notification — and
**whether its end is told**, an **icon** from the codicon set, an optional **colour**, **label** and **tooltip**,
and **parameters** — name, type (text, number or a choice of values), maximum length, preset;
each is required. Kept in `globalState` (`aiBrowser.chat.toolbar`), so every project has the same
toolbar; at most 30, prompts up to 20 000 characters.

- **The bar lives in the Skills tab above the composer** (asked for): `composerTabs` — **Chat**
  (the message box, no skills) and **Skills** (every skill, wrapped, in the box's place; the
  composer's agent/model toolbar stays under both, since a skill runs on them). The skill bar is
  a child of `.composer`, shown by `.skills-mode`; the choice is `composerTab` in the webview's
  `setState`, so every `vscode.setState` call must carry it (a test sandbox defines it too).
- **The message box stays under every composer tab** (asked for): on Skills, Activity and History it
  is cut to one line (`.composer:is(.skills-mode, .list-mode)`, the mirror's padding matched), Send
  alone in its column; the chips and suggestions show on the Chat tab only (asked for) — they still go with the next message.
- **Activity and History are composer tabs too** (asked for): Activity is one scrolling list in the
  box's place (`.composer-list`) with two sections, Agents then Access (`.cl-section`); History lists
  this chat's own messages, newest first (`renderComposerHistory`, from `state.entries`); a click
  scrolls the thread to that turn and flashes its prompt (`scrollToPrompt`). An agent row opens the Agents panel on that agent's card; Access lists every tab with Take / Make free. History asks the host with
  `listHistory` (editor-only in `commands.ts`) each time its tab opens. One resize handle serves
  both lists. **Its height is the user's**:
  a handle above it (`.cl-resize`, pointer drag, double-click resets to the 33vh default) sets
  `overviewHeight` in the webview state, clamped to 80 px–80 % of the view, so every
  `vscode.setState` carries it beside `composerTab`. A saved `agents` / `access` tab from before
  the merge opens as Activity. Lists are rebuilt only when their rows change (#365); the
  look is the `cl-*` set in `chat.css`.
- **Made in an editor drawn over the chat** (`openSkillEditor`, a `history-panel`), opened from
  the "/" palette's *Toolbar* group — Add skill to toolbar…, Edit toolbar skill…, Delete toolbar
  skill… — or from a button's right-click menu, which also moves it left or right. The editor is
  built once per opening and never on a state post, so typing in it is never rebuilt away. The
  host checks what it saves (`validToolbarSkill` in `toolbarText.ts`) and answers `toolbarSaved`
  (the editor closes) or `toolbarError` (it stays, with the reason): a name taken by another
  toolbar skill, a malformed parameter, a preset that does not fit its type.
- **The editor outlives the view losing focus.** A blur of the webview (a click into a file,
  Cmd+Tab, the editor's own native colour picker) or the view being hidden closes menus and
  questions, never a form holding unsaved input: the skill editor, the Chat Settings panel, and
  the parameters popover while it holds the GitHub form or a skill's parameters
  (`formHoldingInput`, `paramsFormAnchor`). Reopening any of them rebuilds it from stored state,
  so closing it there threw the text away (#464's class). The anchor keeps its `active` mark, so
  a second press still closes the form; Escape, its own buttons and a press elsewhere in the view
  close it as before.
- **The icon list is the font's own**: `@vscode/codicons/dist/codicon.csv` bundled as text
  (esbuild's `text` loader), searchable, so nothing offered fails to draw.
- **Three colours** (asked for, one at first, then one each for the label, the border and the
  icon — `colors: { text, border, icon }`), each the theme's own, one of the theme's chart
  colours by name (`red`, `orange`, `yellow`, `green`, `blue`, `purple` →
  `var(--vscode-charts-<name>)`, so every theme has them), or any `#rrggbb` from a native colour
  input. A run's status colour (waiting, done, failed, and running's border) wins over each: the
  status rules come after the tint rules and reset the label and icon with a selector at least
  as specific. The host keeps nothing else (`toolbarColors` and a hex pattern), so no stored
  string reaches CSS but those; a skill saved with the one `color` of the first version is read
  as its label and icon colour. **Each colour row is built once and only marked afterwards**
  (`colorChoice`): rebuilding it on the colour input's `input` event took that input out of the
  page, which closes its picker in the middle of a drag.
- **The palette works on two fields.** `paletteTarget` is the box or the editor's prompt; only the
  box offers the chat's own commands and the toolbar skills, the editor lists the skills of the
  agent the skill is for (the tab's when it is for all). Over the editor it is drawn under the
  field when there is no room above (`z-index` 50, above the panel's 40), and a click inside the
  editor closes only the palette, never the editor.
- **The button's background is hover and press only** (`:hover`, `:active`), asked for after it
  stayed shaded once a right-click menu or a popover had opened from it: `openAbove` marks its
  anchor `active` so a second press closes what the first opened, and that mark is not drawn on a
  skill button (`closePopups` clears it as well). Focus after a click is not drawn either; only
  `:focus-visible` is.
- **The right-click menu runs it two ways** (asked for): **Run**, a press, and **Run after this
  turn** (⌘/Ctrl+click on the button does the same), which holds the skill in the tab's queue
  until the agent has finished, as ⌘Enter holds a message — then Edit, Delete and the moves. Each
  row shows its gesture (`MenuItem.shortcut`). With nothing running a queued skill starts at once
  (after the drain's half second). How it waits depends on where the result goes:
  - **into the chat**, its prompts go into the queue (`ChatTab.enqueue`), one prompt as well as
    several, so it is the multi-prompt path; the queue row reads "/name — sent when this turn ends";
  - **clipboard, silent or in a notification**, a `QueuedRun` waits in the queue ("runs in the background when this
    turn ends") and the drain starts the background run when its turn comes, through
    `_runToolbarSkill` again — so the agent, model and checks are the tab's at that moment, not at
    the press. The item after it waits for it to be started, not to finish;
  - either is taken out with the queue row's ×, dropped (not given back to the box) when the tab
    lets go of its queue, and counted by the close's question;
  - **not refused as "still running"** and not asked "run it again?": another run later is what
    was chosen.
- **Pressing a button**: with parameters, a popover asks for them (the type rules again in the
  view for the form, `valueProblem`; the host checks again in `fillPrompt`), Enter runs. A skill
  also runs from the palette's *Toolbar* group, and **a message sent as `/name args` or
  `$name args` naming a toolbar skill runs it instead of being sent**: one parameter takes all
  the arguments, several take a word each and the last the rest, and what is missing or invalid
  is asked for. It takes precedence over a CLI command of the same name. Toolbar skill names are
  marked in the text like the agents' commands. **The tab it runs for is taken at the press**
  (`requestSkill`), not when a popover's Run or "run again" Yes is clicked: New Chat in the title
  bar is a click outside the view, so nothing closes the popover, and Run then went to the new tab
  (#413). A tab closed in between is refused through the status bar, not dropped in silence. **A
  toolbar write that fails says so** — the editor stays open with the reason — where it used to
  close as if the skill were saved (#255's rule).
- **Where it runs.** The skill runs on the agent of the tab it was pressed in, and the bar shows
  only the skills that agent is offered. Before it is sent, every skill it names is written the
  way that agent reads one (`adaptSigils`: `/name` for Claude Code, `$name` for Codex), so a skill
  for every agent works on either.
  - **In the chat**: sent to that tab as a message, through `_send` with its own empty attachment
    list, so it does not take the chips in the box.
  - **To the clipboard / silently / in a notification**: a background run (`ToolbarRuns`), a session
    of its own on the tab's agent, model and effort, never shown in a tab, let go when its turn ends.
    A clipboard run's prompt gets `withResultMarkers` (a notification run's too, worded for where
    its result goes): put the result, and nothing else, between `<<<RESULT`
    and `RESULT>>>`, each on a line of its own, no fence inside. **The instruction stands before
    the prompt and again after it**: once, at the end, it lost to the prompt's own wording — a
    skill the prompt names brings its own output format — and the model wrote no markers, so a
    generated commit message reached the clipboard with the reply's preamble and closing remarks
    around it. **Markers, not a code fence or JSON**: a fence closes on any code block inside the
    result, and JSON makes the model escape every line break and quote of a multi-line text,
    where one slip leaves nothing to copy. `extractResult` takes the **last** pair (a model quoting
    the instruction writes them twice), **each marker a line of its own** — a commit message
    about this very feature named `<<<RESULT / RESULT>>>` in a sentence, and searching the text
    for the markers started the copy there, the preamble's last words with it (#414); a pair
    written inline is still read when no line is a marker — and drops a fence wrapping all of it; failing markers, the
    reply's **last fenced block** (a shorter fence inside a longer one is content); failing both,
    the whole reply — the button saying which. Measured on Claude Code: "explain why the sky is
    blue, then give the letters in 'browser'" copied `7`, and a commit message asked for *with* an
    introduction, a code block and a closing remark copied the message alone.
- **A background run's questions** are answered by the approval menu like a tab's; one the menu
  leaves to the user stops the run and turns the button to *waiting* (warning colour), and a click
  shows the question with Allow / Deny / Stop — there is no conversation to show a card in.
  Measured on Claude Code: a `touch` asked, Allow created the file, the run ended done. A button
  of a run shows running (accent, breathing), waiting, done (green, a flash, 2.5 s) and failed
  (red, 8 s, the reason in its tooltip). **A run keeps every open question, oldest first**
  (`Running.asked`, a list): a turn that runs tools side by side asks several at once, and one
  slot let the second hide the first — unanswerable while the CLI waited on it, the button back
  to "running" for good (#405). The button shows the oldest; each answer or withdrawal shows the
  next. **A change in the approval menu answers them** as it does a tab's cards
  (`ToolbarRuns.approvalModesChanged`, #407). Deleting a skill stops its runs; **closing the view
  ends them all** (`viewClosed`, failed, "The chat view was closed."), as it ends the tabs'
  turns — it did not, and a run went on unseen, or sat on a question nobody could answer (#406).
  The view is kept while hidden, so this is a real close. **A Refresh that replaces the agent's backend ends its runs too** (`backendReplaced`,
  failed, "run it again"): the replacement disposes every session, and a disposed session reports
  no end of its turn, so the button read "running" for good (#403). A Stop that lands while a
  clipboard result is being written stays "Stopped.".
- **A background run is a row of the agents list** of the chat it was pressed in — asked for:
  pressed, a clipboard or silent skill showed nothing but its button, and a run is an agent
  working in the background. `ToolbarRuns.rows(chatId)` gives each run a `ToolEntry` with
  `tool: 'agent'`, published as `state.skillAgents` and merged into `agentRows` by start time,
  so the composer's agents button, "N agents running" under a finished turn, the tab's agent
  count, the list, the card and its Stop all take it with nothing of their own. The row carries
  the skill's own prompt (not the result-marker instruction around it), its tool calls, tokens and
  the tool it is on; the reply becomes the report **when the run ends**, never while it streams,
  or the list rebuilt on every chunk (#365). Its card says "Started from the toolbar"
  (`AgentInfo.origin`). Stop on the row (`toolbar-run-<n>`) goes to `stopRow`, not to the tab.
  Ended rows stay, 20 per chat and 200 in all, for the life of the window: they are not part of
  the chat and are not saved with it. The report and the prompt are cut at 20 000 characters (the
  ended rows go out with every state post; the clipboard has the result whole), and a call Codex
  reports twice is counted once.
  - **A run stops when its tab lets go of the chat it was pressed in** — closed, cleared, another
    chat from the history or the other agent in its place, the chat deleted (asked for: "надо
    стопать"). `ChatTab.close` and `discard` call `TabHost.released(chatId)`, which runs
    `ToolbarRuns.stopChat`; every such path goes through one of the two. Left running, the run
    dropped out of every list while it went on spending the plan, and the close and switch
    warnings, which count it, promised a stop that did not come (#416). So the warnings are true
    now: `ChatTabSummary.skillRuns` is sent beside `agents`, the tab's badge and "Closing it
    stops … N agents" add them up, the close and Clear ask first while any run, and a chat from the
    history opens into a new tab rather than into one running a skill.
  - **A run stopped on a question says so in the list** — "Waiting for your answer" — and its card
    shows the question with Allow / Deny (`AgentInfo.waiting`, answered by `toolbarApprove` under
    `AgentInfo.skill`), as the button's popover does.
- **A skill already running asks before it runs again** (`openAgainPopup`, asked for): "… is still
  running. Run it again?" with Stop, Yes and **No — the default**: focused and drawn as the
  primary button, so Enter answers No, as do Escape and a click elsewhere. Every way of starting
  a skill goes through `requestSkill` — its button, the palette, `/name` typed — and a run stopped
  on a question shows that question instead. Yes sends `runToolbarSkill` with `again: true`; the
  host refuses a second run without it ("still running"), so two quick clicks inside one state
  post do not count as a yes. **A skill may therefore run several times at once**: `ToolbarRuns`
  keys runs by a number of its own, and the button shows the one that most needs the user —
  waiting, else running (with `count` when more than one), else the newest to end, a tie in the
  same millisecond going to the newer run, or Stop read "Done." from the run before it. **An
  answer names the question shown** (`toolbarApprove` carries `approvalId`), and reaches only the
  run asking it — with two runs waiting, the skill's id alone answered the first found while the
  popup showed the newer one's question, approving a command nobody had seen (#402). Stop stops
  every run of the skill. **A skill sent into the
  chat counts as running too**, while the tab it was sent to is busy (`_chatSkillTabs`,
  `inChat`), and from the start of the send — detection can hold it for seconds before the tab is
  busy, and a post in between would otherwise have dropped it. Its Stop is that tab's own Stop.
- **Its result in a notification, and its end told** — asked for. "In a notification"
  (`result: 'toast'`) is a background run like the clipboard's: the last prompt carries the result
  markers (`withResultMarkers(…, 'notification')`, which says where the result goes) and the marked
  result is shown in an information notification with **Copy** (the whole result) and **Open** (the
  whole result in a read-only plain-text tab, `_openText`). "Notify when it ends" (`notify`) is
  none, `auto` — "… is done.", "…: Copied to the clipboard.", "… failed: <reason>" — or the user's
  own text, where `notificationText` fills in `{{skill}}`, `{{status}}` (done or failed),
  `{{message}}` (what the button says), `{{result}}` and the parameters by name. It works for every
  result, chat included. Details that matter:
  - **Told only for an end the user did not cause.** Done, failed, or stopped by its check is told;
    the skill's own Stop, the tab's Stop, a closed tab, a tab cleared or given another conversation
    ("Close this chat, start …"), a deleted skill and a closed view are not — the last ends every
    run at once (`_end`'s `stopped` and `quiet`). `ToolbarRuns` hands each end to its host
    (`ToolbarRunHost.ended`), and a skill sent into the chat is told once its work in the tab is
    over (`_toolbarRunsState`), failed when the tab's mark is `failed`. Each press of a chat skill
    is a `ChatSkillRun` of its own, remembering the conversation it went into: one record per skill
    let a second run overwrite the first, whose end was then never told, and only the tab's Stop
    marked a run as the user's end, so Clear, a replaced conversation and a closed view each
    announced "… is done." for work the user had just ended (review finding).
  - **One notification for a notification result.** With its own text, the result is added after
    it unless the text names `{{result}}`; a notification result that ended with nothing to show
    says why even with no notify chosen — it was asked to show something.
  - **Everything shown goes through `plainInNotification`**, a cap of 1 000 characters included: a
    result is a model's text, a page's words can be in it, and a notification body opens
    `[x](command:…)` as a one-click command (#124, #132). Copy and Open carry the result as it is.
  - **A notification pauses a browser tab on screen** until it is dismissed
    ([why](#a-notification-pauses-the-built-in-browser)); this one is opted into per skill, and the
    editor says so under both choices, "In a notification" and "Notify when it ends".
  - **Stored where an older build cannot undo it**, #424's rule: `toast` and `notify` live in
    `aiBrowser.chat.toolbarExtras` by skill id, and the skill itself is stored with `silent` for a
    `toast` result — what an older build then does — since an older build reads an unknown
    `result` as `chat` and writes it back so. On reading, `toast` is restored only over that
    `silent`: a skill an older build changed to another result since keeps that one. **A stored
    `notify` this build cannot take is dropped on reading, not the skill** — a longer text a newer
    build allowed, a hand edit: `validToolbarSkill` refuses it, and a refused skill vanished from
    the list and was deleted, next prompts and all, by the next save (review finding). It is
    refused only from the editor.
  - Verified with the compiled `ToolbarRuns` and `ChatViewProvider` against a stubbed `vscode`: each
    result and notify combination, Copy and Open, no notification after a Stop or a closed view,
    the storage round trip and an older build's edit; the editor in headless Chrome.
- **A skill can send several prompts, one after another** — asked for: the first prompt, then
  **next prompts** (`ToolbarSkill.followUps`, up to 9), each sent once the agent has finished the
  one before it, as messages queued with ⌘Enter are. Between two prompts there is either nothing —
  the next one always goes — or a **check** in the user's words (`ToolbarStep.check`, asked for
  in those terms: "a check prompt between them, or not"). The check is made by the agent at the
  end of the step before: that step's prompt is sent with `withNextDecision` appended — judge the
  check, end with a line `<<<NEXT:YES>>>` or `<<<NEXT:NO>>>` — and `stepGate` reads the last such
  line of that step's reply. No yes, no next prompt: a no, no marker at all, or a step that ended
  in an error (it judged nothing) all stop the skill there, with a line saying which. The
  parameters fill the checks as they fill the prompts (`fillPrompt` returns `steps`).
  - **Into the chat, every prompt goes into the tab's own queue** (`ChatTab.enqueue` with a
    `SkillStep`), the first included, and `_drainQueues` sends them. Sent straight out while a turn
    ran, the first would be steered into that turn and its check read from somebody else's reply.
    The queue shows them as "/name, prompt 2 of 3 — sent if: …". The gate runs at the end of the
    step's turn (`_gateNextStep`), the pending entry carrying its `SkillStep`; the instruction is
    added to what is sent and not to the prompt shown.
  - **A checked prompt goes out only once its check has passed** — `_gateNextStep` puts its queue id
    in `_cleared`, and `dequeue` drops the skill's remaining prompts, with a line, when it meets a
    checked prompt that is not there. "Not gated" is not "passed": a step whose send failed, or
    that `_send` returned on before `tab.send` (blocked, no agent), has no turn and so no gate, and
    the next prompt then went out unchecked (review finding; `stepNotSent` now also stops the
    skill there). **Which check a step asks is decided when it is sent**, from what is queued then
    (`asked` on the pending entry), and the gate accepts the answer only for that same check: a
    prompt taken out of the queue with its × made the step before answer one check while the gate
    read it as another's, and removing the first prompt sent the second with no check at all.
  - **The next prompts are stored under a key of their own**, `aiBrowser.chat.toolbarSteps` (skill
    id → steps), and `aiBrowser.chat.toolbar` holds the skills without them. An older build reads
    the toolbar through its own `validToolbarSkill` and writes the whole list back on any edit, so
    a window not yet reloaded after the update stripped every skill's next prompts. It never
    touches the second key; `_toolbar` merges the two on every read and `_storeToolbar` writes both.
  - **A second run of the same skill adds its chain** (`_chatSkillTabs.chains`), and the skill's
    Stop drops every chain of it — a single slot let Stop, pressed between two prompts, miss the
    first run's.
  - **A background run does not count Claude Code's own turns as steps** (`ownTurns`, from
    `autoTurn`): a step that started a background agent gets a turn of the CLI's own when the agent
    finishes, and its end would have sent the next prompt on the wrong reply. **A skill's queued prompts are dropped, not
    given back to the box**, when the tab lets go of its queue (Stop, Clear, another agent in its
    place) — they are the skill's, not something typed — and the skill's own Stop drops them even
    with the tab idle between two of them. The button reads running while any are queued
    (`_chatSkillTabs.chain`), or it read "done" in the half second between two prompts.
  - **In the background, one session runs them all** (`ToolbarRuns.start` takes the filled steps):
    each next prompt is sent on the step's `turnEnd`, the check of the step after is appended to a
    step's prompt, and the clipboard markers go on the last prompt only — the result is read from
    the last step's reply alone (`stepReply`). A skill stopped by its check ends **done**, saying
    after which prompt and why, and copies nothing. The button's tooltip and the agents list say
    which prompt is running ("prompt 2 of 3", `ToolbarRun.step` / `steps`); the report keeps every
    step's reply, separated by a rule.
  - Measured on Claude Code 2.1.301 (Haiku) through the compiled `ToolbarRuns`: a three-prompt
    clipboard skill whose third prompt checked "7 is even" answered `<<<NEXT:NO>>>` and stopped
    after prompt 2; checking "7 is odd" ran all three and copied the third reply's result. The chat
    path was checked against a fake session: a yes ran all three, a no and a missing marker each
    stopped after prompt 2 with their line.
- **The buttons are kept and updated in place** (`skillButtons`), #365's rule: a run's state
  changes them often.
- **Their tooltip is drawn by the view** (`hoverTip`, reading `data-tip`), not a native `title`:
  reported as no tooltip at all on these buttons in VS Code, while the DOM checked out in
  Chrome — the button under the pointer, its `title` set. The cause was not pinned down; the
  drawn one appears after 450 ms, above the button inside `#app`, goes on leave, press and
  scroll, and is redrawn in place when a run changes its text.

### Finding the CLIs

`listAgentBinaries` ([src/chat/agentBinary.ts](src/chat/agentBinary.ts)) collects every copy it can find —
`PATH`, then `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`, then **the
copy the assistant's own VS Code extension ships**, `anthropic.claude-code/resources/native-binary/claude`
and `openai.chatgpt/bin/<platform>/codex` — asks each one `--version`, and `chooseAgentBinary`
**uses the newest** unless the project picked another (below).
The setting, when set, overrides all of it. A tie keeps the search order, so `PATH` wins between
equal versions. The agent dropdown's tooltip names the version, the source and the path.

**A project can pick the copy by hand.** The gear at the right of the agent menu's "Agent"
heading opens *Agent apps*, drawn in the view: a select per agent with **Auto — newest** (naming
the copy Auto is using) and every copy found by version and origin — with the folder too where two
copies would read alike, since a native select shows no tooltip — the copy in use under it, and a
link to VS Code's own `aiBrowser.chat.<agent>Path` setting. Asked for, so that a project needing
an older CLI can keep it while Auto stays the default. How it holds together:

- The choice is kept per project in `workspaceState` (`aiBrowser.chat.agentBinaries`; absent is
  Auto) and **honoured only while it matches a copy found** (`chooseAgentBinary`); the host refuses
  a path the view sends that detection did not find. It picks among what was discovered and never
  names a program of its own — the copy found is what runs, not the stored text.
- **Matched by the file, not the spelling**: one file reached through two `PATH` entries is listed
  once, under whichever came first, and a `PATH` reordered between windows used to read the pick as
  gone. **The copy bundled with the assistant's extension is stored as `bundled`**, not by path:
  its path carries the extension's version, so a pick of it went missing on every update.
- A pick that is gone falls back to the newest; the select shows it as "Not found: …" so that
  choosing Auto is a change and clears it — shown as Auto, it could never be cleared.
- **The setting still overrides it**: the select is disabled with a note naming the setting, and
  the link opens it. The setting stays `application`-scoped for the reason below.
- A pick re-detects **that agent only** (`AgentRegistry.redetect`), after any detection already
  running — re-detecting both could replace the other agent's backend and end a reply nobody
  touched. It does not keep the copy in use: the "keep the current copy unless another is proven
  newer" rule is for a Refresh, and applied to a pick it left Auto beside a copy of unknown
  version for good. The backend is replaced when the copy differs, so a reply running on the old
  copy ends and each tab resumes on the new one at its next message, by its `ref`. A Refresh
  pressed meanwhile waits for it and then runs in full.
- The select keeps the pick while its detection runs (`pendingPicks`) — falling back to the old
  value for that second read as a refusal — and the panel says why an agent does not work, a
  setting that names no executable or a picked copy that is signed out included.
- The panel is rebuilt only when what it shows changes: a native `<select>` whose element is
  replaced closes under the pointer, and state posts arrive every 40 ms while a reply streams.
- A menu opened from a pill near a narrow side bar's right edge is moved left to stay inside the
  view: `#app` clips what overflows, and at 300 px the gear — the one way into this panel — was
  cut off.

Measured with this machine's copies: Auto took Codex 0.162.0-alpha.17.2 from the Codex extension
(GPT-6.1-Sol, GPT-6-Astra, GPT-6-Sol), picking 0.145.0 by hand switched to it and its older list
(GPT-5.6-Sol …), and Auto brought 0.162 back.

**Newest, not first, and the reason is visible in the model list.** The first version took the
first match on `PATH`. On the machine it was written on that was a standalone `codex` 0.145.0
left in `~/.local/bin`, while the Codex extension carried 0.162.0-alpha.17.2 — and `model/list`
is the server's answer *to the client's version*: the old binary was offered only GPT-5.6-Sol /
Terra / Luna, each described as "Older generation…", while the extension's copy got GPT-6.1-Sol
(default), GPT-6-Astra, GPT-6-Sol and GPT-6-Luna. Reported as "Codex shows old models". A
pre-release therefore counts as newer than any lower release (`compareCliVersions`, under test):
the alpha *is* what the user chats with in Codex. Claude Code had the same exposure and simply
did not show it, the `PATH` copy and the extension's being the same 2.1.301.

The extension's copy is still why someone with only an assistant's VS Code extension, and no CLI
on `PATH`, gets a working chat. `getExtension` gives the active version's directory, so an
extension update moves the path and the next detection follows it.

**Only absolute `PATH` entries are searched.** A relative one (`.`, `node_modules/.bin`) is
probed against the extension host's working directory and spawned against the workspace's — two
different files, and the second is one a repository can plant. **And the copy already in use is
kept when a Refresh cannot prove another newer**: its `--version` timed out on a busy machine, or
the versions are equal. Switching replaces the backend, which ends a running conversation for
nothing.

On Windows only `.exe` is accepted. An npm-installed CLI is a `.cmd` shim, which Node refuses to
spawn without a shell since the CVE-2024-27980 fix, and a shell would put the arguments through
`cmd.exe` quoting.

**Detection is a real call, not a file check**: a binary that is present but signed out, or too
old to answer `initialize` / `model/list`, is listed as unavailable with the reason. Codex says
so outright (`account/read` → no account, `requiresOpenaiAuth: true`). It runs when the view's
webview first says `ready`, when trust is granted to a folder the view was refusing, and on
Refresh Agents, which reveals the view first — **no CLI starts before the chat is opened**.
Claude's probe exits once it has answered — kept at most `usageProbeWaitMs` (8 s) more for the
plan's usage, read on the same process ([the plan-limit line](#the-plan-limit-line-and-the-colour-of-u)).
Codex's answer comes from the app-server
itself, which then shuts down 30 s after nothing needs it (see below) — it used to stay up for
the rest of the window, a signed-out Codex included, for a user who might only ever chat with
Claude. A path set in `aiBrowser.chat.<id>Path` that is not an executable says so, rather than
"not found, set the path".

**A Refresh that finds another copy replaces the backend, and the chat follows.** Replacing it
disposes every session it held, the open chat's included; `AgentRegistry.onDidReplace` makes the
chat end a turn it was running, drop that session, and say so — "replaced by another installed
copy", or "no longer installed" when Refresh found none, so the next message opens a session
on the new copy and resumes the same conversation by its `ref`. Before, Claude ignored every later
message in silence and Codex answered each with "Closed.". **A message sent while detection is
still running waits for it** instead of being refused: the webview clears its draft on send, so a
refusal lost the text and told the user to install an agent that was there. Once detection has
found nothing, the send button is disabled and the draft stays in the box.

### Processes

[src/chat/agentProcess.ts](src/chat/agentProcess.ts) is the one piece both share. `spawn` with an argument
array and no shell; an `error` listener on `stdin` (#24); stderr's tail kept, since it is the only
place an early exit says why; and **`CLAUDECODE` removed from the environment** — VS Code started
from a Claude Code terminal inherits it, and the CLI then refuses to start, taking itself for a
nested session. A kill of ours is never reported as a failure, whatever exit code the platform
gives it.

Lifetimes: a Claude process lives as long as its conversation's tab (closing the tab, replacing
it with another agent ends it; a chat from the history only ever goes into a tab with nothing
running) — so five Claude
tabs are five `claude` processes. The Codex app-server lives while a Codex conversation
holds a session, or a detection, a usage read or a skills listing is under way, and **shuts down 30 s after the last
of them lets go** (`idleShutdownMs`); it is restarted on demand, and a thread loaded in an earlier
app-server is resumed with `thread/resume` (`CodexSession._loadedIn` against
`CodexBackend.generation`). An app-server whose `initialize` fails or times out is ended there
and then — clearing only the handshake promise left it running, and each retry added another
process that lived until the extension host exited. Everything is disposed with the view
provider, and **a disposed view lets go of its conversation too**: nothing can show what the CLI
does once the view is gone, so the turn is ended, the chat saved and the session dropped rather
than left working unseen on the user's quota. A kill is SIGTERM, then SIGKILL after 3 s for a
process that is still there — a CLI busy in a tool call, or one that traps the signal.
**With the chat open, the extension does start processes** — the user's own CLIs, and
only while a conversation needs them — and, once keep-awake is switched on in some window, one
detached daemon and the OS's own lock under it; see
[Keeping the computer awake](#keeping-the-computer-awake) — and a shell (or an agent's CLI) for each
[terminal tab](#terminal-tabs-a-real-shell-in-the-chat) the user opens, killed with its tab. Nothing
else in the extension does.

**Every path that lets go of a session mid-turn ends the turn in the chat first** (`_endTurnHere`,
in `ChatTab`): closing a tab, the other agent taking a tab's place ("Close this chat, start …"), a
replaced backend, the view or the window closing. Deleting a chat a tab holds lets the session go
without saving (`discard`). New Chat and a chat from the history no longer end anything: they open
a tab, or use one with nothing running. The session being disposed reports nothing, so without it the chat was saved
with its tool rows "Running…" and its thinking shimmering, and showed them so for good when
reopened. The turn's state is read from the chat (`_pending`), not from the session, whose
`running` a dispose may already have cleared — which is exactly what happened when the registry
disposed a Claude backend *before* announcing it; it now announces first. A chat opened from the
history is `settled` as well, so one saved mid-turn by an earlier build opens with nothing
running. And a send that settles after its chat was **deleted** does not save it back: the send can
take seconds on a cold app-server, and the save wrote the deleted prompt into the history again.

**Stop applies to the turn it was pressed during, not to the queue behind it.** Measured on
Claude Code: the interrupt is acknowledged at once, the interrupted turn ends
`error_during_execution`, and a message queued behind it still runs and ends `success` — which the
flag, carried on, reported as "Stopped.". The fallback for an interrupt that is never acknowledged
ends the process only if it is still the same process with a turn pending; the rejection can come
20 s later, or from a model change closing the channel, by when a new process is running. On
Codex a message sent after Stop waits for the stopped turn to end and starts its own turn, since
steering it into the turn being interrupted is refused; and a `turn/completed` naming another turn
than the running one is ignored.

**A Codex session's sends run one at a time** (`CodexSession._queue`). Two at once started a
second thread: a message sent before the first turn had an id took the start branch again, and
before the thread existed it called `thread/start` a second time — two turns streaming into one
chat, Stop reaching one of them, only one thread saved. Queued behind the first, the second finds
the turn and steers it. **And every await of a start is a point where the chat may have moved
on**: closing the tab and the other agent taking its place dispose the session, and
Stop can arrive before the turn has an id. Each step checks, nothing starts after that, and a
turn that began while its request was on its way is interrupted rather than left to run to the
end, unseen, on the user's quota. A send's failure is reported only into the chat it came from.

Requests the CLIs send *us* must be answered or the turn waits for ever. **A permission
question is held until the user answers it** — Claude's `can_use_tool`, Codex's approval
requests — and is closed on every path that lets the session go; see
[Approvals and the browser tools](#approvals-and-the-browser-tools). Everything else is answered
at once: Claude's other `control_request`s (SDK MCP calls, hooks) get an error response, an MCP
server's own form (`mcpServer/elicitation/request` that is not a tool approval) is declined, and
any other Codex server request gets a JSON-RPC `-32601`. Do not "fix" a waiting approval with a
timeout or a refusal: the wait is the user deciding.

### Approvals and the browser tools

Asked for after a chat message "fill in the email field" came back with "I have no permission
for the built-in browser's tools": the first version started both CLIs so that every tool needing
a yes was refused, the browser tools included, and the chat needed Connect to have been pressed
to have those tools at all. **The chat has the browser tools from its first message, and every
question an agent asks is answered in the chat** — asked for in those words: "access one way or
another, even if by asking".

**The browser tools are handed to each CLI at its start**, from this window's own MCP server
(`BrowserServer`, read from `McpLifecycle.state` at every start, since the port moves with a
setting change; nothing while the server is not running):

- **Claude**: `--mcp-config <file>`, a JSON file naming `ai-browser` with its URL and bearer
  token, in the private directory (`~/.ai-browser/shared/runtime/chat/mcp-<host pid>-<uuid>.json`,
  `0600`). **One file
  per CLI process**, written as it starts and removed when it exits. The first version wrote one
  per session, cached it, and swept files a day old — so a tab open for more than a day had its
  file removed by another window's sweep, and the next process it started (a model change, a
  crash, Stop's fallback) was handed a missing file: the CLI exits with "MCP config file not
  found", and since the path was cached, so did every message after it (measured). The sweep
  (`sweepBrowserConfigs`) now removes only files whose extension host pid no longer runs —
  never by age. **A file, not the JSON as an argument** — `--mcp-config` takes either, and an
  argument puts the token in the process list, which every local user can read. The directory is
  resolved once and the file written synchronously in `_start`, so the send awaits nothing that
  a Stop or a second send could land behind.
- **Codex**: the `config` override of `thread/start` / `thread/resume`,
  `{ mcp_servers: { 'ai-browser': { url, http_headers } } }`.
- **Under the bare `ai-browser` name the injected server replaces a project config's entry of the
  same name rather than adding a second** — measured on both: Claude lists one `ai-browser` with
  `source: dynamic`, Codex one `ai-browser`, ready. A per-project `ai-browser-<slug>-<hash>`
  entry left in `~/.codex/config.toml` is not replaced and would list the tools twice; Connect
  removes that entry, and the repair renames it, so it is not chased here.
- **"Our server" is `ai-browser` or exactly that per-project shape** (`isBrowserServer`, a
  six-hex suffix). Any `ai-browser-…` let a server somebody else named so be answered by the Auto
  toggle as the browser.
- **The server must be running**: with `aiBrowser.mcp.enabled: false`, or a server that failed
  to start, the chat's agents have no browser tools.
- **A share applies to the chat's agents too.** They call the server as `claude` / `codex`
  (their `clientInfo` name), so a tab given to "Claude Code" binds the chat's Claude as well, and
  its calls count as that assignment picking the tab up (🔗 → 🤖).

**The questions come over each CLI's own channel**, and the answers go back the same way.
Measured live (Claude Code 2.1.301, codex-cli 0.162.0-alpha.17.2); the readers are
`claudeApproval` / `codexApproval` and the answers `claudeApprovalAnswer` /
`codexApprovalAnswer` in [src/chat/agentProtocol.ts](src/chat/agentProtocol.ts), under test on the
recorded requests:

| | Claude Code | Codex |
|---|---|---|
| launch | `--permission-prompt-tool stdio` (with `--permission-mode default`) | threads with `approvalPolicy: 'untrusted'`, `approvalsReviewer: 'user'`, `sandbox: 'workspace-write'` (`read-only` with no folder open) |
| question | `control_request` `can_use_tool` (`tool_name`, `input`, `description`, `tool_use_id`) | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` (measured: it names only its `itemId`; the paths are on the `fileChange` item started just before, which the session keeps — `filesOf`), and for an MCP tool `mcpServer/elicitation/request` with `_meta.codex_approval_kind: 'mcp_tool_call'` |
| yes | `{ behavior: 'allow', updatedInput: <input as it came> }` | `{ decision: 'accept' }`; an MCP tool `{ action: 'accept', content: null }` |
| no | `{ behavior: 'deny', message }` — the model reads it as the tool's error and carries on | `{ decision: 'decline' }`, or `cancel` where the request lists its decisions without `decline`; an MCP tool `{ action: 'decline' }` |
| withdrawn | `control_cancel_request` (a Stop: measured, the interrupt withdraws the open question at once) | `serverRequest/resolved` (arrives after the stopped turn's `turn/completed`) |

Each of the Codex settings was found by its absence:

- **`approvalsReviewer: 'user'`**, or the question never reaches us: with it left to the user's
  configuration, Codex's own auto-review approved an MCP tool call by itself ("Automatic approval
  review approved (risk: low)") and no request was sent.
- **`untrusted`, not `on-request`**: under `on-request` the model decides whether to ask, and it
  ran `touch` inside the read-only sandbox without asking, to "Operation not permitted".
  `untrusted` asks before any command Codex does not know to be read-only — what Claude Code's
  default mode asks about too.
- **`workspace-write`, not `read-only`**: an approved command that writes otherwise still fails.
  Edits still ask under it — measured: an `apply_patch` creating a file sent
  `item/fileChange/requestApproval` first. **But with no project the working directory is the
  home directory** — no folder open (`_windowCwd`), or the home directory picked with the
  folder button (`ChatTab.projectRoot`, #447) — and there `workspace-write` would make all of it
  writable, `~/.ssh` and the shell's rc files included; such a thread is `read-only`
  (`threadSettings`).

**How the chat answers** ([src/chat/chatTab.ts](src/chat/chatTab.ts)): a question is an
`ApprovalEntry` in the conversation — a card with what it is for ("Go to the internet?", "Use the
browser?", "Run this command?", "Change this file?", "Use a file outside the project?", "Use this
tool?"), the command or tool, its arguments, and Allow / Deny, plus **Always allow** and **Always
deny**, which also set the card's category in the approval menu.
**The card shows exactly what Allow runs**: a command whole, line breaks kept, arguments one per
line, in a scrolling box. The first version folded the command onto one line and cut it at 500
characters — `echo done` and `rm -rf build` on the next line read as one harmless `echo`, and a
long command ran a tail nobody saw — while Allow sent the original. Text past 100 000 characters
is cut with a sentence saying so.
Never a modal or a QuickPick: either would pause the browser tab the agent is about to use. A
tab waiting on one shows the waiting mark. Each answered card says how it went: Allowed, Denied,
Allowed automatically, Denied automatically, No longer needed.

**The approval menu** — asked for, replacing an on/off toggle that covered terminal and browser
only. The composer's button opens it, drawn in the view; each category has **Auto · Ask · Deny**,
and **All** on top sets every one at once (and shows no choice while they differ). The button
reads "Ask", "Auto", "Deny", or what differs — "Auto 2 · Deny 1" — with every category's mode in
its tooltip. Categories, as `agentProtocol.ts` sorts the questions (`claudeApproval`,
`codexApproval`, under test):

| Category | Claude Code | Codex |
|---|---|---|
| Internet (`web`) | `WebFetch`, `WebSearch` | network access for a command (`networkApprovalContext`) |
| AI Browser (`browser`) | `mcp__ai-browser__*` | the `ai-browser` server's tools |
| Chat control (`chat`) | `mcp__ai-browser__chat_keep_awake` / `_pause` / `_resume` / `_stop_agent` (also an `ask` rule at launch) | the same four of that server; one whose name cannot be read |
| Terminal (`command`) | `Bash` | a command, and input to a running one (`writeStdin`) |
| Files in the project (`edit`) | `Edit` / `Write` / `MultiEdit` / `NotebookEdit` inside the folder | a patch whose files are all inside |
| Files outside the project (`outside`) | any file tool on a path outside the folder, or whose `blocked_path` is; an absolute or `~` `Glob` / `Grep` pattern; an edit tool naming no file | a patch writing outside — its files or where a move takes one (`move_path`) —, with a `grantRoot`, or naming no file at all |
| MCP · *server* (`mcp:<server>`) | `mcp__<server>__*` | another server's tool |
| Other tools (`other`) | the rest | the rest |

- **"Outside the project" is decided by `outsideProject`, and every way out counts**, since Auto
  for "Files in the project" lets an edit through without a card. Each of these was a review
  finding where an edit outside went through as inside:
  - **No local folder open** is no project: the CLIs then work in the home directory, and taking
    that for the project made `~/.ssh/authorized_keys` an edit "in the project". The tab hands
    the sessions a separate `projectRoot()`, undefined then, and everything is outside.
  - **`~`** is expanded to the home directory — as Claude Code does itself; `path.resolve` read
    `~/.zshrc` as a folder named `~` inside the project. Any other `~name` is outside.
  - **Symlinks** are followed: real paths are compared (the longest existing part of the path,
    resolved), so `<project>/homelink/.zshrc` is outside when `homelink` leads to `~`.
  - **A Codex patch's move destination** (`move_path`, in either shape) is a path it writes, and a
    patch whose paths are not known is outside — the card names every path.
  - **A dangling symlink is followed too.** `realpath` fails on a link whose target does not
    exist yet, and taking the name as written read `<project>/dangling -> ../outside/x` as
    inside, so a Write through it created the file outside with no card. `realish` resolves a
    path that does not fully resolve one component at a time, as the kernel does: each link,
    a dangling one included, is followed from the link's real folder; a name that does not
    exist ends the walk with the rest as written (a new file is normal); a loop, more than 40
    links, a file used as a folder or any other error counts as outside.
- **Every Claude Code tool that runs a command is Terminal's, not only `Bash`.** 2.1.301 also
  has `PowerShell` (its permission rule reads `command`) and `Monitor`. Filed under Other tools,
  they escaped Terminal's Deny and Ask, ran unasked under Other tools' Auto, and on Ask the card
  showed the model's description instead of the command. `claudeApproval` reads any non-MCP tool
  whose input has a string `command` as a command, the card titled with the whole command.
  `SandboxNetworkAccess` (`{ host }`) is Internet's, "Network access: <host>", as Codex's
  `networkApprovalContext` is. Whatever still falls to Other tools shows its arguments, with the
  model's description above them, never in their place.
- **A server gets its row the first time an agent asks about one of its tools** (`noteServer`,
  at most 30, kept per workspace), since the servers are each CLI's own configuration and nothing
  lists them up front. Its name is the key, so a name over 80 characters is not listed rather
  than cut.
- **Auto** answers yes and leaves no card — the tool's own row says what ran; **Deny** answers no
  and leaves one short "Denied automatically" line (`.approval.quiet`: what it was for and the
  path or command, no details), so a refusal the agent then works around is
  not a mystery; **Ask** shows the card. A mode changed while cards wait answers them at once
  (`approvalModesChanged`).
- **Kept per workspace** (`aiBrowser.chat.approvalPolicy`), a key not set asks. The old toggle's
  "on" (`aiBrowser.chat.autoApprove`) reads as Terminal and AI Browser on Auto, so nobody's
  choice changed when the menu came — except that a Codex `writeStdin` is now Terminal's, so it is
  answered too. The host refuses a key it does not know and a mode that is not one of the three; a
  server's key is honoured whether or not the menu lists it (the list stops at 30), or a card's
  "Always" would do nothing for it.
- **A choice changes the menu's buttons in place** — rebuilt each time, the clicked button was
  replaced and keyboard focus fell to the page (#365); it is rebuilt only when its rows change,
  and focus then goes back to the same button.
- **The menu's foot carries View Mode** (asked for, replacing an Off · On Compact switch):
  Minimal · Compact · Standard, see [View modes](#view-modes-minimal-compact-standard). Its
  segments share `.mode-seg`'s look and are kept out of the mode loop (`:not(.view-seg)`), which
  otherwise unmarked them for having no category key; its label does not shrink and the choices
  wrap under it in a narrow menu (`.view-row`) — beside three choices it was cut to "View …".
- A Codex `item/permissions/requestApproval` (a broader sandbox profile) is still refused with
  `-32601`: answering it means building a granted profile, not a yes.

**A question nobody can answer any more is closed, on every path.** The CLI withdrawing it, the
tab closing, the other agent taking the tab's place, a replaced backend, the process exiting
(Claude: `_withdrawAll`; Codex: the backend's `_withdraw`, which also *refuses* the open
questions of a session going away, or Codex would wait on them until the interrupt landed), and a
chat reopened from the history (`settled`). A card left "pending" would ask for a click that
reaches nothing. An answer to a card that is no longer pending is ignored, and so is a second
click.

**What still decides before the chat is asked:** each CLI's own rules. Both start in the
conversation's working folder and load the user's and the project's settings — Claude Code's
`permissions.allow` rules and hooks, Codex's own rules — so a tool those rules pre-allow runs
without a question, exactly as in the CLI, and one they deny is refused without one. A folder
fetched from GitHub and not trusted yet loads the user's alone (see
[The working folder](#the-working-folder)).

**What the chat sets over the user's configuration**, stated because it is a grant: Claude's
`--permission-mode default` (over a `defaultMode` in settings), and for Codex the sandbox, the
approval policy and the reviewer — so a `sandbox_mode = "read-only"` in `config.toml` does not
hold in the chat's threads, which are `workspace-write` inside an open folder (`read-only` with
none). Plus every category the approval menu has on **Auto** — any of the internet, the browser,
the terminal, files inside or outside the project, an MCP server, or everything else — which
answers yes without a card. Workspace trust gates the whole chat for that reason.

Verified against the real CLIs through the compiled backends: on both, a `touch` and
`browser_state` each asked once, an Allow ran them (the file created, the tool answered), a Deny
reached the model, and a Stop with a question open withdrew it; the cards and the approval menu
against a fake session and in headless Chrome.

### Questions with choices: the turn waits on a form

Asked for: when an agent asks "this or that?", the chat shows a form, the turn waits, and the
answer lets it go on. Both CLIs ask through a channel that blocks the turn, so it is built as one
more kind of approval card (`what: 'question'`, `ApprovalEntry.questions`) and inherits every way
an approval is withdrawn or closed (#376) — a Stop, the process ending, the tab or view closing, a
replaced backend. Measured on Claude Code 2.1.301 and codex-cli 0.162.0-alpha.17.2; readers and
answers in `agentProtocol.ts` (`claudeQuestions`, `codexQuestions`, `validAnswers`, under test on
the recorded requests):

| | Claude Code | Codex |
|---|---|---|
| asked as | `can_use_tool` for `AskUserQuestion`, `requires_user_interaction: true`; `input.questions[]` of `{ question, header, options: [{ label, description }], multiSelect }` | server request `item/tool/requestUserInput`: `questions[]` of `{ id, header, question, options \| null, isOther, isSecret }` |
| answered | `allow` with `updatedInput: { ...input, answers: { <question text>: "<label>" } }`, several choices joined with ", " — the model reads "Your questions have been answered: …" | `{ answers: { <id>: { answers: ["<label>"] } } }` |
| skipped | `deny` with `questionSkipped` — "go on with your best judgement and say which choice you made" | `{ answers: {} }` |
| withdrawn | `control_cancel_request` | `serverRequest/resolved` |

- **Codex offers the tool in its default mode only with a feature flag**:
  `features.default_mode_request_user_input`, set in every thread's `config` (`threadConfig`).
  Without it the model either said it had no such tool or wrote the question as text
  (`agentMessage` with `questions` and `delivery: "async"`) and then slept waiting for a reply —
  measured both ways. Plan mode has the tool without the flag; the chat does not use plan mode.
  0.145 starts a thread with the flag set. No `experimentalApi` capability is needed.
- **Codex says `isBlocking: false` in the default mode, and waits anyway**: an answer sent 45 s
  later was taken and the turn went on.
- **The approval menu has no say.** A question is never answered by Auto or Deny, is not a
  category in the menu, and `approvalModesChanged` passes over it: only the user can choose.
- **The form is a window above the message box, not a card in the thread** (asked for):
  `questionDock`, first in the footer and as wide as the composer, built by `questionForm` for the
  oldest card of the chat in front that still waits (`renderQuestionDock`). The thread keeps one row
  for the card — the questions' names and "Waiting for your answer — in the form above the message
  box" — which becomes the answers once it is answered. The form is built once per card and never
  on a state post (#365); what has been picked lives in `questionDrafts` and the open tab in
  `questionTabs`, so switching chats and back finds both again.
- **A tab per question** (with more than one), named by its header, with a green check once it has
  an answer, and "N of M answered" in the form's head. Each question shows its options as rows (one,
  or several where `multiSelect`; number keys pick one in the open tab) and — where the user's own
  words are taken — a text row (Claude Code always takes them, as its own picker does; Codex when
  `isOther` or there are no options; masked when `isSecret`). **Answer is enabled only once every
  question has an answer**; before that it is dimmed and marked `aria-disabled`, never `disabled` —
  a disabled button gets no pointer events, so the tooltip saying "Answer every question first"
  would never show — and a press opens the open question if it still needs its answer, else the
  next that does. Skip sends none. Picking an option of a one-choice question moves on to the next
  question still unanswered, and with none left focuses Answer; Enter in a text row answers, or
  moves on the same way. **The focus goes with the open question** (`show`): hiding the block that
  held it dropped it to the body, where the number keys and Enter reach nothing, so a second `1`
  did nothing (review finding). The tabs wrap onto a second row rather than scroll: a strip with
  no scrollbar left the open tab past the edge of a narrow side bar.
  **Answer sends exactly what the form shows chosen**: on a one-choice question, taking the own-words
  row unmarks the options, so an empty row is no answer rather than the option picked before it —
  which used to go out unseen (#430).
- **The host keeps only answers that fit** (`validAnswers`): a known question, one value unless
  several may be chosen, an option's label unless own words are taken. Nothing that fits is a skip.
- **A secret answer is not kept**: the chat stores `••••` for it, the CLI gets the text.
- **While a card waits, the working line says "Waiting for your answer"** instead of a phrase,
  and the tab shows the waiting mark, as for any approval.
- **`AskUserQuestion` gets no tool row** — the card is the question and shows the answer, and the
  tool's result finds no row to update. Codex sends no item for it.
- **A toolbar skill's background run skips a question**: there is no conversation to show it in,
  and the skip tells the agent to choose and say so.

Verified end to end through the compiled backends against both real CLIs (asked, answered "Blue",
the reply named blue; skipped, the reply said no answer was given), and the card in headless
Chrome (two questions, single and multiple choice, own words replacing an option, the draft
surviving a rebuild, the answer posted). The form above the message box was checked there too:
three questions, a pick moving to the next tab, a state post leaving the form as it was, Answer
disabled until the third was answered, the answers posted, the form gone and the row showing them.

### Where it refuses to run

- **Restricted Mode.** Both CLIs load the project's own configuration, and Claude Code runs
  `.claude/settings.json` hooks, which are shell commands — starting one in an untrusted folder
  runs that folder's code. Same reasoning as Connect Codex and git (breaks-silently #208).
- **A remote window.** This extension runs locally there (`extensionKind` puts `ui` first) while
  the project and the CLIs are on the remote — see
  [Special cases](#special-cases-and-non-obvious-decisions).

### State that is kept

- **History**: `workspaceState` `aiBrowser.chat.history`, at most 50 chats, 400 entries each, long
  texts cut at 20 000 characters and tool bodies at 4 000 (the whole history is rewritten on every
  save, and full bodies made that tens of megabytes). **The latest prompt is kept even when the
  400-entry window would drop it**, and a chat records that it is owned (`owned`, and its `ref`),
  because a long turn could otherwise push every prompt out — and a chat reopened that way read as
  unstarted, took the globally remembered agent and handed it the other agent's session id. A chat stores what resumes it (`ref`: Claude's session id,
  Codex's thread id), so opening it from the history continues the real conversation — measured
  for both. Images are not stored; the user entry keeps the attachment labels. Codex threads are
  not `ephemeral`, so they also appear in Codex's own history.
- **The approval menu**: `workspaceState` `aiBrowser.chat.approvalPolicy` (a mode per category)
  and `aiBrowser.chat.approvalServers` (the MCP servers seen) — per workspace, since a project is
  what a user trusts with commands; one menu for every tab.
- **The toolbar's skills**: `globalState` `aiBrowser.chat.toolbar`, in order, each checked again
  on every read (`validToolbarSkill`); their next prompts in `aiBrowser.chat.toolbarSteps`, and a
  notification result and how their end is told in `aiBrowser.chat.toolbarExtras`, by skill id —
  apart, so an older build cannot strip them (see
  [The toolbar of skills](#the-toolbar-of-skills)).
- **The working folder**: on the chat (`StoredChat.folder`), and for a tab nothing was sent from
  in `aiBrowser.chat.openTabs` (`folders`); the folders picked lately in `globalState`
  `aiBrowser.chat.recentFolders`; a separate copy and the references of a tab nothing was sent
  from in `openTabs` (`repos`), of a started one on the chat; the repositories opened lately in
  `globalState` `aiBrowser.chat.recentRepos`; their clones in the extension's global storage.
- **The plan-limit lines closed**: `globalState` `aiBrowser.chat.usageAlertsClosed` — per agent,
  each limit's percentage when closed and whether credits were; see
  [The plan-limit line](#the-plan-limit-line-and-the-colour-of-u).
- **Selection**: `globalState` `aiBrowser.chat.selection` — the last agent, a model per agent and
  an effort per `<agent>:<model>`, made valid against what was detected on every read.
- **Open tabs**: `workspaceState` `aiBrowser.chat.openTabs` — every tab's chat id in order, which
  of them have not started (`fresh`), the one in front, and the names of fresh tabs the user
  renamed (`names`), written when they change. A started tab comes back from the history, its
  name with it; a fresh one comes back empty **with the same chat id**, which is what its draft is
  kept under — without it a first message being written was lost on reload.
- **The drafts**, one per open conversation by chat id, in the webview's `setState`; a draft from
  before tabs is read once into the first conversation shown.

A conversation belongs to one agent: another agent picked in a started chat is a question, not a
switch — see [Tabs](#tabs-several-conversations-at-once). "Started" means *the user has sent
something* (`started`), not "has entries" — a notice is an entry too, and counting it made the new
chat belong to the agent just switched away from (#335).

The round checkbox next to effort controls Claude Ultracode separately from effort. Its thin
ring contains a translucent grey ✦ when off and a yellow ✦ when on; the tooltip highlights
UltraCode in bold yellow. It is
shown for Claude models advertising `xhigh` support, requires Claude Code 2.1.284 or later,
and stores its value per conversation, including fresh tabs restored after reload. The last
explicit toggle is also the global default inherited once by new tabs; changing it in one
tab never changes existing tabs. New tabs in another surface read the current global default. The session launch merges `ultracode` into
its existing `--settings` JSON, preserving the mandatory Chat control approval rules;
`--effort` still receives the chosen reasoning level. Like effort, a change restarts an
idle process with `--resume`, never interrupts current work or background agents, and is
preserved when automatically continuing after a temporary error. No settings files change.

### Tabs: several conversations at once

At webview widths of 1000 CSS pixels and above, the same tab strip becomes a 252 px left
sidebar with a vertical, scrollable list. Its header toggle collapses it to a 52 px rail
that keeps the tabs as 36 px tiles. A tab keeps its own number and border colour for its
node lifetime, even after reordering. The center shows a chat icon before work starts,
the activity spinner while working, a waiting ring for approvals, a check when finished,
or an error icon; a corner badge counts agents and background skill runs (capped at 99+).
The active tile has a tinted background and a stronger frame. Titles/statuses remain in
tooltips and accessible labels. Double-click to rename expands the drawer; the compact
context menu also offers Close chat, expanding it for any required stop confirmation.
`ViewState.chatDrawerCollapsed` retains that preference alongside drafts across reloads.
A footer button moves the sidebar left or right; `ViewState.chatDrawerSide` retains
its side (left by default). Collapse sits beside Chats, toward the conversation (right in the left sidebar, left in
the right sidebar). Move left/right stays at the bottom. Both controls remain available
in the collapsed rail. Move left/right uses an arrow icon; Collapse/Expand uses a chevron pointing toward the window edge to collapse and toward
the conversation to expand. Both have a
tooltip and an accessible label describing the current action.
The conversation and the entire footer share a 696 px outer column with 12 px side padding
(672 px of content), centered in the remaining space. Below 1000 px the strip returns to
the top and the chat fills the surface. Existing tab nodes are reused; reordering follows
the list's vertical or horizontal axis, and horizontal width animations run only below
the breakpoint. Overlays stay attached to `#app`, outside `.chat-main`.

Asked for: "сразу в 2-3-4-5 окнах". The view holds up to `aiBrowser.chat.tabLimit` (10 unless
set) conversations as tabs in a strip above the thread; one is in front and **the others go on
working** — a reply streams, a background agent finishes, in a tab nobody is looking at. A tab
shows a mark of how it is doing (below) and the number of its agents still working. Each tab is a `ChatTab`
([src/chat/chatTab.ts](src/chat/chatTab.ts)) with everything a conversation had before tabs — its
chat, its CLI session, `_pending`, the token offset, `_endTurnHere` — moved there unchanged; the
provider holds what all tabs share: the view, the agents, the selection, the limits, the history.
The default is ten — it was five, raised on request — and there is a ceiling at all because each
Claude tab is a `claude` process and tabs working at once spend the plan's limits at once; the
setting goes up to 30, asked for. One past the limit is refused
through the status bar, and the strip's "+" is **not shown at all** — asked for; a disabled
button read as broken. `tabLimit()` reads the setting every time and takes anything that is not
a whole number from 1 up as the default, and 30 for anything above it (#184's rule: a bad value
must not take the view down). **Lowering it closes nothing**: the open tabs stay, "+" comes back
once enough are closed, and only a window restore is cut to the new limit.

**In the narrow strip, tabs that do not fit go into a dropdown** (asked for): `layoutTabOverflow` in
`chat.ts`, the fitting rule in [preview-src/tabOverflow.ts](preview-src/tabOverflow.ts) (leaf, under test).
The tab in front is always shown, then the others in strip order while they fit at their own width;
the rest get the class `overflowed` (hidden, never removed — the nodes stay keyed, #365/#383) and a
`chevron-down +N` button after the last visible tab opens a list of them, each with its mark, agent
count or terminal icon. A row selects its tab; a right-click, the context-menu key or its `⋯` opens the
tab's own context menu (`TabNode.openMenu`) over the list, which stays open under it (`keep`), with
Rename and Close added for a hidden tab. Rename selects the tab first and starts once it is shown
(`renameWhenShown`); a busy tab's close confirmation is placed under the `+N` button. The layout is
measured synchronously in `renderTabs`, before the switch animation measures, with every tab shown and
`flex-shrink: 0` (`.tab-row.measuring`) in one frame, so nothing flashes; a `ResizeObserver` on the strip
re-runs it. **While tabs overflow, the row reads: the tabs still shown, stretched to the full width left of the buttons (`.tab-row.stretched`, removed while `layoutTabOverflow` measures natural widths), then "+" and New terminal, then the `+N` dropdown last — the DOM order is tabs, adds, overflow button. Hovering the `+N` button opens the list at once (hover-capable pointers only, focus stays where it was); it closes 250 ms after the pointer has left both the button and the list, unless a tab's own menu is open over it.** The wide drawer is untouched: there everything is shown and the button hidden. **A conversation row in the dropdown can be dragged onto the strip** (terminals too, with their own local `draggedTerminal` path): it sets the same `draggedChatTab` and `beginTabDrag` a strip tab does, and the visible tabs' own `dragover`/`drop` post `placeTab`, so dropping on the left half of the first tab puts it at the very start and `fitTabs` then shows it and pushes another into the list. The panel is hidden from a `setTimeout(0)` after `dragstart`, never during it, and only hidden (its nodes stay), or the source node goes and `dragend` never fires.

**The mark on each tab** (`ChatTab.status`, `ChatTabStatus` in the protocol), all asked for:

| Mark | When |
|---|---|
| a pulsing ring, in the warning colour | an approval in the tab waits for an answer — it outranks working, since the agent is stopped on the user and the tab may not be the one in front |
| an orbit spinner with a pulsing central dot | a turn or an agent of the tab runs (`busy`); CSS animates it independently of the working line, and stays still under reduced motion. Tab marks reset the shared `.working` margin/padding so the indicator stays vertically centered |
| green dot | the work ended while nobody was looking at the tab |
| orange dot | the work ended in an error: an error entry or a failed agent since the last message, or the backend replaced under a running turn |
| nothing | finished and read — asked for; a grey square said nothing a plain tab does not — or nothing has been sent from the tab |

- **The end of the work is a change between two posts**, busy then idle, so `ChatTab._post`
  compares the two on every change rather than any one path marking it — a turn's end, a send
  that failed before a turn began, the last background agent finishing all arrive that way.
- **"Read" is decided by the provider**: `_state()` calls `seen()` on the tab in front whenever
  the view is visible, and `onDidChangeVisibility` posts, so a tab is read the moment the view
  shows it — not at its next change. A collapsed view, or the side bar showing another container,
  is not looking.
- **The orange mark outlives being looked at** and goes with the next message: an error is not
  over because it was seen, and losing its mark would say the work had finished.
- **Stopping is not failing.** "Stopped." from the user's Stop is a finish like any other; so is
  closing the tab or the view, which ends the turn and leaves nothing to read (`close()` clears
  the unread mark). A tab reopened from the history has no mark, or the orange one when its last
  entry is an error.

- **The tab in front is wider than the others** (130–260 px against 56–140 px), and the width
  changes with a transition — asked for. **The tab left and the tab chosen move together**, one
  linear animation each, started in the same frame (asked for, after a `calc-size()` version
  that kept their sum exact was turned down as more than wanted): `animateTabSwitch` measures
  both tabs before and after the class change, holds each at its old width with the CSS limits
  lifted — `min-width` / `max-width` do not transition and would clamp the width at once — and
  lets both go to the new width under `.resizing` (`width .25s linear`). The inline styles are
  removed on `transitionend` or after 400 ms, and a switch made during another ends the first
  (`tabResizeEnds`) after measuring where it had got to. Transitioning the limits themselves was
  the first version: each tab met its own title's width at a different moment, so the two moved
  out of step. Both now start and end on the same frame (measured in headless Chrome); their sum
  still changes when the two titles differ in length. That needs the element to survive the
  switch, so the
  strip is **keyed**: one element per open tab, updated in place, its label refilled only when
  what it shows changes, and moved only when out of order (re-inserting ends a transition). It
  used to be rebuilt whenever anything in it changed, which also lost clicks (#365) and keyboard
  focus on a tab.
- **A clicked conversation tab spins until its chat is drawn** (asked for): `markTabLoading` adds
  `loading` to the tab's root, which hides its mark and shows a `codicon-loading` spinner
  (`.tab-loading`, present in every label, hidden otherwise); the first state naming it as
  `activeTab` (or without it) clears it, and 10 s at most. A class, not a rebuild (#365).
- **Double-click a tab (or F2) to rename it** — asked for: Enter or a click elsewhere keeps the
  name, Escape keeps the old one (and goes no further, so it does not also close a popup), an
  empty name changes nothing. The name is one line, 80 characters at most, and sets
  `StoredChat.named`, so the first message no longer replaces it with its own text. A state post
  while the field is open leaves it alone, and so does the host's `focusInput`. Details that
  each were a defect first:
  - **After a click elsewhere, focus stays where the click put it** — only Enter and Escape give
    it back to the tab. It used to go back on every ending, so clicking into the message box to
    type lost what was typed.
  - **The double-click belongs to the tab its first click was on.** That click selects the tab,
    the widths move, and the second click can land on a neighbour — which was then both selected
    and renamed. The second click is ignored and the rename goes to the first click's tab.
  - **Enter and Escape inside an IME composition** pick or drop a candidate, not the name.
  - **A name is shown at once** and held until the host's state carries it, so a post built
    before the rename does not flick the old name back.
  - **A named tab is not "empty"**: a chat from the history opens in a new tab instead of over it,
    and "Close this chat, start …" keeps the name on the tab it reuses.
- **Closing a tab stops what it runs** — its turn and its agents — and keeps the chat in the
  history. A tab that is working asks first, in a popover under the tab (`placeTabConfirm`,
  flipped above when there is no room; a press outside or Escape cancels) — "… is still working.
  Closing it stops its reply and 1 agent." — never in a modal. It was a band across the strip,
  which took a row for as long as the question stood (asked for: a tooltip with buttons).
- **The view closing ends each tab's work with `close('view')`, which does not mark the tab
  closed.** The same `ChatTab` objects are shown again when the view is resolved again, and
  `_closed` is reset only by `start()`, so a tab the view let go of came back closed for good: a
  generated title was dropped and a first send that failed was never saved (#459's survival, in
  every path but the restart it was fixed for). A chat deleted while the view is closed is still
  never written back: deleting discards the tab.
- **New Chat** (title bar, and the strip's "+") asks in an inline menu: open a tab here, an independent editor tab, or a chat in a separate window.
- **A chat from the history** is brought to the front if a tab has it, shown in the tab in front
  if that one is empty, and otherwise opened in a new tab — opening one must not end a
  conversation that is working.
- **Deleting a chat** that a tab holds closes the tab without saving, or the tab writes the
  deleted chat back (`ChatTab._discarded`; #348's rule again).
- **Open tabs come back with the window**, their sessions opened on the next message and resumed
  by `ref`, as a chat from the history always was. The tab ids are minted per extension host, so
  the webview keeps drafts by **chat id** — and carries a draft across when the tab in front gets
  another chat (one opened into it from the history, the other agent taking its place), which is
  why "Close this chat, start …" keeps the tab (`ChatTab.start`) rather than making a new one. A
  draft is saved as the text from before a ↑ walk, never as the message recalled.
- **Each tab keeps its scroll position and its opened rows**; a tab that was following its end
  comes back following it — a reply streaming there is not left behind the previous tab's scroll.
- **A message is sent to the tab it was typed in** (`send` carries `tabId`: the state post that
  shows a newly chosen tab is up to 40 ms behind the click), and **only if that tab still holds the
  chat it was typed for** once detection, which can take seconds, has ended. Otherwise it is kept
  as a "Not sent" notice: going ahead put a fresh chat's message into an old conversation from the
  history, or started a CLI for a tab that had closed, which nothing could show or stop (#368).
- **A closed tab's send still on its way saves its chat only if the history still has it**
  (`_closed`): close, delete from the history, and the late save wrote the chat back.
- **A send that fails before any turn begins gives its place in the queue back**, or the tab read
  as working — a confirmation to close it, a switch card warning of a reply to stop, a "Stopped."
  written on the way out.
- Escape answers the innermost question first: a close being confirmed, then the switch card, then
  any popup.
- **A message belongs to the tab it was typed in**: `_send` takes the tab before it waits for
  detection, so moving to another tab meanwhile does not send it there.
- The strip is never rebuilt (keyed, see above); the switch card is rebuilt only when what it
  shows changes, the rule #365 set for the agents panel. The empty close-confirm row is
  `display: none` while hidden — `.tab-confirm`'s own `display: flex` kept its padding on screen,
  a blank band under the tabs.

**Another agent for a conversation that has started is a question**, asked in a card above the
composer (`switchTo` in the state; the remembered agent waits for the answer):

| choice | what happens |
|---|---|
| New tab with Codex | a new tab; this one stays open and keeps working, agents included |
| Continue in Codex | this conversation is written out as Markdown (`chatTranscript`) to `.ai-browser/chat-<title>-<time>.md` — the report directory, ignored by git, refused through a symlink — and attached to the new tab's first message, telling the agent to read it and carry on. **With no local folder it goes in the message itself**, its newest 60 000 characters: the agents then work in the home directory, a temp file is outside it, and Claude Code asks before reading there — a question the chat answers no. This tab stays open. |
| Close this chat, start Codex | this tab closes, its turn and its agents stopped, and a new one takes its place; the card says what will be stopped |
| Cancel | nothing changes; the pill shows this tab's agent again |

It used to open a new chat silently, with a notice; that hid that the old conversation's agents
were still working, or had just been stopped. The transcript carries what the next agent needs
and nothing it can find itself: prompts, replies, and one line per tool — the command and its
exit code, the file read or edited, an agent with its report fenced. Thinking and notices stay
out. The two options that open a tab are disabled at the limit. The files are swept with the
reports (`chat-*.md` is in the sweep's name pattern); by then the agent has read the file.

### Asking another agent: a second opinion in a new tab

Asked for: a user who does not trust one agent's answer — a bug, the wrong design, a weak
review — asks another. A button beside every reply's copy button (`opinionButton`,
`comment-discussion`) opens a menu of every available agent and model; picking one
(`secondOpinion` → `_secondOpinion`) opens a **new tab** beside the conversation, in its folder,
with that agent and model, and sends it the question the reply answers. **One agent per press,
asked for**: another opinion is another press, another tab. Decisions, each with its reason:

- **A tab, not a background run** (asked which, and chosen): a second opinion is a conversation
  the user wants to continue — "why not B?", "go ahead" — and a tab has its own approvals,
  model, Stop and history. A toolbar-style background run would show only a report.
- **What is sent is the question, never the first answer**: the user entry above the reply
  (`at`, walked back from `index`), as the new tab's own message. The conversation *before* it
  goes along like "Continue in …" (`chatTranscript` of `entries.slice(0, at)`, written to
  `.ai-browser/` or inline without a folder); the first agent's answer does not — an opinion that
  has read the answer it is meant to check is not a second one. So the button works under every
  reply, a running turn's included. The prompt's own attachments are named, not carried (a sent
  chip keeps only its label).
- **The framing is an attachment** (`secondOpinionText`, leaf, tested): independent answer, the
  folder may already hold the first agent's edits, and **no file changes** — say what to change,
  and the user says "go ahead" in that tab. Two agents writing one folder at once is the failure
  it avoids.
- **The model is set the way the pills set it** (`_select` after `_addTab`): a fresh tab sends
  with the remembered agent and its model, so picking a model here also makes it that agent's
  remembered model — the same effect as choosing it in the model pill.
- The conversation's own agent and model are listed but disabled ("This conversation"). The tab
  is named `<agent>: <title>` so the opinions can be told apart in the strip. The tab limit
  refuses in the status bar, like New Chat.

Verified: the framing under `npm test`, the build and typecheck. **Not run inside VS Code yet.**
**Not built:** a council — several agents at once and a synthesis of their answers (designed in
conversation: review merged and verified, plans compared with their disagreements shown, a judge
not among the participants). This is its first, manual step.

### Sending during a turn: added to it, or queued after it

Asked for: Enter while an agent works adds the message to the running turn; **⌘Enter**
(Ctrl+Enter elsewhere), or the queue button beside Send — there only while a turn runs and the
box has something — holds it until the turn ends and sends it as a turn of its own. With nothing
running, both just send.

**Added to the turn.** Codex takes it at once (`turn/steer`), and its prompt goes into the
conversation then. Claude Code decides for itself (measured, see the turn queue under
[The design](#the-design-and-where-each-part-came-from)): taken in at the next tool boundary, or
answered by a turn of its own after this one. So a Claude message is **shown below the
conversation as waiting** ("Waiting for the agent to take it in") and placed where it went in:
before the output that follows a tool's result, or at the start of its own turn (`autoTurn`), or,
failing both, where the conversation stands two seconds after the turn ended. Pushing it at once,
as the first version did, put the prompt in the middle of a reply still streaming, which then went
on below it. Measured with the real CLI in both shapes: after the first tool's result in one,
and the story whole, then the prompt, then its answer in the other.

**The queue button is Send's own round button, in the theme's accent colour** (asked for:
`--vscode-button-background`), so the two read as one pair — Send adds the message to the turn,
the accent one holds it until the turn ends. It used to be a ghost button with a list icon.

**Queued.** Held in the tab (`ChatTab._queued`) with the attachments in the box at the time, shown
below the conversation ("Sent when this turn ends", with an x to take it back), and sent by the
provider (`_drainQueues`) one at a time **half a second after** the tab is idle — no turn running,
none pending, no prompt waiting, no approval waiting. Not at the instant the turn ends: Claude Code
may start a turn of its own milliseconds later, and a send then would be taken into it. A queued
message carries only its own attachments (`_send`'s `only`), not what the box holds for the next.
**Stop is for everything the tab was going to do**: the queue does not go out after it, it comes
back into the message box (`restoreDraft`), attachments with it.

Both kinds are built like prompts, so a sent message's flight lands on its row.

**A queue belongs to the conversation it was typed for**, and each of these was a message sent
into the wrong one, or with nobody watching:
- **A tab letting go of its conversation gives the queue back to the box** (`_giveBackQueue`) —
  "Close this chat, start …", Clear conversation, Stop — rather than sending it into what the tab
  holds next: a message queued for Claude went out as the first message of the Codex chat that
  replaced it. Closing the tab drops it, and the close asks first, naming how many.
- **The drain checks the tab still holds the chat it was scheduled for**, and does nothing while
  there is no view — the view going stopped the tab's work, and a send then started a CLI nobody
  saw — resuming when the view says `ready`. Its timers are cleared on dispose.
- **A tab stays draining until its send has gone through**, and the queued message carries its own
  attachments (`_send`'s `given`): dequeued before a send that waited on detection, the next one
  went out right behind it, with the first one's chips.
- **⌘Enter is passed through and the host decides** whether there is anything to queue behind:
  for a moment after a turn ends the queue is still waiting to go out, and the webview, reading
  "not running", sent the new message straight past it.
- **A waiting Claude prompt goes into the chat before it is saved** on every way of letting go —
  closing the tab, the view, a replaced backend: the save came first, and the history lacked a
  message the resumed session had.

### Attachments

From the `+` menu, all held in the host until the message is sent: **Screenshot** is
`BrowserController.capture(false, userTab)` (the visible area, as the toolbar's Copy Screenshot
takes it) and goes to the agent as an image block — base64 for Claude, a `data:` URL for Codex;
**Element** is the Copy Element Markdown, through `pickElementContext`, which hands the picker
the tab explicitly; **Page address** is the URL and title (`pageTitle` + `plainInPrompt`, since
the title is page-chosen text going into a prompt), plus one line naming the tab by our id (`tabIdOf`) and how the `ai-browser` tools reach it — tools named by suffix (#144), a `browser_state` check before acting because caller pins and sharing override focus, `browser_select_tab` when needed (or a user assignment when sharing prevents selection), and a plain "the server is off" when it is not running (`_tabNote`); **Share page** starts with the same URL, title and MCP note but follows the selected browser tab while it remains in the draft; **the globe button attaches the tab it opens as a page address, and the chip follows it too** — the first `onDidOpenBrowserTab` within 15 s of the press goes to the chat tab it was pressed in (`_awaitOpenedPage`), and tracked attachments have their address, title and active-or-not rebuilt under the same chip id on `onDidChangeBrowserTabState` / `onDidChangeActiveBrowserTab` until the message is sent or the chip removed (`_livePages`, `_refreshLivePages`); `preserveAttachmentReference` carries the existing `@N` to each refreshed chip; closing the browser tab removes its tracked page chips from all chat drafts and refreshes the chat, and the panel opens no tab, so attaches nothing; **File** is the path only, since both agents
read files themselves.

**What is open is offered, not attached** (asked for): the file in the text editor in front
(`activeTextEditor`, `file` scheme) and the browser tab in front — only while the active editor
group's active tab *is* a browser editor (`tabGroups.activeTabGroup.activeTab` with no `input`,
which stays put while focus is in the chat), as a Share page; `userTab` alone kept offering a page
after the user had switched to a file appear in the composer as **suggestions** — dashed chips
(`.chip.suggested`) with a leading **+** and no remove button (`_suggestions`, `state.suggestions`).
**Lines selected in that editor are offered instead of the file** (asked for): a `selection` chip
named `<file> · lines N–M` (`line N`, or `N selections` for several), built by `selectionAttachment`
— the same snapshot "Attach Selection to AI Browser Chat" takes, and the same label. Attached, it
carries `selectionKey` (the document and its ranges), so the same selection is not suggested
again. `onDidChangeTextEditorSelection` fires on every cursor move, so it posts the state only
when that key changes.
The **+** posts `acceptSuggestion`, and the host attaches what is open *now*, not what the chip
showed: a file through `fileAttachment` (the Explorer entry's text), a page through
`_makeAttachment('sharedPage')`, which follows its tab. A suggestion is left out while the tab in
front already holds it — the same file, or a live page chip on the same browser tab — so an
attached chip's **X** turns it back into a suggestion. **Every attached chip's X now leads**, where
the suggestion's + is, so the two read as one on/off control. The state is re-posted on
`onDidChangeActiveTextEditor`, `onDidChangeBrowserTabState` and `tabGroups.onDidChangeTabs` /
`onDidChangeTabGroups`; nothing is suggested where the chat
is blocked. A browser editor in front clears the file suggestion (`activeTextEditor` is `undefined`
there), and a focus in the chat view keeps it (the editor stays active).

VS Code Explorer's file/folder context menu and a file editor tab's context menu have **Attach to AI Browser Chat**
(`aiBrowser.chat.attachExplorerResources`). It accepts the Explorer's whole multi-selection,
deduplicates local file URIs, attaches files or folders to the active draft with an absolute path
and, when applicable, their path inside the conversation's project, then reveals and focuses the
chat. Missing entries are reported and skipped (`ChatViewProvider.attachExplorerResources`).
An editor selection has its own context entry, **Attach Selection to AI Browser Chat**
(`aiBrowser.chat.attachEditorSelection`), shown only for a non-empty selection. It snapshots all
non-empty cursors' selections with the document name and line ranges, JSON-quotes their text so it
stays data in the prompt, refuses more than 1 MB, attaches one `selection` chip, and reveals the chat.

**Files pasted into the message box are attached too** (`paste` in `chat.ts`,
`clipboardFiles.ts`; `_pasteFile` in `chatView.ts`, rules in `pastedFiles.ts`, leaf). A paste
that carries files is taken over: its plain text, if any, still goes into the box, and each file
is read in the view and posted as base64 with the tab and chat it was pasted into. Details that
matter:

- **The host checks everything the view sends**: the tab and chat must still match (a paste
  answered after the tab moved on is refused, #368's rule), the base64 must be canonical and
  decode to at most 64 MB (`pastedFileLimit`, checked in the view before reading too), and the
  name is reduced to a leaf with no control or reserved characters (`pastedFileName`, cut by
  code point, not by UTF-16 unit — #373 — and to 200 UTF-8 bytes, since the host adds a 37-byte
  UUID and a name is at most 255 bytes: 180 CJK characters failed with `ENAMETOOLONG`).
- **The file is written to `projects/<id>/files`** under the private root, exclusively, with a
  UUID prefix, and recorded for the cleanup panel. **Nothing sweeps these automatically**: the
  path is handed to the agent and may be read long after; they go with the panel's Clean
  project / Delete all, which protects the current draft's attachments. **Those are matched
  through `comparablePath`** (`temporaryFiles.ts`): on Windows `Uri.fsPath` lowercases the drive
  letter while paths built from `os.homedir()` keep it upper case, so a plain `===` never matched
  and the cleanup deleted the draft's own files. The file system there ignores case, so the
  whole path is folded, not only the drive letter.
- **PNG, JPEG, GIF and WebP go to the agent as an image block** as well as a path; any other
  type — SVG included — is a file the agent reads itself.
- Sending is held while a paste is still being attached, so a message cannot go out without
  the file it was written around.
- **Known and left:** an office application (Excel, Word, Numbers) copies a picture of the
  selection beside its text, and both are attached; a file over 64 MB is refused with a line
  above the box.

**Clicking a chip opens what it attaches**, as a tab of the active editor group, among the other
editors, and as a preview so the next chip reuses it — asked for. It opened `Beside` at first,
which split the editor area into a new group and read as a separate window:

- a file — the file itself; a conversation handed over to the other agent — its Markdown file;
- a screenshot — the PNG, written once per chip beside the screenshots (`savePng`, the private
  directory swept after a day) and opened in VS Code's image preview;
- an element, a page address, a conversation handed over without a folder — the text, as a
  **read-only, plain-text** document under the `ai-browser-attachment:` scheme (a content provider
  keyed by the chip's id; the label, made file-safe, is its name). An untitled document would ask
  to be saved when closed, for something that was only shown. **Plain text, not Markdown**: the
  text is page-written, and a Markdown editor turns `[x](command:…)` in an element's id into a
  link that runs a command on Cmd+click — the sink of #124 and #132, reached through an editor
  (#371). A restored editor whose chip is gone says so rather than opening empty, and a screenshot
  whose file the day's sweep removed is written again.

Chips in sent messages are labels only — the content is not kept — and do not open. **A voice
chip is the exception that is not one**: its transcript goes into the message's own text
(`Attachment.spoken`), so the chat and the history keep it — see
[Voice messages](#voice-messages). Clicking a voice chip in the box opens the text the agent will
be given, as plain text, like an element's.

**Without the `browser` grant the page entries say so** — "Browser API not enabled — use Enable
Browser API in the status bar" — rather than "open a page first", which is what they said while
`userTab` and `hasOpenTabs`, both empty without the grant, were the only test: Recipe step 3's two
guards with two messages, for a state that is every fresh install's.

**A screenshot or an element pick needs the page on screen.** `userTab` can name a tab a file
has since covered (it remembers the last one focused), and acting on a page the user cannot see
is a pick waiting for a click they cannot make. The test is `LoginWatcher.tabInFront`'s: the
focused tab, or a browser editor visible in some group (`window.tabGroups` models no browser
input, so a visible tab with `input: undefined`), erring towards "visible". The page is named
before anything happens, in the pick's status bar title and in the screenshot's chip — #259's
condition for using `userTab` at all. The page address is attached from any tab, named on its chip.

**The tab is `browser.userTab`, never `activeBrowserTab`** — focus is in the chat view when `+` is
pressed, which is exactly the state where `activeBrowserTab` is `undefined` (#259, #334). That is
why `pickAndDeliver` grew a `preferred` tab.

### Agents the agent starts

The composer's `$(hubot) N` button counts the sub-agents running in this chat, and only those
(asked for): with none running it stays, muted and **without a number** — not a 0, and not the
total it used to show, which read as agents at work — so the list and the reports can still be
opened once they finish; with no agents at all it is hidden. It opens a list over the
chat — status dot, the agent's description, "Running · Grep · 3m 28s · 230k tokens" — and a row
opens its card: status · type · model · background, "Spawned by the main agent", time, tokens and
tool uses, the agent's report as Markdown, then its prompt and its tool calls folded. The layout
follows the Claude Code panel's own agent map, as asked for; it is **in the chat, not a file**,
which was the first idea and was changed on request. Everything is read from the chat's own
rows: nothing is asked of the CLI, and a chat reopened from the history shows its agents too.

**The composer's agents button is gone; agents live in two places** (asked for): the Activity composer tab lists this chat's agents at work now (with "View all agents (N)" opening this chat's Agents panel), and the title bar's **All Agents** (`aiBrowser.chat.allAgents`, `$(hubot)` beside the cup) lists every agent and workflow of every chat open in the extension host, grouped by chat (`showAllAgents` → `allAgents`, refreshed every second by `listAllAgents` while open, editor-only). A row of this surface selects its chat and opens the agent's card (`pendingAgentCard`); a row of another surface is shown, not clickable. The Activity tab carries two counters: agents running in this chat, and this chat's access (own browser tabs, remote viewers, pinned terminals).

**Once the turn has ended and agents are still running, the foot of the chat says so** — asked
for: "✱ 2 agents running · 3m 12s" under the last turn's "Worked for …" (`agentsRunningLine`, in that
turn's tail), the working star in front and turning on the same timer, the text shimmering.
Only then: while the turn runs, the working line is the one at the bottom, and once no agent is
`running` the line goes. It counts the chat's running agent rows, whichever turn started them —
a background agent from an earlier turn included, and the toolbar skills running in the
background. **The time is since the first of them started** — how long the background work has
gone on, asked for with the choice left to us; a sum of the agents' times would run ahead of the
clock. It is rewritten in place every second, and the line rebuilt only when the count or that
start changes. A click opens the agents list
(`openAgentsPanel`, shared with the button). The tail is rebuilt only when the count changes,
#365's rule, or a click straddling a post would be lost; checked in headless Chrome against the
bundle — same element across a post with the same count, gone when the last agent ends.

**Claude Code, measured on 2.1.301** (the samples are in `agentProtocol.test.ts`):

| event | what it means here |
|---|---|
| `tool_use` `Agent` (`description`, `prompt`, `subagent_type`, `run_in_background`) | the row, with its prompt as `input` |
| `system` `task_started` (`tool_use_id`, `is_backgrounded`) | type and background |
| `user` `tool_result` with `tool_use_result.status: 'async_launched'` | a background agent has *started* — the row stays running; `resolvedModel` is its model |
| messages with `parent_tool_use_id` | the agent's own work: its `tool_use` blocks become the card's tool calls, never rows of the chat (capped at 100) |
| `system` `task_progress` | `usage.total_tokens` / `tool_uses` / `duration_ms`, `last_tool_name` |
| `system` `task_notification` | the end: `status` (`completed` → done; `killed`, `stopped`, … → stopped; anything else failed), `summary` as the report |
| `system` `status: 'requesting'` | the CLI starting a turn **of its own** |

**A background agent outlives the turn that started it**, and that is the shape everything
follows from. The main turn's `result` arrives while the agent is still working, so the turn-end
sweep that marks every running tool as done — right for every other tool, which will never be
told otherwise — must pass over a background agent row (`agent.background`), or it reads
"Finished" while the agent works on. The agent ends on its own `task_notification`, and then
**the CLI answers it unprompted**: a fresh turn with text and a second `result`. With no prompt
waiting, `_pendingTurns` was 0, so that turn ran with the chat showing nothing at work and its
`result` went to a prompt queue that was empty. `status: 'requesting'` is the signal — emitted
for the main agent only, and only with `--include-partial-messages` — and `autoTurn` sets
`_pendingTurns` to 1 (ignored while a user turn is already counted) and breaks the text, so the
reply is a block of its own.

**Two more consequences, both in `claudeAgent.ts`.** The process is not restarted for a model or
effort change while a background agent runs (`_agents`), since a restart ends it. And when the
process exits or is stopped, every agent it still had is reported `stopped` (`_endAgents`), since
no notification will ever come; the chat's own `_endTurnHere` does the same for a closed tab and the
rest — and with no turn in progress, only agents in the background, it ends them without a
"Stopped." notice, since no turn was stopped.

**A model or effort change waits for the background agents, and says so** — once, as a notice:
"The new model or effort applies once the background agents have finished." Skipping the restart
in silence left the pill showing a model the next message did not use.

**The automatic turn takes a place in the chat's queue** (`_pending`, an entry with no prompt).
Without it a message sent while that turn ran was queued behind nothing: the automatic turn's
`result` was written onto that message, and the message's own turn found no prompt — #345 again,
from a new direction (#362).

**Not every task is an agent.** `task_started` is sent for every task type, and a background shell
or a Bash call running past two seconds is one (`task_type: local_bash`): read as an agent, a Bash
row took agent fields, had its output replaced by the task's summary, reopened as `stopped`, and
a dev server that never ends would have held the model for good. So `task_started` is read only
for `local_agent` / `remote_agent`, the chat applies a report carrying agent fields to an agent
row only, and `_agents` counts only calls that are agents (`_agentTools`) — including one asked
for in the background, from the call itself, so a process that goes before the launch is
confirmed still reports it ended (#363).

**A foreground agent moved to the background** arrives as `task_updated` with
`patch.is_backgrounded` — the CLI's own schema says so; an earlier comment here claimed
`task_updated` carried nothing useful. It names the task, not the call, so `claudeEvents` is given
a map from `task_started` (task id → call id) to find the row. Without it such an agent read
"Finished" at the end of the turn while it worked on.

**The panel is rebuilt only when what it shows changes** (`agentsShape`); time, tokens, the tool an
agent is on and the tool-use count are rewritten in place (`data-live`), and every second while
the panel is open. Rebuilt on every state post, as the first version was, it swallowed clicks
whose press and release straddled a post — rows, Back, Close, the folds — cleared any selection in
the report and threw focus to the body (#365). A rebuild that is due waits while a button is held
or a selection lies in the panel. A panel left open across New Chat closes. An agent's report is
cut for the history like any tool body; it was stored whole beside a cut copy in `output`.

**Codex, measured on codex-cli 0.162.0-alpha.17.2** (the copy the Codex extension ships, with
`multi_agent` on, as it is by default). The first version followed the app-server schema —
`collabAgentToolCall` with `tool: 'spawnAgent'` as the row, `agentsStates` to end it — and showed
nothing at all, reported as "Codex shows no agents": a live turn that starts a sub-agent sends
**no** `spawnAgent` item, and the `wait` item it does send carries an empty `agentsStates`. What
arrives instead:

| event | what it means here |
|---|---|
| `subAgentActivity` on the parent's thread, `kind: started` | the row, keyed by `agentThreadId`; `agentPath` (`/root/read_a`, a name the model chose) is its title and its type |
| `kind: completed` / `interrupted` | the row ends done / stopped; `interacted` changes nothing |
| every notification under the agent's **own** `threadId` | its work: tool items become the card's calls, `thread/tokenUsage/updated.total.totalTokens` its tokens, its last `agentMessage` its report |

Each `subAgentActivity` arrives twice, as `item/started` and `item/completed`, so only the first is
read; a second `started` for the same agent (Codex giving it more work) runs the existing row
again rather than adding one. **The agent's thread has no session of its own**, so its
notifications were dropped by the routing that sends each `threadId` to its conversation:
`CodexSession._watchAgent` binds that thread to the conversation whose turn started it
(`CodexBackend.bindAgent`), and `notifyAgent` reads it with `codexAgentThreadEvents` — never as the
reply. An approval request from an agent's thread is asked in the conversation the agent belongs
to, like the conversation's own: a card in that tab, which then shows the waiting mark. An
agent an agent starts is bound the same way and gets a row of its own; its card says which agent
started it, read from the path. **The prompt is not sent anywhere**, so a Codex card has no Prompt
section. The `spawnAgent` / `agentsStates` reading stays, for a Codex that does send them
(`multi_agent_v2` is off here).

**A Codex agent is `background`**, and that reverses an earlier decision on purpose. It used not
to be: the parent `wait`s inside its turn (measured), so `completed` arrives before the turn ends,
and the turn's end settled anything left like any other row — a row blinking for ever being the
worse error. That holds for the turn that waits, and not for a thread given more work later, or
an agent an agent started, whose parent's turn is not this conversation's; the end-of-turn sweep
marked those done while they worked on, and "until agents finish" (keep-awake) let the computer
sleep under them. So the rows survive the turn, and **every way an agent can be left without its
own report ends it from our side instead**:

- **Stop** (`CodexSession.stop`) interrupts every agent turn of the conversation and ends every
  agent row as stopped, a Stop pressed with only agents left working included — whether Codex
  interrupts an agent's thread with its parent's turn is not measured, so it is not relied on.
- **The app-server exiting** ends them as failed (`processEnded`, `_backgroundAgents`).
- **Closing the tab** interrupts their turns and the tab ends the rows (`_endTurnHere`).
- **A parent agent stopped or failed** ends the agents it started (`parentId`, below).

**An agent an agent started names its parent** (`AgentInfo.parentId`): Codex's from the thread
the `subAgentActivity` arrived on, Claude Code's from the `parent_tool_use_id` of the message
holding the `Agent` call (`nestedAgents` in `claudeEvents` lets its result through, which a
sub-agent's results otherwise are not). `ChatTab._endOrphanedAgents` ends such a row, after every
event, once its parent is stopped or failed — grandchildren too. Its own report may never come:
Claude Code's interrupt and `stop_task` are not measured to report the agents inside, and the row
is background, so nothing else would end it. A parent that *finished* is not followed, since its
children report their own end and a Codex thread may outlive its parent. **A nested Claude agent
is not one of `ClaudeSession._agents`**: it lives inside its parent, which is what holds a model
change back and what a process exit ends.

**Each running agent can be stopped on its own**, from the agents panel — a Stop button on its
row and in its card — while the turn and the other agents go on:

- **Claude Code**: the `stop_task` control request with the task id (`task_started` gave it beside
  the call's id; `ClaudeSession._tasks`). Measured on 2.1.301 with an agent in a loop of `sleep`s:
  answered at once with success, then `task_updated` (`status: killed`) and `task_notification`
  `status: stopped`, which ends the row; the CLI then answers the stop in a turn of its own (an
  automatic turn, as above). That notification's `summary` is only the task's description ("Run
  timed step loop"), so it is not shown as a report. (A standalone `sleep 40` is refused by Claude
  Code itself, which ends the agent before any stop — worth knowing when measuring this again.)
- **Codex**: `turn/interrupt` on the agent's own thread, with the turn its `turn/started` named
  (`CodexSession._agentTurns`); an interrupted turn on that thread ends the row as stopped, as
  `subAgentActivity` `interrupted` does. Read from the protocol and the code path above, not
  measured with a real stop.

A row reopened from the history has no live session, and is shown stopped already. The button
says "Stopping…" until the row ends, or until the host answers that the stop was refused
(`agentStopFailed`) — Codex between two of an agent's turns, an agent Claude Code has not reported
as a task yet — when it comes back, with the reason in the chat. It used to stay "Stopping…" and
disabled for good. **Closing a Codex tab interrupts its agents' turns as well** as its own: their
threads live in the app-server the other tabs share, and once the session is gone nothing would
show or stop them. An agent's `turn/started` that arrives before the parent's `subAgentActivity`
binds its thread is kept (`_unclaimedTurns`, bounded) and handed over at the binding, or that
agent could not be stopped.

**A Claude Code workflow is listed with the agents.** The `Workflow` tool's call is an agent
row (`agent.type: 'workflow'`, background), named by its `name` or the script's `meta.name`, its
description as the prompt; its task arrives as `task_type: 'local_workflow'` (read in the 2.1.309
binary beside `local_agent`) with the same `task_started` / `task_progress` / `task_notification`,
so it counts, shows time and tokens, and stops like an agent. The row carries a
`type-hierarchy-sub` icon. **Not measured yet:** whether the workflow's own agents and phases
reach stream-json; until then the card shows the workflow alone.

**`stopped` is a fourth tool status**, drawn in the warning colour. The turn-end sweep uses it for
a turn that ended with `Stopped.` too, where it used to say `failed`.

Verified with a fake Claude CLI behind the compiled `chatView.js`: a foreground agent finishing in
its turn, a background one surviving the turn's `result` and ended by its notification, the
automatic turn showing as its own reply with no prompt waiting, and closing the tab stopping an
agent still running; after the review, a message sent during the automatic turn keeping its own time
and tokens. The panel was checked in headless Chrome: hidden with no agents, a click and a fold
landing with a state post between press and release, a 3 006-character selection and the scroll
surviving posts, ↑ in a wrapped draft moving the caret.

### One command table for the three surfaces

[src/chat/core/commands.ts](src/chat/core/commands.ts) (leaf, under test) has a row for every
`ViewToHost` type saying what the Chrome side panel and the Exchange website do with it: `host`
(forwarded and carried out), `local` (answered by the surface's own shim), `mixed` (some forms
local or refused by the host), or `{ no }` with the reason. `satisfies Record<ViewToHost['type'], …>`
fails the typecheck until a new type has its row, and a type with no row is refused remotely.

- **The Chrome side panel forwards `forwardedTypes('chrome')`**, and `commandChromeSource` now
  checks the same column on the host — before, the host had no allowlist for Chrome's `chat`
  feature, and only the panel's own list stood between a crafted command and `_receive`.
- **`exchangeRefusal` reads the website's column** (it replaced the `exchangeForbidden` denylist,
  under which a new type was allowed by default). The website's own `history` request is not a
  `ViewToHost` and passes.
- **`commands.test.ts` freezes both forwarded sets** as reviewed literals: changing a row that
  widens or narrows what a remote surface may do changes that diff, on purpose. It also checks
  that the website reader can still produce every forwarded type and that each row's feature is
  the one Chrome negotiates (`chromeChatCommandFeature`).
- **The renderer shows the same table before anything is clicked.** Chrome's and the website's
  states carry `surface` and `controls` (`surfaceControls`, only what is not on): a `{ no }` row is
  a disabled control with the reason as its title, a `{ no, hide }` row (the microphone, recording)
  is hidden — policy and destructive actions are disabled, what cannot work away from the
  editor's machine is hidden. `post()` in `chat.ts` refuses a message whose control is not on and
  shows the reason in a line above the thread (`controlRefusal`), so a refused action never reaches
  a shim or the host. Menu rows take `command` (gated in `openMenu`), buttons `gateButton`. A form
  of a `mixed` command is a control id of its own (`openBrowser.chrome`); this replaced the
  renderer's reading of `remoteWorkspace`. The editor's own state has no map: everything is on.
- **What leaves the editor is a classified list** (`viewFields` / `projectView` in
  `chromeChatProtocol.ts`): every `ChatViewState` field is `shared`, `editor` or `override`, the
  `satisfies` fails on a new field until it is classified, and an unclassified field is not
  copied. The snapshot used to be `...state` with known fields blanked, so a new field holding a
  path went to Chrome and the website by default.
- **The last `workdirGit` per folder rides in every remote state** (`snapshotEvents`, kept by
  `ChatStateSurfaces.broadcast`) and both shims hand it to the renderer once per change
  (`preview-src/snapshotEvents.ts`, shared). Before, Chrome — which takes no pushed events —
  never saw a Git change made in the editor, and a website viewer that connected after one saw
  none until the next. The relay cannot cache events itself (encrypted envelopes are opaque).
- **Settings kept for the whole window reach every chat surface at once**: approval modes answer
  the waiting cards of every surface's tabs and redraw every menu, `newsHidden` redraws every
  surface; each used to redraw only the surface it was changed in.
- **Delays**: the website's extra coalescing is 16 ms (was 150 on top of the host's 40).
- **Chrome long-polls the snapshot.** The panel sends `X-AI-Browser-Wait: 1000` with its ETag; the
  bridge holds an unchanged request until a new revision, a delivered event or the bridge closing
  (`_waiters` / `_wake`), at most `chromeChatMaxWaitMs`, and answers the header back. A panel that
  sees it polls again at once; against an editor without it, every 250 ms (was 750). The loop also
  carries the annotation sync and the footer events, which is why the hold is about a second and
  not the 25 s a pure long-poll would use. **Listen for `close` on the response, not the
  request**: a GET request emits `close` as soon as its body is read, which took every held
  request off the wait list unanswered.
- **A snapshot older than the one on screen is dropped in Chrome** (`shownRevision`): a command's
  reply now carries the bridge's `revision`, a poll its ETag, and the two can land in either order
  once a poll is held. The pin of another conversation and a new connection reset it.
- **Chrome picks its conversation in the renderer's own tab strip**, not in a `<select>` of the
  shell: `selectTab` is `local` for Chrome, and the side panel answers it with the pin
  (`pinConversation`), so clicking a tab in Chrome changes what Chrome shows and leaves the editor's
  tab in front alone. The strip reads the control map: the close button (`closeTab`), dragging
  (`placeTab`), renaming (`renameTab`), "+" (`newTab`) and the move rows (`moveTabTo` /
  `moveTabToNew`) disappear where they are not on. The old `<select>` is kept in the markup and
  hidden. **The website does the same** (`pinConversation` in `serverChatHost.ts`, `chat.pin`):
  its `selectTab` is `mixed` — the shim pins, and the host still accepts one naming the shared tab.
- **"Open in Google Chrome" on a tab counts Chrome's bridges only** (`ChatStateSurface.kind`,
  `chatIds(front, 'chrome')`). The Exchange website's surface is `active` while its relay socket is up,
  viewers or not, so with it counted a tab stayed marked as shared in Chrome after Chrome was closed.
- **The Chrome side panel offers the Chrome tab in front as a dashed suggestion**, as the editor offers
  its browser tab (`pageSuggestion` in `sidepanel.ts`; `acceptSuggestion` is `local` for Chrome). The +
  attaches it as a `sharedPage` that follows the tab; it is not offered while the draft holds that tab.
  The page chip's text (`chromePageText`) says the page is in Google Chrome and names the `browser_*`
  tools: told only "check browser_tabs", the agent did not see that "open the page" meant those tools.
- **The website can open Google Chrome** (`openBrowser` with `where: 'chrome'` runs `aiBrowser.openInChrome`
  on the editor's machine), and the Browser panel's tab list names each tab's browser: `remoteTabs` carries
  `kind: 'chrome' | 'vscode'` (`tabSource.isChrome`), the relay's `browser.state` schema accepts it as optional,
  and the select reads "Chrome · …" / "VS Code · …".
- **The website offers the page its Browser panel streams as a dashed suggestion too**, built by the
  host (`exchangePageSuggestion` in `exchangeChat.ts`): the shim cannot see which tab is selected, the
  stream socket can (`ExchangeBrowser.selectedPage`, from its last listing, only while a viewer watches;
  `onPage` republishes the snapshot when it changes). The shim answers `acceptSuggestion` itself with the
  existing `attach` of kind `page`, which the host builds from that same tab, MCP note included; it is not
  offered while the draft already holds a page.
- **The view title's buttons are the renderer's on Chrome and the website** (`remoteBar` in
  `chat.ts`, shown whenever `state.surface` names a remote surface): New chat (`newTab`), History
  (`history`, the website's own request, hidden for Chrome by a form rule), Keep awake (`setSleep`)
  and Chat settings (`saveFeatureAi`), each gated by the control map. The website's header kept
  only its connection status; its four buttons and their wiring in `serverChatHost.ts` are gone.
  **The bar sits in the shell's own header** when the page has a `#remote-actions` slot (both shells do), so it takes no row of its own, beside the connection status. The served copy is `apps/web/public/remote-chat/`, written by `exchange-server/scripts/build-chat.mjs` — edit `chat-assets/` and rebuild, or the page keeps the old header.
  **Both shells used to hide the renderer's tab strip** (`#app .tab-strip { display: none }` in
  `sidepanel.css` and `web-chat.css`) in favour of their `<select>`; those rules are removed, or
  hiding the select would have left no way to switch conversations.
- **Patches instead of whole states** ([src/chat/core/sync.ts](src/chat/core/sync.ts), leaf, under
  test): `diffState` names the top-level fields that changed or went and the entries as a tail
  from the first that differs; `applyPatch(prev, diffState(prev, next))` is `next`, checked on
  3 000 random pairs. Computed **per surface, after projection** — `_state` and its side effects
  (`seen()`, the `@N` references) are untouched, and no `editor` field can leave through a patch.
  - **Chrome**: the panel names what it shows in `X-AI-Browser-Base: <epoch>:<rev>`; the bridge
    keeps copies of its last four snapshots (`_published`) and answers `{ patch, top }` — the view
    diffed, the snapshot's other fields whole, `entries` not twice — when that is under half the
    snapshot, else the whole snapshot. A patch that does not apply empties the panel's base and it
    polls again at once for the whole one. The epoch is per bridge, sent in the same header.
  - **Exchange**: the relay announces `features: ['patch']` in its `ready`
    (`RELAY_FEATURES` in `packages/protocol`); only then does the agent number its snapshots
    (`epoch`, `rev`) and send `chat.patch` between them. A whole snapshot still goes at least every
    2 s (`fullEveryMs`), **2 s after the last patch** (`trailing` — the relay caches whole snapshots only, so a burst ending in a patch left a viewer joining later, or a page from before the relay's upgrade that drops patches, on half a reply still "Working"), on `ready`, on the encrypted socket's sync and on `chat.resync` — what the
    website sends when a patch does not fit (at most once a second; a request inside that second is deferred to its end, never dropped). The relay broadcasts patches
    and never caches them, so a late viewer starts from the cached snapshot and converges at the
    next whole one. A snapshot cut to fit 5 MB is never a base. An older relay announces nothing
    and gets whole snapshots, as before; relay and web assets ship together, so an old website
    never meets a patch. **`chat.resync` is answered by the agent itself** with `command.result`,
    before the conversation checks.
- **Both remote entry points start at one door**, `remoteScope` in
  [src/chat/core/remoteScope.ts](src/chat/core/remoteScope.ts) (leaf, under test): the surface's
  conversation (or `remoteGone`, worded per surface), then the chat's own `_blocked()`, then the
  table's refusal — one order for `commandChromeSource` and `commandExchangeSource`, which keep
  only what differs (Chrome's send and attachments; the website's browser, folder and annotation
  forms, and `exchangeRefusal`'s check that an inner id names the shared conversation). The
  surface's members are private, so the scope takes callbacks rather than a shape. Tests that lift
  those methods out of `chatView.ts` are given `remoteScope` beside `remoteRefusal`.

### Sharing a chat with Exchange

`exchange-server/` is a separate hosted application (Next.js, NestJS, PostgreSQL; its own
[README](exchange-server/README.md) is the reference for running it and for protocol v1). The
extension's half is **AI Browser: Connect Chat to Exchange**: one chat of one surface, observed
as a `ChatStateSurface` like Chrome's, published as a text-only snapshot over a WebSocket the
extension opens, and driven back by exactly two commands, `chat.send` and `chat.stop`, through
`ChatViewProvider.commandChromeSource`. `exchange-server/**` is in `.vscodeignore`.

- **A website message is an editor message.** It goes through `_send`, so every approval
  category on Auto answers yes without a card: a website session can run commands in the
  workspace. Approvals themselves are never answered remotely; the snapshot says one waits.
- **The website's `chat.command` is the chat's own UI, narrowed by `exchangeRefusal`** in
  `chatView.ts`. It refuses `setApprovalMode` (a remote Auto for every category would run
  commands with no card, and the choice is stored per workspace), `deleteChat`, `openChat`,
  `temporaryStorage`, `resumeInTerminal`, `setAgentBinary`, `openAgentSetting` and `openFile`,
  and an inner tab or chat id that is not the shared conversation's. `ExchangeSurface` checks
  only the outer `chatId`, so a new message type with an `id` must be added there too.
- **The Chrome extension never copies through the page's DOM.** Its annotation Copy tries
  `navigator.clipboard` in the page and otherwise a field in the side panel's own document
  (`copyInPanel`, which `clipboardWrite` lets copy without focus): a `<textarea>` appended to
  the page let its `MutationObserver` read the note and its `copy` listener rewrite it.
- **A pick started from the website is answered by the website's click, by coordinates**
  (`src/browser/remotePick.ts`, a leaf registry). Element and annotation picks register for
  their tab; `remoteInput` hands a left click on that tab to them instead of dispatching it:
  `DOM.getNodeForLocation` on the picker's own session for an element, the page script's
  `pickAt(x, y)` (`elementsFromPoint`, our overlay skipped) for an annotation. Waiting for input
  on the page left the pick to be finished in the local VS Code browser, where the shared tab is
  usually a hidden tab behind the website itself. In headless Chrome a CDP click does finish an
  inspect pick, so the cause in the editor is not pinned down; the coordinate path does not depend
  on it. A handler that declines (no annotation pick under way) lets the click reach the page.
  **The website sends pointer moves** (`action: 'move'`, a mouse only, at most every 120 ms and
  never with more than two commands in flight), dispatched as `mouseMoved`: the inspect overlay
  and the annotation picker highlight from it, and the page gets its own hover.
- **Git state reaches the website on its own** (`ChatStateSurface.event`, `broadcast` in
  `chatSurface.ts`): every `workdirGit` the editor posts — after a commit, a branch switch, an
  editor event — is also sent as a `chat.event` for the pinned chat. It used to go only to the
  editor's view, so the website saw Git only as the reply to its own refresh. An active remote
  surface also counts as a viewer for `_gitEventRefresh` / `_refreshWorkdirGit`, so the read runs
  with the editor's chat view hidden; Restricted Mode still refuses it (#208).
- **Close from the website** (`action: 'close'`, the × button) closes the shared tab: the
  built-in browser's with `tab.close()` (`remoteInput`), and for a Chrome source the stream is
  stopped and the selection cleared (`exchangeBrowser.ts`). There is no DevTools action: one was
  built and removed, and the protocol refuses `devtools` (`remoteBrowserProtocol.test.ts`).
- **The stream relay refuses the way the chat relay does** (`Refused` in `stream-relay.ts`):
  4001 on `/ws/stream-agent` and 1008 on `/ws/stream-browser` for evidence, 1011 for a check
  that failed. It closed 4001 on any error, so one database hiccup stopped streaming for good.
- **Remote terminals need the snapshot's epoch**, so the agent numbers every snapshot (`epoch`,
  `rev`) whether or not the relay carries patches; the website refuses to attach without one. The
  viewer id must match `viewerPattern` (8–64 of `[A-Za-z0-9_-]`): `exchangeViewerId`'s `legacy`
  fallback does not, so the website then uses a page-lifetime id for terminals. While a viewer holds
  the control lease (`TerminalTab.setRemoteControl`) the editor view's resizes are kept aside and
  applied when it ends; the strip shows a globe on a shared terminal, orange while the website is
  in control. `src/chat/exchangeTerminal.test.ts` drives it end to end over an encrypted fake relay;
  `preview-src/remoteTerminalEnds.test.ts` joins the website shim to the hub.
- **Refused in an untrusted workspace**; plaintext only to loopback (`exchangeServerUrl`); the
  key in SecretStorage, the address and point ID in workspaceState; nothing reconnects after a
  window reload.
- **Only close code 4001 stops the client for good** (refused key, revoked or deleted point,
  connection replaced). Every other close reconnects with backoff. It was 1008 for all of them,
  and the relay also sent 1008 for a snapshot it could not parse and for a queue overflow, so a
  slow database read as "your key was revoked" and disconnected for good. A failure *while*
  checking the key (the database, the session store) is 1011, not 4001: only evidence refuses
  (`Refused` in `relay.ts`). The relay keeps 1008 for a refused `/ws/browser`.
- **The client's frame limit is the relay's `maxPayload` (8 MB for chat, 2.1 MB for the stream relay), in bytes.** The protocol limits
  `text` in UTF-16 units (64 000), and 64 000 Cyrillic characters are 128 000+ UTF-8 bytes: a
  128 000-byte limit closed the socket on a valid command, the relay timed out after 30 s, and a
  retry did the same. Compare frames in bytes against the relay's own limit.

Not run inside VS Code against a live server yet beyond the README's manual steps; the smoke test
(`npm run test:smoke` in `exchange-server/`) covers the relay with a fake agent.

### Only the last turns are loaded

Asked for: a remote connection was slow because every message of a chat was sent, and the editor's
view kept every message in its DOM. Now every view — VS Code, the Chrome side panel, the website — is
sent the last **turns** of the conversation: a turn is the user's message with everything after it
(replies, tool calls, thinking), so a window never starts in the middle of an answer. Counting only
the user's messages would let one turn with hundreds of tool calls fill the view, so the window is
also capped at 20 entries per turn on average (`windowEntries` in
[src/chat/core/entryWindow.ts](src/chat/core/entryWindow.ts), leaf, under test), moved back to start at a prompt.

- **How many**: `aiBrowser.chat.visibleTurns`, 20 by default (5–200), read in `extension.ts` into
  `setVisibleTurns` so the Chrome bridge and the website's connection — which load no `vscode` — read
  the same value. Each "Show earlier messages" adds that many again.
- **Where the cut is made**: per surface, after `_state()` — `_postMessage` for the editor's view
  (`_windowed`; `typeof` because tests lift `_postMessage` alone), `chromeChatSnapshot`'s `prompts`
  for Chrome and the website. `_state()` itself stays whole, since the other surfaces cut their own.
  The view is told `entriesOffset` (an `override` field), the index of the first entry sent.
- **Loading more**: `{ type: 'loadEarlier', chatId, reset? }` — the button at the top of the thread,
  scrolling to the top, or the composer's History tab. The editor answers it in `_receive`; Chrome's
  bridge (`readLoadEarlier`) and the website's connection answer it before their command readers, with a
  whole snapshot. A window belongs to one conversation and goes back to the default on another.
- **Dropping again**: once more was loaded and the view has sat at the end of the thread for a minute
  (`earlierIdleMs`), it sends `reset`, and the earlier turns leave the DOM and the state.
- **Indices**: the view's entry indices are local to the window; the two messages that carry one to the
  host (`secondOpinion`, `openAttachment`'s `entry`) add `entriesOffset`, and the opened/closed rows are
  keyed by the place in the whole chat (`keyOf`, `turnKey` add `renderedOffset`).
- **A window that moves forward is not a rebuild.** Each new message in a chat longer than the window
  pushes the oldest turn out; the view drops the leading turns' nodes (`turnFirst`) and keeps the rest.
  Rebuilding there redrew the thread and lost clicks on every send (#365). Only a backward move (earlier
  turns loaded) rebuilds, keeping the distance from the bottom.
- **The window always starts at a prompt**, the current turn's own when that turn alone is over the
  entry cap. Starting at "total minus the cap" put the start mid-turn and moved it with every new entry,
  which rebuilt the thread on every post of a long agent turn.
- **The website's 5 MB trim adds what it cut to `entriesOffset`**, or the indices above point at other messages.
- The host keeps the whole conversation in memory; only what the views hold is cut.

### Finish sounds

Asked for: a sound when an agent finishes, chosen in settings from five, with a volume, and a
speaker button left of the C and U meters that switches between sound and silence.

- **Synthesised, not files** ([preview-src/chatSound.ts](preview-src/chatSound.ts)): Web Audio
  oscillators, so the CSP needs nothing and Chrome and the website play the same sounds.
- **The settings travel in the state** (`ChatViewState.sound`, `shared` in `viewFields`), so the
  Chrome side panel and the Exchange website play them too; they are changed only in VS Code
  (`soundSettings` is `editor()` in `commands.ts`; Chat Settings → Sound, written at
  `ConfigurationTarget.Global`).
- **"Finished" is a tab's `busy` going from true to false** between two states, not ending on
  `waiting` (an approval). The first state after a load plays nothing.
- **The speaker button overrides the default per device** (`localStorage`
  `aiBrowser.chat.soundOverride`), and the override records which default it overrode: changing
  `aiBrowser.chat.sound.enabled` makes the setting win again.
- **System notifications** (`aiBrowser.chat.notifications.enabled` / `.onlyWhenAway`, both default on, in the
  same settings section and the same `soundSettings` message): the editor's view posts `osNotify` and the host shows
  it with `osascript` (`display notification`, title and text as `argv`), PowerShell's `NotifyIcon` balloon (text in
  the environment) or `notify-send` — never a VS Code toast, which pauses a browser tab (#10). "Away" is
  `window.state.focused`. On macOS the sender shown is Script Editor; no prompt is needed. Chrome and the website use
  the page's `Notification` (permission asked on the first click; the Chrome manifest declares `notifications`),
  "away" there being `!document.hasFocus() || document.hidden`. `osNotify` is `editor()` in `commands.ts`.
- **Chrome and the website have their own Sound & notifications tab**, stored per device in
  `localStorage` (`aiBrowser.chat.deviceSound`: sound, volume, notify, notify only when away), since
  `soundSettings` stays editor-only — a remote surface may not write VS Code user settings. A key not
  set there follows the editor (`effectiveSound`). "Play a sound" there drives the speaker button's
  per-device override. The tab's `hidden` test is inlined in `openFeatureSettings`, which tests lift
  into a sandbox.
- **Repeat** (`aiBrowser.chat.sound.repeat`, 1–5): the sound is scheduled that many times back to back, each copy after the previous one's last note plus 0.15 s. Per device on Chrome and the website like the rest.
- **Active chat** (`aiBrowser.chat.sound.activeChat`, default off): a selected, visible conversation in the active window finishes silently unless "Play a sound for the active chat" is checked. VS Code uses `window.state.focused`, published as editor-only `windowFocused` and refreshed on window-state changes, so focusing another workbench control does not make a visible chat sound. Chrome and the website use their own `document.hasFocus()`. Background conversations, inactive windows, hidden pages and conversations behind a terminal still sound. Applies to finish sounds only: previews and system notifications keep their own controls. Chrome and the website can override this per device in `aiBrowser.chat.deviceSound`.
- **A suspended `AudioContext` plays nothing**: one created without a user gesture (the first finish arriving while the window is in the background) starts `suspended`, and notes scheduled before `resume()` lands are in the past. `playChatSound` schedules only once the context runs, and `unlockChatSound` starts it on the view's first press or key.
- Volume goes to 200: the old 100 is kept as is, above it is louder; a `DynamicsCompressor` limits the sum so
  loud chords do not clip. Fifty sounds (`chatSounds`, the manifest's `enum` and `chatSoundLabels` list them
  alike); a note may glide (`to`).
- Queued and waiting messages show a static hourglass (`watch`), not the spinning `loading` icon
  (asked for).

### Keeping the computer awake

The cup in the chat view's title bar — beside New Chat, Chat History and Refresh Agents —
keeps the computer from sleeping: for a number of minutes or hours (the lists in
`sleepProtocol.ts`, anything else refused), or **until the agents and sub-agents finish** — no
tab busy, waiting on an approval, holding a queue, or running a toolbar skill in the background.
The choice is **per window** and lives in memory: a reload switches it off. The display may still
sleep; only system sleep is held off.

**It sits in the title bar because it is one setting for the whole chat** — asked for, in two
steps: from the composer, where it read as belonging to the conversation in front, to the tab
strip, then up to the view's own title. Details that follow from being there:

- **A title bar icon is static**, so the button is two commands: `aiBrowser.chat.keepAwake` (an
  empty cup) and `aiBrowser.chat.keepAwakeActive` (a filled one), swapped by the
  `aiBrowser.keepAwakeActive` context key, which the provider sets whenever the choice is not
  off (`_publishSleep`) and clears on dispose.
- **The two cups are glyphs of an icon font of our own, so they take the theme's icon colour**
  — asked for, after they first shipped as SVG pairs and stood out beside New Chat and History.
  A contributed SVG is drawn as a picture and keeps its fills; a font glyph is drawn as text in
  `icon.foreground`, exactly as a codicon is, hover and every theme included. The codicon font has
  `coffee` but no filled form, so `media/ai-browser-icons.ttf` (U+E001 empty, U+E002 full) is
  contributed through `contributes.icons` as `$(ai-browser-cup)` / `$(ai-browser-cup-full)`.
  Details that matter:
  - **It is generated, not drawn in a font editor**: `node ./scripts/build-icon-font.mjs` writes
    the TTF from code, no dependency (no fontTools here, and the project keeps none). The ten
    tables Chromium's sanitizer (OTS) requires are written by hand; a font it rejects simply draws
    nothing, so check a rebuild in headless Chrome with an `@font-face` page — `document.fonts`
    reports `loaded` or `error`. Its metrics copy `codicon.ttf` (300 units per em, the glyph in
    0..300 above the baseline), which is what puts the cup at the same size and height as a
    codicon. Glyphs are filled outlines: a stroke has no meaning in a font, so walls are rings
    whose inner contour winds the other way.
  - **VS Code takes `ttf`, `woff` and `woff2`** for `fontPath` (`{ttf:"truetype",…}` in the
    workbench bundle, 1.137); TTF needs no compression step. `fontCharacter` is `"\\E001"` in the
    JSON — a backslash and the hex code.
  - **`check-manifest` checks both halves**: every `$(ai-browser-…)` a command names is declared
    in `contributes.icons`, and every declared font exists. An unknown icon id draws an empty
    button with no error anywhere — verified by misspelling one and watching the check fail.
  - The font sits in `media/`, not `media/icons/`, which `check-manifest` reserves for SVGs and
    sweeps for orphans.
- **The popup is still the view's own** (never a QuickPick, which would pause a browser tab):
  the command reveals the view and posts `openSleep`, held until the webview says `ready` like
  every non-state message, and the popup hangs from the view's top right corner, under the
  button (`openSleepPopup`). A press on the title bar is outside the webview, so it cannot toggle
  the popup closed; Escape, a click elsewhere or a choice closes it.
- Both commands are hidden from the palette with the rest of the chat's title commands.

**"Until the agents finish" has a scope** (`SleepScope`), asked for in the same breath: **This
tab** waits on the tab in front when it was chosen (`{ mode: 'agents', scope: 'tab', tabId }`),
**All tabs** on every tab of the window (`scope: 'window'`, also what an absent scope means). A
timer has no scope — it holds the computer, whatever the tabs do — which is why the popup
labels the timer grid "the whole app". `SleepControl` asks `working(tabId)`; the provider
answers for that tab alone, so a tab-scoped hold ends when that tab's work does even while
another tab works on, and **a closed tab works no more**, so closing it ends the hold too. A
`setSleep` naming a tab that has already closed is ignored. When another tab holds it, the
popup says so ("Now held by …"), so choosing This tab reads as moving the hold. Tab ids are
minted per extension host, which costs nothing here: the choice does not survive a reload anyway.

[src/power/](src/power/) holds it, in three parts, and the split is the design:

- **`SleepControl`**, one per window in the chat's provider, holds the choice and reduces it to one
  boolean vote, re-judged every second (a timer running out, the agents finishing — after 500 ms,
  so a choice made between two turns is not dropped at once). Only the vote crosses the process.
- **`runSleepDaemon`**, one per user, takes every window's vote over a Unix socket
  (`<tmpdir>/ai-browser-wake-<uid>/v1.sock`, the directory `0700` and checked to be ours) or a named
  pipe on Windows, and holds the OS lock while any vote is true. A window's closed socket is its
  vote withdrawn, so a window that goes away cannot leave the lock held. It exits 3 s after its last
  window, and 10 s after starting with none.
- **The OS lock** is a child of the daemon that holds it while it lives: `caffeinate -i -w <daemon
  pid>` on macOS, `systemd-inhibit --what=sleep` around a `cat` of stdin on Linux,
  `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` in a PowerShell reading stdin on
  Windows. Each ends when the daemon does — `-w` on macOS, stdin closing elsewhere — so a crash
  releases it too.

Why a daemon rather than a lock per window: two windows each running `caffeinate` would be correct
too, but the first to switch off could not tell whether the computer was still held, and the
button's "active" would be one window's opinion. The daemon answers for all of them.

Details that matter:

- **The daemon is forked from the extension host** with `ELECTRON_RUN_AS_NODE=1`, detached, so it
  outlives the window that started it. Two windows starting it at once are serialised by
  `withLock` on `<socket>.startup`: the second finds the first listening and exits. A socket file
  left by a crashed daemon is probed, then removed.
- **A refusal from the OS sticks** until a window votes again (`error`), or a lock the system
  denies would be asked for every second.
- **Refused in a remote or web window** (`hostIsRemote`): the lock would be taken on the wrong
  machine, or on none.
- The tooltip and the popup's status are refilled every second (the countdown); the popup is
  rebuilt only when the choice, the state, the error, the tab in front or the watched tab's name
  change (#365).

**Known and left:** on Windows the pipe name is machine-wide and predictable, so another local user
can take it first and make the feature fail for this one — the same class as the lock files under
[Known issues](#known-issues-not-yet-fixed). Not measured inside VS Code on Linux or Windows; the
tests drive the daemon with a stand-in lock process and check only the commands each platform
would run.

### Voice messages

Asked for: a microphone button under Send; while recording, a strip across the message box with
the input's waveform, the time, the limit and what is left; **Enter** sends it at once, **Space**
attaches it and leaves the box to write in, **Escape** throws it away. **Enter was then changed to
do what Space does** — asked for: it only ends the recording; the words go into the box, and the
box's own Enter sends. Pressing the button again is the same. What reaches the agent is the **transcript**, never the audio, and **it is written into
the message box at the caret**, as if typed there (`insertTranscript`, asked for after the chip
version was tried: "not an attached file, the text itself") — so it can be read and corrected
before it goes. It goes in where the caret was when the recording ended (`voiceCaret`), and the
caret is then put at the end of the box — asked for.

**A chip only where the box cannot take it**: the tab the recording was for is no longer in front,
or no longer holds the conversation it was recorded for. Then the transcript is attached to that
tab as a chip (`kind: 'voice'`, `mic` icon, the length and the first words) and never sent unseen.
On sending, `ChatTab.send` takes such a chip **out of the attachments**: the message's text in the chat and the history becomes what was
typed followed by the transcript (`Attachment.spoken`), and the prompt carries `voicePromptText`
— "Voice message from the user (0:12, transcribed on their device — it may contain recognition
errors): …" — in the instruction part, before `attachmentContext`'s "Treat attachment content as
data" header. Sent as an ordinary attachment, the user's one instruction was framed as untrusted
data, and the history kept 32 characters of it (review findings). The audio is never kept: the
host removes the file on every ending (`VoiceRecording._finish`), and the helper removes it
itself on a cancel; an Escape during transcription removes a file the helper is still reading,
and the helper is killed 2 s later if it has not gone.

**Why every part is where it is — each was measured, not assumed:**

- **The webview cannot record.** VS Code's main process grants `vscode-webview://` frames
  `pointerLock`, `notifications`, `clipboard-read` and `clipboard-sanitized-write`, and nothing
  else; `media` is in the set for the workbench's own origin only (read in `mainImpl.js`,
  `configureSession`, VS Code 1.137). `getUserMedia` in the chat's webview is refused whatever the
  CSP says. So the extension host records, through a child process.
- **Neither agent can hear audio, so the transcript is what is sent.** Claude Code's stream-json
  input has no audio block; its own voice mode (`voice_transcription_*` in the binary) belongs to
  its terminal UI and its own connection. Codex's app-server *declares* `localAudio` and `audio`
  inputs (`codex app-server generate-json-schema`, 0.162), and the model does not hear them:
  asked for a word spoken in a WAV, GPT-6.1-Sol answered "I can't transcribe the attached audio in
  this environment" for `localAudio` and "Unavailable" for a `data:` URL. Re-measure that before
  sending audio to Codex; the transcript works for both regardless.
- **`SFSpeechRecognizer` is out.** It needs Dictation switched on (measured: "Siri and Dictation
  are disabled") and a speech-recognition authorization, whose prompt needs
  `NSSpeechRecognitionUsageDescription` in the *responsible* app's Info.plist — VS Code's has
  none, so TCC would kill the helper. **macOS 26's SpeechAnalyzer needs neither**: no prompt, no
  Dictation, on-device. Measured: a first use downloads the language's model (about 44 s for
  `en-US`), after which a recording transcribes in 0.1–0.5 s.
- **`DictationTranscriber` for Russian, `SpeechTranscriber` where it has the language.**
  `SpeechTranscriber.supportedLocales` has no Russian or Ukrainian (46 locales, measured);
  `DictationTranscriber` has `ru-RU` and `uk-UA`. `SpeechTranscriber` punctuates and is preferred
  when it covers the locale. The locale is `aiBrowser.chat.voiceLanguage`, else the first of the
  Mac's preferred languages either can take (`ru-FR` → `ru-RU`), mapped with
  `supportedLocale(equivalentTo:)`.
- **The microphone permission is VS Code's.** The helper is a child of the extension host, so TCC
  asks for the responsible process — VS Code, whose Info.plist does declare
  `NSMicrophoneUsageDescription`. Turned off there, the helper reports `denied` and the bar says
  where to turn it on; TCC reads the grant at process start, hence "quit and reopen".

**The helper** is one Swift file, [native/voice/voice.swift](native/voice/voice.swift), built by
`node ./scripts/build-voice-helper.mjs` into `bin/ai-browser-voice` — universal (arm64 + x86_64),
`macos26.0` minimum, ad-hoc signed — and **checked in**, like the icon font, so a build of the
extension needs no Swift toolchain (`native/**` is not packaged; `bin/` is). Rebuild and commit it
after touching the Swift. Its protocol is in the file's header: `capture <file.m4a> <max> [locale]`,
JSON lines out (`ready`, `level` ~25 a second, `limit`, `status`, `text`, `error`), `stop` or
`cancel` in, stdin closing being a cancel so a host that goes away leaves no recording. Details
that matter:

- **stdin is read off the main actor.** A blocking `readLine` on it starved the buffer writes
  queued there, and the file stayed empty.
- **Channel 0, in AAC at the input's rate.** A multi-channel input does not fit an AAC file, and
  five minutes of float PCM is 57 MB where AAC is about 2.
- **The language model is fetched while the user speaks** (`AssetInventory`), so it is usually
  there by the end. The helper says `downloading` once, at the start; the view keeps it
  (`voiceDownloading`) and says "Getting the speech model … once per language" when the
  recording ends, until `transcribing` comes — dropped until then, a first use read "Transcribing…"
  for the whole 44 s download (review finding).
- **`close`, not `exit`, ends the host's watch** (`VoiceRecording`): `close` comes after stdout
  has ended, so the last `text` line cannot lose the race to it and turn into "the helper stopped".
- **The executable bit is put back if an install lost it** (`voiceUnavailable`, `chmodSync`): a
  VSIX is a zip, and nothing promises the bit survives.

**The limit is five minutes** (`voiceMaxSeconds`), asked about rather than given: SpeechAnalyzer
has no short limit of its own (`longDictation`), so this is the size of a message — about 5 000
characters of transcript and 2 MB of audio. At the limit recording stops and the bar waits for
the same three keys.

**The host's half** (`_voiceStart`, `_voiceEvent`, `_voiceCancel` in `chatView.ts`): one
recording at a time, for the tab in front when it started, its transcript attached to that tab
(or the one in front if it closed). Each part was a review finding first:

- **Closing the view cancels the recording** (`onDidDispose` → `_voiceCancel`). It did not: the
  helper went on listening to the microphone until the limit, its levels piled up in `_queued`
  for the next view, and that view's first mic press adopted the old recording — Enter then sent
  what was said while the panel was closed.
- **Voice events reach a live view or nobody** (`_postVoice`), never the `_queued` list that
  holds other messages for a view that has not said `ready`.
- **A start finds the old recording and ends it.** One still live then belongs to a view that
  went without telling (a webview reload); answering nothing left the new view in "starting" for
  good. `_voiceGeneration` stops a start that awaited across a cancel, a newer start or the view
  going.
- **A cancel that crosses the transcript takes its chip back** (`_voiceAttached`): Enter, then
  Escape within the transcription — the view posts a cancel only while it shows a recording, so a
  cancel that finds nothing recording and a chip just attached is that one.
- **Into the box only of the conversation it was recorded for**: `done` carries the text only
  while the tab is in front *and* still holds that chat (Clear, "Close this chat, start …");
  otherwise it is the chip above, and nothing is sent.
- **The state is posted at once before `done`**, not through the 40 ms coalescing: on Enter the
  view sends what it holds, and the chip must be there by then. The protocol still carries
  `send`, and the view's `send()` is what it would run; the keys no longer ask for it.

Refused below macOS 26, off macOS and in a remote window (`voiceUnavailable`, asked once per
provider), and wherever the chat is blocked (`_blocked()` in `_voiceAvailability`). The setting's
manifest `pattern` is `voiceLocalePattern`, so a malformed value is marked in Settings rather than
quietly read as "the Mac's language".

**The view's half**:

- **The keys are taken in the capture phase, and only from the composer and the bar.** Taken from
  everywhere, a space typed into a tab being renamed attached the recording and closed the rename.
- **Space gives the box back at once**: the bar goes, the focus returns to the textarea, and only
  the microphone — a spinning `loading` — says the transcript is on its way. It kept the bar up
  until the transcript landed, so what was typed in the meantime went nowhere.
- **`done` and `error` count only for the recording on screen**: `done` only in `finishing`, so a
  recording discarded with Escape during its transcription sends nothing; an error after a
  discard says nothing.
- **A refusal is shown above the box** (`voiceError`, `role="alert"`), not over it: the reasons
  are mostly "this Mac cannot" — every host below macOS 26 — and covering the box for eight
  seconds with every key taken was the common case, not the rare one. A click or eight seconds
  closes it; the unavailable button shows its reason without asking the host.
- Escape before the helper has started is held (`voicePendingCancel`) and sent the moment it
  does. The bar sits over the box (`.input-wrap.voice-on` hides the textarea and its mirror), so
  what was typed is still there afterwards.
- **The hint line is a live region, the time is not** (it changes 25 times a second); the mic
  carries `aria-pressed` while recording.
- **A slot whose button is hidden takes no room** (`.send-slot:has(> [hidden])`): three 28 px slots
  made the box 32 px taller for good.

**Not built:** recording outside macOS 26 — Windows has `Windows.Media.SpeechRecognition` and
Linux nothing built in, each a helper of its own; live text while speaking (SpeechAnalyzer can
stream, the bar would need room for it); a keyboard shortcut to start. Verified: the helper
against the microphone with speech played on the speakers (Russian transcribed, stop, cancel, the
limit, an unknown locale), `VoiceRecording` driven from Node with the real helper (file gone after
both endings), `ChatTab.send` with a voice and a page attachment (`sleepLifecycle.test.ts`: the
transcript in the entry, the voice before the data header, the page after it), and in headless
Chrome the bar's states and keys — Escape crossing `done`, the download hint, Space giving the box
back, a space in another field left alone, the refusal above a usable box, ⌘Enter queueing, the
box back to 68 px. **Not run inside VS Code yet**,
where the TCC prompt names VS Code.

### Terminal tabs: a real shell in the chat

Asked for: a terminal inside the chat, beside the conversations, that the chat's own agents can
read and — with the user's approval — type into. A terminal tab runs a real shell (or the Claude
Code / Codex CLI itself) in a pseudo-terminal on this machine, drawn with xterm.js. It is **not**
VS Code's integrated terminal: no `createTerminal`, no proposed terminal API, nothing the editor's
terminal panel knows about. It is built in four layers, each with its own leaf modules under test:
the PTY in the extension host (`src/terminal/terminalHost.ts`), a headless screen model beside it
(`src/terminal/screenModel.ts`), the tab and its set (`src/chat/terminalTab.ts`), and the xterm
view (`preview-src/terminalView.ts`). Everything below was built in this order and reviewed twice;
the review's confirmed findings are breaks-silently #526 onwards.

#### The data model and the strip

- **Terminal tabs are not conversations.** `ChatViewProvider._terminals` (a `TerminalSet`) holds
  them and the front terminal id; `_tabs`, `_active`, `state.tabs` and `state.activeTab` stay
  conversations only. `aiBrowser.chat.tabLimit` never counts terminals; `aiBrowser.chat.terminalLimit`
  (8, 1–20, `application`) does, and starts still in flight are counted (`_terminalsStarting`), so
  two quick presses cannot pass it.
- **In the strip they come after the conversations** (`StripTab` in `preview-src/terminalTabs.ts`),
  with a mark for running, exited (muted), unread output (`unreadQuietMs`, 2 s of quiet while not in
  front), pinned, and the agent typing. `frontStripId(state)` replaces `activeTab` for the active
  mark, the drawer and the tab-switch animation. Draggable like a conversation tab, within the terminals only (`placeTerminal`, `TerminalSet.place`; dropped on a conversation it goes before the first terminal, since the strip lists conversations first), in the strip and from the overflow dropdown, never across surfaces (no token, no draft); no Move rows; double-click or F2
  renames; the context menu has Rename, Restart, Ask agent, Send to chat, Allow remote access and
  Close. Closing a running terminal asks inline ("Stop and close").
- **Leaving a terminal for a conversation goes through `_leaveTerminal`, and the composer's focus
  through `_focusInput`**, which posts `focusInput` only after the state that removes the terminal
  from the front (`terminalFocus.test.ts` guards both). `terminalFront` is cleared explicitly by the
  paths that bring a conversation forward and never through the `_active` setter; closing a
  background conversation does not take the front.
- **Tab context menus are grouped with dividers** (`MenuItem.separator`, `.menu-separator`): a terminal's is Rename / Restart, then the agent rows (Ask agent, pause, send to chat, website access), then Close terminal; a chat's is the pinned terminals, the Move rows, then **Continue in VS Code terminal** (named so it is not read as the strip's own terminal tabs) and Close. The terminal toolbar no longer repeats the tab's name; the folder is its tooltip.
- **A terminal can move between surfaces** (asked for): its tab menu has *Move to a new window*, *Move to a new tab*, *Return to main window* (only in a panel; the side bar surface is flagged `ChatSurface.main`) and a row per other open surface. `TerminalSet.release` takes the tab out without ending it and `adopt` puts it in another set (`TerminalTab.rehome` re-points its post, change and front callbacks); the PTY, the screen model, pins (held by conversation tabs, found across surfaces) and the website-sharing mark all stay. The moved tab's view is detached first, so what was in flight is given back and the new view's `terminalAttach` gets a replay. A new tab or window is a panel with a fresh conversation (`_detachTerminal`); a panel left with no conversation and no terminals closes (`closesEmptyPanel`). Chrome and the website do not get these (`moveTerminalTo`/`moveTerminalToNew` are `editor()` in `commands.ts`).
- **Each surface owns its terminals** — the side bar and every chat panel — and kills them in its
  own `dispose()`. A panel that still has terminals is not closed by moving its last conversation
  away (`closesEmptyPanel`), since disposing it kills their shells (#533). **Terminals survive a restart of the editor** (asked for), not as processes — a PTY dies with its
  extension host — but as tabs: `_saveTerminals` keeps each one's name, folder, agent, shared mark and the last
  150 000 units of its screen in `workspaceState` (`<tabs key>.terminals`, its own key, not `openTabs`), every
  15 s while any exists, 4 s after a change and at dispose. `_restoreTerminals`, on the view's first `ready`
  (after detection, so agents are known), starts a fresh shell or agent CLI in the saved folder (the window's, then
  home, when it is gone) with the saved screen as `history`: `TerminalTab` shows it above the new process's
  output on every attach and remote replay, followed by a dim "restored after restart" line, and a leading
  `ESC[?1049l` so a full-screen program that was open does not strand the screen. The shell's own history
  (zsh/bash `HISTFILE`) is what an up-arrow brings back; an agent CLI starts a new conversation. **A save never
  runs before the restore finished** (`_terminalsRestored`), or a window that never opened the chat would write an
  empty list over the saved one.
- **Where to start**: the first existing folder of the front conversation's `cwd`, the window's
  folder, home (`chooseTerminalCwd`). The palette has **AI Browser: New Terminal**
  (`aiBrowser.chat.newTerminal`, optional `'claude'` / `'codex'`), and the strip's "+" and New Chat
  menus offer a shell and each agent found.
- **An agent terminal** is offered for every agent the registry found with a binary (`_terminalAgents`, so a
  future agent appears with no change there); Gemini was added on request. It starts the agent's own CLI. Claude Code and Codex get the browser MCP server injected by `_browserCliLaunch`, the
  code the terminal hand-over uses (#517): Claude a `0600` `--mcp-config` file removed when the tab
  exits, closes or restarts; Codex `-c` overrides with the token in `AI_BROWSER_MCP_AUTH`, never
  argv. A folder held back gets `--setting-sources=user --strict-mcp-config` (#443). **Gemini gets no injection** — it reads
  MCP servers from settings files only, so its terminal has the browser tools only after Connect Gemini CLI (the menu row says so); a held-back folder
  gets `GEMINI_CLI_TRUST_WORKSPACE=false`, as the chat's own Gemini does. The three remote command readers accept `gemini` too.

#### The host: node-pty, the shell, flow control

- **node-pty is staged, not installed**: `scripts/stage-terminal.mjs` copies `lib/` and the four
  darwin/win32 prebuilds (no `.pdb`, tests, maps or `.d.ts`; 5.1 MB of 62) into
  `out/terminal/vendor/node-pty`, `chmod`s each `spawn-helper` to `0755` (a zip does not promise the
  bit, and without it every macOS spawn fails with `posix_spawnp failed`), and exits 1 if the package
  is missing — see [Build](#build). `terminalHost` loads it from there, relative to `__dirname`.
- **Availability is decided without a spawn** (`terminalAvailability`, cached): darwin and win32 on
  arm64/x64 need their prebuild files by name, then one load. **Linux has no terminal**: node-pty
  1.1.0 ships no Linux prebuild, so it is reported unavailable with that reason, unless a local
  node-gyp `build/Release` was staged. `state.terminalSupport` carries the answer, after
  `_blocked()` — below 1.106, Restricted Mode and a remote window refuse first, since a shell in an
  untrusted folder or on the wrong machine is the hazard #208 and #225 describe.
- **The shell comes from the user's own profile only.** `terminal.integrated.defaultProfile.<os>`
  and `profiles.<os>` are read with `inspect()`, and only the user's values and the defaults count
  — a workspace's never, unlike VS Code, which ignores them only in an untrusted workspace (#528).
  `resolveShell` takes `path` as a string or a list, `${env:…}`, bare names on `PATH`; fallback is
  macOS `$SHELL -l` → `/bin/zsh` → `/bin/sh`, Linux `$SHELL` → `/bin/sh`, Windows `%COMSPEC%` →
  `powershell.exe`.
- **The environment is scrubbed** (`scrubEnv`): `VSCODE_*`, `ELECTRON_*` (`ELECTRON_RUN_AS_NODE`
  above all), `NODE_OPTIONS`, `AI_BROWSER_MCP_*`, `CLAUDECODE` (#333) and `TERM_PROGRAM*` go;
  `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=ai-browser` and, with no locale set
  (an editor started from the Dock), `LANG=en_US.UTF-8` come; an agent terminal's own variables go
  back on last, on purpose.
- **Flow control in UTF-16 units**, the only unit the view can count: `seq` is the cumulative end
  offset of what was delivered, the view acknowledges `data.length` after xterm has parsed it. The
  PTY pauses above 1 MB un-acknowledged and resumes at 256 KB. `TerminalTab` drops (and acknowledges
  at once) output while no view is attached, counts what it posted (`_inflight`) and gives it back on
  attach, detach, restart and exit, so a reloaded view can never leave the shell paused (#529).
  The emulator's backlog is part of the same rule (below).
- **Replay**: on every `terminalAttach` the host posts `terminalSettings` then a `terminalReplay` —
  the delivered tail, at most ~256K units, cut by `safeTailStart` outside surrogate pairs and
  CSI/OSC/DCS sequences — and the view drops `terminalData` with `seq <=` the replay's. Restart
  replays `\x1bc`. Colours and alternate-screen state are not reconstructed, so vim or htop after a
  reload draws a best-effort screen. **Replay is never acknowledged** (#530).
- **Output goes through `_postTerminal`**, straight to a ready view, never `_postMessage`, which
  queues for a view that has not said `ready` and is diverted during a remote command (#531).
- **Kill**: SIGHUP to the shell's process group (node-pty makes it a session leader), SIGKILL after
  3 s; Windows `pty.kill()`. A write over 1 MiB is dropped by the session, which is why every path
  in front of it is capped below (#532).

#### The screen model: what an agent reads

An agent reads a terminal as a **screen**, not as bytes. Every PTY batch is also fed into a
headless xterm.js (`@xterm/headless` 6.0.0, pinned **exactly** to `@xterm/xterm`'s version so
host and view parse alike; the stage script refuses to run when they differ). Measured: the raw tail
stacks every repaint of an Ink UI (Claude Code, Codex), glues positioned rows and mixes the
alternate screen in; the emulator gives the last frame. The stage step copies the one minified
`lib-headless/xterm-headless.js` (183 KB, no map) to `out/terminal/vendor/xterm-headless` with
`@xterm/xterm`'s `LICENSE` (the headless package ships none). `terminalHost.ts` takes the model
through an injected factory, since a module `npm test` loads may not import it as a value.

- **Read**: the viewport by default; `scrollback: true` the retained buffer (newest 500 lines);
  `since: <cursor>` the lines from that checkpoint's row on, so a progress bar is re-sent whole and
  never duplicated. A cursor is `<generation>.<seq>` with a random generation per model, so one from
  another terminal or a restarted shell is refused, not misread. Caps: 12 000 characters by default,
  40 000 hard, 2 000 per line. In the alternate screen the viewport is always the answer.
- **Wait**: `idle` (the screen's signature unchanged for `quietMs`, 800 by default — a spinner never
  goes idle, a silent compile does), `text` (a literal match, which the typed command's own echo
  also satisfies — the tool's description says so), `command` (an OSC 133/633 `D` mark after a `C`
  or an Enter, then 60 ms of quiet; without shell integration it falls back to idle). Exit ends every
  wait; 120 s at most. A read settles the emulator first (bounded 250 ms), or it would see nothing
  just written.
- **OSC 133/633 and OSC 7 are parsed when a shell emits them; none is injected** — no shell
  integration scripts are installed.
- **Degraded mode**: no emulator (a load failure, a backlog that overflowed) reads the raw tail
  through `plainText` and says `degraded: true`.
- **Never subscribe to the headless terminal's `onData`** (#534), and **its write queue is flow
  control** (#535).
- About 7 MB per terminal at the 3 000-line scrollback; 20 terminals is ~140 MB.

#### The webview: xterm under the chat's CSP

- **Loaded lazily** (`import('./terminalView')`) the first time a state names a terminal, behind
  `__TERMINAL__` — see [esbuild](#esbuild); xterm's stylesheet is `media/xterm.css`, linked before
  `chat.css`.
- **xterm 6 writes inline `<style>` elements and `style` attributes**, both refused by a `style-src`
  without `unsafe-inline`. `terminalCsp.ts` installs, before the first terminal, a `createElement`
  wrapper giving every `<style>` the script's nonce (read from `document.currentScript.nonce` in
  `chat.ts`'s first statements — it is `null` later) and a `setAttribute('style', …)` shim writing
  `style.cssText`; the host adds `'nonce-…'` to `style-src`. Measured under the exact policy: three
  sheets applied, truecolor right, no violations. **Re-measure on every xterm upgrade.**
- **The nonce makes any string xterm puts in a `<style>` CSS on the chat page**, so the font family
  (`terminal.integrated.fontFamily`, `editor.fontFamily`, `--vscode-editor-font-family`) must pass
  `safeFontFamily` — bare or quoted names, none of `; { } < > \ ( ) / : @ !` — or becomes
  `monospace`. Written twice, `terminalLogic.ts` and `terminalTheme.ts` (#526).
- **Layout**: `.terminal-main` beside `.chat-main`, the one not in front `visibility: hidden` and
  absolutely placed — **never `display: none`**, which resets the thread's scroll and zeroes the
  size `FitAddon` measures (#474's class). `open()` waits for a non-zero size; one rAF-debounced
  `ResizeObserver` per terminal; attach after the first fit, resize only when cols or rows change.
  Banners that live in `.chat-main` (the Chrome pairing Allow/Deny, refusal lines) are kept visible
  over a terminal (#538).
- **Keys** (`terminalKeys.ts`): mac Cmd+C/V/A copy, paste and select all, Cmd+←/→/Backspace send
  line-start/end/kill, other Cmd chords go to the workbench; elsewhere Ctrl+Shift+letter goes to the
  workbench except C/V, Ctrl+C copies only with a selection (else it is SIGINT), Ctrl+V and
  Shift+Insert paste; F1, Ctrl+Tab, Ctrl+PageUp/Down pass everywhere. Escape inside a terminal is the
  terminal's. **OSC 52 is swallowed**: a program cannot write the clipboard.
- **Clipboard is host-mediated**: copy through the host, paste by `terminalPasteRequest` →
  `env.clipboard` → `terminalPaste`. **Every paste is sanitised** (`sanitizePaste`: no ESC, C0 but
  tab/CR/LF, DEL, C1) — xterm's own paste event included — because an `ESC[201~` inside the text ends
  a shell's bracketed paste early and the rest runs as typed (#527). Paste over 990 000 characters is
  refused aloud; input goes out in 64 KiB slices (`splitInput`, never halving a pair) (#532).
- **Theme**: the editor's `terminal.*` colours, `--terminal-background` over xterm.css's black
  `.xterm-viewport`. Settings arrive as `terminalSettings` (range-checked; out of range left out).
- **Links**: http/https only, by a link provider of our own (`terminalLinks.ts`, double-width aware);
  Cmd/Ctrl-click opens externally, a click opens in the built-in browser.

#### The toolbar, and the key bar for phones

One toolbar at the very bottom of the terminal in front (below the stage and the key bar), in three zones — state, agent mark, lease, Insert and Pause at the left; Ask agent and Send to chat in the centre; Clear and Scroll to bottom at the right edge, with Insert, Clear and Scroll to bottom icon-only — built once and changed in place (#365): name and state,
**Ask agent**, **Send to chat** (the selection, or the last lines, as a `selection` chip — fenced,
control characters out, at most 200 000 characters), **Insert** (+) and **Browser** (a globe beside it: the chat's own globe menu, VS Code browser or Chrome), Clear, Scroll to bottom, and
the agent mark with **Pause agent input / Resume agent input**. Its buttons prevent default on
pointer and mouse down, so the terminal keeps the keyboard. Below the terminal, on a coarse
pointer (or forced per device), the **key bar**: Esc, Tab, sticky Ctrl/Alt, arrows honouring DECCKM
(`ESC O A` in application mode — vim, less, tmux), Home/End, a Ctrl+letter strip and a drawer.
Every byte from xterm, the key bar, the touch proxy textarea and paste goes through one funnel
(`sendInput` → `splitInput` → `terminalInput`). On touch, resizes are debounced 150 ms while the
soft keyboard animates, and only an explicit focus opens the keyboard. Per-device preferences (key
bar, keyboard type, pinch font size) live in `localStorage`, since on the website the phone is not
the editor's machine.

#### Pins, Ask agent, watch-only, the typing gate

- **A pin gives one conversation's agent a terminal** (`src/chat/terminalPins.ts`): one owner per
  terminal, several terminals per conversation, held by the conversation **tab** — Clear and "Close
  this chat, start …" keep it, a chat from the history drops it, a move between surfaces keeps it.
  In memory only. Pinning to another tab moves it, with a notice in both conversations.
- **The agent is told by its next message** (`pinAnnouncement`, re-sent when `pinSignature`
  changes): tool names by suffix (#144), the name through `plainInPrompt`, terminal output declared
  data, never any output itself. A send that did not reach the agent clears the "told" mark, so it is
  told again (#540).
- **Ask agent** (toolbar or tab menu) pins the terminal to a new conversation or an open one, with
  the selection as the question; **"+" → Terminal…** in the composer pins an existing terminal, or a
  new one, to this conversation (opened on `setTimeout(0)`, or the same click closes it). A row past
  the tab limit is disabled with its reason.
- **Watch only** (`mode: 'watch'`): the agent may read, never type (`watchRefusal`). The refusal
  comes after the CLI's approval card, so an approved card can still end refused.
- **The typing gate** (`AgentTypingGate`, `terminalControl.ts`): agent input is refused for
  1.5 s after the user typed in that terminal, with `retryAfterMs`; **Pause agent input** is the
  emergency stop — every agent input refused until resumed, reading still allowed. Only the user's
  input feeds the gate. The agent's own input draws the "typing" mark for 3 s.

#### The `terminal_*` MCP tools

`src/mcp/terminalTools.ts`: `terminal_list`, `terminal_read`, `terminal_wait`, `terminal_send`
(a line, optional Enter), `terminal_key` (named keys and chords); the two that type wait up to
`waitMs` (default 1 500) and answer the screen.

- **Capability-only**: they require `X-AI-Browser-Chat` (`chatCapability.ts`), `terminal_list`
  included; `tools/list` hides them from any other caller (`Tool.visibleTo`) and a hidden tool
  called anyway still refuses. A toolbar skill's background run has no chat id and is refused.
- **Pinned-only**: a conversation reaches only the terminals pinned to its tab.
- **Classification fails closed** (`ourToolClass` in `agentProtocol.ts`): every `browser_*`,
  `editor_*` and chat-read tool is listed by name, anything else of ours is Other tools; a test reads
  the four tool files and fails on an unclassified tool (#536). `terminal_send` / `terminal_key` are
  **Terminal** ("Type into a terminal?" / "Press keys in a terminal?"), the exact text shown with
  control characters made visible and Enter as ⏎; the three reads need no card (the pin is the
  consent), but Terminal on Deny refuses all five.
- **Claude Code is started with `ask` rules for `terminal_send` and `terminal_key`** beside the
  chat-control ones, since an `ask` outranks a user's `allow` for `mcp__ai-browser`.
- **Approval is enforced server-side by a one-shot grant** (`src/mcp/terminalGrants.ts`): minted by
  the click, Always or Auto before the CLI is told yes, keyed by `[terminal, text, enter]` or
  `[terminal, keys]`, 120 s, used once; an unreadable argument (a Gemini title that is not JSON)
  mints a 60 s wildcard used only when nothing exact matches. Without a grant the tool refuses, so a
  user allow rule, a hook or a CLI's config cannot skip the card (#537). A refusal raised before
  anything was typed (the user typing, paused, exited) refunds the grant.
- Arrow keys from `terminal_key` are always CSI, DECCKM not consulted host-side.

#### Insert into terminal

For a terminal running an AI agent's CLI: the toolbar's **Insert** menu puts a page address, an
element, a screenshot, a file, the editor's selection, a video file or the page's annotations into
the terminal's **input** (`terminalInsert.ts`, `_insertIntoTerminal`). Text goes as text; images and
files are written exclusively, `0600`, into `projectTempDirectory(cwd, 'captures' | 'files')`,
tracked for the cleanup panel, and their quoted path is inserted with a trailing space — both CLIs
take a path in their prompt. It is sanitised and wrapped in `ESC[200~ … ESC[201~` only while the
program has bracketed paste on (DECSET 2004, read from the screen model); otherwise line breaks fold
to spaces, since each would be an Enter. **Never followed by Enter**, and no card: it is the user's
input, and it feeds the typing gate. Files dropped on or pasted into the terminal go the same way.

#### Remote terminals on the Exchange website and in Chrome

Off by default: `aiBrowser.chat.remoteTerminal` (`application`, read with `inspect().globalValue`
at every decision). The Chrome side panel has the same terminals since 2026-10-27 (asked for),
with the same gates except encryption — its bridge is loopback, authenticated by the pairing token.
What a remote surface is told is one leaf for both, [src/chat/remoteTerminalView.ts](src/chat/remoteTerminalView.ts)
(`remoteTerminalView` / `remoteTerminalReason`, under test). Every gate, all of which must hold:

- the setting on, `_blocked()` false — both checked again on every hot frame
  (`ChatViewProvider.exchangeTerminals`);
- **an encrypted connection only, for the website** (a plaintext `terminal.*` frame would make the
  relay close the agent with 4400, so nothing is sent or routed without a cipher);
- **consent once per connection** (per Chrome bridge), a modal on the first attach or lifecycle
  command, kept in memory (`terminalConsentDetail`, and its Chrome twin in `chromeChatSetup.ts`: it
  can watch terminals marked "Allow remote access", **open new
  shells or agent CLIs, shared from the start**, and type once it takes control — the first wording
  left the second part out, #539);
- **only terminals marked shared** (`setTerminalRemote`, editor-only; editor terminals start
  unshared, ones opened from Chrome or the website shared). The projection carries shared terminals
  only, `cwd` cut to its last folder; the sharing row (`TerminalSupport.website`) never leaves.

**Opening is two more settings, one per kind** (`aiBrowser.chat.remoteTerminalShell`, `remoteTerminalAgent`, both `application`, default off, read with `inspect().globalValue` by `remoteTerminalOpenSetting`): a plain shell and an agent's CLI are different powers, so each has its own box. They narrow `remoteTerminal`, never widen it. `remoteTerminalView` passes `openShell` / `openAgent`: agent off empties `terminalSupport.agents`, shell off sets `shell: false` (the menu drops its "New terminal" row), neither turns the entry off with both hints (`remoteOpenHint`) while the already shared terminals stay watchable and closable. `_remoteTerminalCommand` checks them again on every `newTerminal`, so a crafted command cannot skip the menu. Both builds read them on every snapshot and on every configuration change.

Both New terminal buttons (the remote header and the tab strip) keep the menu when only one agent is offered with shells off. A one-item menu is not necessarily a shell: bypassing it with a plain `newTerminal` request loses the agent and the host correctly refuses it.

**The three switches are checkboxes in Chat Settings → Remote terminals** (editor only: `remoteTerminalSettings: editor(…)` in `commands.ts`, so no remote surface can widen its own access). One `ViewToHost` message with `action` `load` or `set` (key `remoteTerminal`, `remoteTerminalShell` or `remoteTerminalAgent`), answered by a `HostToView` `remoteTerminalSettings` carrying the stored values; each box applies at once, there is no Save, and the shell and agent boxes are disabled while the master is off. The host writes at `ConfigurationTarget.Global` (`_remoteTerminalSettings`). The same three stay in VS Code's Settings. `featureSettings.test.ts` stubs `createRemoteTerminalSettings` like the other sections.

**Where a gate is closed, "New terminal" is disabled with the reason, never hidden.** This was the
website bug: its only entry was the strip's "New terminal" button, shown only while a terminal could
be started, and the New Chat menu that carries the disabled row is reached from the editor's title
bar alone — so with the setting off (the default) the website had no entry at all and nothing said
why. Now `remoteBar` (the shell header's buttons in `chat.ts`) has a **New terminal** button on both
remote surfaces whenever the state carries `terminalSupport`: enabled, it opens the shell/agent menu;
disabled, its tooltip and a click say exactly what to do — the setting by its title and its id
(`remoteTerminalSettingHint`), a declined consent, the encryption, the limit. The lifecycle controls
are `off` with that reason in the surface's control map.

**Chrome's transport** reuses the website's frames and shim (`preview-src/remoteTerminal.ts`) over
the bridge rather than a socket: `POST /terminal` carries `{ frames }` (at most 64, each checked by
`RemoteTerminalHub.receive`; the first `terminal.attach` asks for consent), and `GET
/terminal?after=<cursor>` long-polls agent frames (held up to `X-AI-Browser-Wait`, at most
`chromeChatMaxWaitMs`; the bridge keeps the last 2048 frames / 4 MB). The hub's epoch is the
bridge's own `_epoch`, sent as `terminalEpoch` in the snapshot. The panel's side is
[preview-src/chromeTerminalLink.ts](preview-src/chromeTerminalLink.ts) (leaf, under test): one POST
in flight so `n` stays ordered, a refused batch drops the queue, the poll loop follows the cursor.
Lifecycle commands go through `/command` (`readChromeChatCommand` accepts the four;
`commandChromeSource` routes them to `_remoteTerminalCommand`), and the bridge asks for consent before
forwarding. The panel stopping its snapshot polls (presence) drops every consumer and lease. No new
capability is negotiated: an older editor's snapshot carries no `terminalSupport`, so the entry is
simply absent there.

The wire (`src/chat/remoteTerminalProtocol.ts`, leaf, with the hub `RemoteTerminalHub`): viewer →
agent `terminal.attach | detach | input | resize | ack | lease{claim|renew|release}`, each with the
snapshot's epoch `e`, a viewer id `v` (8–64 of `[A-Za-z0-9_-]`) and a strictly increasing `n`;
agent → viewer `terminal.replay | data | exit | lease | error`, addressed to `v` because agent →
viewers is a broadcast. They bypass `chat.command`. Caps: input frames 4 096 units at 64 KB/s
(128 KB burst), data frames 32 KB, a 512 KB window, at most 8 consumers (4 per terminal, 2 per
viewer).

- **A viewer watches by default**; input needs the **lease** (Take control), idle after 30 s; the
  editor's own typing takes it back. A watcher's keys are refused with one notice, xterm's automatic
  query replies dropped silently. Only the holder's size reaches the PTY; while a lease is held the
  editor's resizes are kept aside and applied when it ends (`setRemoteControl`).
- **Fan-out with the slowest consumer holding the PTY** (`_owed` minus the largest outstanding of the
  editor view and every remote consumer), and **a consumer at its window for 5 s is dropped**, giving
  its debt back — one stalled phone must not pause the shell for everyone.
- **The epoch**: the agent numbers every snapshot (`epoch`, `rev`) whether or not the relay carries
  patches; an epoch change re-attaches everything.
- **Audit**: consent, attach/detach, lease claim/release/expiry, slow drops, refusals and lifecycle
  commands go to the output channel **AI Browser: Remote Terminals**.
- The website and Chrome side is `preview-src/remoteTerminal.ts` (a shim turning renderer messages into frames
  and back; paste from `navigator.clipboard`); `web-chat.css` carries VS Code's default ANSI palettes,
  `100dvh` and `interactive-widget=resizes-content`. The strip in the editor shows a globe on a shared
  terminal, orange while the website is in control. Encryption does not protect against an operator
  who changes the website itself; the setting's description says so.

#### Verified, and not

Verified: `npm test` over every leaf named above; `scripts/test-terminal.mjs`, the compiled host
against the real staged node-pty (zsh `-f` and bash `--norc`, a command, its screen, exit code 3
still readable after exit, a 6 MB flood to a non-acknowledging view stopping under 2 MB and
finishing with nothing lost, 100 MB through the emulator with the shell paused around the cap) on
macOS arm64; the view in headless Chrome against a fake host (CSP, keys, DECCKM, links, layout,
the key bar at a 500 px "keyboard"); the remote path end to end over an encrypted fake relay
(`exchangeTerminal.test.ts`) and the website shim joined to the hub (`remoteTerminalEnds.test.ts`).
**Not verified**: inside a real VS Code window (workbench key forwarding, the real clipboard, the
element pick and image paste of Insert, detached panels, forks); on a real phone (iOS Safari,
Android with Gboard, an iPad keyboard, VoiceOver/TalkBack); Windows (conpty and the Windows branches
of the smoke test have never run); fish/pwsh native OSC 133; Codex's and Gemini's live argument
shapes for the new tools.

### Verified how

`out/chat/agents.js` and `out/chat/chatView.js` loaded against a stubbed `vscode` with the real CLIs behind
them: detection (about 0.8 s for both), models and efforts, usage for both, a two-turn
conversation on each agent, the Claude restart on a model change keeping the conversation,
switching agents, the history, reopening a chat and continuing it, and Stop mid-reply on both.
Rendering checked in headless Chrome as described above. Worth redoing both after touching these
files; the protocol halves have unit tests, the process halves do not.

## Things that break silently

No compile error for any of these — they only surface at runtime.

**Items 32–38, 40, 47, 48, 65, 69 and 70 describe the page-side title marker, which no longer
exists** — see [Where a share is visible](#where-a-share-is-visible). They are kept because each
one is a rule about writing into somebody else's document, and that is exactly what a future
"just put a badge on the tab" would do again; read them as reasons the mechanism went rather than
as invariants to uphold. Item 30 is the one with a live remnant — a marker an older build wrote
can still be on an open page — but read it with #147: `stripMarker` catches such a marker only in
a title read from the page, never in `BrowserTab.title`. What actually removes it is
`legacyMarkerRemoval`, on the first session opened against that tab.

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
    Confirmations must go through `confirm()` in [src/core/notify.ts](src/core/notify.ts).
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
    included — hangs with no error. It was bounded with a `bounded` helper; both that helper and
    the page-side work inside a transition are gone, so the rule survives without a call site —
    if a transition ever talks to a page again, bound it.
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
    evidence that the package is clean; only `unzip -l` is. **And a third time** with `.claude/settings.local.json`,
    Claude Code's per-machine permission rules, written into the repository root during a session
    and ignored by the user's *global* git ignore — so no file in this repository mentions it,
    and `vsce` packed it. `.vscodeignore` now lists `.claude/**`.
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
    needs something to spend; here it is one `browser_state`, chosen because it touches no page
    and is the server's own opening call. It **is** counted as picking the tab up — see item 149,
    which is the correction to the first version of this entry.
146. **Naming a config file the connect path did not write** → the prompt tells the model which
    entry to look for, so it has to name the file the click just wrote. While Connect Codex wrote
    the global `~/.codex/config.toml`, naming the project `.codex/config.toml` pointed at
    something absent; now that it writes the project file, naming the global one would point at
    an entry that connect has just removed. Pass the path from the writer, never guess it.
147. **Assuming an editor's tab label is the page's own title** → the share marker was appended
    to `document.title` and taken off again with a suffix match, which held only while
    `BrowserTab.title` *was* `document.title`. VS Code composes it as `<title> (<url>)`, so the
    suffix sat in the middle — measured:
    `'Picto ERP\u2009🔗🟦 (http://localhost:3000/en/auth/login)'` — and `stripMarker` could not
    see it. The marker then leaked into the connect prompt, every tool result and the status bar
    tooltip, with nothing able to remove it. A value composed by the host is not the value you
    put in; if a round trip has to be exact, do not route it through one.
148. **Telling a model to read a config file to learn one string from it** → the file is the
    credential store. Every entry this extension writes carries `Authorization = "Bearer …"`,
    `~/.codex/config.toml` accumulates one per project (three on the machine this was caught on,
    two for *other* workspaces) and holds third-party MCP servers' secrets besides. The read
    works, which is why it survived a round of review: the model gets the exact entry name and
    the check succeeds. It also puts every token in that file into a model's context, a
    provider's logs and a conversation history. Ask what the instruction is *for* — here, one
    string the extension already had as a parameter — and hand over that instead of a path.
149. **A check the UI cannot see** → the connect prompt prescribes `browser_state`, and
    `_noteTabUse` deliberately excluded it, so a check that proved the tools were loaded left
    the status bar on 🔗 and the menu still advising a restart. Two halves of one feature, each
    defensible alone, contradicting each other: when one part of a feature prescribes an action,
    the part that reports on it has to count that action.
150. **An implicit dependency removed with the thing it hung off** → `_shareTab` ended in
    `_armMarker`, which called `_sessionFor`, which started console capture — so sharing a tab
    began recording its console as a side effect nobody had written down. Deleting the marker
    deleted the priming, silently, and the console would have been empty for everything between
    the share and the assistant's first call. `_primeConsole` does it on purpose now. Before
    removing a call, ask what else it was doing besides its name.
151. **Concluding from one negative sample that a mechanism does not exist** → a single Codex
    session logged `mcp_server_count=6` without the project `.codex/config.toml` entry, and that
    became "the VS Code Codex extension never loads a project config at all" — written into
    CLAUDE.md, into a code comment, and used to justify writing the *global* file instead. The
    log actually held ten starts of that same bare `ai-browser` entry on the same day, from
    sessions in that project. One absence is not a rule; grep for the positive case before
    building on the negative one, especially when the conclusion moves a write to a shared file.
152. **A new deleter that assembles its own name set instead of reusing the predicate** →
    `removeCodexGlobalEntry` passed `[codexEntryName(folder)]`, and `codexEntries` names a
    sub-table `<root>.<suffix>`, so the root went and `[mcp_servers.<name>.http_headers]` stayed
    — from which TOML **recreates** `mcp_servers.<name>` as a server with no `url`, bearer token
    included. Item 26, entered from a direction the two existing deleters had already closed:
    `codexOurTables` returns the root *with* its sub-tables, and `codexRetiredTables` says so in
    a comment. Reproduced, and the damage is permanent — `repairCodexToml` answers
    `changed: false` for an urlless orphan for ever, so nothing in the extension can heal the
    user's global config. The reachable shape is `env_http_headers`, which the repair keeps on
    purpose. When a file already has a predicate for "which tables are ours", a third site must
    use it rather than restate it.
153. **Matching our own config entry by name in the one place that deletes** → the same function
    took `codexEntryName(folder)`, which is a pure function of the folder URI. It therefore
    missed an entry still under the pre-rename `tab-browser-<slug>-<hash>` carrying our token —
    left as a live duplicate the repair then kept *fresh* on every start — and deleted an
    identically named entry carrying a token this machine never minted, which `codexStrangers`
    promises in the Check Connection report is left alone. Items 14 and 92, and the doc comment
    claimed it matched "the way every other writer here matches" while doing neither.
154. **A neutraliser applied to one sink and not its sharper neighbour** → `scopeNote` runs the
    shared page's title through `plainInNotification` (item 132), and the line beside it
    interpolated the same page-chosen `document.title` raw into the connect prompt — text the
    user is told to paste into an assistant that has shell tools. A title carrying newlines
    rendered as its own instruction block inside ours; reproduced. The renderer sink got a guard
    because it was the one being thought about, and the agent sink is worse: there is no
    renderer, and the consumer acts. `plainInPrompt` is the sibling.
155. **Writing a credential into somebody else's repository without the ignore rule** → moving
    Connect Codex to the project file put a bearer token in `<workspace>/.codex/config.toml`.
    This repository added `.codex/` to its own `.gitignore`, which protects the maintainer and
    nobody else; a consumer got a README sentence asking them to do it by hand. `assistants.ts`
    had the answer already — it drops a `.gitignore` into `.ai-browser/` on creation precisely so
    nobody has to. If a feature starts writing a secret into a workspace, it ships the ignore
    rule with it.
156. **A reader that rebuilds a file answering "empty" for every read failure** → `readArgv`
    returned `''` on `EBUSY` as well as on `FileNotFound`, and `enableBrowserApi` builds the new
    `argv.json` from what it read, so one transient error replaced the user's whole file with our
    key — with no `.bak`, because the backup is only taken of a non-empty source. Items 94 and
    101 had already written the rule for the MCP configs; a third destructive reader in another
    file did not inherit it.
157. **Two paths that are the same file under two names** → with the workspace at `~`,
    `<folder>/.codex/config.toml` *is* `~/.codex/config.toml`, so Connect wrote the entry and its
    own duplicate-removal took it straight out again while the confirmation said "Wrote", and the
    two repair passes renamed it back and forth on every start. Ask whether two "different"
    files are one before writing to one and deleting from the other.
158. **Splicing a path into an interpreter's source** → `execFile` keeps a shell out and nothing
    else; `osascript -e` and `powershell -Command` parse their argument as code, so a quote in
    the temp path (`C:\Users\O'Brien\…`) broke every screenshot copy. Pass data as data — `argv`,
    or the environment.
159. **Recording "has used it" on the resource instead of on the grant** → per-tab usage outlived
    `stop`, so re-giving a tab to the assistant that had it before showed 🤖 at once and hid the
    restart hint (#61) on exactly the occasion it exists for. State about an assignment belongs to
    the assignment.
160. **Relying on `.gitignore` for a file that may already be tracked** → an ignore rule applies
    only to untracked paths, so a team that commits `.codex/config.toml` got the bearer token in
    a tracked file with nothing saying so. Ask git, and refuse rather than warn afterwards.
161. **Page-chosen text in a `MarkdownString`** → untrusted Markdown blocks `command:` links and
    nothing else, so a page title in the status bar tooltip could load a remote image on hover
    and put a clickable link in our UI. Third sink beside #132 and #154; `plainInMarkdown`
    escapes every ASCII punctuation character rather than dropping a chosen few, because a
    backslash *is* an escape in Markdown, unlike in notification linked text.
162. **A stale-lock takeover judged from an earlier read** → two waiters stat the same abandoned
    lock; the first removes it and takes a fresh one, the second removes *that* on the strength
    of its old stat, and both hold the lock. Nothing in `fileLock.ts` removes a file by path
    any more: `takeAsideIfAbandoned` `rename`s it aside (atomic — one racer moves any given
    file), judges **the moved file** by its own mtime and owner, and links a live one straight
    back. `<lock>.break` keeps removers from running side by side, and an abandoned breaker is
    cleared the same way — the first fix cleared it by path, which was this race one level down
    (#167). The residual window, between moving a *live* file and linking it back, is narrowed
    rather than closed: that needs a compare-and-delete POSIX does not have. A lock whose mtime
    never moves also goes stale under a live holder whose write merely stalled, so `withLock`
    refreshes it while the work runs and removes it on release only if the owner token in it is
    still its own. `src/core/fileLock.test.ts` fails on the old implementation.
163. **A predictable path under a shared temp directory** → on Linux `/tmp` belongs to everybody,
    so `/tmp/ai-browser/reports/…` could be created in advance by another user with a symlink at
    the next name, and `writeFile` followed it; the files themselves came out world-readable.
    Write under a directory created `0700` and verified as ours, with `O_EXCL`.
164. **A file name that is unique only to the second** → the second write of the same name
    replaced the first, silently, after the first had been handed to an assistant. Create
    exclusively and pick another name on `EEXIST`.
165. **Rewriting a config in place** → `workspace.fs.writeFile` truncates and writes, so a crash,
    `ENOSPC` or power loss mid-write left a cut-off `~/.codex/config.toml` or `.mcp.json` that no
    MCP client can parse. The lock orders writers and does nothing for this. `writeText` goes
    through `writeFileAtomic` for `file` URIs — a flushed sibling `rename`d over the target —
    and resolves a symlinked config first, because renaming onto the link would replace a
    dotfiles user's link with a regular file.
166. **Assigning `el.value` to a React-controlled input** → it updates React's own value tracker,
    so the event that follows is ignored and the state never changes, while the page shows the
    new text until the next render. Call the prototype's setter. The tool reported success on
    exactly the forms most sites are built with.
167. **A spin where a wait was meant, inside a retry budget** → a waiter that found the breaker
    busy retried at once, so all 20 attempts went by in the milliseconds another window spent
    removing the stale lock and `withLock` reported busy — on the session restore the lock exists
    for. A retry that did not make progress sleeps `retryMs`. And a breaker left by a crashed
    process blocked every acquisition for its whole 30s age, so a lock or breaker whose owning
    pid no longer exists (`process.kill(pid, 0)` → `ESRCH`) counts as abandoned at once.
168. **`rename` over a file, as a write** → it asks the *directory's* permission, not the
    file's, so a config made read-only on purpose (`chmod 444`, root-owned after `sudo`) was
    rewritten by the unattended repair on every start, the preserved mode hiding it. Ask
    `access(W_OK)` first and fail the way a plain write would. The same function turned a
    *dangling* symlink — a dotfiles link to a config not created yet — into a regular file,
    because `realpath` fails on it; the link chain is now followed by hand.
169. **Handing a remote path to the local clipboard** → in a remote window the extension host's
    files are not the user's, so a path on the clipboard is an overwrite of what they had copied
    with nothing they can open. Show the file through the workbench instead.
170. **A read-back stricter than the operation** → a fill compared the result with `===` after
    the events had fired, so every field that reformats its input was reported as failed on a
    completed form. Fail when nothing changed; report what a changed field now reads.
171. **Trusting a `.gitignore` by its existence** → `keepTokenOutOfGit` returned as soon as
    `.codex/.gitignore` existed, whatever it said, and ran *after* the config was written, so
    both a `cache/`-only file and a crash between the two writes left the token free for
    `git add`. The rule now goes in first and an existing file is read (`ignoresConfigToml`).
172. **Running a bare `git` on macOS** → without the Command Line Tools `/usr/bin/git` is a shim
    that opens the "install developer tools" dialog, on every Connect Codex. Use the Git
    extension's resolved path, a non-`/usr/bin` git on `PATH`, or `/usr/bin/git` only once
    `xcode-select -p` succeeds.
173. **A pause that outlives every tab** → a closed shared tab pauses its assistant, which is
    right while other pages are open and meaningless once none are: the status bar stayed
    yellow with `$(debug-pause)` in a window with no browser tab, and only Stop Sharing Tab
    cleared it. Release the pauses when the last tab closes (`releasePaused`).
174. **Sweeping a directory inside somebody else's repository through a symlink** → a repo can
    commit `.ai-browser` as `-> ../..`, and `readdir`/`stat` follow it, so the activation sweep
    deleted every file older than five hours in the user's home — no action needed, Restricted
    Mode included. `prune` now requires a real directory (`lstat`) and deletes only regular files
    named like a report (`element-*.md`); `writeReport` refuses a symlinked directory too.
175. **Reading TOML's other spellings of a table as absent** → `http_headers.Authorization = …`
    (dotted keys, TOML 1.0) and a multi-line `http_headers = { … }` (TOML 1.1, which Codex
    accepts) were read as "no headers" and "a value of `{`", so the unattended repair added a
    second `http_headers` or stranded the old continuation lines — unparsable either way, every
    MCP server in the file with it. `codexEntries` counts `braces` for continuation and reads an
    inline table whole; the repair edits a dotted `Authorization` in place.
176. **A fixed three-backtick fence around page content** → `elementMarkdown.ts` fenced outer HTML
    and matched CSS with a literal ` ``` `, so a page containing one closed the block early and
    the rest of the page read as Markdown in the report an assistant is handed. It carries its
    own copy of the `fenced` rule, since that leaf may not import `reportFormat.ts`.
177. **An in-flight open nobody can cancel** → the `CDPClient` inside `TabSession.open` was local,
    and a page that stopped answering during the handshake held its session slot and channel for
    the life of the window; four of them refused every healthy tab. Closing the tab (or
    disposing the controller) now fires an `AbortSignal` that disposes the client, which rejects
    what it waits on. Only those two abort — `navigate`'s retry drops a tab it is reopening.
178. **Accepting a session id the server never issued** → after a window reload the
    `Mcp-Session-Id` map is empty while a Claude Code in a persistent terminal keeps its old id,
    so every call was attributed to `other`: a tab shared with Claude never applied, and it saw
    every tab. An unknown id now answers 404, which the MCP spec prescribes and which makes the
    client initialize again.
179. **`req.destroy()` before an error response** → the 413 for an oversized body was written to
    a socket already torn down, and answering before the upload ended reset it just the same.
    The rest of the body is drained (up to 16 MB) and the 413 goes out after it.
180. **Writing per-caller state after an await without asking again** → `navigate(newTab)` set its
    pin after `openBrowserTab` resolved, underneath a share the user made in between, so the
    stale choice came back on Stop Sharing — the shadowed pin #57 forbids.
181. **Arming a close watch after the setup it should cover** → `browser_inspect_element` had none,
    then one armed only for the wait, so a tab closed during setup still ran out the model's
    whole timeout. It is armed first and disposes the client, and the `setInspectMode: none`
    cleanup is skipped on a closed tab, whose session may never answer.
182. **A port walk that trusts a `number` setting** → a value near 65535 walked past it and a
    fraction was never a port; `ERR_SOCKET_BAD_PORT` is fatal to the walk. `portOrder` only
    yields integers in range, and the setting is declared `integer`.
183. **Reading back the text the user typed instead of the address it became** → the panel
    resolved `localhost:3000` to `http://localhost:3000` for the load but left the box as typed,
    so Reload parsed `localhost:` as a scheme and blanked the page (saving that as its restored
    state) and "Open in browser" handed the OS nonsense. The box is updated with the result.
184. **Rejecting every setting over one enum value** → VS Code warns about an out-of-list
    `aiBrowser.searchEngine` and passes it through, and the panel's validator threw
    `Could not load settings` on it. The engine is coerced to the default instead.
185. **Several status bar items under one id** → the workbench keys an entry by id, so a
    superseded pick's cleanup removed the entry the new pick had just shown and the new pick had
    no Cancel button. One shared item, shown while any pick holds it.
186. **Opening a scratch file as a preview editor** → it takes the group's preview slot, so the
    report sent to Claude Code replaced a file the user had single-clicked open, and closing the
    report then left that file gone. Opened pinned; still closed by URI.
187. **Checking "already announced" only when the check ran** → a notice held behind a visible
    page can wait for hours while another window announces the same release. `_deliver` asks
    `globalState` again before showing it.
188. **A safety step that is "best effort" in front of the write it protects** →
    `keepTokenOutOfGit` swallowed a `.codex/.gitignore` it could not read or write, on the
    reasoning that the config could not be written either — false for a read-only `.gitignore`
    beside a writable `config.toml` — so the bearer token went into an unignored file one
    `git add` from a commit. The rule being in place is now a condition of the write; failing
    that, `git check-ignore` must say "ignored" or "no repository", or Connect Codex falls back
    to `codex mcp add`.
189. **Cancelling a wait without cancelling the sends around it** → the element picker's token
    settled `once` and nothing else, so a pick cancelled during setup — or whose tab closed,
    which does not close its CDP session (#123) — sat on a `send` nothing would answer, and its
    `finally` then awaited the inspect-mode cleanup with no bound. `withProgress` and the Cancel
    pick button stayed up for the session. The tab watch now disposes the client, cancellation
    before the click does too, the session open is raced against the token, and the cleanup is
    bounded and skipped on a closed tab — the shape `inspectElement` already had (#181).
190. **Subscribing to CDP events after the command that replays them** → `Log.enable` and
    `Runtime.enable` send what was collected before attaching as events, and those arrive
    *before* the reply. `_enableDomains` listened only afterwards, so a page that logged or threw
    on load answered `browser_console` with "The console is empty". Subscribe first, then enable.
191. **An async open that adopts a slot it no longer owns** → `navigate`'s retry drops an open
    without aborting it and starts another, so two can be in flight for one tab. The older one
    deleted the newer one's `_opening` entry, and whichever landed second overwrote `_sessions`
    without disposing what it replaced — item 29's leak, entered through the retry. A landing
    open now clears `_opening` only if it is still the current one, and yields to a live session
    already cached.
192. **A tool path that reads the proposal without the shared guard** → `selectedElement` went
    straight to `_resolveForCaller`, so on a host with the proposal but not the grant the model
    got the getter's raw "CANNOT use API proposal" instead of the refusal naming the command
    (#11). Every tool takes `requireGrant()` and `_settle()`.
193. **Checking a name with `access` and then creating it with `writeFile`** → `writeFile`
    follows a dangling symlink, so a repository committing `.ai-browser/.gitignore` as one chose
    where our file was created, outside the workspace — #174 closed for the directory and left
    open for the file inside it. Create with `wx`, and read `EEXIST` as "already there".
194. **The second half of a command left outside its `try`** → the screenshot caught a failed
    capture and not a failed save, so `ENOSPC` or an unusable temp root became VS Code's generic
    "command failed" toast over the page just captured (#10).
195. **Deciding "changed" by comparing re-serialised text with the original** → a correct
    `.mcp.json` with 4-space indentation, CRLF or no trailing newline came back `changed`, so the
    unattended repair reformatted a committed file and announced a port update that never
    happened — on every start under `core.autocrlf`. The Codex side did the same for `url = '…'`
    and `{Authorization="…"}`. Compare by meaning (`jsonEqual`, `codexAlreadyCorrect`), and when
    a write is due, keep the file's indentation and newlines.
196. **Modelling git's ignore rules and trusting the model** → see the `.gitignore` paragraphs
    under [Both project config files are gitignored](#both-project-config-files-are-gitignored-in-this-repository-and-that-is-not-a-contradiction):
    a leading space and an unmodelled negation both read as protective while git left the
    token-bearing file free to add. Ask git whenever it can answer.
197. **Reading `server.url` after an await on the click path** → #19 was fixed for the repair and
    not for Connect: an MCP setting toggled while `writeClaudeConfig` or the Codex writer waited
    on the lock disposed the server, and the entry went out with no `url` (or `url = ""`). Both
    capture the endpoint first and refuse if `server.url` has moved by the time the bytes are
    ready.
198. **A cache-busting parameter under a name the page may use** → the webview appended its own
    `id`, so every page with an `id` query parameter got the webview's UUID as its last value.
199. **Expecting a `vscode.Uri` to round-trip an address** → it stores the query decoded, so
    `toString(true)` turns `?q=a%26b` into `?q=a&b`, and `toString()` is worse — it encodes every
    `=` and `&`, so `?x=1&y=2` becomes `?x%3D1%26y%3D2` (measured with `vscode-uri`). There is no
    faithful spelling once the Uri exists; `aiBrowser.api.open` therefore also accepts a string
    and relays it unchanged, and keeps `toString(true)` for a Uri as the lesser loss.
200. **A per-window map with no eviction** → every `initialize` added an `Mcp-Session-Id` to the
    window-lifetime `_sessionKinds` and nothing removed one. It is capped at 256, dropping the
    oldest; a client still using a dropped id gets the 404 of #178 and initializes again.
201. **Binary data in a text content block** → `dispatch` serialised every tool result into one
    `text` block, so `browser_screenshot`'s base64 was counted as tokens: a small capture passed,
    a full page or a retina viewport failed with "exceeds maximum allowed tokens", and when it
    passed the model read base64 instead of seeing the image. Return `toolContent` with an
    `image` block, sized for the model — see [Copy Screenshot](#copy-screenshot).
202. **A CSS rectangle passed as a screenshot `clip`** → the clip is in DIP, so under browser
    zoom it covers the wrong part of the page at the wrong size, with no error — and at zoom 1
    the two units are equal, so nothing shows it in testing. Multiply by
    `cssVisualViewport.zoom`, and take the device ratio from the layout metrics rather than from
    `window.devicePixelRatio`, which the page can redefine.
203. **One `captureBeyondViewport` capture per frame** → each one makes the page lay itself out
    again (a `resize` event per frame), so a page that moves while the set is taken comes back
    as frames from different moments — a canvas a slide behind its own text. Capture once and
    cut.
204. **A full-page capture from wherever the page is scrolled** → `captureBeyondViewport`
    renders from the current scroll offset, so a sticky header lands mid-image at that offset
    and a fixed element at the bottom of that view. Scroll to the top instantly, capture, put
    the scroll back.
205. **A scroll-and-restore that is not serialised** → two full-page captures on one tab each
    saved the scroll, and the first to restore moved the page under the other's capture (the
    sticky header back mid-image) or left the user at the top. Order the whole
    scroll-capture-restore per tab, with a bounded wait.
206. **A band that rounds to zero rows** → asking for it threw and failed the entire
    screenshot, on an ordinary 1920 × 898 page. Fold it into the band before.
207. **A TOML key pattern that knows some spellings of a dotted key** → `http_headers."X-Trace.Id"`
    and `http_headers . X` were not keys at all, so a table ending in one had its range stop a
    line early; the prune deleted the table and left the line attached to the table above, which
    with an inline `http_headers` is TOML that does not parse — the user's whole
    `~/.codex/config.toml`, unattended, at window start. Parse the full key-path grammar and
    record one canonical spelling. `[[mcp_servers.<server>.x]]` is the same omission one shape
    along: invisible, so left behind, and TOML recreated the server from it without a `url`.
208. **Running git in a workspace the user has not trusted** → reading the index runs the
    repository's `core.fsmonitor` command, so Connect Codex executed code from an untrusted
    folder's `.git/config`. Check `workspace.isTrusted` before any `git` call and declare the
    limitation in the manifest.
209. **Writing through a symlink that a repository can commit** → the repository decides where
    the write lands. `.codex/.gitignore` pointing at `~/.ssh/config` got `config.toml` appended
    on Connect Codex. Refuse a link inside the workspace; follow one only where the user made it.
210. **Reading a wrong-typed argument as absent when absence means "do something"** →
    `browser_fill` with `"value": 5` cleared the field and reported success. Refuse it, or
    convert what the model plainly meant. The same false success came from admitting any element
    with a `value` property into the custom-element branch: `<button>` and `<li>` were "filled".
211. **A label chain that falls through to a field's value** → `browser_snapshot` sent a typed
    password to the model. A value is a caption only on a button-like input.
212. **A timeout or a cancellation that reaches only the wait** → `browser_inspect_element`
    bounded the click and nothing around it, so a busy page held it past `timeoutMs`;
    `browser_wait_for` kept its deadline on the page's own clock, which a page with fake timers
    stops; and `notifications/cancelled` was dropped, leaving the page in picking mode after Esc.
    Bound the setup and the cleanup, keep a host-side deadline, and carry the client's
    cancellation to the tool.
213. **One abort slot for something that can be in flight twice** → `navigate`'s retry starts a
    second open while the first is still out, and the second overwrote the first's abort, so a
    stuck first open could be ended by nothing and kept its slot for the life of the window. And
    the abort never reached the slot queue, so an open for a closed tab waited out `_slotWaitMs`
    and then evicted a live session to make room for itself.
214. **Reading a scroll in one coordinate system and writing it in another** → on a right-to-left
    page `cssLayoutViewport.pageX` is not what `scrollTo` takes, so every full-page capture
    carried a false note and the user's horizontal scroll was lost. In the same code, a
    visible-area capture outside the scroll gate captured the top of the page while a full-page
    capture had it scrolled there.
215. **A limit applied in the wrong unit** → the 16384 texture cap was compared with the clip in
    DIP, not with the image in device pixels, so on HiDPI a tall page came back with its rows
    repeating the top and was reported as copied whole.
216. **Clearing a buffer whose source replays into it** → `Runtime.enable` and `Log.enable` send
    what was logged before a session attached, so `browser_console` with `clear` was undone by the
    next session opened on the tab. Clear the browser's store as well
    (`Runtime.discardConsoleEntries`, `Log.clear`).
217. **`destroy()` on a stream whose promise waits for `end` or `error`** → neither fires after
    `destroy()`, so the request handler for a body over the drain limit never settled. Reject
    first.
218. **Handing out a selector without resolving it** → the element-picker paths were never
    checked, and three shapes went out wrong while reading as precise: XPath steps for SVG and
    MathML that match nothing, a shadow element's `#id` that selects a different element in the
    page, and a quirks-mode `#id` shared with another case. The builders now check the path with
    the call its consumer makes and answer empty when it does not come back.
219. **Page-chosen text outside a fence in a report** → an element `id` may contain a line break,
    so `Element:`, `HTML Path:` and every report heading could carry the page's own headings and
    instructions, framed as the extension's text; and a page replacing `JSON.stringify` chose the
    "page address". Keep page text on one line (`oneLine`, written twice) and accept only an
    address that serialises to itself.
220. **One throttle for two resources** → a single `lastPrune` served both report directories, so
    alternating assistants kept one of them from ever being swept on writes.
221. **Folding every failure into the one refusal message** → a report that could not be written
    and a command that threw were both "Claude Code is not available", and the report tab stayed
    open after a failed mention. Item 110 again; distinct outcomes, and the tab closed in
    `finally`.
222. **A fallback to "the first entry" where the default was meant** → the webview coerced an
    out-of-list search engine to `BROWSER_SEARCH_ENGINES[0]`, which is Bing, while the setting's
    default is Google.
223. **A `when` clause that hides the only button a context value selects** → a remembered Add
    action with its assistant absent left the toolbar with no primary button. Publish the
    fallback the clause needs, not just the clause.
224. **A rule written twice that drifted in one copy** → the promo build treated a throttle stamp
    in the future as fresh, the full build as due. Same rule, both builds.
225. **`vscode.env.remoteName` as "this host is remote"** → it is set in the local extension host
    of a remote window too, and this extension runs locally there (`extensionKind` puts `ui`
    first). The argv.json grant and the image clipboard were refused on a machine where both
    work, and Connect wrote a `127.0.0.1` config into the remote folder for an assistant on the
    remote, where nothing listens. Ask `Extension.extensionKind`; refuse what cannot work.

226. **Injecting before `Runtime.enable`** → a binding call made before the domain is enabled is
    never delivered — not queued — so the first report from a page is lost and the extension
    believes it has no login form. Enable, then inject.
227. **A virtual authenticator with `automaticPresenceSimulation: true`** → any page can create a
    passkey silently by calling the browser's own `create` around our wrapper, since creating
    needs no stored key. Presence goes on only for an approved ceremony.
228. **Adding the credential after the page's request started** → the request does not pick it
    up and fails or times out; presence toggled mid-request does not help either. The gate exists
    to put the credential in place first.
229. **`setAttribute("value", password)` in a fill** (Browserpass does) → the password lands in
    `outerHTML`, and `browser_html` hands it to a model. React does the same on its own, which is
    why `browser_html` now removes password values from a clone.
230. **Regular expressions in a plain template literal** → `\b` becomes a backspace and `\s` the
    letter s, so every pattern silently differs from the one written. The page script is
    `String.raw`; it may still not contain a backtick.
231. **Prefixing `https://` to an address that already has a scheme** → an app login
    `android://com.app` imported from a CSV became the website `https://android`. Only a value
    without `://` is given a scheme.
232. **A password in `Runtime.evaluate` source text** → it becomes a script the page's DevTools
    lists among its sources. Pass it as a `callFunctionOn` argument.
233. **Offering to save on submit** → a mistyped password becomes "Update saved password?", and
    one click replaces the right password with the wrong one. Offer only once the sign-in
    visibly worked.
234. **A page-triggered picker with no cool-down** → a page calling `navigator.credentials.get()`
    in a loop re-opens a QuickPick that takes the keyboard every time it closes. Refuse that tab
    for a few seconds after a refusal, and ask only for the active tab.
235. **Reading `WebAuthn.credentialDeleted` as the site's doing** → it fires for our own
    `clearCredentials` after every ceremony. The vault is changed only by the user.
236. **Reading `form.elements` / `form.id` as properties, even in an isolated world** → a control
    named `elements`, `id` or `form` shadows them (`[LegacyOverrideBuiltIns]`). The page script
    reads controls through the prototype getter and form attributes with `getAttribute`.
237. **Reading "disabled" as "gone"** → a fill-usability test (`isVisible`, which rejects a
    disabled field) was reused to decide whether a submitted form had left the page. Forms
    disable their inputs while the request runs, so every wrong password typed into one was a
    successful sign-in and became "Update password?". Presence and usability are two tests.
238. **Judging a new document by its first report** → it goes out 300 ms in, before a
    parser-blocking script or an app shell has drawn the error form, so a failed sign-in that
    navigated back to its form read as "no form, it worked". Decide on the settled report, and
    withdraw an offer if the form comes back.
239. **Counting an emptied password box as success** → a server rejecting the current password
    empties it as readily as one accepting the new one. Nothing that also happens on failure is
    evidence of success.
240. **Firefox's `value !== defaultValue` modification fallback** → script-set values (an
    assistant's `browser_fill`, the page's own code) passed as the user's after one trusted click
    anywhere, staging an offer to save a password the user never typed. Trusted input only.
241. **Hiding a secret from one tool that returns markup and not the others** → `browser_html` was
    fixed and the element reports were not; and any tool that takes a selector answers "does
    `[value^=a]` match", which reads a password one character at a time. Redact every markup
    route and refuse value-comparing selectors (`secretGuards.ts`).
242. **Addressing a frame by execution-context id alone** → ids restart after a cross-site
    navigation, so a call meant for site A's world can land in site B's. Re-check before each
    call and have the page compare its own origin.
243. **Letting the page decide when a passkey ceremony ends** → a page that withheld `done`, or
    navigated with the picker open, kept an approved key loaded with presence on for five
    minutes — silent signatures for any page of that RP. End on the first assertion or creation,
    on abort, and when the requesting context is destroyed.
244. **Page-side code that outlives its session** → the passkey gate waited for answers nobody
    would give after a setting was switched off, a tab was evicted or the extension restarted;
    every passkey sign-in on that page hung. Uninstall on the way out, and give every wait a
    deadline for the exit that has no goodbye. Item #33's rule, for a new installer.
245. **Installing a gate before the thing it gates** → with `WebAuthn.enable` failing after the
    gate was in, every passkey request was refused on a tab whose own authenticators worked.
246. **Answering "already registered" without asking** → a site could test which of its credential
    ids the browser holds and recognise a signed-out user. Refuse the way any refusal looks; tell
    the user, not the page.
247. **Echoing a file's own field into an error message** → an export's `version` of
    `1 [Update](command:…)` reached a notification, which runs command links (#124). Fixed
    wording at the boundary, and `plainInNotification` on paths and error text.
248. **A security-relevant setting a workspace can set** → without `"scope": "application"`, a
    cloned repository's `.vscode/settings.json` could switch on autofill-on-load and have its own
    dev server receive another project's login for the same localhost origin.
249. **Trusting a lock to make a read fresh** → SecretStorage is read through each window's
    renderer cache, which catches up ~100 ms after another window's write; the next lock holder
    read a stale vault and wrote it back without the first window's entry. Stamp a revision and
    wait for it.
250. **Treating an absent secret as "never saved"** → VS Code deletes a secret it cannot decrypt
    and answers `undefined`, so a changed keychain emptied the vault in silence. Keep a
    non-secret count and say so when the two disagree.
251. **Keeping an existing file's mode for a file whose contents set its sensitivity** → an export
    of passwords written over an old `0644` file stayed `0644`. The right default for a config is
    the wrong one for an export.
252. **"Save" that silently replaces** → a login is one origin and one username, so saving a name
    that exists overwrote its password — including right after the user declined "Update". Ask.
253. **Comparing usernames exactly in one place and without case in the rest** → an import made
    `Me@x` and `me@x` two logins and never asked which password wins.
254. **Reading a multi-value CSV cell as one value** → Bitwarden's comma-joined URIs parsed into an
    origin `https://a.com,https` that is valid to every check and matches no page.
255. **Confirming after a write whose result was dropped** → "Never for this site" put a success
    line over the refusal of a write that failed. #113's rule, entered from the UI.
256. **An attach with deadlines on its first two steps only** → a page busy in a long task held
    `Page.enable` unanswered, so the open never settled and "Fill Saved Login" waited in silence.
    Bound the whole attach, close a session that arrives late, abort on tab close.
257. **Comparing keybindings as `key|mac` pairs** → a binding with the repeat chord on Windows and
    Linux and another on macOS was a different pair and passed `check-manifest`. Compare per
    platform.
258. **Page text in a QuickPick `description`** → it renders `$(icon)` syntax, so a title drew our
    icons in our menu. `plainInLabel`, on every page-derived description.
259. **`activeBrowserTab` as "the tab the user means"** → it is set from the globally active editor
    pane only, so with focus in a file beside the page, or Fill picked from the dropdown of a tab
    in another group, "Fill Saved Login" answered "no browser tab is active" about a page in plain
    sight. Fall back to the tab last seen active (`userTab`), and ask `tabInFront` for what is
    on screen. The MCP side had met this already (`_lastTab`); the second feature did not inherit
    the answer.
260. **A freshness wait that falls back to the stale read** → the vault writer waited 3 s for the
    other window's revision and then wrote back the read it had — the very read the wait existed
    to reject, deleting that window's entry. Refuse instead; proceed only when the recorded write
    is old enough that its window cannot still flush it.
261. **Matching a selector with a regular expression** → CSS drops a comment between tokens, so
    `[value/**/^="a"]` selects exactly what `[value^="a"]` does and the guard did not see it. A
    selector check has to tokenise: comments out (only outside strings), escapes decoded, case
    folded — and then judge the compound, not the whole string.
262. **Scanning markup for `<input` as text** → a script containing `'<input data-x="'` opened a
    quote that swallowed the next real input, whose password went out unredacted. Skip comments,
    CDATA and raw-text elements, and honour quotes inside a tag.
263. **Awaiting persistence with a key armed** → a created passkey stayed loaded, presence on, for
    the length of the vault write, and gave a second signature with no second approval. End the
    ceremony and empty the authenticator first; save afterwards.
264. **Withdrawing the visible half of an offer** → the status bar item went, the picker the user
    had already opened did not, and Update wrote the rejected password. A withdrawal has to reach
    every place the offer can still be acted on — an open picker, an input box, a write made
    moments before (`_stillValid`, `revertWindowMs`).
265. **Reading silence as success** → a sign-in POST that fails on the network commits Chrome's
    error page, whose `://` origin the watcher ignores, so nothing ever reported and "no sign-in
    form seen" offered a password no server had checked. Absence of a report is not a report.
266. **Asking before the lock and writing inside it** → two windows both saw no entry, both asked
    nothing, and the second write replaced the first window's password. Re-check under the lock
    and come back out to ask. Renaming a username had the same gap with no check at all.
267. **An install guard on state a shared world keeps** → isolated worlds of one name are shared by
    every CDP session, so the frozen global a stopped script left behind made every later install
    return at once, and the document reported nothing until it navigated. Give each install an
    owner and let it retire its predecessors.
268. **Tracking provenance per form when the decision is per value** → Firefox's per-root
    modification flag covers every formless field at once, so a typed username (or a keystroke in
    a search box) vouched for a script-filled password. Record the value each trusted input left,
    per field, and require it to still be there.
269. **Reading a collection of the wrong type as empty** → a vault whose `logins` was not an array
    parsed as no logins, and the next write made that true. Wrong type is unreadable, like a
    newer format.
270. **An emptiness check that counts only what this build understands** → a vault holding only
    unreadable entries answered "nothing to export", and those are exactly the entries an export
    exists to carry to a build that can read them.
271. **Capturing on `pagehide`** → typing a password and clicking any link counted as submitting
    it, and the next page, having no form, counted as signing in. A navigation is not a
    submission; only a submit, a submit-like click or Enter is.
272. **"The form came back" judged by sign-in fields on the same origin** → a sign-up or reset
    form redrawn after a rejection is all new-password fields, and a failure can be sent to its
    form on another host. Any password field, any origin — in the page's own check as well as
    the watcher's; the page's was missed by every review and found while this round was being written up.
273. **Adding a menu section after the one a rule pins to the end** → the logins submenu went in
    after the assignments in both menus, consistently, against "the assignments sit at the end
    of every menu". A new section goes above them.
274. **Throwing after the write has landed** → a failed revision-file rename turned a saved vault
    into "not changed" and, after a passkey was created, into advice to delete a stored key at
    the site. After `store` resolves, everything else is best-effort.
275. **Keeping the first of two duplicate import rows** → Chrome exports a login per URL path, so
    an old and a new password for one account are normal; first-wins installed the old one and
    the summary no longer added up. Keep the newest and count the rest.
276. **A linear search per imported row** → 60 000 rows took 18 s inside the vault lock, freezing
    every extension in the host past the point other windows read the lock as abandoned. Index.
277. **Caching an answer that a change notice overtook** → a read in flight when another window's
    change arrived cached the old vault until the next change. Cache only if no notice came in
    between.
278. **Writing a secret export through `workspace.fs` to a non-file target** → its mode cannot be
    set, so a remote save dialog left every password readable on that host. Refuse it. Its
    sibling: the CSV's formula risk was "stated in the warning" according to a comment, and
    absent from the warning.
279. **Redacting a clone made in the page** → `cloneNode(true)` upgrades custom elements, so a
    read-only tool ran page constructors. Take the markup out and redact it in the extension.
280. **An unanchored name pattern for "secret"** → `pass` matched `passenger_count` and
    `compass_heading`, and `browser_html` reported those filled fields as empty — on the tool a
    model uses to check a page. Match words.
281. **Widening a rule in one tool and not its neighbour** → the secret-field rule grew a name
    test for `browser_html` while `browser_fill`'s refusal still hid only `type=password`, and
    echoed a toggled field's contents. One predicate, every caller.
282. **A refusal wider than the leak** → refusing every `[value…]` broke `option[value="us"]` and
    `input[type=radio][value=pro]`, which reveal nothing and are how models pick choices. Judge the
    element the comparison is on.
283. **A cool-down that only one ending starts** → only a refusal silenced a tab, so a page
    aborting its own request after 100 ms reopened the picker for ever. Every ending the page
    causes starts it.
284. **Answering an existence question before the user acts** → "already saved" became
    `NotAllowedError`, but answered at once it still differed in timing from the picker anyone
    else got, so `excludeCredentials` plus a short abort told a site which ids this browser
    holds. Ask first.
285. **Undoing only the step that failed** → `WebAuthn.enable` succeeded, `addVirtualAuthenticator`
    threw, and the empty virtual environment stayed on, hiding the tab's real authenticators.
    Undo the steps that succeeded.
286. **`location.origin` as a frame's origin** → it is the URL's: `"null"` in a `srcdoc` frame
    that really has the page's origin (every fill there refused), the site's in a sandboxed frame
    that really has none. `self.origin` is the document's.
287. **A toast from a path that runs on tab changes** → the vault warned about a lost store from
    inside `read()`, which runs when the active browser tab changes, so the toast paused the page
    being switched to (#10). Report through an event and let the UI layer choose the surface.
288. **Assuming SecretStorage persists** → on Linux without a keyring it is in memory, per window,
    and nothing in the API says so; the vault vanished with the window and the loss check blamed a
    changed keyring. Say both causes where only one can be true.
289. **A page-level authenticator with a top-frame-only gate** → the virtual authenticator answers
    out-of-process frames too, the gate never reaches them, so a cross-site frame's ceremony
    meets the empty authenticator and times out. Not fixed — documented in the setting and under
    [Passkeys](#passkeys-a-virtual-authenticator-that-holds-nothing); attaching to OOPIFs is the fix.
290. **Translating a page by restructuring its DOM** → wrapping text in elements, as Google
    Translate does with `<font>`, makes React fail with `Failed to execute 'removeChild'`, since
    React holds its own text nodes. Write `Text.data` and attribute values only.
291. **Translating text a form submits** → a submit button's `value` and an `<option>` with no
    `value` attribute (whose text is its value) are what the server receives; translating them
    changes the request. The translator never reads input values and skips text anywhere inside
    such an option — checking only the text's immediate parent let `<option><span>` through.
292. **Marking work done when it is handed out** → a tool result can be lost on the way (refused
    for size, timed out, the turn ended), and every string in it was then never offered again,
    with `remaining: 0` on a half-translated page. Settle a batch when a write answers it.
293. **Comparing `tagName` with upper-case HTML names** → SVG and MathML elements report it in
    lower case, so `<svg><style>` passed as text. Compare `localName.toUpperCase()`.
294. **Pinning a tab for a one-off request** → `browser_select_tab` outlives the request, so a
    translation prompt left the assistant off the user's tab for the rest of its session. Name
    the tab per call (`tabId`) instead.
295. **A loop whose exit needs an answer the API refuses** → the prompt said to leave out what
    needs no translation and to repeat until no segments came back, and an empty answer was
    refused — so a batch with nothing to translate was offered for ever. Accept `segments: []`.
296. **Checking eligibility when a batch is handed out and not when it is written** → the answer
    arrives later, and in between an option can lose its `value` or an element become editable.
    Ask at the moment of writing.
297. **An index the observer appends to** → it grows for as long as the page renders untranslated
    text, and de-duplication markers that outlive their entries hide a node put back into the
    page. Rebuild from a walk when the observer flags a change.
298. **Ids that are unique per window session only** → `tab-1` after a reload, or in another
    window, names a different page, so a prompt pasted late acts on the wrong tab instead of being
    refused. Put something random in the id.
299. **One document id across start-overs** → an answer for the previous language, still on its
    way, was written over the page after it had been put back for a new one, and the new run then
    found nothing to do. Renumber the document on every restore.
300. **Two observers that each undo the other's edits** → a page reverting outside changes and a
     translator re-applying its own wrote back and forth in microtasks for ever, freezing the tab
     and every tool call to it. Bound how often one node is re-applied, and treat a change equal
     to our text modulo whitespace as ours.
301. **Observing the attributes you write and not the ones that decide whether you may** →
     `contenteditable`, `translate`, a `notranslate` class and an option's `value` changed with no
     record, so a node that became editable kept our text for its editor to save, and one that
     became translatable was never offered.
302. **A strong `Set` of observed shadow roots** → every root a component page discarded stayed
     alive with its subtree. Use a `WeakSet`.
303. **Offering text that changes every second** → a clock or a ticker produced a new segment each
     round, so "repeat until nothing is left" never ended. Count an element that keeps changing as
     live text and leave it.
304. **A reverse map that overrides the page's own strings** → a translation equal to another
     source string hid that string: accepted, never written, never offered, and restored into the
     wrong text. A known source string is a source.
305. **`isContentEditable` as "inside an editor"** → it is false inside the `contenteditable="false"`
     islands editors render mentions in, which are still part of the saved HTML. Walk up for the
     editing host.
306. **Restoring only what is still eligible** → the nodes that stopped being eligible are exactly
     the ones whose translation now sits in what a form or an editor submits. A record of our write
     is reason enough to put it back.
307. **Matching submit words as substrings, and letting a link through when it matches** → "Reset
     your password" contains `reset` and "Trouble signing in?" contains `sign ?in`, so following
     either with a guess typed counted as a submission, the help page with no form as a sign-in,
     and the guess became "Update password?" — the failure #271 closed for `pagehide`, entered
     through the click capture. A navigating link is never a submit; words are whole words.
308. **Arming a capture on any interaction and never disarming it** → a "show password" toggle
     armed the form-removal capture, and so did a submit the page had rejected; the next route
     change of a single-page app then sent the retyped or untyped password as signed in. Only a
     submitting click arms it, a keystroke into the form disarms it, and a watch still running for
     a rejected submit ends as `remained` rather than reading the later removal as its success.
     The removal capture also needs a request after the arming click; see #320 for why the arming
     itself was not narrowed instead.
309. **Reading a selector's pinned type from inside a pseudo-class argument** →
     `input:not([type=radio])[value^="a"]` read as "a radio" and passed the value guard while
     matching a password field: the oracle #241 closed, reopened by a negation. Judge only the
     compound's top level.
310. **A screenshot clip in scroll coordinates** → `cssVisualViewport.pageX` is what `scrollTo`
     takes and not what a clip takes; on a right-to-left page the visible-area capture was white
     and reported as the page. The clip starts at layout `pageX` plus the pinch-zoom offset.
311. **A page-side wait that is one evaluate in one document** → the navigation being waited for
     destroys its context and the call fails with CDP's internal sentence; and settling only the
     host side on cancel or timeout leaves the page loop polling. Fixed first by restarting the
     loop in the new document and stopping the old one by token. Since #331 there is no page loop
     at all: each round is one short check polled from the host.
312. **Taking an emptied field for a reshaped one** → a sanitising input (`number`, `date`) given a
     value it rejects becomes `''`, which differs from what it held, so the read-back reported
     success over lost data. Empty after a non-empty value is a refusal, and the old value goes
     back.
313. **Trusting an assistant's command to report a hand-over it could not take** → in a remote
     window Codex dropped the local URI and resolved, so "Sent to Codex" covered a report nothing
     received and the clipboard fallback never ran. Refuse what the window's layout makes
     impossible before writing anything.
314. **A backslash escape honoured inside a TOML literal string** → `'C:\'` consumed its closing
     quote, the rest of the inline table read as one value, and the repair added a second
     `Authorization` beside the one it could not see. Escapes belong to basic strings only — the
     rule `scanLine` already followed, missed in the inline-table reader.
315. **Unquoting a single-segment table name** → `[mcp_servers."ai-browser.bak"]` read as a
     sub-table of `ai-browser`, so the user's own server was renamed into ours by the repair and
     deleted as ours by Connect and the prune. A name keeps the quotes it needs, and the root is
     split at the first dot outside them.
316. **A one-line rewrite applied to a selector after it was checked** → `oneLine` wrote U+2028 as
     the text `\u2028`, which CSS reads as `u`, so the "CSS Path + Location" clipboard copy named
     another selector. Escape such characters the way CSS does, before anything wraps the line.
317. **Taking a lock's breaker aside without judging it first** → every second remover moved a
     *live* breaker out and back, so a third could create its own in the gap and two removers
     ran the rename-and-link-back of #162 at once; after a crash, two windows held the config
     lock together in 5–6 rounds of 120. Only an abandoned breaker is moved, and the lock is
     judged again under the breaker before it is moved; 0 of 120 since.
318. **Page text in a status bar confirmation** → "XPath copied: …" carried the page's id verbatim,
     and the status bar renders `$(name)` as our icons. `plainInLabel`, as #258 says for every
     page-derived label — and the frame-address refusal of `locatorRefusal`, the same sink.
319. **Validating one setting's type and rejecting the panel over another's** → #184 coerced a bad
     `searchEngine`, and a non-boolean `focusLockIndicator.enabled` still threw `Could not load
     settings` and left the panel blank. Coerce every setting the webview reads to its default —
     at load in the webview, and on both paths in the extension (`focusLockSetting`), since the
     change message is validated too and a non-boolean there was dropped.
320. **Narrowing a capture trigger to a word list** → arming the removal capture only on the submit
     words fixed the toggle false positive and lost every `type=button` sign-in labelled in another
     language or with an icon — whole sites, on every sign-in. Keep the broad trigger and require
     the evidence that separates the cases: a request after the click.
321. **Decoding escapes before asking structural questions** → `\)` became a real `)` and closed a
     `:not(` early, putting a type that sat inside it at the top level. Decode punctuation to
     something inert; only names and values need the real character.
322. **A retry that lands where its assumptions do not hold** → restarted in a document that exists
     but has no `<body>` yet, the text wait threw a `TypeError` that was not a navigation error and
     went to the model. A missing body is "not found yet".
323. **A fall-back that is rare elsewhere and constant in one layout** → the remote refusal fired
     after every pick, as a toast over the page just picked in. Hide what cannot work, and refuse
     through the status bar what is still reachable.
324. **Reading a page as one document** → every tool stopped at each `<iframe>`, and nothing in
     the result said so, so an application rendering its content in a frame (OneNote in
     SharePoint) read as an empty shell and the assistant gave up. A frame from another site is
     a separate CDP target that the page's session cannot reach at all. Attach to it, and name
     the page's frames in the page-level results.
325. **Keying frame contexts by context id without the session** → ids are numbered per session, and the
     page and a frame in another process both have a context 1, so a bare id runs in whichever
     session it is sent to. Keep `{ sessionId, contextId }`.
326. **A page-only listener on a channel that also carries frames** → once a frame session has
     Runtime enabled, its `consoleAPICalled` arrives on the same `onDidReceiveMessage`. Compare
     the event's session id.
327. **Invalidating a cache entry by key after an await** → the entry under that key may already
     be the replacement. `forgetFrame` deleted the frame's new context, recorded while the old
     one's failure was on its way, and the frame read as "between documents" from then on.
     Delete only if the entry is still the one that failed.
328. **A child session ending without settling what was sent to it** → the browser drops those
     commands, and `CDPClient` settled pending work only when the whole channel closed, so a
     frame-scoped call on a frame that navigated to another process hung. `failSession` on
     `Target.detachedFromTarget`.
329. **A multi-step attach that rolls back only its bookkeeping** → the session the first step
     created stayed attached, and every retry made another. Undo the steps that succeeded, a late
     reply to a step that timed out included (#285's rule, for CDP sessions).
330. **A resource limit applied to an explicit request** → a cap meant to bound what a listing
     connects to also refused the one frame the model named, with a "removed" message that
     contradicted the listing beside it. Bound the sweep, and serve the named item.
331. **A page-side loop that sleeps on the page's timers** → a document that runs no timers (a frame
     sandboxed without `allow-scripts`) answers evaluates but never fires a `setTimeout` scheduled
     from one. `browser_wait_for` checked once and timed out over text on screen. Poll from the
     host.
332. **A listing that walks only what it connected itself** → a frame past the limit that a caller
     named stayed attached, and its nested frames were never listed again. Walk every attached
     session.
333. **Spawning a CLI with the environment as inherited** → VS Code started from a Claude Code
     terminal carries `CLAUDECODE`, and `claude` then refuses to start, taking itself for a nested
     session; every chat message fails while the same binary works from any other terminal.
     `JsonLineProcess` removes it.
334. **`activeBrowserTab` from a side bar view** → focus is in the view whenever its own button is
     pressed, so the property is always `undefined` there; the chat's "attach from the page" would
     refuse with a page in plain sight. Use `browser.userTab`, and pass the tab to the picker.
335. **"Has entries" as "the conversation has started"** → a notice is an entry, so the chat
     created by switching agents was taken as already started and kept the old agent. Ask
     whether the user has sent anything.
336. **One scale for two usage reports from the same CLI** → Claude Code's `rate_limit_event`
     gives a fraction where `get_usage` gives a percentage for the same window. And its
     `total_cost_usd` is per process while its `usage` is per turn — add the cost up and a
     two-turn chat costs three turns.
337. **Taking the first CLI on `PATH`** → an old standalone copy shadows the current one inside the
     assistant's extension, and since the model list is answered per client version, the chat
     offers last generation's models while the assistant's own UI offers the current ones. Ask
     every copy its version and use the newest.
338. **Two sends of one conversation at once** → a Codex message sent before the first turn had
     an id started a second thread, and both streamed into one chat with only one saved. Serialize
     a session's sends.
339. **An async start that never asks whether it is still wanted** → New Chat or Stop during
     `thread/start` still sent `turn/start`, and the turn ran unseen to the end on the user's
     quota. Check after every await, and interrupt a turn that began meanwhile.
340. **Abandoning a child process whose handshake failed** → only the promise was cleared, and
     every retry started another process that outlived the window's use of it. End it.
341. **A view holding a session its registry has replaced** → a Refresh that picked another copy
     disposed the session under the chat, and Claude ignored every later message in silence.
     Announce the replacement and drop the session.
342. **Deriving "who owns this conversation" from entries a history window can cut** → a long turn
     pushed every prompt out, and the reopened chat took another agent and handed it the wrong
     session id. Store ownership on its own.
343. **A resumed CLI process counting cost from zero** → Claude Code restores the session's cost
     ledger on `--resume`, so the first turn after a model change, or of a chat reopened from the
     history, counted the whole earlier session again. Baseline on the known session cost.
344. **A view in a container the host does not know** → it is not dropped, it is moved into
     Explorer, so the right-only chat appeared on the left below VS Code 1.106. Guard the view
     with a `when`.
345. **One token baseline for a turn and the message queued behind it** → the first turn's figures
     landed on the second prompt and the second turn showed none. Queue the baselines.
346. **Per-row UI state keyed by position, kept across chats** → a row opened in one chat opened
     itself in the next at the same index. Clear it when the chat changes.
347. **Announcing a replacement after disposing what was replaced** → disposing a Claude session
     zeroed its turn count in silence, so the listener read `running` as false and never ended the
     turn. Announce first, and read a turn's state from the chat, not from a session being torn down.
348. **A save at the end of an async send** → the chat it saves may have been deleted while the send
     waited, and the save wrote it, prompt and all, back into the history. Check it still exists.
349. **A stop flag carried to the next turn** → measured: a queued Claude message runs after an
     interrupt and succeeds, and the flag reported it "Stopped.". A stop belongs to one turn.
350. **A delayed fallback that acts on whatever is current** → a failed `interrupt` killed the
     process 20 s later, by when it could be a new one with a new turn. Capture what it was for.
351. **Steering into a turn that is being interrupted** → the message is refused or lost with that
     turn. Wait for the stopped turn to end, then start a new one.
352. **A refresh message read as a toggle** → the list refreshed after a delete reopened a history
     panel the user had just closed. Refresh and toggle are different messages.
353. **A click handler on text people select** → a drag-select ends in a click, so selecting a
     prompt folded it, and the rebuild the toggle caused took the selection away.
354. **A probe that hits the timeout of a child it cannot see** → `execFile`'s timeout kills the
     process it started; a script's own children keep the pipe open, and the version comes back
     anyway or not at all. A Refresh must not replace a working backend on such an answer. (Also a
     harness trap: a fake CLI run with a reduced `PATH` cannot find `sleep`, and "times out" at once.)
355. **Acting on the last-focused tab without checking it is on screen** → a pick waited for a
     click on a page a file had covered. Check, and name the page before acting.
356. **A view that goes away while its process works** → the CLI ran on, unseen, on the user's
     quota. A disposed view ends the turn and drops the session.
357. **Ending every running tool at the end of the turn** → a background agent outlives the turn
     that started it, so the sweep marked it Finished while it worked on, and its later
     notification found a row that was already over. Pass over `agent.background`.
358. **A turn nobody asked for** → after a background agent finishes, Claude Code starts a turn of
     its own; with no prompt counted the chat showed nothing at work and the reply ran into the
     previous one. `system status: requesting` is the signal (`autoTurn`).
359. **Fall-through into a new `case`** → adding a block to the `collabAgentToolCall` case below
     `webSearch` and `imageView` made those two fall into it, and Codex's web searches never
     finished. Give a shared `return` back to the cases that had it.
360. **Background-clipped text inside an ellipsis parent** → the shimmer (`background-clip: text`)
     rendered nothing in the agent list's `overflow: hidden` row. Plain colour there.
361. **Building a reader from a protocol schema the CLI does not use** → Codex's schema documents
     `spawnAgent` items and `agentsStates`, and a real turn sends neither: its sub-agents arrive as
     `subAgentActivity` plus the agent's own thread, which had no session and was dropped. The
     Codex agent list stayed empty. Measure a live turn before building on a schema.
362. **A turn nobody sent that holds no place in the queue** → the prompt sent while it ran was
     next in line, so the automatic turn's end was written onto it and the prompt's own turn found
     nothing. Give such a turn a place of its own.
363. **Reading every task as an agent** → Claude Code's task events cover background shells and
     long Bash calls too; a Bash row took agent fields and a dev server could hold the model for
     ever. Read the agent task types only, and apply agent fields to agent rows only.
364. **"No line break before the caret" as "the caret is on the first line"** → a soft-wrapped
     paragraph is several lines to the user, and ↑ there swapped the draft for history. Start a
     walk only from an empty box or the very start.
365. **Rebuilding a popup on every state post** → a click whose press and release straddle a
     rebuild never fires, and a selection in it is cleared. Rebuild on change and update the
     moving parts in place. (A `[hidden]` that a class's `display` overrides is the same file's
     other trap: the agents button showed "0" in every chat.)
366. **A stopped task's summary read as its report** → Claude Code's `task_notification` for a
     stopped agent carries the task's description in `summary`, and the card showed "Run timed
     step loop" as what the agent had found. Read a summary only from an ending that has one.
367. **A view that holds one conversation turned into one that holds several** → every path that
     let go of "the" session — New Chat, the history, an agent switch, a deleted chat, the view
     closing, a replaced backend — had to become per tab, and the state the webview keeps per
     conversation (the draft) had to be keyed by something that survives a reload. Move the
     conversation into its own object first, then add tabs.
368. **Resuming a send after a wait without asking whether its tab is still the one** → detection
     can take seconds; meanwhile the tab closed, was replaced, or got another chat from the history,
     and the message went into an old conversation or started a CLI for a tab nothing showed. #339
     one level up: check after the wait, and keep the text when the answer is no.
369. **A "keep what is running" rule applied to a change the user asked for** → Refresh keeps the
     copy in use unless another is proven newer, which is right for a Refresh; the same rule on
     a pick back to Auto kept a copy of unknown version, and the panel showed Auto beside it for
     good. A deliberate choice asks for the replacement.
370. **A stored path that names a file by one of its spellings** → the same file reached first
     through another `PATH` entry read as gone, and a path that carries a version (a copy inside
     an extension) went missing on every update. Match by the file, store what was meant.
371. **Page-written text opened as Markdown** → an element's id or a page title shown in a
     Markdown editor turns `[x](command:…)` into a link that runs a command on Cmd+click. A
     chat chip's text opens as plain text.
372. **A new destination for the repeat button gated on less than its refusal** → the chat's Add
     button and chord were gated on the VS Code version alone, so in a remote window or Restricted
     Mode a remembered chat action refused on every press. Gate the button on everything the
     command refuses, and fall back to the Copy twin there.
373. **Cutting a string by UTF-16 unit** → an emoji at the limit leaves half a surrogate pair, and
     a `vscode.Uri` built from it throws "URI malformed". Cut by code point (`capAt`).
374. **`claude -p` with no `--permission-prompt-tool`** → every tool that needs a yes is refused
     on the spot and the model is told it has no permission, MCP tools included, so the chat's
     agent could not touch the browser it was opened beside. `stdio` sends the question to us.
375. **Leaving Codex's approval reviewer to the user's config** → its auto-review answers by
     itself and no approval request is ever sent, so a "ask in the chat" design asks nothing.
     Set `approvalsReviewer: 'user'`.
376. **A question card that outlives the process that asked** → nothing withdraws it when the
     process exits or the session is dropped, and it asks for a click that reaches nothing.
     Close open questions on every path that lets a session go.
377. **Rebuilding a static view on every state post** → the empty chat's welcome was rebuilt each
     time another tab streamed (every 40 ms), and each rebuild restarted its fade-in: the
     changelog blinked while a different tab was thinking. Key it on what it shows.
378. **A credential in a CLI argument** → `--mcp-config` takes JSON inline, and the token would
     then be in the process list for every local user. Pass a `0600` file in a private directory.
379. **Sweeping by age a file a long-lived owner still points at** → the session cached its
     `--mcp-config` path and another window removed the file at a day old, so every later
     process start of that tab failed ("MCP config file not found"). One file per process,
     removed at its exit; sweep only files whose owning pid is gone.
380. **An approval prompt that shows a normalised copy of what it approves** → folding a command
     onto one line and cutting it at 500 characters showed `echo done rm -rf build` while Allow
     ran both lines and the hidden tail. Show the exact text.
381. **Composer chips rebuilt on every state post** → #365 again for a new surface: a click on a
     chip whose press outlasted a 40 ms post never fired, and focus left it. Key the rebuild.
382. **`workspace-write` in the home directory** → with no folder open the working directory is
     `~`, so the sandbox opened all of it to writes. Keep such a thread `read-only`.
383. **A CSS transition on an element that is rebuilt** → the class that should animate lands on
     a brand-new element, which has no "before" to transition from, so the change jumps. The tab
     strip had to keep its elements across a switch for the front tab's width to animate.
384. **Counting every message sent to Claude mid-turn as a turn** → one sent while a tool runs is
     merged into the running turn, so its `result` never comes and the tab read as working for
     ever. Count idle sends; let `status: requesting` announce a turn of its own.
385. **Restoring focus from a `blur` handler** → the blur is the user moving focus somewhere, and
     focusing the old place undoes it: a rename ended by clicking into the message box took the
     typing away. Restore focus only from the keys that end it.
386. **Trusting `dblclick`'s target on a surface that moves under the pointer** → the first click
     changed the layout and the double-click landed on the neighbour. Bind it to the first click.
387. **Ending "the current" thinking by scanning back to the last prompt** → a prompt sent during
     the turn sits after the turn's thinking, so the scan stopped short and "Thinking" shimmered
     for good after the turn ended or was stopped. End every open thinking block.
388. **A queue that outlives its conversation** → queued text went to the agent that replaced the
     tab's, and into a stopped chat after the view had gone. Give the queue back when the tab lets
     go, and check the chat when the drain fires.
389. **Saving before the step that adds to what is saved** → the waiting prompt went into the chat
     after the close had saved it, so the history lacked a message the CLI had received.
390. **Taking the working directory for the project** → with no folder open it is the home
     directory, so the whole of it counted as "Files in the project" under Auto. Keep "the
     project" a separate value that can be absent.
391. **Resolving a path the way the shell does not** → `path.resolve(root, '~/x')` is a folder named
     `~`, and a symlink compares as text; both let an edit outside the project read as inside.
392. **An absolutely positioned child as the last child** → it took `.markdown > :last-child` from
     the reply's last block, and every reply grew a bottom margin. Keep decorations outside the
     element whose children a rule counts.
393. **Finding a DOM node by counting model entries** → a prompt with attachments alone has no text
     node, and the queue's rows sit in another order than entries, so the count was off by one.
     Count the nodes being searched.
394. **A slash command that changes what the chat shows, offered from the chat** → Claude Code
     runs `/model sonnet` from a stream-json message, and the pill went on naming the model the
     process no longer used. The palette leaves such built-ins out (`hiddenClaudeCommands`).
395. **A palette row chosen on `click` in a mode where the query is the message box** → the press
     moved focus out of the box first, the caret went, and the query read as empty. Prevent the
     row's `mousedown`.
396. **Hiding a menu's fixed actions where they cannot act** → in an empty tab Clear and Export
     were simply not there, which read as removed. Show them disabled, with the reason.
397. **A destructive action as a list's default row** → "/" then Enter chose the first row, Clear
     conversation, and cleared the tab. Never make such a row the default without a query.
398. **A popup that follows the box, left open when code rewrites the box** → after a send the
     hidden palette read an empty query, matched everything, and took ↑ and Enter over the empty
     box. Close it wherever the text is set, and check the token is still there.
399. **"Replace the command at the start" as "replace whatever starts with /"** → a message
     beginning with a path lost the path. Replace only a bare `/` or a listed command.
400. **An unanchored `\s*` before an anchored tail, on text a repository writes** → quadratic in
     a run of whitespace; 7 s on the extension host for one command file. Anchor it, bound the input.
401. **Reading a reply's text from the stream deltas only** → a command the CLI answers itself
     (`/usage`, `/agents`) sends no deltas, only a complete message from `<synthetic>`, and showed
     nothing at all.
402. **An answer addressed to "the skill" rather than to the question** → with two runs of one
     toolbar skill waiting, the popup showed the newer run's command and Allow approved the older
     one's. Carry the approval id the user saw, and answer only the run asking it.
403. **A second consumer of agent sessions that does not hear `onDidReplace`** → the tabs end their
     turn when a Refresh replaces the backend; the toolbar's background runs did not, and a
     disposed session never reports the end of its turn, so the runs stayed "running" for good.
     #341 again: every holder of a session has to subscribe.
404. **Waiting for detection before calling a function that re-checks only after its own wait** →
     `_runToolbarSkill` awaited detection, so `_send` found nothing to wait for and skipped its
     "is the tab still the one" check (#368). Whoever waits asks the question.
405. **One slot for "the question it is waiting on"** → a turn that runs tools side by side asks
     several at once; the second replaced the first, which could then never be answered while
     the CLI still waited on it. Keep every open question, the way the tab keeps a card each.
406. **A second holder of sessions left out of the view's teardown** → closing the view ended the
     tabs' conversations and not the toolbar's background runs, which went on unseen. #356, for
     the next thing that holds a session.
407. **Wiring a menu change to one consumer of a shared policy** → the approval menu answered the
     tabs' waiting cards and not a background run's question. Every place that waits on the policy
     hears its change.
408. **Testing for a selection on the first click of a double click** → that click arrives before
     the word is selected, so a double-click to copy a word opened an editor tab and took focus.
     Wait out the double-click window, and drop the open if another click or a selection comes.
409. **Reading a file's content as a diff** → unmarked lines are context, so a Codex `add` given as
     plain content showed a new file as unchanged. Mark the lines by the change's kind, unless the
     text is already a patch.
410. **Rebuilding a row under a press** → a running command's output changes every few dozen
     milliseconds, and a click whose press and release straddle a rebuild never fires (#365 again,
     for the thread). Hold the pressed row as it is until the press ends.
411. **A setting that decides how a row looks, left out of the row's signature** → keyed rendering
     never rebuilt the rows on screen, so "Fold Tool Calls" reached only new ones.
412. **Keeping a list's chosen row while it still matches** → typed letter by letter, the row
     chosen at the first letter outlived an exact match further up. An exact name wins.
413. **Reading "which tab" when a popover is answered instead of when it was opened** → the tab in
     front can change in between, outside the view, and the skill ran in the other conversation.
414. **Searching a reply for a marker the reply may also mention** → a commit message describing
     the result markers named them mid-sentence, and the copy began there. A marker the prompt asks
     for on a line of its own is read only as a line of its own.
415. **Reading the text of every `<synthetic>` message** → an API error is one too, and the turn's
     result repeats it as the error, so "Prompt is too long" was said twice. Skip the flagged one.
416. **A warning that counts work the path it warns about does not stop** → the tab's agent count
     took in the background toolbar runs, and "Closing it stops 1 agent" was printed while closing
     left the run going. Count only what is stopped, or stop what is counted.
417. **Hiding overflow to stop a scroll, with an item that does not shrink** → the palette's list
     stopped scrolling sideways, and a long name that kept its width pushed the group tag past the
     row, where the hidden overflow removed it. Let the flexible part give way, and check every
     piece of the line is still on screen.
418. **A turn's `usage` as the size of the context** → `result.usage` adds up every request of the
     turn, so a turn with five tool rounds counts the conversation five times. The context is the
     latest request's usage — the main agent's last `assistant` message, Codex's `last`.
419. **A compaction's `post_tokens` as the new context** → it is the summary alone; the next request
     carries the system prompt and the tools again (2 220 reported, 25 726 carried). Leave the size
     unknown until a request reports it.
420. **A chain's next step sent on the chain's say-so alone** → a step that ended in an error, or
     a reply with no answer, is not a yes; reading "no marker" as "go on" would run a commit after
     tests nobody saw pass. Only an explicit yes from a clean step lets a checked prompt go.
421. **A skill's first prompt sent straight into a busy tab** → it is steered into the running
     turn, and its check is then read from that turn's reply, which answers somebody else's
     message. Queue every step, the first included.
422. **"No gate ran" read as "the gate passed"** → the check of a skill's next prompt was asked
     only at the end of a turn, so a step that never had one — its send failed, it was taken out of
     the queue — let a checked prompt go out unchecked. A checked prompt needs a recorded pass.
423. **A question fixed when it is queued and answered when it is sent** → the check a step asks
     was taken from the list at press time; with a prompt removed from the queue, the answer to one
     check gated another. Decide the question at send time and accept the answer only for it.
424. **A new field in a list an older build writes back whole** → an old window rebuilds each
     toolbar skill without `followUps` and stores the list, so one edit there stripped the new field
     from every skill. Keep a new field under a key the old build does not know.
425. **Steering into a turn that is not a model's turn** → Codex refuses input to a compaction (and
     a review) turn; wait for it to end, as for a turn being stopped.
426. **Allowing `AskUserQuestion` with its input unchanged** → it reaches the host as an ordinary
     `can_use_tool`, so it read as "Use this tool?" under Other tools; Allow sent no answers and
     Auto answered a question nobody saw. Answer it with `updatedInput.answers`, outside the menu.
427. **Leaving Codex's `request_user_input` to the default mode** → the tool is not offered there
     without `features.default_mode_request_user_input`, and the model asks in plain text and
     sleeps waiting for a reply the chat never sends. Set the feature on every thread.
428. **A menu that closes every popup, opened from inside one** → a link's menu in an agent's
     report closed the Agents panel it was in, so its anchor was hidden and the menu landed in the
     corner. Keep the panel, draw the menu above it, close only the menu.
429. **"Any selection" as "a selection of this"** → a press on a button does not collapse a
     selection elsewhere, so a file name in a tool row did nothing while reply text was selected.
     Ask whether the selection touches the element.
430. **A form whose answer falls back to a choice it no longer shows** → focusing the empty
     own-words row unmarked the option, and Answer still sent it. Send what is shown chosen.
431. **`width: 100%` plus padding and a border on an element that is not `border-box`** → a
     question card's own-words row is a `div` (the options are buttons, which default to
     `border-box`), so it came out 2px wider than the card and the whole thread scrolled sideways
     by that much. Give such rows `box-sizing: border-box`.
432. **Hiding a codicon with `display: none` under one class** → codicon.css sets `display` with
     `.codicon[class*='codicon-']`, which is more specific, so the form's tab checks showed on every
     tab, answered or not, and the check's `font-size` never applied either. Style a codicon with
     a selector more specific than that (`.qd-tabs .qd-tab .qd-tab-check`, `:not(.answered)`).
433. **A glob turned into a regular expression, on text a repository wrote** → `*` as `[^/]*`
     backtracks, and `*a*a*a…*b` against a long name ran for longer than anyone waits, on the
     extension host. Match wildcards with the two-pointer walk.
434. **The working directory of a shared process taken from the tab in front** → a tab whose
     folder was deleted put detection and Codex's one app-server in a missing directory, and
     `spawn` reports that as `ENOENT` of the binary: every agent read as not installed.
435. **Running git in a folder that should be our worktree without checking it still is** →
     removed and made again as a plain folder, git searches upwards and commits in whatever
     repository it finds; and a worktree's `.git` is a file the agent can rewrite.
436. **A flattened name as a unique key** → `feat/x` and `feat-x` became one folder, and the
     second branch's checkout replaced the first tab's under it.
437. **Guarding a shared resource on the tab that asked** → two tabs worked in one copy, and
     Remove from the idle one deleted the worktree under the other's running agent.
438. **A restart that waits for idle, checked only when asked** → a reference added during a
     long fetch arrived while the tab worked, and the running Claude Code never got `--add-dir`.
439. **A reply for a slow request accepted whatever it is for** → the file listing of the tab
     left behind landed after the one in front's and replaced it; listings are kept by folder.
440. **A rebuild signature that counts entries rather than names them** → a renamed file kept
     its old row; and a list rebuilt under a press lost the click (#365, again).
441. **A default row chosen by a search that matched only actions** → a typo and Enter moved the
     conversation to another folder; only a file is chosen by default.
442. **A class one popup adds to a popover others reuse** → the GitHub form's width stayed on
     the next skill's parameters; `openAbove` sets or clears it.
443. **Starting `claude -p` in a folder fetched from the internet** → `-p` skips Claude Code's
     trust dialog, and the repository's `.claude/settings.json` hooks ran as shell commands on
     the first process — the skills listing, before any message. Hold its settings back
     (`--setting-sources=user --strict-mcp-config`) until the user trusts them.
444. **A diff against a remote-tracking ref** → it moves with every fetch, and what came in
     upstream read as deletions made by the copy. Diff from the merge base.
445. **Keeping a list's chosen row while it still matches** → chosen by the first letters or a
     pointer passing by, it beat the best match, and Enter attached the wrong file or moved the
     conversation. Keep only a row picked with the keys, in the same search.
446. **"Not busy" as "quiet"** → between a turn's end and the turn Claude Code starts on its own
     the tab reads idle; ending the session there lost a prompt it had already taken.
447. **The home directory as a project** → picked with the folder button, `~` became the root:
     Codex's `workspace-write` covered all of it and every file there was "inside" — what #382
     and #390 had closed for no folder at all.
448. **A bare `git` where a repository is the working directory** → looked up at run time, an
     empty or `.` `PATH` entry (Windows: the working directory first) ran the repository's own
     `git`. Resolve it once, absolutely, from absolute entries only.
449. **"Could not stat it" as "not there", before a delete** → `prepare` would have re-cloned over
     the copies' work; and a failed clone removed the repository's whole folder, copies with it.
450. **A decision taken when a session opens, about something that can change under it** → a
     folder held back after a Claude session was already working there kept loading its own
     settings in every process that session started. Let the sessions there go when the folder's
     standing changes, in either direction.
451. **`button.type === 'submit'` as "this button submits"** → a `<button>` with no `type`
     attribute reports `submit` with no form to submit, and an app's "Forgot password?" is one:
     the guess just typed went out as a sign-in, the route change read as success, and the
     extension offered it as the new password — #233's outcome, the one the feature exists to
     prevent. Only an explicit `type=submit` is a submit; a typeless button counts by its words,
     and never when they lead elsewhere. Measured in Chrome with the shipped script: four
     typeless "Forgot password?" shapes captured nothing, four real sign-ins (`Log in`, `Войти`, an
     arrow icon, one inside a form) were captured as before.
452. **A withdrawal that can only undo a commit already recorded** → an offer withdrawn while its
     "Replace its password?" modal was up, or while its write was on its way, had nothing to
     undo yet, and fires once: the rejected password stayed saved. The modal's answer is checked
     against the withdrawal, and `_noteCommit` undoes at once what a withdrawn offer wrote.
453. **Suppressing a report identical to the last one sent, across a verdict judged without
     reports** → a sign-in form that faded out and back (no node removed) was judged gone by
     polling while the last report sent still read "password shown", so the report of its
     return was suppressed and the offer never withdrawn. A verdict resets the comparison.
454. **One file's write failure thrown out of a loop over files** → an unwritable `.mcp.json`
     ended `repairConfigs` before `~/.codex/config.toml`, at every start, silently. Each file is
     its own outcome.
455. **Rebuilding a button's contents on every state post** → #365 for the composer's own
     controls: a press on Stop's icon during a reply landed on a node replaced before the
     release, 0 of 10 clicks. Replace them only when what they show changes (`setIcon`,
     `setPill`).
456. **A placeholder that takes the place of a structural element** → the empty chat's welcome
     replaced the spacer, and the first message of a fresh tab (same chat id) never brought it
     back: new conversations sat at the top of the panel.
457. **A sanitiser for one sink reused for its neighbour** → `plainInNotification` keeps `$(`,
     and `scopeNote` feeds status bar confirmations too, where `$(name)` is an icon. Page text
     bound for a label goes through `plainInLabel` (#258, #318), wherever else it also goes.
458. **A fallback that is rare in general and constant in one layout, again** → with no folder
     open, Add to Claude Code toasted over the page after every pick. `canHandOver` now needs a
     local folder for Claude Code, re-published when folders change; the refusal itself goes to
     the status bar (#323's rule).
459. **A tab flag that outlives what it describes** → `_closed` set when the view went away was
     reset only by `start()`, and the view brings the same tabs back: every `restartSession`
     after that did nothing, so a reference or a trusted folder never reached Claude Code.
460. **Page-chosen text on a prose line of a Markdown file** → an element id of
     `[x](command:…)` became a link in the `.md` report, which a Markdown editor runs on
     Cmd+click (#371's sink, through a file on disk). `inertProse` escapes `](` and writes `<` as
     `&lt;`; a Tailwind class's brackets are left alone. See #469 for why not `\<`.
461. **Splitting `mcp__<server>__<tool>` at the first `__`** → a server named `ai-browser__fs`
     read as ours and its writes were answered by the AI Browser category's Auto. A name with
     more than one `__` is asked under Other tools — counted with overlaps, since
     `mcp__ai-browser___x` is also the server `ai-browser_`'s `x` (Claude Code turns
     `ai-browser.` into that), and the lazy split picked ours.
462. **A TOML writer that sees only one spelling of a server** → `[mcp_servers]` keys and root
     dotted keys define servers too; unseen, Connect appended a table of the same name — TOML
     that does not parse. `codexServersElsewhere` names those servers: Connect refuses a
     collision with its own name (or the inline `mcp_servers = { … }`), the repair renames
     nothing onto them, and the removal ignores them. See #467.
463. **A size limit on the count of lines and not on their length** → 200 console lines of
     React warnings with stacks passed the 25 000 tokens Claude Code takes from a tool. Lines are
     cut at 2 000 characters — never inside a surrogate pair, whose lone half a strict JSON reader
     (serde, behind Codex) refuses (#373's rule) — and the answer at 40 000, newest kept. With
     `clear`, only the lines the answer carried are cleared (#470).
464. **An input method's Escape read as the user's** → cancelling a conversion closed the
     toolbar skill editor, the GitHub form or a popover, and what was typed went with it.
465. **A draft saved from before a ↑ walk while the box took new text** → queued messages given
     back by Stop or Clear were appended to a recalled message, and the draft kept the text from
     before the walk, so the next tab switch dropped them. Giving text back ends the walk — and
     adds it to the draft from before the walk, not to the message on show: the first fix built
     on the recalled text, so the draft typed before ↑ was lost for good, and the queued message,
     usually the one recalled, went in twice.
466. **Narrowing what counts as a submit without asking what else reads "not a submit"** → the
     click handler ends a running watch on any click that is not a submit, and Enter's implicit
     submission *is* a trusted click on the form's default button. Once a typeless button stopped
     counting by its type, every Enter sign-in on a form whose default button had no submit word
     ended `remained` at once. A click that submits the watched form itself never ends its watch.
467. **A guard against a collision that refuses on the mere presence of the other party** → the
     detector for servers in another TOML spelling refused the whole file, valid or not, so one
     hand-written `[mcp_servers]` server switched the global repair off for good — `complete`
     never true, no port fixed, nothing pruned — and Connect reported an old entry it could not
     remove on every press. Item 109's rule: refuse only the collision, keep the rest.
468. **A substitute press recorded as a choice** → in a window with no folder the toolbar's Copy
     twin stands in for "Add XPath to Claude Code", and pressing it wrote `xpath` into the
     global memento, taking the Add button away from every project window. A repeat press on a
     stand-in records nothing.
469. **A Markdown escape against a reader that does not read Markdown** → `\<` stopped the
     autolink, and the Markdown language server finds HTML links with an HTML parser over the
     raw text, where the backslash is nothing: `<a href="command:…">` in an element id was still
     a Cmd+click command in the report. Write `<` as `&lt;`; check every link reader the editor
     runs, not the renderer alone.
470. **Clearing everything when the answer carried a part** → `browser_console` with `clear`
     emptied the buffer and the browser's store, then cut the answer to its newest lines, so the
     older ones it said it had "left out" were gone. Clear only what was returned.
471. **Two sources of one figure that name it differently** → Codex's read names its windows
     after their limit when it lists several, and the `updated` notification, carrying one
     limit, would not; a close keyed by one label never matches the other, and the closed
     plan-limit line comes back on the next turn. Name them the same way in both
     (`_namedLimits`).
472. **Two sources of one figure that round differently, the lower read as a reset** → Claude
     Code's `get_usage` says 85 where the turn's `rate_limit_event` says 0.84 in the same second,
     and a close forgotten whenever the figure fell came undone on the next message: the line
     closed at 92 % came back at 91 %. Tell a reset by the reset time moving on, and keep a
     limit's higher figure within one period.
473. **A per-model limit read as the plan's** → `get_usage` lists a model's own weekly limit
     (`weekly_scoped`) beside the plan's, and "extra usage on and any limit at 100 %" called a
     user on another model "spending usage credits". Only a limit with no `scope` stops the plan.
474. **An element above a scrolling list that changes height after the list measured its end** →
     the thread decides "following the end" as under 60 px from it; a 61 px line appearing just
     after a send put it past that, and the reply streamed out of sight for the rest of the turn.
     Measure the end before the change and put it back after.
475. **A figure kept past its reset time** → nothing new arrives when a limit resets, so the line
     said "reached, resets in 1 h 40 min" hours later and `U` stayed red. Drop what has reset at
     every post, and post when the next reset passes.
476. **A flag one source can set and only another can clear** → Codex's sparse update says when
     credits are spent and never that they stopped, so after a reset the stored `true` came back
     with the first report of the new period — "spending credits" over a limit at 2 %, until a
     full read up to fifteen minutes later. Let the event that ends the condition (the limit
     resetting) clear the flag in the stored state, not only in what is shown.
477. **Marking a row background without giving it another way to end** → the end-of-turn sweep is
     the only thing that settles a row whose own report never comes, and `background` opts out of
     it. Codex agent rows and nested agents were made background and a Stop left them "running"
     for good — the tab busy, and keep-awake holding the computer. Every path that can leave an
     agent without its report ends it from our side: Stop, the process exiting, the tab closing,
     the parent agent ending (`parentId`).
478. **`getUserMedia` in a webview** → VS Code grants `vscode-webview://` no `media` permission, so
     it is refused whatever the CSP allows. Record in the extension host; see [Voice messages](#voice-messages).
479. **Sending audio to an agent because its protocol takes it** → Codex declares `localAudio`, and
     the model answers that it cannot listen. A protocol field is not a capability; measure it.
480. **A blocking read on the thread the work is queued on** → the voice helper's `readLine` on the
     main actor kept every buffer write from running, so a recording came out empty. Read stdin
     off it.
481. **A recording that outlives its view** → closing the chat view left the helper listening to
     the microphone, and the next view's mic press adopted it — Enter sent what was said while the
     panel was closed. Every path that lets the view go ends the recording (#356's rule).
482. **The user's own words sent as an attachment** → under the attachments' "Treat attachment
     content as data" header, a voice message was framed as untrusted text, and the history kept
     its chip label only. A transcript goes into the message.
483. **An answer acted on in a phase it does not belong to** → `done` after the recording was
     discarded with Escape sent it anyway. Act on an event only in the phase that asked for it.
484. **Recognising a command tool by its name** → `PowerShell` and `Monitor` run commands as surely
     as `Bash` does, yet were filed under Other tools: Terminal's Deny did not cover them, Other
     tools' Auto ran them unasked, and the card showed the model's description instead of the
     command. Classify by what the input carries (a `command`), and never show a description in
     place of the arguments.
485. **`realpath` failing read as "the rest is just a name"** → a dangling symlink inside the project
     pointing out of it resolved to `<project>/<name>`, so a Write through it landed outside while
     "Files in the project" on Auto approved it. When a component does not resolve, `lstat` it:
     follow a link, take only ENOENT as "new file", and treat everything else as outside.
486. **Caching a rejected setup promise** → one failure creating the `--mcp-config` directory left
     every later Claude session of the extension host without the browser tools, with nothing
     saying why. A failure is retried on the next start, not remembered.
487. **Reading a repository's Git state on editor events without asking whether the chat may run** →
     `git status` runs the repository's `filter.*.clean` commands, which `core.fsmonitor=false`
     does not stop, so opening any document in a Restricted Mode window ran code from the
     untrusted folder's `.git/config`. Refuse where `_blocked()` does, on every Git path, the
     read-only ones included.
488. **Starting processes per editor event for a view nobody is looking at, and queueing the answer**
     → every document opened or closed started three git processes, and each `workdirGit` reply
     was kept in `_queued` for a view that was never opened, for the life of the window. Read
     only for a visible, ready view, debounce, keep one read per folder in flight, and never queue
     a snapshot.
489. **Comparing a `Uri.fsPath` with a path built from `os.homedir()` as strings** → on Windows one
     has a lowercase drive letter and the other an uppercase one, so a draft's attachment never
     matched its own file and the temporary-file cleanup deleted it. Compare through one
     normalisation (`comparablePath`), case-folded on win32.
490. **Marking a tab closed when only its view went away** → the provider reuses the same tabs when the
     view is resolved again, and `_closed` was reset only by `start()`, so generated titles were
     dropped and a failed first send was never saved, in every tab, from then on. The view closing
     calls `close('view')`, which leaves the flag alone.
491. **Closing every popup on blur, unsaved forms included** → the skill editor, Chat Settings and the
     GitHub and parameters forms are rebuilt from stored state when reopened, so a click into a
     file, Cmd+Tab, a collapsed side bar or the editor's native colour picker threw away what was
     typed (#464's class). Keep a form holding input open on blur and visibility loss; close only
     menus and questions there.
492. **Enter in a search box acting on the first row that merely contains the text** → the branch
     search checked out any branch on an empty box, and `experiment-old` for a new name "exp"
     whose create row was on screen. Act only on an exact match or a row picked with the keys;
     otherwise create, or do nothing (#397, #441, #445).
493. **Matching a destructive command by its description in the typed palette** → "/start" or "/over"
     mid-sentence found Clear conversation, made it the default row, and Enter cleared the tab
     instead of sending. Typed chat commands match by name only and are chosen only by an exact
     name or an arrow key.
494. **Writing a line back in our own spelling because it belongs to us** → the unattended repair
     rewrote the header, `http_headers` and every sub-table header on each port move, which
     changes none of them, so the user's comments on those lines and the inline table's spacing
     went every time, while the doc comment promised to touch only the lines that are wrong.
     Compare by meaning, and only write a line that differs.
495. **A hand-written trim where git's own rule was meant** → `[ \t]+$` stripped a trailing tab that
     git keeps as part of the pattern, so `config.toml<TAB>` read as protecting the token-bearing
     file while `git check-ignore` said it did not (#196's direction). Git drops unescaped
     trailing spaces and nothing else.
496. **Taking "it parsed" for "it is a config"** → a `.mcp.json` holding a JSON array was rebuilt into
     `[]` and reported as written (#113), a string `mcpServers` was spread into index keys, and
     the repair left `null` holes in an `mcpServers` array. Refuse any shape the writer cannot
     rebuild, as it refuses a parse error.
497. **A size limit enforced by throwing in the write path** → the throw went to `_fail`, which removes
     the file and shows an error, so a recording reaching 256 MB (about 170 s of a busy page at
     12 Mbps) lost everything, while the time limit stopped and kept it. A limit ends the
     recording; it does not fail it. Stop early enough for the final flush to fit, and
     acknowledge and drop past it.
498. **A success toast after work the user started from the page** → "Video recorded…" and "Recording
     prompt copied" landed on the browser tab they came from and paused it (#10). The status bar
     for a confirmation, a modal for a paste.
499. **The source closing during startup read as a failed stop** → `stop()` refuses while `starting`,
     so closing the tab during a start produced "Browser recording failed: Recording is still
     starting.". Closing the page there is a cancel.
500. **A label read through a call that also needs layout** → `extractElementData` for a report
     heading threw on box-less elements (`<area>`) and took a working Add down with it. Read only
     what the label needs.
501. **Commands contributed without a `category`, menu-only commands left in the palette** → the
     palette listed bare "Balanced · 1080p *" rows and two identical "Record page prompt"
     entries, and two chat commands ran `aiBrowser.chat.focus` below 1.106, where it does not
     exist. `check-manifest` now requires a category; gate or hide the rest.
502. **An armed capture with no way to end it but typing** → a sign-in button with no submit word
     arms the removal capture and starts no watch, so after a rejection the next route change
     counted the rejected request as "sent after the user acted", and the guess was offered as an
     update. End an attempt once the page answers and keeps its form, and on any click that moves
     on.
503. **A memory that only a match can set** → the two-step username was remembered when typed and
     never cleared, so an account switched by a fill or a chooser saved the next password under
     the previous account. Every step replaces it; a sign-in that worked uses it up.
504. **"Newest" decided by a stamp the importer invented** → undated CSV rows all got the import's
     time, so the first duplicate won while the summary said "the newest used". Only real dates
     order rows; the rest are named to the user.
505. **Lowercasing a copy to search the original** → quadratic per element, and `toLowerCase` changes
     length, so an index from the copy pointed elsewhere in the original and copied a password
     value through unscanned. Search the original case-insensitively.
506. **A quote read as a delimiter where it is a name character** → `<div a'="x">` and `<div ='>`
     opened a "value" that ran past the next password input. A quote opens a value only where
     the tokenizer's attribute states would read one — after an `=` that follows a name.
507. **"Not newest" for a password-only sign-in read as "the only login"** → with one login saved
     for the origin, a password whose first step carried no typed username (a fill, an account
     chooser) was offered as that login's update — another account's password. A first step of
     unknown account blocks the single-login rule.
508. **"It did not throw" read as "it was delivered"** → both chat backends give a message up
     without throwing when the session is disposed or stopped before a turn begins, so deleting a
     sent message's annotations on a send that merely returned removed the user's notes for a
     message no agent saw. `AgentSession.send` answers whether the message reached the agent.

509. **A weak positional path never tried after a reload** → only an id, `data-testid` or
     `aria-label` locator reattached a page annotation, so every marker on an element without one
     came back "not found" and stacked in the top right corner of the page after each reload. A
     positional path is tried too, and taken only when it matches one element of the same tag and
     text; a strong locator needs only the tag, so an element whose text changes keeps its marker.
510. **A timer waiting on a session nobody cancels when the session goes** → a replaced backend
     dropped the session under a "Prompt is too long" retry, and the timer, finding none, returned
     without a word: the prompt was never sent again, its error had been held back for the retry,
     and the tab read as working for up to 30 s. Whatever lets a session go ends what waits on it
     (#341's rule), with the error that wait was standing in for.
511. **Classifying a tool call by a title the model writes** → Gemini titles a shell command by the
     command, so `… # (ai-browser MCP Server)` was filed as the browser, and AI Browser's Auto ran
     it with no card. Decide by what the CLI sets (kind, call id); use the title only to split it.
512. **A project path that is a user path at `~`** → `<home>/.gemini/settings.json` is Gemini's user
     settings, so Connect Gemini put the token into every project. Codex had the guard
     (`codexProjectIsGlobal`); every new per-project writer needs its own.
513. **"Auto" resolved to an agent that cannot do the job** → a Gemini tab's Commit button named
     Gemini, took the Git lock and then failed, and titles were dropped. Resolve Auto among the
     agents that have the capability, in the host and the view alike.
514. **Reporting a failure from both the exit handler and the awaiting caller** → a Gemini process
     that ended during its handshake ended the turn in `_processEnded` and rejected `send()` too,
     so the chat showed the error twice. The exit handler ends only a turn whose prompt went out.
515. **Falling back from whole-word matches to raw ones by index** → `symbolColumn('tab, tabs',
     'tab', 2)` returned `tabs`. Use raw matches only when there are no whole ones.
516. **A closed Codex tab leaves its thread loaded** → the shared app-server outlives the tab by
     `idleShutdownMs`, so the terminal hand-over's `codex resume` answered "This conversation is open
     in another app". **`thread/unsubscribe` does not help**: measured on 0.163, it answers
     `unsubscribed` and the thread stays in `thread/loaded/list` 45 s later. Only the app-server
     exiting frees it, so `CodexBackend.release` ends it when nothing else works in it (no turn
     running, no hold); the other tabs resume in a new one at their next message. With a turn
     running elsewhere it leaves the chat open and asks the user to retry the hand-over once
     that work finishes; it never starts a terminal while `release` returns false. Claude Code and Gemini have the same race with their own
     per-conversation process, which a SIGTERM does not end at once: `_resumeInTerminal` closes the
     tab, then awaits `JsonLineProcess.stopped()` — every process told to stop has exited, or 4 s —
     before it creates the terminal.
517. **A conversation handed to a terminal without the server the chat injected** → the chat gives
     its CLIs the browser server at every start, a terminal's `claude --resume` / `codex resume`
     got nothing, so the moved conversation saw neither the VS Code browser nor Chrome.
     `_resumeInTerminal` passes it the same way: Claude a `0600` `--mcp-config` file (removed when
     the terminal closes), Codex `-c` overrides with `env_http_headers` naming
     `AI_BROWSER_MCP_AUTH`, set in the terminal's environment — the token never in argv.
     `http_headers={}` clears a stale project entry's token. Gemini reads servers from settings
     files only and is not covered; Connect Gemini CLI is its route.
     **The tab goes along too** (`X-AI-Browser-Tab`): the controller remembers the tab each chat
     conversation's agent last resolved (`tabIdForChat`, by `caller.chatId`), and the hand-over
     sends its id — Claude in the config's `headers`, Codex through `env_http_headers` from
     `AI_BROWSER_MCP_TAB`. The server reads it as `preferredTab` and seeds that session's pin
     once (`_seeded`), so a later `browser_select_tab` still moves it and a share still wins.
     Without it the terminal followed the VS Code tab in front, never the Chrome tab the chat had
     been working on (the last-resort fallback is built-in only).
518. **A real-path boundary checked on the tool path and not on the editor's own buffer** →
     `editor_reveal` and the language tools resolve symlinks (`_realInside`), while
     `editor_context` asked only `getWorkspaceFolder`, so a file opened through a workspace
     symlink to `~/.ssh/config` handed its current line and selection to the model.
     `_readableInside` applies the real-path test there too; an outside file gets metadata only.
519. **Pushing the branch a record names instead of the one checked out** → `pushCopy` committed on
     the current `HEAD` and pushed `copy.branch`, so after an agent or a terminal switched branches
     in the copy, Push reported success and opened a compare page while the new commit stayed
     local. It reads `symbolic-ref HEAD`, refuses a detached one, and returns what it pushed.
520. **Emptying a send queue whose composer has already let go of the text** → the Chrome side
     panel cleared its outbox on Disconnect and on every new connection, and the composer had
     cleared the text and chips at send, so undelivered messages were gone.
     `returnOutboxToDrafts` gives them back first.
521. **A test that lifts functions out of a file and runs them in a sandbox** → when the lifted
     function starts calling a new helper, the test fails with `ReferenceError` while the product
     works (`prepareChromeMessage`, `chromeFooter.test.ts`). Lift the helper too, not a stub,
     so the test still exercises the real path.
522. **One close code for "revoked" and "transient"** → the Exchange relay closed an agent with
     1008 for a revoked key and for a bad message or a full queue alike, and the client stopped
     for good on any 1008. Give a permanent refusal its own code (4001).
523. **A size limit in one unit on the server and another on the client** → 64 000 UTF-16 units
     pass the relay and exceed 128 000 UTF-8 bytes; the client dropped the connection on a valid
     command. Bound frames in bytes, by the receiver's real limit.
524. **A pick that waits for input on a page the viewer is not looking at** → Element and
     Annotation pressed on the Exchange website armed the picker on the shared tab, and the
     website's click never finished it, so the pick was done in the local VS Code browser
     instead. Resolve a remote pick from the click's coordinates (`remotePick.ts`).
525. **An agent's key press that reaches the user's clipboard** → `browser_press` sent Cmd/Ctrl+V
     as CDP's `paste` command, so a prompt-injected agent could paste what the user had copied (a
     password, a token) into a page and read it back. `keyDescription` refuses copy, cut and paste
     shortcuts outright — without the command Chromium still pastes on Control+V natively on
     Windows and Linux. Text goes in with `browser_type`.
526. **A setting written into a nonce-allowed `<style>`** → xterm puts the font family unescaped into
     a `<style>` element, and `terminalCsp.ts` gives every `<style>` the page's nonce, so a
     workspace's `terminal.integrated.fontFamily` could restyle the whole chat — the approval cards
     included. Once a nonce covers generated styles, every string reaching them is CSS on the page:
     validate it (`safeFontFamily`, written twice) or fall back.
527. **Pasting through a bracketed paste without sanitising** → `ESC[201~` inside the clipboard
     closes the shell's paste early, and the rest runs as typed commands. xterm's `paste()` only
     rewrites newlines and adds the markers. Strip ESC, C0 but tab/CR/LF, DEL and C1 from every
     paste path, the view's own paste event included.
528. **A program to run, taken from a workspace setting** → the shell and its arguments came from
     `terminal.integrated.profiles.*`, so a cloned repository's `.vscode/settings.json` ran code on
     New Terminal. Read them with `inspect()` and keep the user's values and the defaults only — the
     rule `claudePath` and `codexPath` follow by being `application`-scoped.
529. **Flow control whose credit lives in a view that can go away** → a reloaded view never
     acknowledges what its predecessor was sent, and the PTY stayed paused for good, the shell
     blocked on its own output with no error. Whoever counts in-flight output gives it back on
     attach, detach, restart and exit.
530. **Acknowledging what the other side never counted** → the view acknowledged the replay and
     dropped duplicates, which the host had not counted as in flight, so the credit came off live
     output and the shell ran ahead of xterm by a replay's worth per attach. Both ends must agree,
     in one written-down contract, on exactly which bytes are owed.
531. **A stream through a queue built for messages** → `_postMessage` holds everything for a view
     that has not said `ready` and diverts it during a remote command, so terminal output would pile
     up without bound for a hidden view. A stream has its own path that drops when nobody listens,
     with a replay to catch up.
532. **Limits in a chain that do not nest** → the host accepted a paste of up to 4 000 000
     characters and the session dropped any write over 1 MiB in silence, so a large paste vanished.
     Each layer's limit must sit below the next one's, and the outermost refuse aloud: paste
     990 000, input 1 000 000, slices of 64 KiB.
533. **Closing a container because its last item of one kind left** → moving the last conversation
     out of a panel closed it, and its running terminals with it. Ask whether the container holds
     anything else that goes with it (`closesEmptyPanel`).
534. **Two emulators answering one shell** → the headless model's `onData` answers cursor and
     device queries, as the view's xterm already does, and a second answer reaches the shell as
     typed input. A shadow emulator only reads; never subscribe to its replies.
535. **An asynchronous consumer outside flow control** → with no view attached the tab acknowledged
     output at once, so only the headless emulator's queue stood between a flood and memory, and at
     50 MB it throws "write data discarded". Its backlog is part of the pause rule (4 MB high, 1 MB
     low), and a throw from it degrades reads instead of reaching the shell's reader.
536. **A new tool filed under an Auto-able category by default** → every `ai-browser` tool used to be
     "AI Browser", so `terminal_send` would have run unasked under that Auto. Classify by an explicit
     list and file the rest under Other tools; a test fails on a registered tool nobody classified.
537. **An approval that only the client enforces** → a user `allow` rule, a hook or a CLI config can
     answer for the card, and the input goes through. The server mints a one-shot grant when the
     chat says yes and the tool refuses without one; a refusal before anything was typed refunds it.
538. **A banner inside a column that another view hides** → the Chrome pairing Allow/Deny lives in
     `.chat-main`, which a terminal in front hides, so the question could not be answered. Anything
     that waits on the user stays visible whatever is in front.
539. **Consent text narrower than the power it grants** → the website-terminal modal spoke of
     watching and typing into shared terminals and not of opening new shells on this computer, which
     the same consent allowed. The dialog names every capability it unlocks.
540. **Marking a message as told when it was not delivered** → the pin announcement was recorded as
     sent when `send` resolved `false`, so the agent never learned of its terminals. Undo the mark on
     every path where delivery did not happen, and only if no newer mark replaced it.
541. **A size set before the process exists** → a restart whose view attach landed while the new PTY
     was still spawning kept 80×24. Remember the last size the view reported and apply it to every
     process started afterwards.
542. **Focus requested before the state that makes it possible** → `focusInput` reached the view
     before the state that took the terminal out of the front, so the hidden xterm took the focus
     and the composer never got it. Post focus requests after the state they depend on.
543. **A rename that waits for the host's echo** → the tab showed the old name until the next state.
     Show the user's change at once and hold it until the state carries it.
544. **An assertion that cannot fail** → `assert.ok(x || true)` and a check on a value the test set
     itself passed whatever the code did, in two terminal tests. Read a new test's assertions for one
     that can actually fail.
545. **A build-time input under `dependencies`** → node-pty there made a bare `vsce package` pack 305
     raw `node_modules` files beside the staged copy, `spawn-helper` without its execute bit. Native
     code that is staged is a devDependency like everything bundled.
546. **A guard on a build constant that the bundler does not fold** → `typeof __TERMINAL__ !==
     'undefined' &&` and an early return left xterm in the unminified Chrome bundle; only a bare
     positive `if (__TERMINAL__)` is dropped, and a build without the define throws at startup.
547. **Importing a stylesheet from a script entry** → esbuild writes `<entry>.css`, so
     `import 'xterm.css'` in `chat.ts` would overwrite the checked-in `media/chat.css`. Give the
     stylesheet an entry of its own.
548. **A keyed label whose key misses a field** → the strip refills a terminal tab only when
     `terminalTabShown` changes, so a summary field left out of it never shows. Add every field a
     label draws to the string that decides when it is redrawn.
549. **Hand-made module maps in tests** → tests that load `chatTab.ts` through their own `require`
     map, or lift `chatView.ts` methods into a sandbox, failed on each new relative import
     (`./terminalPins`) or member (`_terminals`, `_focusInput`). #521 again: extend the map with the
     real module.
550. **Measuring a hidden tab for an animation** → a tab in the overflow dropdown measures 0 px, so a
     switch to it animated its width from nothing. `tabWidths` and `animateTabSwitch` skip `overflowed`
     tabs, and the overflow layout runs before the animation measures.
551. **An entry shown only while it works** → the website's "New terminal" existed only while a terminal
     could be started, and the default (setting off) left no entry and no reason, read as "the website
     cannot open terminals". A remote entry is disabled with the exact thing to enable, never hidden.
552. **A lifted method meeting a new module-level name** → the Chrome footer and clipboard tests lift
     `sidepanel.ts`'s `postMessage` into a sandbox, and its new `terminals.fromView` call threw
     `ReferenceError`. #521 again: give the sandbox the real `createRemoteTerminalShim`.
553. **A tool call in an assistant message with no matching tool result** → the OpenAI-format API refuses the whole next
     request, so a Stop pressed between a model's tool calls and their results broke the conversation for good. The
     OpenRouter session answers every call of the message, the unrun ones with "Stopped by the user." (#476's shape: a
     path that ends something must end what it left half done).
554. **An API key reachable from anything but the request** → the OpenRouter key is read from SecretStorage for each request
     and goes only into the `Authorization` header to a validated endpoint (https, or loopback http). A setting for the
     endpoint that a workspace could set, or one that accepted any http address, would send the key where a repository
     chose; it is `application`-scoped and `openrouterEndpoint` refuses the rest.
555. **A secret sent to a request that does not need it** → the model catalogue is public, so sending the API key with it
     would hand the key to whatever address `aiBrowser.chat.openrouterEndpoint` names for a request that answers without it. A request carries a credential only when the endpoint it goes to cannot answer without one.
556. **A section's select inside a panel whose Save sweeps every select** → `featureAiSaved` re-reads each `<select>` as an
     AI-feature choice and the section's reasoning select made it throw, leaving the panel in its saving state. A control
     that is not one of the panel's AI features marks itself (`data-appearance`) or lives outside the swept selectors.
557. **A bare `allow` replacing a CLI's own narrower rule** → OpenCode asks before reading `.env` files by default; our
     config set `read: 'allow'` and read them with no question (measured). Replace a rule with the same shape plus the
     exceptions, never with a wider one.
558. **A tool-path argument judged before the tool's own normalisation** → Pi strips a leading `@` and turns Unicode spaces
     into spaces before resolving, so `@/etc/hosts` read `/etc/hosts` while our inside-the-project test saw a relative name.
     Normalise the way the tool does before deciding (`piGateTool`); re-check the tool's path code on every update.
559. **A script runtime that is also a network client, outside the permission rules** → OpenCode's code-mode `execute`
     has `fetch`, and none of the permission keys tried gated it: the Internet category's Deny does not hold there (OPEN).
     Before trusting an approval menu for a new agent, probe each way it can reach the network, not only its named tools.
560. **A starting process that a Stop or an exit meets** → Pi's Stop during startup left the prompt pending (no `turnEnd`),
     its exit during startup reported twice, and `dispose` left the starting process running. A session's start is a state
     of its own: Stop ends the turn, an exit is reported once, dispose ends the process in its handshake.

## Special cases and non-obvious decisions

### Native page actions inspired by Stagehand

`src/browser/nativeActions.ts` independently implements the useful deterministic parts of
Stagehand's locator/input approach, without adding a production dependency, Chrome extension,
LLM client, or second agent. `TabSession` owns one `NativeActions`; `BrowserController` still
resolves the caller's allowed tab through `_withSession`. MCP exposes:

- `browser_click`: unique selector, native mouse events, optional `button`, `clickCount: 2`,
  `smooth` and `humanize`. Unlike the previous `el.click()`, covered/disabled/ambiguous targets fail.
- `browser_hover`: native pointer movement for hover menus; optional `smooth` and `humanize`.
- `browser_press`: focus a unique selector and send a key or shortcut (`Enter`, `Shift+Tab`,
  `Control+a`, `Meta+a`). Platform editing shortcuts include explicit CDP editing commands:
  on macOS, sending the modifier and key alone did not perform Select All in headless Chrome.
- `browser_type`: insert text at the caret/selection using `Input.insertText`; does not replace
  the whole value. Optional `humanize` sends native per-grapheme key events with varied pauses
  (up to 400 graphemes per call). Results never echo editable values. Chromium accepts at most
  four UTF-16 units in a keyboard event's text buffer, so longer graphemes such as joined emoji
  are inserted atomically with `Input.insertText` between their key-down/up events. No character
  is split into surrogate halves. Before each character, verify the same element still has focus;
  never refocus automatically after a page handler moved it somewhere else.
- `browser_drag`: native left-button drag between two selectors in the same frame, with smooth
  movement by default. Both endpoints must fit in its viewport. It does not synthesize HTML5
  DataTransfer payloads or auto-scroll while dragging; callers must check the resulting state.

The snapshot and action resolver support explicit `host >>> inner-selector` chains through
open and closed author shadow roots. `browser_fill` uses the same pinned-element resolver.
For each shadow boundary, `DOM.describeNode` supplies its backend root id and `DOM.resolveNode`
exposes that root in the selected frame's execution context; no attachShadow monkey-patch or
persistent page registry is needed. Browser-owned user-agent shadow roots are excluded.
Snapshot discovery describes only the selected document and does not recurse into iframe
documents; its internal DOM data is never returned directly. Resolved root objects are released
after metadata extraction. Ordinary CSS remains ordinary CSS;
`>>>` inside a quoted attribute or CSS function is not a shadow boundary. Snapshot traversal
is bounded at 150 entries, 200 roots and 20000 visited elements, with a `truncated` flag.
Editable content and field values are never used as snapshot labels, except button captions.

Pointer coordinates are computed in each frame's viewport and projected through the content
quad from `DOM.getBoxModel`, using an invertible projective transform. This handles scale,
rotation, skew, CSS zoom and perspective in nested and site-isolated frames. CDP quads already
include same-renderer ancestors, so apply a session's transform only when crossing into another
renderer; adding every frame offset again is wrong. Map back into each parent's local viewport
for hit-testing. Singular/edge-on transforms fail before mouse input.

An OOPIF's DOM geometry can update before the compositor routes input using its new transform.
Before pressing, verify a trusted native pointer move actually reached the pinned target with
a transient pointermove probe, retrying only movement (up to five attempts). Remove the probe
and release its object on every exit; never replay a press. An explicit sandbox without
allow-scripts cannot run that callback, so sample stable geometry from the host after a short
settling interval instead. This keeps native links usable in script-disabled frames without
waiting on sandboxed page timers. Same-renderer actions need no compositor probe.

Native actions serialize per tab session and use the existing scroll/screenshot gate. Each
operation has a 15-second budget (humanized typing scales up to 55 seconds), and each
CDP/readiness wait a 2.5-second bound. Remote element
objects are pinned for an action and released afterwards, so a rerender cannot silently
redirect input to a replacement node. Cancellation/errors release held keys or mouse buttons.
An issued mutation is never retried automatically; inspect the page before retrying after a
timeout. `smooth` interpolates pointer events over a bounded route; `humanize` uses a curved
route, varied movement timing and brief click/drag pauses. Humanized typing pauses longer at
word/punctuation boundaries. Both are optional, and neither adds deliberate typing mistakes,
moves the OS cursor, installs a visible cursor overlay, or guarantees human indistinguishability.

`nativeActions.test.ts` checks protocol sequences, cancellation, selector parsing and queueing.
The opt-in `nativeActions.browser.test.ts` launches a disposable headless Chrome with CDP pipes
and tests trusted events, transformed nested/site-isolated frames, open/closed shadow DOM,
Unicode editing, script-disabled frames and dragging:

```sh
AI_BROWSER_TEST_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test src/browser/nativeActions.browser.test.ts
```

The browser test uses a temporary profile; its cross-origin fixture listens only on loopback.
It does not touch the user's Chrome profile or expose a network debugging port.

- **Surface coordination after review:** all providers share one `GitAccess`; busy-folder
  checks enumerate every provider, so moving a running agent cannot bypass worktree locks.
  Project command discovery takes the requesting cwd/settings explicitly and caches lists and
  throttles by agent plus cwd; Codex skill items use the session's own project list. Transfers
  use replacement `setTabDraft`, prune departed background drafts and restart queue draining
  in the recipient (including the debounce between turns).
- **Hidden editors reserve ownership before deserialization.** `ChatPanelCatalog` persists
  panel identities and draft snapshots (its stored `highWater` is no longer used to number
  panels). The sidebar
  eagerly creates pending providers from it, without starting sessions or rendering webviews;
  serializers bind to those existing providers instead of reopening their conversations.
  A pending owner can supply its draft for Move here before it becomes visible. Show existing
  materializes its editor with public APIs in the old tab's group and closes the unrevived
  placeholder. Normal panel close removes its catalog entry; extension shutdown preserves it.
  Drafts are mirrored to the host as typed and flushed at shutdown, in addition to webview state.

- **Panel persistence and single ownership:** `aiBrowser.chat.window` has an explicit activation
  event and a `WebviewPanelSerializer`. The webview persists a stable panel UUID/number with
  every draft write; host tab snapshots use `openTabsKey + '.panel.' + UUID`, never the sidebar
  key. Restored panels keep their `AI Browser #N` name; VS Code restores their editor placement.
  Fresh chat ids, names, folders, order and selection come back from the snapshot, started
  conversations from history, and drafts from webview state. Requests interrupted by shutdown
  resume only on the next user message. The sidebar restores first; each subsequent restore
  skips conversations already owned by another provider (and repeated ids in its own snapshot).
  History opened in the main sidebar offers **Move here** or **Show in AI Browser #N** for a
  conversation already open elsewhere. Moving here first requests the source webview's draft,
  then rechecks ownership before moving the existing tab. Other history requests focus the
  existing owner rather than creating a second session. Explicitly closing the last source
  panel after a successful transfer leaves the moved session in its destination; the sidebar
  instead keeps a fresh tab. Panel disposal lets VS Code close an empty auxiliary window.

- **Chat surfaces are identified inside one extension host, not across full VS Code windows.**
  `ChatViewProvider._surfaces` lists live sidebar/panel views. Panels receive a stable creation
  number and a title such as `AI Browser #2`, also used for the actual editor/window title.
  **#1 is always the side bar, and a new panel takes the lowest free number from #2** (asked
  for: no counting upwards). `_freeSurfaceNumber` → `ChatPanelCatalog.freeNumber` treats a
  number as taken while a live panel or a saved one (kept for restore at shutdown) holds it, so
  a closed panel's number goes back into use; a restored panel keeps the number it had.
  State exposes those names, tab counts and folders for the tab context menu's move destinations.
  All surfaces in the host share agent and toolbar services, permitting a live `ChatTab` to move
  into an existing surface without disposing its backend. The target selects the moved tab and
  sends that state before restoring its draft; posting a draft first loses it in a ready view
  still showing another chat. The tab limit and duplicate-chat checks run before any mutation.
  Cross-webview drags carry only surface/tab ids and an opaque token; the source retains the
  draft and original chat id for up to two minutes. Accepted drops consume that pending drag.
  Independent full VS Code windows run other extension hosts and are not enumerated here.

- **Dragging chat tabs uses native drag events, without publishing a file or command URI.**
  Dropping over a tab reorders the existing `ChatTab` objects and persists that order.
  Releasing outside the chat never creates an editor or window. The main sidebar tab context
  menu offers Move to a new window and Move to a new tab before existing chat destinations.
  The editor opens in the active editor group; the extension does not select a group from
  the OS drag destination. Drafts and attached/live-page chips move with the tab. `moveTo`
  changes its host without closing its agent session. Providers sharing a moved session
  share reference-counted agent/toolbar services: closing the old surface must not dispose
  another surface's backend. The sidebar owns all panels' extension lifetime, not their
  immediately preceding surface. Pending launches, Git mutations and microphone recordings
  must settle before moving. Closing a moved tab still stops only that tab's work.

- **Popup placement must account for top-of-chat anchors.** `openAbove` flips below
  when there is insufficient room above and more below, and constrains tall menus
  to the available space. Always clear its previous inline height limit before measuring.
  Otherwise the New Chat menu above the tab strip is clipped by `#app`, leaving only a shadow.

- **The title-bar New Chat command offers Here in chat, In a new tab and In a new window.**
  The plus in the chat tab strip creates a local chat immediately beside the active tab.

- **Independent chat tabs are webview editors; chat-only windows use the same editors moved with `workbench.action.moveEditorToNewWindow`.**
  Check command availability before creating a panel. Each gets its own `ChatViewProvider`,
  fresh conversation and inherited working folder/repository context; it shares saved history
  but must not restore or overwrite the sidebar's `openTabsKey`. Attachment document schemes
  are unique per provider, and attachment actions focus their own panel. The panel retains its
  context while hidden; closing it disposes its provider, agents and any child chat windows.
  Detached providers do not control the sidebar's keep-awake context key. Video recording is
  unavailable there because the extension's recording destination/encoder belongs to the sidebar.
  These panels contain our chat UI, never the legacy browser iframe.

- **The liquid loader is generated, and it is an SVG inside the CSS.** `media/liquid-loader.css`
  is written by `node ./scripts/build-liquid-loader.mjs` — edit the script, never the file. The
  shape (a 40 s loop: circle at 0 s, a fluid six-rayed form, a rounded hexagon for core and shell
  at 16.8 s, held at neither, then the core shrinking into a 2 px dot — a non-scaling round-capped
  stroke, so twice the shell's line at every size — held 4 s, and growing back into the circle) cannot be drawn with `border-radius`, so it is a SMIL-animated SVG
  set as a `data:` background through `--liquid-loader-image` (core and shell) and
  `--liquid-core-image` (core alone, for the small status dots in `chat.css`). A `data:` URL keeps
  every surface on its plain `<span class="liquid-loader">` — the chat, the Chrome side panel and
  the Exchange website copy only the CSS — and is allowed by each CSP (`img-src data:`). SMIL
  rather than CSS `d:` animation because Safari, on the website, animates no CSS `d`. Reduced
  motion swaps both variables to the first frame, a still circle.
- **In a remote window this extension runs on the local machine, and the MCP features are
  refused there.** `extensionKind` is `["ui", "workspace"]`, inherited from upstream
  simple-browser, so a Remote-SSH, WSL or Dev Container window runs it in the local extension
  host — where the built-in browser is. Claude Code and Codex declare no `extensionKind` and run
  next to the workspace, on the remote, so the MCP server's `127.0.0.1` is unreachable for them.
  `hostIsRemote` / `workspaceIsRemoteFromHost` in [src/setup/proposedApi.ts](src/setup/proposedApi.ts) decide
  from `extension.extensionKind`, recorded at activation; Connect refuses with an explanation and
  Check Connection says why. Moving the extension to the remote (`workspace` first) would put the
  server beside the assistants, but whether the `browser` proposal and CDP work from a remote
  extension host is unmeasured — decide that on a real remote before changing the order.

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

- **The copied enum had to go, because Node runs the tests.** `npm test` runs
  `node --test` over every `*.test.ts`, relying on Node 24's native type stripping — the same
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

- **GitHub Copilot CLI as a chat agent** (`copilot --acp`, modelled on `geminiAgent.ts`). Built from the ACP specification and never measured: on the author's account an organisation policy disabled third-party MCP servers, so the browser tools could not reach it and no live run was possible. Removed rather than shipped unmeasured; the shape to redo it from is Gemini's ACP section, re-measured against a real install first.

- **The first remote terminal: a terminal manager behind the Chrome side panel and the Exchange
  relay.** Before the in-chat terminal tabs, a separate terminal was reachable from the Chrome side
  panel and from the website through relay endpoints of its own (`/ws/terminal-*`), with a manager
  in the extension handing out leases. It was never released, and it was removed in favour of the
  [terminal tabs](#terminal-tabs-a-real-shell-in-the-chat): one terminal in the chat, the same tab
  in the editor and — opted in, over the chat's own encrypted connection — on the website. A second
  transport meant a second set of gates, a second flow-control scheme and a second place for the
  consent to drift. Do not bring back a terminal channel beside the chat's. (The Chrome side panel
  built with `__TERMINAL__` false on purpose until 2026-10-27, when the user asked for terminals
  there; they now reach it through the chat's own bridge with the website's frames and gates — see
  [Remote terminals](#remote-terminals-on-the-exchange-website-and-in-chrome) — which is not this
  second channel.)

- **A left-hand (activity bar) copy of the chat for VS Code before 1.106.** Built, as Claude Code
  and Codex do, and removed on request: the chat lives in the secondary side bar only, and below
  1.106 there is none — the view is hidden by `aiBrowser.chatUnsupported` rather than left to fall
  into Explorer. See [The AI Browser chat](#the-ai-browser-chat).

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

**One file in the package is MPL-2.0** — `out/logins/loginFormScript.js`, compiled from the Firefox port.
Its source form ships beside it as `src/logins/loginFormScript.ts` (a `!` exception in `.vscodeignore`,
which otherwise drops `src/**`), which is what MPL §3.2(a) asks for, and
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) ships too. `package.json` declares
`MIT AND MPL-2.0`. Do not add `removeComments` to the tsconfig, and do not drop either file from
the package — `unzip -l tab-browser-ultimate.vsix | grep -E 'loginFormScript|THIRD'` should list
three entries (the source, the compiled file and the notices). Sourcemaps are not packaged
(`**/*.map` in `.vscodeignore`): about 5 MB, of use only for debugging a local build.

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
  [src/core/notify.ts](src/core/notify.ts).
- **Once per version, not once per window** (`aiBrowser.promo.offeredVersion`), plus a six-hour
  throttle on the request itself (`aiBrowser.promo.lastCheck`). A manual check ignores both.
- **The throttle is stamped only by a request that reached a registry.** Stamping before the
  fetch means a laptop whose first window of the day opens offline buys six hours of silence for
  every window after it. **A stamp in the future is due**, as the full build's `dueForCheck` has
  always said: a clock that moved back left the promo announcing a cached release for as long as
  the stamp stayed ahead (breaks-silently #224).
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
now carries its own watch, in [src/setup/updateCheck.ts](src/setup/updateCheck.ts), with the version
comparison split into the leaf [src/setup/updateVersion.ts](src/setup/updateVersion.ts) so `npm test` can
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
and the promo build were: `out/setup/updateCheck.js` loaded against a stubbed `vscode`, a stubbed
`fetch` and a stubbed `globalState`, printing what each state does — newer release, same version,
a repository that is *behind*, offline, already announced, inside the throttle, past it, the
setting off, each of the three buttons, a browser page in front and then the user looking away, a
browser tab visible in a *split* while a file is focused, a `version` carrying a Markdown command
link, a settings write that fails, an `openExternal` that fails, and a host with no browser
proposal. The promo build was re-checked the same way for the stand-down: it speaks for an
installed 0.5.23 and is silent for 0.5.24 and later. Worth redoing that way after touching this file; a typecheck
says nothing about which of those states puts a toast on screen.

### Both project config files are gitignored **in this repository**, and that is not a contradiction

Upstream's design is that a project commits `.mcp.json` and shares it with a team, and the
[Not built yet](#not-built-yet) entry on a stdio bridge is about exactly that trade-off. It
holds for a *consumer's* project. It does not hold here: this repository is public, and pressing
`Connect Claude Code` while working **on the extension itself** writes the workspace's bearer
token into the repository root — the only thing guarding a loopback server that can drive the
developer's browser. So `.mcp.json` is in `.gitignore` and in `.vscodeignore`, the second
because it was otherwise packaged into the VSIX as `extension/.mcp.json` and would have shipped
the token to everyone who installed it.

**A consumer's project gets the rule shipped to it, not written down for it.**
`writeCodexProjectConfig` drops a `.codex/.gitignore` naming `config.toml` on first creation —
the same move `assistants.ts` makes for `.ai-browser/`, and for the same reason: the extension
is what put the secret there. It names that one file rather than `*`, because `.codex/` is
Codex's own directory and may hold settings a team does want to share. See breaks-silently #155.

**The rule goes in before the token, and an existing `.gitignore` is read rather than trusted.**
Written after the config, a crash between the two left the token with nothing keeping it out of
`git add`; and an existing `.codex/.gitignore` ended the function whatever it said. Now
`keepTokenOutOfGit` runs first, and a file that does not ignore `config.toml` —
`ignoresConfigToml` in [src/mcp/gitignoreRule.ts](src/mcp/gitignoreRule.ts) (leaf, under test), read in
order with the last matching line winning, as git does — gets one line appended and nothing else
changed. A pattern it does not model reads as "not covered", which costs a redundant line rather
than a token in a commit. Breaks-silently #171.

**And the rule being in place is a condition of writing the token, not a courtesy.** When
`.codex/.gitignore` cannot be read or written, `git check-ignore` is asked whether something
else — a root `.gitignore`, `info/exclude` — already ignores `.codex/config.toml`. Only
"ignored" or "not a repository" lets the write go ahead; anything else, git missing included,
refuses and hands over `codex mcp add`. Breaks-silently #188.

**And git is asked even when the rule reads as in place.** `ignoresConfigToml` is a model of
git's matching, and it was wrong in the leaking direction twice: it trimmed leading spaces, which
git keeps as part of the pattern, and it treated only four literal negations as negations, so
`config.toml` followed by `!config.*` read as protective. It now reads every `!` line it cannot
model as re-including the file and strips trailing whitespace only — and a clean "not ignored"
from `git check-ignore` refuses the write regardless of what the model says. Breaks-silently
#196. **Trailing whitespace is trimmed the way git trims it**: unescaped spaces only
(`trim_trailing_spaces` in git's `dir.c`). Stripping `[ \t]+` read `config.toml<TAB>` as covered
while `git check-ignore` answers "not ignored", the leaking direction; a tab stays part of the
pattern, and `config.toml\ ` keeps its escaped space and names another file. Measured with git
2.54.

**A `.gitignore` does nothing for a file git already tracks**, and teams do commit
`.codex/config.toml` for shared settings. So `writeCodexProjectConfig` asks
`git ls-files --error-unmatch` first and **refuses** a tracked file — `connectCodex` then reports
why and hands over `codex mcp add`, which does not touch the repository. Warning after the write
would be too late: the token is already in the working tree of a tracked file. Anything short of
a clean "tracked" (git missing, not a repository, a timeout) reads as untracked, since this is a
precaution and refusing a connection on a guess is the wrong direction. Breaks-silently #160.

**Connect Codex refuses in Restricted Mode, because everything above runs git.** `git ls-files`
and `git check-ignore` both read the index, and reading the index runs the repository's own
`core.fsmonitor` command — so a folder opened untrusted, carrying its own `.git/config` (an
extracted archive, a shared folder; a clone does not carry one), ran arbitrary code on one click.
Reproduced with git 2.54. VS Code's own Git extension is disabled in Restricted Mode for this
reason; the manifest now declares `untrustedWorkspaces: "limited"` with a description, and
`writeCodexProjectConfig` throws before any git call, which hands over `codex mcp add`. A trusted
workspace runs git as before: trusting a folder is the consent this asks for (breaks-silently
#208).

**And a symlink inside the workspace refuses the write.** `writeFileAtomic` follows links on
purpose, for a dotfiles user's linked `~/.codex/config.toml` — and every connect writer goes
through it, so a repository committing `.codex/.gitignore -> ../../../.ssh/config` had
`config.toml` appended to the user's ssh config on Connect Codex, before any check could refuse
the token write. Reproduced against `~/.zshrc`, `~/.gitconfig` and a dangling target. A linked
`.mcp.json` merged our entry into whatever JSON file it named, `~/.claude.json` included, and a
linked `.codex/config.toml` sent the bearer token there. `refuseWorkspaceLink` checks `.mcp.json`,
`.codex`, `.codex/config.toml` and `.codex/.gitignore` with `lstat` before either connect
writes; the global config, outside any repository, is still followed (breaks-silently #209).
The unattended repair is left following links: it changes only entries that already carry this
workspace's token, which a repository cannot know.

**Exit code 128 is not "no repository" by itself.** It is git's code for every fatal error —
"detected dubious ownership", a path "beyond a symbolic link" — and reading all of them as
"nothing here can commit the file" let the token write go ahead where git had merely declined
to answer. `gitIgnoreVerdict` reads `noRepository` only from the "not a git repository" message,
with `LC_ALL=C` so a translated git says it in English.

**Which `git` runs matters on macOS**, where `/usr/bin/git` without the Command Line Tools opens
a system dialog offering to install them. `gitBinary` takes the path VS Code's Git extension
already resolved when it is active, then a `git` on an absolute `PATH` entry outside `/usr/bin`,
then `/usr/bin/git` only if `xcode-select -p` succeeds — the guard the Git extension itself uses —
and otherwise skips the check. Breaks-silently #172. Elsewhere it is the first `git` (`git.exe`)
on an absolute `PATH` entry, by its absolute path, or nothing (#448).

**A workspace opened at `~` makes the project and global Codex configs one file**
(`codexProjectIsGlobal`), and every path that treated them as two went wrong: Connect wrote the
entry and `removeCodexGlobalEntry` removed it again as a "duplicate"; the repair renamed it to
the per-project global name and back on every start; `Check Connection` read the file twice. On
that shape Connect skips the removal, the repair makes one pass over the global file under the
bare `ai-browser` name, the check reads it once, and the writer locks it under the global URI so
it takes the repair's lock. Breaks-silently #157.

**`.gemini/` is in both as well, and was missing from them once**: Connect Gemini CLI pressed in
this repository wrote `.gemini/settings.json`, its own `.gemini/.gitignore` kept `git status`
clean, and `npm run package` put the token into the VSIX (breaks-silently #75, a fourth time).

**`.codex/` is in both of *this* repository's ignore files for the same reason, and it had to be
added when Connect Codex moved to the project file.** It writes `.codex/config.toml` with the same bearer token, and that path was
not ignored — so the move quietly created a second copy of exactly the hazard this section
exists for, in a repository where `Connect Codex` is pressed during development. Any future
writer that puts a token inside the workspace needs the same two lines; the rule is not about
`.mcp.json`, it is about the token. Found by review while the file was staged and not yet
committed, so nothing leaked; if it ever does reach a commit, rotating the token is not enough
on its own — the token is the identity `repairConfigs` matches on, so every config naming this
window stops being recognisable at the same moment (see
[The port moves](#the-port-moves-and-the-config-remembers-the-old-one)).

## Known issues, not yet fixed

- **A process squatting on a configured port receives the bearer token.** Clients send
  `Authorization: Bearer <token>` to whatever listens on the port in `.mcp.json` /
  `.codex/config.toml`, and the token never rotates. Another local user who holds that port while
  the window is closed (a terminal `claude` started before VS Code, a window reloading) captures
  it, and can then drive the real server on its own port — loopback is reachable by every local
  user. Reproduced by review: captured on the configured port, replayed with `200` on the next
  one. Rotating the token is not the fix: it is the identity the startup repair matches on (rule
  3 of the security model). The fix is the stdio bridge under [Not built yet](#not-built-yet),
  which takes the token out of the config and the port out of the client, or a Unix socket in a
  `0700` directory. Multi-user machines only; the same threat model as the lock-file entry below.

- **Lock files sit at a predictable path in `os.tmpdir()`** (`fileLock.ts`), so on a
  multi-user Linux machine another local user can pre-create one and block every config write
  there until it is removed — denial of service, not corruption. Not moved yet because the
  obvious homes each cost something: the per-user `0700` directory falls back to a *per-process*
  `mkdtemp` when it cannot be trusted, which would silently give each window its own lock, and
  a lock beside the config puts a transient file inside the user's project.

- **No linter.** It was covered by shared infrastructure in the monorepo. There are tests:
  `npm test` runs Node's own runner over every `*.test.ts` in `preview-src/` and `src/`, no VS
  Code needed.
- **Zero production dependencies, and it is worth keeping it that way.** `build-ext` is `tsc`
  without bundling, so `out/` contains no dependencies. `vsce` will pack `dependencies` into
  the VSIX automatically, but once heavy runtime dependencies appear, the right move is to
  bundle the extension host with esbuild.
- **npm 11 blocks postinstall scripts.** `esbuild` has one, hence the `allowScripts` block in
  `package.json`. After an esbuild version bump the approval has to be granted again
  (`npm install-scripts approve esbuild`), otherwise the binary is not installed.
