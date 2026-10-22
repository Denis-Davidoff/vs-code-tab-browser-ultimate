# Chrome Web Store listing

## Name

AI Browser

## Short description

Chat with AI Browser in Chrome. Attach page elements, screenshots and annotations to your local VS Code conversation.

## Detailed description

Continue your AI Browser conversation alongside any website in Chrome's side panel.
Connect to the AI Browser extension running in a local VS Code window, approve the
connection in the editor, and work with the same conversation and agents.

- Read replies, send messages, stop generation and respond to approval requests.
- Choose a conversation, model and supported chat settings.
- Check usage and context, compact conversations, and run or manage toolbar skills.
- Select a working folder, manage Git branches and commits, and work with GitHub repositories through VS Code.
- Attach selected page elements, visible-page screenshots, page addresses and files.
- Add editable annotations to page elements and let your agent work with those notes.
- Record a short screen or tab video using Chrome's screen-sharing chooser.

Requires the AI Browser extension for VS Code running on the same computer.
VS Code runs the agents and tools; the Chrome extension is a connected chat interface.

Why website access is requested

Website access enables element selection, page annotations and screenshots on the
sites you choose to work with. Tab access supplies page addresses and titles and
keeps explicitly shared tabs and annotations in sync as you navigate. These
permissions support the page-context features; they are not used to build a
browsing-history profile. You can restrict website access in Chrome's extension
settings, which may prevent these features from working on restricted sites.

Data flow

The extension connects to VS Code through an authenticated local connection that
you approve in the editor. Page context and attachments are provided to that
conversation; enabled annotations synchronize while the side panel is connected.
When you send a message, its content and attachments may be processed by the AI
provider or local agent configured in VS Code. Review the settings and privacy
terms of your selected provider before sharing sensitive information.

## Single purpose

Extend the user's local AI Browser conversation in VS Code into Chrome's side
panel, with page context and attachments for that conversation.

## Permission justifications

Use these explanations for the corresponding permission fields in the developer dashboard.

### Host permissions: <all_urls>

Users can select elements and annotate pages on arbitrary websites using scripts
injected into the selected tabs. The extension also captures visible-tab screenshots
from the side panel; Chrome's captureVisibleTab API requires <all_urls> or a valid
activeTab grant. A side-panel click alone does not grant activeTab. Broad host access
supports these features across the sites the user chooses to work with.

### tabs

Reads tab URLs and titles for page-address attachments and explicitly shared pages,
and checks the current URL when synchronizing annotations or selecting elements.
This also supports tab metadata when a site's host access has been restricted;
script injection still requires permission for that site.

### scripting

Injects the bundled element picker and annotation overlay into user-selected tabs
and reads the resulting selected-element context and annotation state.

### activeTab

Provides temporary access to the active tab when the user invokes the extension
through its toolbar action. Chrome can use that grant for supported active-tab
operations when persistent website access is restricted.

### sidePanel

Displays the AI Browser conversation beside the current website.

### storage

Uses Chrome session storage to retain the approved local connection, per-conversation
drafts, pending outgoing commands and annotation state across side-panel reopening.
Connection credentials are not stored in Chrome Sync.

### clipboardWrite

Copies annotation text when the user chooses the annotation overlay's copy action.

## Submission notes

Privacy policy URL (available after publishing `PRIVACY.md` to the public `main` branch):

https://github.com/Denis-Davidoff/vs-code-tab-browser-ultimate/blob/main/PRIVACY.md

The ZIP contains the installable extension and its short manifest description.
Paste the detailed description, single purpose and permission explanations above
into the corresponding Chrome Web Store dashboard fields; this Markdown file is
not included in the extension ZIP.

