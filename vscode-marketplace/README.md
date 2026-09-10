# 🚀 First integrated browser for VS Code editor with Claude Code and Codex support 🎆

**VS Code's own browser tab, wired to your AI assistant: click an element and it becomes a
prompt, or hand the whole browser over and let the agent drive it.**

## ⚠️ Important: enable the browser API

VS Code only hands a proposed API to an extension that was named on the command line, so after
installing the full extension (see below) the browser features stay unavailable until you turn
the API on. It takes one click:

1. Click the orange **Enable Browser API** button in the status bar — or open the Command
   Palette (**`Cmd+Shift+P`** / **`Ctrl+Shift+P`**) and run
   **AI Browser: Enable Integrated Browser API**.
2. Choose **Quit** when it offers to.

The extension adds itself to `enable-proposed-api` in your `argv.json`, keeping the file's
comments and anything already listed there. The button then disappears — while a restart is
still pending it reads **Restart to finish**. Any element command run before then says so in the
status bar and points at the same button.

A permanent **AI Browser** button stays in the status bar: clicking it opens a menu with Open
URL, Open File, Connect Claude Code, Connect Codex, Check Connection and Settings.

**A full quit is required — Reload Window is not enough**, because `argv.json` is only read when
the process starts.

Prefer to do it by hand? Run **Preferences: Configure Runtime Arguments** from the Command
Palette and add this property inside the existing `{ ... }`, appending to the array if it is
already there:

```json
"enable-proposed-api": ["DenysDavydov.tab-browser-ultimate"]
```

Without this, browser features fail with `CANNOT use API proposal: browser`.

**This step is not enough on every editor.** Enabling proposed APIs only grants what the editor
*has*, and some forks ship no `browser` API at all — on those, nothing here can help, and the
webview panel is what works instead (set `aiBrowser.useIntegratedBrowser` to `false` and run
**AI Browser: Show**). The table below says which is which.

