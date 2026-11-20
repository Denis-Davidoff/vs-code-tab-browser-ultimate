# Changelog

**1.0.2** — The AI Browser menu in the status bar has a **Full version** section with **Get the full version — HoverDeck**, which opens HoverDeck on Open VSX. It is hidden once HoverDeck is installed.

**1.0.0** — The last build with the chat, which continues in HoverDeck. 1.0.1 removed it again (the notes under 0.10.0 below).

**0.10.0** — The chat moved to its own extension, [HoverDeck](https://open-vsx.org/extension/DenysDavydov/hoverdeck), and AI Browser is the browser without it. This includes the chat panel, terminal tabs, the Chrome side panel, Exchange, keep-awake, voice messages and the Pi and OpenRouter agents. What stays:

- the MCP server with its browser, Chrome and editor tools;
- Connect for Claude Code, Codex, Gemini CLI, OpenCode and other MCP clients, plus Add to Claude Code / Codex;
- tab sharing, saved logins and passkeys, Translate Page, page annotations and video recording.

Recordings are now encoded by a small **Video Recorder** view in the panel area, and Stop copies the file path to the clipboard. Both extensions can be installed side by side.

**0.9.23** — With a conversation docked under a terminal, opening Skills, Activity or another composer tab no longer squeezes the terminal to nothing: it keeps about five lines of text and the docked messages give way instead. The composer tab row under a terminal sits closer to the border and the message box, and the terminal toolbar strip is a shade darker.

**0.9.22** — Light theme fixes: quotes are a soft tinted box with a yellow edge instead of a dark block, and inline code inside code blocks no longer sits on a dark strip. Appearance → Light or Dark over an editor of the other kind now forces the right colours for quotes, code, keys, scrollbars, notices and the terminal; the terminal re-colours when you change the theme. Code boxes in the approval cards are visible in Light Modern. The chat's "+" has **Folder…** beside **File…**, and both pick several at once; the terminal's Insert has Folder… too. The Conversation tab above the message box is now **Prompts** (Alt+P): your messages in this chat, newest first, each with a jump to its answer. A terminal pinned to a conversation shows its message box, and **Show messages** brings the conversation above it; the terminal toolbar is one compact row with drawn tooltips and arrow-key navigation. A bell on running GitHub Actions runs plays a sound and shows a system notification when the run ends (`aiBrowser.chat.sound.githubRun`, `aiBrowser.chat.notifications.githubRun`). A selection copied from the chat keeps its formatting as Markdown and HTML. The Commit window can commit and push in one step, and the Branches window has **Create PR**. With the message box empty and text on the clipboard, Send turns into **Paste** in the same place. In the GitHub tab a merged branch no longer shows an unusable "Create pull request" row, and an unpushed branch's row opens the Branches window.

**0.9.21** — Pinned tabs: click the chat tab already in front to pin it; it moves beside the other pinned tabs, gets a yellow underline and asks before closing; the tab's menu pins and unpins too. A new toolbar skill editor with a live button preview, sections, a prompt that grows with its text and a Markdown toolbar with Preview in every prompt. JSON and table cards get a proper search field and buttons, and JSON values are coloured by type. The Chrome side panel is 0.6.3. Fixes: ⌘B and ⌘K in the skill editor no longer also run VS Code shortcuts, and inserting a parameter into a prompt in Preview no longer types into the parameter's name, and the tab list shows each tab's mark without a spinner.

**0.9.20** — Tabs are grouped by project: a thin bar above the tabs shows All and each project with its tab count, how many are thinking and how many have unread results; pick one to see only its tabs. The wide sidebar and the tab list group tabs under folding project headings. Each open project's folder icon has a colour no other open project shares, and every project can have its own empty chat. The folder button beside **/** now only sets the working folder and opens GitHub repositories; attach files with **+** or the Files tab. The Chrome side panel (0.6.2) and the Exchange website carry the same chat and design. Fixes: the Chrome mark on grouped tabs in the collapsed sidebar, a terminal dropped on the tab list, and an idle Claude Code tab kept running by a timer from before a model change.

**0.9.19** — With focus in the chat, Cmd+W (Ctrl+W) or Option+W closes the chat tab in front instead of an editor; the close button's tooltip shows the key. In the Bash tab a process's "…" menu opens it in a VS Code terminal with its details and live file output, copies its PID or stops it; process monitoring now works on Windows and checks less often when nobody is looking. The open file, selection or page is offered again as a dashed chip under the message box. Connections & permissions has clearer cards. Fixes: the history loader in an old chat waits a second before appearing, and Chrome and the website no longer show a stray "available in the editor" notice.

**0.9.18** — Stop reads "Stopping…" from the click until the turn ends, and a Claude Code turn that does not stop within 4 seconds is ended, resuming on the next message. Swipe sideways over the composer, not only its tab row: a flick moves one tab, a slow drag snaps tab by tab; right-click the tab row to show or hide tabs, and scrolling down over it no longer returns to Chat. Share Tab with OpenCode, Pi or OpenRouter, Connect OpenCode, and Open Google Chrome for any agent, now under Open URL in the status bar menu. Notice cards get a copy button. Fixes: the arrow beside Send no longer pushes Send aside (touch screens only), and "Stopping…" no longer lingers on the turn after a stopped one.

**0.9.17** — Tab labels: right-click a chat tab and choose Add label… to put an emoji before its title. A page pinned to this chat can be inserted with `@`; one pinned to another chat is shown in orange in the browser menu. Swipe sideways over the composer tab row to walk through the tabs. Hover over a quote in a reply to copy it. The Branches search keeps its text for two minutes after the window closes. Notice cards are more compact.

**0.9.16** — Linked chats let one conversation read another, add attributed notes and manage worker chats. The composer's History tab is renamed Conversation. A new Bash tab lists the agents' shell commands, with their output available in the chat or in a read-only terminal, plus experimental process monitoring. While composing, lists continue with Enter and nest with Tab; a line typed with a leading space, or a bare `1` or `a`, stays plain text. Fixes: the Bash tab keeps clicks and focus while a command produces output, hovering over Send no longer closes other popups, and the usage button turns red while credits are being spent.

**0.9.15** — The composer's History tab lists each message's attachments, generated content and changed files, with links back to the chat or recorded diffs. Background agents appear by name beneath a finished reply, with links to their cards. Connection options now include OpenCode, Pi, OpenRouter and other MCP clients. The message counter updates as you scroll through replies, and inline cards use less space.

**0.9.14** — Create and manage chats, browse history, control agents and use terminal tabs directly from paired local Chrome. In VS Code, **Chat Settings → Connections & permissions** lets you restrict Chrome and Exchange separately, including project file access and terminal controls. Files and folders attached from Chrome now show their draft badges there. An internal session-state prototype adds snapshots and ordered replay for future architecture work; it is not a standalone session server.

**0.9.13** — Agents can display images with Expand/Collapse controls, downloadable files, searchable and sortable tables with pagination, audio and video players, and source cards. Artifacts are saved with the conversation and available in VS Code, Chrome and Exchange. In VS Code, source titles open in AI Browser, with explicit buttons to choose AI Browser or the system browser.

**0.9.12** — Agents can show charts, diagrams and small interactive pages inline in their replies, sandboxed and kept with the chat history; visualizations from Claude Code now render as they do for Codex.

**0.9.11** — Chrome 0.6.1 leaves completion sounds and notifications to VS Code to avoid duplicate alerts on the same computer. Remote terminal control is shared safely between Chrome and the website, Exchange rejects revoked keys during connection setup, switching remote chats no longer leaves pull request creation stuck, and the new-message count stays accurate as older history is loaded or hidden. The Chrome ZIP download is updated.

**0.9.10** — A capsule above the composer tabs shows how many messages are below and scrolls to the latest. GitHub and Files work in Chrome and on the website. Draft badges come back after a restart, sent badges sit closer to the text, and on phones switching tabs no longer reopens the keyboard, the Files status bar keeps its height and no blank band appears above the keyboard.

**0.9.9** — Attachments appear as inline badges in drafts and sent messages, with file icons, drag and drop, and menus to open, copy, remove or attach them again. Copying a badge or a whole message preserves attachments when pasted back into chat. Attach the current browser from the globe menu. The composer supports nested lists and clickable links as you type. Files has sortable sticky column headers, corrected arrow-key navigation in tiles and right-click selection. Pull request suggestions distinguish branches from different forks.

**0.9.8** — Attached files, tabs and suggestions show only on the composer's Chat tab; Skills, Activity, History and GitHub hide them, and they still go with the next message.

**0.9.7** — Shell code blocks in replies can be run in VS Code's terminal or a chat terminal tab. The Commit window has **Commit all changes & Push**. Chat Settings save every change on their own, with no Save button. A message taller than the screen can be read to its end while pinned at the top, and finish sounds play in windows that were never clicked.

**0.9.6** — The selected, visible chat finishes silently by default while its VS Code or browser window is active. Enable **Play a sound for the active chat** in Chat Settings → Sound & notifications to hear it too. Background chats and inactive windows still play finish sounds when sound is enabled; Chrome and the website can keep their own setting per device.

**0.9.5** — Finish sounds (fifty, volume up to 200%, repeated up to five times) and system notifications when agents finish, also in Chrome and on the website. Chats load only their last turns, with earlier ones on scroll, so remote connections open faster. The website's message box stays visible above a phone keyboard.

**0.9.4** — The OpenRouter agent also runs models from Ollama or LM Studio on your computer (no key needed or sent). Chat Settings has a **Remote terminals** tab with checkboxes for what Chrome and the website
may do with terminal tabs: use them at all, open a plain terminal, open an agent in a terminal. Each
applies at once, and they can be changed only in VS Code.

**0.9.3** — Adding a chat reuses an existing empty tab and briefly highlights it instead of creating a duplicate.

**0.9.2** — A tidier tab strip: the tab in front is always 35% wider than the rest and switches
with a quick linear animation. When tabs overflow, the remaining ones share the full width and
hovering the dropdown opens the list, where a hovered row has a close button and a tab picked
from it stays in the strip. Gemini CLI can be opened in a terminal tab, and dragging terminals
to reorder them works again. The Chrome side panel and the website share all of it.

**0.9.1** — Terminal tabs in the chat: a real shell, or Claude Code or Codex in their own CLI,
beside your conversations. Pin one to a conversation and its agent reads the screen and, with your
approval, types; **Watch only** and **Pause agent input** keep it in check. The terminal toolbar
inserts pages, elements, screenshots and files into an agent CLI's prompt. Opted in, the Exchange
website can watch shared terminals and take control, with a key bar for phones.

**0.9.0** — The Exchange server shares a chat and a browser tab with a self-hosted website,
end-to-end encrypted. From any device you can send messages, stop turns, pick elements and
click through the page. The VS Code chat, the Chrome side panel and the website share one set
of controls and receive updates as patches. Git state made in VS Code reaches the website
straight away. Chrome and the website offer the current page as a one-click attachment. The
website can open Google Chrome on the VS Code machine and labels each tab by browser. Agents
can no longer send clipboard shortcuts. The Chrome extension is now 0.6.0.

**0.8.10** — Agents gain native hover, drag, keyboard shortcuts and text insertion,
plus double and right clicks. Browser snapshots and actions reach open and closed
Shadow DOM; pointer actions handle scaled, rotated and perspective-transformed iframes,
including nested frames from other sites. Optional humanized input adds curved pointer
movement, varied pauses and character-by-character Unicode typing. Clicks refuse covered,
disabled or ambiguous targets, and cancelled actions release held keys and mouse buttons.

**0.8.9** — Popups and tooltips stay within the visible chat area, including narrow
Chrome side panels, and adjust when the panel or content changes size. Chrome video
recording has a timer and Pause/Resume/Stop controls above the composer; Chrome's
Stop sharing control also ends recording. The Chrome footer supports usage and context,
skills, working folders, Git branches and commits, and GitHub repositories, with
conversation-bound action results and replay protection for project attachments.
Reconnects preserve command receipts; uncertain sends after an editor restart return
to drafts for review. Subtask failures settle their status, and a watchdog checks
quiet agents without terminating genuinely active work.

**0.8.8** — Continue an editor conversation in Chrome's side panel with quick pairing,
conversation selection, separate drafts, messages, Stop, approvals and model settings.
Attach page elements, screenshots, annotations, page links, files and short recordings;
agents can manage enabled Chrome annotations through MCP. Mirrored editor tabs have an
animated gradient underline. The Chrome footer supports usage, context, skills, working
folders, Git branches and commits, and GitHub repositories. Compatibility is checked per feature, and the Chrome UI
and help are in English. Includes matching Chrome icons, store listing text and
`npm run package-chrome` for creating an installable ZIP.

**0.8.7** — Chrome and agents work without the native Browser API. The chat’s **+** and
browser menus offer Chrome and, where available, native tabs with one-click API setup.
Chrome opens attach the requested tab; sharing, screenshots, element picks and video recording
work with Chrome. A Codex chat stays open when another conversation prevents terminal handover.
The README has a clearer browser comparison and a shorter recording guide.

**0.8.6** — The browser tools can drive Google Chrome, with no Chrome extension. A chat moved
to the terminal keeps the browser tools and the tab it was working on. Chat history can be
filtered by period. A "Prompt is too long" hit during auto-compacting is retried.

**0.8.5** — Claude Ultracode gets its own round toggle beside effort, remembered per chat;
new tabs inherit the last chosen state. A collapsed sidebar keeps chats visible as compact,
colour-bordered tiles with status icons and agent counts. Effort uses a fixed-width slider
with a soft colour scale and an immediate tooltip. The folder footer has shorter labels
and refined spacing.

**0.8.4** — A wide-screen chat layout from 1000 px: a centered conversation and composer,
with tabs in a collapsible sidebar on either side. Attachment references start at `@1` for
each new message. Claude and Codex automatically continue after temporary service errors,
with up to three retries after 5, 15 and 60 seconds. Chat tabs have a centered orbit spinner
and smoother switching animations; closed chat panels release their display numbers for reuse.

**0.8.3** — Publish, push and pull the current branch from the chat's Branches window,
through VS Code's Git extension and your GitHub sign-in, with a button for a pull request. New
`chat_*` MCP tools report the chat's tabs, plan limits and agents, and let the chat's own agents
keep the computer awake, pause their queue or stop one of their agents, behind a new Chat
control approval category. The status bar menu opens new chats, and Gemini shows the model
Auto chose and explains quota, context and exit errors.

**0.8.2** — Open chats in the sidebar, editor tabs or separate windows, and move them
between views with their sessions, drafts and attachments intact. View chats side by side
across screens, drag to reorder, and restore chat tabs after restarting VS Code. The top
**+** offers a location; the tab-strip **+** adds a neighbouring chat. History finds chats
already open elsewhere and offers to move them back to the sidebar.

**0.8.1** — File names throughout the chat now show icons from your selected file icon
theme, including attachments, file links and read/edit tool rows. Usage and context indicators
use clockwise ring meters, and the composer has a darker surface below its toolbar. Generated
commit subjects use conventional commit format with a task ID from the branch or recent
commits when available.

**0.8.0** — Gemini CLI joins the chat as a third agent, driven over ACP through your own
`gemini`, with **Connect Gemini CLI** writing `.gemini/settings.json` (token kept out of git),
**Open Gemini CLI in Terminal** and **Share Tab with Gemini CLI**. **Ask another agent** under a
reply sends the same question to another agent or model in a new tab for a second opinion. New
`editor_*` MCP tools let assistants see what is open and selected, show a place, and find
definitions, references and symbols through VS Code's language servers.

**0.7.19** — A maximum video length in Chat Settings (5 minutes by default, 10 seconds to 1 hour),
with the Stop button blinking red and a countdown in the status bar for the last 30 seconds. The
empty chat lists the features worth trying, one line each, above the changelog. A prompt Claude Code refuses as too long is sent again after it compacts. Annotation
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

