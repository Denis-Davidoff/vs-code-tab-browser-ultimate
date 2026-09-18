# Publishing

**Two registries, two different artifacts.** Open VSX gets the real extension; the Marketplace
gets the stub in [vscode-marketplace/](vscode-marketplace/) — see [Two artifacts, one id](#two-artifacts-one-id).

```sh
npm run package        # -> tab-browser-ultimate.vsix (compiles first, via vscode:prepublish)
npm run publish:ovsx   # -> rebuilds, then uploads to Open VSX
```

**Publishing always packages first.** `publish:ovsx` runs `package` itself, which in turn runs
`compile` through `vscode:prepublish`, so a registry can never receive a `.vsix` built from
source older than the working tree. Run `package` on its own only when you want the artifact
without the upload — before committing it, say.

**There is no `publish:vsce` any more, and putting it back is not the fix for anything.** It
pushed the real build to the Marketplace with `--allow-all-proposed-apis`, which lifts vsce's
client-side refusal of a proposal-declaring extension, and it never once completed — see below.
The stub is what goes to the Marketplace now.

### Current state of the listings

| | Id | Latest published | Reach |
| --- | --- | --- | --- |
| [Open VSX](https://open-vsx.org/extension/DenysDavydov/tab-browser-ultimate) | `tab-browser-ultimate` | **0.5.23** (checked 2026-09-18) | 5916 downloads across 34 versions |
| VS Code Marketplace, old | `tab-browser-ultimate` | **0.3.17** | 2 installs, one 5★ rating — being removed by hand |
| VS Code Marketplace, new | `tab-browser-ultimate-promo` | not yet published | the listing, from `vscode-marketplace/` |

**Open VSX carries this rewrite now** — the row above said 0.3.17 long after it had been
published past that, and a stale number here is not harmless: it was read during a review as
evidence that the update notification pointed users at a downgrade. Re-read it from
`https://open-vsx.org/api/DenysDavydov/tab-browser-ultimate` rather than from this table.

**The Marketplace upload of the real build never completed.** Two attempts both ended in
`ERROR Request timeout: /_apis/gallery` — after vsce's own three internal retries, with the
manifest check bypassed, a PAT resolved from the macOS keychain and the signing binary present.
The host answers a plain GET in 250 ms, so it was the upload itself that stalled. That history is
worth keeping, because the stub is small enough that it may well go through where the 540 KB real
build did not; if the stub also times out, export `VSCE_PAT` and try from a plain terminal before
suspecting the manifest.

## This is not a first publish

`DenysDavydov.tab-browser-ultimate` **is already live on Open VSX**, and has been since before
this rewrite — 34 versions and ~5.9k downloads as of 2026-09-18, the latest being **0.5.23**.

**The changeover already happened.** Open VSX served 0.3.x — the local proxy, the injected page
script, the sidebar, the in-page context menu — until this rewrite was published over it, so the
users described in
[What an update actually does to existing users](#what-an-update-actually-does-to-existing-users)
have already been updated, and that section is a record of what they lost rather than a warning
about the next publish. It is still worth reading before shipping, because anybody still sitting
on 0.3.x meets all of it the moment they update.

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

## Two artifacts, two ids

The Marketplace no longer gets the real build. It gets the stub in
[vscode-marketplace/](vscode-marketplace/) — the listing, its readme and video, and two commands
that point at the download — published as **`DenysDavydov.tab-browser-ultimate-promo`**, an id of
its own.

```sh
cd vscode-marketplace
npm run publish   # packages (via prepare.mjs) and uploads to the VS Code Marketplace
```

**Separate ids mean the versions do not interact** — nothing auto-updates from one to the other,
and both can be installed at once, which is the normal end state. The stub detects the real build
and goes quiet: no welcome message, and its two commands hide themselves from the palette. Keeping
the two version numbers equal is a convention, so the listing says which release it describes;
`prepare.mjs` only notes a mismatch. What it does enforce: the icon is copied from the real
extension, and a readme with a relative image or an `<iframe>`/`<video>` is rejected, since the
Marketplace renders none of those.

**The old `DenysDavydov.tab-browser-ultimate` listing on the Marketplace is being removed by
hand.** It serves the 0.3.x proxy build and nothing here updates it any more; Open VSX keeps that
id for the real extension.

The root has no Marketplace publish script at all any more: this is the only route there.

## Every release

1. **Bump `version` in `package.json`** — the registry refuses a version it already has, and
   `--skip-duplicate` only makes that failure quiet, not a new release. The published set now
   runs past **0.5.23**, so read the current one from
   `https://open-vsx.org/api/DenysDavydov/tab-browser-ultimate` rather than from any number
   written down here; a stale figure in this file is what made an earlier draft of it claim the
   set stopped at 0.3.17.
2. `npm run compile && npm run typecheck && npm test && npm run check-manifest`.
3. `npm run publish:ovsx` — it packages first, so the upload is always current. Open VSX carries
   the real build.
4. **Commit the rebuilt `.vsix`** — it is tracked, and a stale one means VS Code users install the
   previous version.
5. If the listing text or the video changed, set `vscode-marketplace/package.json` to **the same
   version** as the root and `cd vscode-marketplace && npm run publish`.
6. Push, and tag the commit if you want the download to be findable by version.

**Steps 1 and 4 must reach `main` together.** Since 0.5.24 the installed extension reads
`main`'s `package.json` and treats its `version` as *a release you can install* — so pushing the
bump ahead of the rebuilt `.vsix` tells every existing install that a version exists, hands them
a download of the previous one, and **burns the announcement**: the version is recorded as
offered, so when it really ships nobody is told. Bump and repackage in one commit, or push them
together. See
[The real build watches for releases too](CLAUDE.md#the-real-build-watches-for-releases-too).

**There is no GitHub Release, deliberately, and the update button knows it.** Nothing in these
steps creates one, so the notification's `Download from GitHub` opens
`raw/main/tab-browser-ultimate.vsix` — the URL the README documents and the promo build uses. If
releases ever do get cut, that constant in `src/updateCheck.ts` is what has to move with them.

## What an update actually does to existing users

A version published from here was an automatic update for everyone on 0.3.x, and still is for
anyone who has not taken one since. The differences are not release notes — they are things that
broke, or still will break, for somebody:

- **The settings namespace moved.** The old build read `tabBrowser.*`; this one reads
  `aiBrowser.*`. Every setting a user has tuned stops applying, silently, with their old values
  still sitting in `settings.json`.
- **Features the old build had and this one does not**: the sidebar, the in-page context menu,
  console capture, html files served from disk with reload on save, page zoom, terminal-link
  takeover, address-bar completion, the page's own favicon on the tab.
- **It needs a newer editor and proposed APIs.** The old build ran anywhere on stable API;
  `engines.vscode` is `^1.85.0` so this one still installs widely, but its browser features want
  VS Code 1.112+ and the `browser` proposal, which some editors only grant to an extension named
  with `--enable-proposed-api`. Where that is not granted, a user who updates
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
