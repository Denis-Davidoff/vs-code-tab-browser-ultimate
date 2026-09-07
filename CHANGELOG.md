# Changelog

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
