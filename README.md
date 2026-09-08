# AI Browser

Displays web content inside VS Code, using an iframe embedded in a webview panel. The panel
provides its own address bar, back/forward/reload controls, and a button to open the current
page in the system browser.

If VS Code's built-in browser is available (the `workbench.action.browser.open` command), the
extension delegates to it instead of opening its own panel.

## Commands

| Command | Id |
|---|---|
| AI Browser: Show | `aiBrowser.show` |

## Settings

| Setting | Default | Description |
|---|---|---|
| `aiBrowser.focusLockIndicator.enabled` | `true` | Show the floating indicator that appears while focus is inside the browser panel. |

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
