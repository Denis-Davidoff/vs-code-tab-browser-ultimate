# 🚀 First integrated browser for VS Code editor with Claude Code and Codex support 🎆

- **VS Code's built-in browser**, not a webview: every tab is a real Chromium page in its own
  isolated Electron process.
- **Your assistants, your way:** keep the Claude Code and Codex extensions you already use, or
  switch to the **AI Browser chat** — both agents in one panel, up to 10 chats at once, more
  deeply wired into the browser.
- **A built-in MCP server** that connects the browser to Claude Code, Codex or any other
  assistant that speaks MCP.
- **Pick an element on the page** and send its address or metadata straight to Claude Code or
  Codex.
- **Full DevTools for every tab.**
- **Per-assistant tab access:** share a tab with one assistant and it sees and drives that tab
  only, while the others stay hidden from it.
- **A password manager for sites:** it offers to save a login after a sign-in that worked and
  fills it back, with passkeys too, all kept in VS Code's secret storage.
- **Translate, modify and restore content on the page:** your assistant rewrites all of its
  text in place — translate it, stress-test the layout with long labels, try new copy, or mask
  personal data before a screenshot. Only the open page changes; a reload restores it.

## Which editors this works on

The browser features are built on VS Code's own browser tab, reached through the `browser` API
proposal. An editor that does not ship that proposal cannot run them — installing the extension
there is not the problem, the missing API is. **Measured by reading the shipped builds on
2026-09-09**, ordered by how much work each one takes:

| Editor | Version tested | Browser features | How to install | Then |
|---|---|---|---|---|
| **VSCodium** | 1.135 | ✅ yes | Open VSX, one click | Enable Browser API, quit and reopen |
| **Devin** (Windsurf) | 1.126 | ✅ yes | Open VSX, one click | Enable Browser API, quit and reopen |
| **VS Code** | 1.137 | ✅ yes | **the `.vsix` by hand** | Enable Browser API, quit and reopen |
| **Cursor** | 3.19.19 | ❌ no | — | nothing helps — the API is absent |
| **Antigravity IDE** | 1.107 | ❌ no | — | nothing helps — base predates the API |
| **Kiro** | 1.0.437 | ❌ no | — | nothing helps — has the browser, not the API |
| **Trae** | 1.107.1 | ❌ no | — | nothing helps — base predates the API |
| **Theia IDE** | 1.75 | ❌ no | — | nothing helps — not a VS Code build |

**Setup at a glance** — the whole path in eight numbered steps; click the picture for full size:

