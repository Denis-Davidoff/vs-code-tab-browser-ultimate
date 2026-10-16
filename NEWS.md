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

## 0.7.1 — 2026-10-16
- **Toolbar skills**: from **/** → *Add skill to toolbar*, a button above the message box running a prompt of your own — with parameters, using the agents' skills, with colours of your choice for its text, border and icon — into the chat, to the clipboard, or silently in the background; also callable as **/name**. Pressed again while it runs, it asks before running a second time.
- **Tool calls** show the first three lines of their input and output, on a darker card — a command its first three and its output's last three — and a file change its counts with the first three lines removed and added; click IN or OUT to open the whole of it in an editor tab, or a file change to open it in VS Code's diff editor. *Fold Tool Calls* in the settings folds them instead.
- Once a reply is done while the agents it started work on, the foot of the chat says how many are still running; click it to see them. The agents button beside Send counts only the running ones, and stays when they are done so you can read what they found.
- A diff's added and removed lines are coloured across their whole width, scrolled sideways too.
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
