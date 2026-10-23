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
