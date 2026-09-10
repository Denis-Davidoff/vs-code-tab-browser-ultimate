# Changelog

## 0.5.14

The listing now says what it is from the status bar, not only in a toast that can be missed.

- **Install AI Browser** in the status bar — opens a dialog with three version numbers (this
  listing, the latest full build on Open VSX, the full build installed here) and the download.
  It reads **Update AI Browser x.y.z** when the installed build is behind, and disappears
  entirely once the full build is installed and current.
- **AI Browser: Install the Full Build…** is the same dialog from the Command Palette.
- The welcome notice is now shown once per released version of this listing rather than once
  per machine, so installing it always introduces it. It waits ten seconds after startup, since
  a notification pauses a restored browser tab.

## 0.5.11

This entry now watches for new releases of the full build. A VSIX installed by hand never
updates itself, and nothing else would tell you a version is out.

- **AI Browser: Check for Updates** — asks Open VSX, falling back to the repository.
- The check also runs on its own, at most once every six hours, and only speaks up when a
  release is newer than the one installed. Each version is offered once.
- Anything that is not an available update goes to the status bar instead of a notification.

## 0.5.2

The guide for AI Browser on the Marketplace: readme, screenshots and the download for the full
build, which ships as a VSIX because it is built on VS Code API proposals the Marketplace does
not accept.

- **AI Browser: Download the Full Build (VSIX)** — opens the download.
- **AI Browser: Open the Guide** — opens the documentation.

Both commands, and the one-time welcome, disappear once the full build is installed.

The full build, with the browser tab, the element tools, screenshots and the MCP server, is
[in the repository](https://github.com/Denis-Davidoff/vs-code-tab-browser-ultimate) and on
[Open VSX](https://open-vsx.org/extension/DenysDavydov/tab-browser-ultimate).
