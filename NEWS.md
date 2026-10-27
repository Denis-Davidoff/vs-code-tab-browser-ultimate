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

Browse, debug and test your pages in VS Code's own browser — and let Claude Code, Codex or Gemini CLI see them, click through them and take screenshots, right inside the editor.

- $(terminal) **Terminal tabs** — open a shell or Claude Code / Codex in a chat tab; pin it to a conversation and its agent reads it and, with your approval, types.
- $(extensions) **Chrome extension** — a full 1:1 mirror of your chat, right in Chrome alongside any website. [Download ZIP](https://github.com/Denis-Davidoff/vs-code-tab-browser-ultimate/raw/refs/heads/main/chrome-extension/ai-browser-chrome-0.6.0.zip) while Chrome Web Store approval is pending.
- $(coffee) **Keep awake** — use the cup at the top to prevent sleep for a set time or until all agents and sub-agents finish.
- $(eye) **View Mode** — choose Minimal, Compact or Standard in the approval menu to control how much work, tool use and thinking is shown.
- $(files) **Chats across tabs and windows** — open chats with the top +; right-click tabs to move them between the sidebar, tabs and windows with drafts and attachments intact. View chats side by side across screens.
- $(git-commit) **Commits and branches** — bottom right: commit with a generated message, switch branches or create one with a generated name.
- $(device-camera-video) **Record video** — record browser tabs from their toolbar, up to 4K, into the chat or clipboard.
- $(location) **Page markers** — pin notes to page elements and send them to the agent as one prompt.
- $(settings-gear) **Chat Settings** — use the gear at the top to edit prompts for commit messages, branch names and chat titles, or clean up temporary files.

## 0.9.1 — 2026-10-27
- **Terminal tabs in the chat**: open a real shell, or Claude Code or Codex in their own CLI, as a tab beside your conversations — from the tab strip's **+**, **New Chat** or **AI Browser: New Terminal**. It uses your own default shell profile, copy and paste work as in a terminal, and links open in the browser. macOS and Windows; Linux is not supported yet.
- **Agents that use your terminal**: **Ask agent** or **+ → Terminal…** pins a terminal to a conversation. Its agent can read the screen and wait for a command to finish; typing into the terminal asks you first, **Watch only** lets it read and never type, and **Pause agent input** stops it at once. Your own typing always comes first.
- **Insert into a terminal**: the terminal toolbar's **+** puts a page address, an element, a screenshot, a file, the editor's selection or page markers into an agent CLI's prompt, without pressing Enter.
- **Terminals on the website**: with **AI Browser › Chat: Remote Terminal** on and an encrypted connection, the Exchange website can watch terminals you mark **Allow website access** and, after **Take control**, type into them — with a key bar for phones. Off by default; your typing in VS Code takes control back.

## 0.9.0 — 2026-10-23
- **Exchange server**: share a chat and a browser tab with a self-hosted website, and send messages, stop turns, pick elements, add markers and click through the page from any device. The connection is encrypted end to end and opened from VS Code, so nothing has to listen on your machine.
- **One chat on every surface**: the VS Code chat, the Chrome side panel and the website now follow the same rules. A control that a surface cannot use is greyed out with the reason, and updates arrive as small patches instead of whole states.
- **Git state on the website**: commits, branch switches and staged changes made in VS Code appear on the website straight away.
- **Attach the current page**: the Chrome side panel and the website offer the page you are looking at as a dashed suggestion. One click attaches it, together with a note telling the agent which `browser_*` tools reach it.
- **Google Chrome from the website**: the website's globe menu can open Chrome on the VS Code machine. Its Browser panel now labels each tab as Chrome or VS Code.
- **Fixes**: a chat tab no longer stays marked as shared in Chrome after Chrome is closed. Agents can no longer send copy, cut or paste shortcuts, which would have exposed your clipboard.

## 0.8.10 — 2026-10-23
- **More browser actions**: native hover, drag, keyboard shortcuts and text insertion join the MCP tools. Clicks support double and right clicks and refuse covered, disabled or ambiguous targets.
- **Shadow DOM and transformed frames**: snapshots and actions reach open and closed author Shadow DOM. Pointer actions account for scaling, rotation, skew, CSS zoom and perspective in nested and cross-site iframes.
- **Optional humanized input**: curved pointer movement, varied pauses and character-by-character Unicode typing, including joined emoji. Enable `humanize` per action; no additional model or browser plugin is needed.
- **Safer input delivery**: native actions run in sequence per tab, use bounded waits and release held keys or mouse buttons on cancellation. Cross-process frames verify pointer targeting before a click, without replaying issued clicks.

## 0.8.9 — 2026-10-22
- **Safer reconnects**: automatic Chrome reconnection keeps command receipts and late operation results. After an editor restart, uncertain outgoing messages return to drafts for review instead of being silently sent again. Another editor profile's rejection no longer discards the authorized profile's resume key.
- **Stable conversation targeting**: asynchronous footer answers and project attachments are discarded if their original conversation was replaced, instead of reaching the replacement chat.
- **Subtasks settle after failures**: usage-limit and non-retrying child-thread errors end the agent row and its timer. Quiet agents are checked against the backend after two minutes; connection failures show **No response** without pretending the task succeeded or killing live work.
- **Popups stay in view**: branch lists, menus and tooltips are constrained to the visible chat area, including narrow Chrome side panels. Positioning updates when the panel or popup content changes size, with scrolling for tall popups.
- **Clear Chrome recording controls**: a recording bar above the composer shows elapsed time and offers Pause, Resume and Stop. Chrome's **Stop sharing** also finishes recording; disconnecting or closing the panel stops capture.
- **Chrome footer actions**: usage and context, compacting, skills, working folders, Git branches and commits, and GitHub repositories use the selected Chrome conversation. Long operations do not block Stop, and project-attachment receipts survive reopening the side panel.

## 0.8.8 — 2026-10-22
- **The Chrome chat footer works with the editor**: usage and context, compacting, toolbar skills, working folders, Git branches and commits, and GitHub repositories. Requests stay bound to the selected Chrome conversation; native pickers and Git confirmations appear in VS Code, and long operations do not block Stop.
- **Chat alongside websites in Chrome**: connect the AI Browser side panel to a local editor window with **Connect** and **Allow**. Send messages, stop generation, respond to approvals and choose a model without leaving Chrome.
- **A conversation stays selected**: switching editor tabs does not change the conversation in Chrome. Drafts stay separate, pending sends retry without duplication, and mirrored editor tabs have an animated gradient underline with reduced-motion support.
- **Page context from the + menu**: attach elements, visible-page screenshots, page addresses, shared pages, files and short screen or tab recordings. Clipboard files remain attached to their original conversation when switching chats.
- **The same annotation overlay in Chrome**: edit numbered notes on page elements and let agents list, read, add or remove them through MCP. Access is granted per conversation; delivered user markers are removed after sending.
- **Compatibility by feature**: different extension releases can work together. An incompatible optional function shows an update instruction while compatible functions stay available; unsupported outgoing attachments return to the draft.
- **Chrome distribution**: matching icons with clearer toolbar artwork, English interface and help, store description and permission explanations, plus `npm run package-chrome` to build the ZIP.
- **Stop cancels pending starts**: stopping while an asynchronous Git check is pending prevents the waiting message from starting afterward.

## 0.8.7 — 2026-10-21
- **Chrome without native Browser API setup**: use Google Chrome and agents immediately. The chat’s **+** and browser menus also offer native tabs where available, with an action to enable the API and instructions to quit and reopen the editor.
- **Chrome tab fixes**: opening Chrome attaches the requested new tab instead of an existing page. Sharing, screenshots, element picks, annotations and video recording now handle Chrome tabs without relying on native browser events.
- **Codex terminal handover waits for release**: if another Codex conversation is still working, the chat stays open. Retry **Continue in VS Code terminal** after that work finishes.
- **Clearer README**: separate native browser and Chrome columns, updated installation options, and a shorter video recording guide.

## 0.8.6 — 2026-10-21
- **Google Chrome for the browser tools**: every assistant on the MCP server can drive Chrome over its own DevTools connection, with no Chrome extension. The globe button asks where to open a page, and the status bar menu opens Chrome for Claude Code, Codex or Gemini with a ready prompt.
- **Moving a chat to the terminal keeps the browser**: the terminal's Claude Code or Codex gets the browser tools and starts on the tab the chat was working on, Chrome included.
- **History by period**: filter past chats by today, yesterday, this week, this month or last month.
- **"Prompt is too long" during auto-compacting is retried**: the message goes again after Claude Code compacts, instead of stopping with the error.

## 0.8.5 — 2026-10-21
- **Claude Ultracode, separate from effort**: a round star checkbox beside the slider turns automatic workflows on or off without changing reasoning effort. Each chat keeps its own choice across reloads and moves; new tabs inherit the last explicitly chosen state. Available for supported Claude models; requires Claude Code 2.1.284 or later.
- **Chats stay visible in the collapsed sidebar**: compact 36 px tiles keep a number and coloured border, show a spinner, waiting, completion or error indicator, and display running agent counts in a corner badge. Hover for the title and status, right-click for chat actions, or double-click to expand and rename.
- **Effort without layout jumps**: only the fixed-width slider is shown. An immediate tooltip highlights the current effort in bold and in the thumb's colour. Colours progress from silver grey through sky blue to pale violet, with yellow or orange for exceptional levels.
- **A cleaner folder footer**: the current workspace folder has no Current label, external folders use Ext, and GitHub working copies use Git. Folder and Git refresh buttons have refined spacing.

## 0.8.4 — 2026-10-21
- **Wide-screen chat**: from 1000 px, the conversation, composer and footer share a centered 672 px content column. Tabs become a scrollable sidebar that can be collapsed or moved left or right; both choices survive a reload.
- **Attachment references restart for each message**: new drafts start at `@1`, while existing references stay stable when attachments are removed or refreshed. Returning queued messages to the draft updates their references together with the text.
- **Automatic recovery from temporary service errors**: once a Claude or Codex turn has stopped, the chat tries to continue the same conversation after 5, 15 and 60 seconds, up to three attempts. Stop, a new message or closing the chat cancels the wait.
- **Clearer tab activity**: a centered orbit spinner with a pulsing dot replaces the low-sitting star; it stays still under reduced motion. Switching tabs animates their widths together.
- **Reusable panel numbers**: new chat panels take the lowest available number from #2; the sidebar remains #1 and restored panels keep their numbers.

## 0.8.3 — 2026-10-21
- **Publish, Push and Pull** in the Branches window: one row for the current branch shows how far it is ahead or behind, and goes through VS Code's Git extension, so your GitHub sign-in answers for https remotes. Never forced; a pull only fast-forwards; a push to the default branch or while agents work asks first. A **pull request** button opens GitHub's compare page.
- **Chat tools for the agents**: `chat_state`, `chat_usage` and `chat_agents` report the chat's tabs, plan limits and running agents; the chat's own agents can keep the computer awake, pause or resume their tab's queue, and stop one of their agents. The controls are a new **Chat control** approval category, Ask by default. A paused queue shows **Resume** above it.
- **New chats from the status bar**: the AI Browser menu opens a chat here, in a new tab or in a new window.
- **Gemini shows which model Auto chose** beside "Worked for …", and tells a used-up model quota apart from a rate limit, a full context window from a turn limit, and explains its sign-in, settings and folder-trust exits.

## 0.8.2 — 2026-10-20
- **Chats across tabs and windows**: open chats in the sidebar, editor tabs or separate windows, and view several at once across screens. The top **+** offers a location; the tab-strip **+** adds a neighbouring chat.
- **Move live chats**: right-click a chat tab to move it between open views, or from the sidebar into a new tab or window, keeping its session, draft and attachments. Empty source panels close after a move. Drag tabs to reorder them.
- **Restore and find your chats**: chat tabs return after restarting VS Code. Panels have stable names such as **AI Browser #2**; history finds a conversation already open elsewhere and offers to move it back to the sidebar instead of opening a duplicate.
- **More precise file icons**: ordinary prose that matches a theme's special file names no longer receives file icons.

## 0.8.1 — 2026-10-20
- **File icons throughout the chat**: attachments, local file links, read/edit tool rows and file names in messages use your selected file icon theme and refresh when the theme or file associations change.
- **Usage and context ring meters** fill clockwise around their letters; the usage indicator turns into a red disc when a plan limit is reached.
- **A darker chat composer** separates the message box from its toolbar.
- **Conventional commit subjects**: generated messages use `type(TASK-ID): summary`, taking the task ID from the branch name or recent commits when available, without inventing one.

## 0.8.0 — 2026-10-20
- **Gemini CLI in the chat**: a third agent beside Claude Code and Codex, driven through your own `gemini` and its sign-in. Models come from the CLI, tool calls and edits show as they do for the others, questions are asked in the chat, and a conversation reopened from the history picks up where it left off. If a model does not answer, the chat says so and suggests another.
- **Connect Gemini CLI** writes `.gemini/settings.json` for a `gemini` you run in a terminal, keeps the token out of git, and opens Gemini where you can trust the folder. **Open Gemini CLI in Terminal** and **Share Tab with Gemini CLI** are in the new Gemini CLI submenu.
- **Ask another agent**: a button under every reply sends the same question to another agent or model in a new tab, for an independent second opinion that does not see the first answer.
- **Editor tools for the agents**: `editor_context` (what you have open and selected), `editor_reveal`, `editor_definition`, `editor_references` and `editor_symbols` let assistants navigate code through VS Code's language servers, inside the workspace only.
- **The copy icon on an annotation note** now copies the note itself, with the element it is pinned to and the page, instead of only the element's CSS selector.

## 0.7.19 — 2026-10-20
- **Choose how long a video may be**: Chat Settings → Video recording has a maximum length, 5 minutes unless you change it, from 10 seconds up to 1 hour. In the last 30 seconds the Stop button on the browser tab blinks red and the status bar counts down; at the limit the recording stops and keeps the video. The size limit now grows with the length, so a long recording is no longer cut at 256 MB.
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