[![Step-by-step setup: install, enable the browser API, open a page, connect Claude Code or Codex](ai-browser-instruct.jpg)](https://raw.githubusercontent.com/Denis-Davidoff/vs-code-tab-browser-ultimate/main/ai-browser-instruct.jpg)

## Page annotations

**Add Annotation Marker** on the browser tab pins a numbered note to an element you click. Each new
note is attached to the AI Browser chat tab in front, and assistants read, add and remove notes
through the `browser_annotations_*` MCP tools. Sending the message removes its markers from the
page. Details: [CLAUDE.md](CLAUDE.md#page-annotations).

## Browser video recording

Record the visible browser page without granting the operating system screen recording access.
The extension receives page frames through CDP and encodes them with the editor's built-in
`MediaRecorder`: MP4 when supported, otherwise WebM. Recordings are silent. The chat's top
settings button has a **Video recording** tab: **Balanced · 1080p** (6 Mbps), **High · 1440p**
(12 Mbps, default), or **Maximum · 4K** (24 Mbps). Source frames use lossless PNG; the source
page limits the actual resolution. Changes apply to the next recording and are shared across
projects. Higher quality produces larger files. Capture frequency depends on the editor;
smooth 30 fps is not guaranteed.

- **AI Browser Chat:** choose **Record the browser page** under **+**, or the recording action
  under **AI Browser Chat** in the browser tab's extension menu. Stop attaches the video to that
  conversation's draft. Open the attachment to preview it; its context menu offers **Save video as…**.
- **Claude Code / Codex extensions:** choose the recording action under the corresponding
  assistant in the browser menu. Stop copies the file path and shows a notification with the
  duration, size, **Open video** and **Save as…** actions.
- **MCP:** `browser_recording_start` returns an `id`. Use `browser_recording_pause`,
  `browser_recording_resume`, `browser_recording_stop`, or `browser_recording_status` with that id.
  The extension's chat clients attach to their own conversation; external clients copy the path.
  Optional `destination: "chat" | "clipboard"` overrides delivery. Status also returns the
  completed result after a stop from the toolbar, including the file path and delivery outcome.

During recording, **Pause / Resume** and **Stop** appear in the browser tab's top toolbar.
The chat also shows a recording notice and timer above the message box, with adjacent pause
and stop buttons. The notice follows recording, paused and saving states.
Pausing stops CDP capture and excludes the pause from the video. Keep the browser visible;
encoding runs inside the chat webview without opening a separate recording tab, and continues
when the chat is hidden. The chat view is initialized if it has not been opened yet.
One recording can run at a time, for up to ten active minutes and 256 MB.

Videos are kept as local temporary files; use **Save as…** to keep a permanent copy. Chat
attachments provide a file reference to the agent, not native video input. MCP returns metadata
and the path rather than transferring video bytes. This mode records the page viewport, not
the editor chrome or desktop.

To run the local end-to-end recording smoke test after `npm run compile`, use
`node scripts/check-recording.mjs [path-to-editor-executable]`. It opens an isolated editor
profile, checks MCP, toolbar commands, pause timing, chat attachments and clipboard delivery,
then restores the clipboard. It does not request OS screen recording access.

## Changelog

**0.7.19** — The empty chat lists the features worth trying, one line each, above the
changelog. A prompt Claude Code refuses as too long is sent again after it compacts. Annotation
markers keep their elements across a reload, and an empty note is deleted without a question.

**0.7.18** — Page annotations: numbered notes pinned to elements, attached to the chat and
removed from the page once the message is sent, with `browser_annotations_*` tools for the
assistants. A View Mode for the chat — Minimal, Compact or Standard. One repeat button on the
browser tab for the last action, a copy or a marker. Files, folders and editor selections
attached from VS Code, and a shared page that follows its tab. Safe branch switching with
stash, commit or discard first, and diffs from the Git footer.

**0.7.17** — Video recording of browser pages (three quality presets, pause and stop on the tab,
`browser_recording_*` tools for the assistants; both limits keep the video). Files pasted into the
chat are attached. Temporary files moved to `~/.ai-browser`, with per-project cleanup in Chat
Settings. Custom system prompts for commit messages, branch names and titles, automatic
keep-awake while agents work, and themed file icons in the Git footer. Command tools such as
PowerShell are approved under Terminal; a rejected password is no longer offered as an update;
Restricted Mode runs no Git; unsaved skill and settings edits survive focus changes.

**0.7.14** — Git controls in the chat footer: inspect staged and unstaged files, stage or unstage
changes, refresh status, and search, switch, create or delete branches. The sparkle button suggests
a branch name from changes or discussion using a lightweight model at the configured effort. Commit
with an AI-generated message, choosing staged changes or all changes;
failures offer agent assistance, and successful commits show a ten-second VS Code notification.
The settings gear beside the keep-awake cup opens **AI for Extension Features**, with independent
agent (Auto, Claude Code or Codex) and effort (Minimum, Medium or Maximum) choices for commit
messages, branch names and chat titles, saved across projects.

**0.7.13** — Voice messages on macOS 26+: record from the microphone under Send, transcribed on
the device and written into the message box for review before sending. The keep-awake cup moved
to the chat's title bar, and "until the agents finish" can follow this tab or all tabs.

**0.7.12** — Attachment references (`@N`) with an **@** picker; toolbar skills with a wand-shaped
Add button, drag-and-drop ordering and an expandable list; follow-up prompts wait for their
sub-agents. Local file links open in editor tabs and folder links in VS Code Explorer or the
system file manager. Lightweight background requests name new chats without replacing manual
names. Unused managed GitHub copies can be deleted from the folder menu. Mode counts and context
usage are colour-coded, and popups close when focus leaves the panel.

**0.7.11** — A responsive chat composer: toolbar groups adapt to the sidebar width, effort has a
compact selector, Send and queued-send sit beside the message box, and the working folder has
its own status line.

**0.7.10** — A smaller keep-awake cup, matching the context and usage icons.

**0.7.9** — Keep-awake. The cup button in the chat keeps the computer from sleeping for a set
time, or until this window's agents and sub-agents finish. Codex agents and nested agents keep
their place in the agents list after the turn that started them, and Stop or closing the tab ends
them.

**0.7.8** — Plan limits in sight. A line above the chat appears once your agent's nearest limit is
90 % used, says when it resets, returns at every further percent and at 100 % after you close it,
and tells you when the agent starts spending usage credits. The **U** button is coloured by how much
of the plan is used and turns red when a limit is reached. The figures are read from what the agents
already report, without starting extra processes.

**0.7.7** — Follow-up fixes to 0.7.6. Saved logins notice an Enter sign-in again on forms whose
button is an arrow or in another language. Connect Codex and the startup repair no longer stop at a
config holding servers in another TOML spelling. The toolbar's Copy button in a folderless window
keeps the Add button in your other windows, an element's id can no longer become a command link in
a saved report, `browser_console` clears only what it returned, and messages given back by Stop or
Clear join your earlier draft rather than a recalled message.

**0.7.6** — Fixes from a review of the whole project. Saved logins no longer take a "Forgot
password?" button for a sign-in, and undo a save from an offer that turns out wrong. The chat's
buttons answer every click while a reply streams, an input method's Escape no longer closes a form,
and messages given back by Stop or Clear are kept. A fetched repository's own skills stay off until
trusted, Add to Claude Code is hidden with no folder open, Codex configs in other TOML spellings
are left intact, and `browser_console` answers stay within a tool's size limit.

**0.7.5** — A working folder per chat: the folder button beside **/** sets where the agent works
and lists that folder's files to attach. GitHub repositories open three ways — a separate copy on
a branch of its own (with its changes, push and pull request), a clone into a folder, or a
read-only checkout beside the project — and a fetched repository's own Claude Code settings stay
off until you trust them. Toolbar skills can show their result in a notification and tell you
when they end.

**0.7.4** — Questions with choices: when the agent asks, a form opens above the message box with
a tab per question, and Answer sends once every question has an answer. Links in replies open in
the built-in browser (⌘/Ctrl-click: the system browser), and the file a tool row names opens on a
click. Tool calls start folded with a line saying what each does, toolbar skills can run after the
current turn, and headings, quotes and code blocks in replies are restyled.

**0.7.3** — Toolbar skills can send several prompts in a row, each once the agent has finished the
one before — and, where you write a check between two, only if the agent finds it true. A small
pie beside **U** fills as the conversation uses up the model's context window; click it to compact
the conversation with the agent's own `/compact`. The button that queues a message for after the
current turn is now Send's twin, in the accent colour.

**0.7.2** — Toolbar skills running in the background show in the agents list with their tool
calls, reply and a Stop; the foot of the chat says how long the agents have been running; the
**/** palette cuts long rows instead of scrolling sideways.

**0.7.1** — Toolbar skills: buttons above the message box running prompts of your own — with
parameters, your agents' skills and colours of your choice — into the chat, to the clipboard or
silently in the background, also callable as **/name**. Tool calls show the first lines of their
input and output and open whole in an editor tab; a file change opens in VS Code's diff editor.

**0.7.0** — The AI Browser chat, in the secondary side bar: talk to Claude Code or Codex with the
CLI you already have, pick the agent, model and effort, and attach screenshots, page elements, the
address or files. Its agents can use the browser from the first message and ask before they act —
answered in the chat, or set to Auto, Ask or Deny per kind. Several chats at once as tabs, the
agents' skills under **/**, and the sub-agents they start listed with a Stop for each.

**0.6.3** — Assistants can now read and work inside embedded frames, including ones from other
sites — a OneNote notebook in SharePoint, a document viewer, a payment form. A new
`browser_frames` tool lists them, the reading, clicking, filling and waiting tools take a frame,
and a new `browser_scroll` scrolls a page, a frame or an inner panel.

**0.6.2** — Fixes across the board: the password manager no longer offers to save a password after
a link or a rejected sign-in, while catching sign-in buttons in any language; `browser_wait_for`
survives the navigation it waits for; screenshots of right-to-left pages are no longer blank; and
Codex config repairs leave hand-written entries alone.

**0.6.1** — Translate Page: pick a language and paste the prompt into Claude Code or Codex, and the
assistant rewrites the page's text in place through three new MCP tools — which also serve any
other bulk rewrite, from new copy to masked data before a screenshot.

**0.6.0** — Saved logins and passkeys: the browser offers to save a password after a sign-in
that worked, fills it back with `Cmd`/`Ctrl` + `Shift` + `L`, and stores passkeys — all in VS
Code's secret storage, with encrypted export and import from Chrome, Firefox, Safari, Bitwarden
and 1Password.

**0.5.30** — Screenshots for Claude Code fixed: `browser_screenshot` now returns real images
instead of base64 text, which overflowed the tool output limit, and a full page arrives as a
sequence of frames sized for the model to read.

## How to install

**Not sure about your editor?** Run **AI Browser: Enable Integrated Browser API**, or pick it
under *Setup* in the status bar menu, and it says which of the three answers applies. The rule is
a VS Code 1.112 or newer base with the `browser` proposal left in — a fork's own version number
tells you nothing (Cursor reports 1.128 and still lacks it).

> **The fastest way in is the VSIX in this repository:**
> [**tab-browser-ultimate.vsix**](https://github.com/Denis-Davidoff/vs-code-tab-browser-ultimate/raw/main/tab-browser-ultimate.vsix)
> → **Extensions: Install from VSIX…**. It is the current build.
>
> [**Open VSX**](https://open-vsx.org/extension/DenysDavydov/tab-browser-ultimate) carries the
> same build, and is the one-click route on VSCodium, Devin, Cursor, Windsurf and Theia —
> installing is not the same as the browser features working, see the table above. The
> [**VS Code Marketplace**](https://marketplace.visualstudio.com/items?itemName=DenysDavydov.tab-browser-ultimate-promo)
> entry is the guide and the download link, not the extension itself — the Marketplace does not
> accept an extension that declares API proposals. See [Installing](#installing) below.
>
> On a supported editor there is **one step after installing**: the extension declares two API
> proposals (`externalUriOpener`, `browser`) and an editor only grants those to an extension
> named with `--enable-proposed-api`. Click the orange **Enable Browser API** button in the
> status bar and it writes that for you — see
> [Enabling the browser API](CLAUDE.md#enabling-the-grant-in-one-click).

Press `Cmd`/`Ctrl` + `Shift` + `P` to open the command palette, run **AI Browser: Show**, enter
the url you want — then work with the elements on the page exactly as below.

**VS Code's own browser tab, wired to your AI assistant: click an element and it becomes a
prompt, or hand the whole browser over and let the agent drive it.**

Front-end work is a loop: look at the page, find the element, describe it to the assistant,
check what changed. Screenshots lose the markup, hand-copied class names go stale, and a
headless browser opens a session you are not logged into. This extension closes the loop inside
the editor: the page you are looking at is the page your agent reads and drives.

- 🌐 **VS Code's built-in browser, not a webview approximation.** Pages open in the editor's own
  browser editor — a real Chromium tab with history, find in page, page zoom, DevTools and
  working keyboard shortcuts. The extension attaches to it over the Chrome DevTools Protocol,
  the same channel the editor uses for its own browser features.
- 🎯 **Click an element, get the whole story.** One pick returns a report: what the element is,
  where it sits in the html, its outer markup, its box, and the css that actually applies to it
  — matched rules in cascade order, inherited rules, resolved values and css variables. Hover
  highlighting comes from the DevTools overlay, so picking feels like the inspector.
- 📍 **Or just its address.** A CSS selector or an XPath, built to survive the next rebuild:
  both anchor on a unique `id` when there is one and add a positional predicate only where a
  tag really repeats; the selector deliberately leaves utility class names out. **Copy CSS
  Path + Location** puts the page in front of it — `http://localhost:3000/checkout → #main >
  li:nth-of-type(2)` — so an assistant reading it knows which route the selector belongs to
  instead of guessing, in the order it will use them: navigate, then find. It arrives on the
  clipboard already wrapped as inline code, ready to paste into a chat message.
- ✨ **One click turns it into a prompt.** Send the element, its selector or its path straight
  into Claude Code or Codex as a file their agent reads — so "make this button match the one
  above" is a sentence, not a paragraph of description.
- 📸 **Screenshots that paste as pictures.** The visible area or the whole scrollable page, on
  the system clipboard as a real PNG — `Cmd`/`Ctrl` + `V` into a chat, an issue or a document.
- ⌨️ **One key repeats what you did last.** The toolbar's right-hand button and
  `Cmd`/`Ctrl` + `Alt` + `C` both run the action you used last, whichever of the seventeen it was.
- 🔌 **An MCP server, with nothing to install.** No package, no separate process to babysit: the
  extension starts a local server on activation, and one command configures Claude Code, Codex
  or VS Code's own chat to use it.
- 🤖 **Then the agent drives the page itself.** Nineteen tools: snapshot what is clickable, read
  the html or the text, inspect an element, click, fill fields, scroll, wait for a render,
  screenshot, navigate — then read the console to see what its own change actually did. Reading,
  clicking, filling, scrolling and waiting work inside embedded frames too, frames from other
  sites included.
- 🌐 **Translate a page with your own assistant.** Pick a language, paste the prompt it copies into
  Claude Code, Codex or any agent connected to the MCP server, and the page's text is replaced in
  place — no translation service, and text the page re-renders keeps its translation; new text
  needs another run.
- 👀 **In your session, not a fresh one.** Same cookies, same dev server, same logged-in state,
  already past the auth wall you passed this morning. You watch every step happen in the tab and
  can take the mouse back at any point.
- 🔒 **Local by construction.** Loopback only, a bearer token per workspace, and any request
  carrying an `Origin` header refused before its credentials are looked at.
- 🔑 **Saved logins and passkeys.** After a sign-in that worked, the status bar offers to save the
  password — or to update one that changed; a sign-in form gets one-click filling, and
  `Cmd`/`Ctrl` + `Shift` + `L` fills from anywhere on the page. Sites can create and use passkeys,
  each one confirmed in VS Code first — a VS Code prompt for now, not Touch ID or Windows Hello;
  a passkey request from an embedded frame of another site is not served while passkeys are on.
  Everything lives in VS Code's secret storage, encrypted by the operating system (on Linux, only
  when a keyring is available), exports to a passphrase-protected file, and imports from Chrome,
  Firefox, Safari, Bitwarden or 1Password. Nothing is drawn into the page, and no MCP tool returns a
  password value — though an assistant you share a tab with can still click a page's own
  "show password" button and take a screenshot.

It started as a standalone copy of the Simple Browser extension that ships with VS Code,
repackaged so it can be built, installed and extended on its own. That panel is still in here
(`aiBrowser.useIntegratedBrowser: false`), but everything above is built against the editor's
own browser.

## Working in the AI Browser chat

- **Refer to an attachment** with `@1`, `@2`, and so on. Type **@** in the message box to find an
  attached file, page, element or screenshot by name or number; select with the arrow keys and
  Enter / Tab, or click. Clicking a chip's icon or `@N` inserts the reference at the caret (or at
  the end if no position is set). Its name opens the attachment; right-click offers both actions.
- **Build a quick-skill toolbar** with the wand button above the message box. Drag skill buttons
  to change their saved order. If the row overflows, the arrow button expands or collapses the
  list; dragging works in the expanded list too. In a skill's editor, **Add next prompt** creates
  another step: it waits for the preceding prompt, its sub-agents and the parent's follow-up to
  finish. A check between steps must pass before the next one runs.
- **Open local links in replies**: files open in editor tabs, including a line or column when
  specified. Folders inside the VS Code workspace are revealed in Explorer; other folders open
  in Finder, File Explorer or your system file manager. Right-click offers the relevant choices.
- **Automatic titles** use a single short background request after the first prompt, on an
  available lightweight model with minimum effort. Only a bounded fragment of that prompt and
  attachment names is sent, without the chat history or attachment contents. Manual names are
  preserved; if no suitable model is available or the request fails, the first-line title stays.
- **Clean up GitHub copies** from the folder menu after switching to another folder and waiting
  for work in the copy to finish. Deleting a managed copy loses changes that were not pushed.
  Clones in user-picked folders cannot be deleted through this action.
- **Read the indicators**: Mode counts are Auto (green), Ask (yellow) and Deny (red), with zero
  counts hidden. The context pie blends from grey to white at 25%, green at 50%, yellow at 75%,
  orange at 90% and red at 100%; the neutral colour adapts to light themes. Click it to request
  context compaction. Menus and popups also close when you click outside the chat panel.

## Try another useful extension: Task & Script Explorer

Visual Studio Code Marketplace link: https://marketplace.visualstudio.com/items?itemName=DenysDavydov.task-runner-ultimate

Open VSX Registry link: https://open-vsx.org/extension/DenysDavydov/task-runner-ultimate

## The toolbar on the browser tab

Open a page — `Cmd`/`Ctrl` + click a localhost url a dev server printed, or run
**AI Browser: Show** — and the browser tab gets two buttons of its own:

- **a globe**, which opens a menu holding everything the extension does;
- **a crosshair**, which repeats the entry you used last. Its colour says which one: red for the
  element, blue for the css path, purple for the css path + location, green for the xpath, with a
  ring around it when the destination is Claude Code, Codex or the AI Browser chat rather than the
  clipboard. After **Add Annotation Marker** it is a map pin instead, and adds another marker.

`Cmd`/`Ctrl` + `Alt` + `C` runs whatever that second button shows, and is inert outside a
browser tab. Every entry except Open New Browser Tab is also in the command palette under
**AI Browser**.

The menu, in order:

| Entry | Result |
| --- | --- |
| Open New Browser Tab | an empty browser tab |
| Connect Claude Code / Connect Codex | writes the assistant's config and shares this tab with it — the same entries as in the submenus below |
| Copy Element | the full context as Markdown — element, url, html path, outer html, dimensions, matched css |
| Copy CSS Path | `#main > div > li:nth-of-type(2)` |
| Copy CSS Path + Location | the page and the selector on one line, wrapped as inline code: `http://localhost:3000/a/b → #main > div > li:nth-of-type(2)` |
| Copy Element XPath | `//*[@id="main"]/span`, or `/html/body/ul/li[2]` when nothing stable can anchor it |
| Copy Screenshot (Visible Area) | a PNG of what is on screen, on the clipboard |
| Copy Screenshot (Full Page) | the whole scrollable page, truncated past 16384 device pixels |
| Translate Page… | asks for a language and copies a prompt to paste into your assistant, which translates the page in place — [CLAUDE.md](CLAUDE.md#translating-a-page-through-an-assistant) |
| Add Annotation Marker | pin a note to an element you click — [Page annotations](#page-annotations) |
| Remove All Annotation Markers / Copy Annotation Prompt | only while the page has markers: clear them, or copy a prompt that hands the notes to your assistant |
| Claude Code ▸ | a submenu: the same four picks handed to the Claude Code chat, plus Connect and Share Tab |
| Codex ▸ | the same, for Codex |
| AI Browser Chat ▸ | the same four picks, plus a screenshot and the page address, added to this extension's own chat |
| Check Connection | the mcp server, [CLAUDE.md](CLAUDE.md#mcp-the-browser-exposed-to-claude-code-codex-and-vs-code-chat) |
| Logins and Passkeys ▸ | fill a saved login, save the one on the page, manage, import, export — [CLAUDE.md](CLAUDE.md#saved-logins-and-passkeys) |
| Share Tab with All Assistants / Stop Sharing Tab | [CLAUDE.md](CLAUDE.md#mcp-the-browser-exposed-to-claude-code-codex-and-vs-code-chat) |

Everything belonging to one assistant lives in that assistant's submenu, which is what keeps the
top level at twenty-one rows. The four **Add** entries there appear only for an assistant whose
extension is actually installed and can take a report in this window — Claude Code's need a local
folder open, and neither works in a remote window; **Connect** and **Share Tab** are always there, because an
assistant driven from a terminal through `.mcp.json` needs them and has no extension to detect.
The menu is attached to the browser tab — from anywhere else, use the command palette.

Picking is single-flight: starting a pick cancels one already waiting, so the clipboard always
holds the action you chose last rather than one you had abandoned.

---

Everything below this point — what each command writes, the mcp server and its tools, sharing a
tab, the settings and command reference, installing, the `argv.json` grant, and the build — is
in **[CLAUDE.md](CLAUDE.md)**, which is the project's working reference and is kept current with
the code.

## Use from another extension

Driving the browser from another extension is what the fork was originally for:

```ts
await vscode.commands.executeCommand('aiBrowser.api.open', vscode.Uri.parse('http://localhost:3000'), {
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: true,
});
```

A plain string works too, and is relayed exactly as given — prefer it for an address whose query
carries encoded characters such as `%26`, which a `vscode.Uri` decodes.

The extension also registers an external uri opener for `http` and `https`, but only for
localhost-like hosts (`localhost`, `127.0.0.1`, `0.0.0.0` and the IPv6 equivalents) — so a
forwarded port offers to open here, and every other url still goes to your system browser.

## Installing

It is not on the VS Code Marketplace: the Marketplace does not accept an extension that declares
API proposals. Install [`tab-browser-ultimate.vsix`](tab-browser-ultimate.vsix) from this
repository with **Extensions: Install from VSIX…**, then run **AI Browser: Enable Integrated
Browser API** and quit the editor completely. [CLAUDE.md](CLAUDE.md) has the detail, including
which editors can work at all.

## License

MIT, with both copyright lines — Microsoft's, for the forked and copied code, and this
project's. The per-file MIT headers on everything copied from vscode stay where they are.
One file, `src/logins/loginFormScript.ts`, is ported from Firefox's password manager and stays under
the Mozilla Public License 2.0 — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
