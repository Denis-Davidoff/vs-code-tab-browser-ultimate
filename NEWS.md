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

## 0.7.0 — 2026-10-16
- **AI Browser chat** in the secondary side bar: talk to Claude Code or Codex with the CLI you already have.
- Pick the agent, the model and its effort — and, from the gear, which installed copy of each agent to use; **U** shows your plan limits and this chat's tokens.
- **+** attaches a screenshot, an element from the page, the page address or a file; the browser tab's menu adds elements, screenshots and the address too, under AI Browser Chat. Click a chip to open it.
- Commands, file edits and thinking appear as cards you can open.
- The chat's agents can use the browser from the first message, no Connect needed (while the MCP server is on). They ask before terminal commands, browser actions and edits; answer in the chat, or switch **Ask** to **Auto** to let commands and browser actions run.
- Several chats at once, as tabs — five by default, up to 30 in Settings — each marked as working, finished and unread, ended with an error, or read; switching a chat to the other agent asks whether to open a new tab, hand the conversation over, or close this one.
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
