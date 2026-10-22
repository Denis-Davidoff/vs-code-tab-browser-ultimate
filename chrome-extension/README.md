# AI Browser for Chrome

The Chrome side panel uses the shared AI Browser renderer, Markdown, composer,
settings and approval controls. VS Code continues to run the agents and tools.
Choose a conversation from the selector in Chrome. Switching editor tabs does
not change the selected conversation. Its editor tab has an animated gradient
underline (static when reduced motion is enabled).

Closing Chrome's panel disconnects the mirror; only Stop stops the agent.
Chrome keeps separate drafts for each conversation. Pending commands are saved
for the Chrome session. Ordinary reconnects preserve the approved delivery session,
so retries use the same IDs without repeating accepted operations. After an editor
restart or a change of delivery session, uncertain messages return to their drafts;
review the conversation and Git state before retrying an operation.
Starting an agent does not block Stop. The footer supports usage and context,
toolbar skills, working folders, Git branches, commits and GitHub repositories. Unsent attachments in
the editor composer are not included in Chrome messages.

## Chat footer

- **Usage and context**: read agent plan limits and conversation token statistics;
  use the context indicator to request compacting when supported by the agent.
- **Skills**: refresh the slash-command list, run toolbar skills with parameters,
  queue runs, stop them and answer their approval prompts. Skill editing and ordering
  use the same shared toolbar as the editor.
- **Working folder**: choose a recent/workspace folder, browse project paths, or
  use **Choose folder** to open the native folder picker in VS Code. Project paths
  attach to the Chrome conversation's own draft.
- **Git**: refresh changes and branches, stage/unstage, open diffs, create/switch/delete
  branches, generate branch names, commit staged or all changes, and publish/push/pull.
- **GitHub**: open a repository as a clone, working copy or reference, manage copies,
  push a copy and open its pull-request page. Authentication uses the editor's Git setup.

Native folder pickers, diff editors and Git confirmation dialogs appear in VS Code.
Existing workspace trust checks, Git locks, dirty-worktree protections and confirmations
remain in effect. Operations target the conversation selected in Chrome even when
another editor tab is active. Changing a started conversation's folder creates a new
conversation and follows it in Chrome while preserving the editor's selected tab.
Replacing a conversation while an action awaits does not redirect its result to
the replacement chat. Long operations do not hold up Stop. Results are delivered through authenticated,
replayable events, without repeating an operation after a lost response.

## Attachments

The **+** menu provides:

- **Element from the page**: hover to highlight, click to select, Esc or **Cancel**
  to stop. Context includes the URL, HTML, CSS, dimensions and selector; password
  values are redacted. Internal Chrome pages and the Chrome Web Store are unavailable.
- **Screenshot of the page**: a PNG of the visible active tab, sent as an image.
  Chrome's `captureVisibleTab` requires the literal `<all_urls>` host permission;
  HTTP/HTTPS wildcard patterns are insufficient. Clicking inside the side panel
  does not grant `activeTab`. Chrome may ask to confirm access after a manifest update.
- **Page address**: the page URL and title at the time of selection.
- **Share page**: the selected tab's URL and title follow navigation until send.
  This does not enable remote debugging; page control requires a separate Chrome connection.
- **Add annotation**: the same overlay as the main browser, with element highlighting,
  numbered markers, editable notes (up to 2,000 characters), ten colors, copying,
  confirmed deletion and a button to add another marker. Esc cancels selection or
  collapses the card. Draft attachments follow note edits. Delivered markers are
  removed after the message is accepted, including queued sends. Notes are saved
  per URL and restored when returning to the page.
- **File**: a local file; pasting files from the clipboard also works.
- **Record the browser page**: choose a screen or tab without audio, then use
  the recording bar above the composer to pause, resume or stop. Chrome's own
  **Stop sharing** control also ends recording. Recording stops automatically after
  20 seconds or near the size limit. Closing the panel or disconnecting stops capture.

Tab and site access are requested at installation, with no runtime permission
prompts. Restrict site access at `chrome://extensions` if needed. Selected items
stay in the conversation's draft until sent. A draft or recording remains bound
to the conversation where it started.

Each message supports up to eight attachments, 200,000 context characters and
approximately 4 MB of files combined. Files are saved in the VS Code project's
local temporary directory only when sending. Images are passed as images; other
files and videos are provided as local file references for the agent.

## Annotations through MCP

Regular Chrome tabs support `browser_annotations_list`, `browser_annotations_get`,
`browser_annotations_add`, `browser_annotations_remove` and `browser_annotations_clear`
without remote debugging. Keep the connected side panel open and first choose
**+ → Add annotation** in the intended conversation. An ID such as
`chrome-annotations:123` appears in the attachment and in `annotationTabs` from
`browser_state` / `browser_tabs`. Pass it explicitly as `tabId`; these IDs only
support annotation operations.

Only conversations where annotations were explicitly enabled for the tab receive
access. Enabling another conversation preserves earlier grants. Closing a
conversation revokes its access; disconnecting the bridge revokes all grants.
Agent markers use author `assistant` and are not automatically attached as user notes.

