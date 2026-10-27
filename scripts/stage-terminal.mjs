// Stages node-pty for the chat's terminal tabs into out/terminal/vendor/node-pty, next to the
// compiled src/terminal/terminalHost.js, which loads it from there (the VSIX has no node_modules:
// `vsce package --no-dependencies`). Runs after tsc in `build-ext`, whose `clean-ext` empties out/.
//
// It also stages the headless xterm.js that gives an agent a real screen to read
// (src/terminal/screenModel.ts): one minified file, out/terminal/vendor/xterm-headless/xterm-headless.js,
// 183 KB. It is a devDependency exactly like node-pty, so the package still has no runtime dependency.
// The headless tarball carries no licence file, so the MIT text is taken from @xterm/xterm, whose
// authors they are; the source map (800 KB) and the ESM build are not shipped.
//
// Only what a running node-pty needs is copied: no debug symbols (.pdb is most of its 62 MB), source
// maps, its own tests, the native sources or the docs, and only the prebuilds for the platforms the
// extension runs on (darwin and win32; node-pty ships none for Linux). Layout is node-pty's own:
// lib/ and prebuilds/ stay siblings, its loader finds `../prebuilds/<platform>-<arch>`.
import { chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "node_modules", "node-pty");
const target = join(root, "out", "terminal", "vendor", "node-pty");

const unwanted = /(\.pdb|\.map|\.test\.js|\.test\.d\.ts|\.d\.ts|\.cc|\.h|\.gyp|\.gypi|\.md)$/i;
const platforms = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"];

function keep(name) {
  return !unwanted.test(name);
}

async function size(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? await size(full) : (await stat(full)).size;
  }
  return total;
}

try {
  await stat(source);
} catch {
  console.error(
    "stage-terminal: node_modules/node-pty is missing; run npm install first.",
  );
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

// lib/ without its tests and source maps.
await cp(join(source, "lib"), join(target, "lib"), {
  recursive: true,
  filter: (from) => keep(from),
});

// prebuilds/<platform>-<arch>/ for the platforms we run on, without debug symbols.
for (const platform of platforms) {
  const from = join(source, "prebuilds", platform);
  try {
    await stat(from);
  } catch {
    continue;
  }
  await cp(from, join(target, "prebuilds", platform), {
    recursive: true,
    filter: (path) => keep(path),
  });
}

// A local node-gyp build (a Linux developer's own) is the only Linux backend there is.
try {
  await cp(join(source, "build", "Release"), join(target, "build", "Release"), {
    recursive: true,
    filter: (path) =>
      keep(path) && !/[\\/]obj(\.target)?([\\/]|$)/.test(path),
  });
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

await cp(join(source, "package.json"), join(target, "package.json"));
await cp(join(source, "LICENSE"), join(target, "LICENSE"));

// A zip does not promise the execute bit, and without it every spawn on macOS fails: spawn-helper
// is what node-pty runs the shell through.
if (process.platform !== "win32") {
  const helpers = [join(target, "build", "Release", "spawn-helper")];
  try {
    for (const folder of await readdir(join(target, "prebuilds"))) {
      helpers.push(join(target, "prebuilds", folder, "spawn-helper"));
    }
  } catch {
    // no prebuilds staged
  }
  for (const helper of helpers) {
    try {
      await chmod(helper, 0o755);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

const bytes = await size(target);
console.log(
  `stage-terminal: node-pty staged in out/terminal/vendor/node-pty (${(bytes / 1048576).toFixed(1)} MB)`,
);

// The headless emulator behind terminal_read / terminal_wait. Pinned to the xterm.js the view draws with: the
// host and the view must parse the same bytes into the same screen.
const headlessSource = join(root, "node_modules", "@xterm", "headless");
const headlessTarget = join(root, "out", "terminal", "vendor", "xterm-headless");
try {
  await stat(join(headlessSource, "lib-headless", "xterm-headless.js"));
} catch {
  console.error(
    "stage-terminal: node_modules/@xterm/headless is missing; run npm install first.",
  );
  process.exit(1);
}
const headlessPackage = JSON.parse(
  await readFile(join(headlessSource, "package.json"), "utf8"),
);
const xtermPackage = JSON.parse(
  await readFile(join(root, "node_modules", "@xterm", "xterm", "package.json"), "utf8"),
);
if (headlessPackage.version !== xtermPackage.version) {
  console.error(
    `stage-terminal: @xterm/headless ${headlessPackage.version} and @xterm/xterm ${xtermPackage.version} differ; the host and the view would read one stream as two screens.`,
  );
  process.exit(1);
}
await rm(headlessTarget, { recursive: true, force: true });
await mkdir(headlessTarget, { recursive: true });
// The file names a source map that is not shipped; drop the comment rather than have a debugger look for it.
const library = (
  await readFile(join(headlessSource, "lib-headless", "xterm-headless.js"), "utf8")
).replace(/\n?\/\/# sourceMappingURL=.*\s*$/, "\n");
await writeFile(join(headlessTarget, "xterm-headless.js"), library);
await writeFile(
  join(headlessTarget, "package.json"),
  JSON.stringify(
    {
      name: headlessPackage.name,
      version: headlessPackage.version,
      main: "xterm-headless.js",
      license: headlessPackage.license,
    },
    null,
    2,
  ) + "\n",
);
await cp(join(root, "node_modules", "@xterm", "xterm", "LICENSE"), join(headlessTarget, "LICENSE"));
console.log(
  `stage-terminal: @xterm/headless ${headlessPackage.version} staged in out/terminal/vendor/xterm-headless (${((await size(headlessTarget)) / 1024).toFixed(0)} KB)`,
);
