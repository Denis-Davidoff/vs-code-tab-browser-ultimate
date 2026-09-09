# AI Browser

Element inspection tools for VS Code's built-in browser: pick an element on the page and copy
its full context, its XPath, or its CSS path.

Pages open in VS Code's built-in browser, and the extension drives it over the Chrome DevTools
Protocol. It also carries its own webview panel with an address bar and navigation controls,
kept for anyone who wants it — set `aiBrowser.useIntegratedBrowser` to `false`.

> Uses the `browser` and `externalUriOpener` API proposals, so it installs from a VSIX rather
> than the Marketplace, and needs a VS Code recent enough to provide them.

## Copying element info

Open a page in the built-in browser, then use either the **AI Browser** panel in the activity
bar or the crosshair button on the browser tab's toolbar. The button repeats whichever action
you used last; the chevron beside it opens the full list. Hover highlights elements the way
DevTools does — click one and the result is yours.

| Action | Result |
|---|---|
| Copy Element | the full context as Markdown — element, URL, HTML path, outer HTML, dimensions, matched CSS |
| Copy XPath | `//*[@id="main"]/span`, or `/html/body/ul/li[2]` when nothing stable can anchor it |
| Copy CSS Path | `#main > div > li:nth-of-type(2)` |

**Copy Element** runs to several kilobytes, mostly matched CSS — it all goes to the clipboard
as Markdown.

The output matches what the built-in browser attaches for its own "Add Element to Chat", because
the CSS assembly is the same upstream code.

## Commands

| Command | Id |
|---|---|
| AI Browser: Copy Element | `aiBrowser.copyElement` |
| AI Browser: Copy Element XPath | `aiBrowser.copyElementXPath` |
| AI Browser: Copy CSS Path | `aiBrowser.copyElementCssPath` |
| AI Browser: Show | `aiBrowser.show` |

## Settings

| Setting | Default | Description |
|---|---|---|
| `aiBrowser.useIntegratedBrowser` | `true` | Open URLs in VS Code's built-in browser. Set to `false` for the extension's own webview panel. |
| `aiBrowser.searchEngine` | `google` | Engine used when the panel's address bar gets a search term. `none` disables search. |
| `aiBrowser.focusLockIndicator.enabled` | `true` | Show the floating indicator that appears while focus is inside the webview panel. |

## Use from another extension

The panel is primarily meant to be driven by other extensions:

```ts
await vscode.commands.executeCommand('aiBrowser.api.open', vscode.Uri.parse('http://localhost:3000'), {
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: true,
});
```

The extension also registers an external URI opener for `http` and `https`, so localhost URLs
surfaced by VS Code (for example from a forwarded port) can be opened in the panel.

## Packaging

```sh
npm run package     # -> ai-browser.vsix
```

Install it with **Extensions: Install from VSIX…**.

## Development

Requires Node.js 24 or newer.

```sh
npm install
npm run compile      # build both the extension host and the webview
npm run watch        # incremental rebuild of everything
npm run typecheck    # type-check both projects without emitting
```

Press <kbd>F5</kbd> to launch an Extension Development Host. `npm run watch` can run in a
terminal at the same time; F5 only needs to be pressed again to reload the host.

This extension uses the proposed `externalUriOpener` API, so it must be launched with
`--enable-proposed-api=DenysDavydov.ai-browser` — already configured in `.vscode/launch.json`.
The proposed API declaration file is checked in; refresh it with `npm run download-api`.

See [CLAUDE.md](CLAUDE.md) for the full architecture notes and build details.

## License

MIT