Synchronization requires an open side panel. Limits: 50 annotations per page,
eight tabs, and eight saved pages per tab. Copying uses the `clipboardWrite`
permission without additional runtime prompts.

## Feature compatibility

Release numbers do not have to match. Each side advertises supported wire-contract
versions for chat, elements, screenshots, files, video, page addresses, shared
pages, annotations, usage, context, skills, working folders, Git and GitHub. Each function uses its highest shared version.

An incompatible optional feature shows an English update instruction when used;
other compatible features keep working. Unsupported outgoing attachments return
to the draft. Only an incompatible core chat contract or transport prevents the
connection; drafts and pending messages are preserved. Discovery, manual pairing,
restored sessions and server-side requests all check compatibility.

Transport-v2 peers predating the feature map retain their original v1 contracts.
An explicit map does not imply support for omitted features. Unknown features are
ignored. Add compatible versions to a feature's list when evolving its contract;
change the global transport version only for changes to the common envelope.
Both release versions remain available in the connection status tooltip.

## ZIP archive

Run `npm run package-chrome` from the repository root. It rebuilds Chrome assets
and creates `chrome-extension/ai-browser-chrome-<version>.zip`. The archive root
contains `manifest.json`; source files and VS Code assets are excluded.
Unpack the ZIP and select the resulting folder using **Load unpacked** at
`chrome://extensions`.

## Installation

1. Run `npm run compile` and `npm run build-chrome` from the repository root.
2. Start the updated VS Code extension in an Extension Development Host using F5,
   or reload the editor with the updated extension installed.
3. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**
   and select `chrome-extension/dist`.
4. Click the AI Browser icon, then **Connect**.
5. Click **Allow** in the desired editor chat panel. With multiple editor windows,
   choose the window in Chrome first. No IDs or codes need copying.

Requests can be denied or cancelled, and expire after 90 seconds. Discovery never
returns conversations or access credentials before approval. Only the editor UI
can approve a connection, not an already connected Chrome panel.

Fallback: expand **Connect manually**, run **Connect Chrome Chat (Preview)** in
VS Code, enter the extension ID and paste the resulting code into Chrome.

## Connection lifecycle

- Each local editor window starts discovery on a port in `127.0.0.1:19371–19390`.
  Discovery exposes the window label, not chat contents. Approval creates a separate
  bridge on a random loopback port with its own random token and allowed extension origin.
- Each VS Code window has its own bridge. Reconnecting replaces that window's previous
  connection; failed setup preserves the previous connection.
- **Disconnect** in Chrome clears its connection code and forgets the resume grant.
  **Disconnect Chrome Chat** in VS Code revokes access and every resume grant.
- **Resume.** Approving a connection also gives Chrome a resume key: Chrome keeps it in
  `chrome.storage.local` (never Chrome Sync), the editor only its SHA-256 in SecretStorage.
  When the bridge stops answering (VS Code closed or reloaded), the panel returns to the
  Connect screen and keeps looking for an editor every 3 seconds. A running editor that
  accepts the key opens a new bridge without another "Allow"; the window holding the
  pinned conversation is asked first, then any window. A refused key is forgotten and
  the panel asks to connect again. Restarting Chrome resumes the same way.
- Closing the side panel does not stop the agent. Bridge credentials live in
  `chrome.storage.session`; the resume key is what survives restarts.
- Network failures trigger retries while retaining the latest messages. A rejection
  from another editor profile does not remove the original profile's resume grant. Messages still
  pending when the editor restarts are sent through the resumed connection.
- Closing the source editor chat panel revokes its bridge. The normal AI Browser
  lifecycle still applies: closing the source interface can stop its agent.
- VS Code must run on the same computer. Remote extension hosts are not supported.

Conditional GET requests use ETags every 750 ms, with backoff on errors. Commands
use separate authenticated POST requests with runtime validation and conversation
binding. No independent background application is required.

After source changes, restart the Extension Development Host, reload the Chrome
extension at `chrome://extensions` and reconnect. The Chrome build includes the
shared renderer, CSS and codicon font without copying built VS Code resources.
Small toolbar icons use the main icon's crosshair artwork for legibility; larger
icons retain the complete artwork.

## Chrome Web Store listing

See [STORE-LISTING.md](STORE-LISTING.md) for the English store description and
permission justifications to paste into the Chrome Web Store developer dashboard.
The manifest contains the short description; the longer explanation belongs in
the store listing and permission justification fields.

## Validation

Run `npm run typecheck`, `npm run build-chrome`, `npm run compile` and
`npm run check-manifest`. Bridge integration tests use
`node --test src/chat/chromeChatBridge.test.ts` and require loopback access.

Manual checks: connect and approve in the intended panel; deny, cancel and expire
requests; select among multiple editor windows; receive replies; switch editor
conversations; change settings; close and reopen the panel; revoke and reconnect.
