# AI Browser news

<!--
This file is shown in the AI Browser chat whenever a chat is empty: the first
paragraph below as the introduction, then the newest six entries as "What's
new", smallest print. Keep the introduction to one or two sentences.

An entry is a level-two heading — `## <version> — <date>` — followed by a
bullet list; inline `code`, **bold**, *italics* and [links](https://…) work.
Newest first. Older entries can stay; only six are shown. This file ships in
the VSIX, so an edit reaches users with the next release. The format is read by
src/chat/news.ts — see "The AI Browser chat" in CLAUDE.md.
-->

Browse, debug and test your pages in VS Code's own browser — and let Claude Code or Codex see them, click through them and take screenshots, right inside the editor.

## 0.7.9 — 2026-10-18
- **Keep the computer awake** from the chat: the cup button holds off system sleep for a set time, or until the agents and sub-agents in this window finish — one shared helper answers for every window, and closing a window releases its hold.
- Codex agents, and agents started by other agents, stay listed as running after the turn that started them; **Stop**, closing the tab or a parent agent ending now ends them too, instead of leaving them "running".

## 0.7.8 — 2026-10-18
- A **plan-limit line** above the chat when your agent's nearest limit is 90 % used: it names the limit and when it resets, comes back at every further percent and at 100 % after you close it, and says so when the agent starts spending usage credits; click it to open the usage popup.
- **U** is coloured by how much of your plan is used — green, yellow, orange, red — and turns into a red disc once a limit is reached or credits are being spent.
- Your plan's limits stay current without starting anything extra: they are read when the agents are detected, from each turn's own report, and now and then after a turn on the process the conversation already runs.

## 0.7.7 — 2026-10-17
- Saved logins: signing in with **Enter** on a form whose button is an arrow or labelled in another language is noticed again, so the offer to save comes up; a save from an offer withdrawn meanwhile no longer says "Saved" before it is undone.
- Connect Codex and the startup repair work again in a `config.toml` that also holds servers written as `[mcp_servers]` keys; only a clash with our own entry is left alone.
- Pressing the toolbar's Copy button in a window with no folder no longer takes the **Add to Claude Code** button away from your other windows.
- Element reports: HTML in an element's id can no longer turn into a clickable command in the saved `.md` file.
- `browser_console` with `clear` clears only the lines it returned, and long lines are never cut in the middle of an emoji.
- Messages given back by **Stop** or **Clear** join what you had typed before pressing ↑, not the recalled message; the **/** button is a little smaller.

## 0.7.6 — 2026-10-17
- Saved logins: a "Forgot password?" button no longer counts as signing in, so a mistyped password is not offered as an update; and a save from an offer that turns out wrong is undone, even if it was still being written.
- The chat's buttons answer every click while a reply streams, and a new conversation sits by the message box again.
- Escape that cancels an input method's conversion no longer closes the skill editor, the GitHub form or a popover.
- Messages given back by **Stop** or **Clear** stay in the box when you switch tabs.
- A repository fetched from GitHub keeps its own skills and commands off until you trust it too.
- **Add to Claude Code** is hidden when no folder is open, rather than failing after every pick.
- Safer Codex configs: Connect leaves a file alone when it defines servers in another TOML spelling; the startup repair goes on past a `.mcp.json` it cannot write.
- `browser_console` answers stay within what Claude Code accepts from a tool, newest lines kept.

## 0.7.5 — 2026-10-17
- **A working folder per chat**: the folder button beside **/** sets where the tab's agent works — your window's folder, one picked lately or any other — and lists that folder's files and folders to attach; type to search them.
- **GitHub repositories**, three ways: work in a **separate copy** on a branch of its own (see its changes, push and open a pull request, or remove it), **clone** it into a folder, or **read it beside** your project.
- A repository fetched from GitHub does not load its own Claude Code settings or hooks until you trust them from the folder button.
- A toolbar skill can show its result **in a notification**, with Copy and Open, and any skill can **tell you when it ends** — in its own words if you like.

## 0.7.4 — 2026-10-17
- **Questions with choices**: when the agent asks "this or that?", a form opens above the message box with a tab per question; pick an option or answer in your own words, and **Answer** sends them once every question has one — or **Skip** lets the agent choose and say so.
- **Links in replies open**: a click in the built-in browser, ⌘/Ctrl-click in your system browser, a right-click for both and to copy the link. The file a Read or edit row names opens on a click.
- **Tool calls start folded**, each with a line saying what it does; switch it with *Compact* in the approval menu.
- A toolbar skill can **run after this turn** (⌘/Ctrl-click, or its right-click menu) instead of right away.
- Replies read better: headings shade from yellow to white, quotes have a yellow edge, code is a little brighter with its language in yellow.

## 0.7.3 — 2026-10-17
- **Toolbar skills can send several prompts in a row**: add next prompts in the skill's editor, each sent once the agent has finished the one before — and, where you write a check between two, only if the agent finds it true; otherwise the skill stops there and says why.
- The button that holds a message until the agent's turn ends is now Send's own round button, in the theme's accent colour.
- A small **pie** beside **U** fills as the conversation uses up the model's context window; hover it to see how much is used and how much is left; click it to compact the conversation with the agent's own `/compact` — it asks first.

## 0.7.1 — 2026-10-16
- **Toolbar skills**: from **/** → *Add skill to toolbar*, a button above the message box running a prompt of your own — with parameters, using the agents' skills, with colours of your choice for its text, border and icon — into the chat, to the clipboard, or silently in the background; also callable as **/name**. Pressed again while it runs, it asks before running a second time. A skill running in the background shows in the agents list, with its tool calls, its reply, its questions and a Stop, and stops when its chat is closed or cleared.
- **Tool calls** show the first three lines of their input and output, on a darker card — a command its first three and its output's last three — and a file change its counts with the first three lines removed and added; click IN or OUT to open the whole of it in an editor tab, or a file change to open it in VS Code's diff editor. *Fold Tool Calls* in the settings folds them instead.
- Once a reply is done while the agents it started work on, the foot of the chat says how many are still running and for how long; click it to see them. The agents button beside Send counts only the running ones, and stays when they are done so you can read what they found.
- A diff's added and removed lines are coloured across their whole width, scrolled sideways too.
- Messages added while the agent works sit closer together.
- A conversation grown past the model's context says so once, and suggests `/compact`; a clipboard skill copies only what is between its markers, even when the result mentions them.

## 0.7.0 — 2026-10-16
- **AI Browser chat** in the secondary side bar: talk to Claude Code or Codex with the CLI you already have.
- Pick the agent, the model and its effort — and, from the gear, which installed copy of each agent to use; **U** shows your plan limits and this chat's tokens.
- **+** attaches a screenshot, an element from the page, the page address or a file; the browser tab's menu adds elements, screenshots and the address too, under AI Browser Chat. Click a chip to open it.
- Commands, file edits and thinking appear as cards you can open.
- The chat's agents can use the browser from the first message, no Connect needed (while the MCP server is on). They ask before they act; answer in the chat, or set each kind — the internet, the browser, the terminal, files, each MCP server — to **Auto**, **Ask** or **Deny**.
- While an agent works, **Enter** adds your message to what it is doing and **⌘Enter** queues it for after; copy any prompt or reply from its corner.
- **/** beside the globe searches your agent's skills and commands — the project's, your own, plugins' — and clears or exports the conversation; or type **/** or **$** anywhere in the message to pick a skill as you write — commands are marked in the text, and the CLI's own `/usage`, `/context` and the like show their answer.
- Several chats at once, as tabs — up to 10 by default, 30 in Settings — marked while working, when finished and not yet read, or when something went wrong; double-click a tab to rename it; switching a chat to the other agent asks whether to open a new tab, hand the conversation over, or close this one.
- The agents your agent starts: how many are running, what each one did and found, and a Stop for each.

## 0.6.3 — 2026-10-15
- The browser tools read and act inside iframes, cross-origin frames included.

## 0.6.2 — 2026-10-12
- Saved logins: fewer false "update password" offers after a failed sign-in.
- Safer handling of hand-edited Codex configs.

## 0.6.1 — 2026-10-08
- **Translate Page**: an assistant translates the open page in place, and puts it back on request.

## 0.6.0 — 2026-10-06
- **Saved logins and passkeys**: fill sign-in forms, save new logins, import from Chrome, Firefox, Safari, Bitwarden or 1Password, and export encrypted.

## 0.5.32 — 2026-10-06
- Clearer behaviour in remote windows, where the assistants run on the other machine.

## 0.5.30 — 2026-10-02
- Screenshots for assistants arrive as images sized for the model, full pages in frames.
