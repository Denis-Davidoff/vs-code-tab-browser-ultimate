# Publishing

**One registry: Open VSX.** The VS Code Marketplace refuses an extension that declares
`enabledApiProposals`, and this one declares two (`externalUriOpener`, `browser`) — so there is
deliberately no `publish` script for it. VS Code users install the committed
`tab-browser-ultimate.vsix`; every other editor gets it from
[Open VSX](https://open-vsx.org/extension/DenysDavydov/tab-browser-ultimate).

```sh
npm run package        # -> tab-browser-ultimate.vsix (compiles first, via vscode:prepublish)
npm run publish:ovsx   # uploads that exact file  (needs OVSX_PAT)
```

`publish:ovsx` names the `.vsix` on purpose rather than letting `ovsx` package the folder
itself: the artifact that reaches the registry is then the same bytes as the one committed to
the repository, which is what VS Code users install.

## This is not a first publish

`DenysDavydov.tab-browser-ultimate` **is already live on Open VSX**, and has been since before
this rewrite: fourteen versions up to **0.3.17**, published 2026-09-08, ~1.5k downloads. Those
users are running the *previous* implementation — the local proxy, the injected page script, the
sidebar, the in-page context menu. A publish from this repository replaces that build for every
one of them, and the two are not feature-equal in either direction. Read
[What an update actually does to existing users](#what-an-update-actually-does-to-existing-users)
before shipping one.

The setup is therefore already done and does not need repeating:

- **The token** lives in `OVSX_PAT` (from https://open-vsx.org/user-settings/tokens). `ovsx`
  reads it from the environment, so nothing is passed on the command line. Confirm it with
  `npm run verify-pat`, which answers `PAT valid to publish at DenysDavydov`.
- **The namespace exists.** `npx ovsx create-namespace DenysDavydov` is a one-time step that has
  already happened; running it again is harmless but pointless.

## Every release

1. **Bump `version` in `package.json`** — the registry refuses a version it already has (the
   published set is 0.3.1 … 0.3.17, and this repository is at 0.5.0), and `--skip-duplicate`
   only makes that failure quiet, not a new release.
2. `npm run compile && npm run typecheck && npm test && npm run check-manifest`.
3. `npm run package`, then **commit the rebuilt `.vsix`** — it is tracked, and a stale one means
   VS Code users install the previous version.
4. `npm run publish:ovsx`.
5. Push, and tag the commit if you want the download to be findable by version.

## What an update actually does to existing users

A version published from here is an automatic update for everyone on 0.3.x, so the differences
are not release notes — they are things that will break for somebody:

- **The settings namespace moved.** The old build read `tabBrowser.*`; this one reads
  `aiBrowser.*`. Every setting a user has tuned stops applying, silently, with their old values
  still sitting in `settings.json`.
- **Features the old build had and this one does not**: the sidebar, the in-page context menu,
  console capture, html files served from disk with reload on save, page zoom, terminal-link
  takeover, address-bar completion, the page's own favicon on the tab.
- **It needs a newer editor and proposed APIs.** The old build ran anywhere on stable API;
  this one wants VS Code 1.136+ and the `browser` proposal, which some editors only grant to an
  extension named with `--enable-proposed-api`. Where that is not granted, a user who updates
  is left with the webview panel and no element tools at all.

None of that argues against publishing — it argues for saying so in the release, and for
thinking about whether the version number should be a major one rather than 0.5.0.

## Worth knowing

- **Open VSX does not gate proposed apis at publish time**, which is why this route works at
  all. What it cannot do is grant them at runtime: an editor still has to be new enough to carry
  the `browser` proposal, and some builds only hand proposed apis to an extension named with
  `--enable-proposed-api DenysDavydov.tab-browser-ultimate`. That belongs in the release notes,
  not in a workaround.
- **The README is the marketplace page.** Relative links in it resolve through the `repository`
  field, so a link to `CLAUDE.md` works on Open VSX; a relative *image* would need
  `--baseImagesUrl`.
- **`@vscode/vsce` pulls in two packages whose install scripts are blocked** under the npm 11
  `allowScripts` policy (`@vscode/vsce-sign`, `keytar`). Leave them blocked — they are only
  needed for `vsce publish`, which is not the route here.
