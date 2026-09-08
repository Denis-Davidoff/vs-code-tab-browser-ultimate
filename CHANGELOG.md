# Changelog

## Unreleased

- **Fixed: cookies were not stored at all in the panel**, so a login could never be completed.
  The panel's page is a frame in the editor's webview, which makes it a third party in another
  site as far as the browser is concerned — and there a cookie without `SameSite=None; Secure`
  is not withheld from the next request, it is never stored. Every cookie the proxy forwards now
  carries what a framed page needs; `Secure` costs nothing over `http://127.0.0.1`.
- **A session now survives a restart.** The namespace the proxy gives a site's cookies came from
  the port it happened to get, and the port is different next time; it is derived from the site
  itself now.

- **Fixed: a page that freezes its own globals no longer loses the whole agent.** The injected
  script patches `console`, `document.cookie`, `fetch`, `XMLHttpRequest.open` and `sendBeacon`,
  and those run before everything else — so on a page that had frozen one of them the
  assignment threw and took the shortcuts, the picker, the console and every mcp tool with it.
  Each patch is now installed on its own; one that will not take costs only itself.

- **Fixed: a login could not go through** for a page that asks for its own api by absolute url —
  what a build makes of `AUTH_URL` or `NEXT_PUBLIC_API_URL`. Such a request left the proxy: cors
  blocked it, the `SameSite` cookie carrying the csrf token was not sent with it (`127.0.0.1`
  and `localhost` are different sites), and the proxy never saw it, so the session's cookie
  names were not translated back. The injected script now keeps those requests on the origin the
  page was served from; a request to any other origin is left alone.
- New `tabBrowser.proxy.log`: one line per proxied request — method, path, status and the cookie
  names forwarded upstream — for the one question the panel cannot otherwise answer, which is
  whether a request went through the proxy at all.

- Fixed missing ICO favicons on browser tabs: cached icons now live in extension global
  storage, where VS Code permits loading this format, including icons of local documents.

- Fixed page zoom inside cross-site frames: menu commands, keyboard shortcuts and pinch or
  modified scrolling now scale the visible contents along with the page's layout viewport.

- A subresource that fails to load no longer raises a banner over the page — a dev server
  rebuilding answers 404 for a chunk for a second or two. It is still recorded in the console,
  where a browser records it too, so nothing is lost from the copy menu or the mcp tools.
- The panel's dead ends — a server that is not running, a path outside the folder a local page
  is served from — are shown as a card in the middle of the panel instead of bare text.
- The sidebar's sections are now **Navigation**, **Tools** and **MCP**, and the folder browser
  is gone: **Open a file…** already lists the project's pages.

- **Undo, redo, cut, copy, paste and select all reach the page**, from the toolbar's menu: the editor
  answers those keys on the panel's own document, one frame above the page, so in the page
  nothing happened at all. The clipboard is read by the extension, never by the page. The framed
  page is also handed the clipboard permissions the editor gives the panel, so a page's own copy
  button works.
- **Fixed: the extension no longer binds any keys of the editor's own.** A keybinding for
  `Cmd`/`Ctrl` + `C`, `V`, `X`, `A` scoped to a focused browser panel took copy and paste out of
  the rest of the editor; the zoom and new-tab keys were bound the same way and are now
  forwarded by the injected script instead, which is what hears them in the page anyway.

- **A toolbar menu, zoom and a completing address bar.** The button at the right of the toolbar
  opens **New tab** (`Cmd`/`Ctrl` + `T`) and **Zoom in / out / reset** (`Cmd`/`Ctrl` + `+`, `-`,
  `0`); zoom also answers a pinch on the trackpad and `Cmd`/`Ctrl` + scroll, and is remembered
  per panel. The address bar completes the pages this project's panel has been on — ordered by
  how well they answer what was typed, then by how recently they were open — with `↓`/`↑` and
  `Enter`. "New tab" opens a second browser panel; commands, the sidebar and the mcp tools act
  on the one last looked at.

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