[![AI Browser in action](https://raw.githubusercontent.com/Denis-Davidoff/vs-code-tab-browser-ultimate/main/ai-browser-instruct.jpg)](https://raw.githubusercontent.com/Denis-Davidoff/vs-code-tab-browser-ultimate/main/ai-browser-instruct.jpg)

---

## 📦 Install, and which editors it works on

This Marketplace entry is the guide. The working extension ships as a **VSIX** and on **Open
VSX**, because it is built on VS Code API proposals and the Marketplace does not accept those.

**Measured by reading the shipped builds on 2026-09-09**, ordered by how much work each one
takes:

| Editor | Tested | Browser features | How to install | Then |
|---|---|---|---|---|
| **VSCodium** | 1.135 | ✅ yes | Open VSX, one click | Enable Browser API, quit and reopen |
| **Devin** | 1.126 | ✅ yes | Open VSX, one click | Enable Browser API, quit and reopen |
| **VS Code** | 1.137 | ✅ yes | **the `.vsix` by hand** | Enable Browser API, quit and reopen |
| **Cursor** | 3.19.19 | ❌ no | — | nothing helps — the API is absent |
| **Antigravity IDE** | 1.107 | ❌ no | — | nothing helps — base predates the API |
| **Kiro** | 1.0.437 | ❌ no | — | nothing helps — has the browser, not the API |
| **Trae** | 1.107.1 | ❌ no | — | nothing helps — base predates the API |
| **Theia IDE** | 1.75 | ❌ no | — | nothing helps — not a VS Code build |

**On VS Code:**
**[⬇️ download tab-browser-ultimate.vsix](https://github.com/Denis-Davidoff/vs-code-tab-browser-ultimate/raw/main/tab-browser-ultimate.vsix)**
→ press `Cmd`/`Ctrl` + `Shift` + `P` → **Extensions: Install from VSIX…** → pick the file. There
is no one-click route here, and it is not an oversight: VS Code's gallery *is* this Marketplace,
and it rejects any extension declaring API proposals — which is exactly what the browser
features are built on.

**Everywhere else:** install from
**[Open VSX](https://open-vsx.org/extension/DenysDavydov/tab-browser-ultimate)** in one click —
directly on VSCodium, through a mirror on Devin. Note that *installing* and *working* are
different questions: Open VSX will happily install this on Cursor, where the browser features
can never run. The `.vsix` works on any of them too, if you prefer it.

Once the full build is in, this entry stops advertising itself — but keep it, because it has a
second job: **it tells you when a new version is released.** A VSIX installed by hand never
updates itself, and neither VS Code nor Open VSX will say a word about it. This one checks for
you, at most every few hours, and stays silent unless there is something newer than what you
have.

> The browser features need **VS Code 1.112 or later** — that is where the editor's own browser
> tab and its `browser` API proposal exist, and a fork's own version number does not tell you
> (Cursor reports a 1.128 base and still lacks it). On an editor without it the extension still
> loads and falls back to its webview panel.

<!--
  🎥 VIDEO SLOT — fill this in when the recording is up, then delete these comment markers.
  The Marketplace strips <iframe> and <video>, so a video is always a still image that links out:

  [![Watch the tour](https://raw.githubusercontent.com/Denis-Davidoff/vs-code-tab-browser-ultimate/main/marketplace/assets/video-thumbnail.png)](https://www.youtube.com/watch?v=VIDEO_ID)

  An animated GIF under ~10 MB also plays inline and needs no click:

  ![AI Browser tour](https://raw.githubusercontent.com/Denis-Davidoff/vs-code-tab-browser-ultimate/main/marketplace/assets/tour.gif)
-->

---

## What it does

Front-end work is a loop: look at the page, find the element, describe it to the assistant,
check what changed. Screenshots lose the markup, hand-copied class names go stale, and a
headless browser opens a session you are not logged into. This extension closes the loop inside
the editor: the page you are looking at is the page your agent reads and drives.

- 🌐 **VS Code's built-in browser, not a webview approximation.** Pages open in the editor's own
  browser editor — a real Chromium tab with history, find in page, page zoom, DevTools and
  working keyboard shortcuts. The extension attaches to it over the Chrome DevTools Protocol,
  the same channel the editor uses for its own browser features.
- 🎯 **Click an element, get the whole story.** One pick returns a report: what the element is,
  where it sits in the html, its outer markup, its box, and the css that actually applies to it
  — matched rules in cascade order, inherited rules, resolved values and css variables. Hover
  highlighting comes from the DevTools overlay, so picking feels like the inspector.
- 📍 **Or just its address.** A CSS selector or an XPath, built to survive the next rebuild: the
  XPath anchors on a unique `id` when there is one and adds a positional predicate only where a
  tag really repeats; the selector deliberately leaves utility class names out.
- ✨ **One click turns it into a prompt.** Send the element, its selector or its path straight
  into Claude Code or Codex as a file their agent reads — so "make this button match the one
  above" is a sentence, not a paragraph of description.
- 📸 **Screenshots that paste as pictures.** The visible area or the whole scrollable page, on
  the system clipboard as a real PNG — `Cmd`/`Ctrl` + `V` into a chat, an issue or a document.
- ⌨️ **One key repeats what you did last.** The toolbar's right-hand button and
  `Cmd`/`Ctrl` + `Alt` + `C` both run the action you used last, whichever of the nine it was.
- 🔌 **An MCP server, with nothing to install.** No package, no separate process to babysit: the
  extension starts a local server on activation, and one command configures Claude Code, Codex
  or VS Code's own chat to use it.
- 🤖 **Then the agent drives the page itself.** Twelve tools: snapshot what is clickable, read
  the html or the text, inspect an element, click, fill fields, wait for a render, screenshot,
  navigate — then read the console to see what its own change actually did.
- 👀 **In your session, not a fresh one.** Same cookies, same dev server, same logged-in state,
  already past the auth wall you passed this morning. You watch every step happen in the tab and
  can take the mouse back at any point.
- 🔒 **Local by construction.** Loopback only, a bearer token per workspace, and any request
  carrying an `Origin` header refused before its credentials are looked at.

## Getting started, once the VSIX is in

1. `Cmd`/`Ctrl` + `Shift` + `P` → **AI Browser: Show** → type a url.
2. The globe button on the browser tab opens everything the extension does.
3. To let an assistant drive the page: same dropdown → **Connect Claude Code** or
   **Connect Codex**, then restart Claude Code / start a new Codex conversation, because
   neither re-reads its config while running.

## What this build does

It is the listing, and it is the update watch — the second half is the reason to keep it
installed:

| Command | |
|---|---|
| **AI Browser: Check for Updates** | asks Open VSX for the latest release, right now |
| **AI Browser: Download the Full Build (VSIX)** | opens the download |
| **AI Browser: Open the Guide** | opens the documentation |

**The update watch** runs on its own once the full build is installed: it asks Open VSX (and
falls back to the repository) at most once every six hours, compares the answer with the version
you have, and only then says anything. Each release is offered once, not once per window, and
the offer opens the `.vsix` for that exact version. Everything that is not an available update —
"you are up to date", "could not reach the registry" — goes to the status bar rather than a
notification.

It says hello once, the first time it starts, and never again. Before the full build is
installed the two listing commands are in the Command Palette; afterwards they hide themselves
and only **Check for Updates** remains.

## Links

- 📖 **[Full documentation](https://github.com/Denis-Davidoff/vs-code-tab-browser-ultimate#readme)**
- 🐞 **[Issues](https://github.com/Denis-Davidoff/vs-code-tab-browser-ultimate/issues)**
- 🧩 **[Open VSX listing](https://open-vsx.org/extension/DenysDavydov/tab-browser-ultimate)** — the full build

### Another extension worth having

**Task & Script Explorer** —
[Marketplace](https://marketplace.visualstudio.com/items?itemName=DenysDavydov.task-runner-ultimate)
·
[Open VSX](https://open-vsx.org/extension/DenysDavydov/task-runner-ultimate)

## License

MIT. Parts of the full build are forked from
[microsoft/vscode](https://github.com/microsoft/vscode) and carry Microsoft's copyright
alongside this project's.
