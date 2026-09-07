# Publishing

Two registries, one artifact: `npm run package` builds `tab-browser-ultimate.vsix` (through
`vscode:prepublish`, i.e. `typecheck` + a production build), and both publish scripts upload
that exact file rather than repackaging.

```sh
npm run package        # build the vsix
npm run publish        # -> Visual Studio Marketplace (needs VSCE_PAT)
npm run publish:ovsx   # -> Open VSX (needs OVSX_PAT)
npm run publish:all    # all three, in that order
```

Bump `version` in `package.json` first — both registries refuse a version they already have.

## Tokens

- **Marketplace**: an Azure DevOps personal access token, all organizations, scope
  *Marketplace → Manage*. Export it as `VSCE_PAT`, or run `npx vsce login DenysDavydov` once.
  The publisher (`DenysDavydov`) has to exist at https://marketplace.visualstudio.com/manage.
- **Open VSX**: an access token from https://open-vsx.org/user-settings/tokens. Export it as
  `OVSX_PAT`. The namespace has to exist once, before the first publish:

  ```sh
  npx ovsx create-namespace DenysDavydov -p "$OVSX_PAT"
  ```

  Namespaces are unverified until Eclipse links them to the publisher account; an unverified
  namespace still publishes, it only shows a warning on the extension page.

Keep both tokens out of the repository — environment variables or the CI secret store, never
`package.json`.
