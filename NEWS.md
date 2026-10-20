# AI Browser news

<!--
This file is shown in the AI Browser chat whenever a chat is empty: the first
paragraph below as the introduction, then the features listed under it, then
the newest six entries as "What's new", smallest print. Keep the introduction
to one or two sentences.

A feature is a bullet before the first entry, written exactly
`- $(codicon) **Name** — one short line`; any other bullet there is skipped.

An entry is a level-two heading — `## <version> — <date>` — followed by a
bullet list; inline `code`, **bold**, *italics* and [links](https://…) work.
Newest first. Older entries can stay; only six are shown. This file ships in
the VSIX, so an edit reaches users with the next release. The format is read by
src/chat/news.ts — see "The AI Browser chat" in CLAUDE.md.
-->

Browse, debug and test your pages in VS Code's own browser — and let Claude Code or Codex see them, click through them and take screenshots, right inside the editor.

- $(coffee) **Keep awake** — the cup at the top of the chat keeps the computer from sleeping for the time you pick, or until the agents and their sub-agents have finished.
- $(eye) **View Mode** — Minimal, Compact or Standard in the approval menu: how much of the agents' work, their tool calls and thinking, the chat shows.
- $(git-commit) **Commits and branches** — at the bottom right of the chat: commit in a couple of clicks with a generated message, and switch or create branches with a generated name.
- $(device-camera-video) **Record video** — record a browser tab from its toolbar, up to 4K, straight into the chat or to the clipboard.
- $(location) **Page markers** — pin notes to several elements right in the browser and hand them to the agent as one prompt.
- $(settings-gear) **Chat Settings** — the gear at the top of the chat: change the system prompts behind commit messages, branch names and chat titles, and clean up temporary files.

## 0.7.19 — 2026-10-20
- **The empty chat shows what to try**: keep awake, View Mode, commits and branches, video recording, page markers and Chat Settings, each in one line above **Show changelog**.
- **"Prompt is too long" retries itself**: Claude Code compacts the conversation after that error, and the chat sends the prompt again after 5, 15 and 30 seconds. Stop cancels the wait.
- **An empty annotation is deleted without a confirmation.**
- **Annotation markers stay on their elements after a reload**, elements without an id included, instead of piling up in the top right corner.

## 0.7.18 — 2026-10-20
- **Page annotations**: **Add Annotation Marker** pins a numbered note to an element you click. A new note is attached to the chat tab in front, and sending the message removes its markers from the page. The browser menu can remove every marker or copy a prompt that hands the notes to your assistant; assistants read, add and remove notes through the `browser_annotations_*` tools.
- **View Mode** in the chat's approval menu: **Minimal** shows only your messages and the replies, each message's tool calls and thinking folded under one line that says what the agent is doing now; **Compact** folds every tool call; **Standard** shows them open.
- **One repeat button** on the browser tab: it repeats your last action, a copy or a marker, and `Cmd`/`Ctrl` + `Alt` + `C` runs it.
- **Attach from the editor**: files and folders from the Explorer or an editor tab, and the selected text, go to the chat with **Attach to AI Browser Chat**. **Share page** attaches the browser tab and follows it while it stays in the draft.
- **Switch branches safely** from the chat footer: fetch and fast-forward, stash, commit or discard a dirty worktree first, and come back with **Return & Apply Stash**. Clicking a changed file opens its diff.

## 0.7.17 — 2026-10-20
- **Record a video of a browser page** from the tab's toolbar: Balanced 1080p, High 1440p or Maximum 4K, with pause, resume and stop. The video goes into the AI Browser Chat draft or its path to the clipboard; Claude Code and Codex can record through the `browser_recording_*` tools. Reaching the 10-minute or 256 MB limit now stops the recording and keeps the video.
- **Paste files into the chat**: files and images on the clipboard are attached when pasted into the message box; PNG, JPEG, GIF and WebP also go to the agent as images.
- **Temporary files** now live in `~/.ai-browser`, grouped by project. Chat Settings shows what is stored and cleans a project or everything, never touching the current draft's attachments.
- **Your own system prompts** for commit messages, branch names and chat titles in Chat Settings, and keep-awake can switch on automatically while agents work. The Git footer shows file icons from your icon theme.
- **Safer approvals**: PowerShell and other command tools are asked about under Terminal and show the command itself; a write through a symlink that leads out of the project counts as outside it.
- **Saved logins**: a password the site rejected is no longer offered as an update after you click away, and a password for one account is no longer offered for another after switching accounts. A CSV import without dates says which accounts it could not order.
- **Fixes**: Restricted Mode no longer runs Git in the chat footer; the skill editor and Chat Settings keep what you typed when focus leaves the panel; Enter in branch search switches only to an exactly named branch; "/start" in a sentence no longer clears the chat; recording and prompt confirmations no longer pause the page.

## 0.7.14 — 2026-10-19
- **Chat Settings**: the gear beside the keep-awake cup opens **AI for Extension Features**. Choose the current chat agent (Auto), Claude Code or Codex, and minimum, medium or maximum effort independently for commit messages, branch names and chat titles. Settings are saved across projects; naming features use lightweight models.
- **Git in the chat footer**: see the current branch and staged / unstaged file counts beside the working folder. Hover the counts to inspect file names and stage or unstage individual files or a whole group; refresh the repository status with the refresh button.
- **Manage branches**: search local and remote branches, switch branches, create one from the current HEAD, or delete a local branch. The current branch has a green check, and deleting another branch keeps the list open.
- **Suggest a branch name** with the sparkle button beside the branch search. An available lightweight model uses the current changes or chat discussion at the configured effort (minimum by default); the proposed name accounts for existing branch names and stays in the field for you to review before creating it.
- **Commit with an AI-generated message** using the agent and effort chosen in Chat Settings. Choose staged changes or all changes when both are present, or stage all first when nothing is staged. Commit failures offer help from the current agent; successful commits show a VS Code notification for ten seconds.

## 0.7.13 — 2026-10-19
- **Voice messages** (macOS 26+): the microphone under Send records, with a live waveform and a five-minute limit. The speech is transcribed on your Mac and written into the message box at the caret, so you can correct it before sending. Escape discards the recording, and the audio is never kept.
- **Keep the computer awake** has moved to the chat's title bar. Hold sleep off for a set time, or until the agents finish in **this tab** or in **all tabs**.

## 0.7.12 — 2026-10-19
- **Attachment references**: each chip has a short `@N` reference. Click its icon or reference to insert it at the caret, or type **@** to search attached files, pages, elements and screenshots; the agent receives the matching content. Click the name to open it, or right-click for both actions.
- **Toolbar skills**: add a skill with the wand button, drag buttons to reorder them, and expand a crowded toolbar with the arrow button. **Add next prompt** waits for the preceding prompt and its sub-agents, including restarted Codex agents, to finish in both chat and background runs.
- **Local links in replies** open files in editor tabs, with a jump to the line when supplied. Project folders open in VS Code Explorer; other folders open in the system file manager. Right-click a file link to open it or reveal it in Finder / File Explorer.
- **Automatic chat titles**: after the first prompt, a short background request on an available lightweight model can replace the first-line title. Context is limited, effort is minimal, and manually entered names always win; an unavailable model or failed request keeps the existing title.
- **Remove unused GitHub copies** from the folder menu after switching elsewhere, including copies with detached HEAD. Only managed copies in the extension's storage can be deleted; user-picked clone folders are kept.
- **Clearer chat controls**: the Mode button shows coloured Auto / Ask / Deny counts, hiding zero counts; the context pie changes smoothly from grey through white, green, yellow and orange to red as it fills. User messages have a subtle yellow border, and tab marks are better aligned.
- Popups and tooltips close when focus leaves the chat panel, including a click elsewhere in VS Code.

## 0.7.11 — 2026-10-18
- **A responsive chat composer**: toolbar groups adapt to the available width, and the effort slider becomes a compact selector when space is tight.
- Send and queued-send buttons sit beside the message box. The working folder has its own status line, with the keep-awake cup at the right.

## 0.7.10 — 2026-10-18
- The keep-awake cup is smaller and better matches the context and usage icons beside it.

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

## 0.7.2 — 2026-10-16
- Toolbar skills running in the background appear in the agents list with their tool calls, reply and a Stop button.
- The chat footer shows how long agents have been running, and long rows in the **/** palette are cut instead of scrolling sideways.

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
