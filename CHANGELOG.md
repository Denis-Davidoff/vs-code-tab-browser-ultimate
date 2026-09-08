# Changelog

## Unreleased

- **Local html files.** "Open in AI Browser" from the explorer's context menu, the editor tab
  and the command palette; a file browser over the project's own pages in the sidebar, next to
  "Open a file…"; and a path typed or pasted into the address bar. The file is served from the
  folder it belongs to — nothing outside it is reachable — so the picker, the console, the
  reports and the mcp tools work on it like on any other page. Saving the file, or anything it
  pulled in, reloads the panel (`tabBrowser.files.reloadOnChange`).

- **A context menu in the page.** A right-click opens the copy menu's element entries for the
  element under the cursor — report, XPath or CSS path, to the clipboard or to an assistant —
  plus **Inspect element**, which opens the editor's developer tools. The element is outlined
  while the menu is open. A page with a context menu of its own keeps it, and
  `tabBrowser.contextMenu.enabled` turns the whole thing off.

## 0.3.4

- Both connect dialogs can copy a **connection prompt**: the server's address, the command that
  adds it and a check to run afterwards, written for the assistant to act on.
- README: a short "Connecting an assistant" section with the routes side by side.

## 0.3.0

- A view in the activity bar: the page the panel has open, the copy menu's entries, the mcp
  server's state with the two connect commands, and the pages this project has visited.
- **Check MCP Connection**: one real request to the server, plus a read of the three client
  configurations, to see which of them would actually reach this window — the endpoint, the
  token (it is per workspace, so another project's config answers 401) and whether the entry is
  switched on at all.
- **Copy MCP Server URL**, for clients this extension cannot configure itself.

## 0.2.1 — 2026-09-07

First release on the Visual Studio Marketplace and Open VSX.

- Browser tab in the editor, with the page served through a local instrumenting proxy so its
  content can be read from the webview.
- Copy menu: full element report, XPath or CSS selector, and the page's console output — to the
  clipboard, to Claude Code, or to Codex.
- MCP server on the loopback interface, so an assistant can read and drive the panel. Commands
  configure VS Code's chat, Claude Code (`.mcp.json`) and Codex (project or global
  `config.toml`); an unparsable config is left alone rather than overwritten.
- Terminal links: `Cmd`/`Ctrl` + click opens localhost urls in the panel
  (`tabBrowser.terminalLinks.mode`).
- Page favicon on the panel's tab (`tabBrowser.showPageIcon`).
- Per-session cookie prefixing, so dev servers on different ports no longer share cookies.
