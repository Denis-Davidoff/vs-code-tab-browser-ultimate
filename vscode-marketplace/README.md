# 🚀 First integrated browser for VS Code editor with Claude Code and Codex support 🎆

**VS Code's own browser tab, wired to your AI assistant: click an element and it becomes a
prompt, or hand the whole browser over and let the agent drive it.**

## ⚠️ Important: enable the browser API

After installing the full extension (see below), **fully quit VS Code** and run this command
in your terminal to allow the extension to use the proposed browser API:

```sh
code --enable-proposed-api DenysDavydov.tab-browser-ultimate
```

Without this permission, browser features may fail with `CANNOT use API proposal: browser`.

Alternatively, enable it permanently through VS Code (this also works if your terminal
does not recognize `code`):

1. Press **`Cmd+Shift+P` on macOS** or **`Ctrl+Shift+P` on Windows/Linux** to open the Command Palette.
2. Search for **Preferences: Configure Runtime Arguments** and select it.
3. In the `argv.json` file that opens, add the following property inside the existing `{ ... }`:

```json
"enable-proposed-api": ["DenysDavydov.tab-browser-ultimate"]
```

If the property already exists, append the extension ID to its array. Then fully quit and
reopen VS Code; **Reload Window is not enough**.

![AI Browser in action](https://raw.githubusercontent.com/Denis-Davidoff/vs-code-tab-browser-ultimate/main/demo.png)

---

## 📦 One step to install

This Marketplace entry is the guide. The working extension ships as a **VSIX**, because it is
built on VS Code API proposals and the Marketplace does not accept those.

**[⬇️ Download tab-browser-ultimate.vsix](https://github.com/Denis-Davidoff/vs-code-tab-browser-ultimate/raw/main/tab-browser-ultimate.vsix)**
→ in VS Code press `Cmd`/`Ctrl` + `Shift` + `P` → **Extensions: Install from VSIX…** → pick the
file.

Or install straight from
**[Open VSX](https://open-vsx.org/extension/DenysDavydov/tab-browser-ultimate)**, which carries
the full build in one click (Cursor, Windsurf, VSCodium and anything else on that registry).

Once the full build is in, this entry has done its job — it goes quiet on its own, and you can
uninstall it whenever you like.

> The browser features need **VS Code 1.112 or later** — that is where the editor's own browser
> tab and its `browser` API proposal exist. On an older editor the extension still loads and
> falls back to its webview panel.

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

Two commands, and that is the whole of it:

| Command | |
|---|---|
| **AI Browser: Download the Full Build (VSIX)** | opens the download |
| **AI Browser: Open the Guide** | opens the documentation |

It says hello once, the first time it starts, and never again — and not at all if the full build
is already installed, in which case both commands hide themselves too.

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
