# Third-party notices

AI Browser is MIT-licensed (see [LICENSE](LICENSE)). One file is not.

## Mozilla Firefox password manager — MPL-2.0

`src/logins/loginFormScript.ts` — compiled to `out/logins/loginFormScript.js` in the packaged extension — is
derived from Firefox's password manager and is licensed under the
[Mozilla Public License, v. 2.0](https://mozilla.org/MPL/2.0/). It finds the username and
password fields of a sign-in form, tells a change-password form from a sign-in, and decides
whether a submission is one the user made.

Ported from [mozilla-firefox/firefox](https://github.com/mozilla-firefox/firefox) at
`4b5e436b8bc908fe7feb7341209140771397dda1`:

- `toolkit/components/passwordmgr/LoginManagerChild.sys.mjs`
- `toolkit/components/passwordmgr/LoginHelper.sys.mjs`
- `toolkit/components/passwordmgr/LoginManager.shared.sys.mjs`
- `toolkit/components/passwordmgr/shared/NewPasswordModel.sys.mjs`
- `toolkit/modules/FormLikeFactory.sys.mjs`

The modifications are listed at the top of the file. Under MPL-2.0 the file stays under that
licence, including this project's changes to it; the rest of the extension, which only imports
it, is a Larger Work and remains MIT.

**The source form ships with the extension**: the packaged VSIX contains
`extension/src/logins/loginFormScript.ts` beside the compiled `extension/out/logins/loginFormScript.js`, so the
source of the exact version you have travels with it. It is also in this repository:
https://github.com/Denis-Davidoff/vs-code-tab-browser-ultimate/blob/main/src/logins/loginFormScript.ts

The behaviour of Bitwarden's browser extension (GPL-3.0) was studied when deciding when to offer
saving a password and how to fill one. None of its code is included.

## Stagehand — design reference

Stagehand's MIT-licensed `packages/extension/understudy/locator.ts`, `selectorResolver.ts`,
and `page.ts` were studied for native CDP input, shadow-root locators and mouse dragging:
https://github.com/browserbase/stagehand/tree/main/packages/extension/understudy

`src/browser/nativeActions.ts` is an independent implementation for AI Browser's tab-scoped
CDP sessions. No Stagehand source, SDK, browser extension, model client or runtime is included.

## Terminal tabs — node-pty and xterm.js (MIT)

The chat's terminal tabs are built on four MIT-licensed packages, all unmodified:

- [`node-pty`](https://github.com/microsoft/node-pty) 1.1.0 starts the shell in a pseudo-terminal.
  Copyright (c) 2012-2015 Christopher Jeffrey, (c) 2016 Daniel Imms, (c) 2018-present Microsoft
  Corporation. The packaged extension carries the files that run — its `lib/` and the darwin and
  win32 prebuilt binaries — in `extension/out/terminal/vendor/node-pty/`, with its `LICENSE` and
  `package.json` beside them. `scripts/stage-terminal.mjs` makes that copy at build time.
- [`@xterm/xterm`](https://github.com/xtermjs/xterm.js) 6.0.0 draws the terminal in the chat view.
  Copyright (c) 2017-2019 The xterm.js authors, (c) 2014-2016 SourceLair Private Company, (c)
  2012-2013 Christopher Jeffrey. It is bundled into `extension/media/chat.js`, and its stylesheet is
  `extension/media/xterm.css`.
- [`@xterm/addon-fit`](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit) 0.11.0 sizes
  the terminal to its tab. Copyright (c) 2019 The xterm.js authors. Bundled into
  `extension/media/chat.js`.
- [`@xterm/headless`](https://github.com/xtermjs/xterm.js/tree/master/headless) 6.0.0 is the same
  terminal emulator without a display. The extension host feeds it each terminal's output so that an
  agent reads the screen as text. Copyright (c) 2017-2019 The xterm.js authors, (c) 2014-2016
  SourceLair Private Company, (c) 2012-2013 Christopher Jeffrey. The packaged extension carries its
  single minified file in `extension/out/terminal/vendor/xterm-headless/`, with `package.json` and
  the MIT `LICENSE` text of `@xterm/xterm` (the headless package ships none of its own) beside it.
  `scripts/stage-terminal.mjs` makes that copy at build time.

Each is under the MIT licence: permission is granted, free of charge, to use, copy, modify, merge,
publish, distribute, sublicense and sell copies, provided the copyright notices above and the
licence text travel with the copies, and the software is provided "as is", without warranty of any
kind. The full text is in each package's `LICENSE` file (`node_modules/<package>/LICENSE`; for
node-pty also in the packaged copy above).

xterm.js (`@xterm/xterm` and `@xterm/addon-fit`) is bundled into the editor's chat view and into the
Exchange website's chat script, which also serves `xterm.css`, for terminals shared with the
website. The Chrome extension's side panel builds the same chat script without it and carries no
xterm.js. node-pty and `@xterm/headless` run only in the VS Code extension. These packages use none
of VS Code's proposed terminal APIs.
