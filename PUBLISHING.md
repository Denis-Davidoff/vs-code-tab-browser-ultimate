# Publishing

**Two registries, one artifact.** Both scripts upload the committed
`tab-browser-ultimate.vsix` rather than repackaging, so the bytes in a registry are the bytes in
the repository — which is also what VS Code users download directly.

```sh
npm run package        # -> tab-browser-ultimate.vsix (compiles first, via vscode:prepublish)
npm run publish:ovsx   # -> Open VSX
npm run publish:vsce   # -> VS Code Marketplace  (see the caveat below)
npm run publish:all    # both, ovsx first
```

**`publish:vsce` carries `--allow-all-proposed-apis`, and it is load-bearing.** `vsce publish`
refuses an extension that declares `enabledApiProposals` (this one declares
`externalUriOpener` and `browser`); the flag turns that client-side check off. What it cannot
promise is that the service accepts the upload — see below.

### Current state of the two listings

| | Latest published | Reach |
| --- | --- | --- |
| [Open VSX](https://open-vsx.org/extension/DenysDavydov/tab-browser-ultimate) | **0.3.17** (2026-09-08) | ~1.5k downloads across 14 versions |
| [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=DenysDavydov.tab-browser-ultimate) | **0.3.17** | 2 installs, one 5★ rating |

**Both registries still serve the previous implementation.** This rewrite (0.5.0) exists only as
the committed `.vsix`. Until it is published, a reader who follows the README's "install from the
marketplace" line gets the 0.3.x proxy build, not this one.

**`publish:vsce` has not completed successfully yet.** Two attempts both ended in
`ERROR Request timeout: /_apis/gallery` — after vsce's own three internal retries, with the
manifest check bypassed, a PAT resolved from the macOS keychain and the signing binary present.
The host answers a plain GET in 250 ms, so it is the upload itself that stalls; that points at
the network the attempt was made from rather than at anything in this repository. Try it from a
normal terminal, and with `VSCE_PAT` exported if the keychain entry turns out to be stale.

## This is not a first publish

`DenysDavydov.tab-browser-ultimate` **is already live on Open VSX**, and has been since before
this rewrite: fourteen versions up to **0.3.17**, published 2026-09-08, ~1.5k downloads. Those
users are running the *previous* implementation — the local proxy, the injected page script, the
sidebar, the in-page context menu. A publish from this repository replaces that build for every
one of them, and the two are not feature-equal in either direction. Read
[What an update actually does to existing users](#what-an-update-actually-does-to-existing-users)
before shipping one.

The setup is therefore already done and does not need repeating:

- **The Open VSX token is already stored in the OS keychain**, put there by an earlier
  `ovsx login`. `ovsx` looks in three places in order — `-p`, then `OVSX_PAT`, then that store —
  so nothing has to be exported on this machine, while CI needs `OVSX_PAT`
  (from https://open-vsx.org/user-settings/tokens). Confirm either way with `npm run verify-pat`,
  which answers `PAT valid to publish at DenysDavydov`.
- **The Marketplace token** is an Azure DevOps PAT (all organizations, scope
  *Marketplace → Manage*), in `VSCE_PAT` or stored by `npx vsce login DenysDavydov`. One is
  already in this machine's keychain under `vscode-vsce`.
- **The namespace exists.** `npx ovsx create-namespace DenysDavydov` is a one-time step that has
  already happened; running it again is harmless but pointless.

## Every release

1. **Bump `version` in `package.json`** — the registry refuses a version it already has (the
   published set is 0.3.1 … 0.3.17, and this repository is at 0.5.0), and `--skip-duplicate`
   only makes that failure quiet, not a new release.
2. `npm run compile && npm run typecheck && npm test && npm run check-manifest`.
3. `npm run package`, then **commit the rebuilt `.vsix`** — it is tracked, and a stale one means
   VS Code users install the previous version.
4. `npm run publish:ovsx`, and `npm run publish:vsce` if the Marketplace upload is working.
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

- **Open VSX does not gate proposed apis at publish time**, and `vsce` only gates them in the
  client, where `--allow-all-proposed-apis` lifts it. Neither registry can *grant* them at
  runtime, which is the part that matters: an editor still has to be new enough for the `browser`
  proposal, and some builds only hand proposed apis to an extension named with
  `--enable-proposed-api DenysDavydov.tab-browser-ultimate`. That belongs in the release notes,
  not in a workaround.
- **The README is the marketplace page.** Relative links in it resolve through the `repository`
  field, so a link to `CLAUDE.md` works on Open VSX; a relative *image* would need
  `--baseImagesUrl`.
- **`@vscode/vsce` pulls in two packages whose install scripts are blocked** under the npm 11
  `allowScripts` policy (`@vscode/vsce-sign`, `keytar`). Leave them blocked — they are only
  needed for `vsce publish`, which is not the route here.
